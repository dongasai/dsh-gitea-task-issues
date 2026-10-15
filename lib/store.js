/**
 * @module lib/store
 *
 * 插件自有的**非机密**配置：Gitea 服务器清单、工作区↔仓库绑定、默认服务器。
 *
 * 令牌**不在这里** —— 它走 DSH 的 credentials record（`lib/secrets.js`），
 * 所以这份文件可以随便看、随便备份、随便贴进 issue。
 *
 * 落盘两条规矩：
 * 1. **原子替换**：先写同目录临时文件再 `rename`，进程被杀不会留下半个 JSON。
 * 2. **串行写入**：同一进程里所有变更走一条 Promise 链，`revision` 单调递增，
 *    给 UI 的乐观并发当基线（`expectedRevision` 对不上就拒绝，不做静默覆盖）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { BridgeError } from './errors.js'

/** 配置文件结构版本；加字段不改它，改语义才动。 */
export const STORE_VERSION = 1

/** 插件的稳定标识：配置目录名、credential record 的 scope、桥路径前缀都用它。 */
export const PLUGIN_SCOPE = 'gitea-task-issues'

/** 服务器 id 的合法形状（同时要满足 credential key 的段语法 `^[a-z][a-z0-9-]*$`）。 */
const SERVER_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * DSH 数据根：显式 `$DSH_HOME` 优先，空白视作没有，否则 `~/.dsh`。
 * 与 `@deepseek-ai/dsh-home-paths` 的解析规则一致（此处不 import，见 README「为什么 Host 只 import node:」）。
 * @returns 数据根绝对路径。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 配置文件路径。
 * @returns `$DSH_HOME/gitea-task-issues/servers.json`。
 */
export function storeFile() {
  return join(dshHome(), PLUGIN_SCOPE, 'servers.json')
}

/**
 * 空白配置。
 * @returns 全新的配置状态。
 */
export function emptyState() {
  return { version: STORE_VERSION, revision: 0, defaultServerId: null, servers: [], bindings: {} }
}

/**
 * 规范化服务器地址：补协议、去掉查询串与末尾斜杠、保留子路径（Gitea 常挂在 `/gitea` 下）。
 * @param raw - 用户输入的地址。
 * @returns 规范化后的绝对地址（无尾斜杠）。
 * @throws {BridgeError} 400 —— 不是 http(s) 地址。
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BridgeError(400, 'bad-request', 'baseUrl must be a non-empty string')
  }
  const text = raw.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new BridgeError(400, 'bad-request', `baseUrl "${raw}" is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BridgeError(400, 'bad-request', 'baseUrl must use http or https')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/**
 * 拆 `owner/repo`。
 * @param raw - 形如 `dongasai/mylike` 的字符串。
 * @returns 拆好的两部分。
 * @throws {BridgeError} 400 —— 形状不对。
 */
export function parseRepoSpec(raw) {
  if (typeof raw !== 'string') throw new BridgeError(400, 'bad-request', 'repo must be a string')
  const text = raw.trim().replace(/^\/+|\/+$/g, '')
  const cut = text.lastIndexOf('/')
  if (cut <= 0 || cut === text.length - 1) {
    throw new BridgeError(400, 'bad-request', `repo "${raw}" must look like "owner/name"`)
  }
  return { owner: text.slice(0, cut), repo: text.slice(cut + 1) }
}

/**
 * 生成一个没用过的服务器 id。
 * 形状必须同时满足 credential key 的段语法，所以固定小写 + 数字 + 连字符。
 * @param taken - 已占用的 id 集合。
 * @returns 新 id。
 */
export function makeServerId(taken) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = `srv-${Math.random().toString(16).slice(2, 10)}`
    if (!taken.has(candidate)) return candidate
  }
  throw new BridgeError(500, 'server-id-exhausted', 'could not allocate a free server id')
}

/**
 * 规范化工作区根：去掉末尾分隔符（`/data/a/` → `/data/a`）。
 * @param raw - 工作区根。
 * @returns 规范化后的键。
 */
export function normalizeRoot(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BridgeError(400, 'bad-request', 'workspace root must be a non-empty string')
  }
  const text = raw.trim().replace(/[\\/]+$/, '')
  return text === '' ? '/' : text
}

/**
 * 校验并规范化「添加/修改服务器」的输入。
 * @param input - 请求体片段。
 * @returns 校验后的字段（不含 id）。
 * @throws {BridgeError} 400 —— 任一字段不合法。
 */
export function normalizeServerInput(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BridgeError(400, 'bad-request', 'server must be a JSON object')
  }
  const name = typeof input.name === 'string' && input.name.trim() !== ''
    ? input.name.trim()
    : undefined
  if (name === undefined) throw new BridgeError(400, 'bad-request', 'server name must be a non-empty string')
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const tokenEnv = input.tokenEnv === undefined || input.tokenEnv === null || input.tokenEnv === ''
    ? null
    : String(input.tokenEnv).trim()
  if (tokenEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new BridgeError(400, 'bad-request', `tokenEnv "${tokenEnv}" is not an environment variable name`)
  }
  return { name, baseUrl, tokenEnv }
}

/**
 * 深拷贝一份配置（`structuredClone` 在 Node 18+ 是全局的，且这里的数据一定可克隆）。
 * @param value - 任意配置值。
 * @returns 拷贝。
 */
function clone(value) {
  return structuredClone(value)
}

/**
 * 把磁盘上的任意内容收敛成合法状态：缺字段补默认，多余字段保留（向前兼容）。
 * @param raw - 从 JSON 读到的值。
 * @returns 合法状态。
 */
function coerceState(raw) {
  const base = emptyState()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const state = { ...base, ...raw }
  if (!Array.isArray(state.servers)) state.servers = []
  state.servers = state.servers.filter((server) => typeof server === 'object' && server !== null && typeof server.id === 'string')
  if (typeof state.bindings !== 'object' || state.bindings === null || Array.isArray(state.bindings)) state.bindings = {}
  if (typeof state.revision !== 'number' || !Number.isFinite(state.revision)) state.revision = 0
  state.version = STORE_VERSION
  return state
}

/**
 * 串行化的配置存储。一个实例对应一个文件；`apply` 只建一次，随插件同生命周期。
 */
export class ConfigStore {
  /**
   * @param file - 配置文件路径。
   * @param logger - 可选日志口（写坏文件、写盘失败时用）。
   */
  constructor(file, logger) {
    /** 配置文件路径。 */
    this.file = file
    /** 日志口。 */
    this.logger = logger
    /** 内存态；`undefined` 表示还没读过盘。 */
    this.state = undefined
    /** 串行链：所有读改写排在同一条 Promise 上。 */
    this.queue = Promise.resolve()
    /** 临时文件计数，保证同进程并发写不撞名。 */
    this.writes = 0
  }

  /**
   * 读一次盘（带缓存）。文件不存在按空白配置处理；读坏了先留档再按空白配置走。
   * @returns 当前状态（内部引用，调用方不要改）。
   */
  async load() {
    if (this.state !== undefined) return this.state
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.state = emptyState()
        return this.state
      }
      throw error
    }
    try {
      this.state = coerceState(JSON.parse(text))
    } catch (error) {
      // 读坏的文件不删、不悄悄覆盖：挪到一边留证据，再按空白配置继续。
      const aside = `${this.file}.corrupt-${Date.now()}`
      this.logger?.warn?.(`gitea-task-issues: ${this.file} is not valid JSON; moved to ${aside}`)
      await rename(this.file, aside).catch(() => undefined)
      this.state = emptyState()
    }
    return this.state
  }

  /**
   * 取一份可安全外发的快照（深拷贝）。
   * @returns 配置快照。
   */
  async snapshot() {
    return clone(await this.load())
  }

  /**
   * 读改写一条龙：串行执行 `recipe`，成功后原子落盘。
   * @param recipe - 拿到可改写的状态副本，就地修改；抛错则整笔不落盘。
   * @param options - `expectedRevision` 给 UI 的乐观并发当基线。
   * @returns 落盘后的状态快照。
   */
  async mutate(recipe, options = {}) {
    const run = async () => {
      const current = await this.load()
      if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
        throw new BridgeError(409, 'stale-config', `configuration changed (revision ${current.revision} ≠ ${options.expectedRevision}); reload and retry`)
      }
      const draft = clone(current)
      recipe(draft)
      draft.version = STORE_VERSION
      draft.revision = current.revision + 1
      await this.#write(draft)
      this.state = draft
      return clone(draft)
    }
    const next = this.queue.then(run, run)
    // 队列只关心「上一笔结束了」，所以吞掉这一笔的失败，别让一次 409 卡死后面所有写入。
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * 原子落盘：临时文件 + `rename`。
   * @param state - 要写的状态。
   * @returns 写盘完成。
   */
  async #write(state) {
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true })
    this.writes += 1
    const temporary = `${this.file}.${process.pid}.${this.writes}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
  }
}

/**
 * 从状态里按 id 找服务器。
 * @param state - 配置快照。
 * @param id - 服务器 id。
 * @returns 服务器记录，或 undefined。
 */
export function findServer(state, id) {
  return state.servers.find((server) => server.id === id)
}

/**
 * 校验服务器 id 的形状并存在性检查。
 * @param state - 配置快照。
 * @param id - 服务器 id。
 * @returns 找到的服务器。
 * @throws {BridgeError} 400/404。
 */
export function requireServer(state, id) {
  if (typeof id !== 'string' || !SERVER_ID_PATTERN.test(id)) {
    throw new BridgeError(400, 'bad-request', `server id "${String(id)}" must match ${String(SERVER_ID_PATTERN)}`)
  }
  const server = findServer(state, id)
  if (server === undefined) throw new BridgeError(404, 'unknown-server', `no server "${id}" in this configuration`)
  return server
}
