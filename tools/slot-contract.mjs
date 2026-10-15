#!/usr/bin/env node
/**
 * 从本机 DSH 安装里抽出客户端槽位契约（`CLIENT_SLOT_API`）。
 *
 * 这份目录是官方给模型看的编译期契约（运行时以 `cordis_inspect what:"client"` 提供），
 * 打包后只剩一份压缩过的 JS 数据；这里把它按 key 打印出来，便于照着写注册代码。
 *
 * 本仓库不在 profile 的 node_modules 树里（`link:` 安装 + realpath 解析），
 * 所以不能 `import '@deepseek-ai/...'`，只能按候选路径直接找文件。
 *
 * 用法：
 *   node tools/slot-contract.mjs                    # 列出全部 key
 *   node tools/slot-contract.mjs main sidebar.panellist
 *
 * 也作为模块被 `tests/catalog.test.mjs` 复用（`loadSlotCatalog()`）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const RELATIVE = 'node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js'

/** 候选安装位置：显式覆盖 → profile 树 → npx 缓存。 */
function candidates() {
  const list = []
  if (process.env.DSH_SLOT_CATALOG) list.push(process.env.DSH_SLOT_CATALOG)
  if (process.env.DSH_PROFILE_DIR) list.push(join(process.env.DSH_PROFILE_DIR, '..', RELATIVE))
  const home = homedir()
  list.push(join(home, '.dsh/profiles', RELATIVE))
  const npx = join(home, '.npm/_npx')
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) list.push(join(npx, entry, RELATIVE))
  }
  return list
}

/**
 * 读出槽位目录。
 * @returns `{ path, entries }`；找不到安装返回 `{ path: undefined, entries: [] }`。
 */
export function loadSlotCatalog() {
  const found = candidates().find((path) => existsSync(path))
  if (found === undefined) return { path: undefined, entries: [] }
  const source = readFileSync(found, 'utf8')
  const start = source.indexOf('const CLIENT_SLOT_API = [')
  const end = source.indexOf('//#endregion', start)
  const entries = source.slice(start, end)
    .split(/\n\t\t\t\{\n/)
    .slice(1)
    .map((body) => {
      const key = /key: "([^"]+)"/.exec(body)?.[1]
      const kind = /kind: "([^"]+)"/.exec(body)?.[1]
      const scope = /scope: "([^"]+)"/.exec(body)?.[1]
      const optionNames = [...body.matchAll(/name: "([^"]+)",\n\t+requirement: "(\w+)"/g)]
        .map((match) => ({ name: match[1], requirement: match[2] }))
      return { key, kind, scope, options: optionNames, body }
    })
    .filter((entry) => entry.key !== undefined)
  return { path: found, entries }
}

/** 直接运行时的 CLI。 */
function main() {
  const { path, entries } = loadSlotCatalog()
  if (path === undefined) {
    console.error('no slot catalog found; set DSH_SLOT_CATALOG=/path/to/dsh-cordis-client-runner/lib/client.js')
    process.exitCode = 1
    return
  }
  const wanted = process.argv.slice(2)
  if (wanted.length === 0) {
    for (const entry of entries) console.log(entry.key)
    return
  }
  for (const key of wanted) {
    const hit = entries.find((entry) => entry.key === key)
    console.log(hit === undefined ? `(no such slot: ${key})` : `===== ${key} =====\n${hit.body}\n`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
