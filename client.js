/**
 * @module @dongasai/dsh-gitea-task-issues/client
 *
 * **Gitea 任务 issues —— 浏览器半边**。给 GUI 补两处看板 + 一处管理面：
 *
 * 1. **全局看板**（`main` 键 `gitea-issues`，入口是左侧栏 `sidebar.panellist` 的一个图标，
 *    `order: 20` —— 排在官方「自动化任务」（order 10）下面）：把**所有已绑定的工作区仓库**
 *    的 issues 聚到一屏（范围由绑定决定，不是令牌能看见的全部仓库），外加服务器管理与令牌管理；
 * 2. **工作区看板**（右侧栏页签类型 `gitea-issues`）：看当前工作区绑定仓库的 issues，
 *    列表 → 详情 → 编辑 / 评论 / 附件 / 指派 / 依赖 / 订阅 / Pin / Label / Lock / 工时；
 * 3. **绑定设置**：手动绑定压过自动侦测（读 `.git/config` 的 remote 得到 host/owner/repo，
 *    再和已配置服务器按主机名配对）。
 *
 * ## 三条实现约束（改代码时别踩）
 *
 * 1. **所有远端读写都走 Host 的那一条桥**（`POST /gitea-task-issues/api`）。浏览器半边
 *    **永远拿不到 Gitea 令牌**，也不直接访问 Gitea —— 否则 CORS 与令牌泄漏两件事一起中招。
 * 2. **不假设槽位传了哪些 prop**。slot catalog 列的是类型并集，某个渲染点可能只传子集：
 *    `sidebar.right.pane.tab` 有 `sessionId`，但别顺手去调它没保证的 `useSessions`；
 *    要什么就自己从 `ctx` 服务现读，读不到就降级提示（`dsh-editor` 的约束 18 踩过白屏）。
 * 3. **正文与列表只认 `lib/shape.js` 的字段集**。Gitea 的原始对象字段多且版本间会变，
 *    这里只消费瘦身后的字段，缺字段一律按「没有」渲染，不抛错。
 *
 * ## 把一条 issue 发到对话输入框
 *
 * **工作区看板**的列表每行（行尾的小按钮）与详情页动作行各有一个 **「发送到 DSH」**：把这条
 * issue 拼成一行「`请处理 Gitea issue #12：标题`」，插进**这个会话**的对话输入框（光标留在
 * 末尾的新行上，方便接着补自己的要求）。**不带网址**：工作区隔离下模型只能看当前工作区绑定的
 * 那个仓库，网址是多余的噪音（用户明确要求去掉）。写入面与 `dsh-editor` 同一套：
 * `conversation.input.dock` 注册一个渲染 `null` 的哨兵，挂载时把该会话的 `inputActions`
 * 记进模块级 `inputTargets`；侧栏渲染点真传了 `inputActions` prop 就优先用它。
 *
 * 插进去的是**普通文本**：公开面 `InputActions` 只有 `insertText(text, span)`，带结构化引用的
 * 那条路只对内开放。发完在面板上亮一条结果横幅；拿不到输入框（会话还没起来、对话区没打开）
 * 或输入框正忙（正在提交 / 草稿刚被改过）时，横幅写清原因，**不静默失败**。
 *
 * 另外：这个 bundle 没有构建步骤，`h(...)` 手写、样式只挂本地 `<style>` 且只用主题令牌
 * （`--dsw-alias-*`），调试锚点一律走 `data-gti-*` 属性，不用 class 或可见文案当锚点。
 */
window.__ModuleLoader__.load({
  id: '@dongasai/dsh-gitea-task-issues',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 界面文案命名空间。 */
    const NS = 'giteaIssues'

    /** Host 那一条桥的路径；与 `lib/bridge.js` 注册的必须逐字一致。 */
    const API_URL = '/gitea-task-issues/api'

    /** 全局看板的 main 键，同时是左侧栏面板图标的 id。 */
    const PANEL_ID = 'gitea-issues'

    /** 右侧栏页签类型的 id 与 kind。 */
    const TAB_ID = 'gitea-issues'
    const TAB_KIND = 'gitea-issues'

    /** 一次桥请求的墙钟上限（附件上传要宽一点，所以给 60s）。 */
    const REQUEST_TIMEOUT_MS = 60 * 1000

    /** 一次附件上传的原始字节上限（base64 后约 ×1.37）。 */
    const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024

    /** 侧栏看板的状态筛选值。 */
    const STATES = ['open', 'closed', 'all']

    /** 视图模式：泳道（默认，面板一打开就是分好泳道的全景）与列表。 */
    const MODES = ['lanes', 'list']

    /** 泳道分组维度（只在泳道模式下有意义）。 */
    const GROUPS = ['state', 'assignee', 'label', 'milestone']

    /**
     * 对话输入框的写入面，按会话索引：`conversation.input.dock` 的哨兵挂载时登记、卸载即删。
     * 「发送到 DSH」优先用自己槽位上的 `inputActions` prop，prop 没有（侧栏渲染点不保证传全
     * 标准 prop，见文件头注释）时从这里取；两处都拿不到就只亮横幅，不静默失败。
     */
    const inputTargets = new Map()

    /**
     * 简体中文文案（键集的事实来源）。
     */
    const zh = {
      'app.title': 'Gitea 看板',
      'tab.title': 'Gitea issues',
      'tab.guide': '在当前工作区绑定的 Gitea 仓库里查看、新建与讨论 issues',
      'panel.label': 'Gitea 看板',
      'shortcut.issues': '打开 Gitea issues 看板',

      'common.refresh': '刷新',
      'common.loading': '加载中…',
      'common.retry': '重试',
      'common.cancel': '取消',
      'common.save': '保存',
      'common.delete': '删除',
      'common.edit': '编辑',
      'common.create': '新建',
      'common.back': '返回',
      'common.none': '无',
      'common.more': '更多操作',
      'common.confirmDelete': '确认删除？',
      'common.close': '关闭',

      'state.open': '进行中',
      'state.closed': '已关闭',
      'state.all': '全部',

      'filter.state': '状态',
      // 按状态分泳道时状态筛选被接管（取数固定 all、控件置灰）：tooltip 讲原因，旁边短标签给可见解释。
      'filter.stateLocked': '按状态分泳道时固定取「全部」状态：泳道本身就是状态维度',
      'filter.stateLockedHint': '由泳道接管',
      'filter.keyword': '关键词',
      'filter.keywordPlaceholder': '搜标题与正文',
      'filter.owner': '所属',
      'filter.ownerPlaceholder': '按 owner 收窄（可选）',
      'filter.server': '服务器',
      'filter.allServers': '全部服务器',
      // 范围说明：全局看板只聚合「工作区绑定过的仓库」，不是这台 Gitea 上你能看见的全部仓库。
      'filter.boundScope': '范围：{n} 个已绑定的工作区仓库',

      'list.count': '{n} 条',
      'list.empty': '这个筛选下没有 issue。',
      'list.emptyHint': '换个状态或关键词试试，或者新建一条。',
      'list.emptyTargetsHint': '这个筛选下没有已绑定的仓库：清空服务器 / 所属筛选再试。',
      'list.noBindings': '还没有绑定任何工作区仓库。',
      'list.noBindingsHint': '去右侧栏「Gitea issues」看板的「绑定设置」给工作区绑一个仓库，这里就会列出它们的 issues。',
      'list.loading': '正在读取 issues…',
      'list.partial': '部分仓库读取失败：{names}',

      'view.mode': '视图模式',
      'view.lanes': '泳道',
      'view.list': '列表',
      'view.group': '泳道分组',
      'group.state': '状态',
      'group.assignee': '指派',
      'group.label': '标签',
      'group.milestone': '里程碑',
      'group.none.assignee': '未指派',
      'group.none.label': '无标签',
      'group.none.milestone': '无里程碑',
      'lane.empty': '暂无',

      'issue.new': '新建 issue',
      'issue.labels': '标签',
      'issue.assignees': '指派',
      'issue.milestone': '里程碑',
      'issue.due': '截止',
      'issue.author': '作者',
      'issue.created': '创建于',
      'issue.updated': '更新于',
      'issue.comments': '评论',
      'issue.openInBrowser': '在浏览器打开',
      'issue.bodyEmpty': '（无正文）',
      'issue.close': '关闭 issue',
      'issue.reopen': '重新打开',
      'issue.pin': '置顶',
      'issue.unpin': '取消置顶',
      'issue.lock': '锁定讨论',
      'issue.unlock': '解锁讨论',
      'issue.subscribe': '订阅',
      'issue.unsubscribe': '取消订阅',
      'issue.subscribed': '已订阅',
      'issue.deleted': '已删除',

      // 「发送到 DSH」：拼进对话输入框的提示词 + 三种结局的横幅。
      'send.action': '发送到 DSH',
      'send.hint': '把这条 issue 插进当前会话的对话输入框',
      'send.prompt': '请处理 Gitea issue #{index}：{title}',
      'send.sent': '已把 #{index} 发到对话输入框',
      'send.failed.input': '拿不到对话输入框：会话还没起来，或对话区没打开。',
      'send.failed.busy': '输入框正忙（正在提交，或草稿刚被别处改过），请再试一次。',

      'comments.title': '评论',
      'comments.empty': '还没有评论。',
      'comments.placeholder': '写点什么…（支持 Markdown）',
      'comments.submit': '发表评论',
      'comments.saving': '提交中…',
      'comments.edit': '编辑',
      'comments.delete': '删除',
      'comments.deleteConfirm': '删除这条评论？',

      'form.createTitle': '新建 issue',
      'form.editTitle': '编辑 issue',
      // 新建目标：默认从**已绑定的工作区**里挑（绑定直接给出仓库），手动填 owner/name 只是兜底。
      'form.targetMode': '新建目标',
      'form.targetWorkspace': '已绑定的工作区',
      'form.targetManual': '手动指定仓库',
      'form.targetWorkspaceLabel': '目标工作区',
      'form.targetPick': '选择工作区…',
      'form.targetNone': '还没有任何工作区绑定仓库。先在工作区看板的「绑定设置」里绑一个，或切到「手动指定仓库」。',
      'form.targetResolved': '目标仓库 {repo}（服务器 {server}），取自工作区 {root}',
      'form.createNeedTarget': '先选一个目标：已绑定的工作区，或在「手动指定仓库」里填 owner/name。',
      'form.title': '标题',
      'form.titlePlaceholder': '一句话说清问题',
      'form.body': '正文',
      'form.bodyPlaceholder': '复现步骤、期望结果…（支持 Markdown）',
      'form.labels': '标签',
      'form.assignees': '指派给',
      'form.milestone': '里程碑',
      'form.due': '截止日',
      'form.submitCreate': '创建',
      'form.submitSave': '保存',
      'form.nothingChanged': '没有改动',

      'meta.title': '仓库元信息',
      'meta.labels': '{n} 个标签',
      'meta.milestones': '{n} 个里程碑',
      'meta.assignees': '{n} 个可指派用户',

      'times.title': '工时',
      'times.empty': '还没有登记工时。',
      'times.total': '合计 {duration}',
      'times.add': '登记工时',
      'times.minutes': '分钟',
      'times.delete': '删除',
      'times.reset': '清空',

      'assets.title': '附件',
      'assets.empty': '还没有附件。',
      'assets.upload': '上传附件',
      'assets.uploading': '上传中…',
      'assets.deleteConfirm': '删除这个附件？',
      'assets.tooLarge': '文件超过 {limit} 上限。',
      'assets.failed': '上传失败：{message}',

      'deps.title': '依赖（被这些挡住）',
      'deps.empty': '没有依赖。',
      'deps.add': '加依赖',
      'deps.placeholder': 'issue 编号',
      'blocks.title': '阻塞（挡住这些）',
      'blocks.empty': '没有阻塞别人。',
      'blocks.add': '加阻塞',

      'servers.title': 'Gitea 服务器',
      'servers.add': '添加服务器',
      'servers.name': '名称',
      'servers.url': '地址',
      'servers.token': '访问令牌',
      'servers.tokenEnv': '令牌环境变量（可选）',
      'servers.tokenKeep': '留空表示不改动',
      'servers.tokenSet': '已配置',
      'servers.tokenUnset': '未配置',
      'servers.tokenSourceEnv': '来自环境变量 {name}',
      'servers.tokenClear': '清除令牌',
      'servers.test': '探活',
      'servers.testing': '探测中…',
      'servers.remove': '删除',
      'servers.removeConfirm': '删除服务器「{name}」？指向它的工作区绑定与令牌记录都会一并清掉。',
      'servers.empty': '还没有配置服务器。先添加一台 Gitea，再写入访问令牌。',
      'servers.credentialsMissing': '这台 Host 没有凭据中心，令牌只能用环境变量提供。',
      'servers.storage': '配置文件：{path}',
      'servers.version': 'Gitea {version}',
      'servers.user': '令牌用户：{login}',
      'servers.ok': '连接正常',

      // 「自动分配」：定期把指派给我的 issue 变成新会话。默认关闭。
      'auto.title': '自动分配任务',
      'auto.open': '自动分配',
      'auto.enable': '启用自动分配',
      'auto.enableHint': '打开后每隔一段时间检查一次，有新任务就开一个新会话去处理。',
      'auto.master': '总开关',
      'auto.interval': '检查间隔（秒）',
      'auto.quota': '每小时最多开会话',
      'auto.dryRun': '只记账不投递（演练）',
      'auto.trigger.newAssigned': '新 issue 指派给我',
      'auto.trigger.reopened': '我负责的 issue 被重新打开',
      'auto.trigger.newComment': '我负责的 issue 有新评论',
      'auto.cooldown': '同一 issue 冷却（秒）',
      'auto.daily': '单 issue 每日上限',
      'auto.giveUp': '等待上限（小时）',
      'auto.preset': '模式（Agent 预设）',
      'auto.presetHint': '自动打开的新会话用这个模式；「跟随宿主默认」等于 DSH 里设的默认模式。',
      'auto.presetNoRoster': '宿主没有提供预设名册，只能手填预设 id（留空也就是默认模式）。',
      'auto.presetFollow': '跟随宿主默认（{name}）',
      'auto.presetFollowUnnamed': '跟随宿主默认',
      'auto.presetMissing': '{id}（不在当前名册）',
      'auto.presetBroken': '{name}（加载失败）',
      // 内置预设不发布 name，界面按 id 查这几条（与 DSH 自带文案一致）。
      'preset.standard': '标准模式',
      'preset.ptc': 'PTC 模式',
      'preset.minimal': '极简模式',
      'preset.cordis': '创造模式',
      'auto.save': '保存设置',
      'auto.tick': '立即检查一次',
      'auto.ticking': '检查中…',
      'auto.state': '运行状态',
      'auto.state.enabled': '总开关：开',
      'auto.state.disabled': '总开关：关',
      'auto.state.repo': '仓库',
      'auto.state.watermark': '上次检查',
      'auto.state.baseline': '基线时刻（这之前的历史不会被投递）',
      'auto.state.next': '下次检查',
      'auto.state.locked': '本进程未持有轮询锁（另一进程在投递）',
      'auto.state.unavailable': '当前宿主没有会话服务，无法自动开会话（看板与工具仍然可用）。',
      'auto.pending': '待投递',
      'auto.pending.empty': '没有待投递的任务。',
      'auto.pending.since': '等待自 {at}',
      'auto.deliveries': '最近投递',
      'auto.deliveries.empty': '还没有投递记录。',
      'auto.outcome.prompted': '已投递',
      'auto.outcome.busy-skipped': '工作区忙，已跳过',
      'auto.outcome.failed': '失败',
      'auto.outcome.expired': '等待超时，已放弃',
      'auto.outcome.dry-run': '演练：只记账未投递',
      'auto.replay': '重放',
      'auto.replayHint': '把这条重新排进待投递（write-ahead 之后会话没起来时用）',
      'auto.error': '上次失败：{code}——{message}',
      'auto.kind.newAssigned': '新指派',
      'auto.kind.reopened': '重新打开',
      'auto.kind.newComment': '新评论',
      'auto.needBinding': '先绑定仓库，才能配置自动分配。',
      'auto.saved': '已保存。',
      'auto.tickDone': '本轮投递 {n} 个会话。',
      'auto.repoMismatch': '绑定的仓库变了，请重新保存自动分配配置。',
      // 工作区看板标题栏的徽标：只在**真的会被投递**时出现（判据与 lib/watch.js 的 planRoots 同一套）。
      'auto.badge.on': '自动投递已开',
      'auto.badge.dry': '自动投递·演练',
      'auto.badge.mismatch': '自动投递·需重存',
      'auto.badge.unavailable': '自动投递·不可用',
      'auto.badge.pending': '待投递 {n}',
      'auto.badge.next': '下次检查 {at}',
      'auto.badge.countdown': '{time} 后检查',
      'auto.badge.due': '即将检查',
      'auto.badge.backoff': '退避 ×{n}',
      'auto.badge.hint.on': '这个工作区已开启自动投递：出现新任务会开一个新会话处理。点开设置',
      'auto.badge.hint.dry': '自动投递在演练模式：只记账、不开会话。点开设置',
      'auto.badge.hint.mismatch': '绑定的仓库变了，轮询器已跳过这个工作区；重新保存自动分配配置后恢复。点开设置',
      'auto.badge.hint.unavailable': '当前宿主没有会话服务，自动投递开不了会话。点开设置',
      // 失败退避：连续失败会把下一轮拉长（最长 30 分钟）。不写出来，用户只会觉得「我设的间隔没生效」。
      'auto.state.backoff': '连续失败 {n} 次，正在退避重试（下次检查被拉长）',
      'auto.intervalHint': '改完立刻按新间隔重排下一轮；60 秒是下限。',
      'binding.title': '工作区绑定',
      'binding.repo': '仓库（owner/name）',
      'binding.server': '服务器',
      'binding.detected': '从 .git/config 侦测到 {owner}/{repo}（{host}）',
      'binding.detectedUnmatched': '侦测到 {owner}/{repo}（{host}），但没有已配置的服务器对应这个主机名。',
      'binding.noRemote': '这个工作区没有可用的 git remote。',
      'binding.manual': '手动绑定',
      'binding.auto': '自动侦测',
      'binding.save': '绑定',
      'binding.clear': '解除绑定',
      'binding.none': '这个工作区还没有绑定仓库。',
      'binding.noSession': '还没有会话，无法确定工作区。',
      'binding.effective': '当前使用：{owner}/{repo}（{source}）',
      'binding.settings': '绑定设置',

      'error.transport': '连不上 Host（桥接路由没有响应）。',
      'error.unknown': '未知错误',
      'error.noServer': '先添加一台 Gitea 服务器。',
      'error.noToken': '这台服务器还没有令牌，去「Gitea 看板」里配置。',
    }

    /** English mirror of {@link zh}. */
    const en = {
      'app.title': 'Gitea board',
      'tab.title': 'Gitea issues',
      'tab.guide': 'Browse, file and discuss issues in the Gitea repository this workspace is bound to',
      'panel.label': 'Gitea board',
      'shortcut.issues': 'Open the Gitea issues board',

      'common.refresh': 'Refresh',
      'common.loading': 'Loading…',
      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.delete': 'Delete',
      'common.edit': 'Edit',
      'common.create': 'New',
      'common.back': 'Back',
      'common.none': 'None',
      'common.more': 'More actions',
      'common.confirmDelete': 'Delete?',
      'common.close': 'Close',

      'state.open': 'Open',
      'state.closed': 'Closed',
      'state.all': 'All',

      'filter.state': 'State',
      // With lanes grouped by state the state filter is taken over: tooltip explains why, a short
      // visible label next to it keeps a greyed control from being a mystery.
      'filter.stateLocked': 'Grouped by state, lanes always load every state: the lane is the state',
      'filter.stateLockedHint': 'driven by lanes',
      'filter.keyword': 'Keyword',
      'filter.keywordPlaceholder': 'Search title and body',
      'filter.owner': 'Owner',
      'filter.ownerPlaceholder': 'Narrow by owner (optional)',
      'filter.server': 'Server',
      'filter.allServers': 'All servers',
      'filter.boundScope': 'Scope: {n} repositories bound to a workspace',

      'list.count': '{n} items',
      'list.empty': 'No issues match this filter.',
      'list.emptyHint': 'Try another state or keyword, or file a new one.',
      'list.emptyTargetsHint': 'No bound repository matches this filter: clear the server / owner filter and try again.',
      'list.noBindings': 'No workspace repository is bound yet.',
      'list.noBindingsHint': 'Bind a repository in the workspace board (right sidebar) under "binding settings", and its issues will show up here.',
      'list.loading': 'Loading issues…',
      'list.partial': 'Some repositories failed: {names}',

      'view.mode': 'View mode',
      'view.lanes': 'Swimlanes',
      'view.list': 'List',
      'view.group': 'Group lanes by',
      'group.state': 'State',
      'group.assignee': 'Assignee',
      'group.label': 'Label',
      'group.milestone': 'Milestone',
      'group.none.assignee': 'Unassigned',
      'group.none.label': 'No label',
      'group.none.milestone': 'No milestone',
      'lane.empty': 'Empty',

      'issue.new': 'New issue',
      'issue.labels': 'Labels',
      'issue.assignees': 'Assignees',
      'issue.milestone': 'Milestone',
      'issue.due': 'Due',
      'issue.author': 'Author',
      'issue.created': 'Created',
      'issue.updated': 'Updated',
      'issue.comments': 'Comments',
      'issue.openInBrowser': 'Open in browser',
      'issue.bodyEmpty': '(no description)',
      'issue.close': 'Close issue',
      'issue.reopen': 'Reopen',
      'issue.pin': 'Pin',
      'issue.unpin': 'Unpin',
      'issue.lock': 'Lock discussion',
      'issue.unlock': 'Unlock discussion',
      'issue.subscribe': 'Subscribe',
      'issue.unsubscribe': 'Unsubscribe',
      'issue.subscribed': 'Subscribed',
      'issue.deleted': 'Deleted',

      // Send to DSH: the prompt inserted into the composer, plus the three outcomes.
      'send.action': 'Send to DSH',
      'send.hint': 'Insert this issue into the current conversation composer',
      'send.prompt': 'Please handle Gitea issue #{index}: {title}',
      'send.sent': 'Sent #{index} to the composer',
      'send.failed.input': 'Composer unavailable: the session is not up yet, or the conversation is closed.',
      'send.failed.busy': 'The composer is busy (submitting, or the draft just changed elsewhere) — try again.',

      'comments.title': 'Comments',
      'comments.empty': 'No comments yet.',
      'comments.placeholder': 'Say something… (Markdown supported)',
      'comments.submit': 'Comment',
      'comments.saving': 'Sending…',
      'comments.edit': 'Edit',
      'comments.delete': 'Delete',
      'comments.deleteConfirm': 'Delete this comment?',

      'form.createTitle': 'New issue',
      'form.editTitle': 'Edit issue',
      'form.targetMode': 'Create in',
      'form.targetWorkspace': 'Bound workspace',
      'form.targetManual': 'Pick a repository',
      'form.targetWorkspaceLabel': 'Workspace',
      'form.targetPick': 'Choose a workspace…',
      'form.targetNone': 'No workspace is bound to a repository yet. Bind one in the workspace board\u2019s binding settings, or switch to "Pick a repository".',
      'form.targetResolved': 'Target {repo} on {server}, from workspace {root}',
      'form.createNeedTarget': 'Pick a target first: a bound workspace, or type owner/name under "Pick a repository".',
      'form.title': 'Title',
      'form.titlePlaceholder': 'One line that says it',
      'form.body': 'Description',
      'form.bodyPlaceholder': 'Steps, expected result… (Markdown supported)',
      'form.labels': 'Labels',
      'form.assignees': 'Assignees',
      'form.milestone': 'Milestone',
      'form.due': 'Due date',
      'form.submitCreate': 'Create',
      'form.submitSave': 'Save',
      'form.nothingChanged': 'Nothing changed',

      'meta.title': 'Repository metadata',
      'meta.labels': '{n} labels',
      'meta.milestones': '{n} milestones',
      'meta.assignees': '{n} assignable users',

      'times.title': 'Tracked time',
      'times.empty': 'No time tracked yet.',
      'times.total': 'Total {duration}',
      'times.add': 'Add time',
      'times.minutes': 'minutes',
      'times.delete': 'Delete',
      'times.reset': 'Reset',

      'assets.title': 'Attachments',
      'assets.empty': 'No attachments yet.',
      'assets.upload': 'Upload',
      'assets.uploading': 'Uploading…',
      'assets.deleteConfirm': 'Delete this attachment?',
      'assets.tooLarge': 'File exceeds the {limit} limit.',
      'assets.failed': 'Upload failed: {message}',

      'deps.title': 'Depends on (blocked by)',
      'deps.empty': 'No dependencies.',
      'deps.add': 'Add dependency',
      'deps.placeholder': 'issue number',
      'blocks.title': 'Blocks',
      'blocks.empty': 'Not blocking anything.',
      'blocks.add': 'Add block',

      'servers.title': 'Gitea servers',
      'servers.add': 'Add server',
      'servers.name': 'Name',
      'servers.url': 'URL',
      'servers.token': 'Access token',
      'servers.tokenEnv': 'Token environment variable (optional)',
      'servers.tokenKeep': 'Leave blank to keep the current token',
      'servers.tokenSet': 'Configured',
      'servers.tokenUnset': 'Not configured',
      'servers.tokenSourceEnv': 'From environment variable {name}',
      'servers.tokenClear': 'Clear token',
      'servers.test': 'Test',
      'servers.testing': 'Testing…',
      'servers.remove': 'Delete',
      'servers.removeConfirm': 'Delete server "{name}"? Workspace bindings and the stored token pointing at it are removed too.',
      'servers.empty': 'No server configured yet. Add a Gitea instance, then store an access token.',
      'servers.credentialsMissing': 'This host has no credential store, so tokens can only come from environment variables.',
      'servers.storage': 'Config file: {path}',
      'servers.version': 'Gitea {version}',
      'servers.user': 'Token user: {login}',
      'servers.ok': 'Reachable',

      // Automatic assignment: turn assigned issues into new sessions. Off by default.
      'auto.title': 'Automatic task assignment',
      'auto.open': 'Auto assign',
      'auto.enable': 'Enable automatic assignment',
      'auto.enableHint': 'When on, this workspace is checked periodically and new tasks open a new session.',
      'auto.master': 'Master switch',
      'auto.interval': 'Check interval (seconds)',
      'auto.quota': 'Max sessions per hour',
      'auto.dryRun': 'Record only, do not deliver (dry run)',
      'auto.trigger.newAssigned': 'A new issue is assigned to me',
      'auto.trigger.reopened': 'An issue of mine is reopened',
      'auto.trigger.newComment': 'An issue of mine gets a new comment',
      'auto.cooldown': 'Cooldown per issue (seconds)',
      'auto.daily': 'Daily cap per issue',
      'auto.giveUp': 'Give up after (hours)',
      'auto.preset': 'Mode (agent preset)',
      'auto.presetHint': 'Sessions opened automatically use this mode; "follow the host default" equals the default mode set in DSH.',
      'auto.presetNoRoster': 'This host provides no preset roster; type a preset id (empty also means the default mode).',
      'auto.presetFollow': 'Follow host default ({name})',
      'auto.presetFollowUnnamed': 'Follow host default',
      'auto.presetMissing': '{id} (not in the current roster)',
      'auto.presetBroken': '{name} (failed to load)',
      'preset.standard': 'Standard mode',
      'preset.ptc': 'PTC mode',
      'preset.minimal': 'Minimal mode',
      'preset.cordis': 'Creator mode',
      'auto.save': 'Save',
      'auto.tick': 'Check now',
      'auto.ticking': 'Checking…',
      'auto.state': 'Status',
      'auto.state.enabled': 'Master switch: on',
      'auto.state.disabled': 'Master switch: off',
      'auto.state.repo': 'Repository',
      'auto.state.watermark': 'Last check',
      'auto.state.baseline': 'Baseline (history before this is never delivered)',
      'auto.state.next': 'Next check',
      'auto.state.locked': 'This process does not hold the poll lock (another process is delivering).',
      'auto.state.unavailable': 'This host mounts no session service, so no session can be opened (the board and tools still work).',
      'auto.pending': 'Pending',
      'auto.pending.empty': 'Nothing pending.',
      'auto.pending.since': 'waiting since {at}',
      'auto.deliveries': 'Recent deliveries',
      'auto.deliveries.empty': 'No deliveries yet.',
      'auto.outcome.prompted': 'delivered',
      'auto.outcome.busy-skipped': 'workspace busy, skipped',
      'auto.outcome.failed': 'failed',
      'auto.outcome.expired': 'gave up after waiting',
      'auto.outcome.dry-run': 'dry run: recorded, not delivered',
      'auto.replay': 'Replay',
      'auto.replayHint': 'Queue this one again (use when a session never came up after write-ahead).',
      'auto.error': 'Last failure: {code} — {message}',
      'auto.kind.newAssigned': 'new assignment',
      'auto.kind.reopened': 'reopened',
      'auto.kind.newComment': 'new comment',
      'auto.needBinding': 'Bind a repository first, then configure automatic assignment.',
      'auto.saved': 'Saved.',
      'auto.tickDone': 'Delivered {n} session(s) this round.',
      'auto.repoMismatch': 'The bound repository changed; save the automatic assignment again.',
      'auto.badge.on': 'Auto delivery on',
      'auto.badge.dry': 'Auto delivery · dry run',
      'auto.badge.mismatch': 'Auto delivery · re-save',
      'auto.badge.unavailable': 'Auto delivery · unavailable',
      'auto.badge.pending': '{n} pending',
      'auto.badge.next': 'next check {at}',
      'auto.badge.countdown': 'next check in {time}',
      'auto.badge.due': 'due now',
      'auto.badge.backoff': 'backoff ×{n}',
      'auto.badge.hint.on': 'This workspace delivers automatically: a new task opens a new session. Open settings',
      'auto.badge.hint.dry': 'Automatic delivery is in dry-run mode: it only records, never opens sessions. Open settings',
      'auto.badge.hint.mismatch': 'The bound repository changed, so the poller skips this workspace; save the automatic assignment again to resume. Open settings',
      'auto.badge.hint.unavailable': 'This host has no session service, so automatic delivery cannot open sessions. Open settings',
      'auto.state.backoff': '{n} consecutive failures; retrying with backoff (the next check is pushed out)',
      'auto.intervalHint': 'Takes effect immediately after saving; 60 s is the minimum.',
      'binding.title': 'Workspace binding',
      'binding.repo': 'Repository (owner/name)',
      'binding.server': 'Server',
      'binding.detected': 'Detected {owner}/{repo} from .git/config ({host})',
      'binding.detectedUnmatched': 'Detected {owner}/{repo} ({host}), but no configured server matches that host.',
      'binding.noRemote': 'No usable git remote in this workspace.',
      'binding.manual': 'manual',
      'binding.auto': 'auto-detected',
      'binding.save': 'Bind',
      'binding.clear': 'Unbind',
      'binding.none': 'This workspace is not bound to a repository yet.',
      'binding.noSession': 'No session yet, so the workspace is unknown.',
      'binding.effective': 'Using {owner}/{repo} ({source})',
      'binding.settings': 'Binding settings',

      'error.transport': 'Cannot reach the host (the bridge route did not answer).',
      'error.unknown': 'Unknown error',
      'error.noServer': 'Add a Gitea server first.',
      'error.noToken': 'This server has no token yet; configure it in the Gitea board.',
    }

    /**
     * 样式。只挂组件本地 `<style>`、只用主题令牌，不引外部样式表、不写死颜色。
     */
    const CSS = `
.dsh-gti-root{display:flex;flex-direction:column;flex:auto;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}
.dsh-gti-bar{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dsh-gti-bar-title{font-weight:600;font-size:13px}
/* 全局看板的「范围」说明条：单独一行、和筛选条同一种内缩，不像报错横幅那样抢眼。 */
.dsh-gti-scope{display:block;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dsh-gti-spacer{flex:1 1 auto}
.dsh-gti-input,.dsh-gti-select,.dsh-gti-textarea{font:inherit;font-size:12px;box-sizing:border-box;padding:4px 8px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-width:0}
.dsh-gti-textarea{width:100%;min-height:96px;resize:vertical;line-height:1.6;font-family:inherit}
.dsh-gti-input:focus,.dsh-gti-select:focus,.dsh-gti-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-gti-button{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.dsh-gti-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-gti-button:disabled{opacity:.4;cursor:not-allowed}
.dsh-gti-button[data-primary="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-gti-button[data-danger="true"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-gti-icon-button{width:26px;height:26px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-gti-icon-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-gti-icon-button:disabled{opacity:.4;cursor:not-allowed}
.dsh-gti-banner{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dsh-gti-banner[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dsh-gti-banner[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dsh-gti-banner[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}
.dsh-gti-banner-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.dsh-gti-body{flex:1 1 auto;min-height:0;display:flex;overflow:hidden}
.dsh-gti-column{display:flex;flex-direction:column;min-width:0;min-height:0}
.dsh-gti-list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 6px 16px;scrollbar-gutter:stable}
.dsh-gti-row{display:block;width:100%;box-sizing:border-box;padding:8px 10px;margin:2px 0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-gti-row:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-gti-row[data-selected="true"]{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-bg-layer-2))}
.dsh-gti-row-head{display:flex;align-items:baseline;gap:6px;min-width:0}
.dsh-gti-row-index{flex:none;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-gti-row-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-gti-row-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-gti-row-wrap{display:flex;align-items:stretch;gap:2px;margin:2px 0}
.dsh-gti-row-wrap>.dsh-gti-row{flex:1 1 auto;min-width:0;margin:0}
.dsh-gti-send{flex:none;display:inline-flex;align-items:center;gap:4px;padding:0 6px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer;opacity:.5;white-space:nowrap}
.dsh-gti-row-wrap:hover .dsh-gti-send,.dsh-gti-send:focus-visible{opacity:1}
.dsh-gti-send:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
/* 文案只在悬停 / 聚焦时显形：行本身要留给标题，但 title 与无障碍名一直有。 */
.dsh-gti-send-label{display:none}
.dsh-gti-row-wrap:hover .dsh-gti-send-label,.dsh-gti-send:focus-visible .dsh-gti-send-label{display:inline}
.dsh-gti-dot{flex:none;width:8px;height:8px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2)}
.dsh-gti-dot[data-state="open"]{background:var(--dsw-alias-state-success-primary);border-color:transparent}
.dsh-gti-dot[data-state="closed"]{background:var(--dsw-alias-label-tertiary);border-color:transparent}
.dsh-gti-chip{display:inline-flex;align-items:center;gap:4px;max-width:22ch;padding:1px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-gti-chip[data-tone="brand"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
/* 可点的徽标（工作区看板的「自动投递」入口）：要能和状态标签区分开，但别做成主按钮。 */
.dsh-gti-chip-button{max-width:none;cursor:pointer;font-family:inherit;background:none}
.dsh-gti-chip-button:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-gti-chip-button[data-gti-auto-badge="dry"],
.dsh-gti-chip-button[data-gti-auto-badge="mismatch"],
.dsh-gti-chip-button[data-gti-auto-badge="unavailable"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsh-gti-label-dot{flex:none;width:8px;height:8px;border-radius:2px}
.dsh-gti-detail{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px 40px}
.dsh-gti-detail-head{display:flex;align-items:flex-start;gap:8px}
.dsh-gti-detail-title{flex:1 1 auto;min-width:0;margin:0;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.dsh-gti-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:10px 0;font-size:12px}
.dsh-gti-kv-key{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsh-gti-kv-value{min-width:0;overflow-wrap:anywhere}
.dsh-gti-body-text{margin:10px 0;padding:10px 12px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:420px;overflow:auto}
.dsh-gti-section{margin-top:16px;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:10px}
.dsh-gti-section-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-gti-comment{padding:8px 0;border-bottom:.5px dashed var(--dsw-alias-border-l1)}
.dsh-gti-comment-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-gti-comment-body{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.dsh-gti-form{display:flex;flex-direction:column;gap:10px;padding:12px 16px 24px}
.dsh-gti-field{display:flex;flex-direction:column;gap:4px}
.dsh-gti-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-gti-field-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-gti-choices{display:flex;flex-wrap:wrap;gap:6px}
.dsh-gti-choice{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);font-size:11px;cursor:pointer;user-select:none}
.dsh-gti-choice[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-gti-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
.dsh-gti-note{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-gti-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dsh-gti-note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dsh-gti-note[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}
.dsh-gti-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 20px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsh-gti-empty p{margin:0}
.dsh-gti-table{width:100%;border-collapse:collapse;font-size:12px}
.dsh-gti-table th,.dsh-gti-table td{text-align:left;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:top}
.dsh-gti-table th{color:var(--dsw-alias-label-tertiary);font-weight:500}
.dsh-gti-server-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;align-items:end;margin:10px 0}
.dsh-gti-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px 40px}
.dsh-gti-code{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-gti-split{display:flex;flex:1 1 auto;min-height:0}
.dsh-gti-split-list{width:min(420px,42%);flex:none;border-right:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0}
.dsh-gti-split-detail{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;min-height:0}
/* 视图开关：泳道 / 列表分段控件 + 分组下拉（放在筛选条右端）。 */
.dsh-gti-view{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-gti-seg{display:inline-flex;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);overflow:hidden}
.dsh-gti-seg-button{font:inherit;font-size:12px;line-height:16px;padding:3px 10px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.dsh-gti-seg-button+.dsh-gti-seg-button{border-left:.5px solid var(--dsw-alias-border-l2)}
.dsh-gti-seg-button:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dsh-gti-seg-button[data-active="true"]{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-weight:600}
/* 泳道：**竖列**（与主流看板一致 —— 分组横向铺成一列一列，卡片在列内从上往下堆）。
   列多了横向滚动；单列封顶 340px，免得只剩一列时被拉成一整屏宽的怪东西。
   列头吸顶，纵向滚动时还知道自己在哪一列里。 */
.dsh-gti-board{display:flex;align-items:flex-start;gap:8px;min-height:100%}
.dsh-gti-lane{flex:1 1 200px;min-width:172px;max-width:340px;display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px)}
.dsh-gti-lane-head{display:flex;align-items:center;gap:8px;padding:6px 10px;position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px) var(--dsw-radius-sm,6px) 0 0}
.dsh-gti-lane-title{min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-gti-lane-count{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-gti-lane-body{display:flex;flex-direction:column;gap:2px;padding:2px 4px 6px}
/* 列里比列表窄：标题改成最多三行（超了省略号；完整标题在行的 title 里，悬停能看到），
   发送按钮贴到卡片右上角 —— 卡片高的时候居中的箭头会飘在半空。 */
.dsh-gti-lane-body .dsh-gti-row{margin:0}
.dsh-gti-lane-body .dsh-gti-row-wrap{margin:0}
.dsh-gti-lane-body .dsh-gti-row-title{white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dsh-gti-lane-body .dsh-gti-send{align-self:flex-start}
.dsh-gti-lane-empty{padding:10px 6px;font-size:11px;text-align:center;color:var(--dsw-alias-label-tertiary)}
`

    /** 界面里用的极简图标（本 bundle 没有构建步骤，所以手画 SVG，不引图标库）。 */
    const ICON_PATHS = {
      refresh: ['M16 8a8 8 0 1 1-2.34-5.66', 'M16 3v5h-5'],
      plus: ['M8 3.5v9', 'M3.5 8h9'],
      settings: ['M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M13 8a5 5 0 0 0-.08-.86l1.4-1.1-1.5-2.6-1.66.67A5 5 0 0 0 9.6 3.2L9.3 1.5h-2.6L6.4 3.2a5 5 0 0 0-1.56.91L3.18 3.44l-1.5 2.6 1.4 1.1A5 5 0 0 0 3 8c0 .29.03.58.08.86l-1.4 1.1 1.5 2.6 1.66-.67c.45.4.98.71 1.56.91l.3 1.7h2.6l.3-1.7a5 5 0 0 0 1.56-.91l1.66.67 1.5-2.6-1.4-1.1c.05-.28.08-.57.08-.86Z'],
      back: ['M10 12.5 5.5 8 10 3.5', 'M5.5 8H14'],
      external: ['M9 3h4v4', 'M13 3 7.5 8.5', 'M12 11v2H3V4h2'],
      trash: ['M3.5 5h9', 'M6.5 5V3.5h3V5', 'M5 5l.6 8h4.8L11 5'],
      check: ['M3.5 8.5 6.5 11.5 12.5 4.5'],
      close: ['M4 4l8 8', 'M12 4l-8 8'],
      upload: ['M8 11V4', 'M5 6.5 8 3.5l3 3', 'M3.5 12.5h9'],
      comment: ['M3 4.5h10v6H8l-3 2.5v-2.5H3z'],
      lock: ['M5 7.5V6a3 3 0 0 1 6 0v1.5', 'M4.5 7.5h7v6h-7z'],
      pin: ['M8 2.5 9 6l3.5.5-2.5 2.5.7 4.5-2.7-2-2.7 2 .7-4.5L3.5 6.5 7 6z'],
      // 「发送到 DSH」：一条指向右侧的箭头（16px 网格里最不容易看错的「发出去」形状）。
      send: ['M2.5 8h9', 'M8.3 4.8 11.5 8l-3.2 3.2'],
    }

    /**
     * 画一个线性图标。
     * @param props - `name`（{@link ICON_PATHS} 的键）、`size`。
     * @returns SVG 元素。
     */
    function Icon({ name, size = 16 }) {
      const paths = ICON_PATHS[name] ?? []
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    // ── 与 Host 通信 ─────────────────────────────────────────────────────────

    /**
     * 打一次桥。
     *
     * 只认三种结局：成功（`ok: true`）、Host 明确拒绝（带 `code`/`message`）、
     * 连接层失败（没有响应）。**不重试**：这些请求会改变远端状态，静默重试可能重复建 issue。
     *
     * @param op - 操作名。
     * @param params - 参数。
     * @returns `{ ok, data, total, code, message, status }`。
     */
    async function callBridge(op, params = {}) {
      let response
      try {
        response = await fetch(API_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, params }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch {
        return { ok: false, code: 'transport', message: 'transport' }
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (response.ok && payload?.ok === true) {
        return { ok: true, data: payload.data, total: payload.total }
      }
      return {
        ok: false,
        status: response.status,
        code: typeof payload?.code === 'string' ? payload.code : 'request-failed',
        message: typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`,
      }
    }

    /**
     * 建一组带语义的调用口，组件里不必记操作名。
     * @returns 调用方法集合。
     */
    function createApi() {
      /** 统一的 Gitea 操作调用。 */
      const gitea = (op, params = {}) => callBridge('gitea.call', { op, params })
      return {
        callBridge,
        gitea,
        config: () => callBridge('config.get'),
        serverAdd: (input) => callBridge('config.server.add', input),
        serverUpdate: (id, patch, token) => callBridge('config.server.update', { id, patch, token }),
        serverRemove: (id, expectedRevision) => callBridge('config.server.remove', { id, expectedRevision }),
        serverTest: (id) => callBridge('config.server.test', { id }),
        binding: (sessionId, root) => callBridge('binding.get', { sessionId, root }),
        bind: (params) => callBridge('binding.set', params),
        unbind: (params) => callBridge('binding.remove', params),
        repos: (serverId, q) => callBridge('repo.list', { serverId, q }),
        repoMeta: (params) => callBridge('repo.meta', params),
        issueDetail: (params) => callBridge('issue.detail', params),
        presets: () => callBridge('presets.list'),
        autoGet: () => callBridge('watch.get'),
        autoSet: (params) => callBridge('watch.set', params),
        autoTick: () => callBridge('watch.tick'),
        autoRequeue: (params) => callBridge('watch.requeue', params),
      }
    }

    // ── 纯工具 ──────────────────────────────────────────────────────────────

    /** 把 ISO 时间裁成 `MM-DD HH:mm`（读不懂就原样返回）。 */
    function shortTime(value) {
      if (typeof value !== 'string' || value.length < 16) return value ?? ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      const pad = (number) => String(number).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * 毫秒 → `mm:ss`（超过一小时给 `h:mm:ss`）。
     *
     * 倒计时**向上取整**：向下取整会让最后一秒提前显示 `00:00`，看起来像「已经到点但没动」。
     * @param milliseconds - 剩余毫秒。
     * @returns 倒计时文本。
     */
    function formatCountdown(milliseconds) {
      const total = Math.max(0, Math.ceil(milliseconds / 1000))
      const hours = Math.floor(total / 3600)
      const pad = (number) => String(number).padStart(2, '0')
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
    }

    /** 秒 → `2h 30m` / `45m`。 */
    function formatDuration(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      const hours = Math.floor(total / 3600)
      const minutes = Math.round((total % 3600) / 60)
      if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
      if (hours > 0) return `${hours}h`
      return `${minutes}m`
    }

    /** 人类可读的字节数。 */
    function formatBytes(size) {
      const value = Number(size)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
      return `${(value / (1024 * 1024)).toFixed(1)} MiB`
    }

    /** 标签颜色的内联样式（Gitea 给的是不带 `#` 的十六进制）。 */
    function labelDotStyle(color) {
      const value = typeof color === 'string' && /^[0-9a-fA-F]{3,8}$/.test(color) ? `#${color}` : undefined
      return value === undefined ? undefined : { background: value }
    }

    /** issue 的稳定身份，用作 React key 与选中判定。 */
    function issueKey(issue) {
      return `${issue.serverId ?? ''}\u0000${issue.owner ?? ''}/${issue.repo ?? ''}\u0000${issue.index}`
    }

    /** 数组 → 逗号串（给紧凑展示用）。 */
    function joinNames(items, pick) {
      return (items ?? []).map(pick).filter(Boolean).join(', ')
    }

    /**
     * 把文件读成 base64（不带 `data:` 前缀）。
     * @param file - 浏览器 `File`。
     * @returns base64 字符串。
     */
    async function fileToBase64(file) {
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const chunk = 0x8000
      for (let at = 0; at < bytes.length; at += chunk) {
        binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
      }
      return btoa(binary)
    }

    /** 用 `t` 渲染失败信息：传输层失败与 Host 明确拒绝分开说。 */
    function failureText(t, result) {
      if (result.code === 'transport') return t('error.transport')
      if (result.code === 'token-missing') return t('error.noToken')
      return result.message || t('error.unknown')
    }

    /**
     * 把一条 issue 拼成要插进对话输入框的提示词：**只有一行**「请处理 Gitea issue #12：标题」。
     *
     * **不带网址是刻意的**（用户明确要求）：工作区隔离下模型只能操作当前工作区绑定的那个仓库，
     * `gitea_issue_get` 拿编号就够了，网址只是输入框里的噪音；要看网页版在详情页有「在浏览器打开」。
     *
     * **尾随换行也是刻意的**：光标停在末尾的新行上，用户接着补自己的要求时不用先按回车。
     * @param t - 文案函数。
     * @param issue - 线上 issue 对象（只用 `index` / `title`；`htmlUrl` 一概不用）。
     * @returns 提示词字符串（末尾带一个换行）。
     */
    function issuePrompt(t, issue) {
      return `${t('send.prompt', { index: issue.index, title: issue.title })}\n`
    }

    /**
     * 「输入框哨兵」：渲染 `null`，唯一作用是把本会话的 `inputActions`（对话输入框的公开
     * 写入面）登记进模块级 `inputTargets`，供看板的「发送到 DSH」兜底；卸载即删。
     *
     * 为什么不让看板只从自己的槽位 prop 拿：侧栏槽位的渲染点**不保证**传全那套标准 prop
     * （`dsh-editor` 在 `sidebar.right.tab.document` 上白屏过）。`conversation.input.*` 是官方
     * 自己（语音输入、目标栏）在用的位置，`inputActions` 一定在；两处都拿不到时发送只亮横幅，
     * 不影响看板本身。
     *
     * 删除时先比对象：同一会话重挂（换布局 / 换会话）时新哨兵可能已经登记，晚到的旧 cleanup
     * 不能把新的那份删掉。
     * @param props - `conversation.input.dock` 交来的 props（`sessionId` 与 `inputActions`；
     *   会话 id 缺失时退回 owner 的 `session.sessionId`）。
     * @returns null。
     */
    function InputSink(props) {
      const { sessionId, inputActions, session } = props
      const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : session?.sessionId
      React.useEffect(() => {
        if (typeof id !== 'string' || id === '' || inputActions === undefined) return undefined
        inputTargets.set(id, inputActions)
        return () => {
          if (inputTargets.get(id) === inputActions) inputTargets.delete(id)
        }
      }, [id, inputActions])
      return null
    }

    // ── 小组件 ──────────────────────────────────────────────────────────────

    /** 一条横幅：提示 / 警告 / 错误 / 成功。 */
    function Banner({ tone, text, children }) {
      return h('div', { className: 'dsh-gti-banner', 'data-tone': tone, 'data-gti-banner': tone ?? 'info' },
        h('span', { className: 'dsh-gti-banner-text' }, text),
        children)
    }

    /** 空态：一句话 + 可选的下一步。 */
    function Empty({ title, hint, children }) {
      return h('div', { className: 'dsh-gti-empty', 'data-gti-empty': title },
        h('p', null, title),
        hint === undefined ? null : h('p', { className: 'dsh-gti-note' }, hint),
        children)
    }

    /** 状态点 + 文案。 */
    function StateChip({ state, t }) {
      const label = state === 'closed' ? t('state.closed') : t('state.open')
      return h('span', { className: 'dsh-gti-chip', 'data-gti-state': state },
        h('span', { className: 'dsh-gti-dot', 'data-state': state }),
        label)
    }

    /** 标签串。 */
    function LabelChips({ labels }) {
      return (labels ?? []).map((label) => h('span', { key: `${label.id ?? label.name}`, className: 'dsh-gti-chip' },
        h('span', { className: 'dsh-gti-label-dot', style: labelDotStyle(label.color) }),
        label.name))
    }

    /** 一屏提示用的加载/错误块。 */
    function Loading({ t }) {
      return h(Empty, { title: t('common.loading') })
    }

    /**
     * 列表里的一行。
     * @param props - `issue` / `selected` / `onOpen` / `showRepo` / `t`。
     */
    function IssueRow({ issue, selected, onOpen, showRepo, t }) {
      const where = showRepo ? [issue.owner, issue.repo].filter(Boolean).join('/') : ''
      return h('button', {
        type: 'button',
        className: 'dsh-gti-row',
        'data-selected': selected ? 'true' : 'false',
        'data-gti-issue': issueKey(issue),
        onClick: () => onOpen(issue),
        title: issue.title,
      },
        h('span', { className: 'dsh-gti-row-head' },
          h('span', { className: 'dsh-gti-dot', 'data-state': issue.state }),
          h('span', { className: 'dsh-gti-row-index' }, `#${issue.index}`),
          h('span', { className: 'dsh-gti-row-title' }, issue.title)),
        h('span', { className: 'dsh-gti-row-meta' },
          where === '' ? null : h('span', null, where),
          issue.labels.length > 0 ? h('span', null, joinNames(issue.labels, (label) => label.name)) : null,
          issue.assignees.length > 0 ? h('span', null, joinNames(issue.assignees, (user) => `@${user.login}`)) : null,
          issue.comments > 0 ? h('span', { 'data-gti-comment-count': issue.comments }, `💬 ${issue.comments}`) : null,
          issue.milestone === null ? null : h('span', null, `◎ ${issue.milestone.title}`),
          issue.dueDate === null ? null : h('span', null, `⏱ ${shortTime(issue.dueDate)}`),
          issue.pinned ? h('span', { 'data-gti-pinned': 'true' }, `📌 ${t('issue.pin')}`) : null,
          issue.locked ? h('span', null, '🔒') : null))
    }

    /**
     * 把 issues 分进泳道 —— **泳道模式的唯一分组逻辑**（列表模式不走这里）。
     *
     * 为什么在客户端分组：Gitea 的 issue 列表没有「按指派 / 标签聚簇」这种返回形状；一次取回
     * 50 条自己分，比每个维度各发一次请求更省，切维度也不用重新取数。
     *
     * 一条 issue 可以同时落在多条泳道（多个指派 / 多个标签）—— 这是有意的：泳道是**视角**，
     * 不是归属；否则「按指派分」会悄悄丢掉第二个负责人。没有任何值的 issue 落进「未指派 /
     * 无标签 / 无里程碑」泳道，不会被漏掉。
     *
     * **按状态分组时两条泳道始终都在**（空了也留一列）：看板的意义就是「看得见哪一列是空的」，
     * 默认视图又固定取全部状态，所以列不会白占地方；其余维度只能从数据里长出泳道，没有就不画。
     * @param issues - 线上 issue 数组。
     * @param group - 分组维度：`state` / `assignee` / `label` / `milestone`。
     * @param t - 文案函数。
     * @returns `[{ key, title, issues }]`；泳道顺序稳定（状态固定 open → closed，其余按标题排，
     *   「无 X」那条垫底）。
     */
    function laneGroups(issues, group, t) {
      const list = issues ?? []
      // 状态按固定顺序建桶：按标题排序会把 closed 排到 open 前面（字母序），也不该丢空列。
      if (group === 'state') {
        const lanes = ['open', 'closed'].map((state) => ({ key: `state:${state}`, title: t(`state.${state}`), issues: [] }))
        const byKey = new Map(lanes.map((lane) => [lane.key, lane]))
        for (const issue of list) byKey.get(`state:${issue.state}`)?.issues.push(issue)
        return lanes
      }
      const buckets = new Map()
      const push = (key, title, issue) => {
        const lane = buckets.get(key)
        if (lane === undefined) buckets.set(key, { key, title, issues: [issue] })
        else lane.issues.push(issue)
      }
      const noneKey = `${group}:-`
      for (const issue of list) {
        const values = group === 'assignee'
          ? (issue.assignees ?? [])
          : group === 'label'
            ? (issue.labels ?? [])
            : (issue.milestone === null || issue.milestone === undefined ? [] : [issue.milestone])
        const seen = new Set()
        for (const value of values) {
          const key = group === 'assignee' ? `assignee:${value.login}` : group === 'label' ? `label:${value.name}` : `milestone:${value.id}`
          if (seen.has(key)) continue
          seen.add(key)
          push(key, group === 'assignee' ? `@${value.login}` : group === 'label' ? value.name : value.title, issue)
        }
        if (values.length === 0) push(noneKey, t(`group.none.${group}`), issue)
      }
      return [...buckets.values()].sort((left, right) => {
        if (left.key === noneKey) return 1
        if (right.key === noneKey) return -1
        return String(left.title).localeCompare(String(right.title))
      })
    }

    /**
     * 列表里的一行，外加可选的「发送到 DSH」按钮 —— 列表模式与泳道模式共用同一行。
     *
     * 「发送」按钮是行的**兄弟**而不是子节点：`IssueRow` 本身就是 `<button>`，交互元素不能
     * 嵌套（真实浏览器里点里层会连带触发外层）。`onSend` 只有工作区看板传：全局看板是跨工作区
     * 的视图，不碰别人的输入框。
     * @param props - `issue` / `showRepo` / `selected` / `onOpen` / `onSend`（可选）/ `t`。
     */
    function IssueListRow({ issue, showRepo, selected, onOpen, onSend, t }) {
      const row = h(IssueRow, { issue, showRepo, selected, onOpen, t })
      if (typeof onSend !== 'function') return row
      return h('div', { className: 'dsh-gti-row-wrap', 'data-gti-send-row': issueKey(issue) },
        row,
        h('button', {
          type: 'button',
          className: 'dsh-gti-send',
          title: t('send.hint'),
          'data-gti-send': issueKey(issue),
          onClick: () => onSend(issue),
        }, h(Icon, { name: 'send', size: 14 }),
          h('span', { className: 'dsh-gti-send-label' }, t('send.action'))))
    }

    /**
     * issue 列表的两种呈现：**泳道（竖列看板，默认）** 与扁平列表。
     * @param props - `issues` / `mode` / `group` / `showRepo` / `selectedKey` / `onOpen` /
     *   `onSend`（可选）/ `t`。
     */
    function IssueList({ issues, mode, group, showRepo, selectedKey, onOpen, onSend, t }) {
      const row = (issue) => h(IssueListRow, {
        key: issueKey(issue),
        issue,
        t,
        showRepo,
        selected: issueKey(issue) === selectedKey,
        onOpen,
        onSend,
      })
      if (mode !== 'lanes') {
        return h('div', { className: 'dsh-gti-list', 'data-gti-list': 'list' }, issues.map(row))
      }
      return h('div', { className: 'dsh-gti-list', 'data-gti-list': 'lanes' },
        h('div', { className: 'dsh-gti-board', 'data-gti-board': group },
          laneGroups(issues, group, t).map((lane) => h('section', {
            key: lane.key,
            className: 'dsh-gti-lane',
            'data-gti-lane': lane.key,
          },
            h('div', { className: 'dsh-gti-lane-head' },
              h('span', { className: 'dsh-gti-lane-title' }, lane.title),
              h('span', { className: 'dsh-gti-lane-count', 'data-gti-lane-count': lane.issues.length },
                t('list.count', { n: lane.issues.length }))),
            h('div', { className: 'dsh-gti-lane-body' },
              // 空列也给个占位：看板要能看出「这一列是空的」，而不是以为列没渲染出来。
              lane.issues.length === 0
                ? h('div', { className: 'dsh-gti-lane-empty', 'data-gti-lane-empty': lane.key }, t('lane.empty'))
                : lane.issues.map(row))))))
    }

    /**
     * 筛选条。
     * @param props - `value` / `onChange` / `servers` / `showServer` / `showOwner` / `stateLocked` /
     *   `t` / `children`（放在条子最右边的视图开关）。
     */
    function FilterBar({ value, onChange, servers, showServer, showOwner, stateLocked, t, children }) {
      const set = (patch) => onChange({ ...value, ...patch })
      return h('div', { className: 'dsh-gti-bar', 'data-gti-filter': 'true' },
        h('label', { className: 'dsh-gti-note' }, t('filter.state')),
        h('select', {
          className: 'dsh-gti-select',
          value: value.state,
          disabled: stateLocked === true,
          title: stateLocked === true ? t('filter.stateLocked') : undefined,
          'data-gti-filter-state': 'true',
          'data-gti-filter-state-locked': stateLocked === true ? 'true' : 'false',
          onChange: (event) => set({ state: event.target.value }),
        }, STATES.map((state) => h('option', { key: state, value: state }, t(`state.${state}`)))),
        // 置灰控件旁边给一句可见解释：禁用元素的 `title` 在部分浏览器里根本弹不出来，别让控件变成哑巴。
        stateLocked === true ? h('span', { className: 'dsh-gti-note', 'data-gti-state-locked': 'true' },
          t('filter.stateLockedHint')) : null,
        showServer ? h('select', {
          className: 'dsh-gti-select',
          value: value.serverId ?? '',
          'data-gti-filter-server': 'true',
          onChange: (event) => set({ serverId: event.target.value }),
        }, [h('option', { key: '', value: '' }, t('filter.allServers'))]
          .concat((servers ?? []).map((server) => h('option', { key: server.id, value: server.id }, server.name)))) : null,
        showOwner ? h('input', {
          className: 'dsh-gti-input',
          value: value.owner ?? '',
          placeholder: t('filter.ownerPlaceholder'),
          'data-gti-filter-owner': 'true',
          onChange: (event) => set({ owner: event.target.value }),
        }) : null,
        h('input', {
          className: 'dsh-gti-input',
          value: value.q ?? '',
          placeholder: t('filter.keywordPlaceholder'),
          'data-gti-filter-q': 'true',
          onChange: (event) => set({ q: event.target.value }),
        }),
        h('span', { className: 'dsh-gti-spacer' }),
        children)
    }

    /**
     * 视图开关：泳道 / 列表的分段控件，外加（泳道模式下的）分组维度下拉。
     *
     * 放在筛选条右端而不是标题栏：它和筛选一样是「看哪一部分」的控制，标题栏留给写操作
     * （新建 / 绑定设置 / 刷新）。
     * @param props - `mode` / `group` / `onMode` / `onGroup` / `t`。
     */
    function ViewControls({ mode, group, onMode, onGroup, t }) {
      return h('div', { className: 'dsh-gti-view', 'data-gti-view': mode },
        h('div', {
          className: 'dsh-gti-seg',
          role: 'group',
          'aria-label': t('view.mode'),
          'data-gti-mode-switch': 'true',
        }, MODES.map((item) => h('button', {
          key: item,
          type: 'button',
          className: 'dsh-gti-seg-button',
          'data-gti-mode': item,
          'data-active': mode === item ? 'true' : 'false',
          title: t(`view.${item}`),
          onClick: () => onMode(item),
        }, t(`view.${item}`)))),
        // 分组下拉只在泳道模式下出现：列表模式没有泳道可分，留着它只会让人以为选错了模式。
        mode === 'lanes' ? h('select', {
          className: 'dsh-gti-select',
          value: group,
          title: t('view.group'),
          'data-gti-group': 'true',
          onChange: (event) => onGroup(event.target.value),
        }, GROUPS.map((item) => h('option', { key: item, value: item }, t(`group.${item}`)))) : null)
    }

    // ── issue 表单（新建 / 编辑共用） ───────────────────────────────────────

    /**
     * 新建与编辑共用一个表单：差异只在初始值与提交动作，不复制一份 UI。
     * @param props - `mode`（`create` / `edit`）、`meta`、`initial`、`onSubmit`、`onCancel`、`t`、`busy`。
     */
    function IssueForm({ mode, meta, initial, onSubmit, onCancel, t, busy }) {
      const [title, setTitle] = React.useState(initial.title ?? '')
      const [body, setBody] = React.useState(initial.body ?? '')
      const [dueDate, setDueDate] = React.useState(
        typeof initial.dueDate === 'string' && initial.dueDate !== '' ? initial.dueDate.slice(0, 10) : '')
      const [milestoneId, setMilestoneId] = React.useState(initial.milestoneId === undefined ? '' : String(initial.milestoneId))
      const [labelIds, setLabelIds] = React.useState(initial.labelIds ?? [])
      const [assignees, setAssignees] = React.useState(initial.assignees ?? [])

      const toggle = (list, setList, value) => {
        setList(list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
      }

      const submit = () => {
        onSubmit({
          title: title.trim(),
          body,
          due_date: dueDate === '' ? undefined : `${dueDate}T00:00:00Z`,
          milestone: milestoneId === '' ? undefined : Number(milestoneId),
          labels: labelIds,
          assignees,
        })
      }

      return h('div', { className: 'dsh-gti-form', 'data-gti-form': mode },
        h('div', { className: 'dsh-gti-field' },
          h('label', { className: 'dsh-gti-field-label' }, t('form.title')),
          h('input', {
            className: 'dsh-gti-input',
            value: title,
            placeholder: t('form.titlePlaceholder'),
            'data-gti-form-title': 'true',
            onChange: (event) => setTitle(event.target.value),
          })),
        h('div', { className: 'dsh-gti-field' },
          h('label', { className: 'dsh-gti-field-label' }, t('form.body')),
          h('textarea', {
            className: 'dsh-gti-textarea',
            value: body,
            placeholder: t('form.bodyPlaceholder'),
            'data-gti-form-body': 'true',
            onChange: (event) => setBody(event.target.value),
          })),
        meta.labels.length === 0 ? null : h('div', { className: 'dsh-gti-field' },
          h('label', { className: 'dsh-gti-field-label' }, `${t('form.labels')}（${t('meta.labels', { n: meta.labels.length })}）`),
          h('div', { className: 'dsh-gti-choices' }, meta.labels.map((label) => h('span', {
            key: label.id,
            className: 'dsh-gti-choice',
            'data-on': labelIds.includes(label.id) ? 'true' : 'false',
            'data-gti-label-choice': label.id,
            onClick: () => toggle(labelIds, setLabelIds, label.id),
          }, h('span', { className: 'dsh-gti-label-dot', style: labelDotStyle(label.color) }), label.name)))),
        meta.assignees.length === 0 ? null : h('div', { className: 'dsh-gti-field' },
          h('label', { className: 'dsh-gti-field-label' }, t('form.assignees')),
          h('div', { className: 'dsh-gti-choices' }, meta.assignees.map((user) => h('span', {
            key: user.login,
            className: 'dsh-gti-choice',
            'data-on': assignees.includes(user.login) ? 'true' : 'false',
            'data-gti-assignee-choice': user.login,
            onClick: () => toggle(assignees, setAssignees, user.login),
          }, `@${user.login}`)))),
        h('div', { className: 'dsh-gti-field-row' },
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('form.milestone')),
            h('select', {
              className: 'dsh-gti-select',
              value: milestoneId,
              'data-gti-form-milestone': 'true',
              onChange: (event) => setMilestoneId(event.target.value),
            }, [h('option', { key: '', value: '' }, t('common.none'))]
              .concat(meta.milestones.map((milestone) => h('option', { key: milestone.id, value: String(milestone.id) }, milestone.title))))),
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('form.due')),
            h('input', {
              className: 'dsh-gti-input',
              type: 'date',
              value: dueDate,
              'data-gti-form-due': 'true',
              onChange: (event) => setDueDate(event.target.value),
            }))),
        h('div', { className: 'dsh-gti-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-gti-button',
            'data-primary': 'true',
            disabled: busy || title.trim() === '',
            'data-gti-form-submit': 'true',
            onClick: submit,
          }, mode === 'create' ? t('form.submitCreate') : t('form.submitSave')),
          h('button', {
            type: 'button',
            className: 'dsh-gti-button',
            disabled: busy,
            onClick: onCancel,
          }, t('common.cancel'))))
    }

    // ── issue 详情 ──────────────────────────────────────────────────────────

    /**
     * issue 详情：正文、元信息、依赖/阻塞、订阅/置顶/锁定/工时/附件、评论增删改。
     * @param props - `api` / `t` / `target`（`{serverId, owner, repo, index}`）/ `onBack` / `onChanged` /
     *   `onEdit`，外加可选的 `onSend`（给了才出「发送到 DSH」按钮）与 `sendNotice`（那次发送的结果横幅）。
     */
    function IssueDetail({ api, t, target, onBack, onChanged, onEdit, onSend, sendNotice }) {
      const [detail, setDetail] = React.useState(null)
      const [meta, setMeta] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [editingComment, setEditingComment] = React.useState(null)
      const [depInput, setDepInput] = React.useState('')
      const [blockInput, setBlockInput] = React.useState('')
      const [minutes, setMinutes] = React.useState('30')

      /** 重新拉详情。 */
      const reload = React.useCallback(async () => {
        const result = await api.issueDetail({ ...target, sessionId: target.sessionId })
        if (result.ok) {
          setDetail(result.data)
          setError(null)
        } else {
          setError(failureText(t, result))
        }
      }, [api, t, target.serverId, target.owner, target.repo, target.index, target.sessionId])

      React.useEffect(() => { void reload() }, [reload])

      // 仓库元信息只在编辑时要（标签/里程碑/可指派候选），所以单独懒加载，失败不影响正文。
      React.useEffect(() => {
        let alive = true
        void api.repoMeta({ ...target, sessionId: target.sessionId }).then((result) => {
          if (alive && result.ok) setMeta(result.data)
        })
        return () => { alive = false }
      }, [api, target.serverId, target.owner, target.repo, target.sessionId])

      /** 跑一个动作：忙碌标记 → 调用 → 刷新 → 通知。 */
      const act = async (label, run, options = {}) => {
        setBusy(label)
        setNotice(null)
        const result = await run()
        setBusy(null)
        if (!result.ok) {
          setNotice({ tone: 'error', text: failureText(t, result) })
          return false
        }
        if (options.reload !== false) await reload()
        if (options.onChanged === true) onChanged?.()
        if (options.success !== undefined) setNotice({ tone: 'success', text: options.success })
        return true
      }

      if (error !== null && detail === null) {
        return h('div', { className: 'dsh-gti-column' },
          h(Banner, { tone: 'error', text: error },
            h('button', { type: 'button', className: 'dsh-gti-button', onClick: () => void reload() }, t('common.retry'))),
          h('div', { className: 'dsh-gti-actions', style: { padding: '8px 12px' } },
            h('button', { type: 'button', className: 'dsh-gti-button', onClick: onBack }, t('common.back'))))
      }
      if (detail === null) return h('div', { className: 'dsh-gti-column' }, h(Loading, { t }))

      const issue = detail.issue
      const action = (label, name, params, options) => h('button', {
        key: name,
        type: 'button',
        className: 'dsh-gti-button',
        disabled: busy !== null,
        'data-gti-action': name,
        onClick: () => void act(name, () => api.gitea(name, { ...target, ...params }), options),
      }, label)

      return h('div', { className: 'dsh-gti-column', 'data-gti-detail': issueKey(issue) },
        h('div', { className: 'dsh-gti-bar' },
          h('button', {
            type: 'button',
            className: 'dsh-gti-icon-button',
            title: t('common.back'),
            'data-gti-back': 'true',
            onClick: onBack,
          }, h(Icon, { name: 'back' })),
          h('span', { className: 'dsh-gti-row-index' }, `#${issue.index}`),
          h(StateChip, { state: issue.state, t }),
          issue.pinned ? h('span', { className: 'dsh-gti-chip', 'data-tone': 'brand' }, `📌 ${t('issue.pin')}`) : null,
          issue.locked ? h('span', { className: 'dsh-gti-chip' }, `🔒 ${t('issue.lock')}`) : null,
          h('span', { className: 'dsh-gti-spacer' }),
          h('button', {
            type: 'button',
            className: 'dsh-gti-button',
            disabled: busy !== null,
            'data-gti-edit': 'true',
            onClick: () => onEdit(issue),
          }, t('common.edit')),
          h('button', {
            type: 'button',
            className: 'dsh-gti-icon-button',
            title: t('common.refresh'),
            disabled: busy !== null,
            onClick: () => void reload(),
          }, h(Icon, { name: 'refresh' }))),
        notice === null ? null : h(Banner, { tone: notice.tone, text: notice.text }),
        sendNotice === undefined || sendNotice === null ? null : h(Banner, { tone: sendNotice.tone, text: sendNotice.text }),
        h('div', { className: 'dsh-gti-detail' },
          h('div', { className: 'dsh-gti-detail-head' },
            h('h2', { className: 'dsh-gti-detail-title' }, issue.title),
            issue.htmlUrl === null ? null : h('a', {
              className: 'dsh-gti-button',
              href: issue.htmlUrl,
              target: '_blank',
              rel: 'noreferrer',
              'data-gti-external': 'true',
            }, t('issue.openInBrowser'))),
          h('div', { className: 'dsh-gti-kv' },
            h('span', { className: 'dsh-gti-kv-key' }, t('issue.labels')),
            h('span', { className: 'dsh-gti-kv-value' }, issue.labels.length === 0 ? t('common.none') : h('span', { className: 'dsh-gti-choices' }, h(LabelChips, { labels: issue.labels }))),
            h('span', { className: 'dsh-gti-kv-key' }, t('issue.assignees')),
            h('span', { className: 'dsh-gti-kv-value' }, issue.assignees.length === 0 ? t('common.none') : joinNames(issue.assignees, (user) => `@${user.login}`)),
            h('span', { className: 'dsh-gti-kv-key' }, t('issue.milestone')),
            h('span', { className: 'dsh-gti-kv-value' }, issue.milestone === null ? t('common.none') : issue.milestone.title),
            h('span', { className: 'dsh-gti-kv-key' }, t('issue.due')),
            h('span', { className: 'dsh-gti-kv-value' }, issue.dueDate === null ? t('common.none') : shortTime(issue.dueDate)),
            h('span', { className: 'dsh-gti-kv-key' }, t('issue.author')),
            h('span', { className: 'dsh-gti-kv-value' }, issue.user === null ? t('common.none') : `@${issue.user.login}`),
            h('span', { className: 'dsh-gti-kv-key' }, t('issue.created')),
            h('span', { className: 'dsh-gti-kv-value' }, `${shortTime(issue.createdAt)} · ${t('issue.updated')} ${shortTime(issue.updatedAt)}`)),
          h('div', { className: 'dsh-gti-body-text' }, issue.body === '' ? t('issue.bodyEmpty') : issue.body),
          h('div', { className: 'dsh-gti-actions' },
            action(issue.state === 'open' ? t('issue.close') : t('issue.reopen'), 'issue.edit', { state: issue.state === 'open' ? 'closed' : 'open' }),
            action(issue.pinned ? t('issue.unpin') : t('issue.pin'), issue.pinned ? 'issue.unpin' : 'issue.pin'),
            action(issue.locked ? t('issue.unlock') : t('issue.lock'), issue.locked ? 'issue.unlock' : 'issue.lock'),
            action(detail.subscribed ? t('issue.unsubscribe') : t('issue.subscribe'), detail.subscribed ? 'issue.unsubscribe' : 'issue.subscribe', {}, { reload: false, success: detail.subscribed ? undefined : t('issue.subscribed') }),
            // 「发送到 DSH」：只有工作区看板给了 `onSend` 才出现（全局看板不碰别人的输入框）。
            onSend === undefined ? null : h('button', {
              type: 'button',
              className: 'dsh-gti-button',
              title: t('send.hint'),
              'data-gti-send': 'true',
              onClick: () => onSend(issue),
            }, t('send.action'))),

          h('div', { className: 'dsh-gti-section', 'data-gti-section': 'deps' },
            h('div', { className: 'dsh-gti-section-head' }, t('deps.title')),
            detail.dependencies.length === 0
              ? h('p', { className: 'dsh-gti-note' }, t('deps.empty'))
              : h('div', null, detail.dependencies.map((item) => h('div', { key: item.index, className: 'dsh-gti-note' },
                h('button', {
                  type: 'button',
                  className: 'dsh-gti-button',
                  onClick: () => onEdit(null, { index: item.index }),
                }, `#${item.index}`),
                ' ',
                item.title))),
            h('div', { className: 'dsh-gti-field-row' },
              h('input', {
                className: 'dsh-gti-input',
                value: depInput,
                placeholder: t('deps.placeholder'),
                'data-gti-dep-input': 'true',
                onChange: (event) => setDepInput(event.target.value.replace(/[^0-9]/g, '')),
              }),
              h('button', {
                type: 'button',
                className: 'dsh-gti-button',
                disabled: busy !== null || depInput === '',
                onClick: () => void act('deps', () => api.gitea('issue.dependencies.add', { ...target, dependsOn: Number(depInput) })).then((done) => { if (done) setDepInput('') }),
              }, t('deps.add')))),
          h('div', { className: 'dsh-gti-section', 'data-gti-section': 'blocks' },
            h('div', { className: 'dsh-gti-section-head' }, t('blocks.title')),
            detail.blocks.length === 0
              ? h('p', { className: 'dsh-gti-note' }, t('blocks.empty'))
              : h('div', null, detail.blocks.map((item) => h('div', { key: item.index, className: 'dsh-gti-note' }, `#${item.index} ${item.title}`))),
            h('div', { className: 'dsh-gti-field-row' },
              h('input', {
                className: 'dsh-gti-input',
                value: blockInput,
                placeholder: t('deps.placeholder'),
                'data-gti-block-input': 'true',
                onChange: (event) => setBlockInput(event.target.value.replace(/[^0-9]/g, '')),
              }),
              h('button', {
                type: 'button',
                className: 'dsh-gti-button',
                disabled: busy !== null || blockInput === '',
                onClick: () => void act('blocks', () => api.gitea('issue.blocks.add', { ...target, dependsOn: Number(blockInput) })).then((done) => { if (done) setBlockInput('') }),
              }, t('blocks.add')))),

          h('div', { className: 'dsh-gti-section', 'data-gti-section': 'times' },
            h('div', { className: 'dsh-gti-section-head' }, t('times.title'),
              h('span', { className: 'dsh-gti-note' }, t('times.total', { duration: formatDuration(detail.times.reduce((sum, item) => sum + item.time, 0)) }))),
            detail.times.length === 0
              ? h('p', { className: 'dsh-gti-note' }, t('times.empty'))
              : h('div', null, detail.times.map((entry) => h('div', { key: entry.id, className: 'dsh-gti-note' },
                `${formatDuration(entry.time)} · ${entry.userName ?? '?'} · ${shortTime(entry.created)}`,
                ' ',
                h('button', {
                  type: 'button',
                  className: 'dsh-gti-button',
                  disabled: busy !== null,
                  onClick: () => void act('times', () => api.gitea('issue.times.delete', { ...target, timeId: entry.id })),
                }, t('times.delete'))))),
            h('div', { className: 'dsh-gti-field-row' },
              h('input', {
                className: 'dsh-gti-input',
                value: minutes,
                'data-gti-time-minutes': 'true',
                onChange: (event) => setMinutes(event.target.value.replace(/[^0-9]/g, '')),
              }),
              h('span', { className: 'dsh-gti-note' }, t('times.minutes')),
              h('button', {
                type: 'button',
                className: 'dsh-gti-button',
                disabled: busy !== null || minutes === '' || Number(minutes) <= 0,
                onClick: () => void act('times', () => api.gitea('issue.times.add', { ...target, time: Number(minutes) * 60 })),
              }, t('times.add')),
              detail.times.length === 0 ? null : h('button', {
                type: 'button',
                className: 'dsh-gti-button',
                disabled: busy !== null,
                onClick: () => void act('times', () => api.gitea('issue.times.reset', { ...target })),
              }, t('times.reset')))),

          h('div', { className: 'dsh-gti-section', 'data-gti-section': 'assets' },
            h('div', { className: 'dsh-gti-section-head' }, t('assets.title')),
            detail.assets.length === 0
              ? h('p', { className: 'dsh-gti-note' }, t('assets.empty'))
              : h('div', null, detail.assets.map((asset) => h('div', { key: asset.id, className: 'dsh-gti-note' },
                h('a', { href: asset.downloadUrl ?? undefined, target: '_blank', rel: 'noreferrer' }, asset.name ?? `#${asset.id}`),
                ` · ${formatBytes(asset.size)} `,
                h('button', {
                  type: 'button',
                  className: 'dsh-gti-button',
                  disabled: busy !== null,
                  onClick: () => {
                    if (!window.confirm(t('assets.deleteConfirm'))) return
                    void act('assets', () => api.gitea('issue.asset.delete', { ...target, attachmentId: asset.id }))
                  },
                }, t('common.delete'))))),
            h('div', { className: 'dsh-gti-field-row' },
              h('label', { className: 'dsh-gti-button', 'data-gti-upload': 'true' },
                busy === 'upload' ? t('assets.uploading') : t('assets.upload'),
                h('input', {
                  type: 'file',
                  style: { display: 'none' },
                  onChange: (event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file === undefined) return
                    if (file.size > MAX_ATTACHMENT_BYTES) {
                      setNotice({ tone: 'error', text: t('assets.tooLarge', { limit: formatBytes(MAX_ATTACHMENT_BYTES) }) })
                      return
                    }
                    void (async () => {
                      setBusy('upload')
                      const dataBase64 = await fileToBase64(file)
                      const result = await api.gitea('issue.assets.upload', {
                        ...target,
                        name: file.name,
                        filename: file.name,
                        contentType: file.type === '' ? 'application/octet-stream' : file.type,
                        dataBase64,
                      })
                      setBusy(null)
                      if (!result.ok) {
                        setNotice({ tone: 'error', text: t('assets.failed', { message: failureText(t, result) }) })
                        return
                      }
                      await reload()
                    })()
                  },
                })))),

          h('div', { className: 'dsh-gti-section', 'data-gti-section': 'comments' },
            h('div', { className: 'dsh-gti-section-head' }, `${t('comments.title')}（${detail.comments.length}）`),
            detail.comments.length === 0
              ? h('p', { className: 'dsh-gti-note' }, t('comments.empty'))
              : h('div', null, detail.comments.map((comment) => h('div', { key: comment.id, className: 'dsh-gti-comment', 'data-gti-comment': comment.id },
                h('div', { className: 'dsh-gti-comment-head' },
                  h('span', null, `@${comment.user?.login ?? '?'}`),
                  h('span', null, shortTime(comment.createdAt)),
                  h('span', { className: 'dsh-gti-spacer' }),
                  h('button', {
                    type: 'button',
                    className: 'dsh-gti-button',
                    disabled: busy !== null,
                    onClick: () => { setEditingComment({ id: comment.id, body: comment.body }) },
                  }, t('comments.edit')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-gti-button',
                    disabled: busy !== null,
                    onClick: () => {
                      if (!window.confirm(t('comments.deleteConfirm'))) return
                      void act('comment', () => api.gitea('comment.delete', { owner: target.owner, repo: target.repo, serverId: target.serverId, id: comment.id }))
                    },
                  }, t('comments.delete'))),
                editingComment !== null && editingComment.id === comment.id
                  ? h('div', null,
                    h('textarea', {
                      className: 'dsh-gti-textarea',
                      value: editingComment.body,
                      onChange: (event) => setEditingComment({ id: comment.id, body: event.target.value }),
                    }),
                    h('div', { className: 'dsh-gti-actions' },
                      h('button', {
                        type: 'button',
                        className: 'dsh-gti-button',
                        'data-primary': 'true',
                        disabled: busy !== null || editingComment.body.trim() === '',
                        onClick: () => void act('comment', () => api.gitea('comment.edit', {
                          owner: target.owner,
                          repo: target.repo,
                          serverId: target.serverId,
                          id: comment.id,
                          body: editingComment.body,
                        })).then((done) => { if (done) setEditingComment(null) }),
                      }, t('common.save')),
                      h('button', { type: 'button', className: 'dsh-gti-button', onClick: () => setEditingComment(null) }, t('common.cancel'))))
                  : h('p', { className: 'dsh-gti-comment-body' }, comment.body)))),
            h('div', null,
              h('textarea', {
                className: 'dsh-gti-textarea',
                value: draft,
                placeholder: t('comments.placeholder'),
                'data-gti-comment-draft': 'true',
                onChange: (event) => setDraft(event.target.value),
              }),
              h('div', { className: 'dsh-gti-actions' },
                h('button', {
                  type: 'button',
                  className: 'dsh-gti-button',
                  'data-primary': 'true',
                  disabled: busy !== null || draft.trim() === '',
                  'data-gti-comment-submit': 'true',
                  onClick: () => void act('comment', () => api.gitea('issue.comments.create', { ...target, body: draft }))
                    .then((done) => { if (done) setDraft('') }),
                }, busy === 'comment' ? t('comments.saving') : t('comments.submit')),
                meta === null ? null : h('span', { className: 'dsh-gti-note' }, `${t('meta.labels', { n: meta.labels.length })} · ${t('meta.milestones', { n: meta.milestones.length })}`))))))
    }

    // ── 配置与绑定的公共钩子 ────────────────────────────────────────────────

    /**
     * 读插件配置（服务器清单 + 绑定 + revision）。
     * @param api - 调用口。
     * @param t - 文案。
     * @returns `{ config, error, reload }`。
     */
    function useConfig(api, t) {
      const [config, setConfig] = React.useState(null)
      const [error, setError] = React.useState(null)
      const reload = React.useCallback(async () => {
        const result = await api.config()
        if (result.ok) {
          setConfig(result.data)
          setError(null)
        } else {
          setError(failureText(t, result))
        }
      }, [api, t])
      React.useEffect(() => { void reload() }, [reload])
      return { config, error, reload }
    }

    /**
     * 读某个仓库的元信息（标签 / 里程碑 / 可指派候选）。目标为空就不读。
     * @param api - 调用口。
     * @param target - `{ serverId, owner, repo }` 或 null。
     * @returns 元信息，或 null。
     */
    function useRepoMeta(api, target) {
      const [meta, setMeta] = React.useState(null)
      const key = target === null ? '' : `${target.serverId}\u0000${target.owner}\u0000${target.repo}`
      React.useEffect(() => {
        let alive = true
        setMeta(null)
        if (key === '') return () => { alive = false }
        void api.repoMeta({ serverId: target.serverId, owner: target.owner, repo: target.repo }).then((result) => {
          if (alive && result.ok) setMeta(result.data)
        })
        return () => { alive = false }
      }, [api, key])
      return meta
    }

    /** 空元信息，表单在元信息还没到位时也能渲染。 */
    const EMPTY_META = { labels: [], milestones: [], assignees: [] }

    // ── 服务器管理 ──────────────────────────────────────────────────────────

    /**
     * 服务器与令牌管理：列表、增删改、探活。令牌只写不读（界面只看得到「配没配」）。
     * @param props - `api` / `t` / `config` / `reload`。
     */
    function ServerManager({ api, t, config, reload }) {
      const [draft, setDraft] = React.useState({ name: '', baseUrl: '', tokenEnv: '', token: '' })
      const [editing, setEditing] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [probe, setProbe] = React.useState({})

      const servers = config?.servers ?? []

      const run = async (label, promise) => {
        setBusy(label)
        setNotice(null)
        const result = await promise
        setBusy(null)
        if (!result.ok) {
          setNotice({ tone: 'error', text: failureText(t, result) })
          return false
        }
        await reload()
        return true
      }

      const submitAdd = async () => {
        const done = await run('add', api.serverAdd({
          name: draft.name,
          baseUrl: draft.baseUrl,
          tokenEnv: draft.tokenEnv === '' ? null : draft.tokenEnv,
          token: draft.token === '' ? undefined : draft.token,
        }))
        if (done) {
          setDraft({ name: '', baseUrl: '', tokenEnv: '', token: '' })
          setNotice({ tone: 'success', text: t('servers.ok') })
        }
      }

      const submitEdit = async () => {
        const done = await run('edit', api.serverUpdate(editing.id, {
          name: editing.name,
          baseUrl: editing.baseUrl,
          tokenEnv: editing.tokenEnv === '' ? null : editing.tokenEnv,
        }, editing.clearToken === true ? null : (editing.token === '' ? undefined : editing.token)))
        if (done) setEditing(null)
      }

      const probeServer = async (server) => {
        setBusy(`probe-${server.id}`)
        const result = await api.serverTest(server.id)
        setBusy(null)
        if (!result.ok) {
          setProbe((current) => ({ ...current, [server.id]: { tone: 'error', text: failureText(t, result) } }))
          return
        }
        const data = result.data
        setProbe((current) => ({
          ...current,
          [server.id]: data.authenticated
            ? { tone: 'success', text: `${t('servers.version', { version: data.version ?? '?' })} · ${t('servers.user', { login: data.user?.login ?? '?' })}` }
            : { tone: 'warn', text: t('servers.tokenUnset') },
        }))
      }

      return h('div', { className: 'dsh-gti-scroll', 'data-gti-servers': 'true' },
        h('div', { className: 'dsh-gti-section-head' }, t('servers.title')),
        config === null
          ? h(Loading, { t })
          : servers.length === 0
            ? h(Empty, { title: t('servers.empty') })
            : h('table', { className: 'dsh-gti-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('servers.name')),
                h('th', null, t('servers.url')),
                h('th', null, t('servers.token')),
                h('th', null, ''))),
              h('tbody', null, servers.map((server) => h('tr', { key: server.id, 'data-gti-server': server.id },
                h('td', null, server.name, server.id === config.defaultServerId ? h('span', { className: 'dsh-gti-chip', 'data-tone': 'brand' }, '★') : null),
                h('td', null, h('span', { className: 'dsh-gti-code' }, server.baseUrl)),
                h('td', null,
                  h('span', { className: 'dsh-gti-note', 'data-tone': server.token.configured ? 'success' : 'warn' },
                    server.token.configured ? t('servers.tokenSet') : t('servers.tokenUnset')),
                  server.token.source?.startsWith('env:')
                    ? h('div', { className: 'dsh-gti-note' }, t('servers.tokenSourceEnv', { name: server.token.source.slice(4) }))
                    : null,
                  probe[server.id] === undefined
                    ? null
                    : h('div', { className: 'dsh-gti-note', 'data-tone': probe[server.id].tone }, probe[server.id].text)),
                h('td', null,
                  h('button', {
                    type: 'button',
                    className: 'dsh-gti-button',
                    disabled: busy !== null,
                    'data-gti-probe': server.id,
                    onClick: () => void probeServer(server),
                  }, busy === `probe-${server.id}` ? t('servers.testing') : t('servers.test')),
                  ' ',
                  h('button', {
                    type: 'button',
                    className: 'dsh-gti-button',
                    disabled: busy !== null,
                    onClick: () => setEditing({ id: server.id, name: server.name, baseUrl: server.baseUrl, tokenEnv: server.tokenEnv ?? '', token: '', clearToken: false }),
                  }, t('common.edit')),
                  ' ',
                  h('button', {
                    type: 'button',
                    className: 'dsh-gti-button',
                    'data-danger': 'true',
                    disabled: busy !== null,
                    onClick: () => {
                      if (!window.confirm(t('servers.removeConfirm', { name: server.name }))) return
                      void run('remove', api.serverRemove(server.id, config.revision))
                    },
                  }, t('servers.remove'))))))),

        notice === null ? null : h(Banner, { tone: notice.tone, text: notice.text }),
        config?.credentialsAvailable === false ? h(Banner, { tone: 'warn', text: t('servers.credentialsMissing') }) : null,

        h('div', { className: 'dsh-gti-section' },
          h('div', { className: 'dsh-gti-section-head' }, editing === null ? t('servers.add') : t('common.edit')),
          h('div', { className: 'dsh-gti-server-form' },
            h('div', { className: 'dsh-gti-field' },
              h('label', { className: 'dsh-gti-field-label' }, t('servers.name')),
              h('input', {
                className: 'dsh-gti-input',
                value: editing === null ? draft.name : editing.name,
                'data-gti-server-name': 'true',
                onChange: (event) => (editing === null ? setDraft({ ...draft, name: event.target.value }) : setEditing({ ...editing, name: event.target.value })),
              })),
            h('div', { className: 'dsh-gti-field' },
              h('label', { className: 'dsh-gti-field-label' }, t('servers.url')),
              h('input', {
                className: 'dsh-gti-input',
                placeholder: 'https://tea.example.com',
                value: editing === null ? draft.baseUrl : editing.baseUrl,
                'data-gti-server-url': 'true',
                onChange: (event) => (editing === null ? setDraft({ ...draft, baseUrl: event.target.value }) : setEditing({ ...editing, baseUrl: event.target.value })),
              })),
            h('div', { className: 'dsh-gti-field' },
              h('label', { className: 'dsh-gti-field-label' }, t('servers.tokenEnv')),
              h('input', {
                className: 'dsh-gti-input',
                placeholder: 'GITEA_TOKEN',
                value: editing === null ? draft.tokenEnv : editing.tokenEnv,
                onChange: (event) => (editing === null ? setDraft({ ...draft, tokenEnv: event.target.value }) : setEditing({ ...editing, tokenEnv: event.target.value })),
              })),
            h('div', { className: 'dsh-gti-field' },
              h('label', { className: 'dsh-gti-field-label' }, t('servers.token')),
              h('input', {
                className: 'dsh-gti-input',
                type: 'password',
                placeholder: editing === null ? '' : t('servers.tokenKeep'),
                value: editing === null ? draft.token : editing.token,
                'data-gti-server-token': 'true',
                onChange: (event) => (editing === null ? setDraft({ ...draft, token: event.target.value }) : setEditing({ ...editing, token: event.target.value, clearToken: false })),
              }))),
          h('div', { className: 'dsh-gti-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-gti-button',
              'data-primary': 'true',
              disabled: busy !== null || (editing === null
                ? (draft.name.trim() === '' || draft.baseUrl.trim() === '')
                : (editing.name.trim() === '' || editing.baseUrl.trim() === '')),
              'data-gti-server-submit': 'true',
              onClick: () => void (editing === null ? submitAdd() : submitEdit()),
            }, editing === null ? t('servers.add') : t('common.save')),
            editing === null ? null : h('button', {
              type: 'button',
              className: 'dsh-gti-button',
              onClick: () => setEditing(null),
            }, t('common.cancel')),
            editing === null ? null : h('label', { className: 'dsh-gti-choice', 'data-on': editing.clearToken ? 'true' : 'false' },
              h('input', {
                type: 'checkbox',
                checked: editing.clearToken === true,
                onChange: (event) => setEditing({ ...editing, clearToken: event.target.checked, token: '' }),
              }),
              t('servers.tokenClear')))),
        config === null ? null : h('p', { className: 'dsh-gti-note dsh-gti-code' }, t('servers.storage', { path: config.storage })))
    }

    // ── 工作区绑定 ──────────────────────────────────────────────────────────

    /**
     * 工作区 ↔ 仓库绑定的**展示与编辑**。
     *
     * 它自己不读数据：绑定状态由外面的看板持有（列表页也要用它决定查哪个仓库），
     * 这里只在 `binding` 变了以后同步草稿。保存 / 解除之后回调 `reload()` 让看板重读。
     *
     * @param props - `api` / `t` / `sessionId` / `config` / `binding` / `error` / `reload` / `onChanged`。
     */
    function BindingPanel({ api, t, sessionId, config, binding, error, reload, onChanged, onOpenAuto }) {
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        if (binding === null) return
        const effective = binding.effective
        setDraft({
          serverId: effective?.serverId ?? config?.servers?.[0]?.id ?? '',
          owner: effective?.owner ?? '',
          repo: effective?.repo ?? '',
        })
      }, [binding, config])

      if (error !== null && error !== undefined) return h('div', { className: 'dsh-gti-scroll' }, h(Banner, { tone: 'error', text: error }))
      if (binding === null || draft === null) return h('div', { className: 'dsh-gti-scroll' }, h(Loading, { t }))

      const save = async () => {
        setBusy(true)
        setNotice(null)
        const result = await api.bind({
          sessionId,
          serverId: draft.serverId,
          owner: draft.owner.trim(),
          repo: draft.repo.trim(),
          expectedRevision: config?.revision,
        })
        setBusy(false)
        if (!result.ok) {
          setNotice({ tone: 'error', text: failureText(t, result) })
          return
        }
        await reload()
        onChanged?.()
      }

      const clear = async () => {
        setBusy(true)
        const result = await api.unbind({ sessionId, expectedRevision: config?.revision })
        setBusy(false)
        if (!result.ok) {
          setNotice({ tone: 'error', text: failureText(t, result) })
          return
        }
        await reload()
        onChanged?.()
      }

      const detected = binding.detected
      const detectedText = detected === null
        ? t('binding.noRemote')
        : (binding.matchedServerId === null
          ? t('binding.detectedUnmatched', { owner: detected.owner, repo: detected.repo, host: detected.host })
          : t('binding.detected', { owner: detected.owner, repo: detected.repo, host: detected.host }))

      return h('div', { className: 'dsh-gti-scroll', 'data-gti-binding': 'true' },
        h('div', { className: 'dsh-gti-section-head' }, t('binding.title')),
        h('p', { className: 'dsh-gti-note dsh-gti-code' }, binding.root),
        h('p', { className: 'dsh-gti-note', 'data-tone': binding.matchedServerId === null ? 'warn' : undefined }, detectedText),
        binding.binding === null
          ? h('p', { className: 'dsh-gti-note' }, t('binding.none'))
          : h('p', { className: 'dsh-gti-note' }, t('binding.effective', {
            owner: binding.effective.owner,
            repo: binding.effective.repo,
            source: binding.effective.source === 'binding' ? t('binding.manual') : t('binding.auto'),
          })),
        notice === null ? null : h(Banner, { tone: notice.tone, text: notice.text }),
        h('div', { className: 'dsh-gti-form', style: { padding: '12px 0 0' } },
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('binding.server')),
            h('select', {
              className: 'dsh-gti-select',
              value: draft.serverId,
              'data-gti-binding-server': 'true',
              onChange: (event) => setDraft({ ...draft, serverId: event.target.value }),
            }, (config?.servers ?? []).map((server) => h('option', { key: server.id, value: server.id }, `${server.name}（${server.baseUrl}）`)))),
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('binding.repo')),
            h('input', {
              className: 'dsh-gti-input',
              placeholder: 'owner/name',
              value: draft.owner === '' ? '' : `${draft.owner}/${draft.repo}`,
              'data-gti-binding-repo': 'true',
              onChange: (event) => {
                const text = event.target.value.trim().replace(/^\/+/, '')
                const cut = text.indexOf('/')
                if (cut === -1) setDraft({ ...draft, owner: text, repo: '' })
                else setDraft({ ...draft, owner: text.slice(0, cut), repo: text.slice(cut + 1) })
              },
            })),
          h('div', { className: 'dsh-gti-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-gti-button',
              'data-primary': 'true',
              disabled: busy || draft.serverId === '' || draft.owner === '' || draft.repo === '',
              'data-gti-binding-save': 'true',
              onClick: () => void save(),
            }, t('binding.save')),
            h('button', {
              type: 'button',
              className: 'dsh-gti-button',
              disabled: busy || binding.binding === null,
              onClick: () => void clear(),
            }, t('binding.clear')),
            h('button', {
              type: 'button',
              className: 'dsh-gti-button',
              'data-gti-watch-open': 'true',
              onClick: () => onOpenAuto?.(),
            }, t('auto.open')))))
    }


    /**
     * 「自动分配任务」设置面板。
     *
     * 两层配置：**全局**（总闸 / 间隔 / 每小时配额 / 演练）与**本工作区**（三类触发 / 冷却 /
     * 每日上限 / 预设）。为什么分两层：间隔与配额是「这台宿主一共开几个会话」的事，跨工作区
     * 算才有意义；触发与冷却则是「这个仓库的活怎么派」的事。
     *
     * 面板刻意把**基线时刻**与**待投递**都显示出来：前者解释「为什么历史 issue 没被投递」，
     * 后者解释「为什么它还没动」——这两处是最容易让人以为功能坏了的地方。
     *
     * @param props - `api` / `t` / `sessionId` / `binding` / `onChanged`。
     */
    /** 内置预设 id → 文案键。宿主不发布内置预设的 name（自定义预设才有），界面自己查。 */
    const BUILT_IN_PRESET_KEYS = {
      standard: 'preset.standard',
      ptc: 'preset.ptc',
      minimal: 'preset.minimal',
      cordis: 'preset.cordis',
    }

    /**
     * 预设的显示名：宿主给了 name 就用它（自定义预设是用户写的，不该被翻译）；没给就按 id 查
     * 内置文案；都不认识就退回 id —— 绝不渲染 `undefined`。
     * @param preset - 名册里的一行 `{ id, name }`。
     * @param t - 文案函数。
     * @returns 显示名。
     */
    function presetName(preset, t) {
      if (typeof preset?.name === 'string' && preset.name !== '') return preset.name
      const key = BUILT_IN_PRESET_KEYS[preset?.id]
      return key === undefined ? String(preset?.id ?? '') : t(key)
    }

    function AutoAssignPanel({ api, t, sessionId, binding, onChanged }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      /**
       * Agent 预设名册（「模式」下拉的选项）。宿主没挂名册服务时保持 null，界面退回手填 id ——
       * 这是可选服务，不能因为它缺席把整块自动分配面板拖垮（同「依赖是软的」那条约束）。
       */
      const [roster, setRoster] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        void api.presets().then((result) => {
          if (alive && result.ok) setRoster(result.data ?? null)
        })
        return () => { alive = false }
      }, [api])

      const load = React.useCallback(async () => {
        const result = await api.autoGet()
        if (!result.ok) {
          setError(failureText(t, result))
          return
        }
        setError(null)
        setState(result.data)
      }, [api, t])

      React.useEffect(() => { void load() }, [load])

      // 账本里的 per-root 配置：没配过就是 null，用宿主默认值填一份草稿。
      // 账本缺 `roots` 也要能渲染（桥的字段集可能比界面新/旧），按「没配过」处理。
      const root = binding?.root ?? null
      const roots = state?.roots ?? {}
      const saved = state !== null && root !== null ? (roots[root] ?? null) : null

      React.useEffect(() => {
        if (state === null || root === null) return
        const config = saved
        setDraft({
          enabled: config?.enabled ?? true,
          newAssigned: config?.triggers?.newAssigned ?? true,
          reopened: config?.triggers?.reopened ?? true,
          newComment: config?.triggers?.newComment ?? true,
          cooldownSeconds: config?.cooldownSeconds ?? 600,
          maxPerIssuePerDay: config?.maxPerIssuePerDay ?? 3,
          giveUpAfterHours: config?.giveUpAfterHours ?? 24,
          agentPreset: config?.agentPreset ?? '',
        })
      }, [state, root, binding?.effective?.repo])

      if (error !== null) return h('div', { className: 'dsh-gti-scroll' }, h(Banner, { tone: 'error', text: error }))
      if (state === null || draft === null) return h('div', { className: 'dsh-gti-scroll' }, h(Loading, { t }))

      const effective = binding?.effective ?? null
      if (effective === null) return h('div', { className: 'dsh-gti-scroll' }, h(Banner, { tone: 'warn', text: t('auto.needBinding') }))

      // 空名册等价于「没有名册」：只剩「跟随宿主默认」一项的下来框没法选自定义 id，不如给手填。
      const rosterPresets = roster?.available === true && Array.isArray(roster.presets) && roster.presets.length > 0
        ? roster.presets
        : null
      const defaultPreset = rosterPresets === null ? null : (rosterPresets.find((preset) => preset.isDefault === true) ?? null)
      const knownPresetIds = new Set((rosterPresets ?? []).map((preset) => preset.id))
      // 账本里存的预设可能已经被删 / 改名：留一个选项显示它，别让下拉悄悄改成「默认」再被保存回去。
      const missingPreset = rosterPresets !== null && draft.agentPreset !== '' && !knownPresetIds.has(draft.agentPreset)
        ? draft.agentPreset
        : null

      const status = state.status
      const pending = state.pending ?? []
      const deliveries = [...(state.deliveries ?? [])].reverse()

      const patchGlobal = async (patch) => {
        setBusy(true)
        setNotice(null)
        const result = await api.autoSet({ global: patch, expectedRevision: state.revision })
        setBusy(false)
        if (!result.ok) {
          setNotice({ tone: 'error', text: failureText(t, result) })
          return
        }
        await load()
        onChanged?.()
      }

      const saveRoot = async () => {
        setBusy(true)
        setNotice(null)
        const result = await api.autoSet({
          sessionId,
          root,
          rootConfig: {
            enabled: draft.enabled,
            triggers: {
              newAssigned: draft.newAssigned,
              reopened: draft.reopened,
              newComment: draft.newComment,
            },
            cooldownSeconds: Number(draft.cooldownSeconds),
            maxPerIssuePerDay: Number(draft.maxPerIssuePerDay),
            giveUpAfterHours: Number(draft.giveUpAfterHours),
            agentPreset: draft.agentPreset.trim() === '' ? null : draft.agentPreset.trim(),
          },
          expectedRevision: state.revision,
        })
        setBusy(false)
        if (!result.ok) {
          setNotice({ tone: 'error', text: failureText(t, result) })
          return
        }
        setNotice({ tone: 'ok', text: t('auto.saved') })
        await load()
        onChanged?.()
      }

      const tick = async () => {
        setBusy(true)
        setNotice(null)
        const result = await api.autoTick()
        setBusy(false)
        if (!result.ok) {
          setNotice({ tone: 'error', text: failureText(t, result) })
          return
        }
        const delivered = result.data?.summary?.delivered ?? 0
        setNotice({ tone: 'ok', text: t('auto.tickDone', { n: delivered }) })
        await load()
      }

      const replay = async (index) => {
        setBusy(true)
        const result = await api.autoRequeue({ sessionId, root, index, expectedRevision: state.revision })
        setBusy(false)
        if (!result.ok) {
          setNotice({ tone: 'error', text: failureText(t, result) })
          return
        }
        setNotice({ tone: 'ok', text: t('auto.saved') })
        await load()
      }

      const number = (value, fallback) => {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : fallback
      }

      return h('div', { className: 'dsh-gti-scroll', 'data-gti-watch': 'true' },
        // ── 全局 ──
        h('div', { className: 'dsh-gti-section-head' }, t('auto.master')),
        status.serviceAvailable === false
          ? h(Banner, { tone: 'warn', text: t('auto.state.unavailable') })
          : null,
        notice === null ? null : h(Banner, { tone: notice.tone, text: notice.text }),
        h('div', { className: 'dsh-gti-form', style: { padding: '12px 0 0' } },
          h('label', { className: 'dsh-gti-check' },
            h('input', {
              type: 'checkbox',
              checked: state.global.enabled === true,
              'data-gti-watch-master': 'true',
              disabled: busy,
              onChange: (event) => void patchGlobal({ enabled: event.target.checked }),
            }),
            h('span', null, t('auto.enable'))),
          h('p', { className: 'dsh-gti-note' }, t('auto.enableHint')),
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('auto.interval')),
            h('input', {
              className: 'dsh-gti-input',
              type: 'number',
              min: 60,
              value: state.global.intervalSeconds,
              'data-gti-watch-interval': 'true',
              disabled: busy,
              onChange: (event) => void patchGlobal({ intervalSeconds: number(event.target.value, 120) }),
            })),
          h('p', { className: 'dsh-gti-note', 'data-gti-watch-interval-hint': 'true' }, t('auto.intervalHint')),
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('auto.quota')),
            h('input', {
              className: 'dsh-gti-input',
              type: 'number',
              min: 1,
              value: state.global.maxSessionsPerHour,
              'data-gti-watch-quota': 'true',
              disabled: busy,
              onChange: (event) => void patchGlobal({ maxSessionsPerHour: number(event.target.value, 6) }),
            })),
          h('label', { className: 'dsh-gti-check' },
            h('input', {
              type: 'checkbox',
              checked: state.global.dryRun === true,
              'data-gti-watch-dryrun': 'true',
              disabled: busy,
              onChange: (event) => void patchGlobal({ dryRun: event.target.checked }),
            }),
            h('span', null, t('auto.dryRun')))),

        // ── 本工作区 ──
        h('div', { className: 'dsh-gti-section-head' }, t('auto.title')),
        h('p', { className: 'dsh-gti-note dsh-gti-code' }, `${effective.owner}/${effective.repo}`),
        h('div', { className: 'dsh-gti-form', style: { padding: '0' } },
          h('label', { className: 'dsh-gti-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.enabled,
              'data-gti-watch-enabled': 'true',
              onChange: (event) => setDraft({ ...draft, enabled: event.target.checked }),
            }),
            h('span', null, t('auto.enable'))),
          h('label', { className: 'dsh-gti-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.newAssigned,
              'data-gti-watch-trigger-newassigned': 'true',
              onChange: (event) => setDraft({ ...draft, newAssigned: event.target.checked }),
            }),
            h('span', null, t('auto.trigger.newAssigned'))),
          h('label', { className: 'dsh-gti-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.reopened,
              'data-gti-watch-trigger-reopened': 'true',
              onChange: (event) => setDraft({ ...draft, reopened: event.target.checked }),
            }),
            h('span', null, t('auto.trigger.reopened'))),
          h('label', { className: 'dsh-gti-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.newComment,
              'data-gti-watch-trigger-newcomment': 'true',
              onChange: (event) => setDraft({ ...draft, newComment: event.target.checked }),
            }),
            h('span', null, t('auto.trigger.newComment'))),
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('auto.cooldown')),
            h('input', {
              className: 'dsh-gti-input',
              type: 'number',
              min: 0,
              value: draft.cooldownSeconds,
              'data-gti-watch-cooldown': 'true',
              onChange: (event) => setDraft({ ...draft, cooldownSeconds: number(event.target.value, 600) }),
            })),
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('auto.daily')),
            h('input', {
              className: 'dsh-gti-input',
              type: 'number',
              min: 1,
              value: draft.maxPerIssuePerDay,
              'data-gti-watch-daily': 'true',
              onChange: (event) => setDraft({ ...draft, maxPerIssuePerDay: number(event.target.value, 3) }),
            })),
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('auto.giveUp')),
            h('input', {
              className: 'dsh-gti-input',
              type: 'number',
              min: 1,
              value: draft.giveUpAfterHours,
              'data-gti-watch-giveup': 'true',
              onChange: (event) => setDraft({ ...draft, giveUpAfterHours: number(event.target.value, 24) }),
            })),
          h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('auto.preset')),
            // 有名册就选（这正是用户要的「能选模式」）；没有就退回手填 id，不留一个空下拉。
            rosterPresets === null
              ? h('input', {
                className: 'dsh-gti-input',
                placeholder: 'default',
                value: draft.agentPreset,
                'data-gti-watch-preset': 'manual',
                onChange: (event) => setDraft({ ...draft, agentPreset: event.target.value }),
              })
              : h('select', {
                className: 'dsh-gti-select',
                value: draft.agentPreset,
                'data-gti-watch-preset': 'roster',
                onChange: (event) => setDraft({ ...draft, agentPreset: event.target.value }),
              }, [h('option', { key: '', value: '' },
                defaultPreset === null
                  ? t('auto.presetFollowUnnamed')
                  : t('auto.presetFollow', { name: presetName(defaultPreset, t) }))]
                .concat(rosterPresets.map((preset) => h('option', {
                  key: preset.id,
                  value: preset.id,
                  disabled: preset.broken !== null && preset.broken !== undefined,
                }, preset.broken === null || preset.broken === undefined
                  ? presetName(preset, t)
                  : t('auto.presetBroken', { name: presetName(preset, t) }))))
                .concat(missingPreset === null
                  ? []
                  : [h('option', { key: missingPreset, value: missingPreset }, t('auto.presetMissing', { id: missingPreset }))])),
            h('p', { className: 'dsh-gti-note', 'data-gti-preset-hint': 'true' },
              rosterPresets === null ? t('auto.presetNoRoster') : t('auto.presetHint'))),
          h('div', { className: 'dsh-gti-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-gti-button',
              'data-primary': 'true',
              disabled: busy,
              'data-gti-watch-save': 'true',
              onClick: () => void saveRoot(),
            }, t('auto.save')),
            h('button', {
              type: 'button',
              className: 'dsh-gti-button',
              disabled: busy,
              'data-gti-watch-tick': 'true',
              onClick: () => void tick(),
            }, busy ? t('auto.ticking') : t('auto.tick')))),

        // ── 状态 ──
        h('div', { className: 'dsh-gti-section-head' }, t('auto.state')),
        h('ul', { className: 'dsh-gti-note', 'data-gti-watch-status': 'true' },
          state.global.enabled ? h('li', null, t('auto.state.enabled')) : h('li', null, t('auto.state.disabled')),
          h('li', null, `${t('auto.state.repo')}: ${effective.owner}/${effective.repo}`),
          state.global.baselinedAt === null
            ? null
            : h('li', null, `${t('auto.state.baseline')}: ${state.global.baselinedAt}`),
          h('li', null, `${t('auto.state.watermark')}: ${status.lastTickAt ?? '—'}`),
          // 下次检查给「绝对时刻 + 倒计时」：绝对时刻用来对表，倒计时用来看出轮询还活着。
          h('li', null, `${t('auto.state.next')}: ${status.nextTickAt === null || status.nextTickAt === undefined ? '—' : shortTime(status.nextTickAt)}`,
            status.nextTickAt === null || status.nextTickAt === undefined
              ? null
              : h(AutoCountdown, { at: status.nextTickAt, t, onDue: () => void load() })),
          saved === null
            ? null
            : h('li', null, `${t('auto.state.repo')}: ${saved.owner}/${saved.repo}`),
          status.serviceAvailable === false ? h('li', { 'data-tone': 'warn' }, t('auto.state.unavailable')) : null,
          status.locked === false ? h('li', { 'data-tone': 'warn' }, t('auto.state.locked')) : null,
          // 退避中要说出来：否则「下次检查」比设置的间隔长很多，看起来像配置没生效。
          status.consecutiveFailures > 0
            ? h('li', { 'data-tone': 'warn', 'data-gti-watch-backoff': 'true' }, t('auto.state.backoff', { n: status.consecutiveFailures }))
            : null,
          status.lastError === null
            ? null
            : h('li', { 'data-tone': 'error' }, t('auto.error', { code: status.lastError.code, message: status.lastError.message }))),

        // ── 待投递 ──
        h('div', { className: 'dsh-gti-section-head' }, t('auto.pending')),
        pending.length === 0
          ? h('p', { className: 'dsh-gti-note', 'data-gti-watch-pending-empty': 'true' }, t('auto.pending.empty'))
          : h('ul', { className: 'dsh-gti-note', 'data-gti-watch-pending': 'true' },
            pending.map((item) => h('li', { key: item.key },
              `#${item.key.slice(item.key.lastIndexOf('#') + 1)} ${item.title ?? ''} — `,
              item.kinds.map((kind) => t(`auto.kind.${kind}`)).join(' / '),
              item.since === null ? '' : `（${t('auto.pending.since', { at: item.since })}）`))),

        // ── 最近投递 ──
        h('div', { className: 'dsh-gti-section-head' }, t('auto.deliveries')),
        deliveries.length === 0
          ? h('p', { className: 'dsh-gti-note', 'data-gti-watch-deliveries-empty': 'true' }, t('auto.deliveries.empty'))
          : h('ul', { className: 'dsh-gti-note', 'data-gti-watch-deliveries': 'true' },
            deliveries.map((row, position) => h('li', { key: `${row.at}-${position}` },
              `${row.at} · #${row.index ?? '?'} ${row.title ?? ''} — `,
              t(`auto.outcome.${String(row.outcome).replace(/-/g, '-')}`) || row.outcome,
              row.reason === undefined ? '' : ` (${row.reason})`,
              row.outcome === 'failed' || row.outcome === 'busy-skipped'
                ? h('button', {
                  type: 'button',
                  className: 'dsh-gti-button',
                  title: t('auto.replayHint'),
                  disabled: busy,
                  'data-gti-watch-replay': String(row.index ?? ''),
                  onClick: () => void replay(Number(row.index)),
                }, t('auto.replay'))
                : null))))
    }

    // ── 新建 / 编辑 issue 的整屏视图（全局看板与工作区看板共用） ──────────────

    /**
     * 新建 / 编辑 issue 的整屏视图：读仓库元信息 → 表单 → 提交。
     *
     * 编辑不是一次请求：Gitea 的 `EditIssueOption` **没有 labels 字段**，标签必须走
     * `/labels` 的 PUT（整体替换）；指派也要按增删两个端点做差分。这里一次做齐，
     * 界面上是「保存」一次。
     *
     * @param props - `api` / `t` / `mode`（create|edit）/ `target` / `issue` / `onDone` / `onCancel`。
     */
    function IssueEditorView({ api, t, mode, target, issue, onDone, onCancel }) {
      const meta = useRepoMeta(api, target)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const submit = async (values) => {
        setBusy(true)
        setError(null)
        const base = { serverId: target.serverId, owner: target.owner, repo: target.repo }
        if (mode === 'create') {
          const result = await api.gitea('issue.create', { ...base, ...values })
          setBusy(false)
          if (!result.ok) {
            setError(failureText(t, result))
            return
          }
          onDone(result.data)
          return
        }
        const index = issue.index
        const patch = { ...base, index, title: values.title, body: values.body }
        if (values.due_date === undefined) patch.unset_due_date = true
        else patch.due_date = values.due_date
        if (values.milestone !== undefined) patch.milestone = values.milestone
        const edited = await api.gitea('issue.edit', patch)
        if (!edited.ok) {
          setBusy(false)
          setError(failureText(t, edited))
          return
        }
        const labelled = await api.gitea('issue.labels.set', { ...base, index, labels: values.labels })
        if (!labelled.ok) {
          setBusy(false)
          setError(failureText(t, labelled))
          return
        }
        const before = new Set((issue.assignees ?? []).map((user) => user.login))
        const after = new Set(values.assignees ?? [])
        const added = [...after].filter((login) => !before.has(login))
        const removed = [...before].filter((login) => !after.has(login))
        if (added.length > 0) await api.gitea('issue.assignees.add', { ...base, index, assignees: added })
        if (removed.length > 0) await api.gitea('issue.assignees.remove', { ...base, index, assignees: removed })
        setBusy(false)
        onDone(edited.data)
      }

      return h('div', { className: 'dsh-gti-scroll', 'data-gti-editor': mode },
        h('div', { className: 'dsh-gti-section-head' }, mode === 'create' ? t('form.createTitle') : t('form.editTitle')),
        error === null ? null : h(Banner, { tone: 'error', text: error }),
        meta === null
          ? h(Loading, { t })
          : h(IssueForm, {
            mode,
            meta,
            busy,
            t,
            initial: mode === 'create'
              ? { title: '', body: '' }
              : {
                title: issue.title,
                body: issue.body,
                dueDate: issue.dueDate,
                milestoneId: issue.milestone?.id,
                labelIds: (issue.labels ?? []).map((label) => label.id),
                assignees: (issue.assignees ?? []).map((user) => user.login),
              },
            onSubmit: (values) => void submit(values),
            onCancel,
          }))
    }

    /**
     * 新建 issue 前的目标选择。
     *
     * **默认按「已绑定的工作区」选**：全局看板是跨工作区的视图，但一条新 issue 总要落在某个
     * 仓库上；用户真正知道的是「这是哪个工作区的活」，绑定里已经写死了它的仓库 —— 让用户再从
     * 几百个仓库里手挑一个，既慢又容易挑错（issue #6）。所以第一档是工作区下拉（只列**已绑定
     * 仓库**的工作区，选中即得到 `{serverId, owner, repo}`），第二档「手动指定仓库」保留原来的
     * owner/name 输入 + 「我拥有的仓库」候选，用于临时往一个没绑过的工作区仓库里提 issue。
     *
     * @param props - `api` / `t` / `config` / `value` / `onChange`。
     *   `value` 是 `{ serverId, owner, repo }`，与 `IssueEditorView` 的 target 同形。
     */
    function TargetPicker({ api, t, config, value, onChange }) {
      const [repos, setRepos] = React.useState([])
      /**
       * 用户显式点过的模式（`null` = 还没点过）。没点过时按「有没有已绑定的工作区」自动选：
       * 有绑定就走工作区那一档，一个绑定都没有就直接落在手填那一档 —— 否则用户会看到一个
       * 「先在工作区看板里绑一个」的死胡同，而表单永远不出现。
       */
      const [pickedMode, setPickedMode] = React.useState(null)
      const serverId = value.serverId
      const bindingList = bindingOptions(config)
      const mode = pickedMode ?? (bindingList.length === 0 ? 'manual' : 'workspace')

      React.useEffect(() => {
        let alive = true
        if (mode !== 'manual' || serverId === '') {
          setRepos([])
          return () => { alive = false }
        }
        void api.repos(serverId).then((result) => {
          if (alive && result.ok) setRepos(result.data ?? [])
        })
        return () => { alive = false }
      }, [api, serverId, mode])

      const picked = bindingList.find((item) => item.serverId === value.serverId &&
        item.owner === value.owner && item.repo === value.repo)

      /**
       * 切档。
       *
       * 切到**工作区档**时要把「手填的仓库」清掉：那个仓库多半不在绑定里，留着它会让下拉显示
       * 「选择工作区…」而下面的表单已经拿 `acme/widgets` 准备提交 —— 界面与真正的目标对不上，
       * 是比「多点一下」严重得多的错。此时若只剩一个绑定就直接换成它（用户意图明确）。
       *
       * 切到**手动档**时保留当前目标（大多就是某个绑定），用户可以在它基础上改。
       *
       * @param next - `workspace` / `manual`。
       * @returns 无。
       */
      const switchMode = (next) => {
        setPickedMode(next)
        if (next !== 'workspace') return
        if (picked !== undefined) return
        if (bindingList.length === 1) {
          onChange({ serverId: bindingList[0].serverId, owner: bindingList[0].owner, repo: bindingList[0].repo })
          return
        }
        if (value.owner !== '' || value.repo !== '') onChange({ serverId: value.serverId, owner: '', repo: '' })
      }

      return h('div', { className: 'dsh-gti-form', style: { padding: '0' } },
        h('div', { className: 'dsh-gti-seg', role: 'group', 'aria-label': t('form.targetMode'), 'data-gti-target-mode-switch': 'true' },
          ['workspace', 'manual'].map((item) => h('button', {
            key: item,
            type: 'button',
            className: 'dsh-gti-seg-button',
            'data-gti-target-mode': item,
            'data-active': mode === item ? 'true' : 'false',
            onClick: () => switchMode(item),
          }, item === 'workspace' ? t('form.targetWorkspace') : t('form.targetManual')))),
        mode === 'workspace'
          ? h('div', { className: 'dsh-gti-field' },
            h('label', { className: 'dsh-gti-field-label' }, t('form.targetWorkspaceLabel')),
            bindingList.length === 0
              ? h('p', { className: 'dsh-gti-note', 'data-gti-target-empty': 'true' }, t('form.targetNone'))
              : [
                h('select', {
                  key: 'picker',
                  className: 'dsh-gti-select',
                  value: picked === undefined ? '' : bindingKey(picked),
                  'data-gti-target-workspace': 'true',
                  onChange: (event) => {
                    const next = bindingList.find((item) => bindingKey(item) === event.target.value)
                    if (next === undefined) return
                    // 换工作区 = 换整个目标（服务器也一起换），别把上一个的仓库名残留在输入框里。
                    onChange({ serverId: next.serverId, owner: next.owner, repo: next.repo })
                  },
                }, [h('option', { key: '', value: '' }, t('form.targetPick'))]
                  .concat(bindingList.map((item) => h('option', { key: bindingKey(item), value: bindingKey(item) },
                    `${item.owner}/${item.repo} \u2014 ${item.root}`)))),
                picked === undefined
                  ? null
                  : h('p', { key: 'resolved', className: 'dsh-gti-note', 'data-gti-target-resolved': 'true' },
                    t('form.targetResolved', {
                      repo: `${picked.owner}/${picked.repo}`,
                      server: serverName(config, picked.serverId),
                      root: picked.root,
                    })),
              ])
          : [
            h('div', { key: 'manual', className: 'dsh-gti-field-row' },
              h('div', { className: 'dsh-gti-field' },
                h('label', { className: 'dsh-gti-field-label' }, t('filter.server')),
                h('select', {
                  className: 'dsh-gti-select',
                  value: serverId,
                  'data-gti-target-server': 'true',
                  onChange: (event) => onChange({ ...value, serverId: event.target.value }),
                }, (config?.servers ?? []).map((server) => h('option', { key: server.id, value: server.id }, server.name)))),
              h('div', { className: 'dsh-gti-field' },
                h('label', { className: 'dsh-gti-field-label' }, t('binding.repo')),
                h('input', {
                  className: 'dsh-gti-input',
                  placeholder: 'owner/name',
                  list: 'dsh-gti-repo-list',
                  value: value.owner === '' ? '' : `${value.owner}/${value.repo}`,
                  'data-gti-target-repo': 'true',
                  onChange: (event) => {
                    const text = event.target.value.trim().replace(/^\/+/, '')
                    const cut = text.indexOf('/')
                    if (cut === -1) onChange({ ...value, owner: text, repo: '' })
                    else onChange({ ...value, owner: text.slice(0, cut), repo: text.slice(cut + 1) })
                  },
                }))),
            h('datalist', { key: 'list', id: 'dsh-gti-repo-list' },
              repos.map((repo) => h('option', { key: repo.fullName, value: repo.fullName }))),
          ])
    }

    /**
     * 已绑定仓库的工作区清单：`[{ root, serverId, owner, repo }]`，按 root 排序。
     *
     * `config.bindings` 是 `servers.json` 的 `bindings` 原样（键是工作区根）。**自动侦测的
     * 工作区不在里面**（那要逐个读 `.git/config`，得先知道有哪些工作区）—— 那类工作区用
     * 「手动指定仓库」那条路提 issue；把「有绑定的」放第一档已经覆盖绝大多数场景。
     *
     * 指向已删除服务器 / 缺字段的绑定直接跳过：下拉里给一个点了会 404 的选项比没有更糟。
     *
     * @param config - `config.get` 的应答（可能为 null）。
     * @returns 可用的绑定选项。
     */
    function bindingOptions(config) {
      const servers = new Set((config?.servers ?? []).map((server) => server.id))
      return Object.entries(config?.bindings ?? {})
        .filter(([, binding]) => servers.has(binding?.serverId) &&
          typeof binding.owner === 'string' && binding.owner !== '' &&
          typeof binding.repo === 'string' && binding.repo !== '')
        .map(([root, binding]) => ({ root, serverId: binding.serverId, owner: binding.owner, repo: binding.repo }))
        .sort((left, right) => left.root.localeCompare(right.root))
    }

    /**
     * 绑定选项在下拉里的值（root 唯一，同仓库的两个工作区要能分开选）。
     * @param item - `bindingOptions` 的一项。
     * @returns 下拉值。
     */
    function bindingKey(item) {
      return item.root
    }

    /**
     * 全局看板这一屏该查哪些仓库：**所有已绑定的工作区仓库**，去重后按筛选条收窄。
     *
     * 为什么不沿用服务器级跨仓库搜索（`/repos/issues/search`）：那个端点只能按 `owner` 收窄，
     * **收不到单个仓库**，于是「这台 Gitea 上令牌能看见的仓库」全会被拉进来 —— 包括没有任何
     * 工作区绑定过的仓库，看上去像「所有 issues」。范围必须由**绑定**决定：一个绑定就是一条
     * 「这个仓库跟我有关」的声明。改成一个绑定一次仓库级查询，还顺带避开了「每台服务器只取
     * 50 条、被无关仓库挤掉」的问题。
     *
     * 去重按 `服务器 + owner + repo`（不区分大小写）：两个工作区绑同一个仓库是常见情况
     * （主仓 + 拆分出来的子仓目录），查两遍会出现重复行。
     *
     * @param config - `config.get` 的应答（可能为 null）。
     * @param query - 筛选里的 `{ serverId, owner }`（空串表示不收窄）。
     * @returns `[{ serverId, owner, repo, roots }]`，`roots` 是绑到该仓库的工作区根。
     */
    function boardTargets(config, query) {
      const seen = new Set()
      const targets = []
      for (const item of bindingOptions(config)) {
        if (query.serverId !== '' && item.serverId !== query.serverId) continue
        // owner 在 Gitea 里不区分大小写，筛选也跟着不区分（否则输错个大小写就整屏空）。
        if (query.owner !== '' && item.owner.toLowerCase() !== query.owner.trim().toLowerCase()) continue
        const key = `${item.serverId}\n${item.owner.toLowerCase()}\n${item.repo.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({ serverId: item.serverId, owner: item.owner, repo: item.repo, roots: [item.root] })
      }
      return targets
    }

    /**
     * 服务器 id → 显示名（找不到就回 id，别渲染出 `undefined`）。
     * @param config - `config.get` 的应答。
     * @param serverId - 服务器 id。
     * @returns 显示名。
     */
    function serverName(config, serverId) {
      return (config?.servers ?? []).find((server) => server.id === serverId)?.name ?? serverId
    }

    /**
     * 点「新建 issue」时预填的目标。
     *
     * 目标是**已绑定的工作区**，不是一个空仓库（issue #6）：绑定已经把「这个工作区对应哪个
     * 仓库」定死了，用户从工作区过来时心里想的是「在这个工作区的仓库里提一条」。筛选条里的
     * 服务器 / 所属只是**列表的收窄条件**，不该反过来决定新 issue 落在哪 —— 所以只在它能唯一定位
     * 到一个绑定时才用来挑默认值。
     *
     * 预填策略（宁可让用户多点一下，也不猜错仓库）：
     * - 只有一个绑定 → 直接选它；
     * - 多个绑定 → 当前筛选（服务器 + owner）能唯一定位到一个就选它，否则不预选，让用户选；
     * - 一个绑定都没有 → 退回旧行为（当前筛选的服务器 + 空仓库，让用户手填）。
     *
     * @param config - `config.get` 的应答（可能为 null）。
     * @param query - 当前筛选 `{ serverId, owner }`。
     * @returns `{ serverId, owner, repo }`。
     */
    function initialCreateTarget(config, query) {
      const options = bindingOptions(config)
      const narrowed = options.filter((item) =>
        (query.serverId === '' || item.serverId === query.serverId) &&
        (query.owner === '' || item.owner === query.owner))
      const preferred = options.length === 1
        ? options[0]
        : (narrowed.length === 1 ? narrowed[0] : undefined)
      if (preferred !== undefined) {
        return { serverId: preferred.serverId, owner: preferred.owner, repo: preferred.repo }
      }
      return {
        serverId: query.serverId === '' ? (config?.servers?.[0]?.id ?? '') : query.serverId,
        owner: '',
        repo: '',
      }
    }

    /**
     * 输入防抖：关键词每敲一个字就发一次请求太浪费，等 350ms。
     * @param value - 原始值。
     * @param delay - 延迟毫秒。
     * @returns 防抖后的值。
     */
    function useDebounced(value, delay = 350) {
      const [debounced, setDebounced] = React.useState(value)
      React.useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delay)
        return () => clearTimeout(timer)
      }, [value, delay])
      return debounced
    }

    // ── 全局看板 ────────────────────────────────────────────────────────────

    /**
     * 全局看板：**所有已绑定的工作区仓库**的 issues 聚到一屏，外加服务器管理与令牌管理。
     *
     * 范围由绑定决定 —— 「这台 Gitea 上令牌能看见的全部 issue」包括了没绑过工作区的仓库，
     * 那是别人（或只是路过）的仓库，不该出现在「我的看板」里。取数与去重见 `boardTargets`。
     * @param props - `api` / `t`。
     */
    function GlobalBoard({ api, t }) {
      const { config, error: configError, reload: reloadConfig } = useConfig(api, t)
      const [view, setView] = React.useState({ kind: 'list' })
      const [filter, setFilter] = React.useState({ state: 'open', serverId: '', owner: '', q: '' })
      /** 视图模式与泳道分组：默认「泳道 + 按状态」，面板一打开就是分好泳道的全景。 */
      const [mode, setMode] = React.useState('lanes')
      const [group, setGroup] = React.useState('state')
      const [keyword, setKeyword] = React.useState('')
      const [issues, setIssues] = React.useState(null)
      const [failed, setFailed] = React.useState([])
      const [error, setError] = React.useState(null)
      const debouncedKeyword = useDebounced(keyword)

      /**
       * 按状态分泳道时状态筛选被接管：泳道**就是**状态维度，再叠一层状态筛选只会剩下一条泳道，
       * 默认视图也就不成其为泳道了。所以取数固定 `all`、控件置灰（见 README）。
       */
      const stateLocked = mode === 'lanes' && group === 'state'
      const query = { ...filter, state: stateLocked ? 'all' : filter.state, q: debouncedKeyword }

      /** 这一屏要查的仓库：只来自已绑定的工作区（`boardTargets` 里有「为什么不跨仓库搜索」）。 */
      const targets = React.useMemo(
        () => boardTargets(config, { serverId: filter.serverId, owner: filter.owner }),
        [config, filter.serverId, filter.owner],
      )
      const hasBindings = React.useMemo(() => bindingOptions(config).length > 0, [config])

      const load = React.useCallback(async () => {
        if (config === null) return
        if (targets.length === 0) {
          setIssues([])
          setFailed([])
          return
        }
        setError(null)
        const results = await Promise.all(targets.map(async (target) => ({
          target,
          result: await api.gitea('issue.list', {
            serverId: target.serverId,
            owner: target.owner,
            repo: target.repo,
            state: query.state,
            q: query.q === '' ? undefined : query.q,
            limit: 50,
          }),
        })))
        const merged = []
        const broken = []
        const seen = new Set()
        for (const { target, result } of results) {
          if (!result.ok) {
            // 横幅点名到「服务器 + owner/repo」：只写服务器的话，多仓库时看不出是哪个失败的。
            broken.push(`${serverName(config, target.serverId)} ${target.owner}/${target.repo}（${failureText(t, result)}）`)
            continue
          }
          for (const issue of result.data ?? []) {
            const owner = String(issue.owner ?? target.owner).toLowerCase()
            const repo = String(issue.repo ?? target.repo).toLowerCase()
            const key = `${issue.serverId ?? target.serverId}\n${owner}\n${repo}\n${issue.index}`
            // 兜底去重：同一条 issue 被两条绑定查回来时只留一行（泳道是视角，不是归属）。
            if (seen.has(key)) continue
            seen.add(key)
            merged.push({ ...issue, serverId: issue.serverId ?? target.serverId })
          }
        }
        merged.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
        setIssues(merged)
        setFailed(broken)
      }, [api, config, targets, query.state, query.q, t])

      React.useEffect(() => { void load() }, [load])

      const selectedKey = view.kind === 'detail' ? issueKey(view.issue) : null

      const listView = h('div', { className: 'dsh-gti-column', style: { flex: '1 1 auto' } },
        h('div', { className: 'dsh-gti-bar' },
          h('span', { className: 'dsh-gti-bar-title' }, t('app.title')),
          h('span', { className: 'dsh-gti-spacer' }),
          h('button', {
            type: 'button',
            className: 'dsh-gti-button',
            'data-primary': 'true',
            disabled: config === null || (config.servers ?? []).length === 0,
            'data-gti-new': 'true',
            onClick: () => setView({ kind: 'create', ...initialCreateTarget(config, query) }),
          }, t('issue.new')),
          h('button', {
            type: 'button',
            className: 'dsh-gti-button',
            'data-gti-servers-toggle': 'true',
            onClick: () => setView({ kind: 'servers' }),
          }, t('servers.title')),
          h('button', {
            type: 'button',
            className: 'dsh-gti-icon-button',
            title: t('common.refresh'),
            // 先重读配置：范围由绑定决定，别处刚绑好的工作区要能靠这个按钮出现在这一屏
            // （配置换了 → `targets` / `load` 跟着换 → 下面的 effect 自动取数）。
            onClick: () => void reloadConfig(),
          }, h(Icon, { name: 'refresh' }))),
        h(FilterBar, {
          value: { ...filter, state: query.state, q: keyword },
          onChange: (next) => {
            // 置灰期间控件不会发变更；真收到了（旧事件 / 测试直接派发）也不认，免得筛选项与数据对不上。
            setFilter({ state: stateLocked ? filter.state : next.state, serverId: next.serverId ?? '', owner: next.owner ?? '', q: filter.q })
            setKeyword(next.q ?? '')
          },
          servers: config?.servers ?? [],
          showServer: true,
          showOwner: true,
          stateLocked,
          t,
        }, h(ViewControls, { mode, group, onMode: setMode, onGroup: setGroup, t })),
        // 范围写明白：这一屏的是「已绑定的工作区仓库」，不是这台 Gitea 上令牌能看见的全部仓库。
        hasBindings
          ? h('div', { className: 'dsh-gti-note dsh-gti-scope', 'data-gti-scope': 'bound' }, t('filter.boundScope', { n: targets.length }))
          : null,
        configError === null ? null : h(Banner, { tone: 'error', text: configError }),
        failed.length > 0 ? h(Banner, { tone: 'warn', text: t('list.partial', { names: failed.join('；') }) }) : null,
        error === null ? null : h(Banner, { tone: 'error', text: error }),
        issues === null
          ? h(Loading, { t })
          : issues.length === 0
            ? h(Empty, {
              title: hasBindings ? t('list.empty') : t('list.noBindings'),
              hint: !hasBindings
                ? t('list.noBindingsHint')
                : (targets.length === 0 ? t('list.emptyTargetsHint') : t('list.emptyHint')),
            })
            : h(IssueList, {
              issues,
              mode,
              group,
              showRepo: true,
              selectedKey,
              onOpen: (picked) => setView({ kind: 'detail', issue: picked }),
              t,
            }))

      if (view.kind === 'servers') {
        return h('div', { className: 'dsh-gti-root', 'data-gti-global': 'true' },
          h('style', null, CSS),
          h('div', { className: 'dsh-gti-bar' },
            h('button', { type: 'button', className: 'dsh-gti-icon-button', title: t('common.back'), onClick: () => setView({ kind: 'list' }) }, h(Icon, { name: 'back' })),
            h('span', { className: 'dsh-gti-bar-title' }, t('servers.title'))),
          h(ServerManager, { api, t, config, reload: reloadConfig }))
      }

      if (view.kind === 'create') {
        const target = { serverId: view.serverId, owner: view.owner, repo: view.repo }
        const ready = target.serverId !== '' && target.owner !== '' && target.repo !== ''
        return h('div', { className: 'dsh-gti-root', 'data-gti-global': 'true' },
          h('style', null, CSS),
          h('div', { className: 'dsh-gti-bar' },
            h('button', { type: 'button', className: 'dsh-gti-icon-button', title: t('common.back'), onClick: () => setView({ kind: 'list' }) }, h(Icon, { name: 'back' })),
            h('span', { className: 'dsh-gti-bar-title' }, t('form.createTitle'))),
          h('div', { className: 'dsh-gti-scroll' },
            h(TargetPicker, { api, t, config, value: target, onChange: (next) => setView({ kind: 'create', ...next }) }),
            ready
              ? h(IssueEditorView, {
                api,
                t,
                mode: 'create',
                target,
                onDone: () => { void reloadConfig(); setView({ kind: 'list' }) },
                onCancel: () => setView({ kind: 'list' }),
              })
              : h('p', { className: 'dsh-gti-note', 'data-gti-create-blocked': 'true' }, t('form.createNeedTarget'))))
      }

      if (view.kind === 'edit') {
        return h('div', { className: 'dsh-gti-root', 'data-gti-global': 'true' },
          h('style', null, CSS),
          h('div', { className: 'dsh-gti-bar' },
            h('button', { type: 'button', className: 'dsh-gti-icon-button', title: t('common.back'), onClick: () => setView({ kind: 'detail', issue: view.issue }) }, h(Icon, { name: 'back' })),
            h('span', { className: 'dsh-gti-bar-title' }, t('form.editTitle'))),
          h(IssueEditorView, {
            api,
            t,
            mode: 'edit',
            issue: view.issue,
            target: { serverId: view.issue.serverId, owner: view.issue.owner, repo: view.issue.repo },
            onDone: (issue) => { void load(); setView({ kind: 'detail', issue }) },
            onCancel: () => setView({ kind: 'detail', issue: view.issue }),
          }))
      }

      if (view.kind === 'detail') {
        const target = { serverId: view.issue.serverId, owner: view.issue.owner, repo: view.issue.repo, index: view.issue.index }
        return h('div', { className: 'dsh-gti-root', 'data-gti-global': 'true' },
          h('style', null, CSS),
          h('div', { className: 'dsh-gti-split' },
            h('div', { className: 'dsh-gti-split-list' }, listView),
            h('div', { className: 'dsh-gti-split-detail' },
              h(IssueDetail, {
                api,
                t,
                target,
                onBack: () => setView({ kind: 'list' }),
                onChanged: () => void load(),
                onEdit: () => setView({ kind: 'edit', issue: view.issue }),
              }))))
      }

      return h('div', { className: 'dsh-gti-root', 'data-gti-global': 'true' },
        h('style', null, CSS),
        listView)
    }

    // ── 工作区看板（右侧栏页签） ────────────────────────────────────────────

    /**
     * 工作区看板标题栏的「自动投递」徽标：只在**真的会被投递**时出现。
     *
     * 判据必须和轮询器（[lib/watch.js](lib/watch.js) 的 `planRoots`）逐条对齐，否则会给出
     * 一个假的承诺 —— 旧版界面里自动分配配置藏在一个二级页里，用户在工作区看板上完全看不出
     * 它开着没开（用户 2026-10-25 反馈）。四道闸缺一不可：
     * 1. 全局总开关 `global.enabled === true`；
     * 2. 这个工作区**在账本里有配置**且 `enabled === true`（没配过 = 不会被轮询，不能按面板
     *    草稿里的默认 `true` 说成开着）；
     * 3. 账本里记的仓库要和当前绑定一致 —— 换过绑定后轮询器会跳过它（`binding-changed`）；
     * 4. 宿主挂了会话服务，否则「开了」也开不出会话。
     * 演练（`dryRun`）单独一档：看起来开着，但实际只记账。
     *
     * 待投递条数按 issue 键前缀（`serverId/owner/repo#`）算 —— `watch.get` 的 pending 不带 root，
     * 而键里已经写死了仓库。
     *
     * 倒计时（`countdownAt`）只在**这个工作区真会被轮到**的两档（开启 / 演练）给：仓库对不上或
     * 宿主无会话服务时，全局下一轮检查跟这个工作区无关，摆一个倒计时只会误导。
     *
     * @param watch - `watch.get` 的应答（可能为 null / 读取失败）。
     * @param root - 当前工作区根（`binding.root`），没有绑定就是 null。
     * @param effective - 当前生效的仓库 `{ serverId, owner, repo }`，没有就是 null。
     * @param t - 文案函数。
     * @returns `{ kind, text, hint, countdownAt }` 或 null（不该显示徽标）。
     */
    function autoDeliveryBadge(watch, root, effective, t) {
      if (watch === null || root === null || effective === null) return null
      if (watch.global?.enabled !== true) return null
      const config = watch.roots?.[root] ?? null
      if (config === null || config.enabled !== true) return null
      const nextTickAt = watch.status?.nextTickAt ?? null
      const failures = Number(watch.status?.consecutiveFailures ?? 0)
      const lastError = watch.status?.lastError ?? null
      const hintFor = (kind) => {
        const parts = [t(`auto.badge.hint.${kind}`)]
        if (nextTickAt !== null) parts.push(t('auto.badge.next', { at: shortTime(nextTickAt) }))
        // 退避中 / 上次失败也写进悬停：倒计时被拉长时，得能一眼看出是「退避」而不是设置没生效。
        if (failures > 0) parts.push(t('auto.state.backoff', { n: failures }))
        if (lastError !== null) parts.push(t('auto.error', { code: lastError.code ?? '?', message: lastError.message ?? '' }))
        return parts.join(' · ')
      }
      const prefix = `${config.serverId}/${config.owner}/${config.repo}#`
      const pending = (watch.pending ?? []).filter((item) => String(item.key ?? '').startsWith(prefix)).length
      const withPending = (text) => (pending === 0 ? text : `${text} · ${t('auto.badge.pending', { n: pending })}`)
      const withBackoff = (text) => (failures === 0 ? text : `${text} · ${t('auto.badge.backoff', { n: failures })}`)
      if (config.serverId !== effective.serverId || config.owner !== effective.owner || config.repo !== effective.repo) {
        return { kind: 'mismatch', text: withBackoff(withPending(t('auto.badge.mismatch'))), hint: hintFor('mismatch'), countdownAt: null }
      }
      if (watch.status?.serviceAvailable === false) {
        return { kind: 'unavailable', text: withBackoff(withPending(t('auto.badge.unavailable'))), hint: hintFor('unavailable'), countdownAt: null }
      }
      if (watch.global?.dryRun === true) {
        return { kind: 'dry', text: withBackoff(withPending(t('auto.badge.dry'))), hint: hintFor('dry'), countdownAt: nextTickAt }
      }
      return { kind: 'on', text: withBackoff(withPending(t('auto.badge.on'))), hint: hintFor('on'), countdownAt: nextTickAt }
    }

    /**
     * 徽标里的「还有多久检查下一轮」倒计时。
     *
     * 单独一个组件：每秒的重渲染必须**只落在几个字符上** —— 塞进看板主体的话，整个 issue 列表
     * （泳道 / 卡片）会跟着每秒重画一遍。到点（`remaining <= 0`）后按 5 秒节流调 `onDue`，让父
     * 组件重读账本、拿新的 `nextTickAt`（不然倒计时会永远停在「即将检查」）。
     *
     * @param props - `at`（ISO 时刻）/ `t` / `onDue`（到点回调，可省略）。
     */
    function AutoCountdown({ at, t, onDue }) {
      const [now, setNow] = React.useState(() => Date.now())
      const [lastNotifyAt, setLastNotifyAt] = React.useState(0)
      React.useEffect(() => {
        setNow(Date.now())
        setLastNotifyAt(0)
        const timer = setInterval(() => setNow(Date.now()), 1000)
        // 浏览器里 setInterval 返回 number；Node（探针）里是 Timeout，unref 掉才不会把测试进程
        // 吊在事件循环上（探针不会卸载组件，不 unref 就会一直有个活定时器）。
        if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, [at])
      const remaining = Date.parse(at) - now
      React.useEffect(() => {
        if (!Number.isFinite(remaining) || remaining > 0) return
        // 到点后每隔 5 秒最多重读一次账本：正常情况下一轮 tick 就在眼前，读回来的 `nextTickAt`
        // 立刻变新、倒计时接着走；万一这一轮被工作区忙 / 别人持锁跳过，也不能让倒计时永远停在
        // 「即将检查」（5 秒既是自愈间隔，也是不把桥当轮询器使的上限）。
        if (now - lastNotifyAt < 5000) return
        setLastNotifyAt(now)
        onDue?.()
      }, [remaining, now, lastNotifyAt, onDue])
      if (!Number.isFinite(remaining)) return null
      return h('span', { 'data-gti-auto-countdown': 'true' }, ' · ',
        remaining <= 0 ? t('auto.badge.due') : t('auto.badge.countdown', { time: formatCountdown(remaining) }))
    }

    /**
     * 工作区看板：当前会话绑定仓库的 issues。
     * @param props - `api` / `t` / `sessionId`，外加可选的 `inputActions`（侧栏渲染点真给了就直接
     *   用它，没给就退回 `conversation.input.dock` 哨兵登记的那份）。
     */
    function WorkspaceBoard({ api, t, sessionId, inputActions }) {
      const { config, error: configError, reload: reloadConfig } = useConfig(api, t)
      const [binding, setBinding] = React.useState(null)
      const [bindingError, setBindingError] = React.useState(null)
      const [view, setView] = React.useState({ kind: 'list' })
      const [filter, setFilter] = React.useState({ state: 'open', q: '' })
      /** 视图模式与泳道分组：默认「泳道 + 按状态」（与全局看板同一套约定）。 */
      const [mode, setMode] = React.useState('lanes')
      const [group, setGroup] = React.useState('state')
      const [keyword, setKeyword] = React.useState('')
      const [issues, setIssues] = React.useState(null)
      const [error, setError] = React.useState(null)
      /** 「发送到 DSH」的结果横幅，列表页与详情页共用（详情页那次由 `sendNotice` 传下去）。 */
      const [send, setSend] = React.useState(null)
      /** 自动分配的账本快照：标题栏徽标要据此判断「这个工作区到底会不会被投递」。 */
      const [auto, setAuto] = React.useState(null)
      const debouncedKeyword = useDebounced(keyword)

      /** 按状态分泳道时状态筛选被接管（取数固定全部、控件置灰）：理由见 GlobalBoard 同名处。 */
      const stateLocked = mode === 'lanes' && group === 'state'
      const stateQuery = stateLocked ? 'all' : filter.state

      /**
       * 把一条 issue 发进当前会话的对话输入框。
       *
       * 写入面优先用槽位 prop（作用域最明确），没有就用 `conversation.input.dock` 哨兵登记的
       * 那份 —— 侧栏渲染点不保证传全标准 prop。三种结局都落到横幅上，不静默失败。
       * @param issue - 线上 issue 对象。
       * @returns 无。
       */
      const sendIssue = (issue) => {
        const actions = inputActions ?? inputTargets.get(sessionId)
        if (actions === undefined || typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') {
          setSend({ tone: 'error', text: t('send.failed.input') })
          return
        }
        // 先捕获再插：插入是「捕获时的选区 + 草稿版本」的 CAS，中间任何编辑都会让它返回 false。
        if (!actions.insertText(issuePrompt(t, issue), actions.captureInsertion())) {
          setSend({ tone: 'error', text: t('send.failed.busy') })
          return
        }
        setSend({ tone: 'success', text: t('send.sent', { index: issue.index }) })
      }

      /**
       * 绑定状态由**看板自己**读：列表页要拿它决定查哪个仓库，而绑定设置页只是其中一个视图
       * —— 让只在设置页挂载的面板负责读，列表页就永远不知道绑了谁（这个坑被探针抓到过）。
       */
      const loadBinding = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setBinding(null)
          setBindingError(t('binding.noSession'))
          return
        }
        const result = await api.binding(sessionId)
        if (result.ok) {
          setBinding(result.data)
          setBindingError(null)
        } else {
          setBindingError(failureText(t, result))
        }
      }, [api, t, sessionId])

      React.useEffect(() => { void loadBinding() }, [loadBinding])

      /**
       * 自动分配账本由**看板自己**读，理由同绑定：列表页标题栏要显示「自动投递开着没开」，
       * 而配置页只是其中一个视图 —— 交给只在配置页挂载的面板读，列表页就永远是瞎的。
       * 读失败只当没有徽标（不打扰列表本身）。
       */
      const loadAuto = React.useCallback(async () => {
        const result = await api.autoGet()
        if (result.ok) setAuto(result.data)
      }, [api])

      React.useEffect(() => { void loadAuto() }, [loadAuto])

      const effective = binding?.effective ?? null
      const target = effective === null ? null : { serverId: effective.serverId, owner: effective.owner, repo: effective.repo }
      const autoBadge = autoDeliveryBadge(auto, binding?.root ?? null, effective, t)

      const load = React.useCallback(async () => {
        if (target === null) {
          setIssues([])
          return
        }
        setError(null)
        const result = await api.gitea('issue.list', {
          sessionId,
          state: stateQuery,
          q: debouncedKeyword === '' ? undefined : debouncedKeyword,
          limit: 50,
        })
        if (result.ok) setIssues(result.data ?? [])
        else setError(failureText(t, result))
      }, [api, t, sessionId, target?.serverId, target?.owner, target?.repo, stateQuery, debouncedKeyword])

      React.useEffect(() => { void load() }, [load])

      const head = h('div', { className: 'dsh-gti-bar' },
        h('span', { className: 'dsh-gti-bar-title' },
          effective === null ? t('app.title') : `${effective.owner}/${effective.repo}`),
        effective === null ? null : h('span', { className: 'dsh-gti-note' },
          effective.source === 'binding' ? t('binding.manual') : t('binding.auto')),
        // 「自动投递开着没开」必须在这一屏就能看见（用户 2026-10-25 反馈）：徽标本身就是入口，
        // 点一下直接进自动分配设置，不用先摸齿轮再找按钮。
        autoBadge === null ? null : h('button', {
          type: 'button',
          className: 'dsh-gti-chip dsh-gti-chip-button',
          'data-gti-auto-badge': autoBadge.kind,
          'data-tone': autoBadge.kind === 'on' ? 'brand' : undefined,
          title: autoBadge.hint,
          onClick: () => setView({ kind: 'auto', from: 'list' }),
        }, autoBadge.text,
        autoBadge.countdownAt === null ? null : h(AutoCountdown, { at: autoBadge.countdownAt, t, onDue: loadAuto })),
        h('span', { className: 'dsh-gti-spacer' }),
        h('button', {
          type: 'button',
          className: 'dsh-gti-button',
          'data-primary': 'true',
          disabled: target === null,
          'data-gti-new': 'true',
          onClick: () => setView({ kind: 'create' }),
        }, t('issue.new')),
        h('button', {
          type: 'button',
          className: 'dsh-gti-icon-button',
          title: t('binding.settings'),
          'data-gti-binding-toggle': 'true',
          onClick: () => setView({ kind: 'binding' }),
        }, h(Icon, { name: 'settings' })),
        h('button', {
          type: 'button',
          className: 'dsh-gti-icon-button',
          title: t('common.refresh'),
          // 徽标依据的账本状态会变（别处跑了一轮、改了开关），刷新要连它一起重读。
          onClick: () => { void load(); void loadAuto() },
        }, h(Icon, { name: 'refresh' })))

      const filterBar = h(FilterBar, {
        value: { ...filter, state: stateQuery, q: keyword },
        onChange: (next) => {
          // 与全局看板同一套：置灰期间不认状态变更，避免筛选项与已取回的数据对不上。
          setFilter({ state: stateLocked ? filter.state : next.state, q: filter.q })
          setKeyword(next.q ?? '')
        },
        stateLocked,
        t,
      }, h(ViewControls, { mode, group, onMode: setMode, onGroup: setGroup, t }))

      const listBody = issues === null
        ? h(Loading, { t })
        : issues.length === 0
          ? h(Empty, { title: t('list.empty'), hint: t('list.emptyHint') })
          : h(IssueList, {
            issues,
            mode,
            group,
            showRepo: false,
            selectedKey: view.kind === 'detail' ? issueKey(view.issue) : null,
            onOpen: (picked) => setView({ kind: 'detail', issue: picked }),
            onSend: sendIssue,
            t,
          })

      if (view.kind === 'binding') {
        return h('div', { className: 'dsh-gti-root', 'data-gti-workspace': 'true' },
          h('style', null, CSS),
          h('div', { className: 'dsh-gti-bar' },
            h('button', { type: 'button', className: 'dsh-gti-icon-button', title: t('common.back'), onClick: () => setView({ kind: 'list' }) }, h(Icon, { name: 'back' })),
            h('span', { className: 'dsh-gti-bar-title' }, t('binding.settings'))),
          h(BindingPanel, {
            api,
            t,
            sessionId,
            config,
            binding,
            error: bindingError,
            reload: loadBinding,
            onChanged: () => { void reloadConfig(); void load() },
            onOpenAuto: () => setView({ kind: 'auto', from: 'binding' }),
          }))
      }

      if (view.kind === 'auto') {
        return h('div', { className: 'dsh-gti-root', 'data-gti-workspace': 'true' },
          h('style', null, CSS),
          h('div', { className: 'dsh-gti-bar' },
            // 返回时重读账本：面板里刚改的开关 / 刚存下的配置要立刻反映到列表页的徽标上。
            // 回哪一页取决于「从哪进来的」：点标题栏徽标进来的应该直接回列表，别多按一次返回。
            h('button', {
              type: 'button',
              className: 'dsh-gti-icon-button',
              title: t('common.back'),
              'data-gti-auto-back': 'true',
              onClick: () => { void loadAuto(); setView({ kind: view.from === 'list' ? 'list' : 'binding' }) },
            }, h(Icon, { name: 'back' })),
            h('span', { className: 'dsh-gti-bar-title' }, t('auto.title'))),
          h(AutoAssignPanel, {
            api,
            t,
            sessionId,
            binding,
            onChanged: () => void loadAuto(),
          }))
      }

      if (view.kind === 'create' && target !== null) {
        return h('div', { className: 'dsh-gti-root', 'data-gti-workspace': 'true' },
          h('style', null, CSS),
          h('div', { className: 'dsh-gti-bar' },
            h('button', { type: 'button', className: 'dsh-gti-icon-button', title: t('common.back'), onClick: () => setView({ kind: 'list' }) }, h(Icon, { name: 'back' })),
            h('span', { className: 'dsh-gti-bar-title' }, t('form.createTitle'))),
          h(IssueEditorView, {
            api,
            t,
            mode: 'create',
            target,
            onDone: () => { setView({ kind: 'list' }); void load() },
            onCancel: () => setView({ kind: 'list' }),
          }))
      }

      if (view.kind === 'edit') {
        return h('div', { className: 'dsh-gti-root', 'data-gti-workspace': 'true' },
          h('style', null, CSS),
          h('div', { className: 'dsh-gti-bar' },
            h('button', { type: 'button', className: 'dsh-gti-icon-button', title: t('common.back'), onClick: () => setView({ kind: 'detail', issue: view.issue }) }, h(Icon, { name: 'back' })),
            h('span', { className: 'dsh-gti-bar-title' }, t('form.editTitle'))),
          h(IssueEditorView, {
            api,
            t,
            mode: 'edit',
            issue: view.issue,
            target,
            onDone: (issue) => { void load(); setView({ kind: 'detail', issue }) },
            onCancel: () => setView({ kind: 'detail', issue: view.issue }),
          }))
      }

      if (view.kind === 'detail') {
        return h('div', { className: 'dsh-gti-root', 'data-gti-workspace': 'true' },
          h('style', null, CSS),
          h(IssueDetail, {
            api,
            t,
            target: { serverId: view.issue.serverId ?? target?.serverId, owner: view.issue.owner, repo: view.issue.repo, index: view.issue.index, sessionId },
            onBack: () => setView({ kind: 'list' }),
            onChanged: () => void load(),
            onEdit: () => setView({ kind: 'edit', issue: view.issue }),
            onSend: sendIssue,
            sendNotice: send,
          }))
      }

      return h('div', { className: 'dsh-gti-root', 'data-gti-workspace': 'true' },
        h('style', null, CSS),
        head,
        configError === null ? null : h(Banner, { tone: 'error', text: configError }),
        bindingError === null ? null : h(Banner, { tone: 'warn', text: bindingError }),
        error === null ? null : h(Banner, { tone: 'error', text: error }),
        send === null ? null : h(Banner, { tone: send.tone, text: send.text }),
        binding !== null && effective === null
          ? h(Banner, { tone: 'warn', text: t('binding.none') },
            h('button', { type: 'button', className: 'dsh-gti-button', onClick: () => setView({ kind: 'binding' }) }, t('binding.settings')))
          : null,
        effective === null ? null : filterBar,
        effective === null ? null : listBody)
    }

    // ── 图标与注册 ──────────────────────────────────────────────────────────

    /** 左侧栏全局面板的图标（owner 传 `{ size, active }`）。 */
    function BoardIcon({ size }) {
      return h('svg', {
        width: size ?? 18,
        height: size ?? 18,
        viewBox: '0 0 18 18',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.4',
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: 'M4 4.5h10' }),
        h('circle', { cx: 6, cy: 9, r: 1.4 }),
        h('path', { d: 'M5.4 9l.7.8 1.4-1.6' }),
        h('path', { d: 'M9.5 9h4.5' }),
        h('circle', { cx: 6, cy: 13, r: 1.4 }),
        h('path', { d: 'M9.5 13h4.5' }))
    }

    /** 右侧栏页签的图标。 */
    function TabIcon({ size }) {
      return BoardIcon({ size })
    }

    /** 客户端插件正文。 */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      const api = createApi()

      /** 全局看板的槽位正文（owner 传的 prop 一个都不用，所以包一层忽略掉）。 */
      function GlobalBoardSlot() {
        return h(GlobalBoard, { api, t })
      }

      /** 右侧栏页签正文：只用 `sessionId` 与可选的 `inputActions`，别的 prop 一律不假设。 */
      function WorkspaceBoardSlot(props) {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
        const inputActions = props?.inputActions
        return h(WorkspaceBoard, { api, t, sessionId, inputActions })
      }

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gitea-issues: dictionaries')

      // 全局看板：一个 main 键 + 左侧栏一个图标（order 20 —— 排在官方「自动化任务」(10) 下面）。
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, GlobalBoardSlot)), 'gitea-issues: global board')
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('panel.label'),
      }, BoardIcon)), 'gitea-issues: sidebar panel icon')

      // 工作区看板：右侧栏一个**页类型**（没有 patterns —— 不参与任何文件的自动打开排名），
      // 从 guide 卡片或快捷键进入。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'builtin',
        title: () => t('tab.title'),
        guide: [{
          id: TAB_ID,
          commandId: 'gitea.issues',
          order: 30,
          title: () => t('tab.title'),
          description: () => t('tab.guide'),
          icon: TabIcon,
        }],
      }), 'gitea-issues: right sidebar tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
      }, WorkspaceBoardSlot)), 'gitea-issues: right sidebar tab body')

      // 对话输入框的「哨兵」：不画任何东西，只把本会话的 `inputActions` 登记进 `inputTargets`，
      // 给看板的「发送到 DSH」兜底（侧栏槽位不保证把这个标准 prop 传全，见文件头注释）。
      // 与 dsh-editor 的哨兵 id 不同，两者互不顶替；order 靠后，不抢官方那条位置。
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'gitea-issues-input',
        order: 95,
        locale: NS,
      }, InputSink)), 'gitea-issues: composer input sink')

      // 快捷键可选：`shortcuts` 服务不在也不影响面板（guide 卡片照样能打开）。
      ctx.inject(['shortcuts'], (scoped) => {
        scoped.effect(() => scoped.shortcuts.register({
          id: 'gitea.issues',
          label: () => t('shortcut.issues'),
          aliases: ['gitea issues', 'gitea 看板', 'Gitea issues board'],
          defaults: {
            'desktop:macos': { code: 'KeyG', modifiers: ['primary', 'alt'] },
            'desktop:windows': { code: 'KeyG', modifiers: ['primary', 'alt'] },
            'desktop:linux': { code: 'KeyG', modifiers: ['primary', 'alt'] },
            'web:macos': { code: 'KeyG', modifiers: ['primary', 'alt'] },
            'web:windows': { code: 'KeyG', modifiers: ['primary', 'alt'] },
            'web:linux': { code: 'KeyG', modifiers: ['primary', 'alt'] },
          },
          regions: ['page', 'editable', 'terminal'],
          modals: [],
          resolve: ({ target }) => {
            const capture = ctx.sidebarRight.commandTarget(target)
            if (capture === undefined) return { status: 'blocked', reason: t('binding.noSession') }
            return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget(TAB_KIND, capture) } }
          },
        }), 'gitea-issues: issues shortcut')
      })
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

    return { name: 'gitea-issues', inject, apply }
  },
})
