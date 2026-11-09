# plans 索引

本目录是 DSH 任务派发插件 [`dsh-mini-superagent`](../dsh-mini-superagent/) 的产品规划与可行性调研。
「主题」取自各文开头一两段；「状态」只填代码与 [`CHANGELOG.md`](../dsh-mini-superagent/CHANGELOG.md)
里能指认的事实，**确认不了的写「未核实」，不猜**。

| 文件 | 主题 | 状态 |
| --- | --- | --- |
| [`00-vision.md`](00-vision.md) | 五条需求的判定、依据与分期。结论：五条都能做，没有一条卡在 DSH 能力缺失上；真正要拍板的是四个产品语义问题 | 调研结论有效；需求 2/3/4/5 已落地（默认工作区 `src/dispatch.js:2237 provision()`、`workspace`/`create_workspace` 参数、`uiWorkspace.openSession` 跳转），需求 1 属 0.1–0.2 的派发+回报。**真机视觉验收仍未做** |
| [`01-composer.md`](01-composer.md) | 输入框工作区选择器与 `@` 选择两个控件的能力边界（逐条取证） | **已落地**：选择器注册在 `conversation.input.left`，`@` 触发源已注册，chip 的 `appearance` 省略（CHANGELOG 0.5.0 §新增）；界面**未在真浏览器里跑过** |
| [`02-workspace-ui.md`](02-workspace-ui.md) | 侧边栏 / 会话界面骨架与看板跳转的可行性调研 | **已落地**：跳转走 `uiWorkspace.openSession`（`client/index.js:2784`）；归档行按宿主导航策略改为不可点（CHANGELOG「未发布」§修复） |
| [`03-client-graph.md`](03-client-graph.md) | Web 客户端模块图的构建时机、漏检条件、能否不重启重建（答案：**不能**） | 结论已落地为排障口径：`scripts/http-smoke.mjs:65` 打印 `client.inGraph`，根 README「开发」节据此要求重启宿主。属调研结论，无独立功能项 |
| [`04-post-restart.md`](04-post-restart.md) | 重启宿主后的验收清单（三关按顺序跑，每关失败指向不同原因） | 验收清单，非功能项；随时可执行，无「已实现」状态 |
| [`05-superagent-router-worker.md`](05-superagent-router-worker.md) | 与上游 `dsh-superagent-prototype` @ `8c32a9d` 的架构对照：router 与 worker 两种会话角色 | **大部分已落地**：该文 §七「已对齐」列 10 条 + 「可对齐」标 ✅ 的 13/14/16/17/18/19/20/21 共 8 条，代码里可检索到（`enforceRouter` `src/dispatch.js:178`、`selfCheck`、`handOffToBackground`、`decorateSubagent`、`src/prepare.js` 等）；**未做**：#11/#15 明确撤回或不做，上游的「两个 agent preset 硬边界」与「带优先级预留的槽位」未照搬 |
| [`06-board-redesign.md`](06-board-redesign.md) | 任务看板从「流水账」重排成「指挥台」：问题拆解、参考对象、信息架构、效果数字怎么算 | **已落地**：三段式（`需要你处理` / `在跑与排队` / `最近完成`，`client/index.js:138-142`）+ 四个效果数字 + 并发条已上线（CHANGELOG「任务看板改版」）；**真机视觉验收仍未做** |
| [`07-memory-governance.md`](07-memory-governance.md) | 派发记忆治理：哪些事实是权威、哪些只是投影、何时合并、何时退休 | **P0 五项 + P1「降噪」已实现**：`src/dispatch.js` 的 `memoryStats()` / `enforceLedgerCap()` / `sweepMemory()` / `forgetTargets()` / `mergeableOf()` / `projectText()`，`test/memory.test.js` 16 条 + `test/p1-noise.test.js` 15 条用例；**P2「结构」未做** |
| [`08-session-reuse.md`](08-session-reuse.md) | 会话复用与任务连续性：复用被派发的会话、显式续派 + 候选建议 + 硬校验的可行性与成本 | **阶段 0「解耦」+ 阶段 1「最小可用」（模型 A）已落地**：显式绑定 `TaskTable.activeTaskId()` / `activeTaskOf()` / `tasksOfWorker()` / `workerState()`（`src/tasks.js`，`byWorker()` 优先走绑定；`task.threadId` 见 `src/constants.js` 的 `THREAD_PREFIX`），`test/thread-binding.test.js` 19 条；`dispatch_launch({ continue_task_id })` 走 `Dispatch.continueLaunch()`（`src/dispatch.js:674`），五条硬校验后转发为 `message()`、不新建任务，看板已结算行有「续派」按钮（`client/index.js` 的 `continueTask`），`test/continue-launch.test.js` 19 条。**未做**：阶段 2（模型 B：新任务复用会话 + 交接摘要 + `parentTaskId`——`src/` 里检索不到 `parentTaskId`，且须先加「同会话有活跃任务即 409」闸门）、阶段 3（线程级归档/退休，检索不到对应实现）、§四 的「候选建议」（引擎侧不返回可续派候选）；`cancel()` 仍是会话级打断（`src/dispatch.js:1915`），同会话有活跃任务时会间接波及 |
| [`09-board-analytics.md`](09-board-analytics.md) | 看板统计口径与多视图：从状态列表升级为判断工具，规划「总览 / 效果 / 拆解 / 历史」四视图、指标字典与数据契约 | **P0 + P1 + P2 已落地**：P0「统计口径地基」= 权威 `settledAt`（`src/tasks.js` 的 `settle()` / `transition()` 写、`reopen()` 清）+ `boardStats` 聚合与 coverage + 四数字补分子分母，`src/stats.js`（8 个导出：`boardStats` / `degradedStats` / `quantile` / `median` / `normalizeWindow` / `defaultWindowDays` / `settleTimeOf` / `inWindow`）+ `test/stats.test.js` 48 条 + 更新 `GET /board/stats`（`src/board.js:519`），活宿主实测 200：`statsVersion:1, coverage.sourceTasks:63, settled:31, timeBasis:mixed, daily:2 行`；P1「效果 + 拆解」= `EffectView` / `BreakdownView`（`client/index.js`）；P2「历史 + 详情抽屉」= `HistoryView` / `TaskDrawer`，`scripts/client-smoke.mjs` 实测 `全部通过：346 项检查`。**未做**：P3 全部四项——时间加权并发利用率（需宿主有界采样或 running 数变化事件，`src/` 检索不到 `utilization`）、消息级投递流水（检索不到 `deliveryLog` / `messageLog`）、稳定错误码与失败类型分布（检索不到 `errorCode` / `error_code`）、token/成本（检索不到 `tokenUsage` / `costUsd`，且需宿主先给真实模型用量）；均为缺宿主数据源，不是缺视图 |
| [`10-voice-style.md`](10-voice-style.md) | 主会话的语言风格：先认领任务、再说人话、能一眼看懂（报告文案形状与提示词里的说话规则） | **P0 + P1 已落地**：`headline` 字段、`reportText()` 四段式、失败/中断/批次文案在 `src/voice.js`（`test/voice-contract.test.js` 31 条）；提示词「说话方式」段 `SPEAK_RULE` 在 `src/prompt.js`，受 `test/voice-prompt.test.js` 的 ≤8 行 / ≤500 字门禁约束。**未做**：P2「`dispatch_inspect` 返回可直接转述的详情」、P3 追问率校准；`docs/voice-samples.md` 的 10 场景人工盲评仍待人跑 |

## 补充：分析数据看板（未发布，不属于 09 的四视图）

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

## 状态口径

- **已落地**：能在 `src/`、`client/` 或 CHANGELOG 里指到具体实现或发布记录。
- **大部分已落地**：同一份计划里既有已实现的部分，也有明确标注「撤回 / 不做 / 未做」的部分，逐条列在上表。
- **规划中 / 未实现**：只有方案与验收标准，代码里检索不到对应实现。
- **未核实**：本表暂未出现。后续补计划若无法从代码或 CHANGELOG 确认，按此标记，不要用「大概做了」代替。
