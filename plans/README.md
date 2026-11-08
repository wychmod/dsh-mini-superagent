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
| [`07-memory-governance.md`](07-memory-governance.md) | 派发记忆治理：哪些事实是权威、哪些只是投影、何时合并、何时退休 | **P0 五项已实现**：`src/dispatch.js` 的 `memoryStats()` / `enforceLedgerCap()` / `sweepMemory()` / `forgetTargets()`，`test/memory.test.js` 16 条用例；**P1「降噪」与 P2「结构」未做** |
| [`08-session-reuse.md`](08-session-reuse.md) | 会话复用与任务连续性：复用被派发的会话、显式续派 + 候选建议 + 硬校验的可行性与成本 | **未实现**，仅规划（该文自身定的顺序是先做 07 的 P0）。现有能力只有 `dispatch_message` 把同一任务拉回 `running`；新任务仍新开 `dispatch-<taskId>` 会话 |
| [`09-board-analytics.md`](09-board-analytics.md) | 看板统计口径与多视图：从状态列表升级为判断工具，规划「总览 / 效果 / 拆解 / 历史」四视图、指标字典与数据契约 | **规划中**：P0（`settledAt`、`boardStats` 聚合、coverage）与 P1–P3 四视图均未实现（`src/` 与 `client/` 里检索不到 `boardStats`） |
| [`10-voice-style.md`](10-voice-style.md) | 主会话的语言风格：先认领任务、再说人话、能一眼看懂（报告文案形状与提示词里的说话规则） | **规划中**：`dispatch_report` 的可选 `headline` 字段、`reportText()` 四段式、提示词「说话方式」段均未实现（`src/` 里检索不到 `headline`） |

## 状态口径

- **已落地**：能在 `src/`、`client/` 或 CHANGELOG 里指到具体实现或发布记录。
- **大部分已落地**：同一份计划里既有已实现的部分，也有明确标注「撤回 / 不做 / 未做」的部分，逐条列在上表。
- **规划中 / 未实现**：只有方案与验收标准，代码里检索不到对应实现。
- **未核实**：本表暂未出现。后续补计划若无法从代码或 CHANGELOG 确认，按此标记，不要用「大概做了」代替。
