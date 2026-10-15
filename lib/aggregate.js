/**
 * @module lib/aggregate
 *
 * 几个「一次调用拿一屏数据」的聚合读取：issue 详情、仓库元信息。
 *
 * 为什么单独一层：桥的 `issue.detail` / `repo.meta` 与模型工具 `gitea_issue_get` 需要的是
 * **同一份事实**；两边各写一遍迟早会漂移（界面看到的评论数与模型看到的不一致）。
 * 这里只依赖 `ctx` + `store` + 一个已解析好的目标，HTTP 与工具两侧都能直接调。
 */
import { clientFor } from './resolve.js'
import { runOperation } from './gitea.js'
import {
  shapeAsset,
  shapeComment,
  shapeIssue,
  shapeIssues,
  shapeLabel,
  shapeList,
  shapeMilestone,
  shapeRepo,
  shapeTime,
  shapeUser,
} from './shape.js'

/**
 * 拉一份 issue 详情大礼包。
 *
 * `issue.get` 失败即整体失败（issue 不存在 / 没权限）；其余都是可选项，单项失败降级成空值 ——
 * 「没开时间追踪」「不是管理员看不到订阅者」都不该让详情页打不开。
 *
 * @param env - `{ ctx, store, signal }`。
 * @param target - `{ serverId, owner, repo, index }`。
 * @returns 详情大礼包（形状见 `lib/shape.js`）。
 */
export async function loadIssueDetail(env, target) {
  const { serverId, owner, repo, index } = target
  const { client } = await clientFor(env.ctx, env.store, serverId, env.signal)
  const options = { serverId, owner, repo, index }
  const base = { owner, repo, index }
  const issueResult = await runOperation(client, 'issue.get', base, env.signal)

  /** 单项可选读取：失败当作「没有这一项」。 */
  const optional = async (name, extra = {}) => {
    try {
      const { data } = await runOperation(client, name, { ...base, ...extra }, env.signal)
      return data
    } catch {
      return undefined
    }
  }

  const [comments, assets, times, dependencies, blocks, subscribed, subscribers] = await Promise.all([
    optional('issue.comments.list'),
    optional('issue.assets.list'),
    optional('issue.times.list'),
    optional('issue.dependencies.list'),
    optional('issue.blocks.list'),
    optional('issue.subscription.check'),
    optional('issue.subscribers'),
  ])

  return {
    serverId,
    issue: shapeIssue(issueResult.data, options),
    comments: shapeList(comments, (item) => shapeComment(item, options)),
    assets: shapeList(assets, (item) => shapeAsset(item)),
    times: shapeList(times, (item) => shapeTime(item)),
    dependencies: shapeIssues(dependencies, options),
    blocks: shapeIssues(blocks, options),
    subscribed: subscribed === true,
    subscribers: shapeList(subscribers, (item) => shapeUser(item)),
  }
}

/**
 * 拉一份仓库元信息：仓库本体 + 标签 + 里程碑 + 可指派候选。
 * @param env - `{ ctx, store, signal }`。
 * @param target - `{ serverId, owner, repo }`。
 * @returns 元信息大礼包。
 */
export async function loadRepoMeta(env, target) {
  const { serverId, owner, repo } = target
  const { client } = await clientFor(env.ctx, env.store, serverId, env.signal)
  const base = { owner, repo }
  const [repository, labels, milestones, assignees] = await Promise.all([
    runOperation(client, 'repo.get', base, env.signal),
    runOperation(client, 'repo.labels', { ...base, limit: 100 }, env.signal),
    runOperation(client, 'repo.milestones', { ...base, state: 'all', limit: 100 }, env.signal),
    runOperation(client, 'repo.assignees', base, env.signal).catch(() => ({ data: [] })),
  ])
  return {
    serverId,
    owner,
    repo,
    repository: shapeRepo(repository.data, serverId),
    labels: shapeList(labels.data, (item) => shapeLabel(item)),
    milestones: shapeList(milestones.data, (item) => shapeMilestone(item)),
    assignees: shapeList(assignees.data, (item) => shapeUser(item)),
  }
}
