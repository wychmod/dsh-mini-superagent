# 架构

## 目标与边界

一句话：让主会话把任务派给独立的后台子会话，并把结果可靠地送回主会话，其余一概不做。

硬约束（不是设计偏好，是当前实现的事实）：

- Host 插件，纯 ESM，`main` 直接指向 `src/index.js`，无构建、无编译产物、无运行时依赖。
- 单进程：没有队列服务、没有数据库、没有跨进程协调。状态是一个 JSON 文件。
- 硬依赖 DSH 的三个服务：`tools`、`agents`、`sessionController`（`src/index.js` 的 `inject`）。
  可选依赖四个：`webServer`（看板路由，缺失时跳过）、`workspaceRegistry`（工作区解析/创建/归档，缺失时退化）、
  `workingDirectory`（把子会话工作目录切到目标目录，缺失时跳过）、`sessionController.inspect`（默认主会话存在性检查，失败按不存在处理）。
- 任务的生命周期以「DSH Session」为单位；插件不自己维护子进程或工作线程。

## 数据流

```text
主会话（Agent）
  │  dispatch_launch(title, brief, [workspace/create_workspace/cwd/model/presets])
  ▼
Dispatch.launch
  │  workspace 指定 → WorkspaceGateway.resolveOrCreate（id → 绝对路径 → 标题精确 → 标题包含，可按需新建）
  │  任务 cwd = 目标工作区路径 ?? 调用者目录；登记 task（queued）── TaskTable
  │                       │
  │                       └── pump() 占并发位
  ▼
Dispatch.start
  │  placementFor(task) → 有目标工作区就用目标（不可关闭）；
  │                      没有/找不到目标才按 workerWorkspace 兜底（day = 当天【派发】/ cwd = 任务目录）
  ▼
SessionGateway.createWorker
  │  workspaceId 给定时直接用；否则 workspaceRegistry.resolveByPath / create
  │  sessionController.create({sessionId: dispatch-<taskId>, workspaceId|cwd, agentPreset?})
  │  sessionController.resolveAgent(sessionId) → Agent
  │  permissionPresets.set(agent.session, preset?)
  │  sessionController.rename({sessionId, title: "[派发] <title>"})
  │  task.cwd ≠ placement.path → workingDirectory.set(agent, task.cwd)   ← 会话归属与工作目录是两件事
  ▼
worker Session（独立跑一轮或多轮）
  │  dispatch_report(status, summary, detail)
  ▼
Dispatch.report ── 追加报告 ── Dispatch.settle(终态) ── pump() 顶上排队任务
  │
  ▼
SessionGateway.deliver(parent, 报告文本)
  │  freezeMessage({id, role:'user', source:{kind:'dsh-mini-superagent', form:'relay'}})
  │  agent.steer()（父会话在跑）或 agent.followup()（父会话空闲→唤醒）
  ▼
主会话收到报告 → dispatch_message 追问 / 继续派发
```

另外两条被动链路：

- `agent/status`：worker 置 `running` 时记 `turnStartedAt`；置 `idle` 时触发自动回报（若本回合没给终态报告）。
- `agent/disposed`：worker 会话被外部关闭时，把未结算任务标 `interrupted`。

启动与归档是另外两条定时/一次性链路：

```text
apply()
  ├─ restore()          读回 tasks.json
  ├─ provision()        建 <workspaceRoot> + 默认工作区（mini-superagent）+ 默认主会话（mas-lead，幂等）
  └─ startArchiveSweep() 首次 20s，之后每 archiveSweepMinutes
                         └─ archiveStale()：已结算且 updatedAt 超过 archiveAfterHours 的任务
                            → workspaceRegistry.archiveSession(id, {stopActivity:true})
                            → 成功记 archivedAt，失败记 archiveError（看板快照可见）
```

看板与输入框是第三条按需链路：

```text
浏览器侧（client/index.js）
  ├─ 看板（sidebar.panellist + main）
  │    GET  /dsh-mini-superagent/board          （2s 轮询）
  │    GET  /dsh-mini-superagent/board/retired  （选中「已退休」chip 时按需取一次）
  │    POST /dsh-mini-superagent/board/cancel   （看板「取消」）
  │    POST /dsh-mini-superagent/board/retry    （看板「重试」）
  │    POST /dsh-mini-superagent/board/archive  （「立即归档」/手动巡检）
  │    POST /dsh-mini-superagent/board/target   （看板读 targets；选择器与 @ 写）
  ├─ 派发目标选择器（conversation.input.left）
  │    GET  /board（挂载 + 每次打开）→ POST /board/target
  └─ @ 工作区（inputTriggers 的 @ source）
       GET  /board（10s 缓存）→ POST /board/target + 插入 chip
  ▼
src/board.js ── boardSnapshot / retiredSnapshot / Dispatch.cancel / retry / archiveStale / setTarget ──▶ TaskTable + targets + retired
```

Host 与 Client 不共享内存：Client 只认这几个同源 HTTP 端点（GET /board、GET /board/retired、GET /selfcheck、POST /client-ready、POST /archive、POST /target、POST /cancel、POST /retry），Host 把任务表、目标表与退休留痕拍平成快照返回。

## 模块与职责

| 文件 | 职责 | 依赖 | 明确不做 |
| --- | --- | --- | --- |
| `src/index.js` | 插件入口：建 `Dispatch`、`restore` + `provision`、注册 9 个工具、接宿主事件、注册看板路由、启动归档巡检、`ctx.effect` 清理 | `dispatch` / `tools` / `board` / `constants` | 不含业务逻辑 |
| `src/constants.js` | 名称、版本、日志前缀、消息来源 kind、提示段名、状态集合、默认配置（含工作区/归档）、任务 id 与消息 id 生成 | 无 | 不读文件、不碰 ctx |
| `src/tasks.js` | `TaskTable`：并发位、排队、结算、等待者；纯函数 `clip` / `oneLine` / `lastAssistantText` | `constants` | 不做 I/O，不调宿主 API |
| `src/store.js` | `tasks.json` 读回与原子替换写；`{version, savedAt, tasks, targets, retired}`（`version: 4`，缺 `targets` 按空对象、缺 `retired` 按空数组） | Node 内置模块 | 不校验业务字段、不做迁移 |
| `src/sessions.js` | `SessionGateway`：`freezeMessage` 懒加载、构造插件来源消息、双通道投递、`holds`（投递判重）、按目录取 cwd、workspace 解析、建子会话、权限预设、`applyModel`（model 透传）、`restrictTools`（路由模式收窄工具面）、系统提示注入、`enterDirectory`（切工作目录） | `constants` / `prompt` | 不管任务状态 |
| `src/prompt.js` | 给模型看的文本：主会话工作方式提示 `DISPATCH_HINT`、worker 首条消息 `workerPrompt` | `constants` / `tasks` | 不含判断逻辑 |
| `src/tools.js` | 9 个工具定义（含只读的 `dispatch_workspaces`）、`TOOL_NAMES`、参数 schema、结果卡片拼装、归属校验 | `constants` | 不直接操作会话 |
| `src/dispatch.js` | `Dispatch`：`launch` / `pump` / `settle` / `start` / `report` / `admissionOf` / `relay` / `message` / `cancel` / `retry` / `placementFor` / `provision` / `startArchiveSweep` / `archiveStale` / `targetFor` / `setTarget` / `forgetTargets` / `enforceLedgerCap` / `memoryStats` / `sweepMemory` / `resolveTask` / `isRetired` / `retiredCard` / `enforceRouter` / `forgetRouter`、视图 `card` / `detail`、落盘 `persist` / `restore` / `dispose` | 其余全部 | 不直接调 `sessionController` / `agent.*`（走 gateway） |
| `src/board.js` | 看板 Host 半边：`boardTask` / `boardSnapshot`（拍平、计数、排序、200 条、工作区列表、`targets`、`memory` 块）、`retiredSnapshot`（退休视图）、`createBoardHandler`（8 条路由 + 同源校验）、`registerBoardRoutes` | `constants` | 不自己改任务状态（取消/重试/归档/目标转调 `Dispatch`） |
| `src/workspaces.js` | 工作区网关：`defaultRoot` / `rootOf` / `dayKey` / `dayTitle` / `safeDirName`、`WorkspaceGateway`（`ensure` / `defaultWorkspace` / `dayWorkspace` / `createNamed` / `list` / `resolve` / `resolveOrCreate` / `archiveSession`）；内部 `exactMatches` / `fuzzyMatches` / `describeMatches` / `diagnoseTitleRef` 只服务解析链 | `constants` | 不碰任务表、不投递消息 |
| `src/prepare.js` | 每任务目录与一次性 prepare 命令：`taskDirectory` / `prepareEnv` / `runPrepare`（目录已存在即跳过、失败不重试、超时可配） | `workspaces`（`safeDirName`）+ Node 内置 | 不碰任务状态、不碰会话 |
| `client/index.js` | 浏览器半边，三条注册：`sidebar.panellist` 图标 + `main` 看板（2s 轮询、**5 chip**、工作区筛选、归档、已退休只读视图、点行跳会话）；`conversation.input.left` 派发目标选择器；`inputTriggers` 的 `@` 工作区 source。共用 `GET /board`、`GET /board/retired` 与 `POST /board/target` | 无（`require('react')` + 同源 `fetch` + `createPortal`） | 不 import Host 代码、不共享内存、不打包；不写全局样式 |

### 依赖方向

```text
index ──▶ dispatch ──▶ sessions ──▶ prompt ──▶ tasks ──▶ constants
  │            │            │
  │            ├──▶ store   │
  │            ├──▶ prompt  │
  │            ├──▶ prepare ──▶ workspaces ──▶ constants
  │            ├──▶ tools（只用 TOOL_NAMES，不注册）
  │            └──▶ workspaces ──▶ constants
  ├──▶ tools ──▶ constants  │
  └──▶ board ──▶ constants  │
       (接收 dispatch 实例，不 import dispatch；读工作区列表也只调 gateway)

client/index.js ──HTTP(同源)──▶ src/board.js 的路由
```

单向、无环。`tasks.js`、`store.js`、`workspaces.js` 不 import 任何 `@deepseek-ai/*`，所以能脱离 DSH 单测。
`index.js` 只 import 四个模块，把「谁会碰到宿主 API」限制在 `sessions.js` 与 `workspaces.js` 两个文件里；看板 Host 半边只碰
`webServer.register` 与 `Dispatch` 的公开方法。Client 是独立半边：没有 import 关系，只通过 HTTP 契约对齐
（路由前缀与快照字段在两边各有一份，改一处要改两处）。

## 关键设计决策

### 1. worker 是 Session，不是一次性子任务

用 `sessionController.create` 建一个真正的 Session，而不是 `ctx.subagents.startActivation` 的一次性执行器。

依据与代价：

- `create` 会**立即创建并发布 Agent**，`resolveAgent` 只做恢复（`api-contracts.md` §4）。所以建完就能投递，不需要等。
- Session 有历史：追问不用重讲背景；人在侧边栏能直接打开、接手。
- 代价：子会话出现在会话列表里，历史会持续增长；任务取消不会删会话。

### 2. 投递走 Agent 收件箱，不走 `sessionController.prompt`

`prompt()` 构造的消息来源是 `{kind:'user', rpcId: …}`，会被当成用户亲手发的消息（`api-contracts.md` §4 末尾）。
报告需要可区分的来源，所以自己造消息：

```js
{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-mini-superagent', form: 'relay' } }
```

再 `freezeMessage` 后交给 `agent.steer()` / `agent.followup()`。

降级阶梯（`sessions.js` 的 `userMessage` / `deliver`）：

1. 能加载 `@deepseek-ai/dsh-llm` → `freezeMessage` 规范化；
2. 加载失败 → `Object.freeze` 普通对象，投递照常尝试（只记 warn）；
3. 收件箱抛错 → 退回 `sessionController.prompt`（来源退化成 `user`，但至少能送达）。

### 3. 消息 id 必须唯一且稳定

DSH 的 Inbox 对同一 id 的待投递消息直接抛 `message "<id>" is already pending`（`api-contracts.md` §2）。
所以 id 由「任务 id + 用途 + 每次加载的随机前缀 + 进程内序号」组成：

```text
<taskId>:<start|relay|msg>:<BOOT>:<seq>
```

`BOOT` 是每次插件加载时生成的 6 位随机串，跨插件重启不会复用 id；`seq` 是进程内自增。
投递前还会统一加来源前缀（`dsh-mini-superagent:<id>`），避免和其它来源的 `rpcId` 撞车。

### 4. 先 `create` 再 `resolveAgent`

`create` 创建后立即返回；`resolveAgent` 才能拿到可投递的 `Agent`。这是官方原型使用的顺序（`api-contracts.md` §4/§5）。

一个已知坑：`create({sessionId})` 在「会话已存在且非空白」时可能换号，返回值里的 `sessionId` 才是真的。
这里不受影响，因为子会话 id 由任务 id 派生（`dispatch-<taskId>`），而任务 id 由时间+序号生成、不复用。

### 5. `workspaceId` 与 `cwd` 只能给一个

`create` 同时收到两者会报 `gateway/bad-request`（`api-contracts.md` §4）。`SessionGateway.workspaceFor` 的处理：

1. 有 `workspaceRegistry`：先 `resolveByPath(cwd)`，找不到再 `create(cwd)`，用返回的 `workspaceId`；
2. 没有 registry 或解析失败：退回 `{ cwd }`。

这样在正常部署里子会话会出现在工作区列表，缺服务时也能起来。

### 6. 权限预设单独设置

`SessionCreateRequest` 没有 `permissionPreset` 字段。实现是在 Agent 建好后调用
`ctx.get('permissionPresets')?.set(agent.session, preset)`；失败只记 warn，不影响任务（`sessions.js` 的 `createWorker`）。

### 7. 工具全局注册，角色靠运行时判定

工具注册在插件根 ctx，等于全局层：所有 Session 都能看到（`api-contracts.md` §6）。

没有用 `agent.ctx.tools.register` + `restrict` 做隔离，原因：

- `restrict` 只能过滤「继承来的」工具，且必须在 scoped ctx 上调用；要给每个会话分别装配，复杂度不成比例。
- 9 个工具在全局层注册一次，worker 的身份用「它是不是某个任务的 `workerSessionId`」反查（`TaskTable.byWorker`）就够了。

**例外：路由模式（§21）。** 「必派发的会话不许改代码」这条必须靠 `restrict`，因为它是**结构性**的
（模型看不到 write/edit），而「谁能调哪个 dispatch 工具」是**语义**的（靠 `execute` 判定就够）。
两者不冲突：restrict 只 deny 两个非本插件的工具名，本插件的 9 个工具照旧全局可见。

代价与兜底：

- worker 也能看到并调用 `dispatch_launch`（会以 worker 为派发者新开任务）。系统提示第 5 条明确禁止；`maxTasksPerSession` 防失控。
- `dispatch_report` 只认 worker：找不到任务直接抛错，主会话调不了。

### 8. 并发靠队列，不靠拒绝

`maxWorkers` 是全局上限。`TaskTable.takeRunnable()` 在返回任务**之前**就把状态置为 `running`，先占位再启动；
这样即使多个 `pump()` 在 `await` 期间交错，也不会因为都读到旧的 running 计数而超发（`tasks.js` 注释即此意）。

`dispatch_message` 会把已结算任务直接置 `running`，可能短暂超过上限——有意的：人的追问不该排在批量任务后面。
所以 `maxWorkers` 是软上限。

**pump 的触发点**：`Dispatch.launch()`（每次派发后 `void this.pump()`）、`apply()`（插件加载时一次），
以及**所有结算点**——`report()` 拿到终态、`onWorkerIdle()`、`cancel()`、`agent/disposed` 置 `interrupted`——
它们统一走 `Dispatch.settle()`，内部 `table.settle()` 之后立刻 `void this.pump()`。
所以一个 worker 结算，排队中的下一个就被顶上来，不需要等下一个人来派发。

`pump()` 自己的失败分支用的是 `table.settle`（不是 `Dispatch.settle`）：pump 的循环本来就会继续走，
再触发一次 pump 只会自递归。

这条修复本身是 0.2.0 的改动：0.1.0（单文件版）只在 `launch` 与 `apply` 调 pump，并发位一满，队列要等下一次派发才动。

### 9. 状态机只有两个集合，且只有一个写入口

- `SETTLED = {done, blocked, failed, cancelled, ended, interrupted}`：不再占并发位、`dispatch_wait` 不再等。


**0.7.0 起，`task.status` 只有一个写入口。** `TaskTable.transition()` 依 `TRANSITIONS`
跃迁表校验每一次变化，`settle()` 对已结算任务直接返回 false（幂等），离开终态只能走
显式命名的 `reopen()`。0.6.0 之前有 6 处裸赋值（`index.js` 的 agent/status、`takeRunnable`、
`settle`、`start`、`message`、`retry`），没有任何一处校验前置状态，于是派生出这批可复现的 bug：
`done` 被看板的「取消」改成 `cancelled`；已结算任务被 `agent/status` 的 running 事件复活、
并发位被幽灵占用且永不结算；`queued` 任务被 `message` 置 running 但没出队，排队顺序错乱。
- `TERMINAL_REPORT = {done, blocked, failed, cancelled}`：本回合已经给过结论，`idle` 时不再补自动回报。

`progress` 不在任何集合里：只追加记录，不结束任务。

### 10. idle 自动回报是必要的补丁

`agent/status` 只告诉你「某个 agent idle 了」，不带任务 id、也不带结果（`api-contracts.md` §3 的风险项）。
所以自动回报要靠自己关联：

1. 用 `table.byWorker(sessionId)` 找到任务；
2. 用 `lastAssistantText(agent)` 从 `agent.session` 的 `assistant/message` 事件里取最后一条文本；
3. 判断本回合（`turnStartedAt` 之后）有没有终态报告：有就只 `settle(done)`，没有就 `settle(ended)` 并把最后文本回报。

没有这条，worker 忘记报告时主会话会永远干等。

### 11. 落盘单文件 + 800ms 防抖

- 写：`Dispatch.persist()` 覆盖写 `{version: 4, savedAt, tasks, targets, retired}`；密集的状态变化由 800ms 定时器合并（`timer.unref()`，不阻止进程退出）。
  0.5.0 起多一个 `targets`（会话 id → 派发目标），旧文件缺它时按空对象；
  本版未发布起多一个 `retired`（退休留痕数组），旧文件缺它时按空数组。格式细节见 §29。
- 落盘的原子性在 `store.js`：先写 `<file>.tmp` + `fsync`，把当前有效文件留一份 `<file>.bak`，再 `rename` 覆盖。
  `readState()` 主文件损坏时自动回退 `.bak` 并标 `recovered: 'bak'`，两者都坏才抛错。
- 读：`restore()` 启动时读一次；读失败只 warn，不阻止插件启动——但**读不到的是派发事实，不是会话内容**。
  两者的区别见 §26：`tasks.json` 是派发事实的权威副本，丢了之后「报告送过没有、任务归谁、它为什么不见了」
  都无从回答；子会话本身仍由 DSH 自己持久化，所以插件照样能启动。
- 恢复语义：未结算任务的处置见 §23 ①——`queued` 且从没启动过的保持 `queued` 重新入队，其余一律标 `interrupted`，
  因为新进程里没有活的 worker，不能假装它们还在跑。

为什么不上数据库：账本是单写、低频、体积随任务数线性增长的数据结构，JSON 文件足够，而且出问题时用户能直接看、直接删。
**「可丢」这个旧说法是错的**（见 §26）：它曾被用来解释「为什么不做事务、不做迁移」，而事实上看板指标、归属校验、
续跑与 `dispatch_inspect` 全读这份表——把它当缓存丢掉的代价是「历史不可重建」，不是「少一张列表」。
P0-5 的账本封顶（见 §28 第 5 条）就是给它的体积补上硬界，而不是继续假设它随时可以丢。

### 12. 提示只注入用过的会话

第一次从某个会话派发时，`SessionGateway.hint()` 往 `agent.ctx.systemPrompt.section` 加一段：
段名 `dsh-mini-superagent`、`order: 9998`、首行 `[dsh-mini-superagent 工作方式]`。
用 `Set` 记录已加过的 `agent.id`，避免重复注册。没用过派发的会话完全不受影响。

作用域是 `agent.ctx`，所以只影响该会话；注册失败只 warn（提示不是功能依赖）。
`prompt.section()` 返回的 disposer 会被收集，插件卸载时 `SessionGateway.dispose()` 统一收回（`Dispatch.dispose()` 里调用），
然后刷一次状态。

### 13. 字符串单点定义

日志前缀、来源 kind、提示段名、状态目录都从 `constants.js` 取。改名字时只改一处，
`docs/` 与排障表里的字符串也只需跟着改一遍。

### 14. 看板走 HTTP，不走 Remote/RPC

看板是同源页面里的一次普通 `fetch`：Host 用 `ctx.get('webServer').register({kind:'prefix', path, handler})` 注册，
Client 直接请求。理由：

- 只为「读快照 + 两个按钮」定义一套跨进程 Remote 契约（类型、版本、序列化）不划算；HTTP + JSON 已经够用。
- 同源页面本来就带浏览器上下文，普通 `fetch` 自动带 `Origin`，鉴权判断能直接做在 handler 里。
- 路由是 prefix 注册，路径、方法、状态码都在一个文件里，排障时看日志就能对上。

代价：契约是「手写的两端一致」——路由前缀 `BASE` 与快照字段在 `src/board.js` 和 `client/index.js` 各有一份，
改一处要同步另一处；没有类型检查兜底。新增的 `GET /board/retired` 与 `memory` 块同样是手写的一致：
**退休视图的 `{ok, count, dropped, entries[]}` 形状与 `memoryStats()` 的 `{window, ledger, admission, pending, retired}`
形状都是冻结契约，字段名不得改。**

### 15. 看板准入：回环放行 + 写操作要自定义头

插件注册的具名路由排在 DSH 页面鉴权之前，所以看板自己做了准入（0.7.0 起，因为旧的「Origin === Host」判据
可以被 DNS rebinding 绕过）：

- `GET`：`Host` 的主机名是回环（`127.0.0.1` / `localhost` / `::1` / `[::1]`）放行，但若有 `Origin` 它也必须指向回环；
  非回环 `Host` 默认拒绝，需写进 `BOARD_ALLOWED_HOSTS`，且 `Origin` 与 `Host` 一致。
- `POST`：先满足 `GET` 的规则，**并且**带 `x-dsh-mini-superagent` 头（`BOARD_HEADER`）。
  自定义头挡不住 rebinding（同源请求不触发预检），它挡的是**同源页面之外的脚本**与简单 CSRF；
  真正的判据是 `Host`——浏览器无法伪造它。

这是「不把任务标题、工作目录、报告摘要泄露给任意网页」的最低成本方案，不是完整鉴权。
代价：非回环地址默认不可访问（远程 curl 读不到快照）；同源页面里的 XSS 仍能带着这个头发请求。
细节与状态码见 [board.md](board.md)。

### 16. 客户端不打包、不编译

`client/index.js` 是一个 plain ModuleLoader 包：`window.__ModuleLoader__.load({id, factory(require){…}})`，
React 从 `require('react')` 取。理由：

- 仓库的硬约束是「无构建」；为一个面板引入打包器会破坏「clone 下来就能装」。
- ModuleLoader 的 `factory` 里可以直接 `require` 宿主已提供的 React，不需要自己带运行时。
- 样式随面板 `<style>` 卸载，只用 `var(--dsw-alias-*, fallback)`，不维护明暗两套。

代价：没有 JSX、没有类型检查；单文件三千余行，改结构时靠测试与人工审查。

### 17. 会话归属：有目标进目标，没目标才兜底进【派发】

`placementFor()` 的判据是**任务有没有可用的目标工作区**，而不是配置：

1. 任务带 `workspaceId` 且注册表里查得到 → 挂到目标工作区。无条件，`workerWorkspace` 管不到。
2. 否则按 `workerWorkspace` 兜底：`day`（默认）→ 当天【派发】工作区；`cwd` → 直接按任务目录归属。
3. 兜底也失败 → 任务 `cwd`。

无论会话挂在哪，任务的 `cwd` 都是目标工作区路径；两者不同就调 `workingDirectory.set(agent, task.cwd)`。

理由：

- **0.8.0 及更早的错误**：判据是 `workerWorkspace === 'target'`，而它默认 `day`，于是用户的明确选择
  被默认值压掉 —— 指定了工作区也进【派发】，每次派发都凭空多出一个 `【派发】YYYY-MM-DD`。
  用户的意图相反：选了目标就该在目标里，日期工作区只是兜底。
- **日期工作区惰性创建**：`dayWorkspace()` 会 `mkdir` + 注册，所以只在真的需要兜底时才调。
  `provision()` 只建默认工作区，从不碰它。
- 侧边栏按会话的 workspace 分组。兜底收进当天的【派发】、用完归档，列表就干净；而**有目标时**
  会话就混在项目工作区里，这正是用户选目标时期望的。
- 工作目录决定子会话实际读写哪里。把它切到目标目录，shell、读写工具、相对路径全都落在正确位置，
  效果等价于「在目标目录里开了一个会话」。
- 代价：没有目标时会话归属与工作目录分离，排查时要分清 `workspace_title` 与 `cwd`；
  `workingDirectory` 不可用或 `set` 失败时子会话会落在【派发】目录里（只记 warn，任务照跑）。
- 不指定 `workspace` 时：`cwd` 仍取调用者目录，会话按上面的 1→2 顺序归属。这是 0.4.0 相对 0.3.0 的行为变化。
- `workerWorkspace` 的旧值 `target` 已废弃（它表达的行为成了无条件默认），归一成 `day` 不报错，
  见 `src/constants.js` 的 `normalizeWorkerWorkspace()`。

### 18. 归档用 `archiveSession`，不删会话

归档动作是 `workspaceRegistry.archiveSession(sessionId, {stopActivity:true})`，不是删会话。理由：

- 归档只是从会话列表收起，会话历史还在；误归档可以恢复，删了就没有了。
- 任务表、报告、看板都引用 `workerSessionId`。删会话会让 `dispatch_inspect` / 重试 / 审计断链；
  归档后这些引用仍然有效。
- `stopActivity: true` 顺手停掉还在跑的活动，避免归档一个仍在执行的会话。

代价：归档不释放磁盘；`<workspaceRoot>/派发/<日期>` 下的文件也不会自动清理。
失败原因记在任务上（`archiveError`）而不是静默跳过，因为「以为归档了其实没有」会让看板越来越长。

### 19. 启动准备幂等，失败不阻塞

`provision()` 在每次激活时都跑：`mkdir -p` → 按路径注册工作区（宿主对同路径返回已有实体）→ 默认主会话按固定 id
`sessionController.inspect` 判断存在性。任何一步失败都只 warn，插件继续启动。

理由：工作区是「让侧边栏更好用」的增强，不是派发的前置条件。目录不可写、注册表缺失、默认会话创建失败，
都不该让 9 个工具跟着不可用。代价是失败只在日志里，需要 `dispatch_workspaces` 或看板自己确认。

### 20. 派发目标与会话归属分离，客户端三条注册共用一份快照

0.5.0 的输入框能力没有新增 Host 工具，而是复用看板 HTTP 面：

- **派发目标**存在 `Dispatch.targets`（落盘到 `tasks.json`），只是「下一次 `dispatch_launch` 的默认 workspace」。
  DSH 的会话工作区建完不可迁移，所以控件/`@` 都不试图搬会话，只改下一次派发。
- 客户端三条注册（`sidebar.panellist` + `main`、`conversation.input.left`、`inputTriggers` 的 `@`）都读同一份
  `GET /board` 快照，写同一个 `POST /board/target`；`targetBus` 在页面内广播变更，避免选择器与 `@` 各说各话。
- `@` 的 chip 只能走 `insert`，`appearance` 是闭集（session/file/folder），所以只插裸 chip，不能插纯文本。

代价：快照有 10 秒缓存（`@` 候选复用），选择器打开下拉时强制刷新；`@` 选中时设置目标失败没有可挂错误的位置，只 `console.warn`。
边界与未验证项见 [composer.md](composer.md)。

### 21. 路由模式：「必派发」的会话不许改代码（`restrictRouter`）

**为什么**：用户把输入框里的派发目标设成某个工作区或「自动」时，意图是「这个会话只做路由」。
但提示词拦不住模型：它仍会在「派活」和「自己干」之间摇摆，两边同时改同一个项目，
冲突、重复劳动、报告里对不上。`FORCED_HINT` 第 3 条只能劝。

**为什么只对这个模式生效**（这一条是设计约束，不是保守）：

- 我们的产品语义里**任何会话都可能是主会话**，而且「不派发」是默认选项；
- 所以不能按「派发过一次」判定——那等于因为派过一次就永久收走 `write`/`edit`，
  用插件的假设覆盖用户的当场意图（初版就是这么写的，已改）；
- 判据只能是用户自己选的开关：`modeOf()` 返回 `always`。

**怎么做的**（与上游 `dsh-superagent` 的 router preset 对齐，手段不同）：

- 触发点：`Dispatch.enforceRouter()`，由 `launch()` 与 `setTarget()` 经 `syncRouter()` 调用。
  `syncRouter()` 是「模式 ↔ 工具面」的对齐器：`always` 就上锁，其余就解锁。
- 动作：`agent.ctx.tools.restrict({ deny: routerDenyTools })`，默认 deny = `['write','edit']`。
  之后模型**看不到**这两个工具——这是结构性约束，不是提示。
- 幂等：同一个 agent 只收窄一次（`Dispatch.routers` 记账）；worker 递归派发时**跳过**
  （`table.byWorker(agent.id)` 命中说明它是执行者，收窄它等于让它干不了活）。
- 收回：选回「不派发」→ `forgetRouter()` 立刻释放；另外插件卸载、会话销毁
  （`agent/disposed`）也会收回——否则重载后 write/edit 仍然不可见。
- 同时把「已被收窄」写进提示段（`ROUTER_LOCKED`）：模型看不到工具时的默认反应是
  「我做不到」或反复换写法，一句「改代码请派发」能把它直接导向正确路径。

**为什么用 deny 而不是 allow**：`restrict` 对未知名字直接抛错，各部署的工具集又不一样。
allow 写死一份白名单，会顺手把我们不认识的工具（包括本插件自己的 9 个）一起收走；
deny 只碰点名的两个，缺哪个跳哪个。

**边界（必须说清）**：`bash` 默认保留，所以 `echo > file` 依然能写文件。这与上游一致
（它的 router preset 也留着 shell，为的是 `git status` 这类只读命令）。
要硬边界就把 `routerDenyTools` 配成 `['write','edit','bash','pwsh']`。
关掉整件事：`restrictRouter: false`。

### 22. 报告投递「至多一次」：稳定 id + 投前判重

**问题**：0.8.1 及更早的 `#deliverWithRetry` 把 `nextMessageId()` 写在重试循环**里面**。
只要「第一次其实已投进收件箱、只是后面抛错」，第二次就用新 id 再投一遍，
主会话收到两条一模一样的报告，两条都记成 `delivered`。

**现在的做法**：

1. `requestId` 在循环外算一次，三次重试逐字相同（`api-contracts.md` §7.2 的 id 规则：
   全局唯一、**同一次投递的重试逐字相同**、不与用户 RPC 的 `rpcId` 撞车）。
2. 重试前问一句 `sessions.holds(agent, requestId)`：查 `inbox.nextTurn/nextStep`（已入队）
   与 `session.snapshotEvents()` 里的 `user/message`（已被某一步取进上下文），命中就按已送达处理。
3. 判重只在**重试**前做（`attempt > 0`）：第一次投递前查一遍是浪费，且那时必然为空。

代价：`holds` 读一次事件数组（本进程内的快照，不碰持久化文件），比上游
`AgentDelivery`（flush + 逐块读持久化日志）轻，但跨进程重启后判重能力弱于上游。
对「报告」这种一次性的消息够用；真要跨重启去重，得引持久化读。



### 23. 恢复与容错：四件小事的取舍

这一节是「与上游对齐」的第二批（对照见 [plans/05](../../plans/05-superagent-router-worker.md) §七）。
四条都不改状态机，只补事实与节流。

**① 重启后重新排队（`restore()`）**：`queued` 且没有 `startedAt` 的任务保持 `queued` 并重新进队；
其余未结算的一律 `interrupted`。判据是 `startedAt`——它由 `start()` 写入，为空说明
`createWorker()` 从没跑过，既没有子会话也没有副作用，重排就是接着排队。
0.8.1 及更早一律标 `interrupted`，于是重启前排在队列里的任务要人工重派；
上游 `DshExecutor.resume()` 会把 pending 的 launch 重新排，这里对齐它。
`running` 不重排：新进程里那个 worker 可能已经做了一半，重跑会重复执行。

**② 瞬时故障续跑（`onWorkerError()` / `resumeAfterError()`）**：订阅 `agent/error`，
按 `isTransient()` 判 408/429/5xx/连接类错误；命中就退避（默认 15s/30s/60s）后投一条
「从中断处继续」，任务保持 `running`；次数用完或非瞬时错误则 `failTurn()` 落成 `failed` 并回报。
0.8.1 及更早没订这个事件，模型 5xx 之后 worker 走到 `idle`，被自动回报成 `ended`——
主会话收到的是一条「本轮没有输出」，看起来像任务正常做完了。

**③ 读回执（`onSessionEvent()`）**：`dispatch_message` 投递成功只说明「进了收件箱」，
所以先记 `inputPendingAt`；等 `session/event` 里出现对应 id 的 `user/message` 才写 `inputReadAt`。
只认 `msg` / `retry` 两种 id——`relay` / `start` 是发出去的，不能算「输入已读」。
上游把这件事拆成 `inputsDelivered` / `inputsRead` 两个事实，这里对齐「读」那一半；
重投未读消息还没做（需要先有稳定 id，§22 已经有了基础）。

**④ progress 节流（`report()`）**：同一任务一分钟内的第二条 `progress` 不再单独回流，
但仍然入库（`dispatch_inspect` 看得到）。上游用「同名 notice 覆盖未发送的那条」做合并，
我们没有那个队列，退化成按时间节流——`progressRelayIntervalMs: 0` 可关。

**没做的那一条：worker preset（5 秒前台）**。上游给 worker 定义一个独立 preset，
把 `shell.timeoutMs` 与 `job wait` 压到 5 秒。我们没有这么做，原因是 preset 行**不继承**：
`@deepseek-ai/dsh-agent-preset` 的 `plugins` 是完整清单，只写 shell 会让 worker 丢掉
fs、compaction、skill 等全部能力。要抄就得抄一份两百行、且绑定宿主包名的清单，
宿主一升级就碎。折中：`workerAgentPreset` 配置（把部署自己的收紧 preset 指过来）+ worker 提示里
写明「长命令用 `run_in_background` 或 `timeoutMs ≤ 30000`」。等宿主提供 preset 派生或
按字段覆盖的能力，再补真 preset。



### 24. 后台活占位、subagent 收窄、每任务目录（第三批）

前两条补的是「谁能占资源」，第三条补「活干在哪」。

**① 后台活继续占槽位（`handOffToBackground()` / `watchBackground()`）**。
`agent/status → idle` 原本直接 `settle('ended')`，于是一个留了 dev server、或还有 subagent
在跑的任务被判完成：并发位被释放，后台却还在改同一个目录。现在的顺序是：

1. `idle` 时先问宿主 `jobs.list(sessionId)` 与 `subagents.listChildren(sessionId)`；
2. 有活就不结算，记 `task.background = { jobs, subagents, since }`，任务仍是 `running`（槽位没让出）；
3. 每 `backgroundPollMs`（默认 15s）巡检一次，计数变化就刷新，清空后走 `finishIdleTurn()` 正常收尾；
4. 到 `backgroundLimitMs`（默认 30 分钟）终止仍在跑的 shell job（`jobs.kill`），再收尾，并在兜底报告里写明终止了几个。

约束：**每个任务同时只有一个巡检器**（`backgroundTimers`）；新一轮开始（`workerTurnStarted`）
或任务被结算（`settle`）时巡检作废——否则它会在下一轮中途把任务结算掉。
两个服务都不在时直接返回「没有后台活」，这正是 headless 形态，不能因为缺服务把任务卡在 `running`。

**② worker 的 subagent 收窄（`decorateSubagent()`）**。9 个工具注册在全局层，
所以 worker 派出来的 subagent 也能调 `dispatch_launch`——一个任务可以无限往下派生，
而 `maxTasksPerSession` 只按主会话计数。现在沿 `session.header.parentSession` 往上找
最近的 worker（最多 8 层，防脏数据成环），找到就 `restrict({ deny: TOOL_NAMES })`：
subagent 保留读写与执行，但不能再派发、不能再汇报。

**没做的那一半**：任务结算后收走 subagent 的工作工具。上游的工单结束即终结，而我们允许
`dispatch_message` 把任务重新拉回 `running`；收走工具会让续跑直接失效。

**③ 每任务目录 + prepare 命令（`src/prepare.js`）**。配了 `taskDirRoot` 时，
`start()` 在建会话**之前**准备 `<root>/<标题安全名>-<id后6位>`：

- 目录已存在 → 跳过命令（否则第二次派发会在已有 checkout 上再 `git worktree add`，直接失败）；
- 不存在 → 在**父目录**跑一次 `prepareCommand`，环境变量给 `DSH_DISPATCH_DIR` / `_TASK` / `_TITLE` / `_WORKSPACE` / `_CWD`；
- 然后把 `task.cwd` 指向任务目录。会话仍挂在目标/【派发】工作区（侧边栏干净），
  真正读写的是任务目录——由 `start()` 里已有的 `enterDirectory()` 切换。
- 失败即任务 `failed`，**不自动重试**：目录可能已经被写了一半，重试会把它当「已准备好」。
  与上游 `PrepareFailed` 的取舍一致。

代价：任务目录不会被自动清理（和归档一样，只收起不删除）；同一任务重试会复用同一个目录，
需要每次干净环境就得让 `prepareCommand` 自己处理。



### 25. 派发即移交，以及「结束本轮」是正确动作

提示词层（`src/prompt.js` + `src/tools.js`）的两条硬规则。它们不是假想的风险，各自对应一次
**被完整观测到的真实事故**；这一节记录问题形态与取舍，便于以后判断「还能不能再软化」。

**① 派发即移交（`HANDOFF_RULE`）**。

事故形态：主会话把「只读定位某个现象的根因」派给子会话之后，自己又读了三个源码模块、
跑了 30000 局模拟、跑了候选手合法性穷举、开浏览器复现并截图、查了 git 历史、解析了历史录像。
这些全是子会话正在做的事，最后两边给出同一结论。

根因是**枚举不完**：旧文案写「不要自己调用 `write` / `edit` / `pwsh` / `bash` 去完成派发出去的工作」，
只点名了写操作。模型于是合理地认为「我只是读一读、跑个脚本看看」不算重做——
在它的理解里那条规则说的是「别抢着改文件」。这类缝隙没法靠继续往清单里加工具名补完
（`read` / `grep` / `glob` / `node -e` / 浏览器 / 网络… 永远列不全，而且每加一个都在暗示「没列的可以」）。

所以判据从**工具名**换成**意图归属**：这件事是不是那个任务的目标？是，就归子会话。
移交范围写成穷举示例（明确写出「只读调查同样属于移交范围」），并加一条自检——
「正要做的操作与在跑任务重叠就停手」。派发之后主会话对该任务只剩两个动作：读报告、`dispatch_message`。

**② 派发后默认结束本轮（`BACKGROUND_CONTRACT` + 工具描述）**。

事故形态：同一事故里主会话连续调了约 10 次 `dispatch_wait`
（180/240/300/180/180/180/120/120/180/240 秒），累计约 33 分钟原地阻塞，期间零产出。

根因不是模型不知道它会阻塞（旧文案已经写了「`dispatch_wait` 是真的阻塞」），而是两件事：

1. 旧判据「只有『没有这个结果就完全无法继续下一步』时才用它」**太软**——模型总能证明自己「需要」结果；
2. 更关键：**没人告诉它「结束本轮」就是正确动作**。模型的推理是「用户问了问题 → 必须当场给出答案
   才能结束这一轮」，于是等待成了唯一出路。

现在的写法：默认动作是结束本轮，并把「结束本轮 ≠ 没回答」（这一轮末尾说的话就是回答，报告随后自动回流
并唤醒空闲会话）直接写进契约；允许等待的情形**绑定到用户原话**——只在用户于同一条消息里明确要求
「等结果再继续」时才允许。这三种自我说服被逐条点名否定：「等一次看看」「等着比结束省事」
「用户问了就必须当场答」。同时显式禁止「用 `dispatch_wait` 代替结束本轮」，并把 33 分钟这个量级写进去
（没有量级的警告读起来像模板话术，会被当口头禅跳过）。

**③ 有任务在飞时的白名单（`IN_FLIGHT_ALLOWED`）**。只写「不要做什么」时，模型在空档里无所适从，
要么去干重复的活（事故①），要么原地干等（事故②）。所以给一份穷举白名单：回答纯问答、
派发下一批不冲突的任务、处理已回流的报告、**以上都不是 → 结束本轮**。

**共同的设计约束**：四段文本（`BACKGROUND_CONTRACT` / `SPEAK_RULE` / `HANDOFF_RULE` / `IN_FLIGHT_ALLOWED`）
由 `DISPATCH_HINT`（轻提示）与 `FORCED_HINT`（必派发）**共享同一份常量**，按同样顺序拼进各自正文。
理由与 §13 一致：「要不要强制派发」是模式差异，而「派出去就归别人」「有任务在飞时能做什么」
是机制事实，与模式无关。两处各写一遍就会漂移——这个仓库已经被这件事咬过一次。

**`SPEAK_RULE` 的位置不是排版问题**：它夹在机制契约与移交规则中间，凑成
「先讲机制 → 再讲表达 → 最后讲职责」。放到最前面会让「先认领任务」被读成又一条**动作规定**，
而它实际是表达方式；动作与语气混在一起时，模型只会保住动作、丢掉语气——这正是
[plans/10](../../plans/10-voice-style.md) §二 记的现状。它受 `test/voice-prompt.test.js`
的**长度门禁**约束（≤ 8 行、≤ 500 字），量的是装配后的真实提示文本而不是源码字符数，
理由见 CHANGELOG「plans/10 P1」。

**为什么仍然只是提示词**：`dispatch_wait` 被滥用不是可以用守卫拦住的错误——「用户真的要求等结果」
时它是对的调用，插件无法判定那句话在不在用户的原话里。同理，主会话「重做一遍」在工具层面
与「做另一件相关的活」无法区分（都要 `read` / `pwsh`），加守卫只会误伤。
真要做结构性约束就得改工具面（像 §21 的路由模式那样收走工具），但那只在「必派发」模式下才成立，
且会挡住主会话合法的只读问答。**代价就是这么记的：这一层靠提示词，防回归靠 `test/handoff.test.js` 的文本断言。**

### 26. 权威源：账本是派发事实的唯一权威，会话是可重建的投影

这一节补的是 [plans/07](../../plans/07-memory-governance.md) §二 的口径冲突，也是该计划书 §十 落地顺序的第 1 条
（原话是「先把 §二 的口径冲突写进 `docs/architecture.md`（权威源定义），再动代码」）。
本轮代码先动了，所以这条口径现在补上。

**旧口径（错的，已被本文取代）**：`src/store.js` 的注释与更早的 README 都写着「任务表是辅助信息，
丢了不影响子会话」。**这个说法必须明确否定。** 它错在把「会话内容由 DSH 持久化」这件事，
误推成「任务表也可以丢」——两者不是同一份事实。

**事实是：`tasks.json` 已经是派发事实的权威源。** 下列能力全部只读这份表，没有第二份副本：

| 事实 | 只存在于账本的地方 |
| --- | --- |
| 任务状态与归属 | `TaskTable`；`dispatch_list` / `dispatch_inspect` 的归属校验读 `parentSessionId` |
| 报告正文与投递结果 | `task.reports` / `task.delivery`；会话里的那条消息**不记**投递成败 |
| 续跑与重试 | `attempt`、`workerSessionId`、`groupClosed` 等都只在账本里 |
| 看板指标 | `boardSnapshot()` 的 `counts`、`truncated`、效果数字的分母 |
| 归档与冻结 | `archivedAt` / `frozenAt`（`archiveStale()` 写，见 §18 与 §28 第 4 条） |
| 是否退休、为什么 | `retired` 留痕（见 §28 第 5 条、§29） |

**另一侧：会话里的一切都是投影。** 报告以 `user/message` 写进主会话、idle 兜底文本、
批次汇总、`dispatch_inspect` 的卡片文本——都是**从账本读出来再渲染**的东西。
投影可以更短（P0-3 的 `clip`）、可以丢（主会话不在时 `dropped`）、可以重放（重启后从账本重建），
但它**不得反过来成为事实**：任何「只在会话消息里、账本里没有」的派发事实都是缺陷，不是设计。

一句话记法：**先定权威，再定投影，然后给生命周期和预算。顺序反了就会变成「删历史」或「藏数据」**
（计划书 §三 的原话）。

**为什么当时会写成「辅助信息」**：0.1.0 只有「派发 + 回报」，账本确实是展示层——任务表丢了，
子会话照样在跑，报告已经送出的也不受影响。那时这个说法是**对的**。它变成错的，是由于后续每一版
都在往账本上加事实（0.5.0 的 `targets`、0.6.0 的 `attempt`/`delivery`，0.7.0 的状态跃迁表，
0.8.x 的后台活与读回执），**而那句注释没人回头改**。这正是计划书 §九 记的「文档再次漂移」风险：
口径随能力增长而失效，注释不会自己过期提醒。

**代价与边界**（写在文档里，免得下一个人以为是笔误）：

- 账本损坏时**不能**静默拿空表继续跑成「一切正常」：`readState()` 在主文件与 `.bak` 都不可用时抛错，
  `restore()` 记 `restoreError` 并 warn（原子替换与 `.bak` 回退的细节见 §11）。
- 但**也不该让插件起不来**：会话仍可创建、派发仍可进行，所以 `restore()` 只 warn。
  「权威」不等于「不可用就崩」，而是「它的缺失必须被说出来」。
- 权威性靠**单写入口**保证：`TaskTable.transition()` 是状态唯一写入口（§9），
  账本封顶只从 `Dispatch.enforceLedgerCap()` 一个地方动删除，退休只经 `#retire()`。

### 27. 归档（archive）与退休（retire）是两个概念，别混

中文里都像「收起来了」，后果完全不同：

| | 归档 archive | 退休 retire |
| --- | --- | --- |
| 标记字段 | `archivedAt` + `frozenAt` | `retiredAt` + `retiredReason` |
| 任务还在活表里吗 | **在**（`table.tasks`，仍可 `dispatch_inspect` 看全文） | **不在**（移出 `table.tasks`，只留 `retired` 薄记录） |
| 还参与指标吗 | 不参与（客户端按 `archived_at` 排除，见 §28 第 1 条） | 不参与（根本不在快照的 `tasks` 里） |
| 看得到报告正文吗 | 看得到 | 看不到（只留最后一条 200 字摘要与 `reportCount`） |
| 谁触发 | `archiveStale()` 巡检 / `POST /board/archive` | `enforceLedgerCap()`：结算后、归档后、重启后各判一次 |
| 能否撤销 | 会话可从归档恢复（`archivedAt` 可清） | 不能——记录已经不在，只能从留痕看它曾存在 |
| 可见入口 | 看板「已归档」chip（快照 `counts.archived`） | 看板「已退休」chip（独立路由 `GET /board/retired`） |

**`frozenAt` 存在的理由**：归档是「只读冻结」的开始，冻结时刻必须和归档时刻分开记，
因为两者可能不同源（归档成功那一刻写 `archivedAt`，`frozenAt` 是同一次写的，
但语义上「最后一次可写」与「已归档」是两个事实）。`archiveStale()` 里两者取同一个 `at`（`src/dispatch.js` 的
`task.archivedAt = at` 与 `task.frozenAt = at`），保留两个字段是为了将来「冻结」独立于「归档」时不必改存储。

**为什么不复用 `retiredAt` 表示归档**：`dispatch_inspect` 用 `retiredReason` 是否有值来判定「这是不是退休记录」
（`src/dispatch.js` 的 `isRetired()`）。把归档写成退休会让详情层认为任务已不可查，
而它其实还在活表里；`memoryStats()` 也会少算一条活任务。这条见过一次，注释就留在
`archiveStale()` 与 `detail()` 里。

### 28. 记忆治理 P0 五项：行为与可观察后果

对应 [plans/07](../../plans/07-memory-governance.md) §六 P0。**只改治理，不改状态机、不动 Session 格式、不改工具契约。**
每一条都写「可观察后果」，因为内部实现随时会变，行为不该变。

**① 指标窗口化（`memoryWindowDays` / `memoryWindowTasks`）**

- `memoryStats()` 返回 `window: { days, tasks, since }`，`since = now - days × 86400000` 的 ISO 串。
  默认 7 天 / 200 条；非正数或非数字时按默认值算（`days > 0 ? days : 7`）。
- 客户端（`effectStats()`）只统计 `updated_at >= window.sinceAt` 的已结算任务，
  且超过 `window.tasks` 条时按 `updated_at` 倒序取前 N。
- **归档与退休都不进指标**：归档按 `archived_at` 排除（这条与窗口无关，窗口未知时也生效）；
  退休任务根本不在快照的 `tasks` 数组里。
- 可观察后果：同一个 86% 在旧口径与新口径下可能不同——所以卡片上必须显示窗口
  （`最近 7 天 / 最近 200 条`），否则用户会以为数字算错了。
- 窗口只影响**指标口径**，不影响任务是否存在：看板列表仍然显示窗口外的任务，
  `dispatch_list` 也照旧。退休/归档由第 5 条管。

**② 准入分级（`directReportStatuses`；`ADMISSION.DIRECT` / `ADMISSION.LEDGER`）**

准入结论由 `admissionOf()` 判定，顺序有意义（先判的不能被配置翻掉）：

1. `TERMINAL_REPORT` 里的状态（`done` / `blocked` / `failed` / `cancelled`）→ **恒 `direct`**；
2. 配置 `directReportStatuses` 里点名的状态 → `direct`（默认 `['blocked','failed']`，`done` 不在列表里也照样直通）；
3. 其余（含 `progress` 与**未知状态**）→ `ledger`，只入库不回流。

> **这里与直觉不同，必须写清：终态硬直通，配置只能扩展、不能降级。**
> 把 `directReportStatuses` 清空**不会**让 `done` 静默——`admissionOf()` 对终态恒 `direct`。
> 这是有意的：结论与「需要人处理」是主会话唯一必须知道的两类事，任何配置都不该把它们降级成静默，
> 否则主会话会永远等不到「做完了」。配置的唯一用途是**扩大**（例如把 `progress` 加进去换回旧行为）。

可观察后果：

- `dispatch_report` 的返回值多一个 `admission`（`'direct'` / `'ledger'`），只入库的还带 `relayed: false`；
- `progress` 默认只入库 → `dispatch_inspect` 看得到，主会话不会因此被叫醒；
- 批次成员自己的终态只入库，整批结束由 `maybeSummarize()` 汇总一条——但**批次汇总本身恒 `direct`**
  （`admissionCounts` 在 `maybeSummarize()` 里直接记一次 direct）：否则成员静默 + 汇总静默 = 整批静默；
- `selfCheck().memory.admission` 给 `{direct, ledger, directStatuses}`，其中 `directStatuses()` 是
  `TERMINAL_REPORT` 与配置的并集——**自检说直通什么，判定就必须直通什么**，两处读同一份来源。

**③ 单条报告预算（`maxReportSummaryChars` / `maxReportDetailChars` / `maxLastTextChars`）**

- **入库即截断**：`report()` 用 `#admitEntry()` 造条目，`summary` 按 `maxReportSummaryChars`（默认 6000）、
  `detail` 按 `maxReportDetailChars`（默认 4000）当场 `clip`。0.8.x 只在 `reportText()` 外发时截，
  账本里存的是调用方给的原样长度——「单任务体积由调用方决定」是容量膨胀的根之一。
- 被截的条目记 `entry.truncated = { summary: 原始长度, detail: 原始长度 }`；**只在真被截时出现这个键**
  （一个恒存在的空对象会让「是否截过」永远为真）。`dispatch_report` 的返回值同样透出 `truncated`。
- `task.lastText`（worker 最后一段输出）在入库时按 `maxLastTextChars`（默认 5000）截；
  `finishIdleTurn()` 外发兜底文本时用**同一个上限**再过一次。
- **`clip()` 不是「截到恰好 N 字」**：`clip(text, limit)` 在超长时**头尾各半**，
  并在中间插一句 `\n…（已截断 X 字符）…\n` 作为提示，而**提示语本身也占这 N 的预算**
  （`bodyBudget = limit - 40`）。所以 `clip('a'.repeat(1000), 200)` 的实际总长 ≤ 200，
  不是「200 字正文 + 提示」。极端小 `limit` 下干脆硬截到 `limit`（`out.length <= cap ? out : value.slice(0, cap)`）。
  这条在 0.6.0 之前是 `limit - 400` + `slice(-400)`，`limit < 400` 时输出反而比 `limit` 还长（实测 417 字）。
- 内外同一口径是有意的：否则会出现「库里 10 万字、`dispatch_inspect` 看到残版、主会话看到另一个残版」的三方错位。
  `reportText()` 里仍保留一层 `clip` 兜底，但正常情况下是幂等的（长度没变，原样返回）。

**④ 生命周期清理（`forgetTargets` / `inputPendingTtlMs` / `archiveStale` 的 `frozenAt`）**

三件事分别在三个确定时刻发生：

- **会话销毁清 `targets`**（`forgetTargets()`，由 `index.js` 的 `agent/disposed` 调，`clearTargetsOnDispose` 默认开）：
  只删 `targets` 不删任务。为什么不在 `dispose()` 里清——插件卸载时所有会话都还在，
  清空等于把用户的输入框选择全丢掉。`agent/disposed` 才是「这个会话再也不会派发」的确定时刻。
  顺序上它排在任务结算**之前**（`index.js` 的 `agent/disposed`），避免「即将消失的会话的旧目标被新任务读到」。
- **「已投递未读」的 TTL**（`inputPendingTtlMs`，默认 30 分钟）：`sweepMemory()` 把超时的
  `inputPendingAt` 清掉、改写成 `inputUnknownAt`。**看板要区分「待读」与「不知道」**：
  `card()` 只在「有 pending 且没读且没 unknown」时报 `input_pending_at`，
  `input_unknown_at` 单独出现；unknown 必须压过 pending（「不知道」是更弱也更诚实的断言，弱断言不该被强断言盖住）。
  `onSessionEvent()` 真的读到消息时同时清掉 `inputPendingAt` 与 `inputUnknownAt`，写 `inputReadAt`。
  `sweepMemory()` **不新开定时器**：它挂在 `schedulePersist()` 的防抖回调与 `persist()` 之前——
  写盘本来就是这些状态变化的汇合点，为一个纯内存清扫起常驻链路不值得。
- **归档写 `frozenAt`**（`archiveStale()`）：与 `archivedAt` 同一次写，但字段分开（理由见 §27）。

**⑤ 账本封顶（`ledgerMaxTasks` / `ledgerMaxDays` / `ledgerMaxRetired`）**

- 判据两条，任一成立就退休：**条数**超过 `ledgerMaxTasks`（默认 1000）、
  **天数**上存在「非活跃（已结算、非 running/queued）且 `updatedAt` 早于 `ledgerMaxDays` 天」（默认 90 天）
  的任务。配置 `<= 0` 或非数字 = **不限制**（与 `archiveAfterHours: 0` 同一套约定）。
- 退休顺序：**已归档优先，其次最老 `updatedAt`**。归档优先是因为那是用户已经明确表示「不想再看」的动作，
  它比「单纯很老」更该先走。排序键用 `Date.parse()` 的数字而不是 ISO 串比较
  （旧格式不带毫秒时，字典序与时间序会分岔）。
- 触发点三处，**都不新开定时器**（体积增长只发生在这些点，幂等调用没有代价）：
  `settle()` 之后、`archiveStale()` 之后、`restore()` 之后。
- 退休做两件事：从 `table.tasks` / `table.queue` 移出；往 `this.retired` 写一条薄记录（**不搬 `reports` 正文**，见 §29）。
  原因串是稳定的机器值（`RETIRED_REASONS.CAP_COUNT = 'cap-count'` / `CAP_DAYS = 'cap-days'`），
  要给人看的中文放在投影层（客户端按 `retired_reason` 映射「条数上限 / 超过保留期」）。
- `ledgerMaxRetired`（默认 5000）是**留痕列表自己的**上限：超出时丢最老的（Map 插入顺序即退休顺序），
  并把 `retiredDropped` +1。

> **`retiredDropped` 不落盘，重启归零——它是「本次进程内丢弃了多少条留痕」，不是累计值。**
> 这一点必须写明，否则用户会对不上号：看到 `dropped: 1` 之后重启，数字变 0 会以为「数据回来了」，
> 而真相是新进程还没丢过任何东西。落盘反而更糟——把「本次丢弃数」持久化，会让人以为那些被丢的留痕
> 是可追溯的，而它们的定义就是「已经不在了」（`src/dispatch.js` 构造器里 `this.retiredDropped = 0` 的注释）。
> 看板的「另有 N 条退休记录超出展示上限」同样取这个值，所以它也会在重启后归零。

### 28.5 记忆治理 P1 两条：合并窗口与事实/投影分离

P0 管的是「写不写进账本」，P1 管的是「**写进会话的那一份有多长、隔多久**」。两条都只作用于投影，
不动账本、不改状态机、不加新会话事件类型。

**P1-1 合并窗口（`noticeMergeWindowMs`，默认 1500，硬上限 2000）**

- **只有 `progress` 可合并**（`MERGEABLE_REPORT_STATUSES`）。判据单点在 `Dispatch.mergeableOf()`：
  窗口开着 + 状态在集合里。终态（`done`/`blocked`/`failed`/`cancelled`）、批次汇总、启动失败、
  回合兜底**永不参与**——前三者不经过 `report()`（直接调 `relay()`），结构上进不来；
  终态则在集合外被拦。§九 的原话是「直通类永不参与合并」，这里是它的唯一落点。
- 语义是**「后一条覆盖前一条」**：同一 `taskId` 在窗口内又来一条时替换待发文本、重置计时器，
  于是窗口内无论来多少条只发**最新**那条。这与 `progressRelayIntervalMs` 的**节流**不同：
  节流丢的是「当前态」（一分钟只剩一条），合并丢的是「中间态」（最后的进度一定送达）。
- **合并键是 `taskId`**，不是会话：跨任务合并会让人读不出「哪条在做什么」。
- 直通类到达时**先冲刷**该任务窗口里待发的进度再发自己（`notify()` 里 await `flushNotice()`）。
  不做这一步的话，结论会先于过程到达——因果颠倒，且那条迟到的进度可能落在任务已结算之后。
- 卸载时 `dispose()` 会 `flushNotices()` 把窗口冲干净：已经决定要说的内容不该随进程消失。
- **回退开关**：`noticeMergeWindowMs: 0`（§九 要求每批能单独回退）。配成 0 后 `progress` 走
  P0-2 之前的路径（受 `progressRelayIntervalMs` 节流）。
- 可观察：`dispatch_report` 的返回值多一个 `merged: true`（该条进了窗口），自检
  `memory.merge = { windowMs, pending, windows, collapsed, mergeableStatuses }`。

**P1-2 事实/投影分离（`projectText()` / `projectionOf()`）**

- 账本是权威副本，会话是投影（§三）。这一条把「投影可以更短」从原则变成动作：
  报告正文只进账本，会话里在两种情形下发「摘要 + 指针」——
  1. 有 `detail`（长正文已经在账本里，会话不必再背一份）；
  2. `summary` 超过 `REPORT_VIEW.SUMMARY`（800 字符）。
- 压的是 `【说明】` 一行的正文，压到 `REPORT_VIEW.DIGEST`（240 字符）并附一句
  「另有 N 字在账本里，用『细节』行的 dispatch_inspect 查」。`【任务】`/`【结果】`/`【需要你】`
  /`【细节】` **一行都不动**——行动指向和指针不能被压缩掉。
- **不用 `clip()`**：它会在中间插一段带换行的「…（已截断 N 字符）…」，把单行的【说明】撑成三段，
  四段式的「一行一段」直接破掉（全部文案契约测试都是按行找段名的）。投影要的是
  「取开头 + 一句指针」，本来也不需要头尾各半。
- 预算内的短报告**一字不改**：实测典型报告 34–120 字，压它们只会凭空制造信息损失。
  这也是 10-P0 四段式现在的常态——P1-2 不是把四段式推倒，而是给超长的那批留条出路。
- **账本一个字都不压**：`#admitEntry()` 写的 `summary`/`detail` 与本函数无关，
  `test/voice-contract.test.js`「摘要作为投影被压缩，但账本里的原文不被压缩」钉着这条。
- 可观察：`dispatch_report` 的返回值多一个 `projection: 'full'|'digest'|'ledger'`，自检
  `memory.projection = { full, digest, ledger, budget: { view, digest } }`。

**P1-3 自检**：`selfCheck().memory` 在原五项（账本条数 `ledger.tasks`、退休数 `retired.count`、
待读数 `pending.inputs`、当前窗口 `window`、注入预算 `ledger.capPerTask` + `projection.budget`）
之上加了 `merge` 与 `projection` 两块已读数——它们正是「注入侧治理到底发生了什么」的证据。

### 29. 存储格式 v4 与退休留痕的字段

`tasks.json` 现在是：

```json
{
  "version": 4,
  "savedAt": "2026-11-08T04:42:07.000Z",
  "tasks": [ "…活任务，形状不变…" ],
  "targets": { "session-…": { "workspace_id": "ws-…", "title": "项目 A", "path": "D:\\proj\\a" } },
  "retired": [ "…退休留痕（数组，见下）…" ]
}
```

- **`version` 只用于人工排查**，读取时不强校验、不迁移（`store.js` 的 `FILE_VERSION = 4`）。
- **旧文件（无 `retired` 键）读成 `[]`**：`normalize()` 里 `Array.isArray(raw?.retired) ? … : []`，
  并且只保留对象条目（数组里混进字符串会让 `Map` 构造与 `oneLine(record.summary)` 炸掉）。
  刻意**不迁移、不报错**：退休留痕丢了只影响「它为什么消失」这一条可查性，不该让升级后的插件起不来。
- 写盘时 `retired` **显式写空数组而不是省略**：`JSON.stringify` 会直接丢掉 `undefined` 键，
  落盘文件里就再也看不到它——显式键让读的人知道这是新格式。
- 留痕**按「最老在前」写盘**（`[...this.retired.values()]`，Map 插入顺序 = 退休顺序），
  读回来时保持同样顺序，所以 `ledgerMaxRetired` 裁掉的就是队头，不需要在恢复时重排。

**退休记录只有 13 个字段，且不搬 `reports` 正文**（`src/dispatch.js` 的 `#retire()`）：

| # | 字段 | 说明 |
| --- | --- | --- |
| 1 | `id` | 任务 id |
| 2 | `title` | 标题 |
| 3 | `status` | 退休时的状态（已结算） |
| 4 | `parentSessionId` | 派发者会话（`dispatch_inspect` 的归属校验仍要靠它） |
| 5 | `workerSessionId` | 子会话 id（可能已归档/已不存在） |
| 6 | `createdAt` | 创建时间 |
| 7 | `updatedAt` | 最后变更时间（也是封顶判据用的那个） |
| 8 | `archivedAt` | 归档时间；没归档过显式写 `null` |
| 9 | `retiredAt` | 退休时刻 |
| 10 | `retiredReason` | `cap-count` / `cap-days` |
| 11 | `workspaceTitle` | 目标工作区标题；无则 `null` |
| 12 | `reportCount` | 退休前报告条数（**只有计数**） |
| 13 | `summary` | 最后一条报告的单行摘要，`oneLine(…, 200)`；没有报告时取 `oneLine(task.lastText, 200)` |

> 字段数是 **13**（`#retire()` 里 `record` 对象的键），不是「十几个」也不含任何正文。
> 「是不是退休记录」的判据是 `retiredReason` 非空（`isRetired()`），**没有**第二个布尔字段——
> 想加「它是否可查」之类的标志，请先想清楚谁在两种形态之间分叉。

> 读的人是靠这 13 个字段回答「它什么时候、为什么消失」的，正文不在其中——搬正文等于把容量上限
> 换了个地方存，`ledgerMaxRetired` 就成了笑话。
>
> 可选字段显式写 `null` 而不是留 `undefined`（`archivedAt` / `workspaceTitle` 都是 `?? null`）：
> `JSON.stringify` 会丢掉 `undefined` 键，落盘后「这条记录有没有归档过」就只能靠字段**不存在**来判断，
> 读回方再也分不清「没有」与「存的时候就没值」。

**恢复时退休留痕绝不回流成活任务**：`restore()` 把它们放进 `this.retired`，不 `table.add()`。
塞回 `table.tasks` 会让它们重新给指标投票，等于没退休。读回的留痕若超过上限（旧文件 + 上限调小），
只裁不留痕、不写回盘，下一次 `persist` 自然收敛——**不在 `restore()` 里对留痕再跑一次退休判据**
（留痕从来没进过 `table.tasks`，天然不可能被二次退休）。

### 30. 工作区解析语义：每一级命中多个就返回 undefined

这条也属于「文档语义变了、代码才对上」的一类，细节与参数示例见 [workspaces.md](workspaces.md)，
这里只记录设计判据，因为它牵动 `dispatch_launch` / `dispatch_setTarget` / `resolveOrCreate` 三条路径。

**旧文档写的「标题精确匹配」暗示它是唯一的、没有歧义——那是错的。**
`resolve()` 的四级（id → 绝对路径 → 标题精确 → 标题包含）现在遵守**同一条规矩**：

```text
命中 0 个  → undefined（交给调用方决定要不要新建）
命中 1 个  → 返回它
命中多个   → undefined + warn 出全部候选，绝不静默取第一个
```

- **精确匹配也会歧义**，而且比包含匹配更隐蔽：查询看起来「就是这个名字」，调用方很容易以为是唯一的。
  实测踩到的场景是两个不同路径共用标题——仓库根 `dsh-mini-superagent` 与包根
  `dsh-mini-superagent\dsh-mini-superagent`（宿主按目录 basename 起标题），于是用户点「dsh-mini-superagent」
  时被静默送进**另一个盘上的另一个目录**，日志里一行线索都没有。
- **候选文案必须带 `path`**（`describeMatches()`：`标题（路径，id=…）`）：同名工作区之间 id 对人毫无区分度
  （都是一串 uuid），而 path 一眼能看出「这是包根不是仓库根」。
- **warn 而不是 throw**：调用方要的是「解析不到」这个统一信号；抛错会改掉 `setTarget()` 的错误信息
  并牵动 `dispatch.js`。`setTarget()` 的 `!workspace` 分支本来就会把现有工作区全列给用户。
- **单字符不做包含匹配**（按码点数，代理对算 1 个）：`'a'` 命中一堆无关工作区，
  取第一个纯属偶然，比解析不到更糟。

**`resolveOrCreate()` 新增可选 `reason: 'ambiguous' | 'not-found'`**，它只在**没拿到工作区**时出现：

- `'ambiguous'`：注册表里有多个候选，**绝不允许走到新建**——那些目录是真的存在的，再建一个同名目录
  只会把「有两个候选」的问题变成「多出一个重复工作区」；
- `'not-found'`：确实不存在，可以按 `create` 决定新建与否；
- **空引用不给 `reason`**：调用方没给目标，不是「找不到」。给它贴 `'not-found'` 只会让 `dispatch.js`
  为一句空话编出一段错误文案。

`reason` 是**给调用方选文案用的**，不是日志级别：0.8.0 及更早两者都是 `undefined`，`dispatch.js` 只能把
所有失败都写成「找不到工作区「…」，且允许新建被关闭」——而这句话在歧义时是假的（并没有人关掉新建）。
`resolveOrCreate()` 在真正新建**之前**会重跑一遍与 `resolve()` **完全一致**的顺序（`diagnoseTitleRef()`），
否则会出现「resolve 因精确歧义返回 undefined，这里却判成 not-found 然后新建」的漏洞——
0.8.0 只判了包含匹配，正是漏在这里。

**这类机制是历史重复数据的根源**，两个方向都要记住：

- **`sessions.workspaceFor()` 显式传标题**：`workspaceRegistry.create(path)` 不传 `title` 时宿主用目录 basename
  当标题，于是「按目录登记」会自动造出**同名工作区**，而且每撞一次就再冒一个，不是一次性脏数据。
  现在 `distinctTitle()` 会挑一个不与已有标题撞车的名字：撞了就**逐段加长**
  （`proj` → `b/proj` → `D:/idea/b/proj`），极端情况（不同路径末段全同且都很深）才退回 `（2）` 数字后缀。
- **不改已有工作区的标题**：`distinctTitle()` 只决定本次新建那一个。谁先登记谁拿短名，先后顺序变了标题会变，
  但已有条目一个字都不动——改别人的标题等于把用户认过的名字偷偷换掉。
- 已登记的目录仍原样返回（`resolveByPath(cwd)` 命中就直接返回）。

为什么用 `/` 拼标题：标题是给人读的，`/` 任何平台都不需要转义，且天然表示「父/子」，与路径语序一致
（`idea/proj` 读作「idea 下的 proj」）。

### 31. 报告文案：先认领任务，再给结论（plans/10 P0）

派发回来的报告是**主会话唯一的输入**。旧形状
`[dispatch] 任务 t-1a9f-1 · 重构 auth · 报告 done` 里三个成分对用户都没用：
id 对不上、`done` 要翻译一次、标题还得和 id 抢注意力。所以 P0 只改文案层（不动机制）：

| 改什么 | 从哪里 | 变成什么 |
| --- | --- | --- |
| 报告首行 | `任务 <id> · <标题> · 报告 <status>` | `【任务】<短标签>`（≤40 字，无 id、无英文状态） |
| 结论 | 大段 `摘要：` | `【结果】<headline>`；缺省兜底成「短标签 + 状态」 |
| 详情 | 随报告回流 | 只进账本（`dispatch_inspect`），投影只留压缩后的 `summary` |
| 失败 | `启动失败：<error>` | `<短标签>：没能开始——<原因>。要我重试吗？` |
| 跑完无输出 | `一轮执行结束（worker 未显式报告）` | `<短标签>：它跑完了，但没给结论——要我追问一句吗？` |
| 批次汇总 | `批次 g-7f21 全部结束（done 3 / failed 1）` + N 行状态 | `【批次】重构这批 4 条` + 比例 + 分组 + **没成的逐条点名** |

三条不变量（`test/voice-contract.test.js` 钉住）：

1. **任务 id 只出现在末尾「细节」行**——正文里出现 id，用户就得自己去对账；
2. **内部状态词不出现在给用户看的句子里**——`done`/`failed`/`blocked` 走
   `STATUS_VOICE` 的中文说法（它和 `STATUS_ORDER` 同在 `constants.js`：
   新增状态时最容易漏的正是「对用户的那一面」）；
3. **失败/阻塞必须带行动指向**（`【需要你】` 段），且这一段**只在没成时出现**——
   成功报告也喊「需要你」会让这四个字贬值，真需要人时反而被略过。

**压缩只作用于投影**：`reportText()` 里的 `summary` 按 `REPORT_VIEW.SUMMARY`（800 字符）
压，账本里的 `entry.summary` 是 `#admitEntry()` 按 `maxReportSummaryChars`（6000）截后的全文。
两者取不同数值是**有意**的：入库上限决定账本体积（治理问题），投影预算决定回流消息长度
（上下文问题）。混成一个数字，要么账本被撑爆，要么 `dispatch_inspect` 读回的是残版。

**`headline` 不在库里补兜底**：缺省时账本里就是没有这个字段，
`dispatch_inspect` 因此能区分「worker 没写结论」与「系统替他编了一句」。
兜底发生在投影层（`voice.js` 的 `headlineOf()` / `fallbackHeadline()`）。
补在入库处会把这两种事实永久混成一个，再也分不出来。

**同名任务靠 `peers` 区分**：`reportText()` 从 `table.ofSession(parentSessionId)` 取同主会话的
任务列表传给 `taskLabel()`，标题重复的补 `·<工作区标题>`（同工作区再撞就补 id 尾段）。
范围取「同一主会话」而不是全库：用户看到的撞名只会发生在这里面，全库扫描会让每条标签
平白多一个后缀。

## 模块拆分轴

拆分前是单文件 853 行。0.2.0 按「谁最容易变」切开：

| 轴 | 文件 | 变更频率 |
| --- | --- | --- |
| 宿主 API（最易随 DSH 版本变） | `sessions.js` | 高 |
| 业务编排 | `dispatch.js` | 中 |
| 纯规则（可单测） | `tasks.js` | 低 |
| I/O 格式 | `store.js` | 低 |
| 面向模型的文本 | `prompt.js` | 中（措辞会调） |
| 面向用户的文本（报告/失败/批次） | `voice.js` | 中（措辞会调；plans/10 P0 新增） |
| 工具 schema | `tools.js` | 中 |
| 标识与默认值 | `constants.js` | 低 |
| 事件接线 | `index.js` | 低 |
| 看板 Host 半边（路由/快照形状） | `board.js` | 中（0.3.0 新增） |
| 看板浏览器半边（看板 + 选择器 + `@`） | `client/index.js` | 高（样式与交互会改；0.3.0 起，0.5.0 扩到三条注册） |
| 工作区（目录/解析/归档） | `workspaces.js` | 中（0.4.0 新增） |
| 每任务目录与 prepare 命令 | `prepare.js` | 低（0.8.x 新增；只在配了 `taskDirRoot` 时生效） |

这样 DSH 升级时优先改 `sessions.js`；调整提示词不碰业务逻辑；任务表规则可以脱离宿主跑测试；
看板 UI 改动不碰任务状态机，Host 路由改动不碰面板；工作区规则不碰派发状态机。

**`voice.js` 为什么单独拆一个文件**（plans/10 P0）：它和 `prompt.js` 都产「人读的文本」，
但面向的对象不同——`prompt.js` 写给**模型**（工作规则），`voice.js` 写给**用户**
（报告首行是任务短标签、失败要说「没能开始」而不是「启动失败」、批次要点名没成的）。
拆开的直接收益是**可单测**：文案契约（首行无 id/英文状态、行宽上限、失败必须带行动指向、
批次必须点名）全是纯函数断言，不需要假宿主。留在 `dispatch.js` 里的话，这些断言要么
跟着宿主夹具跑（慢且脆），要么干脆没人写。

## 失败与降级路径

| 场景 | 行为 | 依据 |
| --- | --- | --- |
| `dsh-llm` 加载不到 | 用 `Object.freeze` 兜底，投递继续尝试 | `sessions.js` `freeze()` |
| 收件箱投递抛错 | 退 `sessionController.prompt`，日志 warn | `sessions.js` `deliver()` |
| 主会话已不在运行 | 报告只落任务表，日志 warn，返回 `dropped` | `dispatch.js` `relay()` |
| `progress` 且主会话空闲 | 只记录，不唤醒，返回 `recorded` | `dispatch.js` `report()` |
| 子会话创建失败 | 任务 `failed` + `error` 字段，并把失败原因回报主会话 | `dispatch.js` `pump()` / `relayFailure()` |
| worker 会话被关闭 | 任务 `interrupted` | `index.js` `agent/disposed` → `dispatch.settle()` |
| 任务结算、队列还有任务 | `Dispatch.settle()` 立刻 `pump()`，排队任务顶上；pump 自己的失败分支用 `table.settle` 防自递归 | `dispatch.js` `settle()` |
| 状态写盘失败 | 只 warn，不影响内存中的任务 | `dispatch.js` `persist()` |
| 读历史失败 | 只 warn，启动继续 | `dispatch.js` `restore()` |
| 设置权限预设失败 | 只 warn，任务继续 | `sessions.js` `createWorker()` |
| 提示注入失败 | 只 warn | `sessions.js` `hint()` |
| 没有 `webServer`（headless） | 不注册看板路由，记一条 info；工具与派发不受影响 | `board.js` `registerBoardRoutes()` |
| 看板 GET 非本机且非同源 | `403 {"ok":false,"error":"看板只对本机或同源页面开放"}` | `board.js` `readAllowed()` |
| 看板 POST 缺自定义头 | `403 {"ok":false,"error":"看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用"}` | `board.js` `writeAllowed()` |
| `GET /board/retired` 而 `dispatch.retired` 不存在 | 返回空表 `{ok:true,count:0,dropped:0,entries:[]}`，不 500 | `board.js` `retiredSnapshot()` |
| `memoryStats()` 抛错或不存在 | 快照里 `memory: null`、`counts.retired: 0`，看板其余部分照常 | `board.js` `memoryOf()` / `resolveMemory()` |
| `memoryStats()` 是 async（当前实现） | `GET /board` 先 `await resolveMemory()` 再传进 `boardSnapshot(dispatch, memory)`；快照层同步降级给 `null` | `board.js` `createBoardHandler()` / `boardSnapshot()` |
| 报告状态不在直通列表里（如 `progress`） | 只入库，`dispatch_report` 返回 `admission:'ledger'` 与 `relayed:false` | `dispatch.js` `admissionOf()` / `report()` |
| 报告超过单条预算 | 入库即 `clip`，条目带 `entry.truncated`（原始长度），返回值透出 `truncated` | `dispatch.js` `#admitEntry()` |
| 账本超过 `ledgerMaxTasks` / `ledgerMaxDays` | 非活跃任务按「已归档优先 → 最老 `updatedAt`」退休，留一条 13 字段薄记录 | `dispatch.js` `enforceLedgerCap()` / `#retire()` |
| 退休留痕超过 `ledgerMaxRetired` | 丢最老的留痕，`retiredDropped += 1`（**不落盘，重启归零**） | `dispatch.js` `#trimRetired()` |
| 会话销毁 | 清它的 `targets` 条目（`clearTargetsOnDispose` 默认开），**不删任务** | `index.js` `agent/disposed` → `dispatch.forgetTargets()` |
| 「已投递未读」超过 `inputPendingTtlMs` | 改写成 `inputUnknownAt`（「不知道」而非「在读」），看板不再显示「待读」 | `dispatch.js` `sweepMemory()` |
| 工作区引用命中多个（任何一级） | `resolve()` 返回 `undefined` + warn 出带 `path` 的候选，**不静默取第一个** | `workspaces.js` `resolve()` / `describeMatches()` |
| `resolveOrCreate` 遇到歧义 | `{workspace: undefined, created: false, reason: 'ambiguous'}`，**绝不新建** | `workspaces.js` `resolveOrCreate()` / `diagnoseTitleRef()` |
| 按目录登记工作区时标题撞车 | `distinctTitle()` 逐段加长（`proj` → `b/proj`），**不改已有工作区的标题** | `sessions.js` `workspaceFor()` / `distinctTitle()` |
| 看板操作被状态拒绝 | `409`，中文原因（取消/重试的前置条件） | `dispatch.js` `retry()` / `cancel()` |
| 看板 `/target` 缺会话 | `400 {"ok":false,"error":"需要 session_id"}` | `board.js` `createBoardHandler()` |
| 看板 `/target` 解析不到工作区 | `409`，错误文本带现有工作区候选 | `dispatch.js` `setTarget()` |
| 派发目标在派发时已失效 | 只 warn，退回调用者目录，不新建目录 | `dispatch.js` `launch()` |
| 选择器 / `@` 快照取不到 | 选择器禁用（「看板服务不可用」）；`@` 候选为空 | `client/index.js` |
| `inputTriggers` 缺席 | `@` 不注册，看板与选择器照常 | `client/index.js` `registerWorkspaceTrigger()` |
| 点行打开子会话失败 | 提示「打不开子会话 …：原因」，不白屏 | `client/index.js` `openWorker()` |
| 看板 handler 内部异常 | `500` + warn 日志 | `board.js` `createBoardHandler()` |
| 默认工作区准备失败 | 只 warn，插件继续启动，派发按调用者目录工作 | `dispatch.js` `provision()` |
| 显式 `workspace` 解析/新建失败 | `dispatch_launch` 抛错，带现有工作区清单 | `workspaces.js` `resolveOrCreate()` |
| 切换子会话工作目录失败 | 只 warn；子会话留在【派发】目录，任务照跑 | `sessions.js` `enterDirectory()` |
| 子会话归档失败 | 任务记 `archiveError`，日志 warn，下次巡检重试 | `dispatch.js` `archiveStale()` / `workspaces.js` `archiveSession()` |
| 宿主不支持 `archiveSession` | 每次归档都失败并记录 `宿主没有 workspaceRegistry.archiveSession` | `workspaces.js` `archiveSession()` |
| 宿主没有 `agent.ctx.tools.restrict` | 路由模式不上锁，warn 一条；派发与其他能力照常 | `sessions.js` `restrictTools()` / `dispatch.js` `enforceRouter()` |
| `routerDenyTools` 一个都命中不了 | 不上锁并 warn（配置写错时不留静默的假象） | `sessions.js` `restrictTools()` |
| 宿主没有 `llm.resolveCallConfig` 或 session 不支持 `append` | 该次派发失败（任务 `failed`），原因回报主会话；**不**悄悄改用默认模型 | `sessions.js` `applyModel()` |
| 报告重试时发现消息已在会话里 | 按已送达处理，不再重投 | `dispatch.js` `#deliverWithRetry()` / `sessions.js` `holds()` |
| worker 回合遇到瞬时故障（408/429/5xx/网络） | 退避后续跑（默认 15s/30s/60s）；次数用完转 `failed` 并回报 | `dispatch.js` `onWorkerError()` / `resumeAfterError()` |
| worker 回合遇到其他错误 | 直接 `failed`，原因记账并回报，不挂在 `running` 上 | `dispatch.js` `failTurn()` |
| 续跑消息投不进去 | `failed`，原因记在任务上 | `dispatch.js` `resumeAfterError()` |
| 重启时任务还在排队且从没启动过 | 重新入队，`pump()` 接着跑；跑过的一律 `interrupted` | `dispatch.js` `restore()` |
| 同一任务一分钟内的第二条 `progress` | 只入库、不回流，返回 `throttled: true` | `dispatch.js` `report()` |
| 回合结束时后台还有 job/subagent | 不结算，继续占槽位；清空后收尾，到 30 分钟上限终止 job 再收尾 | `dispatch.js` `handOffToBackground()` / `watchBackground()` |
| 宿主没有 `jobs` / `subagents` 服务 | 视为没有后台活，立即结算（headless 形态） | `dispatch.js` `backgroundOfWork()` |
| prepare 命令失败 | 任务 `failed`，输出记在 `error` 并回报；**不建子会话、不自动重试** | `dispatch.js` `prepareTaskDir()` / `prepare.js` `runPrepare()` |
| 任务目录已存在 | 跳过 prepare 命令，直接复用（重试不会重复 worktree） | `prepare.js` `runPrepare()` |
| subagent 的 `dispatch_*` 被收走 | 它仍能读写执行，但派发与汇报会「工具不存在」 | `dispatch.js` `decorateSubagent()` |

## 可测试性

- 纯逻辑测试 `test/tasks.test.js`（13 个用例）：`TaskTable`、`clip`、`oneLine`、`lastAssistantText`。
- 看板测试 `test/board.test.js`：
  - 快照用例（拍平、`last_report`、截断、计数、排序、200 条上限、版本/时间）；
  - 既有路由用例（GET 200/404/403/同源 200、cancel、retry、跨站 403、同源 POST、任务不存在 404、坏 JSON 400、失败 409）；
  - 0.5.0 用例（工作区列表与归档计数、`/archive`、`/target` 设置/清除/缺参/解析失败、快照 `targets`）；
  - 记忆治理用例：`memory` 块的形状、`counts.retired`、宿主没有 `memoryStats` 或它抛错时的 `null` 降级、
    `retiredSnapshot()` 的倒序/`dropped`/缺 `dispatch.retired` 的空表、以及 `GET /board/retired` 的准入与形状。
  路由用假的 `req`/`res` 直接调 handler，不需要起 HTTP 服务。
- 记忆治理测试 `test/memory.test.js`：准入分级（终态恒直通、配置只扩展）、入库截断与 `truncated`、
  窗口口径、TTL 把 `inputPendingAt` 改写成 `inputUnknownAt`、`forgetTargets`、
  账本封顶的退休顺序与留痕字段、`retiredDropped` 不落盘、v4 读写的向后兼容。
- 工作区测试 `test/workspaces.test.js`：日期键、`【派发】`标题、安全目录名（非法字符/空白/长度）、
  根目录优先级，以及解析顺序（id、绝对路径、标题精确、标题包含、找不到、无注册表）；用假注册表，只在 `ensure` 之外不碰磁盘。
- 工作区解析回归 `test/workspace-resolve.test.js`：`resolveOrCreate()` 的 `reason` 归因
  （精确歧义 / 包含歧义 / not-found / 空引用不给 reason / 成功时字段缺席），以及
  `SessionGateway.workspaceFor()` 的标题去重（仓库根 vs 包根不再同名、逐段加长、不改已有标题、无注册表安全返回）。
- 路由与投递测试 `test/router.test.js`（14 个用例）：路由模式的触发时机与幂等、worker 递归派发不被收窄、
  `restrictRouter: false` 的退路、`restrictTools` 只 deny 真存在的工具（未知名字会让 `restrict` 抛错）、
  `model` 从 `launch` 一路传到 `createWorker`、`applyModel` 的能力缺失分支、报告重试复用同一 id 与 `holds` 判重。
- 放置测试 `test/placement.test.js`、非阻塞测试 `test/nonblocking.test.js`、模式测试 `test/mode.test.js`
  与两批回归（`p0-` / `p1-regression.test.js`）见各自文件头。
- 恢复与容错测试 `test/recovery.test.js`（10 个用例）：重启后 `queued` 重排 / `running` 标 `interrupted`、
  `isTransient()` 的判据、瞬时续跑与次数用尽、非瞬时直接失败、`retryTransient: false` 的退路、
  读回执只认 `msg`/`retry`、`dispatch_message` 的待读标记、progress 节流与关闭节流。
- 后台活与目录测试：`test/background.test.js`（6 条：不结算/清空收尾/到上限终止/无服务即结算/subagent 也算/换轮作废巡检）、
  `test/subagent.test.js`（6 条：收窄 `dispatch_*`、普通会话不收窄、worker 自己不算、嵌套链、销毁回收、成环保护）、
  `test/prepare.test.js`（9 条：目录命名与幂等、命令在父目录执行、已存在跳过、无命令只建目录、失败带输出、
  与 `start()` 的集成、失败不建会话、未配置时不动 cwd）。
- `npm test` 跑 `node --test`。**用例数不写死在文档里**：它每轮都在涨（本轮新增了 `test/memory.test.js`、
  `test/workspace-resolve.test.js`，并扩大了看板与放置用例），写死一个数字必然在下一次改动时又变成错的叙述——
  这正是本仓库「文档漂移」的老问题。要数字就看 `npm test` 的输出。
  （历史口径：0.8.1 前后是 111 条，P0/P1 两批之后是 158 条。当前以测试文件为准。）
  注意其中有一批用例依赖父用例的超时语义，在 `node --test` 下会显示为 `cancelled`：
  **cancelled 不是失败，但也别把它当成通过。**
- 宿主相关行为（建会话、投递、事件顺序、真实 HTTP 连接、浏览器渲染、真实 mkdir/归档）没有单元测试，靠 README 的实测记录覆盖；
  看板与输入框的**界面一次都没在真浏览器里跑过**（见 README「验证记录」与 [composer.md](composer.md)）。
- 想手工验证：`dispatch_list` 看 `version` 与 `max_workers`；`dispatch_inspect` 看 `cwd`、`recent_reports`、`last_worker_text`；
  `dispatch_workspaces` 看工作区；看板看 `GET /dsh-mini-superagent/board` 的 JSON。

## 兼容性与风险

- `engines.dsh >= 0.2.1-rc.2`；实测只在 `0.2.1-rc.5`。
- 依据主要来自编译产物的静态取证（asar 内没有 `.d.ts`），不是官方 API 文档。风险与兜底见同目录的
  `api-contracts.md` §8；与本插件最相关的是「`source.kind` 未知值在持久化/回放层是否宽容」。
- `sessionController.create` 换号、`resolveAgent` 的 `agent-busy`、`tools.register` 的层级语义，都在取证文档里列了出处。
- 看板的 `webServer.register` 与 `ctx.slots` 依赖宿主版本：宿主没有对应服务时分别表现为「路由不注册」与「客户端模块不加载」，
  不会让 Host 插件本身启动失败。
- `workspaceRegistry.create(path, title)` 要求目录已存在，且按路径幂等；`resolveByPath` 只查不建。
  这两条是 `workspaces.js` 先 `mkdir -p` 再注册的原因，也是「默认工作区创建失败不阻塞派发」的依据。
- `workspaceRegistry.archiveSession(id, {stopActivity})` 用于归档；宿主不提供时归档失败但任务与看板不受影响。
