# IMPLEMENTATION.md

**为什么这么实现**。怎么用看 [README.md](README.md)，改代码前要背的规则看 [AGENTS.md](AGENTS.md)。

## 一句话架构

```
浏览器半边 (client.js)
   │  POST /gitea-task-issues/api  { op, params, sessionId? }
   ▼
Host 半边 (index.js → lib/bridge.js)
   │  op 查表 → 收敛参数 → 解析目标仓库 → 取令牌
   ▼
lib/gitea.js 操作表 ── fetch ──▶ Gitea /api/v1/…
   │
   └─ lib/shape.js 瘦身 ──▶ { ok, data } 回浏览器
```

模型侧走同一条操作表，但不经过 HTTP：

```
ctx.tools (7 个 gitea_issue_* 工具) → lib/resolve.js → lib/gitea.js → lib/shape.js
```

## 为什么 Host 半边只 import `node:` 内建模块

插件以 `link:` 装进 profile，模块的真实路径在本仓库。Node 的 ESM 解析按**真实路径**往上找
`node_modules`，所以 `@deepseek-ai/dsh-tools` 这类裸包名从这里解析不到（`dsh-editor` 的约束 1
是同一个原因）。三个直接后果：

1. **凭据 record 的 key 自己拼**。官方 `credentialKey(scope, id)` 做的事就是校验两段
   `^[a-z][a-z0-9-]*$` 再拼成 `<scope>/<id>`，`lib/secrets.js` 照抄这段规则；
   服务器 id 的生成规则（`srv-` + 十六进制）保证它一定合法。
2. **工具定义手搓，不用 `defineTool`**。看注册表实现：`register()` 只要求
   `output.schema` 通过 `assertSupportedJsonSchema`、`output.render` 是函数；参数校验是
   `defineTool` 自己加的（它在 `execute` 里跑 `validateJsonSchemaValue`），**不是注册表的义务**。
   所以 `lib/tools.js` 自己收敛参数、自己拼 JSON Schema，行为等价。
   代价是：**返回值会按 `output.schema` 校验并做无损 JSON 快照**，所以出参一律先过
   `jsonSafe` 去掉 `undefined` 值的键 —— 否则真机上报 `INVALID_TOOL_OUTPUT`。
3. **数据根自己解析**：`$DSH_HOME`（空白视作没有）→ `~/.dsh`，与 `dsh-home-paths` 的规则一致。

## 为什么是一条路由 + `op` 操作表

官方 `@deepseek-ai/dsh-api-workspace-files` 是只读的，新增 Remote 命名空间需要构建期生成的
`InvocationDescriptor`，`link:` 装进来的插件走不通 —— 所以只能自己 `ctx.webServer.register()`
开路由。但 Gitea 这边要暴露的操作有几十个，一条路由一张外壳（围栏 / 方法 / 媒体类型 / 生命周期
/ 应答五件事）会把同样的代码抄几十遍。

于是：**一条路由 + `op` 白名单**。`op` 不在表里直接 `unknown-operation`，表里每条都是写死的
路径模板 —— 没有「把任意 URL 透传出去」的口子，也没有把 Gitea 的鉴权面暴露给浏览器。

操作表本身放在 `lib/gitea.js`，`scope` 决定要哪些目标字段（`server` / `repo` / `issue`），
`query` / `body` 只负责收敛参数。桥与工具都从这张表走，端点、参数名、请求体字段**只有一份**，
上游升级时改一处。

## 令牌：record 优先，环境变量兜底

- 首选 DSH 的 credentials **record**（`<scope>/<id>`，落在 `.credentials.yaml`）。
  界面只能问 `describeRecord` 拿到的「配没配、可不可写」，值永远不出 Host。
- 兼容「环境变量」这一路：服务器记录里可以写 `tokenEnv: GITEA_TOKEN`，进程环境里有值就直接用
  （CI / 容器场景），此时界面显示它来自环境、不可写。
- 两条都没有就报 `token-missing`，**不发匿名请求去撞 401** —— 那样只会把「没配令牌」伪装成
  「令牌无效」。

`servers.json` 里因此只有名称 / 地址 / `tokenEnv` / 绑定，可以随便看、随便备份、随便贴进 issue。

## 绑定与自动侦测

解析顺序（显式永远压过隐式），只有一份实现在 `lib/resolve.js`：

1. 入参给全了 `serverId` + `owner` + `repo` → 直接用（全局看板与工具显式指定走这条）；
2. `servers.json` 的 `bindings[工作区根]` → 用户手动绑过的，最可信；
3. 读工作区的 `.git/config`，从 remote 拆 `host / owner / repo`，再和已配置服务器**按主机名
   配对**（先 `host:port` 全等，再退回主机名）；
4. 都没有 → 报 `no-binding` / `no-server-for-host`，**不猜一个默认仓库去改**。

为什么读 `.git/config` 而不跑 `git remote get-url`：不需要子进程（不需要 PATH、不需要在只读
沙箱里找可执行文件）、不触发 git 钩子 / 仓库锁、失败面小（读不到就当没侦测到，由用户手填）。
支持 worktree / submodule（`.git` 是文件时按 `gitdir:` 转一次再读）。

## 出线形状层（`lib/shape.js`）

Gitea 的 issue 里嵌着 `repository`、`assignee`、`milestone.creator` 等整对象，50 条列表能有
200KB+，而界面真正用的就十几个字段。所以桥与工具都把上游对象过一遍 `shape.js`：

- 瘦身：只留界面要用的字段；
- 拍平：`repository.owner.login` / `repository.name` → `owner` / `repo`，界面不必理解 Gitea 的
  对象图；
- 宽容：缺字段一律 `null`，上游版本差异只影响某个字段，不能让整块界面炸掉。

**这一层是浏览器半边唯一认的字段集**：改字段等于改线上协议。

## 三个容易搞反的上游细节

1. **issue 编号是 `number`，不是 `id`**。`Issue` 定义里根本没有 `index` 字段；路径里的
   `{index}` 就是 `number`，用 `id` 会 404。`shapeIssue` 读的也是 `number`。
2. **`blocks` 与 `dependencies` 是反向关系**，且两个都非废弃：
   - `GET /issues/{index}/dependencies` = 「谁挡住我」；
   - `GET /issues/{index}/blocks` = 「我挡住谁」；
   - POST / DELETE 的语义同样相反（`dependencies` 的请求体是「我要依赖的那个」，
     `blocks` 的请求体是「我要挡住的那些」）。
3. **标签：创建 issue 收 id，列表查询收名字**。`CreateIssueOption.labels` 在 swagger 里是
   `[integer]`，直接送名字会被 422；`IssueLabelsOption.labels` 的类型 swagger 没写清。
   所以 `resolveLabelIds` 统一先把名字解析成 id（名字优先，避免「名字恰好是数字」的标签被当
   id），`issue.create` 与 `issue.labels.*` 都走它。

另外两个上游事实：`AddTimeOption.time` 单位是**秒**；`GET .../issues/{index}/comments` **没有
`page` / `limit`**，只有 `since` / `before`（所以那个操作表项也不发分页参数）。

## 分页与上限

Swagger 里**没有**任何 `limit` 的 `maximum`，实际上限来自 `GET /settings/api` 的
`max_response_items`。插件按 50 请求、最多 100，列表不自动翻页；`total` 取自上游的
`X-Total-Count`（没有就是 `undefined`）。跨仓库搜索（`/repos/issues/search`）**没有 repo 参数**，
只能按 `owner` 收窄 —— 界面上因此不假装支持「跨仓库 + 指定单仓库」。

## 探针为什么这么写

真机验收需要一台 Gitea + 一个令牌 + 装进 profile 重启，代价高、也难回归。所以本地把两半都
**用真的代码路径**跑起来：

### Host 侧：假 Gitea + 假 ctx + 真 HTTP

`tests/mock-gitea.mjs` 按 Gitea 1.27.3 的形状实现插件真正会打的那批端点，并**记录每个请求**
（方法、路径、query）——断言「到底打了哪个路径、带了什么参数」比断言返回值更能防回归
（例如 `?name=` 是 query 参数、附件字段名是 `attachment` 这类细节）。
`tests/host.test.mjs` 用假 ctx 调 `apply()`，再起一个真 HTTP server 包住桥的 handler，
用 `fetch` 打进去，所以**连请求体读取、状态码、`allow` 头这些都被覆盖**。

工具出参用**注册表自己的校验器**验（按绝对路径 `import` 本机 DSH 安装里的
`dsh-tools/lib/index.js` 的 `validateJsonSchemaValue`）—— 这样 `INVALID_TOOL_OUTPUT` 这类只有
真机才会暴露的问题本地就能拦。

### 浏览器侧：迷你 React

`tests/mini-react.mjs` 是一个够用的迷你 React：`createElement` + hook + 副作用 + 有限轮次的
重渲染。它把注册出去的组件树真渲染一遍，抓的是**运行时错误**（读 null 字段、把 undefined 当
数组用），以及主要交互（点行进详情、新建、切筛选、探活、绑定设置）。

写这个 harness 时踩了三个坑，改的时候别退回去：

1. **hook 槽位要按组件实例分表**。最初用一张扁平数组 + 全局游标，结果不同组件的 hook 互相顶
   掉槽位（症状：状态写进去却读不出来）。真实 React 也是按实例存的。
2. **`setState` 的闭包必须捕获自己那张表**。异步 setState 发生在渲染结束之后，那时模块级的
   `table` 已经指向别的组件了。
3. **组件返回的子树要另起一段路径**。否则「组件直接返回另一个组件」（`GlobalBoardSlot` →
   `GlobalBoard`）会两张表撞成一张。

它抓不到样式与布局 —— 那部分只能在浏览器里手工验收，清单在 README。

## 已知取舍（都是有意选的，不是没做完）

| 取舍 | 为什么 |
|---|---|
| issue 编辑不带 `content_version` 乐观锁 | Gitea 支持，但界面要多一套冲突态；当前先按「后写覆盖先写」，边界写在 README |
| 附件走 base64 过桥，限 16 MiB | 浏览器 `File` → base64 是最短的路径；更大文件让用户去 Gitea 网页传，比在桥里做流式上传简单得多 |
| 列表不自动翻页 | 先要「看得见」，翻页会牵出滚动加载、`total` 一致性等一堆状态 |
| 不做后台轮询 | 轮询会持续消耗令牌额度，也会让「谁改了什么」变得难以归因；刷新是显式动作 |
| 没有时间线视图 | `issue.timeline` 在操作表里可用，但事件流的渲染（标签变更、指派变更、引用）是另一个界面量级 |
| 绑定用工作区**根路径**作键 | 会话 id 会变、工作区根不会；同一个仓库开多个会话时绑定只维护一份 |
