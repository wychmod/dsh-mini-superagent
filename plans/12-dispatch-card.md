# 12 · 派发卡：把 `dispatch_launch` / `dispatch_launch_many` 的工具行改成批次卡

> 现状：一次批量派发在会话里只留下一行通用工具行——工具名 + 参数摘要 + 展开后的 JSON。
> 派了什么、哪条在跑、哪条卡住，全都要切到侧边栏看板才知道。
> 本文件定义「派发卡」的需求、数据契约、交互规格与验收标准；实现落在
> `dsh-mini-superagent/client/index.js` 的聊天卡片分区。

## 一、结论先行

| 问题 | 结论 |
| --- | --- |
| 能不能做 | 能。`@deepseek-ai/dsh-client-ui-tool` 公开了 keyed slot `tool.call.toolview`，按 wire 工具名分发；注册即替换内置通用行 |
| 要不要动内核 | 不要。不新增会话事件、不改工具返回结构、不改 agent loop；只加一个客户端视图 |
| 状态从哪来 | 工具结果是**派发瞬间**的快照；实时状态必须另外订阅 `GET /dsh-mini-superagent/board`（建议加 `?group=`） |
| 影响面 | `client/index.js` 新增一个视图组件 + 一个共享轮询源；`src/board.js` 加两个只读查询参数；`package.json` 加一个客户端注入包 |
| 工作量 | 约 1–1.5 天（含离线断言与边界处理） |

这是 **Tool View 接缝**：Service Definition 在 `ui-tool`，Provider 是本插件（注册视图），
Consumer 是 `ui-chat` 的工具调用树。

## 二、问题

| 症状 | 根因 |
| --- | --- |
| 派了 4 条，会话里只看见一行 | 没注册 `tool.call.toolview`，走的是 `ui-tool` 的 generic fallback：一行标题 + 参数摘要 |
| 不知道哪条在跑 | 工具返回值只有派发瞬间的 `queued` / `running`；后续状态变化不在调用里 |
| 批次关系断了 | 4 条任务在 transcript 里没有共同容器；`group` 只藏在结果 JSON 里 |
| 要判断得切面板 | 看板是另一块 UI；transcript 与看板之间没有共享的「这一批」视图 |
| 失败要展开 JSON 才看见 | 单项启动失败是 `{ title, error, code }`，被压进参数/结果的原文里 |

## 三、现状取证

### 3.1 工具行现在长什么样

- `@deepseek-ai/dsh-client-ui-tool/README.zh.md`：每次工具调用渲染为卡片树；每个原子调用通过 keyed slot `tool.call.toolview` 分发，**没有注册的工具名使用通用卡片**。
- `.../lib/types/client/contract/slots.d.ts`：`'tool.call.toolview'` 为 `kind: 'keyed'`、`scope: 'session'`、owner 为 `ToolCallOwnerProps`；「Registering an occupied key replaces its view」。
- 本插件 `client/index.js` 目前只注册 4 个槽：`sidebar.panellist`、`main`、`conversation.input.left`、`conversation.chat.user.before`（`client/index.js:8803-8844`），没有任何 `tool.call.toolview`。

### 3.2 数据都在哪

| 数据 | 来源 | 关键字段 |
| --- | --- | --- |
| 这一批要做什么 | 工具入参 `args.tasks[]` | `title`、`brief`、`depends_on`、`depends_on_index` |
| 派发结果 | `dispatch_launch_many` 返回 | `group`、`launched[]`（`task_id`/`title`/`status`/`depends_on` 或 `title`/`error`/`code`）、`note`（`src/tools.js:293-375`） |
| 单条派发结果 | `dispatch_launch` 返回 | `task`（`card()` 投影，含 `task_id`/`title`/`status`）、`depends_on`、`note`（`src/tools.js:220-236`） |
| 实时状态 | `GET /dsh-mini-superagent/board` | `tasks[]` 行含 `task_id`/`title`/`status`/`group`/`depends_on`/`blocked_by`/`blocked_reason`/`error_code`/`elapsed_ms`（`src/board.js:180-262`） |
| 快照上限 | `boardSnapshot()` | 排序后 `slice(0, MAX_TASKS)`，`MAX_TASKS = 200`（`src/board.js:27,366-385`） |

`group` 是这一批的唯一键：`g-${newTaskId()}`（`src/tools.js:294`），同一批所有成员共用。

### 3.3 客户端约束

- 单文件 ModuleLoader：`window.__ModuleLoader__.load({ factory(require) })`，无构建、无 CDN、零运行时依赖（`client/index.js:1-30`）。
- React 从 `require('react')` 取；`createPortal` 从 `require('react-dom')` 取，取不到要降级。
- 现有状态外观表 `STATUS_META` 已经定义 8 个状态的色值（`client/index.js:1202-1212`），全部走 `--dsw-alias-*` 令牌。
- 现有轮询：面板可见时 `POLL_MS = 2000`，隐藏即停（`client/index.js` 的 `POLL_MS` / 可见性处理）。

## 四、目标与非目标

### 目标

1. 一次派发在 transcript 里是**一张卡**，行数与任务数一致、顺序与入参一致。
2. 每行能看出「哪条、什么状态、为什么没动」，不需要切看板。
3. 状态在卡里活着：派发后按 2 秒级刷新，全部结算后降频。
4. `dispatch_launch` 与 `dispatch_launch_many` 共用同一组件，只是行数不同。
5. 不破坏 transcript 的密度：默认最多 4 行，超出折叠。
6. 纯客户端投影：零新依赖、零构建、不新增会话事件。

### 非目标

- 不做看板的替代品：筛选、历史、分析、归档仍在面板。
- 不在卡里执行写操作（取消 / 重试 / 归档）；P2 再议，且必须复用看板的准入头与错误码。
- 不展示 `brief` 与报告正文；正文属于报告卡（plans/13）与 `dispatch_inspect`。
- 不改工具返回结构（`/board` 只加可选查询参数，默认行为不变）。

## 五、场景

| # | 场景 | 卡片的期望 |
| --- | --- | --- |
| S1 | 一次派 4 条独立任务 | 4 行全展示；先 `running` 后逐条 `done` |
| S2 | 一次派 13 条 | 默认 4 行 + 「还有 9 条」；展开后完整列表可滚动 |
| S3 | 批内 `depends_on_index` | 被挡的行显示「等 t-…」而不是「排队中」 |
| S4 | 第 2 项启动失败 | 该行显示「没能开始 + 原因」，其余行照常 |
| S5 | 卡片滚出视口 / 标签页隐藏 | 暂停轮询；回到可见时立即补一次 |

## 六、功能需求

| 编号 | 需求 | 验收要点 |
| --- | --- | --- |
| FR-1 | 注册 `tool.call.toolview`，key 为 `dispatch_launch` 与 `dispatch_launch_many`，指向同一组件 | 两个 key 各注册一次；组件 props 兼容两种返回 |
| FR-2 | 三阶段渲染：`preparing` 骨架、`start` 出标题与行、`result` 出 `group` 与初始状态 | `preparing` 不发网络请求；`start` 时 `args` 可能不完整，不得抛错 |
| FR-3 | 行模型：顺序、标题、状态、依赖、错误 | 顺序严格等于 `launched[]` 下标；启动失败项占位不塌陷 |
| FR-4 | 实时状态：按 `group` 拉 `/board`，合并到行 | 状态变化 2 秒内可见；请求失败保留上次状态 |
| FR-5 | 折叠：> 4 行时默认 4 行 + 「还有 N 条」 | 展开/收起不丢状态；折叠状态不跨轮次记忆 |
| FR-6 | 头部聚合：`已完成/总数` | 只在 `result` 后显示；无 `group` 时不显示批次信息 |
| FR-7 | 依赖与失败：被挡显示前置短 id 与 `blocked_reason`；失败显示 `error_code`（有摘要再附一行） | 不把 `blocked` 误显示成 `queued`；不编造看板没有的错误文本 |
| FR-8 | 未知/缺失：`group` 缺失、行数 0、任务已退休 | 退化成单条/空态，不白屏 |
| FR-9 | 文案：状态词复用客户端 `TEXT['status.*']` | 不新增第二套状态词；不出现英文 `done/failed` |
| FR-10 | 主题：颜色全部走 `--dsw-alias-*`，明暗自动 | 样式里不出现写死的主色；fallback 只作兜底 |
| FR-11 | 可访问性：列表语义 + 文字状态 + 尊重 reduced-motion | 屏幕阅读器能读出「第 2 条，运行中」；动效可关 |
| FR-12 | 卸载清理：定时器、监听器、in-flight 请求 | 组件卸载后不再发请求；插件卸载后无残留 style 节点 |

## 七、交互规格

### 7.1 三阶段

```text
preparing（参数未到）
┌──────────────────────────────────────────────┐
│ ○ 正在准备派发…                              │
└──────────────────────────────────────────────┘

start（参数到齐，结果未回）
┌──────────────────────────────────────────────┐
│ ● 派发 4 个任务                    group —   │
├──────────────────────────────────────────────┤
│ t-m0abc-1  拆分 auth/types.js          待定  │
│ t-m0abc-2  拆分 auth/index.js          待定  │
└──────────────────────────────────────────────┘

result / 运行中
┌──────────────────────────────────────────────┐
│ ● 派发 4 个任务          2/4   group g-m0abc │
├──────────────────────────────────────────────┤
│ t-m0abc-1  拆分 auth/types.js          运行中 │
│ t-m0abc-2  拆分 auth/index.js          排队中 │
│ t-m0abc-3  补 auth 回归测试            排队中 │
│ t-m0abc-4  更新调用点                  排队中 │
└──────────────────────────────────────────────┘
```

### 7.2 行的状态矩阵

| `status` | 圆点 token | 文案 | 行尾附加 |
| --- | --- | --- | --- |
| `queued` | `--dsw-alias-label-tertiary` | 排队中 | 有 `blocked_by` 时显示「等 t-…」 |
| `running` | `--dsw-alias-state-business-primary` | 运行中 | 可选耗时 `m:ss` |
| `done` | `--dsw-alias-state-success-primary` | 已完成 | 耗时 |
| `blocked` | `--dsw-alias-state-warn-primary` | 已阻塞 | 一行 `blocked_reason`（截 100 字） |
| `failed` | `--dsw-alias-state-error-primary` | 失败 | `error_code`；有 `last_report.summary` 时附一行摘要 |
| `interrupted` | `--dsw-alias-state-warn-primary` | 已中断 | — |
| `cancelled` | `--dsw-alias-label-tertiary` | 已取消 | 区分「人取消 / 前置未执行」 |
| `ended` | `--dsw-alias-label-secondary` | 已结束 | — |
| 启动失败（无 id） | 红点 | 没能开始 | `code`，行不可点 |

**状态词只有一套**：客户端 `TEXT['status.*']`（`client/index.js:84-91`）。报告正文里的
`STATUS_VOICE`（`src/constants.js:585-598`）只服务模型转述，不进入 UI，避免同一个状态出现两种中文。

### 7.3 折叠

- 阈值 `CARD_VISIBLE_ROWS = 4`（与设计稿一致）。
- 超过时末尾一行是按钮：「展开全部 13 条」；展开后「收起」。
- 展开状态属于组件实例，不写入 store；轮次收起（宿主 `useDisclosure` 重置）时一并重置。
- 折叠不影响轮询：管的是渲染，不是数据。

### 7.4 头部

- 左：聚合圆点 + 标题。
  - `dispatch_launch`：任务标题（`task.title`）。
  - `dispatch_launch_many`：「派发 N 个任务」。
- 右：`已完成/总数`，然后 `group` 短标签（mono，`title` 属性给全 id）。
- `group` 只在 `result` 后出现；`start` 阶段显示 `—`，不要凭空编。

### 7.5 键盘与可访问性

- 卡片根：`role="group"`，`aria-label="派发 4 个任务，2 条已完成"`。
- 行容器：`role="list"`；每行 `role="listitem"`，状态文字必须在 DOM 里（不能只靠颜色）。
- 展开按钮是真 `<button>`，`aria-expanded` 同步。
- 运行中的呼吸/扫光动画：`@media (prefers-reduced-motion: reduce)` 下关闭。

## 八、数据契约

### 8.1 视图收到的 props

来自 `ToolCallOwnerProps`（`@deepseek-ai/dsh-client-ui-tool/lib/types/client/contract/slots.d.ts`）：

```ts
type Props = {
  phase: 'preparing' | 'start' | 'result'
  callId: string
  toolName: 'dispatch_launch' | 'dispatch_launch_many'
  cwd?: string
  home?: string
  openFile: (path: string, options?: { line?: number }) => void
  inspect?: () => void
  useDisclosure: () => { expanded: boolean; setExpanded(open: boolean): void; toggle(): void }
} & (
  | { phase: 'preparing'; block: { name: string; args: ToolArgs } }
  | { phase: 'start'; block: { argsRaw: string; args: ToolArgs } }
  | { phase: 'result'; block: { argsRaw: string; args: ToolArgs; content: ContentBlock[]; isError: boolean; error?: { name: string; code: string; reason?: string } } }
)
```

约束：

- `args` 是**懒读器**，只在渲染/构造视图时读；不要把它快照进只按对象身份缓存的状态。
- `result` 的 `content` 是内容块数组；本插件的工具返回对象会被序列化成 JSON 文本，取第一个 `type === 'text'` 的块解析。
- 解析失败不得抛错：退化为「已派发，状态未知」，并在 footer 提示。

### 8.2 `/board` 新增查询参数（host 侧）

```http
GET /dsh-mini-superagent/board?group=g-m0abc
GET /dsh-mini-superagent/board?task=t-m0abc-1
```

| 项 | 规则 |
| --- | --- |
| 参数 | `group` 与 `task` 都可选，可同时给（取交集）；空串等价于未给 |
| 校验 | trim 后截断到 64 字符；不做正则拒绝，匹配不到就是空列表 |
| 过滤时机 | 在 `slice(0, MAX_TASKS)` **之前**过滤，避免成员被 200 条截断吃掉 |
| 返回 | 形状不变：`{ version, generatedAt, concurrency, archive_after_hours, counts, tasks, truncated }` |
| `counts` | 仍是**全局**计数（卡片不用它；改成局部会让面板与卡片对不上） |
| 兼容 | 不带参数时与现在逐字节一致；`/archive` 内部调用 `boardSnapshot()` 不受影响 |

测试要钉住：过滤前截断、交集、未知 group 返回空数组、默认请求不变。

### 8.3 行模型合并

```ts
type Row = {
  key: string            // task_id，或 `failed-${i}`
  id?: string            // 启动失败没有 id
  title: string
  status: string         // 来自 board，缺失时用 launched.status
  dependsOn: string[]
  blockedBy?: string
  blockedReason?: string
  errorCode?: string
  summary?: string        // last_report.summary，失败时作一行原因
  error?: { code?: string; message: string }   // 仅启动失败（来自 launched[].error）
  elapsedMs?: number
  live: boolean          // 是否拿到了 board 行
}
```

合并顺序（后者覆盖前者）：

1. `args.tasks[]` —— 只提供标题与顺序（`preparing` 阶段可能为空）。
2. `launched[]` —— 按下标对齐，提供 `task_id` / 初始 `status` / `depends_on` / 启动错误。
3. `board.tasks[]` —— 按 `task_id` 覆盖 `status` / `blocked_by` / `blocked_reason` / `error_code` / `elapsed_ms`。

> 看板行**没有**自由文本的 `error`（只有 `error_code` 与 `last_report.summary`）；
> 卡片的「失败原因」只能用这两个字段拼，不要假装能拿到完整错误。

`launched.length` 与 `args.tasks.length` 不一致时以 `launched` 为准，并保留多出来的 args 行标为「未派发」（防御脏数据，不常见）。

### 8.4 轮询策略

| 项 | 规则 |
| --- | --- |
| 触发 | `phase === 'result'` 且拿到 `group`（或单条 `task_id`）后启动 |
| 频率 | 有非终态成员：2s；全部终态：15s；页面隐藏：暂停 |
| 恢复 | `visibilitychange` 变可见时立即拉一次，不等下一个 tick |
| 失败 | 保留上次数据；连续失败 3 次后 footer 显示「状态可能已过期」；退避 2s→4s→8s→30s |
| 去重 | 同一 `group` 多个卡片共享一个订阅（模块级 `Map<group, entry>`，refcount） |
| 终止 | 卡片卸载即退订；refcount 归零停表 |

不用 `/board` 全量快照做卡片数据源：200 条截断会让「已结算成员」被挤掉，卡片就会永远停在 `running`。

## 九、实现方案

### 9.1 文件与分区

全部在 `dsh-mini-superagent/client/index.js`（无构建，不能拆文件）：

| 分区 | 内容 | 建议位置 |
| --- | --- | --- |
| 常量 | `CARD_VISIBLE_ROWS`、`CARD_POLL_MS`、`CARD_SETTLED_POLL_MS`、`CARD_FEATURES` | 顶部常量区 |
| 纯函数 | `mergeBatchRows()`、`aggregateBatch()`、`statusMetaOf()` | 状态外观区之后 |
| 数据源 | `createGroupFeed()` | 看板轮询逻辑旁边 |
| 视图 | `DispatchBatchRow` + 子组件 `BatchRowItem` | 聊天卡片分区（新增） |
| 样式 | `CARD_STYLE` | 与组件同区 |

### 9.2 组件树

```text
DispatchBatchRow
├─ BatchHeader        聚合点 + 标题 + 2/4 + group
├─ BatchList          role=list
│  ├─ BatchRowItem    圆点 + 短 id + 标题 + 状态 chip + 附加行
│  └─ BatchMore       展开/收起
└─ BatchFooter        可选：状态过期提示 / Inspect
```

`BatchRowItem` 的附加行（依赖、失败原因）默认一行省略，`title` 属性给全文；不引入 tooltip 组件。

### 9.3 注册

```ts
const CARD_TOOLS = ['dispatch_launch', 'dispatch_launch_many']
for (const key of CARD_TOOLS) {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key }, DispatchBatchRow))
}
```

注册是可逆副作用：插件卸载即撤销，不写手动清理。`dispatch_launch` 与批量共用组件，
单条时 `group` 为空、行数为 1。

### 9.4 样式

- 类名前缀 `dsh-sa-card-`，与面板的 `dsh-sa-` 同族但不重叠。
- 样式表只插一次：`document.head` 下 `<style data-plugin-css="dsh-mini-superagent/cards">`，
  由共享的 `ensureCardStyles()` 安装（报告卡 plans/13 复用同一节点），`ctx.effect` 的 disposer 在插件卸载时移除。
  对齐 `ui-goal` 的 `data-plugin-css` 做法，但多一步卸载清理。
- 颜色只用 `var(--dsw-alias-*)`；圆角/字号跟随 `--dsh-content-font-size` 与 `--dsw-radius-*`。
- 这是对「CSS 随面板 `<style>` 卸载」约定的**有意放宽**：聊天卡片不在面板子树里，
  每张卡各带一份 `<style>` 会重复 N 份。放宽的前提是：只有一个 style 节点、有固定
  `data-plugin-css`、卸载时移除。

### 9.5 与现有代码的接触面

| 文件 | 改动 |
| --- | --- |
| `client/index.js` | 新增视图、feed、样式；`apply()` 增加注册；`inject` 不变（仍只需 `slots`） |
| `package.json` | `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-tool` |
| `src/board.js` | `/board` 读取 `group` / `task` 并在截断前过滤 |
| `test/board.test.js` | 新增过滤用例 |
| `scripts/client-smoke.mjs` | 新增卡片渲染与轮询断言 |
| `docs/board.md` | 路由参数表补两行 |
| `README.md` | 能力表补一行「派发卡」 |

## 十、边界与降级

| 情况 | 行为 |
| --- | --- |
| 宿主没有 `tool.call.toolview`（旧版本） | `ctx.slots.inject` 不触发，保持通用行；不报错、不警告刷屏 |
| `block.content` 不是 JSON | 头部仍显示「派发 N 个任务」，行只有标题，状态「未知」 |
| `/board` 403 / 404 / 网络失败 | 用 `launched.status` 的初始值；footer 提示「状态可能已过期」 |
| 宿主忽略 `group` 参数（版本错配） | 返回全量快照，前端按 `group` 过滤；若 `truncated` 且成员不全，**停止轮询**并标「状态为派发时快照」 |
| 任务被归档 / 退休 | board 行缺失，保持最后一次已知状态；不把行删掉 |
| `group` 超过 16 条 | 折叠；不假设上限，按数组长度渲染 |
| 同一 `group` 出现两张卡（重放/分页重复） | 各自渲染，共享一个 feed；不合并 DOM |
| headless 宿主 | 没有 web server 就没有客户端，本需求不适用 |

## 十一、非功能需求

| 维度 | 要求 |
| --- | --- |
| 性能 | 单卡渲染 O(n≤16)；一个 group 一个定时器；页面隐藏不请求 |
| 内存 | 卸载退订；feed 的 Map 在 refcount=0 时删除条目 |
| 网络 | 2s 轮询只拉 `?group=` 的单组数据；失败退避，不无限重试 |
| 兼容 | 不改变 `/board` 默认响应；不改变工具返回；不新增会话事件 |
| i18n | 新增文案进 `TEXT` / `TEXT_EN`；缺 locale 时回落中文 |
| 可访问性 | 状态有文字；展开按钮可键盘操作；reduced-motion 关闭动画 |

## 十二、测试与验收

### 12.1 离线冒烟（`scripts/client-smoke.mjs`）

| # | 断言 |
| --- | --- |
| 1 | `tool.call.toolview` 注册两次，key 分别是 `dispatch_launch` / `dispatch_launch_many` |
| 2 | `preparing` 渲染骨架，且 `fetch` 调用次数为 0 |
| 3 | `start` 用 `args.tasks` 出行，状态为「待定」，不发请求 |
| 4 | `result` 后渲染 `group` 与 `2/4` 聚合 |
| 5 | 16 条默认只渲染 4 行 + 「还有 12 条」 |
| 6 | 点击展开后 16 行全在，`aria-expanded=true` |
| 7 | 启动失败项显示 code 与原因，且占位不塌陷 |
| 8 | `blocked_by` 行显示「等 t-…」而不是「排队中」 |
| 9 | 轮询 URL 带 `?group=`，且同一 group 的两个实例只发一次请求 |
| 10 | 卸载后定时器清空、不再发请求 |
| 11 | 页面隐藏时暂停、恢复可见立即拉一次 |
| 12 | 请求失败保留上次状态；连续 3 次后出现「状态可能已过期」 |
| 13 | 样式只包含 `--dsw-alias-*`（不出现 `#3b82f6` 之类的写死主色） |
| 14 | `package.json` 的 `dsh.client.inject` 含 `@deepseek-ai/dsh-client-ui-tool` |

### 12.2 Host 单测（`test/board.test.js`）

- `?group=` 只返回该组成员，且在 200 条截断前过滤；
- `?task=` 只返回一条；两者同时给取交集；
- 不带参数与旧响应逐字段一致；
- 未知 group 返回 `tasks: []`、`truncated: null`。

### 12.3 手工视觉清单（真机）

- 浅色 / 深色主题下圆点、chip、边框对比度；
- 窄屏（≤480px）下标题与 chip 不重叠；
- 16 条展开后的滚动高度；
- 运行中动画在 `prefers-reduced-motion` 下静止；
- 与相邻工具卡、assistant 文本的间距。

## 十三、风险与未决

| # | 风险 | 处理 |
| --- | --- | --- |
| R1 | `tool.call.toolview` 的 owner props 在 rc 版本间可能变化 | 只读 `phase` / `argsRaw` / `content` / `error` 这几个稳定字段；缺字段一律降级，不抛错 |
| R2 | 每张卡 2s 轮询放大请求 | 同 group 共享；终态降频到 15s；隐藏暂停 |
| R3 | `/board` 参数扩张被当成通用查询接口 | 只支持两个精确匹配参数，不提供排序/分页；文档写清「卡片专用，非通用 API」 |
| R4 | 16 条卡片撑高 transcript | 默认 4 行 + 展开；不提供「始终展开」配置 |
| Q1 | 默认折叠阈值 4 还是 6 | 暂定 4（与设计稿一致），真机目视后定 |
| Q2 | 行首是否显示短 id | 暂定显示（技术卡，便于对 `dispatch_inspect`），字号小一号、颜色 tertiary |
| Q3 | 点击行是否跳子会话 | P1；复用看板的 `uiWorkspace.openSession`，归档/退休行不可点 |
| Q4 | 取消/重试是否进卡 | P2；写操作需要 `x-dsh-mini-superagent` 头与错误码，先把只读做稳 |

## 十四、分期

| 阶段 | 内容 | 出口 |
| --- | --- | --- |
| P0 | 视图 + 三阶段 + 行模型 + 折叠 + `/board?group=` + 冒烟断言 | 4 条/16 条两种批次在离线渲染里正确 |
| P1 | 实时轮询 + 失败退避 + blocked 语义 + 行点击跳子会话 | 状态 2s 内变化；断网不崩 |
| P2 | 取消/重试/归档入口、耗时列、批次内依赖连线 | 与看板同一套写操作契约 |

## 十五、取证附录

| 结论 | 证据 |
| --- | --- |
| 工具视图按 wire 名分发、注册即替换 | `@deepseek-ai/dsh-client-ui-tool/README.zh.md`「注册业务工具视图」；`.../contract/slots.d.ts` 的 `'tool.call.toolview'` |
| 通用行是 fallback | 同上：「没有注册的工具名称使用通用卡片」 |
| 本插件未注册工具视图 | `dsh-mini-superagent/client/index.js:8803-8844` 只有 4 个槽 |
| 批量返回含 `group` 与逐项结果 | `dsh-mini-superagent/src/tools.js:293-375` |
| 单条返回是 `card()` 投影 | `dsh-mini-superagent/src/tools.js:220-236`；`src/dispatch.js:3427-3530` |
| 看板行含 `group` / `elapsed_ms` / `blocked_by` / `blocked_reason` / `error_code` | `dsh-mini-superagent/src/board.js:180-262` |
| 快照 200 条截断 | `dsh-mini-superagent/src/board.js:27,366-385` |
| 状态词与令牌 | `dsh-mini-superagent/client/index.js:84-91,1202-1212` |
| 单文件无构建客户端 | `dsh-mini-superagent/client/index.js:1-30`；`package.json` 的 `dsh.client` |
| 业务包注册聊天/工具视图的注入清单 | `@deepseek-ai/dsh-client-ui-goal/package.json` 的 `dsh.client.inject`；`.../lib/client.js:558-565,571-586` |
