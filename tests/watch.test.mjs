/**
 * 自动分配的**投递路径探针**：假 Gitea + 假会话服务 + 注入时钟。
 *
 * `tests/triggers.test.mjs` 管「该不该触发」（纯函数，不碰 I/O）；这一份只管**副作用**：
 * 真的去打了哪个 Gitea 路径、会话服务被怎么调用、账本落成什么样、失败有没有留下痕迹。
 *
 * 为什么这些必须单独测：这层最容易出的不是逻辑错，而是**接线错**——
 *   1. `runOperation` 给的是原始 Gitea JSON，忘了过瘦身层就永远判不出触发；
 *   2. 工作区忙却先写了「已投递」，待办就永久丢了；
 *   3. 一次投递重复发两遍 prompt。
 * 这三条纯函数都测不出来，只能靠真跑一遍。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { ConfigStore } from '../lib/store.js'
import { createWatch, lockFile } from '../lib/watch.js'
import { coerceWatch, emptyWatch } from '../lib/watchstore.js'
import { startMockGitea, TEST_TOKEN } from './mock-gitea.mjs'

/** 本文件所有的临时目录。 */
const temporary = []
/** 本文件起过的假 Gitea。 */
const servers = []
/** 真实的 DSH_HOME，结束后还原。 */
const REAL_DSH_HOME = process.env.DSH_HOME

/**
 * 造一个临时 DSH 数据根，并把 `$DSH_HOME` 指过去。
 * @returns 数据根路径。
 */
async function useFreshHome() {
  const directory = await mkdtemp(join(tmpdir(), 'gti-watch-'))
  temporary.push(directory)
  await mkdir(join(directory, 'gitea-task-issues'), { recursive: true })
  process.env.DSH_HOME = directory
  return directory
}

/** 起一个假 Gitea 并登记，测试结束统一关。 */
async function useGitea() {
  const server = await startMockGitea()
  servers.push(server)
  return server
}

/**
 * 建一套被轮询器依赖的东西：两个 store + 轮询器本身。
 * @param options - `server` / `root` / `config` / `global` / `service`。
 * @returns `{ watch, watchStore, store, calls, ctx, advance }`。
 */
async function makeHarness(options) {
  const { server, root, global = {}, config = {}, service } = options
  const home = await useFreshHome()

  /** `servers.json`：一台服务器 + 一条绑定。 */
  const store = new ConfigStore(join(home, 'gitea-task-issues', 'servers.json'), { info() {}, warn() {} })
  await store.mutate((draft) => {
    draft.servers.push({ id: 'srv-test', name: 'test', baseUrl: server.url, tokenEnv: null })
    draft.defaultServerId = 'srv-test'
    draft.bindings[root] = { serverId: 'srv-test', owner: 'dongasai', repo: 'mylike', updatedAt: new Date().toISOString() }
  })

  /** 账本。 */
  const watchStore = new ConfigStore(
    join(home, 'gitea-task-issues', 'watch.json'),
    { info() {}, warn() {} },
    { coerce: coerceWatch, empty: emptyWatch },
  )
  await watchStore.mutate((draft) => {
    // `enabled` 默认开（多数用例要它开），但**允许用例覆盖**——否则「总闸关着」那条
    // 用例会被这里的默认值吃掉，测了个寂寞。
    draft.global = { ...draft.global, enabled: true, ...global }
    draft.roots[root] = {
      enabled: true,
      serverId: 'srv-test',
      owner: 'dongasai',
      repo: 'mylike',
      triggers: { newAssigned: true, reopened: true, newComment: true },
      agentPreset: null,
      cooldownSeconds: 0,
      maxPerIssuePerDay: 5,
      giveUpAfterHours: 24,
      ...config,
    }
  })

  // 令牌走环境变量这一路（`resolveToken` 的第二条路），不碰 credentials 服务。
  const tokenEnv = 'GTI_TEST_TOKEN'
  process.env[tokenEnv] = TEST_TOKEN
  await store.mutate((draft) => { draft.servers[0].tokenEnv = tokenEnv })

  /** 会话服务的调用记录。 */
  const calls = []
  /** 当前 `list()` 返回的会话（控制「忙/闲」）。 */
  let sessions = []
  /** `create` 的返回值。 */
  let createError = null
  /** `prompt` 的返回值。 */
  let promptError = null

  const sessionController = {
    async list(request, signal) {
      calls.push({ method: 'list' })
      assert.ok(signal !== undefined, 'list() 必须带 AbortSignal')
      return { items: sessions }
    },
    async create(request) {
      calls.push({ method: 'create', request })
      if (createError !== null) throw createError
      return { sessionId: 'session-new-1' }
    },
    async prompt(request, signal) {
      calls.push({ method: 'prompt', request })
      assert.ok(signal !== undefined, 'prompt() 必须带 AbortSignal')
      if (promptError !== null) throw promptError
      return { accepted: true }
    },
  }

  const workspaceRegistry = {
    async resolveByPath(path) {
      calls.push({ method: 'resolveByPath', path })
      return path === root ? { id: 'ws-1', path } : undefined
    },
  }

  /** 假 ctx：只实现轮询器用到的那几个口。 */
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { fn() },
    get(name) {
      if (name === 'sessionController') return service === false ? undefined : sessionController
      if (name === 'workspaceRegistry') return service === false ? undefined : workspaceRegistry
      return undefined
    },
  }

  /** 可推进的时钟。 */
  const clock = { ms: Date.parse('2026-10-17T00:00:00.000Z') }
  const watch = createWatch({
    ctx,
    store,
    watchStore,
    now: () => clock.ms,
    setTimer: () => 0,
    clearTimer: () => {},
    random: () => 0,
  })

  return {
    watch,
    watchStore,
    store,
    ctx,
    calls,
    clock,
    /** 改 `list()` 的返回（模拟某个工作区在跑 turn）。 */
    setSessions: (next) => { sessions = next },
    /** 让 `create` 抛错。 */
    failCreate: (error) => { createError = error },
    /** 让 `prompt` 抛错。 */
    failPrompt: (error) => { promptError = error },
  }
}

/** 往假 Gitea 里塞一条指派给 tester 的 issue。 */
function seedIssue(server, index, overrides = {}) {
  const now = new Date().toISOString()
  const issue = {
    id: 1000 + index,
    number: index,
    title: `第 ${index} 条`,
    body: '',
    state: 'open',
    labels: [],
    assignees: [{ login: 'tester', full_name: 'Tester', avatar_url: null }],
    milestone: null,
    due_date: null,
    comments: 0,
    created_at: now,
    updated_at: now,
    closed_at: null,
    html_url: `http://localhost/dongasai/mylike/issues/${index}`,
    user: { login: 'tester', full_name: 'Tester', avatar_url: null },
    repository: { name: 'mylike', owner: { login: 'dongasai' } },
    ...overrides,
  }
  issue.owner = 'dongasai'
  server.state.issues.push(issue)
  return issue
}

/** 往假 Gitea 里塞一条评论（带 issue_url，模拟 Gitea 真实字段）。 */
function seedComment(server, id, index, login = 'alice') {
  const now = new Date().toISOString()
  server.state.comments.push({
    id,
    body: '评论正文',
    user: { login, full_name: login, avatar_url: null },
    created_at: now,
    updated_at: now,
    html_url: `http://localhost/dongasai/mylike/issues/${index}#issuecomment-${id}`,
    issue_url: `http://localhost/api/v1/repos/dongasai/mylike/issues/${index}`,
    issue_number: index,
  })
  return id
}

before(() => {
  process.env.DSH_HOME = REAL_DSH_HOME ?? join(tmpdir(), 'gti-watch-unused')
})

after(async () => {
  for (const server of servers) await server.close()
  for (const directory of temporary) await rm(directory, { recursive: true, force: true })
  if (REAL_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = REAL_DSH_HOME
})

// ── 基线 ────────────────────────────────────────────────────────────────────

test('首次 tick 只建基线：不查会话、不建会话、不投递', async () => {
  const server = await useGitea()
  seedIssue(server, 1)
  seedComment(server, 11, 1, 'alice')
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })

  await harness.watch.tickNow()

  const touched = harness.calls.filter((call) => call.method !== 'resolveByPath')
  assert.deepEqual(touched, [], '首次 tick 不该碰会话服务')
  assert.equal(harness.calls.some((call) => call.method === 'create'), false)

  const ledger = await harness.watchStore.snapshot()
  assert.ok(ledger.global.baselinedAt !== null, '基线时刻要记下来')
  const key = 'srv-test/dongasai/mylike'
  assert.ok(ledger.watermarks[key] !== undefined, '水位要推进')
  // 基线：issue 与评论两侧都要标成「已处理」，否则第二轮会把历史全投一遍。
  const fact = ledger.issues[`${key}#1`]
  assert.equal(fact.fired.newAssigned, true)
  assert.equal(fact.fired.commentId, 11)
  assert.equal(fact.pending, null)
  assert.equal(ledger.deliveries.length, 0)
})

// ── 正常投递 ────────────────────────────────────────────────────────────────

test('新指派 + 工作区空闲：建会话并把任务投进去', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  await harness.watch.tickNow()

  // 基线之后来一条新的
  seedIssue(server, 2)
  harness.clock.ms += 60_000
  const summary = await harness.watch.tickNow()

  assert.equal(summary.delivered, 1)
  const create = harness.calls.find((call) => call.method === 'create')
  assert.ok(create !== undefined, '必须调用 create')
  // 优先挂到工作区记录上：会话会出现在该项目的列表里。
  assert.deepEqual(create.request, { workspaceId: 'ws-1' })

  const prompt = harness.calls.find((call) => call.method === 'prompt')
  assert.ok(prompt !== undefined, '必须调用 prompt')
  assert.equal(prompt.request.sessionId, 'session-new-1')
  assert.equal(prompt.request.mode, 'queue')
  assert.equal(
    prompt.request.content[0].text,
    '请处理 Gitea issue #2：第 2 条\n\n（自动分配：刚被指派给你）',
  )
  assert.match(prompt.request.requestId, /^gti-/)

  const ledger = await harness.watchStore.snapshot()
  assert.equal(ledger.deliveries.at(-1).outcome, 'prompted')
  assert.equal(ledger.deliveries.at(-1).index, 2)
})

test('Gitea 真的收到了 assigned / since 参数（接线回归）', async () => {
  const server = await useGitea()
  seedIssue(server, 1)
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  await harness.watch.tickNow()
  harness.clock.ms += 60_000
  await harness.watch.tickNow()

  const search = server.requests.filter((item) => item.path === '/api/v1/repos/issues/search')
  assert.ok(search.length >= 2)
  assert.equal(search.at(-1).query.assigned, 'true')
  assert.equal(search.at(-1).query.state, 'all')
  assert.equal(search.at(-1).query.type, 'issues')
  // 第二轮开始带 since（水位回退一个重叠量）。
  assert.ok(search.at(-1).query.since !== undefined, '第二轮必须带 since')

  const comments = server.requests.filter((item) => item.path === '/api/v1/repos/dongasai/mylike/issues/comments')
  assert.ok(comments.length >= 2)
  assert.equal(comments.at(-1).query.limit, '50')
})

test('新评论触发：提示词带上是谁评论的', async () => {
  const server = await useGitea()
  seedIssue(server, 3)
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  await harness.watch.tickNow()

  seedComment(server, 21, 3, 'alice')
  harness.clock.ms += 60_000
  const summary = await harness.watch.tickNow()

  assert.equal(summary.delivered, 1)
  const prompt = harness.calls.find((call) => call.method === 'prompt')
  assert.equal(
    prompt.request.content[0].text,
    '请处理 Gitea issue #3：第 3 条\n\n（自动分配：有新评论 by @alice）',
  )
})

test('自己发的评论不触发（防自激）', async () => {
  const server = await useGitea()
  seedIssue(server, 4)
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  await harness.watch.tickNow()

  // 令牌用户是 tester：自己评论不该把自己叫醒。
  seedComment(server, 31, 4, 'tester')
  harness.clock.ms += 60_000
  const summary = await harness.watch.tickNow()

  assert.equal(summary.delivered, 0)
  assert.equal(harness.calls.some((call) => call.method === 'create'), false)
})

// ── 忙与幂等 ────────────────────────────────────────────────────────────────

test('工作区忙：不建会话、不写已投递，下一轮空闲时再投', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  await harness.watch.tickNow()

  seedIssue(server, 2)
  harness.setSessions([{ sessionId: 'session-busy', cwd: '/data/ai/dsh/gitea_task_issues', running: true }])
  harness.clock.ms += 60_000
  const busy = await harness.watch.tickNow()

  assert.equal(busy.delivered, 0)
  assert.equal(busy.busy, 1)
  assert.equal(harness.calls.some((call) => call.method === 'create'), false)
  const ledger = await harness.watchStore.snapshot()
  assert.equal(ledger.deliveries.at(-1).outcome, 'busy-skipped')
  // 关键：待办还在，否则这条任务永久丢了。
  assert.notEqual(ledger.issues['srv-test/dongasai/mylike#2'].pending, null)

  // 空闲了：下一轮补投。
  harness.setSessions([])
  harness.clock.ms += 60_000
  const later = await harness.watch.tickNow()
  assert.equal(later.delivered, 1)
  const ledger2 = await harness.watchStore.snapshot()
  assert.equal(ledger2.issues['srv-test/dongasai/mylike#2'].pending, null)
})

test('子代理会话不算「工作区在忙」', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  await harness.watch.tickNow()

  seedIssue(server, 2)
  harness.setSessions([{ sessionId: 'session-sub', cwd: '/data/ai/dsh/gitea_task_issues', running: true, origin: 'subagent' }])
  harness.clock.ms += 60_000
  const summary = await harness.watch.tickNow()
  assert.equal(summary.delivered, 1, 'subagent 会话不该挡住自动分配')
})

test('同一件事只投一次：第二轮不再触发', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  await harness.watch.tickNow()

  seedIssue(server, 2)
  harness.clock.ms += 60_000
  assert.equal((await harness.watch.tickNow()).delivered, 1)
  const promptsAfter = harness.calls.filter((call) => call.method === 'prompt').length

  // 水位重叠会让这条 issue 在下一轮被重新读到——必须靠账本去重。
  harness.clock.ms += 60_000
  const again = await harness.watch.tickNow()
  assert.equal(again.delivered, 0)
  assert.equal(harness.calls.filter((call) => call.method === 'prompt').length, promptsAfter)
})

test('冷却期内的新评论不重复开会话', async () => {
  const server = await useGitea()
  seedIssue(server, 5)
  const harness = await makeHarness({
    server,
    root: '/data/ai/dsh/gitea_task_issues',
    config: { cooldownSeconds: 600, maxPerIssuePerDay: 5 },
  })
  await harness.watch.tickNow()

  seedComment(server, 41, 5, 'alice')
  harness.clock.ms += 60_000
  assert.equal((await harness.watch.tickNow()).delivered, 1)

  seedComment(server, 42, 5, 'bob')
  harness.clock.ms += 60_000
  const cooled = await harness.watch.tickNow()
  assert.equal(cooled.delivered, 0)
  assert.deepEqual(cooled.blocked.map((row) => row.reason), ['cooldown'])
  // 冷却挡住的待办要留着（不是丢弃），否则这条评论永远没人处理。
  const ledger = await harness.watchStore.snapshot()
  assert.notEqual(ledger.issues['srv-test/dongasai/mylike#5'].pending, null)
})

test('每小时配额挡住跨 issue 的投递', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({
    server,
    root: '/data/ai/dsh/gitea_task_issues',
    global: { maxSessionsPerHour: 1 },
  })
  await harness.watch.tickNow()

  seedIssue(server, 2)
  seedIssue(server, 3)
  harness.clock.ms += 60_000
  const summary = await harness.watch.tickNow()
  assert.equal(summary.delivered, 1)
  assert.deepEqual(summary.blocked.map((row) => row.reason), ['hourly'])
})

// ── 失败与降级 ──────────────────────────────────────────────────────────────

test('create 失败：记 failed、不留 pending（宁可漏不可重），下次不自动重试', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  await harness.watch.tickNow()

  seedIssue(server, 2)
  harness.failCreate(new Error('boom'))
  harness.clock.ms += 60_000
  const summary = await harness.watch.tickNow()

  assert.equal(summary.delivered, 0)
  const failed = summary.results.find((row) => row.outcome === 'failed')
  assert.ok(failed !== undefined)
  assert.equal(failed.message, 'boom')

  const ledger = await harness.watchStore.snapshot()
  // write-ahead：已经标成「已投递」，所以下一轮不会再自动重试（要靠界面重放）。
  assert.equal(ledger.issues['srv-test/dongasai/mylike#2'].pending, null)
  assert.equal(ledger.issues['srv-test/dongasai/mylike#2'].fired.newAssigned, true)
})

test('宿主没挂 sessionController：不抛错、不投递，状态里说明不可用', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues', service: false })
  await harness.watch.tickNow()

  seedIssue(server, 2)
  harness.clock.ms += 60_000
  const summary = await harness.watch.tickNow()

  assert.equal(summary.delivered, 0)
  assert.equal(summary.results[0].outcome, 'failed')
  assert.equal(summary.results[0].code, 'session-controller-unavailable')
  assert.equal(harness.watch.status().serviceAvailable, false)
  // 待办还在：服务装上之后还能补投。
  const ledger = await harness.watchStore.snapshot()
  assert.notEqual(ledger.issues['srv-test/dongasai/mylike#2'].pending, null)
})

test('总闸关着：一次 Gitea 请求都不发', async () => {
  const server = await useGitea()
  seedIssue(server, 1)
  const harness = await makeHarness({
    server,
    root: '/data/ai/dsh/gitea_task_issues',
    global: { enabled: false },
  })
  const summary = await harness.watch.tickNow()
  assert.deepEqual(summary, { stopped: 'disabled' })
  assert.equal(server.requests.length, 0)
})

// ── 多工作区 / 锁 ───────────────────────────────────────────────────────────

test('两个工作区绑同一仓库：只投一次', async () => {
  const server = await useGitea()
  const rootA = '/data/ai/dsh/gitea_task_issues'
  const rootB = '/data/ai/work/other'

  // 手工造一份「两个 root 同仓库」的账本。
  const home = await useFreshHome()
  const store = new ConfigStore(join(home, 'gitea-task-issues', 'servers.json'), { info() {}, warn() {} })
  await store.mutate((draft) => {
    draft.servers.push({ id: 'srv-test', name: 'test', baseUrl: server.url, tokenEnv: 'GTI_TEST_TOKEN_2' })
    draft.defaultServerId = 'srv-test'
    for (const root of [rootA, rootB]) {
      draft.bindings[root] = { serverId: 'srv-test', owner: 'dongasai', repo: 'mylike', updatedAt: new Date().toISOString() }
    }
  })
  process.env.GTI_TEST_TOKEN_2 = TEST_TOKEN

  const watchStore = new ConfigStore(
    join(home, 'gitea-task-issues', 'watch.json'),
    { info() {}, warn() {} },
    { coerce: coerceWatch, empty: emptyWatch },
  )
  await watchStore.mutate((draft) => {
    draft.global = { ...draft.global, enabled: true }
    for (const root of [rootA, rootB]) {
      draft.roots[root] = {
        enabled: true,
        serverId: 'srv-test',
        owner: 'dongasai',
        repo: 'mylike',
        triggers: { newAssigned: true, reopened: true, newComment: true },
        agentPreset: null,
        cooldownSeconds: 0,
        maxPerIssuePerDay: 5,
        giveUpAfterHours: 24,
      }
    }
  })

  const calls = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { fn() },
    get(name) {
      if (name === 'sessionController') {
        return {
          async list() { calls.push({ method: 'list' }); return { items: [] } },
          async create() { calls.push({ method: 'create' }); return { sessionId: 'session-shared' } },
          async prompt() { calls.push({ method: 'prompt' }); return { accepted: true } },
        }
      }
      if (name === 'workspaceRegistry') return undefined
      return undefined
    },
  }
  const clock = { ms: Date.parse('2026-10-17T00:00:00.000Z') }
  const watch = createWatch({ ctx, store, watchStore, now: () => clock.ms, setTimer: () => 0, clearTimer: () => {}, random: () => 0 })

  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  await watch.tickNow()
  seedIssue(server, 2)
  clock.ms += 60_000
  const summary = await watch.tickNow()

  assert.equal(summary.delivered, 1, '同一仓库的两条绑定只能投一次')
  assert.equal(calls.filter((call) => call.method === 'create').length, 1)
})

test('单飞锁：锁被别人占着时本轮只读不投', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({
    server,
    root: '/data/ai/dsh/gitea_task_issues',
    global: { intervalSeconds: 60 },
  })
  // 另一个进程的锁：心跳是「刚刚」，不算过期。
  const { writeFile } = await import('node:fs/promises')
  await writeFile(lockFile(), JSON.stringify({ pid: 999999, heartbeatAt: new Date(harness.clock.ms).toISOString() }), 'utf8')

  const summary = await harness.watch.tickNow()
  assert.deepEqual(summary, { skipped: 'lock-held' })
  assert.equal(harness.watch.status().locked, false)
  assert.equal(harness.calls.some((call) => call.method === 'create'), false)
})

test('锁文件过期可以被抢走', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({
    server,
    root: '/data/ai/dsh/gitea_task_issues',
    global: { intervalSeconds: 60 },
  })
  const { writeFile } = await import('node:fs/promises')
  // 心跳停在两小时前：按 2×interval（下限 60s）判为过期。
  await writeFile(lockFile(), JSON.stringify({ pid: 999999, heartbeatAt: new Date(harness.clock.ms - 2 * 60 * 60 * 1000).toISOString() }), 'utf8')

  const summary = await harness.watch.tickNow()
  assert.notDeepEqual(summary, { stopped: 'disabled' })
  assert.equal(harness.watch.status().locked, true)
})

// ── 重放 ────────────────────────────────────────────────────────────────────

test('重放：把已投递的标记重新变成待办，不依赖增量查询', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  await harness.watch.tickNow()

  seedIssue(server, 2)
  harness.clock.ms += 60_000
  assert.equal((await harness.watch.tickNow()).delivered, 1)

  // 手工把待办塞回去（等价于桥上 `watch.requeue` 干的事）。
  await harness.watchStore.mutate((draft) => {
    const fact = draft.issues['srv-test/dongasai/mylike#2']
    fact.pending = { newAssigned: 'n-replay', reopened: null, newComment: null, actor: null }
    fact.pendingSince = new Date(harness.clock.ms).toISOString()
  })

  // 注意：不再改 issue 的 updated_at —— 重放不依赖它重新出现在增量里。
  harness.clock.ms += 60_000
  const replay = await harness.watch.tickNow()
  assert.equal(replay.delivered, 1)
  assert.equal(harness.calls.filter((call) => call.method === 'prompt').length, 2)
})

// ── 退避 ────────────────────────────────────────────────────────────────────

test('连续失败走退避，成功一次后回到正常间隔', async () => {
  const server = await useGitea()
  const harness = await makeHarness({ server, root: '/data/ai/dsh/gitea_task_issues' })
  // 用一个必然失败的服务器地址触发取数失败。
  await harness.store.mutate((draft) => { draft.servers[0].baseUrl = 'http://127.0.0.1:1' })

  await harness.watch.tickNow()
  assert.equal(harness.watch.status().consecutiveFailures, 1)
  assert.ok(harness.watch.status().lastError !== null)

  await harness.watch.tickNow()
  assert.equal(harness.watch.status().consecutiveFailures, 2)

  // 修好之后归零。
  await harness.store.mutate((draft) => { draft.servers[0].baseUrl = server.url })
  await harness.watch.tickNow()
  assert.equal(harness.watch.status().consecutiveFailures, 0)
})

test('演练模式：只记账、不建会话、不推进已投递标记', async () => {
  const server = await useGitea()
  seedIssue(server, 1, { updated_at: '2026-10-16T00:00:00.000Z' })
  const harness = await makeHarness({
    server,
    root: '/data/ai/dsh/gitea_task_issues',
    global: { dryRun: true },
  })
  await harness.watch.tickNow()

  seedIssue(server, 2)
  harness.clock.ms += 60_000
  const summary = await harness.watch.tickNow()

  // 一条都没真投，但记了一条 dry-run。
  assert.equal(summary.delivered, 0)
  assert.equal(harness.calls.some((call) => call.method === 'create'), false, '演练不许建会话')
  assert.equal(harness.calls.some((call) => call.method === 'prompt'), false, '演练不许投递')

  const ledger = await harness.watchStore.snapshot()
  assert.equal(ledger.deliveries.at(-1).outcome, 'dry-run')
  // 关键：待办还在（正是「先看清楚它打算投什么」），而 `fired` 没被推进。
  assert.notEqual(ledger.issues['srv-test/dongasai/mylike#2'].pending, null)
  assert.equal(ledger.issues['srv-test/dongasai/mylike#2'].fired.newAssigned, false)

  // 关掉演练：下一轮真的投出去。
  await harness.watchStore.mutate((draft) => { draft.global.dryRun = false })
  harness.clock.ms += 60_000
  const real = await harness.watch.tickNow()
  assert.equal(real.delivered, 1)
})
