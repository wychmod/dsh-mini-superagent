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
  │  placementFor(task) → day：当天【派发】工作区 / target：任务的目标工作区
  ▼
SessionGateway.createWorker
  │  workspaceId 给定时直接用；否则 workspaceRegistry.resolveByPath / create
  │  sessionController.create({sessionId: dispatch-<taskId>, workspaceId|cwd, agentPreset?})
  │  sessionController.resolveAgent(sessionId) → Agent
  │  permissionPresets.set(agent.session, preset?)
  │  sessionController.rename({sessionId, title: "[派发] <title>"})
  │  task.cwd ≠ placement.path → workingDirectory.set(agent, task.cwd)   ← 会话住【派发】，活干在目标目录
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
| `src/sessions.js` | `SessionGateway`：`freezeMessage` 懒加载、构造插件来源消息、双通道投递、按目录取 cwd、workspace 解析、建子会话、权限预设、系统提示注入、`enterDirectory`（切工作目录） | `constants` / `prompt` | 不管任务状态 |
| `src/prompt.js` | 给模型看的文本：主会话工作方式提示 `DISPATCH_HINT`、worker 首条消息 `workerPrompt` | `constants` / `tasks` | 不含判断逻辑 |
| `src/tools.js` | 9 个工具定义（含只读的 `dispatch_workspaces`）、`TOOL_NAMES`、参数 schema、结果卡片拼装、归属校验 | `constants` | 不直接操作会话 |
| `src/dispatch.js` | `Dispatch`：`launch` / `pump` / `settle` / `start` / `report` / `relay` / `message` / `cancel` / `retry` / `placementFor` / `provision` / `startArchiveSweep` / `archiveStale` / `targetFor` / `setTarget`、视图 `card` / `detail`、落盘 `persist` / `restore` / `dispose` | 其余全部 | 不直接调 `sessionController` / `agent.*`（走 gateway） |
| `src/board.js` | 看板 Host 半边：`boardTask` / `boardSnapshot`（拍平、计数、排序、200 条、工作区列表、`targets`）、`createBoardHandler`（5 条路由 + 同源校验）、`registerBoardRoutes` | `constants` | 不自己改任务状态（取消/重试/归档/目标转调 `Dispatch`） |
| `src/workspaces.js` | 工作区网关：`defaultRoot` / `rootOf` / `dayKey` / `dayTitle` / `safeDirName`、`WorkspaceGateway`（`ensure` / `defaultWorkspace` / `dayWorkspace` / `createNamed` / `list` / `resolve` / `resolveOrCreate` / `archiveSession`） | `constants` | 不碰任务表、不投递消息 |
| `client/index.js` | 浏览器半边，三条注册：`sidebar.panellist` 图标 + `main` 看板（2s 轮询、4 chip、工作区筛选、归档、点行跳会话）；`conversation.input.left` 派发目标选择器；`inputTriggers` 的 `@` 工作区 source。共用 `GET /board` 与 `POST /board/target` | 无（`require('react')` + 同源 `fetch` + `createPortal`） | 不 import Host 代码、不共享内存、不打包；不写全局样式 |

### 依赖方向

```text
index ──▶ dispatch ──▶ sessions ──▶ prompt ──▶ tasks ──▶ constants
  │            │            │
  │            ├──▶ store   │
  │            ├──▶ prompt  │
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

### 17. 会话住在【派发】，活干在目标目录

`workerWorkspace: day`（默认）时，子会话挂到当天【派发】工作区；但任务的 `cwd` 是目标工作区路径。
两者不同就调 `workingDirectory.set(agent, task.cwd)`。

理由：

- 侧边栏按会话的 workspace 分组。如果每个项目都往自己的工作区里塞子会话，项目工作区会被派发会话淹没；
  统一收进当天的【派发】，用完归档，列表就干净。
- 工作目录决定子会话实际读写哪里。把它切到目标目录，shell、读写工具、相对路径全都落在正确位置，
  效果等价于「在目标目录里开了一个会话」。
- 代价：会话归属与工作目录分离，排查时要分清 `workspace_title` 与 `cwd`；`workingDirectory` 不可用或 `set` 失败时
  子会话会落在【派发】目录里（只记 warn，任务照跑）。
- 不指定 `workspace` 时：`cwd` 仍取调用者目录，但会话仍进【派发】。这是 0.4.0 相对 0.3.0 的行为变化。

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

## 可测试性

- 纯逻辑测试 `test/tasks.test.js`（13 个用例）：`TaskTable`、`clip`、`oneLine`、`lastAssistantText`。
- 看板测试 `test/board.test.js`（26 个用例）：
  - 8 个快照用例（拍平、`last_report`、截断、计数、排序、200 条上限、版本/时间）；
  - 11 个既有路由用例（GET 200/404/403/同源 200、cancel、retry、跨站 403、同源 POST、任务不存在 404、坏 JSON 400、失败 409）；
  - 7 个 0.5.0 用例（工作区列表与归档计数、`/archive`、`/target` 设置/清除/缺参/解析失败、快照 `targets`）。
  路由用假的 `req`/`res` 直接调 handler，不需要起 HTTP 服务。
- 工作区测试 `test/workspaces.test.js`（11 个用例）：日期键、`【派发】`标题、安全目录名（非法字符/空白/长度）、
  根目录优先级，以及解析顺序（id、绝对路径、标题精确、标题包含、找不到、无注册表）；用假注册表，只在 `ensure` 之外不碰磁盘。
- `npm test` 跑 `node --test`，全量 50 个用例。
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
