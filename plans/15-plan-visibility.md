# PRD：任务级计划透出（`dispatch_report.plan`）

> 状态：草稿，待评审
> 范围：只做「计划可见」，不做「计划确认门」、不做依赖编排（另见批次依赖 PRD）
> 代码基线：`dsh-mini-superagent` 0.8.0（git `a04733e` + 未提交改动）；行号以当前分支为准

---

## 1. 背景与要解决的问题

现在主会话把任务派给后台子会话后，只能看到两种信息：任务在跑、最后一条终态报告。中间过程里 worker 做到第几步，主会话和用户都不知道。

原因不是 worker 不报，而是：

- `dispatch_report` 只有 `status` / `headline` / `summary` / `detail`（`src/tools.js:430-455`），没有结构化的「步骤」字段；
- `progress` 报告默认只进账本、不回流（`src/constants.js:439` 的 `directReportStatuses` 只有 `blocked` / `failed`，`ADMISSION` 在 `src/constants.js:168-188`）；
- 看板只展示任务状态、报告数、attempt，没有「第几步 / 共几步」的位置（`src/board.js:74` 的 `boardTask()`；客户端 `client/index.js:4265` 的标签行、`4366-4381` 的元信息行）。

结果是：长任务只能靠人反复 `dispatch_inspect` 或等最终报告；派发方无法判断「要不要现在干预」，也无法在批次里比较谁快谁慢。

**这次要解决的最小问题**：让用户在**不增加会话消息**的前提下，从看板一眼看到「当前任务走到第几步」。

---

## 2. 目标与非目标

### 目标

1. `dispatch_report` 增加可选 `plan`，worker 用一次调用同时交「报告 + 最新计划」。
2. 账本记住**最新一版计划**；看板任务行显示 `2/5`，抽屉显示当前步骤文案。
3. 不新增任何会话消息、不触发主会话唤醒；不改变现有 `progress` 的准入。
4. 计划随账本落盘，重启后仍在。
5. 计划更新必须在任务结算后冻结，避免和终态报告打架。

### 非目标

- 不做「计划确认后 worker 才能开工」（那是另一份 PRD 的范围）。
- 不做计划版本历史、逐步耗时、每步负责人。
- 不做看板内编辑计划、拖拽排序。
- 不做计划变更通知（不往会话里推「计划改了」）。
- 不新增独立看板接口；复用现有 `/board` 快照。

---

## 3. 使用场景

1. **长任务**：worker 领到「改 5 个文件」的任务，首条 `progress` 报告带上 5 步计划；用户在看板看到 `2/5`，知道不用催。
2. **中途改计划**：worker 发现要多加一步，下一次 `progress` 带新计划；看板变为 `2/6`，并显示「计划已更新」。
3. **任务结束**：终态报告不再带计划；看板以终态优先，`2/5` 让位给「完成/失败」。
4. **主会话不打扰**：整个过程中，主会话没有新增消息；只有用户主动看板时才看到进度。

---

## 4. 功能与交互细节

### 4.1 数据形状（建议）

`plan` 是一个步骤数组，数组顺序即执行顺序：

```json
{
  "status": "progress",
  "headline": "已完成接口层，正在补测试",
  "summary": "…",
  "plan": [
    { "text": "改 tools.js 参数", "status": "done" },
    { "text": "补 dispatch 单测", "status": "doing" },
    { "text": "跑全量测试", "status": "pending" }
  ]
}
```

规则：

| 项 | 规则 |
| --- | --- |
| 步骤数 | 最多 12 步（`maxPlanSteps`，新增配置）；超出截断并返回 `plan_truncated: true` |
| 单步文案 | 最多 120 字（`maxPlanStepChars`）；超长截断 |
| 状态 | `pending` / `doing` / `done`；缺省按 `pending` |
| 空文案 | 丢弃该步；全空视同没传 `plan` |
| 重复步骤 | 不去重（顺序有意义），但完全相同文案超过 3 次时只保留前 3 条 |
| 覆盖语义 | 每次传 `plan` 都是**整版替换**，不是增量合并；这样 worker 不需要维护 step id |
| 计数 | `done / total`，显示为 `2/5`；`doing` 只用于显示当前步骤文案 |

### 4.2 工具行为

- `plan` 只在 `status` 为 `progress` / `blocked` / 终态时接受；`queued` 不是 worker 能报的状态。
- 传了 `plan` 但 `status` 是终态时：先应用计划，再结算，然后**冻结**（后续任何 `plan` 更新返回 `plan_accepted: false`）。
- 没传 `plan` 的报告不改变已有计划；避免「只报结果」把计划清空。
- 返回值新增两个字段：`plan_accepted`（布尔）、`plan_truncated`（布尔）；不改变原有 `recorded` / `projection` / `delivered` 语义。

参数 schema 落点：`src/tools.js:430-455` 的 `dispatch_report` 注册处；`plan` 的解析与上限复用 `src/tools.js` 现有的字符串清洗函数。

### 4.3 看板展示

| 位置 | 现状 | 改成 |
| --- | --- | --- |
| 任务行标签区（`client/index.js:4265` 附近，attempt 标签旁） | 状态 / attempt / 后台活 | 增加一个 `2/5` 标签，只在 `queued` / `running` 且有计划时出现 |
| 任务行元信息（`client/index.js:4366-4381`） | `报告 3` | 改为 `报告 3 · 2/5`，或在标签区单独显示；二选一，不重复 |
| 任务抽屉（`client/index.js:5596-5616` 的 kv 列表） | 报告数 / 第几次 | 增加「计划 2/5」与「当前步骤：补 dispatch 单测」 |
| 批次头（如有分组视图） | 只显示成员状态 | 显示组内 `done/total` 的聚合，例如「3 个成员 · 完成 1」 |

显示优先级：**终态 > 计划 > 报告数**。任务 `done` 后不再显示 `2/5`，避免「明明完了还停在第 2 步」。

### 4.4 worker 侧提示

`src/prompt.js` 的 worker 工作方式里加一条**软建议**（不是硬规则）：

> 任务超过 3 个步骤时，在首条 `progress` 报告里给 `plan`；每完成一步更新一次。步骤文案写「做什么」，不写「正在做」。

这样既能让计划出现，又不会让所有小任务都背上计划开销。

---

## 5. 数据与接口改动

| 层 | 改动 | 位置 |
| --- | --- | --- |
| 工具 schema | `dispatch_report` 增可选 `plan`；返回值增 `plan_accepted` / `plan_truncated` | `src/tools.js:430-455` |
| 报告入库 | `report()` 调用 `#admitEntry(status, input)` 时把 `plan` 一起归一化、截断；**不写进每条 report entry**，只写 `task.plan`，避免 50 条报告 × 12 步把账本撑大 | `src/dispatch.js:1492`、`#admitEntry` `1732` |
| 计划应用 | 新增 `#applyPlan(task, plan)`：整版替换、计数、`plan_updated_at`、终态冻结 | `src/dispatch.js`（`#admitEntry` 内调用） |
| 投递投影 | `projectReport()` **不读** `plan`；计划永远不参与「是否回流/是否合并」的判断 | `src/dispatch.js:1886` |
| 账本 | 无需改序列化：`store.js` 原样序列化 task 对象，`plan` 自动落盘（`src/store.js:119-125`） | — |
| 恢复 | `restore()` 用 `...item` 重建任务，`plan` 自动保留；无需额外迁移 | `src/dispatch.js:3349-3351` |
| 看板快照 | `boardTask()` 增 `plan_total` / `plan_done` / `plan_current`；**不返回完整步骤数组**，控制 2s 轮询体积 | `src/board.js:74` |
| 客户端 | 标签/元信息/抽屉三处渲染；文案走 `locale/zh.json` / `en.json` | `client/index.js:4265`、`4366-4381`、`5596-5616`；`client/index.js:446/948` 一带的文案表 |
| 配置 | 新增 `maxPlanSteps`（默认 12）、`maxPlanStepChars`（默认 120） | `src/constants.js:405-407` 的 DEFAULTS 区 |
| 契约测试 | `test/contract-consistency.test.js` 增加「工具 schema 字段 ↔ 常量上限 ↔ 看板字段」一致性 | `test/contract-consistency.test.js` |

**为什么不在每条 report 里存 plan**：`MAX_REPORTS = 50`（`src/constants.js:610`），每条报告都带 12 步会显著放大账本；而看板只需要「最新一版」，历史计划没有决策价值。

---

## 6. 状态机与边界情况

| 场景 | 行为 |
| --- | --- |
| 任务 `queued` | 不接受 `plan`（worker 还没起来）；看板不显示计划 |
| 任务 `running`，首次带 `plan` | 应用，`plan_done=0`，显示 `0/5` |
| 连续两次 `progress`，第二次没带 `plan` | 保留第一次的计划，不显示「计划已更新」 |
| 第二次带了更短的计划 | 整版替换，`2/5` → `1/3`；显示「计划已更新」一次（本地状态，不入账本） |
| 计划里全是 `done`，但任务还在跑 | 允许；看板显示 `5/5`，不自动结算 |
| 终态报告带 `plan` | 先应用再结算；结算后冻结 |
| 终态报告之后又来 `progress` 带 `plan` | 拒绝：`plan_accepted:false`；同时按「终态后不再写账本」的既有治理方向处理该报告（见结构分析 P1-1） |
| 报告重复投递 | `#applyPlan` 幂等：内容相同不更新 `plan_updated_at`，不产生额外写盘 |
| 并发两个报告（steer/queue 乱序） | 以 `#admitEntry` 的处理顺序为准，后处理者胜出；worker 是单会话，正常不会乱序。**不引入 plan version 字段**，避免过度设计 |
| 计划超长 | 截断到 12 步 / 120 字，返回 `plan_truncated:true`；不报错 |
| 账本恢复 | `plan` 随 task 恢复；`plan_updated_at` 不参与任何窗口计算 |
| 归档/退休 | 归档记录原样带走 `plan` 字段；退休视图按现有 `boardTask()` 逻辑展示（若字段存在） |
| 计划更新导致写盘 | `progress` 报告走防抖落盘；崩溃最多丢 800ms 内的计划更新，可接受 |

---

## 7. 兼容与迁移

- **旧账本**：没有 `plan` 字段的任务按「无计划」处理，看板不显示，不需要迁移脚本。
- **旧客户端**：`boardTask()` 新增字段是向后兼容的；旧客户端忽略即可。
- **旧 worker 提示**：即使 worker 完全不传 `plan`，行为与现在一致。
- **工具契约**：`plan` 是可选参数，现有调用方不受影响；`required` 仍是 `status` + `summary`。
- **配置**：新增两个 DEFAULTS 项，旧 `cordis.patch.yml` 不用改。

---

## 8. 对现有优势的影响

| 现有机制 | 影响 | 结论 |
| --- | --- | --- |
| `ADMISSION` / `PROJECTION` 分离（`src/constants.js:168-188`） | `plan` 只改账本，不改准入；`progress` 仍然只入账、不回流 | **不动**，这正是本方案不打扰会话的基础 |
| `settledAt` 权威结算（`src/tasks.js` 的 `#markSettled`） | 计划不参与耗时、窗口、完成率；`plan_updated_at` 不替代 `updatedAt` | **无影响** |
| 投递 durability（`task.delivery`、重试、`durability`） | `plan` 不进入任何投递路径 | **无影响** |
| 报告封顶与截断（`maxReportSummaryChars` / `maxReportDetailChars` / `MAX_REPORTS`） | 新增计划上限，但计划不占报告条数 | **体积可控** |
| 「一次派发 ≤3 条消息」的降噪验收 | 不新增消息 | **不破坏** |
| 看板 2s 轮询体积 | 只加 3 个标量字段，不加步骤数组 | **可接受** |

---

## 9. 验收口径

1. 派发一个 5 步任务，worker 在第一次 `progress` 带 `plan`；看板任务行 2 秒内出现 `0/5`，完成后变 `2/5`。
2. 同一时间主会话消息数不增加；`dispatch_wait` / 主会话轮次与改造前一致。
3. 计划在重启后仍显示（杀进程 → 重启 DSH → 看板仍是 `2/5`）。
4. 终态报告后，看板显示「完成/失败」，不再显示 `2/5`；再补一条 `progress` 不会把计划写回去。
5. 计划 20 步 / 单步 500 字：工具返回 `plan_truncated:true`，账本里只有 12 步、每步 ≤120 字。
6. 旧账本（无 `plan`）加载后看板正常，无报错、无「undefined」。
7. `test/contract-consistency.test.js`、`test/settledat-invariant.test.js` 全绿。

---

## 10. 需要拍板的问题

1. **计划形状**：用 `{text,status}` 数组（能显示当前步骤），还是最简 `string[]` + `done` 数（实现更小）？本文建议前者。
2. **看板返回多少**：只回 `plan_done/plan_total/plan_current` 三个标量（本文建议，控制 2s 轮询体积），还是回完整步骤数组（抽屉能看全，但 200 条任务时 payload 明显变大）？
3. **是否允许 worker 缩减计划**：允许（本文建议，反映真实变化），还是只允许追加（防止「把没做的步骤删掉刷进度」）？
4. **终态后是否彻底冻结**：本文建议冻结并拒绝写入；如果希望保留「完工后补一版计划」的能力，需要放宽，但会和「终态后不再写账本」的治理方向冲突。
