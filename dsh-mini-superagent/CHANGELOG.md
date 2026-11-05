# Changelog

本文件记录 `dsh-mini-superagent` 的版本变化。版本号遵循 SemVer；`0.x` 阶段不保证 API 稳定，但工具名与配置键在 0.2.0 已冻结（见下）。

## 0.5.0 — 2026-11-05

界面侧补齐：看板的归档视图/工作区筛选/跳转会话，输入框的「派发目标」选择器与 `@` 工作区。Host 侧增量是「每个会话的派发目标」与状态文件 v3。

### 新增

- **看板（Client）**：
  - 过滤 chip 3 → 4：`全部`（默认，**不含已归档**）/ `进行中` / `需要处理` / `已归档`；顶部「总计」显示 `counts.total − counts.archived`。
  - 归档行整行 0.55 透明度、灰点、无取消/重试按钮，显示 `已归档` 徽标与相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前）；`archive_error` 单独一行。
  - 顶部「立即归档」两步确认（首次点击进入确认态，4 秒无操作自动回落），调 `POST /board/archive`。
  - 每行显示 `workspace_title`（`null` → 「跟随会话目录」）；顶部工作区下拉与状态 chip 取交集；同 `group` 的行聚在一起并带「批次」徽标（服务端底序不变）。
  - 点行跳子会话：`ctx.get('uiWorkspace').openSession(worker_session_id)`，支持 Enter/Space；失败提示「打不开子会话 `<id>`：<原因>」；归档行先提示「可能已不在会话列表」但仍尝试打开。
- **输入框「派发目标工作区」选择器（Client）**：注册到 `conversation.input.left`（list / session），id `dsh-mini-superagent/target`、`order 60`、label「派发目标」；
  28px 高、`flex:none`、`max-width: min(260px, 45cqw)`；有目标显示 `派发 → <标题>`，无目标显示 `派发 → 跟随会话`；
  只在有活跃会话时渲染。下拉用 `createPortal` 挂 body + `position: fixed`，优先向上展开、左右夹在视口内；
  项为「跟随会话目录」/ 全部工作区（带路径与 ✓）/「刷新列表」；选中即 `POST /board/target`，失败把 Host 中文原因留在下拉里且不关闭；
  快照取不到时禁用并提示「看板服务不可用」。不轮询：挂载与每次打开各取一次（快照层另有 10s 缓存，供 `@` 复用）。
- **`@` 选择工作区（Client）**：`inputTriggers.registerSource({trigger:'@', name:'workspace', order:40, …})`，与官方 `@reference` 并存，
  候选分组「工作区」；选中同时设置 Host 目标并往草稿插 chip；`codec.serialize` 产出 `<workspace id="…" title="…"/>`，
  `codec.clipboardText` 为 `@<标题>`；chip 的 `appearance` 故意省略（只认 session/file/folder，传别的会导致整条草稿恢复时被清空）。
  `inputTriggers` 服务缺席时 `@` 不出现，看板与控件照常。
- **Host 增量**：
  - `POST /dsh-mini-superagent/board/target`：body `{session_id, workspace}`（空串=清除）；成功 `{ok, target}`，缺 `session_id` 400，解析失败 409 并给候选。
  - 快照新增 `targets:{[sessionId]:{workspace_id,title,path}}`；任务卡新增 `workspace_id` / `workspace_title` / `archived_at` / `archive_error` / `group`（其中 `workspaces` / `counts.archived` 已在 0.4.0）。
  - `dispatch_launch` 没显式给 `workspace` 时用该会话的派发目标；目标失效只 warn 并退回调用者目录（不会凭选择器新建目录）。
  - 状态文件升到 `version: 3`：`{tasks, targets}`；旧文件缺 `targets` 按空处理。
- `docs/composer.md`：派发目标选择器与 `@` 工作区的说明。

### 变更

- 版本 `0.4.0` → `0.5.0`；`client/index.js` 从 1017 行扩到 **2055 行**（看板 UI 与输入框控件同属 0.5.0）。
- 看板「全部」不再包含已归档任务；顶部「总计」同步减去归档数。归档任务只出现在「已归档」chip。
- 单测从 43 → **50**（`tasks` 13 + `board` 26 + `workspaces` 11）。

### 验证

- ✅ `npm test`：50 pass / 0 fail（board 新增 7 个用例：工作区列表与归档计数、`/archive`、`/target` 设置/清除/缺参/解析失败、快照 `targets`）。
- ⚠️ 界面**未在真浏览器里跑过**（客户端模块要页面重载才挂载）：控件在工具行的对齐与截断、弹层翻转与边缘夹取、
  `@` 与官方 `@reference` 混排观感、chip 刷新后能否从草稿恢复、`openSession` 成功后视图是否真切换、深浅主题对比度、
  `not-listed` 的真实错误码，均未验证。

### 限制

- 派发目标是「下一次 `dispatch_launch` 的目标」，不是会话归属；DSH 会话的工作区建完不可迁移。
- 选择器只在有活跃会话时渲染；空白/hero 会话看不到。
- `@` chip 的 `appearance` 是闭集（session/file/folder），所以插件只插裸 chip，不能自定义图标/颜色。
- `@` 选中时设置目标失败没有可挂错误的位置，只 `console.warn`；控件下次取数会显示真实目标。
- 没显式 `workspace` 而目标已失效时，任务退回调用者目录，只记 warn。

## 0.4.0 — 2026-11-05

新增**工作区**能力：默认工作区 + 按天【派发】工作区 + 按工作区派发 + 自动归档，工具从 8 个变成 9 个。

### 新增

- `src/workspaces.js`（约 160 行）：`defaultRoot` / `rootOf` / `dayKey` / `dayTitle` / `safeDirName` 与
  `WorkspaceGateway`（`ensure` / `defaultWorkspace` / `dayWorkspace` / `createNamed` / `list` / `resolve` /
  `resolveOrCreate` / `archiveSession`）。`resolve` 顺序：工作区 id → 绝对路径 → 标题精确（大小写不敏感）→ 标题包含。
- **启动准备**（`Dispatch.provision()`，幂等）：建 `<workspaceRoot>` 并注册标题 `mini-superagent` 的工作区；
  在其中建固定 id 的默认主会话 `mas-lead`（标题「mini-superagent 主会话」）。已存在就跳过，失败只记日志。
- **按天【派发】工作区**：`<workspaceRoot>/派发/<YYYY-MM-DD>`，标题 `【派发】YYYY-MM-DD`。
  子会话默认放这里（`workerWorkspace: day`）；`target` 模式放进任务的目标工作区。
  会话建好后调 `workingDirectory.set` 把工作目录切到任务目标目录——会话住【派发】，活干在目标目录。
- **`dispatch_launch` / `dispatch_launch_many` 新参数**：`workspace`（id / 绝对路径 / 标题）与
  `create_workspace`（默认 true；绝对路径就地建，名字在工作区根下建）。解析不到且不允许新建时抛错并列出已有工作区。
- **新工具 `dispatch_workspaces`**（只读）：返回 `root`、`worker_workspace`、`archive_after_hours`、`count` 与
  `workspaces[{workspace_id,title,path,sessions}]`。工具总数 8 → 9。
- **自动归档**：每 `archiveSweepMinutes`（首次延迟 20 秒）把已结算且 `updatedAt` 超过 `archiveAfterHours` 的子会话
  `workspaceRegistry.archiveSession(id, {stopActivity:true})`；成功记 `archivedAt`，失败记 `archiveError` 并重试。
  已取消任务也能归档；归档只影响会话列表，不动任务表与看板。
- **看板**：快照新增 `counts.archived` 与 `workspaces:[{id,title,path}]`；任务卡新增
  `workspace_id` / `workspace_title` / `archived_at` / `archive_error`（以及批次 `group`）；
  新增 `POST /dsh-mini-superagent/board/archive` 手动跑一次归档巡检，返回 `{ok, scanned, archived, failed, counts}`。
- **批次汇总**：`dispatch_launch_many` 的整批任务共用一个 `group`，全部结算后给派发者发一条汇总，而不是 N 条流水。
- 新增 6 个配置：`workspaceRoot`、`provisionDefaultWorkspace`、`workerWorkspace`、`archiveAfterHours`、
  `archiveSweepMinutes`、`leadSessionId`。
- `test/workspaces.test.js`（11 个用例）；全量单测 32 → **43**，全过。
- `docs/workspaces.md`：工作区模型、目录约定、解析规则、归档策略、限制与排障。

### 变更

- 版本 `0.3.0` → `0.4.0`；`dispatch_list` 与看板快照的 `version` 同步。
- 任务新增 `workspaceId` / `workspaceTitle` / `archivedAt` / `archiveError` / `group` 字段，随任务表落盘。
- `dispatch_list` 卡片新增可选 `workspace`（工作区标题）与 `archived_at`。
- `dispatch_launch_many` 返回值新增 `group` 与 `note`。
- 没指定 `workspace` 时，工作目录仍沿用调用者目录，但子会话默认挂到当天【派发】工作区（0.3.0 是按目录反查工作区）。

### 限制

- `workspaceRegistry.create` 要求目录已存在：插件先 `mkdir -p`。目录不可写时默认工作区创建失败（只记日志），
  显式指定 `workspace` 的派发会报错。
- 同时给 `workspace` 与 `cwd` 时，工作区路径优先，`cwd` 被忽略。
- 归档失败没有退避，每轮巡检都会重试；`archive_error` 只在看板快照里，`dispatch_list` 看不到。
- 看板 UI 本轮未改，不展示工作区字段与归档字段，也没有归档按钮。

### 验证

- ✅ 启动准备：`dispatch_workspaces` 返回默认工作区且 `sessions: 1`，磁盘目录已创建。
- ✅ 会话/工作目录分离：子会话 `Get-Location` 返回目标工作区根，而会话挂在【派发】工作区下。
- ✅ 自动归档：临时 `archiveAfterHours=0.001` / `archiveSweepMinutes=0.05`，约 20 秒后 4 个任务归档
  （`counts.archived: 4`）；`POST /board/archive` 返回 200，再次调用 `scanned: 0`；配置已改回 24h / 10min。
- ✅ `npm test`：43 pass / 0 fail（tasks 13 + board 19 + workspaces 11）。

## 0.3.0 — 2026-11-05

新增常驻侧边栏的**任务看板**（Host HTTP + 浏览器面板）与**看板重试**。工具面不变，仍是 8 个 `dispatch_*`。

### 新增

- `src/board.js`（Host，约 200 行）：看板快照与三个同源 HTTP 路由——
  `GET /dsh-mini-superagent/board`（快照，`cache-control: no-store`）、
  `POST /dsh-mini-superagent/board/cancel`、`POST /dsh-mini-superagent/board/retry`。
  快照包含 `version`、`generatedAt`、`concurrency`、`counts` 与最多 200 条拍平任务；
  排序 `running` → `queued` → 其余按 `updated_at` 倒序。
- `client/index.js`（浏览器，1017 行）：plain ModuleLoader 包（`window.__ModuleLoader__.load(...)`，React 从 `require('react')` 取）。
  向 `sidebar.panellist` 注册「任务看板」图标（`id` = `dsh-mini-superagent.board`，`order 60`），向 `main` 注册同名面板。
  2 秒轮询、页面隐藏暂停并 abort、`prefers-reduced-motion` 关闭脉动、颜色走 `var(--dsw-alias-*, fallback)`。
- `Dispatch.retry(task)`：看板「重试」的服务端实现。`attempt` 从 1 开始、每次 +1；
  会话可恢复则续跑同一会话（`done` 的指令是「再执行一次」），不可恢复则换 `dispatch-<taskId>-a<attempt>` 并重投原始简报。
  `running` / `queued` / `cancelled` 拒绝重试（409）。
- `test/board.test.js`：19 个用例（快照 8 + 路由 11，用假 `req`/`res`）；全量单测 13 → **32**，全过。
- `docs/board.md`：看板入口、面板结构、接口契约、重试语义、鉴权与限制。
- `package.json`：`exports` 增加 `./client`，`files` 加入 `client`，新增 `dsh.client` 清单
  （`platform: web`、`immediately: true`、注入 layout/sidebar 两个客户端包）。

### 变更

- 版本 `0.2.0` → `0.3.0`；`dispatch_list` 与看板快照里的 `version` 同步。
- 任务对象新增 `attempt` 字段（默认 1），随任务表落盘；旧任务读回按 1 处理。
- README 增加「任务看板」小节与升级后刷新页面的说明。

### 安全

- `GET`：本机回环（`127.0.0.1` / `localhost` / `::1`）放行；非回环必须是同源页面（`Origin` 与 `Host` 一致），否则 403。
- `POST`：带 `Origin` 时必须与 `Host` 一致，跨站 403 且不产生副作用；不带 `Origin` 的客户端（curl/脚本）放行。
- 原因：插件注册的具名路由排在 DSH 页面鉴权之前；全放开会在 Web 暴露到局域网时泄露任务标题、工作目录与报告摘要。
  代价：远程 `curl` 读不到快照；远程只能通过同源页面使用看板。

### 验证

- ✅ `GET /dsh-mini-superagent/board` 返回 200、`cache-control: no-store`、`version: 0.3.0`、3 条任务。
- ✅ 对失败任务 `POST /board/retry` 返回 200，`attempt` 从 1 变 2，任务转 `running`；worker 恢复会话后再次
  `dispatch_report`，第 2 次汇报已回流主会话。
- ✅ `npm test`：32 pass / 0 fail。
- ⚠️ **未实测**：面板在浏览器里的实际渲染（侧边栏图标位置、点击切换、明暗对比度、窄宽度截断、面板高度、轮询暂停）。
  原因：客户端模块需页面刷新后才加载，而 GUI 页面有鉴权，无法代刷。装完/升级后需手动刷新一次 GUI 页面。

### 兼容性

- 8 个工具名、参数 schema、配置键与默认值不变；看板不新增工具。
- Host 侧依赖 `webServer`：headless 形态没有该服务时跳过路由注册，派发与工具不受影响。
- 升级后需刷新一次 GUI 页面，侧边栏才会出现「任务看板」图标。

## 0.2.0 — 2026-11-05

改名 + 多模块重构。功能面与 0.1.0 一致，修掉一个队列推进缺陷。

### 变更

- **改名**：`dsh-dispatch` → `dsh-mini-superagent`。`package.json` 的 `name`、插件 `name`、bundle patch 的 `id` 一起改。
- **拆分模块**：单文件 `index.js`（853 行）拆为 `src/` 下的 8 个模块——`index.js`（入口/事件接线）、`constants.js`（标识与默认值）、
  `tasks.js`（`TaskTable` 纯逻辑 + 纯函数）、`store.js`（落盘/读回）、`sessions.js`（DSH 适配）、`prompt.js`（给模型的文本）、
  `tools.js`（8 个工具）、`dispatch.js`（`Dispatch` 服务）。拆分轴见 `docs/architecture.md`。
- **状态目录改名**：`<DSH_HOME>/dsh-dispatch` → `<DSH_HOME>/dsh-mini-superagent`。
- **消息来源 kind 改名**：`dsh-dispatch` → `dsh-mini-superagent`（`source: {kind, form:'relay'}`）。
- **系统提示段名改名**：`dsh-dispatch` → `dsh-mini-superagent`；段首行相应变为 `[dsh-mini-superagent 工作方式]`。
- **日志前缀改名**：`dsh-dispatch:` → `dsh-mini-superagent:`。
- **状态文件结构版本**：`version: 1` → `version: 2`（读取时不强校验，旧文件仍能读）。
- 版本号改为从 `constants.js` 单点导出，`dispatch_list` 返回 `version: 0.2.0`。

### 新增

- `test/tasks.test.js`（Node 内置 test runner）+ `npm test`（`node --test`，自动发现 `test/*.test.js`），覆盖 `TaskTable` 与纯函数。
- `src/constants.js`：名称、版本、日志前缀、来源 kind、提示段名、状态目录、默认配置、状态集合、任务 id 与消息 id 生成集中在同一处。
- `TOOL_NAMES` 导出：8 个工具名的单一清单，便于核对注册是否齐全。
- `Dispatch.settle(task, status)`：统一结算入口，内部 `table.settle()` 后立刻 `void this.pump()`。
- `package.json` 的 `files` 随目录结构调整为 `src/`，并加入 `CHANGELOG.md` 与 `LICENSE`；新增 MIT `LICENSE` 文件。

### 修复

- **结算后不推进队列**（0.1.0 遗留）：0.1.0 只在 `launch()` 与 `apply()` 调 `pump()`，并发位满时排队的任务要等下一次派发或插件重载才动。
  现在 `report()` 终态、`onWorkerIdle()`、`cancel()`、`agent/disposed` 都经 `Dispatch.settle()` 触发 `pump()`；
  `pump()` 自己的失败分支改用 `table.settle`，避免自递归。
  实测：`maxWorkers=1`，A 慢任务结算于 13:05:53，B 快任务在 13:05:57 自动从 `queued` 转 `running`，期间无新派发。
- **并发 pump 可能超发**：`TaskTable.takeRunnable()` 改为在返回任务前同步置 `running` 占位，不再由调用方启动时补状态。

### 兼容性

- **不变**：8 个工具名（`dispatch_launch` / `dispatch_launch_many` / `dispatch_list` / `dispatch_inspect` / `dispatch_message` /
  `dispatch_cancel` / `dispatch_wait` / `dispatch_report`）、参数 schema、配置键与默认值、状态机语义、报告协议。
- **变了**：包名、状态目录、消息来源 kind、系统提示段名、日志前缀——按名字过滤日志或脚本的地方要跟着改。
- **不能并存**：不要同时安装 `dsh-dispatch` 与 `dsh-mini-superagent`，8 个同名工具会在同一全局层重复注册并抛错。
- **不自动迁移**：`tasks.json` 不会从旧目录搬过来；需要历史列表就手工复制到新 `stateDir`。未结算任务读回后仍标 `interrupted`。

### 验证

- 0.2.0 重装后重验：安装 + 8 工具注册（`version: 0.2.0`）、派发 → 执行 → `dispatch_report` → 回流。
- 0.2.0 新增并发排队实测（`maxWorkers=1`，一慢一快两个任务）。
- 0.1.0 的 8 条实测记录保留在包 README 的「验证记录」里，标注了版本口径。

## 0.1.0 — 2026-11-05

首个版本，单文件 Host 插件，原名 `dsh-dispatch`。

### 新增

- `dispatch_launch` / `dispatch_launch_many` / `dispatch_list` / `dispatch_inspect` / `dispatch_message` / `dispatch_cancel` /
  `dispatch_wait` / `dispatch_report` 共 8 个工具，注册在插件根 context（全局可见），角色靠「调用者是不是已登记的 worker」判定。
- 任务即 Session：`sessionController.create` + `resolveAgent` 建后台子会话，标题 `[派发] <title>`，会话 id `dispatch-<taskId>`。
- 报告回流：自造插件来源的 user message（`kind: dsh-dispatch`），经 `agent.steer()` / `agent.followup()` 投递，
  主会话空闲时唤醒、忙碌时并入下一步；收件箱失败降级到 `sessionController.prompt`。
- `agent/status` 监听：worker 回合结束且本回合没有终态报告时，抓最后一条 assistant 文本自动回报。
- `agent/disposed` 监听：子会话被关闭时把未结算任务标 `interrupted`。
- 并发上限与排队：`maxWorkers` 默认 6，超出进 `queued`，由 `pump()` 按登记顺序启动；该版本的 `pump()` 只在派发与插件加载时运行（缺陷见 0.2.0「修复」）。
- 7 个配置项：`maxWorkers`、`maxTasksPerSession`、`inheritWorkingDirectory`、`permissionPreset`、`stateDir`、
  `reportOnTurnEnd`、`maxBriefChars`，默认值见 `constants.js` 的 `DEFAULTS`。
- 落盘：`<DSH_HOME>/dsh-dispatch/tasks.json`，800ms 防抖，重启读回；未结算任务标 `interrupted`。
- 首次派发时向该会话注入 `[dsh-dispatch 工作方式]` 系统提示（段名 `dsh-dispatch`，`order: 9998`）。
- `cordis.patch.yml` 插入插件行并提供默认配置；`locale/{zh,en}.json` 提供管理面板里的标题与描述。

### 验证

在 `desktop` profile 上实测通过 8 条：安装与工具注册、派发 → `dispatch_report(done)` → 回流、漏报告自动回报（`PONG-OK`）、
`dispatch_wait` 阻塞至结算、对已结算任务追问再汇报、取消长任务、重启恢复、主会话空闲时被报告唤醒（20 秒）。
