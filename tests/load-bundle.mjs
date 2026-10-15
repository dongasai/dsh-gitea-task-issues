/**
 * 加载浏览器半边：假 `window.__ModuleLoader__` + 假 `fetch` + 迷你 React。
 *
 * 单独一个模块是因为两个用例文件都要用它（注册面校验与渲染/交互校验），
 * 而 ESM 的 import 缓存保证 bundle 只被求值一次。
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

import { bridgeAnswer } from './fixtures.mjs'
import { createMiniReact } from './mini-react.mjs'

/** bundle 向 `__ModuleLoader__` 注册的那份 spec。 */
let registered
let imported = false

/**
 * 装好假环境（只做一次）。
 * @returns bundle 的注册 spec。
 */
async function ensureBundle() {
  if (imported) return registered
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        registered = spec
      },
    },
    confirm: () => true,
  }
  globalThis.btoa = (text) => Buffer.from(text, 'binary').toString('base64')
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    const payload = bridgeAnswer(body.op, body.params)
    return { ok: payload.ok, status: payload.ok ? 200 : 400, json: async () => payload }
  }
  await import(pathToFileURL(new URL('../client.js', import.meta.url).pathname).href)
  imported = true
  assert.ok(registered, 'bundle 没有向 __ModuleLoader__ 注册')
  assert.equal(registered.id, '@dongasai/dsh-gitea-task-issues')
  return registered
}

/**
 * 新建一个用例用的插件实例。
 *
 * 关键：`plugin` 与 `mini` 必须来自**同一次**装配 —— bundle 里 `require('react')` 拿到的
 * 必须是渲染时用的那个实例，否则 hook 会写进一份没人读的槽位表（这个坑踩过一次）。
 *
 * @returns `{ plugin, mini }`。
 */
export async function instantiate() {
  const spec = await ensureBundle()
  const mini = createMiniReact()
  const plugin = spec.factory((name) => {
    if (name === 'react') return mini.React
    throw new Error(`unexpected require("${name}")`)
  })
  return { plugin, mini }
}
