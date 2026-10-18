/**
 * 自动分配的**纯函数**探针：触发判定矩阵。
 *
 * 这里不碰网络、不碰会话、不碰时钟——`lib/triggers.js` 的全部输入都是参数，所以每个边界
 * 都能用一张表钉住。真正容易出错的边界（首次基线、自评、重开、冷却、多类同时命中）都在
 * 这一层，`tests/watch.test.mjs` 只管「拿到触发之后有没有正确地去开会话」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  deliveryBlock,
  describeTrigger,
  markFired,
  planTriggers,
  prefixOf,
} from '../lib/triggers.js'
import { defaultRootWatch, newIssueFact } from '../lib/watchstore.js'

/** 固定的「现在」，免得用例受真实时钟影响。 */
const NOW = Date.parse('2026-10-17T00:00:00.000Z')

/** 造一条出线形状的 issue。 */
function issue(index, overrides = {}) {
  return {
    serverId: 'srv-1',
    owner: 'dongasai',
    repo: 'mylike',
    index,
    title: `第 ${index} 条`,
    state: 'open',
    assignees: [{ login: 'tester' }],
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T12:00:00.000Z',
    ...overrides,
  }
}

/** 造一条出线形状的评论（`issueIndex` 由 `shapeComment` 从 issue_url 派生）。 */
function comment(id, index, login = 'someone', overrides = {}) {
  return {
    id,
    issueIndex: index,
    user: { login },
    createdAt: '2026-10-16T12:00:00.000Z',
    updatedAt: '2026-10-16T12:00:00.000Z',
    ...overrides,
  }
}

/** 跑一次判定，默认配置全开。`login` 显式给 `undefined` 时要真的传下去（不能用默认参数，
 *  否则 JS 会把 `undefined` 替换成默认值，把「认不出我是谁」这条 fail-safe 路径遮住）。 */
function plan(opts) {
  const { facts = {}, issues = [], comments = [], config, firstRun = false } = opts
  const login = Object.hasOwn(opts, 'login') ? opts.login : 'tester'
  return planTriggers({
    prefix: 'srv-1/dongasai/mylike',
    config: { ...defaultRootWatch(), ...(config ?? {}) },
    facts,
    issues,
    comments,
    login,
    now: NOW,
    firstRun,
  })
}

test('首次轮询只建立基线，一条都不投', () => {
  const result = plan({ issues: [issue(1), issue(2)], comments: [comment(10, 1)], firstRun: true })
  assert.deepEqual(result.triggers, [])
  assert.equal(result.facts['srv-1/dongasai/mylike#1'].fired.newAssigned, true)
  // 评论水位也要跟着基线走，否则基线之后第一条评论会被当成「历史」漏掉或重复。
  assert.equal(result.facts['srv-1/dongasai/mylike#1'].lastCommentId, 10)
})

test('账本里没有的 issue = 新指派，触发一次', () => {
  const result = plan({ issues: [issue(1)] })
  assert.equal(result.triggers.length, 1)
  assert.deepEqual(result.triggers[0].kinds, ['newAssigned'])
  assert.equal(result.triggers[0].index, 1)
  assert.equal(result.triggers[0].fingerprints.newAssigned, 'n2026-10-16T00:00:00.000Z')

  // 投递之后再跑一轮：同一件事不该再触发（账本里已经有它了）。
  const fact = result.facts['srv-1/dongasai/mylike#1']
  markFired(fact, result.triggers[0], NOW)
  const again = plan({ facts: result.facts, issues: [issue(1)] })
  assert.deepEqual(again.triggers, [])
})

test('重开：closed → open 触发，且只触发一次', () => {
  const facts = { 'srv-1/dongasai/mylike#7': { ...newIssueFact('closed'), fired: { newAssigned: true, reopened: null, commentId: 0 } } }
  const result = plan({ facts, issues: [issue(7, { state: 'open' })] })
  assert.deepEqual(result.triggers.map((item) => item.kinds), [['reopened']])

  const fact = result.facts['srv-1/dongasai/mylike#7']
  markFired(fact, result.triggers[0], NOW)
  assert.deepEqual(plan({ facts: result.facts, issues: [issue(7, { state: 'open' })] }).triggers, [])
})

test('一直开着不算重开', () => {
  const facts = { 'srv-1/dongasai/mylike#7': { ...newIssueFact('open'), fired: { newAssigned: true, reopened: null, commentId: 0 } } }
  assert.deepEqual(plan({ facts, issues: [issue(7)] }).triggers, [])
})

test('新评论触发一次，并带上是谁评论的', () => {
  const facts = { 'srv-1/dongasai/mylike#3': { ...newIssueFact('open'), fired: { newAssigned: true, reopened: null, commentId: 0 } } }
  const result = plan({ facts, issues: [issue(3)], comments: [comment(21, 3, 'alice')] })
  assert.deepEqual(result.triggers.map((item) => item.kinds), [['newComment']])
  assert.equal(result.triggers[0].actor, 'alice')
  assert.equal(describeTrigger(result.triggers[0]), '（自动分配：有新评论 by @alice）')

  const fact = result.facts['srv-1/dongasai/mylike#3']
  markFired(fact, result.triggers[0], NOW)
  // 同一条评论被水位重叠重新读到：不该再触发。
  assert.deepEqual(plan({ facts: result.facts, issues: [issue(3)], comments: [comment(21, 3, 'alice')] }).triggers, [])
})

test('自己发的评论永不触发（防自激），但水位照样推进', () => {
  const facts = { 'srv-1/dongasai/mylike#3': { ...newIssueFact('open'), fired: { newAssigned: true, reopened: null, commentId: 0 } } }
  const result = plan({ facts, issues: [issue(3)], comments: [comment(21, 3, 'tester')], login: 'tester' })
  assert.deepEqual(result.triggers, [])
  assert.equal(result.facts['srv-1/dongasai/mylike#3'].lastCommentId, 21)
})

test('认不出「我是谁」时不敢判评论触发（fail-safe）', () => {
  const facts = { 'srv-1/dongasai/mylike#3': { ...newIssueFact('open'), fired: { newAssigned: true, reopened: null, commentId: 0 } } }
  const result = plan({ facts, issues: [issue(3)], comments: [comment(21, 3, 'alice')], login: undefined })
  assert.deepEqual(result.triggers, [])
  assert.deepEqual(result.notes, [{ key: 'srv-1/dongasai/mylike#3', kind: 'newComment', reason: 'login-unknown' }])
})

test('没指派给我的 issue 上的评论直接忽略，连事实都不建', () => {
  const result = plan({ issues: [], comments: [comment(21, 99, 'alice')] })
  assert.deepEqual(result.triggers, [])
  assert.deepEqual(Object.keys(result.facts), [])
})

test('一条 issue 同时「被重开」且「有新评论」：合成一条待办，投递时两类一起标掉', () => {
  const facts = { 'srv-1/dongasai/mylike#5': { ...newIssueFact('closed'), fired: { newAssigned: true, reopened: null, commentId: 0 } } }
  const result = plan({ facts, issues: [issue(5, { state: 'open' })], comments: [comment(31, 5, 'bob')] })
  assert.equal(result.triggers.length, 1)
  assert.deepEqual(result.triggers[0].kinds, ['reopened', 'newComment'])
  assert.equal(describeTrigger(result.triggers[0]), '（自动分配：被重新打开了；有新评论 by @bob）')

  // 关键：**两类都要标成已投递**。只标一类的话，另一类下一轮会再触发、白开一个会话。
  const fact = result.facts['srv-1/dongasai/mylike#5']
  markFired(fact, result.triggers[0], NOW)
  assert.equal(fact.fired.reopened, 'r2026-10-16T12:00:00.000Z')
  assert.equal(fact.fired.commentId, 31)
  assert.deepEqual(plan({ facts: result.facts, issues: [issue(5, { state: 'open' })], comments: [comment(31, 5, 'bob')] }).triggers, [])
})

test('待办没投出去时，下一轮仍然在（水位推进不影响它）', () => {
  const first = plan({ issues: [issue(1)] })
  // 模拟「工作区忙」：只落账、不 markFired。
  const second = plan({ facts: first.facts, issues: [issue(1)] })
  assert.deepEqual(second.triggers.map((item) => item.kinds), [['newAssigned']])
  // pendingSince 只在第一次拒绝时记，不被反复刷新（否则 giveUp 的计时永远从头开始）。
  assert.equal(second.triggers[0].pendingSince, first.triggers[0].pendingSince)
})

test('关掉某类触发：既不触发，也不留下待办', () => {
  const facts = { 'srv-1/dongasai/mylike#3': { ...newIssueFact('open'), fired: { newAssigned: true, reopened: null, commentId: 0 } } }
  const result = plan({
    facts,
    issues: [issue(3)],
    comments: [comment(21, 3, 'alice')],
    config: { triggers: { newAssigned: true, reopened: true, newComment: false } },
  })
  assert.deepEqual(result.triggers, [])
  assert.equal(result.facts['srv-1/dongasai/mylike#3'].fired.commentId, 21)
})

test('冷却与单 issue 每日上限挡住投递（纯函数，时钟由参数给）', () => {
  const config = { cooldownSeconds: 600, maxPerIssuePerDay: 2 }
  const fresh = newIssueFact('open')
  assert.equal(deliveryBlock(fresh, config, NOW), null)

  const justDelivered = { ...fresh, deliveredAt: new Date(NOW - 60 * 1000).toISOString() }
  assert.equal(deliveryBlock(justDelivered, config, NOW), 'cooldown')

  const cooledDown = { ...fresh, deliveredAt: new Date(NOW - 601 * 1000).toISOString() }
  assert.equal(deliveryBlock(cooledDown, config, NOW), null)

  const day = new Date(NOW).toISOString().slice(0, 10)
  const maxed = { ...cooledDown, dailyCount: { day, n: 2 } }
  assert.equal(deliveryBlock(maxed, config, NOW), 'daily')
  // 跨天要归零：昨天的计数不能压住今天。
  assert.equal(deliveryBlock({ ...maxed, dailyCount: { day: '2026-10-16', n: 9 } }, config, NOW), null)
})

test('markFired 会累加当日计数、清掉待办、写投递时刻', () => {
  const fact = newIssueFact('open')
  const trigger = { kinds: ['newAssigned'], fingerprints: { newAssigned: 'n1' } }
  markFired(fact, trigger, NOW)
  const day = new Date(NOW).toISOString().slice(0, 10)
  assert.deepEqual(fact.dailyCount, { day, n: 1 })
  assert.equal(fact.pending, null)
  assert.equal(fact.pendingSince, null)
  assert.equal(fact.deliveredAt, new Date(NOW).toISOString())
  markFired(fact, trigger, NOW)
  assert.deepEqual(fact.dailyCount, { day, n: 2 })
})

test('prefixOf 与 issueKey 拼法一致（一处拼错就是整仓库查错）', () => {
  assert.equal(prefixOf({ serverId: 'srv-1', owner: 'o', repo: 'r' }), 'srv-1/o/r')
})
