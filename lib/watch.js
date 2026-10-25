/**
 * @module lib/watch
 *
 * 自动分配的**轮询器**：定期拉所有「已启用」绑定的增量，判出触发，工作区空闲就新建一个
 * 会话并把提示词投进去。
 *
 * ## 与「不做后台轮询」那条硬约束的关系
 *
 * `AGENTS.md` 约束 8 与 `index.js` 约束 4 原本写的是「不做后台轮询、不做静默重试」。这条
 * 约束针对的是**桥**——浏览器点一下才发一次请求，不让插件偷偷拿用户的令牌去打 Gitea。
 * 轮询器是另一个子系统，口径是：
 *
 * > **桥不做后台轮询、不做静默重试；后台轮询只属于 watch 子系统**——默认关闭、可一键停、
 * > 有配额、失败可见。
 *
 * 具体落在这几处：总闸默认 `false`；每轮都重读配置（关掉下一轮就停）；失败有界退避且把
 * 原因写进状态给界面看；开几个会话每小时有上限；跨进程有单飞锁。
 *
 * ## 一次 tick 的顺序（顺序本身就是设计）
 *
 * ```
 * 拿锁 → 读配置 → 取数（每服务器 1 次 issue 搜索 + 每仓库 1 次评论增量）
 *      → 判触发 → 落账（事实 + 水位 + 放弃超期待办）
 *      → 逐条投递：先查工作区忙不忙（只读）→ 忙就留着下轮 → 不忙才写「已投递」（write-ahead）
 *        → create + prompt → 记结果
 * ```
 *
 * 「先查忙、再写已投递」这个顺序两个方向都不能反：
 * - **忙的时候不能写已投递**，否则这条待办永远丢了；
 * - **不忙的时候必须先写已投递再投**，否则崩在中间会重复投一次（多花模型调用、还可能重复
 *   改远端）。设计上选了「宁可漏，不可重」，界面提供重放。
 *
 * ## 水位只在「没被截断」时才推进
 *
 * `since` 查询有 `limit`。如果一页正好打满，说明**还有更旧的更新没读到**——这时把水位推到
 * 「现在」就会把那批永久漏掉。所以截断时水位只推进到本批最旧的 `updated_at`（不退反进地
 * 收敛），下一轮接着读。这条是漏单的主要防线。
 *
 * ## 依赖是软的
 *
 * `sessionController`（以及 `workspaceRegistry`）只在 web 类组合里挂载，headless 组合没有。
 * 一律 `ctx.get(...)` 探测，拿不到就把状态标成不可用并跳过投递——**不抛错、不崩**，界面
 * 能解释「当前宿主不支持自动开会话」。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { BridgeError, messageOf } from './errors.js'
import { runOperation } from './gitea.js'
import { clientFor } from './resolve.js'
import { shapeComment, shapeIssues, shapeList } from './shape.js'
import { deliveryBlock, describeTrigger, markFired, planTriggers } from './triggers.js'
import { pruneWatch, pushDelivery, repoKey, WATERMARK_OVERLAP_MS, watchFile } from './watchstore.js'

/** 单次 Gitea 请求一次取多少条。 */
const PAGE_LIMIT = 50

/** 单轮一个仓库最多翻几页（防病态情况把一轮拖死）。 */
const MAX_PAGES = 10

/** 取数的墙钟预算。 */
const REQUEST_BUDGET_MS = 30 * 1000

/** 单次投递给会话的墙钟上限。 */
const DELIVER_TIMEOUT_MS = 60 * 1000

/** 失败退避的上限（毫秒）。 */
const MAX_BACKOFF_MS = 30 * 60 * 1000

/** 锁文件路径。 */
export function lockFile() {
  return `${watchFile()}.lock`
}

/** 毫秒 → ISO；非法值给 null。 */
function iso(value) {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null
}

/** 取一批里最旧的 `updated_at`（截断时用它当水位）。 */
function oldestUpdatedAt(items) {
  let oldest = null
  for (const item of items) {
    const stamp = Date.parse(item?.updatedAt ?? '')
    if (!Number.isFinite(stamp)) continue
    if (oldest === null || stamp < oldest) oldest = stamp
  }
  return oldest
}

/**
 * 水位 → `since`。往回调一个固定重叠，挡 Gitea 的秒级精度与两机时钟偏差：
 * 重复读到不是问题（账本按 id 去重），漏读才是。
 * @param watermark - 上次成功读到的时刻（ISO）。
 * @returns `since`，或 undefined（首次）。
 */
function sinceFrom(watermark) {
  const parsed = Date.parse(watermark ?? '')
  if (!Number.isFinite(parsed)) return undefined
  return new Date(parsed - WATERMARK_OVERLAP_MS).toISOString()
}

/**
 * 建轮询器。
 * @param options - `ctx` / `store`（`servers.json`）/ `watchStore`（账本）；
 *   另有可注入的 `now` / `setTimer` / `clearTimer` / `random`（探针要控时钟）。
 * @returns 轮询器：`start` / `stop` / `tickNow` / `status`。
 */
export function createWatch({ ctx, store, watchStore, now, setTimer, clearTimer, random }) {
  const clock = now ?? (() => Date.now())
  const armTimer = setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  })
  const disarmTimer = clearTimer ?? ((handle) => clearTimeout(handle))
  const rand = random ?? Math.random

  /** 运行状态（给界面读的只读快照）。 */
  const state = {
    running: false,
    locked: false,
    lastTickAt: null,
    lastReason: null,
    lastError: null,
    consecutiveFailures: 0,
    nextTickAt: null,
    summary: null,
  }
  let timer = null
  /**
   * 两个标记，语义不同，**不能合成一个**：
   * - `loopActive`：后台循环在不在（控制「排不排下一轮」）；
   * - `halted`：宿主已经要求停机（控制「投递循环要不要立刻中断」）。
   *
   * 合成一个 `stopped = true` 初值时，`tickNow()`（界面的「立即检查一次」）会在投递循环
   * 第一行就 `break` —— 什么都不会投，而且看不出原因。
   */
  let loopActive = false
  let halted = false

  /** 服务探测：拿不到就降级，不硬读 `ctx.sessionController`（未提供时会走 strict 路径报错）。 */
  const controller = () => ctx.get('sessionController')

  /**
   * 排下一轮：退避 + 最多 10% 抖动（多个进程别踩同一秒）。
   * @param intervalSeconds - 配置的间隔。
   * @returns 无。
   */
  function scheduleNext(intervalSeconds) {
    if (!loopActive) return
    const base = state.consecutiveFailures > 0
      ? Math.min(intervalSeconds * 1000 * 2 ** state.consecutiveFailures, MAX_BACKOFF_MS)
      : intervalSeconds * 1000
    const delay = Math.round(base * (1 + rand() * 0.1))
    state.nextTickAt = iso(clock() + delay)
    if (timer !== null) disarmTimer(timer)
    timer = armTimer(() => {
      timer = null
      void run('timer')
    }, delay)
  }

  /**
   * 跑一轮并排下一轮。失败细节已经写进状态，这里只负责别让循环断掉。
   * @param reason - `start` / `timer` / `manual`。
   * @returns 本轮摘要。
   */
  async function run(reason) {
    let summary = null
    try {
      summary = await tick(reason)
    } catch {
      // tick 自己已经记了 lastError。
    }
    try {
      const watch = await watchStore.snapshot()
      // 总闸关着就不排下一轮：没有「下次检查」这回事，界面别显示一个不会发生的时刻
      //（重新打开由 `refreshSchedule()` 负责排程）。
      if (watch.global.enabled !== true) {
        if (timer !== null) disarmTimer(timer)
        timer = null
        state.nextTickAt = null
        return summary
      }
      scheduleNext(watch.global.intervalSeconds)
    } catch {
      scheduleNext(120)
    }
    return summary
  }

  /**
   * 跨进程单飞锁：同一个 `$DSH_HOME` 被两个 dsh 进程打开时，只有持锁的那个投递，另一个
   * 只读——否则同一件事会被投两次。
   * @param intervalSeconds - 配置的间隔，用来判心跳是否过期。
   * @returns 是否拿到锁。
   */
  async function acquireLock(intervalSeconds) {
    const file = lockFile()
    const staleMs = Math.max(intervalSeconds * 1000 * 2, 60_000)
    const payload = JSON.stringify({ pid: process.pid, heartbeatAt: iso(clock()) })
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, payload, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        ctx.logger?.warn?.(`gitea-task-issues: cannot create ${lockFile()}: ${messageOf(error)}`)
        return false
      }
    }
    let held
    try {
      held = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return false
    }
    const age = clock() - Date.parse(held?.heartbeatAt ?? '')
    if (!Number.isFinite(age) || age < staleMs) return false
    // 心跳过期：抢过来。这里的「写临时文件再 rename」不是原子抢锁，两个进程同时抢可能
    // 都成功——代价只是这一轮可能各投一次，比「永远没人投」好。真要加强一致得用锁目录，
    // 对这个功能不值得。
    try {
      await writeFile(`${file}.take`, payload, 'utf8')
      await rename(`${file}.take`, file)
      return true
    } catch {
      return false
    }
  }

  /** 续一次心跳（取数期间别被别人当成过期锁抢走）。 */
  async function beatHeartbeat() {
    try {
      await writeFile(lockFile(), JSON.stringify({ pid: process.pid, heartbeatAt: iso(clock()) }), 'utf8')
    } catch {
      // 心跳写不上不影响本轮判定。
    }
  }

  /** 释放锁：只把自己的那把标成过期，不动别人的。 */
  async function releaseLock() {
    let held
    try {
      held = JSON.parse(await readFile(lockFile(), 'utf8'))
    } catch {
      return
    }
    if (held?.pid !== process.pid) return
    try {
      await writeFile(lockFile(), JSON.stringify({ pid: process.pid, heartbeatAt: iso(clock() - 60 * 60 * 1000) }), 'utf8')
    } catch {
      // 忽略：下一轮按过期锁处理。
    }
  }

  /**
   * 数某个工作区里有几个**正在跑 turn 的普通会话**。
   *
   * 用 `sessionController.list()` 一次拿全，它是冷安全的（只读 header 与投影缓存，不会把冷
   * 会话点着）。三条口径：
   * 1. `origin: 'subagent'` 的子代理会话**不算** —— 它是某个会话派出去的下手，算进来等于把
   *    同一件事数两遍，上限会被莫名吃掉；
   * 2. 只数 `running === true`：冷会话、等你输入的会话不占名额；
   * 3. 只数 `cwd === root`：别的项目的会话跟这个工作区无关。
   * @param root - 工作区根。
   * @param signal - 取消信号。
   * @returns 活跃会话数。
   * @throws {BridgeError} 409 —— 宿主没挂 `sessionController`。
   */
  async function activeSessions(root, signal) {
    const service = controller()
    if (service === undefined) throw noSessionController()
    const listed = await service.list({}, signal)
    const items = Array.isArray(listed?.items) ? listed.items : []
    return items.filter((item) => item?.origin === undefined && item?.cwd === root && item?.running === true).length
  }

  /**
   * 新建一个会话并把提示词投进去。
   * @param root - 工作区根。
   * @param config - 这份绑定的配置（取 `agentPreset`）。
   * @param prompt - 提示词正文。
   * @param requestId - 幂等键。
   * @param signal - 取消信号。
   * @returns `{ sessionId }`。
   * @throws {BridgeError} 409/502 —— 宿主没挂服务，或 create 没返回会话 id。
   */
  async function openSession(root, config, prompt, requestId, signal) {
    const service = controller()
    if (service === undefined) throw noSessionController()
    const request = {}
    if (typeof config.agentPreset === 'string' && config.agentPreset !== '') request.agentPreset = config.agentPreset
    // 优先挂到工作区记录上：会话会出现在该项目的会话列表里。只给 cwd 也能跑，但它会落在
    // Ungrouped 下，用户找不着是哪个项目的活。
    const registry = ctx.get('workspaceRegistry')
    let attached = false
    if (registry !== undefined && typeof registry.resolveByPath === 'function') {
      try {
        const workspace = await registry.resolveByPath(root)
        if (workspace !== undefined && typeof workspace.id === 'string') {
          request.workspaceId = workspace.id
          attached = true
        }
      } catch {
        // 工作区记录解析失败不是致命问题：退回只给 cwd。
      }
    }
    if (!attached) request.cwd = root

    const created = await service.create(request)
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new BridgeError(502, 'session-create-failed', 'sessionController.create did not return a session id')
    }
    await service.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    }, signal)
    return { sessionId }
  }

  /** 「宿主不支持」的统一失败。 */
  function noSessionController() {
    return new BridgeError(409, 'session-controller-unavailable', 'this host mounts no sessionController, so automatic assignment cannot open sessions')
  }

  /**
   * 拉「指派给我、本轮有更新」的 issue。服务器级搜索一次覆盖该服务器上所有仓库。
   * @param client - Gitea 客户端。
   * @param since - 增量起点。
   * @param signal - 取消信号。
   * @returns `{ items, truncated }`。
   */
  async function fetchIssues(client, since, signal) {
    const params = { state: 'all', assigned: true, limit: PAGE_LIMIT, type: 'issues' }
    if (since !== undefined) params.since = since
    const { data } = await runOperation(client, 'issue.search', params, signal)
    const raw = Array.isArray(data) ? data : []
    // **必须过瘦身层**：`runOperation` 给的是原始 Gitea JSON，`owner` / `repo` 藏在
    // `repository.owner.login` / `repository.name` 里。直接按 `issue.owner` 过滤会恒空，
    // 于是永远判不出任何触发（纯函数探针喂的是已瘦身对象，抓不到这个）。
    return { items: shapeIssues(raw), truncated: raw.length >= PAGE_LIMIT }
  }

  /**
   * 拉某个仓库的评论增量，一直翻到不足一页或到翻页上限。
   * @param client - Gitea 客户端。
   * @param owner - 仓库 owner。
   * @param repo - 仓库名。
   * @param since - 增量起点。
   * @param signal - 取消信号。
   * @returns `{ items, truncated }`。
   */
  async function fetchComments(client, owner, repo, since, signal) {
    const items = []
    let truncated = false
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = { owner, repo, page, limit: PAGE_LIMIT }
      if (since !== undefined) params.since = since
      const { data } = await runOperation(client, 'comment.listRepo', params, signal)
      const raw = Array.isArray(data) ? data : []
      // 瘦身时带 owner/repo，`shapeComment` 会顺带从 `issue_url` 派生 `issueIndex`——
      // 仓库级评论列表本身不带 issue 编号，派生是唯一来源。
      items.push(...shapeList(raw, (item) => shapeComment(item, { owner, repo })))
      const list = raw
      if (list.length < PAGE_LIMIT) {
        truncated = false
        break
      }
      truncated = page === MAX_PAGES
    }
    return { items, truncated }
  }

  /**
   * 令牌对应用户名（用来识别「自己发的评论」，别把自己叫醒）。失败只给 undefined。
   * @param client - Gitea 客户端。
   * @param signal - 取消信号。
   * @returns 用户名或 undefined。
   */
  async function fetchLogin(client, signal) {
    try {
      const { data } = await runOperation(client, 'server.user', {}, signal)
      return typeof data?.login === 'string' && data.login !== '' ? data.login : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 这一轮要查哪些绑定。账本配置与当前绑定对不上（用户改过绑定）就跳过并说明，
   * 绝不拿旧仓库硬查。
   * @param watch - 账本快照。
   * @param servers - `servers.json` 快照。
   * @returns `{ entries, notes }`。
   */
  function planRoots(watch, servers) {
    const entries = []
    const notes = []
    for (const [root, config] of Object.entries(watch.roots)) {
      if (config.enabled !== true) continue
      const binding = servers.bindings[root]
      if (binding === undefined) {
        notes.push({ root, reason: 'no-binding' })
        continue
      }
      if (config.serverId !== binding.serverId || config.owner !== binding.owner || config.repo !== binding.repo) {
        notes.push({ root, reason: 'binding-changed' })
        continue
      }
      const server = servers.servers.find((item) => item.id === config.serverId)
      if (server === undefined) {
        notes.push({ root, reason: 'unknown-server' })
        continue
      }
      entries.push({ root, config, server, key: repoKey(config) })
    }
    return { entries, notes }
  }

  /**
   * 一轮完整工作。
   * @param reason - `start` / `timer` / `manual`。
   * @returns 本轮摘要。
   */
  async function tick(reason) {
    if (state.running) return { skipped: 'already-running' }
    state.running = true
    state.lastReason = reason
    let summary = null
    let holdsLock = false
    try {
      const watch = await watchStore.snapshot()
      if (watch.global.enabled !== true) {
        summary = { stopped: 'disabled' }
        return summary
      }
      const servers = await store.snapshot()
      const interval = watch.global.intervalSeconds
      holdsLock = await acquireLock(interval)
      state.locked = holdsLock
      if (!holdsLock) {
        summary = { skipped: 'lock-held' }
        return summary
      }

      const { entries, notes } = planRoots(watch, servers)
      const at = clock()

      // ── 取数 ──────────────────────────────────────────────────────────────
      const perServer = new Map()
      for (const entry of entries) {
        const serverId = entry.config.serverId
        if (!perServer.has(serverId)) {
          const signal = AbortSignal.timeout(REQUEST_BUDGET_MS)
          const { client } = await clientFor(ctx, store, serverId, signal)
          const login = await fetchLogin(client, signal)
          // 服务器级搜索的 `since` 取该服务器上所有绑定的**最旧**水位（谁最旧就以谁为准）。
          let since
          for (const other of entries) {
            if (other.config.serverId !== serverId) continue
            const candidate = sinceFrom(watch.watermarks[other.key]?.issues)
            if (candidate === undefined) { since = undefined; break }
            if (since === undefined || Date.parse(candidate) < Date.parse(since)) since = candidate
          }
          const issueResult = await fetchIssues(client, since, signal)
          perServer.set(serverId, { client, login, ...issueResult })
        }
        await beatHeartbeat()
      }

      const perRoot = []
      for (const entry of entries) {
        const { client } = perServer.get(entry.config.serverId)
        const points = watch.watermarks[entry.key] ?? { issues: null, comments: null }
        const signal = AbortSignal.timeout(REQUEST_BUDGET_MS)
        const commentResult = await fetchComments(
          client,
          entry.config.owner,
          entry.config.repo,
          sinceFrom(points.comments),
          signal,
        )
        await beatHeartbeat()
        perRoot.push({
          ...entry,
          commentResult,
          issueCount: perServer.get(entry.config.serverId).items
            .filter((issue) => issue.owner === entry.config.owner && issue.repo === entry.config.repo)
            .length,
        })
      }

      // ── 判触发 + 落账（事实、水位、放弃超期待办）─────────────────────────
      const armed = []
      const blocked = []
      const expired = []
      const nowStamp = clock()
      await watchStore.mutate((draft) => {
        for (const entry of perRoot) {
          const { key, config, commentResult } = entry
          const serverData = perServer.get(config.serverId)
          const facts = {}
          for (const [value, fact] of Object.entries(draft.issues)) {
            if (value.startsWith(`${key}#`)) facts[value] = fact
          }
          const firstRun = draft.watermarks[key] === undefined
          const mine = serverData.items.filter((issue) => issue.owner === config.owner && issue.repo === config.repo)

          const planned = planTriggers({
            prefix: key,
            config,
            facts,
            issues: mine,
            comments: commentResult.items,
            login: serverData.login,
            now: nowStamp,
            firstRun,
          })

          // 事实整表替换（同前缀的先清掉，避免账本里留下已不该管的 issue）。
          for (const value of Object.keys(draft.issues)) {
            if (value.startsWith(`${key}#`)) delete draft.issues[value]
          }
          for (const [value, fact] of Object.entries(planned.facts)) draft.issues[value] = fact

          // 水位：只有**没被截断**才推进到「现在」。截断时只推进到本批最旧的 updated_at，
          // 否则那批更旧的更新会被永久漏掉。
          const stamp = iso(nowStamp)
          draft.watermarks[key] = {
            issues: serverData.truncated ? (iso(oldestUpdatedAt(serverData.items)) ?? points.issues) : stamp,
            comments: commentResult.truncated ? (iso(oldestUpdatedAt(commentResult.items)) ?? points.comments) : stamp,
          }
          if (draft.global.baselinedAt === null) draft.global.baselinedAt = stamp
        }

        // 全局每小时配额：跨绑定一起算。
        const hourAgo = nowStamp - 60 * 60 * 1000
        let used = draft.deliveries.filter((row) => row?.outcome === 'prompted' && Date.parse(row.at ?? '') >= hourAgo).length
        for (const [value, fact] of Object.entries(draft.issues)) {
          if (fact.pending === null) continue
          const owner = entries.find((entry) => value.startsWith(`${entry.key}#`))
          if (owner === undefined) continue
          const config = owner.config
          const index = Number(value.slice(value.lastIndexOf('#') + 1))
          if (!Number.isInteger(index)) continue
          const kinds = ['newAssigned', 'reopened', 'newComment'].filter((kind) => fact.pending[kind] !== null)
          if (kinds.length === 0) {
            fact.pending = null
            continue
          }
          const trigger = {
            key: value,
            index,
            title: fact.title,
            kinds,
            fingerprints: Object.fromEntries(kinds.map((kind) => [kind, fact.pending[kind]])),
            actor: fact.pending.actor ?? null,
          }

          // 等太久：放弃这条待办（也写 fired，否则下一轮还会判出来），记一条 expired。
          const pendingSince = Date.parse(fact.pendingSince ?? '')
          if (Number.isFinite(pendingSince) && nowStamp - pendingSince > config.giveUpAfterHours * 60 * 60 * 1000) {
            markFired(fact, trigger, nowStamp)
            expired.push({ key: value, index, kinds, root: owner.root })
            continue
          }

          const reason = deliveryBlock(fact, config, nowStamp)
          if (reason !== null) {
            blocked.push({ key: value, root: owner.root, index, reason })
            continue
          }
          if (used >= draft.global.maxSessionsPerHour) {
            blocked.push({ key: value, root: owner.root, index, reason: 'hourly' })
            continue
          }
          used += 1
          armed.push({ root: owner.root, config, trigger, factKey: value })
        }
        pruneWatch(draft, nowStamp)
      })

      // ── 投递：先查忙（只读）→ 不忙才写「已投递」→ create + prompt ─────────
      // 演练模式（`global.dryRun`）：**只记账、不投递**，也不推进 `fired`。
      // 它是「开总闸之前先看清楚它打算投什么」的那一步，所以必须完全不动远端状态。
      const dryRun = watch.global.dryRun === true
      const results = expired.map((row) => ({ ...row, outcome: 'expired' }))
      if (dryRun) {
        for (const candidate of armed) {
          results.push({
            key: candidate.factKey,
            root: candidate.root,
            index: candidate.trigger.index,
            title: candidate.trigger.title ?? null,
            kinds: candidate.trigger.kinds,
            outcome: 'dry-run',
          })
        }
      }
      /**
       * 本轮已经投出去几个会话（按 root 分别记）：`list()` 对新会话的 `running` 有滞后，只靠
       * 它数会在同一轮里连开好几个、把上限一次性冲穿。
       */
      const openedThisTick = new Map()
      for (const candidate of armed) {
        if (dryRun || halted) break
        const signal = AbortSignal.timeout(DELIVER_TIMEOUT_MS)
        const row = {
          key: candidate.factKey,
          root: candidate.root,
          index: candidate.trigger.index,
          title: candidate.trigger.title ?? null,
          kinds: candidate.trigger.kinds,
        }
        // `?? 1`：老账本 / 手搓的配置里可能没有这个字段，默认就是旧行为（工作区有人跑就不开）。
        const limit = candidate.config.maxActiveSessions ?? 1
        let active
        try {
          active = await activeSessions(candidate.root, signal)
        } catch (error) {
          results.push({ ...row, outcome: 'failed', code: error?.code ?? 'unknown', message: messageOf(error) })
          break
        }
        const total = active + (openedThisTick.get(candidate.root) ?? 0)
        if (total >= limit) {
          // 到上限：**不写 fired**，待办留着下一轮再试（不是丢弃）。
          results.push({ ...row, outcome: 'capped', reason: 'active', active: total, limit })
          continue
        }

        // write-ahead：先记「已投递」再真的投。崩在中间只会漏投（界面能看出来、可重放），
        // 不会重复投。
        await watchStore.mutate((draft) => {
          const fact = draft.issues[candidate.factKey]
          if (fact === undefined || fact.pending === null) return
          markFired(fact, candidate.trigger, clock())
        })
        try {
          const { sessionId } = await openSession(
            candidate.root,
            candidate.config,
            buildPrompt(candidate.trigger),
            `gti-${randomUUID()}`,
            signal,
          )
          openedThisTick.set(candidate.root, (openedThisTick.get(candidate.root) ?? 0) + 1)
          results.push({ ...row, outcome: 'prompted', sessionId })
        } catch (error) {
          results.push({ ...row, outcome: 'failed', code: error?.code ?? 'unknown', message: messageOf(error) })
        }
      }

      if (results.length > 0) {
        await watchStore.mutate((draft) => {
          for (const row of results) pushDelivery(draft, { at: iso(clock()), ...row })
        })
      }

      const failed = results.filter((row) => row.outcome === 'failed')
      // 失败计数要能**归零**：一直加不清，退避就再也回不到正常间隔。
      state.consecutiveFailures = failed.length > 0 ? state.consecutiveFailures + 1 : 0
      state.lastError = failed.length > 0 ? failed[0] : null
      summary = {
        roots: perRoot.map((entry) => ({
          root: entry.root,
          repo: entry.key,
          firstRun: watch.watermarks[entry.key] === undefined,
          issues: entry.issueCount,
          comments: entry.commentResult.items.length,
        })),
        delivered: results.filter((row) => row.outcome === 'prompted').length,
        // busy 把「到活跃会话上限」也算进来（旧调用方只看这一个数），capped 是其中的细分。
        busy: results.filter((row) => row.outcome === 'busy-skipped' || row.outcome === 'capped').length,
        capped: results.filter((row) => row.outcome === 'capped').length,
        blocked,
        expired: expired.length,
        notes,
        results,
      }
      return summary
    } catch (error) {
      state.consecutiveFailures += 1
      state.lastError = { code: error?.code ?? 'unknown', message: messageOf(error), at: iso(clock()) }
      ctx.logger?.warn?.(`gitea-task-issues: watch tick failed: ${messageOf(error)}`)
      throw error
    } finally {
      state.running = false
      state.lastTickAt = iso(clock())
      if (summary !== null) state.summary = summary
      if (holdsLock) await releaseLock()
    }
  }

  /**
   * 提示词：沿用「发送到 DSH」那套措辞（`请处理 Gitea issue #12：标题`），只多一行
   * 「为什么叫醒你」。**不带 URL** —— 会话本身就跑在那个工作区里，仓库由绑定解析。
   * @param trigger - 待办触发。
   * @returns 提示词正文。
   */
  function buildPrompt(trigger) {
    const title = typeof trigger.title === 'string' ? trigger.title : ''
    return `请处理 Gitea issue #${trigger.index}：${title}\n\n${describeTrigger(trigger)}`
  }

  return {
    /** 启动轮询（插件 apply 时调一次）。 */
    start() {
      if (loopActive) return
      loopActive = true
      halted = false
      void run('start')
    },
    /** 停止轮询（插件卸载时由 effect 撤销）。 */
    stop() {
      loopActive = false
      halted = true
      if (timer !== null) disarmTimer(timer)
      timer = null
      state.nextTickAt = null
    },
    /**
     * 手动跑一轮（界面的「立即检查一次」）。
     * @returns 本轮摘要。
     */
    async tickNow() {
      return run('manual')
    },
    /**
     * 配置变了就按新间隔重排下一轮，并把失败退避清零。
     *
     * 为什么需要它：定时器在 **arm 的那一刻**就把延迟算死了，而 `watch.set` 只写账本 —— 用户把
     * 间隔从 20 分钟改成 60 秒，也得等那个旧定时器烧完才生效（界面的「下次检查」倒计时会如实
     * 显示这个陈旧值，看起来就是「我设的 60s 没生效」）。显式保存配置是一次人工动作，顺手把
     * 退避清零也合理：用户多半刚修好令牌 / 改了绑定，没必要继续等退避。
     *
     * 总闸关着时**不排下一轮**并把 `nextTickAt` 清空 —— 关掉就是没有下一次，别留一个吓人的
     * 时刻在界面上。
     * @returns 无。
     */
    async refreshSchedule() {
      state.consecutiveFailures = 0
      let watch
      try {
        watch = await watchStore.snapshot()
      } catch {
        return
      }
      if (!loopActive) return
      if (watch.global.enabled !== true) {
        if (timer !== null) disarmTimer(timer)
        timer = null
        state.nextTickAt = null
        return
      }
      scheduleNext(watch.global.intervalSeconds)
    },

    /**
     * 运行状态快照（给界面）。
     * @returns 状态。
     */
    status() {
      return {
        running: state.running,
        locked: state.locked,
        serviceAvailable: controller() !== undefined,
        lastTickAt: state.lastTickAt,
        lastReason: state.lastReason,
        lastError: state.lastError,
        consecutiveFailures: state.consecutiveFailures,
        nextTickAt: state.nextTickAt,
        summary: state.summary,
        lockFile: lockFile(),
      }
    },
  }
}
