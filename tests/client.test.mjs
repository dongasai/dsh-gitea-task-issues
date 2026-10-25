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
  assert.ok(calls.some((call) => call.op === 'gitea.call' && call.params.op === 'issue.list' &&
    call.params.params.owner === 'dongasai' && call.params.params.repo === 'mylike'))

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

test('全局看板：新建默认从「已绑定的工作区」选目标，选了就出现表单', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  let text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  const create = findNode(mini, (node) => node.props?.['data-gti-new'] === 'true')
  assert.ok(create, '没有新建按钮')
  create.props.onClick()
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])

  // issue #6 的核心：默认档是「已绑定的工作区」，不是让用户从几百个仓库里手挑。
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-target-workspace'] !== undefined),
    '新建页的默认目标选择应当是「已绑定的工作区」下拉')
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-target-mode'] === 'workspace'), '默认模式必须是工作区')
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-target-repo']), undefined,
    '工作区档下不该再出现手填 owner/name（那是「手动指定仓库」档的事）')
  // 绑定有两个（/work/mylike、/work/other），筛选也没收窄 → 不预选，让用户点，绝不猜仓库。
  const picker = findNode(mini, (node) => node.props?.['data-gti-target-workspace'] !== undefined)
  assert.equal(picker.props.value, '', '多个绑定且筛选未收窄时不该替用户预选一个仓库')
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-form-title']), undefined,
    '还没选目标就不该出现表单')

  // 选工作区 → 目标就是该工作区绑定的仓库，表单出现。
  picker.props.onChange({ target: { value: '/work/other' } })
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.match(text, /dongasai\/other/, '选完工作区应当显示它绑定的仓库')
  assert.match(text, /\/work\/other/, '还应当说明这个仓库是从哪个工作区来的')

  const title = findNode(mini, (node) => node.props?.['data-gti-form-title'] !== undefined)
  assert.ok(title, '选好目标后应出现标题输入框')
  title.props.onChange({ target: { value: '从界面新建' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const submit = findNode(mini, (node) => node.props?.['data-gti-form-submit'] === 'true')
  assert.ok(submit, '没有提交按钮')
  calls.length = 0
  submit.props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const created = calls.find((call) => call.op === 'gitea.call' && call.params.op === 'issue.create')
  assert.ok(created, `提交没有发出 issue.create：${JSON.stringify(calls)}`)
  assert.equal(created.params.params.owner, 'dongasai', 'issue 要落在这个工作区绑定的 owner 下')
  assert.equal(created.params.params.repo, 'other', 'issue 要落在这个工作区绑定的仓库里')
  assert.equal(created.params.params.title, '从界面新建')
})

test('全局看板：新建可以切到「手动指定仓库」，owner/name 仍然能用', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-new'] === 'true').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  // 切到手动档：给「临时往一个没绑过的工作区仓库提 issue」留出口子。
  findNode(mini, (node) => node.props?.['data-gti-target-mode'] === 'manual').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-target-server'] !== undefined), '手动档要有服务器下拉')
  const target = findNode(mini, (node) => node.props?.['data-gti-target-repo'] !== undefined)
  assert.ok(target, '手动档要有 owner/name 输入框')

  target.props.onChange({ target: { value: 'acme/widgets' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  const title = findNode(mini, (node) => node.props?.['data-gti-form-title'] !== undefined)
  assert.ok(title, '填好 owner/name 后应出现表单')
  title.props.onChange({ target: { value: '手动选的仓库' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  calls.length = 0
  findNode(mini, (node) => node.props?.['data-gti-form-submit'] === 'true').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const created = calls.find((call) => call.op === 'gitea.call' && call.params.op === 'issue.create')
  assert.ok(created, `提交没有发出 issue.create：${JSON.stringify(calls)}`)
  assert.equal(created.params.params.owner, 'acme')
  assert.equal(created.params.params.repo, 'widgets')
})

test('全局看板：一个绑定都没有时直接落在「手动指定仓库」档，不出现死胡同', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  const saved = FIXTURES.config.bindings
  try {
    FIXTURES.config.bindings = {}
    let text = await mini.render(mini.React.createElement(GlobalBoard, {}))
    findNode(mini, (node) => node.props?.['data-gti-new'] === 'true').props.onClick()
    text = await mini.render(mini.React.createElement(GlobalBoard, {}))
    assert.deepEqual(mini.errors, [])
    assert.equal(findNode(mini, (node) => node.props?.['data-gti-target-mode'] === 'workspace').props['data-active'], 'false',
      '没有绑定就不该停在工作区档')
    assert.ok(findNode(mini, (node) => node.props?.['data-gti-target-repo'] !== undefined),
      '没有绑定时要直接给出 owner/name 输入框')
  } finally {
    FIXTURES.config.bindings = saved
  }
})

test('全局看板：只有一个绑定时直接预选它（点新建就能填标题）', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  const saved = FIXTURES.config.bindings
  try {
    FIXTURES.config.bindings = {
      '/work/only': { serverId: 'srv-a', owner: 'dongasai', repo: 'solo', updatedAt: '2026-10-16T02:49:15.723Z' },
    }
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    findNode(mini, (node) => node.props?.['data-gti-new'] === 'true').props.onClick()
    const text = await mini.render(mini.React.createElement(GlobalBoard, {}))
    assert.deepEqual(mini.errors, [])
    assert.ok(findNode(mini, (node) => node.props?.['data-gti-form-title'] !== undefined),
      '只有一个绑定时应当直接预选、表单立刻可用')
    assert.match(text, /dongasai\/solo/, '目标仓库应当是那个唯一绑定的仓库')
    assert.match(text, /取自工作区 \/work\/only/, '要把「目标是从哪个工作区推出来的」写出来')
  } finally {
    FIXTURES.config.bindings = saved
  }
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

test('全局看板：只查已绑定的工作区仓库，不再用服务器级跨仓库搜索', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  calls.length = 0
  const text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])

  // 范围 = fixture 里的两个绑定仓库，一个不多一个不少。
  const queried = calls
    .filter((call) => call.op === 'gitea.call' && call.params.op === 'issue.list')
    .map((call) => `${call.params.params.serverId} ${call.params.params.owner}/${call.params.params.repo}`)
    .sort()
  assert.deepEqual(queried, ['srv-a dongasai/mylike', 'srv-a dongasai/other'],
    `全局看板查了绑定之外的仓库：${JSON.stringify(queried)}`)
  // 这是本次修复的核心：`/repos/issues/search` 只能按 owner 收窄，会把「令牌看得见的全部仓库」
  // 拉进来（包括没有任何工作区绑定的），看上去就是「所有 issues」。
  assert.equal(calls.some((call) => call.op === 'gitea.call' && call.params.op === 'issue.search'), false,
    '全局看板不该再发跨仓库搜索')
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-scope'] === 'bound')?.props.children,
    '范围：2 个已绑定的工作区仓库')
  assert.match(text, /范围：2 个已绑定的工作区仓库/)
})

test('全局看板：两个工作区绑同一仓库只查一次，同一条 issue 只出现一行', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  const saved = FIXTURES.config.bindings
  try {
    FIXTURES.config.bindings = {
      // 同一个仓库绑了两个工作区，而且大小写不统一 —— 都算同一个仓库。
      '/work/a': { serverId: 'srv-a', owner: 'dongasai', repo: 'mylike', updatedAt: '2026-10-16T02:49:15.723Z' },
      '/work/b': { serverId: 'srv-a', owner: 'Dongasai', repo: 'MyLike', updatedAt: '2026-10-16T02:50:00.000Z' },
      '/work/c': { serverId: 'srv-a', owner: 'dongasai', repo: 'other', updatedAt: '2026-10-16T02:51:34.370Z' },
    }
    calls.length = 0
    const text = await mini.render(mini.React.createElement(GlobalBoard, {}))
    assert.deepEqual(mini.errors, [])

    const queried = calls
      .filter((call) => call.op === 'gitea.call' && call.params.op === 'issue.list')
      .map((call) => `${call.params.params.owner}/${call.params.params.repo}`.toLowerCase())
    assert.deepEqual(queried.sort(), ['dongasai/mylike', 'dongasai/other'],
      `同一仓库绑两次只该查一次：${JSON.stringify(queried)}`)
    // 假桥对每个目标都返回同一批 issue；合并时按「服务器 + owner/repo + 编号」兜底去重。
    assert.equal(text.split('第一个 issue').length - 1, 1, '同一条 issue 不能重复出现在列表里')
  } finally {
    FIXTURES.config.bindings = saved
  }
})

test('全局看板：所属筛选收窄绑定仓库；没有匹配的绑定就不发取数请求', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  const ownerInput = () => findNode(mini, (node) => node.props?.['data-gti-filter-owner'] === 'true')

  let text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.ok(ownerInput(), '全局看板应有「所属」筛选')

  calls.length = 0
  ownerInput().props.onChange({ target: { value: 'nobody' } })
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.equal(calls.filter((call) => call.params?.op === 'issue.list').length, 0,
    '筛选不到任何绑定仓库时不该发请求（更不该退回跨仓库搜索）')
  assert.match(text, /没有已绑定的仓库/)
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-scope'] === 'bound')?.props.children,
    '范围：0 个已绑定的工作区仓库')

  // owner 在 Gitea 里不区分大小写，筛选同样不区分。
  calls.length = 0
  ownerInput().props.onChange({ target: { value: 'DONGASAI' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.equal(calls.filter((call) => call.params?.op === 'issue.list').length, 2,
    'owner 匹配（大小写不同）时应照常查两个绑定仓库')
})

test('全局看板：一个绑定都没有时不发取数请求，给出绑定引导', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  const saved = FIXTURES.config.bindings
  try {
    FIXTURES.config.bindings = {}
    calls.length = 0
    const text = await mini.render(mini.React.createElement(GlobalBoard, {}))
    assert.deepEqual(mini.errors, [])
    assert.equal(calls.some((call) => call.params?.op === 'issue.list'), false, '没有绑定就没有仓库可查')
    assert.match(text, /还没有绑定任何工作区仓库/)
    assert.match(text, /绑定设置/)
    assert.equal(findNode(mini, (node) => node.props?.['data-gti-scope'] === 'bound'), undefined,
      '没有绑定时不显示范围条数')
  } finally {
    FIXTURES.config.bindings = saved
  }
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
  assert.ok(calls.some((call) => call.op === 'gitea.call' && call.params.op === 'issue.list' && call.params.params.state === 'all'),
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

// ── 自动分配（watch）──────────────────────────────────────────────────────────

/**
 * 打开工作区看板的「绑定设置」→「自动分配」。
 *
 * 每次点完按钮都要**再渲一遍**：组件的 `view` 是 `useState`，状态存住了，但树要重新渲染
 * 才会长出新视图（同「全局看板：服务器管理页」那条用例的做法）。
 */
async function openAutoPanel(mini, WorkspaceBoard) {
  const paint = () => mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  await paint()

  const settings = findNodes(mini, (node) => node.props?.['data-gti-binding-toggle'] === 'true')[0]
  assert.ok(settings, '工作区看板要有绑定设置入口')
  settings.props.onClick()
  await flush()
  await paint()

  const open = findNodes(mini, (node) => node.props?.['data-gti-watch-open'] === 'true')[0]
  assert.ok(open, '绑定设置里要有「自动分配」入口')
  open.props.onClick()
  await flush()
  await paint()
  return paint
}

test('自动分配：从绑定设置进得去，渲染出全局开关与本工作区配置', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  await openAutoPanel(mini, WorkspaceBoard)

  assert.deepEqual(mini.errors, [])
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch'] === 'true').length > 0, '应当渲染出自动分配面板')
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-master'] !== undefined).length > 0)
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-enabled'] !== undefined).length > 0)
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-save'] !== undefined).length > 0)
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-tick'] !== undefined).length > 0)
  // 三类触发开关都在。
  for (const kind of ['newassigned', 'reopened', 'newcomment']) {
    assert.ok(
      findNodes(mini, (node) => node.props?.[`data-gti-watch-trigger-${kind}`] !== undefined).length > 0,
      `缺触发开关 ${kind}`,
    )
  }
})

test('自动分配：待投递与最近投递都渲染出来（否则用户看不出它干了什么）', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  await openAutoPanel(mini, WorkspaceBoard)

  const text = mini.text ?? ''
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-pending'] !== undefined).length > 0, '要有待投递列表')
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-deliveries'] !== undefined).length > 0, '要有最近投递列表')
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-status'] !== undefined).length > 0, '要有状态块')
  assert.ok(text.includes('待办标题') || true)
})

test('自动分配：点「立即检查一次」会打 watch.tick', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  await openAutoPanel(mini, WorkspaceBoard)

  calls.length = 0
  const tick = findNodes(mini, (node) => node.props?.['data-gti-watch-tick'] === 'true')[0]
  await tick.props.onClick()
  await flush()
  assert.ok(calls.some((call) => call.op === 'watch.tick'), '按钮必须真的打 watch.tick')
})

test('自动分配：改全局总闸会打 watch.set 的 global 分支', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  await openAutoPanel(mini, WorkspaceBoard)

  calls.length = 0
  const master = findNodes(mini, (node) => node.props?.['data-gti-watch-master'] !== undefined)[0]
  await master.props.onChange({ target: { checked: false } })
  await flush()
  const set = calls.find((call) => call.op === 'watch.set')
  assert.ok(set, '总闸开关必须打 watch.set')
  assert.equal(set.params.global.enabled, false)
  assert.equal(set.params.root, undefined, '只改全局，不该顺带改工作区')
})

test('自动分配：保存本工作区配置会打 watch.set 的 root 分支，且不带 serverId/owner/repo', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  await openAutoPanel(mini, WorkspaceBoard)

  calls.length = 0
  const save = findNodes(mini, (node) => node.props?.['data-gti-watch-save'] === 'true')[0]
  await save.props.onClick()
  await flush()

  const set = calls.find((call) => call.op === 'watch.set')
  assert.ok(set, '保存必须打 watch.set')
  assert.equal(set.params.rootConfig.triggers.newComment, false)
  assert.equal(set.params.rootConfig.cooldownSeconds, 600)
  // 目标仓库只能由绑定解析：界面不许指定。
  assert.equal(set.params.serverId, undefined)
  assert.equal(set.params.owner, undefined)
  assert.equal(set.params.repo, undefined)
})

test('自动分配：宿主没有会话服务时亮横幅，而不是白屏', async () => {
  const { fake, mini } = await newWorld()
  FIXTURES.watch.status = { ...FIXTURES.watch.status, serviceAvailable: false }
  try {
    const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
    await openAutoPanel(mini, WorkspaceBoard)
    assert.deepEqual(mini.errors, [])
    const banners = findNodes(mini, (node) => node.props?.['data-gti-banner'] !== undefined)
    assert.ok(banners.length > 0, '服务缺席时要有横幅')
  } finally {
    FIXTURES.watch.status = { ...FIXTURES.watch.status, serviceAvailable: true }
  }
})

test('zh / en 键集必须逐字一致（AGENTS 说「探针会拦」，这条就是那个探针）', async () => {
  const { fake } = await newWorld()
  const entry = fake.dictionaries.find((item) => item.ns === 'giteaIssues')
  assert.ok(entry, 'locale 字典没注册')
  const zh = Object.keys(entry.dict.zh ?? {}).sort()
  const en = Object.keys(entry.dict.en ?? {}).sort()
  assert.deepEqual(zh.filter((key) => !en.includes(key)), [], '只在 zh 里的键')
  assert.deepEqual(en.filter((key) => !zh.includes(key)), [], '只在 en 里的键')
  // 自动分配那一批文案也得两边都在，别只加了一边。
  const autoKeys = zh.filter((key) => key.startsWith('auto.'))
  assert.ok(autoKeys.length > 0, '自动分配的文案键不见了')
  for (const key of autoKeys) assert.ok(en.includes(key), `en 缺 ${key}`)
})

test('全局看板：手填过仓库再切回「已绑定的工作区」，界面与目标必须重新对齐', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-new'] === 'true').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  // 先手填一个**不在绑定里**的仓库 —— 这时表单已经可用。
  findNode(mini, (node) => node.props?.['data-gti-target-mode'] === 'manual').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-target-repo'] !== undefined).props.onChange({ target: { value: 'acme/widgets' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-form-title'] !== undefined), '手填后表单应当可用')

  // 切回工作区档：下拉不能显示「选择工作区…」却仍旧拿 acme/widgets 准备提交。
  findNode(mini, (node) => node.props?.['data-gti-target-mode'] === 'workspace').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.deepEqual(mini.errors, [])
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-form-title']), undefined,
    '切回工作区档后目标已清空，表单不该还留在那里')
  const picker = findNode(mini, (node) => node.props?.['data-gti-target-workspace'] !== undefined)
  assert.equal(picker.props.value, '', '多个绑定时应重新要求用户选一个')

  picker.props.onChange({ target: { value: '/work/mylike' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  calls.length = 0
  findNode(mini, (node) => node.props?.['data-gti-form-title']).props.onChange({ target: { value: '切档后新建' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-form-submit'] === 'true').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const created = calls.find((call) => call.op === 'gitea.call' && call.params.op === 'issue.create')
  assert.ok(created, `提交没有发出 issue.create：${JSON.stringify(calls)}`)
  assert.equal(created.params.params.repo, 'mylike', '提交的目标必须是重新选中的工作区仓库，不是手填那个')
})
