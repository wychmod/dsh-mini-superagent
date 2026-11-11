# PRD：批次依赖（`depends_on`）

> 状态：草稿，待评审
> 范围：只做「后一步等前一步」的准入，不扩散到计划透出、任务链复用、跨批次编排
> 代码基线：`dsh-mini-superagent` 0.8.0（git `a04733e` + 未提交改动）；行号以当前分支为准

---

## 1. 背景与要解决的问题

`dispatch_launch_many` 今天是**纯并行**：`for (const item of args.tasks)` 逐个 `dispatch.launch`，共用同一个 `group`（`src/tools.js:227-251`）。这适合「5 个模块各自重构」，但不适合真实工程里最常见的「先改接口，再补实现，最后跑测试」。

现在遇到有先后关系的活，只能：

1. 先派第一步，回到主会话等报告；
2. 人看完报告，再派第二步。

问题不在工具不够多，而在**调度器没有「前置条件」这个概念**：

- `takeRunnable()` 只判并发位和会话是否忙，不判任务之间有没有依赖（`src/tasks.js:403-427`）；
- 任务对象里没有依赖字段（`src/dispatch.js:670-702`）；
- `launch_many` 的每个 item 没有依赖参数（`src/tools.js:201-221`）；
- 结算后 `pump()` 会补位（`src/dispatch.js:1209-1213`），这是天然的「前置完成 → 触发后继」的挂点，但目前没有后继可触发。

**这次要解决的最小问题**：让同一批（或显式指定的）任务能声明「我等谁」，并且只在等待对象结算后才开始。

---

## 2. 目标与非目标

### 目标

1. `dispatch_launch` / `dispatch_launch_many` 支持 `depends_on`（任务 id）与批内 `depends_on_index`（下标）。
2. `queued → running` 增加「所有前置已结算且成功」的准入；不满足就留在队列里等待。
3. 前置结算后自动触发后继，不需要人再操作。
4. 前置失败/取消时，后继必须有一个**确定的终局**，不能永远卡在 `queued`。
5. 依赖关系随账本落盘，重启后仍然生效；重启前没跑完的依赖链不能出现「没等就开跑」。
6. 不新增任务状态；复用现有 `queued → running / cancelled` 跃迁。

### 非目标

- 不做 DAG 可视化编辑、不做跨批次编排器、不做定时依赖。
- 不做「前置失败自动重试前置」。
- 不做「后继被取消后，前置重跑能自动复活后继」。
- 不改 `maxWorkers` / `maxTasksPerSession` / 后台巡检语义。
- 不新增看板接口，只扩展现有 `/board` 快照字段。

---

## 3. 使用场景

1. **接口 → 实现 → 测试**：一次 `dispatch_launch_many` 派 3 个任务，B 依赖 A、C 依赖 B；A 完成后 B 自动开始，B 完成后 C 自动开始。
2. **并行 + 汇合**：A、B 并行，C 同时依赖 A 和 B；A、B 都 `done` 后 C 才启动。
3. **前置失败**：A 失败，B 停在队列；系统把 B 标成「因前置失败未执行」，并在批次汇总里点名，而不是让 B 永远挂着。
4. **重启**：A 跑到一半进程被杀；重启后 A 变 `interrupted`，B 按「前置未成功」处理，不会偷偷开跑。
5. **跨批依赖**：给一个已有任务 id 作为前置（例如上一批的 A），新任务等它结算。

---

## 4. 功能与交互细节

### 4.1 工具签名

`dispatch_launch` 新增可选字段（`src/tools.js:83-140` 的 schema）：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `depends_on` | `string[]` | 最多 8 个任务 id；去重、去空；id 必须存在于活任务表或退休留痕中；不允许指向自己 |

`dispatch_launch_many` 的每个 item 新增（`src/tools.js:201-221`）：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `depends_on` | `string[]` | 同上；可引用本批之前已成功的任务 id，也可引用历史任务 |
| `depends_on_index` | `number[]` | 批内下标（0 起）；只能指向**本批中排在自己前面**的 item；服务端在第 i 个 launch 成功后替换成真实 task id |

`additionalProperties: false` 需要同步放开这两个字段；旧调用方不传，行为不变。

**返回**：`dispatch_launch` 的返回对象增 `depends_on`（解析后的 id 数组）；`launch_many` 的每个结果项同样返回 `depends_on`。不新增阻塞等待——派发仍然立即返回。

**描述必须写明**（这是最容易误解的地方）：

> 依赖在**任务开始前**判定，不是派发时判定。被依赖的任务没结算，这条任务会一直排队，不会占用 worker 并发位。前置失败/取消时，这条任务会被取消并标注原因，不会自动改派。

### 4.2 状态与字段

任务对象新增（`src/dispatch.js:670-702` 的构造处）：

| 字段 | 含义 | 落盘 |
| --- | --- | --- |
| `dependsOn: string[]` | 前置任务 id，按声明顺序 | 是（task 原样序列化，`src/store.js:119-125`） |
| `blockedBy?: string` | 当前第一个未满足的前置 id；用于看板 | 是（可选） |
| `blockedReason?: 'running' \| 'failed' \| 'missing'` | 为什么被挡 | 是（可选） |
| `cancelReason?: 'dependency_failed' \| 'dependency_missing'` | 被连带取消的原因 | 是（可选） |
| `errorCode?: 'DEPENDENCY_FAILED' \| 'DEPENDENCY_MISSING'` | 供调用方程序化判断 | 是（可选） |

不新增状态：等待就是 `queued`，失败连带就是 `cancelled`。这样 `TRANSITIONS`（`src/tasks.js:20-46`）、`SETTLED`、统计分母、看板状态色都不需要动。

### 4.3 准入与触发

**唯一准入点**：`takeRunnable()`（`src/tasks.js:403-427`）。改成接受一个只读判定：

```js
takeRunnable(isRunnable = () => true)
```

在现有的 `!task || status !== 'queued'` 之后、`sessionBusy` 之前插入：

```js
if (!isRunnable(task)) { deferred.push(id); continue }
```

保持「扫一遍、被跳过的按原序回队首、不空转」的现有语义。

**Dispatch 侧**（`src/dispatch.js` 的 `pump()`，约 1184 行）：

1. 先跑 `#annotateDependencies()`：遍历 `table.queue`，为每条任务算出 `blockedBy/blockedReason`（或清空）；
2. 再 `this.table.takeRunnable(task => !task.blockedBy)`；
3. 兼容模式：没有 `dependsOn` 的任务 `blockedBy` 恒为空，行为与现在完全一致。

**触发点**：`Dispatch.settle()` 已经在结算后 `void this.pump()`（`src/dispatch.js:1209-1213`）。依赖完成 → 结算 → pump → 后继可运行，这是现成的链路，不需要新定时器。

**判定规则**：

| 前置状态 | 后继行为 |
| --- | --- |
| `done` | 满足 |
| `failed` / `cancelled` / `interrupted` / `ended` | 不满足 → 连带取消（见 4.4） |
| 仍在 `queued` / `running` | 等待，`blockedReason: 'running'` |
| 不在活表、但在退休留痕且 `status === 'done'` | 满足（它已经做完，只是被移出计算） |
| 不在活表、退休留痕非 done 或不存在 | 视为失败 → `blockedReason: 'missing'` → 连带取消 |

### 4.4 前置失败的终局（关键决策）

不能让后继永远 `queued`，原因很具体：

- 它占着 `maxTasksPerSession` 的名额（`quotaUsed()` 会把它算进去）；
- `maybeSummarize()` 要求同组**所有**成员都结算才发汇总（`src/dispatch.js:1230-1236`），一条卡住会让整批静默；
- 看板会把它当成「还在排队」，用户不知道它在等一个已经失败的活。

**建议规则**：前置以非 `done` 的终态结算时，把所有仍在 `queued` 的后继 `settle` 成 `cancelled`，写 `cancelReason: 'dependency_failed'` 与 `errorCode: 'DEPENDENCY_FAILED'`；如果前置是被连带取消的，继续向后传递（BFS，不做深度递归）。

- 同一个 `settle()` 幂等，级联不会重复取消。
- 批次汇总会正常触发，并在汇总里点出「1 条因前置失败未执行」。
- 已经在 `running` 的后继不受影响（正常不会出现；只有「前置被 retry 重开」这种事后情况，定义为**不回溯**，只记一条 warn）。

### 4.5 看板与交互

| 位置 | 新增 |
| --- | --- |
| 任务行标签 | `依赖 2`；被挡时 `等 A`；连带取消时 `前置失败` |
| 任务行元信息 | 不需要额外行，复用现有 `dsh-sa-meta` |
| 任务抽屉 | 「前置：A、B」「当前等待：A（运行中）」「未执行原因：前置 A 失败」 |
| 批次头 | 「3 个成员 · 1 个等待前置 · 1 个未执行」 |

`boardTask()` 增字段（`src/board.js:102-177`）：`depends_on`、`blocked_by`、`blocked_reason`、`cancel_reason`、`error_code`。都是短标量/短数组，2 秒轮询体积可控。

### 4.6 重启与恢复

`restore()` 已经做了两件事：

- 「`queued` 且没 `startedAt`」的任务重新入队（`src/dispatch.js:3281-3286`）；
- `running` / 有 `startedAt` 的任务转 `interrupted`（`src/dispatch.js:3349`）。

依赖链需要在恢复后补一遍收敛，放在 `pump()` 之前：

1. 重建 `table` 后，对每条 `queued` 任务跑一次 `#annotateDependencies()`；
2. 前置是 `interrupted` / 缺失 → 走 4.4 的连带取消；
3. 前置仍 `queued`（也在恢复队列里）→ 保留等待，顺序由 `pump()` 保证；
4. 前置是 `done` → 正常可运行。

**必须保证**：恢复过程中不启动任何「前置未结算」的任务。`pump()` 只在恢复收敛后调用，且准入判定与运行期同一份代码。

---

## 5. 数据与接口改动

| 层 | 改动 | 位置 |
| --- | --- | --- |
| 工具 schema | `dispatch_launch` 增 `depends_on`；`launch_many` 的 item 增 `depends_on` / `depends_on_index`；放开 `additionalProperties` | `src/tools.js:83-140`、`201-221` |
| 批内下标解析 | `launch_many` 循环里维护 `launchedIds`，把 `depends_on_index` 换成真实 id；下标 ≥ 当前项直接报 `INVALID_ARGUMENT`，不 launch | `src/tools.js:227-251` |
| 依赖校验 | 新增 `#resolveDependencies(agent, input)`：去重、限 8、查存在性、查自引用、查环；返回 id 数组或抛 `UNKNOWN_DEPENDENCY` / `DEPENDENCY_CYCLE` | `src/dispatch.js` 的 `launch()`，`530-655` 之间 |
| 任务字段 | `dependsOn` / `blockedBy` / `blockedReason` / `cancelReason` / `errorCode` | `src/dispatch.js:670-702` |
| 准入 | `takeRunnable(isRunnable)`；`pump()` 先 annotate 再取任务 | `src/tasks.js:403-427`、`src/dispatch.js:1184` |
| 连带取消 | 新增 `#failDependents(settledTask)`，在 `settle()` 里 `pump()` 之后调用 | `src/dispatch.js:1209-1213` |
| 恢复收敛 | 恢复后、`pump()` 前跑一次依赖 annotate + 连带取消 | `src/dispatch.js:3281-3353` |
| 看板 | `boardTask()` 增 5 个字段 | `src/board.js:102-177` |
| 客户端 | 标签/抽屉/批次头文案；中英文案表 | `client/index.js:4265`、`5596-5616`、`446/948` |
| 错误码 | 新增 `UNKNOWN_DEPENDENCY` / `DEPENDENCY_CYCLE` / `DEPENDENCY_FAILED` / `DEPENDENCY_MISSING` | `src/constants.js:32` 的 `ERROR_CODES` |
| 配置 | 新增 `maxDependsOn`（默认 8） | `src/constants.js:405` 一带的 DEFAULTS |
| 契约测试 | 工具字段 ↔ 任务字段 ↔ 看板字段 ↔ 错误码一致性 | `test/contract-consistency.test.js` |

**落盘顺序不用改**：`launch()` 已经 `await this.persistCritical()` 再 `pump()`（`src/dispatch.js:710-713`），依赖边会在任务开始前落盘；崩溃不会出现「后继已经开始、依赖边还没写」的情况。

---

## 6. 状态机与边界情况

| 场景 | 行为 |
| --- | --- |
| 无 `depends_on` | `blockedBy` 恒空，行为与现在完全一致 |
| 前置 id 不存在 | 工具报 `UNKNOWN_DEPENDENCY`，**不登记任务**（校验在 `table.add` 之前） |
| 自引用 / 重复 id | 自引用报错；重复 id 去重 |
| 超过 8 个前置 | 报 `INVALID_ARGUMENT`（不静默截断，依赖少一条是逻辑错误） |
| 环 | 只允许指向已存在的任务；批内只允许指向前面的下标，因此正常路径构造不出环。仍做一次 DFS 防御（账本被手工改过的场景），有环报 `DEPENDENCY_CYCLE` |
| 前置仍在运行 | 后继留在 `queued`，`blockedReason:'running'`，不占 worker 位 |
| 前置 `done` | 下一次 `pump()` 启动后继；通常 ≤1 秒 |
| 前置 `failed` / `cancelled` / `interrupted` | 后继连带 `cancelled`，写 `dependency_failed`，并在批次汇总点名 |
| 前置被 `cancel` | 同失败处理；`cancel()` 已会 `settle()`，无需新增触发 |
| 前置被 `retry` 重开 | 已经连带取消的后继**不复活**；仍在等待的后继继续等新一次结算。记一条 warn |
| 后继正在运行，前置被重开 | 不回溯、不中断后继；记一条 warn（正常路径不会发生） |
| 前置是退休记录且 `status==='done'` | 满足 |
| 前置是退休记录但非 done | 视为 `missing`，连带取消 |
| 前置被归档 | 归档不改变 `status`；按原状态判定 |
| 重启时前置 `running` | 恢复为 `interrupted` → 后继连带取消 |
| 重启时前置 `queued` | 两者都重新入队，按依赖顺序启动 |
| 重启时前置缺失 | 后继取消，`dependency_missing` |
| `maxWorkers` 已满 | `takeRunnable` 提前返回，依赖 annotate 不产生副作用；空位出现后下一次 pump 再判 |
| 队列里全是阻塞任务 | `pump()` 扫一遍返回 undefined，不空转、不 setInterval 轮询 |
| 依赖任务被 `archive`/退休 | 判定读 `retired` 留痕里的 `status`；只读，不改退休记录 |
| `dispatch_wait` 等一个被挡的后继 | 它会一直等到该后继被启动并结算，或被连带取消；不会返回「还在等」的中间态。工具描述要写明 |
| `launch_many` 中某条失败 | 该条报错进 `results`，后面的 item 若依赖它 → 解析不到 id，按 `UNKNOWN_DEPENDENCY` 处理该条，不影响其他独立任务 |

---

## 7. 兼容与迁移

- **旧账本**：没有 `dependsOn` 的任务视为无依赖，不需要迁移。
- **旧客户端**：新增看板字段可忽略；不新增状态，状态色/筛选不用改。
- **旧工具调用**：两个新参数都是可选的；`additionalProperties: false` 只是放开，不改变旧字段。
- **统计**：连带取消记 `cancelled`，沿用现有「取消不计入完成率分母」的规则；新增 `cancelReason` 供后续区分「人取消」与「依赖取消」。**本 PRD 不改统计分母**。
- **并发位**：被挡任务仍是 `queued`，仍占 `maxTasksPerSession`，但不占 `maxWorkers`——与现在「排队任务」的语义一致。

---

## 8. 对现有优势的影响

| 现有机制 | 影响 | 结论 |
| --- | --- | --- |
| `ADMISSION` / `PROJECTION` 分离 | 依赖变化不产生新报告、不触发回流；连带取消走现有 `cancelled` 通知路径 | **不破坏** |
| `settledAt` 权威结算 | 后继的 `settledAt` 只在真正取消/完成时写一次；等待时间不写进 `settledAt` | **保持**；但「未启动即取消」的任务没有 `startedAt`，耗时为空，统计需接受 |
| 投递 durability | 依赖取消会走一次终态回流（`cancelled`），沿用现有重试与 `delivery` 记录 | **复用**，不新增投递通道 |
| 批次汇总 `maybeSummarize` | 依赖连带取消让所有成员都能结算，汇总不会挂死；需在汇总文案里区分「未执行」与「失败」 | **必须同步改文案** |
| `TRANSITIONS` 不变式 | 不新增状态/边，`queued → cancelled` 已合法 | **无改动** |
| `takeRunnable` 的同步占位 | 依赖判定是只读谓词，仍在同一个同步循环里完成，不会超发 | **保持** |
| 账本体积 | 每条任务最多 8 个 id + 3 个短字段 | **可控** |

---

## 9. 验收口径

1. **顺序链**：A → B → C，`maxWorkers=3`；任一时刻只有一个在 `running`，B 在 A 结算后 1 秒内启动，C 同理。
2. **并行汇合**：A、B 并行，C 依赖两者；C 在**两者都** `done` 后才启动。
3. **前置失败**：A `failed`，B 在下一次 `pump()` 内变 `cancelled`，`cancel_reason=dependency_failed`；批次汇总包含「1 条未执行」；账本中没有长期 `queued` 的 B。
4. **重启**：A 运行中杀进程，重启后 A=`interrupted`，B=`cancelled(dependency_missing/failed)`，没有 B 的 worker 被创建。
5. **校验**：未知 id、自引用、9 个前置、批内下标越界/指向后面，均返回明确错误码，且**没有**新任务入账。
6. **无空转**：队列里只有阻塞任务时，CPU 无持续占用；不新增轮询定时器。
7. **兼容**：不传依赖的现有 `dispatch_launch_many` 用例全部保持原行为；`test/settledat-invariant.test.js`、`test/contract-consistency.test.js` 全绿。
8. **看板**：任务行能看到「依赖 2 / 等 A / 前置失败」，抽屉能看到前置列表与未执行原因。

---

## 10. 需要拍板的问题

1. **前置失败时后继的终局**：连带取消（本文建议，理由是不会卡住配额和批次汇总），还是保留 `queued` 等人工处理，还是标 `failed`（会拉高失败率）？
2. **是否允许跨批依赖**：本文建议允许引用活任务/退休留痕，方便「上一批的 A → 这一批的 B」；如果担心跨批生命周期不清，可以限制为「只能引用同 `group`」。
3. **批内依赖的写法**：`depends_on_index`（本文建议，调用方不需要先知道 id）还是只允许真实 id（实现更小，但 `launch_many` 基本没法用）。
4. **是否要新增 `blocked` 状态**：本文建议不新增，复用 `queued + blockedBy`；如果产品上需要独立的「等待中」筛选/颜色，再评估加状态的成本（会牵动 8 状态、统计、看板、契约测试）。
