/**
 * @module lib/detect
 *
 * 「工作区 ↔ 仓库」的自动侦测：从工作区根往上找 `.git`，读 `config` 里的 remote URL，
 * 拆出 `host / owner / repo`，再和已配置的服务器按主机名配对。
 *
 * 为什么读 `.git/config` 而不跑 `git remote get-url`：
 * 1. 不需要子进程，也就不需要 PATH、不需要在只读沙箱里找可执行文件；
 * 2. 不触发任何 git 钩子 / 仓库锁；
 * 3. 失败面小 —— 读不到就当「没侦测到」，由用户在界面上手填。
 *
 * 支持 worktree / submodule：`.git` 是文件时按 `gitdir: <路径>` 转一次再读。
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

/** 往上找 `.git` 的层数上限，防止在极深目录里一路走到根。 */
const MAX_ASCENT = 32

/**
 * 拆一个 git remote URL。
 *
 * 认这几种写法：
 * - `https://host/owner/repo.git`、`http://host:3000/a/b/c`
 * - `git@host:owner/repo.git`（scp 风格）
 * - `ssh://git@host:2222/owner/repo.git`、`git://host/owner/repo.git`
 *
 * @param raw - remote URL 原文。
 * @returns `{ host, hostname, path, owner, repo }`；认不出来返回 undefined。
 */
export function parseGitRemoteUrl(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '') return undefined
  let host
  let pathname
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(text)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && scp !== null) {
    host = scp[1]
    pathname = scp[2]
  } else {
    let url
    try {
      url = new URL(text)
    } catch {
      return undefined
    }
    host = url.host
    pathname = url.pathname
  }
  const path = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (path === '' || path.split('/').length < 2) return undefined
  const segments = path.split('/')
  const repo = segments.pop()
  const owner = segments.join('/')
  if (repo === undefined || repo === '' || owner === '') return undefined
  return { host, hostname: host.split(':')[0], path, owner, repo }
}

/**
 * 解析 git config 文本里的 remote URL。只要 `[remote "名字"]` 段里的 `url`。
 * @param text - `.git/config` 的内容。
 * @returns 远端名 → URL；顺序即文件里的出现顺序。
 */
export function parseGitRemotes(text) {
  const remotes = new Map()
  let current
  for (const line of String(text).split(/\r?\n/)) {
    const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line)
    if (section !== null) {
      current = section[1]
      continue
    }
    if (/^\s*\[/.test(line)) {
      current = undefined
      continue
    }
    if (current === undefined) continue
    const entry = /^\s*url\s*=\s*(.*)$/.exec(line)
    if (entry !== null && !remotes.has(current)) remotes.set(current, entry[1].trim())
  }
  return remotes
}

/**
 * 在某个目录上找 git 仓库根。
 * @param start - 起始目录（工作区根）。
 * @returns `{ gitDir, workTree }`，没找到返回 undefined。
 */
async function findGitDir(start) {
  let directory = resolve(start)
  for (let step = 0; step < MAX_ASCENT; step += 1) {
    const dotGit = resolve(directory, '.git')
    let info
    try {
      info = await stat(dotGit)
    } catch {
      info = undefined
    }
    if (info !== undefined) {
      if (info.isDirectory()) return { gitDir: dotGit, workTree: directory }
      // worktree / submodule：`.git` 是一个文本文件，写着 `gitdir: <路径>`。
      const pointer = await readFile(dotGit, 'utf8').catch(() => undefined)
      const match = pointer === undefined ? null : /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer)
      if (match !== null) {
        const target = match[1]
        const gitDir = isAbsolute(target) ? target : resolve(directory, target)
        return { gitDir, workTree: directory }
      }
      return undefined
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

/**
 * 侦测一个工作区对应的仓库。
 * @param workspaceRoot - 工作区根（会话的 cwd）。
 * @returns `{ workspaceRoot, workTree, gitDir, remoteName, remoteUrl, host, hostname, owner, repo }`，没侦测到返回 undefined。
 */
export async function detectRepository(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') return undefined
  const found = await findGitDir(workspaceRoot)
  if (found === undefined) return undefined
  const config = await readFile(resolve(found.gitDir, 'config'), 'utf8').catch(() => undefined)
  if (config === undefined) return undefined
  const remotes = parseGitRemotes(config)
  if (remotes.size === 0) return undefined
  const remoteName = remotes.has('origin') ? 'origin' : [...remotes.keys()][0]
  const remoteUrl = remotes.get(remoteName)
  const parsed = parseGitRemoteUrl(remoteUrl)
  if (parsed === undefined) return undefined
  return {
    workspaceRoot: resolve(workspaceRoot),
    workTree: found.workTree,
    gitDir: found.gitDir,
    remoteName,
    remoteUrl,
    host: parsed.host,
    hostname: parsed.hostname,
    owner: parsed.owner,
    repo: parsed.repo,
  }
}

/**
 * 把一个远端 host 配上已配置的服务器。
 * 先按 `host:port` 全等配，再退回按主机名配（https 的 default port 与 ssh 的 22 都不是同一回事，
 * 但对同一个 Gitea 实例来说主机名足够定位）。
 * @param servers - 服务器清单。
 * @param host - 远端 host（可能带端口）。
 * @returns 命中的服务器，或 undefined。
 */
export function matchServerByHost(servers, host) {
  if (typeof host !== 'string' || host === '') return undefined
  const hostname = host.split(':')[0]
  for (const server of servers) {
    let url
    try {
      url = new URL(server.baseUrl)
    } catch {
      continue
    }
    if (url.host === host) return server
  }
  for (const server of servers) {
    let url
    try {
      url = new URL(server.baseUrl)
    } catch {
      continue
    }
    if (url.hostname === hostname) return server
  }
  return undefined
}
