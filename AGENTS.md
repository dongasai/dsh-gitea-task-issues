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
| 全部测试（142 个用例） | `node --test tests/*.test.mjs` |
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
| [tests/](tests) | 假 Gitea + 迷你 React + 142 个用例（含槽位目录静态校验） |
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
22. **全局看板的展示范围由「工作区绑定」决定**（`boardTargets`）：一个绑定一次**仓库级**查询
    （`issue.list` 显式带 `serverId/owner/repo`），**不要**把它改回服务器级跨仓库搜索
    （`/repos/issues/search` 只能按 `owner` 收窄，会把令牌看得见、但没被任何工作区绑定的仓库也
    拉进来 —— 旧版本「显示所有 issues」就是这么来的）。同一个仓库被多个工作区绑定时按
    `serverId + owner + repo`（不区分大小写）去重，合并结果再按 `serverId/owner/repo/编号` 兜底
    去重；筛选到零个绑定仓库时**不发请求**，只说明是筛选把范围收空了。
23. **工作区看板的「自动投递」徽标（`autoDeliveryBadge`）必须与轮询器同口径**：全局总开关开 +
    本工作区**在账本里有配置且开着** + 账本里的仓库与当前绑定一致 + 宿主挂了会话服务，缺一条就
    只能显示对应的降级文案/不显示（演练单独一档）。**别按「面板草稿的默认值」判断** —— 账本里
    没有这个 root 时轮询器根本不会轮到它，说成「已开」就是假承诺。徽标本身是入口（点开自动分配
    设置，返回回列表），账本由看板自己读 `watch.get`，别交给配置页的面板喂。
    徽标里的「`mm:ss` 后检查」倒计时放在独立子组件 `AutoCountdown` 里（每秒重渲染只落在几个
    字符上，塞进看板主体会让整个列表每秒重画）；只有「开启 / 演练」两档给倒计时，到点后每 5 秒
    最多回调一次账本重读（自愈，又不把桥当轮询器使）；定时器在 Node 里要 `unref()`，否则
    `node --test` 跑完不退。徽标还要把**退避**露出来（`退避 ×N` + 悬停里的上次错误）：退避会把
    下一轮拉长到 30 分钟，不说明原因就会被当成「设置的间隔没生效」。
24. **改自动分配配置必须让排程立刻跟上**：`watch.set` 写完账本要调 `watch.refreshSchedule()`
    （按新间隔重排 + 退避清零 + 总闸关掉时清空 `nextTickAt` 并 disarm）。`setTimeout` 的延迟是在
    arm 时算死的 —— 只写账本的话，用户改完间隔要等旧定时器烧完（可能是 30 分钟退避），界面上
    就变成「我设了 60 秒，怎么还要 13 分钟」（2026-10-25 实报）。失败退避本身要保留，但必须
    在状态块与徽标上可见（连续失败次数 + 上次错误码/原因）。
25. **自动分配「模式」（Agent 预设）的名册只能从宿主读**（`presets.list` →
    `agentPresets.remoteExportList()`）：内置预设不发布 `name`，由界面字典按 id 查
    （standard / ptc / minimal / cordis）；自定义预设用宿主给的 name。坏行（`broken`）要标出来
    并禁用；名册缺席（`available: false`）退回手填 id，**不要**在界面里写死预设清单，也不要因为
    拿不到名册把面板拖垮。存的值不在名册里时补一项「不在当前名册」保留现值 —— 否则下拉会显示成
    默认档，用户一保存就把配置悄悄改掉。**降级提示要分两种**：名册服务缺席（`available:false`）
    说「宿主没有提供预设名册」；`presets.list` 直接 `unknown-operation` 说明 Host 改了没重启，
    提示里必须点出「重启 Harness」（用户第一反应就是「下拉怎么是输入框」）。
26. **投递前的「同项目活跃会话上限」只数正在跑 turn 的普通会话**（`activeSessions`：`running`、
    `cwd === 工作区根`、`origin !== 'subagent'`），默认 1（也就是旧行为「工作区忙」）；上限字段
    是 `maxActiveSessions`（1..20，`lib/watchstore.js` 的 `MAX_ACTIVE_SESSIONS_CEILING`）。
    到上限记 `capped`（带 `active` / `limit`）并**保留待办**，别改成 `failed` 或写 `fired`；
    `summary.busy` 仍把 capped 算进去（旧调用方只看这一个数），另有 `summary.capped` 细分。
    判断时除了 `list()` 还要加**本轮已投出计数**（`openedThisTick`）：`list()` 对新会话的
    `running` 有滞后，只靠它数会在同一轮里连开好几个、把上限一次冲穿（有探针钉着）。
27. **正文贴图只复用已有的 `issue.assets.upload`**（评论也一样），不新增桥操作：图片只是把
    返回的 `uuid` 拼成 `![文件名](/attachments/{uuid})`（**站内相对路径**，别写死 baseUrl）。
    上传时机由「附件端点要不要 issue 编号」决定：编辑 / 评论**选完立刻传、插到光标处**；新建
    issue 时 `CreateIssueOption` 没有 attachments 字段（网页版那条 `/issues/attachments` 是
    会话 Cookie 的网页路由，API 令牌进不去），只能 **create → upload → `issue.edit` 补正文**，
    追加到正文末尾。新建时图片失败要停在表单页写明「issue 已创建」，别放用户再点一次创建；
    评论贴图借用 issue 附件端点（评论还没 id），删 issue 附件会让评论图失效 —— 这两条已写进
    README「已知边界」，别当成 bug 改回去。
28. **图片内嵌必须由 Host 代取字节**（`attachment.content`，操作表里唯一 `base: 'root'`、
    `raw: true` 的操作）：web 路由 `GET {baseUrl}/attachments/{uuid}` 带令牌可用，匿名 404
    （本机实测），浏览器 `<img>` 跨站拿不到会话。客户端把 base64 转 data URL 渲染，**缓存只在
    内存**；刚上传的图在上传时就写进缓存（上传成功路径里 `ATTACHMENT_CACHE.set`），别退回去
    让每张图都等代理往返。面板**只渲染图片这一种 markdown**，别顺手写成一个半吊子 markdown
    渲染器；拉不到图（旧 Host `unknown-operation` / >10 MiB / 403）要显示**可见的**说明，
    不能留破图，`title` 不算（悬停才看得到）。
29. **编辑器的「预览」必须用 Gitea 的 `POST /markdown`**（`markdown.render`），不要自己写
    markdown 渲染器：字段名是 Go 导出名 `Text` / `Mode` / `Context`（小写会静默回空 body，
    本机实测）；返回 HTML 已 sanitize，客户端只做 `dangerouslySetInnerHTML`，另外把
    `/attachments/{uuid}` 的 `src` 换成 `attachment.content` 的 data URL、拆掉包着图片的
    `<a>`（私有地址点了 404）。旧 Host 回 `unknown-operation` 时预览页签写「重启 Harness」。
    工具栏是纯文本插入（`applyEditorTool` 纯函数），别改成 contenteditable/WYSIWYG。
    附件卡片「移除文件」= 删正文引用 + 按附件 id 删远端（拿不到 id 只删引用）。
30. **issue 详情页照 Gitea 的 issue 页排**（issue #2 给的参考截图）：标题区（`#编号` + 标题 +
    「发送到 DSH / 在浏览器打开 / 编辑」）→ 元信息行 → 左列时间线 / 右列属性栏。别退回成
    「元信息表格 + 一排动作按钮 + 几块堆叠 section」。几条别动：
    - **正文是第一张评论卡片**（和评论共用 `.dsh-gti-comment-card`），空正文写「没有提供说明。」；
    - 两列靠 `flex-wrap`（`flex:1 1 320px` + `flex:0 0 216px`）自适应，**不要媒体查询**：
      要看的是容器宽度（全局看板详情只有半屏），窄了就整列掉下去；
    - **关闭 / 重开在评论编辑器底部左侧**，置顶 / 锁定 / 删除在属性栏底部整宽按钮；
    - **关闭事件只写时间不写人**：`closed_at` 没有操作人，别猜；要写「谁关的」得先接
      `issue.timeline`；
    - 依赖 / 阻塞的 `#编号` 是**纯文本**（旧版那个按钮会打开当前 issue 的编辑页，假的跳转比
      不能点更糟），相邻的「移除」是真的（`dependsOn` 传对端编号）；
    - 复制类按钮走 `copyText()`（`navigator.clipboard` 只在安全上下文里有，局域网 http 下要退
      `execCommand`），**失败不报成功**；头像直连 `/avatars/…`、`onError` 退首字母圆片；
    - 详情页不读 `repo.meta`（那是仓库级数字，只有表单要候选名册）。

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
- **动全局看板的「列表范围」**（取哪些仓库、去重口径、范围提示）→ 同步 README 的
  「界面长什么样 · 全局看板」、「只能在浏览器里看的」第 13 条与 [IMPLEMENTATION.md](IMPLEMENTATION.md)
  的「全局看板列表：范围由绑定决定」一节；`tests/client.test.mjs` 里那四条范围用例跟着改。
- **动「同项目活跃会话上限」**（判据、默认值、结果码 `capped`、面板字段）→ 同步 README 的
  「自动分配任务 · 同项目活跃会话上限」、验收清单第 18 条与「已知边界」，
  [IMPLEMENTATION.md](IMPLEMENTATION.md) 的「同项目活跃会话上限」一节；`tests/watch.test.mjs`
  里那两条上限用例跟着改。
- **动自动分配「模式」（Agent 预设）**（名册来源、选项文案、坏行/缺失处理）→ 同步 README 的
  「自动分配任务 · 怎么开」、「线上协议」的 `presets.list` 行、「只能在浏览器里看的」第 18 条与
  [IMPLEMENTATION.md](IMPLEMENTATION.md) 的「模式」一节；`tests/client.test.mjs` 里那三条模式用例
  跟着改。
- **动「自动投递」徽标**（判据、文案、入口与返回路径）→ 同步 README 的「界面长什么样 · 工作区看板」、
  「只能在浏览器里看的」第 20 条与 [IMPLEMENTATION.md](IMPLEMENTATION.md) 的「徽标」一节；
  `tests/client.test.mjs` 里那五条徽标与倒计时用例跟着改。
- **动「发送到 DSH」**（提示词格式、入口位置、失败横幅）→ 同步 README 的「界面长什么样」、
  「只能在浏览器里看的」第 15 条与「已知边界」，以及 [IMPLEMENTATION.md](IMPLEMENTATION.md)
  的「发送到 DSH」一节；`tests/client.test.mjs` 里那四条用例跟着改。
- **动「正文贴图 / 图片内嵌」**（上传时机、插入位置、图片 markdown、附件归属、代取策略、失败态
  文案）→ 同步 README 的「界面长什么样」、「线上协议」、`too-large`、「只能在浏览器里看的」第 21 条
  与「已知边界」，[IMPLEMENTATION.md](IMPLEMENTATION.md) 的「正文贴图」与「图片为什么要 Host 代取」
  两节；`tests/client.test.mjs` 里那八条、`tests/host.test.mjs` 里那条附件字节用例跟着改。
- **动「编辑器外壳 / 预览」**（页签、工具栏动作、预览来源与降级、附件卡片）→ 同步 README 的
  「界面长什么样」、「线上协议」、「只能在浏览器里看的」第 22 条与「已知边界」，
  [IMPLEMENTATION.md](IMPLEMENTATION.md) 的「编辑器外壳」一节；`tests/client.test.mjs` 里那四条
  编辑器用例跟着改。
- **动「详情页版式」**（标题区、时间线与属性栏、评论卡片、关闭事件行、拖放区、依赖/阻塞条目、
  复制引用、头像）→ 同步 README 的「界面长什么样 · 详情页」、「只能在浏览器里看的」第 5 / 8 /
  9 / 10 / 23 条、[IMPLEMENTATION.md](IMPLEMENTATION.md) 的「详情页：为什么照 Gitea 的 issue 页
  重排」与上面的约束 30；`tests/client.test.mjs` 里那批详情页用例跟着改。
- **改文案键** → `zh` 与 `en` 一起改（探针会拦）。
- **已知边界**写在 README 末尾；**没真正解决之前不要从文档里删掉**。

## 其他事项

- 修改提交后记得 push。
