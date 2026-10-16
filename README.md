# @dongasai/dsh-gitea-task-issues

把 **Gitea 的 issue 管理搬进 DSH**：在一个工作区里绑定它的 Gitea 仓库，然后**不用切浏览器**就把
issues 看完、改完、讨论完 —— 列表 / 搜索 / 详情 / 新建 / 编辑 / 删除 / 附件 / 指派 / 依赖 /
订阅 / 置顶 / 标签 / 锁定 / 工时 / 评论，两处看板都能做；模型侧另有一套 `gitea_*` 工具。

两处看板的分工是刻意的：

- **全局看板**（左侧栏图标，排在官方「自动化任务」下面）看**跨服务器、跨仓库**的一屏：
  你在这个 Gitea 上参与的所有 issue，按更新时间排。服务器与令牌也在这里管。
- **工作区看板**（右侧栏页签）只看**当前工作区绑定的那个仓库** —— 改代码时旁边就是它的 issue。

绑定的价值在于**归因**：issue 属于哪个仓库，由「你在哪个工作区」决定，而不是每次手动挑。
模型侧的工具把这条规则执行得更死 —— 它们**没有** `server` / `repo` 参数，只能操作当前工作区
对应的仓库，不可能「看起来在这个项目里干活、实际改了另一个仓库」。

令牌只存在 Host 侧（DSH 的凭据中心），浏览器那半边从头到尾拿不到它：界面只能点名
「哪台服务器 + 哪个操作」，由 Host 去解密、去请求。

- **怎么用插件** → 本文件（安装、两处看板怎么用、线上协议、排错、怎么验证、已知边界）。
- **为什么这么实现** → [IMPLEMENTATION.md](IMPLEMENTATION.md)（设计取舍、一次调用的完整路径、
  工作区隔离的理由、探针为什么这么写）。

## 功能列表

* 全局dash,在自动化任务下面
* 多服务器管理,密钥管理
* 工作区与仓库绑定,服务器+仓库,自动侦测
* 全局issues看板,位于全局dash
* 工作区issues看板,位于项目右侧面板,只能管理本工作区的(关联仓库的)
    - 列表每行与详情页动作行可「发送到 DSH」：把「请处理 Gitea issue #12：标题」插进当前会话的对话输入框（不带网址）
* 页面issues管理(几乎实现所有可用Api),给用户用的
    - 列出/搜索
    - 查看详情
    - 创建/删除/编辑
    - assets附件
    - 分配/blocks
    - 评论的查看/添加/删除/编辑
    - 订阅/Pin/Label/Lock/times
* dsh工具issues管理(只实现主要功能,没有删除),给agent的用的,进行工作区隔离,只能操作本工作区的,不能选仓库
    - 列出/搜索
    - 查看详情
    - 创建/编辑
    - 评论的查看/添加/编辑

## 快速开始

三步：装插件 → 加服务器与令牌 → 在工作区里绑定仓库。

### 1. 装插件

三种装法，按场景选。**都走同一条 pnpm 路径**（`@deepseek-ai/dsh-plugin-manager/operations`，
共用一把 profile 写锁），装完都会出现在侧栏「插件」页的**已安装**列表里。

**都不需要手写注册行**：本包在 `package.json` 里声明了 `dsh.bundle.patch`，只要这个 bundle 被
选中，生效的那一行就来自本包自带的 [cordis.patch.yml](cordis.patch.yml)。命令行（方式二、三）
安装会顺带把它选进 `dsh.profile.bundles`；Web 上（方式一）是装完点 **立即启用**才选中 ——
不点就只是「装着但没启用」。

本包 `private: true`、未发布到 npm，所以没有「按包名从 registry 装」这条路：spec 要么是本地
路径，要么是 git 地址。

#### 方式一：Web 界面（推荐）

DSH Web → 左侧栏**插件** → **添加插件** → 填入本仓库绝对路径（或下面的 git 地址）→ **安装** →
装完点**立即启用**。

- 「添加插件」接受：包名（可带版本）、Git 地址、压缩包、**本地绝对路径**。
- 装完不点**立即启用**，就只是「装着但没启用」。
- 侧栏这个「插件」页才能装和开关；**设置 → 内置插件**里的清单是只读的。

#### 方式二：命令行 · git 源（分发）

```bash
dsh plugin --profile web add github:dongasai/dsh-gitea-task-issues
# 或
dsh plugin --profile web add git+https://github.com/dongasai/dsh-gitea-task-issues.git
```

`dsh plugin --profile <name> <pnpm args>` 把参数转发给该 profile 目录里的 pnpm。装进来的是
**副本**：之后改本仓库代码不影响已装的副本（想边改边用就走方式三）。

- `--profile` **必填**（不写直接报 `required option '--profile <name> not specified'`）。
- **必须带 `git+` 或 `github:` 前缀**。`git@github.com:owner/repo.git` 这种 scp 写法不会被认成
  git spec，pnpm 会把它当路径，装出一条指向不存在目录的 `link:` 死链。
- **钉版本**：URL 后加 `#`，例如 `...#0.1`（tag / 分支 / commit 都行；本仓库当前 tag 是 `0.1`）。
- pnpm 默认会拦 `prepare` 等依赖构建脚本；本包**没有任何构建步骤**（`client.js` 是手写的浏览器
  bundle，由 Host 直接读盘发出），不会遇到。

#### 方式三：命令行 · 本地目录（link，开发）

```bash
dsh plugin --profile web add link:<本仓库绝对路径>
```

装成 `link:` 依赖，代码改动立刻是「已装的那份」—— 适合边改插件边用。

- 改 **Host 半边**（[index.js](index.js) / [lib/](lib)）：**要重启 Harness** 才生效。
- 改 **浏览器半边**（[client.js](client.js)）：**刷新页面**即可（bundle 每次请求都从磁盘现读，
  按内容 revision 换 URL）。

#### 装完确认

命令行可以直接看合成后的 profile 树（不启动服务）：

```bash
dsh --profile web --dump-config | grep -A1 gitea-task-issues
```

期望看到：

```yaml
- id: gitea-task-issues
  name: '@dongasai/dsh-gitea-task-issues'
```

**运行中的实例要重启才会加载它**（插件行是启动时合成的）：

```bash
systemctl --user restart dsh.service     # 按你的部署方式替换
```

### 2. 加一台 Gitea，写入访问令牌

左侧栏点 **Gitea 看板** 图标 → **Gitea 服务器** → 填名称、地址、访问令牌 → **添加服务器** →
点**探活**。

- 地址只填到实例根（`https://tea.example.com`），**不要**带 `/api/v1`；挂在子路径也支持
  （`https://example.com/gitea`）。
- 令牌在 Gitea 里生成：**设置 → 应用 → 生成令牌**，至少要有 `read:issue` 与 `write:issue`
  （只看不写只要 `read:issue`）。
- 探活成功会显示 `Gitea <版本> · <令牌用户>`；没有令牌时会明确说「未配置」，不会去撞 401。
- **令牌存进 DSH 的凭据中心**（`.credentials.yaml`），界面只能看到「配没配、可不可改」。
  不想用凭据中心就填**令牌环境变量**名（例如 `GITEA_TOKEN`），进程环境里有值就直接用 ——
  这种情况下界面会标注「来自环境变量」，且不可写。
- 配置文件落在 `$DSH_HOME/gitea-task-issues/servers.json`，**里面没有令牌**。

多台服务器就重复这一步；第一台会成为默认服务器。

### 3. 绑定工作区

在**要用它的那个工作区的会话里**打开右侧栏 → **Gitea issues**（引导卡片，或
`Ctrl/Cmd+Alt+G`）→ 右上角齿轮 → **绑定设置**。

| 情况 | 界面显示 | 你要做的 |
|---|---|---|
| 工作区是 git 仓库，remote 主机名 = 已配置服务器 | 「从 .git/config 侦测到 `owner/repo`（host）」+ 直接可用 | **什么都不用做** |
| 侦测到了，但主机名对不上任何服务器 | 黄字「侦测到 `owner/repo`（host），但没有已配置的服务器对应这个主机名。」 | 回第 2 步加那台服务器 |
| 没有 remote（或不是 git 仓库） | 「这个工作区没有可用的 git remote」 | 手填：服务器下拉 + `owner/name` → **绑定** |

- **绑定的键是工作区根的绝对路径，不是会话 id**：同一个目录开多少会话都共享一条绑定；
  换目录就是另一条。
- **手动绑定压过自动侦测**；点「解除绑定」退回侦测。
- 自动侦测读的是 `.git/config` 的 `origin`（没有 origin 就取第一个 remote），支持 worktree /
  submodule（`.git` 是文件时按 `gitdir:` 转一次再读）。

### 4. 确认它真的在工作

工作区看板的标题栏应当从「Gitea 看板」变成 `owner/repo` 并标注 `手动绑定` / `自动侦测`，
下面列出这个仓库的 issues。点一条进详情，能看到正文、标签、指派、里程碑、截止日与评论。

模型侧：在**这个工作区**里让 Agent 跑一次 `gitea_issue_list`，它返回的应当就是同一个仓库的
issues（工具没有仓库参数，见「与 Agent 的关系」）。

## 界面长什么样

### 工作区看板（右侧栏页签）

标题栏：`owner/repo` + 绑定来源，右边依次是 **新建 issue**、**齿轮（绑定设置）**、**刷新**。

- 筛选条：**状态**（进行中 / 已关闭 / 全部）+ **关键词**（搜标题与正文，输入防抖 350ms）。
- 列表行：状态点、`#编号`、标题，第二行是标签、`@指派`、`💬 评论数`、`◎ 里程碑`、`⏱ 截止`、
  `📌`（置顶）、`🔒`（锁定）。
- 详情页：标题 + **在浏览器打开**；元信息（标签 / 指派 / 里程碑 / 截止 / 作者 / 时间）；
  正文；动作行 —— **关闭/重开**、**置顶/取消**、**锁定/解锁**、**订阅/取消订阅**；
  然后是**依赖**（被谁挡住）、**阻塞**（挡住谁）、**工时**（列表 + 登记 + 删除 + 清空）、
  **附件**（列表 + 上传 + 删除）、**评论**（列表 + 发表 + 编辑 + 删除）。
- 新建 / 编辑是同一张表单：标题、正文、标签（点选）、指派（点选）、里程碑、截止日。
  **编辑不是一次请求**：Gitea 的编辑接口没有标签字段，标签走 `/labels` 的整体替换，
  指派按增删做差分 —— 界面上仍然只是「保存」一次。
- 绑定设置页：显示工作区根、自动侦测结果、当前生效的仓库，以及服务器 + `owner/name` 表单。
- **发送到 DSH**：列表行尾一个发送按钮（图标，悬停 / 聚焦时显形），详情页动作行最右也有一个。
  点下去把一行「`请处理 Gitea issue #12：标题`」插进**当前会话**的对话输入框（光标停在末尾的
  新行上）——**不带网址**：模型只能操作当前工作区绑定的仓库，编号就够了，要看网页版详情页有
  「在浏览器打开」。面板上亮一条「已把 #12 发到对话输入框」；拿不到输入框（会话还没起来、对话区
  没打开）或输入框正忙时，横幅写清原因，不静默失败。**只有工作区看板有**：全局看板是跨工作区
  的视图，不碰输入框。

### 全局看板（左侧栏图标）

标题栏：**新建 issue**、**Gitea 服务器**、**刷新**。筛选条多了**服务器**下拉与**所属（owner）**
输入框。列表每行会带上 `owner/repo`，点开是「列表 + 详情」并排。

- 选「全部服务器」时，会对每台服务器各发一次跨仓库搜索，结果合并后按更新时间排；
  某台失败会在横幅里点名（其余照常显示）。
- **新建 issue** 要先选目标：服务器下拉 + `owner/name`（输入框带「我拥有的仓库」候选列表），
  选全了才出现表单。
- **Gitea 服务器**页：服务器表格（名称 / 地址 / 令牌状态 / 操作），**探活**会显示版本与令牌用户；
  **编辑**可改名、改地址、换令牌环境变量、写新令牌或**清除令牌**；**删除**会连带清掉它的令牌
  记录与指向它的绑定（有确认提示）。

### 两个细节

- 右侧栏页签是**页类型**（没有 `patterns`），所以它**不参与任何文件的自动打开排名**；
  入口是引导卡片与快捷键 `Ctrl/Cmd+Alt+G`（命令 id `gitea.issues`，可在快捷键设置里改）。
- 所有写操作都会在动作行/横幅里给出结果或失败原因；**没有后台轮询**，别处改的东西不会自己
  冒出来，点刷新。

## 结构

| 文件 | 作用 |
|---|---|
| [index.js](index.js) | **Host 半边入口**：建配置存储 → 建桥 → 注册路由与 7 个工具。只 import `node:` 内建模块。 |
| [lib/bridge.js](lib/bridge.js) | 桥：信任围栏 + `op` 操作表 + 出线形状 + 失败映射。 |
| [lib/gitea.js](lib/gitea.js) | Gitea API 客户端 + **操作表**（59 条：server 5 / repo 16 / issue 38），路径、参数名、请求体字段只有这一份。 |
| [lib/tools.js](lib/tools.js) | 7 个模型工具（手搓 tool definition）。 |
| [lib/resolve.js](lib/resolve.js) | 「这次操作是哪台服务器 / 哪个仓库 / 哪个会话」的共用解析。 |
| [lib/store.js](lib/store.js) | 配置存储：服务器清单、绑定、原子写、`revision` 乐观并发。 |
| [lib/secrets.js](lib/secrets.js) | 令牌：credentials record 优先，环境变量兜底。 |
| [lib/detect.js](lib/detect.js) | 读 `.git/config` 的 remote，拆 `host/owner/repo`。 |
| [lib/shape.js](lib/shape.js) | Gitea 对象 → 线上对象（**浏览器半边唯一认的字段集**）。 |
| [lib/aggregate.js](lib/aggregate.js) | 详情 / 仓库元信息的一揽子读取（桥与工具共用）。 |
| [lib/errors.js](lib/errors.js) | `BridgeError` / `GiteaError` 与状态码映射。 |
| [client.js](client.js) | **浏览器半边**：全局看板 + 左侧栏图标 + 右侧栏看板页签 + 服务器与绑定管理。 |
| [cordis.patch.yml](cordis.patch.yml) | 只插入一行插件；浏览器半边由 `package.json` 的 `dsh.client` 声明，由 dsh-client-modules 扫出来。 |
| [package.json](package.json) | bundle 清单：`dsh.bundle.patch` + `dsh.client`。 |
| [locale/{zh,en}.json](locale/zh.json) | 插件卡片上的显示名与说明。 |
| [icon.svg](icon.svg) | 插件卡片图标。 |
| [docs/gitea-api-reference.md](docs/gitea-api-reference.md) | Gitea 1.27.3 issue 相关 API 参考（改操作表前先查它）。 |
| [tools/smoke.mjs](tools/smoke.mjs) | 对真实实例的**只读**冒烟（只发 GET）。 |
| [tools/slot-contract.mjs](tools/slot-contract.mjs) | 从本机 DSH 安装里抽客户端槽位契约。 |

Host 半边 `inject`：`webServer` / `connection` / `sessions` / `tools`
（`credentials`、`sandboxPolicy`、`sessionPersistence` 都用 `ctx.get()` 可选取 —— 凭据中心不在时
降级到环境变量，沙箱根只在没有会话时兜底）。

浏览器半边占用的扩展点：

| 扩展点 | 注册物 |
|---|---|
| `sidebar.panellist` | id `gitea-issues`、`order: 20`（官方「自动化任务」是 10，所以排在它下面）、`label: Gitea 看板` |
| `main` | 键 `gitea-issues` 的正文（全局看板） |
| `ctx.sidebarRightTabs.register` | kind `gitea-issues`、id `gitea-issues`、**无 patterns**、guide 卡片「Gitea issues」 |
| `sidebar.right.pane.tab` | 键 `gitea-issues` 的正文（工作区看板） |
| `conversation.input.dock` | id `gitea-issues-input` 的**哨兵**（渲染 `null`，把会话的 `inputActions` 登记进 `inputTargets`，给「发送到 DSH」兜底） |
| `ctx.shortcuts.register` | 命令 `gitea.issues`（默认 `Ctrl/Cmd+Alt+G`） |
| `ctx.locale.register` | 命名空间 `giteaIssues`（zh / en 两套） |

## 线上协议

一条路由，请求体是 `{ op, params, sessionId? }`：

```http
POST /gitea-task-issues/api
content-type: application/json

{ "op": "gitea.call", "params": { "op": "issue.list", "params": { "sessionId": "session-3", "state": "open", "limit": 30 } } }
```

成功（200）：

```json
{ "ok": true, "data": [ … ], "total": 2 }
```

失败（HTTP 状态按码给出）：

```json
{ "ok": false, "code": "no-binding", "message": "workspace \"/x\" is not bound to a repository and no git remote was detected" }
```

`op` 是**白名单**（表里没有的一律 `unknown-operation`，不存在任意 URL 透传）：

| op | 作用 |
|---|---|
| `config.get` | 服务器（含令牌状态）、绑定、`revision`、配置文件路径 |
| `config.server.add` / `config.server.update` / `config.server.remove` | 增 / 改 / 删服务器（`token` 给字符串即写入、给 `null` 即清除、不给就不动；删会连带清令牌与绑定） |
| `config.server.test` / `config.default.set` | 探活 + 验令牌 / 切默认服务器 |
| `binding.get` / `binding.set` / `binding.remove` | 工作区绑定（`binding.get` 顺带回报自动侦测结果与匹配到的服务器） |
| `repo.list` / `repo.meta` | 仓库选择器 / 仓库 + 标签 + 里程碑 + 可指派候选 |
| `issue.detail` | issue 详情一揽子（正文 + 评论 + 附件 + 工时 + 依赖 + 阻塞 + 订阅状态） |
| `gitea.ops` / `gitea.call` | 操作清单（59 条）/ 通用 Gitea 调用：`params.op` 取自操作表 |

`gitea.call` 的 `params` 可以平铺（不必多套一层 `params`），`sessionId` 放在桥请求体顶层或
`params` 里都认。仓库 / issue 级操作缺 `owner` / `repo` 时按工作区绑定补；**补不出来就报原始原因**
（`no-binding` / `no-server-for-host` / `root-required`），不会带着空值去撞参数校验。

`data` 的形状由 [lib/shape.js](lib/shape.js) 决定（瘦身 + 把 `repository.owner.login` 拍平成
`owner`）—— 浏览器半边只认那一份字段集。Gitea 原始字段名与语义见
[docs/gitea-api-reference.md](docs/gitea-api-reference.md)。

### 错误码

本地失败（`BridgeError`）：

| code | HTTP | 含义 |
|---|---|---|
| `bad-request` | 400 | 请求体不是 JSON 对象、字段类型不对、参数超出上限 |
| `unknown-operation` | 400 | `op` 不在桥的操作表里，或 `params.op` 不在 Gitea 操作表里 |
| `unknown-server` | 404 | 服务器 id 不在配置里 |
| `bad-server-id` | 500 | 服务器 id 形状不合法（生成侧已经保证，出现即 bug） |
| `server-required` | 400 | 没点名服务器，而本机有多台且工作区未绑定 |
| `token-missing` | 400 | 这台服务器没配令牌（也不去发匿名请求） |
| `credentials-unavailable` | 503 | 这台 Host 没有凭据中心，只能用环境变量提供令牌 |
| `credentials-write-failed` | 500 | 令牌写不进去（凭据中心拒绝） |
| `root-required` | 400 | 没有会话工作区，也没有可兜底的工作区根 |
| `unknown-session` | 404 | 这个 Host 既不认识活会话，也没有它的存档头 |
| `no-binding` | 400 | 工作区没绑定、也没有可用的 git remote |
| `no-server-for-host` | 400 | 侦测到了 remote，但主机名对不上任何已配置服务器 |
| `stale-config` | 409 | 配置在你操作期间被别处改过（`revision` 不符） |
| `unknown-label` | 400 | 标签名在该仓库里不存在（标签名会先解析成 id） |
| `user-required` | 400 | 订阅类端点需要用户名，而当前令牌用户解析不出来 |
| `nothing-to-do` | 400 | 编辑请求一个字段都没给 |
| `too-large` | 413 | 请求体（32 MiB）或附件（16 MiB）超限 |
| `unsupported-media-type` | 415 | 不是 `application/json` |
| `timeout` / `aborted` / `network-error` | 504 / 499 / 502 | 上游没在 30s 内答复 / 调用被取消 / 连不上 |

上游失败（`GiteaError`）按 Gitea 的状态码映射：`bad-request`(400)、`unauthorized`(401)、
`forbidden`(403)、`not-found`(404)、`method-not-allowed`(405)、`timeout`(408)、`conflict`(409)、
`precondition-failed`(412)、`too-large`(413)、`validation-failed`(422)、`rate-limited`(429)、
`upstream-error`(5xx 与未映射)；`details.giteaStatus` 里带着原始状态码。表里没有的一律
`upstream-error`，不猜。

其它方法一律 `405` + `allow: POST`；所有应答都带 `cache-control: no-store`。

## 安全模型

1. **信任围栏**：每个请求先过 `ctx.connection.requestRejection(req)` —— 不可信 Host/Origin
   直接 403，浏览器没认证就是 401。非本机认证页面发不进来。
2. **令牌不出 Host**：浏览器只能点名「哪台服务器 + 哪个操作」；令牌由 Host 从凭据中心（或环境
   变量）取出后使用。配置文件、日志、桥的应答里都不会出现令牌；界面只能问
   「配没配、可不可写」。
3. **操作表是白名单**：`op` 不在表里直接拒；表里每条都是写死的路径模板，参数逐项收敛
   （类型、枚举、上限），不接受调用方拼 URL。
4. **不静默重试、不做后台轮询**：读写都可能改变远端状态，一次用户动作一次调用，失败如实回报。
   删除类动作（issue / 评论 / 附件 / 服务器）界面都会二次确认，且**不可撤销**。

边界说明：**这不是**权限隔离 —— 能打开这个 GUI 的本机用户本来就能用令牌做到同样的事。
插件只是把令牌**收在 Host 侧**，并且不给浏览器任何「拼一个任意请求」的口子。

## 与 Agent 的关系

- 给模型的是 **7 个工具**：`gitea_issue_list`、`gitea_issue_get`、`gitea_issue_create`、
  `gitea_issue_edit`、`gitea_issue_comments`、`gitea_issue_comment_create`、
  `gitea_issue_comment_edit`。**没有删除** —— 破坏性动作留给人在界面上做（带二次确认）。
- **工作区隔离**：这些工具的**参数里没有** `server` / `repo`（也没有跨仓库搜索档）。目标只能由
  当前会话的工作区解析出来：手动绑定优先，其次读该工作区 `.git/config` 的 remote 自动侦测。
  解析不出就报 `no-binding` / `no-server-for-host` / `root-required`，**不会猜一个默认仓库去改**。
  换个工作区就换个仓库 —— 同一套代码在 A 工作区操作 A 的仓库，在 B 工作区操作 B 的。
- 界面**不受**这条限制：全局看板本来就要跨服务器 / 跨仓库看。
- 工具的**出参会过 DSH 注册表自己的 JSON Schema 校验**，所以字段集与界面看到的是同一份
  （都来自 [lib/shape.js](lib/shape.js)）；模型读到的文本渲染是紧凑版（正文与评论按长度截断）。

## 排错

浏览器侧的现象先看**横幅文案**；Host 侧的现象看 Harness 日志。

横幅里显示什么，分两种情况：**传输层失败**（请求没到）与**缺令牌**是中文提示；其余情况显示
Host 回来的原始说明 —— 多数是英文，左列括号里给出它的 `code`，照着 code 查更快。

| 症状 | 原因 | 处置 |
|---|---|---|
| 看板说「连不上 Host（桥接路由没有响应）」 | 请求根本没到：插件没启用，或 `index.js` 改过只刷新了页面（路由还没注册） | 确认插件行 `enabled`；改过 Host 半边就**重启 Harness** |
| 看板报 `token-missing` | 这台服务器没配令牌 | 去全局看板填令牌，或设好 `tokenEnv` 指向的环境变量 |
| 探活失败但地址没错 | 地址带了 `/api/v1`，或自签证书不被宿主信任 | 地址只填到实例根；自签证书要让宿主信任 |
| `unauthorized` | 令牌无效 / 过期 / 被撤销 | 在 Gitea 里重新生成 |
| `forbidden` | 令牌 scope 不够（缺 `write:issue`），或该仓库不允许你操作 | 换有权限的令牌 / 仓库 |
| `not-found` | `owner/repo` 或 issue 编号不存在。**issue 编号是 Gitea 的 `number`，不是数据库 `id`** | 核对编号；界面上显示的就是 `#number` |
| `validation-failed`（422） | 标签名在该仓库里不存在，或里程碑 id 不对 | 从表单里的候选点选，别手打标签名 |
| `no-binding` | 这个工作区没绑定、也没有可用的 git remote | 去绑定设置手填，或给工作区挂一个 remote |
| `no-server-for-host` | 侦测到了 remote，但主机名没有对应的已配置服务器 | 先加那台服务器 |
| `stale-config` | 配置在你操作期间被别处改过（两个页面同时在改服务器） | 刷新后重试 |
| 报 `owner must be a non-empty string` | **旧版本桥的 bug**：`gitea.call` 丢掉了 `params` 内层的 `sessionId`，仓库解析回退后带着空 owner 去撞校验（真实原因被掩盖） | 更新到含该修复的版本并**重启 Harness**；现在的版本会报真实的 `no-binding` |
| 找不到右侧栏页签入口 | 页签是**页类型**，不参与文件自动打开 | 用右侧栏引导卡片，或 `Ctrl/Cmd+Alt+G` |
| 全局看板某台服务器没数据，横幅点名了它 | 那台失败（令牌 / 网络），其余照常 | 按横幅里的原因处理那台 |
| 从 shell 里 curl 这条路由拿到 `{"ok":false,"error":"unauthorized"}` | **不是插件的应答**：本 profile 装了 `@xgone/dsh-remote`，它猴补 `ctx.webServer.register`，给之后注册的每条路由套一层会话门禁 | 在页面里点（浏览器带着它自己的会话），或带上它的登录 cookie |
| 插件行是 `enabled: true` 但页面里什么都没变 | 浏览器 bundle 还是上一次加载的 | 刷新页面 |
| 改了 `lib/*.js` 或 `index.js` 不生效 | Host 半边不在 HMR 监视集内，ESM 模块缓存按解析后的 URL 命中 | **重启 Harness**（禁用 / 启用插件不够） |

## 怎么验证

### 命令行能覆盖的部分

**静态自检**：

| 检查 | 命令 | 期望 |
|---|---|---|
| 两半语法 | `node --check index.js && node --check client.js`（或 `npm run check`） | 退出码 0 |
| 全部探针 | `node --test tests/*.test.mjs`（或 `npm test`） | 37 个用例全过 |

**探针覆盖了什么**（都在本地，不需要网络）：

| 文件 | 覆盖 |
|---|---|
| [tests/host.test.mjs](tests/host.test.mjs) | 28 例：地址与 git remote 解析、配置存储（原子写 / 乐观并发 / 坏文件留档）、绑定与自动侦测、issue / 评论 / 附件 / 指派 / 依赖 / 订阅 / 置顶 / 锁定 / 工时全链路、上游失败映射、**界面调用形状的回归**、7 个工具（出参过注册表自己的校验器）、**工作区隔离**（参数集 + 换工作区就换仓库） |
| [tests/client.test.mjs](tests/client.test.mjs) | 7 例：用[迷你 React](tests/mini-react.mjs) 真渲染组件树并点交互（进详情 / 新建 / 切筛选 / 探活 / 绑定设置） |
| [tests/catalog.test.mjs](tests/catalog.test.mjs) | 2 例：注册面与官方槽位目录对照（键存在、基数要求的注册项齐全、`main` 不撞保留键、面板 `order > 10`） |

**对真实实例的只读冒烟**（只发 GET，不建不删不改）：

```bash
GITEA_BASE_URL=https://tea.example.com GITEA_TOKEN=xxx node tools/smoke.mjs
```

期望逐行 `✔`，最后一行「全部通过」；退出码 0。它会依次验证 `server.version` / `server.user` /
`issue.search`，挑一个有 issue 的仓库跑仓库级端点，再挑一条 issue 跑 issue 级端点
（`issue.get` / comments / timeline / assets / times / dependencies / blocks / labels /
subscription.check / subscribers / pinned）。`forbidden` 与 `not-found` 记为 `·`（「这台实例
没开这个能力」不算路径错），其余记为 `✖` 并让退出码变 1。

**HTTP 面**（不经过界面）：

| 检查 | 手段 | 期望 |
|---|---|---|
| 路由存在性 | `GET /gitea-task-issues/api` | `405` + `allow: POST`（而不是 SPA 的 HTML） |
| 信任围栏 | 无认证的 `POST` | 被拒（403/401），不会落到 SPA fallback |
| 未知操作 | `POST` + `{"op":"nope"}` | `400` + `code: unknown-operation` |

上表的三条期望是**插件自己的行为**（在探针里逐条验过）。但本机这个 profile 装了
`@xgone/dsh-remote`，它猴补 `ctx.webServer.register`，给之后注册的每条路由套一层会话门禁 ——
于是从 shell 打任何一条都先撞上它，返回 `{"ok":false,"error":"unauthorized"}`，看不到插件
自己的 405 / 400。那不是本插件的应答；要照上表验，得在页面里点，或临时禁用那个插件。

### 只能在浏览器里看的

样式与布局没有前端测试环境，命令行替代不了。手工走一遍：

1. **左侧栏图标**出现在官方「自动化任务」**下面**，点开是全局看板（标题「Gitea 看板」）。
2. **右侧栏**：引导卡片里有「Gitea issues」，`Ctrl/Cmd+Alt+G` 也能开；打开后标题栏先是
   「Gitea 看板」，绑定后变成 `owner/repo` + 绑定来源。
3. **加服务器**：填名称 / 地址 / 令牌 → 添加 → **探活**显示 `Gitea <版本> · <你的用户名>`；
   令牌状态显示「已配置」。
4. **绑定**：齿轮 → 绑定设置。手填 `owner/name` 保存后，标题栏与列表立刻跟着变；
   点「解除绑定」回到自动侦测（若该工作区有 remote）。
5. **列表与详情**：切换状态筛选（进行中 / 已关闭 / 全部）与关键词，列表跟着变；点一条进详情，
   正文 / 标签 / 指派 / 里程碑 / 截止日都对得上；点「在浏览器打开」跳到 Gitea 网页。
6. **新建**：`＋` → 填标题与正文 → 创建；列表里出现新条目（刷新后仍在）。
7. **编辑**：详情 → 编辑 → 改标题 / 正文 / 标签 / 指派 / 里程碑 / 截止日 → 保存；
   列表与详情都跟着变；清空截止日后再保存，详情里截止日应变成「无」。
8. **评论**：发表一条 → 出现在列表里；点「编辑」改文案 → 保存后变化；点「删除」→ 确认后消失。
9. **动作行**：关闭 / 重开、置顶 / 取消（列表行出现 `📌`）、锁定 / 解锁（出现 `🔒`）、
   订阅 / 取消（按钮文案在「订阅 / 取消订阅」之间切换）。
10. **依赖与阻塞**：在「依赖」里填一个存在的 issue 编号 → 加依赖，条目出现；「阻塞」同理。
    编号填不存在的会报错（错误文案来自 Gitea）。
11. **工时**：填 30 分钟 → 登记工时，列表出现一条且合计跟着变；删除单条、清空全部各试一次。
12. **附件**：上传一个小文件 → 条目出现、能点开下载；删除它 → 确认后消失。
    传一个超过 16 MiB 的文件应被前端拦住并提示上限。
13. **全局看板**：切服务器下拉、填 owner 收窄、切状态；点开一条是「列表 + 详情」并排；
    **新建 issue** 要先选服务器与 `owner/name` 才出现表单。
14. **主题**：切到暗色，文字与边框仍可读（样式只用了 `--dsw-alias-*` 主题令牌）。
15. **发送到 DSH**：在工作区看板里把鼠标移到某条 issue 行上，行尾出现发送按钮；点一下，
    **当前会话**的对话输入框里多出一行 `请处理 Gitea issue #12：标题`（**不带网址**，光标在下一行），
    面板顶部亮「已把 #12 发到对话输入框」，直接回车能把这条发出去。详情页动作行最右的「发送到 DSH」同理。
    把对话区关掉（或开一个没有对话区的布局）再点，应提示「拿不到对话输入框」，而不是静默失败。

## 已知边界

- **issue 编辑不带乐观锁**：Gitea 的 `PATCH /issues/{index}` 支持 `content_version` 做冲突检测，
  这里没用 —— 两人同时改同一条时后写覆盖先写。代价与理由见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。
- **跨仓库搜索不能按单个仓库过滤**：上游的 `/repos/issues/search` 只支持 `owner`，所以全局看板
  选「全部服务器」时仓库筛选不可用（工作区看板不受影响）。**模型工具也没有跨仓库档** ——
  那是「换个仓库看」的能力，与工作区隔离相冲。
- **分页上限由实例决定**：实际上限来自 `GET /settings/api` 的 `max_response_items`；插件按 50
  请求、最多 100，列表**不自动翻页**，要下一页得自己改 `page`（界面没做翻页控件）。
- **附件走 base64 过桥**：单文件上限 16 MiB（桥请求体 32 MiB），更大的文件请在 Gitea 网页传。
- **没有 issue 时间线视图**：`issue.timeline` 在操作表里可用（`gitea.call` 能调），界面没做事件流
  渲染（标签变更、指派变更、引用这些条目）。
- **评论附件没有界面入口**：操作表里有 `comment.assets.*`（评论级附件），界面只做了 issue 级
  附件与评论正文。
- **不做后台轮询**：列表是打开 / 手动刷新时取的，别处的改动不会自动出现。
- **草稿只在内存里**：写了一半的评论切走就没了。
- **删除不可撤销**：issue / 评论 / 附件 / 服务器都是永久删除（服务器还会连带清掉令牌记录与
  绑定），界面会二次确认。
- **绑定按工作区根路径存**：同一个仓库在多个工作区里各绑一次；换机器 / 换 `$DSH_HOME` 不跟随。
- **探活只验两件事**：`GET /version`（不需要令牌）+ `GET /user`（验令牌），不校验仓库级权限 ——
  仓库级权限要等真正操作时才会暴露为 `forbidden`。
- **`link:` 安装时 Host 半边改完要重启 Harness**：本目录不在 HMR 的监视集内，禁用 / 启用插件
  只会重挂 fiber，不会重新 `import()` 模块。浏览器半边不受这条限制（刷新即新）。
- **只有两处看板，没有独立设置页**：服务器与绑定都收在全局看板与工作区看板的齿轮里；
  `settings.section` 那类槽位没用。
- **「发送到 DSH」只在工作区看板，且只插一行文本**：它要的是当前会话的输入框
  （`conversation.input.dock`），全局看板是跨工作区视图、没有这个面。公开的写入面只有
  `insertText`，插进去的是 `请处理 Gitea issue #12：标题` 这一行普通文本，不是结构化的 issue
  芯片；**不带网址**，模型侧靠编号 + 标题自己判断（工作区隔离下 `gitea_issue_get` 也只会看当前
  工作区绑定的仓库）。

## 相关文件

| 文件 | 关系 |
|---|---|
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | 为什么这么实现：为什么只用 `node:`、为什么一条桥 + 操作表、为什么令牌用 record、绑定解析顺序、出线形状层、工作区隔离的理由、探针怎么搭 |
| [AGENTS.md](AGENTS.md) | 给代理的速查：命令、硬性约束、代码风格、验证规范、改动连带项 |
| [docs/gitea-api-reference.md](docs/gitea-api-reference.md) | Gitea 1.27.3 issue 相关 API 参考（路径 / 参数 / 请求体 / 坑） |
| [index.js](index.js) / [lib/](lib) | Host 半边全部实现 |
| [client.js](client.js) | 浏览器半边全部实现 |
| [cordis.patch.yml](cordis.patch.yml) | profile 里的插入行 |
