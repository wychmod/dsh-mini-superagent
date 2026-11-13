# dsh-mini-superagent 代码结构与潜在问题分析

> 分析对象：`d:\idea\dsh-mini-superagent`（工作区根）及插件包 `dsh-mini-superagent/`
> 基线：插件版本 `0.8.0`，git `a04733e`（2026-11-10）**+ 未提交改动**
> 方法：只读静态分析（通读 `src/`、`client/`、配置、README、CHANGELOG，并与既有评估结论交叉核对）。既有评估文件已在公开前移除（含本机会话数据），下文只引用其结论、不再给出路径。**未运行宿主、未跑测试套件**；凡涉及宿主行为的推断均已标注「推测」。

---

## 一、结论摘要

1. **这是一个纯 ESM、零运行时依赖、无构建的 DSH（DeepSeek Harness）插件**：主会话把任务派给独立的后台子会话执行，子会话通过工具把报告投递回主会话；附带 HTTP 看板与浏览器面板。
2. **整体工程质量高于同规模插件**：状态机有显式跃迁表，账本单文件原子写并带 `.bak` 回退，看板对写操作有 token + 同源校验、对 DNS rebinding 有 Host 白名单，账本有准入分级/封顶/退休，30 个测试文件覆盖了并发、恢复、口径、契约一致性。
3. **没有发现 P0 级可直接利用的漏洞**。风险集中在四类「并发窗口 / 终态之后」的问题：
   - 终态任务仍可被迟到的报告写入并回流，甚至重新挂后台巡检；
   - 配额检查与任务登记之间隔着多个 `await`，并行调用可突破上限；
   - 工作区创建（`mkdir` + `registry.create`）没有并发去重；
   - `dispose()` 会被投递重试拖住，且重试不感知卸载。
4. **最大的长期成本是双巨型模块**：`src/dispatch.js` 约 3,227 行、`client/index.js` 约 7,945 行，混合了状态机、调度、投递、治理与几乎全部 UI 状态。既有评估中的 O12/O13/O14 仍然成立。
5. **既有分析的部分 P0 结论已经过时**（O01–O07 在当前代码中已修复），详见第六节；引用时不要再把 2026-11-10 评估文档的 §2.4 当作待办清单。

---

## 二、技术栈、构建与运行方式

全部依据 `dsh-mini-superagent/package.json`、`cordis.patch.yml`、`README.md`。

| 项 | 事实 |
| --- | --- |
| 包形态 | `"type": "module"`，`"main": "src/index.js"`，`exports` 暴露 `.` / `./client` / `./locale/*.json` / `./icon` |
| 运行时依赖 | `dependencies` 为空；**零依赖、无构建、无需 `npm install`** |
| Node | `engines.node: ^22.19.0 || >=24.0.0`（用到了 `fs/promises.open().sync()` 等） |
| 宿主 | `engines.dsh: >=0.2.1-rc.2`；README 实测环境为 DSH `0.2.1-rc.5` |
| 插件声明 | `dsh.bundle.patch = ./cordis.patch.yml`；`dsh.client.platform = "web"`，`immediately: true`，`inject` 依赖 `dsh-client-ui-layout` 与 `dsh-client-ui-sidebar` |
| 工具面 | 9 个：`dispatch_launch` / `launch_many` / `workspaces` / `list` / `inspect` / `message` / `cancel` / `wait` / `report`（`src/tools.js:83-351`） |
| 测试 | `npm test` → `node --test`，`test/` 下 30 个测试文件（含 `p0-regression`、`p1-regression`、`background-lifecycle`、`settledat-invariant`、`contract-consistency` 等） |
| 配置 | `cordis.patch.yml` 只覆盖了部分 `DEFAULTS`（`src/constants.js:211`），未写的项走代码默认值 |
| 安装/运行 | 作为 bundle 安装进 DSH profile（`plugin_manager` 的 `install_bundle`，或手动放入 profile）；headless 形态没有看板，工具与派发照常 |

**部署前提**：账本是单文件、无锁、假定单进程独占（`src/store.js`）。同一 profile 被两个 DSH 实例同时打开时，两边会互相覆盖账本——这是当前架构的隐含约束，README 未写明。

---

## 三、顶层目录职责

工作区根 `d:\idea\dsh-mini-superagent` 是「研究/计划 + 插件包」的组合，不是单一 npm 工程。

| 路径 | 职责 |
| --- | --- |
| `dsh-mini-superagent/` | **插件本体**（可安装单元），含 `src/`、`client/`、`test/`、`docs/`、`locale/`、`scripts/`、`cordis.patch.yml` |
| `dsh-mini-superagent/src/` | 服务端：14 个 ESM 模块（入口、常量、状态机、编排、宿主网关、看板、统计、提示词等） |
| `dsh-mini-superagent/client/` | 浏览器半边，单文件 `index.js`（约 7,945 行），注册侧边栏图标与「派发工作台」面板 |
| `dsh-mini-superagent/test/` | 30 个 `node:test` 用例；纯逻辑模块（tasks/stats/analytics/workspaces）与编排（dispatch）分层测试 |
| `dsh-mini-superagent/docs/` | 架构、工具契约、看板、工作区、API 契约、排障等 8 份文档 |
| `dsh-mini-superagent/locale/` | `zh.json` / `en.json` |
| `dsh-mini-superagent/preview/` | 界面截图/预览素材 |
| `analysis/` | 既有评估：能力评估与路线图（2026-11-10）、与 Trae 宝的机制对比（2026-11-11）；**该目录已在公开前移除（含本机会话数据）** |
| `plans/` | 00–10 号设计与实施计划，另有 `README.md` 索引 |
| `notes/` | 过程中的调研/决策笔记 |
| `reference/` | 上游 DSH 的静态取证材料（asar 反查），用于反推宿主 API |
| `scripts/`（根） | 工作区级辅助脚本 |
| `2026-11-11/` | 本次分析的交付目录 |

插件 `src/` 的模块职责：

| 文件 | 职责 | 规模 |
| --- | --- | --- |
| `index.js` | 插件入口：`apply(ctx)` 组装 `Dispatch`、注册 9 个工具、订阅宿主事件、挂看板 HTTP handler、`restore → provision → pump` | 小 |
| `constants.js` | 常量、`DEFAULTS`、状态集、错误码闭集、看板准入常量 | 中 |
| `tasks.js` | 纯状态机：`TaskTable`（跃迁表、队列、并发位、结算幂等、等待者） | 中 |
| `dispatch.js` | **业务编排核心**：launch/queue/pump/start/report/settle/relay/message/cancel/retry、后台巡检、治理、落盘触发 | 约 3,227 行 |
| `tools.js` | 9 个工具的参数解析、校验、错误映射；只做薄封装 | 中 |
| `sessions.js` | 宿主会话网关：创建 worker、冻结工具面、投递（queue/steer/inject）、工作区归属缓存 | 中 |
| `workspaces.js` | 工作区解析/新建（id → 绝对路径 → 精确标题 → 包含匹配），Windows 保留名与越界审计 | 中 |
| `store.js` | 单文件账本读写：tmp + fsync + rename + `.bak` 回退 | 小 |
| `board.js` | HTTP 看板：准入、快照、历史、统计、分析、档案/取消/追问/重试/自检路由 | 中 |
| `stats.js` | 全量聚合口径（结算时刻、窗口、完成率、并行节省） | 中 |
| `analytics.js` | 分析看板聚合与降级结构 | 中 |
| `prompt.js` | 主会话/worker 的工作方式提示词与路由模式提示 | 小 |
| `prepare.js` | 每任务目录与 prepare 命令 | 小 |
| `voice.js` | 声音/文案风格与示例 | 小 |

---

## 四、主入口与核心调用关系

```
DSH 宿主
  │ apply(ctx)                              src/index.js
  ├─ new Dispatch(ctx, config) ─────────────► src/dispatch.js
  │     ├─ TaskTable（状态机/队列/并发位）     src/tasks.js
  │     ├─ SessionGateway（建会话/投递）       src/sessions.js ──► ctx.agents / sessionController / jobs / subagents
  │     ├─ WorkspaceGateway（解析/新建）       src/workspaces.js ──► ctx.workspaceRegistry / fs.mkdir
  │     └─ store.readState/writeState         src/store.js
  ├─ registerTools(ctx, dispatch)             src/tools.js
  ├─ ctx.effect(board handler)                src/board.js ──► stats.js / analytics.js
  ├─ 订阅 agent/status、agent/disposed …      src/index.js
  └─ restore() → provision() → pump() → resumeBackgroundWatches()

主会话                          后台 worker 会话
  │ dispatch_launch(brief)              │
  ├─► Dispatch.launch                  │
  │    ├─ 配额检查 → 解析/创建工作区      │
  │    ├─ table.add + persistCritical    │
  │    └─ pump → start → agents.create ─┼─► 执行任务
  │                                     │
  │◄── relay ◄── report(status,text) ◄──┘  dispatch_report 工具
  │      └─ sessions.deliver（steer/queue + wake 语义 + 2/4/8s 重试）
  │
浏览器面板（client/index.js）
  ├─ 每 2s GET /board            （可见时；分析页打开则暂停）
  ├─ 每 1s 本地走表（耗时显示）
  └─ 每 10s GET /board/analytics
```

关键设计（读代码确认，不是推测）：

- **单一权威账本**：任务状态、归属、报告、投递结果、归档/退休只在 `TaskTable` + 账本文件中；会话内容由宿主持久化，是另一份事实。
- **并发位在 `takeRunnable()` 里同步占用**（`src/tasks.js:362-372`）：先 `transition(task,'running')` 再返回，多个 `pump()` 并行也不会超发。
- **结算幂等**：`settle()` 遇到终态直接返回 false（`src/tasks.js:382-404`）；`settledAt` 只写一次（`#markSettled`）。
- **投递可观测**：`task.delivery` 记录 `delivered` / `delivered-degraded` / `dropped` / `failed`、重试次数与 `durability`（`src/dispatch.js:1718-1746`）。
- **看板准入**：读操作默认只允许回环 Host 且 Origin 必须是回环或缺失；写操作额外要求 `x-dsh-mini-superagent` 自定义头（跨站带自定义头会触发预检，从而挡住简单 CSRF）。`BOARD_ALLOWED_HOSTS` 为空且是源码常量（`src/constants.js:420`、`src/board.js:419-439`）。

---

## 五、潜在问题（按严重程度排序）

> 口径：P1 = 应当排进下一轮修；P2 = 有明确触发条件或长期成本。每条都给出可核对的位置与代码事实；涉及宿主行为的地方标「推测」。

### P1-1 终态之后仍会写账本、回流结论，并可能重新挂后台巡检

**位置**
- `src/dispatch.js:1185-1222`（`report()`）
- `src/dispatch.js:1882-1893`（`handOffToBackground()`）
- `src/dispatch.js:955-964`（`#launchOne` 的失败回流）

**事实**
`report()` 只挡了 `cancelled`：

```js
if (task.status === 'cancelled') return { recorded: false, ... }
```

对 `done` / `failed` / `ended` / `interrupted` 不设防。迟到的 `progress` 报告仍会 `push` 进 `reports`、刷新 `task.updatedAt`；迟到的终态报告仍会 `task.pendingTerminal = status` 并调用 `handOffToBackground()`。而 `handOffToBackground()` 内部只看 `jobs/subagents` 是否有活，**不检查任务是否已结算**，于是可能给一条已 `done` 的任务重新挂上后台巡检（最长 30 分钟，到点还会 `killBackground`）。`settle()` 本身幂等，所以状态不会被改回去，但**回流给主会话的文字与账本最终结论可能矛盾**（例如先 `done`，后 `blocked`）。

同一类问题还出现在启动失败路径：`#launchOne` 捕获异常后无条件 `settle(failed)` 并 `relayFailure`；若任务在 `start()` 期间已被取消，`settle` 不会覆盖 `cancelled`，但仍会向主会话发一条「启动失败」。

**影响**
- 用户/看板看到互相矛盾的结论；模型可能据此重复派发或误判。
- 已结算任务被重新纳入后台巡检：多一个定时器、到点可能误杀 job。
- `updatedAt` 晚于 `settledAt`：影响按 `updatedAt` 的归档扫描与看板「最近活动」排序（统计口径已改用 `settledAt`，不受影响）。

**建议**
在 `report()` 入口统一判定 `SETTLED.has(task.status)`：已结算任务只允许「追加证据」并标记 `recorded:false/relayed:false`，不再刷新 `updatedAt`、不再 `handOffToBackground`、不再回流；`#launchOne` 在 `settle` 返回 false 时跳过 `relayFailure`（或先查 `task.status !== 'running'`）。

---

### P1-2 配额检查与任务登记之间存在 `await` 窗口（TOCTOU）

**位置**：`src/dispatch.js:520-524`（检查）→ `src/dispatch.js:654`（`this.table.add(task)`）

**事实**
`quotaUsed(agent.id)` 与 `table.add(task)` 之间隔着解析工作区、决定 `cwd`、构造 task 等多个 `await`。两个并行到达的 `dispatch_launch` 可以都读到「未超限」，随后各自登记，最终超过 `maxTasksPerSession`。

**影响**
`maxTasksPerSession` 是防止「主会话无限派生」的刹车；并行调用可绕过它。是否会触发取决于宿主是否并行执行同一轮的工具调用（**推测**：支持并行 tool calls 的宿主可以触发）。

**建议**
在第一个 `await` 之前同步「预占」一个名额（例如 `this.pendingLaunches += 1`，`quotaUsed` 把它计入，`add`/失败时释放），或在 `add` 前紧邻的位置做一次无 `await` 的复查。

---

### P1-3 工作区创建没有并发去重（严重度取决于宿主是否按路径复用，待验证）

**位置**
- `src/workspaces.js:233-238`（`ensure()`：`mkdir` 后直接 `registry.create`）
- `src/workspaces.js:347-380`（`resolveOrCreate()`：resolve 未命中 → 新建）
- `src/sessions.js:293-304`（`workspaceFor()` 的 resolve → list → create）

**事实**
`ensure()` 是「`mkdir`（幂等）+ `registry.create`（不去重）」。`pump()` 会并行启动多个任务（`src/dispatch.js:943-951`）；若多个任务的 `placementFor()` 同时落到当天【派发】工作区，或 `workspaceFor()` 同时对同一个新 `cwd` 走 resolve→create，就会重复创建注册表条目。`distinctTitle()` 读取的是创建前的快照，同样无法阻止并发下的同名。

**反证（必须一起看）**
`src/sessions.js:327` 的注释明确写道：「同一目录的既有条目不算撞车：那种情况宿主会复用同一个工作区，传去的标题会被忽略。」如果宿主 `registry.create` 确实按路径去重，那么此问题的实际后果会降级为「标题竞争」而非「重复条目」。**这一点无法从插件代码证实，标为推测/待验证**；在验证之前，建议按「可能产生重复」对待，而不是假设宿主一定兜底。

**影响**
若宿主不去重：注册表里出现同路径/同标题的重复工作区，用户选择「dsh-mini-superagent」时可能被送进另一个条目（该文件头注释描述过这类事故）。若宿主按路径复用：仅表现为并发时标题选择不稳定（短名/长名谁先落地），不影响目录归属。

**建议**
按目标路径做 in-flight 去重（`Map<path, Promise<workspace>>`），或 create 后重新 resolve，发现重复则归档/复用胜者；`ensure()` 也走同一把锁。

---

### P1-4 `dispose()` 会被投递重试拖住，且重试不感知卸载

**位置**：`src/dispatch.js:3365-3389`（`dispose()`）、`src/dispatch.js:1697-1746`（`#deliverWithRetry`）

**事实**
`dispose()` 先 `await this.flushNotices()`；`flushNotices()` 会 `relay()`，`relay()` 走 `#deliverWithRetry()`。该函数在失败后 `await new Promise(resolve => setTimeout(resolve, delays[attempt]))`，默认 2s → 4s → 8s，且**不检查 `this.disposed`**。`dispose()` 只清了 `retryTimers` / `backgroundTimers`，没有取消这些 sleep，也没有给 flush 设上限。

**影响**
宿主卸载插件时，最坏要等 14 秒/条待投递通知；期间仍会向主会话投递；`setTimeout` 未 `unref`，进程退出被拖住（测试/CLI 场景明显）。这是「卸载语义」与「投递可靠性」相互拉扯的典型缺口。

**建议**
重试循环里每轮先判 `if (this.disposed) break`，sleep 使用可取消 timer 并登记；`dispose()` 对 `flushNotices()` 加超时（`Promise.race`），超时后只落盘不再投递。

---

### P2-5 `settle()` 绕过跃迁表，也不校验目标状态属于终态

**位置**：`src/tasks.js:382-404`

**事实**
`settle()` 直接 `task.status = status`，只做 `SETTLED.has(task.status)` 的前置幂等判断，没有 `canTransition()` 校验，也没有断言 `SETTLED.has(status)`。文件头与注释多次强调「`transition()` 是唯一的状态写入口」，这里是一个公开例外。

**影响**
当前所有调用点都传终态，行为正确；但它使「非法跃迁都会被 `transition` 拦住并计数」这条不变式失效——未来新增调用若传入 `running`，会得到一条「已标记 settledAt 的 running 任务」。属于可维护性/不变式风险，不是现行 bug。

**建议**
在 `settle()` 开头断言 `SETTLED.has(status)`（否则抛错），或内部改为 `transition(task, status, { force: true })` 并保留幂等判断，使 `rejectedTransitions` 能覆盖这条路径。

---

### P2-6 `deliver(wake:false)` 在 `inject` 失败时会静默升级为「唤醒」

**位置**：`src/sessions.js:104-122`

**事实**
当 `agent && wake === false && typeof agent.inject === 'function'` 时先尝试 `inject`；若 `inject` 抛错，代码 `warn` 后继续执行到 `if (agent)` 分支，最终走 `followup()`（会唤醒 agent）。`wake:false` 的契约是「只投递，不唤醒」，此处被降级。

**影响**
在宿主 `inject` 不可用/报错时，本应静默排队的报告会唤醒主会话，造成不必要的轮次；调用方无法从返回值区分「降级为唤醒」。

**建议**
`wake === false` 且 `inject` 失败时直接返回 `{ delivered: 'recorded', woke: false }`（或带 `degraded:'wake'` 标记），不要落到 `followup`。

---

### P2-7 事件处理直接解引用 `agent.id`

**位置**：`src/index.js:43-44`、`src/index.js:67`

**事实**
`agent/disposed` 分支用的是 `dispatch.forgetTargets(agent?.id)`，但同一处理器里下一行是 `dispatch.table.byWorker(agent.id)`；`agent/status` 也直接 `agent.id`。两处风格不一致。

**影响**
宿主事件 payload 缺少 `agent` 时，会在宿主事件循环里抛 `TypeError`（**推测**：正常宿主会保证该字段，故实际概率低）。

**建议**
统一 `const id = agent?.id; if (!id) return`。

---

### P2-8 `retry()` 的探活判定有恒假分支，且 `undefined` 语义含糊

**位置**：`src/dispatch.js:2181-2199`

**事实**
`let resumable = !!existing` 之后，`if (!resumable) { ... if (probe) resumable = !probe.error; else if (resumable === undefined) resumable = false }`。此时 `resumable` 只可能是 `true/false`，`resumable === undefined` 永远不成立；`resolveAgent` 返回 `undefined`（没抛错、也没有结果）会被当成「不可续跑」，直接新开会话。

**影响**
探活结果的「未知」状态被折叠成「会话已死」，可能无谓丢弃可续跑的 worker 会话（丢失上下文与已做工作）。属于边界语义问题。

**建议**
把三态写清楚（`probe?.agent` / `probe?.error` / `undefined`），未知时按保守策略处理并在 `retry` 结果里注明原因。

---

### P2-9 落盘强度与 `.bak` 策略：rename 后未 fsync 目录；坏主文件可能覆盖好备份

**位置**：`src/store.js:111-143`（尤其 124-138）

**事实**
写入顺序是：写 `tmp` → `handle.sync()` → `copyFile(file, file.bak)` → `rename(tmp, file)`。没有对父目录 `fsync`；`.bak` 在 rename 之前从**当前主文件**复制。若主文件已经损坏（例如旧版本写坏），`readState()` 会从 `.bak` 恢复，但下一次写入会先把损坏的主文件复制成 `.bak`，覆盖掉唯一的好备份。

**影响**
- 断电后 rename 的目录项可能未持久化（文件内容已 fsync，元数据未必），与注释宣称的「真的到了磁盘」有差距。
- 「坏主文件 + 好备份」的恢复窗口只有一次写入；之后再坏就两份都坏。

**建议**
rename 后对父目录 `fsync`；`.bak` 改成「上一份成功写入的 tmp」或仅在主文件解析成功时更新，避免用已知损坏内容覆盖备份。

---

### P2-10 账本整表重写，写放大 O(n)

**位置**：`src/store.js:111-122`；`src/dispatch.js` 的 800ms 防抖与 `persistCritical()`

**事实**
`JSON.stringify({...}, null, 2)` 序列化整个 `tasks` + `targets` + `retired` 后整体重写、fsync，并复制 `.bak`。账本上限是 1,000 任务/90 天（`DEFAULTS`），每次任务事件都会触发（防抖后）一次全量写。

**影响**
任务多时单次落盘可达数 MB、双份 I/O；高频报告会持续占用事件循环。既有评估 O09 已识别，当前未修。

**建议**
至少去掉 `null, 2` 的 pretty-print（体积直接减半）；中期改为追加式 journal + 周期性 checkpoint，保留 v4 读取兼容与 `.bak` 回退。

---

### P2-11 双巨型模块、无类型检查、局部重复

**位置**
- `src/dispatch.js`（约 3,227 行）：状态机、调度、投递、治理、统计辅助混在一起。
- `client/index.js`（约 7,945 行）：看板 + 分析 + 表单 + 轮询 + 文案全都在这一个文件。
- `src/constants.js:10` 的 `VERSION = '0.8.0'` 与 `BASE` 常量在 `src/board.js` 与 `client/index.js:44` 各写一份。
- `src/tools.js` 与 `src/board.js` 各有一套 `asString` / `asCount` / `oneLine` / `clamp` 之类的参数清洗函数（边界处理略有差异）。

**影响**
改动回归面大；契约靠静态反推（无 `@ts-check` / JSDoc 全量类型），宿主升级时只能靠 `selfCheck` 事后发现。既有评估 O12/O13/O14/O15 仍然成立。

**建议**
不改行为的前提下先做纯函数物理搬迁（`dispatch` 拆出 relay / background / governance 三个模块，`client` 按 surface 拆）；加 `// @ts-check` + `tsc --noEmit` 作为开发期校验（不进运行时依赖）；`BASE` 由 Host 快照下发或由零依赖脚本生成。

---

## 六、配置与依赖风险（非缺陷，但影响部署）

| 风险 | 事实 | 建议 |
| --- | --- | --- |
| 宿主 API 无类型契约 | 依赖 `ctx.get('agents'/'sessionController'/'workspaceRegistry'/'jobs'/'subagents'/'sessionPersistence')` 的能力探测与降级；`reference/` 里的行号取证会随上游漂移（O16） | 保持探测 + `selfCheck` 回显；文档以能力表为主、行号为附录 |
| 版本号已漂移 | `package.json` 与 `src/constants.js:10` 都是 `0.8.0`，但工作区含未发布修复：`src/workspaces.js:14` 与 `src/index.js:81` 以「0.8.0/0.8.1 及更早」描述这些缺陷，CHANGELOG 顶部为「未发布」 | 发布前必须升版本，否则「同为 0.8.0」的两次安装行为不同，排障时无法区分 |
| 看板不能跨机访问 | `BOARD_ALLOWED_HOSTS` 是源码常量且为空（`src/constants.js:420`），改配置无法放开 | 若确有 LAN 需求，把它接进 `DEFAULTS` 并在 README 写明风险；否则在文档中明确「仅本机」 |
| 账本假定单写者 | `store.js` 无文件锁；同 profile 多实例会互相覆盖 | 在 README「落盘与重启」显式声明单实例约束 |
| 绝对路径可越界建目录 | `resolveOrCreate()` 对绝对路径直接 `mkdir -p`，仅在 `workspaceRoot` 之外记 warn（`src/workspaces.js:374-380`） | 这是有意的「可审计优先于可禁止」取舍；若安全要求提高，建议加 `allowAbsoluteWorkspace` 开关 |
| 路由模式不是强隔离 | 只挡 `write`/`edit` 工具，worker 的 `bash` 仍可改文件（代码注释已说明） | 不要把它当安全边界；文档已写明即可 |

---

## 七、对既有分析的核对（哪些结论已过时）

以当前代码为准，2026-11-10 评估文档（已在公开前移除，含本机会话数据）的 §2.4 / O01–O17 中：

**已修复，结论过时（不要再当待办）**

| 编号 | 旧结论 | 当前代码证据 |
| --- | --- | --- |
| O01 | 后台活不拦截结算 | `report()` 先 `handOffToBackground()`，有活则延迟结算（`src/dispatch.js:1214-1220`）；`cancel()` 会 `await killBackground()`（`src/dispatch.js:2109-2119`）；重启后 `resumeBackgroundWatches()` 只接管未结算任务（`src/dispatch.js:2001-2008`） |
| O02 | `killBackground()` 的 `jobs.list()` 未 await | 已 `await` 并按数组/形状探测（`src/dispatch.js:1970-1992`） |
| O03 | 报告后只靠 800ms 防抖，未强制落盘 | `report()` 末尾 `await this.persistCritical()`（`src/dispatch.js:1222`）；`cancel()` 同样强制落盘 |
| O04 | 跨重启投递幂等缺 flush 屏障 | 新增 `#flushSessionPersistence()`，投递后调用并记录 `durability`（`src/dispatch.js:1676-1689`、`1718-1732`） |
| O05 | 降级 `prompt` 把来源变成 `user` 且不可见 | 记录为 `delivered-degraded` 并 warn（`src/dispatch.js:1727-1732`） |
| O06 | 13 处中文 `throw new Error` + 看板手写状态码 | 已引入 `ERROR_CODES` 闭集与统一映射（`src/constants.js`，`src/tools.js` / `src/board.js` 使用） |
| O07 | 4 处文档漂移 + CHANGELOG 两个 `0.5.2` | 0.8.0 段落已重写；`test/contract-consistency.test.js` 承担常量↔文档一致性 |

**仍然成立**

- **O08**：`/board`、`/board/stats`、`/board/analytics` 每次请求全量遍历账本，客户端 2s/10s 轮询，无增量水位/ETag。
- **O09**：整表重写（见 P2-10）。
- **O10**：批次汇总仍等组内最慢成员。
- **O12**：客户端单文件轮询 + 大列表；离线冒烟依赖 hook 顺序。
- **O13**：`dispatch.js` / `client/index.js` 未分层。
- **O14**：无类型检查。
- **O15**：`BASE` 双写仍在（`src/board.js` 与 `client/index.js:44`），靠契约测试兜底。

**索引/数字漂移**

- O12 写 `client/index.js` 8,224 行，当前约 **7,945** 行；O13 写 `dispatch.js` 3,168 行，当前约 **3,227** 行。
- `plans/README.md:16` 仍把 07 的 P2 笼统写成「未做」，而 `GET /board/retired`（P2-3）已落地（`src/board.js:9`、`513-515`）；2026-11-11 对比文档（已在公开前移除）的「两处索引漂移」结论**仍然有效**，只是属于文档维护问题，不影响运行。

**没有过时、且本次复核确认的评估项**：`trae-comparison` 的品类判断（「IDE 个人助理」vs「宿主内任务编排插件」）与当前模块划分一致；它标注的「真机视觉验收未做」也仍然成立（本次为静态分析，未做界面验收）。

---

## 八、建议的修复顺序

1. **P1-1 终态防护**（改动小、收益最大）：`report()` / `#launchOne` / `handOffToBackground()` 三处加终态判定。
2. **P1-4 卸载路径**：重试循环加 `disposed` 检查 + `dispose()` 的 flush 超时；避免卸载卡顿与卸载后投递。
3. **P1-2 配额预占**：在 `launch()` 首个 `await` 前同步占位。
4. **P1-3 工作区并发去重**：先确认宿主 `registry.create` 是否按路径去重（写一个最小验证），再决定加锁还是加「create 后复解并归档多余项」。
5. **P2-9 / P2-10 持久化**：去 pretty-print + rename 后目录 fsync + `.bak` 策略；中期再评估 journal。
6. **P2-5 / P2-6 / P2-7 / P2-8**：低成本语义修正，可随下一次发布一起做。
7. **P2-11 结构治理**：按既有评估 O13 的「先物理搬迁 + parity 对照」执行，不要在一次提交里改行为。

---

## 九、本次分析的局限

- **未运行**：没有启动 DSH 宿主、没有执行 `npm test`、没有真机界面验收；所有「宿主会怎样」的判断都是基于插件侧代码与注释的推断。
- **未验证的宿主行为**：`registry.create()` 是否按路径去重、`agent.inject()` 的失败形态、`jobs.list()` / `subagents.listChildren()` 的返回形状、事件 payload 是否保证带 `agent`。这些直接影响 P1-2/P1-3/P2-6/P2-7 的实际触发概率，已在正文标注。
- **未覆盖**：`voice.js`、`prompt.js`、`prepare.js` 只做了结构级阅读，未逐行审查；`locale` 文案与 `docs/` 的一致性未做全量比对。
- **既有文档**：`plans/`、`notes/`、`reference/` 已参考（`analysis/` 已在公开前移除，含本机会话数据）；凡与当前代码冲突之处，以当前代码为准，并在第七节标出。
