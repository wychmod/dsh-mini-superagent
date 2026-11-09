# 任务看板

0.3.0 新增、0.5.0 补齐归档与工作区视图、本版（未发布）补齐「已退休」视图与记忆治理口径的常驻面板，
并在同一面板内新增一个**平级的分析数据看板**（与任务看板二选一切换）。Host 半边 `src/board.js` 提供快照、两条只读聚合与四个写操作（取消 / 重试 / 归档 / 派发目标），
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

从上到下（**任务看板**形态；顶部多一条平级切换条，其余布局、字段与操作逐字未改）：

```text
┌ 看板  [任务看板] [分析看板]   任务看板字段与操作保持不变              ┐
├──────────────────────────────────────────────────────────────┤
│ 并发 2/6   排队 1   总计 7   失败 3          更新于 13:42:07 │
│ [全部 7] [进行中 3] [需要处理 3] [已归档 2] [已退休 1]         │
│ [全部工作区 ▾]                              [立即归档]        │
├──────────────────────────────────────────────────────────────┤
│ ● 运行中  重构 auth 模块   批次  第 2 次  3 分 12 秒 [取消]      │
│   项目 A · t-m0abc-1 · 报告 2 · 正在跑集成测试                  │
│ ○ 已完成  迁移 billing 表         已归档  2 小时前              │
│   跟随会话目录 · t-m0abc-2 · 报告 1 · 迁移完成                  │
└──────────────────────────────────────────────────────────────┘
```

- **顶层切换条**：`任务看板 / 分析看板` 二选一，默认停在任务看板。它只决定渲染哪一块，
  任务看板的 state、header、chip、行内操作与历史抽屉一行未改。
  分析看板的布局、口径与刷新见下文「分析数据看板」。
- **顶部指标**：`并发 running/max`、`排队`、`总计`、`失败`（有失败时红字），右侧「更新于 HH:MM:SS」。
  指标来自快照的 `concurrency` 与 `counts`；**「总计」= `counts.total − counts.archived`**（归档只在它自己的 chip 里计数）。
- **效果条**：`完成`、`成功率`、`平均耗时`（中位数）、`并行节省`。它们的口径受**记忆治理窗口**约束：
  只统计 `updated_at >= memory.window.since` 且在最近 `memory.window.tasks` 条之内的已结算任务，
  **归档与退休任务一律不进**。窗口文案（`最近 7 天 / 最近 200 条`）显示在 hover 里；
  快照没有 `memory` 块时降级为「窗口未知 · 全部已结算」，**不假装窗口存在**（否则同一个百分比会在两种口径间悄悄漂移）。
- **过滤 chip（5 个）**：
  - `全部`（默认）：`!archived_at`，**不含已归档**；
  - `进行中`：未归档且 `running`/`queued`；
  - `需要处理`：未归档且 `failed`/`interrupted`/`blocked`；
  - `已归档`：`archived_at` 非空；
  - `已退休`：**不从快照取数**，选中时才走 `GET /board/retired` 单独取（见下文「已退休视图」）。
  前四个 chip 的数字按**当前工作区筛选后**的任务算；退休 chip 的数字来自 `counts.retired`（即 `memory.retired.count`），
  宿主不给 `memory` 时显示 `—` 而不是 `0`——`0` 会被读成「确实一条都没有」。
- **工作区下拉**：`全部工作区` + 快照 `workspaces` 列表；选中后与状态 chip 取交集（先按 `workspace_id` 过滤，再套 chip）。
- **立即归档**：两步确认。第一次点击进入确认态（按钮变「确认归档」），4 秒内不再点自动回落；确认后
  `POST /board/archive`，结果用提示条显示「扫描 N，归档 N，失败 N」。这是**巡检**：按保留期扫全表，
  不是「归档某一条」。
- **任务行**：
  - 第一行：状态点、状态文字、标题、`批次` 徽标（`group` 非空）、`第 N 次`（`attempt > 1`）、`已归档` 徽标与相对时间、走表耗时、操作按钮。
  - 第二行：工作区名（`workspace_title`，为空显示「跟随会话目录」）、`task_id`、报告数、报告摘要首行。
  - 失败任务额外一行错误原文；归档失败额外一行「归档失败：…」。
  - 悬停标题可看到 `task_id`、`cwd`、`worker_session_id`；可点行再加「点击打开子会话」。
- **归档行**：整行 0.55 透明度、状态点转灰、无脉动、**没有任何操作按钮**（含「归档」自己不重复出现）；相对时间按 `刚刚 / N 分钟前 / N 小时前 / N 天前` 显示。
- **批次聚合**：`group` 非空的行以该组在服务端底序里第一次出现的位置为锚点，把同组任务整体挪到一起（只改视觉顺序，不动底序）。
- **跳转会话**：整行可点（`worker_session_id` 非空时），`Enter`/`Space` 同样触发；按钮会吞掉冒泡。
  成功时不提示；失败显示「打不开子会话 `<id>`：<原因>」；**已归档的行不可点**（见下节「跳转会话」）。
- **状态点**：颜色 + 文字双通道，不只靠颜色。只有 `running` 脉动；`prefers-reduced-motion: reduce` 下动画关闭。
- **耗时**：`queued` 显示「等待中」；`running` 在两次轮询之间每秒走表（服务端 `elapsed_ms` + 本地经过时间）；
  其余状态用服务端算好的值。不足 1 秒按 1 秒显示。
- **按钮**：一行可能有**两个**按钮——「主操作」+「归档」。
  - 主操作：`running`/`queued` → 「取消」；`failed`/`interrupted`/`ended`/`blocked` → 「重试」；`done`/`cancelled`/已归档 没有主操作。
  - 归档：`interrupted`/`failed`/`blocked`/`ended`/`done`/`cancelled`（**全部终态**）都有；`running`/`queued` 没有——
    归档会把还在写的会话冻成只读。已归档的行不再给归档按钮。
  - 主操作请求期间按钮置灰并显示「取消中… / 重试中…」，成功后立即重取快照。
  - 归档同样走**两步确认**（第一次点击按钮变「再点一次确认归档」，4 秒内不再点自动回落），
    确认后 `POST /board/archive-task`，请求期间显示「归档中…」。
    提示条分两种：干净归档说「已归档（历史里仍可查到）」；**子会话没归档成功**说
    「已归档，但子会话没归档成功：<原因>」——那是黄色警告，不是错误（任务确实已经离开待办区）。
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
| GET | `/dsh-mini-superagent/board` | 返回整块快照（含 `memory` 块），响应头 `cache-control: no-store` |
| GET | `/dsh-mini-superagent/board/retired` | 只读：已退休任务的留痕，`{ok, count, dropped, entries[]}` |
| GET | `/dsh-mini-superagent/board/stats` | 只读：效果 / 拆解视图的全量聚合（plans/09 口径） |
| GET | `/dsh-mini-superagent/board/analytics` | 只读：分析数据看板的队列聚合（口径见「分析数据看板」） |
| POST | `/dsh-mini-superagent/board/cancel` | body `{"task_id":"t-..."}`，取消任务 |
| POST | `/dsh-mini-superagent/board/retry` | body `{"task_id":"t-..."}`，重试任务；**再带 `message` 时是续派**（见下） |
| POST | `/dsh-mini-superagent/board/archive` | 无 body，立即跑一次归档巡检（**全量**，按保留期） |
| POST | `/dsh-mini-superagent/board/archive-task` | body `{"task_id":"t-..."}`，归档**指定**的一条任务 |
| POST | `/dsh-mini-superagent/board/target` | body `{"session_id":"session-...","workspace":"id/路径/标题或空串"}`，设置/清除派发目标 |
| GET | `/dsh-mini-superagent/board/selfcheck` | 诊断：宿主侧能力、工作区、默认主会话、`client.inGraph` / `client.ready`、启动图模块列表、`memory` 口径 |
| POST | `/dsh-mini-superagent/board/client-ready` | 浏览器半边在 `apply` 末尾自报 `{ok, registered:[...]}`，宿主记进 `client.ready` |

请求体上限 64 KiB，必须是合法 JSON（`/archive` 不需要 body）。

**准入分档**：只读端点（`GET /board`、`GET /board/retired`、`GET /board/stats`、
`GET /board/analytics`、`GET /selfcheck`）走 `readAllowed`，
写端点走 `writeAllowed`（= 读的规则 + 自定义头）。**`GET /board/retired` 不要求 `x-dsh-mini-superagent` 写头**：
它只读、不含正文、只回答「这条任务什么时候因为什么被移出账本」，把它当写操作对待会让 `curl`、
脚本、以及将来任何只读看板都得多带一个无意义的头。退休本身**不是**写操作——退休由宿主封顶逻辑决定，面板只能看。

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
  "version": "0.8.0",
  "generatedAt": "2026-11-05T10:42:07.000Z",
  "concurrency": { "running": 2, "queued": 1, "max": 6 },
  "counts": { "total": 7, "running": 2, "queued": 1, "done": 2, "blocked": 1, "failed": 1, "cancelled": 0, "ended": 0, "interrupted": 0, "archived": 2, "retired": 3 },
  "workspaces": [ { "id": "ws-…", "title": "mini-superagent", "path": "C:\\Users\\…\\Documents\\mini-superagent" } ],
  "targets": { "session-…": { "workspace_id": "ws-…", "title": "项目 A", "path": "D:\\proj\\a" } },
  "truncated": null,
  "memory": {
    "window": { "days": 7, "tasks": 200, "since": "2026-10-29T10:42:07.000Z", "count": 5 },
    "ledger": { "tasks": 7, "retired": 3, "archived": 2, "retiredDropped": 0, "capPerTask": { "summary": 6000, "detail": 4000 } },
    "admission": { "direct": 12, "ledger": 40, "directStatuses": ["done", "blocked", "failed", "cancelled"] },
    "pending": { "inputs": 1, "unknown": 0 },
    "retired": { "count": 3, "latestAt": "2026-11-05T09:00:00.000Z" }
  },
  "tasks": [ { "task_id": "t-m0abc-1", "…": "…" } ]
}
```

- `counts` 按**全量**任务统计；`archived` 是带 `archivedAt` 的任务数（不是状态）。
- `counts.retired` 取 `memory.retired.count`——退休任务**不在** `tasks` 里，所以只能从 `memory` 拿。
  拿不到就是 `0`（= 这块信息宿主没提供），不是「一条都没有」。
- `workspaces` 是工作区注册表快照（`id` / `title` / `path`），注册表不可用时为空数组；面板用它做工作区下拉。
- `targets` 是每个主会话当前的派发目标（`session_id → {workspace_id,title,path}` 或 `{auto:true,…}`）；没有目标的会话不出现。
- `tasks` 最多 200 条；排序：`running` → `queued` → 其余按 `updated_at` 倒序；同权重按 `updated_at` 倒序。
- `truncated`：任务总数超过 200 时为 `{shown, total}`，否则 `null`。**这是给界面的提示**——没有它的时候「总计 500 / 列表 200」看起来像数据丢了。
- `version` 来自 `src/constants.js` 的 `VERSION`（当前 `0.8.0`）。
- `memory`：记忆治理口径，**形状逐字冻结**为 `memoryStats()` 的返回值。五块的含义：
  - `window`：指标窗口（最近 `days` 天 / `tasks` 条，`since` 是窗口起点 ISO 串，
    `count` 是窗口**实际命中**的条数——未套 `tasks` 上限，按 `updated_at`（没有则 `settled_at`）
    落在 `since` 之后且**非归档**判定，与客户端「效果条」那一条口径一致）。
    `count` 的作用是让窗口**能被账本核对**：没有它，`window` 只是一份配置回显，
    而 `ledger.tasks` 报的是活表全量（含归档、含窗口外），两个数谁也解释不了谁；
  - `ledger`：**活表**条数、退休留痕数、归档数、被丢弃的留痕数（`retiredDropped`，**不落盘、重启归零**）、单条报告预算；
    `ledger.tasks + retired.count` 才是「曾经有过多少任务」；
  - `admission`：准入决策计数（`direct` / `ledger`）与当前直通状态列表（`directStatuses` 含硬编码终态）；
  - `pending`：仍在 TTL 内的「已投递未读」数与已降级成 unknown 的数量；
  - `retired`：留痕条数与最近一次退休时刻。
  **`memory: null` 是合法值**：旧版宿主、headless 宿主、或 `memoryStats()` 抛错时都是 `null`。
  显式给 `null` 而不是省略字段，是为了让客户端能区分「宿主没提供」与「这是旧版宿主」——两者都按「窗口未知」降级，
  但排障时看得出差别。

### 一个必须写下来的实现细节：`memoryStats()` 是 async

`Dispatch.memoryStats()` 现在是 **async** 的（读活表与留痕两份，将来还可能读更多）。于是：

- **`GET /board` 必须 `await` 之后再传进去**：`boardSnapshot(dispatch, await resolveMemory(dispatch))`。
  漏了 `await` 会把一个 Promise 塞进快照，而 `JSON.stringify(Promise)` 得到 `{}`——
  客户端会看到一个**空的 memory 块**，然后以为「宿主给了一个空块」，比 `null` 更难排查。
- **快照层必须保留同步降级**：`boardSnapshot(dispatch, memory)` 的第二个参数省略时，
  它会自己试一次同步取值；拿到 thenable 就**给 `null`**（`memoryOf()` 里的
  `if (stats && typeof stats.then === 'function') return null`），绝不把 Promise 传下去。
  这样任何直接调 `boardSnapshot(dispatch)` 的旧代码、测试或脚本都不会被 async 化影响。
- `resolveMemory()` 是唯一负责「await 掉 thenable」的地方，失败一律返回 `null`：
  **指标口径坏掉不该让人看不见任务。**
- `POST /archive` 的响应里也有 `counts`，它走同一条 `await resolveMemory(...)` 路径。

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
| `input_pending_at` | ISO 8601 \| null | 「已投递未读」的投递时刻；**只在仍在 TTL 内时才有值**（超时被改写成 `input_unknown_at`） |
| `input_read_at` | ISO 8601 \| null | worker 真把这条消息读进上下文的时刻 |
| `input_unknown_at` | ISO 8601 \| null | 「不知道读没读到」的判定时刻（P0-4 的 TTL 到期）。看板据此**不再显示「待读」** |
| `error` | string | 仅失败任务出现，启动失败原因 |

> `input_pending_at` 与 `input_unknown_at` 的区别要记住：前者是**待读**（一个更强的断言：消息还在收件箱里等人读），
> 后者是**不知道**（更弱也更诚实的断言）。`card()` 里 unknown 会压过 pending——
> 弱断言不该被强断言盖住。宿主不发 `session/event` 的部署里，`input_pending_at` 曾经会**永久**挂着
> 「已投递未读」，比不显示更误导人。

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

`POST /archive-task` 归档**一条**指定任务（任务行上的「归档」按钮走这里）：

```json
// 请求
{ "task_id": "t-xxx" }
// 成功（子会话也归档成功）
{ "ok": true, "archived": true, "task": { "task_id": "t-xxx", "archived_at": "…", "frozen_at": "…", "…": "…" } }
// 成功（任务归档了，但子会话没归档成功 —— 决策 B）
{ "ok": true, "archived": true, "reason": "会话已不存在", "task": { "…": "…", "archive_error": "会话已不存在" } }
```

- `archived`：本次是否**真的**写了归档标记。已归档的任务再调一次返回 `archived: false` 且不改时间戳（**幂等**）。
- `reason`：只在「归档了但子会话没归档成功」时出现，内容等于 `task.archive_error`；HTTP 仍是 `200`（归档动作本身成功了）。
- **错误码**：缺 `task_id` → `400`；任务不存在 → `404`；`running` / `queued` → `409`
  （`任务 t-xxx 还没结算（running），不能归档；要停掉它请用取消`）。
- 与 `POST /archive` 的分工见下文「两条归档入口」。

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
- `/target` 的工作区解析走 `WorkspaceGateway.resolve()`，**任何一级命中多个都会返回 409**（而不是静默取第一个）。
  错误文本里的候选带 `path`：**同名工作区之间 id 没有区分度**（仓库根与包根都可能叫 `dsh-mini-superagent`），
  只有路径能让人分清是哪一个。这是本版（未发布）的行为变化，旧文档写的「标题精确匹配」暗示它唯一、无歧义，那是错的。
  细节见 [workspaces.md](workspaces.md)。

### 续派：`POST /retry` 带 `message`

行内「续派」按钮（只出现在**已结算**的行上）走的就是这条既有路由，**没有新造路由**：

```json
// 请求
{ "task_id": "t-xxx", "message": "把 lint 也跑一遍" }
// 成功（任务重新变为 running）
{ "ok": true, "task": { "task_id": "t-xxx", "status": "running", "…": "…" } }
// 任务还在跑
{ "ok": false, "error": "任务 t-xxx 还在 running，不能续派：等它结算后再补要求，或先取消" }   // 409
```

为什么复用 `/retry` 而不是加一条 `/continue`：「往这条任务的子会话里投一条消息，让它接着干」
是同一条通道，`retry()` 内部走的也是 `dispatch.message()`。区别只有消息文本——重试按状态挑
一句固定指令，续派用用户自己写的那句话。多一条路由等于多一套准入、多一组错误码，以及多一次
「两条路径什么时候开始分叉」的维护。

| 判据 | 行为 |
| --- | --- |
| `message` 缺省或只有空白 | 按原来的重试处理（`retry()`，`attempt` +1）；任务**已归档**时 `409`——归档是只读冻结，重试也不能复活它（`retry()` 的续跑与换会话两条分支都挡在入口） |
| `message` 有内容 + 任务**已结算** | 续派：`dispatch.continueTask(task, 正文)` |
| `message` 有内容 + 任务 `running` / `queued` | `409`，一条消息都不投。不能把要求插进正在跑的回合 |
| `message` 有内容 + 任务**已归档** | `409`：归档是只读冻结，不能再往里续派 |
| `message` 有内容 + 任务**已退休** | `409`：记录已移出活表，没有上下文可用 |
| 投递**途中**任务被取消 | `409`：取消优先，任务保持已取消（不会被这次投递复活） |
| `message()` 抛错（子会话不可用） | `409`，错误文本原样透给看板 |
| 打到 `/cancel` 时 body 里带 `message` | 忽略它，仍按取消处理（别让它悄悄变成两条副作用） |

续派消息的前缀来自 `src/dispatch.js` 的 `continueLead()`，与 agent 侧的
`dispatch_launch({ continue_task_id })` **同一份**：同一条要求从工具与看板两条入口进来，
worker 看到的东西必须一样。语义、三个代价与四条硬校验见 [tools.md](tools.md) 的「续派」一节。

**两个入口共用一条投递路径**（`dispatch.continueTask()` → `dispatch.message()`）：
归档 / 退休 / 会话形状这三条准入写在同一个地方，看板入口不再绕开它们。
0.8.x 之前看板那条直接调 `dispatch.message()`，于是可以对**已归档**的任务续派、
可以往不是本插件建的会话里塞要求——同一个动作两套准入。

界面上不弹「成功」提示条：续派成功后看板里不会多出一行，唯一可见的变化是这条任务从
「已完成」变回「运行中」——那本身就是结果。**失败**才弹，因为用户写的那句话还在输入框里，
不能悄悄吞掉。输入框展开时会显示一句代价提示（「续派不新建任务…列表里仍然只有这一行」），
否则用户会以为按钮没生效。

### GET /board/retired（已退休视图）

只读诊断视图，回答「这条任务什么时候、因为什么被移出账本」。准入与 `GET /board` **同档**（`readAllowed`），
**不要求 `x-dsh-mini-superagent` 写头**。

成功：`200`，`content-type: application/json; charset=utf-8`，`cache-control: no-store`。

```json
{
  "ok": true,
  "count": 3,
  "dropped": 0,
  "entries": [
    {
      "task_id": "t-m0abc-1",
      "title": "重构 auth 模块",
      "status": "done",
      "retired_at": "2026-11-05T09:00:00.000Z",
      "retired_reason": "cap-count",
      "archived_at": null,
      "updated_at": "2026-10-01T08:00:00.000Z",
      "summary": "迁移完成，遗留两条未跑集成测试"
    }
  ]
}
```

- `entries` **最多 200 条**，按 `retired_at` **倒序**（最近的退休最该被看到——它最可能是用户刚发现「任务不见了」的那条）。
- `dropped`：超过 200 条时明说少给了多少，而不是悄悄截断。它来自 `count - entries.length`，
  与 `memory.ledger.retiredDropped`（**进程内被丢弃的留痕数**）是两件不同的事，别混：
  前者是「这个视图没显示全」，后者是「留痕列表本身已经丢了」。
- `dispatch.retired` 不存在时（旧版宿主 / headless / 实现未落地）返回**空表**
  `{"ok":true,"count":0,"dropped":0,"entries":[]}`，不 500——这是一个只读诊断视图，
  宿主没这个能力就该显示「没有」，不该让面板崩。
- 每条记录**只有摘要，没有正文**：`summary` 是退休时留下的 200 字单行摘要，
  `reports` 正文随任务记录一起消失（这是「退休」的定义——`ledgerMaxRetired` 要守住体积，
  搬正文到另一个 Map 只是换个地方存）。
- `retired_reason` 是稳定机器串（`cap-count` / `cap-days`），客户端映射成中文「条数上限 / 超过保留期」；
  未记录原因时显示「未记录原因」，**不要**把机器串直接甩给用户。
- 退休记录**不挂子会话**（`worker_session_id` 不返回）：会话可能已归档或已不存在，点行跳转没有意义。
  视图里只能复制 `task_id`，再用 `dispatch_inspect` 去查（`dispatch_inspect` 对退休任务仍返回留痕，带 `retired: true`）。

### GET /board/stats（全量统计聚合）

只读聚合，回答「这段时间干得怎么样」。准入与 `GET /board` **同档**（`readAllowed`），
**不要求** `x-dsh-mini-superagent` 写头。契约见 [../../plans/09-board-analytics.md](../../plans/09-board-analytics.md) §六.1。

为什么单独一条路由而不是塞进 `GET /board`：快照每 2 秒轮询一次、**只带 200 条任务**，
拿它算比例分母从一开始就是错的；统计要遍历完整账本（含退休留痕），偶尔查一次就够。

查询参数（都可省略）：

| 参数 | 取值 | 缺省 |
|---|---|---|
| `window` | `24h` / `7d` / `30d` / `all` | 沿用 `memoryWindowDays`（默认 7 天） |
| `workspaceId` | 工作区 id | 不过滤，按**派发目标** `workspace_id` 筛 |
| `hostWorkspaceId` | 工作区 id | 不过滤，按**实际归属** `host_workspace_id` 筛 |

两个工作区参数是**两个维度**：同时给是交集，不互相替代（没有派发目标的任务照样有实际归属）。
非法 `window` 不报错，退回默认并在 `scope.window.fallbackFrom` 里记下原始输入，
让前端能显示「筛选条件无效，已退回 N 天」而不是静默换一个窗口。

成功：`200`，`cache-control: no-store`。顶层字段与规划书逐字段对齐：

```text
{ statsVersion, generatedAt,
  scope:    { window: { key, days, since }, workspaceId, hostWorkspaceId },
  coverage: { sourceTasks, inWindow, settled, validDurations, excludedArchived,
              excludedRetired, missingTimes, truncated, timeBasis, fallbackCount },
  summary:  { outcome, durations, parallel, reliability },
  daily:    [{ day, created, done, failed, blocked, interrupted, medianDuration, saved }],
  groups:   { workspaces: { dimension, byTarget, byHost }, batches, parentSessions,
              statuses, retiredReasons } }
```

口径要点（每一条都能追到分子分母）：

- **完成率分母是 `done + ended + failed + blocked + interrupted`，取消不进分母**；
  取消率（`cancelRate`）单列，分母是全部已结算（含取消）。两个比例共用分母等于把
  「用户改了主意」算成「任务没做成」。
- **n=0 时值是 `null` 而不是 `0`**（达成率、P50/P90、并行节省…）；`1 ≤ n < 5` 时照给数值
  但带 `sampleLow: true`。`0%` 与「没有样本」在界面上必须长得不一样。
- **归档与退休不投票**：归档任务（`archivedAt`）与退休留痕都不进效果指标，但分别计入
  `coverage.excludedArchived` / `coverage.excludedRetired`，不会悄悄消失。
- **时间基准要能区分**：新数据用权威 `settledAt`，旧数据回退 `updatedAt` 时
  `coverage.timeBasis` 报 `updatedAt-fallback`（两种混用报 `mixed`），`fallbackCount` 给条数。
  `updatedAt` 会被报告、追问、归档刷新，拿它算精确生命周期统计会把「大概」冒充成「精确」。
  这两个字段**同源且只说窗口内的事**：`timeBasis` 描述的是**这个窗口**里那些行的基准，
  窗口外的历史不参与（否则会出现「口径混用了」却「一条回退都没有」的自相矛盾）。
  恒等式：`timeBasis = mixed` ⇒ `fallbackCount ≥ 1`。
- **可靠性块受工作区约束**：`summary.reliability` 是「当前健康」，**不看窗口**
  （一条跑了 10 天的任务不能因为窗口是 24h 就从健康面板里消失），但**看工作区**——
  筛了 ws-1 之后，未投递报告只数 ws-1 的那条。
- **并行节省是粗算**：`max(0, Σ占用 - 墙钟跨度)`，`estimated` 恒为 `true`（它不是工时结算）；
  `degraded` + `reasons` 说明「为什么更粗」（样本少 / 有回退基准 / 有夹紧跨度 / 留痕有丢失）。
- **不装全量**：`truncated` 非 `null` 时界面必须显示「结果可能低估」，不能装作全量。

统计失败（聚合抛错）时返回 `200` + 与成功结果**同构**的最小结构：
`{ ok: false, degraded: true, reason, summary: null, daily: [], groups: {...空容器} }`。
**不是 500**：面板每 2 秒轮询，一个 500 会让客户端进入「报错→重试→再报错」的循环，
而任务列表其实还是好的。总览继续按快照工作，效果区显示「统计暂不可用」。

### GET /board/analytics（分析看板聚合）

只读聚合，服务新加的「分析数据看板」，准入与 `GET /board` / `GET /board/stats` **完全同档**
（`readAllowed`，不要求写头）。它同样遍历**完整账本**（`dispatch.table.tasks` 全量 + 退休留痕计数），
不受 `/board` 的 200 条快照上限影响；但**口径与 `/board/stats` 刻意不同**：

| | `/board/stats` | `/board/analytics` |
| --- | --- | --- |
| 视角 | 效果视图：按**结算时刻**归属窗口 | 队列视图：按**创建时刻** `createdAt` 选出「这段时间派出的任务」 |
| 归档 / 退休 | 不进效果指标，另在 coverage 里计数 | 归档任务仍在账本，**计入总量与分母**；退休留痕单列不并入 |
| 时间窗 | 不隐藏当前工作（running/queued 不看窗口） | 只看窗口内创建的任务；`all` 连缺创建时间的行也收进来 |
| 服务视图 | 既有的「效果 / 拆解」 | 新增的「分析看板」 |

两套口径各自在界面上写明分母，**不互相复用中间结果**。查询参数、响应形状、指标口径表与状态处理
统一写在下文「分析数据看板」。聚合抛错时与 `/stats` 一样返回 `200` + 同构降级结构，不返回 500。

### 已退休视图（面板里的第五个 chip）

- chip 名为「已退休」，**排在「已归档」之后**。
- 它**不从快照取数**：`FILTERS` 里这一项的 `match` 恒为 `false`（退休记录根本不在 `tasks` 数组里），
  选中时才触发一次 `GET /board/retired`。计数来自 `counts.retired`（= `memory.retired.count`）。
- 取数时机与 2 秒轮询**解耦**：退休记录一旦生成就不再变化（它描述的是「已经消失」这件事），
  跟着快照每 2 秒拉一次纯属浪费，也会让视图在手滑时闪。只有 `generation` 变化（用户点重试 / 归档后再进来）才重取。
- 三种空态要分开，别混成一句「没有」：
  - `memory` 为 `null` → 「宿主未提供退休记录」（旧版/headless，**不是**「没有退休记录」）；
  - 取数失败 → 「退休记录暂时取不到：<原因>」；
  - 真的空 → 「没有被退休的任务」。
- 行内显示：标题、状态、`退休于 <相对时间>`、原因徽标；整行 0.7 透明度、无按钮、不可点行。
- 顶部提示条：`dropped > 0` 或 `memory.ledger.retiredDropped > 0` 时显示
  「另有 N 条退休记录超出展示上限，未在此列出」。

---

## 分析数据看板（任务看板平级）

### 定位与装配

任务看板回答「现在要我做什么」，分析看板回答「这段时间派出去的活，总量、状态、完成、超时、趋势各是什么」。
两者**共用一个侧边栏入口**，由面板顶部的一条切换条选择，默认停在任务看板：

| 形态 | 渲染 | 任务看板可用性 |
| --- | --- | --- |
| `任务看板` | 原有 header / chips / 工具条 / 三段列表，前面只多一条切换条 | 完全不变（字段、入口、取消 / 重试 / 归档 / 续派 / 跳会话 / 历史抽屉） |
| `分析看板` | 只渲染 AnalyticsView | 不渲染；2 秒快照轮询**在分析看板可见时停掉**（否则整个分析视图每 2 秒重建一次），切回任务看板时立刻恢复 |

`client/index.js` 里所有新 state / effect 都追加在 `BoardPanel` 的**末尾**：既有 hook 序号一个不动，
`AnalyticsView` 是无 hook 的纯展示组件。这样离线冒烟（按序号复用 store 的迷你 React）仍能断言
「切筛选 → 重取 → 数字跟着变」，而不是只能验真机。

布局（宽容器时 KPI 2×2，窄容器 1 列；趋势与分布都是 div 条形 + 表格等价物，**没有图表库**）：

```text
┌ 看板  [任务看板] [分析看板]                                      ┐
├ 分析数据看板   汇总于 16:05:15                                    ┤
├ 时间范围 [24h][7d][30d][全部] 自定义天数[  ][应用]              ┤
│ 状态[▾] 负责人[▾] 工作区[▾] 批次[▾] 超时阈值[▾] [清除筛选][刷新]│
├ 样本口径 账本 16 · 窗口内 14 · 命中 14 · 退休留痕 3（不并入）    ┤
│  ⚠ 账本没有人员字段，负责人按派发主会话代理（待业务确认）        │
│  ⚠ 账本没有截止时间字段，逾期为时长代理指标（待业务确认）        │
├ 任务总量 14 │ 完成率 50%  │ 超时代理 0 │ 未结算 4              ┤
├ 趋势变化  较上一等长窗口：新建 +14 / 完成 +5 / 完成率 +6.7pp    ┤
│  [图表][表格]  11-03 ▬▬ 新建 0 · 完成 0 · 异常 0                │
│                11-09 ▬▬▬ 新建 11 · 完成 5 · 异常 3              │
├ 状态分布  运行中 ███████ 3 · 21.4%（点行即筛该状态）            ┤
├ 逾期情况（代理指标） 未结算超阈值 0 / 已结算超阈值 0 / 未知 0   ┤
├ ▸ 统计口径与数据可得性（展开是三列口径表）                      ┤
└──────────────────────────────────────────────────────────────┘
```

### 指标口径表

**口径先行**：所有指标基于**同一批筛选后的任务行**（`matched`），不做第二次过滤。
时间窗按 `createdAt` 归属（队列视角）；`all` 时连缺创建时间的行也计入。
分母为 0 一律给 `null`，界面显示 `—` 而不是 `0%`；`1 ≤ n < 5` 照给数值但带 `sampleLow`。

| 指标 | 分子 / 计算 | 分母 / 时间字段 | 数据可得性 |
| --- | --- | --- | --- |
| 任务总量 | 筛选后任务条数（含已归档） | 窗口按 `createdAt`；`all` 不限时间 | `dispatch.table.tasks` 全量。退休留痕**只在** `coverage.retiredTraces` 单列，不并入 |
| 状态分布 | 每个 `status` 的条数 | 任务总量（分母含归档与取消） | `status` 字段直接计数，零值状态不出表格 |
| 完成率 | `status=done` 的条数 | `done + ended + failed + blocked + interrupted`（`COMPLETION_BASE`）；`cancelled` / `running` / `queued` 排除 | `status`；分子分母都随结果回显 |
| 超时代理 | 未结算：`now − createdAt > 阈值`；已结算：`settle − createdAt > 阈值` | 默认 24h，可选 8 / 24 / 72 / 168h；阈值随结果回显 | `createdAt` / `settledAt`（旧数据回退 `updatedAt`）。**账本没有 `due_at`：不是业务逾期**，`basis: 'proxy:createdAt'`、`pendingFields: ['due_at']` |
| 趋势变化 | 按 UTC 自然日分桶：新建按 `createdAt`，完成 / 异常按 `settledAt`；空天由界面按 `trend.range` 补 0 | 一天一行；`all` 且跨度 > 366 天时裁剪并在 `coverage.trendClamped` 说明 | `createdAt` / `settledAt`。跨天结算会落到另一天，这是口径不是误差 |
| 环比 | 当前窗口 − **上一等长窗口**，套同样的非时间筛选 | 同样按创建时间切队列；`all` 无上一窗口 → `compare.available=false` | 任一窗口无可结算样本时 `rateDelta=null`，界面写「不比较完成率」 |
| 筛选 | 时间 / 状态 / 负责人 / 工作区 / 批次 / 超时阈值，全部**与**关系 | 候选值 `facets.*` 从**未筛选**的全量账本取（选一个筛选项不会让其它选项消失） | 负责人 = `parentSessionId` 代理；工作区 = `workspaceId`；批次 = `group` |

**「负责人」与「逾期」是代理指标，不是既有事实**：账本的任务对象（`src/dispatch.js` 的 `task`）里
没有人员字段，也没有截止时间 / SLA 字段。因此：

- 负责人用「派发主会话」`parentSessionId` 代理，缺字段归到 `__unknown__`（界面写「未标注」）；
- 逾期只统计「创建后超过阈值仍未结算 / 端到端耗时超过阈值」的条数，阈值由用户设定并回显；
- 界面口径行与口径表都写「待业务确认」，响应里带 `warnings: ['owner-proxy', 'due-at-proxy']`；
- **待接入字段**：`assignee` / `owner`（真实负责人）、`due_at`（真实截止时间）。接上后应把
  这两块换成真口径，并保留 `pendingFields` 作为迁移标记；在此之前不要把它们当 SLA 结论用。

### 查询参数与响应

`GET /board/analytics?…`，全部可省略；非法值不报错，在 `scope.warnings` / 界面提示条里退回默认。

| 参数 | 取值 | 缺省 |
| --- | --- | --- |
| `window` | `24h` / `7d` / `30d` / `all` / `<n>h` / `<n>d` | `7d`（自定义天数由界面拼 `<n>d`） |
| `status` | 单个状态或逗号分隔多个 | 全部 |
| `owner` | `parentSessionId` 或 `__unknown__` | 全部 |
| `workspaceId` / `hostWorkspaceId` | 工作区 id（两个维度，交集） | 全部 |
| `group` | 批次名 | 全部 |
| `overdueHours` | 1…720（夹到合法范围） | `24` |

```text
{ analyticsVersion, generatedAt, ok,
  scope:    { window:{key,days,since}, status, statusList, owner, ownerField,
              workspaceId, hostWorkspaceId, group, overdueHours, timeField, warnings },
  facets:   { statuses, owners, workspaces, hostWorkspaces, groups },   // 全量账本的候选值
  coverage: { sourceTasks, retiredTraces, inWindow, matched, excludedByFilters,
              archived, missingCreatedAt, missingSettledAt, fallbackTimeBasis,
              trendClamped, sampleLow, truncated },
  summary:  { total, active, settled, archived, cancelled, byStatus, distribution,
              completion:{done,base,rate,sampleLow,includes,excludes},
              overdue:{thresholdHours,basis,dueAtAvailable,pendingFields,
                       open,settled,unknown,total,rate} },
  trend:    { days:[{day,created,done,failed,blocked,interrupted,cancelled,ended,settled}],
              range:{from,to,days}, compare:{available,current,previous,*Delta} },
  warnings: ['owner-proxy','due-at-proxy', …] }
```

`coverage.sourceTasks` 用来证明「读的是完整账本」；`truncated.mayUnderestimate` 为真（活表触顶、
留痕被丢）时界面写「结果为下界」，**不装全量**。口径不清的字段一律标「待业务确认」，
不编造目标值，也不下管理结论。

两条「不许悄悄消失」的口径：

- **缺 `createdAt` 的行要从 `coverage.missingCreatedAt` 里数出来**。它数的是「过了其它筛选、
  但没有创建时间」的行：有窗口时这类行进不了窗口的分母，但**不能连计数都没有**——
  否则一条真实任务就从「缺时间 n」里也消失了，读者根本不知道分母少了几条。
- **facets 的候选值与筛选的匹配必须同源**。「未标注」（`__unknown__`）这类归一值
  在候选列表与匹配判据里必须**是同一个值**：两处各写一份（一边归一成 `__unknown__`、
  一边拿空串比）会让「未标注」永远筛不出任何东西。

### 四种状态与刷新方案

| 状态 | 触发 | 界面 |
| --- | --- | --- |
| 加载中 | 首次进入 / 切换筛选 / 手动刷新，还没有数据 | 「正在汇总分析数据…」+「读取完整账本，不使用 200 条快照」；有旧数据时**只切 loading 不清内容**，不闪空白 |
| 空数据 | `summary.total === 0` | 「这个筛选下没有任务」+「清除筛选」；不画 0% 卡片 |
| 无样本 | 完成率分母 0、无趋势日、趋势范围无事实 | `—` / 「这个时间范围里没有趋势数据」；`sampleLow` 时加「样本少（n<5）」 |
| 取数失败 / 降级 | 404（旧版宿主）、网络错误、非法 JSON、Host 返回 `degraded:true` | 有旧数据 → 保留内容 + 黄色「展示的是上一次成功汇总的数据」；没有旧数据 → 错误态 + 「重试」+「回到任务看板」。**任务看板始终可用** |

**刷新方案（静态数据 / 定时刷新 / 实时推送三选一）**：本版走**定时刷新**——分析视图可见时
`GET /board/analytics` 每 10 秒取一次，筛选变化与手动「刷新」立即重取；页面隐藏时停表并中止在途请求，
切回可见立刻重取；面板卸载时清定时器与 `AbortController`。任务看板那条 2 秒快照轮询在
**分析看板可见时整条停掉**（不取数也不落状态）——否则每 2 秒落一次快照状态就把整个分析视图
重建一次，两套轮询互相踩；切回任务看板时立刻把轮询叫醒。两条链路**互不阻塞、互不清对方状态**。
Host 聚合是纯内存遍历（不读盘、不发网络），
一次全量账本遍历在刷新的这一档频率下没有可观测成本；真要上实时推送（SSE / WebSocket）
应先证明 2 秒级变化有人看，否则只是把轮询成本搬了个地方。

### 兼容、样式与安全

- **零改动保证**：`GET /board`、`GET /board/stats`、`GET /board/retired` 与四个写路由都没改；
  新增的只是 `src/analytics.js` 和 `GET /board/analytics`。分析数据取不到时任务看板照常工作。
- **样式一致**：复用 `.dsh-sa-card` / `.dsh-sa-dist` / `.dsh-sa-trend-*` / `.dsh-sa-table` / `.dsh-sa-tab`，
  颜色走 `var(--dsw-alias-*, fallback)`，不写死明暗配色；颜色之外一律有文字（读屏与复制不依赖像素）。
- **响应式**：卡片 `auto-fit`、筛选条 `flex-wrap`，并按**容器宽度**（`@container`）而不是视口折行——
  宽显示器上的窄侧边栏同样会切成单列，容器再窄也不会横向溢出。
- **交互**：点状态分布行即把「状态」筛选切到该状态（再点一次取消）；趋势支持图表 / 表格等价双形态，
  图表把连续空天合并成一行（如 `11-02–11-07 ｜ 连续 6 天无任务（空天补 0）`），表格仍逐日给全；
  「空天」的判据与表格列**同源**（新建 / 完成 / 问题 / **取消** / **结束**）——跨天取消的那天
  不是空天，否则图表与表格对同一件事给了两个答案；
  口径表常驻可展开；错误态另有「回到任务看板」入口，正常态用顶部切换条返回。
- **权限与脱敏**：聚合结果含任务标题、会话 id、工作区名与统计值，不含报告正文；仍只对本机 / 同源页面开放
  （`readAllowed`），非回环 Host 默认 403。若把这些数字导出到外部报表或多人共享，先按项目要求脱敏
  标题与路径，并按接收方最小权限控制访问；本看板只做呈现，不做经营判断。

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
- `POST /board/archive` 可手动触发一次巡检；面板顶部的「立即归档」就是它的两步确认版；
- 任务行上的「归档」按钮走 `POST /board/archive-task`，**只归档那一条**（见下节）。

#### 两条归档入口的区别（别混用）

| | `POST /board/archive` | `POST /board/archive-task` |
| --- | --- | --- |
| 作用范围 | **全量巡检**：扫全表，只碰 `updatedAt` 早于 `archiveAfterHours` 且未归档的已结算任务 | **单条**：只处理 body 里那一个 `task_id` |
| 是否看保留期 | 看（默认 24h） | **不看**——用户点了就归档，哪怕它是 1 秒前更新的 |
| 请求体 | 无 | `{"task_id":"t-..."}` |
| 响应 | `{ok, scanned, archived, failed, counts}` | `{ok, archived, reason?, task}` |
| 谁在用 | 面板顶部「立即归档」、启动后的定时巡检（`startArchiveSweep`） | 任务行上的「归档」按钮 |
| 未结算任务 | 直接被跳过（不算候选） | `409`，明确拒绝 |

为什么不用一个接口两种语义：巡检的返回值是**批量口径**（`scanned/archived/failed`），
被既有用例与定时器共用；给它加一个「只处理某条」的开关，会让同一个 URL 在不同 body 下
既有两套返回形状、又有两种副作用。分两个路由之后，两件事各自能被人读懂。

#### 决策 B：子会话归档失败时仍然归档任务，但必须留痕

`workspaceRegistry.archiveSession()` 可能失败——最常见的是会话随宿主重启消失了，
或者任务从启动就失败、**根本没有**活动会话。这类任务如果「归档失败就不归档」，会永远
停在「需要处理」区，正是用户报的「只有重试会一直卡着」。

所以单条归档的口径是：**先写 `archivedAt` + `frozenAt`，再按真实结果决定留不留痕**：

- 子会话归档成功 → 清空 `archiveError`，返回 `{ok:true, archived:true}`；
- 子会话归档失败 → 仍然写 `archivedAt` + `frozenAt`，把真实原因写进 `task.archiveError`，
  返回 `{ok:true, archived:true, reason:"<原因>"}`；看板在任务行上显示「归档失败：<原因>」，
  提示条用**警告**语气说「已归档，但子会话没归档成功：<原因>」。

不许假装干净成功：`reason` 与 `archive_error` 两个字段就是这条口径的证据。
（巡检那条路仍然是老口径：失败不归档、只记 `archiveError`、下次巡检重试。）

**幂等**：`archivedAt` 是「第一次被归档的时刻」。已归档的任务再调 `archiveTask()` 会直接返回
`{ok:true, archived:false}`，不重写时间戳、也不再碰子会话——否则看板上的「N 小时前归档」
会被重复点击反复归零。

归档规则与排障见 [workspaces.md](workspaces.md)。

---

## 记忆治理口径（P0）

看板是唯一能一眼看到「治理到底发生了什么」的地方。四个可观察点，全部来自快照的 `memory` 块
（`memory: null` = 宿主没提供，一律降级不报错）：

| 治理项 | 在看板上怎么看 | 对应行为 |
| --- | --- | --- |
| 指标窗口化 | 效果条数字的 hover 显示 `最近 N 天 / 最近 200 条`；归档与退休不进指标 | 只统计窗口内已结算任务，见上文「效果条」 |
| 准入分级 | 任务行的「待读」徽标只反映**投递**，报告是否回流不进看板（看 `dispatch_report` 的返回值 `admission`） | `progress` 默认只入库；终态恒直通（配置只能扩展、不能降级） |
| 单条预算 | 无 UI 提示；`dispatch_inspect` 的 `recent_reports[].truncated` 记录原始长度 | 入库即 `clip`，不是「截到恰好 N 字」 |
| 生命周期清理 | 「待读」徽标在 TTL 到期后消失（改写 `input_unknown_at`） | 不再把「不知道」显示成「在读」 |
| 账本封顶 | 「已退休」chip + 退休视图；`dropped` 提示条 | 超过 `ledgerMaxTasks` / `ledgerMaxDays` 的任务移出活表 |

**别把「已归档」与「已退休」当同一件事**：归档的任务**还在**快照的 `tasks` 里（`archived_at` 非空，报告正文还能看），
退休的任务**不在** `tasks` 里（只有 `retired` 留痕，没有正文）。看板上它们分属两个 chip，
`dispatch_inspect` 对两者也给出不同结果（退休的返回 `retired: true` 且 `recent_reports` 缺席）。
判据写在 [architecture.md](architecture.md) §27。

---

## 已归档视图

0.5.0 起，归档任务从「全部」里移出，只出现在 `已归档` chip：

- `全部`、`进行中`、`需要处理` 都排除 `archived_at` 非空的任务；
- `已归档` 只显示 `archived_at` 非空的任务；
- 顶部「总计」= `counts.total − counts.archived`，与「全部」chip 对得上；
- 归档行整行 0.55 透明度、灰点、无脉动、**没有任何操作按钮**，显示 `已归档` 徽标与相对时间；
- 归档失败的任务额外显示一行「归档失败：<原因>」（来自 `archive_error`），不随归档隐藏。

这样设计的原因：归档是历史，不是「完成」。混在「全部」里会让日常视图被历史淹没，也会让「总计」与列表数量对不上。

## 历史视图与任务详情抽屉（plans/09 P2）

面板顶部现在是 **四个视图分段**：`总览` / `效果` / `拆解` / `历史`。历史视图回答
「某条任务到底发生了什么」，是唯一按时间倒查记录的视图。

### 数据来源

| 子视图 | 来源 | 是否依赖 `/board/stats` |
| --- | --- | --- |
| `全部` | `GET /board` 快照里的全部任务（含已归档） | 否 |
| `已归档` | 同上的子集（`archived_at` 非空） | 否 |
| `已退休` | `GET /board/retired` 的留痕 | 否 |

**历史视图完全不碰 `/board/stats`**：统计挂了（404、宿主降级）它照常工作。
「查证据」的地方跟着统计一起失效，是 §八.10 最不该出现的结果。

`全部` 子视图**不含**退休留痕：留痕不在快照的 `tasks` 里，混进去会让同一份账本
在两个子视图里给出两个总数。要查退休记录就切到 `已退休`。

### 搜索与筛选

- 搜索（大小写不敏感）：`task_id`、标题、`worker_session_id`、工作区（**两个维度都算命中**：
  派发目标 `workspace_id` 与实际归属 `host_workspace_id`）；
- 状态 / 工作区下拉：状态选项来自客户端唯一那份 `STATUS_META` 键集合，不另抄一份；
- 时间：按**创建时刻**过滤，档位复用 `WINDOW_PRESETS`（24h / 7 天 / 30 天 / 全部）。
  退休留痕没有创建时刻，改用 `retired_at`——否则「最近 7 天」里永远看不到刚退休的那批；
  两边时间都未知的行**不会因为「不知道」被丢掉**，留在列表里显示「没有记录」；
- 开关：`是否重试`（`attempt > 1`）、`是否有后台`（`background` 非空）。

### 排序与分页

- 排序四档：创建 / 结算 / 耗时 / 状态。**缺时间或耗时未知的行一律排到末尾**，
  不会因为 `NaN` 被当成 0 而看起来像「1970 年的任务」；同值按 `task_id` 倒序，
  保证同一份快照每次渲染顺序一致（否则 2 秒轮询会让行在视觉上跳动）；
- 每页 **50 条**，底部固定分页条（`第 from–to / 共 n 条` + 上一页/下一页）。
  `/board` 快照本身最多 200 条，最坏 4 页，不做虚拟滚动；
- 快照被截断时（`truncated`）表格上方给一条「快照只含最近 N 条；更早的请用
  `dispatch_list` / `dispatch_inspect`」，不假装列表是全量。

### 表格列

`任务 | 状态 | 工作区 | 创建 | 结束 | 耗时`。「结束」一列按来源打标签
（`结算` / `退休`），未结算的行显示 `—`；**不拿创建时刻冒充结束时刻**。

### 任务详情抽屉

点任意一行在表格下方展开抽屉（**不是**遮罩层：面板在宿主的槽里滚动，
`fixed` 定位会跑到视口外并盖住别家 DOM）。抽屉七块：

1. **生命周期**：创建 → 开始 → 报告 → 结算 → 归档 → 退休，六步各自一格；
   缺的一步显示「没有记录」而不是留空；
2. **简报与目录**：简报、工作目录 `cwd`、任务目录 `task_dir`、目标工作区、实际归属；
3. **报告与最后输出**：报告数、最后一次报告（时刻 + 状态 + 摘要首行）、最后一次输出节选；
4. **重试与错误**：attempt、错误、归档失败、冻结时刻；
5. **追问投递**：已读 / 待读 / 未读未知三种状态之一 + 时刻；
6. **后台 job / subagent**：数量与起始时刻，被终止时另起一行；
7. **prepare 结果**：准备时刻与任务目录。

**快照里没有、抽屉也拿不到的字段**（浏览器半边没有 `dispatch_inspect` 工具），
一律写明「请用 `dispatch_inspect <task_id>`」，绝不编造：

- 完整简报正文（快照只投影标题）；
- 完整报告正文、更早的报告（快照只有 `report_count` 与最后一条摘要）。

「打开子会话」按钮只在 **有 `worker_session_id` 且未归档且不是退休留痕** 时出现。
其余情况只给「复制 id」，并说明原因——归档会话会被宿主清成空白主视图，
退休留痕连会话都不在了。退休记录另有一句「已退休：报告正文不可用」。

## 工作区分组

- 每行第二行显示 `workspace_title`；为 `null` 时显示「跟随会话目录」。
- 顶部工作区下拉列出「全部工作区」+ 快照 `workspaces` 的标题；选中后先按 `workspace_id` 过滤，再套状态 chip，两者取交集。
- chip 上的数字按**当前工作区筛选后**的任务计算，不是全量。
- `group` 非空的任务（`dispatch_launch_many` 派出的批次）带「批次」徽标；渲染时以该组在服务端底序里第一次出现的位置为锚点，
  把同组行聚到一起。服务端排序骨架（`running` → `queued` → 其余 `updated_at` 倒序）不变，聚合只发生在客户端。

## 跳转会话

- 整行可点（`worker_session_id` 非空**且未归档**时），鼠标点击与 `Enter` / `Space` 都会调
  `ctx.get('uiWorkspace').openSession(worker_session_id)`。
- 行内的取消/重试按钮会 `stopPropagation`，不会误触跳转。
- 失败处理：
  - `uiWorkspace` 服务不可用 → 「打不开子会话 `<id>`：会话导航服务不可用」；
  - `openSession` 抛错 → 「打不开子会话 `<id>`：<原因>」；
  - 任务没有 `worker_session_id` → 「这个任务没有可打开的子会话」。
- **已归档的行不可点**：不挂 `onClick` / `onKeyDown`、没有 `tabIndex`、没有手形光标，
  用 `aria-disabled="true"` + `aria-description`/`title` 说明「该子会话已归档，不可直接打开；
  请在会话列表里取消归档后再查看」。`openWorker` 里还有第二道闸：任务带 `archived_at` 就只给提示、
  **绝不调** `openSession`。
- **为什么是「不可点」而不是「打开原会话」**：归档记录里的 `worker_session_id` 仍在（所以数据上是可解析的），
  但宿主的 `uiWorkspace.openSession(id)` 只负责换主视图；ui-workspace 的 `watchNavigation()` 里有
  `clearArchivedCurrent()`，一旦发现主视图的会话在 `archivedSessionIds` 中就直接 `clearMain()`，
  主区域随后被补建成空白会话 —— 这正是「点已归档任务会跳到新会话」的根因。
  DSH 自己的侧边栏对归档会话也只提示「已归档对话暂时无法查看，请取消归档后查看」而不打开，本插件对齐同一口径。
  换成「先取消归档再打开」属于写操作，不该由一次点击的副作用触发。
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
- 看板的「续派」等价于 agent 调 `dispatch_launch({ continue_task_id })`（**也是**一条 `dispatch_message`，
  不新建任务）。区别只在文案：工具侧会先做归属 / 工作区 / 「别的活跃任务」这几条**只有调用方知道**的校验，
  看板侧没有调用方，因此只做与任务自身有关的准入（已归档 / 已退休 / 会话形状）——
  两条入口的这部分准入**共用 `dispatch.continueTask()` 一份实现**，不会分叉。
- 看板的「归档」等价于 `POST /archive-task`（单条），不是 `POST /archive`（巡检、扫全表）。
- 看板的「派发目标」是输入框选择器的数据源；`dispatch_launch` 没显式给 `workspace` 时读它。
- 主会话要续跑一个任务，仍然用 `dispatch_message`（或 `dispatch_launch({ continue_task_id })`）；
  不要因为看板有按钮就以为多了一个工具。

---

## 已知限制

- **界面未在真浏览器里跑过**：客户端模块要页面重载才挂载，本轮只做了代码审查 + Host 单测。不能断言的有：
  控件在工具行的实际对齐与截断、弹层翻转与边缘夹取、`@` 与官方 `@reference` 混排观感、chip 刷新后能否从草稿恢复、
  `openSession` 成功后视图是否真切换、深浅主题对比度、`not-listed` 的真实错误码。
- **列表上限 200 条**：超出部分不显示，但 `counts.total` 仍是全量；没有分页。
- **退休视图上限也是 200 条**：超出用 `dropped` 明说，没有分页、没有关键字过滤。
- **没有历史归档**：来源是内存任务表（重启时从 `tasks.json` 读回），不查库、不查子会话日志。
- **退休留痕可能被丢弃**：`ledgerMaxRetired`（默认 5000）超限时丢最老的，
  `retiredDropped` 是**本次进程内**丢弃的条数，**不落盘、重启归零**——看到它变小或变 0 不代表数据回来了。
- **轮询固定 2 秒**：不可配置；页面隐藏时暂停。退休视图不跟着轮询，只在进入视图或 `generation` 变化时取一次。
- **数据可能陈旧**：取数失败时保留上一次成功快照并提示，不自动清空（退休视图同理，保留旧数据只切 loading 态）。
- **看板不按会话过滤**：它展示整个实例的任务；agent 侧要按会话看用 `dispatch_list`。
- **效果数字受窗口约束**：成功率、中位耗时、并行节省只算窗口内（默认最近 7 天 / 200 条）的已结算任务，
  **且排除已归档与已退休**。拿它跟旧版本的数字对比会不一致——先看 hover 里的窗口口径。
  宿主没提供 `memory` 块时降级成「全部已结算」，这时它**不等于**窗口口径，别混为一谈。
- ~~POST 无 Origin 即放行~~：0.7.0 已修，见「鉴权与暴露面」。
- **重试不做状态回滚**：续跑依赖 worker 自己的历史；它可能重复执行已经做过的步骤。
- **归档字段现在会渲染，但归档行的历史仍可点**：`openSession` 对已归档会话可能失败（`not-listed`），失败只给通用错误文本。
- **退休行不可点**：退休记录没有 `worker_session_id`，会话可能已归档或已不存在，跳转没有意义，只能复制 `task_id`。
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
| 「已退休」chip 显示 `—` | 快照 `memory` 是否为 `null` | 宿主版本较旧或没启用记忆治理；`GET /board/retired` 仍可单独调，能返回空表 |
| 「已退休」是空的但确实退休过任务 | `GET /board/retired` 的 `count` 与 `entries.length` | `count > 0` 但 `entries` 空 → 取数失败；`count: 0` → 留痕已被 `ledgerMaxRetired` 丢弃（看 `memory.ledger.retiredDropped`） |
| `memory.ledger.retiredDropped` 重启后变小 | 正常，**它是进程内计数，不落盘** | 不要把它当累计值；它是「本次进程内丢了多少条留痕」 |
| 效果数字与上次看的不一样 | hover 里的窗口口径；是否刚归档/退休过任务 | 窗口滚动或归档/退休都会改变分母；这是有意的（旧事实不该给当下的数字投票） |
| `/board/retired` 返回 403 | 是否非回环 Host 且未放行 | 与 `GET /board` 同档准入，按「鉴权与暴露面」处理；**不需要** `x-dsh-mini-superagent` 头 |
| 点行打不开子会话 | 提示条里的原因；任务卡 `worker_session_id` | 会话导航服务不可用，或子会话已归档/不在会话目录（`not-listed`） |
| 工作区下拉是空的 | 快照 `workspaces`；工作区注册表 | 先让插件建默认工作区，或检查 `workspaceRegistry`；空列表时下拉只有「全部工作区」 |
