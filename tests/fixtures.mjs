/**
 * 浏览器半边探针用的假数据：与 `lib/shape.js` 的出线形状逐字对齐。
 *
 * 单独一个文件是为了让调试脚本也能直接 import 同一份数据 —— 断言与调试看的是同一批事实。
 */

/** 每次桥调用都记一笔，便于断言「界面到底请求了什么」。 */
export const calls = []

/** 假桥返回的数据。 */
export const FIXTURES = {
  config: {
    revision: 3,
    defaultServerId: 'srv-a',
    servers: [{
      id: 'srv-a',
      name: '本地 Gitea',
      baseUrl: 'http://localhost:3000',
      tokenEnv: null,
      token: { configured: true, source: 'record', writable: true },
    }],
    bindings: {
      '/work/mylike': { serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', updatedAt: '2026-10-16T02:49:15.723Z' },
      '/work/other': { serverId: 'srv-a', owner: 'dongasai', repo: 'other', updatedAt: '2026-10-16T02:51:34.370Z' },
    },
    credentialsAvailable: true,
    storage: '/tmp/gitea-task-issues/servers.json',
  },
  binding: {
    root: '/work/mylike',
    binding: { serverId: 'srv-a', owner: 'dongasai', repo: 'mylike' },
    detected: { remoteName: 'origin', remoteUrl: 'http://localhost:3000/dongasai/mylike.git', host: 'localhost:3000', owner: 'dongasai', repo: 'mylike', workTree: '/work/mylike' },
    matchedServerId: 'srv-a',
    effective: { serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', source: 'binding' },
    server: { id: 'srv-a', name: '本地 Gitea', baseUrl: 'http://localhost:3000', tokenEnv: null, token: { configured: true, source: 'record', writable: true } },
  },
  issues: [
    {
      serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', index: 12, title: '第一个 issue',
      state: 'open', body: '正文内容', labels: [{ id: 1, name: 'bug', color: 'd73a4a' }],
      assignees: [{ login: 'tester' }], milestone: { id: 7, title: 'v1' }, dueDate: null,
      comments: 2, createdAt: '2026-10-01T02:00:00Z', updatedAt: '2026-10-02T02:00:00Z',
      closedAt: null, htmlUrl: 'http://localhost:3000/dongasai/mylike/issues/12',
      user: { login: 'tester' }, isPull: false, locked: false, pinned: true,
    },
    {
      serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', index: 13, title: '第二个 issue',
      state: 'closed', body: '', labels: [], assignees: [], milestone: null, dueDate: '2026-11-01T00:00:00Z',
      comments: 0, createdAt: '2026-10-03T02:00:00Z', updatedAt: '2026-10-04T02:00:00Z',
      closedAt: '2026-10-05T02:00:00Z', htmlUrl: 'http://localhost:3000/dongasai/mylike/issues/13',
      user: { login: 'tester' }, isPull: false, locked: true, pinned: false,
    },
  ],
  detail: {
    issue: {
      serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', index: 12, title: '第一个 issue',
      state: 'open', body: '正文内容', labels: [{ id: 1, name: 'bug', color: 'd73a4a' }],
      assignees: [{ login: 'tester' }], milestone: { id: 7, title: 'v1' }, dueDate: null,
      comments: 1, createdAt: '2026-10-01T02:00:00Z', updatedAt: '2026-10-02T02:00:00Z',
      closedAt: null, htmlUrl: 'http://localhost:3000/dongasai/mylike/issues/12',
      user: { login: 'tester' }, isPull: false, locked: false, pinned: false,
    },
    comments: [{ id: 5, body: '第一条评论', user: { login: 'tester' }, createdAt: '2026-10-02T03:00:00Z', updatedAt: null, htmlUrl: null, issueIndex: 12, assets: [] }],
    assets: [{ id: 9, name: 'note.txt', size: 2048, uuid: 'u', downloadUrl: 'http://localhost/attachments/9', createdAt: '2026-10-02T03:00:00Z' }],
    times: [{ id: 1, time: 3600, created: '2026-10-02T03:00:00Z', userName: 'tester' }],
    dependencies: [{ serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', index: 3, title: '依赖的 issue', state: 'open', labels: [], assignees: [], milestone: null, dueDate: null, comments: 0, createdAt: null, updatedAt: null, closedAt: null, htmlUrl: null, user: null, isPull: false, locked: false, pinned: false }],
    blocks: [],
    subscribed: true,
    subscribers: [{ login: 'tester' }],
  },
  meta: {
    serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', source: 'binding',
    repository: { serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', fullName: 'dongasai/mylike', private: false, hasIssues: true, htmlUrl: null, updatedAt: null, defaultBranch: 'main' },
    labels: [{ id: 1, name: 'bug', color: 'd73a4a', description: null }, { id: 2, name: 'enhancement', color: 'a2eeef', description: null }],
    milestones: [{ id: 7, title: 'v1', state: 'open', dueOn: null }],
    assignees: [{ login: 'tester', name: 'Tester', avatarUrl: null }],
  },
  repos: [{ serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', fullName: 'dongasai/mylike', private: false, hasIssues: true, htmlUrl: null, updatedAt: null, defaultBranch: 'main' }],
  probe: { ok: true, authenticated: true, version: '1.27.3', user: { login: 'tester', name: 'Tester', avatarUrl: null }, tokenSource: 'record' },
  // Agent 预设名册（自动分配面板的「模式」下拉）。内置预设不发布 name，由界面按 id 查文案；
  // cordis 故意标成加载失败，用来验「坏行禁用」。
  presets: {
    available: true,
    defaultId: 'standard',
    presets: [
      { id: 'standard', name: null, description: null, isDefault: true, broken: null },
      { id: 'ptc', name: 'PTC mode', description: '批量工具', isDefault: false, broken: null },
      { id: 'minimal', name: null, description: null, isDefault: false, broken: null },
      { id: 'cordis', name: null, description: null, isDefault: false, broken: 'activation failed' },
    ],
  },
  // 自动分配的账本快照：一条待投递 + 一条已投递，够渲染出两个列表。
  watch: {
    revision: 3,
    global: { enabled: true, intervalSeconds: 120, maxSessionsPerHour: 6, dryRun: false, baselinedAt: '2026-10-16T00:00:00.000Z' },
    roots: {
      '/work/mylike': {
        enabled: true,
        serverId: 'srv-a',
        owner: 'dongasai',
        repo: 'mylike',
        triggers: { newAssigned: true, reopened: true, newComment: false },
        agentPreset: null,
        cooldownSeconds: 600,
        maxPerIssuePerDay: 3,
        giveUpAfterHours: 24,
      },
    },
    watermarks: { 'srv-a/dongasai/mylike': { issues: '2026-10-16T12:00:00.000Z', comments: '2026-10-16T12:00:00.000Z' } },
    pending: [{ key: 'srv-a/dongasai/mylike#9', title: '待办标题', kinds: ['newComment'], actor: 'alice', since: '2026-10-16T12:00:00.000Z' }],
    deliveries: [{ at: '2026-10-16T12:00:00.000Z', key: 'srv-a/dongasai/mylike#2', root: '/work/mylike', index: 2, title: '列表标题二', kinds: ['newAssigned'], outcome: 'prompted', sessionId: 'session-x' }],
    status: {
      running: false,
      locked: true,
      serviceAvailable: true,
      lastTickAt: '2026-10-16T12:00:00.000Z',
      lastReason: 'timer',
      lastError: null,
      consecutiveFailures: 0,
      nextTickAt: '2026-10-16T12:02:00.000Z',
      summary: null,
      lockFile: '/tmp/lock',
    },
    storage: '/tmp/watch.json',
  },
}

/**
 * 假桥：按操作名返回固定数据。
 * @param op - 操作名。
 * @param params - 参数。
 * @returns `{ ok, data }` 形状的载荷。
 */
export function bridgeAnswer(op, params) {
  calls.push({ op, params })
  if (op === 'config.get') return { ok: true, data: FIXTURES.config }
  if (op === 'binding.get') return { ok: true, data: FIXTURES.binding }
  // `presetsError` 用来模拟「宿主是旧版、没有 presets.list」，验降级提示。
  if (op === 'presets.list') {
    if (typeof FIXTURES.presetsError === 'string') return { ok: false, code: FIXTURES.presetsError, message: 'no such op' }
    return { ok: true, data: FIXTURES.presets }
  }
  if (op === 'repo.list') return { ok: true, data: FIXTURES.repos }
  if (op === 'repo.meta') return { ok: true, data: FIXTURES.meta }
  if (op === 'issue.detail') return { ok: true, data: FIXTURES.detail }
  if (op === 'config.server.test') return { ok: true, data: FIXTURES.probe }
  if (op === 'config.server.add' || op === 'config.server.update') {
    return { ok: true, data: { server: FIXTURES.config.servers[0], revision: 4 } }
  }
  if (op === 'config.server.remove' || op === 'binding.set' || op === 'binding.remove') return { ok: true, data: { revision: 4 } }
  if (op === 'watch.get') return { ok: true, data: FIXTURES.watch }
  if (op === 'watch.set') return { ok: true, data: { revision: 4, global: FIXTURES.watch.global, roots: FIXTURES.watch.roots } }
  if (op === 'watch.tick') return { ok: true, data: { summary: { delivered: 1 }, status: FIXTURES.watch.status } }
  if (op === 'watch.requeue') return { ok: true, data: { root: params?.root, index: params?.index, revision: 5 } }
  if (op === 'gitea.call') {
    const inner = params?.op
    if (inner === 'issue.list' || inner === 'issue.search') return { ok: true, data: FIXTURES.issues, total: 2 }
    if (inner === 'issue.create') return { ok: true, data: FIXTURES.detail.issue }
    if (inner === 'issue.edit') return { ok: true, data: FIXTURES.detail.issue }
    if (inner === 'issue.labels.set') return { ok: true, data: FIXTURES.meta.labels }
    if (inner === 'issue.comments.create') return { ok: true, data: FIXTURES.detail.comments[0] }
    if (inner === 'issue.times.add') return { ok: true, data: FIXTURES.detail.times[0] }
    if (inner === 'issue.assets.upload') {
      // 一次性失败开关：验「issue 已创建、图片没传上去」这条半成功路径（不重复建 issue）。
      if (FIXTURES.failUploadOnce === true) {
        delete FIXTURES.failUploadOnce
        return { ok: false, code: 'upstream-error', message: 'boom' }
      }
      return { ok: true, data: FIXTURES.detail.assets[0] }
    }
    return { ok: true, data: null }
  }
  return { ok: false, code: 'unknown-operation', message: `no fixture for ${op}` }
}

