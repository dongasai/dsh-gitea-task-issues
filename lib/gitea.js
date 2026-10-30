/**
 * @module lib/gitea
 *
 * Gitea API 客户端与**操作表**。
 *
 * 桥（`lib/bridge.js`）与模型工具（`lib/tools.js`）都只认操作名，不各自拼 URL —— 端点、
 * 参数名、请求体字段只有这一份，改版本时改一处。操作表按 Swagger 2.0 / Gitea 1.27.3 抄写，
 * 每一行都在 `docs/gitea-api-reference.md` 里有对应条目。
 *
 * 三条约定：
 * 1. **参数在这里收敛**：调用方给的是 JSON，字段类型、枚举、上限都在 `param.*` 里校验，
 *    非法输入直接 `BridgeError(400)`，不带着脏参数去打 Gitea。
 * 2. **上游失败原样带状态**：`GiteaError` 保留 Gitea 的状态码与正文；映射成线上码由
 *    `lib/errors.js` 负责，这里不猜原因。
 * 3. **不做重试**：读写都会改变远端状态，静默重试可能重复建 issue / 重复评论。
 *    网络抖动由用户重试，界面必须能看见失败。
 */
import { BridgeError, GiteaError, codeForGiteaStatus } from './errors.js'

/** 单次上游请求的墙钟上限：Gitea 慢或不通时不让桥请求挂死。 */
export const REQUEST_TIMEOUT_MS = 30 * 1000

/** 单次请求体上限（字节）；附件走 base64，所以给得比一般 JSON 大。 */
export const MAX_BODY_BYTES = 24 * 1024 * 1024

/**
 * 取附件**原始字节**时的上限（byte）。这是给界面内嵌图片用的：超过这个体积转成 data URL
 * 只会把界面拖死，界面上退化成「去 Gitea 看」更诚实。
 */
export const MAX_RAW_BYTES = 10 * 1024 * 1024

// ── 参数收敛 ────────────────────────────────────────────────────────────────

/**
 * 可选字符串。
 * @param value - 入参。
 * @param field - 字段名（报错用）。
 * @returns 去掉首尾空白的字符串，或 undefined。
 */
export function optString(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new BridgeError(400, 'bad-request', `${field} must be a string`)
  return value
}

/**
 * 可清空的字符串：与 `optString` 的唯一差别是**空字符串合法**。
 *
 * `issue.edit` 的 `body` 是典型场景：用户把正文删干净再保存，语义是「清空正文」，不是「不改正文」；
 * 用 `optString` 会把 `''` 折叠成 `undefined`，PATCH 里根本不带 body —— 界面显示保存成功，正文却
 * 纹丝不动（2026-10-30 清空贴图正文时实报）。
 * @param value - 入参。
 * @param field - 字段名。
 * @returns 字符串；`undefined` 表示字段没出现（= 不改）。
 * @throws {BridgeError} 400 —— 不是字符串。
 */
export function optEditableString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new BridgeError(400, 'bad-request', `${field} must be a string`)
  return value
}

/** Gitea 附件的 uuid 形状（`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 必填的附件 uuid。
 *
 * 收敛形状不是为了「好看」：这个值会被拼进 web 路由 `/attachments/{uuid}`，放开了就等于
 * 允许调用方往 Gitea 根路径上拼任意段（`../` 之类），所以宁可在入口挡掉。
 * @param value - 入参。
 * @returns uuid 字符串。
 * @throws {BridgeError} 400 —— 缺失或形状不对。
 */
export function reqUuid(value) {
  const text = reqString(value, 'uuid')
  if (!UUID_PATTERN.test(text)) throw new BridgeError(400, 'bad-request', 'uuid must be a Gitea attachment uuid')
  return text
}

/**
 * 必填字符串。
 * @param value - 入参。
 * @param field - 字段名。
 * @returns 字符串。
 */
export function reqString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError(400, 'bad-request', `${field} must be a non-empty string`)
  }
  return value
}

/**
 * 可选整数（也接受能安全转换的数字字符串）。
 * @param value - 入参。
 * @param field - 字段名。
 * @param options - `min` / `max` 夹取范围（超出即 400）。
 * @returns 整数，或 undefined。
 */
export function optInt(value, field, options = {}) {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number)) throw new BridgeError(400, 'bad-request', `${field} must be an integer`)
  if (options.min !== undefined && number < options.min) {
    throw new BridgeError(400, 'bad-request', `${field} must be ≥ ${options.min}`)
  }
  if (options.max !== undefined && number > options.max) {
    throw new BridgeError(400, 'bad-request', `${field} must be ≤ ${options.max}`)
  }
  return number
}

/**
 * 必填整数。
 * @param value - 入参。
 * @param field - 字段名。
 * @returns 整数。
 */
export function reqInt(value, field) {
  const number = optInt(value, field)
  if (number === undefined) throw new BridgeError(400, 'bad-request', `${field} is required`)
  return number
}

/**
 * 可选布尔。
 * @param value - 入参。
 * @param field - 字段名。
 * @returns 布尔，或 undefined。
 */
export function optBool(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new BridgeError(400, 'bad-request', `${field} must be a boolean`)
}

/**
 * 可选枚举。
 * @param value - 入参。
 * @param field - 字段名。
 * @param allowed - 允许值。
 * @returns 命中的值，或 undefined。
 */
export function optEnum(value, field, allowed) {
  const text = optString(value, field)
  if (text === undefined) return undefined
  if (!allowed.includes(text)) {
    throw new BridgeError(400, 'bad-request', `${field} must be one of ${allowed.join(' / ')}`)
  }
  return text
}

/**
 * 字符串数组（去重、去空白）。
 * @param value - 入参。
 * @param field - 字段名。
 * @returns 数组，或 undefined。
 */
export function optStringArray(value, field) {
  if (value === undefined || value === null) return undefined
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new BridgeError(400, 'bad-request', `${field} must be a list of non-empty strings`)
    }
    if (!out.includes(item)) out.push(item)
  }
  return out
}

/**
 * 标签数组：Gitea 的 `labels` 既收标签 id（整数）也收标签名（字符串）。
 * @param value - 入参。
 * @param field - 字段名。
 * @returns 混合数组，或 undefined。
 */
export function optLabelArray(value, field) {
  if (value === undefined || value === null) return undefined
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (typeof item === 'number' && Number.isInteger(item)) {
      out.push(item)
      continue
    }
    if (typeof item === 'string' && item.trim() !== '') {
      out.push(item)
      continue
    }
    throw new BridgeError(400, 'bad-request', `${field} must be a list of label ids or names`)
  }
  return out
}

/**
 * 从入参里挑出允许的字段（值不是 undefined 才带上）。
 * @param params - 入参对象。
 * @param fields - 允许的字段名。
 * @returns 挑选后的对象。
 */
function pick(params, fields) {
  const out = {}
  for (const field of fields) {
    if (params[field] !== undefined && params[field] !== null) out[field] = params[field]
  }
  return out
}

/**
 * 路径段编码。Gitea 的 `{owner}`/`{repo}` 都是单段，整体编码即可。
 * @param value - 段内容。
 * @returns 编码后的段。
 */
export function segment(value) {
  return encodeURIComponent(String(value))
}

/** 仓库 issue 列表支持的筛选（Gitea 1.27.3 实测字段）。 */
function issueListQuery(params) {
  return pick({
    state: optEnum(params.state, 'state', ['open', 'closed', 'all']),
    labels: optString(params.labels, 'labels'),
    q: optString(params.q, 'q'),
    type: optEnum(params.type, 'type', ['issues', 'pulls']),
    milestones: optString(params.milestones, 'milestones'),
    since: optString(params.since, 'since'),
    before: optString(params.before, 'before'),
    created_by: optString(params.created_by, 'created_by'),
    assigned_by: optString(params.assigned_by, 'assigned_by'),
    mentioned_by: optString(params.mentioned_by, 'mentioned_by'),
    page: optInt(params.page, 'page', { min: 1 }),
    limit: optInt(params.limit, 'limit', { min: 1, max: 100 }),
  }, ['state', 'labels', 'q', 'type', 'milestones', 'since', 'before', 'created_by', 'assigned_by', 'mentioned_by', 'page', 'limit'])
}

/** 跨仓库 issue 搜索支持的筛选。 */
function issueSearchQuery(params) {
  return pick({
    state: optEnum(params.state, 'state', ['open', 'closed', 'all']),
    labels: optString(params.labels, 'labels'),
    q: optString(params.q, 'q'),
    type: optEnum(params.type, 'type', ['issues', 'pulls']),
    milestones: optString(params.milestones, 'milestones'),
    since: optString(params.since, 'since'),
    before: optString(params.before, 'before'),
    owner: optString(params.owner, 'owner'),
    created_by: optString(params.created_by, 'created_by'),
    assigned: optBool(params.assigned, 'assigned'),
    created: optBool(params.created, 'created'),
    mentioned: optBool(params.mentioned, 'mentioned'),
    page: optInt(params.page, 'page', { min: 1 }),
    limit: optInt(params.limit, 'limit', { min: 1, max: 100 }),
  }, ['state', 'labels', 'q', 'type', 'milestones', 'since', 'before', 'owner', 'created_by', 'assigned', 'created', 'mentioned', 'page', 'limit'])
}

/** 创建 issue 的请求体。 */
function createIssueBody(params) {
  const body = pick({
    title: params.title === undefined ? undefined : reqString(params.title, 'title'),
    body: optString(params.body, 'body'),
    assignees: optStringArray(params.assignees, 'assignees'),
    labels: optLabelArray(params.labels, 'labels'),
    milestone: optInt(params.milestone, 'milestone', { min: 1 }),
    due_date: optString(params.due_date, 'due_date'),
    closed: optBool(params.closed, 'closed'),
    ref: optString(params.ref, 'ref'),
  }, ['title', 'body', 'assignees', 'labels', 'milestone', 'due_date', 'closed', 'ref'])
  if (body.title === undefined) throw new BridgeError(400, 'bad-request', 'title is required')
  return body
}

/** 编辑 issue 的请求体：只送出现过的字段（Gitea 用「字段缺席」区分「不改」）。 */
function editIssueBody(params) {
  return pick({
    title: params.title === undefined ? undefined : reqString(params.title, 'title'),
    // 空字符串 = 清空正文（不是「不改」），所以这里不能用 optString。
    body: optEditableString(params.body, 'body'),
    state: optEnum(params.state, 'state', ['open', 'closed']),
    assignees: optStringArray(params.assignees, 'assignees'),
    milestone: optInt(params.milestone, 'milestone', { min: 1 }),
    due_date: optString(params.due_date, 'due_date'),
    unset_due_date: optBool(params.unset_due_date, 'unset_due_date'),
    ref: optString(params.ref, 'ref'),
  }, ['title', 'body', 'state', 'assignees', 'milestone', 'due_date', 'unset_due_date', 'ref'])
}

/** 依赖 / 阻塞关系的请求体。 */
function issueMetaBody(params) {
  const index = reqInt(params.dependsOn ?? params.index ?? params.target, 'index')
  return pick({
    index,
    owner: optString(params.owner, 'owner'),
    repo: optString(params.repo, 'repo'),
  }, ['index', 'owner', 'repo'])
}

// ── 操作表 ──────────────────────────────────────────────────────────────────

/**
 * 操作表。`scope` 决定桥要从入参里取哪些目标字段：
 * - `server`：只要服务器；
 * - `repo`：要 `owner` + `repo`；
 * - `issue`：还要 `index`（issue 编号）。
 *
 * 每条 `path(t)` 里的 `t` 已由桥校验过，`query(p)` / `body(p)` 只负责收敛参数。
 */
export const OPS = {
  // 服务器级
  'server.version': {
    scope: 'server', method: 'GET', auth: false,
    summary: 'Gitea 版本（连通性与版本探测，不需要令牌）',
    path: () => '/version',
  },
  'server.user': {
    scope: 'server', method: 'GET',
    summary: '当前令牌对应的用户（顺带校验令牌有效性）',
    path: () => '/user',
  },
  'attachment.content': {
    scope: 'server', method: 'GET', raw: true, base: 'root', uuid: true,
    summary: '取附件原始字节（web 路由 `/attachments/{uuid}`，令牌可用；图片内嵌用）',
    path: (t) => `/attachments/${segment(t.uuid)}`,
  },
  'repo.search': {
    scope: 'server', method: 'GET',
    summary: '搜索可见仓库',
    path: () => '/repos/search',
    query: (p) => pick({
      q: optString(p.q, 'q'),
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
      sort: optString(p.sort, 'sort'),
      order: optString(p.order, 'order'),
      archived: optBool(p.archived, 'archived'),
      private: optBool(p.private, 'private'),
      uid: optInt(p.uid, 'uid'),
    }, ['q', 'page', 'limit', 'sort', 'order', 'archived', 'private', 'uid']),
  },
  'repo.mine': {
    scope: 'server', method: 'GET',
    summary: '当前用户拥有的仓库',
    path: () => '/user/repos',
    query: (p) => pick({
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
    }, ['page', 'limit']),
  },
  'issue.search': {
    scope: 'server', method: 'GET',
    summary: '跨仓库搜索 issues（全局看板用）',
    path: () => '/repos/issues/search',
    query: issueSearchQuery,
  },

  // 仓库级
  'repo.get': {
    scope: 'repo', method: 'GET',
    summary: '仓库详情（权限、是否开启 issues）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}`,
  },
  'repo.labels': {
    scope: 'repo', method: 'GET',
    summary: '仓库标签（编辑 issue 时选标签）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/labels`,
    query: (p) => pick({
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
    }, ['page', 'limit']),
  },
  'repo.milestones': {
    scope: 'repo', method: 'GET',
    summary: '仓库里程碑',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/milestones`,
    query: (p) => pick({
      state: optEnum(p.state, 'state', ['open', 'closed', 'all']),
      name: optString(p.name, 'name'),
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
    }, ['state', 'name', 'page', 'limit']),
  },
  'repo.assignees': {
    scope: 'repo', method: 'GET',
    summary: '可指派用户候选',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/assignees`,
  },
  'issue.list': {
    scope: 'repo', method: 'GET',
    summary: '仓库 issue 列表 / 搜索',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues`,
    query: issueListQuery,
  },
  'issue.pinned': {
    scope: 'repo', method: 'GET',
    summary: '仓库内置顶的 issues',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/pinned`,
  },
  'issue.create': {
    scope: 'repo', method: 'POST',
    summary: '创建 issue',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues`,
    body: createIssueBody,
  },
  'comment.listRepo': {
    scope: 'repo', method: 'GET',
    summary: '仓库内全部评论（按时间倒序，用于「最近讨论」）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/comments`,
    query: (p) => pick({
      since: optString(p.since, 'since'),
      before: optString(p.before, 'before'),
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
    }, ['since', 'before', 'page', 'limit']),
  },
  'comment.get': {
    scope: 'repo', method: 'GET',
    summary: '取单条评论',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/comments/${segment(t.id)}`,
  },
  'comment.edit': {
    scope: 'repo', method: 'PATCH',
    summary: '编辑评论',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/comments/${segment(t.id)}`,
    body: (p) => ({ body: reqString(p.body, 'body') }),
  },
  'comment.delete': {
    scope: 'repo', method: 'DELETE',
    summary: '删除评论',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/comments/${segment(t.id)}`,
  },

  // issue 级
  'issue.get': {
    scope: 'issue', method: 'GET',
    summary: 'issue 详情',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}`,
  },
  'issue.edit': {
    scope: 'issue', method: 'PATCH',
    summary: '编辑 issue（标题 / 正文 / 状态 / 指派 / 里程碑 / 截止日）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}`,
    body: editIssueBody,
  },
  'issue.delete': {
    scope: 'issue', method: 'DELETE',
    summary: '删除 issue',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}`,
  },
  'issue.deadline': {
    scope: 'issue', method: 'POST',
    summary: '设置 / 清除截止日（清空请用 issue.edit 的 unset_due_date）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/deadline`,
    body: (p) => ({ due_date: reqString(p.due_date, 'due_date') }),
  },
  'issue.assignees.add': {
    scope: 'issue', method: 'POST',
    summary: '增加指派',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/assignees`,
    body: (p) => ({ assignees: optStringArray(p.assignees, 'assignees') ?? [] }),
  },
  'issue.assignees.remove': {
    scope: 'issue', method: 'DELETE',
    summary: '移除指派',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/assignees`,
    body: (p) => ({ assignees: optStringArray(p.assignees, 'assignees') ?? [] }),
  },
  'issue.assignee.check': {
    scope: 'issue', method: 'GET', needsUser: true,
    summary: '某用户是否可被指派（`user` 省略时用当前令牌用户）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/assignees/${segment(t.user)}`,
  },
  'issue.labels.get': {
    scope: 'issue', method: 'GET',
    summary: 'issue 标签',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/labels`,
  },
  'issue.labels.add': {
    scope: 'issue', method: 'POST',
    summary: '给 issue 加标签（追加）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/labels`,
    body: (p) => ({ labels: optLabelArray(p.labels, 'labels') ?? [] }),
  },
  'issue.labels.set': {
    scope: 'issue', method: 'PUT',
    summary: '整体替换 issue 标签',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/labels`,
    body: (p) => ({ labels: optLabelArray(p.labels, 'labels') ?? [] }),
  },
  'issue.labels.clear': {
    scope: 'issue', method: 'DELETE',
    summary: '清空 issue 标签',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/labels`,
  },
  'issue.labels.remove': {
    scope: 'issue', method: 'DELETE',
    summary: '移除某一个标签',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/labels/${segment(t.labelId)}`,
  },
  'issue.comments.list': {
    scope: 'issue', method: 'GET',
    summary: 'issue 评论列表',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/comments`,
    query: (p) => pick({
      since: optString(p.since, 'since'),
      before: optString(p.before, 'before'),
    }, ['since', 'before']),
  },
  'issue.comments.create': {
    scope: 'issue', method: 'POST',
    summary: '发表评论',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/comments`,
    body: (p) => ({ body: reqString(p.body, 'body') }),
  },
  'issue.timeline': {
    scope: 'issue', method: 'GET',
    summary: 'issue 时间线（评论 + 事件）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/timeline`,
    query: (p) => pick({
      since: optString(p.since, 'since'),
      before: optString(p.before, 'before'),
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
    }, ['since', 'before', 'page', 'limit']),
  },
  'issue.assets.list': {
    scope: 'issue', method: 'GET',
    summary: 'issue 附件列表',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/assets`,
  },
  'issue.assets.upload': {
    scope: 'issue', method: 'POST', upload: true,
    summary: '上传 issue 附件（multipart，字段名 attachment）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/assets`,
    query: (p) => pick({ name: optString(p.name, 'name') }, ['name']),
    form: (p) => attachmentForm(p),
  },
  'issue.asset.get': {
    scope: 'issue', method: 'GET',
    summary: '取单个附件元信息',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/assets/${segment(t.attachmentId)}`,
  },
  'issue.asset.edit': {
    scope: 'issue', method: 'PATCH',
    summary: '重命名附件',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/assets/${segment(t.attachmentId)}`,
    body: (p) => ({ name: reqString(p.name, 'name') }),
  },
  'issue.asset.delete': {
    scope: 'issue', method: 'DELETE',
    summary: '删除附件',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/assets/${segment(t.attachmentId)}`,
  },
  'comment.assets.list': {
    scope: 'repo', method: 'GET',
    summary: '评论附件列表（要 comment id）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/comments/${segment(t.id)}/assets`,
  },
  'comment.assets.upload': {
    scope: 'repo', method: 'POST', upload: true,
    summary: '上传评论附件（multipart，字段名 attachment）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/comments/${segment(t.id)}/assets`,
    query: (p) => pick({ name: optString(p.name, 'name') }, ['name']),
    form: (p) => attachmentForm(p),
  },
  'comment.asset.get': {
    scope: 'repo', method: 'GET',
    summary: '取单条评论附件元信息',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/comments/${segment(t.id)}/assets/${segment(t.attachmentId)}`,
  },
  'comment.asset.edit': {
    scope: 'repo', method: 'PATCH',
    summary: '重命名评论附件',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/comments/${segment(t.id)}/assets/${segment(t.attachmentId)}`,
    body: (p) => ({ name: reqString(p.name, 'name') }),
  },
  'comment.asset.delete': {
    scope: 'repo', method: 'DELETE',
    summary: '删除评论附件',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/comments/${segment(t.id)}/assets/${segment(t.attachmentId)}`,
  },
  'issue.dependencies.list': {
    scope: 'issue', method: 'GET',
    summary: '本 issue 依赖的 issues（被它们挡住）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/dependencies`,
    query: (p) => pick({
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
    }, ['page', 'limit']),
  },
  'issue.dependencies.add': {
    scope: 'issue', method: 'POST',
    summary: '增加依赖：本 issue 依赖 body 里那个 issue',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/dependencies`,
    body: issueMetaBody,
  },
  'issue.dependencies.remove': {
    scope: 'issue', method: 'DELETE',
    summary: '移除依赖',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/dependencies`,
    body: issueMetaBody,
  },
  'issue.blocks.list': {
    scope: 'issue', method: 'GET',
    summary: '被本 issue 挡住的 issues',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/blocks`,
    query: (p) => pick({
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
    }, ['page', 'limit']),
  },
  'issue.blocks.add': {
    scope: 'issue', method: 'POST',
    summary: '增加阻塞：本 issue 挡住 body 里那个 issue',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/blocks`,
    body: issueMetaBody,
  },
  'issue.blocks.remove': {
    scope: 'issue', method: 'DELETE',
    summary: '移除阻塞',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/blocks`,
    body: issueMetaBody,
  },
  'issue.subscribers': {
    scope: 'issue', method: 'GET',
    summary: '订阅者列表',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/subscriptions`,
    query: (p) => pick({
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
    }, ['page', 'limit']),
  },
  'issue.subscription.check': {
    scope: 'issue', method: 'GET',
    summary: '当前令牌用户是否订阅了本 issue',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/subscriptions/check`,
  },
  'issue.subscribe': {
    scope: 'issue', method: 'PUT', needsUser: true,
    summary: '订阅（`user` 省略时用当前令牌用户）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/subscriptions/${segment(t.user)}`,
  },
  'issue.unsubscribe': {
    scope: 'issue', method: 'DELETE', needsUser: true,
    summary: '取消订阅（`user` 省略时用当前令牌用户）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/subscriptions/${segment(t.user)}`,
  },
  'issue.pin': {
    scope: 'issue', method: 'POST',
    summary: '置顶',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/pin`,
  },
  'issue.unpin': {
    scope: 'issue', method: 'DELETE',
    summary: '取消置顶',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/pin`,
  },
  'issue.lock': {
    scope: 'issue', method: 'PUT',
    summary: '锁定讨论（可带 lock_reason）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/lock`,
    body: (p) => pick({
      lock_reason: optEnum(p.lock_reason, 'lock_reason', ['off-topic', 'too heated', 'resolved', 'spam']),
    }, ['lock_reason']),
  },
  'issue.unlock': {
    scope: 'issue', method: 'DELETE',
    summary: '解锁讨论',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/lock`,
  },
  'issue.times.list': {
    scope: 'issue', method: 'GET',
    summary: '工时列表',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/times`,
    query: (p) => pick({
      user: optString(p.user, 'user'),
      since: optString(p.since, 'since'),
      before: optString(p.before, 'before'),
      page: optInt(p.page, 'page', { min: 1 }),
      limit: optInt(p.limit, 'limit', { min: 1, max: 100 }),
    }, ['user', 'since', 'before', 'page', 'limit']),
  },
  'issue.times.add': {
    scope: 'issue', method: 'POST',
    summary: '登记工时（`time` 为秒）',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/times`,
    body: (p) => pick({
      time: reqInt(p.time, 'time'),
      created: optString(p.created, 'created'),
      user_name: optString(p.user_name, 'user_name'),
    }, ['time', 'created', 'user_name']),
  },
  'issue.times.reset': {
    scope: 'issue', method: 'DELETE',
    summary: '清空本 issue 的工时',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/times`,
  },
  'issue.times.delete': {
    scope: 'issue', method: 'DELETE',
    summary: '删除某一条工时',
    path: (t) => `/repos/${segment(t.owner)}/${segment(t.repo)}/issues/${segment(t.index)}/times/${segment(t.timeId)}`,
  },
}

/**
 * 组装附件上传的 multipart。
 * 桥传的是 base64（浏览器侧 `File` → `arrayBuffer` → base64），这里还原成字节再包一层 `File`。
 * @param params - `{ name, filename, contentType, dataBase64 }`。
 * @returns FormData。
 */
function attachmentForm(params) {
  const dataBase64 = reqString(params.dataBase64, 'dataBase64')
  const filename = reqString(params.filename, 'filename')
  let bytes
  try {
    bytes = Buffer.from(dataBase64, 'base64')
  } catch {
    throw new BridgeError(400, 'bad-request', 'dataBase64 is not valid base64')
  }
  if (bytes.byteLength === 0) throw new BridgeError(400, 'bad-request', 'attachment is empty')
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new BridgeError(413, 'too-large', `attachment exceeds the ${MAX_BODY_BYTES}-byte limit`)
  }
  const form = new FormData()
  const type = optString(params.contentType, 'contentType') ?? 'application/octet-stream'
  form.append('attachment', new File([bytes], filename, { type }), filename)
  return form
}

/**
 * 把入参里的目标字段收敛成 `{ owner, repo, index, ... }`。
 * @param op - 操作描述。
 * @param params - 入参。
 * @returns 目标对象。
 * @throws {BridgeError} 400 —— 缺字段或类型不对。
 */
export function resolveTarget(op, params) {
  const target = {}
  if (op.scope === 'repo' || op.scope === 'issue') {
    target.owner = reqString(params.owner, 'owner')
    target.repo = reqString(params.repo, 'repo')
  }
  if (op.scope === 'issue') target.index = reqInt(params.index, 'index')
  if (op.uuid === true) target.uuid = reqUuid(params.uuid)
  const passthrough = ['id', 'attachmentId', 'labelId', 'timeId', 'user', 'position']
  for (const field of passthrough) {
    if (params[field] !== undefined && params[field] !== null) target[field] = params[field]
  }
  return target
}

/**
 * 造一个 Gitea 客户端。
 * @param options - `baseUrl`（服务器根，不含 `/api/v1`）、`token`、可选的 `signal` / `userAgent`。
 * @returns `{ request }`。
 */
export function createGiteaClient(options) {
  const { baseUrl, token } = options
  const apiBase = `${baseUrl.replace(/\/+$/, '')}/api/v1`

  /**
   * 发一次请求。
   * @param pathname - 以 `/` 开头的 API 路径（不含 `/api/v1`）；`base: 'root'` 时相对服务器根。
   * @param request - `method` / `query` / `body` / `form` / `auth` / `raw` / `base` / `signal`。
   *   `raw: true` 表示响应体不是 JSON，而是**原始字节**（附件下载），返回
   *   `{ data: { base64, contentType, size } }` —— 浏览器拿不到令牌，图片只能由 Host 代取。
   * @returns `{ data, total }`；`total` 来自 `X-Total-Count`（没有则 undefined）。
   */
  async function request(pathname, request = {}) {
    const base = request.base === 'root' ? baseUrl.replace(/\/+$/, '') : apiBase
    const url = new URL(`${base}${pathname}`)
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    const headers = { accept: request.raw === true ? '*/*' : 'application/json', 'user-agent': options.userAgent ?? 'dsh-gitea-task-issues' }
    if (request.auth !== false) {
      if (typeof token !== 'string' || token === '') {
        throw new BridgeError(400, 'token-missing', 'this server has no token configured')
      }
      headers.authorization = `token ${token}`
    }
    let body
    if (request.form !== undefined) {
      body = request.form
    } else if (request.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(request.body)
    }
    const signal = request.signal === undefined
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    let response
    try {
      response = await fetch(url, { method: request.method, headers, body, signal })
    } catch (error) {
      // fetch 只在网络层、DNS、超时、取消上抛错；这些没有 Gitea 状态码。
      if (error?.name === 'TimeoutError') throw new BridgeError(504, 'timeout', `Gitea did not answer within ${REQUEST_TIMEOUT_MS}ms`)
      if (error?.name === 'AbortError') throw new BridgeError(499, 'aborted', 'request was cancelled')
      throw new BridgeError(502, 'network-error', `cannot reach ${url.origin}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (request.raw === true) {
      const contentType = String(response.headers.get('content-type') ?? 'application/octet-stream')
      if (!response.ok) {
        const text = await response.text()
        const message = text === '' ? `Gitea answered HTTP ${response.status}` : text.slice(0, 400)
        throw new GiteaError(response.status, codeForGiteaStatus(response.status), message)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > MAX_RAW_BYTES) {
        throw new BridgeError(413, 'too-large', `attachment is larger than ${MAX_RAW_BYTES} bytes`)
      }
      return { data: { base64: bytes.toString('base64'), contentType, size: bytes.byteLength } }
    }
    const text = await response.text()
    const contentType = String(response.headers.get('content-type') ?? '')
    let payload = text === '' ? undefined : text
    if (payload !== undefined && contentType.includes('json')) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }
    if (!response.ok) {
      const message = typeof payload === 'object' && payload !== null && typeof payload.message === 'string'
        ? payload.message
        : (typeof payload === 'string' && payload !== '' ? payload.slice(0, 400) : `Gitea answered HTTP ${response.status}`)
      throw new GiteaError(response.status, codeForGiteaStatus(response.status), message, payload)
    }
    const totalHeader = response.headers.get('x-total-count')
    const total = totalHeader === null ? undefined : Number(totalHeader)
    return { data: payload, total: Number.isFinite(total) ? total : undefined }
  }

  return { request, apiBase }
}

/**
 * 执行一条操作：查表 → 收敛目标 → 拼请求 → 打 Gitea。
 * @param client - `createGiteaClient` 的产物。
 * @param name - 操作名。
 * @param params - 入参。
 * @param signal - 取消信号。
 * @returns `{ data, total }`。
 * @throws {BridgeError} 400 —— 操作名未知或参数不合法。
 * @throws {GiteaError} 上游非 2xx。
 */
export async function runOperation(client, name, params, signal) {
  const op = OPS[name]
  if (op === undefined) throw new BridgeError(400, 'unknown-operation', `unknown operation "${name}"`)
  const target = resolveTarget(op, params)
  // 有些端点的用户名是**路径必需段**（订阅 / 可指派检查）。调用方省略时用当前令牌用户补上 ——
  // 让界面和模型都不必先自己问一次「我是谁」。
  if (op.needsUser === true && (target.user === undefined || target.user === '')) {
    const me = await client.request('/user', { method: 'GET', signal })
    const login = me?.data?.login
    if (typeof login !== 'string' || login === '') {
      throw new BridgeError(400, 'user-required', `operation "${name}" needs a user name and the token's own user could not be resolved`)
    }
    target.user = login
  }
  const request = {
    method: op.method,
    auth: op.auth,
    raw: op.raw,
    base: op.base,
    signal,
    query: op.query === undefined ? undefined : op.query(params),
    body: op.body === undefined ? undefined : op.body(params),
    form: op.form === undefined ? undefined : op.form(params),
  }
  const { data, total } = await client.request(op.path(target), request)
  return { data, total }
}

/**
 * 执行一条操作，并在操作收标签时先把标签名解析成 id。
 * @param client - `createGiteaClient` 的产物。
 * @param name - 操作名。
 * @param params - 入参。
 * @param signal - 取消信号。
 * @returns `{ data, total }`。
 */
export async function runOperationWithLabels(client, name, params, signal) {
  if (LABEL_OPS.has(name) && Array.isArray(params.labels) && params.labels.length > 0) {
    const labels = await resolveLabelIds(client, params.owner, params.repo, params.labels, signal)
    return runOperation(client, name, { ...params, labels }, signal)
  }
  return runOperation(client, name, params, signal)
}

/** 操作名清单（工具与自检用）。 */
export function operationNames() {
  return Object.keys(OPS).sort()
}

/** 收 `labels` 的操作。这几个操作的标签既要能收名字也要能收 id，所以统一先解析。 */
export const LABEL_OPS = new Set(['issue.create', 'issue.labels.add', 'issue.labels.set'])

/**
 * 把标签数组里的**名字**解析成 id。
 *
 * 为什么必须解析：`CreateIssueOption.labels` 在 swagger 里是 `[integer]`，直接送名字会被 422；
 * 而 `IssueLabelsOption.labels` 的类型 swagger 没写清（`[?]`），送名字能不能成要看版本。
 * 统一解析成 id 就不必赌版本行为。
 *
 * 顺序：先按名字查（名字优先，避免「名字恰好是数字」的标签被当成 id），查不到再当数字 id。
 * @param client - Gitea 客户端。
 * @param owner - 仓库所属。
 * @param repo - 仓库名。
 * @param labels - 标签数组（名字或 id 混合）。
 * @param signal - 取消信号。
 * @returns 全是整数 id 的数组。
 * @throws {BridgeError} 400 —— 名字在仓库里不存在。
 */
export async function resolveLabelIds(client, owner, repo, labels, signal) {
  const strings = labels.filter((label) => typeof label === 'string')
  if (strings.length === 0) return labels.map((label) => Number(label))
  const { data } = await client.request(`/repos/${segment(owner)}/${segment(repo)}/labels`, {
    method: 'GET',
    query: { limit: 100 },
    signal,
  })
  const byName = new Map()
  for (const label of Array.isArray(data) ? data : []) {
    if (typeof label?.name === 'string' && Number.isInteger(label?.id)) byName.set(label.name, label.id)
  }
  const out = []
  for (const label of labels) {
    if (typeof label === 'number') {
      out.push(label)
      continue
    }
    const match = byName.get(label)
    if (match !== undefined) {
      out.push(match)
      continue
    }
    if (/^\d+$/.test(label)) {
      out.push(Number(label))
      continue
    }
    throw new BridgeError(400, 'unknown-label', `label "${label}" does not exist in ${owner}/${repo}`)
  }
  return out
}
