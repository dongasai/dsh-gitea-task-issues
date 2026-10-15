/**
 * @module lib/resolve
 *
 * 「这次操作说的是哪台服务器、哪个仓库、哪个会话」—— 桥（HTTP）与模型工具（`ctx.tools`）
 * 共用这一份解析，两边的选仓库规则必须一致，否则界面上看到的和模型改的会不是同一个仓库。
 *
 * 解析顺序（显式永远压过隐式）：
 * 1. 入参直接给 `serverId` + `owner` + `repo` —— 全局看板与工具显式指定时走这条；
 * 2. 工作区绑定（`servers.json` 的 `bindings[工作区根]`）—— 用户手动绑过的，最可信；
 * 3. 自动侦测（读 `.git/config` 的 remote）—— 只认「host 能配上已配置服务器」的仓库；
 * 4. 都没有就报错，并说清缺什么，不猜一个默认仓库去改。
 */
import { detectRepository, matchServerByHost } from './detect.js'
import { BridgeError } from './errors.js'
import { createGiteaClient } from './gitea.js'
import { resolveToken } from './secrets.js'
import { normalizeRoot, requireServer } from './store.js'

/**
 * 会话的工作区根：活会话读内存头，冷会话读持久化头。
 * @param ctx - Host 上下文。
 * @param sessionId - 会话 id。
 * @param signal - 取消信号。
 * @returns 工作区根绝对路径。
 * @throws {BridgeError} 404 —— 这个 Host 不认识该会话。
 */
export async function sessionRoot(ctx, sessionId, signal) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new BridgeError(400, 'bad-request', 'sessionId must be a non-empty string')
  }
  const session = ctx.sessions.get(sessionId)
  let cwd = session?.header?.cwd
  if (cwd === undefined) {
    const stored = await ctx.get('sessionPersistence')?.stat(sessionId, { signal })
    cwd = stored?.header?.cwd
  }
  if (session === undefined && cwd === undefined) {
    throw new BridgeError(404, 'unknown-session', `no session "${sessionId}" in this host`)
  }
  if (typeof cwd !== 'string' || cwd === '') {
    const fallback = ctx.get('sandboxPolicy')?.workspaceRoot
    if (typeof fallback !== 'string' || fallback === '') {
      throw new BridgeError(404, 'unknown-session', `session "${sessionId}" has no workspace root`)
    }
    return normalizeRoot(fallback)
  }
  return normalizeRoot(cwd)
}

/**
 * 从模型工具的 `exec` 里读工作区根（同步；没会话就没有）。
 * @param exec - 工具运行上下文。
 * @returns 工作区根，或 undefined。
 */
export function execRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? normalizeRoot(cwd) : undefined
}

/**
 * 本次调用该用哪个工作区根：显式 `root` → 会话 → 服务器默认工作区。
 * @param ctx - Host 上下文。
 * @param params - 入参（`root` / `sessionId`）。
 * @param signal - 取消信号。
 * @returns 工作区根。
 * @throws {BridgeError} 400 —— 一条路都走不通。
 */
export async function anyRoot(ctx, params, signal) {
  if (typeof params.root === 'string' && params.root.trim() !== '') return normalizeRoot(params.root)
  if (typeof params.sessionId === 'string' && params.sessionId !== '') return sessionRoot(ctx, params.sessionId, signal)
  const fallback = ctx.get('sandboxPolicy')?.workspaceRoot
  if (typeof fallback === 'string' && fallback !== '') return normalizeRoot(fallback)
  throw new BridgeError(400, 'root-required', 'pass a sessionId or an absolute workspace root')
}

/**
 * 取一台服务器 + 它的客户端。
 * @param ctx - Host 上下文。
 * @param store - 配置存储。
 * @param serverId - 服务器 id。
 * @param signal - 取消信号。
 * @returns `{ server, client, tokenSource }`。
 * @throws {BridgeError} 404 —— 服务器不存在；400 —— 没配令牌。
 */
export async function clientFor(ctx, store, serverId, signal) {
  const state = await store.snapshot()
  const server = requireServer(state, serverId)
  const { token, source } = await resolveToken(ctx, server)
  if (token === undefined) {
    throw new BridgeError(400, 'token-missing', `server "${server.name}" has no token: add one in the Gitea board, or set the ${server.tokenEnv ?? 'token'} environment variable`)
  }
  return { server, client: createGiteaClient({ baseUrl: server.baseUrl, token, signal }), tokenSource: source }
}

/**
 * 解析「这次操作针对哪个仓库」。
 *
 * @param ctx - Host 上下文。
 * @param store - 配置存储。
 * @param params - 入参：可含 `serverId` / `owner` / `repo` / `root` / `sessionId`。
 * @param signal - 取消信号。
 * @returns `{ server, owner, repo, source, detected, binding, root }`；`source` 是 `explicit` / `binding` / `detected`。
 * @throws {BridgeError} 400/404 —— 无法唯一定位一个仓库。
 */
export async function resolveRepository(ctx, store, params, signal) {
  const state = await store.snapshot()

  // 1. 显式三件套（缺 owner/repo 时下面还可能用绑定补，所以先记下来）。
  const explicitServerId = typeof params.serverId === 'string' && params.serverId !== '' ? params.serverId : undefined
  const explicitOwner = typeof params.owner === 'string' && params.owner !== '' ? params.owner : undefined
  const explicitRepo = typeof params.repo === 'string' && params.repo !== '' ? params.repo : undefined
  if (explicitServerId !== undefined && explicitOwner !== undefined && explicitRepo !== undefined) {
    return {
      server: requireServer(state, explicitServerId),
      owner: explicitOwner,
      repo: explicitRepo,
      source: 'explicit',
      detected: undefined,
      binding: undefined,
      root: undefined,
    }
  }

  const root = await anyRoot(ctx, params, signal)
  const binding = state.bindings[root]
  const detected = await detectRepository(root)

  // 2. 工作区绑定。
  if (binding !== undefined) {
    const server = requireServer(state, explicitServerId ?? binding.serverId)
    return {
      server,
      owner: explicitOwner ?? binding.owner,
      repo: explicitRepo ?? binding.repo,
      source: 'binding',
      detected,
      binding,
      root,
    }
  }

  // 3. 自动侦测：只认能对上已配置服务器的远端。
  if (detected !== undefined) {
    const server = explicitServerId === undefined
      ? matchServerByHost(state.servers, detected.host)
      : requireServer(state, explicitServerId)
    if (server === undefined) {
      throw new BridgeError(400, 'no-server-for-host', `workspace remote host "${detected.host}" matches no configured server; add one, or bind the workspace manually`)
    }
    return {
      server,
      owner: explicitOwner ?? detected.owner,
      repo: explicitRepo ?? detected.repo,
      source: 'detected',
      detected,
      binding: undefined,
      root,
    }
  }

  throw new BridgeError(400, 'no-binding', `workspace "${root}" is not bound to a repository and no git remote was detected`)
}

/**
 * 给「全局看板」用：按优先级列出要聚合查询的服务器。
 * @param store - 配置存储。
 * @param serverId - 可选：只看这一台。
 * @returns 服务器数组。
 * @throws {BridgeError} 404 —— 指定了不存在的服务器。
 */
export async function serversForBoard(store, serverId) {
  const state = await store.snapshot()
  if (typeof serverId === 'string' && serverId !== '') return [requireServer(state, serverId)]
  if (state.servers.length === 0) return []
  return state.servers
}
