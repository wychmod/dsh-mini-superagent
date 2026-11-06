# 任务看板

0.3.0 新增、0.5.0 补齐归档与工作区视图的常驻面板。Host 半边 `src/board.js` 提供快照与四个写操作（取消 / 重试 / 归档 / 派发目标），
浏览器半边 `client/index.js` 负责渲染。两边只通过同源 HTTP 通信，不共享内存、不走 Remote/RPC。

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
│ [全部 7] [进行中 3] [需要处理 3] [已归档 2]                    │
│ [全部工作区 ▾]                              [立即归档]        │
├──────────────────────────────────────────────────────────────┤
│ ● 运行中  重构 auth 模块   批次  第 2 次  3 分 12 秒 [取消]      │
│   项目 A · t-m0abc-1 · 报告 2 · 正在跑集成测试                  │
│ ○ 已完成  迁移 billing 表         已归档  2 小时前              │
│   跟随会话目录 · t-m0abc-2 · 报告 1 · 迁移完成                  │
└──────────────────────────────────────────────────────────────┘
```

- **顶部指标**：`并发 running/max`、`排队`、`总计`、`失败`（有失败时红字），右侧「更新于 HH:MM:SS」。
  指标来自快照的 `concurrency` 与 `counts`；**「总计」= `counts.total − counts.archived`**（归档只在它自己的 chip 里计数）。
- **过滤 chip（4 个）**：
  - `全部`（默认）：`!archived_at`，**不含已归档**；
  - `进行中`：未归档且 `running`/`queued`；
  - `需要处理`：未归档且 `failed`/`interrupted`/`blocked`；
  - `已归档`：`archived_at` 非空。
  每个 chip 的数字按**当前工作区筛选后**的任务算。
- **工作区下拉**：`全部工作区` + 快照 `workspaces` 列表；选中后与状态 chip 取交集（先按 `workspace_id` 过滤，再套 chip）。
- **立即归档**：两步确认。第一次点击进入确认态（按钮变「确认归档」），4 秒内不再点自动回落；确认后
  `POST /board/archive`，结果用提示条显示「扫描 N，归档 N，失败 N」。
- **任务行**：
  - 第一行：状态点、状态文字、标题、`批次` 徽标（`group` 非空）、`第 N 次`（`attempt > 1`）、`已归档` 徽标与相对时间、走表耗时、操作按钮。
  - 第二行：工作区名（`workspace_title`，为空显示「跟随会话目录」）、`task_id`、报告数、报告摘要首行。
  - 失败任务额外一行错误原文；归档失败额外一行「归档失败：…」。
  - 悬停标题可看到 `task_id`、`cwd`、`worker_session_id`；可点行再加「点击打开子会话」。
- **归档行**：整行 0.55 透明度、状态点转灰、无脉动、**没有取消/重试按钮**；相对时间按 `刚刚 / N 分钟前 / N 小时前 / N 天前` 显示。
- **批次聚合**：`group` 非空的行以该组在服务端底序里第一次出现的位置为锚点，把同组任务整体挪到一起（只改视觉顺序，不动底序）。
- **跳转会话**：整行可点（`worker_session_id` 非空时），`Enter`/`Space` 同样触发；按钮会吞掉冒泡。
  成功时不提示；失败显示「打不开子会话 `<id>`：<原因>」；归档行先弹一句「该子会话已归档，可能已不在会话列表里」，但仍然尝试打开。
- **状态点**：颜色 + 文字双通道，不只靠颜色。只有 `running` 脉动；`prefers-reduced-motion: reduce` 下动画关闭。
- **耗时**：`queued` 显示「等待中」；`running` 在两次轮询之间每秒走表（服务端 `elapsed_ms` + 本地经过时间）；
  其余状态用服务端算好的值。不足 1 秒按 1 秒显示。
- **按钮**：`running`/`queued` → 「取消」；`failed`/`interrupted`/`ended`/`blocked` → 「重试」；`done`/`cancelled`/已归档 没有按钮。
  请求期间按钮置灰并显示「取消中… / 重试中…」，成功后立即重取快照。
- **占位**：加载中、空列表（提示用 `dispatch_launch` 派发）、筛选后为空、取不到数据（有旧快照时显示「展示的是上一次成功取到的数据」）。
- **提示条**：取数失败是黄色条（带「重试」按钮）；操作失败是红色条（带「关闭」），显示 Host 返回的中文原因。
- **刷新节奏**：每 2 秒轮询一次；页面隐藏时停表并中止在途请求，切回来立刻重取；只在存在 `running` 任务时启动 1 秒走表；
  面板卸载或插件卸载时清定时器、中止所有在途请求。
- **样式**：全部选择器在 `.dsh-sa` 前缀下，`<style>` 随面板卸载；不写全局样式表、不碰别家 DOM。
  颜色走 `var(--dsw-alias-*, fallback)`（token 自带明暗两套），不写死明暗配色。

---

## HTTP 接口

全部挂在同一个前缀下，同源 `fetch`；0.7.0 起客户端会带上 `x-dsh-mini-superagent` 头（写操作要求它）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-mini-superagent/board` | 返回整块快照，响应头 `cache-control: no-store` |
| POST | `/dsh-mini-superagent/board/cancel` | body `{"task_id":"t-..."}`，取消任务 |
| POST | `/dsh-mini-superagent/board/retry` | body `{"task_id":"t-..."}`，重试任务 |
| POST | `/dsh-mini-superagent/board/archive` | 无 body，立即跑一次归档巡检 |
| POST | `/dsh-mini-superagent/board/target` | body `{"session_id":"session-...","workspace":"id/路径/标题或空串"}`，设置/清除派发目标 |
| GET | `/dsh-mini-superagent/board/selfcheck` | 诊断：宿主侧能力、工作区、默认主会话、`client.inGraph` / `client.ready`、启动图模块列表 |
| POST | `/dsh-mini-superagent/board/client-ready` | 浏览器半边在 `apply` 末尾自报 `{ok, registered:[...]}`，宿主记进 `client.ready` |

请求体上限 64 KiB，必须是合法 JSON（`/archive` 不需要 body）。

### 两个诊断入口

`/selfcheck` 与 `/client-ready` 不是给面板用的，是排查「面板为什么没出现」用的：

| 字段 | 含义 | 怎么读 |
| --- | --- | --- |
| `client.inGraph` | 宿主是否把本包的浏览器半边编进了 Web 启动图 | `false` = 面板和输入框控件根本不会加载。`dsh.client` 的解析结果是按 Loader 行缓存在进程内存里的（含否定结论），**必须重启宿主**才能刷新。见 `plans/03-client-graph.md` |
| `client.path` | 编进图时该模块的磁盘路径 | 用来确认装的是哪一份 |
| `client.ready` | 浏览器半边最近一次 `apply` 自报 | 缺省 = 模块没跑起来或页面还没刷新；`ok:false` = `apply` 抛错了 |
| `client.bootAt` | 本插件实例的启动时间 | `ready.at` 早于它，说明那是上一次实例留下的陈旧记录 |
| `client.probes` | 对 `dsh-context` / `dsh-ppt` 等已知正常包的同样探测 | 用来判断探针本身是否可靠：它们都为空才是方法问题 |

`inGraph` 与 `ready` 是两件事：前者＝模块进了图，后者＝它在页面里真的跑起来了。
两关都过还没有面板，才轮到看槽注册与渲染。

### GET 快照

成功：`200`，`content-type: application/json; charset=utf-8`，`cache-control: no-store`。

```json
{
  "version": "0.7.0",
  "generatedAt": "2026-11-05T10:42:07.000Z",
  "concurrency": { "running": 2, "queued": 1, "max": 6 },
  "counts": { "total": 7, "running": 2, "queued": 1, "done": 2, "blocked": 1, "failed": 1, "cancelled": 0, "ended": 0, "interrupted": 0, "archived": 2 },
  "workspaces": [ { "id": "ws-…", "title": "mini-superagent", "path": "C:\\Users\\…\\Documents\\mini-superagent" } ],
  "targets": { "session-…": { "workspace_id": "ws-…", "title": "项目 A", "path": "D:\\proj\\a" } },
  "truncated": null,
  "tasks": [ { "task_id": "t-m0abc-1", "…": "…" } ]
}
```

- `counts` 按**全量**任务统计；`archived` 是带 `archivedAt` 的任务数（不是状态）。
- `workspaces` 是工作区注册表快照（`id` / `title` / `path`），注册表不可用时为空数组；面板用它做工作区下拉。
- `targets` 是每个主会话当前的派发目标（`session_id → {workspace_id,title,path}` 或 `{auto:true,…}`）；没有目标的会话不出现。
- `tasks` 最多 200 条；排序：`running` → `queued` → 其余按 `updated_at` 倒序；同权重按 `updated_at` 倒序。
- `truncated`：任务总数超过 200 时为 `{shown, total}`，否则 `null`。**这是给界面的提示**——没有它的时候「总计 500 / 列表 200」看起来像数据丢了。
- `version` 来自 `src/constants.js` 的 `VERSION`（当前 `0.7.0`）。

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
| `elapsed_ms` | number | 耗时。未结算：`started_at → 现在`（走表增长）；已结算：`started_at → updated_at`（冻结在结算时刻）。无 `started_at`、或已结算但 `updated_at` 不可解析时为 0 |
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
| `403` | Host 非回环且未在 `BOARD_ALLOWED_HOSTS` / Origin 与 Host 不一致 / 写操作缺 `x-dsh-mini-superagent` 头 | `看板只对本机或同源页面开放`、`看板写操作需要同源页面或带 ... 头的本机调用` |
| `404` | `task_id` 不存在 / 未知子路径 | `没有任务 t-xxx`、`未知的看板接口` |
| `409` | 操作被任务状态拒绝；或 `/target` 找不到工作区 | `任务 t-xxx 正在运行，不需要重试；要打断它请用取消`、`找不到工作区「…」。现有：<标题>（<id>）；…` |
| `500` | 处理器内部异常 | `看板接口内部错误`（日志里有前缀 `dsh-mini-superagent:` 的 warn） |

`POST /archive` 是例外：它没有 `task_id`，成功固定 `200`：

```json
{ "ok": true, "scanned": 4, "archived": 4, "failed": 0, "counts": { "total": 7, "…": "…", "archived": 4 } }
```

- `scanned`：本次符合条件的候选数；全部已归档后再调返回 `scanned: 0`。
- `archived` / `failed`：本次成功 / 失败数；失败原因记在对应任务的 `archive_error` 上。
- `counts`：跑完后的最新计数（含 `archived`）。
- 不会返回 404/409；`403`（跨站）与 `500`（内部异常）规则同其它 POST。

`POST /target` 也不带 `task_id`：

```json
// 请求
{ "session_id": "session-…", "workspace": "ws-…" }   // workspace 为空串 = 清除目标
// 成功
{ "ok": true, "target": { "workspace_id": "ws-…", "title": "项目 A", "path": "D:\\proj\\a" } }
// 清除成功
{ "ok": true, "target": null }
// 失败
{ "ok": false, "error": "需要 session_id" }          // 400
{ "ok": false, "error": "找不到工作区「…」。现有：…（ws-…）；…" }  // 409
```

- 400：缺 `session_id`（或 URL/JSON 格式错）。
- 409：`workspace` 解析不到（id / 绝对路径 / 标题都试过）；错误文本带现有工作区候选。
- 设置成功后写入任务表落盘的 `targets`；`dispatch_launch` 没显式给 `workspace` 时使用它。语义见 [composer.md](composer.md)。

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
- `POST /board/archive` 可手动触发一次巡检；面板顶部的「立即归档」就是它的两步确认版。

归档规则与排障见 [workspaces.md](workspaces.md)。

---

## 已归档视图

0.5.0 起，归档任务从「全部」里移出，只出现在 `已归档` chip：

- `全部`、`进行中`、`需要处理` 都排除 `archived_at` 非空的任务；
- `已归档` 只显示 `archived_at` 非空的任务；
- 顶部「总计」= `counts.total − counts.archived`，与「全部」chip 对得上；
- 归档行整行 0.55 透明度、灰点、无脉动、没有取消/重试按钮，显示 `已归档` 徽标与相对时间；
- 归档失败的任务额外显示一行「归档失败：<原因>」（来自 `archive_error`），不随归档隐藏。

这样设计的原因：归档是历史，不是「完成」。混在「全部」里会让日常视图被历史淹没，也会让「总计」与列表数量对不上。

## 工作区分组

- 每行第二行显示 `workspace_title`；为 `null` 时显示「跟随会话目录」。
- 顶部工作区下拉列出「全部工作区」+ 快照 `workspaces` 的标题；选中后先按 `workspace_id` 过滤，再套状态 chip，两者取交集。
- chip 上的数字按**当前工作区筛选后**的任务计算，不是全量。
- `group` 非空的任务（`dispatch_launch_many` 派出的批次）带「批次」徽标；渲染时以该组在服务端底序里第一次出现的位置为锚点，
  把同组行聚到一起。服务端排序骨架（`running` → `queued` → 其余 `updated_at` 倒序）不变，聚合只发生在客户端。

## 跳转会话

- 整行可点（`worker_session_id` 非空时），鼠标点击与 `Enter` / `Space` 都会调
  `ctx.get('uiWorkspace').openSession(worker_session_id)`。
- 行内的取消/重试按钮会 `stopPropagation`，不会误触跳转。
- 失败处理：
  - `uiWorkspace` 服务不可用 → 「打不开子会话 `<id>`：会话导航服务不可用」；
  - `openSession` 抛错 → 「打不开子会话 `<id>`：<原因>」；
  - 任务没有 `worker_session_id` → 「这个任务没有可打开的子会话」。
- 已归档的行先提示「该子会话已归档，可能已不在会话列表里」，但仍然尝试打开。
- 成功时清掉上一条失败提示（归档行保留那句归档提醒）。
- 已知边界：`openSession` 抛 `not-listed`（子会话已不在会话目录）时，展示的是通用错误文本，未针对该错误码做专门文案。

---

## 鉴权与暴露面

0.7.0 起不再只靠 Host/Origin 的相等比较，因为那个判据可以被 DNS rebinding 绕过。

没有 token、没有登录态，准入靠两条：**Host 必须是真正在监听的地址**，写操作另需**自定义头**。

| 操作 | 规则 |
| --- | --- |
| `GET` | `Host` 的主机名是回环（`127.0.0.1` / `localhost` / `::1` / `[::1]`）→ 放行，但若有 `Origin` 它也必须指向回环；非回环 `Host` 默认拒绝，需写进 `BOARD_ALLOWED_HOSTS`，且 `Origin` 与 `Host` 一致 |
| `POST` | 先满足 `GET` 的规则，**并且**带 `x-dsh-mini-superagent` 头 |

为什么这么改：

- **D A S**（DNS rebinding）能绕过 0.6.0 的判据。攻击者页面在 `http://evil.example:9735`
  （该域名解析到 127.0.0.1），它向同一个源发请求——浏览器的 `Host` 与 `Origin`
  都是 `evil.example:9735`，「两者相等」恒真。而 0.6.0 对不带 `Origin` 的 POST
  直接放行，等于局域网里任意脚本都能打。
- **自定义头挡不住 rebinding**（同源请求不需要预检），所以真正的判据是 Host：
  浏览器无法伪造 `Host`，它来自 URL。回环 Host 放行是安全的——攻击者页面想让浏览器
  发出 `Host: 127.0.0.1:9735`，就必须真的去连 127.0.0.1，那时 `Origin` 是 `evil.example`，
  会被回环分支的 Origin 检查拒掉。
- 自定义头的作用是防**同源页面之外的脚本**与简单 CSRF：跨站发带自定义头的请求会触发
  预检，预检不带凭据也不带这个头，服务端拒绝后真请求不会发出。

配置：

- `BOARD_ALLOWED_HOSTS`（`src/constants.js`）默认空数组。要开放远程访问，把实际地址
  写进去，例如 `['192.168.1.5:3080']`；`['*']` 放行任意 Host，不推荐。
- 本机命令行/脚本调用写操作时自己带上这个头即可：
  `curl -H 'x-dsh-mini-superagent: 1' -X POST ...`

代价与边界：

- **非回环地址默认不可访问**（0.7.0 的行为变更）。远程浏览器要用的，必须显式放行。
- 看板返回的数据包含 `cwd`、会话 id、报告摘要与错误原文，按敏感信息对待。
- 这仍然不是完整鉴权：同源页面里的 XSS 可以带着这个头发请求。它防的是跨站，不是页面内的脚本。

---

## 与 agent 工具的关系

- 看板**没有**新增工具；它调用 `Dispatch.cancel` / `Dispatch.retry` / `Dispatch.archiveStale` / `Dispatch.setTarget`。
  agent 侧的工具在 0.5.0 是 9 个（多了只读的 `dispatch_workspaces`），但看板本身不提供工具。
- 看板的「取消」等价于 agent 调 `dispatch_cancel`（状态与并发位语义一致）。
- 看板的「重试」是给人用的：能恢复就续跑（与 `dispatch_message` 同一条投递路径），不能恢复就新开会话重投简报。
- 看板的「派发目标」是输入框选择器的数据源；`dispatch_launch` 没显式给 `workspace` 时读它。
- 主会话要续跑一个任务，仍然用 `dispatch_message`；不要因为看板有按钮就以为多了一个工具。

---

## 已知限制

- **界面未在真浏览器里跑过**：客户端模块要页面重载才挂载，本轮只做了代码审查 + Host 单测。不能断言的有：
  控件在工具行的实际对齐与截断、弹层翻转与边缘夹取、`@` 与官方 `@reference` 混排观感、chip 刷新后能否从草稿恢复、
  `openSession` 成功后视图是否真切换、深浅主题对比度、`not-listed` 的真实错误码。
- **列表上限 200 条**：超出部分不显示，但 `counts.total` 仍是全量；没有分页。
- **没有历史归档**：来源是内存任务表（重启时从 `tasks.json` 读回），不查库、不查子会话日志。
- **轮询固定 2 秒**：不可配置；页面隐藏时暂停。
- **数据可能陈旧**：取数失败时保留上一次成功快照并提示，不自动清空。
- **看板不按会话过滤**：它展示整个实例的任务；agent 侧要按会话看用 `dispatch_list`。
- ~~POST 无 Origin 即放行~~：0.7.0 已修，见「鉴权与暴露面」。
- **重试不做状态回滚**：续跑依赖 worker 自己的历史；它可能重复执行已经做过的步骤。
- **归档字段现在会渲染，但归档行的历史仍可点**：`openSession` 对已归档会话可能失败（`not-listed`），失败只给通用错误文本。
- **`targets` 只看主会话**：它是「下一次派发往哪派」的偏好，不是任务属性；任务卡上的 `workspace_id` 只反映任务实际派到哪。

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
| `counts.archived` 不涨 | `archiveAfterHours` 是否为 0；任务是否已结算；`updatedAt` 是否够旧 | 调小保留期，或点「立即归档」/`POST /board/archive` |
| `POST /board/archive` 返回 `failed > 0` | 任务卡的 `archive_error`；日志 `归档子会话 … 失败` | 宿主是否支持 `workspaceRegistry.archiveSession`；会话/目录是否还在。失败会在下次巡检重试 |
| 「全部」chip 数比 `counts.total` 少 | 正常 | 「全部」不含已归档；「总计」与「全部」一致，归档数看「已归档」chip |
| 点行打不开子会话 | 提示条里的原因；任务卡 `worker_session_id` | 会话导航服务不可用，或子会话已归档/不在会话目录（`not-listed`） |
| 工作区下拉是空的 | 快照 `workspaces`；工作区注册表 | 先让插件建默认工作区，或检查 `workspaceRegistry`；空列表时下拉只有「全部工作区」 |
