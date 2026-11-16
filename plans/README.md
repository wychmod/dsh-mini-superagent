# plans 索引

本目录是 DSH 任务派发插件 [`dsh-mini-superagent`](../dsh-mini-superagent/) 的产品规划与可行性调研。
「主题」取自各文开头一两段；「状态」只填代码与 [`CHANGELOG.md`](../dsh-mini-superagent/CHANGELOG.md)
里能指认的事实，**确认不了的写「未核实」，不猜**。

| 文件 | 主题 | 状态 |
| --- | --- | --- |
| [`00-vision.md`](00-vision.md) | 五条需求的判定、依据与分期。结论：五条都能做，没有一条卡在 DSH 能力缺失上；真正要拍板的是四个产品语义问题 | 调研结论有效；需求 2/3/4/5 已落地（默认工作区 `src/dispatch.js:2237 provision()`、`workspace`/`create_workspace` 参数、`uiWorkspace.openSession` 跳转），需求 1 属 0.1–0.2 的派发+回报。**真机视觉验收仍未做** |
| [`01-composer.md`](01-composer.md) | 输入框工作区选择器与 `@` 选择两个控件的能力边界（逐条取证） | **已落地**：选择器注册在 `conversation.input.left`，`@` 触发源已注册，chip 的 `appearance` 省略（CHANGELOG 0.5.0 §新增）；界面**未在真浏览器里跑过** |
| [`02-workspace-ui.md`](02-workspace-ui.md) | 侧边栏 / 会话界面骨架与看板跳转的可行性调研 | **已落地**：跳转走 `uiWorkspace.openSession`（`client/index.js:2784`）；归档行按宿主导航策略改为不可点（CHANGELOG「修复」节） |
| [`03-client-graph.md`](03-client-graph.md) | Web 客户端模块图的构建时机、漏检条件、能否不重启重建（答案：**不能**） | 结论已落地为排障口径：`scripts/http-smoke.mjs:65` 打印 `client.inGraph`，根 README「开发」节据此要求重启宿主。属调研结论，无独立功能项 |
| [`04-post-restart.md`](04-post-restart.md) | 重启宿主后的验收清单（三关按顺序跑，每关失败指向不同原因） | 验收清单，非功能项；随时可执行，无「已实现」状态 |
| [`05-superagent-router-worker.md`](05-superagent-router-worker.md) | 与上游 `dsh-superagent-prototype` @ `8c32a9d` 的架构对照：router 与 worker 两种会话角色 | **大部分已落地**：该文 §七「已对齐」列 10 条 + 「可对齐」标 ✅ 的 13/14/16/17/18/19/20/21 共 8 条，代码里可检索到（`enforceRouter` `src/dispatch.js:178`、`selfCheck`、`handOffToBackground`、`decorateSubagent`、`src/prepare.js` 等）；**未做**：#11/#15 明确撤回或不做，上游的「两个 agent preset 硬边界」与「带优先级预留的槽位」未照搬 |
| [`06-board-redesign.md`](06-board-redesign.md) | 任务看板从「流水账」重排成「指挥台」：问题拆解、参考对象、信息架构、效果数字怎么算 | **已落地**：三段式（`需要你处理` / `在跑与排队` / `最近完成`，`client/index.js:138-142`）+ 四个效果数字 + 并发条已上线（CHANGELOG「任务看板改版」）；**真机视觉验收仍未做** |
| [`07-memory-governance.md`](07-memory-governance.md) | 派发记忆治理：哪些事实是权威、哪些只是投影、何时合并、何时退休 | **P0 五项 + P1「降噪」已实现**：`src/dispatch.js` 的 `memoryStats()` / `enforceLedgerCap()` / `sweepMemory()` / `forgetTargets()` / `mergeableOf()` / `projectText()`，`test/memory.test.js` 16 条 + `test/p1-noise.test.js` 15 条用例；**P2「结构」未做** |
| [`08-session-reuse.md`](08-session-reuse.md) | 会话复用与任务连续性：复用被派发的会话、显式续派 + 候选建议 + 硬校验的可行性与成本 | **阶段 0「解耦」+ 阶段 1「最小可用」（模型 A）+ 阶段 2「复用会话」（模型 B）已落地**：显式绑定 `TaskTable.activeTaskId()` / `activeTaskOf()` / `tasksOfWorker()` / `workerState()`（`src/tasks.js`，`byWorker()` 优先走绑定；`task.threadId` 见 `src/constants.js` 的 `THREAD_PREFIX`），`test/thread-binding.test.js` 19 条；`dispatch_launch({ continue_task_id })` 走 `Dispatch.continueLaunch()`，五条硬校验后转发为 `message()`、不新建任务，看板已结算行有「续派」按钮（`client/index.js` 的 `continueTask`），`test/continue-launch.test.js` 19 条；`handoff_from` / `handoff_reason` / `no_reuse` 新建任务并沿用来源子会话，`launch()` 记录 `parentTaskId` 血缘（`src/dispatch.js` 的 `#startReused()`，落盘与 `restore()` 都保留，看板 `handoff_from` 由 `boardTask()` 投影），`test/session-reuse.test.js` 35 条。§四 的「候选建议」已由只读工具 `dispatch_candidates` 落地（plans/11）。**未做**：阶段 3（线程级归档/退休，检索不到对应实现）；`cancel()` 仍是会话级打断，同会话有活跃任务时会间接波及 |
| [`09-board-analytics.md`](09-board-analytics.md) | 看板统计口径与多视图：从状态列表升级为判断工具，规划「总览 / 效果 / 拆解 / 历史」四视图、指标字典与数据契约 | **P0 + P1 + P2 已落地**：P0「统计口径地基」= 权威 `settledAt`（`src/tasks.js` 的 `settle()` / `transition()` 写、`reopen()` 清）+ `boardStats` 聚合与 coverage + 四数字补分子分母，`src/stats.js`（8 个导出：`boardStats` / `degradedStats` / `quantile` / `median` / `normalizeWindow` / `defaultWindowDays` / `settleTimeOf` / `inWindow`）+ `test/stats.test.js` 48 条 + 更新 `GET /board/stats`（`src/board.js:519`），活宿主实测 200：`statsVersion:1, coverage.sourceTasks:63, settled:31, timeBasis:mixed, daily:2 行`；P1「效果 + 拆解」= `EffectView` / `BreakdownView`（`client/index.js`）；P2「历史 + 详情抽屉」= `HistoryView` / `TaskDrawer`，`scripts/client-smoke.mjs` 当时实测 346 项检查（当前全套 817 项）。**未做**：P3 全部四项——时间加权并发利用率（需宿主有界采样或 running 数变化事件，`src/` 检索不到 `utilization`）、消息级投递流水（检索不到 `deliveryLog` / `messageLog`）、稳定错误码与失败类型分布（检索不到 `errorCode` / `error_code`）、token/成本（检索不到 `tokenUsage` / `costUsd`，且需宿主先给真实模型用量）；均为缺宿主数据源，不是缺视图 |
| [`10-voice-style.md`](10-voice-style.md) | 主会话的语言风格：先认领任务、再说人话、能一眼看懂（报告文案形状与提示词里的说话规则） | **P0 + P1 已落地**：`headline` 字段、`reportText()` 四段式、失败/中断/批次文案在 `src/voice.js`（`test/voice-contract.test.js` 31 条）；提示词「说话方式」段 `SPEAK_RULE` 在 `src/prompt.js`，受 `test/voice-prompt.test.js` 的 ≤8 行 / ≤500 字门禁约束。**未做**：P2「`dispatch_inspect` 返回可直接转述的详情」、P3 追问率校准；`docs/voice-samples.md` 的 10 场景人工盲评仍待人跑 |
| [`12-dispatch-card.md`](12-dispatch-card.md) | 派发卡：把 `dispatch_launch` / `dispatch_launch_many` 的通用工具行改成批次卡（Tool View 接缝：`tool.call.toolview`） | **已落地（2026-11-16）**：`tool.call.toolview` 注册见 `client/index.js:11210`，`package.json` 的 `dsh.client.inject` 已加 `@deepseek-ai/dsh-client-ui-tool`；三阶段 `preparing/start/result`、超 4 行折叠、启动失败占位；P1 实时按 `?group=` / `?task=` 轮询（`src/board.js:413`）、一个 group 一个定时器、全部结算后降频 15s、`document.hidden` 暂停、连续 3 次失败标「状态可能已过期」；另注册 `conversation.chat.turnTail` 本轮派发摘要（工具行被折叠时仍可见）。**未做**：plans/14 §12.3 的手工视觉清单未逐项记录 |
| [`13-report-card.md`](13-report-card.md) | 报告卡：把回流报告从 `context` 行改成卡片（Conversation Node 接缝：`events.register` + `conversation.chat.node`） | **已落地（2026-11-16）**：`REPORT_NODE_KIND = 'dispatch-report'`（`client/index.js:123`），`uiConversation.events.register` 以 `exclusive` 认领插件来源的 relay `user/message`，再在 `conversation.chat.node` 渲染；按【任务】【结果】【备注】【需要】四段解析，**任一段解析不出就整份退回原文卡**（原文始终在 DOM，【细节】里是完整 raw）；状态 chip + 一键复制原文；注册顺序固定「先 renderer 再 Definition」，失败 warn 一次并撤 renderer；`test/voice-contract.test.js` 反向钉住 `REPORT_SECTIONS` 段名。**未核实**：plans/14 G2 的五条真机标准（只出现一次 / 轮次导航 / compact / 刷新去重 / 热重载）没有逐条验收记录；真机只抓到并修掉了 `<details>` 把 `open` 当受控属性导致的「点了没反应」 |
| [`14-cards-degradation-validation.md`](14-cards-degradation-validation.md) | 12/13 的配套策略：L0–L3 降级阶梯、逐项降级矩阵、`client-ready` 可观测、G0–G3 四道验证闸门与回滚 | **策略已部分执行**：G0 离线闸门落在 `scripts/client-smoke.mjs`（当前 817 项，覆盖 L2/L3 降级、10 条失败注入、parser 畸形 fixture、槽注册与 `CARD_FEATURES` kill switch）；G3 常量级关闭已实现（`client/index.js:88` 的 `CARD_FEATURES`），`GET /board/selfcheck` 的 `client.ready.cards` 可读（`docs/board.md`）。**未做 / 未记录**：G1 的三条 `http-smoke.mjs` 用例（`?group=` / `?task=` / `cards`）尚未补；G2 真机五条没有逐条验收记录；§12.3 / §6 的真机目视与部分失败注入（`clipboard` 缺失、断网）只在离线层覆盖 |
| [`prd-01-task-plan-visibility.md`](../2026-11-11/code-structure-analysis/outputs/prd-01-task-plan-visibility.md) | 任务级计划透出：worker 在报告里说「分几步、走到哪一步」，看板用 `2/5` 与当前步骤透出，但不新增消息、不放大快照 | **已落地**：`dispatch_report.plan`（`[{text,status}]`、整版替换、`maxPlanSteps` 12 / `maxPlanStepChars` 120、`plan_accepted` / `plan_truncated`）、`#applyPlan()` 的终态冻结与幂等、`boardTask()` 的 `plan_total` / `plan_done` / `plan_current`（已结算不下发）。**审计确认的缺口**：① §6「计划更新后显示『计划已更新』一次」**已实现**（A7 收口：`client/index.js` 的 `lastPlan` / `planNotice` 两张表 + `PLAN_NOTICE_MS = POLL_MS * 3` = 6 秒窗口；验收见 `scripts/client-smoke.mjs` 的「归档按钮改名与提示 / 计划已更新」段）；② §5 写归一化在 `#admitEntry`，实际在 `report()` 里调 `normalizePlan()`（等价，位置不符）；③ 原记录的「`card()` / `detail()` 都不投影 `task.plan`，「全量计划走 `dispatch_inspect`」在代码里没有落点」**已被 A2 收口**——`detail()` 现在投影全量 `plan`（已结算任务照样返回，`test/inspect-plan-deps.test.js` 断言），`card()` 仍刻意不投影（列表是每轮全量，步骤数组会撑大返回体），这句话在代码里已有落点 |
| [`prd-02-batch-dependencies.md`](../2026-11-11/code-structure-analysis/outputs/prd-02-batch-dependencies.md) | 批次依赖：后一步等前一步结算，被挡任务仍 `queued` 但不占并发位；前置失败则连带取消并标注原因 | **已落地**：`dispatch_launch.depends_on` / `launch_many` 的 `depends_on_index`、开始前判定（`blockedBy` / `blockedReason`）、连带取消 `#cancelDependents()`（`cancel_reason` / `error_code`）、恢复收敛、看板五字段、四个错误码、`maxDependsOn`（默认 8，超限报错不截断）。**审计确认的缺口**：§6「前置被 retry 重开 → 记一条 warn」未实现（`#cancelDependents()` 只对「后继 running」记 warn，见 §4.4）；见下方「已知限制」小结 |

## 补充：PRD-01 / PRD-02 的已知限制（2026-11-12 审计）

- **E1（部分收口，2026-11-13）**：PRD-01 §6 的「计划更新后显示『计划已更新』一次」**已实现**（A7）——
  看板行与抽屉在计划三元组（总步数 / 已完成 / 当前步骤）变化时亮一个徽标，窗口
  `PLAN_NOTICE_MS = POLL_MS * 3`（= 6 秒，3 个轮询周期），首次出现 / 页面刷新不提示、
  `stale` 快照不比较、任务结算即清理；实现见 `client/index.js` 的 `lastPlan` / `planNotice`
  两张表，验收落在 **`scripts/client-smoke.mjs`** 的「归档按钮改名与提示 / 计划已更新」段
  （该段 15 项断言覆盖：窗口按 `POLL_MS` 推导、首次出现不亮、`2/5`→`3/5` 亮一次、窗口内不重复、
  跨窗口后消失且数字保留、失败期间不提示、恢复首轮只重建基线、恢复后判定照常、抽屉同步、
  已结算不显示、刷新不补提示）；
  PRD-02 §6 的「前置被 retry 重开 → 记一条 warn」仍**未做**（只有 `#cancelDependents()` 对「后继 running」
  记 warn，那是 §4.4 的另一条）；PRD-01 §5 把计划归一化写在 `#admitEntry`，实际在 `report()` 里调
  `normalizePlan()`（行为等价，位置与文档不符）。
- **E2（已知限制）**：计划与依赖都没有 token / 成本字段；两项能力本轮**无真机视觉验收**（看板渲染未在真实浏览器里逐屏核对），
  `docs/voice-samples.md` 的人工盲评也仍未做。
- **E2 已收口（2026-11-12）**：`dispatch_message` 不再能唤醒被依赖挡住的任务——`message()` 在投递前用
  `#blockedStateOf()` 现算一次，被挡就抛 `dispatch/conflict`（`dispatch_message` / 续派 / 看板续派三条入口同时受约束），
  见 CHANGELOG「修复：截断标记误报、热重载误判与依赖准入绕过」。

## 补充：分析数据看板（已随 0.9.1 发布，不属于 09 的四视图）

顶层新增 `任务看板 / 分析看板` 二选一切换，任务看板零改动。分析看板走**另一条**只读路由
`GET /board/analytics`（`src/analytics.js`），按 `createdAt` 的队列口径统计任务总量、状态分布、
完成率、超时代理与按天趋势；与 09 的 `/board/stats`（按结算时刻、归档不投票）**刻意不同**，
两套分母各自在界面写明。账本没有人员字段与 `due_at`，负责人 / 逾期均标为代理指标并写「待业务确认」。
布局图、指标口径表、状态处理与刷新方案见 [`dsh-mini-superagent/docs/board.md`](../dsh-mini-superagent/docs/board.md)。

## 补充：12 条缺陷的修复（2026-11-09）

一次针对「复活已结算任务」与「口径漂移」的集中修复。四条与复活有关（`settledAt` 不刷新 /
第二轮零报告被判 done / 取消被投递撤销 / 已归档任务可复活），四条与统计口径有关
（`timeBasis` 被窗口外污染 / 可靠性块不按工作区筛选 / 「未标注」永远筛不出 / 缺时间恒为 0），
四条在客户端（图表判空漏 cancelled/ended / 2 秒轮询不看面板 / 口径行用新窗口配旧数字 / 死代码与常量漂移）。

**口径只有一份**这条原则在这次修复里落成三处具体动作：`TaskTable.transition()` 统一承担
「离开终态即失效」，`dispatch.continueTask()` 统一承担续派准入（工具入口与看板入口共用），
`SAMPLE_LOW_BELOW` / `defaultWindowDays` / `ANALYTICS_UNKNOWN` 这些口径一律复用既有导出。

新增用例：`test/resume-after-settle.test.js`（7 条，钉复活路径的四条事实）、
`test/stats.test.js` +6 条、`test/analytics.test.js` +6 条、`test/memory.test.js` +2 条、
`test/board.test.js` +1 条；`scripts/client-smoke.mjs` +6 项（图表判空、轮询停摆、口径行跟 payload）。

## 补充：卡片落地与 0.10.0 发布（2026-11-16）

12 / 13 的代码已全部进 `main`（`203358f` 派发卡、`834efd8` 的 `/board?group=`、`f140c73` 的
`client.ready.cards`、`f6db9c2` 报告卡正式版与派发卡实时状态）。当前实测：`npm test` **660 pass / 0 fail**，
`node scripts/client-smoke.mjs` **817 项全过**。

**发布面已收口**：`dsh-mini-superagent@0.10.0` 已上 npm（`latest`，2026-11-16 11:36:28 +08:00，
tarball integrity 与本地 pack 一致）；`v0.10.0` tag 与 GitHub Release 已创建。GitHub Pages 已启用
（`main` 根目录 + `.nojekyll`），`https://wychmod.github.io/dsh-mini-superagent/` 返回 200，
线上 `index.html` 与仓库版本字节一致（127,108 B）。

**P0 工程收口（0.10.1）**：补了 `src/config.js` 的 Schemastery `Config`（错配置 fail loud，默认值引用
`DEFAULTS`）；`webServer` 改 `ctx.inject` 延迟注入、`workspaceRegistry` 进硬 `inject`；
`restrictWorkerTools()` 把 worker 收窄到只剩 `dispatch_report`；看板路由注册包了一层失败隔离。
新增四组用例（Config / worker 边界 / 看板注册 / apply 生命周期），单测从 643 升到 **660**。

已能指认的落地面：

- 派发卡：`tool.call.toolview` 双 key 注册、三阶段、4 行折叠、`?group=` / `?task=` 轮询、
  单 group 单定时器、结算后降频、页面隐藏暂停、3 次失败标「可能已过期」；`conversation.chat.turnTail`
  本轮摘要与它各自独立降级。
- 报告卡：`dispatch-report` 节点、`exclusive` 认领、四段解析、原文卡兜底、状态 chip、复制原文；
  先 renderer 后 Definition 的顺序被失败注入用例钉住。
- 降级可观测：`GET /board/selfcheck` 的 `client.ready.cards.batch` / `.report` 三态
  （`on` / `error:slot` / `error:register` / `error:parse`）；`CARD_FEATURES` 常量级关闭。

仍未收口（不阻塞 0.10.0 发布，但要记在案）：

1. **G1 / G2 未收口**：`scripts/http-smoke.mjs` 还没有 `?group=` / `?task=` / `cards` 三条用例
   （单测已覆盖过滤与截断语义）；报告卡 G2 五条只有「`<details>` 点击被重渲染收回」这一条有真机记录，
   其余（单条报告、轮次导航、compact、刷新去重、热重载）未逐条验收。
2. **手工视觉清单未跑**：plans/12 §12.3、plans/13 §12.3 的间距、对比度、窄屏折行、portal 翻转
   仍以离线断言为准，未截图目视。落地页也受同一限制：浏览器控制器截图超过 10 MiB，无法做像素级目视。

本次已收口（0.10.0）：版本号已同源到 `package.json`、`src/constants.js`、根 README、包内 README、
`index.html`、`docs/board.md` / `docs/tools.md` 示例与 CHANGELOG 标题；CHANGELOG 补了派发卡 / 报告卡 /
轮次摘要条目，并补上 0.9.1 / 0.9.0 的正式版本标题；`docs/board.md` 不再声称报告卡未实现；
根 README 与落地页的 629 / 450 已改成当前实测数字（现为 660 / 817）；包内 README 补了「会话里的两张卡」一节。

发布与页面：npm `0.10.0` 已发布（`latest`）、`v0.10.0` tag 与 GitHub Release 已建；GitHub Pages
已启用并完成两次构建，线上页面与本地字节一致，0 个未闭合标签 / 重复 id / 失效锚点，6 个按钮均有
`type`，5 个外链中 4 个 200（npmjs.com 对 curl 返回 403，属反爬，不是死链）。

## 状态口径

- **已落地**：能在 `src/`、`client/` 或 CHANGELOG 里指到具体实现或发布记录。
- **大部分已落地**：同一份计划里既有已实现的部分，也有明确标注「撤回 / 不做 / 未做」的部分，逐条列在上表。
- **规划中 / 未实现**：只有方案与验收标准，代码里检索不到对应实现。
- **未核实**：本表暂未出现。后续补计划若无法从代码或 CHANGELOG 确认，按此标记，不要用「大概做了」代替。
