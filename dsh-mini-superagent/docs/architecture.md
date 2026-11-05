# 架构

## 目标与边界

一句话：让主会话把任务派给独立的后台子会话，并把结果可靠地送回主会话，其余一概不做。

硬约束（不是设计偏好，是当前实现的事实）：

- Host 插件，纯 ESM，`main` 直接指向 `src/index.js`，无构建、无编译产物、无运行时依赖。
- 单进程：没有队列服务、没有数据库、没有跨进程协调。状态是一个 JSON 文件。
- 只依赖 DSH 的三个服务：`tools`、`agents`、`sessionController`（`src/index.js` 的 `inject`）。
- 任务的生命周期以「DSH Session」为单位；插件不自己维护子进程或工作线程。

## 数据流

```text
主会话（Agent）
  │  dispatch_launch(title, brief, [cwd/model/presets])
  ▼
Dispatch.launch ── 登记 task（queued）── TaskTable
  │                       │
  │                       └── pump() 占并发位
  ▼
SessionGateway.createWorker
  │  workspaceRegistry.resolveByPath / create → workspaceId
  │  sessionController.create({sessionId: dispatch-<taskId>, workspaceId|cwd, agentPreset?})
  │  sessionController.resolveAgent(sessionId) → Agent
  │  permissionPresets.set(agent.session, preset?)
  │  sessionController.rename({sessionId, title: "[派发] <title>"})
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

## 模块与职责

| 文件 | 职责 | 依赖 | 明确不做 |
| --- | --- | --- | --- |
| `src/index.js` | 插件入口：建 `Dispatch`、注册 8 个工具、接 `agent/status` 与 `agent/disposed`、`ctx.effect` 清理 | `dispatch` / `tools` / `constants` | 不含业务逻辑 |
| `src/constants.js` | 名称、版本、日志前缀、消息来源 kind、提示段名、状态集合、默认配置、任务 id 与消息 id 生成 | 无 | 不读文件、不碰 ctx |
| `src/tasks.js` | `TaskTable`：并发位、排队、结算、等待者；纯函数 `clip` / `oneLine` / `lastAssistantText` | `constants` | 不做 I/O，不调宿主 API |
| `src/store.js` | `tasks.json` 读回与覆盖写；`{version, savedAt, tasks}` | Node 内置模块 | 不校验业务字段、不做迁移 |
| `src/sessions.js` | `SessionGateway`：`freezeMessage` 懒加载、构造插件来源消息、双通道投递、按目录取 cwd、workspace 解析、建子会话、权限预设、系统提示注入 | `constants` / `prompt` | 不管任务状态 |
| `src/prompt.js` | 给模型看的文本：主会话工作方式提示 `DISPATCH_HINT`、worker 首条消息 `workerPrompt` | `constants` / `tasks` | 不含判断逻辑 |
| `src/tools.js` | 8 个工具定义、`TOOL_NAMES`、参数 schema、结果卡片拼装、归属校验 | `constants` | 不直接操作会话 |
| `src/dispatch.js` | `Dispatch`：`launch` / `pump` / `settle` / `start` / `report` / `relay` / `message` / `cancel`、视图 `card` / `detail`、落盘 `persist` / `restore` / `dispose` | 其余全部 | 不直接调 `sessionController` / `agent.*`（走 gateway） |

### 依赖方向

```text
index ──▶ dispatch ──▶ sessions ──▶ prompt ──▶ tasks ──▶ constants
  │            │            │
  │            ├──▶ store   │
  │            └──▶ prompt  │
  └──▶ tools ──▶ constants  │
       (接收 dispatch 实例，不 import dispatch)
```

单向、无环。`tasks.js` 与 `store.js` 不 import 任何 `@deepseek-ai/*`，所以能脱离 DSH 单测。
`index.js` 只 import 三个模块，把「谁会碰到宿主 API」限制在 `sessions.js` 一个文件里。

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
- 8 个工具在全局层注册一次，worker 的身份用「它是不是某个任务的 `workerSessionId`」反查（`TaskTable.byWorker`）就够了。

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

### 9. 状态机只有两个集合

- `SETTLED = {done, blocked, failed, cancelled, ended, interrupted}`：不再占并发位、`dispatch_wait` 不再等。
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

- 写：`Dispatch.persist()` 覆盖写 `{version: 2, savedAt, tasks}`；密集的状态变化由 800ms 定时器合并（`timer.unref()`，不阻止进程退出）。
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

这样 DSH 升级时优先改 `sessions.js`；调整提示词不碰业务逻辑；任务表规则可以脱离宿主跑测试。

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

## 可测试性

- `TaskTable`、`clip`、`oneLine`、`lastAssistantText` 都是纯逻辑，测试在 `test/tasks.test.js`，`npm test` 跑 `node --test`（13 个用例）。
- 宿主相关行为（建会话、投递、事件顺序）没有单元测试，靠 README 里的实测记录覆盖。
- 想手工验证：`dispatch_list` 看 `version` 与 `max_workers`；`dispatch_inspect` 看 `cwd`、`recent_reports`、`last_worker_text`。

## 兼容性与风险

- `engines.dsh >= 0.2.1-rc.2`；实测只在 `0.2.1-rc.5`。
- 依据主要来自编译产物的静态取证（asar 内没有 `.d.ts`），不是官方 API 文档。风险与兜底见同目录的
  `api-contracts.md` §8；与本插件最相关的是「`source.kind` 未知值在持久化/回放层是否宽容」。
- `sessionController.create` 换号、`resolveAgent` 的 `agent-busy`、`tools.register` 的层级语义，都在取证文档里列了出处。
