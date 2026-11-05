# 02 · 工作区 / 会话界面骨架与看板跳转（可行性调研）

调研对象：本机已装 DSH `0.2.1-rc.5`（app.asar 内 `dsh/node_modules/@deepseek-ai/*`）+ 已装插件产物。
产出：只给结论、接口清单与最小路径，不含实现代码。

## 结论先行

| # | 问题 | 结论 | 一句话依据 |
|---|---|---|---|
| 1 | 侧边栏能否挂插件 UI | **可行** | `sidebar` 槽声明 8 个子槽，其中 4 个是 list 槽可多占用 |
| 1b | 在**工作区行**上加按钮 | **不可行** | 工作区行没有子槽，`sidebar.workspaces` 是 single 槽，已被官方 WorkspaceBrowser 独占 |
| 1c | 在**会话行**上加徽标 | **有条件可行** | 有 `sidebar.session.row.leading` / `.hover` / `.action` 三个 list 槽，props 本次未实测 |
| 2 | 从看板跳到某个会话 | **可行（纯 client service）** | `ctx.get('uiWorkspace').openSession(id)`，无 HTTP/URL 深链 |
| 2b | 在右侧栏打开 worker 会话记录 | **可行（需运行时探测）** | `sidebarRight.openResource('dsh-resource://subagentchat/session/…')` |
| 3 | 「在这个工作区新开主会话」入口 | **可行** | `uiWorkspace.startSession(workspaceId)`；入口挂 `sidebar.footer.action`（list） |
| 3b | 「把任务派到这个工作区」 | **有条件可行** | 这是 Host 侧 dispatch 参数，UI 只负责挑 workspaceId 并 POST 给我们自己的路由 |
| 4 | client 直接创建工作区 | **可行，且不必自建 HTTP 代理** | `ctx.get('workspaces').create({ path })`；结果由 Workspace 状态流自动广播回界面 |
| 5 | 看板增强是否需要换槽 | **不需要** | 维持 `main` 面板 + 行内按钮即可；分组/进度条是数据问题不是槽问题 |
| 6 | 是否必须引入打包 | **不需要** | 全部是 `ctx.get` / `ctx.slots` / `React.createElement`，纯运行时 JS |

**总体判断**：看板「点任务行 → 跳到那个子会话」是本轮唯一有产品价值且技术可行的增项，成本约半天（含真机验证）。真正卡住的只有两处：**工作区行没有插件挂载点**、**`client` Inspect 本次不可用（3× 10s 超时）导致槽 props 无法实测**。

## 0. 证据基础与限制

- 版本：`@deepseek-ai/dsh-client-ui-sidebar` / `-workspace` / `-layout` / `dsh-api-workspace-controller` 均为 `0.2.1-rc.5`（各包 `package.json:4`）。
- 下面把 `D:\...\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\` 记作 **`APP\`**；插件产物根记作 **`PLUG\`** = `C:\Users\<user>\.dsh\profiles\desktop\node_modules\`。
- **限制**：`cordis_inspect_query(platform="client", …)` 三次（`sidebar.panellist`、`sidebar.workspaces`、`sidebar.session.row.leading`）全部 10s 超时（"Open or reconnect the Harness page"），说明当前没有连上活页面。因此**本文所有结论来自只读源码**；凡标「未实测」的地方都是真没验证过，不是省略。
- 只读源码在 asar 内用 `read` 可读，`pwsh/glob/grep` 不行（已实测报 `os error 3`）。

## 1. 工作区的界面构成

### 1.1 骨架

三列框架由 `@deepseek-ai/dsh-client-ui-layout` 提供（"Shell plugin: three-column AppFrame with drag handles, `ctx.layout` viewing-state service"）。侧边栏外壳由 `ui-sidebar` 独占，它把整个子树一次性声明出来：

`APP\dsh-client-ui-sidebar\lib\client.js:611-649`（`ctx.slots.inject("sidebar", register({ name:'sidebar', children: {...} }, SidebarRoot))`）

| 槽名 | 种类 | 现状占用者 | 渲染位置 |
|---|---|---|---|
| `sidebar.brand.mark` | single | 官方（fallback 是 FishLogo） | 折叠态/宽态品牌图 |
| `sidebar.brand.name` | single | 官方（版本号） | 品牌文字 |
| `sidebar.toggle.badge` | single | 空（fallback 无） | 折叠按钮角标 |
| `sidebar.panellist` | **list** | 我方 + 其它插件（`dsh-ppt` 等已实测注册于此），官方面板亦占位 | 全局面板图标列 |
| `sidebar.panellist.actions` | **list** | 空 | 「更多」菜单的行 |
| `sidebar.workspaces` | single | `ui-workspace` 的 `WorkspaceBrowser` | 工作区/会话浏览区 |
| `sidebar.settings` | single | 官方设置入口（推断，未实测） | 底部 |
| `sidebar.footer.action` | **list** | 空 | 底部按钮区 |

另外两处可直接用：`shell.leading`（`client.js:650`，窗口标题栏左侧）、`shell.overlay`（`APP\dsh-client-ui-workspace\lib\client.js:5306`，全屏浮层，按 id 注册）。

槽的 `inject` 会向占用者发一组回调（`ui-sidebar:590-610`）：`startSession(workspaceId)` / `toggleSidebar()` / `selectPanel(id)` / `setPinned(id,pinned)` / `trackEntryClick()` + `hooks: {panels, shortcuts, entryPins, entryActions}`。`renderSlot` 直接传的 props：`sidebar.workspaces → {wide, expandSidebar}`（`:504-509`）、`sidebar.footer.action → {wide}`（`:515`）、`sidebar.settings → {wide}`（`:518`）、`sidebar.panellist → {size, active}`（`:226-229`）、`sidebar.panellist.actions → {entries, onOpen, onPinnedChange, onDismiss}`（`:277-282`）。

### 1.2 会话行的挂载点（本次最有价值的新发现）

`sidebar.workspaces` 虽然是 single 槽，但它内部再声明了 5 个子槽（`APP\dsh-client-ui-workspace\lib\client.js:5221-5248`）：

- `sidebar.workspaces.directoryFlow` — single，添加目录流程的覆盖层
- `sidebar.workspaces.session.menu.item` — **list**，会话右键菜单项（官方占用 pin/rename/fork/archive/session-id；inject `hooks:{menuOpenState, shortcuts}`）
- `sidebar.workspaces.session.row.action` — **list**，会话行操作按钮（官方占用 archive/pin）
- `sidebar.session.row.leading` — **list**，会话行首（徽标位）
- `sidebar.session.row.hover` — **list**，会话行悬停区

即：**「在会话行上做动作」有正经的官方挂载点，「在工作区行上做动作」没有**。工作区行只有内部注入的 `renameWorkspace/deleteWorkspace/insertWorkspaceBefore/createWorkspace`（`:5193-5205`），没有任何子槽。

### 1.3 工作区/会话怎么列

同一个浏览器组件：分区（`section.workspaces`="工作区" / `section.sessions`="会话"），三种分组（`groupBy.workspace`/`groupBy.workspaceTree`/`groupBy.flat`），排序（`orderBy.*`），置顶集与归档集来自 `workspaces.list` 快照的 `pinnedSessionIds` / `archivedSessionIds`（locale 键见 `:4762-4780`，数据见 `APP\dsh-api-workspace-controller\lib\client.js:259-267`）。

### 1.4 结论与风险

- 想加「看板入口按钮」→ 用 `sidebar.footer.action`（list，稳妥，不抢别人位置）。
- 想在会话行显示「该会话有 N 个派发任务」→ 用 `sidebar.session.row.leading`。**条件**：它是 `ui-workspace` 声明在 `sidebar.workspaces` 之下的子槽，只有浏览区挂载时才存在；props 形状未实测。
- 想在工作区行加按钮 → **做不到**；替代是把入口放到 `sidebar.footer.action`/`panellist.actions`，或整体接管 `sidebar.workspaces`（等于重写整个浏览区，不接受）。

## 2. 从看板跳到某个会话（核心需求）

### 2.1 结论：可行，走 client service，不是 URL 也不是 HTTP

会话跳转的官方入口在 **`uiWorkspace` 服务** 上，不在 `sessions` 上。这一点有源码注释明确背书：

> `dsh-better-sidebar\lib\client.js:25445-25450` — "DSH moved child and session navigation **OFF `ISessions`**（0.1.6 的 `open`/`openSubagent` are gone from the runtime…）onto the workspace face, which owns the main-view selection."

证据链（4 条独立来源，互相印证）：

1. 官方原型 `reference/dsh-superagent-prototype/src/navigation.ts:14-22`：先确保目录就绪，再 `openKnownSession(sessions, id, target => ctx.uiWorkspace.openSession(target), signal)`；`index.tsx:36-43` 是调用现场，`index.tsx:48` 声明 `inject = ['slots','locale','sessions','uiWorkspace']`。
2. `ui-workspace` 自己：`const openSession = (sessionId) => { uiWorkspace.openSession(sessionId) }`（`:5064-5066`）；`startSession: (workspaceId, options) => uiWorkspace.startSession(workspaceId, options)`（`:5183-5185`）。
3. `ui-sidebar`：`const workspaceNavigation = ctx.get("uiWorkspace")`，`startSession: (workspaceId) => workspaceNavigation.startSession(workspaceId)`（`:561`、`:591-593`）。
4. `dsh-better-sidebar`：`ctx.get("uiWorkspace")` → `workspace.openSession(target.address ?? target.sessionId)`，紧接着 `ctx.get("layout").beginNavigation()` 拿 `AbortSignal` 用于取消在途跳转（`:18686-18905`；等价简版在 `:25451-25459`）。

反证：全仓插件中没有任何一处把会话 id 写进 `location`/`history` 来导航（`pushState` 命中全部来自 CodeMirror/mermaid 等第三方依赖；`dsh-better-sidebar\lib\index.js:9716` 的 `?sessionId=` 是它**自己的 Host HTTP 资源地址**，用于服务端子会话页面，不是前端路由）。→ **没有可用的 URL 深链**，别指望「贴个链接就能打开会话」。

### 2.2 可直接照抄的调用方式（接口，不是实现）

```
const sessions  = ctx.get('sessions')       // ISessions
const ws        = ctx.get('uiWorkspace')    // openSession / startSession / archiveSession / forkSession …
const layout    = ctx.get('layout')         // beginNavigation() -> AbortSignal / selectPanel(id) / toggleSidebar()

// 1) 确保目录已知（否则可能 not-listed）
if (sessions.list.getSnapshot().phase !== 'ready' || !sessions.list.getSnapshot().byId[id]) await sessions.refresh()
// 2) 主视图切过去
ws.openSession(target)        // target = SessionId | { parentSessionId, childSessionId, mode }
// 3) 可选：拿取消信号，用户再点别的就中止
const signal = layout.beginNavigation()
```

判定顺序照抄 `navigation.ts`：`phase !== 'ready'` → `SessionNavigationError('not-ready')`；`byId[id]` 缺失 → `('not-listed')`。

### 2.3 第二种落点：右侧栏打开子会话（不抢占主视图）

`PLUG\dsh-better-sidebar\lib\client.js:18340-18383` 给出完整做法，运行时要先探测：

```
ctx.get('sidebarRightTabs').get('subagentchat')   // 必须存在
ctx.get('sidebarRight').openResource(
  'dsh-resource://subagentchat/session/' + encodeURIComponent(childId) + '?parent=' + parent + '&mode=' + mode,
  { kind: 'subagentchat', preferNewPane: true })
```

不可用（无该 tab 类型/无右列/没有挂载座位）时它 `return false` 让调用方回退到主视图跳转 —— 这个「探测 + 回退」结构建议照搬。

### 2.4 风险

- **最大风险（未实测）**：目标会话必须已在 `sessions.list.byId` 里，否则 `openSession` 之后界面不会变，而我们拿到的只是 `not-listed`。我们派发出来的 worker 会话（`worker_session_id`）是否进入这个目录、是否出现在侧栏树里，**必须真机验证**，否则「跳转」在产品上等于不存在。
- 子会话要用 `address` 形式（`{parentSessionId, childSessionId, mode}`），直接传 id 可能落到错的层级（better-sidebar 就是 `address ?? sessionId` 二选一）。
- 这是 0.1.6 → 0.2 迁移过的 API：照抄旧文档的 `sessions.open()`/`openSubagent()` 会**静默无效**（better-sidebar 注释原话）。
- 我们的 `client/index.js:977` 目前 `inject = ['slots']`，要加 `'sessions','uiWorkspace'`（可选 `'layout'`）。缺 inject 时 `ctx.get` 返回 undefined，不会报错——所以必须显式声明并做空值兜底。

## 3. 工作区级动作

- **可行**：`uiWorkspace.startSession(workspaceId, options?)`（`ui-workspace:5183`、`ui-sidebar:591`）。官方 Ctrl+N 也是走这条（`ui-workspace:123-128`，`navigation.startSession()` 不带参数＝当前工作区）。
- 入口放 `sidebar.footer.action`（list，`{wide}`）最干净；`sidebar.panellist.actions` 只有在该槽有占用者时才渲染「更多」按钮（`ui-sidebar:479-500`，`hasEntryActions` 见 `:587-589`），可作二级入口。
- **「把任务派到这个工作区」是另一回事**：它需要 Host 侧 `dispatch_launch` 接受 workspaceId 并把它换成 cwd/preset。UI 只能负责「选中 → 写进请求体」。这属于我们自己的协议扩展（`src/board.js` 现有 3 条路由要加字段），不是 DSH 能力问题。风险：`BoardSnapshot` 里目前只有 `cwd/parent_session_id/worker_session_id`（`dsh-mini-superagent/src/board.js:30-47`），没有 workspaceId，分组/派发都要先补这个字段。

## 4. 客户端能否直接创建工作区

**能，而且不该自建 HTTP 代理。**

- 服务键 `workspaces`：`APP\dsh-api-workspace-controller\lib\client.js:388-392`（`super(ctx, "workspaces")`，`this.list = model`）。完整方法：`create / initializeDefault / rename / delete / insertBefore / insertSessionBefore / archiveSession / unarchiveSession / pinSession / unpinSession`（`:393-436`）。
- `create` 的线上契约（Host 侧 `APP\dsh-api-workspace-controller\lib\index.js:211-227`）：入参 `{ path }`；先 `resolveByPath` 命中就返回 `{workspace, created:false}`，否则建；返回 `workspace = {workspaceId, path, title, sessionIds, createdAt, updatedAt}`（`:17-26`）；失败码 `workspace/invalid-path`。Client 包装层把 `result.value.workspace` 直接返回（`client.js:393-397`），失败抛 `WorkspaceCreateError`（`:357-365`）。
- 其它错误码（同一 Host 文件）：`rename` → `workspace/name-conflict`（`:240`）；`archiveSession` 有运行中工作 → `workspace/session-active` + `details.activity`（`:302-306`）。
- 选目录：`ctx.get('remote').directoryPicker.pick()`；同命名空间还有 `list` 与 `createDirectory({path, name})`（`index.js:408-411`、`:428-430`）。
- **界面刷新不需要我们操心**：Host 有 Workspace 状态流，client 侧用 `RemoteSnapshotStream` 收 `baseline / upsert / remove / order / archived / pinned` 帧并 `installViews/upsert`（`client.js:473-514`）。`create` 成功后界面会自己出现新工作区。**这正是「自己写 HTTP 路由代理」的坏处：绕过 model 就没有这条广播，得自己想办法让界面刷新。**
- 限制：① 只接受**已存在的绝对目录**（`APP\dsh-workspace\lib\index.js:48-51`，相对路径/不存在都拒绝）；② 可见性受权限过滤——Host 的 `follow` 逐条过 `remoteAccess.allows({kind:'workspace'|'session'})`（`index.js:963-988`），非 owner 可能看不到；③ 需要在 client 模块 `inject` 里加 `'workspaces'`（用目录选择器再加 `'remote'`）。
- 结论：**自建 `/dsh-mini-superagent/...` 路由只用于「我们自己的看板数据」，不要用它代理工作区增删。**

## 5. 看板增强：要不要换槽

不需要。现状（`main` 槽整块面板，`client/index.js:1004-1009`）足够承载：

- **按工作区分组**：纯数据活。`boardTask` 补一个 `workspace_id`（Host 侧用 `cwd` 反查 `workspaces.list` 的 `path`），client 侧 `groupBy` 即可。
- **子会话链接**：行内按钮调 §2.2 / §2.3，不占新槽。
- **实时进度条**：现有 2s 轮询（`client/index.js:33`）够用；要更实时得上 Remote 流，但我们没有跨进程契约，性价比低。
- **会话行徽标**（可选增强）：`sidebar.session.row.leading`。
- 需要全局浮层（例如「派发到工作区」表单）时用 `shell.overlay`（`ui-workspace:5306`）；需要 toast 时可用宿主已挂的 keyed 槽 `workspace.toast`（`ui-workspace:5323`，宿主端 `RowActionToast` 已注册，见 `:5319-5327`）。

## 6. 是否只能靠编译型插件做

**一项都不是。** 上面所有调用都是运行时 `ctx.get(...)` / `ctx.slots.inject(...)` / `inject: [...]`，与 React 的 `createElement` 同一层次，我们的 `client/index.js`（手写 `window.__ModuleLoader__`、无打包）完全够用。唯一的代价是要手写 `h()`，不能写 JSX/TSX；以及不能用 TS 类型（`SidebarPanelIconOwnerProps` 这类只有 `.d.ts`，而 app.asar 里 `.d.ts` 实际不存在——本次三处 `lib/types/**` 读取全部 `not found`，只能从编译产物反推）。

真正「做不了」的不是技术形态，而是界面结构：**工作区行没有挂载点**、`sidebar.workspaces` 是 single 槽不可共存。

## 7. 未验证 / 缺口清单（交付前必须补）

1. `client` Inspect 全程不可用（3× 超时）→ 槽 occupants、`standardProps`（`useWorkspaces`/`usePanelInfo` 等）都**没有实测**，只从源码反推。页面重连后应重跑：`listSubTree{root:"sidebar.session.row.leading"}`、`{root:"sidebar.panellist"}`、`{root:"main"}`。
2. `sidebar.session.row.leading` / `.hover` 的 props 形状未验证（只知道是 list 槽、root scope、随行渲染）。
3. `startSession(workspaceId, options)` 的 `options` 字段未验证（只知道存在第二参）。
4. **worker 子会话是否进入 `sessions.list` / 侧栏树** 未实测 —— 决定「跳转」是否真能落地，优先级最高。
5. 插件卸载/HMR 时 `slots.inject` 的清理语义未验证（我们现有代码靠 `ctx.effect` 兜底）。

**建议验证顺序**（约半天）：① 起页面、跑 §7.1 三条 inspect；② 用一条 `console.log(await ctx.get('sessions').list.getSnapshot().byId)` 确认 worker 会话在不在目录里；③ 在面板里放一个临时按钮跑 `openSession`，目视主视图是否切过去；④ 再决定是否做 `startSession` 入口与行徽标。

## 8. 接口清单（速查）

| 用途 | 调用 | 证据 |
|---|---|---|
| 打开会话（主视图） | `ctx.get('uiWorkspace').openSession(id \| {parentSessionId,childSessionId,mode})` | `ui-workspace:5064`、better-sidebar `:18890` |
| 新开会话 | `ctx.get('uiWorkspace').startSession(workspaceId?, options?)` | `ui-workspace:5183`、`ui-sidebar:591` |
| 导航取消信号 | `ctx.get('layout').beginNavigation()` → AbortSignal | better-sidebar `:18892` |
| 切全局面板 | `ctx.get('layout').selectPanel(id)` | `ui-sidebar:597-599` |
| 会话目录 | `ctx.get('sessions').list.getSnapshot()` / `.refresh()` / `.search(q,signal)` / `.using(id,{source},fn)` | `ui-workspace:5023`、`:5049-5063`、`:5077-5080` |
| 工作区增删改 | `ctx.get('workspaces')` → `create({path}) / rename(id,title) / delete(id) / insertBefore(id,before)` | controller `client.js:388-436` |
| 工作区列表订阅 | `ctx.get('workspaces').list.getSnapshot()/subscribe()` | `client.js:255-258` |
| 选目录 | `ctx.get('remote').directoryPicker.pick()` | `index.js:428` |
| 右侧栏开子会话 | `ctx.get('sidebarRight').openResource(url,{kind:'subagentchat',preferNewPane:true})` | better-sidebar `:18371-18378` |
| 空槽位（入口按钮） | `sidebar.footer.action`（list）、`sidebar.panellist.actions`（list）、`shell.overlay` | `ui-sidebar:643`、`:631`、`ui-workspace:5306` |
| 空槽位（会话行） | `sidebar.session.row.leading`、`.hover`、`.action` | `ui-workspace:5236-5247` |
