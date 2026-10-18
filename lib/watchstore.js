/**
 * @module lib/watchstore
 *
 * 自动分配的**账本**：`$DSH_HOME/gitea-task-issues/watch.json`。
 *
 * ## 为什么跟 `servers.json` 分开一个文件
 *
 * 水位每轮都在变，而 `servers.json` 走 `ConfigStore` 的 `revision` 乐观并发，界面
 * 保存设置时带 `expectedRevision`。把水位写进 `servers.json`，界面每次保存都可能撞
 * `409 stale-config`——用户看到的现象是「设置怎么老是保存失败」。所以分文件，
 * 但**复用同一个 `ConfigStore` 类**（它允许换收敛器，见 `lib/store.js`）。
 *
 * ## 三块数据，三种生命周期
 *
 * - `watermarks`：每仓库一条水位（`since` 的基线）。只在**成功读完**之后推进；
 * - `issues`：每 issue 一条记录，里面是**事实**（`state` / `lastCommentId`）与
 *   **已投递标记**（`fired`）。事实每轮都推进，`fired` 只在决定投递时先写（write-ahead）；
 * - `deliveries`：环形缓冲，纯粹给界面看「它到底干了什么」。
 */
import { join } from 'node:path'

import { BridgeError } from './errors.js'
import { dshHome, PLUGIN_SCOPE } from './store.js'

/** 账本结构版本；加字段不改它，改语义才动。 */
export const WATCH_VERSION = 1

/** 轮询间隔的上下限（秒）。下限 60 是刻意的：再密就是在拿 Gitea 当轮询玩具。 */
export const MIN_INTERVAL_SECONDS = 60
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60

/** 每小时最多自动开几个会话。 */
export const MAX_SESSIONS_PER_HOUR_CEILING = 60

/** 「最近投递」保留条数。 */
export const MAX_DELIVERIES = 200

/** issue 记录多久没动就剪掉（毫秒）。 */
export const ISSUE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 水位往回的固定重叠（毫秒）：挡 Gitea 的秒级精度与两机时钟偏差。 */
export const WATERMARK_OVERLAP_MS = 60 * 1000

/** 三类触发的名字（界面、账本、探针共用这一份）。 */
export const TRIGGER_KINDS = ['newAssigned', 'reopened', 'newComment']

/**
 * 账本文件路径。
 * @returns `$DSH_HOME/gitea-task-issues/watch.json`。
 */
export function watchFile() {
  return join(dshHome(), PLUGIN_SCOPE, 'watch.json')
}

/**
 * 空白账本。
 * @returns 全新账本（总闸默认关）。
 */
export function emptyWatch() {
  return {
    version: WATCH_VERSION,
    revision: 0,
    global: {
      enabled: false,
      intervalSeconds: 120,
      maxSessionsPerHour: 6,
      dryRun: false,
      baselinedAt: null,
    },
    roots: {},
    watermarks: {},
    issues: {},
    deliveries: [],
  }
}

/**
 * 某个绑定的自动分配默认值。
 * @returns 默认配置。
 */
export function defaultRootWatch() {
  return {
    enabled: true,
    serverId: null,
    owner: null,
    repo: null,
    triggers: { newAssigned: true, reopened: true, newComment: true },
    agentPreset: null,
    cooldownSeconds: 600,
    maxPerIssuePerDay: 3,
    giveUpAfterHours: 24,
  }
}

/**
 * 仓库键：水位按仓库存。
 * @param args - `serverId` / `owner` / `repo`。
 * @returns 稳定键。
 */
export function repoKey({ serverId, owner, repo }) {
  return `${serverId}/${owner}/${repo}`
}

/**
 * issue 键：事实与已投递标记按 issue 存。
 * @param args - `serverId` / `owner` / `repo` / `index`。
 * @returns 稳定键。
 */
export function issueKey({ serverId, owner, repo, index }) {
  return `${serverId}/${owner}/${repo}#${index}`
}

/** 取有限的非负整数，越界的钳到边界（配置文件要宽容，不能因为一个脏值拒绝启动）。 */
function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number)) return fallback
  if (number < min) return min
  if (number > max) return max
  return number
}

/** 取布尔，非布尔回退。 */
function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 取字符串或 null。 */
function asText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 收敛一条 per-root 配置。 */
function coerceRootWatch(raw) {
  const base = defaultRootWatch()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const triggers = typeof raw.triggers === 'object' && raw.triggers !== null && !Array.isArray(raw.triggers)
    ? raw.triggers
    : {}
  return {
    enabled: asBool(raw.enabled, base.enabled),
    serverId: asText(raw.serverId),
    owner: asText(raw.owner),
    repo: asText(raw.repo),
    triggers: {
      newAssigned: asBool(triggers.newAssigned, base.triggers.newAssigned),
      reopened: asBool(triggers.reopened, base.triggers.reopened),
      newComment: asBool(triggers.newComment, base.triggers.newComment),
    },
    agentPreset: asText(raw.agentPreset),
    cooldownSeconds: clampInt(raw.cooldownSeconds, base.cooldownSeconds, 0, 24 * 60 * 60),
    maxPerIssuePerDay: clampInt(raw.maxPerIssuePerDay, base.maxPerIssuePerDay, 1, 50),
    giveUpAfterHours: clampInt(raw.giveUpAfterHours, base.giveUpAfterHours, 1, 168),
  }
}

/** 收敛待办槽位：三类各一个指纹，全空则归一成 null。`actor` 只是给提示词显示「谁评论的」。 */
function normalizePending(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const pending = {
    newAssigned: asText(raw.newAssigned),
    reopened: asText(raw.reopened),
    newComment: asText(raw.newComment),
    actor: asText(raw.actor),
  }
  return pending.newAssigned === null && pending.reopened === null && pending.newComment === null ? null : pending
}

/** 收敛一条 issue 事实。 */
function coerceIssueFact(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const firedRaw = typeof raw.fired === 'object' && raw.fired !== null && !Array.isArray(raw.fired) ? raw.fired : {}
  const dailyRaw = typeof raw.dailyCount === 'object' && raw.dailyCount !== null && !Array.isArray(raw.dailyCount) ? raw.dailyCount : {}
  const pendingRaw = typeof raw.pending === 'object' && raw.pending !== null && !Array.isArray(raw.pending) ? raw.pending : null
  return {
    state: asText(raw.state) ?? 'open',
    title: asText(raw.title),
    lastCommentId: clampInt(raw.lastCommentId, 0, 0, Number.MAX_SAFE_INTEGER),
    fired: {
      newAssigned: asBool(firedRaw.newAssigned, false),
      reopened: asText(firedRaw.reopened),
      commentId: clampInt(firedRaw.commentId, 0, 0, Number.MAX_SAFE_INTEGER),
    },
    // 已判出、还没投出去的触发，**按类型分槽**（一条 issue 可能同时「被重开」且「有新评论」）。
    // 有了它就不必为了「等空闲」而压住水位——水位照常推进，待办留在账本里，重启也不丢。
    // 投递时一次性把所有槽位都标成已投递，否则漏标的那一类下轮会再触发一次、多开一个会话。
    pending: normalizePending(pendingRaw),
    pendingSince: asText(raw.pendingSince),
    deliveredAt: asText(raw.deliveredAt),
    touchedAt: asText(raw.touchedAt),
    dailyCount: { day: asText(dailyRaw.day), n: clampInt(dailyRaw.n, 0, 0, 1000) },
  }
}

/**
 * 把磁盘上的任意内容收敛成合法账本：缺字段补默认，多余字段保留（向前兼容）。
 * @param raw - 从 JSON 读到的值。
 * @returns 合法账本。
 */
export function coerceWatch(raw) {
  const base = emptyWatch()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base

  const globalRaw = typeof raw.global === 'object' && raw.global !== null && !Array.isArray(raw.global) ? raw.global : {}
  const global = {
    enabled: asBool(globalRaw.enabled, base.global.enabled),
    intervalSeconds: clampInt(globalRaw.intervalSeconds, base.global.intervalSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS),
    maxSessionsPerHour: clampInt(globalRaw.maxSessionsPerHour, base.global.maxSessionsPerHour, 1, MAX_SESSIONS_PER_HOUR_CEILING),
    dryRun: asBool(globalRaw.dryRun, base.global.dryRun),
    baselinedAt: asText(globalRaw.baselinedAt),
  }

  const roots = {}
  if (typeof raw.roots === 'object' && raw.roots !== null && !Array.isArray(raw.roots)) {
    for (const [root, value] of Object.entries(raw.roots)) {
      if (typeof root === 'string' && root.trim() !== '') roots[root] = coerceRootWatch(value)
    }
  }

  const watermarks = {}
  if (typeof raw.watermarks === 'object' && raw.watermarks !== null && !Array.isArray(raw.watermarks)) {
    for (const [key, value] of Object.entries(raw.watermarks)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      watermarks[key] = { issues: asText(value.issues), comments: asText(value.comments) }
    }
  }

  const issues = {}
  if (typeof raw.issues === 'object' && raw.issues !== null && !Array.isArray(raw.issues)) {
    for (const [key, value] of Object.entries(raw.issues)) {
      const fact = coerceIssueFact(value)
      if (fact !== null) issues[key] = fact
    }
  }

  const deliveries = Array.isArray(raw.deliveries)
    ? raw.deliveries.filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item)).slice(-MAX_DELIVERIES)
    : []

  return {
    ...raw,
    version: WATCH_VERSION,
    revision: typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 0,
    global,
    roots,
    watermarks,
    issues,
    deliveries,
  }
}

/**
 * 校验并规范化 `watch.set` 里的 global 局部更新。
 * @param input - 请求体片段。
 * @returns 只含被提供字段的对象。
 * @throws {BridgeError} 400 —— 任一字段不合法。
 */
export function normalizeWatchGlobal(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError(400, 'bad-request', 'global must be a JSON object')
  }
  const out = {}
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new BridgeError(400, 'bad-request', 'global.enabled must be a boolean')
    out.enabled = input.enabled
  }
  if (input.dryRun !== undefined) {
    if (typeof input.dryRun !== 'boolean') throw new BridgeError(400, 'bad-request', 'global.dryRun must be a boolean')
    out.dryRun = input.dryRun
  }
  if (input.intervalSeconds !== undefined) {
    const value = Number(input.intervalSeconds)
    if (!Number.isInteger(value) || value < MIN_INTERVAL_SECONDS || value > MAX_INTERVAL_SECONDS) {
      throw new BridgeError(400, 'bad-request', `global.intervalSeconds must be an integer within ${MIN_INTERVAL_SECONDS}..${MAX_INTERVAL_SECONDS}`)
    }
    out.intervalSeconds = value
  }
  if (input.maxSessionsPerHour !== undefined) {
    const value = Number(input.maxSessionsPerHour)
    if (!Number.isInteger(value) || value < 1 || value > MAX_SESSIONS_PER_HOUR_CEILING) {
      throw new BridgeError(400, 'bad-request', `global.maxSessionsPerHour must be an integer within 1..${MAX_SESSIONS_PER_HOUR_CEILING}`)
    }
    out.maxSessionsPerHour = value
  }
  return out
}

/**
 * 校验并规范化 `watch.set` 里的 per-root 局部更新。
 * @param input - 请求体片段。
 * @returns 只含被提供字段的对象。
 * @throws {BridgeError} 400 —— 任一字段不合法。
 */
export function normalizeWatchRoot(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError(400, 'bad-request', 'rootConfig must be a JSON object')
  }
  const out = {}
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new BridgeError(400, 'bad-request', 'rootConfig.enabled must be a boolean')
    out.enabled = input.enabled
  }
  if (input.agentPreset !== undefined) {
    if (input.agentPreset !== null && (typeof input.agentPreset !== 'string' || input.agentPreset.trim() === '')) {
      throw new BridgeError(400, 'bad-request', 'rootConfig.agentPreset must be a non-empty string or null')
    }
    out.agentPreset = input.agentPreset === null ? null : input.agentPreset.trim()
  }
  if (input.triggers !== undefined) {
    const triggers = input.triggers
    if (typeof triggers !== 'object' || triggers === null || Array.isArray(triggers)) {
      throw new BridgeError(400, 'bad-request', 'rootConfig.triggers must be a JSON object')
    }
    const built = {}
    for (const kind of TRIGGER_KINDS) {
      if (triggers[kind] === undefined) continue
      if (typeof triggers[kind] !== 'boolean') {
        throw new BridgeError(400, 'bad-request', `rootConfig.triggers.${kind} must be a boolean`)
      }
      built[kind] = triggers[kind]
    }
    out.triggers = built
  }
  for (const [field, min, max] of [
    ['cooldownSeconds', 0, 24 * 60 * 60],
    ['maxPerIssuePerDay', 1, 50],
    ['giveUpAfterHours', 1, 168],
  ]) {
    if (input[field] === undefined) continue
    const value = Number(input[field])
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new BridgeError(400, 'bad-request', `rootConfig.${field} must be an integer within ${min}..${max}`)
    }
    out[field] = value
  }
  return out
}

/**
 * 一条全新的 issue 事实。形状只在这里定义一次，`lib/triggers.js` 从这里取。
 * @param state - 初始 `state`（`open` / `closed`）。
 * @returns 新事实。
 */
export function newIssueFact(state = 'open') {
  return {
    state,
    title: null,
    lastCommentId: 0,
    fired: { newAssigned: false, reopened: null, commentId: 0 },
    pending: null,
    pendingSince: null,
    deliveredAt: null,
    touchedAt: null,
    dailyCount: { day: null, n: 0 },
  }
}
/**
 * 剪枝：扔掉太久没动的 issue 记录、超上限的投递记录。
 *
 * 只在写盘前调用，**不改变**语义（事实与 `fired` 都还在 TTL 内）。
 * @param state - 账本（就地修改）。
 * @param now - 当前毫秒。
 * @returns 同一个账本。
 */
export function pruneWatch(state, now) {
  const cutoff = now - ISSUE_TTL_MS
  for (const [key, fact] of Object.entries(state.issues)) {
    // **待办不剪**：还没投出去的触发不管放多久都得留着，否则「等空闲」就变成「等到丢」。
    if (fact.pending !== null) continue
    const touched = Date.parse(fact.touchedAt ?? fact.deliveredAt ?? '')
    if (Number.isFinite(touched) && touched < cutoff) delete state.issues[key]
  }
  if (state.deliveries.length > MAX_DELIVERIES) {
    state.deliveries = state.deliveries.slice(-MAX_DELIVERIES)
  }
  return state
}

/**
 * 追加一条投递记录（环形缓冲）。就地修改。
 * @param state - 账本。
 * @param entry - 记录内容。
 * @returns 同一个账本。
 */
export function pushDelivery(state, entry) {
  state.deliveries.push(entry)
  if (state.deliveries.length > MAX_DELIVERIES) {
    state.deliveries = state.deliveries.slice(-MAX_DELIVERIES)
  }
  return state
}
