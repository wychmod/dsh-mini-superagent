# DSH 主机 API 契约（写 dsh-dispatch 用）

取证环境
- 安装包：`D:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\*`
  全包版本 `0.2.1-rc.5`。**asar 内没有 `.d.ts`**（只有 `lib/*.js`，类型文件在打包时被剥掉），所以类型必须靠
  `cordis_inspect_query(platform=host, provider=Service|Event)` 的官方投影，或从编译产物反推。
- 下文 `<PKG>` = `app.asar\dsh\node_modules\@deepseek-ai\<PKG>`；行号对应本机当前文件内容。
- 另一证据源：官方原型 `reference/dsh-superagent-prototype`（`src/app/delivery.ts`、`src/app/sessions.ts`、`src/executor/dsh.ts`）。
  它是**编译通过的真实插件**，调用方式可直接抄，价值最高。
- 本次只做「源码 + 官方类型投影」交叉验证，**没有起进程做运行时实验**（见 §8）。

---

## 1. `@deepseek-ai/dsh-llm`：消息构造与 source 扩展

**结论**
- 导出（运行时值是 `MessageId` / `freezeMessage` / `createUserMessage` / `boundContextSummary`）：
  - `MessageId(id: string): MessageId` —— 品牌化构造函数，**可直接当函数调用**作稳定 id。
  - `freezeMessage(message: Message): Message` = `deepFreeze(structuredClone(message))`，**保留传入的 id**，不做校验、不留空白补全。
  - `createUserMessage({content, source}): UserMessage` = 内部 `createMessage` → `structuredClone({...input, role:'user', id: brandString(randomUUID())})` + `deepFreeze`。
  - `boundContextSummary(s): string` 截到 `CONTEXT_SUMMARY_MAX_CHARS = 120`，`notice` 的 `summary` 必须先用它。
- `MessageSourceMap` 是**可被声明合并的开放映射**，基础成员只有 4 个：
  `{ user: {kind:'user'}; model: ModelMessageSource; tool: ToolMessageSource; 'system-prompt': SystemPromptMessageSource }`。
  插件新增 source kind 靠 TypeScript 模块增强，运行时不注册、不校验：
  ```ts
  declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap { 'dsh-dispatch': { kind: 'dsh-dispatch' } & ContextFormed }
  }
  ```
- `ContextFormed` 的实际用法（两个独立出处一致）：`{ form: 'relay' | 'notice' | 'snapshot'; summary?: string; sections?: ... }`。
  `form: 'relay'` = 视为一条正常投递的消息；`form: 'notice'` = 带一行摘要、不唤醒目标的上下文notice。
- **最稳做法**：自己造完整消息再 `freezeMessage`，id 用 `MessageId('dsh-dispatch:<task>:<role>:<n>')`，
  source 用 `{ kind:'dsh-dispatch', form:'relay', ...(摘要?{summary:boundContextSummary(x)}:{}) }`。
  **不要**用 `createUserMessage`（id 由 randomUUID 生成，重试会重复投递）。

**证据**
- `<dsh-llm>/lib/types/message.js:26-28`（freezeMessage）、`:34-39`（createMessage→uuid）、`:53-58`（createUserMessage）、`:10-20`（boundContextSummary）。
- `<dsh-llm>/lib/types/index.d.ts` 不存在；`MessageSourceMap` 基础成员来自 `cordis_inspect_query(Service=sessionController)` 的 `referencedTypes`。
- 声明增强范例：`reference/.../src/app/delivery.ts:8-12`；构造与投递：`:76-81`。
- `form:'notice'` + 120 字摘要的真实内部用法：`<dsh-agent-loop>/lib/index.js:136-146`（`{kind:'model-selection', form:'notice', summary: boundContextSummary(...)}`）。

**风险**
- `ContextFormed` **没有拿到逐字声明**（无 .d.ts）。`summary`/`sections` 是否必填未验证；按"只给 `{kind, form, summary?}`"写最安全。
- 运行时没有任何代码校验 `source.kind` 白名单（我通读了 message.js 与 session append 路径），但**也未验证持久化层是否宽容未知 kind**；若担心，兜底用旧形态 `{kind:'plugin', plugin:'dsh-dispatch', form:'relay'}`（原型历史上就用过，见 `tests/delivery.spec.ts:59,72`）。

---

## 2. `@deepseek-ai/dsh-agent`：Agent 接口完整成员

**结论**（`ReactLoopAgent` 是 `Agent` 的唯一实现，公开面就是下列成员）

| 成员 | 精确签名 | 语义 |
|---|---|---|
| `id` | `readonly id: SessionId` | 与 session.id 相同 |
| `session` | `readonly session: Session` | 可 `snapshotEvents()`、`append()`、`requestHeader()`、`header.parentSession` |
| `ctx` | `readonly ctx: Context` | **agent 作用域** ctx：`ctx.tools.register` / `restrict` / `guard` / `systemPrompt` / `inject` |
| `status` | `readonly status: 'idle' \| 'running'` | `maintenance` 也报 idle |
| `inbox` | `{ nextTurn: UserMessage[]; nextStep: UserMessage[]; hasPending: boolean; remove(id): boolean; append/prepend/replace/clear/splice }` | `nextTurn/nextStep` 是**只读快照数组** |
| `followup(m)` | `(m: UserMessage) => void` | 追加到 **next-turn** 并唤醒（目标 idle 则开新 turn） |
| `steer(m)` | `(m: UserMessage) => void` | 追加到 **next-step** 并唤醒（运行中在下一个 step 边界插入） |
| `inject(m)` | `(m: UserMessage) => void` | 追加到 **next-step**、**不唤醒**（纯上下文） |
| `cancel(cause, opts?)` | `(c: AgentCancelCause, o?: {keepInbox?: boolean}) => void` | `keepInbox` 缺省 false 会 clear 收件箱 |
| `whenIdle()` | `() => Promise<void>` | 等到驱动完全静止；实现是 do/while 轮询 |
| `options` | `AgentOptions`（只读） | `{provider?, model?, reasoningEffort?, maxTokens?}` |
| 内部 | `loopCtx`, `phase`, `dispatch`, `runMaintenance(job)` | 插件**不要**碰 |

- `AgentCancelCause = {kind:'user'} | {kind:'parent'} | {kind:'hook'; reason:string} | {kind:'disposed'}`。
- 三个投递方法都走同一个 `send(message, target, wakeup)`：`inbox.splice(target, Infinity, 0, [message])` — 即**尾部 FIFO 追加**。
  若目标正处于"已 abort 但未 idle"的 phase，`wakeup && phase.aborted` 会被降级成 `next-turn`（见 `:801-802`）。
- **同一 id 不能同时待投递**：Inbox 在写入时检查 `ids.has(message.id)` 并抛 `message "<id>" is already pending`（`:191-194`）。所以 id 必须幂等且唯一。

**证据**：`<dsh-agent-loop>/lib/index.js:747-875`（类字段、`status`、`send/followup/steer/inject/cancel`、`whenIdle`）；`<dsh-agent-loop>/lib/index.js:70-150`（Inbox）；`Agent`/`AgentCancelCause` 投影见 `Service=subagents` 的 `referencedTypes`。

**风险**
- 无 .d.ts，上表由实现反推；`replace/prepend` 等 Inbox 次要方法是否属于"公开约定"未验证，插件只该用 `nextTurn/nextStep/remove`（原型只用了这三个，见 `delivery.ts:63,74`、`dsh.ts:448`）。
- `steer()` 的"下一个 step"依赖目标正在跑 turn；对 idle 目标的语义实际等同 followup（因为会唤醒并开 turn）。

---

## 3. Host 事件：签名与分派语义

**结论**（`ctx.on(name, listener, options?)`；`agent/*` 事件的 `this` 是 `Scoped<Agent>` 载波）

```ts
'session/event'  (this: Scoped<Session>, session: Session, event: SessionEvent): void          // emit，提交后
'agent/status'   (this: Scoped<Agent>,   payload: { agent: Agent; status: AgentStatus }): void // emit，仅状态跃迁时
'agent/created'  (this: Scoped<Agent>,   payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined> // serial，可 await
'agent/disposed' (this: Scoped<Agent>,   payload: { agent: Agent }): void                       // emit，驱动静止后、session 解绑前
'agent/error'    (this: Scoped<Agent>,   payload: { agent: Agent; turn: number; step: number; error: unknown }): void
'agent/inbox/inserted' (this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }): void
```

- **精确解构**（照抄即可）：
  ```ts
  ctx.on('agent/status', ({ agent, status }) => { /* status: 'idle' | 'running' */ })
  ctx.on('agent/created', async ({ agent, source, signal }) => { /* 可 await */ return undefined })
  ctx.on('agent/disposed', ({ agent }) => { /* 从你的表里删掉 */ })
  ctx.on('session/event', (session, event) => { /* 注意：两个位置参数，不包 payload */ })
  ```
- 分派语义：`emit` 是 fire-and-forget，回调返回的 Promise 只被 `.catch` 记 warn，**不等待**；`serial` 才按注册顺序 await。
- **作用域过滤**：`agent/*`、`session/*` 是 scope-filtered dispatch。插件根 ctx 注册 = 收到**所有** agent 的事件；
  `agent.ctx.on(...)` 注册 = 只收到该 agent（只有以该 agent 作载波派发的事件）。官方控制器在根 ctx 上监听时显式传 `{ global: true }` 来**关闭过滤**。
- `agent/status` 只在状态**真的变化**时发（`setPhase` 内比较前后 status），一个 turn 内多次 step 不会重复发。
- 原型就是靠 `agent/status === 'idle'` 判完成、靠 `agent/created` 给新会话挂装饰：`sessions.ts:107-136`。

**证据**：目录与签名来自 `cordis_inspect_query(provider=Event)`（`agent/status`、`agent/created`、`agent/disposed`、`session/event` 单条查询）；
`agent/status` 的派发点 `<dsh-agent-loop>/lib/index.js:794-799`；`{global:true}` 实用于 `<dsh-api-session-controller>/lib/index.js:1460,1536`。

**风险**
- `{global:true}` 这个 `on` 选项的精确语义只从官方源码用法反推（cordis 无 .d.ts），**未逐字验证**。插件根 ctx 监听 `agent/status` 在原型里不加该选项也工作（`sessions.ts:133`），建议**根 ctx + 不传选项**，要绝对保险再补 `{global:true}`。
- `agent/status` 只告诉你"某个 agent idle 了"，**不告诉你哪条任务完成、也没带结果**；worker→parent 的"报告"必须自己关联 taskId 并从 session 日志里取答案。

---

## 4. `@deepseek-ai/dsh-api-session-controller`：create / resolveAgent 真实行为

**结论**
- 类型（官方投影，逐字）：
  ```ts
  SessionCreateRequest  = { readonly workspaceId?: WorkspaceId; readonly cwd?: string; readonly sessionId?: SessionId; readonly agentPreset?: string }
  SessionCreateValue    = { readonly sessionId: SessionId; readonly agentPreset?: string }
  SessionRenameRequest  = { readonly sessionId: SessionId; readonly title: string }   // → {title, seq}
  ApiSessionAgentResult = { readonly agent: Agent } | { readonly error: ApiSessionAgentError }
  ApiSessionAgentError  = RemoteError<'session/not-found'|'session/agent-busy'|'session/writer-held'|'gateway/internal'>
  ```
- `create({sessionId?, workspaceId?|cwd?, agentPreset?})`：
  1. `workspaceId` 与 `cwd` **互斥**，同时给 → `RemoteError('gateway/bad-request')`；
  2. `workspaceId` 查 `ctx.workspaceRegistry.get()`，找不到 → `RemoteError('workspace/not-found')`；**不需要先注册 workspace 也能用 `cwd`**；
  3. `cwd = workspace?.path ?? request.cwd ?? process.cwd()`，随后 `mkdir(cwd, {recursive:true})`；
  4. **立即创建并发布 Agent**：`ctx.agents.create({sessionId, agentOptions: <默认模型>, meta: {cwd, agentPreset?}, setup})`；
  5. 给了 `workspaceId` 还会 `workspace.attachSession(sessionId)`（失败 → `session/workspace-attach-failed`）。
- **命名会话会被"复用 or 换号"**：传入 `sessionId` 且该会话已存在时，只有"仍空白（无 `turn/start`）+ 未被归档 + 属于同一 workspace"才复用；
  否则 `createMinted()` **铸造一个全新 id** `session-<uuid>`。所以 `create({sessionId})` 的返回值必须读 `value.sessionId`，不能假定等于传入值。
- `resolveAgent(sessionId)`：**只解析/恢复，不创建**。活的直接返回；否则 `ctx.agents.resume({resumeSessionId, agentOptions, setup})`。
  失败映射：不存在 → `session/not-found`；`SessionAlreadyOwnedError` → `session/writer-held`；被 subagent 路由占用 → `session/agent-busy`；其余 → `gateway/internal`。
  官方原型的正确姿势就是 **`create()` 之后再 `resolveAgent()`** 拿 Agent（`sessions.ts:140-148`）。
- 标题：`rename({sessionId, title})`，内部 `ctx.get('sessionTitle').rename(agent.session, title)`，无 `sessionTitle` 服务 → `gateway/internal`；标题非法 → `session/title-invalid`。rename 会 **resume** Agent。
- `prompt({requestId, sessionId, mode:'queue'|'steer', content, clientTimeZone?})` 可用，但它构造的 source 是
  `{ kind:'user', rpcId: requestId, ... }` —— **会被当成"用户亲自发的消息"**。dsh-dispatch 要保留"插件来源"，就别用它，改成 §5 的 `freezeMessage` + `steer/followup`。

**证据**：`<dsh-api-session-controller>/lib/index.js:755-787`（commands.create，workspaceId/cwd/mkdir/attach）、
`:264-268 + :416-465`（claim / reuse / `createMinted`）、`:508-526`（`ctx.agents.create` 与 `mkdir`）、
`:210-246`（resolveAgent + 错误映射）、`:827-841`（rename）、`:3218-3231`（prompt 的 user source）。

**风险**
- `agentOptions` 由控制器统一注入部署默认模型（`ctx.agentDefaultModel.currentSelection()`）；**绕过 sessionController 直接 `ctx.agents.create` 时必须自己传**，否则路由未验证（见 §8）。
- 返回值换了 id 这件事很容易踩：dsh-dispatch 若用"确定性 sessionId"做幂等键，必须**以返回值为准并落库**。

---

## 5. 参考实现：子会话创建 + 首条 prompt + 父↔子消息

有两条官方路径，按"你要多薄"选：

**A. 最薄（插件自己撸，等价于 sessionController 的核心）**
```ts
const { agent } = await ctx.agents.create({          // agents.create(options: CreateAgentOptions): Promise<AgentHandle>
  sessionId: workerId as SessionId,
  agentOptions: { ...ctx.agentDefaultModel.currentSelection() },   // provider/model 必给
  meta: { cwd, parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
  setup: async (agentCtx, agent) => { /* 在这里注册 worker 专属工具/系统提示 */ },
})
agent.followup(freezeMessage({ id: MessageId(`dsh-dispatch:${workerId}:kickoff`), role: 'user',
  content: [{ type: 'text', text: promptText }], source: { kind: 'dsh-dispatch', form: 'relay' } }))
```
`AgentHandle = { agent, dispose }`；`meta` 是 `SessionHeader` 片段（`cwd/parentSession/origin/delegationDepth/isSeeded/agentPreset`），
证据：`<dsh-agent-loop>/lib/index.js:1893-1913`（createAgent）、`:511-526` 与 `:883-898`（官方传 meta 的形状）。

**B. 官方原型路径（会话在 GUI 里像"正常会话"，标题可控）**
```ts
let r = await ctx.sessionController.resolveAgent(id)
if ('error' in r && r.error.code === 'session/not-found') {
  const workspace = await ctx.workspaceRegistry.create(cwd)     // 可选：想让它进某个 workspace 才需要
  await ctx.sessionController.create({ sessionId: id, workspaceId: workspace.id, agentPreset })
  r = await ctx.sessionController.resolveAgent(id)
}
if ('error' in r) throw r.error
await ctx.sessionController.rename({ sessionId: id, title })     // 标题
```
证据：`reference/.../src/app/sessions.ts:138-155`（逐行）。

**C. 用官方托管运行时（自带结果投递、深度限制、子进程清理）**
`ctx.subagents.startActivation({ provider:'spawn', label, request:{ cwd?, prompt:[{type:'text',text}], parent, agentPreset?, agentOptions?, maxDepth? }, signal, delivery:'parent' })`
→ 返回 `SubagentActivation = { childId, messageId?, result: Promise<SubagentResult>, dispose() }`。
`SubagentResult = { output: ContentBlock[]; structured?; diagnostic?; stopReason }` —— **这是唯一"自带报告回传"的机制**。
证据：`cordis_inspect_query(Service=subagents)`；`<dsh-tool-subagent>/lib/index.js:462-483`（工具里怎么调）；
`<dsh-subagent-spawn-in-process>/lib/index.js:19-37`（provider 只声明 capabilities，`start()` 可缺省 → 由 manager 代建 child）。

**父→子后续消息**：`ctx.subagents.sendMessage(sender, targetId, content, { signal })`（限"直接父/直接 continuable 子"），
或按 §2 直接 `targetAgent.steer/inject/followup(message)`（A/B 路径下你有 Agent 引用，最直接）。
原型对"父收子报告"的处理是 **自己建投递层**：`AgentDelivery.send()` 用"稳定 MessageId + 扫描 pending/持久化日志"做至多一次投递（`delivery.ts:61-85`）。

**风险**
- `startActivation` 的 `provider:'spawn'` 名字取决于部署配置（`spawn-in-process` 的 Config 允许改名，默认 `spawn`）；用前先 `ctx.subagents.list()`。
- B 路径下 `create()` 可能换号（§4），原型靠 `resolveAgent(id)` 二次解析规避；**不要直接信 `create` 的入参 id**。
- **已验证的硬约束**：`hasApiSessionSubagentOwner()` 的第一条判断就是 `session.header.origin === 'subagent'` → 命中即判定"subagent 路由拥有"，
  `resolveAgent` 直接返回 `{error: RemoteError('session/agent-busy', '... is owned by subagent routing', {reason:'use subagent delivery for this child session'})}`
  （`<dsh-api-session-controller>/lib/index.js:128-142`、`:225`）。
  第二条判断是 `header.parentSession` 存在 **且** 父 Agent 在注册表里 `isOwnedBy(child, parent)` 也为真，同样判 busy（`:130-133`）。
  所以：**想让子会话日后还能被 sessionController/GUI 打开，就不要写 `origin:'subagent'`，也不要让父 Agent 通过 `parentAgent`/`enter()` 取得所有权**；
  只用 `meta.parentSession` 记血缘。反过来，若走 §5C 的 `subagents` 托管路线，被这个规则挡住是**预期行为**（那是它的设计）。

---

## 6. `ctx.tools.register` 的作用域语义

**结论**（`ToolDefinition` 必填 `output: {schema, render(args,value): ContentBlock[]}`，缺了直接 `TypeError`）
- `register(definition): () => void` —— **注册到"调用它的 ctx 所属的层"**：
  - 插件 `apply(ctx)` 里的根 ctx → **全局层**，所有 Session 的模型都看得到；
  - `agent.ctx.tools.register(...)`（或 `agent.ctx.inject(['tools'], c => ...)` 后 `tools.register`）→ **该 agent 的层**，只对该 agent 可见，且**遮蔽**同名全局工具。
  - 同一层重复名、以及保留名 `run_code` → 抛错。
- `restrict({allow?, deny?})`：**必须**在 scoped ctx（`agent.ctx`）上调用，否则抛
  `"tools.restrict() requires a scoped context (agent.ctx)"`。语义 = 只过滤"继承来的"工具（全局 + 祖先层），**永不过滤本层自己注册的**；多次 restrict 取交集；空 filter 抛错；名字未知抛错。
- `guard((exec) => string | undefined)`：普通 ctx = 全局 guard；`agent.ctx` = 只对该 agent。单调：任一 guard 返回字符串即 deny，没有"强制放行"。
- 读取侧：`get(name, scope?)` / `schemas(scope?)`，`scope` 就是那个 `Agent`（`ScopeKey = object`）。
- 清理：三者都返回"exact disposer"，且内部是 `layers.effect(this.ctx, ...)` → **绑在 ctx 生命周期上**，插件卸载自动注销。
  官方写法一律 `ctx.effect(() => { const off = ctx.tools.register(def); return off })`（`<dsh-tool-subagent>/lib/index.js:488-496`）。
- **给"每个 agent 装自己的工具"的官方范式**（照抄）：
  ```ts
  ctx.on('agent/created', async ({ agent }) => {
    agent.ctx.inject(['tools'], (c) => { c.tools.register(workerOnlyTool) })   // fiber 随 agent 卸载
  })
  ctx.on('agent/disposed', ({ agent }) => { /* 对应 fiber.dispose() */ })
  ```
  证据：`<dsh-tool-subagent>/lib/index.js:570-610`。

**证据**：`<dsh-tools>/lib/index.js:2974-2983`（register → `layers.effect(this.ctx, layer => layer.tools.insert(...))`）、
`:2991-3006`（restrict 强制 scoped）、`:3017-3032`（guard 全局/作用域）、`:2911-2913`（presentAs 同样要求 scoped）；
方法描述来自 `cordis_inspect_query(Service=tools)`。

**风险**
- "作用域"来自 `scopeOf(ctx)`（dsh-scope）。**在 `agent.ctx` 里异步 `await` 之后再 register 仍然算该 agent 层**（scope 跟 ctx 走，不跟时间走）——但这条我只从 `layers.effect(this.ctx, ...)` 的写法推断，未做运行时验证。
- dsh-dispatch 的工具如果是**全局**注册（`apply` 里），那么 **worker 自己也能调用 `dispatch`**（递归派生）。需要 `restrict({deny:['dispatch']})` 或只在主会话的 agent 层注册。

---

## 7. 两段可直接抄的最小代码

### 7.1 创建子 Session（含 workspace 处理）→ 取 Agent → 投第一条 prompt
```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 创建 worker，返回活 Agent。cwd 决定它的工作目录；不需要先注册 workspace。 */
export async function spawnWorker(ctx: Context, parent: Agent, workerId: string, cwd: string, brief: string): Promise<Agent> {
  const existing = ctx.agents.get(workerId as SessionId)
  const agent = existing ?? (await ctx.agents.create({
    sessionId: workerId as SessionId,
    agentOptions: { ...ctx.agentDefaultModel.currentSelection() },   // provider/model：不要省
    meta: { cwd, parentSession: parent.id, delegationDepth: 1 },     // 想进 GUI workspace 就用 §5B
    setup: async (agentCtx, worker) => {
      // worker 专属能力（可选）：agentCtx.tools.register(...) / agentCtx.systemPrompt.section(...)
    },
  })).agent

  // 首条 prompt：稳定 id，重复调用不会重复入队
  const id = MessageId(`dsh-dispatch:${workerId}:kickoff`)
  const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(m => m.id === id)
  const logged = agent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.id === id)
  if (!pending && !logged) {
    agent.followup(freezeMessage({
      id, role: 'user',
      content: [{ type: 'text', text: brief }],
      source: { kind: 'dsh-dispatch', form: 'relay' },
    }))
  }
  return agent
}
```
注意：`ctx.agents.create` 会**立即发布** Agent 并触发 `agent/created` / `session/created`；
`followup` 负责唤醒（`steer` 亦可，语义见 §2）。若用 sessionController 版本，把上面 `ctx.agents.create` 换成 §5B 的四行。

### 7.2 把一条文本作为"插件来源的 user message"投进另一个 Agent
```ts
import { boundContextSummary, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'

/** mode: 'steer' = 下一个 step 边界插入；'followup' = 作为新 turn；'inject' = 只进上下文不唤醒。 */
export function deliver(target: Agent, key: string, text: string,
  mode: 'steer' | 'followup' | 'inject' = 'followup'): boolean {
  const id = MessageId(`dsh-dispatch:${target.id}:${key}`)          // key 里放 taskId/回合号 → 幂等
  const dupe = [...target.inbox.nextTurn, ...target.inbox.nextStep].some(m => m.id === id)
    || target.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.id === id)
  if (dupe) return false
  const message = freezeMessage({
    id, role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-dispatch', form: mode === 'inject' ? 'notice' : 'relay',
              ...(mode === 'inject' ? { summary: boundContextSummary(text) } : {}) },
  })
  if (mode === 'steer') target.steer(message)
  else if (mode === 'inject') target.inject(message)
  else target.followup(message)
  return true
}
```
**id 生成规则**：`dsh-dispatch:<sessionId>:<taskId>:<role>:<n>`，必须
（a）全局唯一、（b）同一次投递重试时逐字相同、（c）不与其他来源（用户 RPC 的 `rpcId`）撞车。
重复的 pending id 会抛 `message "<id>" is already pending`（§2），已提交的重复 id 不会抛但会在日志里留重复消息 → 所以两处都要查。
跨重启的强幂等要像原型那样读持久化日志（`ctx.sessionPersistence.flush()` + `open(agent.id,'read')` + 分页 `read(offset,512)`，见 `delivery.ts:40-60`）。

---

## 8. 没有验证成功的点 + 兜底方案

| # | 未验证 | 影响 | 兜底 |
|---|---|---|---|
| 1 | `ContextFormed` 的逐字声明（asar 无 .d.ts，`MessageSourceMap` 投影里也没带它） | 类型报错 | 只用 `{kind, form:'relay'\|'notice', summary?}`；或本地 `as unknown as UserMessage` 强转（原型 `host.ts:37` 就这么干） |
| 2 | `ctx.on(name, fn, {global:true})` 的精确语义 | 可能漏收其他 agent 的事件 | 在**根 ctx** 注册监听（原型实证可行）；必要时再加 `{global:true}` 并回归测试 |
| 3 | `ctx.sessionPersistence.flush()` / `open(id,'read')` / `handle.read(offset,limit)` 的签名 | 跨重启幂等会挂 | 先只做"内存 + session 日志"级幂等（§7.2），把持久化幂等标 TODO；或改用 `subagents.startActivation` 的托管语义 |
| 4 | 省略 `agentOptions` 时 `ctx.agents.create` 的模型路由兜底 | worker 可能起不来/用错模型 | 一律显式传 `ctx.agentDefaultModel.currentSelection()`（官方控制器就是这么做，`:527-533`） |
| 5 | `source.kind` 未知值在持久化/回放层是否被宽容 | 重启后可能读不出消息 | 先按 `{kind:'plugin', plugin:'dsh-dispatch'}` 旧形态起步（有历史先例），验证后再升级到专属 kind |
| 6 | worker "完成 → 自动回报" 是否有现成钩子 | 需要自己实现 | **没有**。只有 `agent/status:'idle'` + 自己（用 taskId 关联）从 `agent.session` 里取最后一条 assistant 文本，然后 §7.2 投给父；或用 `subagents.startActivation().result` 这条现成通道 |
| 7 | **全部结论均为静态取证，未跑通一次真实派生**（本任务只做契约确认） | 编译期/运行期偏差未知（类型是反推的、无 .d.ts） | 落地第一步就写 `dispatch-smoke`：起一个 worker → 等 `agent/status idle` → 断言父会话收到回流消息，再扩功能 |

**工程约束（不是 API，但会咬人）**
- 工具必须有 `output: { schema, render }`，否则 `register()` 直接 `TypeError`；`parameters` 用 JSON Schema（或 `defineTool` 的 DSL）。
- 工具名不能是 `run_code`；同一层不能重名。
- 全局注册的 `dispatch` 工具会被 worker 自己看到 → 递归派生，需 `restrict({deny:['dispatch']})`（只能对 `agent.ctx` 用）。
- 只写 `research/`，不动 `plugins/`（本任务约束）。

---

## 与实现的对应关系

本节由维护者追加，**不改动上文任何取证结论与证据行**（上文写于 0.1.0 时期，当时的包名是 `dsh-dispatch`）。
当前实现是 `dsh-mini-superagent` 0.2.0，契约结论不变，只把「落到哪个文件」对上号：

| 上文契约 | 当前实现位置 | 说明 |
| --- | --- | --- |
| §1 `freezeMessage` / 消息 id / `source` 扩展 | `src/sessions.js` `freeze()` / `userMessage()`；`src/constants.js` `SOURCE_KIND` / `nextMessageId()` | 懒加载 `@deepseek-ai/dsh-llm`，失败退 `Object.freeze`；来源 `{kind:'dsh-mini-superagent', form:'relay'}`；消息 id 为 `<taskId>:<kind>:<BOOT>:<seq>` |
| §2 Agent 接口（`followup` / `steer` / `cancel` / `status`） | `src/sessions.js` `deliver()`；`src/dispatch.js` `message()` / `cancel()` | `steer` 仅在目标 `running` 时用，否则 `followup`；取消用 `cancel({kind:'user'}, {keepInbox:false})` |
| §3 Host 事件（`agent/status` / `agent/disposed`） | `src/index.js` 两个 `ctx.on` | `emit` 是 fire-and-forget，异步处理统一 `void dispatch.onWorkerIdle(...)` |
| §4 `create` / `resolveAgent` / `rename` | `src/sessions.js` `createWorker()` | 先 `create` 再 `resolveAgent`；`workspaceId` 与 `cwd` 互斥；权限预设走 `permissionPresets.set` |
| §4 末尾「`prompt()` 的来源是 `user`」 | `src/sessions.js` `deliver()` 的降级分支 | 正常走收件箱保留插件来源；收件箱失败才退 `sessionController.prompt` |
| §5 子会话创建路径 | 采用 §5B（`sessionController`），未用 §5C（`subagents.startActivation`） | 子会话是普通 Session，可在侧边栏打开与追问 |
| §6 `ctx.tools.register` 作用域 | `src/tools.js` `registerTools()` | 在插件根 ctx 全局注册；没有用 `restrict`，角色在 `execute` 里判定（`requireCaller` / `ownTask` / `byWorker`） |
| §7.2 插件来源消息投递 | `src/sessions.js` `deliver()` + `src/constants.js` `nextMessageId()` | 思路同 §7.2；id 生成规则改成了「任务 id + 用途 + 随机前缀 + 序号」，跨插件重启不撞 |
| §8 #5 未知 `source.kind` 是否被宽容 | 已用专属 kind 实跑 | 0.1.0 的 8 条实测与 0.2.0 重验都走这条来源，报告能回流、任务表能恢复 |
| §8 #6 自动回报钩子 | `src/dispatch.js` `onWorkerIdle()` + `src/tasks.js` `lastAssistantText()` | 没有现成钩子，按取证结论自己用 `agent/status:'idle'` + 最后一条 assistant 文本实现 |
| §8 #7 未跑通真实派生 | 已跑通 | 端到端实测记录在包 `README.md` 的「验证记录」，含派发/回流、漏报告兜底、追问、取消、重启恢复、空闲唤醒、并发排队 |
