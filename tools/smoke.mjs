#!/usr/bin/env node
/**
 * 对**真实 Gitea 实例**的只读冒烟：用插件自己的操作表打一遍，确认路径与参数在真机上成立。
 *
 * 为什么需要它：本地探针用的是假 Gitea，字段名与路径是照 swagger 抄的；真机可能版本不同、
 * 可能没开某些能力（时间追踪、依赖关系）。这个脚本只发 **GET**，不建不删不改，可以随时跑。
 *
 * 用法（令牌只从参数或环境变量来，绝不落盘、绝不打印）：
 *   GITEA_BASE_URL=https://tea.example.com GITEA_TOKEN=xxx node tools/smoke.mjs
 *   node tools/smoke.mjs https://tea.example.com xxx
 *
 * 退出码：全部通过 0；有失败 1。
 */
import { createGiteaClient, runOperation } from '../lib/gitea.js'
import { shapeIssue, shapeRepo, shapeUser } from '../lib/shape.js'

/** 读参数：位置参数优先，其次环境变量。 */
function readArgs() {
  const [baseArg, tokenArg] = process.argv.slice(2)
  const baseUrl = (baseArg ?? process.env.GITEA_BASE_URL ?? '').replace(/\/+$/, '')
  const token = tokenArg ?? process.env.GITEA_TOKEN ?? ''
  if (baseUrl === '' || token === '') {
    console.error('usage: GITEA_BASE_URL=... GITEA_TOKEN=... node tools/smoke.mjs   （或两个位置参数）')
    process.exit(2)
  }
  return { baseUrl, token }
}

/** 一行结果。 */
function report(name, status, detail) {
  const mark = status === 'ok' ? '✔' : (status === 'skip' ? '·' : '✖')
  console.log(`${mark} ${name.padEnd(28)} ${detail}`)
}

/**
 * 跑一条只读操作。
 * @param client - Gitea 客户端。
 * @param name - 操作名。
 * @param params - 参数。
 * @param summary - 成功时怎么描述结果。
 * @returns `{ ok, data }`。
 */
async function probe(client, name, params, summary) {
  try {
    const { data, total } = await runOperation(client, name, params, AbortSignal.timeout(20000))
    report(name, 'ok', summary(data, total))
    return { ok: true, data }
  } catch (error) {
    // 「没开这个能力」不算路径错：403/404 在时间追踪、依赖、订阅上很常见。
    const soft = error?.code === 'forbidden' || error?.code === 'not-found'
    report(name, soft ? 'skip' : 'fail', `${error?.code ?? 'error'}: ${error?.message ?? String(error)}`)
    return { ok: false, data: undefined }
  }
}

const { baseUrl, token } = readArgs()
const client = createGiteaClient({ baseUrl, token, userAgent: 'dsh-gitea-task-issues/smoke' })
let failures = 0
const track = (result) => { if (!result.ok) failures += 1 }

console.log(`# 只读冒烟：${baseUrl}\n`)

const version = await probe(client, 'server.version', {}, (data) => `Gitea ${data?.version ?? '?'}`)
const me = await probe(client, 'server.user', {}, (data) => {
  const user = shapeUser(data)
  return user === undefined ? '（无法解析用户）' : `@${user.login}`
})
if (!me.ok) failures += 1

// 挑一个**有 issue 的**仓库：跨仓库搜索里拿一条 issue，用它的仓库当目标；
// 没有 issue 就退回「我拥有的第一个仓库」，只跑仓库级端点。
let repo = undefined
let seedIssue = undefined
const search = await probe(client, 'issue.search', { state: 'all', limit: 10 }, (data) => {
  const issues = Array.isArray(data) ? data : []
  const first = issues.length > 0 ? shapeIssue(issues[0]) : undefined
  return `${issues.length} 条${first === undefined ? '' : `，首条 ${first.owner}/${first.repo}#${first.index}`}`
})
if (search.ok && Array.isArray(search.data)) {
  for (const raw of search.data) {
    const shaped = shapeIssue(raw)
    if (shaped !== undefined && shaped.isPull !== true && shaped.owner !== null && shaped.repo !== null) {
      seedIssue = shaped
      break
    }
  }
}
if (seedIssue !== undefined) {
  repo = { owner: seedIssue.owner, repo: seedIssue.repo, fullName: `${seedIssue.owner}/${seedIssue.repo}` }
} else {
  const mine = await probe(client, 'repo.mine', { limit: 20 }, (data, total) => `${Array.isArray(data) ? data.length : 0} 个${total === undefined ? '' : `（共 ${total}）`}`)
  if (mine.ok && Array.isArray(mine.data) && mine.data.length > 0) repo = shapeRepo(mine.data[0])
}
if (repo === undefined) {
  console.log('\n没有可见仓库，停在这里（后面的用例都需要一个仓库）。')
  process.exit(failures > 0 ? 1 : 0)
}
const target = { owner: repo.owner, repo: repo.repo }
console.log(`\n# 用仓库 ${repo.fullName} 继续\n`)

track(await probe(client, 'repo.get', target, (data) => {
  const shaped = shapeRepo(data)
  return `${shaped?.fullName ?? '?'} issues=${shaped?.hasIssues ?? '?'} default=${shaped?.defaultBranch ?? '?'}`
}))
track(await probe(client, 'repo.labels', { ...target, limit: 20 }, (data) => `${Array.isArray(data) ? data.length : 0} 个标签`))
track(await probe(client, 'repo.milestones', { ...target, state: 'all', limit: 20 }, (data) => `${Array.isArray(data) ? data.length : 0} 个里程碑`))
track(await probe(client, 'repo.assignees', target, (data) => `${Array.isArray(data) ? data.length : 0} 个可指派用户`))

const list = await probe(client, 'issue.list', { ...target, state: 'all', limit: 10 }, (data, total) => {
  const issues = Array.isArray(data) ? data : []
  const first = issues.length > 0 ? shapeIssue(issues[0], target) : undefined
  return `${issues.length} 条${total === undefined ? '' : `（共 ${total}）`}${first === undefined ? '' : `，首条 #${first.index} ${first.state}`}`
})
track(list)
const issues = list.ok && Array.isArray(list.data) ? list.data : []
const picked = (seedIssue !== undefined && seedIssue.owner === target.owner && seedIssue.repo === target.repo)
  ? seedIssue
  : issues.map((issue) => shapeIssue(issue, target)).find((issue) => issue !== undefined && issue.isPull !== true)
if (picked === undefined) {
  console.log('\n这个仓库没有可用的 issue，跳过 issue 级端点。')
  process.exit(failures > 0 ? 1 : 0)
}
const issueTarget = { ...target, index: picked.index }
console.log(`\n# 用 issue #${picked.index} 继续\n`)

track(await probe(client, 'issue.get', issueTarget, (data) => {
  const shaped = shapeIssue(data, target)
  return `#${shaped?.index} ${shaped?.state} 标签 ${shaped?.labels.length ?? 0} 评论 ${shaped?.comments ?? 0}`
}))
track(await probe(client, 'issue.comments.list', issueTarget, (data) => `${Array.isArray(data) ? data.length : 0} 条评论`))
track(await probe(client, 'issue.timeline', { ...issueTarget, limit: 10 }, (data) => `${Array.isArray(data) ? data.length : 0} 个时间线条目`))
track(await probe(client, 'issue.assets.list', issueTarget, (data) => `${Array.isArray(data) ? data.length : 0} 个附件`))
track(await probe(client, 'issue.times.list', issueTarget, (data) => `${Array.isArray(data) ? data.length : 0} 条工时`))
track(await probe(client, 'issue.dependencies.list', issueTarget, (data) => `${Array.isArray(data) ? data.length : 0} 个依赖`))
track(await probe(client, 'issue.blocks.list', issueTarget, (data) => `${Array.isArray(data) ? data.length : 0} 个阻塞`))
track(await probe(client, 'issue.labels.get', issueTarget, (data) => `${Array.isArray(data) ? data.length : 0} 个标签`))
track(await probe(client, 'issue.subscription.check', issueTarget, (data) => `订阅中=${data === true}`))
track(await probe(client, 'issue.subscribers', issueTarget, (data) => `${Array.isArray(data) ? data.length : 0} 个订阅者`))
track(await probe(client, 'issue.pinned', target, (data) => `${Array.isArray(data) ? data.length : 0} 条置顶`))

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 条失败`}`)
process.exit(failures === 0 ? 0 : 1)
