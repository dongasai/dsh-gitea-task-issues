/**
 * @module lib/bridge
 *
 * Host 半边对浏览器的**唯一入口**：`POST /gitea-task-issues/api`。
 *
 * ## 为什么是一条路由 + 操作名，而不是几十条 REST 路由
 *
 * 官方 `@deepseek-ai/dsh-api-workspace-files` 是只读的，新增 Remote 命名空间要构建期生成的
 * `InvocationDescriptor`，`link:` 装进来的插件走不通（同 `dsh-editor` 的结论），所以只能自己开
 * `ctx.webServer.register()` 路由。但 Gitea 这边要暴露的操作有几十个，一条路由一张外壳
 * （围栏 / 方法 / 媒体类型 / 生命周期 / 应答五件事）会把同样的代码抄几十遍。这里改成
 * **一条路由 + `op` 操作表**：外壳只有一份，操作名是白名单 —— 表里没有的名字一律
 * `unknown-operation`，不存在把任意 URL 透传出去的口子。
 *
 * ## 三道栅栏（与 `dsh-editor` 同一套，不要放宽）
 *
 * 1. **Connection 信任围栏**：`ctx.connection.requestRejection(req)`，非本机认证页面一律拒；
 * 2. **只接受 POST + `application/json`**，请求体有上限；
 * 3. **令牌只在 Host 侧解密**：浏览器从头到尾拿不到 Gitea 令牌，它只能点名「哪台服务器」。
 *
 * ## 应答约定（线上协议）
 *
 * - 成功：HTTP 200 + `{ ok: true, data, total? }`；
 * - 失败：HTTP 4xx/5xx + `{ ok: false, code, message, details? }`；
 * - `data` 的形状由 `lib/shape.js` 决定 —— 浏览器半边只认那一份字段集。
 */
import { loadIssueDetail, loadRepoMeta } from './aggregate.js'
import { BridgeError, GiteaError, httpStatusForGitea, messageOf } from './errors.js'
import { detectRepository, matchServerByHost } from './detect.js'
import { OPS, operationNames, reqInt, reqString, runOperation, runOperationWithLabels } from './gitea.js'
import { anyRoot, clientFor, resolveRepository } from './resolve.js'
import { clearToken, credentialProvider, resolveToken, setToken, tokenStatus } from './secrets.js'
import { shapeAsset, shapeComment, shapeIssue, shapeIssues, shapeLabel, shapeList, shapeMilestone, shapeRepo, shapeTimeline, shapeTime, shapeUser } from './shape.js'
import {
  makeServerId,
  normalizeRoot,
  normalizeServerInput,
  requireServer,
} from './store.js'
import { defaultRootWatch, normalizeWatchGlobal, normalizeWatchRoot } from './watchstore.js'

/** 桥接路由路径；与客户端半边拼出的 URL 必须逐字一致。 */
export const BRIDGE_PATH = '/gitea-task-issues/api'

/**
 * 请求体上限。附件走 base64（膨胀 4/3），所以给到 32MiB —— 约合 20MiB 的真实文件，
 * 与 Gitea 默认的 `MAX_SIZE` 一个量级。
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 单次桥请求的墙钟上限。 */
const REQUEST_TIMEOUT_MS = 60 * 1000

// ── 结果瘦身：操作名 → 出线形状 ─────────────────────────────────────────────

/** 单条 → 单条的映射。 */
const ONE = {
  'server.user': (raw) => shapeUser(raw) ?? null,
  'repo.get': (raw, o) => shapeRepo(raw, o.serverId) ?? null,
  'issue.get': (raw, o) => shapeIssue(raw, o) ?? null,
  'issue.create': (raw, o) => shapeIssue(raw, o) ?? null,
  'issue.edit': (raw, o) => shapeIssue(raw, o) ?? null,
  'issue.deadline': (raw, o) => shapeIssue(raw, o) ?? null,
  'comment.get': (raw, o) => shapeComment(raw, o) ?? null,
  'comment.edit': (raw, o) => shapeComment(raw, o) ?? null,
  'issue.asset.get': (raw) => shapeAsset(raw) ?? null,
  'issue.asset.edit': (raw) => shapeAsset(raw) ?? null,
  'comment.asset.get': (raw) => shapeAsset(raw) ?? null,
  'comment.asset.edit': (raw) => shapeAsset(raw) ?? null,
  'issue.times.add': (raw) => shapeTime(raw) ?? null,
}

/** 列表 → 列表的映射。 */
const MANY = {
  'issue.list': (list, o) => shapeIssues(list, o),
  'issue.search': (list, o) => shapeIssues(list, o),
  'issue.pinned': (list, o) => shapeIssues(list, o),
  'issue.dependencies.list': (list, o) => shapeIssues(list, o),
  'issue.blocks.list': (list, o) => shapeIssues(list, o),
  'issue.comments.list': (list, o) => shapeList(list, (item) => shapeComment(item, o)),
  'comment.listRepo': (list, o) => shapeList(list, (item) => shapeComment(item, o)),
  'issue.assets.list': (list) => shapeList(list, (item) => shapeAsset(item)),
  'comment.assets.list': (list) => shapeList(list, (item) => shapeAsset(item)),
  'issue.times.list': (list) => shapeList(list, (item) => shapeTime(item)),
  'issue.labels.get': (list) => shapeList(list, (item) => shapeLabel(item)),
  'issue.labels.add': (list) => shapeList(list, (item) => shapeLabel(item)),
  'issue.labels.set': (list) => shapeList(list, (item) => shapeLabel(item)),
  'repo.labels': (list) => shapeList(list, (item) => shapeLabel(item)),
  'repo.milestones': (list) => shapeList(list, (item) => shapeMilestone(item)),
  'repo.assignees': (list) => shapeList(list, (item) => shapeUser(item)),
  'issue.subscribers': (list) => shapeList(list, (item) => shapeUser(item)),
  'repo.search': (payload, o) => shapeList(Array.isArray(payload) ? payload : payload?.data, (item) => shapeRepo(item, o.serverId)),
  'repo.mine': (list, o) => shapeList(list, (item) => shapeRepo(item, o.serverId)),
  'issue.timeline': (list, o) => shapeList(list, (item) => shapeTimeline(item, o)),
}

/**
 * 按操作名瘦身。
 * @param name - 操作名。
 * @param data - 上游 `data`。
 * @param options - `serverId` / `owner` / `repo` / `index`。
 * @returns 出线形状。
 */
function shapeResult(name, data, options) {
  if (MANY[name] !== undefined) return MANY[name](data, options) ?? []
  if (ONE[name] !== undefined) return ONE[name](data, options)
  // 没有映射的一律原样返回（删除 / 订阅 / 锁定 / 置顶这类 204 或布尔应答）。
  return data === undefined ? null : data
}

// ── 操作表 ──────────────────────────────────────────────────────────────────

/**
 * 建桥。
 * @param options - `ctx`（Host 上下文）与 `store`（配置存储）。
 * @returns `{ path, handler }`；`handler` 是 `ctx.webServer.register` 要的 (req,res)。
 */
export function createBridge({ ctx, store, watch, watchStore }) {
  /**
   * 一条桥请求的完整生命周期：围栏 → 校验 → 执行操作 → 应答。
   * @param req - 传入请求。
   * @param res - 应答对象。
   * @returns 应答写完即返回。
   */
  async function handler(req, res) {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }
    const mediaType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (mediaType !== 'application/json') {
      sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return
    }

    const signal = requestLifetime(req, res)
    let body
    try {
      body = await readBody(req)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new BridgeError(400, 'bad-request', 'body must be a JSON object')
      }
      const op = reqString(body.op, 'op')
      const handlerForOp = OPERATIONS[op]
      if (handlerForOp === undefined) {
        throw new BridgeError(400, 'unknown-operation', `unknown bridge operation "${op}"`)
      }
      const params = {
        ...(typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params) ? body.params : {}),
      }
      if (typeof body.sessionId === 'string' && body.sessionId !== '') params.sessionId = body.sessionId
      const result = await handlerForOp({ ctx, store, watch, watchStore, signal }, params)
      sendJson(res, 200, { ok: true, data: result.data ?? null, ...(result.total === undefined ? {} : { total: result.total }) })
    } catch (error) {
      sendFailure(res, error, ctx)
    }
  }

  return { path: BRIDGE_PATH, handler }
}

/**
 * 桥的操作表。每个 handler 拿 `({ ctx, store, signal }, params)`，回 `{ data, total? }`。
 */
const OPERATIONS = {
  /** 全量配置：服务器（含令牌状态）、绑定、默认服务器。 */
  'config.get': async ({ ctx, store }) => {
    const state = await store.snapshot()
    const servers = []
    for (const server of state.servers) {
      servers.push({ ...server, token: await tokenStatus(ctx, server) })
    }
    return {
      data: {
        revision: state.revision,
        defaultServerId: state.defaultServerId,
        servers,
        bindings: state.bindings,
        credentialsAvailable: credentialProvider(ctx) !== undefined,
        storage: store.file,
      },
    }
  },

  /** 新增服务器；可选同时写入令牌。 */
  'config.server.add': async ({ ctx, store }, params) => {
    const input = normalizeServerInput(params)
    const state = await store.snapshot()
    const id = makeServerId(new Set(state.servers.map((server) => server.id)))
    const next = await store.mutate((draft) => {
      draft.servers.push({ id, ...input })
      if (draft.defaultServerId === null) draft.defaultServerId = id
    }, { expectedRevision: opts(params).expectedRevision })
    if (typeof params.token === 'string' && params.token !== '') await setToken(ctx, id, params.token)
    const server = requireServer(next, id)
    return { data: { server: { ...server, token: await tokenStatus(ctx, server) }, revision: next.revision } }
  },

  /** 改服务器；`token` 给字符串即写入、给 null 即清除、不给就不动。 */
  'config.server.update': async ({ ctx, store }, params) => {
    const id = reqString(params.id, 'id')
    const state = await store.snapshot()
    requireServer(state, id)
    const patch = normalizeServerInput({ ...requireServer(state, id), ...(params.patch ?? params) })
    const next = await store.mutate((draft) => {
      const target = requireServer(draft, id)
      target.name = patch.name
      target.baseUrl = patch.baseUrl
      target.tokenEnv = patch.tokenEnv
    }, { expectedRevision: opts(params).expectedRevision })
    if (params.token === null) await clearToken(ctx, id)
    else if (typeof params.token === 'string' && params.token !== '') await setToken(ctx, id, params.token)
    const server = requireServer(next, id)
    return { data: { server: { ...server, token: await tokenStatus(ctx, server) }, revision: next.revision } }
  },

  /** 删服务器：连同它的令牌记录与指向它的绑定一起清掉。 */
  'config.server.remove': async ({ ctx, store }, params) => {
    const id = reqString(params.id, 'id')
    const next = await store.mutate((draft) => {
      requireServer(draft, id)
      draft.servers = draft.servers.filter((server) => server.id !== id)
      for (const [root, binding] of Object.entries(draft.bindings)) {
        if (binding.serverId === id) delete draft.bindings[root]
      }
      if (draft.defaultServerId === id) draft.defaultServerId = draft.servers[0]?.id ?? null
    }, { expectedRevision: opts(params).expectedRevision })
    await clearToken(ctx, id)
    return { data: { revision: next.revision } }
  },

  /** 切默认服务器。 */
  'config.default.set': async ({ store }, params) => {
    const id = params.id === null ? null : reqString(params.id, 'id')
    const next = await store.mutate((draft) => {
      if (id !== null) requireServer(draft, id)
      draft.defaultServerId = id
    }, { expectedRevision: opts(params).expectedRevision })
    return { data: { defaultServerId: next.defaultServerId, revision: next.revision } }
  },

  /** 探活 + 验令牌：`/version` 不需要令牌，`/user` 需要。 */
  'config.server.test': async ({ ctx, store, signal }, params) => {
    const id = reqString(params.id, 'id')
    const state = await store.snapshot()
    const server = requireServer(state, id)
    const version = await requestNoAuth(server, '/version', signal)
    const { token, source } = await resolveToken(ctx, server)
    if (token === undefined) {
      return { data: { ok: true, authenticated: false, version: version?.version ?? null, user: null, tokenSource: null } }
    }
    const { client } = await clientFor(ctx, store, id, signal)
    const { data } = await runOperation(client, 'server.user', {}, signal)
    return { data: { ok: true, authenticated: true, version: version?.version ?? null, user: shapeUser(data) ?? null, tokenSource: source ?? null } }
  },

  /** 读工作区绑定的现状：手动绑定 / 自动侦测 / 最终生效的仓库。 */
  'binding.get': async ({ ctx, store, signal }, params) => {
    const root = await anyRoot(ctx, params, signal)
    const state = await store.snapshot()
    const binding = state.bindings[root] ?? null
    const detected = await detectRepository(root)
    const matchedServerId = detected === undefined ? undefined : matchServerByHost(state.servers, detected.host)?.id
    let effective = null
    let server = null
    if (binding !== null) {
      effective = { serverId: binding.serverId, owner: binding.owner, repo: binding.repo, source: 'binding' }
      server = state.servers.find((item) => item.id === binding.serverId) ?? null
    } else if (detected !== undefined && matchedServerId !== undefined) {
      effective = { serverId: matchedServerId, owner: detected.owner, repo: detected.repo, source: 'detected' }
      server = state.servers.find((item) => item.id === matchedServerId) ?? null
    }
    return {
      data: {
        root,
        binding,
        detected: detected === undefined ? null : {
          remoteName: detected.remoteName,
          remoteUrl: detected.remoteUrl,
          host: detected.host,
          owner: detected.owner,
          repo: detected.repo,
          workTree: detected.workTree,
        },
        matchedServerId: matchedServerId ?? null,
        effective,
        server: server === null ? null : { ...server, token: await tokenStatus(ctx, server) },
      },
    }
  },

  /** 写入工作区绑定。 */
  'binding.set': async ({ ctx, store, signal }, params) => {
    const root = await anyRoot(ctx, params, signal)
    const serverId = reqString(params.serverId, 'serverId')
    const owner = reqString(params.owner, 'owner')
    const repo = reqString(params.repo, 'repo')
    const next = await store.mutate((draft) => {
      requireServer(draft, serverId)
      draft.bindings[normalizeRoot(root)] = { serverId, owner, repo, updatedAt: new Date().toISOString() }
    }, { expectedRevision: opts(params).expectedRevision })
    return { data: { root, binding: next.bindings[normalizeRoot(root)], revision: next.revision } }
  },

  /** 解除工作区绑定（不影响自动侦测）。 */
  'binding.remove': async ({ ctx, store, signal }, params) => {
    const root = await anyRoot(ctx, params, signal)
    const next = await store.mutate((draft) => {
      delete draft.bindings[normalizeRoot(root)]
    }, { expectedRevision: opts(params).expectedRevision })
    return { data: { root, revision: next.revision } }
  },

  // ── 自动分配（watch）：配置、状态、手动跑一轮、重放一条 ─────────────────────

  /**
   * 自动分配的全量视图：配置 + 待办 + 最近投递 + 运行状态。
   *
   * 「最近投递」只回最后 50 条（账本里最多留 200 条）：这个列表是给眼睛看的，
   * 不是给程序消费的，回全部只会把响应撑大。
   */
  'watch.get': async ({ watch, watchStore }) => {
    const state = await watchStore.snapshot()
    return {
      data: {
        revision: state.revision,
        global: state.global,
        roots: state.roots,
        watermarks: state.watermarks,
        pending: Object.entries(state.issues)
          .filter(([, fact]) => fact.pending !== null)
          .map(([key, fact]) => ({
            key,
            title: fact.title,
            kinds: ['newAssigned', 'reopened', 'newComment'].filter((kind) => fact.pending[kind] !== null),
            actor: fact.pending.actor ?? null,
            since: fact.pendingSince,
          })),
        deliveries: state.deliveries.slice(-50),
        status: watch.status(),
        storage: watchStore.file,
      },
    }
  },

  /**
   * 改自动分配配置：`global` 局部更新，或某个工作区的局部更新。
   *
   * **`serverId` / `owner` / `repo` 不接受调用方给** —— 一律由当前工作区的绑定解析出来，
   * 和模型工具的工作区隔离开关同源：界面不能把自动分配指到一个它没绑的仓库上去。
   * `rootConfig: null` 表示删掉这个工作区的配置。
   */
  'watch.set': async ({ ctx, store, watch, watchStore, signal }, params) => {
    const globalPatch = params.global === undefined ? undefined : normalizeWatchGlobal(params.global)
    const hasRoot = typeof params.root === 'string' && params.root.trim() !== ''
    let edit
    if (hasRoot) {
      const root = normalizeRoot(params.root)
      if (params.rootConfig === null) {
        edit = { root, remove: true }
      } else {
        const patch = normalizeWatchRoot(params.rootConfig ?? {})
        const target = await resolveRepository(ctx, store, { root }, signal)
        const current = (await watchStore.snapshot()).roots[root]
        const base = { ...defaultRootWatch(), ...(current ?? {}) }
        edit = {
          root,
          config: {
            ...base,
            ...patch,
            triggers: { ...base.triggers, ...(patch.triggers ?? {}) },
            serverId: target.server.id,
            owner: target.owner,
            repo: target.repo,
          },
        }
      }
    }
    if (globalPatch === undefined && edit === undefined) {
      throw new BridgeError(400, 'bad-request', 'watch.set needs global or root + rootConfig')
    }
    const next = await watchStore.mutate((draft) => {
      if (globalPatch !== undefined) draft.global = { ...draft.global, ...globalPatch }
      if (edit === undefined) return
      if (edit.remove === true) delete draft.roots[edit.root]
      else draft.roots[edit.root] = edit.config
    }, { expectedRevision: opts(params).expectedRevision })
    // 改完立刻按新配置重排：定时器的延迟是在 arm 时算死的，只写账本要等旧定时器烧完才生效
    //（最坏情况 30 分钟退避 / 24 小时间隔 —— 用户会以为「60 秒没生效」）。
    await watch?.refreshSchedule?.()
    return { data: { revision: next.revision, global: next.global, roots: next.roots } }
  },

  /** 手动跑一轮（界面的「立即检查一次」），不受间隔限制。 */
  'watch.tick': async ({ watch }) => {
    const summary = await watch.tickNow()
    return { data: { summary: summary ?? null, status: watch.status() } }
  },

  /**
   * 重放一条 issue：把「已投递」的标记重新变成待办。
   *
   * 用途只有一个——write-ahead 记忆已经落盘、但会话没开起来的那次漏投（进程被杀、create
   * 抛错）。**不依赖增量查询**：直接往账本里写待办，所以就算那条 issue 早就滑出 `since`
   * 窗口也照样能重投。
   */
  'watch.requeue': async ({ ctx, watchStore, signal }, params) => {
    const root = normalizeRoot(await anyRoot(ctx, params, signal))
    const index = reqInt(params.index, 'index')
    const state = await watchStore.snapshot()
    const config = state.roots[root]
    if (config === undefined) {
      throw new BridgeError(404, 'watch-root-unknown', `workspace "${root}" has no automatic assignment configured`)
    }
    const key = `${config.serverId}/${config.owner}/${config.repo}#${index}`
    const next = await watchStore.mutate((draft) => {
      const fact = draft.issues[key]
      if (fact === undefined) {
        throw new BridgeError(404, 'watch-issue-unknown', `issue #${index} of ${config.owner}/${config.repo} was never seen by the poller`)
      }
      const pending = {
        newAssigned: fact.fired.newAssigned === true ? 'n-replay' : null,
        reopened: typeof fact.fired.reopened === 'string' ? fact.fired.reopened : null,
        newComment: fact.fired.commentId > 0 ? `c${fact.fired.commentId}` : null,
        actor: null,
      }
      if (pending.newAssigned === null && pending.reopened === null && pending.newComment === null) {
        throw new BridgeError(400, 'nothing-to-replay', `issue #${index} has no delivered trigger to replay`)
      }
      fact.pending = pending
      fact.pendingSince = new Date().toISOString()
    }, { expectedRevision: opts(params).expectedRevision })
    return { data: { root, index, revision: next.revision } }
  },

  /** 仓库选择器：有关键词走搜索，否则列当前用户的仓库。 */
  'repo.list': async ({ ctx, store, signal }, params) => {
    const serverId = reqString(params.serverId, 'serverId')
    const { server, client } = await clientFor(ctx, store, serverId, signal)
    const query = typeof params.q === 'string' && params.q.trim() !== '' ? params.q.trim() : undefined
    const name = query === undefined ? 'repo.mine' : 'repo.search'
    const { data } = await runOperation(client, name, { q: query, limit: params.limit ?? 50 }, signal)
    return { data: shapeResult(name, data, { serverId: server.id }) }
  },

  /** 当前令牌用户。 */
  'user.me': async ({ ctx, store, signal }, params) => {
    const serverId = reqString(params.serverId, 'serverId')
    const { client } = await clientFor(ctx, store, serverId, signal)
    const { data } = await runOperation(client, 'server.user', {}, signal)
    return { data: shapeUser(data) ?? null }
  },

  /** 操作清单：给界面与文档做「能力清单」，避免两边手工同步。 */
  'gitea.ops': async ({ store }) => {
    const state = await store.snapshot()
    return {
      data: operationNames().map((name) => ({
        name,
        scope: OPS[name].scope,
        method: OPS[name].method,
        summary: OPS[name].summary,
      })),
      total: state.revision,
    }
  },

  /** 通用 Gitea 调用：`op` 必须在操作表里；仓库/issue 缺 `owner`/`repo` 时按绑定补。 */
  'gitea.call': async (env, params) => {
    const opName = reqString(params.op, 'op')
    const op = OPS[opName]
    if (op === undefined) throw new BridgeError(400, 'unknown-operation', `unknown operation "${opName}"`)
    const inner = typeof params.params === 'object' && params.params !== null && !Array.isArray(params.params)
      ? { ...params.params }
      : omit(params, ['op', 'params', 'sessionId', 'serverId', 'expectedRevision'])

    /** 空串 / null / 非字符串一律当「没给」——别让 `null` 混进必填校验。 */
    const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined)
    // sessionId 有两个来处：桥请求体的顶层（界面直传）与 `params` 里（`gitea.call` 的调用方塞的）。
    // **两边都要认**：早先只认顶层，于是 `{ ...inner, sessionId: params.sessionId }` 把内层那个
    // 覆盖成 undefined，仓库解析悄悄回退到 Host 的工作区根，最后报出「owner must be a non-empty string」
    // 这种和真实原因完全无关的错误（界面就是这么调用的）。
    const sessionId = text(params.sessionId) ?? text(inner.sessionId)
    const resolveParams = sessionId === undefined ? { ...inner } : { ...inner, sessionId }

    let serverId = text(params.serverId) ?? text(inner.serverId)
    let owner = text(inner.owner)
    let repo = text(inner.repo)
    const needRepo = op.scope !== 'server'

    if (serverId === undefined) {
      // 没点名服务器：先按工作区绑定 / 自动侦测定位（顺带补上 owner/repo）。
      let resolved
      let resolutionError
      try {
        resolved = await resolveRepository(env.ctx, env.store, resolveParams, env.signal)
      } catch (error) {
        resolutionError = error
        resolved = undefined
      }
      if (resolved !== undefined) {
        serverId = resolved.server.id
        if (needRepo) {
          owner = owner ?? resolved.owner
          repo = repo ?? resolved.repo
        }
      } else if (needRepo) {
        // **仓库级操作不降级**：解析不出仓库就把原始原因抛出去（`no-binding` / `no-server-for-host` /
        // `root-required`）。否则会带着空 owner 去打 Gitea，报出的错和真实原因无关，排查要多花一轮。
        throw resolutionError
      } else {
        // 服务器级操作（全局看板的跨仓库搜索）本来就不带工作区，退回唯一的或默认的服务器。
        const state = await env.store.snapshot()
        serverId = state.servers.length === 1 ? state.servers[0].id : (state.defaultServerId ?? undefined)
        if (serverId === undefined) {
          throw new BridgeError(400, 'server-required', 'pass serverId: this host has several servers and the workspace is not bound to a repository')
        }
      }
    } else if (needRepo && (owner === undefined || repo === undefined)) {
      const resolved = await resolveRepository(env.ctx, env.store, { ...resolveParams, serverId }, env.signal)
      owner = owner ?? resolved.owner
      repo = repo ?? resolved.repo
    }
    const { server, client } = await clientFor(env.ctx, env.store, serverId, env.signal)
    const target = { ...inner, owner, repo }
    const { data, total } = await runOperationWithLabels(client, opName, target, env.signal)
    return { data: shapeResult(opName, data, { serverId: server.id, owner, repo, index: inner.index }), total }
  },

  /** issue 详情一揽子：正文 + 评论 + 附件 + 工时 + 依赖 + 阻塞 + 订阅状态。 */
  'issue.detail': async (env, params) => {
    const { serverId, owner, repo, index } = await requireIssueTarget(env, params)
    const detail = await loadIssueDetail(env, { serverId, owner, repo, index })
    return { data: detail }
  },

  /** 仓库元信息一揽子：仓库 + 标签 + 里程碑 + 可指派候选。 */
  'repo.meta': async (env, params) => {
    const resolved = await resolveRepository(env.ctx, env.store, params, env.signal)
    const meta = await loadRepoMeta(env, { serverId: resolved.server.id, owner: resolved.owner, repo: resolved.repo })
    return { data: { ...meta, source: resolved.source } }
  },
}

/**
 * 取「某台服务器上的某个 issue」的四元组：显式优先，其次绑定 / 侦测。
 * @param env - `{ ctx, store, signal }`。
 * @param params - 入参。
 * @returns `{ serverId, owner, repo, index }`。
 */
async function requireIssueTarget(env, params) {
  const index = reqInt(params.index, 'index')
  const resolved = await resolveRepository(env.ctx, env.store, params, env.signal)
  return { serverId: resolved.server.id, owner: resolved.owner, repo: resolved.repo, index }
}

/**
 * 不带令牌打一个 GET（现在只用于 `/version`）。
 * @param server - 服务器记录。
 * @param pathname - API 路径。
 * @param signal - 取消信号。
 * @returns 解析后的 JSON，或 undefined。
 */
async function requestNoAuth(server, pathname, signal) {
  const response = await fetch(`${server.baseUrl}/api/v1${pathname}`, {
    headers: { accept: 'application/json' },
    signal: signal === undefined ? AbortSignal.timeout(10 * 1000) : AbortSignal.any([signal, AbortSignal.timeout(10 * 1000)]),
  }).catch((error) => {
    throw new BridgeError(502, 'network-error', `cannot reach ${server.baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (!response.ok) {
    throw new BridgeError(502, 'upstream-error', `${server.baseUrl} answered HTTP ${response.status} for ${pathname}`)
  }
  return response.json().catch(() => undefined)
}

/** 取 `expectedRevision`（可选整数）。 */
function opts(params) {
  const value = params.expectedRevision
  if (value === undefined || value === null || value === '') return {}
  if (!Number.isInteger(value)) throw new BridgeError(400, 'bad-request', 'expectedRevision must be an integer')
  return { expectedRevision: value }
}

/**
 * 摘掉若干键。`gitea.call` 允许把内层参数平铺在外层（省一层嵌套），这里把外层自己的键摘掉。
 * @param source - 入参对象。
 * @param keys - 要摘掉的键。
 * @returns 新对象。
 */
function omit(source, keys) {
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) out[key] = value
  }
  return out
}

/** 请求的取消信号：客户端断连或超出墙钟。 */
function requestLifetime(req, res) {
  const disconnect = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) disconnect.abort(new Error('client disconnected'))
  })
  return AbortSignal.any([disconnect.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
}

/**
 * 有界读 JSON 请求体。
 * @param req - 传入请求。
 * @returns 解析后的值。
 * @throws {BridgeError} 400/413。
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      throw new BridgeError(413, 'too-large', `request body exceeds the ${MAX_BODY_BYTES}-byte limit`)
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new BridgeError(400, 'bad-request', 'body must be valid JSON')
  }
}

/**
 * 失败应答：本地失败照搬其码；上游失败换一个语义状态；其余 500 并记日志。
 * @param res - 应答对象。
 * @param error - 捕获到的值。
 * @param ctx - Host 上下文（日志用）。
 * @returns 无。
 */
function sendFailure(res, error, ctx) {
  if (error instanceof BridgeError) {
    sendJson(res, error.status, { ok: false, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) })
    return
  }
  if (error instanceof GiteaError) {
    sendJson(res, httpStatusForGitea(error.giteaStatus), {
      ok: false,
      code: error.code,
      message: error.message,
      details: { giteaStatus: error.giteaStatus },
    })
    return
  }
  ctx.logger.error(error)
  sendJson(res, 500, { ok: false, code: 'bridge-failed', message: messageOf(error) })
}

/** JSON 应答（no-store：这些都是即时事实）。 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}
