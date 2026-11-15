# 13 · 报告卡：把回流报告从 context 行改成卡片

> 现状：worker 的报告以「插件来源的 user message」投回主会话（`source.kind = dsh-mini-superagent`,
> `form = relay`）。`ui-chat` 把它归到 `context` 节点，渲染成一条「来自会话 …」的上下文行。
> 报告里其实已经有结论、说明、需要你、细节四段，但视觉上和一条注入上下文没区别。
> 本文件定义「报告卡」的需求、文本解析契约、节点注册方式与验收标准；实现落在
> `dsh-mini-superagent/client/index.js` 的会话节点分区。

## 一、结论先行

| 问题 | 结论 |
| --- | --- |
| 能不能做 | 能。注册一个 Conversation 节点定义（`kind: dispatch-report`，`target: chat`），用 `exclusive` 认领这条 `user/message`，再在 `conversation.chat.node` 注册 keyed renderer |
| 要不要动内核 | 不要。只改投影：会话日志里的 `user/message` 原样不动，模型看到的文本一字不变 |
| 接缝性质 | `ctx.uiConversation.events.register()` 有文档（`ui-conversation/README.zh.md` §Conversation 组装），且 `ui-goal` / `ui-plan` / `ui-user-questions` 已用同款写法向 `chat` 目标贡献节点；其中 `ui-user-questions` 的 `user-question-reply` **就是「认领自己的 user/message + exclusive + chat 节点」的第一方先例** |
| 主要风险 | 认领后默认的 context 行与轮次分隔线不再渲染；`location` / `anchorSeq` / `groupTree` 给错会打乱轮次分组与分页锚点 |
| 工作量 | 约 1.5–2 天（含四种文本形态、兜底、状态回查与离线断言） |

这是 **Conversation Node 接缝**：Service Definition 在 `ui-conversation`（事件组装）与
`ui-chat`（节点渲染），Provider 是本插件，Consumer 是 chat 的 flow 渲染器。

## 二、问题

| 症状 | 根因 |
| --- | --- |
| 报告像一条系统注入 | `ui-chat` 的 `messageDefinition` 把 `source.kind !== 'user'` 的 `user/message` 归成 `context` 节点，走 `contextMessage()` 投影 |
| 结论和说明糊在一起 | context 行只有一个折叠体，四段式没有分段渲染 |
| 「需要你」不显眼 | 它只是正文里的一行，没有视觉权重 |
| 与派发卡不成对 | 派发有卡片（plans/12），回来却是一条灰行，形不成「派出去—收回来」的闭环 |
| 看不出是哪条任务 | context 行头是「来自会话 {session}」，不是任务短标签 |

## 三、现状取证

### 3.1 报告是怎么进来的

- 投递：`Sessions.userMessage()` 构造 `{ id, role: 'user', content: [{type:'text', text}], source: { kind: SOURCE_KIND, form: 'relay' } }`（`src/sessions.js:74-83`）。
- id：`${SOURCE_KIND}:${requestId}`（`src/sessions.js:105,115`），`requestId = nextMessageId(task.id, 'relay')` = `${taskId}:relay:${BOOT}:${seq}`（`src/constants.js:835`）。
- 反向解析已存在：`dispatch.js:3363-3364` 从 id 里拆出 `taskId` 与 `kind`。
- 批次汇总把 `group` 当 `task.id` 传给 `relay()`（`src/dispatch.js:1703-1707`），所以批次消息 id 的第一段是 `g-…`。

### 3.2 文本有四种形态

| 形态 | 产出函数 | 首行 | 结构 |
| --- | --- | --- | --- |
| 单任务报告 | `reportText()`（`src/voice.js:288-304`） | `【任务】…` | 任务 / 结果 / 说明? / 需要你? / 细节 |
| 批次汇总 | `batchText()`（`src/voice.js:390-456`） | `【批次】…` | 批次 / 比例行 / `· 成了：`… / `· 没成：`… / `· 未执行：`… / `· 已取消：`… / 需要你? |
| 启动失败 | `failureText()`（`src/voice.js:340-344`） | `<标签>：没能开始——…` | 单行 |
| 跑完没结论 | `idleText()`（`src/voice.js:356-364`） | `<标签>：它跑完了，但没给结论——…` | 首行 / 说明? / 细节 |

段名是稳定常量 `REPORT_SECTIONS`（`src/constants.js:607-614`），`test/voice-contract.test.js` 钉着它们。
长报告会在【说明】里插入「摘要 + 指针」文本（`src/dispatch.js:2375-2398`），解析器必须原样保留。

### 3.3 客户端把它渲染成什么

- `@deepseek-ai/dsh-client-ui-chat/lib/client.js` 的 `messageDefinition`（`kind: 'input-message'`, `target: 'chat'`）：
  - `match` 命中 `event.type === 'user/message'`；
  - `start` 里 `event.data.source.kind !== 'user'` → `contextMessage()`：`{ kind: 'context', content, source, producer, form }`；
  - `buildViewNode` 产出 `kind: 'context'` 的节点。
- `contextProducer()` 的 label 取自 durable source，未知 producer 回落到 source kind（`.../contract/context-producer.d.ts`）。
- relay 形态的正文带一行「来自会话 {session}」（`ui-chat/lib/client.js` 的 `message.context.relay.from`）。
- 本插件已经做了一层补偿：`conversation.chat.user.before` 的 `selectTurnDivider()` 认出 relay 来源，画一条带「派发报告」标签的分隔线（`client/index.js:4019-4093`）。

### 3.4 可用的注册面

- `ctx.uiConversation.events.register(definition)` 与 `views.register(view)` 是唯一注册表，拒绝重复 key、返回幂等 disposer（`ui-conversation/README.zh.md` 第 31、51 行）。
- `match()` 可以返回 `exclusive: true`，在目标上独占一个事件：该目标的其他 Definition 收不到它，也不会走 fallback（README 第 41 行；`contract/conversation.d.ts` 的 `ConversationMatchResult`）。
- `ConversationNodeDefinition` 的 `buildViewNode()` 返回 `{ key, kind, id, target, anchorSeq, location, visibility, data }`（`contract/conversation.d.ts`）。
- 现成范例：`@deepseek-ai/dsh-client-ui-goal/lib/client.js:398-432` 注册 `target: 'chat'` 的 Definition，
  `location: context.start?.location ?? { kind: 'unresolved' }`；`571-586` 同时注册 `conversation.chat.node`。
- **更贴近本需求的先例**：`@deepseek-ai/dsh-client-ui-user-questions/lib/client.js:1358-1400` 的
  `questionReplyDefinition`——`kind: 'user-question-reply'`、`target: 'chat'`、`match` 命中
  `user/message` 且 `source.kind === 'user-question-reply'`、返回 `exclusive: true`。
  源码注释原话：「It claims the reply message on the Chat target, so the generic message Definition
  never presents it.」这正是报告卡要做的动作，只是把 `source.kind` 换成本插件。
- 同一处的 `match` 还要求 `isAppendSurfaceEvent(event)`（即 `event.surfaceOp === 'append'`）；
  本插件没有该 helper，但 `surfaceOp` 是事件上的公开字段，可直接判断。
- `conversation.chat.node` 是 keyed by `ChatNodeKind` 的槽；**没有 occupant 的 kind 不渲染任何行**
  （`ui-chat/lib/types/client/contract/slots.d.ts`）。

## 四、目标与非目标

### 目标

1. 回流报告在 transcript 里是**一张卡**，不是一条上下文行。
2. 四种文本形态都能正确分段落，且信息不丢：结论、说明、需要你、细节、批次分组。
3. 认领范围严格限定「本插件 + relay」，不碰其他插件、不碰人类输入、不碰 steering。
4. 解析失败时兜底成原文卡片，**绝不吞掉内容**。
5. 状态只做「已知事实」的展示：查得到就显示 chip，查不到就不显示，不猜。
6. 纯投影：不改会话事件、不改 `reportText()`、不改投递机制。

### 非目标

- 不改报告文案契约（plans/10）；四段式是模型输入，不是 UI 内部格式。
- 不替代 `dispatch_inspect`：卡里不展开完整账本，只给指针。
- 不做交互式操作（重试/追问/打开子会话）——P2 再议，且要复用看板与工具的错误码。
- 不接管其他 `form`（如未来新增的形态）与其他人插件的 relay。

## 五、场景

| # | 场景 | 期望 |
| --- | --- | --- |
| S1 | 单任务 `done` | 卡头是任务短标签 + 「已完成」；正文是结论 + 说明；需要你段不出现 |
| S2 | 单任务 `failed` | 红点 + 「失败」；结论一行；需要你段高亮 |
| S3 | 批次 4 条，3 成 1 卡 | 卡头「批次 · 3/4」；正文按「成了 / 没成」分组；没成的带原因 |
| S4 | 启动失败 | 卡头「没能开始」；正文是原因；没有任务 id 时也不空 |
| S5 | 长说明（摘要 + 指针） | 说明段折叠到 3 行，展开后含「另有 N 字在账本里」原句 |
| S6 | 未来新增的文本形态 | 走原文兜底卡，内容完整、可选中 |

## 六、功能需求

| 编号 | 需求 | 验收要点 |
| --- | --- | --- |
| FR-1 | 注册 `kind: 'dispatch-report'`、`target: 'chat'` 的 Definition | 只在 `ctx.uiConversation.events` 可用时注册 |
| FR-2 | `match` 只命中 `user/message` 且 `source.kind === 'dsh-mini-superagent'` 且 `form === 'relay'` | 人类输入、其他插件、其他 form 一律返回 `null` |
| FR-3 | `exclusive: true` 认领该事件 | 认领后默认 `context` 行不再出现（用假 registry 断言） |
| FR-4 | `buildViewNode` 产出 `kind: 'dispatch-report'` 的 chat 节点 | `target`/`location`/`anchorSeq`/`visibility` 齐全 |
| FR-5 | 注册 `conversation.chat.node` 的 keyed renderer | key 与节点 kind 完全一致 |
| FR-6 | 文本解析：四种形态 + 未知兜底 | 每种形态一组 fixture；缺段不抛错 |
| FR-7 | 卡片渲染：头部 / 结论 / 说明 / 需要你 / 批次分组 / 细节 | 段落顺序稳定；空段不占位 |
| FR-8 | 状态 chip：按 message id 里的 task/group 反查 `/board` | 查不到不显示；不显示英文状态 |
| FR-9 | 长文本折叠：说明 3 行、批次每组 5 条 | 展开后内容完整；折叠不改变可复制文本 |
| FR-10 | 原文兜底 | 解析失败时渲染 `raw`，样式仍是卡，内容不丢 |
| FR-11 | 与现有分隔线的关系：卡片生效时分隔线不再需要 relay 分支 | 无 `uiConversation` 的宿主仍走分隔线兜底 |
| FR-12 | 卸载即撤销 | `events.register` 的 disposer 随插件卸载执行；不残留 style 节点 |
| FR-13 | 段名漂移防护 | `test/voice-contract.test.js` 断言 `client/index.js` 含全部 `REPORT_SECTIONS` 值 |

## 七、交互规格

### 7.1 单任务报告

```text
┌──────────────────────────────────────────────────────┐
│ ● auth 令牌刷新                            已完成    │
│                                                      │
│ 登录超时修好了，补了 3 个回归测试                     │
│                                                      │
│ 替换了 refresh 调用点 6 处；新增 3 条用例；测试全绿。  │
│                                                      │
│ ┌ 需要你 ──────────────────────────────────────────┐ │
│ │ 定一下：重试、换做法，还是先放着？                │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ dispatch_inspect t-1a9f-1                    复制    │
└──────────────────────────────────────────────────────┘
```

### 7.2 批次汇总

```text
┌──────────────────────────────────────────────────────┐
│ ● 重构这批 4 条                          批次 3/4     │
│                                                      │
│ 4 条成了 3 条，1 条卡住。                             │
│                                                      │
│ ✓ 成了    登录超时、接口重试、日志清理                │
│ ! 没成    补集成测试（连不上压测环境）                │
│                                                      │
│ dispatch_inspect g-7f21                      复制    │
└──────────────────────────────────────────────────────┘
```

### 7.3 异常与兜底

```text
┌──────────────────────────────────────────────────────┐
│ ○ auth 令牌刷新                          没能开始     │
│ 没能开始——模型侧 503。要我重试吗？                    │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ ○ 派发报告                              状态未知     │
│ <原文，等宽、保留换行>                                │
└──────────────────────────────────────────────────────┘
```

### 7.4 段落规则

| 段 | 来源 | 视觉 | 缺省 |
| --- | --- | --- | --- |
| 头部标题 | `【任务】` / `【批次】` | 主字号、加粗、最多 1 行省略 | 「派发报告」（不拿 id 当标题） |
| 状态 chip | `/board` 回查 | 圆点 + 中文；`done/failed/…` 映射到 `TEXT['status.*']` | 不显示 |
| 结论 | `【结果】` 或批次比例行 | 正文主色，最多 3 行 | 不占位 |
| 说明 | `【说明】` | 次要色，默认 3 行 + 「展开」 | 不占位 |
| 需要你 | `【需要你】` | 左侧 2px 状态色条 + 浅底 | 不占位 |
| 批次分组 | `· 成了/没成/未执行/已取消` | 每组一行标签 + 名称列表 | 只渲染存在的组 |
| 细节 | `【细节】` | 等宽小字 + 复制按钮 | 不占位；无 id 时不显示 |
| 兜底 | 全文 | 等宽、`white-space: pre-wrap` | — |

### 7.5 折叠与复制

- 说明超过 3 行（按渲染高度算，不按字符数）才出现「展开」；展开后「收起」。
- 批次每个分组最多显示 5 个名字（文案本身已限 5），更多时显示「等 N 条」。
- 复制按钮复制**原始消息文本**（`raw`），不是渲染后的 DOM 文本；`navigator.clipboard` 不可用时按钮不渲染。
- 卡片正文是真实文本节点，允许用户直接选中复制；不用 canvas / 图片。

### 7.6 可访问性

- 根：`role="article"`，`aria-label="任务 auth 令牌刷新，已完成"`。
- 状态不能只靠圆点颜色：chip 必须有文字。
- 「需要你」用 `role="note"`，不自动聚焦、不 `aria-live`（报告是静态内容）。
- 折叠按钮 `aria-expanded`；`prefers-reduced-motion` 下无动效。

## 八、数据契约

### 8.1 认领条件

```ts
match(event) {
  if (event.type !== 'user/message') return null
  if (event.surfaceOp !== 'append') return null          // 对齐 isAppendSurfaceEvent
  const source = event.data?.source
  if (!source || source.kind !== 'dsh-mini-superagent' || source.form !== 'relay') return null
  return { id: String(event.data.id), role: 'start', exclusive: true }
}
```

- 不认领 `developer/message`、`steering/message`、`system/message`。
- 人类消息的 `source.kind === 'user'`，天然不命中。
- 其他插件用自己的 `source.kind`，即使也叫 `relay` 也不会命中。

### 8.2 文本解析

输入：`raw`（完整正文）、`messageId`。输出：

```ts
type ReportCardData = {
  shape: 'report' | 'batch' | 'failure' | 'idle' | 'unknown'
  taskId?: string          // 从 id 第一段取：t-… 或 g-…
  title: string            // 【任务】/【批次】的值，或首行标签
  result?: string          // 【结果】或批次比例行
  note?: string            // 【说明】
  need?: string            // 【需要你】
  detail?: string          // 【细节】原文
  inspectId?: string       // 从 detail 里 /dispatch_inspect\s+(\S+)/
  groups?: Array<{ kind: 'ok' | 'failed' | 'notRun' | 'cancelled' | 'other'; label: string; text: string }>
  raw: string
}
```

规则：

1. 按 `\n` 切行；段名只认行首精确匹配（`【任务】` 等），不做模糊匹配。
2. `【说明】` 里的「另有 N 字在账本里…」原样保留，不二次裁剪。
3. 批次分组行以 `· ` 开头，冒号前是组名；`成了 / 没成 / 未执行 / 已取消` 映射固定四种，未知组名归入 `other` 并保留原标签与原文（不猜语义）。
4. `failure` 用正则 `^(.+?)：没能开始——(.+?)。要我重试吗？$`；`idle` 用 `^(.+?)：它跑完了，但没给结论——`。
5. 任一必填段缺失 → 该字段 `undefined`；**整卡不得抛错**。
6. 首行不匹配任何已知形态 → `shape: 'unknown'`，`title` 用「派发报告」。

`taskId` 提取：

```ts
// dsh-mini-superagent:t-1a9f-1:relay:boot:7
const [taskId] = id.slice('dsh-mini-superagent:'.length).split(':')
```

非法 id → `undefined`，不显示细节行。

### 8.3 状态回查

| 项 | 规则 |
| --- | --- |
| 端点 | `GET /dsh-mini-superagent/board?task=<id>`，批次用 `?group=<id>` |
| 时机 | 卡片首次挂载时查一次；若返回非终态（`running/queued`），5s 后重查，直到终态或卸载 |
| 缓存 | 模块级 `Map<id, { at, status }>`，TTL 10s；聊天虚拟滚动导致的重挂载不重复请求 |
| 失败 | 静默：不显示 chip；不重试超过 3 次 |
| 优先级 | 先看文本形态（`failure`→失败、`idle`→结束），再被 board 状态覆盖（board 是权威） |
| 禁止 | 不从文案里猜 `done`；不显示英文词；查不到就不显示 chip（不编造第三种状态） |

> `/board` 的 `task` / `group` 参数与 plans/12 §8.2 是同一份契约，由派发卡先落地。

### 8.4 节点构造

```ts
start(_context, match) {
  const event = match.event
  if (event.type !== 'user/message') throw new Error('dispatch-report start requires user/message')
  const blocks = Array.isArray(event.data.content) ? event.data.content : []
  const raw = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return { seq: event.seq, card: parseReportText(raw, String(event.data.id)) }
}

update: (context) => context.state
```

```ts
buildViewNode(context) {
  const state = context.state
  if (!state) return null
  return {
    key: context.key,
    kind: 'dispatch-report',
    id: context.id,
    target: 'chat',
    anchorSeq: state.seq,
    location: context.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    groupTree: undefined,     // 不当作人类输入，不开启 exchange
    data: state.card,
  }
}
```

- `location` 直接取 start match 的位置（`ui-goal` 同款），不要自己从 `matches` 拼。
- `groupTree` 留空：报告不是 input，也不是 exchange；给 `input` 会打乱轮次导航。
- `visibility` 恒为 `visible`；报告的隐藏逻辑（例如压缩检查点）不在本插件范围内。
- renderer 的 props 里用 `props.node.data` 取上面的 `data`（`ui-goal` 的 `GoalCommandInputView({ node })` 同款）。

## 九、实现方案

### 9.1 文件与分区

全部在 `dsh-mini-superagent/client/index.js`：

| 分区 | 内容 |
| --- | --- |
| 常量 | `REPORT_SOURCE_KIND`（复用 `RELAY_SOURCE_KIND`）、`REPORT_NODE_KIND = 'dispatch-report'`、`NOTE_CLAMP_LINES = 3` |
| 纯函数 | `parseReportText(raw, id)`、`statusFromBoard()`、`toCardModel()` |
| 注册 | `installReportCard(ctx)`：`ctx.inject(['uiConversation'])` 内注册 Definition + slot，两处都包 try/catch |
| 视图 | `ReportCard` + `ReportSection` + `ReportGroups` |
| 样式 | 复用派发卡的 style 节点，类名 `dsh-sa-card-report-*` |

### 9.2 注册代码

```ts
function installReportCard(ctx) {
  if (typeof ctx.inject !== 'function') return          // 老宿主/测试桩没有 inject：安静跳过
  // 只在 uiConversation 就绪后跑；缺它时整段不执行，但不影响看板与输入框控件。
  ctx.inject(['uiConversation'], (scope) => {
    const conversation = scope.uiConversation
    if (!conversation?.events?.register) return

    // 关键顺序：**渲染器先就位，再认领消息**。
    // 反过来会出现「消息被 exclusive 认领、但 chat.node 还没有 occupant」的黑洞——
    // 默认 context 行不再渲染，卡片也没人画，整条报告直接消失。
    scope.slots.inject('conversation.chat.node', () => {
      const disposeRenderer = scope.slots.register(
        { name: 'conversation.chat.node', key: REPORT_NODE_KIND }, ReportCard)

      let disposeDefinition
      try {
        disposeDefinition = conversation.events.register({
          kind: REPORT_NODE_KIND,
          target: 'chat',
          match: matchRelayMessage,
          start: startReportState,
          update: (context) => context.state,
          buildViewNode,
        })
      } catch (error) {
        scope.logger?.warn?.('%s 报告节点注册失败: %s', 'dsh-mini-superagent:', String(error))
        if (typeof disposeRenderer === 'function') disposeRenderer()
        return
      }

      return () => {
        if (typeof disposeDefinition === 'function') disposeDefinition()
        if (typeof disposeRenderer === 'function') disposeRenderer()
      }
    })
  })
}
```

- `ctx.inject(deps, cb)` 是 Cordis 的「等依赖就绪再执行」：**不阻塞**本插件的其余注册，
  也不会因为宿主缺 `uiConversation` 就让整个客户端 apply 失败。
- `slots.inject` 的回调返回的是「这一组注册」的清理函数；把 renderer 与 Definition 一起收掉，
  保证卸载顺序是「先撤销认领，再撤渲染器」——反过来又会短暂出现无人渲染的节点。
- 注册失败（HMR 重复、宿主形态不符）只警告一次，并立刻把已注册的 renderer 撤掉，保持配套。

### 9.3 注入变更

| 位置 | 变更 |
| --- | --- |
| `package.json` → `dsh.client.inject` | 增加 `@deepseek-ai/dsh-client-ui-chat`、`@deepseek-ai/dsh-client-ui-conversation`（派发卡另需 `-ui-tool`） |
| `client/index.js` → `inject` | **不变**，仍是 `['slots']`；报告卡用 `ctx.inject(['uiConversation'], …)` 延迟安装 |

为什么不像 `ui-goal` 那样把 `uiConversation` 写进 `inject`：Cordis 的 `inject` 是**启动门槛**，
缺服务时整个插件根本不 `apply`。报告卡只是增强项，不该有权力把看板与输入框控件一起拖下水。
`ctx.inject` 则是「等服务就绪再执行这一段」，既不等错，也不阻塞其余注册。

### 9.4 与现有分隔线的关系

- 卡片生效时：报告不再是 `user` 节点，`conversation.chat.user.before` 不会执行，relay 分支自然失效。
- 卡片未生效（旧宿主 / 注册失败）：保留现有 `selectTurnDivider()` 的 relay 分支，仍然画「派发报告」线。
- **不删除** `DIVIDER_SELECTED_RELAY` 与相关文案；它是降级路径，删了就没有兜底。
- 冒烟脚本里现有的「派发报告分隔线」断言保留，并新增「卡片生效时 Definition 认领该事件」的断言。

### 9.5 样式

- 复用派发卡插入的单个 `<style data-plugin-css="dsh-mini-superagent/cards">`，不新增第二个节点；
  该节点由共享的 `ensureCardStyles()` 安装（两张卡谁先挂载谁装，只装一次）。
- 卡片背景/边框：`--dsw-alias-bg-*` / `--dsw-alias-border-l2`；文字：`--dsw-alias-label-primary/secondary/tertiary`；状态色：`--dsw-alias-state-*`。
- 宽度跟随 chat 内容宽度 `--dsh-chat-content-width`，不写死 680px。
- 圆角 `--dsw-radius-l`，内边距 12/14，段落间距 8。

## 十、边界与降级

| 情况 | 行为 |
| --- | --- |
| 宿主无 `ctx.uiConversation` | 不注册；走现有分隔线 + context 行 |
| `conversation.chat.node` 槽不存在（没组装 chat） | `slots.inject` 不触发 → 连 Definition 都不注册；消息保持 context 行 |
| `events.register` 抛错 | 撤掉已注册的 renderer；警告一次；消息保持 context 行 |
| 文本形态未知 | 原文卡；`shape: 'unknown'`；标题「派发报告」 |
| 报告被截断（digest） | 原样渲染；不试图还原被裁掉的部分 |
| 任务已归档/退休 | `/board` 查不到 → 不显示 chip；正文照常 |
| 同一消息被重放（分页重叠） | 由宿主 key 去重；Definition 的 id 用 message id，天然幂等 |
| 其他插件也发 relay | `source.kind` 不同，不认领 |
| 报告在 compact 模式下落在折叠的过程区 | 与现在的 context 行一致，不额外处理（待真机确认） |
| 用户复制 | 复制 `raw`；卡片 DOM 文本也应可选 |

## 十一、非功能需求

| 维度 | 要求 |
| --- | --- |
| 信息保真 | 任何解析失败都必须能看到原文；不允许「卡片渲染成功但内容丢了」 |
| 性能 | 单卡解析 O(行数)；状态回查每卡最多 1 次 + 非终态 5s 重查；有 10s 缓存 |
| 兼容 | 不改会话事件、不改文案、不改投递；旧消息与新消息同一套解析 |
| i18n | 段名是中文常量，不翻译；UI 文案（批次/展开/复制/状态）进 `TEXT` / `TEXT_EN` |
| 可访问性 | 状态有文字；正文可选中；折叠可键盘 |
| 稳定性 | 任何解析异常都被捕获，卡片退化为原文，不让整条 transcript 崩 |

## 十二、测试与验收

### 12.1 离线冒烟（`scripts/client-smoke.mjs`）

先给 fake ctx 增加 `inject(deps, cb)`（依赖里有 `uiConversation` 时同步调用 `cb(scope)`）与
`uiConversation: { events: { register }, userText: { register } }`，捕获 Definition。

| # | 断言 |
| --- | --- |
| 1 | `events.register` 调用一次，`kind === 'dispatch-report'`、`target === 'chat'` |
| 2 | `match` 命中本插件 relay 消息，返回 `exclusive: true` |
| 3 | `match` 不命中人类消息、其他插件 relay、`developer/message`、`form !== 'relay'`、`surfaceOp !== 'append'` |
| 4 | `buildViewNode` 的 `kind/target/location/anchorSeq/visibility` 正确；`groupTree` 为空 |
| 5 | 四种 fixture 分别渲染出：任务标题 + 结论 + 说明 + 需要你 + 细节 |
| 6 | 批次 fixture 渲染「3/4」与「成了/没成」两组 |
| 7 | 未知 fixture 渲染原文，且包含全部行 |
| 8 | 缺段 fixture 不抛错，空段不占位 |
| 9 | 无 `uiConversation` 时 apply 不抛错，其余槽照常注册 |
| 10 | 注册抛错时不注册 renderer，但看板/输入框控件仍注册 |
| 11 | `?task=` / `?group=` 请求只在有 id 时发出；失败时不显示 chip |
| 12 | 复制按钮复制的是 `raw`（用 fake clipboard 断言） |
| 13 | 样式只含 `--dsw-alias-*`；只有一个 `data-plugin-css` 节点 |
| 14 | `package.json` 的 `dsh.client.inject` 含 `ui-chat` / `ui-conversation`（派发卡另需 `ui-tool`） |

### 12.2 Host 契约测试

- `test/voice-contract.test.js` 增加一条：读取 `client/index.js`，断言包含 `REPORT_SECTIONS` 的**全部**值（任务/结果/说明/需要你/细节/批次）。段名一改，两边同时红。
- `test/board.test.js` 的 `?task=` / `?group=` 用例与 plans/12 共用。

### 12.3 手工视觉清单（真机）

- 浅色/深色主题：卡片底色、边框、需要你色条、状态 chip 对比度；
- 宽屏/窄屏：标题省略、批次分组换行、说明展开；
- 连续三条报告：间距与轮次分组是否自然；
- compact / standard 两种 transcript 视图下，报告卡是否出现在预期位置；
- 复制、选中、键盘展开；
- 升级前写入的旧报告：不报错、能显示。

## 十三、风险与未决

| # | 风险 | 处理 |
| --- | --- | --- |
| R1 | 第一方已有 `ui-user-questions` 认领自己的 `user/message`，但第三方插件走同一路径仍需确认（注册表归属、HMR、目标是否接受外部 Definition） | 先做真机 spike：注册一个最小 Definition，确认 context 行消失、轮次导航正常；不通过就退回方案 B（见下） |
| R2 | `exclusive` 可能影响技能名投影（未知 kind 被当作 boundary） | 报告位于助手输出之后，不在「用户消息 → skill 注入」批次之间；真机确认，必要时把报告节点排在 `turn-tail` 之后 |
| R3 | `groupTree`/`anchorSeq` 给错导致轮次错位 | 严格照 `ui-goal` 的字段；`anchorSeq` 用事件 seq；`groupTree` 留空 |
| R4 | 文案契约漂移（新增段名/新形态） | 12.2 的 grep 断言 + 未知形态兜底 |
| R5 | 报告卡与派发卡状态不一致（一个 2s 轮询、一个一次性） | 共用同一个状态缓存；派发卡刷新时顺手更新报告卡缓存 |
| R6 | 卡片让「复制报告」变难 | 复制按钮复制 `raw`；正文保持可选 |

**方案 B（R1 不通过时的退路）**：不改节点种类，只给 context 行加装饰——在
`conversation.chat.user.before` 里画更完整的卡头（标题/状态），正文仍是默认 context 体。
视觉上做不到图里的圆角卡，但零投影风险。是否接受由 R1 的 spike 结果决定。

| Q | 未决 |
| --- | --- |
| Q1 | 卡头主标题用 `【任务】` 的值，还是「报告 · <任务名>」？暂定前者（短标签已经过 `taskLabel()` 压缩） |
| Q2 | 状态 chip 是否必要？报告文本已经说了成没成，chip 是冗余还是锚点？暂定保留，且只在查得到时显示 |
| Q3 | 批次卡的「细节」显示 group id 还是逐条 `dispatch_inspect`？暂定 group id |
| Q4 | 是否合并连续多条报告（同一任务 progress → done）？暂定不合并，一条消息一张卡 |

## 十四、分期

| 阶段 | 内容 | 出口 |
| --- | --- | --- |
| P0 | Definition + 四种解析 + 卡片渲染 + 原文兜底 + 注册降级 | 四种 fixture 离线全过；真机确认 context 行被替换 |
| P1 | 状态回查 + 缓存 + 折叠 + 复制 + 批次分组样式 | 状态与看板一致；长报告可展开 |
| P2 | 追问/重试/打开子会话入口 | 复用工具与看板的契约，不新开写路径 |

## 十五、取证附录

| 结论 | 证据 |
| --- | --- |
| 报告以插件来源 user message 投递 | `dsh-mini-superagent/src/sessions.js:74-83` |
| 消息 id 编码 taskId 与 kind | `src/constants.js:835`；`src/sessions.js:105,115`；`src/dispatch.js:3363-3364` |
| 批次汇总用 group 作为 task.id | `src/dispatch.js:1703-1707` |
| 四段式与批次文案 | `src/voice.js:288-304,340-344,356-364,390-456`；`src/constants.js:607-614` |
| 摘要 + 指针 | `src/dispatch.js:2375-2398` |
| context 归类逻辑 | `@deepseek-ai/dsh-client-ui-chat/lib/client.js` 的 `messageDefinition` / `contextMessage()` |
| relay 形态带「来自会话」 | `@deepseek-ai/dsh-client-ui-chat/lib/client.js` 的 `message.context.relay.from` |
| 现有分隔线补偿 | `dsh-mini-superagent/client/index.js:4019-4093`；`RELAY_SOURCE_KIND` 在 `:70` |
| Definition 注册表与 exclusive | `@deepseek-ai/dsh-client-ui-conversation/README.zh.md` 第 31/41/51 行；`.../contract/conversation.d.ts` |
| 业务包向 chat 目标注册节点 | `@deepseek-ai/dsh-client-ui-goal/lib/client.js:398-432,571-586` |
| 认领自己的 `user/message` 的第一方先例 | `@deepseek-ai/dsh-client-ui-user-questions/lib/client.js:1358-1400`（`questionReplyDefinition`，`exclusive: true` 与源码注释）；`conversation.chat.node` key `question-reply` 在 `:1929` |
| `surfaceOp` 是公开字段 | `@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts:464`；`isAppendSurfaceEvent` 在 `ui-chat/lib/client.js:9475-9477` |
| keyed chat 节点槽 | `@deepseek-ai/dsh-client-ui-chat/lib/types/client/contract/slots.d.ts` 的 `'conversation.chat.node'` |
| 无 occupant 不渲染 | 同上注释：「a kind with no occupant renders no row」 |
