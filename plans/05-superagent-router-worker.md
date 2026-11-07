# 05 · 与上游 dsh-superagent 的架构对照：router 与 worker

> 对照对象：`deepseek-ai/dsh-superagent-prototype` @ `8c32a9d`（取回方式见
> [`reference/README.md`](../reference/README.md)）。
> 对照对象是本仓库的 [`dsh-mini-superagent/`](../dsh-mini-superagent/)（`package.json` 0.8.0，
> 工作区含 0.8.1 未发布改动）。
>
> 结论先行：**骨架同源，治理层缺位**。上游把「主会话（router）」与「执行会话（worker）」的差别
> 落成三件可执行的东西——两个 agent preset、按角色 restrict 的工具白名单、带优先级预留的槽位；
> 我们只落成**提示词 + 调用时的归属校验**。所以功能闭环一致，边界与失控保护不一致。

---

## 一、上游怎么切 router 与 worker

上游没有「派发插件」这个概念，它是**一个完整产品**（监听 GitHub/Feishu → 建工单 → 派给执行会话 →
回收报告 → 回复原会话）。router 与 worker 是同一套工单模型上的两个**会话角色**，差别全部由
DSH 的 agent preset 承担。

```mermaid
flowchart TB
  subgraph bundle[插件 bundle 自己声明的两个 preset]
    R["dsh-superagent-router<br/>order 91 · 主 Session"]
    W["dsh-superagent-worker<br/>order 90 · 执行器 Session"]
  end
  S[sources: GitHub / Feishu] -->|Trigger| E[Engine]
  E -->|accept → Ticket + Assignment| X[DshExecutor]
  X -->|ensure(worker-&lt;ticketId&gt;)| W
  X -->|relay 报告| R
  R -->|decide: accept / stop / ignore| E
  W -->|report: ready / blocked / failed / progress| E
```

### 1.1 两个 preset 是硬边界，不是建议

`cordis.patch.yml` 里以 `@deepseek-ai/dsh-agent-preset` 的形式插入两行：

| | `dsh-superagent-router`（order 91） | `dsh-superagent-worker`（order 90） |
|---|---|---|
| shell | `timeoutMs`/`maxTimeoutMs` = **5000** | 同样 5000 |
| 文件系统 | `tool-fs` **`write:false, edit:false`** | 读写全开 |
| 搜索 | 无 `tool-fs-search` | 有 `glob`/`grep` |
| 子会话 | **无** `tool-subagent` | 有（`agentPreset: standard`） |
| web | 无 | 有（`fetch:false`，只留 search） |
| todo / persona | 无 | 有 |
| 提示词 | `complete: true`（整段替换系统提示，无 persona 段） | 由 persona 起头 |

设计意图写在注释里：**主会话不该能写文件**，因为它只做路由；**worker 的前台命令 5 秒后转后台**，
这样人插进来的消息能在**下一个 step** 被拿到，而不是等一条 60 秒的命令跑完。

### 1.2 三道运行时闸门（比 preset 更细）

`src/app/sessions.ts` 的 `decorate()`（232–269）：

1. **router**：`agent.ctx.tools.restrict({ allow: ['skill','bash','read','read_image','job_output','job_list','job_kill'] })`
   —— 即使 profile 里有 `write`/`subagent`，主会话也拿不到。
2. **router**：`agent.ctx.tools.guard(noWait)`（63–86）—— 拦掉命令行里出现 `sleep`、
   `timeoutMs > 30_000`、`job_output.wait` 超过 5 秒的调用，并把原因回给模型：
   「报告会自己来，结束这一轮，不要等」。这就是把「不要阻塞」从提示词升级成**拒绝执行**。
3. **worker**：`workOnly()`（289–297）—— `restrict` 到 `WORK_TOOLS`（61–62），
   并挂一个 guard：**工单结束后所有工具立刻失效**（`Ticket ended; new work needs a new authorized ticket`）。
   子会话（subagent）走 `limitSubagent()`，继承同一套工作工具，`standard` preset。

### 1.3 槽位模型：并发不是「计数」，是「预留」

`src/executor/dsh.ts:171-205` 的 `WorkerSlots`：

- `used() = |running ∪ starting|`，`starting` 是**同步预留**的（`reserve()` 在 `await` 之前调用），
  所以两次启动不可能同时拿走最后一个空位。
- `reserve(ticketId, by)` 的 `by` 有三种：`launch` / `wake` / `person`。
  **`person` 可以用 `max + 1` 的那一个额外槽位**，代码注释直说：
  「so they never wait behind new launches」——人的追问永远不排在批量任务后面。
- `launches() = max - |running ∪ wakes|`：只有 `launch` 受这个数限制，`wake` 不占，
  于是「唤醒已有会话」永远不会被「新任务排队」饿死。

这三点我们的实现里**一个都没有**：只有一个 `maxWorkers` 软上限，`dispatch_message` 会直接把任务
置 `running`，超了也不管（`docs/architecture.md` §8 明确写成「有意为之」）。

### 1.4 worker 的生命周期比「回合」长

上游把 worker 的占用单位定义成 **Assignment**，而不是「一次 agent 回合」：

- 回合结束时如果还有 shell job 或 subagent 在跑，**槽位不释放**，工单仍是 `working`；
  后台活干完会唤回 worker 拿结果（`003-execution.md` §Background work and worker slots）。
- 后台活最多再跑 30 分钟（`BACKGROUND_LIMIT_MS`），到点杀 job、报 `waiting`，
  并把「最后说的话 + 杀了哪些 job」写进报告。
- **交接给人的那一刻立即释放槽位**（`handOff()`，588–604）：subagent 停，shell job
  （比如留给人看的 dev server）留着、**不再占槽位**、不受 30 分钟限制，
  它的结束不会唤醒 worker，只会被 `collectJob` 记成一条 `inject` 提示，下一回合再读。

我们的对应物是 `agent/status → idle` 就结算成 `ended`——**哪怕 worker 刚起了一个后台服务、
或还有 subagent 在跑**。这是「回合结束 ≠ 任务结束」这条语义的缺失。

### 1.5 投递：稳定 id + 读历史去重

`src/app/delivery.ts` 的 `AgentDelivery`：

- `messageId(requestId) = MessageId('dsh-superagent:' + requestId)`——**同一次投递的所有重试共用同一个 id**。
- `holds()` / `send()` 先 `sessionPersistence.open(...).read()` 把**已持久化的历史**扫一遍，
  再看 `inbox.nextTurn`/`nextStep`，确认没投过才投；投完 `flush()` 再向外确认。
- `send()` 接受两个回调：`authorize()`（投递前重新校验业务状态）与 `accepted()`（投递后记账）。
  这解决了「await 期间工单已经结束」的竞态。

我们有 `BOOT + seq` 的唯一 id（`constants.js:162-170`），思路相反：**靠不重复来保证唯一，
而不是靠稳定 id 去重**。`dispatch.js:565` 的 `nextMessageId(task.id,'relay')` 写在
**重试循环内部**，所以「第一次其实已送达但抛错」会变成重复报告。

### 1.6 报告回流的分级

`src/app/notices.ts:104-127` 的 `reportRelay()` 把报告分成三类，不是一条流水：

| 报告 | 去哪 |
|---|---|
| `question`（要人回答） | 立刻 `worker_attention` 中继 |
| `progress` 且不带 `answers` | **只留在工单上，不打扰主会话** |
| 其余（result / blocked / failed / end / 答问） | `worker_report` 中继，摘要超 600 字符截断到 `ticket/<id>/result` |

我们的 `progress` 处理与之一致（`report()` 里 `wake=false`，空闲主会话只记 `recorded`），
这一条是**已经对齐**的。

---

## 二、逐项对照

| # | 能力 | 上游做法（证据） | 本项目现状（证据） | 判定 |
|---|---|---|---|---|
| 1 | 主会话 / 执行会话两个角色 | 两个 preset + 不同工具面（`cordis.patch.yml:20,125`） | 一个默认 preset，工具全局注册（`tools.js:322-328`） | **缺** |
| 2 | 主会话不能写文件 | `tool-fs write:false,edit:false` | 主会话有全套 write/edit/bash | **差异（不建议补，见 §六）** |
| 3 | 主会话不能阻塞等待 | `noWait()` guard 直接拒绝（`sessions.ts:63-86`）+ 提示契约 | 只有 `FORCED_HINT` 措辞（`prompt.js:59-75`） | **部分** |
| 4 | worker 只能拿到工作工具 | `workOnly()` restrict + guard（`sessions.ts:289-297`） | 9 个工具全部可见，靠提示词与 `execute` 校验 | **部分** |
| 5 | 工单结束后工具失效 | guard 返回 `Ticket ended...` | 无；worker 会话可继续被调用 | **缺** |
| 6 | 子会话同样受限 | `limitSubagent()` 继承工作工具 + `standard` | 无感知 | **缺** |
| 7 | 后台活延长占用 | Assignment 级槽位 + 30 分钟上限 | `idle` 即 `ended` | **缺** |
| 8 | 人的追问优先 | `person` 额外槽位（`dsh.ts:192-196`） | 直接置 running，超发不管 | **缺** |
| 9 | 唤醒不饿死 | `launches()` 排除 wake 占用 | pump 统一排队 | **部分** |
| 10 | 投递幂等 | 稳定 `requestId` + 扫历史（`delivery.ts`） | 每次重试新 id（`dispatch.js:565`） | **缺** |
| 11 | 来源可区分 | `source.kind='dsh-superagent'` | 同（`SOURCE_KIND`，`sessions.js:47-56`） | **一致** |
| 12 | 降级投递 | `prompt()` 一层，无降级 | `inject → steer/followup → prompt` 三级 | **本项目更好** |
| 13 | 报告分级回流 | `reportRelay()` 三类 | `progress` 不唤醒，其余回流 | **一致** |
| 14 | 角色模型 | `settings.eval.model` / `executor.model`（`sessions.ts:150`） | `dispatch_launch` 有 `model` 参数，**但 `start()` 没往下传** | **缺陷** |
| 15 | 瞬时失败重试 | 3 次、15s×2ⁿ、只对 408/429/5xx/网络（`dsh.ts:46-47,548-577`） | 无 `agent/error` 订阅，回合挂了就 `ended` | **缺** |
| 16 | 重启恢复 | `resume()`：中断的重开、pending 重排队 | `restore()`：未结算一律 `interrupted` | **部分** |
| 17 | 每任务一个目录 | `executionRoot/<name-id>` + prepare 命令 + 10 分钟超时 | 目标工作区路径，无 prepare | **部分** |
| 18 | 提示词分层 | `compose(config,'orchestrator'|'worker')` + revision + skills | 两个常量 + 动态求值函数 | **部分**（够用） |

---

## 三、值得迭代的六个点

按「收益 / 改动量」排序。每条都给到函数级落点。

### P0-1 · `dispatch_launch` 的 `model` 参数被静默丢弃

**现象**：`tools.js:82` 向模型承诺 `model`（「子会话使用的模型 id」），`dispatch.js:250` 也确实把它
存进 `task.model`，但 `start()`（`dispatch.js:421-425`）只把 `agentPreset` / `permissionPreset` /
`workspaceId` 传给 `createWorker()`，`model` 一路没有下文。

**上游**：`Sessions.ensure()` 在建完会话后调 `initializeRoleModel(ctx, agent, settings.executor.model)`
（`sessions.ts:150`），角色模型是**建会话后单独设**的，与 preset 无关。

**改法**：`SessionGateway.createWorker()` 增加 `model` 选项，建完后用宿主提供的模型选择服务设置
（与我们设 `permissionPresets` 的方式一致，失败只 warn）。拿不到服务时**明确报错**而不是静默忽略，
否则这个参数会一直骗模型。

**验收**：`test/placement.test.js` 旁边加一个用例，断言 `createWorker` 收到 `model` 并调用了一次设置函数；
没有宿主服务时抛「宿主不支持指定模型」。

**状态：已实现。** `sessions.js` 新增 `applyModel()`（`model` 或 `provider/model` → `llm.resolveCallConfig` →
`session.append('model/selection')`），`start()` 把 `task.model` 传进 `createWorker()`；
能力缺失时该次派发失败并回报原因，不静默降级。用例见 `test/router.test.js`。

---

### P0-2 · 报告投递不幂等，重试可能重复

**现象**：`dispatch.js:565` 在重试循环内部生成 id。第一次 `deliver()` 若「已投进收件箱但
`flush` 抛错」，第二次用新 id 会再投一遍，主会话看到两条一样的报告。

**上游**：`AgentDelivery.messageId(requestId)` 恒定 + `holds()` 先扫历史（`delivery.ts:44-78`）。

**改法**：把 message id 提到循环外算一次（`const requestId = nextMessageId(task.id,'relay')`），
`deliver()` 前先问一句「这条 id 是否已经在 `agent.inbox` 或会话历史里」。
宿主没有 `holds` 能力时，退化成「进程内 Set 记录已投 id」——跨重启仍可能重复，但至少同进程内不会。

**验收**：`test/p0-regression.test.js` 加一条：让 `deliver` 第一次抛错、第二次成功，
断言 `deliver` 只被调用两次且**两次 requestId 相同**。

**状态：已实现。** `#deliverWithRetry` 的 `requestId` 提到循环外，重试前用
`SessionGateway.holds()` 查收件箱与历史；`relayRetryMs` 可配（测试用 1ms，默认仍 2s/4s/8s）。
用例见 `test/router.test.js`（含「重试复用同一 id」与「holds 命中就不重投」两条）。

---

### P1-1 · 主会话缺 `noWait` 闸门：提示词管不住手

**现象**：`FORCED_HINT` 第 3 条写「不要自己调用 write / edit / pwsh / bash」（`prompt.js:71`），
但这只是文字。模型完全可以自己在主会话里跑一条 60 秒的命令，把整个派发循环卡住——
这正是上游 `noWait()` 要治的病。

**上游**：`tools.guard()` 在工具执行前拦截，返回 `NO_WAIT` 文案让模型自己改道；
且 router preset 里 `tool-fs` **根本没有 write/edit**。

**改法（两级，先做轻的）**：
1. 给 `Dispatch` 加一个 `guardFor(agent)`：判断 agent 是不是某个任务的 `parentSessionId`，
   是就返回一条 guard 函数，拒绝 `timeoutMs > 30000`、命令行含 `sleep`、`dispatch_wait` 超过某阈值。
2. 在 `index.js` 的 `agent/created` 里按角色挂上（主会话挂 noWait，worker 挂「结束后失效」）。
   注意：我们注册的是**全局工具**，`tools.guard` 的语义需要先确认支不支持按 agent 挂；
   不支持就改成「在 `execute` 里检查 `exec.agent`」，成本更低，效果一样。

**验收**：单测直接调 `dispatch_wait.execute`，断言超时参数被拒；手动验证主会话跑 `sleep 30` 被拦。

---

### P1-2 · worker 的「回合结束」不等于「任务结束」

**现象**：`index.js:50` 在 `agent/status → idle` 时直接 `onWorkerIdle()` → 结算成 `ended`。
worker 起了 dev server、或还有 subagent 在跑时，任务已经被判结束，并发位被让出，
但后台其实还在干活。

**上游**：`running(ticket) = agent.status === 'running' || this.settling.has(ticketId)`
（`dsh.ts:406-409`），后台活通过 `settling` 继续占槽位，30 分钟后才降级。

**改法（最小版）**：`onWorkerIdle()` 里先问宿主 `ctx.get('jobs')` / `ctx.get('subagents')`：
- 两者都没有 → 现在的行为不变（无服务即无后台活）；
- 有在跑的 job/subagent → 不结算，记 `backgroundAt`，起一个**带 TTL 的轮询**
  （默认 30 分钟），活干完或到点再走 `settle('ended')`。
- 任务对象加 `background: {jobs, subagents, since}`，看板显示「后台收尾中」，别让人以为卡住。

**成本**：这是六个点里唯一会碰「结算时机」的，要同步改 `board.js` 的 `elapsedOf()` 与
`docs/architecture.md` §9 的状态说明。建议放最后做。

**验收**：新增 `test/background.test.js`，用假 `jobs` 服务驱动：idle 时有一个 running job
→ 任务保持 `running`；job 结束后 → `ended`；超 TTL → `ended` 且报告里带「仍有 N 个 job 在跑」。

---

### P2-1 · 让 worker 用得上「更短的前台等待」

**现象**：worker 继承 profile 的 `standard`，一条命令前台最多等 60 秒。`dispatch_message` 的
「下一轮就能看到」因此会晚最多一分钟——而人的追问恰恰是最需要快的那一类。

**上游**：worker preset 把 shell 与 job wait 都压到 5 秒（`cordis.patch.yml:47-49,80-84`）。

**改法**：本插件**自己也声明一个 preset**（`dsh.bundle.patch` 里加一行
`@deepseek-ai/dsh-agent-preset`，id 叫 `dsh-mini-superagent-worker`），只覆盖 `shell.timeoutMs`
与 `tool-jobs.waitTimeoutMs`，其余继承。`createWorker()` 默认带上这个 preset，
配置项 `workerPreset` 允许改回 `standard`。

**风险**：preset 里列出的插件 id 属于 DSH 内部包名，跨版本会变；必须做**探测式降级**
（preset 加载失败就退回默认，只 warn）。这条要先确认宿主版本。

**验收**：`dispatch_workspaces` 或 `selfCheck()` 里回显 worker 实际用的 preset；
手动派一个跑 `sleep 8` 的任务，确认 5 秒后转后台而不是干等。

---

### P2-2 · 「投递成功」不等于「worker 读到了」

**现象**：`dispatch.message()`（`dispatch.js:653-679`）先 `deliver()`，成功后用
`transition(force)` 把任务置回 `running` 并刷新 `turnStartedAt`。但 `deliver()` 的语义只是
「进了收件箱」，**没有任何回执说明 worker 把这条消息读进了上下文**。如果 worker 恰好在这一步
被 cancel、或这一步失败回滚，消息留在收件箱里但没人处理，任务却显示 `running`——
并发位被占，报告永远不会来。

**上游**：把这件事拆成两个事实：`inputsDelivered` 与 `inputsRead`
（`engine` 的 `session/event → user/message` 才记 `inputsRead`），
并在 retry / restart 时把「已投递未读」的 Inputs **重新投一遍**
（`003-execution.md` §Retry、§Restart）。

**改法（最小闭环）**：
1. `index.js` 订 `session/event`，只看 `user/message` 且 `source.kind === SOURCE_KIND` 的事件，
   用 message id 反查任务，记 `task.inputReadAt`。
2. `dispatch_inspect` / 看板显示「已投递未读」标记；`cancel` 时若有未读消息，报告里点出来。
3. 重投暂不做（需要先有稳定 id，依赖 P0-2）。

**验收**：`test/nonblocking.test.js` 加一条：投递后未触发 `user/message` 事件时任务带
`delivery=unread`；触发后清掉。

---

## 四、不建议照搬的部分

| 上游能力 | 为什么不搬 |
|---|---|
| 工单模型（Ticket / Assignment / Mandate / Subscription） | 它服务于「一个仓库 + 多人多源」的常驻产品；我们的输入只有「主会话一句话」，搬过来就是给任务表加五张表，收益为零 |
| Engine 事务 + Effect 队列 + Outbox | 我们用 JSON 单文件 + 内存队列已够；上事务/队列要引依赖，违反「无运行时依赖」的硬约束 |
| 源码/渠道抽象（GitHub / Feishu Source） | 与派发正交，属于另一个产品 |
| prepare 命令 + 每工单 git worktree | 有价值，但属于「工作区」能力的下一步；先解决 P0 两个缺陷 |
| prompt revision + 按会话授权读版本 | 只在多操作员、需审计时才有意义；我们连面板都没有版本管理 |

---

## 五、落地顺序

1. **✅ P0-1（model 透传）** + **✅ P0-2（投递幂等）**：纯 bug 级，已修，见 §三 的状态行。
2. **✅ 必派发会话不能改代码**（§六 第 ① 层）：`restrictRouter` + `syncRouter` + `ROUTER_LOCKED`。
3. **✅ 第二批（已落地）**：重启后排队重排、瞬时故障续跑、读回执、progress 节流、`selfCheck` 回显。
4. **✅ 第三批（已落地）**：后台活续占槽位（含 30 分钟上限与终止 job）、subagent 收窄 `dispatch_*`、每任务目录 + prepare 命令。
5. **部分**：worker 5 秒前台（`workerAgentPreset` + 提示），真 preset 等宿主提供派生能力。
6. **不做**：主会话 noWait 闸门、追问 `+1` 硬配额（理由见 §七）。

---

## 附：怎么复核本文

```bash
# 取回上游（若 reference/ 下没有）
git clone --depth 1 https://github.com/deepseek-ai/dsh-superagent-prototype.git reference/dsh-superagent-prototype

# 两个 preset 的差别
sed -n '20,200p' reference/dsh-superagent-prototype/cordis.patch.yml

# 三道闸门与槽位
sed -n '232,312p' reference/dsh-superagent-prototype/src/app/sessions.ts
sed -n '171,206p' reference/dsh-superagent-prototype/src/executor/dsh.ts
```

---

## 六、改与不改的边界（防止误读）

「主会话能不能改文件」由三个不同层次决定。**第 ① 层已经实现（按用户要求）**，
但实现手段与上游不同：上游改 preset，我们只能用 `restrict`——因为主会话是用户自己的会话，插件改不了它的 preset。

| 层 | 上游做法 | 本项目现状 | 结论 |
|---|---|---|---|
| ① 结构性剥夺（模型看不到这个工具） | router preset `tool-fs {write:false, edit:false}`，且无 subagent / web / todo | **已实现**：会话处于「必派发」时在 `agent.ctx` 上 `tools.restrict({ deny: ['write','edit'] })`，切回「不派发」即撤回 | 已对齐（手段与触发点不同） |
| ② 运行时闸门（动作被拒绝） | `tools.guard(noWait)` 拒绝 `sleep`、`timeoutMs > 30s`、长 job 等待 | 无 | P1-1，待做 |
| ③ 提示词（劝，可以被无视） | router 主提示词 | `FORCED_HINT` 第 3 条（仅 `mode=always` 时注入）+ `ROUTER_LOCKED`（已上锁时） | 已对齐 |

**第 ① 层为什么用 `restrict` 而不是 preset**：preset 在建会话时绑定、事后改不了，
而我们的主会话由 DSH 建、插件只是旁观者；`agent.ctx.tools.restrict` 是当前 API 里唯一
能对**已有** agent 收窄工具面的口子。代价是它只对「继承来的」工具生效
（本插件自己的 9 个工具不受影响，因为它们本来就在全局层），且名字未知会抛错——
所以实现里先 `tools.get()` 探一遍，缺哪个跳哪个。

**触发点为什么是「必派发」而不是「派发过」或固定 id**：

- 按 id 硬编码只能覆盖默认主会话（`mas-lead`），用户随手开的会话不受约束；
- 按「派发过」判定则相反——**任何会话都可能是主会话，而且「不派发」是默认选项**，
  派过一次就永久收走 `write`/`edit`，等于用插件的假设覆盖用户的当场意图（初版就是这么写的，已改）；
- 按用户自己选的开关（`modeOf() === 'always'`）判定，语义最干净：选了「必派发」就是「我只做路由」，
  选回「不派发」立刻把工具还回来。

worker 递归派发时跳过。

**可逆性**：`restrictRouter: false` 关闭；disposer 随插件卸载或 `agent/disposed` 收回，
不会留下「重装也无效」的残留。

**边界要诚实**：默认只 deny `write` / `edit`，`bash` 仍可用，`echo > file` 依然能写文件——
上游同样如此（它的 router 留着 shell 是为了 `git status` 这类只读命令）。
要硬边界就把 `routerDenyTools` 配成 `['write','edit','bash','pwsh']`。

**P1-1 会不会顺手把文件也锁了**：不会，而且现在也不需要它来锁文件了。它的判据只有三条，且都只看 shell 工具的参数：

1. `bash`/`pwsh` 的 `command` 里出现命令位的 `sleep`；
2. `bash`/`pwsh` 的 `timeoutMs > 30_000`；
3. `job_output` 的 `wait: true` 且 `timeout_ms > 5_000`。

`write` / `edit` / `read` / `grep` 不在判据里，`timeoutMs ≤ 30s` 的普通命令也不受影响。

**「只能派发」现在是什么状态**：两件事不要混。

- **能不能改文件**：只跟输入框的「派发目标」有关。选了具体工作区或「自动」→ `write`/`edit` 被收窄；
  保持「不派发」（默认）→ 工具一个都不少。切回去立刻解锁。
- **要不要派发**：同一个开关的提示侧——`always` 注入 `FORCED_HINT`（除纯问答外都要派下去），
  `off` 注入 `SOFT_HINT`（只说「可以派」，不要求派）。

所以现在的最短路径是：**不派发 → 什么都能干；必派发 → 能读能跑能派，不能直接写文件**。
想关掉结构性那条、只留提示：`restrictRouter: false`。

---

## 七、可以和上游对齐的清单

状态：**已对齐** = 代码里已经这样；**可对齐** = 有价值但还没做；**不对齐** = 判断为不该做。
每条后面是落点或理由。

### 已对齐

| # | 能力 | 上游 | 本项目 |
|---|---|---|---|
| 1 | 一个任务一个持久 Session | `worker-<ticketId>` | `dispatch-<taskId>` |
| 2 | 报告来源可区分 | `source.kind='dsh-superagent'` | `source.kind='dsh-mini-superagent'` |
| 3 | `progress` 不打扰主会话 | `reportRelay()` 丢弃 routine progress | 同（`relay(... wake=false)`） |
| 4 | 回合无报告时的兜底 | 后台超时后报 `waiting` | `idle` 抓最后一条 assistant 文本报 `ended` |
| 5 | 角色模型 | `initializeRoleModel()` | `applyModel()`（本次） |
| 6 | 主会话不能改代码 | router preset `write:false,edit:false` | `restrict({ deny: ['write','edit'] })`（本次） |
| 7 | 投递幂等 | 稳定 MessageId + 扫持久化历史 | 稳定 requestId + `holds()` 查收件箱/历史（本次，弱一档） |
| 8 | 归档而非删除会话 | `archiveSession(id,{stopActivity})` | 同 |
| 9 | 启动准备幂等 | `Setup` + `sessions.ensure` | `provision()`（失败只 warn） |
| 10 | 工具面按角色收窄 | `restrict` + `workOnly` guard | 仅「必派发」时会话收窄；worker 靠运行时归属校验 |

> 上表只列「结构上已经一致」的十条。本轮另外落地了五条（已完成项），
> 见下一节表格里标 ✅ 的 13 / 14 / 19 / 20 / 21。

### 可对齐（按收益/成本排序）

状态：**✅** = 已实现（含用例）；**部分** = 做了能做的、剩下的有阻塞；空白 = 待做。

| # | 能力 | 上游做法 | 我们的落点 | 成本 | 状态 |
|---|---|---|---|---|---|
| 11 | 主会话不许阻塞等待 | `tools.guard(noWait)`：拒 `sleep` / `timeoutMs>30s` / 长 job 等待 | `index.js` 的 `agent/created` + `tools.guard` | 小 | 撤回（见下） |
| 12 | worker 也有 5 秒前台 | worker preset `shell.timeoutMs=5000` | `workerAgentPreset` 配置 + worker 提示要求后台跑 | 中 | 部分 |
| 13 | 已投递 ≠ 已读 | `inputsRead`（`session/event → user/message`） | `onSessionEvent()` 记 `inputReadAt`，看板显示待读 | 小 | ✅ |
| 14 | 瞬时失败重试 | 3 次、15s×2ⁿ，只对 408/429/5xx/网络 | `onWorkerError()` + `resumeAfterError()` + `isTransient()` | 中 | ✅ |
| 15 | 人的追问优先 | `person` 槽位可用 `max+1` | 现在已是软上限（追问不排队） | 中 | 不做（见下） |
| 16 | 后台活续占槽位 | Assignment 级槽位 + 30 分钟上限 | `handOffToBackground()` + `watchBackground()`（巡检/终止/收尾） | 大 | ✅ |
| 17 | 子会话也受限 | `limitSubagent()` 继承 worker 工具面 | `decorateSubagent()` 沿 parentSession 链收走 `dispatch_*` | 中 | ✅ |
| 18 | 每任务独立目录 + prepare | `executionRoot/<name-id>` + `git worktree` | `src/prepare.js` + `taskDirRoot` / `prepareCommand` | 中 | ✅ |
| 19 | 运行时可观测 | `health` 条目 | `selfCheck()` 回显 router / delivery / retry | 小 | ✅ |
| 20 | 重启后 pending 重排 | `DshExecutor.resume()` | `restore()` 里 `queued` 且无 `startedAt` → 重新入队 | 小 | ✅ |
| 21 | progress 合并 | 同名 notice 覆盖未发送的那条 | `report()` 按 `progressRelayIntervalMs` 节流（仍然入库） | 小 | ✅ |

**11 为什么撤回**：主会话现在被允许自己干活（任何会话都可能是主会话，且默认「不派发」）。
它跑一条三分钟的命令是用户意图，拦下来只会更烦。要做也只能挂在「必派发」模式下，收益有限。

**15 为什么不额外做**：`dispatch_message` 已经不排队（投递后直接置 `running`），
代价是可能短暂超过 `maxWorkers`。再加一个「+1 硬配额」只会在人多时开始拒绝人的追问——
比超发更糟。上游的 `+1` 解决的是「launch 占满槽位导致 wake 排队」，我们没有那个分离。

### 不对齐

| # | 能力 | 为什么不做 |
|---|---|---|
| 20 | 工单模型（Ticket / Assignment / Mandate / Subscription） | 服务于「一个仓库 + 多人多源」的常驻产品；我们的输入只有主会话一句话 |
| 21 | Engine 事务 + Effect 队列 + Outbox | 需要依赖与事务抽象，违反「零运行时依赖、无构建」硬约束 |
| 22 | GitHub / Feishu Source 抽象 | 与派发正交，属于另一个产品 |
| 23 | prompt revision + 按会话授权读 | 只在多操作员与审计场景有意义 |
| 24 | 主动派的 admission / policy 引擎 | 需要「谁允许、什么规则」的完整模型；我们是人工触发 |
| 25 | 55 个测试文件的客户端套件 | 我们的面板只有 3 条注册，成本不成比例 |


