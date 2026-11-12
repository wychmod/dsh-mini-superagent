# Changelog

本文件记录 `dsh-mini-superagent` 的版本变化。版本号遵循 SemVer；`0.x` 阶段不保证 API 稳定，但工具名与配置键在 0.2.0 已冻结（见下）。

## 未发布

### 新增：任务级计划透出（PRD-01）

worker 可以在报告里写「这条任务分几步、走到哪一步」：`dispatch_report` 新增可选 `plan`，
看板据此在任务行显示 `2/5`、在抽屉里显示当前步骤。**计划只写 `task.plan`，不写进每条 report entry**
——`MAX_REPORTS = 50`，12 步 × 50 条会把账本放大一个量级，而看板只需要「最新一版」，历史计划没有决策价值。

- 形状 `[{ text, status }]`，`status ∈ pending | doing | done`（未知值按 `pending`，空文案丢弃，
  完全相同的文案最多留 3 条）；上限由新增配置 `maxPlanSteps`（默认 12）/ `maxPlanStepChars`（默认 120）
  决定，超限**截断不报错**，返回值给 `plan_accepted`（这一版是否落地）与 `plan_truncated`（是否因超限截断）。
- **整版替换**，不做增量合并（worker 不需要维护 step id）；内容与当前计划完全相同视为幂等，
  不刷新 `planUpdatedAt`、不额外写盘。
- **不参与投递 / 合并判定**：`projectReport()` 不读 `plan`，准入（`admissionOf()`）也不看它，
  所以**不新增任何会话消息**——计划只是账本上的附属事实。
- 看板任务行显示 `plan_done / plan_total`，抽屉显示 `plan_current`（优先取 `doing`，没有就取第一条
  `pending`；全 `done` 时是空串）；**已结算任务不下发 `plan_*`**（显示优先级：终态 > 计划 > 报告数），
  计划本身仍留在账本里。
- 终态报告可以带计划：先应用、再结算，结算后冻结（`#applyPlan()` 对 `queued` / 终态返回 `false`，
  迟到的 `progress` 带计划只会拿到 `plan_accepted:false`）。
- 尚未实现：PRD-01 §6 的「计划更新后显示『计划已更新』一次」——当前客户端没有这个提示，
  缺口与验收落点见 [`../plans/README.md`](../plans/README.md)。

### 新增：批次依赖（`depends_on`，PRD-02）

后一步可以等前一步：`dispatch_launch` 增 `depends_on`，`dispatch_launch_many` 的 item 增
`depends_on` / `depends_on_index`（批内下标，服务端替换成真实 task id）。**依赖在任务开始前判定**，
被等的任务没结算就一直排队，不占 `maxWorkers`；前置失败/取消时后继被**连带取消**并写
`cancel_reason` / `error_code`，不会自动改派。

- 不新增任务状态：等待仍是 `queued + blockedBy`，连带取消仍是 `cancelled`；`TRANSITIONS` /
  `SETTLED` / 统计分母 / 看板状态色都没有动。
- 任务新增 `dependsOn` / `blockedBy` / `blockedReason` / `cancelReason` / `errorCode`，随账本原样落盘；
  重启后在第一次 `pump()` 之前做一次收敛（前置 `interrupted` / 缺失 → 后继取消），
  不会出现「没等就开跑」。
- 看板新增五个短字段（`depends_on` / `blocked_by` / `blocked_reason` / `cancel_reason` / `error_code`）；
  任务行「依赖 2 / 等 A / 前置失败」、抽屉「前置：A、B」「当前等待：A（运行中）」「未执行原因：前置 A 失败」、
  批次头「3 个成员 · 1 个等待前置 · 1 个未执行」。
- 错误码新增 `UNKNOWN_DEPENDENCY` / `DEPENDENCY_CYCLE` / `DEPENDENCY_FAILED` / `DEPENDENCY_MISSING`；
  配置新增 `maxDependsOn`（默认 8，超限报错、不静默截断）。
- 兼容：不传依赖时任务形状与行为与 0.8.x 逐字相同（`takeRunnable` 的谓词默认恒真）。

### 更名：任务看板 → 派发工作台（英文 `Dispatch Workbench`）

用户拍板的**纯展示名**改动，不改任何内部标识：

- 改的：`client/index.js` 的 `TEXT.title` / `TEXT_EN.title`、`sidebar.panellist` 注册时的
  `label`，以及把它当产品名说的用户可见文案——分析视图切换条（`an.surfaceTasks`）、
  切换条提示（`an.surfaceHint`）、加载提示（`an.loadingHint`）、错误态返回入口（`an.backTasks`）；
  两个 `README.md`、`docs/board.md`、`preview/board-preview.template.html` 同步更名。
- 不动的：路由 `/board*`、`BoardSnapshot` / `boardTask` 等字段、`createBoardHandler` /
  `registerBoardRoutes`、`sidebar.panellist` 的 `id`（`dsh-mini-superagent.board`）、
  `TEXT` / `TEXT_EN` 的键名与键集合、`dsh-sa-*` 类名、文件名（`docs/board.md`、`src/board.js`、
  `preview/board-preview.*`）。本文件里 0.3.0 以来的历史记录保持原样（那是历史事实）。
- 生效方式：**不需要重启宿主**——客户端半边是页面加载的模块，改写 `client/index.js` 只换模块
  rev（`plans/03-client-graph.md` §3.5 已按 `rebuilt(id)` 实测口径写明）。刷新一次 GUI 页面
  必定生效；宿主若接了客户端 HMR，也可能不刷新就换掉。

### 变更：自动归档保留期 24 小时 → 168 小时（7 天）

用户反馈「看板隔一天就空了」：`archiveAfterHours` 默认 24 小时，昨天结算的任务
第二天就被 `archiveStale()` 归档，而看板「全部」chip 不含已归档任务。

- `DEFAULTS.archiveAfterHours`（`src/constants.js`）与随包 `cordis.patch.yml`
  同步改为 `168`；README / `docs/workspaces.md` / `docs/tools.md` / `docs/board.md`
  里的默认值描述一并更新，0.4.0 的历史实测记录保留原值并加注。
- 看板总览为空时新增提示「还有 N 条历史已归档，可在『已归档』查看」：N 取快照
  已有的 `counts.archived`，不新增接口；`client/index.js` 的 `TEXT` / `TEXT_EN`
  各加一条 `emptyArchivedHint`。
- 这是 **bundle 配置层**的改动：配置在宿主启动时读取，运行中的进程不会自动重读，
  因此需要重启宿主后 `dispatch_workspaces` 的 `archive_after_hours` 才会变成 168。

### 修复：截断标记误报、热重载误判与依赖准入绕过（2026-11-12）

三条都是「语义前提错了，代码按前提执行得很正确」，根因与修法分别记在下面。

**截断标记误报「摘要已截断」（`src/board.js`）**

- 根因：判据只看 `entry.truncated` 的真假，把「`detail` 被裁」也算成「摘要被裁」。真实账本里 32 条被裁条目
  **100% 只裁了 `detail`**（入库上限 4000），而看板行展示的 `summary`（上限 6000）一条都没被裁过——于是每一行都在说
  「摘要已截断」，一句没发生的话。
- 修法：`boardTask()` 新增 `truncated_fields` 投影（`summary` / `headline` / `detail` / `brief`，按展示顺序去重），
  界面据此分段提示；`has_truncated` 原样保留，旧客户端行为不变。

**热重载把仍在跑的 worker 判成 `interrupted`（回归 t-mwcbmq2a-2，`src/dispatch.js`）**

- 根因：`restore()` 的前提是「进程重启 ⇒ 没有活的 worker」，而**插件热重载**只换插件实例、宿主的子会话与它正在跑的
  回合都还在。于是 `running` 被改写成 `interrupted`（并写下 `settledAt`），worker 之后报的 `done` 被
  `TaskTable.settle()` 的幂等挡掉，账本永远停在「已中断」；完成率、并发位、看板全错，后继还会被
  `#failDependents()` 连带取消。
- 修法：新增 `#liveWorker()`（只问 `ctx.agents` 活引用，活会话且不是 `idle` 才保留），恢复时不再判死；报告到达时
  撤回那条假定的 `interrupted` 再走正常结算；存量数据按「晚于 `settledAt` 的终态报告」在恢复时自愈，结算时刻取报告自己的时刻。

**依赖准入被 `dispatch_message` 绕过（`src/dispatch.js` / `src/tools.js`）**

- 根因：`message()` 只挡 `cancelled` / `archived`，不看 `blockedBy`；而它后面的 `transition(force)` 会把任务直接改成
  `running` 并摘出队列——用户看到「还在等 A，B 却开跑了」，声明好的先后顺序被一条追问打乱。
- 修法：投递前用 `#blockedStateOf()` 现算一次，被挡就以 `dispatch/conflict` 拒绝，状态与队列原样不动；
  `dispatch_message`、`dispatch_launch({continue_task_id})` 与看板续派三条入口同时受约束（`dispatch_wait` 只等结算，不受影响）。
  工具描述与 `docs/tools.md` 的错误表同步说明。

### 修复：后台活生命周期、账本落盘与契约一致性（评估 P0）

依据 `analysis/assessment-and-roadmap-2026-11-10.md` 的 P0 清单与
`analysis/session-evaluation-2026-11-08.md` 的行为探针，一次修掉「代码在、
语义没闭环」的几条。全部是修复，不新增功能。

**后台活三条 P0（`src/dispatch.js` / `src/index.js`）**

- **终态报告不再绕过门禁**：`dispatch_report(status:'done'|'blocked'|'failed')`
  原先直接 `settle()`，只有 `onWorkerIdle()` 才查后台活。现在先记
  `task.pendingTerminal` 并走 `handOffToBackground()`：有活就不结算，报告照常
  入库回流，返回里多一个 `deferred:true`；巡检收尾时按 worker 自己报的终态
  结算，不退化成 `done`，也不再发「没给结论」的兜底回报。
- **取消会终止后台活**：`cancel()` 先 `await killBackground(task)` 再结算。
  subagent 没有可验证的终止接口，明确记在 `task.backgroundNote` 并 warn，
  不假装停干净了（此前 `jobs.kill` 实测调用 0 次）。
- **重启接管巡检**：`restore()` 读到 `task.background` 时先问宿主还有没有活，
  有就记进 `pendingBackgroundWatchers`；`apply()` 在 `pump()` 之后调
  `resumeBackgroundWatches()` 重挂。两个可选服务尚未就绪时保留这条事实，
  不把它抹成 `interrupted`。
- **一行缺陷**：`killBackground()` 漏了 `await jobs.list(sessionId)`，
  `Array.isArray(Promise)` 恒 false，一个 job 都杀不到却对外宣称已终止。
- 新一轮开始时 `workerTurnStarted()` 清掉 `pendingTerminal`，避免上一轮的
  结论串到下一轮。

**账本与投递（`src/dispatch.js`）**

- 新增 `persistCritical()`：清掉 800ms 防抖定时器并 `await persist()`。
  结算、报告、派发登记、追问、取消、后台活变更、失败回合都等写完再返回——
  既消除「已 `dispatch_report done` 却仍读到 `running`」的窗口，也避免
  无人等待的写盘与调用方清理动作抢文件句柄（Windows 上表现为 EBUSY）。
- `restore()` 用账本里已有的终态报告（或 `pendingTerminal`）纠正 stale
  `running`，不再一律标成 `interrupted`；恢复结果本身也会立即落盘，
  下次重启不会重复判一次。
- 投递成功后尝试 `ctx.sessionPersistence.flush()` 作为可选持久化屏障，
  结果记在 `task.delivery.durable`；拿不到服务或调用抛错就退回弱幂等，
  只 warn 一次并由 `selfCheck().delivery.durability` 回显，绝不假装已持久化。
- `selfCheck()` 新增 `background`（活跃数 / 巡检数 / 待重挂 / 终止 job 数 /
  延迟终态数）与 `delivery.degraded`、`delivery.durableOk`。

**契约与可维护性**

- 新增 `ERROR_CODES` 闭集与 `fail()` / `codeOf()`（`src/constants.js`）：
  9 个工具在 `registerTools()` 统一贴 `code`（中文 `message` 保持不变），
  看板所有 `ok:false` 响应按 HTTP 状态自动带闭集 `code`。
- 看板路由前缀收口到 `constants.js` 的 `BOARD_BASE`；浏览器半边
  `client/index.js` 无法 import（不打包），改为由新增的
  `test/contract-consistency.test.js` 在每次 `npm test` 时钉住两处逐字一致。
- 修 4 处文档漂移：`prepareEnv` 的 5 个环境变量在 `cordis.patch.yml` /
  README / 架构文档里写全名（不再用 `_TASK` 缩写）、`store.js` 注释不再声称
  「任务表是辅助信息」、`tools.js` 头部改成「9 个工具」、README 的
  `dispatch_list` 示例版本对齐 `0.8.0`；`CHANGELOG` 重复的 `0.5.2` 订正为
  `0.5.3`（附订正说明）。
- 同样的「一致性」变成 7 条可执行断言：路由前缀、示例版本、工具数量、
  环境变量全名、store 口径、版本号唯一、错误码唯一。

**文档**：`docs/tools.md` 补 `deferred` 返回形态，`docs/architecture.md` §24
补这一轮四条修复的取舍。

**验证**

- `npm test` **476 条**（470 pass / 0 fail / 6 cancelled）。6 条 cancelled 是
  `tasks.test.js` 既有的父子超时用例，基线即如此，与本轮无关；连续 5 轮结果一致。
- 新增 `test/background-lifecycle.test.js` 7 条（终态报告延迟结算、按
  pendingTerminal 收尾、取消终止 job、异步 `jobs.list` 生效、重启重挂巡检、
  stale running 自愈、工具错误码）、`test/contract-consistency.test.js` 7 条。
- `node scripts/client-smoke.mjs` **394 项全过**；`node --check` 覆盖全部
  `src/*.js` 与 `test/*.js`。
- `background.test.js` 两处固定 `sleep` 改轮询等条件：巡检收尾现在要等一次
  真实写盘，慢盘/冷启动下 60ms 不够，此前会偶发失败。

**本轮仍未做**（不在代码能力范围内，不假装完成）：真机视觉验收三关与只能
目视的 6 项（需要宿主 GUI 与浏览器）；`sessionPersistence.flush()` 在本机
仍属静态取证，真机签名需复核；配置 schema / 包内四层拆分 / TypeScript
类型闸门属于下一阶段结构性改造。

### 修复：12 条口径与复活路径缺陷

一次集中修复，主题是「**已结算的任务被复活时，上一轮的事实没有跟着失效**」，
以及由此衍生的几处统计口径漂移。

**复活路径（Host）**

- **离开终态即失效**：`TaskTable.transition()` 在进入非终态时清掉 `settledAt`。
  原来只有 `reopen()` 清，续派走的是 `transition(force)`——于是续派后再结算沿用**第一轮**时刻，
  按天趋势、完成时刻、占用时长全算到旧日期。
- **新回合清回合标记**：`message()` 在投递成功、回合开始时清 `reportedSinceTurn`。
  原来它只在回合结束时清，于是「第一轮报 done → 续派 → 第二轮没给结论」被判成 done
  **且不发兜底通知**：主会话只看到第一轮报告，看板显示成功。
- **取消优先**：`message()` 在投递（await）**之后**复查任务状态，投递途中被取消就不复活它。
  原来投递后无条件改回 running，用户点的取消被静默撤销。
- **归档是只读冻结**：`message()` 拒绝已归档的任务；续派准入抽成
  `Dispatch.continueTask()` / `#assertContinuable()`，工具入口（`dispatch_launch({continue_task_id}）`
  与看板入口（`POST /board/retry` 带 `message`）**共用一份**——看板那条以前直接调 `message()`，
  绕开了归档 / 退休 / 会话形状的全部校验。
- **重试不能穿过归档闸**：`retry()` 在两条分支之前就拒绝已归档任务。只在 `message()` 里挡
  会漏掉「子会话已死」那条——它直接 `reopen()` 换新会话、根本不经过 `message()`，
  于是归档任务被复活成 `running` 而 `archivedAt` 仍在（归档与在跑并存）。
  看板 `POST /board/retry` 对归档任务现在返回 `409`。

**统计口径（Host）**

- `coverage.timeBasis` 只反映**窗口内**那些行的基准，且与 `fallbackCount` 同源：
  恒等式 `timeBasis = mixed ⇒ fallbackCount ≥ 1`（原来窗口外一条老数据就能把口径说成 mixed，
  而 fallbackCount 仍是 0，界面自相矛盾）。
- `summary.reliability` 受**工作区**筛选约束（不看窗口：跑了 10 天的任务不该从健康面板消失）。
- 分析看板的「未标注」facet 与匹配判据**共用一个归一函数**（原来一边写 `__unknown__`、
  一边拿空串比，选中「未标注」永远筛不出任何东西）。
- `coverage.missingCreatedAt` 改为在时间过滤**之前**数：缺 `createdAt` 的行不再从分母里悄悄消失。

**客户端**

- 趋势图的「空天」判据补上 `cancelled` / `ended`，与表格列同源（跨天取消那天不再显示「空天补 0」，
  而同列表格却显示 `cancelled=1`）。
- 2 秒快照轮询在**分析看板可见时整条停掉**（原来每 2 秒落一次状态，把整个分析视图重建一次）。
- 口径行（窗口提示与样本口径行）跟着**当前展示的 payload** 走，而不是跟着即将生效的选择走——
  不再出现「新标签 + 旧数字」。
- 删掉只写不读的 `windowPicked`；`memoryStats().window` 增加 `count`（窗口实际命中条数），
  让窗口能被账本核对；分析看板的样本门槛改为复用 `SAMPLE_LOW_BELOW`；
  降级响应的默认窗口改为复用 `defaultWindowDays`（不再写死 7 天）。

**验证**：新增 `test/resume-after-settle.test.js` 7 条；`test/stats.test.js` +6、`test/analytics.test.js` +6、
`test/memory.test.js` +2、`test/board.test.js` +1；`scripts/client-smoke.mjs` +6 项。
`npm test` 459 条全过，冒烟 394 项全过。

### 新增：分析数据看板（与任务看板二选一切换）

在同一个 `main` 面板里加一条顶层切换条：`任务看板 / 分析看板`，默认仍是任务看板。
任务看板的 header、5 个 chip、工具栏、三段列表、5 类行内操作、历史抽屉与 2 秒轮询**一行未改**；
所有新 state / effect 都追加在 `BoardPanel` 末尾（既有 hook 序号不动），`AnalyticsView` 是无 hook 的纯展示组件。

- **Host**：新增 `src/analytics.js`（`analyticsSnapshot` / `degradedAnalytics` / `normalizeAnalyticsScope`）
  与 `GET /board/analytics`（`readAllowed`，与 `/board` 同档）。遍历 `dispatch.table.tasks` **全量**，
  不受 `/board` 的 200 条上限影响；聚合抛错返回 200 + 同构降级结构，不返回 500。
- **指标**：任务总量、状态分布、完成率（`done ÷ COMPLETION_BASE`，取消与未结算不进分母）、
  超时代理、按天趋势 + 上一等长窗口环比；n=0 给 `null` / 界面 `—`，1≤n<5 带 `sampleLow`。
- **筛选**：时间范围（`24h/7d/30d/all/<n>d`）、状态、负责人（`parentSessionId` 代理）、
  工作区、批次、超时阈值；候选 `facets.*` 从**未筛选**账本取，条件之间是「与」。
- **口径诚实**：账本没有人员字段与 `due_at`/SLA 字段，负责人与逾期都自报为**代理指标**
  （`warnings: ['owner-proxy','due-at-proxy']`、`pendingFields: ['due_at']`），界面写「待业务确认」；
  口径表常驻可展开，覆盖率、时间回退、账本触顶都在 `coverage` 里可见。
- **状态与刷新**：首次加载 / 空数据 / 取数失败 / Host 降级 / 有旧数据时的陈旧态逐条分开；
  分析视图可见时 10 秒刷新，页面隐藏停表、卸载中止请求，与任务看板轮询互不影响。
  点状态分布行即筛该状态，趋势有图表 / 表格等价双形态。
- **样式与适配**：复用既有 `.dsh-sa-*` 组件样式与主题 token，按**容器宽度**（`@container`）折行，
  窄侧栏自动单列，不横向溢出。
- **验证**：`test/analytics.test.js` 15 条（全量 / 窗口 / 分母 / 筛选 / 代理指标 / 趋势 / 降级 / 路由）；
  `npm test` 439 条、`scripts/client-smoke.mjs` 全过；离线预览页已重新生成，
  真机（无头 Chrome）目视了任务看板 / 分析看板 / 窄屏三种形态。

### 调整：移除「并列」形态，并做一轮 UI 布局收敛

按反馈去掉第三种形态，切换条收敛为 `任务看板 / 分析看板` 二选一；`split` 的文案、
样式（`.dsh-sa-split` / `.dsh-sa-pane`）、渲染分支与预览页专用规则一并删除，不留死代码。

同时按真机目视结果整理分析看板的信息密度：

- 去掉头部重复的「回到任务看板」按钮（顶部切换条就在上面），该入口只在错误态保留；
- KPI 区标题从重复的大标题改成「核心指标」并补一行口径提示；
- 样本口径行把两条长警告合成一条 `代理口径（待业务确认）` 说明，减少三行密排；
- 清除/刷新按钮靠右成组，筛选条层级更清楚；
- 趋势图把**连续的空天合并成一行**（如 `11-02–11-07 ｜ 连续 6 天无任务（空天补 0）`），
  表格形态仍逐日给全；不再出现 6 条全 0 的空条；
- 修掉新看板条形填充**宽度不生效**的视觉缺陷：`<span>` 默认 inline，需像既有
  `DistRows` / `TrendBlock` 一样显式带 `display:block`，否则状态分布与趋势只剩灰色轨道；
- 窄侧栏下状态分布仍保持「名称 / 条 / 数值」一行，不再拆成三行；缩短三处口径提示，
  消掉窄屏的孤字换行；
- 页脚改成刷新节奏与口径指引，不再重复「读取完整账本」那句。

### 看板：终态任务加「归档」按钮（用户反馈：只有重试会一直卡着）

用户在看板上报的原话：「已经中断的任务应该加取消或者归档按钮，要不然只有重试会一直卡着」。
核实后是真的缺陷，而且不是 UI 少画一个按钮那么简单：

- `dispatch.cancel()` 开头就 `SETTLED.has(task.status)` 直接抛，而
  `interrupted`/`failed`/`blocked`/`ended`/`done`/`cancelled` **全在 `SETTLED`** 里
  → 这些终态任务**根本没有取消入口**；
- 唯一出路 `archiveStale()` 是**全量巡检**，只在 `updatedAt` 早于 `archiveAfterHours`
  （默认 24h）时才动，也没有「指定这一条」的入口；
- 于是 `failed`/`blocked`/`interrupted` 这些行只剩「重试」一个按钮，
  而它们又永远停在首屏的「需要你处理」区（`ATTENTION_STATUS`）。

**`Dispatch.archiveTask(taskId)`**（`src/dispatch.js`）

- 只处理指定任务、不跑巡检；语义与 `archiveStale()` 内部那一段一致（写 `archivedAt` + `frozenAt`，
  成功清 `archiveError`）。
- **未结算（`running`/`queued`）一律拒绝**：归档 = 只读冻结，冻一个还在写的会话只会丢数据。
- **幂等**：已归档再调返回 `{ok:true, archived:false}`，不重写 `archivedAt`/`frozenAt`，也不再碰子会话。
- 返回 `{ ok, archived, reason?, task }`；`archived` = 本次是否真的写了归档标记，
  `reason` = 「归档了但子会话没归档成功」的真实原因。

**决策 B：子会话归档失败也归档，但必须留痕**

会话可能随重启消失，或者任务从启动就失败、**根本没有**活动会话。这类任务若「归档失败就不归档」，
会永远停在待办区——正是用户报的缺陷本身。所以：仍然写 `archivedAt` + `frozenAt`，
把真实原因写进 `task.archiveError` 并原样回成 `reason`，看板用**警告**语气说
「已归档，但子会话没归档成功：<原因>」。绝不假装干净成功。
（巡检那条路保持老口径：失败不归档、只记 `archiveError`、下次巡检重试。）

**新路由 `POST /board/archive-task`**（`src/board.js`）

- body `{"task_id":"t-..."}`；缺 `task_id` → `400`，任务不存在 → `404`，未结算 → `409`，都带中文原因。
- **`POST /board/archive` 一行没动**：它仍是巡检入口（不读 body、扫全表、回 `{scanned, archived, failed}`），
  既有用例（`test/board.test.js`、`test/p0-regression.test.js`）的断言原样通过。
  两条路各管一件事，不做「同 URL 两套语义」。

**看板按钮**（`client/index.js`）

- `actionOf(status)` 从「返回单个 kind」改成 `{ primary, archive }`：
  `running|queued → {primary:'cancel', archive:false}`；
  `failed|interrupted|ended|blocked → {primary:'retry', archive:true}`；
  `done|cancelled → {primary:null, archive:true}`（没有主操作，但仍能被收走）。
- 一行可能有两个按钮，归档在主操作**之后**；归档走 `POST /board/archive-task`（不塞进 `/cancel|/retry` 的三元式）。
- 归档两步确认（`archiveAsk` 存「等确认的 task_id」，4 秒过期），与工具栏巡检确认态分开持有。
- **不把 `interrupted` 改写成 `cancelled`**：plans/09 §四 A 规定取消不进完成率分母，
  混用会同时污染取消率与完成率。
- 新增 5 条 zh/en 成对文案（`archiveTask` / `archiving` / `archiveTaskConfirm` / `archiveTaskDone` /
  `archiveTaskKept`），`TEXT`/`TEXT_EN` 各 369 个顶层键（改前 364）。

**验收**：`node --test` **400 pass / 0 fail**（新增 `test/archive-task.test.js` 15 条，基线 385）；
`client-smoke` 330/330 不变；连跑 10 次全绿。

### plans/07 P1：降噪（合并窗口 + 事实/投影分离）

P0 管「写不写进账本」，P1 管「**投进会话的那一份多长、隔多久**」。三条都只作用于投影，
不动账本、不改状态机、不新增会话事件类型。

**P1-1 合并窗口**（配置 `noticeMergeWindowMs`，默认 `1500`，硬上限 `2000`）

- 同一 `taskId` 在窗口内的多条未消费通知**合成最后一条**（后一条覆盖前一条、计时器重起），
  合并键是任务而不是会话——跨任务合并会让人读不出「哪条在做什么」。
- **只有 `progress` 可合并**（`MERGEABLE_REPORT_STATUSES`）。终态
  （`done`/`blocked`/`failed`/`cancelled`）、批次汇总、启动失败、回合兜底**永不参与**：
  前三类不经过 `report()`（直接调 `relay()`），结构上进不来。§九 的「直通类永不参与合并」
  由此落成唯一判据 `Dispatch.mergeableOf()`。
- 直通类到达时**先冲刷**该任务待发的进度再发自己，保证「先过程、后结论」的顺序；
  卸载时 `dispose()` 冲刷全部窗口，已决定要说的内容不随进程消失。
- **与节流是两件事**：`progressRelayIntervalMs` 丢的是当前态（一分钟只剩一条），
  合并丢的是中间态（最后那条一定送达）。两者并存：节流管「多久一次」，合并管「一次几条」。
- 回退开关就是把这个窗口配成 `0`（§九「每批能单独回退」）。

**P1-2 事实/投影分离**（`projectText()` / `projectionOf()`）

- 先测量再动手：改前三种真实形状（典型 34 字 / 长 1200 字 / 超长 6000 字）合计
  **账本 7234 字 → 会话 1811 字（25.0%）**。四段式本身已经在预算内，`detail` 也从来不进会话，
  所以真正的浪费集中在「写了 1000 字以上的摘要」那批——它们才是要分的那批。
- 改后同一批输入 **会话 820 字（11.3%）**：超长那两条各从 838→343、866→370（各省约 495 字），
  **典型短报告 107→107 一字未改**（压预算内的东西只会凭空制造信息损失）。
- 压的是 `【说明】` 一行的正文（压到 `REPORT_VIEW.DIGEST` 240 字 + 「另有 N 字在账本里」的指针），
  `【任务】`/`【结果】`/`【需要你】`/`【细节】` 一行都不动——行动指向和指针不能被压缩掉。
- **不用 `clip()`**：它会在中间插一段带换行的「…（已截断 N 字符）…」，把单行的【说明】撑成三段，
  四段式的「一行一段」直接破掉（全部文案契约测试都是按行找段名的）。
- **账本一个字都没压**：`#admitEntry()` 与 `projectText()` 互不相干，
  `test/voice-contract.test.js` 的「账本原文不压缩」照旧通过。

**P1-3 自检**：`selfCheck().memory` 原有五项（账本条数、退休数、待读数、当前窗口、注入预算）
已齐；本次补 `merge` 与 `projection` 两块已读数（生效窗口、待发数、窗口数、合并掉的条数、
三种投递形态计数、投影预算），让「注入侧到底发生了什么」能直接对账。

**验收**（`test/p1-noise.test.js` 15 条）：一次派发 + 一次收尾，主会话新增插件消息 **1 条**
（≤3，`progress` 默认 0 条）；同一任务 60 秒内未消费通知 **1 条**（≤1）；
重复 message id 计数 **0**。`node --test` **363 pass / 0 fail**，连跑 10 次 **10/10 全绿**；
`http-smoke` 26/26、`client-smoke` 330/330 不变。

### plans/10 P1：提示词里加「说话方式」段（先认领任务、再说人话）

问题不是「模型不会做事」，而是**它把事实说得像日志**：报告回来是
`[dispatch] 任务 t-1a9f-1 · 重构 auth · 报告 done`，主会话照着转述，用户看到的是一串
状态词和 id，得自己猜「回来的是哪条、要不要我管」（plans/10 §二）。

P1 只动提示词这一层——机制不变，把**表达方式**补进主会话的系统提示：

- 新增 `src/prompt.js` 的 `SPEAK_RULE`，插在 `BACKGROUND_CONTRACT` 之后、`HANDOFF_RULE` 之前
  （顺序 = 先讲机制 → 再讲表达 → 最后讲职责）。轻提示与强制派发**共用同一份文本**，
  与另外三段一样，避免两种模式各说一套。
- 七条说话规则：先认领再结论 / 默认 2-3 行 / 说人话不报内部词 / 不写流水账 /
  失败说清「卡在哪 + 你只需做什么」/ 有建议才写 / 细节从 `dispatch_inspect` 取。
- **优先级写在段的标题行**：风格规则不得覆盖事实与安全规则，简洁与准确冲突时先准确。
  放标题行是因为风格条款与示例都靠它划边界，放末尾等于没写。
- 带**两组**改前/改后示例（§六 例 1 单任务完成、例 2 批次有失败），并注明
  「只作兜底参考，正文自己组织，别照抄句式」。§九 建议只放一组；这里多放批次的
  那组，是因为**只有它能演示「没成的必须点名」**——单任务示例演示不了本段最难的那条。
  多出的 1 行仍在预算内（见下），§八 P1 的验收写的是「1–2 组」。

**长度门禁**（plans/10 §七.1）：新增 `test/voice-prompt.test.js`，断言「说话方式」段
**≤ 8 行、≤ 500 字**。三个刻意的选择：

1. **量装配后的真实文本**，不是源码里常量的长度：走 `Dispatch.refreshHint()` →
   `agent.ctx.systemPrompt.section()` 的 `text()` 求值，拿到宿主下一步会写进
   `system/message` 的字符串；连 `ROUTER_LOCKED` 追加那段也一起量。
2. **只通过 import 读，不经 shell**：`git show > file` / PowerShell 重定向会倒出
   UTF-16/BOM，按字节或按行统计会失真（上一个任务踩过）。
3. **字数按 code point 数**（`Array.from(text).length`），不是 `String.length`：
   后者数 UTF-16 码元，emoji/生僻字会虚高，把一次正常润色误判成超限。

实测当前段：**8 行 / 481 字**（上限 8 行 / 500 字），两种模式一致。提示整体只增加 483 字符
（`SOFT_HINT` 1441 → 1924，`FORCED_HINT` 1784 → 2267），没有挤进任何已有段落。

门禁常量放在 `src/constants.js` 的 `VOICE_SECTION`（标题行 + 两个上限）：标题行是测试切段用的
稳定锚点，正文才是会反复润色的散文，两者分开，以后润色不必改测试、门禁仍盯着真实渲染结果。

**未做**（属 P2/P3）：`dispatch_inspect` 返回「可直接转述的详情」、用户说「展开」时给全、
按真实对话回收追问率。人工盲评 10 场景（`docs/voice-samples.md`）仍需人跑一次。

### plans/09 P2：历史视图 + 任务详情抽屉

看板第三个阶段：**第四个视图「历史」**与它的**任务详情抽屉**。回答「某条任务到底发生了什么」，
不新增接口、不改任务状态机、不动 `src/stats.js` 的口径。

**① 第四个视图「历史」**

- 加进 `viewTabs`，顺序固定 `总览 / 效果 / 拆解 / 历史`。
- 三个子视图：`全部`（`/board` 快照全部任务，含已归档）/ `已归档` / `已退休`（`/board/retired`）。
  退休留痕**不进** `全部`：它不在快照的 `tasks` 里，混进去会让同一份账本在两个子视图里给出两个总数。
- 搜索：`task_id`、标题、`worker_session_id`、工作区（派发目标与实际归属**两个维度都算命中**）。
- 筛选：状态、工作区、时间（按创建时刻；退休留痕用 `retired_at`，否则「最近 7 天」永远看不到刚退休的那批）、
  是否重试、是否有后台。
- 排序：创建 / 结算 / 耗时 / 状态。**缺时间或耗时未知的行排到末尾**，不会因为 `NaN` 被当成 0
  而看起来像「1970 年的任务」；同值按 `task_id` 倒序，保证 2 秒轮询下渲染顺序稳定。
- 表格替代无限长卡片列表，**每页 50 条** + 底部固定分页条；快照 `truncated` 时明说「只含最近 N 条」。
- **完全不依赖 `/board/stats`**：统计 404 或宿主降级时历史视图照常工作（§八.10）。
- 退休行与已归档行不假装能打开子会话，只给复制 id 并说明原因。

**② 任务详情抽屉**（本视图的核心增量）

点行在表格下方展开，七块：生命周期（创建 → 开始 → 报告 → 结算 → 归档 → 退休，缺的写「没有记录」）、
简报与目录（cwd / task_dir / 目标工作区 / 实际归属）、报告与最后输出、attempt / 错误 / 归档失败、
追问投递、后台 job 与 subagent、prepare 结果。

抽屉是**文档流里的一块**而不是 `fixed` 遮罩：面板在宿主槽里滚动，`fixed` 会跑到视口外并盖住别家 DOM。

**快照里没有、抽屉也拿不到的字段**明说指向 `dispatch_inspect <task_id>`，不编造：完整简报正文、
完整报告正文、更早的报告（快照只有 `report_count` 与最后一条摘要）。浏览器半边没有 `dispatch_inspect` 工具。

「打开子会话」只在**有 `worker_session_id` 且未归档且不是退休留痕**时出现；其余情况只给复制 id。

**③ 文案**

新增 **79 个 zh/en 成对键**（`hist.*` 34 个、`drawer.*` 44 个、`view.history` 1 个），
`TEXT` 与 `TEXT_EN` 各 363 个**顶层**键，键集合完全一致。

**④ 测试**

- `scripts/client-smoke.mjs`：266 → **330** 条断言（+64），覆盖四个视图分段、三个子视图、
  搜索四字段、四档排序、分页翻页、退休行不可打开、抽屉七块与生命周期六步、zh/en 键集合。
- 修掉冒烟脚本里一处**潜伏的污染**：`uiWorkspace.openSession` 被临时改成抛错函数模拟 `not-listed` 后
  从未恢复，导致其后所有「打开子会话」断言都会失败，而失败信息指向那些断言本身。
- `npm test` 仍 **304 pass / 0 fail**。
- 真机（浏览器打开 `preview/board-preview.html`）目视：修掉两处版式问题——历史表六列时「耗时」被
  裁到看不见（合并「结算/退休」为「结束」一列并压窄列宽），以及抽屉里「后台 job / subagent」
  与「prepare 结果」两个标签重复了各自的块标题。


### 统计口径地基：权威 `settledAt` + `GET /board/stats`

对应 [plans/09-board-analytics.md](../plans/09-board-analytics.md) §七 P0。
**没有新增任何看板视图**（那是 P1）——这一版只把「数字怎么算」定死，让后续视图不至于
各自发明一套口径。

**① 权威结算时刻 `settledAt`**

0.8.x 各处拿 `updatedAt` 当结算时刻，而它会被报告、追问、归档巡检、后台巡检反复刷新。
后果是**同一个数字在两次轮询之间会变**：一个 3 小时前就 done 的任务只要 worker 又来一条
报告，「完成时间」就往前跳一次，按天趋势把它挪到另一天，并行节省跟着重算。

- 只在状态进入终态时写一次（`TaskTable.settle()` 与 `transition()` 都走 `#markSettled()`，
  后者保证幂等）。两个入口都要写：`transition()` 是唯一的状态写入口，`force: true` 的
  重开/强改从它过——只在 settle 里写会漏掉这条路径。
- `reopen()`（retry）**清掉**它：任务重新活跃后，结算时刻不再存在；不清会让第二次结算
  沿用旧值（`#markSettled` 看到已有值就什么都不写），任务被算在上一次结算那一天。
- 旧数据没有这个字段 → 读的时候回退 `updatedAt`，但**必须**带
  `time_basis: 'updatedAt-fallback'`（新数据是 `'settledAt'`）。快照（`boardTask`）与
  统计（`coverage.timeBasis` / `fallbackCount`）两处都报，不静默混用。
- `boardTask().elapsed_ms` 优先用 `settled_at`：耗时因此不再随后续报告漂移。

**② `GET /board/stats`：对完整账本聚合**

契约逐字段照 §六.1。刻意独立于 `GET /board`：快照每 2 秒轮询、只带 200 条任务，
拿它算比例分母从开始就是错的（§八.2「1000 条任务不受 200 条快照上限影响」）。

口径要点：完成率分母不含取消（取消率单列）；n=0 给 `null` 不给 `0`；1≤n<5 带
`sampleLow`；归档与退休不进效果指标但计入 `coverage`；工作区按**派发目标**与
**实际归属**分成 `byTarget` / `byHost` 两份，绝不合并。

聚合失败返回 `200` + 同构的最小结构（`degraded: true`），**不是 500**：
面板轮询遇到 500 会进入「报错→重试→再报错」的循环，而任务列表其实还是好的（§八.10）。

**③ 新增 `src/constants.js` 的四个常量**

`COMPLETION_BASE`（完成率分母，与 `SETTLED` 差一个 `cancelled`，含义不同不能共用）、
`TIME_BASIS`（时间基准标记）、`STATS_VERSION`、`STATS_WINDOW_ALL`、`STATUS_ORDER`
（展示顺序，不参与任何判据）。

**测试**：新增 `test/stats.test.js` 48 条，覆盖 §七 P0 验收与 §八 的边界：
窗口起点恰好相等（左闭）、跨天、缺 `startedAt`/`settledAt`、取消不进分母、
归档与退休不投票、1000 条全量、n=0 的 null、分位数与并行节省的手算对照、
以及新路由的准入与降级。`node --test` 从 249 → **297 全过**。

**注意**：宿主**已加载的进程不会自动重载 host 侧代码**，新路由要在重启 DSH 后才出现
（这是宿主行为，不是插件缺陷）。路由正确性由单测直接调 `createBoardHandler` 证明。


### 修复：点已归档任务会跳到一个空白新会话

归档行的 `worker_session_id` 还在，所以 「整行可点」的判断一直为真；点击后调
`ctx.get('uiWorkspace').openSession(id)`。但宿主这次调用只做「换主视图」，而 ui-workspace 的
`watchNavigation()` 里有 `clearArchivedCurrent()`：当前主视图的会话一旦在 `archivedSessionIds` 里就
`clearMain()`，主区域随后被补建成空白会话。**用户看到的就是「点一下归档任务，跳到了新会话」**，
而任务本身并没有真正被打开。

**选择「不可点」而不是「打开原会话」**：数据上确实能解析出原会话 id，但宿主对归档会话的导航策略
就是不让打开（DSH 自己的侧边栏对归档会话也只提示「已归档对话暂时无法查看，请取消归档后查看」）。
绕过它需要先做一次「取消归档」写操作，不该由一次点击的副作用触发；而点了打不开再报一句错，
等于把「坏了但没全坏」写进交互。因此归档行**彻底不给点击入口**。

- `client/index.js`：`TaskCard` 的可点判据从 `Boolean(worker_session_id)` 收紧为
  `Boolean(worker_session_id) && !archived`；归档行因此没有 `onClick` / `onKeyDown` / `tabIndex` /
  `dsh-sa-row-clickable`（无手形光标），并加 `aria-disabled="true"` + `aria-description`（= `archivedHint`）
  说明原因；`title` 不再拼「点击打开子会话」。`openWorker` 加**第二道闸**：任务带 `archived_at` 就只弹提示、
  **绝不调** `openSession`（键盘/脚本/将来新增调用方绕过渲染层时兜底）。归档行 hover 不再给可点底色。
- 文案：`archivedHint` 从「该子会话已归档，可能已不在会话列表里」改为
  「该子会话已归档，不可直接打开；请在会话列表里取消归档后再查看」（中英各一份）。
- `preview/board-preview.html` 随 `scripts/board-preview.mjs` 重新生成。
- `scripts/client-smoke.mjs`：新增 25 条回归断言 —— 归档行没有 `onClick`/`onKeyDown`/`tabIndex`/
  `dsh-sa-row-clickable`、有 `aria-disabled`、`title` 不含「点击打开子会话」；
  **点遍三条归档行之后 `uiWorkspace.openSession` 调用数为 0**；以及「未归档行点击仍然正常打开子会话」
  （防止修归档时误伤正常行）。已用变异测试确认断言有鉴别力：把 `&& !archived` 去掉后有 21+ 条断言变红。

### 记忆治理 P0：指标窗口、准入分级、单条预算、生命周期清理、账本封顶

对应 [plans/07-memory-governance.md](../plans/07-memory-governance.md) §六 P0 五项。**没有改状态机、没动 Session 格式、没改工具契约**——
只补「哪些事实进会话、进多少、留多久、怎么退出」这条一直没人负责的链路。

先说清一个此前被写错的口径：`src/store.js` 的注释与 README 都说任务表是「辅助信息，丢了不影响子会话」。
**这个说法是错的**：状态、归属、续跑、看板指标、归档标记、`dispatch_inspect` 全读这份表，而会话里的报告一旦写入不可回收。
它曾经是对的（0.1.0 只有派发 + 回报），但后续每一版都在往账本上加事实，那句注释没人回头改——
计划书 §九 记的「文档再次漂移」风险就是这么发生的。现在 `docs/architecture.md` §26 明确把它定为**派发事实的权威源**，
会话是**可重建的投影**，并解释了旧口径为什么当时成立、后来失效。

**① 指标窗口化（`memoryWindowDays` / `memoryWindowTasks`，默认 7 天 / 200 条）**

`effectStats()` 原来对**全部**未归档已结算任务计算，于是上个月失败的几条会一直给今天的成功率投票。
现在客户端只统计 `updated_at >= memory.window.since` 且落在最近 N 条内的已结算任务；
**归档按 `archived_at` 排除（这条与窗口无关），退休任务根本不在快照的 `tasks` 里**。
窗口文案显示在卡片 hover 里——不显示口径的话，同一个 86% 在两种算法下会看起来像 bug。

**② 准入分级（`directReportStatuses`，`ADMISSION.DIRECT` / `LEDGER`）**

`report()` 现在先问 `admissionOf()`：终态（`done`/`blocked`/`failed`/`cancelled`）恒直通，
配置点名的状态直通（默认 `blocked`/`failed`），**其余只入库**——`progress` 落在这一类。

**这里有个与直觉相反、必须写下来的取舍：终态硬直通，配置只能扩展、不能降级。**
把 `directReportStatuses` 清空**不会**让 `done` 静默。理由：结论与「需要人处理」是主会话唯一必须知道的两类事，
任何配置都不该把它们降级成静默，否则主会话会永远等不到「做完了」。这条如果不写清，下一个改配置的人
会以为「我清空列表就等于关掉回流」。

批次成员自己只入库（整批由 `maybeSummarize()` 汇总一条），**但批次汇总本身恒 direct**——
否则成员静默 + 汇总静默 = 整批彻底静默。`progress` 的旧节流（`progressRelayIntervalMs`）保留，
但它现在只在用户把 `progress` 配进直通列表时才用得上：配置一放开，没有节流会比放开前更糟。

**③ 单条消息预算（`maxReportSummaryChars` 6000 / `maxReportDetailChars` 4000 / `maxLastTextChars` 5000）**

原来只有 `reportText()` 外发时 `clip`，`task.reports` 里存的是调用方给的原样长度——
「单任务体积由调用方决定」正是计划书点出的容量膨胀根因之一。现在 `#admitEntry()` **入库即截断**，
被截的条目记 `truncated: {summary: 原始长度, detail: 原始长度}`，只在真被截时出现这个键
（一个恒存在的空对象会让「是否截过」永远为真）。内外同一口径，避免「库里 10 万字、
`dispatch_inspect` 看残版、主会话看另一个残版」的三方错位。

**`clip()` 不是「截到恰好 N 字」**：超长时头尾各半，中间插一句「已截断 X 字符」的提示，
而**提示语本身也占这 N 的预算**（`bodyBudget = limit - 40`）。这条在 0.6.0 之前是 `limit - 400` + `slice(-400)`，
`limit < 400` 时输出反而比 `limit` 还长（实测 `clip(1000 字, 200)` 返回 417 字）。文档里写清楚是因为
「为什么我传 200 却拿到 160 字」会被反复问。

**④ 生命周期清理（`forgetTargets` / `inputPendingTtlMs` / `archiveStale` 写 `frozenAt`）**

- **会话销毁清 `targets`**（`forgetTargets()`，`clearTargetsOnDispose` 默认开）：只删目标不删任务。
  不在 `dispose()` 里清——插件卸载时所有会话都还在，清空等于把用户的输入框选择全丢掉；
  `agent/disposed` 才是「这个会话再也不会派发」的确定时刻。它排在任务结算**之前**，
  避免「即将消失的会话的旧目标被新任务读到」那个窗口。
- **`inputPendingAt` 的 TTL**（默认 30 分钟）：宿主在部分部署里根本不发 `session/event`，
  `inputPendingAt` 会**永久**挂着「待读」，看板看起来像 worker 卡住了。超时后**不假装读过**
  （那会掩盖真正的问题），而是改写成 `inputUnknownAt`——「不知道读没读到」比「永远在读」更接近事实。
  看板据此区分「待读」与「不知道」，且 unknown 压过 pending。`sweepMemory()` **不新开定时器**，
  挂在 `schedulePersist()` 的防抖回调与 `persist()` 之前（写盘本来就是这些变化的汇合点）。
- **归档写 `frozenAt`**：归档是「只读冻结」的开始，冻结时刻与归档时刻分开记。
  **不能复用 `retiredAt`**——`isRetired()` 靠 `retiredReason` 判「这是不是退休记录」，
  把归档写成退休会让 `dispatch_inspect` 认为任务已不可查（其实它还在活表里），也让 `memoryStats()` 少算一条活任务。

**⑤ 账本封顶（`ledgerMaxTasks` 1000 / `ledgerMaxDays` 90 / `ledgerMaxRetired` 5000）**

判据两条（条数超、或存在非活跃且超期的任务），任一成立就退休；顺序是**已归档优先，其次最老 `updatedAt`**
（归档是用户已经明确表示「不想再看」的动作，比「单纯很老」更该先走）。排序键用 `Date.parse()` 的数字
而不是 ISO 串比较——旧格式不带毫秒时字典序会与时间序分岔。触发点三处，都不新开定时器：
`settle()` 后、`archiveStale()` 后、`restore()` 后（幂等，体积只在这几处增长）。

退休做两件事：移出 `table.tasks` / `table.queue`，往 `this.retired` 写一条**13 字段**薄记录，
**不搬 `reports` 正文**——搬正文等于把容量上限换了个地方存。

**`retiredDropped` 不落盘，重启归零。** 它是「本次进程内丢弃了多少条留痕」，不是累计值。
这一点必须写下来，否则用户会对不上号：看到 `dropped: 1` 之后重启变成 0，会以为「数据回来了」。
落盘反而更糟——把「本次丢弃数」持久化，会让人以为那些被丢的留痕是可追溯的，而它们的定义就是「已经不在了」。

### 存储格式 v4：`tasks.json` 多一个 `retired` 数组

`{version: 4, savedAt, tasks, targets, retired}`。旧文件没有 `retired` 键时读成 `[]`，
**不迁移、不报错**（退休留痕丢了只影响「它为什么消失」这一条可查性，不该让升级后的插件起不来）。
写盘时显式写空数组而不是省略：`JSON.stringify` 会丢掉 `undefined` 键，落盘后读的人就再也看不出这是新格式。

留痕**按「最老在前」写盘**（Map 插入顺序 = 退休顺序），读回来时保持同样顺序，
所以 `ledgerMaxRetired` 裁掉的就是队头，恢复时不需要重排。`restore()` 把它们放进 `this.retired`，
**绝不当活任务恢复**——塞回 `table.tasks` 会让它们重新给指标投票，等于没退休。

### 看板：新增「已退休」视图与 `memory` 块

- **新路由 `GET /board/retired`**（只读，准入与 `GET /board` 同档，**不要求 `x-dsh-mini-superagent` 写头**）：
  返回 `{ok, count, dropped, entries[]}`，最多 200 条、按 `retired_at` 倒序；`dispatch.retired` 不存在时返回空表而不是 500。
  退休本身不是写操作，面板只能看。
- **快照新增 `memory` 块**（形状逐字照抄 `memoryStats()` 的 `{window, ledger, admission, pending, retired}`）
  与 `counts.retired`。`memory: null` 是合法值（旧版/headless/抛错），显式给 `null` 而不是省略字段，
  是为了让客户端能区分「宿主没提供」与「这是旧版宿主」。
- **视图 chip 从 4 个变 5 个**，新增「已退休」排在「已归档」之后。它**不从快照取数**（`match` 恒 false），
  选中时才走独立路由；计数取 `counts.retired`，`memory` 为 null 时显示 `—` 而不是 `0`
  （`0` 会被读成「确实一条都没有」）。取数还与 2 秒轮询解耦：退休记录生成后不再变化，跟着轮询纯属浪费。
- **一个必须写下来的坑**：`memoryStats()` 现在是 **async**，所以 `GET /board` 必须
  `boardSnapshot(dispatch, await resolveMemory(dispatch))`。漏了 `await` 会把 Promise 塞进 JSON，
  而 `JSON.stringify(Promise)` 得到 `{}`——客户端会以为「宿主给了一个空块」，比 `null` 更难排查。
  同时快照层**保留同步降级**：拿不到就给 `null`，绝不把 Promise 传下去，这样直接调 `boardSnapshot(dispatch)` 的旧代码不受影响。

### 工作区解析：每一级命中多个都不再静默取第一个

计划书没覆盖这条，但它和「口径」是同一类问题：**旧文档把「标题精确匹配」写成唯一的、没有歧义的，那是错的。**

实测（2026-11-08 12:10）：仓库根 `D:\idea\dsh-mini-superagent` 与包根
`D:\idea\dsh-mini-superagent\dsh-mini-superagent` 各自登记了一条标题都叫 `dsh-mini-superagent` 的工作区
（宿主按目录 basename 起标题）。用户点「dsh-mini-superagent」时被静默送进**另一个盘上的另一个目录**，
日志里一行线索都没有。

- **`resolve()` 四级（id / 绝对路径 / 标题精确 / 标题包含）遵守同一条规矩**：命中多个就返回 `undefined` 并
  warn 出全部候选，**绝不静默取第一个**。精确匹配的歧义比包含匹配更隐蔽——查询看起来「就是这个名字」。
- **候选文案必须带 `path`**（`describeMatches()`）：同名工作区之间 id 对人毫无区分度（都是一串 uuid）。
- **`resolveOrCreate()` 新增可选 `reason: 'ambiguous' | 'not-found'`**，只在没拿到工作区时出现；
  **空引用不给 `reason`**（「没给目标」不等于「找不到」，给它贴 `not-found` 只会让调用方为一句空话编错误文案）。
  它是**给调用方选文案用的**：0.8.0 及更早两者都是 `undefined`，`dispatch.js` 只能把所有失败都写成
  「找不到工作区「…」，且允许新建被关闭」——而这句话在歧义时是**假的**（并没有人关掉新建）。
- **歧义绝不新建**：`resolveOrCreate()` 在新建之前重跑一遍与 `resolve()` **完全一致**的判定
  （`diagnoseTitleRef`，精确在前、单字符不做包含匹配）。0.8.0 只判了包含匹配，于是「精确歧义」被当成「不存在」，
  直接 `mkdir` 出第三个同名目录——比原来的问题更糟。

### 工作区登记不再自动造出同名工作区

`SessionGateway.workspaceFor(cwd)` 原来调 `registry.create(cwd)` 不传标题，宿主拿目录 basename 当标题，
于是「仓库根」与「包根」各造出一条同名工作区，而且**每次按目录反查登记都会再撞一次**——这不是一次性脏数据。

现在显式传标题，`distinctTitle()` 挑一个不与已有标题撞车的名字：撞了就**逐段加长**
（`proj` → `b/proj` → `D:/idea/b/proj`），极端情况才退回 `（2）` 后缀。
三条硬约束来自实际踩坑：人能看出是哪个目录（用路径末段，不用 uuid/随机数）、不与已有标题重复（大小写不敏感）、
**不改已有工作区的标题**（改别人的标题等于把用户认过的名字偷偷换掉）。

### 文档

`docs/architecture.md` 新增 §26（权威源定义、旧口径为什么失效）、§27（归档 vs 退休）、
§28（P0 五项的行为与可观察后果）、§29（存储格式 v4 与留痕 13 字段）、§30（工作区解析语义），
并修正 §11 / §14 / §15 / §16 与模块表里过时的口径（`version: 3`、「四个 chip」、「`sameOrigin()`」、
「1017 行」、把用例数写死等）；`docs/board.md` 补路由表、`memory` 块、`input_unknown_at`、
「已退休」视图与记忆治理口径表；`docs/workspaces.md` 重写解析小节与 `reason` 契约，新增「按目录登记会造标题」
与「显式 `cwd` 被记住的目标覆盖」的缺口记录；`docs/tools.md` 同步 `dispatch_launch` 的 `workspace`/`cwd`、
`dispatch_inspect` 的退休分支、`dispatch_report` 的准入与截断；`README.md` 同步配置表、看板接口与已知限制。

**没写进本文档清单、但同批落地的**：`src/dispatch.js` 的 `cwd` 优先级修复见下一节。

### 修复：显式 `cwd` 被记住的派发目标静默丢弃

实测（2026-11-08 12:10）：主会话目标是 auto 时，`dispatch_launch({ cwd: 'D:\idea\dsh-mini-superagent' })` 派出的两个子会话
分别落到了 `…\Documents\mini-superagent\派发\2026-11-07` 与 `…\Documents\mini-superagent`。
用户给的 `cwd` 从头到尾没生效，`src/` 一个字节没变，现场看起来像「根本没派发」。
根因是旧代码 `cwd: target?.path ?? cwdFor(agent, cwd)`：只要存在任何 target（**包括 auto**），
显式 `cwd` 一次都没被读到，而且**没有任何提示**。

现在判据只有一条：**显式参数优先级高于记住的设置**——记住的 auto / 目标只是「调用方没指定时的默认」，
没有资格压掉调用方当场给出的参数。

| 调用方给了什么 | 结果 |
| --- | --- |
| 只给 `cwd`（会话有 auto / 记住的目标） | `cwd` 胜，auto 与目标这一轮当没设过 |
| `workspace` 与 `cwd` 同时给 | `workspace` 胜（会话住在它里面），`cwd` **仍被保留**为任务工作目录 |

第二行是关键细节：`task.cwd` 必须保留 `cwd`，否则 `task.cwd === placement.path`，
`start()` 里的 `enterDirectory()` 直接短路，`cwd` 又变成一句空话（正是旧版那个三元短路）。
连带修正：`placementFor()` 在「没有目标」分支里先看 `task.cwdExplicit`，
**显式 `cwd` 不再触发日期工作区兜底**——调用方明确给了目录，就不该再被塞进当天的【派发】。

**这条修的是「静默丢弃输入」这类缺陷，所以也补了说法**：`workspace` 解析失败时不再一律写成
「找不到工作区「…」，且允许新建被关闭」（歧义时那句话是假的），而是按归因分三种——
`ambiguous` 列出同名候选并说明「为避免建出重复目录，本次不自动新建」、
`not-found` + 真的关了新建保留原措辞、`not-found` + 允许新建但新建抛错则如实说「已按名字尝试新建，但没有成功」。
候选一律带 `path`：同名工作区之间 id 对人没有区分度。

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
  （环境变量 `DSH_DISPATCH_DIR` / `DSH_DISPATCH_TASK` / `DSH_DISPATCH_TITLE` / `DSH_DISPATCH_WORKSPACE` / `DSH_DISPATCH_CWD`），已存在则跳过。
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

## 0.5.3 — 2026-11-06

> 版本号订正：此段此前误记为 `0.5.2`，与本文件下一节重复。按倒序发布顺序
> 它晚于 0.5.2、早于 0.6.0，故订正为 0.5.3；内容未改动。

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
