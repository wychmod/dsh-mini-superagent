# Changelog

本文件记录 `dsh-mini-superagent` 的版本变化。版本号遵循 SemVer；`0.x` 阶段不保证 API 稳定，但工具名与配置键在 0.2.0 已冻结（见下）。

## 未发布

### 提示词：派发即移交，派发后结束本轮

两条规则各对应一次**被完整观测到的真实事故**，都是提示词没写清而不是能力缺失。

**① 派发后又自己重做（`src/prompt.js` `HANDOFF_RULE`，两种模式共用）**

事故：主会话把「只读定位某现象根因」派给子会话之后，自己又读了三个源码模块、跑了 30000 局模拟、
跑了候选手合法性穷举、开浏览器复现并截图、查了 git 历史、解析了历史录像——全是子会话正在做的事，
最后两边给出同一结论。

根因是旧执行条款只点名了 `write` / `edit` / `pwsh` / `bash`，**没点名读代码、搜索、跑脚本、浏览器、
网络请求**，模型就把它当成「别抢着改文件」，只读调查从这条缝里钻了过去。

现在判据从工具名换成意图归属：`dispatch_launch` 返回之后，该任务的任何执行环节
（读代码 / grep / glob / 跑脚本 / `node -e` / 开浏览器 / 查网络 / 验数据 / 看日志 / git 历史）
都不再由主会话进行；**只读调查同样属于移交范围**。主会话对该任务只剩两个动作：读报告、`dispatch_message`。
另加自检条款：正要做的操作与在跑任务重叠时，立刻停手、改为结束本轮。

**② 派发后原地干等（`src/prompt.js` `BACKGROUND_CONTRACT` + `src/tools.js` 工具描述）**

事故：同一场景里主会话连续调了约 10 次 `dispatch_wait`（180/240/300/180/180/180/120/120/180/240 秒），
累计约 33 分钟原地阻塞，期间零产出。

根因不是不知道它会阻塞（旧文案已写「`dispatch_wait` 是真的阻塞」），而是**没说清「结束本轮」就是正确动作**：
模型的推理是「用户问了问题 → 必须当场给出答案才能结束这一轮」，等待成了唯一出路。
旧判据「没有这个结果就完全无法继续下一步」也太软，模型总能证明自己「需要」结果。

现在：派发之后的**默认动作是结束本轮**，并明确「结束本轮 ≠ 没回答」（这一轮末尾说的话就是回答，
报告会回流并唤醒空闲会话）；`dispatch_wait` 的允许情形**绑定到用户原话**——只有用户在**同一条消息里**
明确要求「等结果再继续」才允许；逐条否定三种常见自我说服（「等一次看看」「等着省事」「问句必须当场作答」）；
显式禁止「用 `dispatch_wait` 代替结束本轮」，并把 33 分钟这个量级写进文本。

**③ 新增「有任务在飞时」的白名单（`IN_FLIGHT_ALLOWED`）**

只写「不要做什么」时模型在空档里无所适从，于是要么重做（事故①）要么干等（事故②）。
现在给穷举白名单：回答纯问答 / 派发下一批不冲突的任务 / 处理**已回流**的报告 / **以上都不是 → 结束本轮**。

**④ 工具描述同步（`src/tools.js`）**

工具描述是模型调用前真正读到的东西，影响力不比提示段小，所以一并改：
`dispatch_wait` 写明「默认不要调用」、唯一允许情形、禁止代替结束本轮、且「它不是 sleep」；
`dispatch_launch` / `dispatch_launch_many` 写明「派发即移交」与「接下来默认结束本轮」；
`dispatch_launch` 的返回值 `note` 也带上同一句话（那是离决策点最近的一手信息）。

**⑤ 新增 `test/handoff.test.js`（18 个用例）**

钉住上述文本不变量：只断言语义锚点（判据、禁用的反模式、白名单四条、两种模式共用同样的三段），
不断言整段排版——否则每次润色都要改测试，测试反而会被绕过。
包含两条真实回归：`dispatch_launch_many` 的描述漏了「结束本轮」、`dispatch_wait` 的描述漏了「不是 sleep」，
都是写测试时才发现的。

**⑥ 文档**

`docs/architecture.md` 新增 §25（事故形态、为什么枚举工具名不可行、为什么仍只做提示词而不加守卫）；
`docs/tools.md` 的 `dispatch_launch` / `dispatch_wait` 两节同步改写；`README.md` 的「工作方式提示」
与「已知限制」同步。同时删掉 `docs/tools.md` 里与新规则冲突的一句
（原文：`dispatch_launch`「别用：下一步马上需要结果——那就直接做，或用 `dispatch_wait` 但要接受阻塞」）。

### 任务看板改版：从「流水账」到「指挥台」

问题：原面板是一张按状态排序的平铺列表，只能回答「有哪些任务」，回答不了「派发到底带来了什么」
「现在哪条需要我」「这条为什么停住」。列表一长就成了记账本。

- **总览分三段**（`全部` 视图）：`需要你处理` → `在跑与排队` → `最近完成`。
  - 需要处理：failed / blocked / interrupted，按「失败优先、等得久的优先」排序，**行内直接给原因**；
  - 在跑与排队：同批次聚在一起，批次头给 `2/5` 进度条与计数；
  - 最近完成：默认 5 条，可展开。
- **效果条**：新增 `完成`、`成功率`、`平均耗时`（中位）、`并行节省` 四个数字，随工作区筛选联动。
  `并行节省` 是粗算（各任务耗时之和 − 实际墙钟），定义写在 hover 里。
- **并发条**：4px 进度条 + 排队 / 后台收尾计数，替代「只看两个数字猜还有没有空位」。
- **运行中任务**多一条「耗时 / 中位耗时」的细进度条，超过中位转橙——用来判断某条是不是跑偏了。
- **视图 chip 语义**：`全部` 现在是「总览」（三段），`进行中` / `需要处理` 只显示对应一节，
  `已归档` 是紧凑单行列表。计数口径不变。
- 活跃行不再重复显示「批次」徽标（批次头已经说明）；归档行只留标题、状态、耗时与时间。
- 保留的契约：行元素仍带 `dsh-sa-row` / `data-status` / `data-archived`，点行仍打开子会话；
  离线冒烟据此断言，并新增 6 条结构断言（三段、四个效果数字、原因、批次进度、两个异常标签）。
- 新增 [`preview/board-preview.html`](preview/board-preview.html)：真实面板组件 + 假数据，用来在宿主之外目视版式。

### 路由模式：主会话不能改代码

- **新增 `restrictRouter`（默认 `true`）与 `routerDenyTools`（默认 `["write","edit"]`）**（`src/dispatch.js` `enforceRouter()` /
  `syncRouter()`、`src/sessions.js` `restrictTools()`）：**「必派发」的会话**（输入框把派发目标设成某个工作区或「自动」）
  在它的 `agent.ctx` 上 `tools.restrict({ deny })`，模型看不到 `write` / `edit`，改代码只能派给子会话；
  把目标选回「不派发」时 `syncRouter()` 立刻把工具还回去。语义对齐上游 `dsh-superagent` 的
  `dsh-superagent-router` preset，但实现方式不同——我们的主会话是用户自己的会话、改不了它的 preset，
  作用域 `restrict` 是当前 API 里唯一能按 agent 收窄工具面的口子。

  四个必须记住的细节：
  0. **只对「必派发」生效**：任何会话都可能是主会话，而且「不派发」是默认选项。
     初版按「第一次派发」判定，等于派过一次就永久收走 write/edit——与产品语义冲突，已改。
  1. **worker 跳过**：worker 递归派发时 `table.byWorker(agent.id)` 命中，不收窄——否则它自己干不了活。
  2. **只 deny 真实存在的工具**：`restrict` 对未知名字直接抛错，所以先 `tools.get(name, agent)` 探一遍，缺哪个跳哪个。
  3. **可逆**：disposer 由 `SessionGateway.restrictDisposers` 持有，插件卸载或 `agent/disposed` 时收回；
     否则重载后主会话仍然看不到 write/edit，用户会以为插件坏了。

  边界说清：`bash` 默认保留，`echo > file` 仍能写文件（上游同样如此）。要硬边界就把它也加进 `routerDenyTools`。
  关掉整件事：`restrictRouter: false`，行为回到 0.8.1。
- **提示段同步**（`src/prompt.js` `ROUTER_LOCKED`）：已上锁的会话在 `SOFT_HINT` / `FORCED_HINT` 之后追加一段，
  点明「write/edit 已被收窄、改代码请派发」。模型看不到工具时的默认反应是「我做不到」或反复换写法，一句话能省一轮试错。

### 修复：`dispatch_launch` 的 `model` 参数被静默丢弃

`tools.js` 的工具描述承诺了 `model`，`dispatch.js` 也把它存进 `task.model`，但 `start()` 调用
`createWorker()` 时只传了 `agentPreset` / `permissionPreset` / `workspaceId` —— 这个参数**一路没有下文**，
用户以为在用便宜/更强的模型，实际用的是部署默认，且没有任何提示。

现在（`src/sessions.js` `applyModel()`）：接受 `model` 或 `provider/model`，经 `llm.resolveCallConfig` 解析后
在首个请求之前记一条 `model/selection`（与官方原型同样的做法，且避开会改全局默认的 `selectModel`）。
拿不到能力（没有 `llm.resolveCallConfig`、session 不支持 `append`）时**该次派发直接失败并回报原因**，
不静默降级——静默用默认模型比报错更贵。

### 修复：报告重试可能投两条

`#deliverWithRetry` 原来把 `nextMessageId()` 写在重试循环**里面**，每次重试换一个新 id。
只要「第一次其实已投进收件箱、只是后面抛错」，第二次就会用新 id 再投一遍，主会话看到两条一样的报告。

现在：`requestId` 在循环外算一次（三次重试逐字相同），重试前用 `SessionGateway.holds()`
查收件箱（`nextTurn`/`nextStep`）与会话历史（`user/message` 事件），命中就按已送达处理。
`relayRetryMs` 可配，默认仍是 2s/4s/8s。

### 对齐上游：恢复与容错四件事

四条都不改状态机（对照见 `plans/05-superagent-router-worker.md` §七）。

- **重启后排队任务重新入队**（`restore()`）：`queued` 且 `startedAt` 为空（说明 `createWorker()` 从没跑过）
  的任务保持 `queued` 并重新进队，`pump()` 接着跑；跑过的仍标 `interrupted`。
  0.8.1 及更早一律 `interrupted`，重启前排队的任务要人工重派——上游 `resume()` 会重排 pending，这里对齐。
- **瞬时故障续跑**（`onWorkerError()` / `resumeAfterError()` / `isTransient()`）：订阅 `agent/error`，
  408/429/5xx/连接类错误退避（默认 15s/30s/60s）后投一条「从中断处继续」，任务保持 `running`；
  次数用完或非瞬时错误走 `failTurn()` → `failed` + 回报。
  0.8.1 及更早没订这个事件：模型 5xx 之后 worker 走到 `idle`，被自动回报成 `ended`，
  主会话收到的是一条「本轮没有输出」，看起来像任务做完了。
- **读回执**（`onSessionEvent()`）：`dispatch_message` 投递成功后记 `inputPendingAt`，
  等 `session/event` 出现对应 `user/message` 才写 `inputReadAt`；只认 `msg`/`retry`，`relay` 不算。
  看板与 `dispatch_inspect` 因此能区分「已投递」与「已读」。
- **progress 节流**（`report()`）：同一任务 `progressRelayIntervalMs`（默认 60s）内的第二条不再回流，
  但仍入库。上游用通知合并，我们没有队列，退化成按时间节流；`0` 可关。
- **worker preset 暂不抄**：上游给 worker 一个把前台命令压到 5 秒的 preset，但 preset 的 `plugins`
  是完整清单、不继承，抄过来等于复制两百行绑定宿主包名的配置，宿主升级就碎。
  折中：新增 `workerAgentPreset` 配置 + worker 提示里要求「长命令用 `run_in_background` 或 `timeoutMs ≤ 30000`」。
- 新增配置：`retryTransient`、`retryBackoffMs`、`progressRelayIntervalMs`、`workerAgentPreset`；
  `selfCheck()` 回显 `router` / `delivery` / `retry` 三块，便于确认「配了但没生效」。

### 对齐上游：后台活占位、subagent 收窄、每任务目录

- **回合结束 ≠ 任务结束**（`handOffToBackground()` / `watchBackground()` / `backgroundOfWork()`）：
  `agent/status → idle` 时先看宿主 `jobs` 与 `subagents`，有活就不结算——任务继续 `running`、占着并发位、
  看板显示「后台收尾」；每 `backgroundPollMs`（默认 15s）巡检，清空后正常收尾；
  到 `backgroundLimitMs`（默认 30 分钟）终止剩余 shell job 再结算，并在兜底报告里写明终止数。
  0.8.1 及更早直接 `ended`，于是「留了个 dev server」的任务被判完成、槽位被释放，后台还在改同一个目录。
- **worker 的 subagent 收窄**（`decorateSubagent()`）：沿 `session.header.parentSession` 找最近的 worker
  （最多 8 层，防成环），找到就用 `restrict({ deny: TOOL_NAMES })` 收走全部 `dispatch_*`。
  subagent 保留读写与执行，但不能再派发/汇报——否则一个任务能无限往下派生，而 `maxTasksPerSession` 只算主会话。
  **没做**「任务结算后收走工作工具」：我们的 `dispatch_message` 允许续跑，收走会让续跑失效。
- **每任务目录 + prepare 命令**（新增 `src/prepare.js`）：配 `taskDirRoot` 后每个任务得到
  `<root>/<标题安全名>-<id后6位>`；目录不存在时在**父目录**跑一次 `prepareCommand`
  （环境变量 `DSH_DISPATCH_DIR` / `_TASK` / `_TITLE` / `_WORKSPACE` / `_CWD`），已存在则跳过。
  之后 `task.cwd` 指向任务目录，会话仍挂在目标/【派发】工作区，由 `enterDirectory()` 切进去。
  失败即 `failed` + 回报，**不建子会话、不自动重试**（目录可能已被写了一半）。
- 看板：任务卡新增 `task_dir` / `prepare_at` / `background` / `background_killed`，
  行内新增「后台收尾」「待读」两个徽标（`dsh-sa-tag-bg` / `-unread`）。
- 新增配置：`backgroundPollMs`、`backgroundLimitMs`、`taskDirRoot`、`prepareCommand`、`prepareTimeoutMs`。

### 验证

- `node --test` **158 个用例 / 152 pass / 6 cancelled / 0 fail**（新增 `test/router.test.js` 16 条、
  `test/recovery.test.js` 10 条、`test/background.test.js` 6 条、`test/subagent.test.js` 6 条、
  `test/prepare.test.js` 9 条；6 条 cancelled 是 `tasks.test.js` 里依赖父用例超时语义的既有用例）。
- 新增用例做了**变异验证**：把 `enforceRouter` 的 `byWorker` 跳过去掉，worker 用例立即失败；
  把 `requestId` 移回循环内，「重试复用同一 id」用例立即失败。

### 工作区放置

- **明确指定了目标工作区，子会话仍被塞进【派发】**（`src/dispatch.js`）：
  `placementFor()` 的判据原来是 `workerWorkspace === 'target' && target`，而 `workerWorkspace` 默认是 `day`，
  于是**用户选了目标也被默认值压掉**，每次派发都凭空多出一个 `【派发】YYYY-MM-DD` 工作区并登记到侧边栏。
  现在语义是「**有目标用目标，没有/找不到目标才退回日期工作区**」：目标存在就直接用，`workerWorkspace` 管不到；
  只有目标缺失或目标已被删除时才走兜底。
- **`workerWorkspace` 重新定义为「无目标时的兜底」**（`src/constants.js`）：
  取值从 `day` / `target` 改为 `day`（默认，当天【派发】）/ `cwd`（直接用任务 cwd，不建【派发】）。
  旧值 `target` 已废弃——它表达的「用目标工作区」现在是无条件默认行为——配成它会被
  `normalizeWorkerWorkspace()` 归一成 `day`，**不报错**（旧 profile 升级不该让插件起不来）。
- **日期工作区保持惰性创建**：`provision()` 只建默认工作区，从不建【派发】；`placementFor()` 也只在实际需要
  兜底时才调 `dayWorkspace()`。有目标的派发全程不碰它——这正是「不再凭空多出日期工作区」的前半段。

### 提示词：把「非阻塞」讲清楚

- **`FORCED_HINT` 的「派下去，然后结束本轮」误导了模型**（`src/prompt.js`）：
  这句话读起来像「派完就没事了」，既没交代派发是**非阻塞**的、也没交代报告会**自己回来**。
  结果是主会话倾向于原地等着看结果，或者干脆自己把活干了。

  现在把「机制契约」抽成共享常量 `BACKGROUND_CONTRACT`，`DISPATCH_HINT`（轻提示）与
  `FORCED_HINT`（必派发）**共用同一份文字**，从结构上杜绝两种模式各说各话（之前确实漂过）。
  契约明确四件事：
  1. 派发立即返回，派完就有空了，不要原地等；
  2. 但边界要诚实——`dispatch_wait` 是真阻塞，会等到超时；
  3. 报告不用取：它自动成为本会话的一条消息，在跑时下一步看到、空闲时被唤醒；
  4. 可以连续派多批，上一批没回来不是等下去的理由。

  注意：这**只是措辞修复**。派发本身在更早的版本里就已经是非阻塞的
  （`launch()` 从不 await 子会话），所以用户感知到的「卡死」来自模型行为被措辞误导，
  而不是机制缺陷。下面新增的行为级测试把「不阻塞」这件事钉成了运行时契约。

### 验证

- `node --test` **111 pass**（0.8.0 为 95；新增 `test/placement.test.js` 12 条 +
  `test/nonblocking.test.js` 4 条）。
- **行为级回归测试**（`test/nonblocking.test.js`）：不满足于断言提示词文本，而是真正驱动
  `dispatch_launch.execute`，用计时和「子会话那步尚未完成」两个信号证明它提前返回；
  另有三条覆盖并发不互斥、报告自动投递、`dispatch_wait` 确实阻塞。
  做了变异验证：把 `launch()` 尾部改成 `await this.pump()` 后，非阻塞用例立即失败；
  恢复后全绿。
- 工作区用例同样做了变异验证：把 `placementFor()` 回退成 0.8.0 行为后，
  6 条与目标相关的用例全部失败；修复后全部通过。所以这些用例钉的是缺陷本身，不是摆设。
- `verify-placement.mjs` 8/8：用假宿主驱动 `launch() → pump() → start()` 全流程，
  断言的是「子会话真被建在哪个工作区」，而不只是 `placementFor()` 的返回值。
- `verify-prompt.mjs` 36/36：断言两种提示都讲了非阻塞、报告回流、`dispatch_wait` 边界，且表述不矛盾。

## 0.8.0 — 2026-11-06

修掉 0.7.0 评审里剩下的 P1/P2。这些问题单个看都不致命，但都是「用久了会咬人」的类型：
越权读、报告丢失、排队错乱、额度永久锁死、提示注入、来源污染。

### 权限与安全

- **`dispatch_wait` 缺归属校验**（`src/tools.js`）
  同文件的 `inspect` / `message` / `cancel` 都校验了 `parentSessionId`，唯独 `wait` 没校验。
  后果：会话 A 传会话 B 的 `task_id`，能读到对方的标题、状态与报告摘要。
  顺带修掉同源的另一半：原来的 `.filter(Boolean)` 还会把**不存在的 id 静默吃掉**并返回
  `waited:false`，让调用方误以为等到了。现在两者都显式报错。
- **`dispatch_report` 的未知 status 让任务永远卡 `running`**（`src/tools.js`）
  schema 声明了 enum，但 execute 直接透传；传 `'finished'` 之类的值既不结算也不报错，
  任务永久占用并发位。现在入口处校验并列出允许值。
- **工作目录可伪造提示规则块**（`src/prompt.js`）
  `工作目录: ${task.cwd}` 未清洗，含换行的 cwd 能伪造出「工作规则」块并插在真规则**之前**。
  现在：结构化字段一律压成单行去控制字符；简报用围栏包住；**规则放到数据块之后**，
  并显式声明「与简报冲突时以规则为准」。
  风险等级要说清：不是远程漏洞（攻击面是能控制 `dispatch_launch` 参数的会话），
  但它破坏了数据/指令边界，而边界破了之后，任何让外部输入流进参数的功能都会变成真漏洞。

### 报告回流

- **报告投递失败无人知晓**（`src/dispatch.js`）
  `relay()` 的返回值被所有调用方忽略，「报告会自己回来」这个核心承诺其实是尽力而为。
  现在：失败按 2s→4s→8s 重试 3 次，结果记在 `task.delivery` 上，
  并通过 `card()` 的 `report_delivery` 暴露——失败的投递在 `dispatch_list` 与看板上一眼可见。
- **降级投递污染消息来源**（`src/sessions.js`）
  收件箱不可用时退回 `sessionController.prompt`，而它构造的消息来源是 `{kind:'user'}`，
  主会话会把报告当成用户亲口说的。现在降级时记 warn，并返回 `delivered:'prompt'`
  让调用方能区分；这直接违背了 `constants.js` 里「不会被误当成用户手打的消息」的注释。
- **`wake=false` 反而会唤醒对方**（`src/sessions.js` / `src/dispatch.js`）
  steer 对空闲 agent 会静默降级成 followup（唤醒），与「不打扰」的意图相反；
  且 `relay` 与 `deliver` 各有一套「目标在不在跑」的判据。
  现在判据只留一处，`wake=false` 走 `agent.inject()`（只追加下一步、不唤醒）。
- **批次成员被 retry 后三条回流路径全关**（`src/dispatch.js`）
  `groupClosed` 永不复位 + `report` 见 group 就 skip + `onWorkerIdle` 见 group 就 return，
  结果重试后的成员彻底静默。现在用独立的 `groupReopened` 标记放行，**不动** `groupClosed`
  （改动它会让 `maybeSummarize` 以为这批没汇总，重复发一条）。

### 状态与额度

- **`maxTasksPerSession` 永久锁死会话**（`src/dispatch.js`）
  原实现数 `ofSession().length`，而任务表只增不减：累计派发满 64 个之后该会话**再也不能派发**，
  即使全部 done、全部归档也不释放。这是「用着用着突然不能派了」的典型成因。
  现在 `quotaUsed()` 只数仍在册的任务：已归档的不计，已结算超过 24 小时的不计。
- **`waitFor` 对重复 id 要等满超时、且超时后不清理等待者**（`src/tasks.js`）
  `finishOne` 被 `Set` 去重但 `remaining` 按数组长度计，所以 `waitFor([a,a])` 里 a 结算后仍要等满超时；
  超时分支也从不摘除 `waiters`，长期不结算的任务会一直挂着 resolver。两者都已修。
- **`retry` 的 attempt 先自增后投递**（`src/dispatch.js`）
  投递失败时 attempt 已消耗、状态卡 `running`。现在投递成功后才记 attempt。
  同时区分「确定不存在」与「探不了」：原来的 `.catch(() => undefined)` 把任意异常都当成
  不可恢复，一次瞬时 `gateway/internal` 就会白白换掉 worker、历史断链。
- **`createWorker` 丢弃 `create()` 的返回值**（`src/sessions.js`）
  `create({sessionId})` 在会话已存在且非空白时**可能换号**，返回值里的 id 才是真的。
  原实现紧接着用请求里的 id 去 `resolveAgent`，换号时必然 not-found，任务 failed 而真会话成孤儿。
  现在以返回值为准，并同步回 `task.workerSessionId`。

### 文本与数据

- **`clip()` 在 `limit < 400` 时输出比上限还长**（`src/tasks.js`）
  原来是 `limit - 400` + `slice(-400)`，短 limit 下头部预算变负、尾部仍取 400，
  实测 `clip(1000 字, 200)` 返回 417 字。这类调用在 `reportText` 与 `card` 里都有，
  会把消息撑出上下文预算。现在按比例分配预算并做硬兜底。
- **简报落盘被截到 2000 字，retry 重投残版**（`src/dispatch.js`）
  重启读回的是残版，`retry` 的「重投原始简报」实际投的是被截断的任务描述，worker 无从得知。
  现在完整落盘（上限放宽到 `maxBriefChars × 2`），超过才截并留 `briefTruncated` 标记。

### 工作区

- **`safeDirName` 放过 Windows 保留名与尾部点号**（`src/workspaces.js`）
  `CON` / `NUL` / `COM1` 会让 `mkdir` 失败或建出非法目录；`abc.` 与 `abc` 会撞同一个目录。
  现在保留名按第一个点之前的部分判定并在点前插入 `-`（`CON.txt` → `CON-.txt`），
  尾部点号与空格在截断前后各清理一次。
- **`resolve` 的包含匹配会误命中短查询**（`src/workspaces.js`）
  `resolve('a')` 会命中「第一个含 a 的工作区」。现在单字符跳过包含匹配；多命中时
  记 warn 列出全部候选并返回 `undefined`，不再静默挑一个。
  同时补掉一个我自己方案里的坑：`resolve` 返回 undefined 后 `resolveOrCreate` 会把歧义
  当成「不存在」然后 `mkdir` 一个重复目录——比原 bug 更糟。现在新建前再判一次歧义。
- **绝对路径无脑 `mkdir -p`，可越界建目录**（`src/workspaces.js`）
  agent 只要把 `workspace` 写成绝对路径，插件就以 Host 进程权限在该路径建目录并注册，
  不受 `workspaceRoot` 约束且无任何痕迹。现在越界时记 warn 说明路径与工作区根
  （仍然创建——「可审计」优先于「可禁止」，但必须留痕）。

### 看板

- **`elapsed_ms` 语义错误**（`src/board.js`）：用 `startedAt → 现在`，已完成任务会一直增长，
  实测一个 26 小时前的 done 任务显示「26 时 0 分」。现在已结算的冻结在 `updatedAt`。
- **200 条截断无提示**（`src/board.js`）：任务数超上限时「总计 500 / 列表 200」看起来像数据丢了。
  快照新增 `truncated: {shown, total}`。
- `/target` 只校验 `session_id` 非空，任意字符串（含 `__proto__`）都会 200 并写进 targets 落盘；
  现在校验会话形状与存在性，不合法 404。
- 请求体超限时 `req.destroy()` 让客户端收到 ECONNRESET 而非 400；改为停止累积并正常返回 400。

### 验证

- `node --test` **95 pass**（0.7.0 为 74；新增 `test/p1-regression.test.js` 17 条 +
  看板新增 4 条）。
- 四个独立验证脚本全通过（共 70 项断言）：
  `verify-p0-fixes.mjs`（11）· `verify-lead-p1.mjs`（11）· `verify-surface-p1.mjs`（19）·
  `verify-workspaces-p1.mjs`（37）。

### 未做

- 未做真机视觉验收。
- 未引入错误码闭集（评审的 P1-13）：13 处 `throw new Error(中文)` 与看板手工状态码仍在，
  这是「文档漂移」与「状态码靠猜」的共同根因，但改动面横跨所有模块，单独一轮做更合适。

## 0.7.0 — 2026-11-06

修掉六个**可复现**的正确性 / 安全问题。它们都属于「平时看不出、出事很难查」的类型：
状态机没有单一入口、落盘不原子、看板准入判据可被绕过。全部有回归测试钉住
（`test/p0-regression.test.js`，16 条用例）。

### 修复（P0）

- **P0-1 看板准入可被 DNS rebinding 绕过**（`src/board.js`）
  0.6.0 的判据是「`Origin.host === Host` 即同源」，没有 `Origin` 时直接放行。
  但 `Host` 与 `Origin` 都由客户端决定：攻击者页面从 `http://evil.example:9735`
  加载（域名解析到 127.0.0.1）时两者都是 `evil.example:9735`，判据恒真。
  实测能读全部任务标题 / 工作目录 / 报告摘要，能归档、改派发目标、取消任务。
  现在：回环 Host 放行（并要求 Origin 也是回环或无 Origin），非回环 Host 默认拒绝、
  需显式写进 `BOARD_ALLOWED_HOSTS`；写操作另需自定义头 `x-dsh-mini-superagent`。
  **行为变更**：非回环地址的看板默认不可访问，需要显式放行。

- **P0-2 `settle()` 无幂等，状态可被任意覆盖**（`src/tasks.js`）
  0.6.0 的 `settle` 是裸赋值：`done` 能被 `settle('cancelled')` 改成 cancelled
  （看板点一下「取消」就能改掉已完成任务）；`index.js` 的 `agent/status` 分支
  更是无条件把任务写成 `running`，让 `done` / `cancelled` 复活、并发位被幽灵占用
  且永不结算。
  现在：新增 `TRANSITIONS` 跃迁表与 `transition()` 唯一入口，`settle` 对已结算
  任务直接返回 false；`index.js` 改为调用事实方法 `dispatch.workerTurnStarted()`。

- **P0-3 `dispatch_message` 先改状态后投递**（`src/dispatch.js`）
  投递失败时状态不回滚：已完成任务被打回 `running` 并永久占用并发位；
  对 `queued` 任务更糟——状态置 running 但没从队列摘除，排队顺序永久错乱。
  现在：先投递，成功后跃迁状态，失败则保持原状态并抛错。

- **P0-4 `cancel()` 与 `start()` 竞态留下僵尸 worker**（`src/dispatch.js`）
  `start()` 有多个 await（解析工作区、建会话、切目录、投递），期间取消任务时
  `agents.get()` 还是空的，`agent.cancel()` 被跳过，但会话照常被创建并投递简报。
  看板显示已取消，实际有子会话在烧模型额度。
  现在：每个 await 之后检查一次状态，已结算就中止启动并取消已建出的会话。

- **P0-5 落盘非原子，写坏即全部历史丢失**（`src/store.js`）
  原来是直接 `writeFile` 覆盖，进程在写入中途崩溃会留下半截 JSON，`restore`
  只 warn 然后以空表启动，用户无法区分「第一次装」和「数据被写坏了」。
  现在：`tmp` → `fsync` → `rename` 原子替换，保留 `.bak`，读时主文件损坏
  自动回退备份并标明 `recovered: 'bak'`；`Dispatch.persist()` 另加串行写链。

- **P0-6 「自动选择」目标重启后丢失**（`src/dispatch.js`）
  `restore()` 只恢复带 `workspace_id` 的目标，`auto` 目标被过滤掉。
  0.6.0 里 auto 还意味着「必派发」模式，所以丢失后会话会**静默退回「不派发」**
  （自己干活），行为反转且界面无提示。
  现在：`auto` 与具体工作区目标都被保留。

### 顺带修复

- `/target` 只校验 `session_id` 非空，任意字符串（含 `__proto__`、不存在的会话）
  都会返回 200 并写进 targets；现在校验会话形状与存在性，不合法返回 404。
- 请求体超限时 `req.destroy()` 让客户端收到 ECONNRESET 而非 400；改为停止累积
  并正常返回 400。
- `pump()` 串行 `await start()`：并发位是 6 但启动永远是 1，冷启动时延 ≈ N × 建会话时延。
  现在一次占满所有空位并行启动。
- `ctx.effect` 的 disposer 用 `void dispatch.dispose()`，宿主拿不到 Promise 不会等它，
  最后一段状态可能没落盘。改为返回该 Promise。

### 客户端

- 所有 fetch 带上 `x-dsh-mini-superagent` 头（写操作现在要求它）。
- 带该头的跨站请求会触发 CORS 预检，预检不带凭据也不带此头，服务端拒绝后真请求不会发出。

### 验证

- `node --test` **74 pass**（0.6.0 为 56；新增 `test/p0-regression.test.js` 16 条 +
  看板准入新增 2 条，同时移除了 1 条与新行为冲突的旧断言）。
- 独立探针 `verify-p0-fixes.mjs` 逐条复验：**11/11 通过**。
- 真实 `tasks.json`（12 个任务）可被新版正常读回；该文件的 `targets` 已为空，
  正是旧版每次重启丢弃 auto 目标的结果。

### 未做

- 未做真机视觉验收；看板界面与 `@` 菜单的观感仍需目视。
- 本轮只修 P0，评审列出的 20 条 P1 未动。

## 0.6.0 — 2026-11-06

把「派发」变成**会话级的模式开关**：默认不派发，选了任何具体目标就强制派发。

### 新增

- **「不派发」项**（`client/index.js`）：下拉第一项，也是默认勾选项。
  选中它 = 清除会话的派发目标，会话按普通方式自己干活，不创建子会话。
  `@` 菜单里也有（关键词匹配到「不派发 / 关 / none / off」时出现），选中不插入 chip、只清目标。
- **强制派发模式**（Host）：目标不是「不派发」时，该会话进入 `always` 模式，
  系统提示换成 `[dsh-mini-superagent 强制派发]` 段——
  除纯问答外，一切执行型工作都必须 `dispatch_launch` 派下去，
  且**本会话不得自己 write / edit / pwsh 去完成派下去的工作**（避免两处同时改同一项目冲突）。
- **动态提示段**（`src/sessions.js`）：`hint()` 改为注册**函数式文本**，DSH 每次装配系统提示都重新求值。
  切换模式只换求值函数，不重复注册段、不重载插件。
- `Dispatch.modeOf(sessionId)`：目标为 `auto` 或具体工作区 → `always`，否则 `off`。
  新增 `refreshHint` / `refreshAllHints`，并在 `agent/created` 与 `setTarget` 时触发。
- 常量 `NONE` / `MODE_OFF` / `MODE_ALWAYS`。

### 变更

- 下拉第二项是「自动选择」（原第一项），其后才是具体工作区列表；
  「跟随会话目录」并入「不派发」的语义（两者都清目标）。
- 触发器文案：没有目标时显示 `派发 → 不派发`（原「跟随会话」）；
  有目标时 title 提示「已开启必派发：除纯问答外，任务都派下去」。

### 验证

- `node --test` **56 pass**（新增 `test/mode.test.js` 6 条，覆盖模式判定与脏数据防御）；
  `node scripts/client-smoke.mjs` **81 pass**（新增不派发项、顺序、清目标等断言）。
- **真机双向验证**：设为具体工作区后，本会话系统提示当场出现 `[dsh-mini-superagent 强制派发]` 段；
  切回「不派发」后又变回 `[dsh-mini-superagent 工作方式]` 轻提示。切换无需重载插件。
- HTTP：`POST /board/target` 传 `""` 或 `"none"` 都返回 `{ok:true,target:null}`。
- **未做视觉验收**：两处菜单的新首项与文案仍需真机目视。

## 0.5.2 — 2026-11-06

`@` 派发目标菜单里加一条常驻的「自动选择」，不用手动翻列表。

### 新增

- **`@` 菜单首条「自动选择」**（`client/index.js`）：候选列表顶部固定一条，按输入的关键词给工作区打分，
  取第一名。命中时显示 `自动：<标题>`，无匹配时显示 `自动：没有匹配的工作区` 且 `value` 为空
  （点了不会静默什么都不做）。
- **打分规则**（`rankWorkspaces`）：只看用户看得见的东西，不做语义猜测——标题完全相等 100 /
  标题包含 40 / 目录名相等 30 / 目录名包含 15 / 路径包含 5；多关键词累加，同分按标题字典序。
  无关键词时全部同分（1 分），退化为按标题排序取第一，所以 `@` 后直接回车也能选到一个。

### 变更

- `@` 候选里「工作区」分组整体下移一位（首条让位给自动选择）；查询过滤逻辑不变。

### 验证

- `node --test` **50 pass**；`node scripts/client-smoke.mjs` **76 pass**
  （新增 6 条：首条是自动选择、无关键词时指向真实工作区、关键词命中时指向命中的那个、
  自动选择 onPick 产出正确 insert、无匹配时 value 为空、候选 = 自动选择 + 全部工作区）。
- 打分逻辑实测（典型输入 `""` / `sable` / `派发` / `mini` / `2026-11-06` / `不存在`）结果符合预期，
  已记入 `docs/composer.md`。
- 已装到 `desktop` profile，`inGraph = true`、`client.ready.ok = true`。
- **未做视觉验收**：菜单里这一条的实际观感（分组标题、与官方 `@reference` 混排）仍需真机目视。

## 0.5.2 — 2026-11-06

「自动选择」成为派发目标的默认模式，并在 `@` 菜单与输入框下拉两处都提供。

### 新增

- **派发目标新增 `auto` 模式**（Host）：`targets[sessionId] = { auto: true, title: "自动选择", path: "" }`。
  `dispatch_launch` 不带 `workspace` 时，按任务的 `title + brief` 前 200 字给所有工作区打分，
  取分数 ≥ 40 的第一名；挑不到退回默认工作区。显式 `workspace` 参数仍然优先。
- **打分逻辑搬到 Host**（`src/workspaces.js` 的 `rankWorkspaces`）：标题完全相等 100 / 标题包含 40 /
  目录名相等 30 / 目录名包含 15 / 路径包含 5；多关键词累加，同分按标题字典序。
  与 Client 侧共用同一套分值，不再两处各写一份。
- **输入框下拉第一项「自动选择」**（`client/index.js`）：带 `✦` 图标与一行说明，是默认勾选项；
  点它写 `workspace: "auto"`。原有「跟随会话目录」下移为第二项并补了说明文字。
- **`@` 菜单首条「自动选择」**：候选列表顶部固定一条，按输入的关键词打分取第一名；
  命中显示 `自动：<标题>`，无匹配显示 `自动：没有匹配的工作区` 且 `value` 为空（点了不会静默失败）。

### 变更

- `@` 候选里「工作区」分组整体下移一位（首条让位给自动选择）；查询过滤逻辑不变。

### 验证

- `node --test` **50 pass**；`node scripts/client-smoke.mjs` **79 pass**
  （新增 3 条：下拉第一项是自动选择、下拉里有该按钮、点它 POST `workspace:"auto"`）。
- **端到端实测**：把会话目标设为 `auto`，派发标题「sableos 项目目录结构梳理」的任务，
  `task.workspace_title = sableos`，子会话 `Get-Location` 返回 `D:\idea\sableos` ——
  自动识别生效，且落在预期工作区。
- 已装到 `desktop` profile，`inGraph = true`。
- **未做视觉验收**：两处菜单的实际观感（`✦` 图标、分组标题、与官方 `@reference` 混排）仍需真机目视。

## 0.5.1 — 2026-11-06

重启宿主后第一次真机验收时发现并修掉一个会误判「主会话丢了」的 bug。**功能面与 0.5.0 相同。**

### 修复

- **`sessionExists` 调了不存在的方法**：0.5.0 用 `sessionController.inspect(sessionId)` 判断默认主会话是否还在，
  但 `sessionController` 上根本没有 `inspect`（那是另一个服务的接口），调用直接抛 `TypeError`，
  被 catch 成「不存在」。后果是每次启动都以为 `mas-lead` 没了，重新 `create` 一遍；
  而 `selfcheck.lead.exists` 也永远报 `false`，看起来像会话丢了。
  - 现在改用 `state({sessionId}, signal)`（只读被动状态，不 resume Agent），并以 `list()` 兜底；
  - 返回 `{exists, error}` 而不是裸 boolean：`inspect`/`state` 抛错的原因不止「不存在」，
    权限、格式、读写失败都会抛，盲建会覆盖或冲突，所以「查不了」时只记 warn 并跳过创建。
  - `selfcheck.lead` 增加 `error` 字段，把失败原因暴露出来。

### 验证（真机，重启宿主后）

三层全绿，这是界面侧代码第一次在真实浏览器里被确认加载并执行：

| 层 | 命令 | 结果 |
| --- | --- | --- |
| 单元 | `npm test` | **50 pass** |
| 宿主集成 | `node scripts/http-smoke.mjs http://127.0.0.1:9270` | **26/26** |
| 客户端离线 | `node scripts/client-smoke.mjs` | **71/71** |

真机证据：

- `client.inGraph = true`，`path` 指向 `dsh-mini-superagent/client/index.js`；
- `client.ready = {ok: true, registered: ['sidebar.panellist','main','conversation.input.left','@workspace']}`，
  且 `ready.at` 晚于 `bootAt`（`17:36:27` > `17:36:25`），确认是本次实例的真实自报而非陈旧记录；
- 槽位注册表实测：`sidebar.panellist` 有 `dsh-mini-superagent.board`（order 60）、
  `conversation.input.left` 有 `dsh-mini-superagent/target`（order 60）、`main` 有 key `dsh-mini-superagent.board`；
- 系统提示里出现 `[dsh-mini-superagent 工作方式]` 段，确认 per-session 提示注入生效；
- 派发到「mini-superagent」工作区的任务，子会话 `Get-Location` 返回该工作区根目录；
- 磁盘上确认 `mas-lead` 的会话日志（`.dsh/sessions/--…mini-superagent--/mas-lead/session.v4.jsonl.zstd`）存在。

仍未做视觉验收（布局对齐、portal 翻转、深浅主题对比度、`@` 混排观感、草稿 chip 恢复），
这些需要人看，见 `plans/04-post-restart.md` 的目视清单。

## 0.5.0 — 2026-11-05

界面侧补齐：看板的归档视图/工作区筛选/跳转会话，输入框的「派发目标」选择器与 `@` 工作区。Host 侧增量是「每个会话的派发目标」与状态文件 v3。

### 新增

- **看板（Client）**：
  - 过滤 chip 3 → 4：`全部`（默认，**不含已归档**）/ `进行中` / `需要处理` / `已归档`；顶部「总计」显示 `counts.total − counts.archived`。
  - 归档行整行 0.55 透明度、灰点、无取消/重试按钮，显示 `已归档` 徽标与相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前）；`archive_error` 单独一行。
  - 顶部「立即归档」两步确认（首次点击进入确认态，4 秒无操作自动回落），调 `POST /board/archive`。
  - 每行显示 `workspace_title`（`null` → 「跟随会话目录」）；顶部工作区下拉与状态 chip 取交集；同 `group` 的行聚在一起并带「批次」徽标（服务端底序不变）。
  - 点行跳子会话：`ctx.get('uiWorkspace').openSession(worker_session_id)`，支持 Enter/Space；失败提示「打不开子会话 `<id>`：<原因>」；归档行先提示「可能已不在会话列表」但仍尝试打开。
- **输入框「派发目标工作区」选择器（Client）**：注册到 `conversation.input.left`（list / session），id `dsh-mini-superagent/target`、`order 60`、label「派发目标」；
  28px 高、`flex:none`、`max-width: min(260px, 45cqw)`；有目标显示 `派发 → <标题>`，无目标显示 `派发 → 跟随会话`；
  只在有活跃会话时渲染。下拉用 `createPortal` 挂 body + `position: fixed`，优先向上展开、左右夹在视口内；
  项为「跟随会话目录」/ 全部工作区（带路径与 ✓）/「刷新列表」；选中即 `POST /board/target`，失败把 Host 中文原因留在下拉里且不关闭；
  快照取不到时禁用并提示「看板服务不可用」。不轮询：挂载与每次打开各取一次（快照层另有 10s 缓存，供 `@` 复用）。
- **`@` 选择工作区（Client）**：`inputTriggers.registerSource({trigger:'@', name:'workspace', order:40, …})`，与官方 `@reference` 并存，
  候选分组「工作区」；选中同时设置 Host 目标并往草稿插 chip；`codec.serialize` 产出 `<workspace id="…" title="…"/>`，
  `codec.clipboardText` 为 `@<标题>`；chip 的 `appearance` 故意省略（只认 session/file/folder，传别的会导致整条草稿恢复时被清空）。
  `inputTriggers` 服务缺席时 `@` 不出现，看板与控件照常。
- **Host 增量**：
  - `POST /dsh-mini-superagent/board/target`：body `{session_id, workspace}`（空串=清除）；成功 `{ok, target}`，缺 `session_id` 400，解析失败 409 并给候选。
  - 快照新增 `targets:{[sessionId]:{workspace_id,title,path}}`；任务卡新增 `workspace_id` / `workspace_title` / `archived_at` / `archive_error` / `group`（其中 `workspaces` / `counts.archived` 已在 0.4.0）。
  - `dispatch_launch` 没显式给 `workspace` 时用该会话的派发目标；目标失效只 warn 并退回调用者目录（不会凭选择器新建目录）。
  - 状态文件升到 `version: 3`：`{tasks, targets}`；旧文件缺 `targets` 按空处理。
- `docs/composer.md`：派发目标选择器与 `@` 工作区的说明。

### 变更

- 版本 `0.4.0` → `0.5.0`；`client/index.js` 从 1017 行扩到 **2055 行**（看板 UI 与输入框控件同属 0.5.0）。
- 看板「全部」不再包含已归档任务；顶部「总计」同步减去归档数。归档任务只出现在「已归档」chip。
- 单测从 43 → **50**（`tasks` 13 + `board` 26 + `workspaces` 11）。

### 验证

- ✅ `npm test`：50 pass / 0 fail（board 新增 7 个用例：工作区列表与归档计数、`/archive`、`/target` 设置/清除/缺参/解析失败、快照 `targets`）。
- ⚠️ 界面**未在真浏览器里跑过**（客户端模块要页面重载才挂载）：控件在工具行的对齐与截断、弹层翻转与边缘夹取、
  `@` 与官方 `@reference` 混排观感、chip 刷新后能否从草稿恢复、`openSession` 成功后视图是否真切换、深浅主题对比度、
  `not-listed` 的真实错误码，均未验证。

### 限制

- 派发目标是「下一次 `dispatch_launch` 的目标」，不是会话归属；DSH 会话的工作区建完不可迁移。
- 选择器只在有活跃会话时渲染；空白/hero 会话看不到。
- `@` chip 的 `appearance` 是闭集（session/file/folder），所以插件只插裸 chip，不能自定义图标/颜色。
- `@` 选中时设置目标失败没有可挂错误的位置，只 `console.warn`；控件下次取数会显示真实目标。
- 没显式 `workspace` 而目标已失效时，任务退回调用者目录，只记 warn。

## 0.4.0 — 2026-11-05

新增**工作区**能力：默认工作区 + 按天【派发】工作区 + 按工作区派发 + 自动归档，工具从 8 个变成 9 个。

### 新增

- `src/workspaces.js`（约 160 行）：`defaultRoot` / `rootOf` / `dayKey` / `dayTitle` / `safeDirName` 与
  `WorkspaceGateway`（`ensure` / `defaultWorkspace` / `dayWorkspace` / `createNamed` / `list` / `resolve` /
  `resolveOrCreate` / `archiveSession`）。`resolve` 顺序：工作区 id → 绝对路径 → 标题精确（大小写不敏感）→ 标题包含。
- **启动准备**（`Dispatch.provision()`，幂等）：建 `<workspaceRoot>` 并注册标题 `mini-superagent` 的工作区；
  在其中建固定 id 的默认主会话 `mas-lead`（标题「mini-superagent 主会话」）。已存在就跳过，失败只记日志。
- **按天【派发】工作区**：`<workspaceRoot>/派发/<YYYY-MM-DD>`，标题 `【派发】YYYY-MM-DD`。
  子会话默认放这里（`workerWorkspace: day`）；`target` 模式放进任务的目标工作区。
  会话建好后调 `workingDirectory.set` 把工作目录切到任务目标目录——会话住【派发】，活干在目标目录。
- **`dispatch_launch` / `dispatch_launch_many` 新参数**：`workspace`（id / 绝对路径 / 标题）与
  `create_workspace`（默认 true；绝对路径就地建，名字在工作区根下建）。解析不到且不允许新建时抛错并列出已有工作区。
- **新工具 `dispatch_workspaces`**（只读）：返回 `root`、`worker_workspace`、`archive_after_hours`、`count` 与
  `workspaces[{workspace_id,title,path,sessions}]`。工具总数 8 → 9。
- **自动归档**：每 `archiveSweepMinutes`（首次延迟 20 秒）把已结算且 `updatedAt` 超过 `archiveAfterHours` 的子会话
  `workspaceRegistry.archiveSession(id, {stopActivity:true})`；成功记 `archivedAt`，失败记 `archiveError` 并重试。
  已取消任务也能归档；归档只影响会话列表，不动任务表与看板。
- **看板**：快照新增 `counts.archived` 与 `workspaces:[{id,title,path}]`；任务卡新增
  `workspace_id` / `workspace_title` / `archived_at` / `archive_error`（以及批次 `group`）；
  新增 `POST /dsh-mini-superagent/board/archive` 手动跑一次归档巡检，返回 `{ok, scanned, archived, failed, counts}`。
- **批次汇总**：`dispatch_launch_many` 的整批任务共用一个 `group`，全部结算后给派发者发一条汇总，而不是 N 条流水。
- 新增 6 个配置：`workspaceRoot`、`provisionDefaultWorkspace`、`workerWorkspace`、`archiveAfterHours`、
  `archiveSweepMinutes`、`leadSessionId`。
- `test/workspaces.test.js`（11 个用例）；全量单测 32 → **43**，全过。
- `docs/workspaces.md`：工作区模型、目录约定、解析规则、归档策略、限制与排障。

### 变更

- 版本 `0.3.0` → `0.4.0`；`dispatch_list` 与看板快照的 `version` 同步。
- 任务新增 `workspaceId` / `workspaceTitle` / `archivedAt` / `archiveError` / `group` 字段，随任务表落盘。
- `dispatch_list` 卡片新增可选 `workspace`（工作区标题）与 `archived_at`。
- `dispatch_launch_many` 返回值新增 `group` 与 `note`。
- 没指定 `workspace` 时，工作目录仍沿用调用者目录，但子会话默认挂到当天【派发】工作区（0.3.0 是按目录反查工作区）。

### 限制

- `workspaceRegistry.create` 要求目录已存在：插件先 `mkdir -p`。目录不可写时默认工作区创建失败（只记日志），
  显式指定 `workspace` 的派发会报错。
- 同时给 `workspace` 与 `cwd` 时，工作区路径优先，`cwd` 被忽略。
- 归档失败没有退避，每轮巡检都会重试；`archive_error` 只在看板快照里，`dispatch_list` 看不到。
- 看板 UI 本轮未改，不展示工作区字段与归档字段，也没有归档按钮。

### 验证

- ✅ 启动准备：`dispatch_workspaces` 返回默认工作区且 `sessions: 1`，磁盘目录已创建。
- ✅ 会话/工作目录分离：子会话 `Get-Location` 返回目标工作区根，而会话挂在【派发】工作区下。
- ✅ 自动归档：临时 `archiveAfterHours=0.001` / `archiveSweepMinutes=0.05`，约 20 秒后 4 个任务归档
  （`counts.archived: 4`）；`POST /board/archive` 返回 200，再次调用 `scanned: 0`；配置已改回 24h / 10min。
- ✅ `npm test`：43 pass / 0 fail（tasks 13 + board 19 + workspaces 11）。

## 0.3.0 — 2026-11-05

新增常驻侧边栏的**任务看板**（Host HTTP + 浏览器面板）与**看板重试**。工具面不变，仍是 8 个 `dispatch_*`。

### 新增

- `src/board.js`（Host，约 200 行）：看板快照与三个同源 HTTP 路由——
  `GET /dsh-mini-superagent/board`（快照，`cache-control: no-store`）、
  `POST /dsh-mini-superagent/board/cancel`、`POST /dsh-mini-superagent/board/retry`。
  快照包含 `version`、`generatedAt`、`concurrency`、`counts` 与最多 200 条拍平任务；
  排序 `running` → `queued` → 其余按 `updated_at` 倒序。
- `client/index.js`（浏览器，1017 行）：plain ModuleLoader 包（`window.__ModuleLoader__.load(...)`，React 从 `require('react')` 取）。
  向 `sidebar.panellist` 注册「任务看板」图标（`id` = `dsh-mini-superagent.board`，`order 60`），向 `main` 注册同名面板。
  2 秒轮询、页面隐藏暂停并 abort、`prefers-reduced-motion` 关闭脉动、颜色走 `var(--dsw-alias-*, fallback)`。
- `Dispatch.retry(task)`：看板「重试」的服务端实现。`attempt` 从 1 开始、每次 +1；
  会话可恢复则续跑同一会话（`done` 的指令是「再执行一次」），不可恢复则换 `dispatch-<taskId>-a<attempt>` 并重投原始简报。
  `running` / `queued` / `cancelled` 拒绝重试（409）。
- `test/board.test.js`：19 个用例（快照 8 + 路由 11，用假 `req`/`res`）；全量单测 13 → **32**，全过。
- `docs/board.md`：看板入口、面板结构、接口契约、重试语义、鉴权与限制。
- `package.json`：`exports` 增加 `./client`，`files` 加入 `client`，新增 `dsh.client` 清单
  （`platform: web`、`immediately: true`、注入 layout/sidebar 两个客户端包）。

### 变更

- 版本 `0.2.0` → `0.3.0`；`dispatch_list` 与看板快照里的 `version` 同步。
- 任务对象新增 `attempt` 字段（默认 1），随任务表落盘；旧任务读回按 1 处理。
- README 增加「任务看板」小节与升级后刷新页面的说明。

### 安全

- `GET`：本机回环（`127.0.0.1` / `localhost` / `::1`）放行；非回环必须是同源页面（`Origin` 与 `Host` 一致），否则 403。
- `POST`：带 `Origin` 时必须与 `Host` 一致，跨站 403 且不产生副作用；不带 `Origin` 的客户端（curl/脚本）放行。
- 原因：插件注册的具名路由排在 DSH 页面鉴权之前；全放开会在 Web 暴露到局域网时泄露任务标题、工作目录与报告摘要。
  代价：远程 `curl` 读不到快照；远程只能通过同源页面使用看板。

### 验证

- ✅ `GET /dsh-mini-superagent/board` 返回 200、`cache-control: no-store`、`version: 0.3.0`、3 条任务。
- ✅ 对失败任务 `POST /board/retry` 返回 200，`attempt` 从 1 变 2，任务转 `running`；worker 恢复会话后再次
  `dispatch_report`，第 2 次汇报已回流主会话。
- ✅ `npm test`：32 pass / 0 fail。
- ⚠️ **未实测**：面板在浏览器里的实际渲染（侧边栏图标位置、点击切换、明暗对比度、窄宽度截断、面板高度、轮询暂停）。
  原因：客户端模块需页面刷新后才加载，而 GUI 页面有鉴权，无法代刷。装完/升级后需手动刷新一次 GUI 页面。

### 兼容性

- 8 个工具名、参数 schema、配置键与默认值不变；看板不新增工具。
- Host 侧依赖 `webServer`：headless 形态没有该服务时跳过路由注册，派发与工具不受影响。
- 升级后需刷新一次 GUI 页面，侧边栏才会出现「任务看板」图标。

## 0.2.0 — 2026-11-05

改名 + 多模块重构。功能面与 0.1.0 一致，修掉一个队列推进缺陷。

### 变更

- **改名**：`dsh-dispatch` → `dsh-mini-superagent`。`package.json` 的 `name`、插件 `name`、bundle patch 的 `id` 一起改。
- **拆分模块**：单文件 `index.js`（853 行）拆为 `src/` 下的 8 个模块——`index.js`（入口/事件接线）、`constants.js`（标识与默认值）、
  `tasks.js`（`TaskTable` 纯逻辑 + 纯函数）、`store.js`（落盘/读回）、`sessions.js`（DSH 适配）、`prompt.js`（给模型的文本）、
  `tools.js`（8 个工具）、`dispatch.js`（`Dispatch` 服务）。拆分轴见 `docs/architecture.md`。
- **状态目录改名**：`<DSH_HOME>/dsh-dispatch` → `<DSH_HOME>/dsh-mini-superagent`。
- **消息来源 kind 改名**：`dsh-dispatch` → `dsh-mini-superagent`（`source: {kind, form:'relay'}`）。
- **系统提示段名改名**：`dsh-dispatch` → `dsh-mini-superagent`；段首行相应变为 `[dsh-mini-superagent 工作方式]`。
- **日志前缀改名**：`dsh-dispatch:` → `dsh-mini-superagent:`。
- **状态文件结构版本**：`version: 1` → `version: 2`（读取时不强校验，旧文件仍能读）。
- 版本号改为从 `constants.js` 单点导出，`dispatch_list` 返回 `version: 0.2.0`。

### 新增

- `test/tasks.test.js`（Node 内置 test runner）+ `npm test`（`node --test`，自动发现 `test/*.test.js`），覆盖 `TaskTable` 与纯函数。
- `src/constants.js`：名称、版本、日志前缀、来源 kind、提示段名、状态目录、默认配置、状态集合、任务 id 与消息 id 生成集中在同一处。
- `TOOL_NAMES` 导出：8 个工具名的单一清单，便于核对注册是否齐全。
- `Dispatch.settle(task, status)`：统一结算入口，内部 `table.settle()` 后立刻 `void this.pump()`。
- `package.json` 的 `files` 随目录结构调整为 `src/`，并加入 `CHANGELOG.md` 与 `LICENSE`；新增 MIT `LICENSE` 文件。

### 修复

- **结算后不推进队列**（0.1.0 遗留）：0.1.0 只在 `launch()` 与 `apply()` 调 `pump()`，并发位满时排队的任务要等下一次派发或插件重载才动。
  现在 `report()` 终态、`onWorkerIdle()`、`cancel()`、`agent/disposed` 都经 `Dispatch.settle()` 触发 `pump()`；
  `pump()` 自己的失败分支改用 `table.settle`，避免自递归。
  实测：`maxWorkers=1`，A 慢任务结算于 13:05:53，B 快任务在 13:05:57 自动从 `queued` 转 `running`，期间无新派发。
- **并发 pump 可能超发**：`TaskTable.takeRunnable()` 改为在返回任务前同步置 `running` 占位，不再由调用方启动时补状态。

### 兼容性

- **不变**：8 个工具名（`dispatch_launch` / `dispatch_launch_many` / `dispatch_list` / `dispatch_inspect` / `dispatch_message` /
  `dispatch_cancel` / `dispatch_wait` / `dispatch_report`）、参数 schema、配置键与默认值、状态机语义、报告协议。
- **变了**：包名、状态目录、消息来源 kind、系统提示段名、日志前缀——按名字过滤日志或脚本的地方要跟着改。
- **不能并存**：不要同时安装 `dsh-dispatch` 与 `dsh-mini-superagent`，8 个同名工具会在同一全局层重复注册并抛错。
- **不自动迁移**：`tasks.json` 不会从旧目录搬过来；需要历史列表就手工复制到新 `stateDir`。未结算任务读回后仍标 `interrupted`。

### 验证

- 0.2.0 重装后重验：安装 + 8 工具注册（`version: 0.2.0`）、派发 → 执行 → `dispatch_report` → 回流。
- 0.2.0 新增并发排队实测（`maxWorkers=1`，一慢一快两个任务）。
- 0.1.0 的 8 条实测记录保留在包 README 的「验证记录」里，标注了版本口径。

## 0.1.0 — 2026-11-05

首个版本，单文件 Host 插件，原名 `dsh-dispatch`。

### 新增

- `dispatch_launch` / `dispatch_launch_many` / `dispatch_list` / `dispatch_inspect` / `dispatch_message` / `dispatch_cancel` /
  `dispatch_wait` / `dispatch_report` 共 8 个工具，注册在插件根 context（全局可见），角色靠「调用者是不是已登记的 worker」判定。
- 任务即 Session：`sessionController.create` + `resolveAgent` 建后台子会话，标题 `[派发] <title>`，会话 id `dispatch-<taskId>`。
- 报告回流：自造插件来源的 user message（`kind: dsh-dispatch`），经 `agent.steer()` / `agent.followup()` 投递，
  主会话空闲时唤醒、忙碌时并入下一步；收件箱失败降级到 `sessionController.prompt`。
- `agent/status` 监听：worker 回合结束且本回合没有终态报告时，抓最后一条 assistant 文本自动回报。
- `agent/disposed` 监听：子会话被关闭时把未结算任务标 `interrupted`。
- 并发上限与排队：`maxWorkers` 默认 6，超出进 `queued`，由 `pump()` 按登记顺序启动；该版本的 `pump()` 只在派发与插件加载时运行（缺陷见 0.2.0「修复」）。
- 7 个配置项：`maxWorkers`、`maxTasksPerSession`、`inheritWorkingDirectory`、`permissionPreset`、`stateDir`、
  `reportOnTurnEnd`、`maxBriefChars`，默认值见 `constants.js` 的 `DEFAULTS`。
- 落盘：`<DSH_HOME>/dsh-dispatch/tasks.json`，800ms 防抖，重启读回；未结算任务标 `interrupted`。
- 首次派发时向该会话注入 `[dsh-dispatch 工作方式]` 系统提示（段名 `dsh-dispatch`，`order: 9998`）。
- `cordis.patch.yml` 插入插件行并提供默认配置；`locale/{zh,en}.json` 提供管理面板里的标题与描述。

### 验证

在 `desktop` profile 上实测通过 8 条：安装与工具注册、派发 → `dispatch_report(done)` → 回流、漏报告自动回报（`PONG-OK`）、
`dispatch_wait` 阻塞至结算、对已结算任务追问再汇报、取消长任务、重启恢复、主会话空闲时被报告唤醒（20 秒）。
