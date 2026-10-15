/**
 * @module @dongasai/dsh-gitea-task-issues/client
 *
 * **Gitea 任务 issues —— 浏览器半边**。给 GUI 补两处看板 + 一处管理面：
 *
 * 1. **全局看板**（`main` 键 `gitea-issues`，入口是左侧栏 `sidebar.panellist` 的一个图标，
 *    `order: 20` —— 排在官方「自动化任务」（order 10）下面）：跨服务器 / 跨仓库的 issues 视图，
 *    外加服务器管理与令牌管理；
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
 *    这里只消费瘦身后的字段；缺字段一律按「没有」渲染，不抛错。
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
      'filter.keyword': '关键词',
      'filter.keywordPlaceholder': '搜标题与正文',
      'filter.owner': '所属',
      'filter.ownerPlaceholder': '按 owner 收窄（可选）',
      'filter.server': '服务器',
      'filter.allServers': '全部服务器',
      'filter.scope': '范围',
      'filter.scopeAll': '跨仓库',

      'list.count': '{n} 条',
      'list.empty': '这个筛选下没有 issue。',
      'list.emptyHint': '换个状态或关键词试试，或者新建一条。',
      'list.loading': '正在读取 issues…',
      'list.partial': '部分服务器读取失败：{names}',

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
      'filter.keyword': 'Keyword',
      'filter.keywordPlaceholder': 'Search title and body',
      'filter.owner': 'Owner',
      'filter.ownerPlaceholder': 'Narrow by owner (optional)',
      'filter.server': 'Server',
      'filter.allServers': 'All servers',
      'filter.scope': 'Scope',
      'filter.scopeAll': 'Across repositories',

      'list.count': '{n} items',
      'list.empty': 'No issues match this filter.',
      'list.emptyHint': 'Try another state or keyword, or file a new one.',
      'list.loading': 'Loading issues…',
      'list.partial': 'Some servers failed: {names}',

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
.dsh-gti-dot{flex:none;width:8px;height:8px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2)}
.dsh-gti-dot[data-state="open"]{background:var(--dsw-alias-state-success-primary);border-color:transparent}
.dsh-gti-dot[data-state="closed"]{background:var(--dsw-alias-label-tertiary);border-color:transparent}
.dsh-gti-chip{display:inline-flex;align-items:center;gap:4px;max-width:22ch;padding:1px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-gti-chip[data-tone="brand"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
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
     * 筛选条。
     * @param props - `value` / `onChange` / `servers` / `showServer` / `showOwner` / `t`。
     */
    function FilterBar({ value, onChange, servers, showServer, showOwner, t, children }) {
      const set = (patch) => onChange({ ...value, ...patch })
      return h('div', { className: 'dsh-gti-bar', 'data-gti-filter': 'true' },
        h('label', { className: 'dsh-gti-note' }, t('filter.state')),
        h('select', {
          className: 'dsh-gti-select',
          value: value.state,
          'data-gti-filter-state': 'true',
          onChange: (event) => set({ state: event.target.value }),
        }, STATES.map((state) => h('option', { key: state, value: state }, t(`state.${state}`)))),
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
     * @param props - `api` / `t` / `target`（`{serverId, owner, repo, index}`）/ `onBack` / `onChanged` / `onEdit`。
     */
    function IssueDetail({ api, t, target, onBack, onChanged, onEdit }) {
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
            action(detail.subscribed ? t('issue.unsubscribe') : t('issue.subscribe'), detail.subscribed ? 'issue.unsubscribe' : 'issue.subscribe', {}, { reload: false, success: detail.subscribed ? undefined : t('issue.subscribed') })),

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
    function BindingPanel({ api, t, sessionId, config, binding, error, reload, onChanged }) {
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
            }, t('binding.clear')))))
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
     * 新建 issue 前的目标选择：服务器 + owner/repo，可从我拥有的仓库里挑。
     * @param props - `api` / `t` / `config` / `value` / `onChange`。
     */
    function TargetPicker({ api, t, config, value, onChange }) {
      const [repos, setRepos] = React.useState([])
      const serverId = value.serverId

      React.useEffect(() => {
        let alive = true
        if (serverId === '') {
          setRepos([])
          return () => { alive = false }
        }
        void api.repos(serverId).then((result) => {
          if (alive && result.ok) setRepos(result.data ?? [])
        })
        return () => { alive = false }
      }, [api, serverId])

      return h('div', { className: 'dsh-gti-field-row' },
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
          })),
        h('datalist', { id: 'dsh-gti-repo-list' },
          repos.map((repo) => h('option', { key: repo.fullName, value: repo.fullName }))))
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
     * 全局看板：跨服务器（可选跨仓库）的 issues，外加服务器管理与令牌管理。
     * @param props - `api` / `t`。
     */
    function GlobalBoard({ api, t }) {
      const { config, error: configError, reload: reloadConfig } = useConfig(api, t)
      const [view, setView] = React.useState({ kind: 'list' })
      const [filter, setFilter] = React.useState({ state: 'open', serverId: '', owner: '', q: '' })
      const [keyword, setKeyword] = React.useState('')
      const [issues, setIssues] = React.useState(null)
      const [failed, setFailed] = React.useState([])
      const [error, setError] = React.useState(null)
      const debouncedKeyword = useDebounced(keyword)

      const query = { ...filter, q: debouncedKeyword }

      const load = React.useCallback(async () => {
        if (config === null) return
        const servers = query.serverId === '' ? config.servers : config.servers.filter((server) => server.id === query.serverId)
        if (servers.length === 0) {
          setIssues([])
          setFailed([])
          return
        }
        setError(null)
        const results = await Promise.all(servers.map(async (server) => ({
          server,
          result: await api.gitea('issue.search', {
            serverId: server.id,
            state: query.state,
            q: query.q === '' ? undefined : query.q,
            owner: query.owner === '' ? undefined : query.owner,
            limit: 50,
          }),
        })))
        const merged = []
        const broken = []
        for (const { server, result } of results) {
          if (result.ok) merged.push(...(result.data ?? []).map((issue) => ({ ...issue, serverId: server.id })))
          else broken.push(`${server.name}（${failureText(t, result)}）`)
        }
        merged.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
        setIssues(merged)
        setFailed(broken)
      }, [api, config, query.serverId, query.state, query.q, query.owner, t])

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
            onClick: () => setView({ kind: 'create', serverId: query.serverId === '' ? (config.servers[0]?.id ?? '') : query.serverId, owner: query.owner, repo: '' }),
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
            onClick: () => void load(),
          }, h(Icon, { name: 'refresh' }))),
        h(FilterBar, {
          value: { ...filter, q: keyword },
          onChange: (next) => { setFilter({ state: next.state, serverId: next.serverId ?? '', owner: next.owner ?? '', q: filter.q }); setKeyword(next.q ?? '') },
          servers: config?.servers ?? [],
          showServer: true,
          showOwner: true,
          t,
        }),
        configError === null ? null : h(Banner, { tone: 'error', text: configError }),
        failed.length > 0 ? h(Banner, { tone: 'warn', text: t('list.partial', { names: failed.join('；') }) }) : null,
        error === null ? null : h(Banner, { tone: 'error', text: error }),
        issues === null
          ? h(Loading, { t })
          : issues.length === 0
            ? h(Empty, { title: t('list.empty'), hint: t('list.emptyHint') })
            : h('div', { className: 'dsh-gti-list' }, issues.map((issue) => h(IssueRow, {
              key: issueKey(issue),
              issue,
              t,
              showRepo: true,
              selected: issueKey(issue) === selectedKey,
              onOpen: (picked) => setView({ kind: 'detail', issue: picked }),
            }))))

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
              : h('p', { className: 'dsh-gti-note' }, t('binding.repo'))))
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
     * 工作区看板：当前会话绑定仓库的 issues。
     * @param props - `api` / `t` / `sessionId`。
     */
    function WorkspaceBoard({ api, t, sessionId }) {
      const { config, error: configError, reload: reloadConfig } = useConfig(api, t)
      const [binding, setBinding] = React.useState(null)
      const [bindingError, setBindingError] = React.useState(null)
      const [view, setView] = React.useState({ kind: 'list' })
      const [filter, setFilter] = React.useState({ state: 'open', q: '' })
      const [keyword, setKeyword] = React.useState('')
      const [issues, setIssues] = React.useState(null)
      const [error, setError] = React.useState(null)
      const debouncedKeyword = useDebounced(keyword)

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

      const effective = binding?.effective ?? null
      const target = effective === null ? null : { serverId: effective.serverId, owner: effective.owner, repo: effective.repo }

      const load = React.useCallback(async () => {
        if (target === null) {
          setIssues([])
          return
        }
        setError(null)
        const result = await api.gitea('issue.list', {
          sessionId,
          state: filter.state,
          q: debouncedKeyword === '' ? undefined : debouncedKeyword,
          limit: 50,
        })
        if (result.ok) setIssues(result.data ?? [])
        else setError(failureText(t, result))
      }, [api, t, sessionId, target?.serverId, target?.owner, target?.repo, filter.state, debouncedKeyword])

      React.useEffect(() => { void load() }, [load])

      const head = h('div', { className: 'dsh-gti-bar' },
        h('span', { className: 'dsh-gti-bar-title' },
          effective === null ? t('app.title') : `${effective.owner}/${effective.repo}`),
        effective === null ? null : h('span', { className: 'dsh-gti-note' },
          effective.source === 'binding' ? t('binding.manual') : t('binding.auto')),
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
          onClick: () => void load(),
        }, h(Icon, { name: 'refresh' })))

      const filterBar = h(FilterBar, {
        value: { ...filter, q: keyword },
        onChange: (next) => { setFilter({ state: next.state, q: filter.q }); setKeyword(next.q ?? '') },
        t,
      })

      const listBody = issues === null
        ? h(Loading, { t })
        : issues.length === 0
          ? h(Empty, { title: t('list.empty'), hint: t('list.emptyHint') })
          : h('div', { className: 'dsh-gti-list' }, issues.map((issue) => h(IssueRow, {
            key: issueKey(issue),
            issue,
            t,
            showRepo: false,
            selected: view.kind === 'detail' && issueKey(view.issue) === issueKey(issue),
            onOpen: (picked) => setView({ kind: 'detail', issue: picked }),
          })))

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
          }))
      }

      return h('div', { className: 'dsh-gti-root', 'data-gti-workspace': 'true' },
        h('style', null, CSS),
        head,
        configError === null ? null : h(Banner, { tone: 'error', text: configError }),
        bindingError === null ? null : h(Banner, { tone: 'warn', text: bindingError }),
        error === null ? null : h(Banner, { tone: 'error', text: error }),
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

      /** 右侧栏页签正文：只用 `sessionId`，别的 prop 一律不假设。 */
      function WorkspaceBoardSlot(props) {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
        return h(WorkspaceBoard, { api, t, sessionId })
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
