# 任务看板

0.3.0 新增的常驻面板。Host 半边 `src/board.js` 提供快照与三个写操作（取消 / 重试 / 归档），浏览器半边 `client/index.js` 负责渲染。
两边只通过同源 HTTP 通信，不共享内存、不走 Remote/RPC。

---

## 入口与前提

| 项 | 值 |
| --- | --- |
| 侧边栏注册 | `sidebar.panellist`，`id` = `dsh-mini-superagent.board`，`order: 60`，`label: "任务看板"` |
| 主面板注册 | `main` 槽，`key` = `dsh-mini-superagent.board`（与侧边栏 id 必须一致，点图标才会切过去） |
| 客户端形态 | plain ModuleLoader 包：`window.__ModuleLoader__.load({id:'dsh-mini-superagent', factory(require){…}})`，React 从 `require('react')` 取 |
| 依赖声明 | `package.json` 的 `dsh.client`：`platform: "web"`、`immediately: true`、`inject: ["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"]` |
| 构建 | 无。不打包、不编译、无 CDN 依赖 |

前提与注意：

- **装完/升级后刷新一次 GUI 页面**，侧边栏才会出现图标。客户端模块在页面刷新后加载，插件激活本身不触发展示。
- Host 侧依赖 `webServer` 服务。headless 形态没有它时，路由不注册，日志写
  `dsh-mini-superagent: 没有 webServer，跳过任务看板路由`；派发与 9 个工具不受影响。
- 看板显示**整个实例**的任务（所有会话派出的），不是当前会话的；要只看本会话用 `dispatch_list`。

---

## 面板结构

从上到下：

```text
┌ 并发 2/6   排队 1   总计 7   失败 3          更新于 13:42:07 ┐
│ [全部 7] [进行中 3] [需要处理 3]                              │
├──────────────────────────────────────────────────────────────┤
│ ● 运行中  重构 auth 模块              第 2 次   3 分 12 秒 [取消]│
│   t-m0abc-1  报告 2   正在跑集成测试                           │
│ ● 失败    迁移 billing 表              —        8 秒      [重试]│
│   t-m0abc-2  报告 1   建会话失败                               │
│   建会话失败：无法解析子会话 dispatch-t-m0abc-2: session/not-found│
└──────────────────────────────────────────────────────────────┘
```

- **顶部指标**：`并发 running/max`、`排队`、`总计`、`失败`（有失败时红字），右侧「更新于 HH:MM:SS」。
  指标来自快照的 `concurrency` 与 `counts`，不是本地累加。
- **过滤 chip**：全部 / 进行中（`running`+`queued`）/ 需要处理（`failed`+`interrupted`+`blocked`），各带计数。
  过滤只影响列表，不影响顶部指标。
- **任务行**：
  - 第一行：状态点、状态文字、标题、`第 N 次`（`attempt > 1` 才显示）、走表耗时、操作按钮。
  - 第二行：`task_id`、报告数、最近一条报告摘要的首行（没有报告时显示「尚无报告」）。
  - 失败任务第三行：错误原文。
  - 悬停标题可看到 `task_id`、`cwd`、`worker_session_id`（放在 `title` 提示里，不占布局）。
- **状态点**：颜色 + 文字双通道，不只靠颜色。只有 `running` 脉动；`prefers-reduced-motion: reduce` 下动画关闭。
- **耗时**：`queued` 显示「等待中」；`running` 在两次轮询之间每秒走表（服务端 `elapsed_ms` + 本地经过时间）；
  其余状态用服务端算好的值。不足 1 秒按 1 秒显示。
- **按钮**：`running`/`queued` → 「取消」；`failed`/`interrupted`/`ended`/`blocked` → 「重试」；`done`/`cancelled` 没有按钮。
  请求期间按钮置灰并显示「取消中… / 重试中…」，成功后立即重取快照。
- **占位**：加载中、空列表（提示用 `dispatch_launch` 派发）、筛选后为空、取不到数据（有旧快照时显示「展示的是上一次成功取到的数据」）。
- **提示条**：取数失败是黄色条（带「重试」按钮）；操作失败是红色条（带「关闭」），显示 Host 返回的中文原因。
- **刷新节奏**：每 2 秒轮询一次；页面隐藏时停表并中止在途请求，切回来立刻重取；只在存在 `running` 任务时启动 1 秒走表；
  面板卸载或插件卸载时清定时器、中止所有在途请求。
- **样式**：全部选择器在 `.dsh-sa` 前缀下，`<style>` 随面板卸载；不写全局样式表、不碰别家 DOM。
  颜色走 `var(--dsw-alias-*, fallback)`（token 自带明暗两套），不写死明暗配色。

---

## HTTP 接口

全部挂在同一个前缀下，同源 `fetch`，不需要鉴权头：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-mini-superagent/board` | 返回整块快照，响应头 `cache-control: no-store` |
| POST | `/dsh-mini-superagent/board/cancel` | body `{"task_id":"t-..."}`，取消任务 |
| POST | `/dsh-mini-superagent/board/retry` | body `{"task_id":"t-..."}`，重试任务 |
| POST | `/dsh-mini-superagent/board/archive` | 无 body，立即跑一次归档巡检 |

请求体上限 64 KiB，必须是合法 JSON（`/archive` 不需要 body）。

### GET 快照

成功：`200`，`content-type: application/json; charset=utf-8`，`cache-control: no-store`。

```json
{
  "version": "0.4.0",
  "generatedAt": "2026-11-05T10:42:07.000Z",
  "concurrency": { "running": 2, "queued": 1, "max": 6 },
  "counts": { "total": 7, "running": 2, "queued": 1, "done": 2, "blocked": 1, "failed": 1, "cancelled": 0, "ended": 0, "interrupted": 0, "archived": 2 },
  "workspaces": [ { "id": "ws-…", "title": "mini-superagent", "path": "C:\\Users\\…\\Documents\\mini-superagent" } ],
  "tasks": [ { "task_id": "t-m0abc-1", "…": "…" } ]
}
```

- `counts` 按**全量**任务统计；`archived` 是带 `archivedAt` 的任务数（不是状态）。
- `workspaces` 是工作区注册表快照（`id` / `title` / `path`），注册表不可用时为空数组；面板当前没有用它渲染分组。
- `tasks` 最多 200 条；排序：`running` → `queued` → 其余按 `updated_at` 倒序；同权重按 `updated_at` 倒序。
- `version` 来自 `src/constants.js` 的 `VERSION`（当前 `0.4.0`）。

任务字段（`boardTask` 拍平后的形状）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task_id` | string | 任务 id |
| `title` | string | 标题 |
| `status` | string | `queued` / `running` / `done` / `blocked` / `failed` / `cancelled` / `ended` / `interrupted` |
| `attempt` | number | 第几次尝试，从 1 开始；旧任务缺省按 1 |
| `parent_session_id` | string | 派发者会话 |
| `worker_session_id` | string | 子会话 id（重试换会话后会变，形如 `dispatch-<taskId>-a2`） |
| `cwd` | string | 任务工作目录（指定 `workspace` 时为工作区路径） |
| `workspace_id` | string \| null | 目标工作区 id，未指定时为 `null` |
| `workspace_title` | string \| null | 目标工作区标题，未指定时为 `null` |
| `archived_at` | ISO 8601 \| null | 子会话归档时间，未归档为 `null` |
| `archive_error` | string | 仅归档失败的任务出现 |
| `group` | string | 仅 `dispatch_launch_many` 派出的任务出现，批次 id |
| `created_at` / `updated_at` | ISO 8601 | 创建 / 最近变更 |
| `started_at` | ISO 8601 | 首次启动时间；从未启动（仍在 `queued`）时字段缺失 |
| `turn_started_at` | ISO 8601 | 本轮开始时间；没有在跑回合时字段缺失 |
| `elapsed_ms` | number | 从 `started_at` 到现在的毫秒数；无 `started_at` 时为 0 |
| `report_count` | number | 报告条数（上限 50） |
| `last_report` | object \| null | `{at, status, summary}`，没有报告时 `null` |
| `last_text_preview` | string | worker 最后一段输出的前 500 字符 |
| `error` | string | 仅失败任务出现，启动失败原因 |

### POST 响应

成功：`200`，`{"ok":true,"task":{…}}`（`task` 是同一个拍平形状）。

失败：`{"ok":false,"error":"中文原因"}`，状态码：

| 码 | 场景 | 错误文案示例 |
| --- | --- | --- |
| `400` | 请求 URL 不合法 / body 不是合法 JSON / body 超过 64 KiB | `请求体不是合法 JSON`、`请求体过大` |
| `403` | GET 非本机且非同一源 / POST 的 `Origin` 与 `Host` 不一致 | `看板只对本机或同源页面开放`、`跨站请求被拒绝` |
| `404` | `task_id` 不存在 / 未知子路径 | `没有任务 t-xxx`、`未知的看板接口` |
| `409` | 操作被任务状态拒绝 | `任务 t-xxx 正在运行，不需要重试；要打断它请用取消`、`任务 t-xxx 已被取消；要重新做请派发一个新任务` |
| `500` | 处理器内部异常 | `看板接口内部错误`（日志里有前缀 `dsh-mini-superagent:` 的 warn） |

`POST /archive` 是例外：它没有 `task_id`，成功固定 `200`：

```json
{ "ok": true, "scanned": 4, "archived": 4, "failed": 0, "counts": { "total": 7, "…": "…", "archived": 4 } }
```

- `scanned`：本次符合条件的候选数；全部已归档后再调返回 `scanned: 0`。
- `archived` / `failed`：本次成功 / 失败数；失败原因记在对应任务的 `archive_error` 上。
- `counts`：跑完后的最新计数（含 `archived`）。
- 不会返回 404/409；`403`（跨站）与 `500`（内部异常）规则同其它 POST。

---

## 重试语义

任务的 `attempt` 从 1 开始，每次重试 +1，看板显示「第 N 次」。重试**沿用同一个任务 id**，只递增 `attempt`。

重试前会清掉 `error` 与 `lastReportAt`；历史报告（`reports`）保留，不删。

### 两种情况

1. **子会话还活着，或能 `resolveAgent` 恢复**（`blocked` / `ended` / `failed` 的常见情况）
   → `dispatch_message(task, 指令, 'queue')` **续跑同一会话**，它的历史还在，不用重讲背景。
   - 原状态是 `done`：指令是「把原任务**再执行一次**（第 N 次）」，要求重新核对当前状态与要求，按需补做。
   - 其它状态：指令是「**从中断处继续**完成原任务」。
2. **会话不在了**（`interrupted`，或当初建会话就失败）
   → 把 `worker_session_id` 换成 `dispatch-<taskId>-a<attempt>`，清空 `turnStartedAt`/`lastText`，
   任务回到 `queued` 并重新入队，`pump()` 有空位就新开会话、**重投原始简报**。

> 判定依据是「活 Agent 或 `resolveAgent` 成功」，不是任务状态本身。所以一个 `interrupted` 任务如果会话仍可恢复，
> 会走续跑而不是新开会话。

### 不允许重试的情况

| 状态 | 结果 |
| --- | --- |
| `running` | 409，提示先取消 |
| `queued` | 409，提示先取消 |
| `cancelled` | 409，提示重新派发；取消是终局 |

没有自动重试、没有退避策略、没有重试次数上限；只有人在看板上点，或脚本直接调接口。

### 取消

看板的取消走 `Dispatch.cancel(task, '看板取消')`：先把任务移出排队队列，再 `agent.cancel({kind:'user'}, {keepInbox:false})`
结束当前回合并清空收件箱，任务置 `cancelled`、释放并发位。已产生的工作不回滚。理由固定记为「看板取消」。

### 归档

`archived` **不是任务状态**，是任务上的 `archivedAt` 标记：

- 后台巡检（`archiveSweepMinutes` / `archiveAfterHours`）把已结算且过期的子会话
  `workspaceRegistry.archiveSession(id, {stopActivity:true})` 归档；
- 成功记 `archived_at`，失败记 `archive_error`，下一次巡检重试；
- 看板快照里多出 `counts.archived`，任务卡多出 `archived_at` / `archive_error`；
- 归档只影响会话列表，任务仍在快照里、`status` 不变；
- `POST /board/archive` 可手动触发一次巡检。

当前面板（0.3.0 的 UI 代码）**没有**渲染归档字段，也没有归档按钮；要用就调接口或看快照 JSON。
归档规则与排障见 [workspaces.md](workspaces.md)。

---

## 鉴权与暴露面

没有 token、没有登录态、没有额外请求头。准入靠 Host/Origin：

| 操作 | 规则 |
| --- | --- |
| `GET` | `Host` 的主机名是 `127.0.0.1` / `localhost` / `::1`（含 `[::1]`）→ 放行；否则必须带 `Origin` 且其 host 与 `Host` 一致 |
| `POST` | 带 `Origin` 时，其 host 必须与 `Host` 一致；不带 `Origin` 的请求放行（非浏览器客户端，如 curl/脚本） |

为什么：

- DSH 自己的页面路由要求鉴权，但**插件注册的具名路由排在鉴权之前**。如果对所有来源开放，
  把 Web 暴露到局域网时，任何人都能读到任务标题、工作目录、报告摘要与错误原文。
- 同源检查挡的是**浏览器跨站伪造**：浏览器发起的跨站 POST 一定带 `Origin`，不一致就 403，且不产生副作用。

代价与边界：

- 远程访问时，看板只能在同源页面里用；**远程 `curl` 读不到数据（GET 403）**。
- 但「不带 Origin」的 POST 会被放行。也就是说：能访问到端口、又知道 `task_id` 的远程脚本，仍可以取消/重试任务。
  这是为了不破坏本机命令行调用而做的取舍；任务 id 不含可枚举的会话信息，但拿到 id 就能操作，不要把 Web 端口暴露到不可信网络。
- 看板返回的数据包含 `cwd`、会话 id、报告摘要与错误原文，按敏感信息对待。

---

## 与 agent 工具的关系

- 看板**没有**新增工具；它只是调用 `Dispatch.cancel` / `Dispatch.retry` / `Dispatch.archiveStale`。
  agent 侧的工具在 0.4.0 是 9 个（多了只读的 `dispatch_workspaces`），但看板本身不提供工具。
- 看板的「取消」等价于 agent 调 `dispatch_cancel`（状态与并发位语义一致）。
- 看板的「重试」是给人用的：能恢复就续跑（与 `dispatch_message` 同一条投递路径），不能恢复就新开会话重投简报。
- 主会话要续跑一个任务，仍然用 `dispatch_message`；不要因为看板有按钮就以为多了一个工具。

---

## 已知限制

- **浏览器渲染未实测**：侧边栏图标位置、点击切换、明暗对比度、窄宽度截断、面板高度、轮询暂停都只做了代码审查，
  没有在真实 GUI 里点验（GUI 页面有鉴权，无法代刷）。接口与快照形状有实测和 19 个单测覆盖。
- **列表上限 200 条**：超出部分不显示，但 `counts.total` 仍是全量；没有分页。
- **没有历史归档**：来源是内存任务表（重启时从 `tasks.json` 读回），不查库、不查子会话日志。
- **轮询固定 2 秒**：不可配置；页面隐藏时暂停。
- **数据可能陈旧**：取数失败时保留上一次成功快照并提示，不自动清空。
- **看板不按会话过滤**：它展示整个实例的任务；agent 侧要按会话看用 `dispatch_list`。
- **POST 无 Origin 即放行**：见「鉴权与暴露面」，局域网部署要自己控制端口暴露。
- **重试不做状态回滚**：续跑依赖 worker 自己的历史；它可能重复执行已经做过的步骤。
- **归档字段只进快照**：`archived_at` / `archive_error` / `counts.archived` 有数据，但当前面板不显示；
  也没有归档按钮，只能调 `POST /board/archive`。

---

## 排障

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| 侧边栏没有「任务看板」 | 装/升级后是否刷新过页面；宿主是否 web 形态 | 刷新 GUI 页面；确认 `package.json` 的 `dsh.client` 已生效 |
| 面板显示「看板数据暂时取不到」 | 浏览器控制台里 GET 的状态码 | 403 → 用同源页面或本机访问；404 → Host 没注册路由（无 `webServer` 或旧版本）；500 → 看日志 `dsh-mini-superagent:` |
| 点取消/重试后红条提示 | 红条里的中文原因 | 409 → 任务状态不允许（running/queued/cancelled）；404 → 任务已不在表里 |
| 看板任务比 `dispatch_list` 多 | 正常 | 看板是全实例；`dispatch_list` 只列本会话 |
| 重试后 worker 会话 id 变了 | 正常 | 原会话不可恢复，换了 `dispatch-<taskId>-a<attempt>` |
| 「第 N 次」一直是 1 | 是否真的点过重试；旧任务是否有 `attempt` | 旧任务缺省 1；重试成功后 +1 |
| 远程 `curl` 读不到 | 403 是预期 | 用同源页面；或在 Host 本机访问 |
| `counts.archived` 不涨 | `archiveAfterHours` 是否为 0；任务是否已结算；`updatedAt` 是否够旧 | 调小保留期，或 `POST /board/archive` 手动跑一次 |
| `POST /board/archive` 返回 `failed > 0` | 任务卡的 `archive_error`；日志 `归档子会话 … 失败` | 宿主是否支持 `workspaceRegistry.archiveSession`；会话/目录是否还在。失败会在下次巡检重试 |
