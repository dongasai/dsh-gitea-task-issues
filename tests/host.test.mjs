/**
 * Host 半边的探针：**假 ctx + 假 Gitea + 真 HTTP**。
 *
 * 覆盖三层：
 * 1. 纯函数（git remote 解析、地址规范化、瘦身、标签名→id）；
 * 2. 配置存储（原子写、revision 乐观并发、坏文件留档、并发串行）；
 * 3. 端到端（`apply()` 注册 → 桥接路由 → 假 Gitea → 瘦身后的应答），以及七个模型工具。
 *
 * 关键一条：工具出参用**注册表自己的校验器**（`dsh-tools` 的 `validateJsonSchemaValue`）
 * 验一遍。`output.schema` 不合规在真机上会变成 `INVALID_TOOL_OUTPUT`，本地必须能提前抓到。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { apply } from '../index.js'
import { parseGitRemotes, parseGitRemoteUrl, matchServerByHost } from '../lib/detect.js'
import { BridgeError } from '../lib/errors.js'
import { resolveLabelIds } from '../lib/gitea.js'
import { ConfigStore, emptyState, makeServerId, normalizeBaseUrl, parseRepoSpec, storeFile } from '../lib/store.js'
import { shapeComment, shapeIssue, shapeRepo, shapeTime } from '../lib/shape.js'
import { startMockGitea, TEST_TOKEN } from './mock-gitea.mjs'

/** 假会话 id。 */
const SESSION_ID = 'session-test'

/** 本次运行的所有临时目录，结束后删。 */
const temporary = []

/**
 * 真实的 `$DSH_HOME`：`before` 会把它指到临时目录（被测代码要写配置），
 * 但测试自己要用**真实**的那份去按路径加载官方包，所以在模块加载时就记下来。
 */
const REAL_DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')

/** 建一个临时目录。 */
async function makeTemporary(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(directory)
  return directory
}

/**
 * 按绝对路径 import 官方包：本仓库不在 profile 的 node_modules 树里，裸包名解析不到，
 * 但测试想用**注册表自己的**校验器，所以显式按路径加载。
 * @param relative - `node_modules` 下的相对路径。
 * @returns 模块命名空间。
 */
async function dshModule(relative) {
  const path = join(REAL_DSH_HOME, 'profiles/node_modules', relative)
  return import(pathToFileURL(path).href)
}

/** 假凭据中心：只实现插件用到的那几个方法。 */
function makeCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) {
      return records.get(key)
    },
    async describeRecord(key) {
      return { configured: records.has(key), kind: records.get(key)?.kind, writable: true }
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) {
      records.delete(key)
    },
    async listRecords() {
      return [...records.keys()].map((key) => ({ key, kind: records.get(key).kind }))
    },
  }
}

/** 假 Host 上下文。 */
function makeCtx({ cwd, credentials, rejection }) {
  const tools = []
  const routes = []
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return () => {}
    },
    get(service) {
      if (service === 'credentials') return credentials
      if (service === 'sandboxPolicy') return { workspaceRoot: cwd }
      return undefined
    },
    connection: { requestRejection: () => rejection },
    sessions: { get: (id) => (id === SESSION_ID ? { header: { cwd } } : undefined) },
    webServer: { register: (spec) => { routes.push(spec); return () => {} } },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
  }
  return { ctx, tools, routes, effects }
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test('parseGitRemoteUrl 认 https / scp / ssh / 子路径', () => {
  assert.deepEqual(parseGitRemoteUrl('https://tea.2sxo.com/dongasai/mylike.git'), {
    host: 'tea.2sxo.com', hostname: 'tea.2sxo.com', path: 'dongasai/mylike', owner: 'dongasai', repo: 'mylike',
  })
  assert.deepEqual(parseGitRemoteUrl('git@tea.2sxo.com:dongasai/mylike.git'), {
    host: 'tea.2sxo.com', hostname: 'tea.2sxo.com', path: 'dongasai/mylike', owner: 'dongasai', repo: 'mylike',
  })
  assert.equal(parseGitRemoteUrl('ssh://git@tea.2sxo.com:2222/g/p/r.git')?.repo, 'r')
  assert.equal(parseGitRemoteUrl('https://tea.2sxo.com/a/b/c.git')?.owner, 'a/b')
  assert.equal(parseGitRemoteUrl('http://127.0.0.1:3000/o/r')?.host, '127.0.0.1:3000')
  assert.equal(parseGitRemoteUrl('not a url'), undefined)
  assert.equal(parseGitRemoteUrl('https://tea.2sxo.com/onlyowner'), undefined)
})

test('parseGitRemotes 只取 [remote] 段里的 url，origin 优先', () => {
  const text = [
    '[core]',
    '  bare = false',
    '[remote "upstream"]',
    '  url = https://example.com/up/repo.git',
    '[remote "origin"]',
    '  url = git@tea.2sxo.com:dongasai/mylike.git',
    '  fetch = +refs/heads/*:refs/remotes/origin/*',
  ].join('\n')
  const remotes = parseGitRemotes(text)
  assert.equal(remotes.get('origin'), 'git@tea.2sxo.com:dongasai/mylike.git')
  assert.equal(remotes.get('upstream'), 'https://example.com/up/repo.git')
  assert.equal(parseGitRemotes('[core]\n  bare = true\n').size, 0)
})

test('normalizeBaseUrl 补协议、去尾斜杠、保留子路径、拒非 http', () => {
  assert.equal(normalizeBaseUrl('tea.2sxo.com'), 'https://tea.2sxo.com')
  assert.equal(normalizeBaseUrl('https://tea.2sxo.com/'), 'https://tea.2sxo.com')
  assert.equal(normalizeBaseUrl('http://host:3000/gitea///'), 'http://host:3000/gitea')
  assert.equal(normalizeBaseUrl('https://host/x?a=1#b'), 'https://host/x')
  assert.throws(() => normalizeBaseUrl('ftp://host'), BridgeError)
  assert.throws(() => normalizeBaseUrl(''), BridgeError)
})

test('parseRepoSpec 与 makeServerId 的形状约束', () => {
  assert.deepEqual(parseRepoSpec('dongasai/mylike'), { owner: 'dongasai', repo: 'mylike' })
  assert.deepEqual(parseRepoSpec('/group/sub/repo/'), { owner: 'group/sub', repo: 'repo' })
  assert.throws(() => parseRepoSpec('mylike'), BridgeError)
  const id = makeServerId(new Set())
  assert.match(id, /^[a-z][a-z0-9-]*$/, '服务器 id 必须满足 credential key 的段语法')
})

test('shapeIssue 认 number（不是 id）、拍平 owner/repo、pin_order 判置顶', () => {
  const issue = shapeIssue({
    id: 999,
    number: 12,
    title: 't',
    state: 'open',
    labels: [{ id: 1, name: 'bug', color: 'fff' }],
    assignees: [{ login: 'a' }],
    repository: { name: 'mylike', owner: { login: 'dongasai' } },
    pin_order: 0,
    pull_request: {},
  })
  assert.equal(issue.index, 12)
  assert.equal(issue.owner, 'dongasai')
  assert.equal(issue.repo, 'mylike')
  assert.equal(issue.labels[0].name, 'bug')
  assert.equal(issue.assignees[0].login, 'a')
  assert.equal(issue.pinned, true, 'pin_order=0 也是置顶')
  assert.equal(issue.isPull, true)
  assert.equal(shapeIssue({ id: 1, title: 'no number' }), undefined)
})

test('shapeComment / shapeAsset / shapeTime / shapeRepo 的兜底', () => {
  assert.equal(shapeComment({ id: 3, body: 'x' }).body, 'x')
  assert.equal(shapeComment({ body: 'no id' }), undefined)
  assert.equal(shapeTime({ id: 1, time: 60, user_name: 'a' }).time, 60)
  assert.equal(shapeRepo({ name: 'r', owner: { login: 'o' } }, 'srv-1').fullName, 'o/r')
  assert.equal(shapeIssue({ number: 1, title: 'x' }).owner, null)
})

test('resolveLabelIds：名字→id、数字串当 id、未知名字报错', async () => {
  const client = {
    async request() {
      return { data: [{ id: 1, name: 'bug' }, { id: 2, name: '123' }] }
    },
  }
  assert.deepEqual(await resolveLabelIds(client, 'o', 'r', ['bug', 2]), [1, 2])
  assert.deepEqual(await resolveLabelIds(client, 'o', 'r', ['123']), [2], '名字优先于数字')
  assert.deepEqual(await resolveLabelIds(client, 'o', 'r', ['77']), [77], '名字不存在时按 id 走')
  await assert.rejects(() => resolveLabelIds(client, 'o', 'r', ['nope']), /does not exist/)
})

test('matchServerByHost 先按 host:port 全等，再退回主机名', () => {
  const servers = [
    { id: 'srv-a', baseUrl: 'https://tea.2sxo.com' },
    { id: 'srv-b', baseUrl: 'http://127.0.0.1:3000/gitea' },
  ]
  assert.equal(matchServerByHost(servers, 'tea.2sxo.com')?.id, 'srv-a')
  assert.equal(matchServerByHost(servers, '127.0.0.1:3000')?.id, 'srv-b')
  assert.equal(matchServerByHost(servers, '127.0.0.1:9999')?.id, 'srv-b')
  assert.equal(matchServerByHost(servers, 'nope.example'), undefined)
})

// ── 配置存储 ────────────────────────────────────────────────────────────────

test('ConfigStore：原子写、revision 递增、乐观并发、坏文件留档', async () => {
  const directory = await makeTemporary('gti-store-')
  const file = join(directory, 'servers.json')
  const store = new ConfigStore(file)

  assert.deepEqual(await store.snapshot(), emptyState())
  const first = await store.mutate((draft) => { draft.servers.push({ id: 'srv-a', name: 'A', baseUrl: 'https://a' }) })
  assert.equal(first.revision, 1)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 1, '落盘内容与内存一致')

  await assert.rejects(
    () => store.mutate((draft) => { draft.defaultServerId = 'srv-a' }, { expectedRevision: 0 }),
    (error) => error.code === 'stale-config' && error.status === 409,
  )
  const second = await store.mutate((draft) => { draft.defaultServerId = 'srv-a' }, { expectedRevision: 1 })
  assert.equal(second.revision, 2)

  // 并发十笔：串行链保证一笔不丢。
  await Promise.all(Array.from({ length: 10 }, () => store.mutate((draft) => { draft.revision += 0 })))
  const after10 = await new ConfigStore(file).snapshot()
  assert.equal(after10.revision, 12)

  // 坏文件：挪到一边、按空白配置继续，不静默覆盖。
  await writeFile(file, '{ not json', 'utf8')
  const recovered = new ConfigStore(file)
  assert.deepEqual(await recovered.snapshot(), emptyState())
  const siblings = await readFile(file, 'utf8').catch(() => undefined)
  assert.equal(siblings, undefined, '坏文件已被挪走，原路径暂时不存在')
})

test('storeFile 跟着 DSH_HOME 走', () => {
  assert.equal(storeFile(), join(process.env.DSH_HOME, 'gitea-task-issues/servers.json'))
})

// ── 端到端 ──────────────────────────────────────────────────────────────────

/** 整条链路的共享状态，`before` 里装好。 */
const world = {}

before(async () => {
  world.home = await makeTemporary('gti-home-')
  process.env.DSH_HOME = world.home
  world.gitea = await startMockGitea()
  world.credentials = makeCredentials()

  // 一个「像真的」工作区：有 .git/config，remote 指向假 Gitea。
  world.workspace = await makeTemporary('gti-work-')
  await mkdir(join(world.workspace, '.git'), { recursive: true })
  await writeFile(join(world.workspace, '.git/config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    `\turl = ${world.gitea.url}/dongasai/mylike.git`,
  ].join('\n'), 'utf8')

  world.fake = makeCtx({ cwd: world.workspace, credentials: world.credentials })
  apply(world.fake.ctx)
  world.route = world.fake.routes[0]
  world.tools = world.fake.tools

  world.server = createServer((req, res) => world.route.handler(req, res))
  await new Promise((resolve) => world.server.listen(0, '127.0.0.1', resolve))
  world.bridge = `http://127.0.0.1:${world.server.address().port}${world.route.path}`
})

after(async () => {
  await new Promise((resolve) => world.server.close(resolve))
  await world.gitea.close()
  await rm(world.home, { recursive: true, force: true })
  await rm(world.workspace, { recursive: true, force: true })
})

/**
 * 打一次桥。
 * @param op - 操作名。
 * @param params - 参数。
 * @returns `{ status, body }`。
 */
async function call(op, params = {}, extra = {}) {
  const response = await fetch(world.bridge, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, params, ...extra }),
  })
  return { status: response.status, body: await response.json().catch(() => undefined) }
}

/** 成功调用并返回 `data`。 */
async function ok(op, params = {}) {
  const { status, body } = await call(op, params)
  assert.equal(status, 200, `${op} 应当成功，实际 ${status}：${JSON.stringify(body)}`)
  assert.equal(body.ok, true)
  return body.data
}

/** 跑一个模型工具。 */
async function runTool(name, args) {
  const tool = world.tools.find((definition) => definition.name === name)
  assert.ok(tool, `工具 ${name} 没注册`)
  const value = await tool.execute(args, { signal: AbortSignal.timeout(15000), agent: { session: { header: { cwd: world.workspace } } } })
  return { tool, value }
}

test('apply() 注册一条路由与七个工具', () => {
  assert.equal(world.fake.routes.length, 1)
  assert.equal(world.route.path, '/gitea-task-issues/api')
  assert.deepEqual(world.tools.map((tool) => tool.name).sort(), [
    'gitea_issue_comment_create',
    'gitea_issue_comment_edit',
    'gitea_issue_comments',
    'gitea_issue_create',
    'gitea_issue_edit',
    'gitea_issue_get',
    'gitea_issue_list',
  ])
  for (const tool of world.tools) {
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 render`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
    assert.equal(tool.parameters.type, 'object')
  }
})

test('桥：只收 POST + JSON，未知操作被拒', async () => {
  const get = await fetch(world.bridge)
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')

  const wrongType = await fetch(world.bridge, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
  assert.equal(wrongType.status, 415)

  const unknown = await call('nope')
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'unknown-operation')

  const badJson = await fetch(world.bridge, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
  assert.equal(badJson.status, 400)
  assert.equal((await badJson.json()).code, 'bad-request')
})

test('信任围栏：requestRejection 说什么就回什么', async () => {
  const fake = makeCtx({ cwd: world.workspace, credentials: world.credentials, rejection: 403 })
  apply(fake.ctx)
  const server = createServer((req, res) => fake.routes[0].handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${fake.routes[0].path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'config.get', params: {} }),
    })
    assert.equal(response.status, 403)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('配置：新增服务器 + 写令牌 + 探活 + 令牌状态', async () => {
  const empty = await ok('config.get')
  assert.deepEqual(empty.servers, [])
  assert.equal(empty.credentialsAvailable, true)

  const added = await ok('config.server.add', {
    name: '本地 Gitea',
    baseUrl: world.gitea.url,
    token: TEST_TOKEN,
  })
  world.serverId = added.server.id
  assert.match(world.serverId, /^[a-z][a-z0-9-]*$/)
  assert.equal(added.server.baseUrl, world.gitea.url)
  assert.equal(added.server.token.configured, true)
  assert.equal(added.server.token.source, 'record')
  assert.equal(added.revision, 1)

  const tested = await ok('config.server.test', { id: world.serverId })
  assert.equal(tested.authenticated, true)
  assert.equal(tested.version, '1.27.3')
  assert.equal(tested.user.login, 'tester')

  const fetched = await ok('config.get')
  assert.equal(fetched.servers.length, 1)
  assert.equal(fetched.defaultServerId, world.serverId)
})

test('绑定：自动侦测命中服务器，手动绑定压过侦测', async () => {
  const detected = await ok('binding.get', { sessionId: SESSION_ID })
  assert.equal(detected.root, world.workspace)
  assert.equal(detected.binding, null)
  assert.equal(detected.detected.owner, 'dongasai')
  assert.equal(detected.detected.repo, 'mylike')
  assert.equal(detected.matchedServerId, world.serverId)
  assert.deepEqual(detected.effective, { serverId: world.serverId, owner: 'dongasai', repo: 'mylike', source: 'detected' })

  const bound = await ok('binding.set', {
    sessionId: SESSION_ID,
    serverId: world.serverId,
    owner: 'dongasai',
    repo: 'other',
    expectedRevision: 1,
  })
  assert.equal(bound.binding.repo, 'other')

  const after = await ok('binding.get', { sessionId: SESSION_ID })
  assert.equal(after.effective.source, 'binding')
  assert.equal(after.effective.repo, 'other')

  // 改回来，后面的用例继续用 mylike。
  await ok('binding.set', { sessionId: SESSION_ID, serverId: world.serverId, owner: 'dongasai', repo: 'mylike' })
})

test('issue：创建（标签按名字解析）→ 列表 → 详情', async () => {
  const created = await ok('gitea.call', {
    sessionId: SESSION_ID,
    op: 'issue.create',
    params: { title: '第一个 issue', body: '正文', labels: ['bug'], assignees: ['tester'] },
  })
  assert.equal(created.index, 1)
  assert.equal(created.title, '第一个 issue')
  assert.equal(created.labels[0].name, 'bug', '标签名应先被解析成 id 再送 Gitea')
  assert.equal(created.assignees[0].login, 'tester')
  assert.equal(created.owner, 'dongasai')
  world.issueIndex = created.index

  const listed = await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.list', params: { state: 'open' } })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].index, 1)

  const detail = await ok('issue.detail', { sessionId: SESSION_ID, index: world.issueIndex })
  assert.equal(detail.issue.index, 1)
  assert.deepEqual(detail.comments, [])
  assert.deepEqual(detail.assets, [])
  assert.equal(detail.subscribed, false)
})

test('issue：编辑、状态、截止日、标签替换、指派增删', async () => {
  const edited = await ok('gitea.call', {
    sessionId: SESSION_ID,
    op: 'issue.edit',
    params: { index: world.issueIndex, title: '改过标题', body: '新正文' },
  })
  assert.equal(edited.title, '改过标题')

  const labelled = await ok('gitea.call', {
    sessionId: SESSION_ID,
    op: 'issue.labels.set',
    params: { index: world.issueIndex, labels: ['enhancement'] },
  })
  assert.equal(labelled.length, 1)
  assert.equal(labelled[0].name, 'enhancement')

  await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.assignees.add', params: { index: world.issueIndex, assignees: ['tester'] } })
  const cleared = await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.assignees.remove', params: { index: world.issueIndex, assignees: ['tester'] } })
  assert.equal(cleared.assignees.length, 0)

  const deadline = await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.deadline', params: { index: world.issueIndex, due_date: '2026-12-01T00:00:00Z' } })
  assert.equal(deadline.dueDate, '2026-12-01T00:00:00Z')

  const closed = await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.edit', params: { index: world.issueIndex, state: 'closed' } })
  assert.equal(closed.state, 'closed')
  await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.edit', params: { index: world.issueIndex, state: 'open' } })
})

test('评论：发表 → 列表 → 编辑', async () => {
  const comment = await ok('gitea.call', {
    sessionId: SESSION_ID,
    op: 'issue.comments.create',
    params: { index: world.issueIndex, body: '第一条评论' },
  })
  assert.equal(comment.body, '第一条评论')
  world.commentId = comment.id

  const list = await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.comments.list', params: { index: world.issueIndex } })
  assert.equal(list.length, 1)

  const edited = await ok('gitea.call', {
    sessionId: SESSION_ID,
    op: 'comment.edit',
    params: { id: world.commentId, body: '改过的评论' },
  })
  assert.equal(edited.body, '改过的评论')

  const detail = await ok('issue.detail', { sessionId: SESSION_ID, index: world.issueIndex })
  assert.equal(detail.comments[0].body, '改过的评论')
})

test('侧栏动作：置顶、锁定、订阅、工时、依赖、附件', async () => {
  const target = { sessionId: SESSION_ID, params: { index: world.issueIndex } }
  assert.equal(await ok('gitea.call', { ...target, op: 'issue.pin' }), null)
  assert.equal((await ok('gitea.call', { ...target, op: 'issue.get' })).pinned, true)
  await ok('gitea.call', { ...target, op: 'issue.unpin' })

  await ok('gitea.call', { ...target, op: 'issue.lock', params: { index: world.issueIndex, lock_reason: 'resolved' } })
  assert.equal((await ok('gitea.call', { ...target, op: 'issue.get' })).locked, true)
  await ok('gitea.call', { ...target, op: 'issue.unlock' })

  await ok('gitea.call', { ...target, op: 'issue.subscribe' })
  assert.equal(await ok('gitea.call', { ...target, op: 'issue.subscription.check' }), true)
  await ok('gitea.call', { ...target, op: 'issue.unsubscribe' })
  assert.equal(await ok('gitea.call', { ...target, op: 'issue.subscription.check' }), false)

  const time = await ok('gitea.call', { ...target, op: 'issue.times.add', params: { index: world.issueIndex, time: 3600 } })
  assert.equal(time.time, 3600)
  assert.equal((await ok('gitea.call', { ...target, op: 'issue.times.list' })).length, 1)
  await ok('gitea.call', { ...target, op: 'issue.times.delete', params: { index: world.issueIndex, timeId: time.id } })

  await ok('gitea.call', { ...target, op: 'issue.dependencies.add', params: { index: world.issueIndex, dependsOn: 2 } })
  assert.equal((await ok('gitea.call', { ...target, op: 'issue.dependencies.list' }))[0].index, 2)
  await ok('gitea.call', { ...target, op: 'issue.blocks.add', params: { index: world.issueIndex, dependsOn: 3 } })
  assert.equal((await ok('gitea.call', { ...target, op: 'issue.blocks.list' }))[0].index, 3)

  const asset = await ok('gitea.call', {
    ...target,
    op: 'issue.assets.upload',
    params: { index: world.issueIndex, name: 'note.txt', filename: 'note.txt', contentType: 'text/plain', dataBase64: Buffer.from('hello').toString('base64') },
  })
  assert.equal(asset.name, 'note.txt')
  assert.equal((await ok('gitea.call', { ...target, op: 'issue.assets.list' })).length, 1)
  await ok('gitea.call', { ...target, op: 'issue.asset.delete', params: { index: world.issueIndex, attachmentId: asset.id } })
  assert.equal((await ok('gitea.call', { ...target, op: 'issue.assets.list' })).length, 0)
})

test('gitea.call 也接受平铺的内层参数（不强制多套一层 params）', async () => {
  const flat = await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.get', index: world.issueIndex })
  assert.equal(flat.index, world.issueIndex)
  const nested = await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.get', params: { index: world.issueIndex } })
  assert.deepEqual(nested, flat)
})

test('仓库元信息与跨仓库搜索', async () => {
  const meta = await ok('repo.meta', { sessionId: SESSION_ID })
  assert.equal(meta.repository.fullName, 'dongasai/mylike')
  assert.equal(meta.labels.length, 2)
  assert.equal(meta.assignees[0].login, 'tester')
  assert.equal(meta.source, 'binding')

  const searched = await ok('gitea.call', { sessionId: SESSION_ID, op: 'issue.search', params: { state: 'open', owner: 'dongasai' } })
  assert.ok(Array.isArray(searched))
})

test('上游失败带上 Gitea 状态码与线上码', async () => {
  const missing = await call('gitea.call', { sessionId: SESSION_ID, op: 'issue.get', params: { index: 9999 } })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'not-found')

  const badParam = await call('gitea.call', { sessionId: SESSION_ID, op: 'issue.get', params: { index: 'x' } })
  assert.equal(badParam.status, 400)
  assert.equal(badParam.body.code, 'bad-request')
})

test('没配令牌的服务器：明确报 token-missing，不匿名去打', async () => {
  const added = await ok('config.server.add', { name: '无令牌', baseUrl: 'https://example.invalid' })
  const result = await call('gitea.call', { op: 'issue.list', params: { serverId: added.server.id, owner: 'a', repo: 'b' } })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'token-missing')
  await ok('config.server.remove', { id: added.server.id, expectedRevision: (await ok('config.get')).revision })
})

test('删除服务器会连带清掉令牌记录与指向它的绑定', async () => {
  const added = await ok('config.server.add', { name: '临时', baseUrl: 'https://tmp.invalid', token: 'tmp-token' })
  const revision = (await ok('config.get')).revision
  await ok('binding.set', { root: '/tmp/other-work', serverId: added.server.id, owner: 'o', repo: 'r', expectedRevision: revision })
  const removed = await ok('config.server.remove', { id: added.server.id })
  assert.equal(removed.revision, revision + 2)
  assert.equal(world.credentials.records.has(`gitea-task-issues/${added.server.id}`), false)
  const state = await ok('config.get')
  assert.equal(state.bindings['/tmp/other-work'], undefined)
})

test('模型工具：列表 / 详情 / 创建 / 编辑 / 评论三件套', async () => {
  const list = await runTool('gitea_issue_list', { state: 'open', limit: 10 })
  assert.equal(list.value.ok, true)
  assert.equal(list.value.owner, 'dongasai')
  assert.equal(list.value.repo, 'mylike')
  assert.ok(list.value.issues.length >= 1)

  const detail = await runTool('gitea_issue_get', { index: world.issueIndex })
  assert.equal(detail.value.ok, true)
  assert.equal(detail.value.issue.index, world.issueIndex)
  assert.ok(detail.value.comments.length >= 1)

  const created = await runTool('gitea_issue_create', { title: '工具建的', body: '来自模型', labels: ['enhancement'] })
  assert.equal(created.value.ok, true)
  assert.equal(created.value.issue.title, '工具建的')
  assert.equal(created.value.issue.labels[0].name, 'enhancement')
  const toolIndex = created.value.issue.index

  const edited = await runTool('gitea_issue_edit', { index: toolIndex, state: 'closed', labels: ['bug'] })
  assert.equal(edited.value.ok, true)
  assert.equal(edited.value.issue.state, 'closed')
  assert.equal(edited.value.labelsReplaced, true)

  const noop = await runTool('gitea_issue_edit', { index: toolIndex })
  assert.equal(noop.value.ok, false)
  assert.equal(noop.value.code, 'nothing-to-do')

  const commented = await runTool('gitea_issue_comment_create', { index: toolIndex, body: '模型评论' })
  assert.equal(commented.value.ok, true)

  const comments = await runTool('gitea_issue_comments', { index: toolIndex })
  assert.equal(comments.value.count, 1)

  const commentEdited = await runTool('gitea_issue_comment_edit', { id: commented.value.comment.id, body: '模型改过的评论' })
  assert.equal(commentEdited.value.ok, true)
  assert.equal(commentEdited.value.comment.body, '模型改过的评论')

  const failed = await runTool('gitea_issue_get', { index: 9999 })
  assert.equal(failed.value.ok, false)
  assert.equal(failed.value.code, 'not-found')
})

test('模型工具的出参过注册表自己的校验器，且不含 undefined 值的键', async () => {
  const { validateJsonSchemaValue } = await dshModule('@deepseek-ai/dsh-tools/lib/index.js')
  const runs = [
    ['gitea_issue_list', { state: 'all', limit: 5 }],
    ['gitea_issue_get', { index: world.issueIndex }],
    ['gitea_issue_create', { title: '校验用', labels: ['bug'], due_date: '2026-12-31T00:00:00Z' }],
    ['gitea_issue_edit', { index: world.issueIndex, body: '校验正文' }],
    ['gitea_issue_comments', { index: world.issueIndex }],
    ['gitea_issue_comment_create', { index: world.issueIndex, body: '校验评论' }],
    ['gitea_issue_get', { index: 424242 }],
  ]
  for (const [name, args] of runs) {
    const { tool, value } = await runTool(name, args)
    const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
    assert.deepEqual(violations, [], `${name} 出参不合规：${violations.join('; ')}`)
    assertNoUndefined(value, name)
    const blocks = tool.output.render(args, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0 && typeof blocks[0].text === 'string', `${name} render 结果不对`)
  }
})

/** 递归断言对象里没有值为 `undefined` 的键（注册表会做无损 JSON 快照，undefined 不合法）。 */
function assertNoUndefined(value, label, path = '') {
  if (value === undefined) assert.fail(`${label}: ${path} 是 undefined`)
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, at) => assertNoUndefined(item, label, `${path}[${at}]`))
    return
  }
  for (const [key, item] of Object.entries(value)) assertNoUndefined(item, label, `${path}.${key}`)
}
