/**
 * @module lib/secrets
 *
 * Gitea 令牌的存放处。**令牌绝不进 `servers.json`**：
 *
 * 1. 首选 DSH 的 credentials service 的 **record**（`<scope>/<id>`），落盘在
 *    `.credentials.yaml`，界面只能看「配没配、可不可写」，看不到值；
 * 2. 兼容「环境变量」这一路：服务器记录里可以写 `tokenEnv: GITEA_TOKEN`，
 *    进程环境里有值就直接用（CI / 容器场景），此时页面上会显示它来自环境、不可写。
 *
 * 两条都没有时，工具与界面都会明确报 `token-missing`，而不是发一个匿名请求去撞 401。
 *
 * 这里不 import `@deepseek-ai/dsh-credentials`（插件以 `link:` 装进 profile，
 * 裸包名解析不到，见 README「为什么 Host 只 import node:」），因此 record key 自己拼。
 * 段语法与官方一致：`^[a-z][a-z0-9-]*$`，服务器 id 的生成规则已经保证这一点。
 */
import { BridgeError } from './errors.js'

/** credential record 的 scope；与插件 id 一致。 */
export const CREDENTIAL_SCOPE = 'gitea-task-issues'

/** credential key 的单段语法（照抄官方 `KEY_SEGMENT_PATTERN`）。 */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * 拼某个服务器的 record key。
 * @param serverId - 服务器 id。
 * @returns `<scope>/<serverId>`。
 * @throws {BridgeError} 500 —— id 形状不该出现（生成侧已经保证）。
 */
export function credentialKeyFor(serverId) {
  if (!KEY_SEGMENT_PATTERN.test(String(serverId))) {
    throw new BridgeError(500, 'bad-server-id', `server id "${String(serverId)}" cannot address a credential record`)
  }
  return `${CREDENTIAL_SCOPE}/${serverId}`
}

/**
 * 取 credentials service。它不在（极简装配）时返回 undefined，由调用方降级。
 * @param ctx - Host 上下文。
 * @returns credentials provider，或 undefined。
 */
export function credentialProvider(ctx) {
  try {
    return ctx.get('credentials')
  } catch {
    return undefined
  }
}

/**
 * 解析一个服务器此刻可用的令牌。
 * @param ctx - Host 上下文。
 * @param server - 服务器记录。
 * @returns `{ token, source }`；没有则 `{ token: undefined, source: undefined }`。
 */
export async function resolveToken(ctx, server) {
  if (typeof server.tokenEnv === 'string' && server.tokenEnv !== '') {
    const fromEnv = process.env[server.tokenEnv]
    if (typeof fromEnv === 'string' && fromEnv !== '') {
      return { token: fromEnv, source: `env:${server.tokenEnv}` }
    }
  }
  const credentials = credentialProvider(ctx)
  if (credentials === undefined) return { token: undefined, source: undefined }
  const record = await credentials.readRecord(credentialKeyFor(server.id))
  if (record === undefined || record.kind !== 'api-key') return { token: undefined, source: undefined }
  const key = typeof record.key === 'string' && record.key !== '' ? record.key : undefined
  return { token: key, source: key === undefined ? undefined : 'record' }
}

/**
 * 令牌状态（给界面看，不含值）。
 * @param ctx - Host 上下文。
 * @param server - 服务器记录。
 * @returns `{ configured, source, writable }`。
 */
export async function tokenStatus(ctx, server) {
  const { token, source } = await resolveToken(ctx, server)
  const credentials = credentialProvider(ctx)
  let writable = credentials !== undefined
  if (credentials !== undefined) {
    try {
      const info = await credentials.describeRecord(credentialKeyFor(server.id))
      writable = info.writable
    } catch {
      writable = false
    }
  }
  return { configured: token !== undefined, source: source ?? null, writable }
}

/**
 * 写入令牌。
 * @param ctx - Host 上下文。
 * @param serverId - 服务器 id。
 * @param token - 令牌原文。
 * @returns 无。
 * @throws {BridgeError} 400 —— 令牌为空；503 —— 这台 Host 没有凭据中心。
 */
export async function setToken(ctx, serverId, token) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new BridgeError(400, 'bad-request', 'token must be a non-empty string')
  }
  const credentials = credentialProvider(ctx)
  if (credentials === undefined) {
    throw new BridgeError(503, 'credentials-unavailable', 'this host has no credential store; configure the token through an environment variable instead')
  }
  const key = credentialKeyFor(serverId)
  try {
    await credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: token.trim() }))
  } catch (error) {
    throw new BridgeError(500, 'credentials-write-failed', `could not store the token: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 删除令牌记录（服务器被删、或用户清空令牌时）。
 * @param ctx - Host 上下文。
 * @param serverId - 服务器 id。
 * @returns 无。
 */
export async function clearToken(ctx, serverId) {
  const credentials = credentialProvider(ctx)
  if (credentials === undefined) return
  await credentials.deleteRecord(credentialKeyFor(serverId)).catch(() => undefined)
}
