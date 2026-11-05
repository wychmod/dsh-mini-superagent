# 01 · 输入框工作区选择器与 @ 选择（可行性调研）

## 结论先行

| # | 问题 | 结论 | 一句话依据 |
|---|---|---|---|
| 1 | composer 里加一个「选工作区」控件 | **可行** | `conversation.input.left`/`right` 是空置的 list 槽，会话作用域，随控件带 `useWorkspaces` 等标准 hook |
| 2 | 像选模型那样开下拉 | **可行** | 抄 `ModelSelect`：overlay 槽 + `createPortal(document.body)` + fixed 定位 + 外部 mousedown 关闭 |
| 3 | 注册自己的 `@` 触发源（@工作区） | **可行** | `ctx.inputTriggers.registerSource({trigger:'@', name:'workspace', …})`，与官方 `@reference` 并存、按 source 分组 |
| 4 | 把「@某工作区」渲染成草稿里的 chip | **有条件可行** | chip 节点的 `appearance` 被 zod 闭集锁死为 `session/file/folder`；用 `appearance: undefined` 或 `"session"` 可以，自定义图标不行 |
| 5 | 纯文本 `@名字` 自动变成 chip 装饰 | **对中文不可行** | 装饰扫描正则 `[\w-]+`，JS 的 `\w` 不含中文 → `@工作区名` 永远扫不出来 |
| 6 | 选中值传给模型 / 工具 | **可行，且是唯一官方钩子** | `codec.serialize(ref)` 在 `sinkSerialized()` 里替换 chip 占位文本；序列化失败会阻断发送而不是静默降级 |
| 7 | 提交前改写消息内容（composer chain） | **不可行（不是这个用途）** | `conversation.composer` 是 chain 槽：整体接管输入框 UI，没有「改写文本」的钩子 |
| 8 | 在「当前会话」里切换工作区 | **不可行** | 全网关无 session→workspace 迁移 API；工作区只能在 `connectWorkspace/startSession` 时定 |
| 9 | 是否需要构建步骤 | **不需要** | 现成写法就是 `window.__ModuleLoader__` + `require('react')` + `React.createElement`，样式内联或注入 `<style>` |

**一句话：技术上「输入框里 @ 工作区 + 下拉选」全部能做出一版可用的东西；但产品语义要改——工作区是「这次派发到哪」，不是「这个会话属于哪」，因为会话的工作区不可变。**

---

## 0. 证据基础与限制

- 下文路径统一缩写，`<DSH>` = `…\resources\app.asar\dsh`，`R/C/M/T/F/W/S` = `<DSH>\node_modules\@deepseek-ai\dsh-{cordis-client-runner,client-ui-conversation,client-ui-model-selection,client-ui-input-trigger,client-ui-reference,client-ui-workspace,api-session-controller}\lib\client.js`。
- 我把 asar 头解析后把 `@deepseek-ai/*/lib` + `locale` 解到临时目录再全文检索，所以下面的行号是 asar 内原始文件的真实行号。
- **客户端 inspect 通道不可用**：`cordis_inspect_query(platform="client", provider="Slots", method="listSubTree")` 连续 3 次 10s 超时（返回"Open or reconnect the Harness page"）。因此没有运行时槽目录，改用 **`R` 里内置的槽目录**——它就是 Slots inspect provider 的数据源（同一份 `registration(...)` 表），字段（`kind/scope/ownerProps/standardProps/occupants/replaceRisk/keyDomain/source`）与 inspect 输出同构。
- **未在真机跑过任何 UI**。本文全部是静态代码证据 + 一次 asar 解包；凡属推断的地方都标了「推断」。

---

## 1. composer 里有哪些槽

槽目录：`R:3260-3726`（`conversation.input.*` 全量），实际渲染位置在 `C:19235-19286`。

| 槽 | kind / scope | 渲染位置（代码事实） | 占用 | 我们能用吗 |
|---|---|---|---|---|
| `conversation.input.left` | list / session | 工具行左侧 `.tools` 组，跟在「+」按钮和 permission/plan 之后（`C:19266-19270`） | **空** | ✅ 主选 |
| `conversation.input.right` | list / session | `.standardControls` 里、模型选择器**之前**（`C:19276-19278`） | **空** | ✅ 备选 |
| `conversation.input.model` | single / session | 工具行右侧，`.standardControls` 最后一个（`C:19278`） | `ModelSelect` | ❌ 注册即替换官方控件（`replaceRisk: shadows-shipped-ui`，`R:3491`） |
| `conversation.input.activity` | single / session | 提交按钮前，可横向展开占满工具行（`C:19280-19286`） | 语音输入 | ❌ single，且展开语义冲突 |
| `conversation.input.overlay` | list / session | 输入卡片内浮动层，锚点是卡片顶部的 0 高容器（`C:19198`，`.GRgSLq_overlayAnchor{height:0;position:absolute;inset:0 0 auto}`） | `/` 菜单、命令弹窗、反馈弹窗 | ✅ 下拉菜单放这里 |
| `conversation.input.dock` | list / session | 输入卡片**上方**整宽区（`C:17907`） | 队列/Todo/Goal | ⚠️ 只能做横幅，不能做下拉 |
| `conversation.hero.workspace` | single / root | 空白会话（hero）的工作区选择器 | 官方 `WorkspacePicker` | ❌ 替换官方（`R:3226`） |

**props 清单**（所有槽共享的 standardProps，`R:3428-3447` 等）：`useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>`、`useSessions`、`useSessionStatus`、`useInput: SnapshotSelectorHook<InputState>`、`inputActions`、`sessionId`、`useConversation`、`useRemoteAccess`、`useWorkspaceAccess`、`useAccess` 等。
→ **关键收益：工作区列表不用走 Remote，也不用我们自己的 Host 路由，`useWorkspaces((s) => s.items)` 直接拿到 `[{workspaceId, title, path}]`**（`W:2571-2572, 2593-2597`）。

**尺寸/布局约束**（CSS 事实）：
- 工具行 `.GRgSLq_row{flex-wrap:wrap; gap:12px; padding:2px 8px 6px; container-type:inline-size}`；`+` 按钮 `28×28`（`.GRgSLq_add`）。模型触发器 `height:28px; max-width:min(360px,45cqw)`（`M:1060` 的 CSS 串）。→ 我们的控件应与 28px 同高、宽度自适应、**不要 flex:1**。
- `.trailing{flex:none; margin-left:auto}`、`.standardControls{display:flex;gap:12px;min-width:0}`：右侧是紧凑不换行区。
- **activity 展开时 `.tools` 与 `.standardControls` 都被 `hidden`**（`C:19240`、`C:19277`）→ 语音输入展开时我们的控件会消失。可接受，但要写进交互说明。
- 只有存在活跃输入 shell 时才渲染（`C:19270`：`input === undefined || sessionId === undefined ? null`），**空白会话看不到**。

---

## 2. 照抄对象：`ModelSelect`（`@deepseek-ai/dsh-client-ui-model-selection`）

注册（`M:1900-1924`）：

```
scope.slots.inject("conversation.input.model", () => scope.slots.register({
  name: "conversation.input.model",
  locale: NS,                                  // 自动注入 t()
  children: { "conversation.input.model.label": { kind: "single", scope: "session", inline: true } },
  inject: (sessionId) => ({ available, directory, load, select }),   // 每会话的 owner 数据
}, ModelSelect))
```

组件收到的 props：`{ locked, available, directory, load, select, t, renderSlot }`（`M:1152`）。可抄的四件事：

1. **数据**：`useSyncExternalStore(directory.subscribe, directory.getSnapshot)`（`M:1153`）——store 由 `createSnapshotStore` 造（`M:813`）。
2. **弹层**：`createPortal(…, document.body)`（`M:1719`）+ `useLayoutEffect` 算 `getBoundingClientRect` 相对定位、翻边、贴边距 12px、监听 `scroll(capture)/resize/ResizeObserver`（`M:1280-1318`）；菜单 CSS `position:fixed; z-index:1100`（`M:1060`）。
3. **关闭**：`document.addEventListener("mousedown", 外部判断)`，同时认 trigger 和 menu 两个 ref（`M:1221-1232`）；`Escape`/`Shift+Tab` 先退层再关（`M:1150` 注释）。
4. **回写**：`sessions.selectModel({sessionId, provider, model, reasoningEffort})`（`M:880-885`），失败只落在 store 的 error 上，不抛给 UI。

**差异**：模型选择必须走 Remote（`remote.session.modelCatalog`）；我们不需要——工作区列表来自 `useWorkspaces`，选择结果只活在插件自己的 store 里。

---

## 3. `@` 触发基础设施：可扩展（这是本次最正面的发现）

服务：`ctx.inputTriggers`（`T:1534-1571`，`super(ctx, "inputTriggers")`）。
官方用法证明插件可以注册自己的源：`F:367-368` `const inputTriggers = ctx.get("inputTriggers"); ctx.effect(() => inputTriggers.registerSource(source), …)`。

**契约**（`F:293-366` 是唯一一份完整样例，字段在 `T` 各处被消费）：

| 字段 | 必需 | 语义 / 证据 |
|---|---|---|
| `trigger` | ✅ | 目前只有 `"@"` 和 `"/"` 两种被 detect 出来（`T:776-812`，硬编码，**不能自定义触发字符**） |
| `name` | ✅ | `(trigger,name)` 唯一，重复直接 throw（`T:1558`） |
| `order` | – | roster 按 `order` 排序（`T:1594`） |
| `showGroupTitle` | – | `false` 时不画分组标题（`T:836`） |
| `candidates(session, {query, quoted, drilled, signal})` | ✅ | 返回候选行 `{name, description?, icon, section, value(不透明字符串), drill?}`；`section` 会在菜单里画分组小标题（`T:1788-1791`） |
| `header(session, req)` | – | 面包屑（钻取目录时用） |
| `onPick({candidate, action})` | ✅ | 返回 `{insert:{source, ref, label, appearance?, clipboardText}}` 或 `{text, continue?}` 或 `"handled"` |
| `codec.serialize(ref, signal)` | ✅ | **模型可见文本**，`T:1249-1253`；缺失 owner 或无 codec 会让发送**报错并恢复草稿**，不会降级 |
| `codec.clipboardText(ref)` | – | 剪贴板投影 |
| `openReference(session, {ref, appearance})` | – | 点击已有 chip 时接管（`T:1260-1268`） |
| `lexicon(projection)` / `subscribeLexicon` | – | 纯文本 chip 装饰用（见 §4.2，本场景不适用） |
| `warm` / `matchSpace` / `matchEnter` / `matchClaim` | – | 预热、空格裁决、回车裁决、`/` 命令恢复。`matchEnter` 也可以用来拦截回车 |

**多个 `@` 源如何共存**：controller 按触发字符过滤后再按 `order` 排序（`T:1594`），菜单状态是 `groups[]`，每个 group 属于一个 source（`T:831-841`），渲染时按 `item.section` 画分组标题（`T:1788-1791`）。官方 `@reference` 用了两个 section：`文件与文件夹 / 子智能体 / 对话`（`F:214-217`）。→ 我们的候选可以落在自己的 `section: "工作区"` 下，和文件/会话混在一个 @ 菜单里，这正是产品要的观感。

**硬限制（写进设计约束）**：触发字符不可扩展；候选的 `name` 就是 chip 的可见 label（`onPick` 里的 `label` 由源自己给）；`candidates` 是 async，可以带 `AbortSignal`。

---

## 4. 选中结果怎么落进消息

### 4.1 chip 节点路线：可行，但 `appearance` 被锁成三选一

- 插入链路：`onPick → {insert} → actx.bail("slash/input-insert-reference")`（`T:1376-1379`）→ `shell.insertReference(ref, span)`（`C:15862`）→ `draftEditor.insertReference`（`C:14787-14793`，`$createReferenceChipNode(ref)`，**插入时不校验 appearance**）。
- 渲染：`ReferenceChip({label, appearance, invalid})`（`C:13629-13646`）——`appearance === undefined` 时画一个 `@` 标记 + label（**这正好是工作区 chip 想要的**）；否则画 `ReferenceIconRegular kind={appearance}` 的图标 + label。
- **卡点**：草稿持久化 schema 的 `appearance` 是 `z.enum(["session","file","folder"])`（`C:4338-4345`），且 `parseStoredDraft` 校验失败返回 `undefined`，读回时是 `?? empty`（`C:4383-4386`、`C:4464-4479`，存 `localStorage["dsh.conversation.<sessionId>"]`）——**整条草稿（正文 + 所有 chip）被清空**，不只是那一个 chip。所以：`appearance: undefined` 或 `"session"` → 安全；`appearance: "workspace"` → 刷新/切走会话后草稿全丢（风险，别做）。
- chip 的 `clipboardText` 必须等于草稿文本在该 offset 上的切片，长度也要一致（`C:4351-4361` 的 refine）。所以 `clipboardText` 就填 `@工作区名`。

### 4.2 纯文本自动装饰路线：对中文不可行

`scanTextRefs` 的 token 正则 `/(^|\s)([/@])([\w-]+)/g`（`C:13893`），命中要求名字是 lexicon 成员（`C:13920`）。JS 的 `\w` = `[A-Za-z0-9_]`，**不含中文**，所以 `@产品设计工作区` 永远不匹配；带空格的标题更是完全不匹配。`FOLDER_REF_RE` 只认以 `/` 结尾的目录形态，也不适用。
→ 想让 `@名字` 在草稿里变成 chip 装饰，工作区名必须是纯 ASCII 单词。用户改工作区名不现实。**放弃这条，用 4.1 的 insert 路线。**

### 4.3 已发送消息里的渲染：可扩展，但越界

`conversation.user.text.node` 是 keyed 槽，参数 `{node, raw, interactive}`，`keyDomain` 写死"由 owner 键表决定，已占用 command/file/folder/secret/session/skill/text"（`R:4183`）。
但**运行时是通用的**：`renderSlot("conversation.user.text.node", {node, raw, interactive}, {entryKey: node.id, fallback: <原始文本>})`（`C:4209-4216`），而 `UserTextRegistry.register(rule)` 只校验「id 非空、不是 `text`、order 有限、不重复」（`C:3886-3891`），**没有白名单**。
→ 注册 `userText` 规则 `id:"workspace"` + 槽 key `"workspace"` 在运行期能生效（未注册时自动回退成原文，不会炸）。
**但这是越界用法**：TS 层是封闭 union `UserTextId`，哪天官方加了运行时校验就静默失效。建议：**只把它当增强（transcript 里好看），不要让它承担语义**；语义走 §5 的文本。

---

## 5. 选择怎么传给模型 / 工具（唯一的官方钩子）

`C:15524-15560` `sinkSerialized()`：提交时对草稿里每个 chip 调 `inputTriggers.serializeReference(source, ref)`，**用返回值替换该 chip 的文本区间**，其余草稿 `trim()` 后一起发出；任一序列化失败 → 发送失败 + 草稿恢复（`C:15561-15606`）。

所以：
- `codec.serialize(ref)` 返回什么，模型就看到什么。建议 `ref` 里塞 `workspaceId`，`serialize` 返回一段人能读、模型能解析的标记，例如 `<workspace id="ws-xxx" title="产品设计"/>`（纯建议，不是现有约定）。
- 模型拿到后把它作为 `dispatch_launch` 的 `workspace` 参数 → **需要 Host 侧支持**：现在 `dispatch_launch` 只有 `cwd`（`…\profiles\desktop\node_modules\dsh-mini-superagent\src\tools.js` 的 parameters），而 `sessions.create` 已接受 `workspaceId`（`S:3321-3333`，`remote.session.create({workspaceId})`）。缺的只是插件侧把参数透传。
- 如果不想依赖「模型看文本再转参数」，第二条路：控件选中后直接 `inputActions.setDraft({text, references})` 写一条结构化草稿（`C:14951-14953`，`DraftInput = {text, references: [{source, ref, offset, length, label, appearance?, clipboardText}], command?}`）。**这是「由面板写一段结构化文本」的官方入口，比模拟键入稳。**
- `conversation.composer`（chain，`R:2871-2920`）**不是**提交前改写钩子：`select(owner)` 命中就整体接管输入框（当前占用者：审批面板、子智能体只读输入框、提问面板）。用它做选择器等于重写整个 composer，成本远大于收益。→ 明确不走。

---

## 6. 必须先决的产品语义：会话的工作区不可变

- 客户端能拿到的只有：`useWorkspaces` 的 `{workspaceId, title, path}`、`ctx.workspaces.create({path})`（`R` 服务目录 `workspaces` 项）、`ctx.uiWorkspace.startSession(workspaceId?, options?)` / `connectWorkspace(workspaceId)` / `openWorkspace(workspaceId)`（`R:1488-1562`）。
- 全仓检索**没有**任何 session→workspace 迁移 RPC（只有归档时的 `workspace/session-active` 拒绝码）。`startSession` 的语义是"打开该工作区的空白会话"（`R:1553-1561`），不是"把当前会话搬过去"。
- 空白会话（hero）已经有官方工作区选择器，并且**输入框本体就是触发器**（`workspaceTrigger`，`C:19228-19232`；`conversation.composer.bar` 的 owner props 带 `workspacePickerOpen/onRequestWorkspace`，`R:2929`）。

**因此**：在活跃会话的输入框里"选工作区"，只能解释成**这一条消息/这一次派发投递到哪个工作区**（插件自己的选择状态），不能解释成"切换会话所属工作区"。这不是技术妥协，是 DSH 的数据模型如此；产品文案要按此写，否则用户会以为切换了工作区。

---

## 7. 是否需要构建步骤

**不需要。** 三条硬事实：

1. 现成产物就是手写脚本：`R:1`、`F:1`、`M:1` 全是 `window.__ModuleLoader__.load({id, factory(require){…}})`；`M:10-11` 直接 `require("react/jsx-runtime")` / `require("react")`。用 `React.createElement` 就不需要 JSX 编译。
2. 样式两种都行：组件内联 `style`，或 `document.head.appendChild(<style data-plugin=…>)`——官方包自己就这么干（`M:1061-1068`，带 id 去重）。**不需要 CSS Modules**（那只是编译期的类名混淆）。
3. 动态插件的 `ctx` 是**白名单代理**：没在 `inject` 里声明的服务，`ctx.get` 直接抛错并提示"Declare it on the plugin you return: { inject: [...] }"（`R:328-355`，尤其 `R:331-332`）。所以要用的服务必须写进 `inject`：`slots`、`inputTriggers`、`workspaces`、`sessions`，需要发 RPC 再加 `remote`。另外浏览器 timer 全局被重定向，要定时器得声明 `inject: ['timer']`（`R:41`）。

---

## 8. 最小实现路径（分三步，按投入递增）

**Step 1（1–2 天，纯 Client，先验证观感）**
`conversation.input.left` 里一个 28px 的按钮，显示当前选中的工作区名（默认跟随 `session.cwd` 所属工作区或第一个工作区）。点击在 `conversation.input.overlay` 里开下拉，数据 `useWorkspaces`，选中写插件自己的 per-session store。**不接 @，不改消息**——先验证位置、层级、窄屏表现是否成立。

**Step 2（2–3 天，接 @）**
`inject:['inputTriggers']`，注册 `{trigger:'@', name:'workspace'}`，`candidates` 返回 `section:"工作区"` 的行，`onPick` 返回 `{insert:{source:'workspace', ref: workspaceId, label: title, appearance: undefined, clipboardText:'@'+title}}`，`codec.serialize` 输出结构化标记。同时把 Step 1 的下拉选中改成"插入一个 chip"，两条路径统一。

**Step 3（Host 侧，必须）**
`dispatch_launch` 增加 `workspace` 参数 → 建会话时用 `workspaceId` 而不是 `cwd`；`dispatch_list/inspect` 的快照带上工作区。没有这一步，@ 出来的标记模型只能当文本读，工具不认。

---

## 9. 风险与未验证清单

1. **客户端 inspect 全程超时**（3 次），槽目录来自编译产物里的常量表，可能与当前运行时实际挂载情况有差；上线前必须在真机 `listSubTree` 复核一次。
2. **未跑过 UI**：28px 控件在窄窗口、活动展开态（`hidden:activity`）、hero/普通两态下的表现都没实测。
3. `conversation.user.text.node` 自定义 key `workspace` 属于**越界使用**（§4.3），TS 契约里不存在。只用它做视觉增强。
4. `appearance` 三选一的 zod 校验只在持久化/恢复路径上；插入路径不校验，所以"今天能插、明天恢复丢草稿"这种不对称风险真实存在——不要传自定义 appearance。
5. **中文 `@名字` 无法自动装饰**（§4.2），只有走 insert 才有 chip。
6. 会话↔工作区不可变（§6）。任何"切换工作区"的 UI 都会误导用户。
7. `inputTriggers` 服务**不在** Client Service 目录里（`R` 的服务表查不到它），只能靠 `inject:['inputTriggers']` 拿到；若某天官方改名为其他键，`ctx.get` 会抛错（好在抛错是显式的，不会静默坏）。
8. 空白会话（hero）阶段输入框里没有 `conversation.input.left`，官方 hero 工作区选择器是 single 槽、不可叠加。产品上要么接受"空白会话用官方、进会话后用我们的"，要么把选择器同时挂到 `conversation.hero.options`（list）做入口——后者未验证。

---

## 10. 接口清单（速查）

```
# 槽注册（框架选项；每槽另有自己的 registerOptions）
ctx.slots.inject("<slotName>", () => ctx.slots.register({ name, id?, key?, order?, label?, locale?, inject?, children?, select? }, Component))
# list 槽必须带 id（自取，重复即替换同 id 的格子）；keyed 槽必须带 key；chain 槽必须带 select(owner)=>{…}|null
# 注册回调里可拿到 standardProps：useWorkspaces / useSessions / useSessionStatus / useInput / inputActions / sessionId / useConversation / useRemoteAccess / useWorkspaceAccess / renderSlot

# 触发源
ctx.get("inputTriggers").registerSource({
  trigger: "@", name: "workspace", order?: n, showGroupTitle?: false,
  async candidates(session, { query, quoted, drilled, signal }) -> [{name, description?, icon, section?, value, drill?}],
  header?(session, req) -> crumbs|undefined,
  onPick({candidate, action}) -> {insert:{source, ref, label, appearance?, clipboardText}} | {text, continue?} | "handled" | undefined,
  codec: { serialize(ref, signal): Promise<string>, clipboardText(ref): string },
  openReference?(session, {ref, appearance}) -> boolean,
  lexicon?(projection) -> string[] , subscribeLexicon?(projection, cb) -> () => void,
  warm?(projection), matchSpace?(projection, token), matchEnter?(projection, line, signal, envelope), matchClaim?(projection, token, signal)
})
# 注册返回 disposer；用 ctx.effect(() => registerSource(...)) 收口

# 输入框动作（会话作用域）
inputActions.captureInsertion() -> {start, end, draftRev}
inputActions.insertText(text, span) -> boolean
inputActions.setDraft(text | {text, references: [{source, ref, offset, length, label, appearance?, clipboardText}], command?: {token}})
inputActions.persistDraft() / addAttachments(ids) / removeAttachment(id) / pruneAttachments(ids) / submit()

# 工作区 / 会话
ctx.get("workspaces").create({ path }) -> Promise<{workspaceId, title, path}>
ctx.get("uiWorkspace").startSession(workspaceId?, options?) -> void
ctx.get("uiWorkspace").connectWorkspace(workspaceId, options?) -> Promise<sessionId>
ctx.get("uiWorkspace").openWorkspace(workspaceId, beforeOpen?, options?) -> Promise<void>
ctx.get("uiWorkspace").openSession(target) -> void
ctx.get("sessions").create({ workspaceId?, cwd?, agentPreset?, sessionId? }) -> Promise<{sessionId}>
```

**参考实现顺序**：`M:1857-1925`（槽注册全貌）→ `F:293-368`（@ 源全貌）→ `C:15524-15560`（序列化）→ `C:4330-4422`（草稿结构）。
