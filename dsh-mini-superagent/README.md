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
→ {"version":"0.4.0","total":0,"running":0,"max_workers":6,"tasks":[]}
```

`version` 是 `0.4.0` 说明跑的是这一版；`max_workers` 应等于配置里的 `maxWorkers`（默认 6）。

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
| `dispatch_launch` | 主会话 | 派发一个任务，立即返回 `task_id` + 子会话 id。可指定 `workspace`；并发位满时进 `queued` |
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

---

## 任务看板

Web 形态下，侧边栏会多一个「任务看板」图标（`sidebar.panellist`，`order 60`）；点开是常驻主面板（`main` 槽），
数据来自 Host 的同源 HTTP 路由 `GET /dsh-mini-superagent/board`，每 2 秒轮询一次。

**装完/升级后必须刷新一次 GUI 页面**，图标才会出现——客户端模块在页面刷新后加载，插件已激活不影响这一点。

面板从上到下：

- **顶部指标**：并发 `N/max`、排队、总计、失败（有失败时红字）；右侧「更新于 HH:MM:SS」。
- **三个过滤 chip**：全部 / 进行中（running + queued）/ 需要处理（failed + interrupted + blocked），各带计数。
- **任务行**：状态点（只有 running 脉动，`prefers-reduced-motion` 下关闭）、状态文字、标题、**第 N 次**（attempt > 1 才显示）、
  走表耗时（running 每秒走表，其余用服务端算好的值）、报告摘要首行，以及一个按钮；
  第二行是 `task_id`、报告数、摘要（悬停标题里带 `cwd` 与 worker 会话 id）。失败任务额外显示一行错误。
- **占位与提示**：加载中 / 空列表 / 筛选后为空 / 取不到数据（保留上次成功快照并提示）；取消/重试失败用顶部红条显示原因。
- **按钮**：`running` / `queued` 只给「取消」；`failed` / `interrupted` / `ended` / `blocked` 给「重试」；
  `done` / `cancelled` 没有按钮。按钮请求期间置灰并显示「取消中…/重试中…」，成功后立即重取快照。
- **刷新节奏**：页面隐藏时停表并中止在途请求，切回来立刻重取；面板卸载时清掉定时器与所有在途请求。
- **主题**：颜色全部走 `var(--dsw-alias-*, fallback)`，不写死明暗两套。

安全取舍（细节见 [docs/board.md](docs/board.md)）：

- `GET`：本机回环（`127.0.0.1` / `localhost` / `::1`）放行；非回环必须是同源页面（`Origin` 与 `Host` 一致）。
- `POST`：带 `Origin` 时必须同源，跨站请求 403；不带 `Origin` 的非浏览器客户端（curl/脚本）放行。
- 原因：插件注册的具名路由排在 DSH 页面鉴权之前。若全放开，把 Web 暴露到局域网时任何人都能读到任务标题、工作目录与报告摘要。
  代价是远程访问只能用同源页面，远程 `curl` 读不到看板。

看板快照从 0.4.0 起还带 `counts.archived` 与 `workspaces`，任务卡带 `workspace_*` / `archived_*` 字段；
`POST /dsh-mini-superagent/board/archive` 可手动跑一次归档巡检。当前面板代码未改，不显示这些字段，也没有归档按钮。

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

### 每天一个【派发】工作区

子会话默认（`workerWorkspace: day`）挂到**当天的**工作区：

```text
<workspaceRoot>/派发/<YYYY-MM-DD>      标题：【派发】YYYY-MM-DD
```

于是侧边栏里子会话按天收拢，而不是散落在每个项目下。想按项目看会话就设 `workerWorkspace: target`。

**会话住【派发】，活干在目标目录**：建完会话后插件会调 `workingDirectory.set` 把工作目录切到任务的目标路径，
所以子会话的会话归属与 `Get-Location` 不是一回事。切目录失败只记 warn，任务照跑。

### 派发到哪个工作区

`dispatch_launch` / `dispatch_launch_many` 支持：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `workspace` | — | 工作区 id / 绝对路径 / 标题，三者都可以 |
| `create_workspace` | `true` | 解析不到时是否新建（绝对路径就在该路径建，名字就在工作区根下建） |

解析顺序：**id → 绝对路径（只查不建）→ 标题精确（大小写不敏感）→ 标题包含**。
解析不到且允许新建时：绝对路径直接建在该路径；名字建在 `<workspaceRoot>/<安全目录名>`。
解析不到且 `create_workspace: false` → 报错并列出已有工作区。

同时给 `workspace` 和 `cwd` 时**工作区路径优先**，`cwd` 被忽略。完全不指定 `workspace` 时沿用调用者的工作目录。
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
| `workerWorkspace` | `day` | 子会话放哪：`day` = 当天【派发】工作区；`target` = 任务指定的目标工作区 |
| `archiveAfterHours` | `24` | 子会话结束多少小时后自动归档；`0` 表示不归档 |
| `archiveSweepMinutes` | `10` | 归档巡检间隔（分钟）；`0` 表示不巡检 |
| `leadSessionId` | `mas-lead` | 默认主会话的固定 id；改值等于换一个新默认主会话 |

单个任务还可以在 `dispatch_launch` / `dispatch_launch_many` 时覆盖 `cwd` / `workspace` / `create_workspace` /
`model` / `agent_preset` / `permission_preset`。

---

## 落盘与重启

- 任务表在 `<stateDir>/tasks.json`（默认 `$DSH_HOME/dsh-mini-superagent/tasks.json`），UTF-8，覆盖写，800ms 防抖。
- 文件结构 `{version: 2, savedAt, tasks: [...]}`；读取时不强校验版本，坏文件只记日志、不阻止插件启动。
- 插件重启后读回历史任务；进程之间没有活的 worker，所以**未结算的一律标 `interrupted`**，不假装还活着。
- 子会话本身是普通 DSH Session，内容由 DSH 自己持久化，在侧边栏里可以直接打开。
- 每个任务最多保留 50 条报告；简报落盘时截到 2000 字符（完整简报在 worker 首条消息里）。
- 任务新增 `attempt` 字段（默认 1，重试 +1），随任务表落盘；旧任务读回时按 1 处理，看板不会误显示「第 0 次」。
- 工作区相关字段也随任务落盘：`workspaceId` / `workspaceTitle` / `archivedAt` / `archiveError`（以及批次 `group`），重启后看板仍能显示工作区与归档状态。

---

## 工作方式提示

第一次从某个会话派发任务时，插件往**那个会话**的系统提示里加一段，段名 `dsh-mini-superagent`、`order: 9998`，
首行是 `[dsh-mini-superagent 工作方式]`，内容是「派发—收报告—再派发，不要用 dispatch_wait 空等」。
只加一次，且只影响这个会话；没用过派发的会话完全不受影响。

worker 的首条消息由插件拼装：任务 ID、标题、工作目录、简报，加 6 条工作规则（直接开工、完成后必须
`dispatch_report`、只有真被阻塞才报 `blocked`、汇报后收尾、不要调主会话的工具、不伪造结果）。

---

## 已知限制

- **没有持久队列**：重启时在排队的任务不会自动重跑，标 `interrupted`，由主会话决定是否重派。
- **`maxWorkers` 是软的**：`dispatch_message` 唤醒已结算的 worker 会直接置 `running`，可能短暂超过上限
  （有意的：人的追问不该排在批量任务后面）。
- **worker 能看到全部全局工具**，包括 `dispatch_launch`。插件不做 `restrict`；要更严的白名单，用 `agent_preset` 给子会话指定收紧的 preset。
- **`dispatch_wait` 阻塞当前 step**：只适合「没有它就真的没法继续」。系统提示也会劝模型别用。
- **状态文件是单写的**：多个 Harness 实例共用同一个 `DSH_HOME` 时可能互相覆盖；`stateDir` 可指到别处。
- **报告与简报有截断**：单任务 50 条报告；`dispatch_inspect` 只展示最近 5 条、简报 2000 字符、最后输出 3000 字符。
- **看板依赖 `webServer`**：headless 形态没有这个服务时不注册路由（日志会写「没有 webServer，跳过任务看板路由」），面板取不到数据；工具与派发不受影响。
- **看板最多返回 200 条**：计数按全量算，列表只截前 200；没有分页、没有历史归档。
- **远程访问受限**：非回环地址只能通过同源页面看看板，远程 `curl` 会被 403；这是有意的（见「任务看板」的安全取舍）。
- **重试有边界**：`running` / `queued` / `cancelled` 不能重试；重试沿用同一个任务 id，只把 `attempt` +1（会话无法恢复时换一个 worker 会话）。
- **工作区目录必须可写**：`workspaceRegistry.create` 要求目录已存在，插件会先 `mkdir`；目录不可写时默认工作区创建失败（只记日志），
  显式指定 `workspace` 的派发会直接报错。没有 `workspaceRegistry` 时，`day` 模式退化为按任务 cwd 建会话。
- **`workspace` 优先于 `cwd`**：两者同时给时，任务工作目录取工作区路径，`cwd` 被忽略。
- **未指定 `workspace` 时**：工作目录沿用调用者（旧行为），但子会话仍挂在当天【派发】工作区（0.3.0 的会话归属是「按目录反查工作区」）。
- **归档只收起会话**：不删目录、不删任务、不删报告；归档失败会每轮巡检重试，失败原因只在看板快照的 `archive_error` 里，`dispatch_list` 看不到。
- **看板 UI 的浏览器实测缺失**：面板渲染、侧边栏图标位置、明暗对比度、窄宽度截断、轮询暂停都只做了代码审查，未在真实 GUI 里点验（原因见验证记录）。

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

0.2.0 那组最后一条（并发排队）同时是修复验证：0.1.0 只在派发与插件加载时推进队列，结算后不会补 `pump()`，
并发位满时后面的任务会一直 `queued`。这个问题是整理代码时被测出来的，修法与依据见 [docs/architecture.md](docs/architecture.md) 的「pump 的触发点」。

0.4.0 的全量单测是 **43 pass / 0 fail**（`tasks.test.js` 13 + `board.test.js` 19 + `workspaces.test.js` 11）。

**未实测**（0.3.0）：看板在浏览器里的实际渲染——侧边栏图标位置、点击切换、明暗对比度、窄宽度截断、面板高度、轮询暂停。
原因：客户端模块要在页面刷新后才会加载，而 GUI 页面有鉴权，无法代刷；接口层与快照形状已被上面两条实测与 19 个用例覆盖。
读者只需知道：**装完/更新后刷新一次 GUI 页面**。

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
| [docs/board.md](docs/board.md) | 任务看板：入口、面板结构、HTTP 接口、重试语义、鉴权、已知限制 |
| [docs/api-contracts.md](docs/api-contracts.md) | DSH 主机 API 契约取证（消息/Agent/事件/会话控制器/工具作用域） |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0（原名 dsh-dispatch）、0.2.0、0.3.0、0.4.0 的差异 |

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
    dispatch.js       # Dispatch 服务：launch/pump/settle/start/report/relay/message/cancel/retry/归档
    board.js          # 看板 Host 半边：快照 + GET/POST 路由 + 同源校验
    workspaces.js     # 工作区：根/日期/安全目录名/解析/按需新建/归档
  client/
    index.js          # 浏览器半边：侧边栏图标 + 主面板（不打包、不编译）
  test/
    tasks.test.js     # TaskTable 单测（13）
    board.test.js     # 快照与路由单测（19）
    workspaces.test.js  # 工作区纯逻辑与解析顺序单测（11）
  locale/{zh,en}.json # 管理面板里的标题与描述
  icon.svg
  LICENSE             # MIT
  docs/
    architecture.md   # 模块职责、数据流、设计取舍
    tools.md          # 9 个工具的参数/返回/错误
    troubleshooting.md  # 排障表与日志前缀
    workspaces.md     # 工作区模型、解析、归档
    board.md          # 任务看板：面板、接口、重试、鉴权
    api-contracts.md  # DSH 主机 API 契约取证
  CHANGELOG.md
```

---

## License

MIT
