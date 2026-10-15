# Gitea Issue 相关 API 参考

> 本文只记录 Gitea swagger 规范里的事实。凡规范未写明之处一律标注「swagger 中未说明」，不做推测。

## 来源与版本

| 项 | 值 |
| --- | --- |
| 规范文件 | `/tmp/giti/swagger.v1.json`（870,698 字节） |
| 规范版本字段 | `swagger: "2.0"`；**没有** `openapi` 字段，即 **Swagger 2.0** |
| Gitea 版本（`info.version`） | **1.27.3** |
| API 标题 / 许可 | `Gitea API` / MIT |
| `basePath` | `/api/v1` |
| `host` | swagger 中未声明（无 `host` 字段）；`schemes: ["https", "http"]` |
| 全局 `consumes` | `application/json` |
| 全局 `produces` | `application/json` |
| 规模 | 308 条 path，222 个 definition |

> **读取说明**：编写本文时 `/tmp/giti/swagger.v1.json` 在本执行环境内不可读（该路径位于另一挂载命名空间），实际依据仓库 README 记载的源 `https://tea.2sxo.com/swagger.v1.json` 重新取得，大小同为 870,698 字节，并与工作区 `.cache/swagger.v1.json` 逐字节一致（MD5 `4b8a5ae1eb683eca9f1efde285771e88`），可视为同一份输入。

### 认证方式（swagger `securityDefinitions`）

| 方案 | 位置 | 参数名 | 说明（swagger 原文摘要） |
| --- | --- | --- | --- |
| `AuthorizationHeaderToken` | header | `Authorization` | token 需以 `token` + 空格作前缀 |
| `BasicAuth` | basic | — | HTTP Basic |
| `SudoHeader` | header | `Sudo` | 以该值对应用户身份发请求；**需要 admin 权限** |
| `SudoParam` | query | `sudo` | 同上 |
| `TOTPHeader` | header | `X-GITEA-OTP` | 开启两步验证时须与 BasicAuth 配合 |
| `Token` | query | `token` | **已废弃**，原文「deprecated for removal in Gitea 1.23」 |
| `AccessToken` | query | `access_token` | **已废弃**，同上 |

全局 `security` 为 `BasicAuth / Token / AccessToken / AuthorizationHeaderToken / SudoParam / SudoHeader / TOTPHeader`，任一即可。

> **逐端点权限要求：swagger 中未说明。** 全文 308 个操作**没有任何一个**带 operation 级 `security` 覆盖（全部继承全局），issue 相关端点的 description 也从未出现 admin / scope 字样。权限只能从响应码间接推断：`403`（`APIForbiddenError`）、`423`（`APIRepoArchivedError`，仓库已归档）、订阅端点的 `304`（"User can only subscribe itself if he is no admin"）。

### 本文覆盖的端点总数

**64 个操作**（61 个在用 + 3 个标记 `deprecated`），分布在下面第 1~12 节。第 13 节是通用参数说明。

---

## 1. 仓库 issue 主体

| 方法 路径 | 用途 | 请求体 | 成功响应 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues` | 列出仓库的 issue | — | `200` → `[Issue]` | 否 |
| `GET /repos/issues/search` | 跨仓库搜索当前用户可访问的 issue | — | `200` → `[Issue]` | 否 |
| `GET /repos/{owner}/{repo}/issues/{index}` | 查看单个 issue | — | `200` → `Issue` | 否 |
| `POST /repos/{owner}/{repo}/issues` | 创建 issue | `CreateIssueOption` | `201` → `Issue` | 否 |
| `PATCH /repos/{owner}/{repo}/issues/{index}` | 编辑 issue | `EditIssueOption` | `201` → `Issue` | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}` | 删除 issue | — | `204`（空） | 否 |
| `POST /repos/{owner}/{repo}/issues/{index}/deadline` | 单独设置截止日期（传 null 表示删除截止日期） | `EditDeadlineOption` | `201` → `Issue` | 否 |

`operationId`：`issueListIssues` / `issueSearchIssues` / `issueGetIssue` / `issueCreateIssue` / `issueEditIssue` / `issueDelete` / `issueEditIssueDeadline`。

### 1.1 `GET /repos/{owner}/{repo}/issues` 查询参数

| 参数 | 类型 | 必填 | 取值 / 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `state` | string | 否 | 枚举 `closed` / `open` / `all`；**无默认值声明** | 是否只看打开/关闭 |
| `labels` | string | 否 | — | 逗号分隔的 **label 名**；命中任一标签即返回；不存在的标签被丢弃 |
| `q` | string | 否 | — | 搜索字符串 |
| `type` | string | 否 | 枚举 `issues` / `pulls` | 「if set」才按类型过滤 |
| `milestones` | string | 否 | — | 逗号分隔的里程碑 **名称或 id**（优先按名称，回退按 id）；不存在的被丢弃 |
| `since` | string (date-time) | 否 | RFC 3339 | 只返回该时间**之后更新**的项 |
| `before` | string (date-time) | 否 | RFC 3339 | 只返回该时间**之前更新**的项 |
| `created_by` | string | 否 | — | 只看该用户创建的 |
| `assigned_by` | string | 否 | — | 只看指派给该用户的 |
| `mentioned_by` | string | 否 | — | 只看提到该用户的 |
| `page` | integer | 否 | 1-based；**无默认值声明** | 页码 |
| `limit` | integer | 否 | **无上下限声明** | 每页数量 |

**没有** `sort` / `order` 参数（swagger 未列出）。

### 1.2 `GET /repos/issues/search` 查询参数

| 参数 | 类型 | 必填 | 取值 / 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `state` | string | 否 | 枚举 `open` / `closed` / `all`；**默认 `open`** | issue 状态 |
| `labels` | string | 否 | — | 逗号分隔 label 名，命中任一即返回 |
| `milestones` | string | 否 | — | 逗号分隔里程碑**名称** |
| `q` | string | 否 | — | 搜索字符串 |
| `type` | string | 否 | 枚举 `issues` / `pulls` | 过滤 issue 类型 |
| `since` | string (date-time) | 否 | RFC 3339 | 该时间之后更新 |
| `before` | string (date-time) | 否 | RFC 3339 | 该时间之前更新 |
| `assigned` | boolean | 否 | **默认 `false`** | 只看指派给当前认证用户的 |
| `created` | boolean | 否 | **默认 `false`** | 只看当前认证用户创建的 |
| `mentioned` | boolean | 否 | **默认 `false`** | 只看提到当前认证用户的 |
| `review_requested` | boolean | 否 | **默认 `false`** | 只看请求当前用户 review 的 PR |
| `reviewed` | boolean | 否 | **默认 `false`** | 只看当前用户 review 过的 PR |
| `owner` | string | 否 | — | 按仓库 owner 过滤 |
| `created_by` | string | 否 | — | 只看指定用户创建的 |
| `team` | string | 否 | — | 按 team 过滤（**需同时给 owner 参数**） |
| `page` | integer | 否 | **默认 `1`**，`minimum: 1` | 页码 |
| `limit` | integer | 否 | `minimum: 0`，无上限声明 | 每页数量 |

成功响应是**裸数组** `[Issue]`，**不是** `{ok, data}` 包装（`{ok,data}` 只有仓库搜索 `GET /repos/search` 用）。**没有** `sort` / `order` 参数。

### 1.3 请求体

**`CreateIssueOption`（POST）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | **是** | 标题 |
| `body` | string | 否 | 正文 |
| `assignee` | string | 否 | swagger 描述为 **deprecated** |
| `assignees` | [string] | 否 | 一组用户名 |
| `closed` | boolean | 否 | 直接以关闭状态创建 |
| `due_date` | string (date-time) | 否 | 截止日期；**只用日期部分，时间被忽略** |
| `labels` | [integer(int64)] | 否 | **label id 列表**（不是名字） |
| `milestone` | integer(int64) | 否 | 里程碑 id |
| `projects` | [integer(int64)] | 否 | 项目 id 列表 |
| `ref` | string | 否 | — |

**`EditIssueOption`（PATCH）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 否 | 新标题 |
| `body` | string | 否 | 新正文 |
| `state` | string | 否 | **swagger 没有声明枚举**（只有 `string`）；原文无取值列表 |
| `assignee` | string | 否 | swagger 描述为 **deprecated** |
| `assignees` | [string] | 否 | 一组用户名 |
| `due_date` | string (date-time) | 否 | 截止日期；只用日期部分 |
| `unset_due_date` | boolean | 否 | 清除截止日期 |
| `milestone` | integer(int64) | 否 | 里程碑 id |
| `projects` | [integer(int64)] | 否 | 项目 id 列表（**替换**现有项目） |
| `ref` | string | 否 | — |
| `content_version` | integer(int64) | 否 | 乐观锁：与当前值不符时返回 **409 Conflict**（operation description 明写） |

**`EditDeadlineOption`（POST .../deadline）**

| 字段 | 类型 | 必填 |
| --- | --- | --- |
| `due_date` | string (date-time) | **是** |

### 1.4 `Issue` 对象常用字段（响应）

顶层是**对象**（单个）/ **数组**（列表）。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | integer(int64) | 全局主键（**不是**前端用的编号） |
| `number` | integer(int64) | 仓库内 issue 编号 —— **路径里的 `{index}` 就是它** |
| `title` | string | 标题 |
| `body` | string | 正文 |
| `state` | string，枚举 `open` / `closed` | 状态 |
| `labels` | [Label] | 标签对象数组，取名字用 `labels[].name`，取 id 用 `labels[].id` |
| `assignees` | [User] | 负责人数组，取用户名用 `assignees[].login` |
| `assignee` | User | 单个负责人（兼容字段） |
| `milestone` | Milestone | 里程碑对象，取名字用 `milestone.title`，取 id 用 `milestone.id` |
| `due_date` | string (date-time) | 截止日期 |
| `comments` | integer(int64) | 评论**条数**（类型为 integer，不可能是评论内容；swagger 未给文字描述） |
| `created_at` / `updated_at` / `closed_at` | string (date-time) | 创建 / 更新 / 关闭时间 |
| `html_url` | string | 网页地址 |
| `url` | string | API 地址 |
| `pull_request` | PullRequestMeta | **非空即表示这是 PR**（原文 "PR info if an issue is a PR"） |
| `is_locked` | boolean | 是否锁定 |
| `pin_order` | integer(int64) | 置顶序号（swagger 未给描述） |
| `content_version` | integer(int64) | 乐观锁用的内容版本；swagger 原文 "The version of the issue content for optimistic locking" |
| `time_estimate` | integer(int64) | swagger 未给描述（字段名暗示工时预估） |
| `assets` | [Attachment] | 附件 |
| `projects` | [Project] | 所属项目 |
| `repository` | RepositoryMeta | 仓库基本信息（`id` / `name` / `owner` / `full_name`） |
| `user` | User | 创建者 |
| `original_author` / `original_author_id` | string / integer | 原始作者（迁移场景） |
| `ref` | string | — |

> `Issue` 定义里**没有** `index` 字段，只有 `number`。

---

## 2. 评论 comments

| 方法 路径 | 用途 | 请求体 | 成功响应 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues/comments` | 列出**整个仓库**的评论 | — | `200` → `[Comment]` | 否 |
| `GET /repos/{owner}/{repo}/issues/comments/{id}` | 查看单条评论 | — | `200` → `Comment` | 否 |
| `PATCH /repos/{owner}/{repo}/issues/comments/{id}` | 编辑评论 | `EditIssueCommentOption` | `200` → `Comment` | 否 |
| `DELETE /repos/{owner}/{repo}/issues/comments/{id}` | 删除评论 | — | `204`（空） | 否 |
| `GET /repos/{owner}/{repo}/issues/{index}/comments` | 列出某 issue 的全部评论 | — | `200` → `[Comment]` | 否 |
| `POST /repos/{owner}/{repo}/issues/{index}/comments` | 给 issue 添加评论 | `CreateIssueCommentOption` | `201` → `Comment` | 否 |
| `PATCH /repos/{owner}/{repo}/issues/{index}/comments/{id}` | 编辑评论（旧路径） | `EditIssueCommentOption` | `200` → `Comment` | **是** |
| `DELETE /repos/{owner}/{repo}/issues/{index}/comments/{id}` | 删除评论（旧路径） | — | `204`（空） | **是** |

`operationId`：`issueGetRepoComments` / `issueGetComment` / `issueEditComment` / `issueDeleteComment` / `issueGetComments` / `issueCreateComment` / `issueEditCommentDeprecated` / `issueDeleteCommentDeprecated`。

### 2.1 查询参数

| 端点 | 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `GET .../issues/comments` | `since` | string (date-time) | 否 | — | 只返回该时间之后更新的评论 |
| | `before` | string (date-time) | 否 | — | 只返回该时间之前更新的评论 |
| | `page` | integer | 否 | 无声明 | 页码 |
| | `limit` | integer | 否 | 无声明 | 每页数量 |
| `GET .../issues/{index}/comments` | `since` | string (date-time) | 否 | — | 同上 |
| | `before` | string (date-time) | 否 | — | 同上 |

> `GET /repos/{owner}/{repo}/issues/{index}/comments` **没有 `page` / `limit` 参数**（swagger 未列出），只能靠 `since`/`before` 收窄。

### 2.2 请求体

`CreateIssueCommentOption`：`body` string **必填**（唯一字段）。

`EditIssueCommentOption`：`body` string **必填**（唯一字段）。

### 2.3 `Comment` 对象常用字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | integer(int64) | 评论 id（编辑/删除用这个） |
| `body` | string | 内容 |
| `user` | User | 作者，取用户名用 `user.login` |
| `created_at` / `updated_at` | string (date-time) | 创建 / 更新时间 |
| `html_url` | string | 网页地址 |
| `issue_url` | string | 所属 issue 的 API 地址 |
| `pull_request_url` | string | 若是 PR 评论则为 PR 地址 |
| `assets` | [Attachment] | 该评论的附件 |
| `original_author` / `original_author_id` | string / integer | 原始作者 |

---

## 3. 附件 assets / attachments

issue 附件与评论附件是**两套并行**的路径；评论附件的路径变量是 `{id}`（**评论 id，不是 issue 编号**）。

### 3.1 issue 附件

| 方法 路径 | 用途 | 请求体 | 成功响应 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues/{index}/assets` | 列出 issue 的附件 | — | `200` → `[Attachment]` | 否 |
| `POST /repos/{owner}/{repo}/issues/{index}/assets` | 上传 issue 附件 | **multipart/form-data** | `201` → `Attachment` | 否 |
| `GET /repos/{owner}/{repo}/issues/{index}/assets/{attachment_id}` | 查看单个附件 | — | `200` → `Attachment` | 否 |
| `PATCH /repos/{owner}/{repo}/issues/{index}/assets/{attachment_id}` | 编辑附件（改名） | `EditAttachmentOptions` | `201` → `Attachment` | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/assets/{attachment_id}` | 删除附件 | — | `204`（空） | 否 |

`operationId`：`issueListIssueAttachments` / `issueCreateIssueAttachment` / `issueGetIssueAttachment` / `issueEditIssueAttachment` / `issueDeleteIssueAttachment`。

### 3.2 评论附件

| 方法 路径 | 用途 | 请求体 | 成功响应 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues/comments/{id}/assets` | 列出评论的附件 | — | `200` → `[Attachment]` | 否 |
| `POST /repos/{owner}/{repo}/issues/comments/{id}/assets` | 上传评论附件 | **multipart/form-data** | `201` → `Attachment` | 否 |
| `GET /repos/{owner}/{repo}/issues/comments/{id}/assets/{attachment_id}` | 查看单个评论附件 | — | `200` → `Attachment` | 否 |
| `PATCH /repos/{owner}/{repo}/issues/comments/{id}/assets/{attachment_id}` | 编辑评论附件 | `EditAttachmentOptions` | `201` → `Attachment` | 否 |
| `DELETE /repos/{owner}/{repo}/issues/comments/{id}/assets/{attachment_id}` | 删除评论附件 | — | `204`（空） | 否 |

`operationId`：`issueListIssueCommentAttachments` / `issueCreateIssueCommentAttachment` / `issueGetIssueCommentAttachment` / `issueEditIssueCommentAttachment` / `issueDeleteIssueCommentAttachment`。

### 3.3 上传参数（`consumes: multipart/form-data`）

| 参数 | 位置 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `attachment` | **formData** | file | **是** | 文件本体 |
| `name` | **query** | string | 否 | 文件名（注意：是 query，不是 formData） |

### 3.4 `EditAttachmentOptions`（PATCH）

| 字段 | 类型 | 必填 |
| --- | --- | --- |
| `name` | string | 否 |

### 3.5 `Attachment` 对象常用字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | integer(int64) | 附件 id（PATCH / DELETE 用这个） |
| `name` | string | 文件名 |
| `size` | integer(int64) | 字节数 |
| `uuid` | string | UUID（正文里引用图片时用） |
| `browser_download_url` | string | 浏览器可直接打开的下载地址 |
| `created_at` | string (date-time) | 创建时间 |
| `download_count` | integer(int64) | 下载次数 |

---

## 4. 负责人 assignees

| 方法 路径 | 用途 | 请求体 | 成功响应 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/assignees` | 列出**可被指派**的用户（有写权限的人） | — | `200` → `[User]` | 否 |
| `GET /repos/{owner}/{repo}/assignees/{assignee}` | 校验某用户可否被指派到本仓库 | — | `204`（空，可指派） | 否 |
| `POST /repos/{owner}/{repo}/issues/{index}/assignees` | 给 issue 添加负责人 | `IssueAssigneesOption` | `201` → `Issue` | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/assignees` | 移除 issue 的负责人 | `IssueAssigneesOption` | `200` → `Issue` | 否 |
| `GET /repos/{owner}/{repo}/issues/{index}/assignees/{assignee}` | 校验某用户可否被指派到该 issue | — | `204`（空，可指派） | 否 |

`operationId`：`repoGetAssignees` / `repoCheckAssignee` / `issueAddAssignees` / `issueRemoveAssignees` / `issueCheckAssignee`。

> 前两个端点的 swagger tag 是 `repository`（不是 `issue`），后三个是 `issue`。

请求体 `IssueAssigneesOption`（POST 与 DELETE 共用）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `assignees` | [string] | 否 | 用户名数组 |

> **POST 返回 201，DELETE 返回 200**，两者都返回完整 `Issue`。校验类端点返回 `204` 表示可以指派，`404` 表示不行。

---

## 5. 依赖 blocks / dependencies

两组路径是**互为反向**的关系，语义容易搞反：

| 方法 路径 | 用途（swagger 原文） | 请求体 | 成功响应 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues/{index}/blocks` | 列出**被本 issue 阻塞**的 issue（"List issues that are blocked by this issue"） | — | `200` → `[Issue]` | 否 |
| `POST /repos/{owner}/{repo}/issues/{index}/blocks` | 用路径里的 issue **阻塞**请求体里的 issue | `IssueMeta` | `201` → `Issue` | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/blocks` | 解除上述阻塞 | `IssueMeta` | `200` → `Issue` | 否 |
| `GET /repos/{owner}/{repo}/issues/{index}/dependencies` | 列出**阻塞本 issue** 的依赖（"all issues that block this issue"） | — | `200` → `[Issue]` | 否 |
| `POST /repos/{owner}/{repo}/issues/{index}/dependencies` | 让路径里的 issue **依赖**请求体里的 issue | `IssueMeta` | `201` → `Issue` | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/dependencies` | 移除一条依赖 | `IssueMeta` | `200` → `Issue` | 否 |

`operationId`：`issueListBlocks` / `issueCreateIssueBlocking` / `issueRemoveIssueBlocking` / `issueListIssueDependencies` / `issueCreateIssueDependencies` / `issueRemoveIssueDependencies`。

- `GET /blocks` 与 `GET /dependencies` 支持 `page`、`limit` 两个 query 参数（**无默认值与上限声明**）。
- 两组端点**都没有被标记 deprecated**；swagger 中**未说明**它们之间的版本沿革或路径迁移关系。
- 这两组路径的 `{index}` 在 swagger 里声明为 **`type: string`**（其他 issue 端点都是 `integer/int64`）；`owner` / `repo` 仍是 string。

请求体 `IssueMeta`（三组写操作共用，全部字段可选）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `index` | integer(int64) | 否 | 对方 issue 的编号 |
| `owner` | string | 否 | 对方仓库 owner（可跨仓库） |
| `repo` | string | 否 | 对方仓库名（可跨仓库） |

> `POST /blocks` 与 `POST /dependencies` 的 `404` 描述是 "the issue does not exist"；`DELETE` 的 `404` 是 `APINotFound`。

---

## 6. 订阅 subscription

| 方法 路径 | 用途 | 成功响应 | 说明 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues/{index}/subscriptions` | 列出该 issue 的订阅者 | `200` → `[User]` | 支持 `page` / `limit`（无默认声明） | 否 |
| `GET /repos/{owner}/{repo}/issues/{index}/subscriptions/check` | 检查当前用户是否已订阅 | `200` → `WatchInfo` | — | 否 |
| `PUT /repos/{owner}/{repo}/issues/{index}/subscriptions/{user}` | 让 `{user}` 订阅 | `200` 已订阅 / `201` 订阅成功 / `304` 非 admin 只能订阅自己 | 无请求体 | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/subscriptions/{user}` | 让 `{user}` 取消订阅 | `200` 已取消 / `201` 取消成功 / `304` 同上 | 无请求体 | 否 |

`operationId`：`issueSubscriptions` / `issueCheckSubscription` / `issueAddSubscription` / `issueDeleteSubscription`。

`WatchInfo` 字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `subscribed` | boolean | 是否已订阅（check 端点最常用） |
| `ignored` | boolean | 是否忽略 |
| `reason` | （无类型声明） | 原因 |
| `created_at` | string (date-time) | — |
| `url` | string | — |
| `repository_url` | string | — |

> 这是 **issue 级**订阅。仓库级订阅是另一组路径 `/repos/{owner}/{repo}/subscription`（PUT / DELETE / GET），不在本文范围。

---

## 7. 置顶 pin / unpin

| 方法 路径 | 用途 | 成功响应 | deprecated |
| --- | --- | --- | --- |
| `POST /repos/{owner}/{repo}/issues/{index}/pin` | 置顶 issue | `204`（空） | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/pin` | 取消置顶 | `204`（空） | 否 |
| `PATCH /repos/{owner}/{repo}/issues/{index}/pin/{position}` | 把置顶移动到第 `{position}` 位 | `204`（空） | 否 |
| `GET /repos/{owner}/{repo}/issues/pinned` | 列出仓库已置顶的 issue | `200` → `[Issue]` | 否 |

`operationId`：`pinIssue` / `unpinIssue` / `moveIssuePin` / `repoListPinnedIssues`。

- 后两个路径参数 `{position}` 为 integer(int64)，**必填**，位置从 1 开始（swagger 只说 "the given Position"，未说明起始值）。
- 三个写操作都无请求体；都可能返回 `403` / `404`。
- `GET .../issues/pinned` 的 tag 是 `repository`（不是 `issue`），**无分页参数**。

---

## 8. 锁定 lock / unlock

| 方法 路径 | 用途 | 请求体 | 成功响应 | deprecated |
| --- | --- | --- | --- | --- |
| `PUT /repos/{owner}/{repo}/issues/{index}/lock` | 锁定 issue | `LockIssueOption` | `204`（空） | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/lock` | 解锁 issue | — | `204`（空） | 否 |

`operationId`：`issueLockIssue` / `issueUnlockIssue`。

`LockIssueOption`：

| 字段 | 类型 | 必填 | 枚举 |
| --- | --- | --- | --- |
| `lock_reason` | string | 否 | **swagger 中未声明枚举**（Go 字段名 `Reason`） |

---

## 9. 时间工时 times

| 方法 路径 | 用途 | 请求体 | 成功响应 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues/{index}/times` | 列出该 issue 的工时记录 | — | `200` → `[TrackedTime]` | 否 |
| `POST /repos/{owner}/{repo}/issues/{index}/times` | 为该 issue 添加工时 | `AddTimeOption` | `200` → `TrackedTime` | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/times` | 重置该 issue 的工时（原文 "Reset a tracked time of an issue"，具体重置范围 swagger 未说明） | — | `204`（空） | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/times/{id}` | 删除指定的某条工时记录 | — | `204`（空） | 否 |
| `GET /repos/{owner}/{repo}/times` | 列出**整个仓库**的工时记录 | — | `200` → `[TrackedTime]` | 否 |
| `GET /repos/{owner}/{repo}/times/{user}` | 列出某用户在仓库内的工时（旧路径） | — | `200` → `[TrackedTime]` | **是** |

`operationId`：`issueTrackedTimes` / `issueAddTime` / `issueResetTime` / `issueDeleteTime` / `repoTrackedTimes` / `userTrackedTimes`。

### 9.1 查询参数

| 端点 | 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `GET .../issues/{index}/times` | `user` | string | 否 | 只看某用户的工时 |
| | `since` / `before` | string (date-time) | 否 | 时间范围 |
| | `page` / `limit` | integer | 否 | 分页（无默认/上限声明） |
| `GET /repos/{owner}/{repo}/times` | `user` | string | 否 | 同上 |
| | `since` / `before` | string (date-time) | 否 | 同上 |
| | `page` / `limit` | integer | 否 | 同上 |
| `GET /repos/{owner}/{repo}/times/{user}` | — | — | — | **无任何参数**（连分页都没有） |

### 9.2 请求体 `AddTimeOption`（POST）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `time` | integer(int64) | **是** | **秒数**（原文 "time in seconds"） |
| `created` | string (date-time) | 否 | 记录时间 |
| `user_name` | string | 否 | 该工时归属的用户名（可选） |

> POST 成功返回 **`200`**（不是 201）。`400` 表示参数错误，`403` 表示无权限。

### 9.3 `TrackedTime` 对象字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | integer(int64) | 工时记录 id（DELETE .../times/{id} 用这个） |
| `time` | integer(int64) | 工时**秒数** |
| `created` | string (date-time) | 记录时间 |
| `user_name` | string | 用户名 |
| `user_id` | integer(int64) | 用户 id |
| `issue_id` | integer(int64) | 所属 issue 的 id |
| `issue` | Issue | 所属 issue 对象 |

### 9.4 秒表 stopwatch（与工时同族，附带列出）

| 方法 路径 | 用途 | 成功响应 | 备注 |
| --- | --- | --- | --- |
| `POST /repos/{owner}/{repo}/issues/{index}/stopwatch/start` | 开始计时 | `201`（空） | `409` 已存在计时 |
| `POST /repos/{owner}/{repo}/issues/{index}/stopwatch/stop` | 停止计时并记录工时 | `201`（空） | `409` 不存在计时 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/stopwatch/delete` | 丢弃计时 | `204`（空） | `409` 不存在计时 |

`operationId`：`issueStartStopWatch` / `issueStopStopWatch` / `issueDeleteStopWatch`。三者均无请求体，`403` 描述为 "Not repo writer, user does not have rights to toggle stopwatch"。

---

## 10. 标签 labels

### 10.1 列出仓库标签（issue 编辑时的候选标签）

| 方法 路径 | 用途 | 成功响应 | deprecated |
| --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/labels` | 取仓库的全部标签 | `200` → `[Label]` | 否 |

`operationId`：`issueListLabels`。query 参数：`page`、`limit`（均为 integer，**无默认值与上限声明**）。

`Label` 字段：`id`(int64) / `name`(string) / `color`(string) / `description`(string) / `exclusive`(boolean) / `is_archived`(boolean) / `url`(string)。

### 10.2 issue 自身的标签管理

| 方法 路径 | 用途 | 请求体 | 成功响应 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues/{index}/labels` | 取该 issue 的标签 | — | `200` → `[Label]` | 否 |
| `POST /repos/{owner}/{repo}/issues/{index}/labels` | **添加**标签 | `IssueLabelsOption` | `200` → `[Label]` | 否 |
| `PUT /repos/{owner}/{repo}/issues/{index}/labels` | **替换**全部标签 | `IssueLabelsOption` | `200` → `[Label]` | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/labels` | 清空全部标签 | — | `204`（空） | 否 |
| `DELETE /repos/{owner}/{repo}/issues/{index}/labels/{id}` | 删除单个标签（`{id}` 是 label id） | — | `204`（空） | 否 |

`operationId`：`issueGetLabels` / `issueAddLabel` / `issueReplaceLabels` / `issueClearLabels` / `issueRemoveLabel`。

`IssueLabelsOption`：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `labels` | array（`items` **未声明类型**） | 否 | swagger 原文：可以是「label id 的整数数组」**或**「label 名的字符串数组」 |

> 注意区分：`POST /issues/{index}/labels` 是**追加**，`PUT` 是**整体替换**。

---

## 11. 里程碑 milestones

| 方法 路径 | 用途 | 成功响应 | deprecated |
| --- | --- | --- | --- |
| `GET /repos/{owner}/{repo}/milestones` | 列出仓库里程碑（摘要写着 "opened milestones"） | `200` → `[Milestone]` | 否 |

`operationId`：`issueGetMilestonesList`。

| 参数 | 类型 | 必填 | 枚举 / 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `state` | string | 否 | **swagger 未声明枚举**；description 说「Recognized values are open, closed and all. Defaults to "open"」 | 里程碑状态 |
| `name` | string | 否 | — | 按名称过滤 |
| `page` / `limit` | integer | 否 | 无默认/上限声明 | 分页 |

`Milestone` 字段：`id`(int64) / `title`(string) / `description`(string) / `state`(string，**枚举 `open` / `closed`**) / `open_issues`(int64) / `closed_issues`(int64) / `due_on`(date-time) / `created_at` / `updated_at` / `closed_at`(date-time)。

> 创建/编辑/删除里程碑是 `POST/PATCH/DELETE /repos/{owner}/{repo}/milestones...`，不在本文主题范围，此处只列「用于 issue 编辑时选值」的列表端点。

---

## 12. 辅助端点

| 方法 路径 | 用途 | 成功响应 | 关键参数 | deprecated |
| --- | --- | --- | --- | --- |
| `GET /user/repos` | 列出当前认证用户**拥有**的仓库 | `200` → `[Repository]` | `page`、`limit`（无默认/上限声明） | 否 |
| `GET /repos/search` | 搜索仓库（全局） | `200` → `{ok, data}`（`SearchResults`：`ok` boolean + `data` `[Repository]`） | 见下 | 否 |

`operationId`：`userCurrentListRepos` / `repoSearch`。

**指派候选**：直接用第 4 节的 `GET /repos/{owner}/{repo}/assignees`（返回 `[User]`，取 `login` 作为 `assignees[]` 的取值），不需要另外列举用户/组织。

`GET /repos/search` 关键参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q` | string | 否 | 关键字 |
| `uid` | integer(int64) | 否 | 只搜该用户拥有或参与的仓库 |
| `exclusive` | boolean | 否 | 给了 `uid` 时，只搜该用户**拥有**的 |
| `topic` / `includeDesc` | boolean | 否 | 关键字限定在 topic / 描述内 |
| `private` / `is_private` | boolean | 否 | 是否包含私有（默认 true）/ 只显示公有、私有或全部（默认全部） |
| `template` / `archived` | boolean | 否 | 是否包含模板仓库（默认 true）/ 只显示已归档、未归档或全部（默认全部） |
| `mode` | string | 否 | 支持 `fork` / `source` / `mirror` / `collaborative` |
| `sort` | string | 否 | 支持 `alpha` / `created` / `updated` / `size` / `git_size` / `lfs_size` / `stars` / `forks` / `id`；**默认 `alpha`** |
| `order` | string | 否 | `asc` / `desc`，**默认 `asc`**；未给 `sort` 时被忽略 |
| `page` / `limit` | integer | 否 | 分页（无默认/上限声明） |

`Repository` 常用字段（列表页只需要少数几个）：`id`(int64) / `name`(string) / `full_name`(string) / `owner.login`(User) / `private`(boolean) / `archived`(boolean) / `empty`(boolean) / `html_url`(string) / `default_branch`(string) / `updated_at`(date-time)。

---

## 13. 通用查询参数与分页

### 13.1 参数名对照（容易混）

| 语义 | 仓库 issue 列表 `GET /repos/{owner}/{repo}/issues` | 全局搜索 `GET /repos/issues/search` |
| --- | --- | --- |
| 按类型过滤 | `type` = `issues` / `pulls` | `type` = `issues` / `pulls` |
| 状态 | `state` = `closed` / `open` / `all`（无默认） | `state` = `open` / `closed` / `all`（**默认 `open`**） |
| 关键字 | `q` | `q` |
| 标签 | `labels`（逗号分隔 label **名**） | `labels`（逗号分隔 label **名**） |
| 里程碑 | `milestones`（逗号分隔**名称或 id**） | `milestones`（逗号分隔**名称**） |
| 时间范围 | `since` / `before`（date-time，作用于 **updated_at**） | `since` / `before` |
| 创建者 | `created_by`（用户名） | `created_by`（用户名） |
| 指派给 | `assigned_by`（用户名） | `assigned`（**boolean**，只对当前认证用户） |
| 提到 | `mentioned_by`（用户名） | `mentioned`（**boolean**，只对当前认证用户） |
| 仓库归属 | — | `owner`（string）、`team`（string，需配 `owner`） |
| 分页 | `page`, `limit` | `page`（默认 1，最小 1）, `limit`（最小 0） |

用户想找的 `assignee` / `creator` / `mentioned` / `milestone`（单数）这几个名字**在 swagger 里不存在**；实际名字是上面的 `assigned_by`/`created_by`/`mentioned_by`/`milestones`。

### 13.2 分页

| 项 | swagger 中的事实 |
| --- | --- |
| `page` 语义 | "page number of results to return (1-based)" |
| `limit` 语义 | "page size of results" / "Number of items per page" |
| `limit` 的**上限** | **swagger 中未说明**（参数上没有任何 `maximum`）。运行时上限由服务端配置决定，可通过 `GET /settings/api` 读取：`max_response_items`（API 响应最大条数）、`default_paging_num`（每页默认条数） |
| `page` 默认值 | 多数端点**未声明默认值**；只有 `GET /repos/issues/search` 明写 `default: 1`、`minimum: 1` |
| `limit` 最小值 | 多数端点未声明；`GET /repos/issues/search` 明写 `minimum: 0` |
| 分页风格 | 每个列表端点的 `page`/`limit` 各自单独声明（没有全局 parameter 定义），所以不同端点的默认值/上下限**不一致** |
| 响应头 | swagger 中未说明分页响应头（如 `X-Total-Count`） |

### 13.3 响应形态

| 端点 | 顶层 |
| --- | --- |
| `GET /repos/{owner}/{repo}/issues` | **数组** `[Issue]` |
| `GET /repos/issues/search` | **数组** `[Issue]` |
| `GET /repos/{owner}/{repo}/issues/{index}` | 对象 `Issue` |
| `GET .../issues/comments`、`GET .../issues/{index}/comments` | 数组 `[Comment]` |
| `GET .../issues/{index}/assets`、`.../comments/{id}/assets` | 数组 `[Attachment]` |
| `GET .../issues/{index}/times`、`GET /repos/{owner}/{repo}/times` | 数组 `[TrackedTime]` |
| `GET .../assignees`、`GET .../subscriptions` | 数组 `[User]` |
| `GET .../labels`、`GET .../issues/{index}/labels` | 数组 `[Label]` |
| `GET .../milestones` | 数组 `[Milestone]` |
| `GET .../issues/{index}/blocks`、`.../dependencies`、`GET .../issues/pinned` | 数组 `[Issue]` |
| `GET /user/repos` | 数组 `[Repository]` |
| `GET /repos/search` | **对象** `{ok, data}` |

写操作返回：创建类多为 `201` + 对象；编辑类 `200`/`201` + 对象；删除/置顶/锁定类为 `204` 空响应。

### 13.4 API 路径占位符

| 占位符 | 含义 |
| --- | --- |
| `{owner}` | 仓库所有者（用户名或组织名） |
| `{repo}` | 仓库名 |
| `{index}` | **issue 编号（= `Issue.number`）**，不是 `Issue.id` |
| `{id}` | 视上下文而定：`.../issues/comments/{id}` 是**评论 id**；`.../issues/{index}/labels/{id}` 是 **label id**；`.../issues/{index}/times/{id}` 是**工时记录 id** |
| `{attachment_id}` | 附件 id（= `Attachment.id`） |
| `{assignee}` / `{user}` | 用户名（login） |
| `{position}` | 置顶位置序号 |

---

## 14. 易踩的坑

1. **issue 编号字段是 `number`，不是 `index`。**
   路径里的 `{index}` 对应响应对象里的 `Issue.number`；`Issue` 定义里**根本没有 `index` 字段**。`Issue.id` 是全局主键，拿 `id` 去拼 `/issues/{index}` 会 404。

2. **`limit` 的上限 swagger 里没有。**
   所有 `limit` 参数都没有 `maximum`。真实上限是服务端配置，需要调 `GET /settings/api` 看 `max_response_items` 与 `default_paging_num`。`page`/`limit` 的默认值也因端点而异（只有 `GET /repos/issues/search` 明写 `page` 默认 1）。同一个 `limit` 值在 A 端点可能被接受、在 B 端点被截断。

3. **附件上传是 `multipart/form-data`，而且 `name` 在 query 不在 form。**
   `POST .../assets` 只接受 `multipart/form-data`；文件字段是 formData 的 `attachment`（必填），文件名参数 `name` 却被声明在 **query**。用 JSON 提交会失败。

4. **`blocks` 与 `dependencies` 是反向关系，方向极易写反。**
   `GET .../blocks` = 「被我阻塞的」；`GET .../dependencies` = 「阻塞我的」。`POST .../blocks` 是「用路径 issue 阻塞 body issue」，`POST .../dependencies` 是「路径 issue 依赖 body issue」——方向相反，body 都是 `IssueMeta`（可跨仓库，带 `owner`/`repo`）。两组路径**都没有 deprecated 标记**，swagger **未说明**所谓新老路径的差异或迁移关系。另外这两组路径的 `{index}` 在 swagger 里声明为 **string**，其他 issue 端点却是 **integer**。

5. **`GET /repos/{owner}/{repo}/issues/{index}/comments` 没有分页参数。**
   swagger 里它只有 `since` / `before`，**没有 `page` / `limit`**；要翻页只能用仓库级 `GET /repos/{owner}/{repo}/issues/comments`（那个有 page/limit）。

6. **issue 列表与搜索都没有 `sort` / `order`。**
   这两个参数只存在于仓库搜索 `GET /repos/search`；issue 列表/搜索（1.27.3）只支持 `since`/`before` 做时间收窄。

7. **`POST .../times` 成功返回 `200` 而不是 `201`；`time` 单位是秒。**
   `AddTimeOption.time` 是**整数秒**且必填。删除/重置是两条不同路径：`DELETE .../times` = 重置（无 body），`DELETE .../times/{id}` = 删单条。

8. **times 相关功能依赖仓库开启时间追踪。**
   swagger 的端点声明里**没有说明**该开关（`GET /settings/api` 也没有）。相关端点的 `403` 表示权限不足；是否能用工时取决于仓库设置，**swagger 中未说明**具体开关名称与检查方式。

9. **`POST .../issues/{index}/labels` 是追加、`PUT` 是整体替换。**
   两者 body 都是 `IssueLabelsOption`，其中 `labels` 的 `items` **未声明类型**，swagger 原文说明它可以是 label **id 数组**或 label **名数组**。用 `POST` 想覆盖会变成累积。

10. **创建 issue 时 `labels` 传的是 id，不是名字。**
    `CreateIssueOption.labels` 是 `[integer(int64)]`（label id），而列表查询参数 `labels` 传的是**名字**。同一个词在请求体与 query 里语义不同。

11. **`CreateIssueOption` / `EditIssueOption` 的 `assignee` 字段已废弃。**
    swagger 在字段 description 里直接写了 "deprecated"，应改用 `assignees`（数组）。注意 `EditIssueOption.state` 是 string 且**没有枚举声明**。

12. **`state` 语义在列表与搜索间不同。**
    仓库列表 `state` 枚举是 `closed`/`open`/`all` 且**无默认值**；全局搜索 `state` 枚举是 `open`/`closed`/`all` 且**默认 `open`**（即漏传会漏掉 closed）。

13. **`milestones` 参数：仓库列表接受「名称或 id」，全局搜索只接受「名称」。**
    非名称的 id 在全局搜索里会被丢弃（原文 "Non existent milestones are discarded"）。

14. **`pull_request` 字段是判断 issue 还是 PR 的唯一标志。**
    issue 列表默认会同时返回 PR（`type` 未设置时不过滤）；`Issue.pull_request` 非空即表示这是 PR。

15. **`PATCH /issues/{index}` 有乐观锁。**
    传了 `content_version` 且与服务端当前值不符时返回 **409 Conflict**（operation description 明写）。编辑正文时若不做冲突处理会失败。

16. **已废弃的操作与字段要避开。**
    操作：`PATCH`/`DELETE /repos/{owner}/{repo}/issues/{index}/comments/{id}`（改用 `/repos/{owner}/{repo}/issues/comments/{id}`）、`GET /repos/{owner}/{repo}/times/{user}`。字段：`CreateIssueOption.assignee`、`EditIssueOption.assignee`。认证：`Token`/`AccessToken`（query 传 token，1.23 起移除）、`POST /org/{org}/repos`。

17. **`Sudo` 请求头需要 admin。**
    `Sudo`/`sudo` 是以他人身份发请求，swagger 明写 "Admin privileges are required"。issue 端点本身没有 admin 要求（swagger 未说明），但 423（仓库已归档）会让写操作失败。
