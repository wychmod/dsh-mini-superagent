# 9 个工具

全部工具注册在插件根 context，因此**对所有会话可见**。可调用性由 `execute` 里的判断决定，不靠注册作用域。

## 通用规则

- 除 `dispatch_workspaces` 外，所有工具都要求调用方处于某个 Agent 中；拿不到 `exec.agent` 就抛
  `该工具只能在某个会话（Agent）中调用`。
- 返回值统一按 JSON 文本渲染（`output.render` = `JSON.stringify(value, null, 2)`），所以你在工具结果里看到的是格式化 JSON。
- 参数用 snake_case（`agent_preset`、`permission_preset`、`create_workspace`），配置项用 camelCase（`maxWorkers`、`workspaceRoot`）。两套拼写别混。
- `dispatch_inspect` / `dispatch_message` / `dispatch_cancel` 只允许操作 `parentSessionId === 调用者 id` 的任务，跨会话访问直接报错。
- 错误一律 `throw`，没有「部分成功」的返回值；`dispatch_launch_many` 是唯一会把单项失败收进结果数组的工具。
- 9 个工具名是固定的（`src/tools.js` 的 `TOOL_NAMES`），不做别名。

### 调用矩阵

| 角色 | 应该调用 | 调了会怎样 |
| --- | --- | --- |
| 主会话（派发者） | `dispatch_launch` / `dispatch_launch_many` / `dispatch_workspaces` / `dispatch_list` / `dispatch_inspect` / `dispatch_message` / `dispatch_cancel` / `dispatch_wait` | 正常 |
| 主会话 | `dispatch_report` | 抛错：当前会话不属于任何派发任务 |
| worker | `dispatch_report` | 正常 |
| worker | `dispatch_workspaces` | 正常（只读，不要求 Agent，也不受任务归属限制） |
| worker | `dispatch_list` / `dispatch_inspect` / `dispatch_message` / `dispatch_cancel` | 看不到父会话的任务；对父任务会报「不属于本会话」 |
| worker | `dispatch_launch` | 不拦，会以 worker 自己为派发者新建任务；只受 `maxTasksPerSession` 限制。系统提示禁止这样做 |

---

## 任务对象

列表与返回值里的 `task` 是 `card`，`dispatch_inspect` 返回 `detail`。

### card

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task_id` | string | `t-<时间36>-<序号36>` |
| `title` | string | 派发时的标题（单行，≤120 字符） |
| `status` | string | `queued` / `running` / `done` / `blocked` / `failed` / `cancelled` / `ended` / `interrupted` |
| `session_id` | string | 子会话 id，固定为 `dispatch-<task_id>`（重试换会话后为 `dispatch-<task_id>-a<attempt>`） |
| `workspace` | string | 目标工作区标题，仅指定了 `workspace` 时出现 |
| `archived_at` | ISO 8601 | 子会话已归档时才出现 |
| `created_at` / `updated_at` | ISO 8601 | 创建 / 最近变更时间 |
| `last_report_at` | ISO 8601 | 有报告时才出现 |
| `reports` | integer | 报告条数（上限 50），有报告时才出现 |
| `summary` | string | 最近一条报告摘要，没有报告时取 worker 最后输出；≤200 字符 |
| `error` | string | 启动失败原因，仅失败任务出现；≤300 字符 |

### detail（= card + 以下字段）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `brief` | string | 简报，≤2000 字符（落盘同样截到 2000） |
| `cwd` | string | 子会话实际工作目录（指定 `workspace` 时为工作区路径） |
| `recent_reports` | array | 最近 5 条 `{at, status, summary, detail?}` |
| `last_worker_text` | string | worker 最后一条 assistant 文本，≤3000 字符 |

---

## dispatch_launch

派一个任务给新的后台子会话，立即返回。

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 是 | 任务短标题，超过 120 字符会被截断；用于列表与子会话标题 `[派发] <title>` |
| `brief` | string | 是 | 自包含简报：目标、约束、验收、已知事实。子会话看不到主会话历史 |
| `cwd` | string | 否 | 子会话工作目录的绝对路径。**显式 `cwd` 优先于**会话记住的派发目标（auto / 目标）；与 `workspace` 同时给时 `workspace` 决定会话归属、`cwd` 决定实际工作目录（两者分工，不是二选一丢弃）。都没有才退到继承主会话目录、进程 cwd |
| `workspace` | string | 否 | 工作区 id / 绝对路径 / 标题；解析顺序见 [workspaces.md](workspaces.md)。**任何一级命中多个都会抛错**（本版未发布起不再静默取第一个），错误里带现有工作区清单 |
| `create_workspace` | boolean | 否 | 默认 `true`；`workspace` 解析不到时是否新建（绝对路径就地建，名字在工作区根下建） |
| `model` | string | 否 | 子会话模型：`model` 或 `provider/model`；省略用部署默认。宿主不支持切换模型时这次派发失败并说明原因（不会静默改用默认） |
| `agent_preset` | string | 否 | 子会话 agent preset id；省略用部署默认 |
| `permission_preset` | string | 否 | 子会话权限预设（如 `danger-full-access`）；省略用插件配置，再省略用 DSH 默认 |

`additionalProperties: false`：多传字段会被宿主拒绝。

### 行为

1. 校验本会话累计派发数，超过 `maxTasksPerSession`（默认 64）抛错。
2. 给了 `workspace` 就先解析（id → 绝对路径 → 标题精确 → 标题包含）；解析不到且 `create_workspace !== false` 时按需新建，
   仍失败则抛错并列出已有工作区。没给 `workspace` 时用该会话的「派发目标」（输入框选择器/`@` 写入，见 [composer.md](composer.md)）；
   没有目标才沿用调用者目录。任务 `cwd` 取目标工作区路径。
   **歧义时不会新建**：`resolveOrCreate()` 返回 `reason: 'ambiguous'`，`launch()` 直接抛错——
   0.8.0 及更早会把歧义当成「不存在」然后凭空建出一个同名目录（第三个），比原来的问题更糟。
3. 生成任务 id 与子会话 id（`dispatch-<task_id>`），登记为 `queued`。
4. 首次从这个会话派发时，把 `[dsh-mini-superagent 工作方式]` 注入该会话系统提示（只一次）。
5. `pump()` 有空位就立刻建会话、投递简报、置 `running`；没空位就留在 `queued`。
   有目标工作区时子会话就挂在目标里；没有目标才按 `workerWorkspace` 兜底到【派发】或任务目录，
   然后把工作目录切到任务 `cwd`（见 [workspaces.md](workspaces.md)）。
6. 返回，不等结果。

**工作目录的优先级**（这张表的判据只有一条：**显式参数高于记住的设置**）：

| 调用方给了什么 | 结果 |
| --- | --- |
| 只给 `cwd`（会话有 auto / 记住的目标） | `cwd` 胜，auto 与记住的目标这一轮当没设过 |
| 只给 `workspace` | 用 `workspace` |
| `workspace` 与 `cwd` 同时给 | `workspace` 胜（会话住在它里面），`cwd` 仍是任务的工作目录，由 `enterDirectory()` 切过去 |
| 都不给 | 会话记住的派发目标 → 调用者目录 |

显式 `cwd` 也**不再触发日期工作区兜底**：调用方明确给了目录，就不该再被塞进当天的【派发】。

### 返回

```json
{
  "task": { "task_id": "t-m0abc-1", "title": "重构 auth 模块", "status": "running", "session_id": "dispatch-t-m0abc-1", "...": "..." },
  "note": "已入队/启动；接下来默认结束本轮，不要在本轮等它完成，报告会自己回来。"
}
```

返回的 `status` 是**返回瞬间**的状态：有空位时 `pump()` 已经同步占位，所以是 `running`；并发位满时是 `queued`。
两种都代表任务已经派出去，别把 `queued` 当成失败或没派。

### 何时用 / 何时别用

- 用：任务可独立完成，且主会话还有别的事可做。
- 用：需要子会话保留上下文、后续还要追问。
- 别用：任务之间有顺序依赖。先派 A，收到 A 的报告再派 B。

### 派发即移交（返回之后）

`dispatch_launch` 返回之后，**该任务的任何执行环节都不再由主会话进行**：读代码、`grep` / `glob`、
跑脚本、`node -e`、开浏览器、查网络、验数据、看日志、查 git 历史，全部归子会话。
判据是「这件事是不是那个任务的目标」，不是「我用的是哪个工具」——**只读调查同样属于移交范围**。

主会话对这个任务只剩两个动作：读回流回来的报告；用 `dispatch_message` 追问或纠偏。
派发之后的默认动作是**结束本轮**（结束本轮 ≠ 没回答，报告会作为消息回流并把空闲会话唤醒）。
如果主会话正要做的操作与某个在跑的任务重叠，应当立刻停手、改为结束本轮。

不变量由 `test/handoff.test.js` 钉住（`src/prompt.js` 的 `HANDOFF_RULE`）。

---

## dispatch_launch_many

批量版 `dispatch_launch`，一次派 1–16 个互相独立的任务。

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `tasks` | array | 是 | 1–16 项；每项字段与 `dispatch_launch` 完全相同（`title` / `brief` 必填，可选 `cwd` / `workspace` / `create_workspace` / `model` / `agent_preset` / `permission_preset`） |

### 行为

- 顺序逐项调用 `launch`，每项单独 try/catch：某一项失败（比如撞上派发上限）不会中断其它项。
- 不是原子操作：前几项已经登记成功，后面某项失败时，前面的任务照常执行。
- 整批任务共用一个 `group`（`g-<taskId>`）。等这一组全部结算后，插件给派发者发**一条**批次汇总，
  而不是 N 条流水；组内任一成员带 `groupClosed` 标记后不会重复汇总。

### 返回

```json
{
  "group": "g-t-m0abc-0",
  "launched": [
    { "task_id": "t-m0abc-1", "title": "重构 auth 模块", "status": "running" },
    { "title": "重构 billing 模块", "error": "Error: 本会话已派发 64 个任务，达到上限 64；请先收束旧任务" }
  ],
  "note": "全部结算后会收到一条批次汇总。"
}
```

成功项有 `task_id` / `title` / `status`，失败项只有 `title` / `error`。

### 何时用 / 何时别用

- 用：「把这 5 个模块分别重构」这类互不依赖的批量工作。
- 别用：任务数超过 16，拆成多次调用。
- 别用：想让这一批全部成功或全部不派——没有这种保证。

---

## dispatch_workspaces

只读列出工作区，供 `dispatch_launch` 的 `workspace` 参数使用。不要求调用者是 Agent。

### 参数

无（`additionalProperties: false`）。

### 返回

```json
{
  "root": "C:\\Users\\…\\Documents\\mini-superagent",
  "worker_workspace": "day",
  "archive_after_hours": 24,
  "count": 3,
  "workspaces": [
    { "workspace_id": "ws-…", "title": "mini-superagent", "path": "C:\\Users\\…\\Documents\\mini-superagent", "sessions": 1 }
  ]
}
```

- `root`：工作区根（`workspaceRoot` 或默认值）。
- `worker_workspace`：当前 `workerWorkspace` 配置（原始值；只影响无目标时的兜底）。
- `archive_after_hours`：当前归档保留期。
- `sessions`：该工作区的会话数，不是任务数。
- 注册表不可用时返回 `count: 0`、空数组。

### 何时用 / 何时别用

- 用：派发前确认目标工作区的 id / 标题 / 路径。
- 用：排查「为什么子会话不在项目里」——先确认 `workspace` 或派发目标是否存在（有目标一定在目标里），再看 `worker_workspace`（它只管无目标时的兜底）。
- 别用：它不是任务列表；看任务用 `dispatch_list` / 看板。

---

## dispatch_list

看本会话派出的任务，最新在前。

### 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `all` | boolean | 否 | `true` | `false` 只看未结算任务 |
| `limit` | integer | 否 | `20` | 1–100，返回条数上限 |

### 返回

```json
{
  "version": "0.4.0",
  "total": 3,
  "running": 2,
  "max_workers": 6,
  "tasks": [ { "task_id": "t-m0abc-2", "...": "..." } ]
}
```

- `total`：本会话累计派发数（不受 `limit` 影响）。
- `running`：**全局**正在跑的任务数，不是本会话的。
- `max_workers`：当前生效的 `maxWorkers`。

### 何时用 / 何时别用

- 用：派发后确认有没有排队、有没有卡住。
- 用：用 `version` 确认装的是哪一版。
- 别用：需要看简报、最近报告、worker 输出时用 `dispatch_inspect`——列表里的 `summary` 只有 200 字符。

---

## dispatch_inspect

看单个任务的详情。

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `task_id` | string | 是 | 任务 id，例如 `t-m0abc-1` |

### 返回

`{ "task": detail }`，字段见上文[任务对象](#任务对象)。

**退休任务也能查**（本版未发布起）：`dispatch_inspect` 走 `resolveTask()`，先查活表、再查退休留痕，所以
「记录已移出活表」不等于「查不到」。此时返回：

```json
{
  "task": { "task_id": "t-m0abc-1", "status": "done", "retired_at": "…", "retired_reason": "cap-count", "summary": "…" },
  "retired": true,
  "note": "该任务已退休：只保留留痕（何时、为什么、最后一条摘要），报告正文不可用。"
}
```

- 形状与活任务**同构**（都是 `{task: {...}}`），调用方不必为「退休」学一套新字段，只看 `retired` 这个布尔。
- `recent_reports` **缺席**（不是空数组）：正文随任务记录一起消失了，这是退休的定义。
  `note` 必须读——否则「`recent_reports` 缺失」会被误读成「它没报告过」。
- `retired_reason` 是机器串（`cap-count` / `cap-days`），别直接甩给用户。
- 归属校验照样做：退休记录带 `parentSessionId`，别人的任务仍然报「不属于本会话」。

### 何时用 / 何时别用

- 用：判断「它到底做到哪了」；`failed` 时看 `error`；`running` 太久时看 `cwd` 与 `last_worker_text`。
- 用：追问前确认上一轮报告说了什么。
- 用：任务从看板上消失、`dispatch_list` 里也没有时——它可能已退休，这里能看到「何时、为什么」。
- 别用：把 `last_worker_text` 当结论——它只是最后一条 assistant 文本，可能是不完整的过程描述。

---

## dispatch_message

给某个任务的子会话追加一条消息：补充信息、修正方向、回答它的问题，或让它接着做下一步。

### 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `task_id` | string | 是 | — | 目标任务 |
| `message` | string | 是 | — | 完整文本，自包含；worker 看不到主会话历史 |
| `mode` | string | 否 | `queue` | `queue` 排到下一轮（空闲时唤醒）；`steer` 并入当前回合的下一步 |

### 行为

1. 任务已 `cancelled` → 直接抛错，不能复活。
2. 找不到活的 worker Agent 时，尝试 `sessionController.resolveAgent` 恢复；恢复失败就抛错，不假装投递成功。
3. 任务置 `running`，记录 `turnStartedAt`。
4. 投递：`queue` 走 `followup`（目标空闲时唤醒它开新一轮）；`steer` 只在 worker 正在跑时 `steer` 当前回合，否则退化为 `followup`。

### 返回

```json
{ "task": { "...": "..." }, "note": "消息已投递；子会话处理完会再次汇报。" }
```

### 何时用 / 何时别用

- 用：报告说「遗留风险：没跑集成测试」→ 下发补充要求。
- 用：worker 报 `blocked` 并问了一个问题 → 回答它，让它继续。
- 用：`done` 之后还想让它做下一步（任务会重新 `running`）。
- 别用：想终止——用 `dispatch_cancel`。`message` 不会停掉正在跑的回合。
- 别用：`cancelled` 任务。新开一个。
- 注意：`steer` 只对运行中的 worker 有「插入当前回合」的效果；对空闲 worker 等价于排下一轮。
- 注意：对已结算任务发消息**等价于续跑**（任务重新 `running`，worker 恢复原会话继续做）。
  0.3.0 看板上的「重试」按钮走的是同一条投递路径；区别只在重试会先递增 `attempt`，并按需换新会话。

---

## dispatch_cancel

结束子会话当前回合并把任务置 `cancelled`，立即释放并发位。

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `task_id` | string | 是 | 目标任务 |
| `reason` | string | 否 | 取消原因，记录在任务的 `cancelReason` 上（`card` 里不展示） |

### 行为

1. 从排队列表移除（`queued` 任务直接消失，不再启动）。
2. 有活 Agent 则 `agent.cancel({kind:'user'}, {keepInbox:false})`：结束当前回合并清空收件箱。
3. 任务结算为 `cancelled`，写盘。

### 返回

`{ "task": card }`，`status` 为 `cancelled`。

### 何时用 / 何时别用

- 用：任务跑偏、跑太久、目标已不存在。
- 别用：只是想改方向——用 `dispatch_message`，保留已有工作与上下文。
- 注意：已产生的工作**不会回滚**（文件、提交、进程都留着），取消后自己检查工作目录。
- 注意：`cancelled` 是终局，之后 `dispatch_message` 会报错。

---

## dispatch_wait

阻塞等待若干任务结算。

### 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `task_ids` | string[] | 否 | — | 省略表示本会话全部未结算任务；列表里不存在的 id 会被静默丢弃 |
| `timeout_ms` | integer | 否 | `60000` | 1000–600000 |

### 返回

有可等任务：

```json
{ "waited": true, "tasks": [ { "task_id": "t-m0abc-1", "status": "done", "...": "..." } ] }
```

没有未结算任务：

```json
{ "waited": false, "tasks": [ { "task_id": "t-m0abc-1", "...": "..." } ] }
```

- 超时**不报错**：到点后按当前状态返回，`waited` 仍为 `true`，任务可能还是 `running`。
- 没有可等任务时返回的是本会话最新 10 条任务，供你判断。

### 何时用 / 何时别用

**默认不要调用。** 判据是穷举的，不要自行放宽：

- 用（唯一允许的情形）：用户在**同一条消息里**明确要求「等结果再继续」，且不拿到结果就无法产出他要的东西。
- 别用：其余全部情形。派发之后的默认动作是**结束本轮**——结束本轮 ≠ 没回答，报告本来会作为消息回流，
  阻塞等待只是占着当前 step，期间什么也做不了。
- 别用：当 sleep 用（`timeout_ms` 不是延时器）。超时后任务可能仍在 `running`，再等一次只是再阻塞一次。
- 明确禁止：用 `dispatch_wait` 代替结束本轮。连续多次调用尤其严重。

**这条为什么写得这么硬**：实测有人派发后连续调了约 10 次 `dispatch_wait`
（180/240/300/180/180/180/120/120/180/240 秒），累计约 33 分钟原地阻塞，期间零产出。
根因不是不知道它会阻塞，而是旧文案的判据「没有这个结果就无法继续下一步」太软——
模型总能为「等一次」找到理由。现在把允许情形绑定到用户的原话上。

不变量由 `test/handoff.test.js` 钉住（`src/prompt.js` 的 `BACKGROUND_CONTRACT` + `src/tools.js` 的工具描述）。

---

## dispatch_report

worker 向派发者汇报。主会话不要调用。

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `status` | string | 是 | `done` / `blocked` / `failed` / `progress` |
| `summary` | string | 是 | 3–6 行：做了什么、结果、需要主会话做什么（如有）。空字符串会报错；**入库上限 6000 字符**（`maxReportSummaryChars`） |
| `detail` | string | 否 | 长详情：改动清单、验证命令与输出、遗留问题；**入库上限 4000 字符**（`maxReportDetailChars`） |

### 行为

1. 找不到调用者对应的任务 → 抛错（说明它不是被派发的 worker）。
2. 任务已 `cancelled` → 返回 `{recorded:false}`，不再回流。
3. **入库即截断**（本版未发布，P0-3）：条目在写进 `task.reports` **之前**就按上面两个上限 `clip`，
   被截的条目记 `truncated: { summary: 原始长度, detail: 原始长度 }`（只在真被截时出现这个键）。
   0.8.x 只在**外发**时截，账本里存的是调用方给的原样长度——单任务体积由调用方决定是容量膨胀的根之一。
4. 追加一条 `{at, status, summary, detail?, truncated?}` 到任务的报告列表（每任务最多 50 条，超出丢最早的）。
5. `done` / `blocked` / `failed` 会把任务结算为同名状态；`progress` 只记录，不结束任务。
6. **准入分级**（本版未发布，P0-2）：决定这条报告要不要回流主会话。
   - `done` / `blocked` / `failed` / `cancelled` → **恒 `direct`**（回流）；
   - 配置 `directReportStatuses` 点名的状态（默认 `blocked` / `failed`）→ `direct`；
   - 其余（含 `progress` 与未知状态）→ **`ledger`，只入库不回流**。

   > **终态硬直通，配置只能扩展、不能降级。** 把 `directReportStatuses` 清空**不会**让 `done` 静默——
   > 结论与「需要人处理」是主会话唯一必须知道的两类事。这条与直觉相反，别以为配了这个列表就能关掉 `done`。

7. 回流主会话（仅 `direct` 命中时）：
   - `progress`：仅当主会话**正在跑**时并入下一步，不为了它唤醒空闲会话；
   - 其余：立即投递；主会话空闲时唤醒它；
   - 主会话已不在运行：只落任务表并记日志。
   - **批次成员例外**：`group` 非空的成员自己只入库，等整批结束时由批次汇总回流一条；
     但如果这一批已经汇总过、或任务被重开过，就等不到汇总了，此时它必须自己回流（否则彻底静默）。

### 返回

```json
{ "recorded": true, "task_id": "t-m0abc-1", "status": "done", "admission": "direct" }
```

只入库、不回流时（`progress` 的默认行为）：

```json
{ "recorded": true, "task_id": "t-m0abc-1", "status": "running", "admission": "ledger", "relayed": false }
```

被截断时多一个 `truncated` 字段：

```json
{ "recorded": true, "task_id": "t-m0abc-1", "status": "done", "admission": "direct", "truncated": { "summary": 9000 } }
```

> `truncated` 里的数字是**原始长度**，不是被截到的长度。想算「截到多少」，看 `dispatch_inspect` 里那条
> `recent_reports[].summary` 的字符数——它就是入库后的值（`clip` 头尾各半 + 一句提示语，总长 ≤ 上限，
> 不是「恰好 N 字」）。

任务已取消时：

```json
{ "recorded": false, "task_id": "t-m0abc-1", "note": "任务已取消，报告不再回流" }
```

### 何时用 / 何时别用

- 用：任务完成 → `done`；缺凭据/需人决策/外部依赖不可用 → `blocked` 并写清需要什么；真的失败 → `failed`。
- 用：长任务阶段性进展 → `progress`（有实质进展再报，别刷屏）。
  **注意它默认只入库**（`admission: 'ledger'`），主会话不会因此被叫醒；想让它回流，得把 `progress` 加进
  `directReportStatuses`——那时 `progressRelayIntervalMs`（默认 60s）会开始节流。
- 别用：编造结果。做不到就 `blocked`。
- 别用：把结论写进 `progress`。终态才有「必须让人知道」的保证；`progress` 只是台账。
- 注意：报完 `done` 后还在同一回合里继续做别的，主会话已经按 `done` 处理了；要续做请让主会话 `dispatch_message`。

---

## 错误信息总表

| 错误串 | 触发条件 | 处理 |
| --- | --- | --- |
| `该工具只能在某个会话（Agent）中调用` | 工具在无 Agent 的上下文里被调用 | 正常会话里调用即可 |
| `本会话已派发 N 个任务，达到上限 64；请先收束旧任务` | 超过 `maxTasksPerSession` | 取消/收束旧任务，或调大配置 |
| `没有任务 <id>` | `task_id` 不存在（或已不在任务表） | 用 `dispatch_list` 取正确 id。**退休任务不算「没有」**：`dispatch_inspect` 能查到留痕（带 `retired: true`），但 `dispatch_message` / `dispatch_cancel` / `dispatch_wait` 只认活表 |
| `任务 <id> 不属于本会话` | 操作别人的任务 | 只操作本会话派出的任务 |
| `dispatch_report 只能由被派发的 worker 调用；当前会话不属于任何派发任务` | 主会话/无关会话调用 report | 主会话不要调 report |
| `dispatch_report 需要 summary` | `summary` 为空 | 写 3–6 行摘要 |
| `任务 <id> 已取消；请重新 dispatch_launch 一个新任务` | 对 `cancelled` 任务 `dispatch_message` | 重新派发 |
| `无法解析子会话 <id>: <code>` | 建会话后 `resolveAgent` 失败，任务置 `failed`，原因在 `dispatch_inspect().error` | 看 code（如 `session/not-found`、`session/writer-held`）；修正后重新派发 |
| `子会话 <id> 不可用：<code>` | worker 会话无法恢复（如 `session/not-found`） | 看 code；必要时重新派发该任务 |
| `找不到工作区「<ref>」，且允许新建被关闭。现有：<标题>（<路径>）；…` | `workspace` 解析不到且 `create_workspace: false`；或宿主没有 `workspaceRegistry` | 用 `dispatch_workspaces` 取正确 id；去掉 `create_workspace: false`；或改用绝对路径 |

宿主 schema 层还会拒绝：`launch_many` 超过 16 项、`timeout_ms` 越界、`limit` 越界、`status`/`mode` 不在枚举内、多传未知字段。
这类错误在执行前就返回，不会留下半截任务。
