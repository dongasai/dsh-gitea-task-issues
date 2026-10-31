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

test('工作区看板：自动投递开着时标题栏有徽标，点按直接进自动分配设置', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component

  calls.length = 0
  const text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  assert.deepEqual(mini.errors, [])

  const badge = findNode(mini, (node) => typeof node.props?.['data-gti-auto-badge'] === 'string')
  assert.ok(badge, '开启自动投递时标题栏必须有可见徽标（用户 2026-10-25 反馈的正是这个缺口）')
  assert.equal(badge.props['data-gti-auto-badge'], 'on')
  assert.match(text, /自动投递已开/)
  // fixtures 的 pending 里 #9 属于 srv-a/dongasai/mylike —— 徽标按「当前仓库」算待投递条数。
  assert.match(text, /待投递 1/)
  assert.match(badge.props.title, /下次检查/, '悬停要能看出轮询还在跑（带下次检查时刻）')
  assert.ok(calls.some((call) => call.op === 'watch.get'), '徽标要自己读账本，不能等配置页来喂')

  // 徽标本身就是入口：点一下直接进自动分配设置，不必先摸齿轮。
  badge.props.onClick()
  await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  assert.deepEqual(mini.errors, [])
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-watch'] === 'true'), '点徽标应直接进自动分配设置')

  // 从徽标进来的返回应该回列表，而不是先落到绑定设置页。
  findNode(mini, (node) => node.props?.['data-gti-auto-back'] === 'true').props.onClick()
  await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  assert.ok(findNode(mini, (node) => node.props?.['data-gti-filter-state'] === 'true'), '返回应回到列表页')
})

test('工作区看板：演练模式 / 仓库变更 / 宿主无会话服务各有对应徽标', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const kindOf = () => findNode(mini, (node) => typeof node.props?.['data-gti-auto-badge'] === 'string')?.props['data-gti-auto-badge'] ?? null
  const savedGlobal = FIXTURES.watch.global
  const savedRoots = FIXTURES.watch.roots
  const savedStatus = FIXTURES.watch.status
  try {
    // 演练：看起来开着，其实只记账 —— 必须区别于「已开」，否则用户以为会话会被拉起来。
    FIXTURES.watch.global = { ...savedGlobal, dryRun: true }
    const dryText = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.equal(kindOf(), 'dry')
    assert.match(dryText, /自动投递·演练/)

    // 绑定换过仓库：轮询器会跳过这个工作区，徽标不能还说「已开」。
    FIXTURES.watch.global = { ...savedGlobal }
    FIXTURES.watch.roots = {
      '/work/mylike': { ...savedRoots['/work/mylike'], repo: 'moved' },
    }
    await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.equal(kindOf(), 'mismatch')
    assert.match(findNode(mini, (node) => node.props?.['data-gti-auto-badge'] === 'mismatch').props.title, /重新保存/)

    // 宿主没挂会话服务：开着也开不出会话。
    FIXTURES.watch.roots = savedRoots
    FIXTURES.watch.status = { ...savedStatus, serviceAvailable: false }
    await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.equal(kindOf(), 'unavailable')
  } finally {
    FIXTURES.watch.global = savedGlobal
    FIXTURES.watch.roots = savedRoots
    FIXTURES.watch.status = savedStatus
  }
})

test('工作区看板：总开关关着 / 这个工作区没配自动分配时不显示徽标', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const badgeOf = () => findNode(mini, (node) => typeof node.props?.['data-gti-auto-badge'] === 'string')
  const savedGlobal = FIXTURES.watch.global
  const savedRoots = FIXTURES.watch.roots
  try {
    FIXTURES.watch.global = { ...savedGlobal, enabled: false }
    await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.deepEqual(mini.errors, [])
    assert.equal(badgeOf(), undefined, '总开关关着就不该亮徽标')

    FIXTURES.watch.global = savedGlobal
    FIXTURES.watch.roots = {}
    await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.equal(badgeOf(), undefined, '账本里没有这个工作区 = 不会被轮询，不能按面板默认值说成开着')
  } finally {
    FIXTURES.watch.global = savedGlobal
    FIXTURES.watch.roots = savedRoots
  }
})


test('工作区看板：徽标里的下次检查倒计时按 mm:ss 走', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const savedStatus = FIXTURES.watch.status
  try {
    FIXTURES.watch.status = { ...savedStatus, nextTickAt: new Date(Date.now() + 125_000).toISOString() }
    const text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.deepEqual(mini.errors, [])
    assert.ok(findNode(mini, (node) => node.props?.['data-gti-auto-countdown'] === 'true'),
      '徽标里要有倒计时锚点')
    // 125 秒 → 02:05（留一点执行耗时的宽容）。
    assert.match(text, /02:0[4-5] 后检查/)
    // 等一秒多再看：倒计时要真的在走，而不是渲染一次就定死。
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const later = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.match(later, /02:0[2-4] 后检查/, '倒计时要按秒递减')
  } finally {
    FIXTURES.watch.status = savedStatus
  }
})

test('工作区看板：倒计时到点显示「即将检查」并重读账本', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const savedStatus = FIXTURES.watch.status
  try {
    FIXTURES.watch.status = { ...savedStatus, nextTickAt: new Date(Date.now() - 5_000).toISOString() }
    calls.length = 0
    const text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.deepEqual(mini.errors, [])
    assert.match(text, /即将检查/)
    // 到点后要重新读一次账本拿新的 nextTickAt，否则倒计时会永远停在「即将检查」。
    assert.ok(calls.filter((call) => call.op === 'watch.get').length >= 2,
      `到点后应重读账本：${JSON.stringify(calls.map((call) => call.op))}`)
  } finally {
    FIXTURES.watch.status = savedStatus
  }
})

test('工作区看板：退避中徽标写出失败次数，悬停带上次错误', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const savedStatus = FIXTURES.watch.status
  try {
    FIXTURES.watch.status = {
      ...savedStatus,
      consecutiveFailures: 3,
      lastError: { code: 'token-missing', message: 'server "x" has no token', at: '2026-10-25T09:00:00.000Z' },
    }
    const text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.deepEqual(mini.errors, [])
    // 退避会把「下次检查」拉长（最长 30 分钟）。徽标必须说明原因，否则看起来像「60 秒没生效」。
    assert.match(text, /退避 ×3/)
    const badge = findNode(mini, (node) => typeof node.props?.['data-gti-auto-badge'] === 'string')
    assert.match(badge.props.title, /连续失败 3 次/)
    assert.match(badge.props.title, /token-missing/)
  } finally {
    FIXTURES.watch.status = savedStatus
  }
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
  const paint = await openAutoPanel(mini, WorkspaceBoard)

  const text = await paint()
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-pending'] !== undefined).length > 0, '要有待投递列表')
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-deliveries'] !== undefined).length > 0, '要有最近投递列表')
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-status'] !== undefined).length > 0, '要有状态块')
  // 「下次检查」既给绝对时刻也给倒计时：绝对时刻对表，倒计时看得出轮询还活着。
  assert.match(text, /下次检查/)
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-auto-countdown'] === 'true').length > 0,
    '运行状态的下次检查要有倒计时锚点')
  assert.ok(text.includes('待办标题'))
})

test('自动分配：连续失败时状态块说明正在退避（否则「下次检查」变长像配置没生效）', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const savedStatus = FIXTURES.watch.status
  try {
    FIXTURES.watch.status = {
      ...savedStatus,
      consecutiveFailures: 2,
      lastError: { code: 'token-missing', message: 'no token', at: '2026-10-25T09:00:00.000Z' },
    }
    const paint = await openAutoPanel(mini, WorkspaceBoard)
    const text = await paint()
    assert.deepEqual(mini.errors, [])
    assert.ok(findNodes(mini, (node) => node.props?.['data-gti-watch-backoff'] === 'true').length > 0,
      '状态块要有退避说明')
    assert.match(text, /连续失败 2 次/)
    assert.match(text, /上次失败/)
  } finally {
    FIXTURES.watch.status = savedStatus
  }
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
  assert.equal(set.params.rootConfig.maxActiveSessions, 1, '同项目活跃会话上限默认 1（旧行为）')
  // 目标仓库只能由绑定解析：界面不许指定。
  assert.equal(set.params.serverId, undefined)
  assert.equal(set.params.owner, undefined)
  assert.equal(set.params.repo, undefined)
})

test('自动分配：有预设名册时用下拉选「模式」，保存的是预设 id', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  await openAutoPanel(mini, WorkspaceBoard)

  const picker = findNodes(mini, (node) => node.props?.['data-gti-watch-preset'] === 'roster')[0]
  assert.ok(picker, '有名册时必须渲染成下拉（用户要的「能选模式」）')
  assert.equal(picker.props.value, '', '默认档是「跟随宿主默认」')
  const options = picker.props.children
  assert.deepEqual(options.map((option) => option.props.value), ['', 'standard', 'ptc', 'minimal', 'cordis'])
  // 默认档要把宿主默认模式的名字写出来，否则「跟随默认」等于没说。
  assert.match(options[0].props.children, /跟随宿主默认（标准模式）/)
  assert.equal(options[1].props.children, '标准模式', '内置预设按 id 查本地文案（宿主不发布 name）')
  assert.equal(options[2].props.children, 'PTC mode', '自定义预设用宿主给的 name')
  assert.equal(options[4].props.disabled, true, '加载失败的预设不能选')
  assert.match(options[4].props.children, /加载失败/)

  // 选 PTC 模式 → 保存 → rootConfig 里必须是预设 id，开会话就按它走。
  picker.props.onChange({ target: { value: 'ptc' } })
  await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  calls.length = 0
  await findNodes(mini, (node) => node.props?.['data-gti-watch-save'] === 'true')[0].props.onClick()
  await flush()
  const set = calls.find((call) => call.op === 'watch.set')
  assert.ok(set, '保存必须打 watch.set')
  assert.equal(set.params.rootConfig.agentPreset, 'ptc')
})

test('自动分配：宿主没有预设名册时退回手填 id（面板不白屏）', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const saved = FIXTURES.presets
  try {
    FIXTURES.presets = { available: false, defaultId: null, presets: [] }
    await openAutoPanel(mini, WorkspaceBoard)

    const manual = findNodes(mini, (node) => node.props?.['data-gti-watch-preset'] === 'manual')[0]
    assert.ok(manual, '没有名册就退回手填 id')
    const text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    assert.match(text, /手填预设 id/)

    manual.props.onChange({ target: { value: 'team-mode' } })
    await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    calls.length = 0
    await findNodes(mini, (node) => node.props?.['data-gti-watch-save'] === 'true')[0].props.onClick()
    await flush()
    assert.equal(calls.find((call) => call.op === 'watch.set').params.rootConfig.agentPreset, 'team-mode')
  } finally {
    FIXTURES.presets = saved
  }
})

test('自动分配：旧宿主没有 presets.list 时，提示要说清「重启 Harness」', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  try {
    FIXTURES.presetsError = 'unknown-operation'
    await openAutoPanel(mini, WorkspaceBoard)

    const manual = findNodes(mini, (node) => node.props?.['data-gti-watch-preset'] === 'manual')[0]
    assert.ok(manual, '拿不到名册就退回手填（不能白屏）')
    const text = await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
    // 最常见的误判就是「下拉被写成了输入框」—— 提示里必须点出重启这一步。
    assert.match(text, /重启 Harness/)
  } finally {
    delete FIXTURES.presetsError
  }
})

test('自动分配：账本里存的预设已不在当前名册时也要显示出来，不能被悄悄改回默认', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const savedRoots = FIXTURES.watch.roots
  try {
    FIXTURES.watch.roots = {
      ...savedRoots,
      '/work/mylike': { ...savedRoots['/work/mylike'], agentPreset: 'ghost-mode' },
    }
    await openAutoPanel(mini, WorkspaceBoard)

    const picker = findNodes(mini, (node) => node.props?.['data-gti-watch-preset'] === 'roster')[0]
    assert.equal(picker.props.value, 'ghost-mode', '当前值必须保持，不能被下拉重置成默认档')
    const ghost = picker.props.children.find((option) => option.props.value === 'ghost-mode')
    assert.ok(ghost, '缺的那一项要补进选项，否则下拉显示的和账本里的对不上')
    assert.match(ghost.props.children, /不在当前名册/)
  } finally {
    FIXTURES.watch.roots = savedRoots
  }
})

test('自动分配：可调「同项目活跃会话上限」，保存进 rootConfig', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  await openAutoPanel(mini, WorkspaceBoard)

  const input = findNodes(mini, (node) => node.props?.['data-gti-watch-maxactive'] === 'true')[0]
  assert.ok(input, '面板要有「同项目活跃会话上限」输入框')
  assert.equal(input.props.value, 1, '默认 1：有人在跑就不再开新的')
  assert.ok(findNodes(mini, (node) => node.props?.['data-gti-maxactive-hint'] === 'true').length > 0,
    '这个数会改变投递行为，必须有一句解释')

  input.props.onChange({ target: { value: '3' } })
  await mini.render(mini.React.createElement(WorkspaceBoard, { sessionId: 'session-1' }))
  calls.length = 0
  await findNodes(mini, (node) => node.props?.['data-gti-watch-save'] === 'true')[0].props.onClick()
  await flush()
  const set = calls.find((call) => call.op === 'watch.set')
  assert.equal(set.params.rootConfig.maxActiveSessions, 3)
})

test('自动分配：被活跃会话上限挡下的投递记录能读出上限数字', async () => {
  const { fake, mini } = await newWorld()
  const WorkspaceBoard = fake.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  const saved = FIXTURES.watch.deliveries
  try {
    FIXTURES.watch.deliveries = [{
      at: '2026-10-25T09:00:00.000Z', key: 'srv-a/dongasai/mylike#7', root: '/work/mylike',
      index: 7, title: '被挡下的任务', kinds: ['newAssigned'],
      outcome: 'capped', reason: 'active', active: 3, limit: 3,
    }]
    const paint = await openAutoPanel(mini, WorkspaceBoard)
    const text = await paint()
    assert.match(text, /同项目活跃会话已达上限（3）/, '要说清是哪条闸门挡的、上限是多少')
    assert.doesNotMatch(text, /\(active\)/, '内部 reason 不该直接摊给用户看')
    assert.match(text, /被挡下的任务/)
  } finally {
    FIXTURES.watch.deliveries = saved
  }
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

// ── 正文贴图：编辑 / 新建 / 评论 / 只认图片 / 半成功 ──────────────────────────

/**
 * 造一张真的图片 `File`（Node 18+ 有全局 `File`，`arrayBuffer()` 走的是同一套 Blob 实现）。
 * @param name - 文件名。
 * @param type - MIME。
 * @param bytes - 内容（默认塞一个 PNG 头，够 `byteLength` 与 base64 用）。
 * @returns `File`。
 */
function imageFile(name = 'shot.png', type = 'image/png', bytes = [137, 80, 78, 71]) {
  return new File([new Uint8Array(bytes)], name, { type })
}

/** 模拟一次带文件的粘贴 / 拖入事件。 */
function fileEvent(file) {
  return {
    clipboardData: { files: [file] },
    target: { selectionStart: 0, selectionEnd: 0 },
    preventDefault() {},
  }
}

test('编辑 issue：粘贴图片立刻上传，markdown 插在光标处并随正文一起保存', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  let text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string').props.onClick(FIXTURES.issues[0])
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-edit'] === 'true').props.onClick()
  text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  const body = findNode(mini, (node) => node.props?.['data-gti-form-body'] !== undefined)
  assert.ok(body, '没有进入编辑表单')

  calls.length = 0
  body.props.onPaste(fileEvent(imageFile()))
  await flush()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const upload = calls.find((call) => call.op === 'gitea.call' && call.params.op === 'issue.assets.upload')
  assert.ok(upload, `粘贴图片没有走上传：${JSON.stringify(calls)}`)
  assert.equal(upload.params.params.index, 12, '编辑时上传必须落在这条 issue 的附件端点')
  assert.equal(upload.params.params.filename, 'shot.png')

  const updated = findNode(mini, (node) => node.props?.['data-gti-form-body'] !== undefined)
  assert.equal(updated.props.value, '![shot.png](/attachments/148f63a9-5bfd-4b08-b85a-d996fc6cf47a)正文内容', 'markdown 应插在光标（开头）处')

  findNode(mini, (node) => node.props?.['data-gti-form-submit'] === 'true').props.onClick()
  await flush()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const saved = calls.find((call) => call.op === 'gitea.call' && call.params.op === 'issue.edit')
  assert.ok(saved, '保存没有发出 issue.edit')
  assert.equal(saved.params.params.body, '![shot.png](/attachments/148f63a9-5bfd-4b08-b85a-d996fc6cf47a)正文内容')
})

test('新建 issue：图片先攒着，创建成功后上传并追加到正文末尾', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-new'] === 'true').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-target-workspace'] !== undefined)
    .props.onChange({ target: { value: '/work/other' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-form-title']).props.onChange({ target: { value: '带图的新 issue' } })
  await mini.render(mini.React.createElement(GlobalBoard, {}))

  calls.length = 0
  const input = findNode(mini, (node) => node.props?.['data-gti-image-input'] !== undefined)
  assert.ok(input, '新建表单里没有图片入口')
  input.props.onChange({ target: { files: [imageFile()], value: '' } })
  await flush()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-attachments'] !== undefined).props['data-gti-attachments'], '1',
    '新建时图片应当先进入待上传卡片')
  assert.equal(calls.filter((call) => call.params?.op === 'issue.assets.upload').length, 0,
    '新建时还没有 issue 编号，不该先发上传请求')

  findNode(mini, (node) => node.props?.['data-gti-form-submit'] === 'true').props.onClick()
  await flush()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const ops = calls
    .filter((call) => call.op === 'gitea.call' && ['issue.create', 'issue.assets.upload', 'issue.edit'].includes(call.params.op))
    .map((call) => call.params.op)
  assert.deepEqual(ops, ['issue.create', 'issue.assets.upload', 'issue.edit'], `顺序必须是先建再传后补正文：${JSON.stringify(ops)}`)
  const patched = calls.find((call) => call.params?.op === 'issue.edit')
  assert.equal(patched.params.params.body, '![shot.png](/attachments/148f63a9-5bfd-4b08-b85a-d996fc6cf47a)', '图片 markdown 要追加进正文')
})

test('评论框：粘贴图片立刻上传并把 markdown 写进草稿，发表时正文已完整', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string').props.onClick(FIXTURES.issues[0])
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const draftNode = findNode(mini, (node) => node.props?.['data-gti-comment-draft'] !== undefined)
  assert.ok(draftNode, '详情里没有评论草稿框')

  calls.length = 0
  draftNode.props.onPaste(fileEvent(imageFile()))
  await flush()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const upload = calls.find((call) => call.op === 'gitea.call' && call.params.op === 'issue.assets.upload')
  assert.ok(upload, '评论框贴图没有上传')
  const next = findNode(mini, (node) => node.props?.['data-gti-comment-draft'] !== undefined)
  assert.equal(next.props.value, '![shot.png](/attachments/148f63a9-5bfd-4b08-b85a-d996fc6cf47a)', 'markdown 应写进草稿')

  findNode(mini, (node) => node.props?.['data-gti-comment-submit'] === 'true').props.onClick()
  await flush()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const comment = calls.find((call) => call.params?.op === 'issue.comments.create')
  assert.ok(comment, '没有发出发表评论请求')
  assert.equal(comment.params.params.body, '![shot.png](/attachments/148f63a9-5bfd-4b08-b85a-d996fc6cf47a)')
})

test('贴图只认图片：文本文件不发上传，也不吞掉普通粘贴', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string').props.onClick(FIXTURES.issues[0])
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-edit'] === 'true').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const body = findNode(mini, (node) => node.props?.['data-gti-form-body'] !== undefined)

  calls.length = 0
  let prevented = 0
  body.props.onPaste({
    clipboardData: { files: [new File(['hello'], 'note.txt', { type: 'text/plain' })] },
    target: { selectionStart: 0, selectionEnd: 0 },
    preventDefault() { prevented += 1 },
  })
  await flush()
  const text = await mini.render(mini.React.createElement(GlobalBoard, {}))
  assert.equal(prevented, 0, '非图片文件不该拦掉默认粘贴')
  assert.equal(calls.filter((call) => call.params?.op === 'issue.assets.upload').length, 0, '非图片文件不该发上传')
  assert.match(text, /只支持图片文件/)
})

test('新建时图片上传失败：只建一次 issue，停在表单并给「打开已创建的 issue」', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  try {
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    findNode(mini, (node) => node.props?.['data-gti-new'] === 'true').props.onClick()
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    findNode(mini, (node) => node.props?.['data-gti-target-workspace'] !== undefined)
      .props.onChange({ target: { value: '/work/other' } })
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    findNode(mini, (node) => node.props?.['data-gti-form-title']).props.onChange({ target: { value: '图片会失败' } })
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    findNode(mini, (node) => node.props?.['data-gti-image-input'] !== undefined)
      .props.onChange({ target: { files: [imageFile()], value: '' } })
    await flush()
    await mini.render(mini.React.createElement(GlobalBoard, {}))

    calls.length = 0
    FIXTURES.failUploadOnce = true
    findNode(mini, (node) => node.props?.['data-gti-form-submit'] === 'true').props.onClick()
    await flush()
    const text = await mini.render(mini.React.createElement(GlobalBoard, {}))
    assert.equal(calls.filter((call) => call.params?.op === 'issue.create').length, 1, 'issue 只该建一次')
    assert.match(text, /issue 已创建/)
    const open = findNode(mini, (node) => typeof node.props?.['data-gti-open-created'] === 'string')
    assert.ok(open, '应当给「打开已创建的 issue」，而不是让用户再点一次创建')

    open.props.onClick()
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    assert.equal(findNode(mini, (node) => node.props?.['data-gti-form-submit']), undefined, '点击后应离开表单')
  } finally {
    delete FIXTURES.failUploadOnce
  }
})

// ── 图片内嵌：正文/评论渲染、编辑预览、旧 Host 降级 ─────────────────────────

/** 两个合法 uuid：正文一个、评论一个。 */
const IMG_A = '148f63a9-5bfd-4b08-b85a-d996fc6cf47a'
const IMG_B = '7ccf7fb1-72d8-4f1b-9253-2740b462e0e9'

test('详情：正文与评论里的图片 markdown 渲染成 <img>，不再只剩裸 markdown', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  const savedBody = FIXTURES.detail.issue.body
  const savedComment = FIXTURES.detail.comments[0].body
  try {
    FIXTURES.detail.issue.body = `看这张 ![正文图](/attachments/${IMG_A})`
    FIXTURES.detail.comments[0].body = `评论里的图 ![评论图](/attachments/${IMG_B})`
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string').props.onClick(FIXTURES.issues[0])
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    await flush()
    const text = await mini.render(mini.React.createElement(GlobalBoard, {}))

    const images = mini.nodes.filter((node) => node.type === 'img' && String(node.props?.className).includes('dsh-gti-inline-image'))
    assert.equal(images.length, 2, `正文与评论各应有一张图，实际 ${images.length}`)
    assert.deepEqual(images.map((node) => node.props['data-gti-inline-image']), [IMG_A, IMG_B])
    for (const image of images) {
      assert.match(String(image.props.src), /^data:image\/png;base64,/, '图片必须用 Host 代取来的 data URL')
    }
    assert.doesNotMatch(text, /!\[正文图\]/, '渲染成图之后不该再显示裸 markdown')
    assert.ok(calls.some((call) => call.params?.op === 'attachment.content' && call.params.params.uuid === IMG_A),
      '正文里的附件图应当走 Host 代取')
  } finally {
    FIXTURES.detail.issue.body = savedBody
    FIXTURES.detail.comments[0].body = savedComment
  }
})

test('编辑表单：贴进来的图片立刻出缩略预览（不再只看到一段 markdown）', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component

  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string').props.onClick(FIXTURES.issues[0])
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-edit'] === 'true').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const body = findNode(mini, (node) => node.props?.['data-gti-form-body'] !== undefined)

  calls.length = 0
  body.props.onPaste(fileEvent(imageFile()))
  await flush()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const previews = mini.nodes.filter((node) => node.type === 'img' && String(node.props?.className).includes('dsh-gti-attachment-thumb'))
  assert.equal(previews.length, 1, '上传成功后表单里应有缩略图预览')
  assert.match(String(previews[0].props.src), /^data:image\/png;base64,/, '预览直接用上传时的字节，不必等 Host 代理')
  assert.ok(calls.every((call) => call.params?.op !== 'attachment.content'), '刚上传的图不该再走一遍 Host 代取')
})

test('旧 Host 没有附件代理：正文图片位退化成「重启 Harness」说明，不留破图', async () => {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  const savedBody = FIXTURES.detail.issue.body
  try {
    FIXTURES.detail.issue.body = `图 ![正文图](/attachments/${IMG_A})`
    FIXTURES.failAttachment = true
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string').props.onClick(FIXTURES.issues[0])
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    await flush()
    const text = await mini.render(mini.React.createElement(GlobalBoard, {}))
    assert.match(text, /重启 Harness/, '旧 Host 下必须点出「重启 Harness」，而不是默默显示破图')
    assert.equal(mini.nodes.filter((node) => node.type === 'img').length, 0, '拉不到图时不该渲染 <img>')
  } finally {
    FIXTURES.detail.issue.body = savedBody
    delete FIXTURES.failAttachment
  }
})

// ── 编辑器外壳：撰写 / 预览、工具栏、附件卡片 ─────────────────────────────

/** 打开「编辑 issue」表单，返回 `{ mini, GlobalBoard }`。 */
async function openEditForm() {
  const { fake, mini } = await newWorld()
  const GlobalBoard = fake.slots.find((entry) => entry.options.name === 'main').component
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => typeof node.props?.['data-gti-issue'] === 'string').props.onClick(FIXTURES.issues[0])
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  findNode(mini, (node) => node.props?.['data-gti-edit'] === 'true').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  return { mini, GlobalBoard }
}

test('编辑器：撰写 / 预览两个页签，预览走 Gitea 的 markdown 渲染', async () => {
  const { mini, GlobalBoard } = await openEditForm()
  assert.equal(findNode(mini, (node) => node.props?.['data-gti-editor-tab'] === 'write').props['data-active'], 'true')
  const tabs = mini.nodes.filter((node) => node.props?.['data-gti-editor-tab'] !== undefined)
  assert.deepEqual(tabs.map((node) => node.props['data-gti-editor-tab']), ['write', 'preview'])

  findNode(mini, (node) => node.props?.['data-gti-editor-tab'] === 'preview').props.onClick()
  // 先渲染一轮让 effect 登记预览请求，再等防抖到期，最后再渲染出结果。
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  await new Promise((resolve) => setTimeout(resolve, 260))
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const preview = findNode(mini, (node) => node.props?.['data-gti-preview-html'] === 'true')
  assert.ok(preview, '预览页签里应有渲染结果')
  assert.match(preview.props.dangerouslySetInnerHTML.__html, /正文内容/, '预览内容应来自正文')
  assert.ok(calls.some((call) => call.params?.op === 'markdown.render'), '预览没有调 Gitea 的 markdown 渲染')
})

test('编辑器：工具栏按钮把 markdown 语法插进正文', async () => {
  const { mini, GlobalBoard } = await openEditForm()
  findNode(mini, (node) => node.props?.['data-gti-editor-tool'] === 'bold').props.onClick()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const body = findNode(mini, (node) => node.props?.['data-gti-form-body'] !== undefined)
  assert.match(body.props.value, /\*\*粗体\*\*/, '加粗按钮应当插入 **粗体**')
})

test('编辑器：旧 Host 没有 markdown.render 时，预览页签说清楚要重启 Harness', async () => {
  const { mini, GlobalBoard } = await openEditForm()
  try {
    FIXTURES.failMarkdown = true
    findNode(mini, (node) => node.props?.['data-gti-editor-tab'] === 'preview').props.onClick()
    await mini.render(mini.React.createElement(GlobalBoard, {}))
    await new Promise((resolve) => setTimeout(resolve, 260))
    const text = await mini.render(mini.React.createElement(GlobalBoard, {}))
    assert.match(text, /重启 Harness/, '预览失败要给出可见的「重启 Harness」提示')
  } finally {
    delete FIXTURES.failMarkdown
  }
})

test('编辑器：附件卡片显示文件名与体积，「移除文件」同时删正文引用与远端附件', async () => {
  const { mini, GlobalBoard } = await openEditForm()
  findNode(mini, (node) => node.props?.['data-gti-form-body'] !== undefined).props.onPaste(fileEvent(imageFile()))
  await flush()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const card = findNode(mini, (node) => typeof node.props?.['data-gti-attachment-card'] === 'string')
  assert.ok(card, '上传后应出现附件卡片')

  calls.length = 0
  findNode(mini, (node) => node.props?.['data-gti-attachment-remove'] !== undefined).props.onClick()
  await flush()
  await mini.render(mini.React.createElement(GlobalBoard, {}))
  const body = findNode(mini, (node) => node.props?.['data-gti-form-body'] !== undefined)
  assert.equal(body.props.value, '正文内容', '移除文件后正文里不该再有该图引用')
  const deleted = calls.find((call) => call.params?.op === 'issue.asset.delete')
  assert.ok(deleted, '移除文件应当删掉远端附件')
  assert.equal(deleted.params.params.attachmentId, 9)
})
