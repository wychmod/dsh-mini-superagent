# dsh-mini-superagent · 任务派发

给 DeepSeek Harness 装一张任务台：主会话派活，子会话干活，报告自己回来。

主会话用 `dispatch_launch` 把任务派给**独立的后台子会话**（自己的 Session、自己的工作目录、独立跑完整的一轮或多轮），
命令**立即返回**；子会话干完用 `dispatch_report` 汇报，报告作为一条插件来源的消息回到主会话——
主会话空闲时被唤醒，忙碌时并入下一个 step。于是主会话可以「派发 → 收报告 → 追问/纠偏 → 再派发」，
而不是卡在等结果上。

能力模型参考 DSH 官方 [dsh-superagent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype)，
但只保留派发这一件事：**没有** GitHub/飞书监听、没有工单与授权策略、没有数据库、没有构建步骤。
纯 ESM，零运行时依赖。

从 0.3.0 起附带一个常驻侧边栏的**任务看板**：Host 侧注册同源 HTTP 路由提供快照，浏览器侧是一个不打包、不编译的
ModuleLoader 面板，可以看并发、排队、耗时与报告摘要，并直接取消/重试。它不占模型上下文，也不需要 agent 调工具。

从 0.4.0 起有**工作区**：启动时准备一个默认工作区与固定主会话；每天一个【派发】工作区收拢子会话；
派发时可以用 `workspace` 指定目标工作区（id / 绝对路径 / 标题）；结束超过保留期的子会话会自动归档。

从 0.5.0 起，看板补了**归档视图 / 工作区筛选 / 批次聚合 / 点行跳会话**；输入框补了**派发目标选择器**与 **`@` 工作区**，
两者都写「下一次派发到哪」，不改会话归属。

---

## 它解决什么

- 一次派 5 个互不相关的任务，谁先好谁先报。
- 派完就能结束本轮；报告回来再继续，不占着 step 等。
- worker 是有历史的 Session：能追问、纠偏、让它接着做下一步。
- 卡住了能看见、能取消，不会变成黑洞。

## 不是什么

| 它不是 | 原因 |
| --- | --- |
| 同步 subagent | 同步调用要等结果；这里派发只登记 + 投递就返回 |
| 任务队列服务 | 没有持久队列、没有重试策略；重启后未结算任务标 `interrupted`，由你决定是否重派 |
| 权限系统 | 不裁剪 worker 工具集；需要收紧时给子会话指定 `agent_preset` |
| 多机调度 | 状态是一个本地 JSON 文件，单写，不跨进程协调 |

---

## 环境要求

| 项 | 要求 | 依据 |
| --- | --- | --- |
| DSH | `>=0.2.1-rc.2` | `package.json` 的 `engines.dsh` |
| Node | `^22.19.0 \|\| >=24.0.0` | `package.json` 的 `engines.node` |
| 依赖 / 构建 | 无 | `dependencies` 为空，`main` 直接指向 `src/index.js` |
| 任务看板 | 仅 Web 形态 | 需要宿主 `webServer` 与浏览器页面；headless 形态没有看板，派发与工具照常 |

实测环境：DSH `0.2.1-rc.5`，`desktop` profile。

---

## 安装

插件是纯 ESM，不需要构建、不需要 `npm install`。

### 方式一：让 agent 安装（推荐）

把这句话交给 DSH 里的任意会话：

> 用 plugin_manager 的 install_bundle，把 `dsh-mini-superagent` 这个目录安装成 bundle，装完确认 9 个 `dispatch_*` 工具已注册。

### 方式二：手动

```text
plugin_manager(action="install_bundle", target="<仓库根>/dsh-mini-superagent")
```

安装到 live profile 后立即生效；工具在会话的下一轮可见。

验证：

```text
dispatch_list()
→ {"version":"0.5.0","total":0,"running":0,"max_workers":6,"tasks":[]}
```

`version` 是 `0.5.0` 说明跑的是这一版；`max_workers` 应等于配置里的 `maxWorkers`（默认 6）。

> **装完/升级后刷新一次 GUI 页面**，侧边栏才会出现「任务看板」图标。
> 客户端模块在页面刷新后才加载，插件本身已经激活不影响这一点。

> **迁移注意**：不要和旧插件 `dsh-dispatch` 同时安装。两者共有 8 个同名工具，同一全局层重复注册会直接抛错。
> 先 `plugin_manager` 的 `remove_bundle` 移除旧 bundle（准确的 id 以 `list_bundles` 为准），再装这个。

旧任务表可选迁移（不迁也能用，只是历史列表为空）：

```powershell
Copy-Item "$env:DSH_HOME\dsh-dispatch\tasks.json" "$env:DSH_HOME\dsh-mini-superagent\tasks.json"
```

旧文件是 version 1，新代码读取时不强校验版本；其中未结算的任务照样会被标成 `interrupted`。
（若 `DSH_HOME` 未设，两处路径换成 `~/.dsh/...`。）

---

## 9 个工具

| 工具 | 谁用 | 做什么 |
| --- | --- | --- |
| `dispatch_launch` | 主会话 | 派发一个任务，立即返回 `task_id` + 子会话 id。可指定 `workspace`；并发位满时进 `queued`。**传 `continue_task_id` 则是续派**：不新建任务，把要求追加给已有子会话 |
| `dispatch_launch_many` | 主会话 | 一次派发 1–16 个互相独立的任务；整批结算后收到一条汇总 |
| `dispatch_workspaces` | 主会话 / worker | 列出工作区（id、标题、路径、会话数）与当前工作区配置，供 `workspace` 参数使用 |
| `dispatch_list` | 主会话 | 看本会话派出的任务与状态 |
| `dispatch_inspect` | 主会话 | 看单个任务的详情：简报、最近报告、worker 最后输出 |
| `dispatch_message` | 主会话 | 给子会话追问、纠偏、下发下一步；任务重新变 `running` |
| `dispatch_cancel` | 主会话 | 结束子会话当前回合、释放并发位 |
| `dispatch_wait` | 主会话 | 阻塞等待若干任务结算（**少用**，报告本来就会自己回来） |
| `dispatch_report` | 子会话 | worker 向派发者汇报 `done` / `blocked` / `failed` / `progress` |

工具注册在插件根 context，**对所有会话可见**；权限不靠注册作用域，而是在 `execute` 里判断
「调用者是不是已登记的 worker」：`dispatch_report` 只接受 worker，其余工具只操作本会话派出的任务。
`dispatch_workspaces` 是纯只读，不要求调用者是 Agent，也不受任务归属限制。
worker 调用 `dispatch_launch` 不会被拦（只受 `maxTasksPerSession` 限制），所以系统提示里明确要求 worker 别调；
见[已知限制](#已知限制)。

逐条参数、返回值与错误信息见 [docs/tools.md](docs/tools.md)。

---

## 一次典型用法

```text
用户：把这个项目的三个模块分别重构一下，互相独立。

主会话：
  dispatch_launch_many(tasks=[
    {title: "重构 auth 模块",    brief: "……目标、约束、验收、相关路径……"},
    {title: "重构 billing 模块", brief: "……"},
    {title: "重构 notify 模块",  brief: "……"},
  ])
  → 立即拿到 3 个 task_id，本轮结束，不阻塞。
```

之后：

1. 子会话各自开工（`running`，全局最多 `maxWorkers` 个同时跑，超出的 `queued`）。
2. 第一个完成后 `dispatch_report(done)` → 主会话被唤醒，收到一条 `[dispatch]` 前缀的消息。
3. 主会话发现 auth 的摘要里写着「遗留风险：没跑集成测试」，于是
   `dispatch_message(task_id, "补跑 test/auth 下的集成测试，失败就修到绿")` → 任务重新 `running`。
4. 全部完成后主会话汇总给用户。

### 怎么写 brief

子会话**看不到主会话的历史**，brief 必须自包含。一条能用的 brief 有四项：

- **目标**：要达成什么（不是要执行哪些命令）。
- **约束**：不能改的接口、必须遵守的规范、可用/不可用的依赖。
- **验收**：怎么算做完，尽量写成可执行的检查。
- **已知事实**：已排查出的结论、相关文件路径、报错原文。

反例：「修一下那个 bug」——worker 会瞎猜，报告里全是假设。

超过 `maxBriefChars`（默认 12000）会被截断，尾部保留；落盘与 `dispatch_inspect` 里再截到 2000。

---

## 状态流转

```text
queued ──pump──> running ──dispatch_report(done)──────> done
                   ├──dispatch_report(blocked)────────> blocked ──dispatch_message──> running
                   ├──dispatch_report(failed)─────────> failed
                   ├──dispatch_cancel─────────────────> cancelled
                   ├──回合结束、本回合无终态报告───────> ended（自动把最后一段输出回报）
                   └──插件重启 / 子会话被关闭─────────> interrupted
```

| 状态 | 含义 | 占并发位 |
| --- | --- | --- |
| `queued` | 已登记，等空位 | 否 |
| `running` | 子会话有回合在跑 | 是 |
| `done` | 显式 `done`，或本回合已给过终态报告 | 否 |
| `blocked` | 缺凭据 / 需人决策 / 外部依赖不可用 | 否 |
| `failed` | 启动失败，或显式 `failed` | 否 |
| `cancelled` | 被 `dispatch_cancel` | 否 |
| `ended` | 回合结束但 worker 没显式报告 | 否 |
| `interrupted` | 插件重启时未结算，或子会话被外部关闭 | 否 |

除 `cancelled` 外，任何已结算任务都能被 `dispatch_message` 重新拉回 `running`；
`cancelled` 是终局，要重派得新开一个任务。`progress` 报告只追加记录，不结束任务、不唤醒空闲的主会话。

**排队怎么推进**：`queued` 任务由 `pump()` 按登记顺序启动。`pump()` 在派发（`dispatch_launch` / `dispatch_launch_many`）、
插件加载、以及**每个结算点**（report 终态 / 回合结束 / cancel / 子会话被关闭）经 `Dispatch.settle()` 触发。
所以一个 worker 结算，空出的并发位会立刻被队列里的下一个占上，不需要等下一个人来派发。
实测：`maxWorkers=1` 派一慢一快两个任务，慢任务结算后约 4 秒，快任务自动从 `queued` 变 `running`，期间没有任何新派发。

工具返回里的 `running` 字段是全局在跑数，`max_workers` 是上限。

## 自动回报

worker 回合结束（`agent/status` → `idle`）时，如果它这一轮没给过终态报告，插件会抓它最后一条 assistant 文本，
作为「一轮执行结束（worker 未显式报告）」回报给主会话；用 `reportOnTurnEnd: false` 可关掉。
所以即使 worker 忘了报告，主会话也不会永远干等——实测收到过 `PONG-OK`。

如果这时它的 shell job / subagent 还在跑，回报会**推迟到后台清空**（或到 30 分钟上限）再发，见下一节。

---

## 任务看板

Web 形态下，侧边栏会多一个「任务看板」图标（`sidebar.panellist`，`order 60`）；点开是常驻主面板（`main` 槽），
数据来自 Host 的同源 HTTP 路由 `GET /dsh-mini-superagent/board`，每 2 秒轮询一次。
面板顶部有一条**平级切换条**：`任务看板 / 分析看板`，默认停在任务看板；
切到分析看板时，原有任务看板的字段、入口与所有行内操作都不变。

分析看板读另一条只读路由 `GET /board/analytics`（全量账本，10 秒刷新），
按时间范围 / 状态 / 负责人 / 工作区 / 批次筛选，展示任务总量、状态分布、完成率、超时代理、按天趋势与环比，
并附一张可展开的指标口径表。**账本没有人员与截止时间字段**：负责人按 `parentSessionId`（派发主会话）代理、
逾期按「创建后超过阈值的时长」代理，两处都标「待业务确认」；详见 [docs/board.md](docs/board.md)。

**装完/升级后必须刷新一次 GUI 页面**，图标才会出现——客户端模块在页面刷新后加载，插件已激活不影响这一点。

面板从上到下：

- **头部数字**：`并发 N/max`、`排队`、`总计`（不含已归档）、失败数；右侧「更新于 HH:MM:SS」。
- **效果条**：`完成`、`成功率`、`平均耗时`（中位数）、`并行节省`——粗算「各任务耗时之和 − 实际占用的墙钟」，
  定义写在每个数字的 hover 里，不让人误当账目。
- **并发条**：一条 4px 进度条 + 排队 / 后台收尾计数，比两个数字更快看出还有没有空位。
- **四个视图 chip 之外还有第五个**：`全部`（总览）/ `进行中` / `需要处理` / `已归档` / **`已退休`**，各带计数（按当前工作区筛选后计算）。
  「已退休」不从快照取数——它走独立的只读路由 `GET /board/retired`，选中时才取一次。
- **总览三段**：
  - `需要你处理`：failed / blocked / interrupted，按「失败的先、等得久的先」排序，**行内直接给原因**，
    不用点进子会话才知道它为什么停住；
  - `在跑与排队`：同批次的成员聚在一起，批次头给 `2/5` 的进度条；运行中的行带一条
    「耗时 / 中位耗时」的细进度条（超过中位转橙），一眼看出哪条跑偏了；
  - `最近完成`：默认 5 条，超过可「显示全部」。
- **任务行**：状态点（只有 running 脉动，`prefers-reduced-motion` 下关闭）、状态文字、标题、
  `第 N 次`、`后台收尾`、`待读`、耗时、取消/重试按钮；第二行是工作区标题、`task_id`、报告数、
  摘要首行与「报告 3 分钟前」。失败任务额外一行错误，归档失败额外一行「归档失败：…」。
- **工作区下拉**：`全部工作区` + 快照 `workspaces`；选中的工作区与视图 chip 取交集，效果数字也跟着这个范围走。
- **立即归档**：两步确认（首次点击变「确认归档」，4 秒无操作自动回落），调 `POST /board/archive`，结果用提示条显示扫描/归档/失败数。
- **归档视图**：紧凑单行（标题、状态、耗时、归档相对时间），整行 0.55 透明度、灰点、无按钮；归档失败的原因照常显示。
- **点行跳子会话**：整行可点，`Enter`/`Space` 也可以；失败提示「打不开子会话 `<id>`：<原因>」，**已归档的行不可点**（归档会话在宿主里一 opened 就会被清成空白会话，故不给点击入口，`aria-disabled` 说明原因）。
- **占位与提示**：加载中 / 空列表 / 筛选后为空 / 取不到数据（保留上次成功快照并提示）；取消/重试/归档失败用顶部红条显示原因。
- **刷新节奏**：页面隐藏时停表并中止在途请求，切回来立刻重取；面板卸载时清掉定时器与所有在途请求。
- **主题**：颜色全部走 `var(--dsw-alias-*, fallback)`，不写死明暗两套。

> 想先看效果不装宿主：打开 [`preview/board-preview.html`](preview/board-preview.html)（真实面板组件 + 假数据，
> 自包含单文件，只需联网取 React）。改完 `client/index.js` 后跑 `node scripts/board-preview.mjs` 重新生成。

安全取舍（细节见 [docs/board.md](docs/board.md)）：

- `GET`：本机回环（`127.0.0.1` / `localhost` / `::1`）放行；非回环必须是同源页面（`Origin` 与 `Host` 一致）。
- `POST`：带 `Origin` 时必须同源，跨站请求 403；不带 `Origin` 的非浏览器客户端（curl/脚本）放行。
- 原因：插件注册的具名路由排在 DSH 页面鉴权之前。若全放开，把 Web 暴露到局域网时任何人都能读到任务标题、工作目录与报告摘要。
  代价是远程访问只能用同源页面，远程 `curl` 读不到看板。

看板接口（0.5.0 起，本版未发布新增退休视图）：`GET /board`、`GET /board/retired`、`POST /board/cancel`、`POST /board/retry`、
`POST /board/archive`、`POST /board/target`。
快照带 `workspaces`、`targets`、`counts.archived`、`counts.retired` 与 `memory` 块，任务卡带 `workspace_*` / `archived_*` / `group` / `input_*`。
`memory` 是记忆治理口径（窗口、账本容量、准入计数、待读/不知道、退休数），`null` 表示宿主没提供。
细节见 [docs/board.md](docs/board.md)。

**重试语义**（看板按钮，不是新工具）：

- 任务的 `attempt` 从 1 开始，每次重试 +1，看板显示「第 N 次」。
- 子会话还活着或能 `resolveAgent` 恢复（`blocked` / `ended` / `failed` 的常见情况）→ **续跑同一会话**，历史保留。
- 会话没了（`interrupted`，或建会话就失败）→ **新开** `dispatch-<taskId>-a<attempt>`，重投原始简报。
- 判定以「能否拿到活 Agent 或 `resolveAgent` 成功」为准，不是任务状态本身。
- `done` 的任务被重试时指令是「再执行一次」，不是「接着做」。
- `running` / `queued` 不能重试（先取消）；`cancelled` 不能重试（要重做请新派发）。
- agent 侧没有新增工具：主会话续跑仍然用 `dispatch_message`。

---

## 工作区

0.4.0 起，插件自己管理一小组 DSH 工作区，目标是：子会话不把侧边栏塞满，同时活干在正确的项目目录里。

### 默认工作区与主会话

启动时（`provisionDefaultWorkspace: true`，默认）插件做两件幂等的事：

1. 建目录并注册工作区：`<workspaceRoot>`，标题 `mini-superagent`。
   `workspaceRoot` 留空时是 `<用户文档目录>/mini-superagent`（Windows 上通常是 `C:\Users\<你>\Documents\mini-superagent`）。
2. 在其中建一个**固定 id 的默认主会话** `mas-lead`，标题「mini-superagent 主会话」；已存在就跳过。

失败只记日志（`创建默认工作区失败（不影响派发）`），不影响派发。`dispatch_workspaces` 可以看到这个工作区与会话数。

### 子会话放在哪个工作区

**有目标工作区就用目标**（不可关闭）；只有**没有目标 / 目标已被删除**时才退回当天的【派发】工作区：

```text
<workspaceRoot>/派发/<YYYY-MM-DD>      标题：【派发】YYYY-MM-DD     ← 仅在需要兜底时按需创建
```

于是选了目标项目的派发就待在项目里，不会凭空多出日期工作区；没指定目标时才按天收拢、用完归档，
侧边栏不至于散落在每个项目下。完全不想让兜底建工作区，就把 `workerWorkspace` 设成 `cwd`。

> 0.8.1 变更：旧版 `workerWorkspace` 决定「用不用目标」，默认 `day` 使目标被忽略。
> 现在这个配置**只决定无目标时的兜底**（`day` = 当天【派发】，`cwd` = 任务目录）；
> 旧值 `target` 已废弃，会被当作 `day` 处理（不报错）。

**会话归属与工作目录是两件事**：建完会话后插件会调 `workingDirectory.set` 把工作目录切到任务的目标路径，
所以子会话的会话归属与 `Get-Location` 不一定是同一个地方。切目录失败只记 warn，任务照跑。

### 派发到哪个工作区

`dispatch_launch` / `dispatch_launch_many` 支持：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `workspace` | — | 工作区 id / 绝对路径 / 标题，三者都可以 |
| `create_workspace` | `true` | 解析不到时是否新建（绝对路径就在该路径建，名字就在工作区根下建） |

解析顺序：**id → 绝对路径（只查不建）→ 标题精确（大小写不敏感）→ 标题包含**。
解析不到且允许新建时：绝对路径直接建在该路径；名字建在 `<workspaceRoot>/<安全目录名>`。
解析不到且 `create_workspace: false` → 报错并列出已有工作区。

### 续派：`dispatch_launch({ continue_task_id })`

想在**同一个任务**上补一句要求，就传 `continue_task_id`：那一刻不新建任务，要求直接追加给
该任务的子会话（等价于一次 `dispatch_message`），任务重新变 `running`。看板上已结算的行也有
一个「续派」按钮走同一条通道（`POST /board/retry` 带 `message`）。

三个代价（规划书 §二要求写清）：**没有独立的任务记录**、**没有独立的报告链**、**没有独立的看板行**
——「这次要求」与「上次要求」混在同一任务里。要保留任务粒度就别传它，直接新派一个。

四条硬校验，任一不满足即报错并给原因，不会静默降级成新派发：目标任务存在且未退休、属于本会话、
子会话是本插件建的（`dispatch-*`）、工作区/cwd 一致（**续派没有自己的 `workspace` 参数**，
一律沿用目标任务的工作区），另外还要求当前没有别的活跃任务。
细节见 [docs/tools.md](docs/tools.md) 的「续派」一节。


同时给 `workspace` 和 `cwd` 时**工作区路径优先**，`cwd` 被忽略。完全不指定 `workspace` 时：
先看输入框里选的「派发目标」（见下一节），没有目标才沿用调用者的工作目录。
先用 `dispatch_workspaces` 看有哪些工作区。

### 自动归档

- 每 `archiveSweepMinutes`（默认 10 分钟，首次延迟 20 秒）巡检一次；
- 把「已结算且 `updatedAt` 早于 `archiveAfterHours`（默认 24 小时）」的任务对应子会话
  `workspaceRegistry.archiveSession(id, {stopActivity:true})` 归档；
- 成功记 `archivedAt`，失败记 `archiveError`（看板快照的 `archive_error` 可见），下次巡检重试；
- 归档只收起会话列表，不动任务表、报告与看板；已取消任务也能归档；
- `archiveAfterHours: 0` 关闭自动归档，`archiveSweepMinutes: 0` 关闭巡检；
- 看板有 `POST /dsh-mini-superagent/board/archive` 可手动跑一次巡检。

细节见 [docs/workspaces.md](docs/workspaces.md)。

---

## 输入框选择派发目标

0.5.0 起，输入框工具行左侧多一个「派发目标」控件（`conversation.input.left`，`id` = `dsh-mini-superagent/target`，`order 60`）。

- 只在**有活跃会话**时渲染；空白/hero 会话看不到。
- 28px 高、`flex:none`、最大宽度 `min(260px, 45cqw)`；有目标显示 `派发 → <标题>`，没有目标显示 `派发 → 跟随会话`。
- 下拉用 `createPortal` 挂到 `document.body` + `position: fixed`，优先向上展开、左右夹在视口内；
  项是「跟随会话目录」/ 全部工作区（带路径与 ✓）/「刷新列表」。
- 选中立即 `POST /board/target`（空串=清除）；失败把 Host 的中文原因留在下拉里，且不关闭。
- 快照取不到时控件禁用，`title` 显示「看板服务不可用」；不轮询，挂载与每次打开下拉各取一次。
- 它改的是**下一次 `dispatch_launch` 的目标**，不是会话归属——DSH 里会话的工作区建完不可迁移。

## `@` 选择工作区

同一个目标还可以在输入框里用 `@` 选：

- 注册在 `inputTriggers` 的 `@` 触发下，`name: workspace`、`order: 40`，与官方 `@reference` 并存；候选分组「工作区」。
- 选中后**同时**做两件事：`POST /board/target` 设目标 + 往草稿插 chip。
- 模型看到的文本是 `<workspace id="ws-2" title="副工作区"/>`；剪贴板文本是 `@副工作区`。
- chip 的 `appearance` 故意省略：宿主只认 `session`/`file`/`folder`，传别的会让整条草稿恢复时被清空。
  也因为没有「只插纯文本」的返回形态，**`@中文名` 纯文本不可行**，选中一定产生 chip。
- `inputTriggers` 服务缺席时 `@` 不出现；看板与选择器照常工作。

完整契约、失败降级与限制见 [docs/composer.md](docs/composer.md)。

---

## 配置

全部可选，写在 bundle 的 `cordis.patch.yml` 的 `config` 里（默认值见 `src/constants.js` 的 `DEFAULTS`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxWorkers` | `6` | **全局**同时 `running` 的上限；超出的进 `queued`，有空位自动开始（按登记顺序） |
| `maxTasksPerSession` | `64` | 每个主会话累计派发上限（防递归派发失控） |
| `inheritWorkingDirectory` | `true` | 子会话继承主会话的工作目录（指定了 `workspace` 时以工作区路径为准） |
| `permissionPreset` | `''` | 子会话权限预设。后台无人看管时建议 `danger-full-access`，否则可能卡在审批上 |
| `stateDir` | `''` | 任务表落盘目录；空表示 `$DSH_HOME/dsh-mini-superagent`（`DSH_HOME` 未设时用 `~/.dsh`） |
| `reportOnTurnEnd` | `true` | worker 回合结束自动回报 |
| `maxBriefChars` | `12000` | 投给 worker 的任务简报最大字符数 |
| `workspaceRoot` | `''` | 工作区根；空表示 `<用户文档目录>/mini-superagent` |
| `provisionDefaultWorkspace` | `true` | 启动时创建默认工作区与默认主会话（失败只记日志） |
| `workerWorkspace` | `day` | **无目标时**的兜底：`day` = 当天【派发】工作区；`cwd` = 直接用任务 cwd。有目标时与它无关 |
| `archiveAfterHours` | `24` | 子会话结束多少小时后自动归档；`0` 表示不归档 |
| `archiveSweepMinutes` | `10` | 归档巡检间隔（分钟）；`0` 表示不巡检 |
| `leadSessionId` | `mas-lead` | 默认主会话的固定 id；改值等于换一个新默认主会话 |
| `restrictRouter` | `true` | 「必派发」的会话收窄 `write` / `edit`，改代码只能派下去（选回「不派发」立刻解锁，见「路由模式」） |
| `routerDenyTools` | `["write","edit"]` | 路由模式收走哪些工具。注意 `bash` 默认保留，`echo > file` 仍能写；要硬边界就把它也加进来 |
| `relayRetryMs` | `[2000,4000,8000]` | 报告投递失败的退避序列（毫秒），用完即放弃 |
| `retryTransient` | `true` | worker 回合遇到瞬时故障（408/429/5xx/网络）时自动续跑 |
| `retryBackoffMs` | `[15000,30000,60000]` | 续跑的退避序列；长度即最大重试次数 |
| `progressRelayIntervalMs` | `60000` | 同一任务 `progress` 报告的最短回流间隔；`0` 表示不节流（被挡下的仍然入库） |
| `workerAgentPreset` | `''` | 子会话默认 preset；指向一个收紧的 preset 可以让 worker 的前台命令更早转后台 |
| `backgroundPollMs` | `15000` | 回合结束后后台还有 job/subagent 时的巡检间隔 |
| `backgroundLimitMs` | `1800000` | 后台活最多再占多久（30 分钟）；到点终止剩余 job 再结算，`0` 不限 |
| `taskDirRoot` | `''` | 每任务目录的根；留空不启用（子会话仍在工作区/调用者目录里干活） |
| `prepareCommand` | `''` | 任务目录不存在时在父目录执行一次的命令，典型是 `git worktree add` |
| `prepareTimeoutMs` | `600000` | prepare 命令超时（10 分钟） |
| `memoryWindowDays` | `7` | 派生指标的窗口：最近 N 天。只影响指标口径，不影响任务是否存在 |
| `memoryWindowTasks` | `200` | 派生指标的窗口：最近 M 条已结算（与天数取交集） |
| `maxReportSummaryChars` | `6000` | 单条报告 `summary` 的**入库**上限（与外发同一口径）；超长时头尾各半并记 `truncated` |
| `maxReportDetailChars` | `4000` | 单条报告 `detail` 的入库上限（只进账本，不随报告回流） |
| `maxLastTextChars` | `5000` | `task.lastText`（worker 最后一段输出）的入库上限 |
| `inputPendingTtlMs` | `1800000` | 「已投递未读」的存活上限（30 分钟）；超时改写成 `inputUnknownAt` 而不是假装读过 |
| `clearTargetsOnDispose` | `true` | 会话销毁时清掉它的派发目标。不清的话 `targets` 只增不减 |
| `ledgerMaxTasks` | `1000` | 账本全局条数上限；超出按「已归档优先 → 最老 `updatedAt`」退休。`<= 0` 不限制 |
| `ledgerMaxDays` | `90` | 账本保留天数；非活跃且更早的任务退休。`<= 0` 不限制 |
| `ledgerMaxRetired` | `5000` | 退休留痕列表上限；超出丢最老的并累加 `retiredDropped`（**该计数不落盘、重启归零**） |
| `directReportStatuses` | `["blocked","failed"]` | **额外**直通主会话的报告状态。终态（`done`/`blocked`/`failed`/`cancelled`）恒直通，**配置只能扩展、不能降级** |
| `noticeMergeWindowMs` | `1500` | 未消费通知的**合并窗口**（毫秒）：同一任务窗口内多条 `progress` 合成最后一条。`0` 关闭合并。**上限 2000**（配更大会被截断） |

单个任务还可以在 `dispatch_launch` / `dispatch_launch_many` 时覆盖 `cwd` / `workspace` / `create_workspace` /
`model` / `agent_preset` / `permission_preset`。

---

## 落盘与重启

- 任务表在 `<stateDir>/tasks.json`（默认 `$DSH_HOME/dsh-mini-superagent/tasks.json`），UTF-8，原子替换写（`tmp` → `fsync` → `rename`，另留 `.bak`），800ms 防抖。
- 文件结构 `{version: 4, savedAt, tasks: [...], targets: {...}, retired: [...]}`；读取时不强校验版本，坏文件只记日志、不阻止插件启动。
  旧文件没有 `targets` 时按空对象、没有 `retired` 时按空数组（**不迁移、不报错**）。
- `retired` 是**退休留痕**：任务被移出活表后只剩 13 个字段（含 `retiredAt` / `retiredReason` 与 200 字摘要），
  **不搬报告正文**。它落盘是为了重启后还能回答「这条任务什么时候、为什么不见了」。
  格式细节见 [docs/architecture.md](docs/architecture.md) §29。
- 插件重启后读回历史任务：**还在排队、且从没启动过的任务会重新入队接着跑**（判据 `startedAt` 为空）；
  已经在跑的标 `interrupted`，因为新进程里那个 worker 可能已经做了一半，重跑会重复执行。
- 子会话本身是普通 DSH Session，内容由 DSH 自己持久化，在侧边栏里可以直接打开。
- 每个任务最多保留 50 条报告；简报落盘时截到 2000 字符（完整简报在 worker 首条消息里）。
- 任务新增 `attempt` 字段（默认 1，重试 +1），随任务表落盘；旧任务读回时按 1 处理，看板不会误显示「第 0 次」。
- 工作区相关字段也随任务落盘：`workspaceId` / `workspaceTitle` / `archivedAt` / `archiveError`（以及批次 `group`），重启后看板仍能显示工作区与归档状态。

---

## 工作方式提示

每个新建会话都会挂上提示段（段名 `dsh-mini-superagent`、`order: 9998`），文本是**函数**：
输入框里切「派发目标」时下一轮就换文案，不需要重载插件。

- 没设目标：`SOFT_HINT`（首行 `[dsh-mini-superagent 工作方式]`），只说「可以派」，不强制；
- 设了目标：`FORCED_HINT`（首行 `[dsh-mini-superagent 强制派发]`），除纯问答外都要派下去；
- 已进路由模式：在上面两段之后追加 `ROUTER_LOCKED`，说明 `write` / `edit` 已被收窄、改代码请派发。

### 切模式为什么要开新请求序列

「文本是函数、下一轮换文案」只说对了一半。宿主的请求装配对**变化的提示是追加，不是替换**：
路由声明 `systemPromptUpdate: 'in-history'` 时（本机的 deepseek 路由就是），文本一变就 `append`
一个新的 `system/message`，**旧的那个仍然留在面上**、仍随 `deriveMessages()` 进请求；只有开新请求
序列时才改写节点 0 并把后续非空的旧节点逐条清空（`app.asar` 的 `SystemPromptProjection.project`）。

于是切回「不派发」后，模型会同时读到旧的强制段和新的轻提示——这正是 0.8.2 之前那个
「我选了不派发，为什么还是派发了」的故障。所以插件在**装配文本相对上一步真的变了**时，
通过 `agent/pre-step` 返回 `startsRequestSeries: true`，把收敛交回宿主自己的机制；
文本没变时不动，避免白白打掉提供方的前缀缓存。实测这能解释本机会话 `session-<redacted>`
面上叠着三份 `system/message`（turn 1 强制段、turn 2 强制段、turn 7 轻提示，三份都还在）。

两段提示共用四段文本（`BACKGROUND_CONTRACT` / `SPEAK_RULE` / `HANDOFF_RULE` / `IN_FLIGHT_ALLOWED`）：
派发非阻塞、报告会自己回来、`dispatch_wait` 才是真阻塞；**派发即移交**（返回之后该任务的读代码、
搜索、跑脚本、开浏览器、查网络、验数据都不再由主会话进行，只读调查也算）；**有任务在飞时只剩四件事可做，
其余一律结束本轮**。这是刻意的，避免两种模式各说一套。

中间那段 `SPEAK_RULE` 只管**对用户怎么说**（先认领任务、默认 2-3 行、不报 id 与英文状态、
失败说清卡在哪），受 `test/voice-prompt.test.js` 的长度门禁约束：**≤ 8 行、≤ 500 字**，
量的装配后的真实提示文本。提示词继续膨胀会稀释每条规则，所以加内容前先删一段重复解释。

其中「派发之后默认结束本轮」写得很硬，因为它对应一次真实事故：主会话派发后连调约 10 次
`dispatch_wait`（累计约 33 分钟原地阻塞、零产出），根因是旧文案没说清「结束本轮」就是正确动作。
允许等待的唯一情形是**用户在同一个消息里明确要求**「等结果再继续」。

worker 的首条消息由插件拼装：任务 ID、标题、工作目录、简报，加 7 条工作规则（直接开工、完成后必须
`dispatch_report`、只有真被阻塞才报 `blocked`、汇报后收尾、不要调主会话的工具、不伪造结果、简报与规则冲突时以规则为准）。

---

## 路由模式（必派发的会话不许改代码）

**只对「必派发」的会话生效**——也就是你把输入框里的「派发目标」设成某个工作区或「自动」的时候。
这时插件在那个会话的 agent 作用域上 `tools.restrict({ deny: ["write", "edit"] })`：
模型看不到这两个工具，改代码只能派给子会话。

- **默认状态（不派发）什么都不变**：任何会话都可能是主会话，所以只要没选派发目标，工具一个都不少。
- **切回「不派发」立刻解锁**：`setTarget` 会调 `syncRouter`，把收窄收回去，工具马上还回来。
- **触发点是模式，不是「派发过一次」**：上一版按「第一次派发」判定，等于因为派过一次就永久收走
  `write`/`edit`——与「任何会话都可以是主会话、也有不派发这个选项」的产品语义冲突。
- **worker 不受影响**：worker 自己再派发（递归）时会被跳过——收窄它等于让它干不了活。
- **可逆**：`restrictRouter: false` 全局关掉；插件卸载或会话关闭时也会收回收窄，不留残余。
- **边界**：`bash` 默认保留，`echo > file` 依然能写文件（上游同样如此）。要硬边界就把
  `routerDenyTools` 配成 `["write","edit","bash","pwsh"]`。
- **宿主不支持时不上锁**：没有 `agent.ctx.tools.restrict` 时只记一条 warn，派发照常，别的地方不退化。

## 报告投递为什么不会重复

同一份报告的 3 次重试共用一个 message id；重试前先查这条消息是否已经在会话里
（收件箱 `nextTurn`/`nextStep` 或历史里的 `user/message`），命中就按已送达处理。

0.8.1 及更早把 id 生成写在重试循环里，于是「第一次其实投进去了、只是后面抛错」会变成两条一样的报告。

## 后台收尾：回合结束 ≠ 任务结束

worker 的回合结束时，如果它的 shell job 或 subagent 还在跑，任务**不结算**：
并发位继续占着，看板上显示「后台收尾」标签，每 `backgroundPollMs`（默认 15 秒）巡检一次。
后台清空后自动收尾并回报；到 `backgroundLimitMs`（默认 30 分钟）会终止还剩的 shell job，
再结算，并在报告里写明终止了几个。

没有 `jobs` / `subagents` 服务的部署（headless）视为「没有后台活」，行为和以前一致。
`dispatch_message` 唤醒的下一轮会让上一轮的巡检作废，不会把正在跑的这一轮结算掉。

## 每任务目录与 prepare 命令

配了 `taskDirRoot` 时，每个任务得到 `<root>/<标题安全名>-<id后6位>` 作为工作目录：

- 会话仍挂在目标/【派发】工作区（侧边栏干净），真正读写的是任务目录；
- 目录**不存在**时才跑一次 `prepareCommand`（典型：`git worktree add "$DSH_DISPATCH_DIR"`），
  已存在就跳过——否则重试会在同一个 checkout 上再 worktree 一次；
- 命令在**父目录**执行，环境变量：`DSH_DISPATCH_DIR` / `_TASK` / `_TITLE` / `_WORKSPACE` / `_CWD`；
- 失败即任务 `failed` 并回报原因，**不建子会话、不自动重试**（目录可能已被写了一半）。

---

## 已知限制

- **排队只在内存里**：重启时排队中且没启动过的任务会重新入队，但队列本身不落盘（顺序靠登记顺序重建）；
  已经在跑的一律 `interrupted`，要不要重派由主会话决定。
- **瞬时续跑依赖宿主事件**：`retryTransient` 靠 `agent/error` 触发。宿主不发这个事件时续跑不生效，
  但不会报错——任务照常会走到 `idle` 并被自动回报成 `ended`。
- **读回执依赖 `session/event`**：收不到 `user/message` 时，`dispatch_message` 之后的
  `input_pending_at` 会一直留着（看板显示「已投递未读」），这只影响显示，不影响投递本身。
- **后台活只终止 shell job**：到 `backgroundLimitMs` 时被终止的是 job；subagent 允许继续（上游同样如此）。
- **任务目录不自动清理**：`taskDirRoot` 下的目录随任务一直留着（和归档只收起不删除一致），需要清理请让 `prepareCommand` 或外部脚本处理。
- **`maxWorkers` 是软的**：`dispatch_message` 唤醒已结算的 worker 会直接置 `running`，可能短暂超过上限
  （有意的：人的追问不该排在批量任务后面）。
- **worker 能看到全部全局工具**，包括 `dispatch_launch`。插件只对**主会话**做 `restrict`（路由模式，收走 write/edit），
  不对 worker 收窄；要更严的 worker 工具面，用 `agent_preset` 给子会话指定收紧的 preset。
- **`dispatch_wait` 阻塞当前 step**：**默认不要用**。唯一允许的情形是用户在同一个消息里明确要求
  「等结果再继续」；其余一律结束本轮（结束本轮 ≠ 没回答，报告会自己回流）。系统提示与工具描述
  都把这条写成硬约束——它对应一次「连续等待约 33 分钟、零产出」的真实事故。
- **「派发即移交」靠提示词，不靠守卫**：派发之后主会话重做同一个任务，在工具层面与「做另一件相关的活」
  无法区分（都要 `read` / `pwsh`），加守卫只会误伤；防回归靠 `test/handoff.test.js` 的文本断言。
  硬边界只有一种做法：路由模式（见上）收走 `write` / `edit`，但那只在「必派发」模式下成立。
- **状态文件是单写的**：多个 Harness 实例共用同一个 `DSH_HOME` 时可能互相覆盖；`stateDir` 可指到别处。
- **报告与简报有截断**：单任务 50 条报告；**入库**按 `maxReportSummaryChars`（6000）/ `maxReportDetailChars`（4000）截，
  `lastText` 按 `maxLastTextChars`（5000）截，被截的条目记 `truncated`；`dispatch_inspect` 只展示最近 5 条、简报 2000 字符、最后输出 3000 字符。
  注意 `clip()` 是「头尾各半 + 一句提示语」且提示语也占预算，**不是截到恰好 N 字**。
- **回流给主会话的那份报告是四段式，且比账本短**：入库上限管账本体积，投影预算（`summary` 800 字符、
  不含 `detail`）管回流消息长度。两者取不同数字是有意的——压缩只作用于投影，`dispatch_inspect` 读回的仍是全文。
- **超长摘要只发「摘要 + 指针」**（P1-2）：说明行超过 800 字符时，回流的那份压到 ~240 字并附一句
  「另有 N 字在账本里」，**账本原文一个字都不压**。常态报告（几十到几百字）原样发送，不受影响。
- **同一任务的进度会被合并**（P1-1）：窗口 `noticeMergeWindowMs`（默认 1.5 秒）内的多条 `progress`
  合成最后一条。**结论类永不参与**——`done` / `blocked` / `failed` / `cancelled`、批次汇总、启动失败
  都是立刻直达。想让进度也逐条发，把 `noticeMergeWindowMs` 设成 `0`（这是 P1-1 的单独回退开关）。
  直通类到达时会先冲掉窗口里还躺着的进度，保证「先过程、后结论」的顺序。
- **`progress` 默认不回流**：它只入库（`admission: 'ledger'`），主会话不会被叫醒。这是有意的——
  过程信息不该进会话长期历史。想恢复旧行为，把 `progress` 加进 `directReportStatuses`（此时才轮到 `progressRelayIntervalMs` 节流）。
- **终态报告不能被配置关掉**：`done` / `blocked` / `failed` / `cancelled` 恒直通。`directReportStatuses` 只能往里加，
  **不能把结论类状态降级成静默**——那样主会话会永远等不到「做完了」。
- **账本会退休老任务**：超过 `ledgerMaxTasks`（1000 条）或 `ledgerMaxDays`（90 天）的非活跃任务被移出活表，
  只留 13 个字段的薄记录（无报告正文）。看板「已退休」视图与 `dispatch_inspect`（带 `retired: true`）能查到，但正文取不回来。
  `retiredDropped`（留痕列表本身超 `ledgerMaxRetired` 被丢弃的条数）**不落盘、重启归零**，它不是累计值。
- **指标有窗口**：成功率 / 中位耗时 / 并行节省只算最近 `memoryWindowDays`（7）天 / `memoryWindowTasks`（200）条内的已结算任务，
  且排除已归档与已退休。拿它跟旧版本的数字比会不一致——先看卡片 hover 里的窗口口径。
- **看板依赖 `webServer`**：headless 形态没有这个服务时不注册路由（日志会写「没有 webServer，跳过任务看板路由」），面板取不到数据；工具与派发不受影响。
- **看板最多返回 200 条**：计数按全量算，列表只截前 200；没有分页、没有历史归档。
- **远程访问受限**：非回环地址只能通过同源页面看看板，远程 `curl` 会被 403；这是有意的（见「任务看板」的安全取舍）。
- **重试有边界**：`running` / `queued` / `cancelled` 不能重试；重试沿用同一个任务 id，只把 `attempt` +1（会话无法恢复时换一个 worker 会话）。
- **工作区目录必须可写**：`workspaceRegistry.create` 要求目录已存在，插件会先 `mkdir`；目录不可写时默认工作区创建失败（只记日志），
  显式指定 `workspace` 的派发会直接报错。没有 `workspaceRegistry` 时，`day` 模式退化为按任务 cwd 建会话。
- **`workspace` 胜 `cwd`，但 `cwd` 不被丢弃**：两者同时给时，会话归属按工作区、任务工作目录仍是 `cwd`
  （由 `enterDirectory()` 切过去）。只给 `cwd` 时它优先于会话里记住的派发目标。
- **显式 `cwd` 不触发日期兜底**：调用方明确给了目录，就不会再被塞进当天的【派发】工作区。
- **未指定 `workspace` 时**：先看输入框选的「派发目标」；没有目标才沿用调用者目录。无论哪种，子会话仍挂在当天【派发】工作区。
- **派发目标 ≠ 会话归属**：输入框的选择器只影响下一次 `dispatch_launch`；DSH 里会话的工作区建完不可迁移。
- **`@` chip 外观不可定制**：`appearance` 只认 session/file/folder，插件省略它；也因为没有纯文本插入形态，`@中文名` 不可行。
- **归档只收起会话**：不删目录、不删任务、不删报告；归档失败会每轮巡检重试，失败原因只在看板快照的 `archive_error` 里，`dispatch_list` 看不到。
- **界面未在真浏览器里跑过**：控件对齐/截断、弹层翻转与边缘夹取、`@` 与官方 `@reference` 混排、chip 刷新后恢复、
  `openSession` 成功后视图切换、深浅主题对比度、`not-listed` 错误码，全部未验证（见验证记录）。

---

## 验证记录

在本机 `desktop` profile 上的实测（2026-11-05）。**版本口径**：前 8 条是改名前的 `dsh-dispatch` 0.1.0（单文件 853 行）上跑出来的；
0.2.0 重构后重装了插件，重验了「安装 + 8 工具注册」与「派发 → 执行 → report → 回流」两条，并补做了并发排队实测。

| 用例 | 版本 | 结果 |
| --- | --- | --- |
| 安装 bundle、8 个工具注册 | 0.1.0 | ✅ `dispatch_list` 返回 `version: 0.1.0` |
| 派发 → worker 建文件 → `dispatch_report(done)` → 报告回流主会话 | 0.1.0 | ✅ |
| worker 回合结束但**不**显式报告 → 自动抓最后输出回报 | 0.1.0 | ✅ 收到 `PONG-OK` |
| `dispatch_wait` 阻塞至任务结算 | 0.1.0 | ✅ 返回 `status: done` 与完整摘要 |
| 对已结算任务 `dispatch_message` 追问 → worker 恢复会话继续做 → 再次汇报 | 0.1.0 | ✅ 文件被追加第二行 |
| `dispatch_cancel` 长任务 | 0.1.0 | ✅ 状态变 `cancelled`，并发位释放，无残留文件 |
| 插件重启后从 `tasks.json` 恢复历史任务 | 0.1.0 | ✅ 任务与报告都在 |
| 主会话**空闲**时被报告唤醒（派发后直接结束本轮） | 0.1.0 | ✅ 20 秒后会话自行醒来并收到完整报告 |
| 重装 0.2.0、8 个工具注册 | 0.2.0 重验 | ✅ `dispatch_list` 返回 `version: 0.2.0` |
| 派发 → 执行 → `dispatch_report` → 回流 | 0.2.0 重验 | ✅ |
| 并发排队：`maxWorkers=1` 派一慢一快两个任务 | 0.2.0 | ✅ A 慢任务 `running`、B 快任务 `queued`；A 结算后约 4 秒 B 自动 `running`（13:05:53 → 13:05:57），期间无新派发 |
| 看板快照：`GET /dsh-mini-superagent/board` | 0.3.0 | ✅ 200、`cache-control: no-store`、`version: 0.3.0`、返回 3 条任务 |
| 看板重试：对失败任务 `POST /board/retry` | 0.3.0 | ✅ 200、`attempt` 1→2、任务转 `running`；worker 恢复会话后再次 `dispatch_report`，第 2 次汇报已回流 |
| 全量单测（`npm test`） | 0.3.0 | ✅ 32 pass / 0 fail（`tasks.test.js` 13 + `board.test.js` 19） |
| 工作区自动准备 | 0.4.0 | ✅ `dispatch_workspaces` 返回默认工作区且 `sessions: 1`；磁盘上 `<workspaceRoot>` 已创建 |
| 子会话住【派发】、活干在目标目录 | 0.4.0 | ✅ 子会话 `Get-Location` 返回目标工作区根（`…\Documents\mini-superagent`），而它的会话挂在【派发】工作区下 |
| 自动归档 | 0.4.0 | ✅ 临时 `archiveAfterHours=0.001` / `archiveSweepMinutes=0.05`，约 20 秒后 4 个任务归档（`counts.archived: 4`）；`POST /board/archive` 200，再次调用返回 `scanned: 0`；配置已改回 24h / 10min |
| 看板 UI：归档视图 / 工作区筛选 / 批次聚合 / 跳转会话 | 0.5.0 | ⚠️ 仅代码审查；接口与快照由单测覆盖，浏览器渲染未验证 |
| 输入框派发目标选择器、`@` 工作区 | 0.5.0 | ⚠️ 仅代码审查；`/board/target` 与 `targets` 快照有单测覆盖，界面未验证 |
| 全量单测（`npm test`） | 0.5.0 | ✅ 50 pass / 0 fail（tasks 13 + board 26 + workspaces 11） |

0.2.0 那组最后一条（并发排队）同时是修复验证：0.1.0 只在派发与插件加载时推进队列，结算后不会补 `pump()`，
并发位满时后面的任务会一直 `queued`。这个问题是整理代码时被测出来的，修法与依据见 [docs/architecture.md](docs/architecture.md) 的「pump 的触发点」。

0.4.0 的全量单测是 43 pass（13 + 19 + 11）；0.5.0 起是 50 pass（board 新增 7 个用例）。

**未实测（0.5.0，界面一次性都没跑过）**：客户端模块要页面重载才挂载，本轮只做了代码审查 + Host 单测。不能断言：

- 控件在真实工具行里的对齐、换行与截断（28px 高、`min(260px, 45cqw)` 只是 CSS 声明）；
- 弹层向上/向下翻转与左右边缘夹取的实际观感；
- `@` 候选与官方 `@reference` 混排时的分组、排序与视觉一致性；
- chip 在页面刷新后能否从草稿恢复；
- `openSession` 成功后视图是否真的切过去；
- 深浅主题下的对比度；
- `not-listed` 的真实错误码与错误文本。

装完/更新后需要刷新一次 GUI 页面，看板、选择器与 `@` 才会挂载。

`test/tasks.test.js` 覆盖任务表纯逻辑，`test/board.test.js` 覆盖快照与路由（用假的 req/res，不需要起 HTTP 服务），
`test/workspaces.test.js` 覆盖日期键、安全目录名、根目录与工作区解析顺序（用假注册表）；它们都不是端到端实测的替代。

---

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/tools.md](docs/tools.md) | 9 个工具的参数、返回、错误、何时用/何时别用 |
| [docs/architecture.md](docs/architecture.md) | 模块职责、数据流、设计取舍与依据 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 排障表、日志前缀与恢复动作 |
| [docs/workspaces.md](docs/workspaces.md) | 工作区模型、目录约定、解析规则、自动归档、限制与排障 |
| [docs/board.md](docs/board.md) | 任务看板 + 分析数据看板：入口、面板结构、两条只读聚合接口、指标口径表、归档/工作区视图、跳转、重试、鉴权 |
| [docs/composer.md](docs/composer.md) | 输入框：派发目标选择器、`@` 工作区、chip 契约与降级、未验证清单 |
| [docs/api-contracts.md](docs/api-contracts.md) | DSH 主机 API 契约取证（消息/Agent/事件/会话控制器/工具作用域） |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0（原名 dsh-dispatch）、0.2.0、0.3.0、0.4.0、0.5.0 的差异 |

---

## 目录

```text
dsh-mini-superagent/
  package.json        # name/version、engines、dsh.bundle.patch、dsh.client 声明
  cordis.patch.yml    # 插入插件行 + 默认配置（可整段删掉，靠代码默认值）
  src/
    index.js          # 入口：建 Dispatch、注册工具、接宿主事件、看板路由、启动准备
    constants.js      # 名称/版本/日志前缀/source kind/默认配置/状态集合
    tasks.js          # TaskTable（并发位/排队/结算/等待）+ 纯函数
    store.js          # tasks.json 读写
    sessions.js       # DSH 适配：建会话、取 Agent、权限预设、提示注入、投递、切工作目录
    prompt.js         # 给模型的文本：工作方式提示 + worker 首条简报
    tools.js          # 9 个工具定义
    dispatch.js       # Dispatch 服务：launch/pump/settle/start/report/relay/message/cancel/retry/归档/targets
    board.js          # 看板 Host 半边：快照 + GET/POST 路由 + 同源校验
    workspaces.js     # 工作区：根/日期/安全目录名/解析/按需新建/归档
  client/
    index.js          # 浏览器半边：侧边栏图标 + 主面板 + 输入框选择器 + @ 工作区（不打包、不编译）
  test/
    tasks.test.js     # TaskTable 单测（13）
    board.test.js     # 快照与路由单测（26）
    workspaces.test.js  # 工作区纯逻辑与解析顺序单测（11）
  locale/{zh,en}.json # 管理面板里的标题与描述
  icon.svg
  LICENSE             # MIT
  docs/
    architecture.md   # 模块职责、数据流、设计取舍
    tools.md          # 9 个工具的参数/返回/错误
    troubleshooting.md  # 排障表与日志前缀
    workspaces.md     # 工作区模型、解析、归档
    board.md          # 任务看板：面板、接口、归档/工作区视图
    composer.md       # 输入框派发目标与 @ 工作区
    api-contracts.md  # DSH 主机 API 契约取证
  CHANGELOG.md
```

---

## License

MIT
