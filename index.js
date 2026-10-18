/**
 * @module @dongasai/dsh-gitea-task-issues
 *
 * **Gitea 任务 issues —— Host 半边**。一个包两半，这一半负责四件事：
 *
 * 1. **持有凭据与配置**：Gitea 服务器清单（名称 / 地址 / 令牌来源）与「工作区 ↔ 仓库」绑定，
 *    令牌只进 DSH 的 credentials record，配置落在 `$DSH_HOME/gitea-task-issues/servers.json`；
 * 2. **代理 Gitea API**：注册唯一一条桥接路由 `POST /gitea-task-issues/api`，浏览器半边只能
 *    点名「哪台服务器 + 哪个操作」，**永远拿不到令牌**；操作表是白名单，不做任意 URL 透传；
 * 3. **给模型一套工具**：`gitea_issue_*`（列出/搜索、详情、创建、编辑、评论查看/添加/编辑）；
 * 4. **自动分配任务**（`lib/watch.js`）：定期轮询已启用绑定的 issue 增量，工作区空闲就新建
 *    一个会话把任务投进去。账本在 `$DSH_HOME/gitea-task-issues/watch.json`。
 *
 * 浏览器那半边（`./client.js`）注册全局看板页、左侧栏面板图标与右侧栏「Gitea issues」看板页签，
 * 三者都只通过这条桥读写。
 *
 * ## 硬性约束（改代码前先读）
 *
 * 1. **只 import `node:` 内建模块**。插件以 `link:` 装进 profile，模块真实路径在本仓库，
 *    `@deepseek-ai/*` 这类裸包名从这里解析不到（同 `dsh-editor` 的约束 1），因此：
 *    - 凭据 record 的 key 自己拼（`lib/secrets.js`）；
 *    - 工具定义手搓而不用 `defineTool`（见 `lib/tools.js` 的文件头）；
 *    - 数据根自己按 `$DSH_HOME` → `~/.dsh` 解析（`lib/store.js`）；
 *    - 会话能力按**字符串服务名**探测（`ctx.get('sessionController')`），不 import 类型。
 * 2. **桥必须过 Connection 信任围栏**（`lib/bridge.js` 第一件事），且只收 POST + JSON。
 * 3. **令牌不进配置文件、不进日志、不进桥的应答**；界面只能看到「配没配、可不可写」。
 * 4. **桥不做后台轮询、不做静默重试**：一次用户动作一次调用。
 *    **后台轮询只属于 watch 子系统**（`lib/watch.js`）——它默认关闭、可一键停、有配额、
 *    失败可见；轮询器不走桥，直接在本进程内调操作表。
 */
import { BRIDGE_PATH, createBridge } from './lib/bridge.js'
import { ConfigStore, storeFile } from './lib/store.js'
import { createToolDefinitions } from './lib/tools.js'
import { createWatch } from './lib/watch.js'
import { coerceWatch, emptyWatch, watchFile } from './lib/watchstore.js'

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'gitea-task-issues'

/**
 * 硬依赖：路由载体、信任围栏、会话存储（解析工作区根）、工具注册表。
 *
 * **刻意不含 `sessionController`**：它只在 web 类组合里挂载，headless 组合没有。把它写进
 * `inject` 会让整个插件在那种组合里加载失败，而看板与工具本来是能用的。自动分配改成
 * 运行时 `ctx.get(...)` 探测，拿不到就降级。
 */
export const inject = ['webServer', 'connection', 'sessions', 'tools']

/**
 * Host 插件正文：注册桥接路由、全部模型工具，并起停自动分配轮询器。
 * @param ctx - Host 上下文；注册都是 effect，随插件卸载一起撤销。
 * @returns 无。
 */
export function apply(ctx) {
  const store = new ConfigStore(storeFile(), ctx.logger)
  // 账本单独一个文件：水位每轮都在变，混进 `servers.json` 会让界面的乐观并发（revision）
  // 一直撞 409。收敛器也换一份，否则 `coerceState` 会往里塞 `servers` / `bindings`。
  const watchStore = new ConfigStore(watchFile(), ctx.logger, { coerce: coerceWatch, empty: emptyWatch })
  const watch = createWatch({ ctx, store, watchStore })
  const bridge = createBridge({ ctx, store, watch, watchStore })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: bridge.path,
    handler: bridge.handler,
  }), `gitea-task-issues: POST ${BRIDGE_PATH}`)

  for (const definition of createToolDefinitions({ ctx, store })) {
    ctx.effect(() => ctx.tools.register(definition), `gitea-task-issues: tool ${definition.name}`)
  }

  ctx.effect(() => {
    watch.start()
    return () => watch.stop()
  }, 'gitea-task-issues: watch loop')

  ctx.logger?.info?.(`gitea-task-issues: bridge on ${BRIDGE_PATH}, config at ${store.file}, ledger at ${watchStore.file}`)
}
