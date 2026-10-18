# 自动分配任务：设计稿

> 状态：**已实现（v0.3.0）**。本文件保留「为什么这么做、哪些还没证实」；用法见
> [README.md](../README.md)「自动分配任务」一节，实现取舍见 [IMPLEMENTATION.md](../IMPLEMENTATION.md)。
> 与代码冲突时以代码为准 —— 下面第 14 节记了实现期与初稿的偏离。

## 一句话方案

Host 半边多一个**默认关闭、可分级开关**的轮询器：每个周期对每个「已启用自动分配」的绑定，
用**已有的两个 Gitea 操作**各拉一次增量，纯函数判出「新指派给我 / 被重新打开 / 有新评论」
三类触发，再判该工作区**有没有正在跑的会话**——没有才 `sessionController.create({ cwd })`
新建一个会话，并把一行提示词 `prompt()` 投进去。

一句话就说完，但难点全在边角上：首次基线、幂等窗口、自激循环、跨进程重复、工作区忙、
多 root 同仓库、宿主不支持。下面逐个交代。

---

## 1. 触发语义与判定表

三类触发的判定**全部落在纯函数**里（`lib/triggers.js`），这样探针不碰网络也不碰会话就能把
矩阵测完。判定读三份输入：上轮账本、本轮 issue 列表、本轮评论列表。

| 触发 | 判定 | 用到的字段 |
|---|---|---|
| 新指派给我 | 账本里**没有**这条 issue 的记录，且它现在指派给我 | `issue.index` + `created_at` |
| 被重新打开 | 账本记的 `state === 'closed'`，本轮变成 `'open'` | `state` |
| 有新评论 | 本轮最新评论 id **大于**账本记的 `lastCommentId`，且评论人**不是我自己** | `comment.id` + `comment.user.login` |

三条硬性细节，漏一条就是 bug：

1. **「指派给我」不能自己判断，交给 Gitea。** `GET /repos/issues/search` 的 `assigned=true`
   就是「指派给当前令牌用户」，我们不去比对用户名——省一次 `server.user`，也不会因为
   大小写或团队指派判错。
2. **「新」是相对账本，不是相对 `created_at`。** 账本里没有记录 = 新。所以**首次轮询必须
   只建立基线、零投递**，否则一开启就会把历史上所有指派给自己的 issue 全开一遍会话。
   基线时刻另存 `baselinedAt`，界面要显式说明「基线之后才算新」。
3. **评论人过滤是防自激的第一道闸。** 新建的会话自己去评论 issue 是正常工作方式，而它
   评论会让 issue 的 `updated_at` 变、评论列表变——不过滤的话就是无限自我唤醒。

## 2. 数据从哪来：不新增任何 Gitea 操作

现有的操作表已经够了，**一个字都不用加**：

| 用途 | 现成操作 | 实际请求 |
|---|---|---|
| 我的 issue 增量（跨仓库，一次拿全） | `issue.search` | `GET /repos/issues/search?state=all&assigned=true&since=…&limit=50` |
| 本仓库评论增量 | `comment.listRepo` | `GET /repos/{owner}/{repo}/issues/comments?since=…&limit=50` |

`issue.search` 是**服务器级**的、跨仓库的，一次调用覆盖该服务器上所有仓库；按
`owner` 过滤出当前绑定的仓库即可。所以每周期成本 = 每服务器 1 次 + 每仓库 1 次。

两个已知缺口，设计上要正面处理：

- `comment.listRepo` 的评论对象**不带 issue 编号**（`lib/shape.js` 的 `shapeComment` 在
  仓库级调用下 `issueIndex` 是 `null`）。但上游的 Comment **有** `issue_url`
  （`docs/gitea-api-reference.md:218` 的字段表，形状是
  `/repos/{owner}/{repo}/issues/{index}`），**从它解析出 index**。这条要么在
  `shapeComment` 里补一步派生（改一处，两边共用），要么在 `lib/triggers.js` 的入参里
  自己解析。**取前者**：派生逻辑放出线形状层，浏览器半边想要「这条评论属于哪个 issue」
  时也能直接拿到，不必再拼一次。
- 分页。`since` 收窄之后的条目数通常很小，但**必须**写「一页 50 条打满就按 `updated_at`
  继续往前翻到追平水位」，不能假装不会溢出。

## 3. 账本：`watch.json`，跟 `servers.json` 分开

这是本设计里最重要的一个结构决定。

**为什么必须分开一个文件**：水位每轮都在变，而 `servers.json` 走 `ConfigStore` 的
`revision` 乐观并发，界面保存设置时带 `expectedRevision`。把水位写进 `servers.json`，
界面每次保存都可能撞 `409 stale-config`——用户看到的是「设置怎么老是保存失败」。

`ConfigStore` 本身是通用的（构造时给路径即可），所以**直接复用同一个类**，新的只是一份
schema 与一台实例：

```js
new ConfigStore(join(dshHome(), PLUGIN_SCOPE, 'watch.json'), ctx.logger)
```

```jsonc
{
  "version": 1,
  "revision": 37,
  "global": {
    "enabled": false,          // 总闸，默认关
    "intervalSeconds": 120,    // 下限 60
    "maxSessionsPerHour": 6,   // 全局配额
    "baselinedAt": "2026-10-17T00:10:00.000Z"
  },
  "roots": {
    "/data/ai/dsh/gitea_task_issues": {
      "enabled": true,
      "serverId": "srv-1a2b3c4d",   // 冗余存：绑定改了要能对账报错，而不是拿旧仓库硬查
      "owner": "dongasai",
      "repo": "gitea_task_issues",
      "triggers": { "newAssigned": true, "reopened": true, "newComment": true },
      "agentPreset": null,           // null = 宿主默认 preset
      "cooldownSeconds": 600,        // 同一 issue 两次自动开会话的最小间隔
      "maxPerIssuePerDay": 3,
      "giveUpAfterHours": 24         // 工作区长时间不空闲就放弃这条触发（记 fired=expired）
    }
  },
  "watermarks": {
    "srv-1a2b3c4d/dongasai/gitea_task_issues": { "issues": "…", "comments": "…" }
  },
  "issues": {
    "srv-1a2b3c4d/dongasai/gitea_task_issues#12": {
      "state": "open",
      "lastCommentId": 991,
      "fired": { "newAssigned": true, "reopened": "2026-10-16T…", "commentId": 991 },
      "pendingSince": null,
      "deliveredAt": "2026-10-17T00:12:03.000Z",
      "dailyCount": { "day": "2026-10-17", "n": 1 }
    }
  },
  "deliveries": [ /* 环形缓冲，上限 200 条，给界面看 */ ]
}
```

三个字段语义要说清，否则很容易写歪：

- **`state` / `lastCommentId` 是「事实」，每轮都推进**——即使这轮因为工作区忙而没投递。
  不推进的话「被重新打开」永远判不出来。
- **`fired` 是「我已经为哪个版本开过会话」**，记三种触发的 fingerprint：
  `newAssigned` 记 `true`、`reopened` 记观测到重开的那次时刻、`newComment` 记已消费到的
  `commentId`。**判出触发但被业务拒绝时（忙 / 配额 / 冷却）绝不写 `fired`**，于是下轮天然
  重试——账本自己就是队列，不必另建 pending 列表；`pendingSince` 只用来记账「第一次被拒的
  时刻」，配合 `giveUpAfterHours` 收口。
- **但「决定投递」与「业务拒绝」是两回事**：一旦决定投递，就**先写 `fired` 再投**（第 5 节
  闸门一）。此时若 `create`/`prompt` 抛错，`fired` 已经写了，**不自动重试**，只记一条
  `failed:code` 到 deliveries 并在界面提供「重放」——这是刻意换来的「宁可漏，不可重」。

写入策略：**只在内容真的变了才落盘**（比较序列化结果）；`issues` 里 30 天没动过的记录、
`deliveries` 超上限的旧条目在写盘前剪掉。原子写与串行写沿用 `ConfigStore`。

## 4. 空闲判定与会话投递：已核实的 DSH 契约

这一节是**已核实的事实**，不是设想。证据都来自本机 profile 里的官方包
（`~/.dsh/profiles/node_modules/@deepseek-ai/…`，符号链接指向
`~/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/…`）。

服务名与命名空间：`dsh-api-session-controller/lib/index.js:2847`
```js
super(ctx, "sessionController", { namespace: "session" });
```

服务类上的入口与实现（同一个包 `lib/index.js`，括号里是**服务类**入口行 / 实现行）：

- `create(request)` —— 服务类 2971 → `commands.create` 686
- `prompt(request, signal)` —— 服务类 3096 → `commands.prompt` 850
- `list(_request, signal)` —— 服务类 2954 → `listState.list` 1888

```js
// 新建会话：cwd 就是工作区根，会话会自动归入该目录所在的项目
const { sessionId } = await ctx.sessionController.create({ cwd: root, agentPreset })

// 投递：requestId 是幂等键，content 至少一段非空文本；第二参是 AbortSignal
await ctx.sessionController.prompt(
  { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] },
  signal,
)

// 判忙：list 收一个（保留的）请求对象，返回 { items }，不是裸数组
const { items } = await ctx.sessionController.list({}, signal)
```

两个签名细节容易写错，先记在这：`prompt` 的第二参是**必需的 `AbortSignal`**（服务入口第一件事就是
`signal.throwIfAborted()`）；`list` 返回 `{ items: SessionSummary[] }`。

`create` 的入参校验是「`workspaceId` 与 `cwd` 二选一，都给报 `gateway/bad-request`」
（`lib/index.js:687`），我们只给 `cwd`。

`cwd` 是官方文档化的入参：`SessionCreateRequest { workspaceId?, cwd?, sessionId?, agentPreset? }`
（`lib/types/types.d.ts:279`），实现里 `create()` 取
`workspace?.path ?? request.cwd ?? defaultCwd`（`lib/index.js:693`）；
`PromptContentPart` 是 `{ type:'text', text }` 的联合（`lib/types/types.d.ts:78`）；
`SessionPromptRequest` 见 `lib/types/types.d.ts:319`。
`dsh-workspace/README.zh.md` 明确「在项目目录中创建会话，它就会出现在该项目下」，
所以只给 `cwd` 就够，不必先 `workspaceRegistry.create()`。

**「工作区是否空闲」有现成判据**——`SessionSummary`（`lib/types/types.d.ts:159`）：

```ts
{ agentAvailable: boolean, sessionId, updatedAt, running: boolean,
  blank: boolean, parentSessionId?, origin?, cwd?, projections? }
```

于是空闲判定就是：

```js
const { items } = await ctx.sessionController.list({}, signal)
const busy = items.some((s) => s.origin === undefined && s.cwd === root && s.running)
```

`origin === undefined` 用来排除 subagent 会话（它们是 `origin: 'subagent'`，不该算作
「这个工作区有人在干活」的独立信号）。**不空闲就整条跳过，只记 `pendingSince`，不投递。**

`list()` 是**冷安全**的：官方文档说列表只读持久化 header 与 projection cache，
「绝不调用逐 Session stat 或打开冷 Session body」（`dsh-api-session-controller/README.zh.md`
「使用本包」一节）。所以每周期调它不会把冷会话点着。

**默认策略是「永远新建」，不复用空白会话。** 官方有 `blank: true` 的空会话可以收养，但
那可能是用户刚点开、正准备打字的窗口——自动投递会直接抢走用户的输入焦点。复用作为
可选项（`reuseBlankSession: false` 默认）留着，不默认开。

## 5. 幂等与防自激：四道闸门

自动开会话最怕两件事：**同一件事开两次会话**、**会话自己把自己唤醒**。

**闸门一：先记账，再投递（write-ahead）。** 决定投递时，先把这条触发的 fingerprint 写进
`fired` 并**落盘**，再去 `create` / `prompt`。崩溃窗口于是落在「已记账、未投递」这一侧：
最坏是**漏投一次**，界面能看出来（有 `fired`、没有对应的 deliveries 记录），给一个
「重放」入口；反过来则是**重复投**——真的多花模型调用、可能重复改远端。

方向是刻意选的：**宁可漏，不可重。** 所有幂等设计都从这一条推出来。

**闸门二：`requestId` 只兜「同一会话内的重试」。** 我原本以为它是全局幂等键，**核实后不是**：
去重按 **Agent** 做——`hasPromptRequest(agent, request.requestId)`，命中就直接返回
`{ accepted: true }`（`lib/index.js:855`）。而我们是**每次投递都新建会话**，跨会话它帮不上忙。
所以它不是一个可以单独依赖的闸门，必须配闸门三。

**闸门三（待实测）：确定性 `sessionId`。** 官方文档写明 `create` 带显式 id 时会「收养活动
Session，或恢复持久化 Session 并持续持有其写锁」，写锁争用报 `session/writer-held`。若持久层
接受我们造的 id，就能让「重试 = 重新收养同一个会话」，闸门二随之生效，闸门一的漏投窗口也能
靠重放补齐而不产生第二个会话。但**官方自造的 id 是 `session-<uuid>` 形状，自定义 id 是否过
header 校验没有任何文档保证**——列进第 12 节实验清单，不成则退回闸门一。

**闸门四：自评过滤 + 冷却 + 配额（防自激）。**
- 评论人 `user.login === 当前令牌用户` 的评论**永不触发**，只推进 `lastCommentId`；
- 同一 issue `cooldownSeconds`（默认 600s）内不开第二次；
- 同一 issue 每天 `maxPerIssuePerDay`（默认 3）次上限；
- 全局 `maxSessionsPerHour`（默认 6）上限，超了就整轮不投并记一条可见的 `capped` 记录。

配额超限与工作区忙都**不是失败**，是设计内的拒绝，必须在界面里能看到原因——否则用户
只会看到「自动分配怎么没干活」。

## 6. 失败、降级与并发

- **服务缺席就整机降级。** `ctx.get('sessionController')` 为空（headless / 纯 SDK 组合）时，
  轮询器**不启动**，只记一条日志，界面显示「当前宿主不支持自动开会话」。这不是猜的：
  `dsh-schedule` 的 README 明确写了同一约束——投递需要 Host 的 Web Session controller 与
  会话持久化后端，headless 组合挂不上。同理，我们没有 `sessionController` 就什么都做不了。
- **轮询失败要有界、可见、不静默。** 连续失败退避 2/4/8/…/上限 1800s，退避期间界面显示
  「上次失败：<code>，下次尝试 <时刻>」。**不推进水位**——没读到就不算读过。
- **水位回退 60 秒重叠。** 用 `watermark − 60s` 当 `since`，靠 `lastCommentId` / issue 记录
  去重，防止 Gitea 的秒级精度与时钟偏差漏条目。重复读到不是问题，重复投递才是。
- **跨进程单飞锁。** 同一个 `$DSH_HOME` 可能被两个 dsh 进程（两个 npx 实例）同时打开，
  两个轮询器会各自投一次。做法：`watch.lock` 写 `{ pid, host, heartbeatAt }`，心跳超过
  `2 × intervalSeconds` 视为陈旧可夺取；拿不到锁的进程只读不投，界面标注「本进程未持有
  轮询锁」。
- **多个 root 绑到同一仓库**：按 `(serverId, owner, repo)` 去重，**只投给字典序最前的那个
  root**，其余 root 记录 `skipped: shared-repo`。不这么做的话，一个仓库绑两个工作区就会
  投两次。
- **`setInterval(...).unref()` 且包在 `ctx.effect` 里**，插件卸载即停，也不会拖着进程不退。
  定时器与时钟**必须可注入**（`now()` / `setTimer()`），否则探针只能靠 sleep。

## 7. 提示词

沿用「发送到 DSH」那套措辞（`client.js` 的 `send.prompt`：
`请处理 Gitea issue #{index}：{title}`），只多一行「为什么叫醒你」：

```
请处理 Gitea issue #12：修复泳道分组的空列渲染

（自动分配：有新评论 by @someone）
```

**不带 URL**——与 `88a530c` 的决定保持一致；会话本身就跑在那个工作区里，仓库由绑定解析，
`#12` 足够。三类触发的理由行分别是：`刚被指派给你` / `被重新打开了` / `有新评论 by @x`。

## 8. 界面

新增一个视图 `view.kind === 'automation'`，入口放在**绑定设置页**里（自动分配是绑定的属性，
不是服务器属性）。内容：

- 总开关 + 每个绑定的开关、三类触发勾选、预设选择、冷却与配额；
- 只读状态：水位时刻、上次轮询结果、**基线时刻**（并显式说明基线之前的历史不会被投递）；
- 「最近投递」列表：时间、issue、触发类型、结果（`prompted` / `busy-skipped` / `capped` /
  `expired` / `failed:code`）、会话 id；
- **「立即检查一次」** 按钮（走桥的 `watch.tick`，手动触发一轮，不受 interval 限制）；
- 服务缺席时的横幅。

按项目规矩：样式只挂组件本地 `<style>` 且只用 `--dsw-alias-*`；调试锚点走
`data-gti-watch-*`；文案 `zh` / `en` 一起加。

## 9. 代码落点与改动连带项

新增：

| 文件 | 职责 |
|---|---|
| `lib/watchstore.js` | `watch.json` 的 schema、收敛（`coerceState`）、剪枝 |
| `lib/triggers.js` | **纯函数**：账本 + issues + comments → 触发列表 |
| `lib/watch.js` | 轮询循环、锁、退避、配额；调 `sessionController` |

改：

- `index.js`：建 `watch.json` 的 store、起停轮询器（`ctx.effect`）；**文件头约束 4 要改写**；
- `lib/bridge.js`：加 `watch.get` / `watch.set` / `watch.tick` / `watch.history` 四个 op
  （参数逐项收敛，`intervalSeconds` 下限 60，配额上限收敛）；
- `lib/shape.js`：`shapeComment` 从 `issue_url` 派生 `issueIndex`（浏览器半边与轮询共用）；
- `lib/gitea.js`：**不动**（第 2 节已确认无需新 op）；
- `client.js`：新视图 + 文案 + 锚点；
- `tests/`：见第 10 节；
- **`AGENTS.md` 硬性约束 8 与 `index.js` 约束 4 必须改写**：现在是「不做后台轮询」，
  要精修成「**桥不做后台轮询、不做静默重试；后台轮询只属于 watch 子系统**，默认关闭、
  可一键停、有配额、失败可见」。这是本设计唯一触碰既有硬约束的地方，也是最需要拍板的一条；
- README（新增「自动分配」用法一节 + 已知边界）、IMPLEMENTATION（为什么单独一个账本文件、
  为什么首次只建基线、**为什么幂等不能只靠 `requestId`**）、`package.json` 版本号。

## 10. 探针计划

- `tests/triggers.test.mjs`（纯函数，矩阵）：首次基线零投递 / 新指派 / 重开 / 新评论 /
  **自评不触发** / 冷却内不重复 / 每日配额 / fingerprint 相同不重复触发 / 水位回退仍不重复。
- `tests/watch.test.mjs`（假 Gitea + 假 `sessionController` + **注入时钟**）：
  1. 断言真打了 `/repos/issues/search?assigned=true&state=all&since=…` 与
     `/repos/{o}/{r}/issues/comments?since=…`（比其他断言更能防回归）；
  2. 假 `list()` 返回 `running: true` 的会话 → **断言 `create` 一次都没被调**，且记了
     `busy-skipped`；
  3. 不忙 → 断言 `create({ cwd: root })` 与 `prompt` 的文本、`requestId` 完全符合预期；
  4. 同一触发跑两轮 → 断言 `prompt` 只发一次；
  5. `ctx.get('sessionController')` 为 undefined → 断言不抛错、不投递、状态可读；
  6. 跨进程锁被占 → 断言只读不投。
- 浏览器侧：`tests/client.test.mjs` 补新视图的渲染与开关交互；布局改动按 README
  「只能在浏览器里看的」清单人工走一遍。

## 11. 分期与每期验收

| 期 | 内容 | 验收 |
|---|---|---|
| P0 | `watchstore` + `triggers` 纯函数 + 探针 | `node --test` 全绿，无网络无会话 |
| P1 | 拉取 + 判定 + 落账，**dry-run 只记账不投递**，界面能看到「将会投递什么」 | 假 Gitea 断言请求形状；dry-run 下 `create` 零调用 |
| P2 | 真投递：空闲判定 + `create` + `prompt` | 探针 1–6 全过；手动在一台真 Gitea 上跑通一例 |
| P3 | 界面（开关 / 状态 / 最近投递 / 立即检查一次） | 浏览器人工走一遍 + 迷你 React 用例 |
| P4 | 文档与版本号（含 AGENTS 约束 8 改写） | 文档与代码一致，`npm test` + `npm run check` |

**P1 的 dry-run 是刻意加的**：这个功能默认关、真开起来就会花掉模型调用与真实改远端状态，
先能看清「它打算投什么」再放行，比事后从 deliveries 里倒查便宜得多。

## 12. 需要实测的不确定项

按不确定性从高到低，全部**用一次性脚本验证，不靠推理**：

1. **自定义 `sessionId` 是否被接受**（决定闸门三能不能用）。不成 → 退回闸门一
   （write-ahead 记账）。
2. **`sessionController` 在当前组合里是否可用**，`create({ cwd })` 出来的会话是否真的
   落在那个工作区、并归入同名项目。
3. ~~`requestId` 的去重范围~~ —— **已核实，按 Agent 去重**（`lib/index.js:855`），
   跨会话无效。结论已并入闸门二，留此仅作记录。
4. **新会话用什么模型**：没有 `agentPreset` 时会不会因为「无默认模型」被拒
   （文档里的 `session/model-unavailable`）。要给出配置项与回退行为。
5. **`since` 的秒级精度与时钟偏差**：实测丢条目率，定 60s 重叠够不够。
6. **`prompt` 的准入条件**：`create` 之后立刻 `prompt`，会不会撞上 Agent 还在装配
   （需要重试还是天然排队）。

## 13. 已拍板的点（2026-10-17 定稿）

1. **AGENTS.md 约束 8 已改写**：桥不做后台轮询；后台轮询只属于 watch 子系统，默认关闭、
   可一键停、有配额、失败可见。
2. **总闸默认关**，单绑定默认开（`global.enabled = false`，`roots[root].enabled = true`）——
   即「装好就能配，但要显式打开总闸才会动」。
3. **工作区忙时跳过并保留待办**，下轮重试，超过 `giveUpAfterHours` 写入 `fired` 并记
   `expired`（不再重试）。
4. **一个仓库绑多个工作区只投一次**：事实按仓库存（`serverId/owner/repo#index`），
   第一个匹配的 root 负责投递，其余自然看到「没有待办」。
5. **dry-run 保留为运行时开关**（`global.dryRun`），不再单列一期 —— 只记账不投递，
   可以随时打开「先看清楚再放行」。
6. **v1 不加模型工具**：自动分配只走界面，避免动到「模型工具工作区隔离」那条硬约束。

## 14. 实现期与初稿的偏离（以代码为准）

落地时改了三处，其中两处是**探针抓出来的真 bug**，记在这里免得后人重犯：

1. **`requestId` 不是全局幂等键。** 初稿以为它跨会话唯一，核实后是按 **Agent** 去重
   （`hasPromptRequest(agent, request.requestId)`），而我们是每次新建会话 —— 所以真正的幂等
   靠**账本 + write-ahead**（先写已投递再投），`requestId` 只兜同一会话内的重试。
   第 5 节的闸门一才是主防线。
2. **`since` 查询的截断必须压住水位。** 一页 `limit=50` 打满说明还有更旧的更新没读到；这时
   把水位推到「现在」会永久漏单。实现里改成：截断时水位只推进到本批最旧的 `updated_at`。
3. **`stopped` 不能一个标记两用。** 初稿用 `stopped = true` 当「循环没启动」的初值，结果
   `tickNow()`（界面的「立即检查一次」）在投递循环第一行就 `break`，什么都不投。实现拆成
   `loopActive`（排不排下一轮）与 `halted`（投递要不要立刻中断）。

另外三处是**接线坑**，纯函数测不出来，只能在端到端探针里钉：

4. **`runOperation` 给的是原始 Gitea JSON**，不是出线形状。轮询器必须自己过
   `shapeIssues` / `shapeComment`，否则 `issue.owner` 恒为 `undefined`、过滤恒空、
   **永远判不出任何触发**。
5. **`createBridge` 漏传 `watchStore`**：`watch.get` 等操作在桥里直接 `bridge-failed`。
6. **评论侧也要建基线。** 初稿只给 issue 侧建了首轮基线，评论侧漏了 —— 开启功能的第一轮
   会把每条指派 issue 上的历史评论各开一个会话。已修，且有专门用例钉住。

## 15. 探针覆盖（90 个用例里的相关部分）

| 文件 | 条数 | 管什么 |
|---|---|---|
| `tests/triggers.test.mjs` | 14 | 纯函数矩阵：基线、三类触发、自评、fail-safe、多类合成、冷却、配额 |
| `tests/watch.test.mjs` | 18 | 投递路径：请求形状、忙跳过、幂等、配额、失败、锁、重放、退避 |
| `tests/host.test.mjs` | +8 | 桥的 `watch.*` 操作：参数收敛、仓库只认绑定、错误码 |
| `tests/client.test.mjs` | +6 | 面板渲染、入口可达、三个按钮真打对应 op |

**没覆盖、只能人工验的**：真实 Gitea 上的端到端一例（真令牌 + 真会话服务），以及面板排版。
