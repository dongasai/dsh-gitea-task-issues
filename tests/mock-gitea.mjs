/**
 * 一个够用的 **假 Gitea**：只实现插件真正会打的那批端点，行为按 Gitea 1.27.3 的形状来。
 *
 * 为什么值得写：插件的风险几乎全在「拼错路径 / 少个字段 / 把 204 当 JSON 读」这类地方，
 * 而这些恰好是 mock 能抓住、人眼看不出的。所有请求都会记进 `requests`，
 * 断言「到底打了哪个路径、带了什么参数」比断言返回值更能防回归。
 */
import { createServer } from 'node:http'

/** 认的令牌。请求头必须是 `Authorization: token test-token`。 */
export const TEST_TOKEN = 'test-token'

/**
 * 起一个假 Gitea。
 * @returns `{ url, state, requests, close }`。
 */
export async function startMockGitea() {
  const state = {
    issues: [],
    comments: [],
    labels: [
      { id: 1, name: 'bug', color: 'd73a4a', description: 'Something is broken' },
      { id: 2, name: 'enhancement', color: 'a2eeef', description: 'New feature' },
    ],
    milestones: [{ id: 7, title: 'v1', state: 'open', due_on: null }],
    assignees: [{ login: 'tester', full_name: 'Tester', avatar_url: null }],
    times: [],
    assets: [],
    pinned: [],
    locked: false,
    subscribers: [],
    dependencies: [],
    blocks: [],
    nextIssue: 1,
    nextComment: 1,
    nextAsset: 1,
    nextTime: 1,
  }
  const requests = []

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })
    const send = (status, payload) => {
      res.statusCode = status
      if (payload === undefined) {
        res.end()
        return
      }
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (Array.isArray(payload)) res.setHeader('x-total-count', String(payload.length))
      res.end(JSON.stringify(payload))
    }
    const fail = (status, message) => send(status, { message, url: req.url })

    // 除 /version 外都要令牌。
    if (url.pathname !== '/api/v1/version') {
      if (req.headers.authorization !== `token ${TEST_TOKEN}`) {
        fail(401, 'Unauthorized')
        return
      }
    }

    const readBody = async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') return undefined
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }

    const route = async () => {
      const path = url.pathname.replace(/^\/api\/v1/, '')
      const segments = path.split('/').filter((part) => part !== '')

      if (path === '/version') return send(200, { version: '1.27.3' })
      if (path === '/user') return send(200, { login: 'tester', full_name: 'Tester', avatar_url: null })

      // /repos/search 与 /user/repos
      if (path === '/repos/search') return send(200, { ok: true, data: [repoOf('dongasai', 'mylike')] })
      if (path === '/user/repos') return send(200, [repoOf('dongasai', 'mylike')])
      if (path === '/repos/issues/search') {
        const stateFilter = url.searchParams.get('state') ?? 'open'
        const owner = url.searchParams.get('owner')
        // `assigned=true` 是 Gitea 的「指派给当前令牌用户」，mock 的令牌用户是 tester。
        const assigned = url.searchParams.get('assigned') === 'true'
        const since = url.searchParams.get('since')
        return send(200, state.issues.filter((issue) => (
          matchesState(issue, stateFilter)
          && (owner === null || issue.owner === owner)
          && (!assigned || issue.assignees.some((person) => person.login === 'tester'))
          && (since === null || Date.parse(issue.updated_at) > Date.parse(since))
        )))
      }

      if (segments[0] !== 'repos' || segments.length < 3) return fail(404, 'Not Found')
      const owner = segments[1]
      const repo = segments[2]
      const rest = segments.slice(3)

      if (rest.length === 0) {
        if (req.method === 'GET') return send(200, repoOf(owner, repo))
        return fail(405, 'Method Not Allowed')
      }
      if (rest.length === 1 && rest[0] === 'labels') return send(200, state.labels)
      if (rest.length === 1 && rest[0] === 'milestones') return send(200, state.milestones)
      if (rest.length === 1 && rest[0] === 'assignees') return send(200, state.assignees)
      if (rest.length === 1 && rest[0] === 'issues') {
        if (req.method === 'GET') {
          const stateFilter = url.searchParams.get('state') ?? 'open'
          return send(200, state.issues.filter((issue) => matchesState(issue, stateFilter)))
        }
        if (req.method === 'POST') {
          const body = await readBody()
          if (typeof body?.title !== 'string' || body.title === '') return fail(422, 'title is required')
          if (Array.isArray(body.labels) && body.labels.some((label) => typeof label !== 'number')) {
            return fail(422, 'labels must be ids')
          }
          const issue = makeIssue(state, owner, repo, body)
          state.issues.push(issue)
          return send(201, issue)
        }
        return fail(405, 'Method Not Allowed')
      }
      if (rest[0] === 'issues' && rest[1] === 'comments') {
        const id = Number(rest[2])
        const comment = state.comments.find((item) => item.id === id)
        if (rest.length === 2) {
          if (req.method === 'GET') {
            // 仓库级评论列表支持 since / page / limit（Gitea 1.27.3 实测）。
            const since = url.searchParams.get('since')
            const page = Number(url.searchParams.get('page') ?? '1')
            const limit = Number(url.searchParams.get('limit') ?? '50')
            const filtered = state.comments.filter((item) => since === null || Date.parse(item.updated_at) > Date.parse(since))
            return send(200, filtered.slice((page - 1) * limit, page * limit))
          }
          return fail(405, 'Method Not Allowed')
        }
        if (comment === undefined) return fail(404, 'Not Found')
        if (req.method === 'GET') return send(200, comment)
        if (req.method === 'PATCH') {
          const body = await readBody()
          if (typeof body?.body !== 'string' || body.body === '') return fail(422, 'body is required')
          comment.body = body.body
          comment.updated_at = new Date().toISOString()
          return send(200, comment)
        }
        if (req.method === 'DELETE') {
          state.comments = state.comments.filter((item) => item.id !== id)
          return send(204)
        }
        return fail(405, 'Method Not Allowed')
      }
      if (rest[0] === 'issues' && rest[1] === 'pinned') return send(200, state.issues.filter((issue) => issue.pin_order !== undefined))

      if (rest[0] !== 'issues' || rest[1] === undefined) return fail(404, 'Not Found')
      const index = Number(rest[1])
      const issue = state.issues.find((item) => item.number === index)
      if (issue === undefined) return fail(404, 'Not Found')
      const sub = rest.slice(2)

      if (sub.length === 0) {
        if (req.method === 'GET') return send(200, issue)
        if (req.method === 'PATCH') {
          const body = await readBody()
          if (body?.title !== undefined) issue.title = body.title
          if (body?.body !== undefined) issue.body = body.body
          if (body?.state !== undefined) issue.state = body.state
          if (body?.assignees !== undefined) issue.assignees = body.assignees.map((login) => ({ login }))
          if (body?.unset_due_date === true) issue.due_date = null
          if (body?.due_date !== undefined) issue.due_date = body.due_date
          issue.updated_at = new Date().toISOString()
          return send(201, issue)
        }
        if (req.method === 'DELETE') {
          state.issues = state.issues.filter((item) => item.number !== index)
          return send(204)
        }
        return fail(405, 'Method Not Allowed')
      }

      if (sub[0] === 'comments') {
        if (sub.length === 1) {
          if (req.method === 'GET') return send(200, state.comments.filter((item) => item.issue_number === index))
          if (req.method === 'POST') {
            const body = await readBody()
            if (typeof body?.body !== 'string' || body.body === '') return fail(422, 'body is required')
            const comment = {
              id: state.nextComment,
              body: body.body,
              user: { login: 'tester', full_name: 'Tester', avatar_url: null },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              html_url: `http://localhost/${owner}/${repo}/issues/${index}#issuecomment-${state.nextComment}`,
              issue_url: `http://localhost/api/v1/repos/${owner}/${repo}/issues/${index}`,
              issue_number: index,
            }
            state.nextComment += 1
            state.comments.push(comment)
            issue.comments += 1
            return send(201, comment)
          }
        }
        return fail(404, 'Not Found')
      }
      if (sub[0] === 'labels') {
        if (req.method === 'GET') return send(200, issue.labels)
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = await readBody()
          const chosen = (body?.labels ?? []).map((id) => state.labels.find((label) => label.id === id)).filter(Boolean)
          issue.labels = req.method === 'PUT' ? chosen : [...issue.labels, ...chosen]
          return send(200, issue.labels)
        }
        if (req.method === 'DELETE') {
          if (sub.length === 1) {
            issue.labels = []
            return send(204)
          }
          issue.labels = issue.labels.filter((label) => label.id !== Number(sub[1]))
          return send(204)
        }
        return fail(405, 'Method Not Allowed')
      }
      if (sub[0] === 'assignees') {
        if (req.method === 'GET') return send(200, { login: sub[1], assignable: true })
        const body = await readBody()
        const names = body?.assignees ?? []
        if (req.method === 'POST') issue.assignees = [...issue.assignees, ...names.map((login) => ({ login }))]
        if (req.method === 'DELETE') issue.assignees = issue.assignees.filter((user) => !names.includes(user.login))
        return send(201, issue)
      }
      if (sub[0] === 'dependencies' || sub[0] === 'blocks') {
        const bucket = sub[0] === 'dependencies' ? state.dependencies : state.blocks
        if (req.method === 'GET') return send(200, bucket)
        const body = await readBody()
        if (typeof body?.index !== 'number') return fail(422, 'index is required')
        if (req.method === 'POST') bucket.push({ number: body.index, title: `target ${body.index}` })
        if (req.method === 'DELETE') {
          const at = bucket.findIndex((item) => item.number === body.index)
          if (at >= 0) bucket.splice(at, 1)
        }
        return send(200, bucket)
      }
      if (sub[0] === 'subscriptions') {
        if (sub[1] === 'check') return send(200, state.subscribers.includes('tester'))
        if (req.method === 'PUT') {
          if (!state.subscribers.includes(sub[1])) state.subscribers.push(sub[1])
          return send(200, {})
        }
        if (req.method === 'DELETE') {
          state.subscribers = state.subscribers.filter((user) => user !== sub[1])
          return send(204)
        }
        return send(200, state.subscribers.map((login) => ({ login })))
      }
      if (sub[0] === 'pin') {
        if (req.method === 'POST') {
          issue.pin_order = 1
          return send(204)
        }
        if (req.method === 'DELETE') {
          delete issue.pin_order
          return send(204)
        }
        return fail(405, 'Method Not Allowed')
      }
      if (sub[0] === 'lock') {
        if (req.method === 'PUT') {
          state.locked = true
          issue.is_locked = true
          return send(204)
        }
        if (req.method === 'DELETE') {
          state.locked = false
          issue.is_locked = false
          return send(204)
        }
        return fail(405, 'Method Not Allowed')
      }
      if (sub[0] === 'times') {
        if (req.method === 'GET') return send(200, state.times)
        if (req.method === 'POST') {
          const body = await readBody()
          if (!Number.isInteger(body?.time)) return fail(422, 'time is required')
          const entry = { id: state.nextTime, time: body.time, created: new Date().toISOString(), user_name: body.user_name ?? 'tester' }
          state.nextTime += 1
          state.times.push(entry)
          return send(200, entry)
        }
        if (req.method === 'DELETE') {
          if (sub.length === 1) state.times = []
          else state.times = state.times.filter((entry) => entry.id !== Number(sub[1]))
          return send(204)
        }
        return fail(405, 'Method Not Allowed')
      }
      if (sub[0] === 'assets') {
        if (sub.length === 1) {
          if (req.method === 'GET') return send(200, state.assets)
          if (req.method === 'POST') {
            const name = url.searchParams.get('name')
            if (name === null) return fail(422, 'name is required')
            const asset = { id: state.nextAsset, name, size: 5, uuid: `uuid-${state.nextAsset}`, browser_download_url: `http://localhost/attachments/${state.nextAsset}`, created_at: new Date().toISOString() }
            state.nextAsset += 1
            state.assets.push(asset)
            return send(201, asset)
          }
        }
        const asset = state.assets.find((item) => item.id === Number(sub[1]))
        if (asset === undefined) return fail(404, 'Not Found')
        if (req.method === 'GET') return send(200, asset)
        if (req.method === 'PATCH') {
          const body = await readBody()
          if (typeof body?.name !== 'string' || body.name === '') return fail(422, 'name is required')
          asset.name = body.name
          return send(200, asset)
        }
        if (req.method === 'DELETE') {
          state.assets = state.assets.filter((item) => item.id !== asset.id)
          return send(204)
        }
        return fail(405, 'Method Not Allowed')
      }
      if (sub[0] === 'deadline') {
        const body = await readBody()
        issue.due_date = body?.due_date ?? null
        return send(201, issue)
      }
      if (sub[0] === 'timeline') return send(200, [])
      return fail(404, 'Not Found')
    }

    route().catch((error) => fail(500, error instanceof Error ? error.message : String(error)))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 状态筛选：Gitea 的 `all` 是「不筛」。 */
function matchesState(issue, filter) {
  if (filter === 'all') return true
  return issue.state === filter
}

/** 造一个 issue 对象，字段名照 Gitea。 */
function makeIssue(state, owner, repo, body) {
  const number = state.nextIssue
  state.nextIssue += 1
  return {
    id: 1000 + number,
    number,
    title: body.title,
    body: body.body ?? '',
    state: 'open',
    labels: (body.labels ?? []).map((id) => state.labels.find((label) => label.id === id)).filter(Boolean),
    assignees: (body.assignees ?? []).map((login) => ({ login })),
    milestone: null,
    due_date: body.due_date ?? null,
    comments: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    html_url: `http://localhost/${owner}/${repo}/issues/${number}`,
    user: { login: 'tester', full_name: 'Tester', avatar_url: null },
    repository: { name: repo, owner: { login: owner } },
  }
}

/** 仓库对象。 */
function repoOf(owner, repo) {
  return {
    id: 42,
    name: repo,
    full_name: `${owner}/${repo}`,
    owner: { login: owner },
    private: false,
    has_issues: true,
    html_url: `http://localhost/${owner}/${repo}`,
    updated_at: new Date().toISOString(),
    default_branch: 'main',
  }
}
