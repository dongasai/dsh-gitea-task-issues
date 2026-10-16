# @dongasai/dsh-gitea-task-issues

DSH 插件：把**工作区绑到 Gitea 仓库**，然后在两处看板里处理 issues —— 全局看板（跨服务器）
与工作区看板（右侧栏，只管当前工作区关联的那个仓库）；另外给模型一套 `gitea_*` 工具。

一个包两半：

- **Host 半边**（[index.js](index.js) + [lib/](lib)）：持有服务器清单、令牌与「工作区 ↔ 仓库」绑定，
  注册一条桥接路由 `POST /gitea-task-issues/api` 代理 Gitea API，并把 7 个工具注册给模型。
  **令牌只在 Host 侧**，浏览器那半边从头到尾拿不到。
- **浏览器半边**（[client.js](client.js)）：注册全局看板页、左侧栏面板图标，以及右侧栏的
  「Gitea issues」看板页签。

## 功能列表

* 全局dash,在自动化任务下面
* 多服务器管理,密钥管理
* 工作区与仓库绑定,服务器+仓库,自动侦测
* 全局issues看板,位于全局dash
* 工作区issues看板,位于项目右侧面板,只能管理本工作区的(关联仓库的)
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

对应的模型工具名：`gitea_issue_list`、`gitea_issue_get`、`gitea_issue_create`、
`gitea_issue_edit`、`gitea_issue_comments`、`gitea_issue_comment_create`、
`gitea_issue_comment_edit`。

## 快速开始

### 1. 装插件

本包 `private: true`、未发布到 npm，spec 只能是本地路径或 git 地址。

**Web 界面**：DSH Web → 左侧栏**插件** → **添加插件** → 填本仓库的绝对路径 → **安装** →
装完点**立即启用**。

**命令行**：

```bash
dsh plugin --profile web add <本仓库绝对路径>
```

不需要手写注册行：本包在 `package.json` 里声明了 `dsh.bundle.patch`，只要这个 bundle 被选中，
生效的那一行就来自本包自带的 [cordis.patch.yml](cordis.patch.yml)（`id: gitea-task-issues`）。

改完代码的生效方式：

| 改了 | 生效方式 |
|---|---|
| [client.js](client.js) | 刷新浏览器页面 |
| [index.js](index.js) / [lib/](lib) / `cordis.patch.yml` / `package.json` 的 `dsh.*` | 重启 Harness |

### 2. 加一台 Gitea，写入访问令牌

左侧栏点 **Gitea 看板** 图标 → **Gitea 服务器** → 填名称、地址、访问令牌 → **添加服务器** →
点**探活**确认。

- 地址只填到实例根（`https://tea.example.com`），**不要**带 `/api/v1`；挂在子路径也支持
  （`https://example.com/gitea`）。
- 令牌在 Gitea 里生成：**设置 → 应用 → 生成令牌**，至少要有 `read:issue` 与 `write:issue`
  （只看不写只要 `read:issue`）。
- 令牌存进 DSH 的凭据中心，**界面只能看到「配没配、可不可改」**。不想用凭据中心就填
  **令牌环境变量**名（例如 `GITEA_TOKEN`），进程环境里有值就直接用。
- 配置文件落在 `$DSH_HOME/gitea-task-issues/servers.json`，**里面没有令牌**。

### 3. 绑定工作区

打开任意会话 → 右侧栏 **Gitea issues** 页签（从右侧栏的引导卡片或 `Ctrl/Cmd+Alt+G` 打开）→
点右上角齿轮。

- 工作区是 git 仓库、remote 主机名又和已配置服务器对得上时，**自动侦测**出 `owner/repo`
  并直接可用；
- 想固定成别的仓库就在绑定设置里手填 `owner/name` 保存 —— **手动绑定压过自动侦测**；
- 解除绑定后回到自动侦测。

### 4. 用起来

- **工作区看板**（右侧栏）：列表 → 点一条进详情 → 编辑 / 评论 / 附件 / 指派 / 依赖 / 订阅 /
  置顶 / 锁定 / 工时；右上角 `＋` 新建 issue。
- **全局看板**（左侧栏图标，位置在官方「自动化任务」下面）：跨服务器（或指定一台）、
  跨仓库的 issue 列表，点开是「列表 + 详情」并排；右上角可进服务器管理。

## 模型工具：工作区隔离

7 个工具**只能操作当前会话工作区对应的那个仓库**，参数里**没有** `server` / `repo`
（也没有跨仓库搜索档）—— 模型无法把操作指向别的仓库。

目标这样解析：手动绑定优先，其次读该工作区 `.git/config` 的 remote 自动侦测，再和已配置
服务器按主机名配对。解析不出（工作区不是 git 仓库、或 remote 主机名没有对应服务器）时，工具
明确报 `no-binding` / `no-server-for-host` / `root-required`，**不会猜一个仓库去改**。

换个工作区就换个仓库：同一个工具在 A 工作区操作 A 的仓库，在 B 工作区操作 B 的。

> 界面（两处看板）不受这条限制：全局看板本来就要跨服务器 / 跨仓库看；工作区看板只看当前
> 工作区绑定的仓库。

## 线上协议

一条路由：`POST /gitea-task-issues/api`，请求体 `{ op, params, sessionId? }`。

- 成功：HTTP 200 + `{ ok: true, data, total? }`；
- 失败：HTTP 4xx/5xx + `{ ok: false, code, message, details? }`。

`op` 是**白名单**（表里没有的一律 `unknown-operation`，不存在任意 URL 透传）：

| op | 作用 |
|---|---|
| `config.get` / `config.server.add` / `config.server.update` / `config.server.remove` | 服务器与令牌管理（带 `revision` 乐观并发） |
| `config.server.test` / `config.default.set` | 探活 + 验令牌 / 切默认服务器 |
| `binding.get` / `binding.set` / `binding.remove` | 工作区绑定（`binding.get` 顺带回报自动侦测结果） |
| `repo.list` / `repo.meta` | 仓库选择器 / 仓库 + 标签 + 里程碑 + 可指派候选 |
| `issue.detail` | issue 详情一揽子（正文 + 评论 + 附件 + 工时 + 依赖 + 阻塞 + 订阅状态） |
| `gitea.ops` / `gitea.call` | 操作清单 / 通用 Gitea 调用（`op` 取自操作表） |

`data` 的形状由 [lib/shape.js](lib/shape.js) 决定（瘦身 + 把 `repository.owner.login` 拍平成
`owner`）—— 浏览器半边只认那一份字段集。Gitea 原始字段名与语义见
[docs/gitea-api-reference.md](docs/gitea-api-reference.md)。

## 安全模型

1. **Connection 信任围栏**：桥的第一件事是 `ctx.connection.requestRejection(req)`，非本机认证
   页面一律拒；只接受 POST + `application/json`，请求体有上限。
2. **令牌不出 Host**：浏览器只能点名「哪台服务器 + 哪个操作」，令牌由 Host 解密后使用；
   配置文件、日志、桥的应答里都不会出现令牌。
3. **操作表是白名单**：`op` 不在表里直接拒；表里每条都是写死的路径模板，参数逐项收敛
   （类型、枚举、上限），不接受调用方拼 URL。
4. **不静默重试**：读写都可能改变远端状态，一次用户动作一次调用，失败如实回报。

## 排错

| 现象 | 原因与处理 |
|---|---|
| 看板说「连不上 Host」 | 桥接路由没起来：插件没启用，或 `index.js` 改过没重启 Harness |
| `token-missing` | 这台服务器没配令牌：去全局看板填，或设置对应的环境变量 |
| `unauthorized` | 令牌无效 / 过期 / 被撤销：重新生成 |
| `forbidden` | 令牌 scope 不够（缺 `write:issue`），或该仓库不允许你操作 |
| `not-found` | `owner/repo` 或 issue 编号不存在。**issue 编号是 Gitea 的 `number`，不是数据库 `id`** |
| `validation-failed` | 上游 422：多半是标签名在仓库里不存在，或里程碑 id 不对 |
| `no-binding` | 这个工作区没绑定、也没有可用的 git remote：去绑定设置手填（工具与界面都会报它） |
| `root-required` | 工具调用没有会话工作区（例如不在工作区里跑）：工具只在工作区里工作 |
| `no-server-for-host` | 侦测到了 remote，但主机名没有对应的已配置服务器：先添加服务器 |
| `stale-config` | 配置在你操作期间被别处改过：刷新后重试 |
| 找不到右侧栏页签入口 | 从右侧栏引导卡片或 `Ctrl/Cmd+Alt+G` 打开；它是**页类型**，不参与文件自动打开 |
| 探活失败但地址没错 | 地址别带 `/api/v1`；自签证书的实例需要宿主信任该证书 |

## 怎么验证

### 命令行能覆盖的部分

```bash
node --test tests/*.test.mjs   # 36 个用例
node --check index.js && node --check client.js
```

测试自带**假 Gitea**（[tests/mock-gitea.mjs](tests/mock-gitea.mjs)）与**假 ctx**，覆盖：地址与
git remote 解析、配置存储（原子写 / 乐观并发 / 坏文件留档）、绑定与自动侦测、issue / 评论 /
附件 / 指派 / 依赖 / 订阅 / 置顶 / 锁定 / 工时全链路、上游失败映射、7 个工具（出参用注册表
自己的校验器验一遍）。浏览器半边用[迷你 React](tests/mini-react.mjs) 把组件树真渲染一遍，
覆盖注册面、渲染面与主要交互（点行进详情、新建、切筛选、探活、绑定设置）。

### 只能在浏览器里看的

1. 左侧栏图标出现在「自动化任务」**下面**，点开是全局看板；
2. 右侧栏引导卡片与 `Ctrl/Cmd+Alt+G` 能打开「Gitea issues」页签；
3. 列表 → 详情 → 编辑 → 保存后列表跟着变；
4. 新建 issue（全局看板要先选服务器与 `owner/name`）；
5. 评论发表 / 编辑 / 删除；
6. 附件上传（选文件 → 出现条目 → 能下载）；
7. 服务器探活显示 Gitea 版本与令牌用户；
8. 深浅色主题下文字与边框都可读（只用了主题令牌）。

## 已知边界

- **issue 编辑不带乐观锁**：Gitea 的 `PATCH /issues/{index}` 支持 `content_version` 做冲突检测，
  这里没用 —— 两人同时改同一条时后写覆盖先写。
- **跨仓库搜索不能按单个仓库过滤**：上游只支持 `owner`，所以全局看板选「全部服务器」时
  仓库筛选不可用（工作区看板不受影响）。**模型工具没有跨仓库档** —— 那是「换个仓库看」的
  能力，与工作区隔离相冲。
- **分页上限由实例决定**：实际上限来自 `GET /settings/api` 的 `max_response_items`；插件按 50
  请求、最多 100，列表不自动翻页。
- **附件走 base64 过桥**：单文件上限 16 MiB（桥请求体 32 MiB），更大的文件请在 Gitea 网页传。
- **没有 issue 时间线视图**：`issue.timeline` 在操作表里可用（`gitea.call` 能调），界面没做
  事件流渲染。
- **不做后台轮询**：列表是打开 / 手动刷新时取的，别处的改动不会自动出现。
- **草稿只在内存里**：写了一半的评论切走就没了。
- **删除不可撤销**：issue / 评论 / 附件都是永久删除，界面会二次确认。

## 相关文件

| 文件 | 作用 |
|---|---|
| [index.js](index.js) / [lib/](lib) | Host 半边（桥、Gitea 客户端、工具、存储） |
| [client.js](client.js) | 浏览器半边（两处看板 + 绑定与服务器管理） |
| [cordis.patch.yml](cordis.patch.yml) | 插进 profile 的那一行 |
| [docs/gitea-api-reference.md](docs/gitea-api-reference.md) | Gitea 1.27.3 issue 相关 API 参考 |
| [AGENTS.md](AGENTS.md) | 给编码代理的项目须知 |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | 设计取舍与来龙去脉 |
