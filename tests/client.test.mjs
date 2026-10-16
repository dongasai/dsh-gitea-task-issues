/**
 * 浏览器半边的探针：**假 window + 迷你 React + 假桥**。
 *
 * 覆盖三件事：
 * 1. **注册面**：`apply()` 到底往哪些槽位注册了什么（main 键、左侧栏面板 id 与 order、
 *    右侧栏页签类型与 guide 卡片、locale 字典），以及 zh/en 键集是否一致；
 * 2. **渲染面**：把每个注册出去的组件真渲染一遍，抓运行时错误（读 null 字段、把 undefined
 *    当数组用这类），并断言关键文案/数据出现在输出里；
 * 3. **交互面**：点列表行 → 进详情；点「新建」→ 进表单；改筛选 → 重新取数；
 *    「发送到 DSH」→ 提示词落进假输入框（成功 / 拿不到输入框 / 输入框正忙三条路）。
 *
 * 抓不到的是样式与布局 —— 那部分只能在浏览器里手工验收（见 README「怎么验证」）。
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { calls, FIXTURES } from './fixtures.mjs'
import { instantiate } from './load-bundle.mjs'
import { createMiniReact } from './mini-react.mjs'

/** 让事件处理里的 await 落地（点击触发的异步动作不会同步完成）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 假环境 ──────────────────────────────────────────────────────────────────

/**
 * 装好假环境，并为一个用例新建 `{ plugin, mini, fake }`。
 * @returns 一个用例的完整环境。
 */
async function newWorld() {
  const { plugin, mini } = await instantiate()
  const fake = makeCtx()
  plugin.apply(fake.ctx)
  return { plugin, mini, fake }
}

/** 假 ctx：记录注册面，effect 立刻执行。 */
function makeCtx() {
  const slots = []
  const tabs = []
  const dictionaries = []
  const shortcuts = []
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    inject(names, fn) {
      // 只模拟 shortcuts 这一条可选注入。
      if (names.includes('shortcuts')) fn(ctx)
    },
    locale: {
      register(ns, dict) {
        dictionaries.push({ ns, dict })
      },
      bind: (ns) => (key, params) => {
        const dict = dictionaries.find((entry) => entry.ns === ns)?.dict.zh ?? {}
        const text = dict[key] ?? key
        if (params === undefined) return text
        return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
      },
    },
    slots: {
      inject(name, register) {
        register()
        return () => {}
      },
      register(options, component) {
        slots.push({ options, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        tabs.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      commandTarget: () => ({ sessionId: 'session-1' }),
      openTabFromTarget: () => {},
    },
    shortcuts: {
      register(definition) {
        shortcuts.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, slots, tabs, dictionaries, shortcuts }
}

test('bundle 注册：locale 字典、main 面板、侧栏图标、右侧栏页签、快捷键', async () => {
  const { plugin, fake } = await newWorld()
  assert.equal(plugin.name, 'gitea-issues')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'])

  const dict = fake.dictionaries[0]
  assert.equal(dict.ns, 'giteaIssues')
  assert.deepEqual(Object.keys(dict.dict.zh).sort(), Object.keys(dict.dict.en).sort(), 'zh 与 en 的键集必须一致')

  const main = fake.slots.find((entry) => entry.options.name === 'main')
  assert.equal(main.options.key, 'gitea-issues')

  const panel = fake.slots.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(panel.options.id, 'gitea-issues')
  assert.equal(panel.options.order, 20, 'order 必须大于官方「自动化任务」的 10，才排在它下面')
  assert.equal(typeof panel.options.label(), 'string')

  const body = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  assert.equal(body.options.key, 'gitea-issues')

  // 对话输入框的哨兵：list 槽位要 `id`，注册项不能夹带 `key`（catalog 用例也会核一遍）。
  const dock = fake.slots.find((entry) => entry.options.name === 'conversation.input.dock')
  assert.ok(dock, '没有注册对话输入框哨兵，「发送到 DSH」就没有兜底写入面')
  assert.equal(dock.options.id, 'gitea-issues-input')
  assert.equal(dock.options.key, undefined)

  assert.equal(fake.tabs.length, 1)
  assert.equal(fake.tabs[0].kind, 'gitea-issues')
  assert.equal(fake.tabs[0].id, 'gitea-issues')
  assert.equal(fake.tabs[0].patterns, undefined, '页类型不能有 patterns，否则会抢文件的自动打开')
  assert.equal(fake.tabs[0].guide[0].commandId, 'gitea.issues')

  assert.equal(fake.shortcuts.length, 1)
  assert.equal(fake.shortcuts[0].id, 'gitea.issues')
})

test('全局看板：渲染出服务器、issue 列表与详情，交互可达', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  calls.length = 0
  let text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [], `渲染期报错：${mini.errors.map((error) => error.message).join('; ')}`)
  assert.match(text, /第一个 issue/)
  assert.match(text, /第二个 issue/)
  assert.ok(calls.some((call) => call.op === 'config.get'))
  assert.ok(calls.some((call) => call.op === 'gitea.call' && call.params.op === 'issue.search'))

  // 点第一行 → 进详情（详情走 issue.detail 一揽子）。
  const row = findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string')
  assert.ok(row, '没有找到列表行')
  row.props.onClick(FIXTURES.issues[0])
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.match(text, /正文内容/)
  assert.match(text, /第一条评论/)
  assert.match(text, /依赖的 issue/)
  assert.ok(calls.some((call) => call.op === 'issue.detail'))

  // 详情里的「编辑」→ 表单（读 repo.meta 拿标签与指派候选）。
  const edit = findNode(mini, (node) => node.props?.['data-gti-edit'] === 'true')
  assert.ok(edit, '详情里没有编辑按钮')
  edit.props.onClick()
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-form-title'] !== undefined), '没有进入编辑表单')
  assert.match(text, /bug/)
  assert.ok(calls.some((call) => call.op === 'repo.meta'))
})

test('全局看板：新建流程（选目标 → 填标题 → 提交）', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  let text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  const create = findNode(mini, (node) => node.props?.['data-gti-new'] === 'true')
  assert.ok(create, '没有新建按钮')
  create.props.onClick()
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-target-repo'] !== undefined), '新建页缺目标选择')

  // 填目标仓库 → 出现表单
  const target = findNode(mini, (node) => node.props?.['data-gti-target-repo'] !== undefined)
  target.props.onChange({ target: { value: 'dongasai/mylike' } })
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  const title = findNode(mini, (node) => node.props?.['data-gti-form-title'] !== undefined)
  assert.ok(title, '选好目标后应出现标题输入框')
  title.props.onChange({ target: { value: '从界面新建' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const submit = findNode(mini, (node) => node.props?.['data-gti-form-submit'] === 'true')
  assert.ok(submit, '没有提交按钮')
  calls.length = 0
  submit.props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.ok(calls.some((call) => call.op === 'gitea.call' && call.params.op === 'issue.create' && call.params.params.title === '从界面新建'),
    `提交没有发出 issue.create：${JSON.stringify(calls)}`)
})

test('全局看板：服务器管理页渲染并探活', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const toggle = findNode(mini, (node) => node.props?.['data-gti-servers-toggle'] === 'true')
  toggle.props.onClick()
  let text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.match(text, /本地 Gitea/)
  assert.match(text, /已配置/)

  calls.length = 0
  const probe = findNode(mini, (node) => node.props?.['data-gti-probe'] === 'srv-a')
  assert.ok(probe, '没有探活按钮')
  probe.props.onClick()
  await flush()
  await flush()
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.ok(calls.some((call) => call.op === 'config.server.test'))
  assert.match(text, /1\.27\.3/)
  assert.match(text, /tester/)
})

test('工作区看板：无绑定 / 有绑定 / 进详情 / 进绑定设置', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component

  calls.length = 0
  let text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  assert.deepEqual(mini.errors, [], `渲染期报错：${mini.errors.map((error) => error.message).join('; ')}`)
  assert.match(text, /dongasai\/mylike/)
  assert.match(text, /第一个 issue/)
  assert.ok(calls.some((call) => call.op === 'binding.get'))
  assert.ok(calls.some((call) => call.op === 'gitea.call' && call.params.op === 'issue.list'))

  // 进详情
  const row = findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string')
  row.props.onClick(FIXTURES.issues[0])
  text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  assert.deepEqual(mini.errors, [])
  assert.match(text, /第一条评论/)
  assert.match(text, /note\.txt/)

  // 详情里的动作按钮存在（置顶 / 锁定 / 订阅 / 工时 / 附件）
  for (const name of ['issue.pin', 'issue.lock', 'issue.unsubscribe']) {
    assert.ok(findNode(mini, (node) => node.props?.['data-gti-action'] === name), `详情缺动作 ${name}`)
  }

  // 绑定设置：详情页没有那条工具条，先返回列表。
  const back = findNode(mini, (node) => node.props?.['data-gti-back'] === 'true')
  assert.ok(back, '详情页缺返回按钮')
  back.props.onClick()
  await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  const settings = findNode(mini, (node) => node.props?.['data-gti-binding-toggle'] === 'true')
  assert.ok(settings, '列表页缺绑定设置入口')
  settings.props.onClick()
  text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  assert.deepEqual(mini.errors, [])
  assert.match(text, /dongasai\/mylike/)
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-binding-save'] === 'true'), '绑定设置缺保存按钮')
})

test('工作区看板：没有 sessionId 时降级提示，不炸', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const text = await mini.render(mini.React.createElement(WorkspaceBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.match(text, /Gitea/, '没有会话时应当给出提示而不是空白')
})

test('筛选条改动会触发重新取数', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  // 默认是「泳道 + 按状态分组」，此时状态筛选被泳道接管（置灰、取全部）；
  // 切到列表模式才恢复成普通筛选 —— 这一步本身就是下面那条用例的断言。
  findNode(mini, (node) => node.props?.['data-gti-mode'] === 'list').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  calls.length = 0
  const select = findNode(mini, (node) => node.props?.['data-gti-filter-state'] === 'true')
  assert.ok(select, '没有状态筛选')
  assert.equal(select.props.disabled, false, '列表模式下状态筛选必须可用')
  select.props.onChange({ target: { value: 'closed' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.ok(calls.some((call) => call.op === 'gitea.call' && call.params.params.state === 'closed'),
    `切到 closed 后没有重新取数：${JSON.stringify(calls)}`)
})

/** 当前渲染里所有泳道的 key（按渲染顺序）—— 泳道模式的探针锚点。 */
function laneKeys(mini) {
  return findNodes(mini, (node) => typeof node.props?.['data-gti-lane'] === 'string')
    .map((node) => node.props['data-gti-lane'])
}

test('泳道模式：默认泳道 + 按状态分组，状态筛选被接管；切列表模式恢复扁平列表', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  calls.length = 0
  let text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-list'] !== undefined).props['data-gti-list'], 'lanes',
    '默认必须是泳道模式')
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-board'] !== undefined).props['data-gti-board'], 'state',
    '看板要带上当前分组维度（锚点，同时说明列是横着铺的）')
  // 按状态分泳道时取数固定「全部」，否则「已关闭」那条泳道永远不会出现（fixtures 一 open 一 closed）。
  assert.ok(calls.some((call) => call.op === 'gitea.call' && call.params.op === 'issue.search' && call.params.params.state === 'all'),
    `按状态分泳道应先取全部状态：${JSON.stringify(calls)}`)
  assert.deepEqual(laneKeys(mini), ['state:open', 'state:closed'])
  assert.match(text, /第一个 issue/)
  assert.match(text, /第二个 issue/)

  const locked = findNode(mini, (node) => node.props?.['data-gti-filter-state'] === 'true')
  assert.equal(locked.props.disabled, true, '状态与泳道维度重合时筛选要置灰')
  assert.equal(locked.props.value, 'all')
  // 置灰只有配一句可见解释才不算哑巴（禁用元素的 title 在部分浏览器里弹不出来）。
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-state-locked'] === 'true'),
    '置灰的状态筛选旁边必须有可见解释')

  // 切到列表模式：扁平列表回来、泳道消失、状态筛选可用，取数回到用户选的状态（默认进行中）。
  calls.length = 0
  findNode(mini, (node) => node.props?.['data-gti-mode'] === 'list').props.onClick()
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-list'] !== undefined).props['data-gti-list'], 'list')
  assert.deepEqual(laneKeys(mini), [])
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-filter-state'] === 'true').props.disabled, false)
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-state-locked'] === 'true'), undefined)
  assert.ok(calls.some((call) => call.op === 'gitea.call' && call.params.params.state === 'open'),
    `列表模式应回到普通状态筛选：${JSON.stringify(calls)}`)
})

test('泳道模式：分组维度可切换（指派 / 标签 / 里程碑），没值的落「未指派 / 无标签 / 无里程碑」', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  await mini.render(mini.React.createElement(GlobalBoard, {}))

  const groupOf = () => findNode(mini, (node) => node.props?.['data-gti-group'] === 'true')
  assert.ok(groupOf(), '泳道模式下必须有分组维度下拉')
  assert.equal(groupOf().props.value, 'state', '默认按状态分组')

  groupOf().props.onChange({ target: { value: 'assignee' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  // fixtures：#12 指派 tester，#13 谁都没指派 —— 后者必须出现在「未指派」泳道里，不能被漏掉。
  assert.deepEqual(laneKeys(mini), ['assignee:tester', 'assignee:-'])

  groupOf().props.onChange({ target: { value: 'label' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.deepEqual(laneKeys(mini), ['label:bug', 'label:-'])

  groupOf().props.onChange({ target: { value: 'milestone' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.deepEqual(laneKeys(mini), ['milestone:7', 'milestone:-'])

  // 分组不再是状态 → 状态筛选交还用户（默认进行中）。
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-filter-state'] === 'true').props.disabled, false)
})

test('泳道模式：按状态分组时空列也留着（看板要看得见哪一列是空的）', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  const saved = FIXTURES.issues
  try {
    // 只留 open 那条：已关闭列仍要在，只是里面是空的。
    FIXTURES.issues = saved.filter((issue) => issue.state === 'open')
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    assert.deepEqual(mini.errors, [])
    assert.deepEqual(laneKeys(mini), ['state:open', 'state:closed'])
    assert.ok(findNode(mini, (node) => node.props?.['data-gti-lane-empty'] === 'state:closed'),
      '空的「已关闭」列必须照样渲染出来')
  } finally {
    FIXTURES.issues = saved
  }
})

test('工作区看板：默认泳道模式，泳道里的行照样能发送到 DSH', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const { actions, log } = makeInputActions()

  calls.length = 0
  await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1', inputActions: actions }))
  assert.deepEqual(mini.errors, [])
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-list'] !== undefined).props['data-gti-list'], 'lanes',
    '工作区看板默认也必须是泳道模式')
  assert.deepEqual(laneKeys(mini), ['state:open', 'state:closed'])
  assert.ok(calls.some((call) => call.op === 'gitea.call' && call.params.op === 'issue.list' && call.params.params.state === 'all'))

  const send = findNode(mini, SEND_ROW(12))
  assert.ok(send, '泳道里的行尾也要有「发送到 DSH」')
  send.props.onClick()
  assert.equal(log.text, '请处理 Gitea issue #12：第一个 issue\n')
})

/** 在迷你 React 上一次渲染里找第一个满足条件的节点（含函数组件展开出来的宿主节点）。 */
function findNode(mini, predicate) {
  const found = mini.nodes?.find(predicate)
  return found
}

/** 全部满足条件的节点（同一个锚点出现多次时用，比如列表里每行一个发送按钮）。 */
function findNodes(mini, predicate) {
  return mini.nodes?.filter(predicate) ?? []
}

/**
 * 一个假的对话输入框写入面：`captureInsertion` 发一张「捕获票」，`insertText` 收下文本。
 * @param options - `accept`：`insertText` 的返回值；`false` 模拟「输入框正忙」。
 * @returns `{ actions, log }`。
 */
function makeInputActions(options = {}) {
  const log = { text: null, span: null, captures: 0, calls: 0 }
  const actions = {
    captureInsertion: () => { log.captures += 1; return { ticket: log.captures } },
    insertText: (text, span) => {
      log.calls += 1
      if (options.accept === false) return false
      log.text = text
      log.span = span
      return true
    },
  }
  return { actions, log }
}

/** 工作区看板里「发送到 DSH」的锚点值：`data-gti-send` 在列表行上是 issueKey，在详情里是 `true`。 */
const SEND_ROW = (index) => (node) => typeof node.props?.['data-gti-send'] === 'string' &&
  node.props['data-gti-send'].endsWith(`\u0000${index}`)

test('发送到 DSH：列表行只把「请处理 issue #编号：标题」这一行插进输入框（不带网址）', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const InputSink = fake.slots.find((entry) => entry.options.name === 'conversation.input.dock').component
  const { actions, log } = makeInputActions()

  // 哨兵登记：真实 GUI 里 `conversation.input.dock` 就是这么把写入面交出来的。
  await mini.render(mini.React.createElement(InputSink, { sessionId: 'session-1', inputActions: actions }))
  assert.deepEqual(mini.errors, [])

  let text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  assert.deepEqual(mini.errors, [], `渲染期报错：${mini.errors.map((error) => error.message).join('; ')}`)
  const send = findNode(mini, SEND_ROW(12))
  assert.ok(send, '列表行没有「发送到 DSH」按钮')
  send.props.onClick()
  assert.equal(log.text, '请处理 Gitea issue #12：第一个 issue\n', '插进输入框的文本不对')
  // 用户明确要求：**不带网址**（这条 issue 的 htmlUrl 是有的，仍然不该出现在提示词里）。
  assert.doesNotMatch(log.text, /http/, '提示词里不该有网址')
  assert.ok(log.captures >= 1, '插入前必须先捕获选区（插入是捕获 + 草稿版本的 CAS）')

  text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  assert.deepEqual(mini.errors, [])
  assert.match(text, /已把 #12 发到对话输入框/)
})

test('发送到 DSH：详情页动作行发的是当前这条 issue', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const { actions, log } = makeInputActions()

  // 这一条走**槽位 prop** 那条路（没有哨兵）—— 两条路都得能用。
  await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-2', inputActions: actions }))
  const row = findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string')
  assert.ok(row, '没有找到列表行')
  row.props.onClick(FIXTURES.issues[0])
  let text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-2', inputActions: actions }))
  assert.deepEqual(mini.errors, [])

  const send = findNode(mini, (node) => node.props?.['data-gti-send'] === 'true')
  assert.ok(send, '详情页动作行没有「发送到 DSH」')
  send.props.onClick()
  assert.equal(log.text, '请处理 Gitea issue #12：第一个 issue\n')
  text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-2', inputActions: actions }))
  assert.deepEqual(mini.errors, [])
  assert.match(text, /已把 #12 发到对话输入框/)
})

test('发送到 DSH：拿不到输入框 / 输入框正忙都亮横幅，不炸', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component

  // 没有任何哨兵、槽位也没传 `inputActions`（用别人没登记过的会话 id，避免串场）。
  await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-no-dock' }))
  let send = findNode(mini, SEND_ROW(12))
  assert.ok(send, '列表行没有「发送到 DSH」按钮')
  send.props.onClick()
  let text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-no-dock' }))
  assert.deepEqual(mini.errors, [])
  assert.match(text, /拿不到对话输入框/)

  // 输入框正忙：`insertText` 返回 false（正在提交，或草稿刚被别处改过）。
  const { actions, log } = makeInputActions({ accept: false })
  await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-4', inputActions: actions }))
  send = findNode(mini, SEND_ROW(12))
  send.props.onClick()
  text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-4', inputActions: actions }))
  assert.deepEqual(mini.errors, [])
  assert.equal(log.text, null, '被拒时不该记下文本')
  assert.match(text, /输入框正忙/)
})

test('发送到 DSH：只有工作区看板有这个入口，全局看板不碰输入框', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.deepEqual(findNodes(mini, (node) => node.props?.['data-gti-send'] !== undefined), [],
    '全局看板是跨工作区的视图，不该出现「发送到 DSH」')
})
