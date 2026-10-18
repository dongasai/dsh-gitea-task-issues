# AGENTS.md

给 AI 编码代理的项目须知。文档分工：[README.md](README.md) 讲**怎么用**（安装、两处看板、
线上协议、排错、怎么验证、已知边界），[IMPLEMENTATION.md](IMPLEMENTATION.md) 讲**为什么这么
实现**（设计取舍、一次调用的完整路径、探针为什么这么写）。与代码冲突时以代码为准。

## 项目是什么

`@dongasai/dsh-gitea-task-issues` —— DSH 插件，一个包两半：**Host 半边** [index.js](index.js)
注册唯一一条桥接路由 `POST /gitea-task-issues/api`（[lib/bridge.js](lib/bridge.js)）、注册 7 个
模型工具（[lib/tools.js](lib/tools.js)），并跑一个**默认关闭**的自动分配轮询器
（[lib/watch.js](lib/watch.js)：定期把「指派给我的新任务」变成新会话）；
**浏览器半边** [client.js](client.js) 注册全局看板页（`main` 键 `gitea-issues`）、左侧栏面板图标
（`sidebar.panellist`，`order: 20`，排在官方「自动化任务」的 10 之后）与右侧栏「Gitea issues」
看板页签；自动分配的设置页从工作区看板的「绑定设置」进入。

## 命令

| 目的 | 命令 |
|---|---|
| 全部测试（96 个用例） | `node --test tests/*.test.mjs` |
| 两半语法自检 | `node --check index.js && node --check client.js`（等价 `npm run check`） |
| 查某个槽位的官方契约 | `node tools/slot-contract.mjs main sidebar.panellist` |

无构建、无 lint、**没有 `dependencies`**：`index.js` 与 `lib/**` 只用 `node:` 内建模块；
`client.js` 是手写的浏览器 bundle（由 Host 直接读盘发出，不经打包器），没有构建步骤。

## 文件地图

| 文件 | 作用 |
|---|---|
| [index.js](index.js) | Host 插件入口：建 store → 建桥 → 注册路由与工具 |
| [lib/bridge.js](lib/bridge.js) | 桥：信任围栏 + `op` 操作表 + 出线形状 + 失败映射 |
| [lib/gitea.js](lib/gitea.js) | Gitea API 客户端 + **操作表**（路径/参数/请求体只有这一份） |
| [lib/tools.js](lib/tools.js) | 7 个模型工具（手搓 tool definition，不用 `defineTool`） |
| [lib/resolve.js](lib/resolve.js) | 「这次操作是哪台服务器 / 哪个仓库 / 哪个会话」的共用解析 |
| [lib/store.js](lib/store.js) | 配置存储：服务器清单、绑定、原子写、`revision` 乐观并发 |
| [lib/secrets.js](lib/secrets.js) | 令牌：credentials record 优先，环境变量兜底 |
| [lib/detect.js](lib/detect.js) | 读 `.git/config` 的 remote，拆 `host/owner/repo` |
| [lib/shape.js](lib/shape.js) | Gitea 对象 → 线上对象（**浏览器半边唯一认的字段集**） |
| [lib/aggregate.js](lib/aggregate.js) | 详情 / 仓库元信息的一揽子读取（桥与工具共用） |
| [lib/errors.js](lib/errors.js) | `BridgeError` / `GiteaError` 与状态码映射 |
| [lib/watch.js](lib/watch.js) | 自动分配轮询器：取数、空闲判定、跨进程锁、退避、投递 |
| [lib/triggers.js](lib/triggers.js) | **纯函数**：账本 + issues + 评论 → 触发（矩阵的主战场） |
| [lib/watchstore.js](lib/watchstore.js) | 自动分配账本 `watch.json`：schema、收敛、剪枝 |
| [client.js](client.js) | 浏览器半边全部实现 |
| [tests/](tests) | 假 Gitea + 迷你 React + 96 个用例（含槽位目录静态校验） |
| [tools/slot-contract.mjs](tools/slot-contract.mjs) | 从本机 DSH 安装里抽客户端槽位契约 |
| [docs/gitea-api-reference.md](docs/gitea-api-reference.md) | Gitea 1.27.3 issue 相关 API 参考（改操作表前先查它） |
| [docs/auto-assign-design.md](docs/auto-assign-design.md) | 自动分配的设计稿：口径、账本、幂等闸门、边界 |

## 硬性约束（违反即出 bug，别试探）

### Host 半边

1. **只 import `node:` 内建模块**。插件以 `link:` 装进 profile，模块真实路径在本仓库，
   `@deepseek-ai/*` 这类裸包名从这里解析不到。代价与做法：
   - 凭据 record 的 key 自己拼（段语法 `^[a-z][a-z0-9-]*$`，服务器 id 的生成规则已保证）；
   - 工具定义手搓 —— `ctx.tools.register` 只要求 `output.schema` 受支持的 JSON Schema 子集 +
   `output.render` 是函数，参数校验是 `defineTool` 自己加的，不是注册表的义务；
   - 数据根自己按 `$DSH_HOME` → `~/.dsh` 解析。
2. **返回值会按 `output.schema` 校验**，且会做无损 JSON 快照：工具出参一律先过 `jsonSafe`
   （去掉值为 `undefined` 的键），否则真机上变成 `INVALID_TOOL_OUTPUT`。
3. **令牌只走 `lib/secrets.js`**：不进 `servers.json`、不进日志、不进桥的应答。界面只能问
   「配没配、可不可写」。
4. **桥的第一件事是信任围栏**（`ctx.connection.requestRejection`），且只收 POST + JSON；
   请求体有上限。
5. **`op` 必须查表**：`lib/gitea.js` 的操作表是白名单，`lib/bridge.js` 不接受调用方拼 URL；
   新增能力 = 加一条表项，不要在桥里写一次性 URL。
6. **参数逐项收敛**：类型、枚举、上限都在操作表的 `query` / `body` 里用 `optInt` / `optEnum` /
   `optStringArray` 收敛，非法输入 400，不把脏参数送给 Gitea。
7. **失败按 `code` / 状态码判别，绝不看 `message`**；上游状态 → 线上码走
   `lib/errors.js` 的 `codeForGiteaStatus`，表里没有的一律 `upstream-error`，不猜。
8. **桥不静默重试、不做后台轮询**：读写都可能改变远端状态，一次用户动作一次调用。
   **例外只有一处：`lib/watch.js` 的自动分配轮询器**（默认关闭、可一键停、每小时有配额、
   失败可见并退避）。两条边界必须守住：
   - 轮询器**不走桥**，在本进程内直接调操作表，浏览器永远拿不到令牌；
   - 除它以外任何地方都不许起定时器去打 Gitea。想把这条口子开大时，先读
     [docs/auto-assign-design.md](docs/auto-assign-design.md) 的「为什么可以开这个口子」。
9. **破坏性动作要能说清后果**：删除服务器会连带删掉它的令牌记录与指向它的绑定；
   issue / 评论 / 附件删除不可撤销（界面二次确认）。
10. **模型工具必须工作区隔离**：7 个 `gitea_issue_*` 工具的**参数里不能有** `server` / `repo`
    （也不能有跨仓库搜索档）—— 目标只能由当前会话的工作区解析出来（`workspaceTarget`），
    解析不出就报 `no-binding` / `no-server-for-host` / `root-required`。
    探针会断言参数集与「换工作区就换仓库」，别为了「顺手指定一个仓库」把它加回来。

### 浏览器半边

11. **所有远端读写只走那条桥**。浏览器半边永远拿不到令牌，也不直连 Gitea（CORS + 泄漏两件事）。
12. **不假设槽位传了哪些 prop**。slot catalog 列的是类型并集：`sidebar.right.pane.tab` 有
    `sessionId`，但别去调它没保证的 `useSessions`；要什么自己从 `ctx` 服务现读，读不到就降级
    提示（`dsh-editor` 的约束 18 踩过整块白屏）。
13. **只消费 `lib/shape.js` 的字段集**；缺字段按「没有」渲染，不抛错。
14. **看板自己读绑定**：列表页要拿绑定决定查哪个仓库，而绑定设置只是其中一个视图 ——
    把「读绑定」交给只在设置页挂载的面板，列表页就永远不知道绑了谁（探针抓到过）。
15. **右侧栏页签是页类型**：`sidebarRightTabs.register` 不给 `patterns`，否则会抢文件的自动
    打开；入口走 guide 卡片 + 快捷键。
16. **样式只挂组件本地 `<style>` 且只用主题令牌**（`--dsw-alias-*`），不引外部样式表、
    不写死颜色。
17. **调试锚点走 `data-gti-*` 属性**，不要用 `class` 选择器或可见文案当锚点 —— 探针就是靠
    这些属性点交互的。
18. **`h(...)` 的子元素别多打一个 `)`**：`node --check` 只验语法，但括号/逗号错位会让整段变成
    逗号表达式或提前收口。改完大块 `h(...)` 之后跑一次 `node --test tests/client.test.mjs`，
    迷你 React 会把树渲染一遍，这类错误当场就炸。
19. **往对话输入框写文本只走 `inputActions`**（公开面只有 `captureInsertion()` + `insertText()`）：
    写入面按「槽位 prop → `conversation.input.dock` 哨兵登记的 `inputTargets`」取，**不能只信
    prop**（目录列的是类型并集）；两处都拿不到只亮横幅（`send.failed.input`），不抛错、不静默
    失败；`insertText` 返回 `false` 是「正忙」不是异常。**列表行的发送按钮必须是 `IssueRow`
    的兄弟节点**（`IssueRow` 本身是 `<button>`，交互元素嵌套时点里层会连带触发外层）。
20. **泳道是默认视图（竖列看板），分组只在客户端做**（`laneGroups`，两个看板共用 `IssueList`）：
    一条 issue 可以同时落进多列（多个指派 / 多个标签）——泳道是视角不是归属，别去重；
    **按状态分组时两列始终渲染**（空了也留一列，里面写「暂无」），其余维度没有值的列不出现。
    **按状态分泳道时状态筛选被接管**（取数固定 `all` + 控件置灰，`stateLocked`）：泳道本身就是
    状态维度，别把它改回「服务端按维度各查一次」，也别让筛选与已取回的数据对不上。
21. **全局看板新建 issue 的目标默认是「已绑定的工作区」**（`TargetPicker` 的 `workspace` 档 +
    `initialCreateTarget`）：「我给哪个工作区提一条」比「仓库叫什么」更贴近用户脑子里的问题，
    绑定里已经写死了它的 `serverId/owner/repo`。三条别动：① 选项来自 `config.get` 的 `bindings`，
    **不扫盘、不预读自动侦测**（`bindingOptions` 只收能对得上已配置服务器的绑定）；② 多个绑定时
    **拿不准就不预选**（猜错仓库 = issue 落到别处，比多点一下贵得多）；③ 筛选条只是列表的收窄
    条件，不能反过来当成新建目标。手填 `owner/name` 那档叫「手动指定仓库」，是兜底、不是默认。

## 代码风格

- 中文 JSDoc（`@param` / `@returns` / `@throws`）；注释解释**为什么**，尤其是反直觉的取舍
  （为什么不用 `defineTool`、为什么一条路由、为什么绑定优先于侦测、为什么 setter 要捕获表），
  不解释语法。
- 两半都是：**无分号、单引号、2 空格缩进**；`function` 声明 + 顶层 `const`；工具函数保持纯函数。
- 文案字典（`zh` / `en`）与 `CSS` 模板里内层用双引号（`'…'` 包着 `"…"`），这是刻意的，
  不要「统一」成单引号。
- 组件用 `React.createElement`（`h`），不用 JSX —— 这个 bundle 没有构建步骤。
- 界面文案一律走 `t('key')`，`zh` 是键集的事实来源；**加文案要同时加 `en`**，探针会断言两边
  键集一致。

## 验证规范

改完至少跑：

```bash
node --test tests/*.test.mjs
node --check index.js && node --check client.js
```

- **Host 侧**：改操作表 / 桥 / 工具，必须补 `tests/host.test.mjs` 的用例（假 Gitea 会断言
  「到底打了哪个路径、带了什么参数」，比断言返回值更能防回归）；工具出参必须过注册表自己的
  校验器（用例里已经这么做了）。
- **客户端侧**：改交互 / 加组件，必须补 `tests/client.test.mjs` 的用例（迷你 React 会真渲染
  组件树并点交互）。**命令行替代不了浏览器** —— 动过布局或样式就要在浏览器里走一遍
  README「只能在浏览器里看的」清单。

## 提交

历史格式：`<类型>(<范围>): <中文描述>`。类型用「功能 / 修复 / 重构 / 文档 / 测试」。

## 改动连带项

- **动线上协议**（桥的 op、字段、错误码）→ 同步 README 的「线上协议」表与
  [lib/shape.js](lib/shape.js) 的注释；两边字段必须逐字一致。
- **动操作表**（路径、参数名、请求体）→ 先查 [docs/gitea-api-reference.md](docs/gitea-api-reference.md)
  确认上游语义，再同步该文档里受影响的小节。
- **加/改模型工具** → 同步 README 的「功能列表」与「模型工具：工作区隔离」；工具描述里要写清
  目标仓库只能来自当前工作区（**不要**加回 `server` / `repo` 参数）。
- **改服务器/令牌/绑定的行为** → 同步 README 的「快速开始」第 2、3 步与排错表；
  动了 `servers.json` 的结构要同时动 `lib/store.js` 的 `coerceState`。
- **动全局看板的「新建 issue」**（目标来源、默认预选、两档切换）→ 同步 README 的「界面长什么样 ·
  全局看板」、「只能在浏览器里看的」第 13 条与 [IMPLEMENTATION.md](IMPLEMENTATION.md) 的
  「全局看板新建 issue：为什么目标是工作区」一节；`tests/client.test.mjs` 里那五条用例跟着改。
- **动「发送到 DSH」**（提示词格式、入口位置、失败横幅）→ 同步 README 的「界面长什么样」、
  「只能在浏览器里看的」第 15 条与「已知边界」，以及 [IMPLEMENTATION.md](IMPLEMENTATION.md)
  的「发送到 DSH」一节；`tests/client.test.mjs` 里那四条用例跟着改。
- **改文案键** → `zh` 与 `en` 一起改（探针会拦）。
- **已知边界**写在 README 末尾；**没真正解决之前不要从文档里删掉**。

## 其他事项

- 修改提交后记得 push。
