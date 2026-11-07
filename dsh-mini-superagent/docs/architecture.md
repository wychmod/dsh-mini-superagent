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
  │    POST /dsh-mini-superagent/board/cancel   （看板「取消」）
  │    POST /dsh-mini-superagent/board/retry    （看板「重试」）
  │    POST /dsh-mini-superagent/board/archive  （「立即归档」/手动巡检）
  │    POST /dsh-mini-superagent/board/target   （看板读 targets；选择器与 @ 写）
  ├─ 派发目标选择器（conversation.input.left）
  │    GET  /board（挂载 + 每次打开）→ POST /board/target
  └─ @ 工作区（inputTriggers 的 @ source）
       GET  /board（10s 缓存）→ POST /board/target + 插入 chip
  ▼
src/board.js ── boardSnapshot / Dispatch.cancel / retry / archiveStale / setTarget ──▶ TaskTable + targets
```

Host 与 Client 不共享内存：Client 只认这几个同源 HTTP 端点（GET /board、GET /selfcheck、POST /client-ready、POST /archive、POST /target、POST /cancel、POST /retry），Host 把任务表与目标表拍平成快照返回。

## 模块与职责

| 文件 | 职责 | 依赖 | 明确不做 |
| --- | --- | --- | --- |
| `src/index.js` | 插件入口：建 `Dispatch`、`restore` + `provision`、注册 9 个工具、接宿主事件、注册看板路由、启动归档巡检、`ctx.effect` 清理 | `dispatch` / `tools` / `board` / `constants` | 不含业务逻辑 |
| `src/constants.js` | 名称、版本、日志前缀、消息来源 kind、提示段名、状态集合、默认配置（含工作区/归档）、任务 id 与消息 id 生成 | 无 | 不读文件、不碰 ctx |
| `src/tasks.js` | `TaskTable`：并发位、排队、结算、等待者；纯函数 `clip` / `oneLine` / `lastAssistantText` | `constants` | 不做 I/O，不调宿主 API |
| `src/store.js` | `tasks.json` 读回与覆盖写；`{version, savedAt, tasks, targets}`（`version: 3`，缺 `targets` 按空） | Node 内置模块 | 不校验业务字段、不做迁移 |
| `src/sessions.js` | `SessionGateway`：`freezeMessage` 懒加载、构造插件来源消息、双通道投递、`holds`（投递判重）、按目录取 cwd、workspace 解析、建子会话、权限预设、`applyModel`（model 透传）、`restrictTools`（路由模式收窄工具面）、系统提示注入、`enterDirectory`（切工作目录） | `constants` / `prompt` | 不管任务状态 |
| `src/prompt.js` | 给模型看的文本：主会话工作方式提示 `DISPATCH_HINT`、worker 首条消息 `workerPrompt` | `constants` / `tasks` | 不含判断逻辑 |
| `src/tools.js` | 9 个工具定义（含只读的 `dispatch_workspaces`）、`TOOL_NAMES`、参数 schema、结果卡片拼装、归属校验 | `constants` | 不直接操作会话 |
| `src/dispatch.js` | `Dispatch`：`launch` / `pump` / `settle` / `start` / `report` / `relay` / `message` / `cancel` / `retry` / `placementFor` / `provision` / `startArchiveSweep` / `archiveStale` / `targetFor` / `setTarget` / `enforceRouter` / `forgetRouter`、视图 `card` / `detail`、落盘 `persist` / `restore` / `dispose` | 其余全部 | 不直接调 `sessionController` / `agent.*`（走 gateway） |
| `src/board.js` | 看板 Host 半边：`boardTask` / `boardSnapshot`（拍平、计数、排序、200 条、工作区列表、`targets`）、`createBoardHandler`（5 条路由 + 同源校验）、`registerBoardRoutes` | `constants` | 不自己改任务状态（取消/重试/归档/目标转调 `Dispatch`） |
| `src/workspaces.js` | 工作区网关：`defaultRoot` / `rootOf` / `dayKey` / `dayTitle` / `safeDirName`、`WorkspaceGateway`（`ensure` / `defaultWorkspace` / `dayWorkspace` / `createNamed` / `list` / `resolve` / `resolveOrCreate` / `archiveSession`） | `constants` | 不碰任务表、不投递消息 |
| `src/prepare.js` | 每任务目录与一次性 prepare 命令：`taskDirectory` / `prepareEnv` / `runPrepare`（目录已存在即跳过、失败不重试、超时可配） | `workspaces`（`safeDirName`）+ Node 内置 | 不碰任务状态、不碰会话 |
| `client/index.js` | 浏览器半边，三条注册：`sidebar.panellist` 图标 + `main` 看板（2s 轮询、4 chip、工作区筛选、归档、点行跳会话）；`conversation.input.left` 派发目标选择器；`inputTriggers` 的 `@` 工作区 source。共用 `GET /board` 与 `POST /board/target` | 无（`require('react')` + 同源 `fetch` + `createPortal`） | 不 import Host 代码、不共享内存、不打包；不写全局样式 |

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

- 写：`Dispatch.persist()` 覆盖写 `{version: 3, savedAt, tasks, targets}`；密集的状态变化由 800ms 定时器合并（`timer.unref()`，不阻止进程退出）。
  0.5.0 起多一个 `targets`（会话 id → 派发目标），旧文件缺它时按空对象。
- 读：`restore()` 启动时读一次；读失败只 warn，不阻止插件启动——任务表是辅助信息，会话内容由 DSH 自己持久化。
- 恢复语义：未结算任务一律标 `interrupted`，因为新进程里没有活的 worker，不能假装它们还在跑。

为什么不上数据库：任务表是单写、低频、可丢的展示数据；JSON 文件足够，而且出问题时用户能直接看、直接删。

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
改一处要同步另一处；没有类型检查兜底。

### 15. 看板准入：回环放行，其余同源

插件注册的具名路由排在 DSH 页面鉴权之前，所以看板自己做了准入：

- `GET`：`Host` 是回环名（`127.0.0.1` / `localhost` / `::1`）放行；否则要求 `Origin` 与 `Host` 一致。
- `POST`：带 `Origin` 时必须与 `Host` 一致；不带 `Origin` 的（curl/脚本）放行。

这是「不把任务标题、工作目录、报告摘要泄露给任意网页」的最低成本方案，不是完整鉴权。
代价：远程 curl 读不到快照；不带 Origin 的 POST 在端口暴露时仍可取消/重试，需要自己控制网络暴露面。
细节与状态码见 [board.md](board.md)。

### 16. 客户端不打包、不编译

`client/index.js` 是一个 plain ModuleLoader 包：`window.__ModuleLoader__.load({id, factory(require){…}})`，
React 从 `require('react')` 取。理由：

- 仓库的硬约束是「无构建」；为一个面板引入打包器会破坏「clone 下来就能装」。
- ModuleLoader 的 `factory` 里可以直接 `require` 宿主已提供的 React，不需要自己带运行时。
- 样式随面板 `<style>` 卸载，只用 `var(--dsw-alias-*, fallback)`，不维护明暗两套。

代价：没有 JSX、没有类型检查；1017 行单文件，改结构时靠测试与人工审查。

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



## 模块拆分轴

拆分前是单文件 853 行。0.2.0 按「谁最容易变」切开：

| 轴 | 文件 | 变更频率 |
| --- | --- | --- |
| 宿主 API（最易随 DSH 版本变） | `sessions.js` | 高 |
| 业务编排 | `dispatch.js` | 中 |
| 纯规则（可单测） | `tasks.js` | 低 |
| I/O 格式 | `store.js` | 低 |
| 面向模型的文本 | `prompt.js` | 中（措辞会调） |
| 工具 schema | `tools.js` | 中 |
| 标识与默认值 | `constants.js` | 低 |
| 事件接线 | `index.js` | 低 |
| 看板 Host 半边（路由/快照形状） | `board.js` | 中（0.3.0 新增） |
| 看板浏览器半边（看板 + 选择器 + `@`） | `client/index.js` | 高（样式与交互会改；0.3.0 起，0.5.0 扩到三条注册） |
| 工作区（目录/解析/归档） | `workspaces.js` | 中（0.4.0 新增） |
| 每任务目录与 prepare 命令 | `prepare.js` | 低（0.8.x 新增；只在配了 `taskDirRoot` 时生效） |

这样 DSH 升级时优先改 `sessions.js`；调整提示词不碰业务逻辑；任务表规则可以脱离宿主跑测试；
看板 UI 改动不碰任务状态机，Host 路由改动不碰面板；工作区规则不碰派发状态机。

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
| 看板 POST 跨站 | `403 {"ok":false,"error":"跨站请求被拒绝"}`，不产生副作用 | `board.js` `sameOrigin()` |
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
- 看板测试 `test/board.test.js`（26 个用例）：
  - 8 个快照用例（拍平、`last_report`、截断、计数、排序、200 条上限、版本/时间）；
  - 11 个既有路由用例（GET 200/404/403/同源 200、cancel、retry、跨站 403、同源 POST、任务不存在 404、坏 JSON 400、失败 409）；
  - 7 个 0.5.0 用例（工作区列表与归档计数、`/archive`、`/target` 设置/清除/缺参/解析失败、快照 `targets`）。
  路由用假的 `req`/`res` 直接调 handler，不需要起 HTTP 服务。
- 工作区测试 `test/workspaces.test.js`（11 个用例）：日期键、`【派发】`标题、安全目录名（非法字符/空白/长度）、
  根目录优先级，以及解析顺序（id、绝对路径、标题精确、标题包含、找不到、无注册表）；用假注册表，只在 `ensure` 之外不碰磁盘。
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
- `npm test` 跑 `node --test`，全量 **158 个用例**（152 pass / 6 cancelled，后者是 `tasks.test.js` 里
  依赖父用例超时语义的既有用例，与本次改动无关）。
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
