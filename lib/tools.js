/**
 * @module lib/tools
 *
 * **模型侧的 Gitea issue 工具**。按用户要求只做主要功能、**没有删除**：
 * 列出/搜索、查看详情、创建、编辑、评论的查看/添加/编辑。
 *
 * ## 为什么手搓 tool definition，不用 `defineTool`
 *
 * 插件以 `link:` 装进 profile，模块真实路径在本仓库，`@deepseek-ai/dsh-tools` 这类裸包名
 * 从这里解析不到（同 `dsh-editor` 的约束 1）。而 `ctx.tools.register` 对定义的要求其实只有
 * 两条：`output.schema` 是受支持的 JSON Schema 子集、`output.render` 是函数；参数校验是
 * `defineTool` 自己加的，不是注册表的义务。所以这里自己写定义 + 自己校验参数。
 *
 * ## 两条容易踩的注册表行为
 *
 * 1. **返回值会按 `output.schema` 校验**（不合规就是 `INVALID_TOOL_OUTPUT`）。所以出参
 *    一律先过 {@link jsonSafe}：去掉值为 `undefined` 的键 —— 那些键不是「无损 JSON」，
 *    会在快照阶段被判非法。
 * 2. **参数不会自动校验**：每个工具的 `execute` 自己收敛参数（`reqString` / `optInt`…），
 *    非法输入抛 `BridgeError`，工具结果里带清晰的失败原因，而不是把坏参数送给 Gitea。
 *
 * ## 找哪个仓库
 *
 * 每个工具都收同两个可选参数 `server` / `repo`：
 * - 给了 `repo`（`owner/name`）就用它；只给 `report` 不给 `server` 时，服务器按工作区绑定推；
 * - 都不给就按当前会话的工作区：手动绑定优先，其次 `.git/config` 的 remote 自动侦测。
 * 解析规则只有一份，在 `lib/resolve.js`。
 */
import { loadIssueDetail } from './aggregate.js'
import { BridgeError, GiteaError, messageOf } from './errors.js'
import { optEnum, optInt, optLabelArray, optString, optStringArray, reqInt, reqString, runOperation, runOperationWithLabels } from './gitea.js'
import { clientFor, execRoot, resolveRepository } from './resolve.js'
import { shapeComment, shapeIssue, shapeIssues, shapeList } from './shape.js'
import { parseRepoSpec } from './store.js'

/** 只读检索类工具都用的「找哪台服务器」参数。 */
const TARGET_PROPS = {
  server: { type: 'string', description: 'Gitea 服务器 id（看板里配置的名字）。省略时按当前工作区绑定/自动侦测推断。' },
  repo: { type: 'string', description: '仓库 owner/name。省略时按当前工作区绑定/自动侦测推断。' },
}

/**
 * 去掉值为 `undefined` 的键。
 * 注册表会把返回值按 `output.schema` 校验并做无损 JSON 快照，`undefined` 不是合法 JSON 值。
 * @param value - 任意结果值。
 * @returns 只含 JSON 值的深拷贝。
 */
export function jsonSafe(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = jsonSafe(item)
  }
  return out
}

/**
 * 解析工具要操作的目标仓库。
 * @param ctx - Host 上下文。
 * @param store - 配置存储。
 * @param args - 工具参数（`server` / `repo`）。
 * @param exec - 工具运行上下文（用来取会话工作区）。
 * @param signal - 取消信号。
 * @returns `{ serverId, owner, repo, source }`。
 */
async function toolTarget(ctx, store, args, exec, signal) {
  const root = execRoot(exec)
  const spec = typeof args.repo === 'string' && args.repo.trim() !== '' ? parseRepoSpec(args.repo) : undefined
  const resolved = await resolveRepository(ctx, store, {
    root,
    serverId: typeof args.server === 'string' && args.server !== '' ? args.server : undefined,
    owner: spec?.owner,
    repo: spec?.repo,
  }, signal)
  return { serverId: resolved.server.id, owner: resolved.owner, repo: resolved.repo, source: resolved.source }
}

/**
 * 把失败收敛成工具结果里的一段说明（工具不因普通失败结束回合）。
 * @param error - 捕获到的值。
 * @returns `{ ok: false, code, message }`。
 */
function failure(error) {
  if (error instanceof BridgeError || error instanceof GiteaError) {
    return { ok: false, code: error.code, message: error.message }
  }
  return { ok: false, code: 'unexpected', message: messageOf(error) }
}

/** 截断长文本，并在尾部标出被截掉多少字符。 */
function clip(text, limit) {
  if (typeof text !== 'string') return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断，原文 ${text.length} 字）`
}

/** issue 的紧凑单行（列表与详情头部共用）。 */
function issueLine(issue) {
  const where = [issue.owner, issue.repo].filter(Boolean).join('/')
  const labels = issue.labels.map((label) => label.name).join(', ')
  const assignees = issue.assignees.map((user) => `@${user.login}`).join(' ')
  const parts = [`#${issue.index}`, `[${issue.state}]`, issue.title]
  if (where !== '') parts.push(`(${where})`)
  if (labels !== '') parts.push(`labels: ${labels}`)
  if (assignees !== '') parts.push(assignees)
  if (issue.milestone !== null) parts.push(`milestone: ${issue.milestone.title}`)
  if (issue.dueDate !== null) parts.push(`due: ${issue.dueDate}`)
  parts.push(`comments: ${issue.comments}`)
  if (issue.htmlUrl !== null) parts.push(issue.htmlUrl)
  return parts.join(' ')
}

/** 一屏文本：工具结果真正被模型读到的部分。 */
function textOf(title, lines) {
  return [title, ...lines].filter((line) => line !== undefined && line !== '').join('\n')
}

/**
 * 造一个工具定义。
 * @param options - `name` / `description` / `parameters` / `output` / `execute`。
 * @returns 注册表要的 `ToolDefinition`。
 */
function makeTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: options.output.render,
    },
    execute: options.execute,
  }
}

/** 出参统一形状：`ok` 必有，其余按工具声明。 */
const BASE_OUT = { ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' } }

/**
 * 建全部工具的**定义**（还没注册）。
 * @param options - `ctx` 与 `store`。
 * @returns 工具定义数组。
 */
export function createToolDefinitions({ ctx, store }) {
  /** 每次工具调用共用的环境。 */
  const env = (signal) => ({ ctx, store, signal })

  return [
    makeTool({
      name: 'gitea_issue_list',
      description: [
        '列出或搜索 Gitea issues。默认查当前工作区绑定仓库；给 repo（owner/name）查指定仓库；',
        'scope=all 时在该服务器上跨仓库搜索（相当于 Gitea 的 issues 搜索页）。',
        '返回结构化的 issues 数组（含编号、标题、状态、标签、指派、里程碑、截止日、评论数与网页地址）。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          scope: { type: 'string', enum: ['repo', 'all'], description: 'repo（默认）只看一个仓库；all 跨仓库搜索（按 owner 收窄，Gitea 不支持按单个仓库过滤跨仓库搜索）。' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态筛选，默认 open。' },
          q: { type: 'string', description: '关键词，匹配标题与正文。' },
          labels: { type: 'string', description: '标签名，多个用英文逗号分隔（Gitea 只认名字）。' },
          assignee: { type: 'string', description: '按被指派人筛选（用户名）；scope=all 时请改用 assigned=true。' },
          creator: { type: 'string', description: '按创建者筛选（用户名）。' },
          mentioned: { type: 'string', description: '按被提及的用户筛选（用户名）。' },
          milestone: { type: 'string', description: '里程碑名字。' },
          type: { type: 'string', enum: ['issues', 'pulls'], description: '只看 issue 或只看 PR，默认 issues。' },
          assigned: { type: 'boolean', description: 'scope=all：只看指派给我的。' },
          created: { type: 'boolean', description: 'scope=all：只看我创建的。' },
          page: { type: 'integer', description: '页码，从 1 开始。' },
          limit: { type: 'integer', description: '每页条数上限，默认 30，最大 100。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok'],
          properties: {
            ...BASE_OUT,
            serverId: { type: 'string' },
            owner: { type: 'string' },
            repo: { type: 'string' },
            scope: { type: 'string' },
            count: { type: 'integer' },
            total: { type: 'integer' },
            issues: { type: 'array', items: { type: 'object' } },
          },
        },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: `Gitea 查询失败（${value.code}）：${value.message}` }]
          const head = `${value.scope === 'all' ? '跨仓库' : `${value.owner}/${value.repo}`} 命中 ${value.count} 条${value.total === undefined ? '' : `（服务端共 ${value.total} 条）`}`
          return [{ type: 'text', text: textOf(head, value.issues.map(issueLine)) }]
        },
      },
      async execute(args, exec) {
        try {
          const limit = optInt(args.limit, 'limit', { min: 1, max: 100 }) ?? 30
          const scope = optEnum(args.scope, 'scope', ['repo', 'all']) ?? 'repo'
          const state = optEnum(args.state, 'state', ['open', 'closed', 'all']) ?? 'open'
          const type = optEnum(args.type, 'type', ['issues', 'pulls']) ?? 'issues'
          const page = optInt(args.page, 'page', { min: 1 })
          const target = await toolTarget(ctx, store, args, exec, exec.signal)
          const { client } = await clientFor(ctx, store, target.serverId, exec.signal)
          const shared = {
            state,
            type,
            q: optString(args.q, 'q'),
            labels: optString(args.labels, 'labels'),
            milestones: optString(args.milestone, 'milestone'),
            page,
            limit,
          }
          const name = scope === 'all' ? 'issue.search' : 'issue.list'
          // 跨仓库搜索（Gitea 的 /repos/issues/search）**没有 repo 参数**，只能按 owner 收窄；
          // 仓库级过滤交给 scope=repo。这里不假装支持。
          const params = scope === 'all'
            ? { ...shared, owner: target.owner, assigned: args.assigned, created: args.created }
            : { ...shared, owner: target.owner, repo: target.repo, assigned_by: optString(args.assignee, 'assignee'), created_by: optString(args.creator, 'creator'), mentioned_by: optString(args.mentioned, 'mentioned') }
          const { data, total } = await runOperation(client, name, params, exec.signal)
          const options = { serverId: target.serverId, owner: target.owner, repo: target.repo }
          const issues = shapeIssues(data, options)
          return jsonSafe({
            ok: true,
            serverId: target.serverId,
            owner: target.owner,
            repo: target.repo,
            scope,
            count: issues.length,
            total,
            issues,
          })
        } catch (error) {
          return jsonSafe(failure(error))
        }
      },
    }),

    makeTool({
      name: 'gitea_issue_get',
      description: '查看一个 Gitea issue 的详情：正文、评论、标签、指派、里程碑、截止日、依赖/阻塞关系与工时汇总。',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          index: { type: 'integer', description: 'issue 编号（Gitea 的 number，不是数据库 id）。必填。' },
        },
        required: ['index'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok'],
          properties: {
            ...BASE_OUT,
            serverId: { type: 'string' },
            issue: { type: 'object' },
            comments: { type: 'array', items: { type: 'object' } },
            dependencies: { type: 'array', items: { type: 'object' } },
            blocks: { type: 'array', items: { type: 'object' } },
            times: { type: 'array', items: { type: 'object' } },
            subscribed: { type: 'boolean' },
          },
        },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: `Gitea 读取失败（${value.code}）：${value.message}` }]
          const issue = value.issue
          const lines = [
            issueLine(issue),
            '',
            clip(issue.body, 4000),
          ]
          if (value.dependencies.length > 0) lines.push('', `依赖（被这些挡住）：${value.dependencies.map((item) => `#${item.index} ${item.title}`).join('；')}`)
          if (value.blocks.length > 0) lines.push(`阻塞：${value.blocks.map((item) => `#${item.index} ${item.title}`).join('；')}`)
          if (value.times.length > 0) {
            const seconds = value.times.reduce((sum, item) => sum + item.time, 0)
            lines.push(`工时：${Math.round(seconds / 60)} 分钟（${value.times.length} 条记录）`)
          }
          if (value.comments.length > 0) {
            lines.push('', `评论（${value.comments.length} 条）：`)
            for (const comment of value.comments) {
              lines.push(`- #${comment.id} ${comment.user?.login ?? '?'} @ ${comment.createdAt ?? '?'}`)
              lines.push(clip(comment.body, 2000))
            }
          }
          return [{ type: 'text', text: lines.filter((line) => line !== undefined).join('\n') }]
        },
      },
      async execute(args, exec) {
        try {
          const index = reqInt(args.index, 'index')
          const target = await toolTarget(ctx, store, args, exec, exec.signal)
          const detail = await loadIssueDetail(env(exec.signal), { ...target, index })
          return jsonSafe({ ok: true, serverId: target.serverId, ...detail })
        } catch (error) {
          return jsonSafe(failure(error))
        }
      },
    }),

    makeTool({
      name: 'gitea_issue_create',
      description: '在 Gitea 仓库里新建一个 issue。title 必填；labels 可以给标签名或标签 id。',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          title: { type: 'string', description: '标题。必填。' },
          body: { type: 'string', description: '正文（Markdown）。' },
          labels: { type: 'array', items: { type: 'string' }, description: '标签名或标签 id。' },
          assignees: { type: 'array', items: { type: 'string' }, description: '指派给谁（用户名）。' },
          milestone: { type: 'integer', description: '里程碑 id。' },
          due_date: { type: 'string', description: '截止日，ISO 8601（如 2026-11-01T00:00:00Z）。' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok'],
          properties: { ...BASE_OUT, issue: { type: 'object' } },
        },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: `创建失败（${value.code}）：${value.message}` }]
          return [{ type: 'text', text: `已创建：${issueLine(value.issue)}` }]
        },
      },
      async execute(args, exec) {
        try {
          const title = reqString(args.title, 'title')
          const target = await toolTarget(ctx, store, args, exec, exec.signal)
          const { client } = await clientFor(ctx, store, target.serverId, exec.signal)
          const { data } = await runOperationWithLabels(client, 'issue.create', {
            owner: target.owner,
            repo: target.repo,
            title,
            body: optString(args.body, 'body'),
            labels: optLabelArray(args.labels, 'labels'),
            assignees: optStringArray(args.assignees, 'assignees'),
            milestone: optInt(args.milestone, 'milestone', { min: 1 }),
            due_date: optString(args.due_date, 'due_date'),
          }, exec.signal)
          const issue = shapeIssue(data, { serverId: target.serverId, owner: target.owner, repo: target.repo })
          return jsonSafe({ ok: true, issue })
        } catch (error) {
          return jsonSafe(failure(error))
        }
      },
    }),

    makeTool({
      name: 'gitea_issue_edit',
      description: [
        '编辑 Gitea issue：标题、正文、状态（open/closed）、指派、里程碑、截止日。',
        'labels 是**整体替换**；只想加一个标签时把原有标签一起传进来。',
        '不带某字段表示「不改它」；要清空截止日请传 clear_due_date=true。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          index: { type: 'integer', description: 'issue 编号。必填。' },
          title: { type: 'string' },
          body: { type: 'string' },
          state: { type: 'string', enum: ['open', 'closed'], description: '改成 open 或 closed。' },
          assignees: { type: 'array', items: { type: 'string' }, description: '整体替换指派名单。' },
          labels: { type: 'array', items: { type: 'string' }, description: '整体替换标签（名字或 id）。' },
          milestone: { type: 'integer', description: '里程碑 id。' },
          due_date: { type: 'string', description: '截止日 ISO 8601。' },
          clear_due_date: { type: 'boolean', description: 'true 表示清空截止日。' },
        },
        required: ['index'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok'],
          properties: { ...BASE_OUT, issue: { type: 'object' }, labelsReplaced: { type: 'boolean' } },
        },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: `编辑失败（${value.code}）：${value.message}` }]
          return [{ type: 'text', text: `已更新${value.labelsReplaced ? '（标签已整体替换）' : ''}：${issueLine(value.issue)}` }]
        },
      },
      async execute(args, exec) {
        try {
          const index = reqInt(args.index, 'index')
          const target = await toolTarget(ctx, store, args, exec, exec.signal)
          const { client } = await clientFor(ctx, store, target.serverId, exec.signal)
          const clearDue = args.clear_due_date === true
          const patch = {
            owner: target.owner,
            repo: target.repo,
            index,
            title: optString(args.title, 'title'),
            body: optString(args.body, 'body'),
            state: optEnum(args.state, 'state', ['open', 'closed']),
            assignees: optStringArray(args.assignees, 'assignees'),
            milestone: optInt(args.milestone, 'milestone', { min: 1 }),
            due_date: optString(args.due_date, 'due_date'),
            unset_due_date: clearDue ? true : undefined,
          }
          if (patch.title === undefined && patch.body === undefined && patch.state === undefined
            && patch.assignees === undefined && patch.milestone === undefined && patch.due_date === undefined && !clearDue) {
            throw new BridgeError(400, 'nothing-to-do', 'pass at least one field to change')
          }
          const { data } = await runOperation(client, 'issue.edit', patch, exec.signal)
          const labels = optLabelArray(args.labels, 'labels')
          let labelsReplaced = false
          if (labels !== undefined) {
            await runOperationWithLabels(client, 'issue.labels.set', { owner: target.owner, repo: target.repo, index, labels }, exec.signal)
            labelsReplaced = true
          }
          const issue = shapeIssue(data, { serverId: target.serverId, owner: target.owner, repo: target.repo })
          return jsonSafe({ ok: true, issue, labelsReplaced })
        } catch (error) {
          return jsonSafe(failure(error))
        }
      },
    }),

    makeTool({
      name: 'gitea_issue_comments',
      description: '查看一个 Gitea issue 的评论列表（按时间正序）。since/before 按 RFC 3339 时间过滤。',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          index: { type: 'integer', description: 'issue 编号。必填。' },
          since: { type: 'string', description: '只要这个时间之后的评论（RFC 3339）。' },
          before: { type: 'string', description: '只要这个时间之前的评论（RFC 3339）。' },
        },
        required: ['index'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok'],
          properties: { ...BASE_OUT, count: { type: 'integer' }, comments: { type: 'array', items: { type: 'object' } } },
        },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: `读取评论失败（${value.code}）：${value.message}` }]
          const lines = [`共 ${value.count} 条评论：`]
          for (const comment of value.comments) {
            lines.push(`- #${comment.id} ${comment.user?.login ?? '?'} @ ${comment.createdAt ?? '?'}`)
            lines.push(clip(comment.body, 2000))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        try {
          const index = reqInt(args.index, 'index')
          const target = await toolTarget(ctx, store, args, exec, exec.signal)
          const { client } = await clientFor(ctx, store, target.serverId, exec.signal)
          const { data } = await runOperation(client, 'issue.comments.list', {
            owner: target.owner,
            repo: target.repo,
            index,
            since: optString(args.since, 'since'),
            before: optString(args.before, 'before'),
          }, exec.signal)
          const comments = shapeList(data, (item) => shapeComment(item, { serverId: target.serverId, owner: target.owner, repo: target.repo, issueIndex: index }))
          return jsonSafe({ ok: true, count: comments.length, comments })
        } catch (error) {
          return jsonSafe(failure(error))
        }
      },
    }),

    makeTool({
      name: 'gitea_issue_comment_create',
      description: '给 Gitea issue 添加一条评论。',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          index: { type: 'integer', description: 'issue 编号。必填。' },
          body: { type: 'string', description: '评论正文（Markdown）。必填。' },
        },
        required: ['index', 'body'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok'],
          properties: { ...BASE_OUT, comment: { type: 'object' } },
        },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: `评论失败（${value.code}）：${value.message}` }]
          return [{ type: 'text', text: `已评论（#${value.comment.id}）：${clip(value.comment.body, 500)}` }]
        },
      },
      async execute(args, exec) {
        try {
          const index = reqInt(args.index, 'index')
          const body = reqString(args.body, 'body')
          const target = await toolTarget(ctx, store, args, exec, exec.signal)
          const { client } = await clientFor(ctx, store, target.serverId, exec.signal)
          const { data } = await runOperation(client, 'issue.comments.create', { owner: target.owner, repo: target.repo, index, body }, exec.signal)
          const comment = shapeComment(data, { serverId: target.serverId, owner: target.owner, repo: target.repo, issueIndex: index })
          return jsonSafe({ ok: true, comment })
        } catch (error) {
          return jsonSafe(failure(error))
        }
      },
    }),

    makeTool({
      name: 'gitea_issue_comment_edit',
      description: '编辑一条已有的 Gitea 评论（按评论 id 定位，不需要 issue 编号）。',
      parameters: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          id: { type: 'integer', description: '评论 id。必填。' },
          body: { type: 'string', description: '新的评论正文。必填。' },
        },
        required: ['id', 'body'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok'],
          properties: { ...BASE_OUT, comment: { type: 'object' } },
        },
        render(args, value) {
          if (value.ok !== true) return [{ type: 'text', text: `编辑评论失败（${value.code}）：${value.message}` }]
          return [{ type: 'text', text: `已更新评论 #${value.comment.id}：${clip(value.comment.body, 500)}` }]
        },
      },
      async execute(args, exec) {
        try {
          const id = reqInt(args.id, 'id')
          const body = reqString(args.body, 'body')
          const target = await toolTarget(ctx, store, args, exec, exec.signal)
          const { client } = await clientFor(ctx, store, target.serverId, exec.signal)
          const { data } = await runOperation(client, 'comment.edit', { owner: target.owner, repo: target.repo, id, body }, exec.signal)
          const comment = shapeComment(data, { serverId: target.serverId, owner: target.owner, repo: target.repo })
          return jsonSafe({ ok: true, comment })
        } catch (error) {
          return jsonSafe(failure(error))
        }
      },
    }),
  ]
}
