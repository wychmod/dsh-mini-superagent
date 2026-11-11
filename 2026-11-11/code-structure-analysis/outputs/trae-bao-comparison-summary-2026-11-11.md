# Trae 宝 × dsh-mini-superagent：对比总结与迭代取舍

> 依据：`analysis/trae-comparison-2026-11-11.md`（核心版）、`analysis/trae-comparison-2026-11-11-detail.md`（详细版），以及本轮对当前工作区代码的静态核对。
> 基线：`dsh-mini-superagent` 0.8.0（git `a04733e` + 未提交改动）。
> 原则：只写文档与代码能支撑的结论；两边信息不足的维度直接标注「信息不足」。

---

## 0. 一句话定位

`trae宝` 是字节 TRAE 桌面端 Agent 窗口里的**开发者个人助理**，由「全局助理 / 项目助理」两层角色组成（依据：官方文档《个人助理：TRAE 宝》，仓库两份对比文档均以此为唯一对象）。

因此两者不是同一品类：**Trae 宝 = IDE 内的个人助理；本插件 = 宿主（DSH）内的任务编排与后台执行插件**。下面的对比只谈机制，不做「你有没有编辑器」式的功能对齐。

---

## 1. 六维对比

### 1.1 产品定位与使用形态

| | Trae 宝 | dsh-mini-superagent |
| --- | --- | --- |
| 形态 | 长在 TRAE 桌面端 Agent 窗口里的助理角色；全局助理跨项目、项目助理管当前项目 | 装进 DSH 的一个 bundle 插件；主会话通过 9 个 `dispatch_*` 工具把任务派给后台子会话 |
| 用户动作 | 在对话里下达任务，可继续布置新任务；复杂任务走 Todos / Goal / 自动化任务 | 在主会话里 `dispatch_launch` / `launch_many`，然后继续对话；结果由插件回流 |
| 交付面 | Agent 窗口 + 工具面板 + 产物空间 + IM（飞书/微信） | 侧边栏任务看板 + 分析看板 + 宿主会话本身 |

**差在哪**：Trae 宝卖的是「编辑器 + 云端执行 + 模型额度」的完整体验；本插件卖的是「派发语义 + 权威账本 + 统计口径」。前者是产品，后者是机制层。**这是形态差异，不是能力缺失。**

### 1.2 架构与扩展方式

| | Trae 宝 | dsh-mini-superagent |
| --- | --- | --- |
| 组成 | 闭源桌面客户端 + 云端执行环境；文档未公开其内部 agent 架构 | 纯 ESM、零运行时依赖、无构建；`src/index.js` 组装 `Dispatch`，`inject` 3 个必需服务 + 若干可选服务 |
| 扩展点 | MCP / 技能 / 插件 / 自定义智能体 / 规则 / 记忆成套 | 宿主工具面 + `dispatch_*` 工具 + 看板 HTTP 路由 + 客户端侧边栏槽位；不另造权限/模型系统 |
| 边界 | 客户端与云端都是自己的 | 只做编排层；会话、工作区、文件、终端、调度都复用宿主能力 |

**差在哪**：Trae 宝的扩展面是「一个产品内的生态」；本插件的扩展面是「宿主能力的组合」。后者更轻，但也意味着**能力上限由宿主 API 决定**（见 §3.3）。

### 1.3 任务 / 会话调度能力

| | Trae 宝 | dsh-mini-superagent |
| --- | --- | --- |
| 并发 | 一句话下达后可继续布置；云端任务锁屏可跑，并发按套餐档位（2/10/20） | `maxWorkers` 默认 6，满了进 `queued`，`pump()` 按登记顺序补位（`src/constants.js:213`、`src/dispatch.js:943-951`） |
| 任务粒度 | 任务 = 一段对话；有 Todos 实时进度、Goal 多轮续跑、自动化定时 | 任务 = 一条账本记录 + 一个后台子会话；8 个状态 + `attempt` + `settle` 幂等 |
| 续跑/复用 | 文档提到项目助理汇总子任务；**子 agent 是否独立上下文、是否受并发档位限制，文档未公开** | `continue_task_id` 续派（同一会话、不新建任务）；`handoff_from` 新建任务但沿用来源会话（`src/dispatch.js:530-550`、`#startReused()` `src/dispatch.js:1389`） |
| 顺序/依赖 | 文档称「根据依赖安排联调与验证」 | `launch_many` 只并行；`src/` 检索不到 `depends_on` / `dependOn`（确认过） |

**差在哪**：本项目的状态机、结算口径、续派/交接的准入校验明显更细；Trae 宝多了「任务内部计划可见」和「依赖编排」两件产品级能力。**前者不要为对齐而简化，后者是真缺口。**

### 1.4 工具与权限模型

| | Trae 宝 | dsh-mini-superagent |
| --- | --- | --- |
| 权限 | 四档：手动审批 / 自动审批 / 完全访问 / 自定义；Plan、Spec 是「确认计划前不执行」的门 | 按任务透传 `permission_preset` / `agent_preset` / `model`；主会话进路由模式后 `tools.restrict({deny:['write','edit']})`（`enforceRouter()` `src/dispatch.js:320` 起） |
| 执行前确认 | Plan / Spec 工作流：先产出规划文档，人确认后再执行 | worker 首条消息硬规则是「直接开工，不要等待进一步指示」（`src/prompt.js:243` 附近）；没有默认确认门 |
| 回退 | Handoff；文档明确「部分步骤可能已完成，不会自动回退所有改动」 | `cancel` / `retry` / `continue`；`retry()` 区分「会话还能恢复就续跑 / 会话没了就新开」 |

**差在哪**：最值得跟的一条就在这里。Trae 把「计划 → 人确认 → 才动手」做成默认路径；本插件把「直接开工」写成硬规则，`progress` 又默认不回流，于是**约定与机制冲突**（详细版 P0-2 的判断仍然成立）。

### 1.5 持久化与多端能力

| | Trae 宝 | dsh-mini-superagent |
| --- | --- | --- |
| 数据 | 记忆/规则本地存储；任务与执行在云端；IM 可接管但要求桌面端运行且电脑唤醒 | 单文件 JSON 账本（`store.js`：tmp + fsync + rename + `.bak`），单写、无锁；会话内容由宿主持久化 |
| 多端 | 云端任务可在锁屏/睡眠时跑；飞书/微信可发起与查看 | 浏览器看板默认只允许回环 Host（`BOARD_ALLOWED_HOSTS` 为空且是源码常量，`src/constants.js:431`）；无云端、无跨设备 |
| 规模 | 未公开 | 账本默认封顶 1,000 活任务 / 90 天，退休留痕 5,000 条 |

**差在哪**：Trae 的多端建立在云端执行 + 账号体系上；本插件的多端受**本地单写账本**与**宿主会话**双重约束。这不是「补一个页面」能解决的，是执行后端与持久化模型的差异（见 §3.3）。

### 1.6 生态与集成面

| | Trae 宝 | dsh-mini-superagent |
| --- | --- | --- |
| 生态 | MCP / 技能 / 插件 / 自定义智能体 / 规则 / 记忆；对话级模型选择；积分计费 | 继承宿主工具面与 preset；`model` / `agent_preset` / `permission_preset` 按任务透传；不自建 MCP / 技能 / 权限系统 |
| 计量 | 积分 / 套餐 / 并发档位 | 无 token / 成本计量（`stats.js`、`analytics.js` 检索不到 `tokenUsage` / `costUsd`） |
| 集成面 | 桌面端 + 云端 + IM | `dispatch_*` 工具 + `/board` 路由 + 侧边栏组件 |

**差在哪**：生态该由宿主/平台提供，插件自建会分裂生态。唯一低成本可补的是「这条任务用了哪个模型」的可见性——而这一点当前代码已经做了一半（见 §2.2）。

---

## 2. 作为迭代方向：借鉴 / 保留 / 硬约束

### 2.1 值得借鉴（按优先级）

#### A. 任务级计划透出（P0-1，未做）

- **现状**：`dispatch_report` 没有 plan/todo 字段；`src/` 全库检索不到 `plan` / `todos`；`progress` 归 `ledger` 不回流（`src/constants.js:168-171`、`406`），主会话对长任务是黑箱。
- **最小落地**：`dispatch_report` 加可选 `plan: [{text, done}]` → 存 `task.plan`（与 `reports` 平级）→ `boardTask()` 输出 → 客户端任务行显示 `2/5`。**不新增会话消息**，避免撞「一次派发 ≤3 条消息」的既有验收。
- **落点**：`src/dispatch.js:1185` 的 `report()`（入库与截断）、`src/board.js:74-140` 的 `boardTask()`、`client/index.js` 任务行、`src/constants.js` 的字段上限。
- **为什么值得**：它把「它现在做到第几步」从不可见变成观察量，且不动状态机、不动投递语义。

#### B. 执行前计划确认门（P0-2，未做）

- **现状**：`src/prompt.js` 的 worker 首条规则是「直接开工」；`retry()` 复用同一会话时会带着错误上下文继续，方向错了返工成本高于一次确认。
- **最小落地**：`dispatch_launch({ plan_first: true })` → worker 先 `dispatch_report(progress)` 交计划并停下 → **仅该任务**的 `progress` 直通主会话（按任务覆盖 `directReportStatuses`，不要全局打开）→ 看板标「待确认」。
- **落点**：`src/prompt.js` 的 `workerPrompt()`、`src/tools.js:83` 的参数 schema、`src/dispatch.js:1185` 的准入分支、`src/constants.js:406` 的按任务覆盖。
- **为什么值得**：这是 Trae 宝与本插件差距最大的一条，且不需要宿主新原语。

#### C. 批次依赖（P1-1，未做）

- **现状**：`launch_many` 只有并行（`src/tools.js:192` 起）；`pump()` / `takeRunnable()` 只按登记顺序取任务（`src/tasks.js:362-372`），没有前置条件输入。
- **最小落地**：`tasks[].depends_on` → `queued → running` 的准入加一条「前置已结算」判断 → 不满足时保留 `queued` 并记 `blockedBy` → 看板批次头显示阻塞原因。
- **落点**：`src/tasks.js` 的跃迁准入、`src/dispatch.js:943` 的 `pump()`、`src/tools.js:192`、`src/board.js` 批次聚合。
- **为什么值得**：「先改接口再补测试」这类真实依赖，现在只能靠人收报告后手工再派；人是最不可靠的调度器。

#### D. 模型可见性（P1-3，已做一半）

- **现状（与既有文档不同）**：`launch()` **已经**把 `model` / `agentPreset` / `permissionPreset` 写进任务（`src/dispatch.js:687-689`），并随账本原样落盘（`src/store.js:119-125` 序列化整个 task 对象）。缺的是**出口**：`boardTask()` 不输出这三个字段，`stats.js` / `analytics.js` 也不按模型分组。
- **最小落地**：`boardTask()` 增 `model` / `agent_preset`；`analyticsSnapshot()` 的 `groups` 增一维「模型」；旧账本缺字段显示「未标注」。
- **落点**：`src/board.js:100` 的返回对象、`src/analytics.js:364` 的聚合。
- **成本**：很低；不需要改采集，只改投影。

#### E. 任务目录生命周期（P2-1，未做）

- **现状**：`prepare.js` 能建任务目录/worktree，但没有清理闭环，磁盘只增不减。
- **最小落地**：`POST /board/cleanup-taskdir`（两步确认），只清目录、不自动合并；快照带目录是否存在/大小。
- **落点**：`src/prepare.js`、`src/board.js`、`src/dispatch.js` 的归档扫描。

### 2.2 当前已有优势，应当保留

| 优势 | 代码位置 | 为什么别在追赶时丢掉 |
| --- | --- | --- |
| 显式状态机 + 幂等结算 + 权威 `settledAt` | `src/tasks.js` 的 `transition()` / `settle()` / `#markSettled()` | Trae 的任务只是「对话单元」，没有可审计的终态；简化状态会让口径与回退一起失真 |
| 报告准入/投影分离（`ADMISSION` / `PROJECTION`） | `src/constants.js:168-188` | 这是「哪些信息必须打扰人、哪些只入账」的机制；P0-1/P0-2 必须在这套机制上做**窄口**，不能推倒 |
| 投递可观测（`task.delivery`、重试、durability） | `src/dispatch.js:1718-1746` | 能回答「报告到底进没进会话」；这是本插件相对「对话即任务」的结构性优势 |
| 稳定错误码闭集 | `src/constants.js` 的 `ERROR_CODES` + `src/tools.js` 的 `codeOf()` | 9 个工具的错误可被调用方程序化处理 |
| 统计口径诚实（分子分母、窗口、覆盖率、时间回退） | `src/stats.js`、`src/analytics.js` | Trae 文档未见对应物（**信息不足，不推断其无**）；这是本项目的立身之本 |
| `retry()` 的会话存活判定 | `src/dispatch.js:2476` 起 | 比「部分已完成、不会自动回退」更进一步：把「要不要沿用旧上下文」变成显式判定 |
| `handoff_from` 交接（新建任务 + 沿用会话） | `src/dispatch.js:530-550`、`854`、`1389`；`src/tools.js:103-174`；`test/session-reuse.test.js` | 任务粒度、报告链、看板行都不丢；这是**当前已落地、既有文档尚未承认**的能力 |

### 2.3 硬约束：会挡住演进的地方

1. **单文件、单写、无锁的账本**（`src/store.js:114-141`）
   整表 `JSON.stringify` + fsync + `.bak`，默认 1,000 活任务。任何「多实例 / 跨设备 / 服务端队列」都要先换持久化模型；这不是加一个接口能解决的。既有评估 O09（写放大）仍成立。
2. **执行单元是宿主会话**（`src/sessions.js:236-370`）
   worker 由 `ctx.agents` / `sessionController` 创建，插件不持有执行环境。Trae 的「云端执行 / 锁屏可跑」无法在插件层实现，除非宿主提供远端执行后端。
3. **任务与会话 1:1 的线程模型**（`src/dispatch.js:672`、`src/tasks.js` 的绑定）
   `threadId` 由任务 id 派生，`handoff_from` 是「新任务沿用旧会话」的显式特例。要做 Trae 那种「一个目标多轮续跑」（Goal），需要先引入「线程级任务链」，而不是继续加工具参数。
4. **准入模型把 `progress` 归为 ledger**（`src/constants.js:406`）
   计划透出（P0-1）与确认门（P0-2）都撞这条：必须做「按任务放行」，不能全局打开，否则会破坏「一次派发 ≤3 条消息」的降噪验收。
5. **提示词硬规则与长度门禁**（`src/prompt.js`）
   worker「直接开工」是硬规则；`SPEAK_RULE` 受 ≤8 行 / ≤500 字门禁。加确认门/规则文件必须先算提示词预算。
6. **看板每次全量遍历 + 2s 轮询**（`src/board.js` 快照、`client/index.js` 的 `POLL_MS = 2000`）
   账本上限内可控；要做「按模型/依赖/线程」多维分析，需要增量水位或预聚合，否则会随维度线性变慢。
7. **无宿主用量数据**（`src/stats.js` / `src/analytics.js` 检索不到 `tokenUsage` / `costUsd`）
   成本/积分归因做不了；硬做只能造假数字，违反项目口径。
8. **宿主 API 无类型契约、靠能力探测**（`src/sessions.js`、`reference/`）
   这是插件形态的固有约束；能不能做「执行前阻塞等待」「任务级定时」「用量回传」，取决于宿主是否提供原语。

---

## 3. 与既有对比文档的差异（以当前代码为准）

| 既有文档的说法 | 当前代码事实 | 处理 |
| --- | --- | --- |
| P1-2「交接摘要」列为**可选跟的方向**，`plans/README.md:17` 称「`src/` 里检索不到 `parentTaskId`」 | **已落地**：`handoff_from`、`parentTaskId`、`#startReused()`、`handoffSource/handoffReason`、`test/session-reuse.test.js` | 从「待做」移到「已落地优势」；`plans/README.md:17` 需要更新 |
| P1-3「把 `model` / `agentPreset` 记进账本」 | **已记**（`src/dispatch.js:687-689`，随账本落盘）；缺的是看板/分析出口 | 改成「已采集、未投影」 |
| P0-1 / P0-2 / P1-1 未做 | 仍然成立：`src/` 检索不到 `plan` / `todos` / `plan_first` / `depends_on` | 保留 |
| 详细版的行号（如 `launch` 514、`cancel` 2109） | 已整体偏移（`launch` 当前在 530，`maxWorkers` 默认 6 未变） | 引用时以函数名 + 当前行号为准 |
| `plans/README.md:18` 称稳定错误码未做 | 已落地（`ERROR_CODES` + `codeOf()`），与详细版 §6 一致 | 属于索引漂移，顺手修 |

---

## 4. 信息不足（不推断）

- **Trae 宝的子任务机制**：文档只说「调度子任务并行推进、进度汇总到项目助理」，未说明是否独立上下文、是否受并发档位限制、失败如何回传。
- **Trae 宝的常规计费口径**：限免页只写「1000 次 Query，超出转积分」；平时按什么计未单列。
- **Trae 是否有成功率 / 中位耗时 / 并行节省面板**：官网与文档未见；**不能据此说它有或没有**。
- **本项目真机视觉验收**：仍未做；所有界面判断基于代码与文档。

---

## 5. 结论

- **不要追 Trae 宝的产品形态**（编辑器、云端执行、IM 接管、积分计费、自动合并）：这些要么是宿主职责，要么与「本地单写账本 + 零依赖插件」的边界正面冲突。
- **真正值得跟的是三件机制**：任务级计划透出、执行前确认门、批次依赖。它们都能落在现有状态机与准入模型上，且不需要宿主新原语。
- **当前最该保留的是「账本 + 状态机 + 口径」这一层**：Trae 宝没有对应物，简化它会同时丢掉可审计性、可归因性和回退能力。
- **当前最硬的演进阻力是持久化与执行单元**：单文件单写账本、worker = 宿主会话。凡是要求「多端 / 云端 / 多实例」的方向，都应先视为架构升级，而不是功能迭代。
