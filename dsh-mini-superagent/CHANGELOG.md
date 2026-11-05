# Changelog

本文件记录 `dsh-mini-superagent` 的版本变化。版本号遵循 SemVer；`0.x` 阶段不保证 API 稳定，但工具名与配置键在 0.2.0 已冻结（见下）。

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
