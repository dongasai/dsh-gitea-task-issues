/**
 * @module lib/triggers
 *
 * **纯函数**：账本 + 本轮 issue + 本轮评论 → 新的账本 + 待投递的触发。
 *
 * 为什么一定要无副作用：这个功能的行为面几乎全是「边界」——首次基线、自评、冷却、
 * 重开、水位回退、工作区忙。把这些判在一堆 `await fetch()` 中间，探针就只能靠真起服务
 * 去测；抽成纯函数之后，整套矩阵可以用一张表测完（`tests/triggers.test.mjs`）。
 *
 * ## 三种触发
 *
 * | 触发 | 条件 | fingerprint |
 * |---|---|---|
 * | `newAssigned` | 账本里根本没有这条 issue（查询本身已经限定「指派给我」） | `n{created_at}` |
 * | `reopened` | 账本记 `closed`、本轮 `open` | `r{updated_at}` |
 * | `newComment` | 出现比 `fired.commentId` 更大的、**不是我发的**评论 | `c{评论 id}` |
 *
 * ## 两条关键设计
 *
 * ### 1. 触发写进账本（`pending`），不是「压住水位」
 *
 * 一开始的想法是「工作区忙就不推进水位，下轮重新读到」。那条路有隐患：水位是**按仓库**的，
 * 一条待办会把整仓的水位一起压住，而且「读到哪了」与「什么还没投」混成一个数。现在改成：
 * **判出触发当场记进 `facts[key].pending`，水位该推进就推进。**
 *
 * ### 2. `pending` 是**按类型分槽的集合**，不是一个带优先级的单槽
 *
 * 一条 issue 完全可能同时「刚被重开」且「又有新评论」。如果只留一个槽（甚至还按优先级挑），
 * 投递时把评论那类标成已投递、却没标重开那类，**下轮重开就会再触发一次、白开一个会话**。
 * 分槽之后：投递时把三个槽一起标掉，漏标这个 bug 从结构上就不存在了。
 */
import { newIssueFact } from './watchstore.js'

/** 一类触发对应的中文说明（进提示词，也给界面看）。 */
export const KIND_TEXT = {
  newAssigned: '刚被指派给你',
  reopened: '被重新打开了',
  newComment: '有新评论',
}

/** 三类触发的固定顺序（提示词与界面都按这个顺序说，读起来稳定）。 */
export const KIND_ORDER = ['newAssigned', 'reopened', 'newComment']

/**
 * 取一条评论所属的 issue 编号。
 *
 * 仓库级评论列表里的评论**不带 issue 编号**（`lib/shape.js` 的 `shapeComment` 在仓库级
 * 调用下 `issueIndex` 是 `null`），所以这里兜一层：优先用已经派生好的 `issueIndex`。
 * @param comment - 出线形状的评论。
 * @returns 编号，或 undefined。
 */
function commentIssueIndex(comment) {
  const index = comment?.issueIndex
  return typeof index === 'number' && Number.isInteger(index) ? index : undefined
}

/** 评论 id 的取值（非数字按 0）。 */
function commentId(comment) {
  return typeof comment?.id === 'number' ? comment.id : 0
}

/**
 * 判定本轮所有触发，并推进账本事实。
 *
 * @param input - 见下。
 * @param input.prefix - `serverId/owner/repo`（`prefixOf` 拼）。
 * @param input.config - 这份绑定的自动分配配置（`triggers` 三个开关）。
 * @param input.facts - 该仓库现有的事实表（`{ [issueKey]: Fact }`，只含本仓库）。
 * @param input.issues - 本轮 issue（已经过滤到本仓库）。
 * @param input.comments - 本轮评论（已经过滤到本仓库）。
 * @param input.login - 令牌对应的用户名；**undefined 表示没解析出来**。
 * @param input.now - 当前时刻（毫秒）。
 * @param input.firstRun - 首次轮询（只建立基线，零投递）。
 * @returns `{ facts, triggers, notes }`——`facts` 替换该仓库的事实表；`triggers` 是待投递
 *   的 issue（已按类型顺序排好）；`notes` 是被判定为「不该触发」的原因，给界面解释用。
 */
export function planTriggers({ prefix, config, facts, issues, comments, login, now, firstRun }) {
  const next = {}
  for (const [key, fact] of Object.entries(facts ?? {})) next[key] = structuredClone(fact)
  const notes = []
  const nowIso = new Date(now).toISOString()

  /** 往待办槽里放一条（同指纹不重复放，避免 pendingSince 被反复刷新）。 */
  const arm = (fact, kind, fingerprint) => {
    if (fact.pending === null) {
      fact.pending = { newAssigned: null, reopened: null, newComment: null }
    }
    if (fact.pending[kind] !== fingerprint) fact.pending[kind] = fingerprint
    fact.pendingSince = fact.pendingSince ?? nowIso
  }

  // ── 1. issue 侧：新指派与重开 ─────────────────────────────────────────────
  for (const issue of issues ?? []) {
    const index = issue?.index
    if (typeof index !== 'number' || !Number.isInteger(index)) continue
    const key = `${prefix}#${index}`
    const known = (facts ?? {})[key] !== undefined
    const fact = next[key] ?? newIssueFact(issue.state)
    next[key] = fact

    if (!known) {
      // 首次轮询：把当前状态记成「已处理」，零投递。
      // 否则一开启就会把历史上所有指派给自己的 issue 全各开一个会话。
      if (firstRun || !config.triggers.newAssigned) {
        fact.fired.newAssigned = true
      } else {
        arm(fact, 'newAssigned', `n${issue.createdAt ?? index}`)
      }
    } else if (fact.state === 'closed' && issue.state === 'open') {
      const fingerprint = `r${issue.updatedAt ?? index}`
      if (fact.fired.reopened !== fingerprint) {
        if (config.triggers.reopened) arm(fact, 'reopened', fingerprint)
        else fact.fired.reopened = fingerprint
      }
    }
    fact.state = issue.state ?? fact.state
    if (typeof issue.title === 'string') fact.title = issue.title
    fact.touchedAt = nowIso
  }

  // ── 2. 评论侧：别人的新评论 ───────────────────────────────────────────────
  const byIssue = new Map()
  for (const comment of comments ?? []) {
    const index = commentIssueIndex(comment)
    if (index === undefined) continue
    if (!byIssue.has(index)) byIssue.set(index, [])
    byIssue.get(index).push(comment)
  }

  for (const [index, list] of byIssue) {
    const key = `${prefix}#${index}`
    const fact = next[key]
    // 评论落在「没指派给我」的 issue 上：不是我们的活，直接忽略（连事实都不建）。
    if (fact === undefined) continue

    const newest = list.reduce((max, comment) => Math.max(max, commentId(comment)), 0)
    fact.lastCommentId = Math.max(fact.lastCommentId, newest)
    fact.touchedAt = nowIso

    if (login === undefined) {
      // 认不出「我是谁」时**不敢**判评论触发：万一是自己发的就会自激。
      // 有意 fail-safe —— 宁可不触发，也不要把自己叫醒。
      notes.push({ key, kind: 'newComment', reason: 'login-unknown' })
      continue
    }

    const others = list.filter((comment) => comment?.user?.login !== login)
    if (others.length === 0) continue
    const newestOther = others.reduce((max, comment) => Math.max(max, commentId(comment)), 0)
    if (newestOther <= fact.fired.commentId) continue

    if (!config.triggers.newComment || firstRun) {
      // 关掉这类触发时把水位吃掉；**首次轮询同理**——漏了 `firstRun`，开启功能的第一轮就会
      // 把每条指派 issue 上的历史评论各开一个会话，和 issue 侧同一个「基线洪水」，只是位置不同。
      fact.fired.commentId = newestOther
      continue
    }
    const newestComment = others.find((comment) => commentId(comment) === newestOther)
    const actor = newestComment?.user?.login
    arm(fact, 'newComment', `c${newestOther}`)
    if (typeof actor === 'string') fact.pending.actor = actor
  }

  // ── 3. 汇总：有待办槽的 issue 就是待投递 ──────────────────────────────────
  const triggers = []
  for (const [key, fact] of Object.entries(next)) {
    if (fact.pending === null) continue
    const index = Number(key.slice(key.lastIndexOf('#') + 1))
    if (!Number.isInteger(index)) continue
    const kinds = KIND_ORDER.filter((kind) => fact.pending[kind] !== null)
    if (kinds.length === 0) continue
    triggers.push({
      key,
      index,
      title: fact.title,
      kinds,
      fingerprints: Object.fromEntries(kinds.map((kind) => [kind, fact.pending[kind]])),
      actor: typeof fact.pending.actor === 'string' ? fact.pending.actor : null,
      pendingSince: fact.pendingSince,
    })
  }
  triggers.sort((left, right) => left.index - right.index)
  return { facts: next, triggers, notes }
}

/**
 * 把一条待办渲染成提示词里的「为什么叫醒你」。纯函数，探针直接断言文案。
 * @param trigger - `planTriggers` 产出的触发。
 * @returns 一行中文说明。
 */
export function describeTrigger(trigger) {
  const parts = trigger.kinds.map((kind) => (
    kind === 'newComment' && typeof trigger.actor === 'string'
      ? `${KIND_TEXT[kind]} by @${trigger.actor}`
      : KIND_TEXT[kind]
  ))
  return `（自动分配：${parts.join('；')}）`
}

/**
 * 投递前的一次准入检查（纯函数）：冷却与单 issue 每日上限。
 *
 * 全局每小时配额不在这里 —— 它要跨绑定看，属于 `lib/watch.js` 的账。
 * @param fact - issue 事实。
 * @param config - 这份绑定的配置。
 * @param now - 当前毫秒。
 * @returns 拒绝原因（`cooldown` / `daily`），或 null 表示放行。
 */
export function deliveryBlock(fact, config, now) {
  const deliveredAt = Date.parse(fact.deliveredAt ?? '')
  if (Number.isFinite(deliveredAt) && now - deliveredAt < config.cooldownSeconds * 1000) return 'cooldown'
  const day = new Date(now).toISOString().slice(0, 10)
  if (fact.dailyCount.day === day && fact.dailyCount.n >= config.maxPerIssuePerDay) return 'daily'
  return null
}

/**
 * 投递成功：把待办槽全部转成已投递标记。
 *
 * **必须一次标完所有槽位**（见模块头第 2 条）：只标其中一类的话，另一类下轮会重新触发。
 * @param fact - issue 事实（就地修改）。
 * @param trigger - 刚投递的那条触发。
 * @param now - 当前毫秒。
 * @returns 同一个事实。
 */
export function markFired(fact, trigger, now) {
  for (const kind of trigger.kinds) {
    const fingerprint = trigger.fingerprints[kind]
    if (kind === 'newAssigned') fact.fired.newAssigned = true
    if (kind === 'reopened') fact.fired.reopened = fingerprint
    if (kind === 'newComment') {
      const id = Number(String(fingerprint).replace(/^c/, ''))
      if (Number.isInteger(id)) fact.fired.commentId = Math.max(fact.fired.commentId, id)
    }
  }
  const day = new Date(now).toISOString().slice(0, 10)
  fact.dailyCount = fact.dailyCount.day === day
    ? { day, n: fact.dailyCount.n + 1 }
    : { day, n: 1 }
  fact.deliveredAt = new Date(now).toISOString()
  fact.pending = null
  fact.pendingSince = null
  return fact
}

/**
 * 组合键：给外部拼 `prefix` 用（探针与 `lib/watch.js` 共用，别各自拼字符串）。
 * @param args - `serverId` / `owner` / `repo`。
 * @returns 仓库前缀。
 */
export function prefixOf({ serverId, owner, repo }) {
  return `${serverId}/${owner}/${repo}`
}
