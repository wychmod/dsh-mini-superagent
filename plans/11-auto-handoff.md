# 11 · 接续由模型判断：插件只给候选、给证据、做硬校验

> **红线（本方案不含任何"相似度打分 / 阈值判定"）**：插件里不出现权重、不出现阈值、不出现"推荐分数"、
> 不出现"建议接它"，也不会自己挑一条来源任务去绑定。
> **「这两条任务是不是同一件事的延续」是语义判断，判定权在调用插件的那个 agent（主会话的模型）身上。**
> 插件只做三件事：**给候选、给证据、做硬校验**。
>
> 依据：本仓库 `dsh-mini-superagent/` 0.8.0 的真实代码（逐字段核验见 §十一），以及另一任务已落地的
> 显式复用底座（`handoff_from` / `parentTaskId` / `handoffPrompt` / `allowSessionReuse`）。
> 行号会漂（本仓库自己就在改 `src/dispatch.js`），所以下文引用一律以 **`文件:函数名/字段名`** 为准。

---

## 一、为什么不自动绑定

一句话：**插件没有语义能力，而误判的代价不对称。**

### 1.1 误判代价不对称

| 判错的方向 | 后果 | 可逆性 |
|---|---|---|
| 误判为"连续"（错接） | 新任务被塞进旧会话：旧结论、旧错误、旧分支全带进来；**模型 / preset / 权限 / 工作区在会话创建时已定死**（`src/dispatch.js` 的 `start()` 只在 `createWorker()` 时应用 `model` / `agentPreset` / `permissionPreset`），想换只能另开；顺带还有一个会话级串行约束（同一 `workerSessionId` 同时只能跑一个回合） | **基本不可逆**：已经跑出去的上下文收不回来 |
| 误判为"不连续"（漏接） | 多开一条会话，任务照常做完 | 完全可逆：用户说一句"接着上一条"再补一次即可 |

漏接的代价是"多一条会话 + 多一次说明"；错接的代价是"用户以为上下文接上了，其实接的是别人的结论"。
后者会**看起来成功**，这正是最难发现的一类故障（`#startReused` 的注释里对"新建会话冒充复用"写了同一句话）。

### 1.2 插件确实没有语义能力

- 它是 DSH 的一个 **bundle 插件、零运行时依赖**（`package.json` 无运行时依赖，`src/**` 只 import `node:*` 与宿主 ctx），**没有任何调用 LLM 的通道**；
- 账本里能拿到的只有 `title` / `brief` / `reports[]` / `status` / `cwd` / `workspace*` / 时间戳——**没有代码、没有 diff、没有意图**；
- 于是任何"插件自己判断"最终都只能退化成**写死的字符串启发式**：它不理解"精简这份文档"和"给同一模块另一个 bug 写测试"的区别，只看到两个字重合。把语义判断塞进字符串匹配，是把该由模型做的事交给正则。

### 1.3 用户口径

用户明确要求：**接不接由大模型判断，插件里不许用写死的打分 / 阈值决定。**
本仓库既有的产品口径也一致：`plans/00-vision.md` §4「工作区识别交给 agent，插件只负责解析和校验」；
`plans/08` §四 的结论是「不做自动判定，改为显式续派 + 候选建议 + 硬校验」——本方案把那句话落成实现。

### 1.4 结论：分工

| 谁 | 做什么 | 不做什么 |
|---|---|---|
| 插件（`dispatch_candidates`） | 缩小范围（同域、已结算、最近），并把**能支撑判断的素材**摊开 | 不打分、不排序推荐、不自动绑定 |
| 模型（主会话 agent） | 读素材 → 判断这是不是同一件事的延续 → 显式传 `handoff_from` + `handoff_reason` | 不绕过硬校验，不伪造来源 |
| 插件（`dispatch_launch`） | 校验（九条，§五）→ 通过才复用会话，否则**报错并说明病因** | 不猜、不降级成"看起来成功" |

---

## 二、数据流

```text
主会话模型                                  插件
    │                                          │
    ├─(不确定时) dispatch_candidates ─────────▶ │ 只读：同域 + 已结算 + 窗口内，附素材，不打分
    │ ◀────────── candidates[] / excluded ───── │
    │                                          │
    ├─ 自己判断：接 / 不接                      │
    │                                          │
    ├─ dispatch_launch({ handoff_from, ───────▶ │ 硬校验（九条，一份实现）
    │                    handoff_reason,        │   ├─ 不过 → 抛错（带 code + 病因 + 下一步），不建任务
    │                    handoff_source })      │   └─ 过   → 新建任务，复用 workerSessionId / threadId
    │ ◀── { task, handoff, note } ───────────── │        落库 parentTaskId / handoffSource / handoffReason
    │                                          │
    └─ 转述给用户「这条例程接自 X」 ───────────▶ 看板 / inspect 同步可见
```

**没有第四种路径**：不存在"插件自己发现像就接上"的分支。`handoff_from` 是唯一的复用入口，
它的值只能来自模型（或用户点名让模型传的 id）。

---

## 三、候选工具：`dispatch_candidates`（建议新增，第 10 个工具）

### 3.1 形态选择：独立工具，不做成 `dispatch_list` 的视图

结论：**独立工具**。四条理由：

| 维度 | 独立工具 | `dispatch_list({ mode: 'candidates' })` |
|---|---|---|
| 语义 | "哪些可以接"（已结算、按结算时间、带判定素材） | "我派了什么"（全量、按创建时间、含在跑） |
| 默认值 | `days=7` / `limit=5` / 排除 cancelled、archived | `all=true` / `limit=20` / 含一切 |
| 体积 | 每条带 600 字简报 + 600 字最后报告摘要；5 条 ≈ 6k 字 | 现有 `card()` **故意不含 brief**；把 brief 塞进列表会让每次列表调用都变重（最多 20 条 × 600+） |
| 误用成本 | 名字自解释；拼错参数会报错 | `mode` 拼错会静默退回全量列表，模型以为"没有候选" |

成本明示：新增第 10 个工具要改 `src/tools.js` 的 `TOOL_NAMES`，以及该文件**头部注释里的数字**
（`test/contract-consistency.test.js` 有一条断言拿它和 `TOOL_NAMES.length` 比），再在 `docs/tools.md` 增一节。
这是纯增量，不动任何既有工具的 schema。

### 3.2 输入契约

| 参数 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `limit` | integer | `5` | 1–10 | 返回候选条数上限 |
| `days` | integer | `7` | 1–30 | 只看最近 N 天**结算**的任务 |
| `cwd` | string | 会话当前派发目标的 `path`，没有则 `sessions.cwdFor()` | — | 按目录圈定"同域"，比较走 `sameDir()`（Windows 大小写 / 斜杠不敏感） |
| `workspace` | string | 会话当前派发目标（`targetFor()`） | — | 按工作区圈定；`workspace` 与 `cwd` 都给时**两个都要满足** |
| `all_workspaces` | boolean | `false` | — | `true` 时不按工作区/目录过滤（返回里 `scope.same_domain=false`），用于"我就是要跨目录看一眼"的少数场景；跨目录的候选**用不了**（§五 D9 会拒），所以默认关 |

参数刻意只有五个：候选工具是**只读、无副作用**的，不需要 `create_*`、不需要 `model`（模型/preset 的比对发生在
`dispatch_launch`，见 §五 D8）。

### 3.3 输出契约（字段逐个来自账本，来源已核验）

```jsonc
{
  "candidates": [
    {
      "task_id": "t-m0abc-1",                       // task.id
      "title": "调研 Trae 功能差异",                 // task.title
      "status": "done",                              // task.status（SETTLED 之一：done/ended/failed/blocked/interrupted）
      "settled_at": "2026-11-11T07:30:00.000Z",      // task.settledAt ?? task.updatedAt（回退时见下一行）
      "settled_basis": "settledAt",                  // "settledAt" | "updatedAt-fallback"（与 boardTask 的 time_basis 同口径）
      "age_hours": 6.2,                              // 派生：now - settled_at，保留 1 位小数
      "brief": "……（≤ handoffBriefChars 字）……",      // clip(task.brief, config.handoffBriefChars)
      "brief_chars": 4213,                           // task.brief.length（原长，总是给）
      "brief_truncated_to": 600,                     // 仅当被截时出现（与 dispatch_inspect 的 brief_truncated_to 同名同义）
      "last_report": {                               // task.reports.at(-1)；无报告时是 null
        "status": "done",                            // entry.status
        "at": "2026-11-11T07:29:41.000Z",            // entry.at
        "headline": "对照文档出好了，12 项差异",       // entry.headline（可选，worker 没写就没有这个键）
        "summary": "……（≤ handoffReportSummaryChars 字）……"  // clip(entry.summary, config.handoffReportSummaryChars)
      },
      "report_count": 4,                             // task.reports.length
      "last_text": null,                             // task.lastText 截 600 字；有报告时为 null（避免两份"结论"打架）
      "error": null,                                 // task.error 截 200 字（failed 的"为什么没成"）
      "cancel_reason": null,                         // task.cancelReason 截 200 字（cancelled 已被排除，仅旧数据可能带出）
      "thread_id": "thread-t-m0abc-1",               // task.threadId
      "parent_task_id": null,                        // task.parentTaskId ?? null（它自己就是接上去的时候有值）
      "workspace_id": "w-proj",                      // task.workspaceId（派发目标）
      "workspace_title": "项目 A",                    // task.workspaceTitle
      "host_workspace_id": "w-proj",                 // task.hostWorkspaceId（子会话实际挂在哪）
      "host_workspace_title": "项目 A",               // task.hostWorkspaceTitle
      "cwd": "D:\\idea\\x",                          // task.cwd
      "worker_session_id": "dispatch-t-m0abc-1",     // task.workerSessionId
      "model": null,                                 // task.model ?? null
      "agent_preset": null,                          // task.agentPreset ?? null
      "permission_preset": null,                     // task.permissionPreset ?? null
      "group": null,                                 // task.group ?? null（同一批派发的成员）
      "attempt": 1,                                  // task.attempt
      "created_at": "2026-11-11T05:00:00.000Z",      // task.createdAt
      "session": {                                   // 这条会话现在的占用情况
        "busy": false,                               // !!this.table.activeTaskId(task.workerSessionId)
        "active_task_id": null                       // 活跃任务 id（有的话）
      },
      "successors": {                                // 它的后继（= 已经接过它的任务）
        "active": [],                                // 未结算的后继：[{task_id,status,title}]（最多 3 条）
        "settled_count": 1                           // 已结算的后继条数
      },
      "reuse_check": {                               // 与 dispatch_launch 同一份校验函数的只读预览
        "ok": true,
        "blocked_by": []                             // ["session-busy","archived","not-settled","retired","session-missing"] 的子集
      }
    }
  ],
  "count": 1,
  "considered": 12,                                  // 本会话参与筛选的任务总数（含被排除的）
  "excluded": {                                      // 被排除的条数与原因（让"为什么没有候选"可回答）
    "not_settled": 2,
    "cancelled": 1,
    "archived": 2,
    "retired": 0,
    "outside_window": 5,
    "other_domain": 1
  },
  "scope": {
    "same_domain": true,                             // false 表示这次用了 all_workspaces
    "workspace_id": "w-proj",
    "cwd": "D:\\idea\\x",
    "days": 7,
    "limit": 5,
    "source": "session-target"                       // "explicit-args" | "session-target" | "session-cwd" | "none"
  },
  "note": "只读候选，接不接由你判断；这里没有分数也没有推荐。要接就 dispatch_launch({ handoff_from, handoff_reason })。"
}
```

**没有的字段，就是没有**：候选里**不出现** `score` / `rank` / `recommend` / `confidence` / `match` / `similarity`
这类键——这条由测试 G1（§九）把守，防止后续有人"顺手加个分"。

`reuse_check` 为什么是校验而不是打分：它只说**事实**（这条会话现在忙不忙、这条任务是不是已结算），
与 `dispatch_launch` 里真正会执行的校验**同一份实现**（`#handoffSource()` 抽出一个纯判据函数，两处共用），
所以预览结论与真实结果不会漂。它**不含任何偏好**：`ok:true` 不等于"建议接"。

### 3.4 取数规则（确定性，只负责缩小范围）

1. 范围：`this.table.ofSession(agent.id)`——**只看本会话派出的任务**（跨会话复用一律拒绝，见 D4）；
2. 排除 `cancelled`（用户已明确不要它了）、`archived`（`task.archivedAt`，只读冻结，不能当来源）、
   退休记录（本来就不在活表，只在 `this.retired` 留痕）、未结算（`!SETTLED.has(status)`）；
3. 时间窗：`now - settledAt <= days * 24h`（`settledAt` 缺失的旧数据回退 `updatedAt` 并标 `updatedAt-fallback`）；
4. 同域：`sameDir(task.cwd, scope.cwd)`；给了 `workspace` 时还要求 `task.workspaceId === scope.workspaceId`
   （来源没有 `workspaceId` 时比 `cwd`，与 `#handoffSource()` 同一判据）；`all_workspaces: true` 时跳过；
5. 排序：`settled_at` 降序，时间相同则 `createdAt` 降序；**不按"像不像"排**；
6. 截断到 `limit`；`excluded` 里的计数按原因累加。

### 3.5 明确不做

- 不排序推荐、不给"最可能"、不给 top-1 高亮；
- 不因为"只有一条候选"就自动绑定；
- 不把 `dispatch_candidates` 设成派发的前置条件（模型可以完全不调用它，直接传 `handoff_from`——用户点名时就应该这样）；
- 不返回退休记录的正文（退休只留痕：`id/title/status/summary/threadId/parentTaskId`，见 `#retire()`）。

### 3.6 请求体积

最坏情况：5 条 ×（600 字简报 + 600 字摘要 + ~300 字结构字段）≈ 7.5k 字符。这个工具**只在模型不确定时才调**，
不是每次派发都调；`autoHandoff` 打开时提示词也只是"不确定就调"，不强制。

---

## 四、`handoff_from` / `handoff_reason` / `no_reuse` 的优先级与错误

### 4.1 优先级链（确定，不猜）

```text
① 参数互斥检查（先于一切建任务动作）
   continue_task_id × handoff_from   → 报错
   continue_task_id × no_reuse       → 报错
   handoff_from     × no_reuse:true  → 报错
② continue_task_id 单独  → 模型 A：同一个任务追加要求（不新建任务，无独立记录）
③ handoff_from 单独      → 模型 B：新建任务 + 复用来源子会话（本规格的主路径）
④ no_reuse: true 单独    → 普通新派（模型显式说"别接"），落 handoffDecision='fresh-explicit'
⑤ 都不传                 → 普通新派，行为与 0.8.0 逐字一致（红线：插件不自己挑来源）
```

`no_reuse` 与 `handoff_from` 同传**必须报错**，理由是它和 `continue_task_id × handoff_from` 同一类问题：
两条指令在语义上互斥，按任何一方"赢"都会静默改变结果，事后只能从"怎么少/多了一条任务"去反推。
**优先级链里没有"插件自己猜"这一层。**

`handoff_reason` 与 `handoff_source`：
- 只在 `handoff_from` 存在时有意义；单独出现 → 报错（避免模型以为"写了理由就算接上了"）；
- `handoff_reason`：1–200 个 code point；空串按"未给"处理；超长 → 报错（"一句话"是这个字段的语义边界，超长说明写成了别的东西）；
- `handoff_source`：`enum ['explicit','agent']`，默认 `'agent'`（见 §六）。

### 4.2 错误情形表

| # | 情形 | code（`src/constants.js` 的 `ERROR_CODES`） | 是否建任务 | 文案要点（必须有"下一步"） |
|---|---|---|---|---|
| E1 | `continue_task_id` + `handoff_from` 同传（**已落地**，`src/tools.js`） | `dispatch/bad-args` | 否 | 两个参数各是什么、只能选一个 |
| E2 | `continue_task_id` + `no_reuse` 同传 | `dispatch/bad-args` | 否 | `no_reuse` 只约束"新任务的会话从哪来"，续派没有新任务 |
| E3 | `handoff_from` + `no_reuse:true` 同传 | `dispatch/bad-args` | 否 | "要接就别要新会话" |
| E4 | `handoff_reason` 给了但没 `handoff_from` | `dispatch/bad-args` | 否 | 理由只有在"要接"时才有意义 |
| E5 | `handoff_reason` 超 200 字 | `dispatch/bad-args` | 否 | 一句话即可，超长会挤掉看板展示 |
| E6 | `handoff_source` 不在枚举里 / 单独出现 | `dispatch/bad-args` | 否 | 允许值两个 |
| E7 | 来源 id 不存在 | `dispatch/not-found` | 否 | 先用 `dispatch_candidates` / `dispatch_list` 查 |
| E8 | 来源已退休 | `dispatch/not-found` | 否 | 记录已移出活表，会话没有可核对的上下文 |
| E9 | 来源已归档 | `dispatch/bad-state` | 否 | 归档是只读冻结 |
| E10 | 来源不属于本会话 | `dispatch/forbidden` | 否 | 不能复用别人的子会话 |
| E11 | 来源还没结算（running/queued） | `dispatch/conflict` | 否 | 一个会话同一时刻只能跑一个回合 → 等它结算 |
| E12 | 子会话 id 不是 `dispatch-*` | `dispatch/bad-args` | 否 | 形状判据（`isWorkerSessionId()`） |
| E13 | **同会话还有其它活跃任务** | `dispatch/conflict` | 否 | 见 §五 D7；给出活跃任务的 id + 状态 |
| E14 | `cwd` 与来源不一致 / 来源没记 cwd | `dispatch/conflict` | 否 | 两侧路径都写出来（复用不跨目录） |
| E15 | `workspace` 解析不到 / 与来源不一致 | `dispatch/conflict` | 否 | 两侧工作区都写出来 |
| E16 | `model` / `agent_preset` / `permission_preset` 与来源不一致 | `dispatch/conflict` | 否 | 会话创建时已定死 → 要比对"有效值"（D8） |
| E17 | `allowSessionReuse: false` 时传了 `handoff_from` | 无（不报错） | **是**（降级为新派） | **已落地的行为**：不静默忽略，在返回值 `reuse_degraded: true` + `note` 里说明"配置关掉了复用"。本规格保留这一行为（`src/dispatch.js` 的 `reuseSession` / `degradedNote`） |
| E18 | 启动时来源子会话已不存在 | `dispatch/bad-state` | 是（任务建了，随后 failed） | **已落地**：`#resolveReusedAgent()` 明确失败，绝不用新会话冒充复用 |

> 注意 `code` 现状：已落地的 `#handoffSource()` 抛的是**裸 `Error`**，经 `src/tools.js` 的 `withErrorCode()` 会被归一成
> `dispatch/internal`。**本规格要求 E7–E16 显式使用 `fail(code, msg)`**（`src/constants.js` 的 `fail()`），
> 否则看板与排障脚本无法按类统计——这正是 `ERROR_CODES` 存在的理由。

### 4.3 与已落地底座的关系

| 能力 | 状态 |
|---|---|
| `handoff_from` 参数、互斥检查、`handoffFrom` 进 `launch()` | **已落地**（`src/tools.js`、`src/dispatch.js` 的 `launch()`） |
| `allowSessionReuse` 降级 + `reuseNotice()` | **已落地** |
| `#handoffSource()` 八条校验、`#launchReused()`、`parentTaskId` / `threadId` 继承 | **已落地** |
| `handoffPrompt()`（1200 字上限的四段交接摘要） | **已落地**（`src/prompt.js`） |
| `dispatch_candidates` 工具、`handoff_reason`、`handoff_source`、`no_reuse`、`handoffCandidates` 计数、会话级互斥 D7、有效值比对 D8 | **本规格要加** |

---

## 五、硬校验：一份实现，两个入口

### 5.1 九条（顺序 = 便宜的在前面，报错永远指向真正的病因）

| # | 判据 | 取数来源 | 不过时 |
|---|---|---|---|
| D1 | 来源存在 | `dispatch.resolveTask(id)`（活表 → 退休留痕） | E7 |
| D2 | 非退休 | `dispatch.isRetired(record)`（`retiredReason` 非空） | E8 |
| D3 | 非归档 | `task.archivedAt`（`archiveTask()` 写 `archivedAt` + `frozenAt`） | E9 |
| D4 | 同会话归属 | `task.parentSessionId === agent.id` | E10 |
| D5 | 已结算 | `SETTLED.has(task.status)`（`src/constants.js`：done/blocked/failed/cancelled/ended/interrupted） | E11 |
| D6 | 会话形状 | `isWorkerSessionId(task.workerSessionId)`（必须以 `WORKER_PREFIX`=`dispatch-` 开头） | E12 |
| D7 | **同会话无其它活跃任务** | `this.table.tasksOfWorker(task.workerSessionId)` 里除来源外还有 `queued`/`running` | E13 |
| D8 | 模型 / preset 一致（**比有效值**） | 见 §5.2 | E16 |
| D9 | 工作区 / cwd 一致 | `sameDir(task.cwd, input.cwd)`；`workspace` 解析后比 `task.workspaceId`，没有 id 时比 `path` | E14 / E15 |

> 顺序说明：D7 是**新增且必要**的一条。已落地的八条只要求来源"已结算"，但没看**这条会话上有没有别的活**。
> 复用的语义是"把新要求投进同一条会话"，而一个会话同一时刻只跑一个回合：
> 若来源已结算、但之前接过它的那条任务还在 `running`，再 `handoff_from` 来源就会让两条任务共用一条会话且并发，
> 报告归属与取消立刻串账（`plans/08` §三.1/§三.3 记的就是这件事）。

### 5.2 D8 为什么必须比"有效值"

会话创建时实际用的是**合并后的值**：

- `agentPreset: task.agentPreset || this.config.workerAgentPreset || undefined`（`start()` 里 `createWorker()` 的参数）
- `permissionPreset: task.permissionPreset`（空则落配置或宿主默认）
- `model: task.model`（空则部署默认）

所以比对必须按"这条会话当时真正拿到的那套设置"算：

```js
effectiveModel(task)      = task.model ?? ''
effectiveAgentPreset(task)= task.agentPreset || config.workerAgentPreset || ''
effectivePermission(task) = task.permissionPreset ?? config.permissionPreset ?? ''
```

直接比 `task.agentPreset` 的裸值会误拒：来源的 `agentPreset` 是 `undefined`、本次显式传了
`workerAgentPreset` 的同一个值——两边实际一模一样，裸比对却判成"不一致"。

### 5.3 校验只在 `launch()` 里发生一次

- `dispatch_candidates` 调**同一个判据函数**（`reuse_check`），但它只读、只报告；
- `dispatch_launch` 在**建任务之前**跑完整校验，不通过就抛错、**一个字节都不写**；
- 校验实现只有一份：`#handoffSource()` 抽成 `checkHandoffSource(sourceTask, input, cfg) → {ok, blocked_by[]}`，
  候选工具调用它的只读部分（不需要新任务的 `model`/`cwd` 时跳过 D8/D9 中依赖新参数的那一半）。

---

## 六、可观测：谁决定的、为什么、看过几个候选

### 6.1 账本字段（都随 `{...task}` 落盘，`restore()` 的 `{...item}` 读回，**不需要改 `src/store.js`**）

| 字段 | 类型 | 何时写 | 说明 |
|---|---|---|---|
| `parentTaskId` | string \| undefined | 复用成功时 | **已落地**：来源任务 id（"这条的会话是借来的"） |
| `threadId` | string | 建任务时 | **已落地**：复用复制来源的 `threadId`（同一条工作线） |
| `handoffSource` | `'explicit' \| 'agent'` | 复用成功时 | **谁决定的**：`explicit`=用户点名接哪条；`agent`=模型看候选后自己判断 |
| `handoffReason` | string \| undefined | 复用成功时 | 模型写的一句话（≤200 字），**给人和审计看**，不参与任何计算 |
| `handoffDecidedAt` | ISO string | 复用成功时 | 落库时刻（`now()`） |
| `handoffCandidates` | `{ seen: number, at?: ISO }` | 复用成功时 | **插件实测**：本次会话在 TTL（30 分钟）内调用过 `dispatch_candidates` 的返回条数；没调过就是 `seen: 0` |

为什么不信任模型自报"我看过几个候选"：`seen` 由插件在 `dispatch_candidates` 的 execute 里记账
（`Dispatch` 内存 Map：`sessionId → {count, at}`），`dispatch_launch` 时读一次并落库。
TTL 之外的不算（否则一周前查过一次候选，今天任何一次复用都显示"看过"）。
`seen: 0` **不阻断**派发（用户点名时本来就不需要查候选），只在看板上标一个"未看候选"的小角标，供事后归因。

### 6.2 工具返回值

`dispatch_launch` 复用成功时（在已落地的 `handoff: true` / `reused_session` 之上补三个键）：

```jsonc
{
  "task": { /* card，含 parent_task_id / handed_from */ },
  "handoff": true,
  "reused_session": "dispatch-t-m0abc-1",
  "handoff_from": "t-m0abc-1",
  "handoff_title": "调研 Trae 功能差异",      // 来源任务短标签（shortLabel）
  "handoff_source": "agent",
  "handoff_reason": "把上一轮那份 Trae 对照文档精简到 5 项关键差异",
  "handoff_candidates_seen": 3,
  "note": "已新建任务，沿用「调研 Trae 功能差异」的子会话（上下文接着走，模型/工作区不变）；这是独立的一条任务，有独立的记录与报告链。接下来默认结束本轮，报告会自己回来。"
}
```

`note` 里的那句话是**给人看的**：短标签而不是 id、说清"接自谁"、说清"独立记录"、给出下一步。
没有 `handoff_reason` 时补一句"（没写 handoff_reason，看板只显示接自谁）"——**不替模型编理由**。

### 6.3 三个视图

| 视图 | 加什么 | 为什么 |
|---|---|---|
| `dispatch.card()`（`dispatch_list` / `dispatch_wait` / 看板共用） | `parent_task_id`、`handed_from`（来源短标签）、`handoff_source`——**只在有值时出现** | 列表里就能看出"这条例程是接上去的"，不必再 inspect |
| `dispatch.detail()`（`dispatch_inspect`） | `handoff: { from, title, source, reason, decided_at, candidates_seen }` | 事后回答"这条为什么接了上一条、谁决定的、看过几个候选" |
| `board.js` 的 `boardTask()` + 客户端行 | `parent_task_id`、`handed_from_title`、`handoff_source`；行上一个 chip：`接自 调研 Trae 功能差异`，点开是 `handoff_reason` | 用户**不看日志**也能知道这条接的是哪条；`handoff_source==='agent'` 时 chip 上加个"模型判断"的小字，便于评估 |

> 现状：`card()` / `detail()` / `boardTask()` **都还没有** `parentTaskId`（目前只有退休留痕带了它）。
> 这是本规格要求补的第一处可观测缺口。

### 6.4 人话文案样例（三处，都用短标签、不报 id）

- 派发成功（工具 `note`）：
  「已新建任务，沿用「调研 Trae 功能差异」的子会话（上下文接着走，模型/工作区不变）；这是独立的一条任务，有独立的记录与报告链。」
- 模型自己决定接的（`handoff_source: 'agent'`）：
  「这条接了「调研 Trae 功能差异」——同一份对照文档的线程；理由：把那份文档精简到 5 项。」
- 用户点名接的（`handoff_source: 'explicit'`）：
  「按你说的，接了「调研 Trae 功能差异」的子会话。」
- 降级（`allowSessionReuse: false`）——**已落地**：
  「配置 allowSessionReuse=false：本次已降级为普通新派，没有沿用任务 t-xxx 的子会话。」（含"怎么恢复"）

### 6.5 统计（可选，P2）

`memoryStats()` 里加一块 `handoff: { explicit, agent, degraded, no_candidates_seen }`。
只统计本进程生命周期内的计数，与现有 `admissionCounts` / `projectionCounts` 同一套写法。
**不统计"准确率"**——插件没有真值，无法判断一次复用对不对；准确率只能靠人抽样。

---

## 七、提示词指引：让模型主动想一次"这是不是接着上一条"

### 7.1 现有门禁的实测约束（先量再写）

- 「说话方式」段（`SPEAK_RULE`，`src/prompt.js`）受 `test/voice-prompt.test.js` 门禁约束：**≤8 行、≤500 字**
  （`VOICE_SECTION.MAX_LINES` / `MAX_CHARS`，按 code point 数）。
- 实测当前装配结果（用真实装配链路量，不是数源码常量）：

  ```text
  lines = 8   （正好 8/8，零行余量）
  chars = 481 （481/500，剩 19 字）
  ```

**结论：一个字的新规则都塞不进 `SPEAK_RULE`**（加一行立刻破 `MAX_LINES`）。

### 7.2 落点：新增独立段 `HANDOFF_JUDGE_RULE`

- 位置：`src/prompt.js` 里新增常量，在 `DISPATCH_HINT` 与 `FORCED_HINT` 的拼装顺序中
  **放在 `SPEAK_RULE` 之后、`HANDOFF_RULE` 之前**（两处顺序必须一致：机制 → 怎么说 → **要不要接** → 派出去之后的职责 → 有任务在飞时能做什么）；
- 开关：`config.autoHandoff === true` 时才拼进去（默认 `false`，见 §八）；
- 体量：**5 行 / 233 字**（实测；门禁建议 ≤5 行 / ≤250 字，留 17 字余量）；
- 原文（可直接落地）：

```text
接续判断（接不接上一条由你判断；插件只给候选，不打分）:
- 派发前先想一次：这条是不是接着某条已做完的任务？不确定就调 dispatch_candidates。
- 只有「同一份产物 / 同一条工作线」才接（接着改、补测试、精简这份文档）；同目录修别的问题不算。
- 要接就传 handoff_from + handoff_reason（一句话，给用户看懂）；不接照常派。
- 拿不准就不接：接错的会话带着旧结论和旧分支，模型 / preset / 目录跟着锁死。
```

这段刻意做到四件事：① 把决定权明确交给模型（"由你判断""插件不打分"）；② 给一条可操作的动作（不确定就调候选）；
③ 给**判据的边界**（同一份产物/同一条工作线 vs 同目录不同问题）——这是最容易搞混的一处；
④ 给保守方向的理由（接错的代价），与 §一 的结论一致。

### 7.3 新增门禁（新测试文件，或并入 `test/voice-prompt.test.js`）

| 断言 | 内容 |
|---|---|
| P1 | `autoHandoff: false` → 装配出的提示**不含**接续段（用真实 `refreshHint()` 链路量） |
| P2 | `autoHandoff: true` → 含，且**≤5 行 / ≤250 字**（`Array.from().length`） |
| P3 | 位置：接续段在 `SPEAK_RULE` 之后、`HANDOFF_RULE` 之前（按段标题定位） |
| P4 | 既有门禁仍绿：`SPEAK_RULE` 仍是 8/8 行、≤500 字（不动它） |
| P5 | 段里必须出现"由你判断"与"不打分"两个锚点（防止后续被改回"插件建议接 X"） |

### 7.4 `autoHandoff` 的语义（与旧稿的关键差别）

| 旧（已废弃） | 新 |
|---|---|
| "是否让插件自动绑定" | **"是否把候选 + 判断指引注入主会话提示"** |
| 打开 = 插件自己决定接不接 | 打开 = **提醒模型去考虑延续**，决定权仍在模型 |
| 关掉 = 功能不存在 | 关掉 = 提示里不提这件事；`dispatch_candidates` / `handoff_from` 照常可用 |

### 7.5 为什么不加进 `SPEAK_RULE`

1. 空间：8/8 行已满（§7.1）；
2. 语义：`SPEAK_RULE` 管的是**对用户怎么说话**（plans/10 §五），接续判断是**派发前的决策**；
   混进去会让"语气规则"里出现一条动作规则，而模型对两类的遵守方式不同（动作会被执行、语气会被变通）；
3. 可回滚：独立段可以整段开关（`autoHandoff`），塞进 `SPEAK_RULE` 就只能改文案。

---

## 八、配置项与回滚

| 键 | 默认 | 落点 | 语义与理由 |
|---|---|---|---|
| `allowSessionReuse` | `true` | **已落地**（`src/constants.js` 的 `DEFAULTS`） | 复用总开关。`false` 时 `handoff_from` **降级为新派 + note**（不静默）。这是唯一能"一键回到没有复用"的开关 |
| `autoHandoff` | **`false`** | 新增 | **只控制提示注入**（§7.4）。默认关：它改变的是模型行为，而"模型更愿意考虑延续"这件事需要实测——开着它，模型会开始用一个新的工具、新的参数，出问题时的表现是"多接了一条"，不是报错。用法是先在单机打开跑两周、看 `handoffSource` 分布与抽查准确率，再决定是否随版本默认打开 |
| `handoffCandidatesDays` | `7` | 新增 | 候选窗口。**与 `archiveAfterHours: 168`（7 天）对齐**：更老的任务会被归档巡检收走，而归档任务不能当来源（D3）→ 窗口超过 7 天只会返回一堆 `reuse_check.blocked_by:['archived']` 的候选 |
| `handoffCandidatesLimit` | `5` | 新增 | 每次返回上限（工具参数 1–10 可覆盖）。5 条 × ~1.5k 字 ≈ 7.5k 字符，可控；再多边际收益低 |
| `handoffBriefChars` | `600` | 新增 | 候选简报截断。与 `dispatch_inspect` 的 2000 区分：候选是"扫一眼挑一个"，不是详情 |
| `handoffReportSummaryChars` | `600` | 新增 | 候选最后报告摘要截断（入库上限 `maxReportSummaryChars` 可能更大，这里二次裁） |

### 8.1 逃生门

| 场景 | 手段 |
|---|---|
| 这一次就是不要接 | `dispatch_launch({ no_reuse: true })`：显式新开会话，落 `handoffDecision='fresh-explicit'`，**不打分、不查候选** |
| 这一类都不要接 | `allowSessionReuse: false`（总开关；`handoff_from` 降级 + note） |
| 不想让模型被提示影响 | `autoHandoff: false`（提示里不提接续，工具仍然可用） |
| 接错了怎么办 | **跑起来的接不回来**：会话历史已经带上旧上下文，插件没有"抽走历史"的能力。纠正 = `dispatch_cancel` 那条 → `dispatch_launch({ no_reuse: true })` 重派。**尚未启动**（`queued` 且无 `startedAt`）的任务理论上可改，但本规格**不提供**该命令（P2）：它要么新增第 11 个工具，要么在看板上做状态机中途改写，两条都超出"只增加候选能力"的范围；`retry()` 里已有的"换 attempt 会话即解除 `parentTaskId`"是内部路径，不宜直接暴露 |

"接错了就取消重派"必须写进文档而不是留给用户猜：错接的代价已经被 §一 认定为最高的一类，
所以它的纠正手段必须显式、可执行、且诚实说明"不可逆"。

---

## 九、契约测试用例清单（验证契约，不验证"像不像"）

> 新文件建议 `test/handoff-candidates.test.js`（候选 + 参数）与 `test/handoff-record.test.js`（落库 + 视图），
> 与既有 `test/*.test.js` 同一套夹具风格（假 `ctx` + 临时 `stateDir`）。

| # | 组 | 输入 | 期望断言 |
|---|---|---|---|
| A1 | 候选契约 | 3 条已结算任务（done/ended/failed），1 条 running | 返回 3 条；每条含 §3.3 的**全部**字段；running 不计入 |
| A2 | 候选契约 | 一条 `cancelled` | 不返回；`excluded.cancelled === 1` |
| A3 | 候选契约 | 一条 `archivedAt` 已设 | 不返回；`excluded.archived === 1` |
| A4 | 候选契约 | 一条已退休（`this.retired` 有留痕） | 不返回；`excluded.retired` 计数正确；返回里不含它的 `brief`/`reports` |
| A5 | 候选契约 | 一条结算于 8 天前（`days=7`） | 不返回；`excluded.outside_window === 1`；`days=30` 时返回 |
| A6 | 候选契约 | 两条同工作区、一条另一 `cwd` | 默认只返回同域那条；`all_workspaces: true` 时两条都返回且 `scope.same_domain === false` |
| A7 | 候选契约 | `settledAt` 有值 / 缺失（旧账本）两种 | 有值 → `settled_basis: 'settledAt'`；缺失 → `'updatedAt-fallback'` 且 `settled_at` 取 `updatedAt` |
| A8 | 候选契约 | 三条不同结算时刻 | 按 `settled_at` 降序；不按标题、不按任何"像不像" |
| B1 | 素材 | `brief` 2000 字 | `brief` 截到 600 字；`brief_chars === 2000`；`brief_truncated_to === 600` |
| B2 | 素材 | 一条没有任何报告的任务 | `last_report === null`（不是 `{}`）；`report_count === 0`；`last_text` 有值（若 `lastText` 非空） |
| B3 | 素材 | 两条以上报告 + `headline` 有无各一 | `last_report` 取**最后一条**；有 `headline` 就带、没有就没有这个键 |
| B4 | 素材 | 一条 `failed`（`task.error` 有值）、一条 `interrupted` | `error` 带出（≤200 字）；`status` 如实是 `failed` / `interrupted`（**不因"failed"被隐藏**——那是模型要判断的信息） |
| B5 | 素材 | 候选已有 1 条 running 后继 + 1 条 done 后继 | `successors.active` 含 running 那条（含 `task_id`/`status`/`title`）；`settled_count === 1` |
| B6 | 素材 | 候选会话上有活跃任务（用 `#launchReused` 造一条 running 复用任务） | `session.busy === true`；`reuse_check.blocked_by` 含 `session-busy`；`reuse_check.ok === false` |
| C1 | 优先级 | `handoff_from` + `no_reuse: true` | 抛 `dispatch/bad-args`；**任务表条数不变** |
| C2 | 优先级 | `continue_task_id` + `handoff_from` | 抛 `dispatch/bad-args`（既有行为，回归） |
| C3 | 优先级 | `continue_task_id` + `no_reuse: true` | 抛 `dispatch/bad-args` |
| C4 | 优先级 | `handoff_reason` 单独给 | 抛 `dispatch/bad-args` |
| C5 | 优先级 | `handoff_reason` 201 字 / 空串 | 201 字 → 抛错；空串 → 视为未给，正常复用成功且无 `handoffReason` |
| C6 | 优先级 | `no_reuse: true` 单独 | 与不传任何参数**逐字段一致**（无 `parentTaskId`、无 `handoffSource`），仅多一个 `handoffDecision: 'fresh-explicit'` |
| V1 | 硬校验 | 来源 `running` | 抛 `dispatch/conflict`（文案含"一个子会话同一时刻只能跑一个回合"）；不建任务 |
| V2 | 硬校验 | 来源已退休 / 已归档 | 分别抛 `not-found` / `bad-state`；不建任务 |
| V3 | 硬校验 | 来源属于另一个主会话 | 抛 `dispatch/forbidden` |
| V4 | 硬校验 | `cwd` 与来源不同 / 来源 `cwd` 为空 | 抛 `dispatch/conflict`，文案含两侧路径 |
| V5 | 硬校验 | 来源已结算，但同 `workerSessionId` 上还有 `running` 任务 | 抛 `dispatch/conflict`（对应 §五 **D7**，**本次要补的关键用例**） |
| V6 | 硬校验 | 来源 `agentPreset === undefined`、`config.workerAgentPreset = 'p1'`、本次传 `agent_preset = 'p1'` | **通过**（比有效值，§五 D8）；改成传 `'p2'` → 抛 `dispatch/conflict` |
| E1 | 落库 | `handoff_from` + `handoff_reason` + `handoff_source:'explicit'` | 任务上 `parentTaskId` / `handoffReason` / `handoffSource === 'explicit'` / `handoffDecidedAt` 都有；`threadId` 等于来源 |
| E2 | 落库 | 省略 `handoff_source` | 落 `'agent'`（默认值），并有注释说明这是"故意把无法归因的算作 agent" |
| E3 | 落库 | 先调 `dispatch_candidates`（返回 3 条）再 `handoff_from` | `task.handoffCandidates.seen === 3`；不调候选直接复用 → `seen === 0` |
| E4 | 落库 | 复用任务结算 → `#retire()` | 退休留痕里带 `parentTaskId`（已有）；**新增带 `handoffSource`/`handoffReason`** |
| F1 | 视图 | `dispatch_list` / `dispatch_inspect` / `/board` | card 带 `parent_task_id` + `handed_from`；detail 带完整 `handoff` 块；`boardTask()` 带 `handed_from_title` / `handoff_source` |
| F2 | 视图 | 普通（非复用）任务 | 三个视图都**不出现**任何 `handoff*` 键（不污染既有契约） |
| G1 | 回归 | 不传任何新参数派发 | 与 0.8.0 逐字一致：无 `parentTaskId`、无 `handoffSource`；`dispatch_launch` 返回值不含 `handoff` 键 |
| G2 | 红线 | 对 `dispatch_candidates` 的返回 JSON 做否定断言 | 不含 `score` / `rank` / `recommend` / `confidence` / `match` / `similarity`（防止后人把打分加回来） |
| P1 | 提示词 | `autoHandoff:false` / `true` | 分别为"不含接续段" / "含且 ≤5 行 ≤250 字"；位置在 `SPEAK_RULE` 之后 `HANDOFF_RULE` 之前 |
| P2 | 提示词 | 既有门禁 | `SPEAK_RULE` 仍 8 行 / ≤500 字（**不动它**）；`test/voice-prompt.test.js` 全绿 |

共 36 条，其中 **G2 与 P1 是"方案红线"用例**：前者钉住"插件不打分"，后者钉住"提示词没挤爆既有门禁"。

---

## 十、落地清单（文件级，含并发冲突面）

> ⚠️ 另一个任务正在改 `src/dispatch.js` / `src/tools.js` / `src/prompt.js` / `src/tasks.js` / `src/store.js` /
> `src/constants.js` / `test/`。以下清单是**后续任务**的依据，本次只写本文档，不改任何代码。

| 步骤 | 文件 | 内容 | 冲突风险 |
|---|---|---|---|
| 1 | `src/dispatch.js` | 把 `#handoffSource()` 的判据抽成 `checkHandoffSource()`（纯函数式，返回 `{ok, blocked_by[]}`），并补 D7 会话级互斥 + D8 有效值比对；E7–E16 改用 `fail(code,msg)` | **高**（对方正在改同一函数） |
| 2 | `src/dispatch.js` | 新增 `candidates(agent, input)`：按 §3.4 取数 + §3.3 投影；`sameDir()` 从模块私有导出（候选与校验共用一份） | 高 |
| 3 | `src/tools.js` | 新增第 10 个工具 `dispatch_candidates`（§3.2 参数）；`dispatch_launch` 增 `handoff_reason` / `handoff_source` / `no_reuse`（§4.1 互斥）；返回值补 §6.2 三键；**同步改文件头注释里的工具数** | 高 |
| 4 | `src/prompt.js` | 新增 `HANDOFF_JUDGE_RULE`（§7.2 文本）+ 两处拼装位置 | 高 |
| 5 | `src/constants.js` | `DEFAULTS` 增 `autoHandoff/handoffCandidatesDays/handoffCandidatesLimit/handoffBriefChars/handoffReportSummaryChars`；新增 `HANDOFF_JUDGE` 段落标题与行/字上限常量 | 中 |
| 6 | `src/dispatch.js` | `card()` / `detail()` 补 §6.3 字段；`#retire()` 留痕补 `handoffSource`/`handoffReason`；`handoffCandidates` 记账 Map + TTL | 中 |
| 7 | `src/board.js` + `client/index.js` | `boardTask()` 补三字段；行上一个 `接自 X` chip | 低 |
| 8 | `test/handoff-candidates.test.js` / `test/handoff-record.test.js` / `test/voice-prompt.test.js` | §九 的 36 条 | 中 |
| 9 | `docs/tools.md` / `docs/api-contracts.md` / `plans/README.md` / `CHANGELOG.md` | 工具文档、契约、索引、变更记录 | 低（索引由后续任务同步） |

---

## 十一、字段核验（不要编造字段名）

本文用到的账本字段，逐个在真实代码里确认过（行号会漂，按函数名/字段名 grep）：

| 字段 | 位置（来源） |
|---|---|
| `id / title / brief / parentSessionId / workerSessionId / threadId / status / attempt / createdAt / updatedAt / lastReportAt / lastText / reports / cwd / workspaceId / workspaceTitle / model / agentPreset / permissionPreset / group` | `src/dispatch.js` 的 `launch()` 里构造的 `task` 对象 |
| `settledAt` | `src/tasks.js` 的 `settle()` / `transition()` / `#markSettled()`（幂等；离开终态被清空） |
| `parentTaskId` | `src/dispatch.js` 的 `#launchReused()`；退休留痕 `#retire()`；`retry()` 换会话时清掉 |
| `startedAt` | `src/dispatch.js` 的 `start()` |
| `hostWorkspaceId / hostWorkspaceTitle` | `src/dispatch.js` 的 `start()`（`placement` 之后写） |
| `archivedAt / frozenAt` | `src/dispatch.js` 的 `archiveTask()` / `archiveStale()` |
| `error / cancelReason / backgroundNote / taskDir / prepareAt` | `src/dispatch.js` 的 `failTurn()` / `cancel()` / `finishIdleTurn()` / `prepareTaskDir()` |
| `reports[]` 条目形状 `{at,status,headline?,summary,detail?,truncated?}` | `src/dispatch.js` 的 `#admitEntry()` |
| `SETTLED` = done/blocked/failed/cancelled/ended/interrupted | `src/constants.js` |
| `ERROR_CODES` | `src/constants.js`（`dispatch/bad-args` 等 7 个闭集） |
| `WORKER_PREFIX` = `'dispatch-'`、`isWorkerSessionId()` | `src/constants.js` |
| `HANDOFF_MAX_CHARS` = 1200 | `src/constants.js`（由 `handoffPrompt()` 用） |
| `VOICE_SECTION.MAX_LINES/MAX_CHARS` = 8/500 | `src/constants.js`，实测装配后 8 行/481 字 |
| `table.ofSession()` / `table.tasksOfWorker()` / `table.activeTaskId()` | `src/tasks.js` |
| `targetFor()` / `sessions.cwdFor()` / `sameDir()` | `src/dispatch.js`（`sameDir` 目前是模块私有，需要导出） |
| `boardTask()` 的 `settled_at` / `time_basis` / `last_report` | `src/board.js` |

**取不到、因此不用的信号**（明确写下来，避免后人以为漏了）：

| 想要的信号 | 为什么不用 |
|---|---|
| 改了哪些文件 / diff | 账本没有 `changedFiles`/`diff` 字段；`task.taskDir` 只有在配了 `taskDirRoot` 时才有值，且它表示"工作目录"，不是"改动清单"。模型要看改动，应让 worker 在报告的 `detail` 里写（`#admitEntry` 保留 `detail`，`dispatch_inspect` 可读） |
| token / 成本 | 账本没有（`plans/09` 已记录 `tokenUsage`/`costUsd` 检索不到），与接续判断也无关 |
| 依赖关系 / 计划图 | 账本没有 `depends_on` 一类字段 |
| 用户身份 / 偏好 | 账本没有人员字段（`analytics.js` 里已注明） |
| 语义向量 / 相似度 | **本方案明确不用**：插件零依赖、无模型通道；引入 embedding 就是要引入依赖与网络调用 |
| `group` | 有字段，但它的语义是"同一次批量派发"。**不拿它做接续信号**：同批任务互为并行，接续判断应由模型看素材决定 |

---

## 十二、风险与不做

| 风险 | 说明 | 对策 |
|---|---|---|
| 模型不看候选就猜 | 传了一个 `handoff_from` 但一次候选都没查 | `handoffCandidates.seen` 落库 + 看板角标；**不阻断**（用户点名时本就不该查） |
| 候选素材仍是字面 | 简报告诉模型"做了什么"，但简报质量决定判断质量 | 候选**必须**带 `last_report.summary`（`brief` 只是补充）；`handoffPrompt` 只搬 1200 字的四段摘要，不搬全文 |
| 上下文污染被复用放大 | 每次复用都把前序历史带进新任务 | 交接摘要（已落地的 `handoffPrompt`，1200 字上限）+ `plans/07` 的记忆治理；`threadId` 为将来的线程预算留好口子 |
| 会话串行 | 同一会话同时只能跑一个回合 | D7 校验 + E13 报错；接续任务会排在会话上，不会被"并行"假装 |
| 模型 / preset 锁死 | 复用沿用旧会话的模型与权限 | 工具描述 + 返回值 `note` 都写明；D8 拒绝"填了新模型"的请求（不静默沿用） |
| 接对了但用户看不出为什么 | 用户只看到"这是另一条任务" | `handoffReason` + 看板 chip + `note` 里的人话（§6.4） |
| 提示词膨胀 | 新加 5 行 | 独立段 + 独立门禁（≤5 行/≤250 字）+ 只写一条规则，不复制 `plans/08` 的解释 |

**不做**（明确排除，避免范围蔓延）：

1. **插件自动绑定**（本方案的立身之本）；
2. **相似度打分 / 阈值 / 推荐排序**（连"辅助排序"都不做——排序即暗示）；
3. 跨工作区 / 跨目录复用（D9 已拒，且会让 A 的代码被 B 改掉）；
4. 复用中换模型 / preset（会话创建时定死）；
5. 运行中"解除绑定"（不可逆，只能 cancel + `no_reuse` 重派）；
6. 把 `dispatch_candidates` 设成派发前置条件（用户点名接续时应允许直接传 `handoff_from`）；
7. 自动选择"最佳"候选（没有这个动作，也没有"最佳"）。

---

## 十三、一句话总结

- **判定权在模型**：插件给候选（同域、已结算、最近 + 素材）、做硬校验（九条），**不打分、不猜、不自动绑定**；
- **`handoff_from` 是唯一入口**，`no_reuse` 是逃生门，三者（含 `continue_task_id`）的互斥与优先级写死在工具边界；
- **可观测**：`handoffSource`（谁决定的）/`handoffReason`（为什么）/`handoffCandidates.seen`（看过几个）落库，看板与
  `dispatch_inspect` 能回答"这条为什么接了上一条"，不看日志；
- **提示词**：新段 5 行 / 233 字，独立门禁；`autoHandoff` 默认 `false`，且它的语义是"提醒模型去考虑"，不是"插件替你决定"。
