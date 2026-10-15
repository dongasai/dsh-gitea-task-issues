/**
 * 静态契约校验：把浏览器半边的注册面拿去和**真实槽位目录**对照。
 *
 * 为什么值得单独一个用例：`slots.register` 传错键、或漏掉该基数要求的注册项（keyed 要 `key`、
 * list 要 `id`），在真机上表现为「界面什么都不出来」或加载期直接抛 —— 而本机有官方发布的
 * 槽位目录（`cordis_inspect what:"client"` 的数据源），可以离线核对。
 *
 * 目录来自本机 DSH 安装；找不到时跳过（换机器不该因此红）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { instantiate } from './load-bundle.mjs'
import { loadSlotCatalog } from '../tools/slot-contract.mjs'

/** 把 bundle 的注册面抓出来（只需要注册，不需要渲染）。 */
async function captureRegistrations() {
  const { entries, path } = loadSlotCatalog()
  if (path === undefined) return { catalog: null }

  const { plugin } = await instantiate()
  const slots = []
  const tabs = []
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject(names, fn) { if (names.includes('shortcuts')) fn(ctx) },
    locale: { register() {}, bind: () => (key) => key },
    slots: {
      inject(name, register) { register(); return () => {} },
      register(options, component) { slots.push({ options, component }); return () => {} },
    },
    sidebarRightTabs: { register(definition) { tabs.push(definition); return () => {} } },
    sidebarRight: { commandTarget: () => undefined, openTabFromTarget() {} },
    shortcuts: { register() {} },
  }
  plugin.apply(ctx)
  return { catalog: entries, slots, tabs }
}

test('槽位键都在官方目录里，且注册项满足该槽位的基数要求', async () => {
  const { catalog, slots, tabs } = await captureRegistrations()
  if (catalog === null) {
    console.log('skip: 本机找不到客户端槽位目录')
    return
  }
  const byKey = new Map(catalog.map((entry) => [entry.key, entry]))

  for (const entry of slots) {
    const key = entry.options.name
    const slot = byKey.get(key)
    assert.ok(slot, `槽位 "${key}" 不在官方目录里`)
    const required = slot.options.filter((option) => option.requirement === 'required').map((option) => option.name)
    for (const name of required) {
      assert.ok(entry.options[name] !== undefined, `槽位 "${key}"（${slot.kind}）缺少必需的注册项 "${name}"`)
    }
    // 反方向：keyed 槽位不该收到 `id`，list 槽位不该收到 `key`（传了也没用，属于抄错模板）。
    const allowed = new Set(['name', 'locale', 'inject', 'order', 'label', ...slot.options.map((option) => option.name)])
    for (const name of Object.keys(entry.options)) {
      assert.ok(allowed.has(name), `槽位 "${key}" 不接受注册项 "${name}"`)
    }
  }

  // 右侧栏页签类型：kind/id 必填，且必须是页类型（不能有 patterns）。
  assert.equal(tabs.length, 1)
  for (const definition of tabs) {
    assert.equal(typeof definition.id, 'string')
    assert.equal(typeof definition.kind, 'string')
    assert.equal(definition.patterns, undefined, '页类型不该声明 patterns')
    assert.equal(typeof definition.title, 'function')
  }
})

test('注册的 main 键不是官方保留键，面板 id 不撞官方条目', async () => {
  const { catalog, slots } = await captureRegistrations()
  if (catalog === null) return
  const main = catalog.find((entry) => entry.key === 'main')
  assert.ok(main, '官方目录里应当有 main')
  assert.match(main.body, /already taken: conversation/, 'main 的保留键是 conversation，用来核对本用例的前提')

  const panel = slots.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(panel.options.id, 'gitea-issues')
  assert.ok(panel.options.order > 10, '必须排在官方「自动化任务」的 order 10 之后')
})
