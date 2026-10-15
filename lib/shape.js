/**
 * @module lib/shape
 *
 * Gitea 对象 → 线上对象。**这是浏览器半边唯一认的字段集**，改字段等于改线上协议。
 *
 * 为什么不原样把 Gitea 的 JSON 吐给浏览器：一个 issue 里有 `repository`、`assignee`、
 * `milestone.creator`… 全是重复的整对象，50 条列表能有 200KB+；而界面真正用的就十几个字段。
 * 这里做一层「瘦身 + 改名」，顺带把 Gitea 里位置不固定的信息（`repository.owner.login`、
 * `repository.name`）拍平成 `owner` / `repo`，让界面不必再去理解 Gitea 的对象图。
 *
 * 所有函数都对缺字段宽容：上游版本差异只影响某个字段是 undefined，不能让整块界面炸掉。
 */

/**
 * 取一个可能不存在的对象字段。
 * @param value - 容器。
 * @param key - 字段名。
 * @returns 字段值，或 undefined。
 */
function at(value, key) {
  if (typeof value !== 'object' || value === null) return undefined
  return value[key]
}

/** 字符串字段；非字符串一律 undefined。 */
function str(value) {
  return typeof value === 'string' ? value : undefined
}

/** 布尔字段；非布尔一律 undefined。 */
function bool(value) {
  return typeof value === 'boolean' ? value : undefined
}

/** 整数字段。 */
function int(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/**
 * 用户 → `{ login, name, avatarUrl }`。
 * @param raw - Gitea 的 user 对象。
 * @returns 线上用户对象，或 undefined。
 */
export function shapeUser(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const login = str(at(raw, 'login'))
  if (login === undefined) return undefined
  return {
    login,
    name: str(at(raw, 'full_name')) ?? null,
    avatarUrl: str(at(raw, 'avatar_url')) ?? null,
  }
}

/**
 * 标签 → `{ id, name, color, description }`。
 * @param raw - Gitea 的 label 对象。
 * @returns 线上标签对象，或 undefined。
 */
export function shapeLabel(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const name = str(at(raw, 'name'))
  if (name === undefined) return undefined
  return {
    id: int(at(raw, 'id')) ?? null,
    name,
    color: str(at(raw, 'color')) ?? null,
    description: str(at(raw, 'description')) ?? null,
  }
}

/**
 * 里程碑 → `{ id, title, state, dueOn }`。
 * @param raw - Gitea 的 milestone 对象。
 * @returns 线上里程碑对象，或 undefined。
 */
export function shapeMilestone(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const title = str(at(raw, 'title'))
  if (title === undefined) return undefined
  return {
    id: int(at(raw, 'id')) ?? null,
    title,
    state: str(at(raw, 'state')) ?? null,
    dueOn: str(at(raw, 'due_on')) ?? null,
  }
}

/**
 * 仓库 → `{ serverId, id, owner, repo, fullName, private, hasIssues, htmlUrl, updatedAt, defaultBranch }`。
 * @param raw - Gitea 的 repository 对象。
 * @param serverId - 所属服务器 id。
 * @returns 线上仓库对象，或 undefined。
 */
export function shapeRepo(raw, serverId) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const owner = str(at(at(raw, 'owner'), 'login')) ?? str(at(raw, 'owner'))
  const name = str(at(raw, 'name'))
  if (owner === undefined || name === undefined) return undefined
  return {
    serverId: serverId ?? null,
    id: int(at(raw, 'id')) ?? null,
    owner,
    repo: name,
    fullName: str(at(raw, 'full_name')) ?? `${owner}/${name}`,
    private: bool(at(raw, 'private')) ?? null,
    hasIssues: bool(at(raw, 'has_issues')) ?? null,
    htmlUrl: str(at(raw, 'html_url')) ?? null,
    updatedAt: str(at(raw, 'updated_at')) ?? null,
    defaultBranch: str(at(raw, 'default_branch')) ?? null,
  }
}

/**
 * issue → 线上 issue。`/repos/issues/search` 的返回里带 `repository`，仓库级列表也带，
 * 但旧版本可能不带，所以调用方可以用 `fallback` 兜一层。
 * @param raw - Gitea 的 issue 对象。
 * @param options - `serverId`、`owner` / `repo` 兜底值。
 * @returns 线上 issue 对象，或 undefined。
 */
export function shapeIssue(raw, options = {}) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const repository = at(raw, 'repository')
  const owner = str(at(at(repository, 'owner'), 'login')) ?? str(at(repository, 'owner')) ?? options.owner ?? null
  const repo = str(at(repository, 'name')) ?? options.repo ?? null
  const index = int(at(raw, 'number'))
  if (index === undefined) return undefined
  const labels = Array.isArray(at(raw, 'labels')) ? at(raw, 'labels').map(shapeLabel).filter(Boolean) : []
  const assignees = Array.isArray(at(raw, 'assignees')) ? at(raw, 'assignees').map(shapeUser).filter(Boolean) : []
  const milestone = shapeMilestone(at(raw, 'milestone'))
  return {
    serverId: options.serverId ?? null,
    owner,
    repo,
    index,
    title: str(at(raw, 'title')) ?? '',
    state: str(at(raw, 'state')) ?? 'open',
    body: str(at(raw, 'body')) ?? '',
    labels,
    assignees,
    milestone: milestone ?? null,
    dueDate: str(at(raw, 'due_date')) ?? null,
    comments: int(at(raw, 'comments')) ?? 0,
    createdAt: str(at(raw, 'created_at')) ?? null,
    updatedAt: str(at(raw, 'updated_at')) ?? null,
    closedAt: str(at(raw, 'closed_at')) ?? null,
    htmlUrl: str(at(raw, 'html_url')) ?? null,
    user: shapeUser(at(raw, 'user')) ?? null,
    isPull: at(raw, 'pull_request') !== undefined && at(raw, 'pull_request') !== null,
    locked: bool(at(raw, 'is_locked')) ?? false,
    // Gitea 用 `pin_order`（整数）表示置顶；0 也是置顶，所以判「字段在不在」而不是判真假。
    pinned: at(raw, 'pin_order') !== undefined && at(raw, 'pin_order') !== null,
  }
}

/**
 * 评论 → 线上评论。
 * @param raw - Gitea 的 comment 对象。
 * @param options - `serverId` / `owner` / `repo` 兜底值。
 * @returns 线上评论对象，或 undefined。
 */
export function shapeComment(raw, options = {}) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = int(at(raw, 'id'))
  if (id === undefined) return undefined
  return {
    id,
    serverId: options.serverId ?? null,
    owner: options.owner ?? null,
    repo: options.repo ?? null,
    issueIndex: options.issueIndex ?? null,
    body: str(at(raw, 'body')) ?? '',
    user: shapeUser(at(raw, 'user')) ?? null,
    createdAt: str(at(raw, 'created_at')) ?? null,
    updatedAt: str(at(raw, 'updated_at')) ?? null,
    htmlUrl: str(at(raw, 'html_url')) ?? null,
    assets: Array.isArray(at(raw, 'assets')) ? at(raw, 'assets').map(shapeAsset).filter(Boolean) : [],
  }
}

/**
 * 附件 → 线上附件。
 * @param raw - Gitea 的 attachment 对象。
 * @returns 线上附件对象，或 undefined。
 */
export function shapeAsset(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = int(at(raw, 'id'))
  if (id === undefined) return undefined
  return {
    id,
    name: str(at(raw, 'name')) ?? null,
    size: int(at(raw, 'size')) ?? null,
    uuid: str(at(raw, 'uuid')) ?? null,
    downloadUrl: str(at(raw, 'browser_download_url')) ?? null,
    createdAt: str(at(raw, 'created_at')) ?? null,
  }
}

/**
 * 工时 → 线上工时。`time` 单位是**秒**（Gitea 的 `AddTimeOption.time` 同义）。
 * @param raw - Gitea 的 tracked time 对象。
 * @returns 线上工时对象，或 undefined。
 */
export function shapeTime(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = int(at(raw, 'id'))
  if (id === undefined) return undefined
  return {
    id,
    time: int(at(raw, 'time')) ?? 0,
    created: str(at(raw, 'created')) ?? null,
    userName: str(at(raw, 'user_name')) ?? null,
  }
}

/**
 * 时间线条目 → 线上条目。Gitea 的 timeline 是评论与事件的混合数组，按 `type` 分支。
 * @param raw - Gitea 的 timeline 条目。
 * @param options - `serverId` / `owner` / `repo`。
 * @returns 线上时间线条目。
 */
export function shapeTimeline(raw, options = {}) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const type = str(at(raw, 'type')) ?? 'unknown'
  const base = {
    type,
    id: int(at(raw, 'id')) ?? null,
    createdAt: str(at(raw, 'created_at')) ?? null,
    user: shapeUser(at(raw, 'user')) ?? null,
  }
  if (type === 'comment' || type === 'review') return { ...base, comment: shapeComment(raw, options) }
  if (type === 'label') return { ...base, label: shapeLabel(at(raw, 'label')) ?? null, removed: bool(at(raw, 'removed')) ?? false }
  if (type === 'assignees') return { ...base, assignees: Array.isArray(at(raw, 'assignees')) ? at(raw, 'assignees').map(shapeUser).filter(Boolean) : [], removed: bool(at(raw, 'removed')) ?? false }
  if (type === 'milestone') return { ...base, milestone: shapeMilestone(at(raw, 'milestone')) ?? null }
  if (type === 'close' || type === 'reopen') return { ...base, commitId: str(at(raw, 'commit_id')) ?? null }
  if (type === 'issue_ref') return { ...base, refIssue: shapeIssue(at(raw, 'ref_issue'), options) ?? null }
  return { ...base, body: str(at(raw, 'body')) ?? null }
}

/**
 * 列表整批瘦身。
 * @param list - 原始数组。
 * @param fn - 单条映射函数。
 * @returns 过滤掉 undefined 的数组。
 */
export function shapeList(list, fn) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    const shaped = fn(item)
    if (shaped !== undefined) out.push(shaped)
  }
  return out
}

/** 组合用：把一个 issue 列表映射成线上 issue。 */
export function shapeIssues(list, options) {
  return shapeList(list, (item) => shapeIssue(item, options))
}
