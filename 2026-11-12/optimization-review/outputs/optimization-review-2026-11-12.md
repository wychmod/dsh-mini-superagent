# dsh-mini-superagent 优化评审（2026-11-12）

> 范围：只找**尚未进入排期**的优化点。2026-11-11 代码结构分析里的 4 个 P1、6 个 P2，以及两份 PRD（计划透出、批次依赖）的正文论证，本报告不重复。
> 依据：当前工作区代码（`package.json` 0.9.0，HEAD `fcadac8`，另有 3 个未提交文件）+ 仓库内文档 + `reference/` 下的上游原型。

---

## 0. 结论摘要

功能主线已经走完「能力补齐」，当前更值得投入的是**收口**：把已经写进代码的事实，在文档、工具面、存储闸门和 CI 上钉住。

最先做的四件事（合计约 1 人天以内）：

1. 修根 README 的工具数矛盾，并把一致性测试从「包内 README」扩到「仓库根 README」。
2. 让 `dispatch_wait` 的超时和「全部结算」可区分。
3. 给账本 `version` 加读取校验，否则下一次存储格式变更没有回退锚点。
4. 加最小 CI（`node --check` + `npm test` + `client-smoke`），把现在靠人记的三条命令变成闸门。

需要判断再立项的有五个方向，其中**最值得先评估的是「依赖只排序、不传值」**：`depends_on` 解决了「什么时候开始」，没有解决「后继拿到什么」，链式任务目前仍要靠主会话转述。

---

## 1. 先确认：superagent 指什么

### 1.1 结论

本仓库语境里的 **superagent = DSH 官方发布的「超智能体研究原型」仓库 `deepseek-ai/dsh-superagent-prototype`**，不是 npm 上的 `superagent` HTTP 库，也不是一个独立产品。

证据：

- [`reference/README.md:8-14`](../../../reference/README.md)：明确写「DSH 官方发布的超智能体研究原型」，上游 `https://github.com/deepseek-ai/dsh-superagent-prototype`，参考提交 `8c32a9d`，约 3.3 MB / 245 个文件。
- [`reference/README.md:16-20`](../../../reference/README.md)：「它是 `dsh-mini-superagent` 的架构来源」，并列出三处被采纳的实现——`src/executor/dsh.ts`（一个任务一个 Session）、`src/app/sessions.ts`（按角色装配提示词、skills 与工具白名单）、`src/app/delivery.ts`（`freezeMessage` + 稳定 `MessageId` 的幂等投递）。
- [根 `README.md:17`](../../../README.md)：`reference/` 是「DSH 官方 `dsh-superagent-prototype` 的本地克隆，只作架构参考」，目录内容被 `.gitignore` 排除，只提交指针 README。
- [`.gitignore:3`](../../../.gitignore) 的注释也是同一个上游地址。

### 1.2 关系边界

| 维度 | 本插件 | superagent 原型 |
| --- | --- | --- |
| 关系 | 独立的 DSH bundle 插件 | 上游研究原型，仅作架构参考 |
| 代码依赖 | 无。`src/` 与 `client/` 不 import `reference/` 任何文件 | — |
| 借鉴方式 | 读实现后重写，不是拷贝 | — |
| 主要差异 | 主会话显式派发、单 JSON 账本、零依赖 | GitHub/Feishu 来源监听、SQLite、zod、pnpm 构建 |

上游 README 自己声明「research code, not production-ready」，并说明文章里讨论的部分设计并未在这个原型里实现（[`reference/dsh-superagent-prototype/README.md:3-5`](../../../reference/dsh-superagent-prototype/README.md)）。因此**不能**把原型的每个模块都当成「官方推荐做法」。

### 1.3 信息不足的部分

- `docs/api-contracts.md` 里形如 `reference/.../src/app/sessions.ts:138-155` 的行号取证，只对 `8c32a9d` 有效；换版本会失效（[`reference/README.md:22-24`](../../../reference/README.md) 已说明）。
- 原型内部是否有比本插件更强的实现（例如完整的评估链路），只能以本地这份快照为准，无法代表上游后续版本。

---

## 2. 评审基线（避免与既有结论打架）

| 事实 | 依据 | 说明 |
| --- | --- | --- |
| 版本已是 0.9.0 | `package.json` `version`；`src/constants.js:10` | 根 README 仍写 0.8.0 |
| PRD-01 / PRD-02 已实现 | `git log`：`7412e3b feat(dispatch): 计划透出、批次依赖、会话复用与候选工具` | 不是「待排期」，本报告按已实现代码评审 |
| 三个 PRD 审计缺口已记录 | [`plans/README.md:20-28`](../../../plans/README.md) | 本报告涉及处会标「已记录、未排期」，不冒充新发现 |
| 工具数实际 10 个 | `src/tools.js:51-62` `TOOL_NAMES` | 根 README 一处写 9、一处写 10 |

---

## 3. A 类：现在就能做（低成本、收益明确）

### A1. 根 README 与仓库事实漂移，且没有闸门守它

**现状**

- [根 `README.md:28`](../../../README.md) 要求装完确认「9 个 `dispatch_*` 工具」；同一文件 [`README.md:47`](../../../README.md) 写「10 个工具」。`src/tools.js:51-62` 实际是 10 个。
- [根 `README.md:14`](../../../README.md) 说「插件包本体（0.8.0）」，`package.json` 已是 0.9.0。
- 现有一致性测试只读**包内** README：[`test/contract-consistency.test.js:33-39`](../../../dsh-mini-superagent/test/contract-consistency.test.js) 用 `read('README.md')`，解析到 `dsh-mini-superagent/README.md`。仓库根 README 不在任何断言里。

**不改会怎样**

新用户按根 README 装完，看到 10 个工具会怀疑装错；版本号对不上会让报障描述失真。这类漂移已经在 `contract-consistency.test.js` 的注释里被列为历史事故（「`tools.js` 头部写 8 个而实际 9 个」），说明它复发过。

**建议**

- 把根 README 的工具数改成 10，版本改为「工作区版本 0.9.0 / 当前发布版见 CHANGELOG」或直接统一。
- 在 `contract-consistency.test.js` 增加一条：读 `../README.md`（仓库根），断言其中出现的 `N 个 dispatch_* 工具` 与 `TOOL_NAMES.length` 一致；再断言 `package.json.version === constants.VERSION`。

**成本**：0.5–1 小时。

**依据**：`README.md:14/28/47`、`package.json`、`src/constants.js:10`、`test/contract-consistency.test.js:33-39`。

---

### A2. 工具面读不回计划与依赖（看板有、`dispatch_inspect` 没有）

**现状**

- `card()`（[`src/dispatch.js:3349-3396`](../../../dsh-mini-superagent/src/dispatch.js)）与 `detail()`（[`3398-3422`](../../../dsh-mini-superagent/src/dispatch.js)）都不投影 `task.plan`、`dependsOn`、`blockedBy`。
- 看板快照有 `plan_total` / `plan_done` / `plan_current` 与 `depends_on` / `blocked_by`（`src/board.js` 的 `boardTask()`）。
- 文档自己承认了这个缺口：[`docs/tools.md:58-62`](../../../dsh-mini-superagent/docs/tools.md) 写「想看全量计划走……读 `<stateDir>/tasks.json`」，等于让调用方绕过工具去翻文件。
- [`plans/README.md:20`](../../../plans/README.md) 已把它记为审计缺口，但尚未进入任何 PRD 条目。

**不改会怎样**

模型自己上报了 5 步计划，回头用 `dispatch_inspect` 只能看到一个数字或什么都没有；主会话想判断「这条任务卡在第几步、为什么没开始」必须读账本文件。工具面与看板面对同一事实给了两种可见性。

**建议**

- `detail()` 增加 `plan`（最多 12 步，已是入库上限）与 `depends_on` / `blocked_by` / `blocked_reason`。
- `card()` 只加 `depends_on`（短数组）与 `blocked_by`，不加步骤数组，避免 `dispatch_list` 返回体膨胀。
- 同步 `docs/tools.md` 那段「读文件」的措辞。

**成本**：2–4 小时（含测试）。

**依据**：`src/dispatch.js:3349-3422`、`src/board.js` `boardTask()`、`docs/tools.md:58-62`、`plans/README.md:20`。

> 与 PRD-01/PRD-02 相关，但不改变它们的语义；只是把已有字段投影到工具面。

---

### A3. `dispatch_wait` 的超时与「全部结算」不可区分

**现状**

- `TaskTable.waitFor()`（[`src/tasks.js:512-555`](../../../dsh-mini-superagent/src/tasks.js)）无论「全部结算」还是「超时」都 `resolve(tasks)`，没有标志；`finish()` 同时服务于两条路径。
- 工具层（[`src/tools.js:543-556`](../../../dsh-mini-superagent/src/tools.js)）无条件返回 `{ waited: true, tasks: ... }`。

**不改会怎样**

模型调用 `dispatch_wait` 拿到 `waited: true`，会倾向认为「已经等到了」，于是基于可能仍 `running` 的任务写结论。工具描述里虽然写了「超时后任务可能仍在 running」，但返回值本身没有给这个信号，只能靠逐条读 `status` 反推。

**建议**

- `waitFor()` 返回 `{ timedOut: boolean, tasks }`（或 `{ completed: n, total: n }`）。
- 工具返回改成 `{ waited: true, timed_out: true|false, tasks }`，并在 `timed_out` 为真时附一句「未结算的任务仍在运行，不要把它们当作已完成」。

**成本**：1–2 小时（含一条超时用例）。

**依据**：`src/tasks.js:512-555`、`src/tools.js:527-556`。

---

### A4. 账本 `version` 只写不读，下一次格式变更没有闸门

**现状**

- [`src/store.js:49`](../../../dsh-mini-superagent/src/store.js) 定义 `FILE_VERSION = 4`，写入时带上（`store.js:119-125`）。
- 读取路径的 `normalize()`（[`store.js:59-70`](../../../dsh-mini-superagent/src/store.js)）完全不看 `version`：未来版本的文件会被当成本版本静默接受，旧版本文件也同理。
- 对照上游：`reference/dsh-superagent-prototype/src/app/migration.ts:20-25` 有 `SCHEMA_VERSION`、`OLDEST_SCHEMA`，并对过旧库直接拒绝并给出「换一个 state 目录」的指引。

**不改会怎样**

下一次改字段语义（例如把 `retired` 从数组改成 map）时，旧插件读到新文件不会报错，只会按缺省值处理，症状是「升级后任务看起来丢了/状态不对」，而不是一条明确的「版本不支持」。这正是最难排查的一类问题。

**建议**

- `readState()` 解析后校验 `version`：
  - `> FILE_VERSION`：拒绝启动，提示「账本由更新版本写入，请升级插件或换 state 目录」；
  - `< 3`：拒绝并给出同样指引（当前最早的兼容边界由代码事实决定，先定在 3 或 4）。
- 不需要完整迁移框架；单文件账本的兼容策略本来就是「缺字段按空读」，这里只补**版本闸门**。

**成本**：2–3 小时（含两条用例：过新、过旧）。

**依据**：`src/store.js:49/59-70/119-125`；上游 `src/app/migration.ts:20-25`。

---

### A5. 没有 CI，`client-smoke` 不在 `npm test` 里

**现状**

- 仓库根没有 `.github/`，也没有任何 CI 配置。
- `package.json` 的 `scripts` 只有 `"test": "node --test"`；`scripts/client-smoke.mjs` 需要人工执行，测试目录里没有任何引用（grep 无命中）。
- 文档里的验收口径是多条命令分散写（`npm test`、`node scripts/client-smoke.mjs`、`node --check`）。

**不改会怎样**

任何一次提交都可能只跑了 `node --test`，客户端渲染断言（`client-smoke` 目前数百项）没跑也看不出来；而 `client/index.js` 是单文件近 8000 行、无类型检查的部分，回归最容易发生在这里。

**建议**

- 加一个最小 CI（GitHub Actions 或本地 `npm run check`）：
  1. `node --check` 遍历 `src/`、`client/`、`scripts/`；
  2. `npm test`；
  3. `node scripts/client-smoke.mjs`。
- 把三条包成 `"check": "..."`，CI 与本地共用同一入口。

**成本**：2–4 小时（不含首次跑通的偶发修复）。

**依据**：`package.json` `scripts`；仓库根无 `.github/`；`scripts/client-smoke.mjs` 存在但未被测试引用。

---

### A6. 重试健康度只存在内存里，卡片看不到

**现状**

- `this.retryCounts`（[`src/dispatch.js:233`](../../../dsh-mini-superagent/src/dispatch.js)）记录「这个任务已经续跑几次」，在 `retry()`（`3217-3223`）累加，成功或回合结束时删除（`1986`、`3265`）。
- `card()` 只投影 `retry_at`（`3389`），没有尝试次数、首次失败时间、最近错误。
- 看板侧有 attempt 标签（`client/index.js` 约 4265），但拿不到次数。

**不改会怎样**

一条任务反复瞬时失败时，看板只显示「重试中」；用户无法判断是「刚重试一次」还是「已经第七次」，也不知道该等还是该介入。`retryCounts` 只服务于内部节流，没有变成可观测事实。

**建议**

- `card()` 增加 `retry`：`{ attempts, since, last_at, last_error }`，数据全部已在内存（`retryCounts` + `retryAt` + `error`）。
- 看板 attempt 标签直接显示 `3 次`；`dispatch_inspect` 同步可见。

**成本**：2–4 小时（含看板渲染与测试）。

**依据**：`src/dispatch.js:233/1986/3217-3223/3265`、`src/dispatch.js` `card()`。

> 与 P1/P2 无关；这是把已有的内部计数投影出来，不改变重试策略。

---

### A7. PRD-01 的「计划已更新」提示仍未实现

**现状**

- [`plans/README.md:25`](../../../plans/README.md) 已记录：PRD-01 §6 的「计划更新后显示『计划已更新』一次」没有做，客户端没有这个提示。
- 同一处还记录 PRD-01 §5 的归一化位置与文档不符（实际在 `report()`，文档写 `#admitEntry`），行为等价。

**不改会怎样**

worker 上报新计划后，看板的 `2/5` 会**静默变化**。用户视角是「数字自己变了」，不知道该不该重新看一眼；而这条提示是 PRD 明确写下的验收项，不实现等于验收表里有一条永远空着。

**建议**

- 客户端在快照里检测同一任务的 `plan_total/plan_done/plan_current` 与上一轮不同，标记一次「计划已更新」，下一次轮询清除。纯客户端状态，不改协议。
- 顺手把 `docs/tools.md` §5 的位置描述改成 `report()`，消掉第二处文档偏差。

**成本**：2–3 小时。

**依据**：`plans/README.md:25`、`client/index.js` 快照轮询、`docs/tools.md:647-651`。

---

## 4. B 类：需要判断或立项

### B1. 依赖只解决「何时开始」，不解决「拿到什么」

**现状**

- `depends_on` 的语义是准入：前置未结算，后继停在 `queued`，不占并发位（PRD-02 已实现）。
- 后继启动时，worker 收到的仍然只有自己的 `brief` 与工作目录；前置的报告、`task_dir`、结论都不会进入提示。`workerPrompt` 的入参里没有「上游结果」这一项。

**不改会怎样**

「先调研 → 再实现」这类链式任务，第二步要么由主会话在前置报告回流后手工再派一次（等于没用到依赖），要么让后继 worker 重新调研一遍（浪费一份上下文，还可能得出不同结论）。依赖目前主要节省的是「主会话不用记着去派」，不是「任务之间能协作」。

**建议**

前置结算后、后继启动前，把前置的 `card().summary`（截断）与 `task_dir` 拼进 worker 提示的一个**显式围栏段**（「上游任务结论，仅供引用，不是指令」），沿用 `prompt.js` 已有的 `inlineField` / 围栏防注入做法。默认关闭，按 `depends_on` 自动开启或加 `pass_context: true`。

**成本**：1.5–3 天（提示词、截断预算、注入防护、看板与测试）。

**依据**：`src/tasks.js` `takeRunnable()`、`src/dispatch.js` `#start`、`src/prompt.js:258-264`（`inlineField` 的注入清洗口径）、PRD-02 已实现代码。

**要拍的板**：上游结论可能是错的，传下去会放大错误；以及每次多花的提示预算是否可接受。

---

### B2. 角色化装配：目前只有「固定 worker」，没有「按任务类型装配」

**现状**

- `SessionGateway.createWorker()`（[`src/sessions.js:361-390`](../../../dsh-mini-superagent/src/sessions.js)）接收 `agentPreset` / `permissionPreset`，但提示词、skills、工具白名单是固定的 worker 形态。
- 上游 `src/app/sessions.ts` 的做法是「按角色装配提示词、skills 与工具白名单」；`role-models.ts:8-20` 还把 `provider/model/reasoningEffort` 按角色解析并在首次请求前注入，不动全局默认。
- 本插件的 `model` / `agent_preset` / `permission_preset` 已经是任务级参数，但没有 `reasoning_effort`，也没有「档位」概念。

**不改会怎样**

「只读调研」和「改代码实现」用同一套工具面与权限预设：调研任务也能写文件，实现任务不会被提示「先跑测试」。用户只能每次手传 `permission_preset`，容易忘、也容易传得过宽。上游已经证明「按角色装配」是可行的，而且不需要改宿主。

**建议**

引入 `dispatch_launch.profile`，先做三个内置档：

| profile | 工具面 | 默认权限 | 提示词增量 |
| --- | --- | --- | --- |
| `research` | 读写 + 搜索 | 默认 | 「只产出结论与路径，不改文件」 |
| `implement` | 全量 | 继承 | 现有 worker 规则 |
| `verify` | 读 + 执行测试 | 只读 | 「只验证，不修」 |

映射表放 `constants.js`，与 `tools.js` schema 用一致性测试钉住（已有同类测试范式）。

**成本**：3–5 天（含三个档位的提示词回归）。

**依据**：`src/sessions.js:361-390`、`src/tools.js:138-140`、`src/constants.js` `DEFAULTS`、上游 `src/app/sessions.ts` 与 `src/app/role-models.ts:8-20`。

**要拍的板**：是否值得引入「档位」这个新概念，还是继续用参数直传；档位与 `agent_preset` 的优先级。

---

### B3. `done` 是 worker 自报，没有第二意见

**现状**

- 任务是否完成完全取决于 worker 的 `dispatch_report(status: 'done')`；`settle()` 只记录 `settledAt`，不校验报告内容。
- 上游有 `policy.ts` 的 `EvalConfigSchema`（`mode: off/observe/auto`、独立 `RoleModel`、`timeoutSeconds`）与 `assessmentOutcome()`，把「是否接受」做成独立的评估步骤，且可以先只观察不拦截（`reference/dsh-superagent-prototype/src/policy.ts:40-87`）。

**不改会怎样**

worker 说完成就完成。对「实现类」任务，用户仍要自己打开日志判断；而插件已经把「报告会自动回来」作为核心承诺，却没有对报告质量做任何独立检查。风险不是「会出错」，而是「出错了也没有第二个信号」。

**建议**

先只做 observe：用第二个轻量会话（或同一 worker 的追问）按三条固定问题检查报告——是否引用了具体文件/行、是否说明了验证方式、是否与 brief 的要求逐条对应；结果只记 `task.verdict`，不影响状态。跑一段时间有数据后，再决定是否升级为 auto（`done` 降级为 `needs_review`）。

**成本**：3–5 天（observe 版；auto 版另算）。

**依据**：`src/dispatch.js` `report()` / `settle()`、上游 `src/policy.ts:83-87` 与 `src/app/role-models.ts`。

**要拍的板**：额外一次会话的 token 成本谁承担；observe 结果展示在哪（看板 vs 抽屉）。

> 注意：**不要照搬上游的 `policy.rules` 自动准入**。那套规则是为「监听 GitHub/Feishu 后判断该不该接活」设计的，本插件没有外部来源，派发是主会话的显式决定，照搬会引入一整套身份、来源、去重负担。这里只借「独立评估 + observe 先行」这一层。

---

### B4. 没有任务级预算，也没有「预算耗尽」分类

**现状**

- `DEFAULTS` 只有 `maxWorkers: 6`、`maxTasksPerSession: 64`、`backgroundLimitMs: 1800000`（[`src/constants.js:222-224/384`](../../../dsh-mini-superagent/src/constants.js)）；没有任务级 token 或时长上限。
- `isTransient()` 把 `429` / `5xx` 当作可重试；上游 `retry-health.ts:9-23` 专门识别 `budget_exceeded` 并从普通限流中区分出来，投影成「当前卡在预算重试」。

**不改会怎样**

一条跑飞的任务可以一直占着 1/6 的并发位直到回合结束；用户看到的是「跑了很久」，而不是「已超出预算，建议取消」。预算耗尽会被当成普通瞬时错误反复重试，白占并发位。

**建议**

- 近期（低成本）：在错误分类里单独识别 `budget_exceeded` / 上下文超限，卡片显示「预算耗尽」并停止自动续跑；`retry_health` 与 A6 合并投影。
- 中期（需立项）：加 `maxTaskMs`（到点标记 `blocked` 并保留现场），不默认开启。

**成本**：识别 1–2 天；硬上限 2–3 天。

**依据**：`src/constants.js:222-224/384`、`src/dispatch.js` `isTransient()` / `retry()`、上游 `src/app/retry-health.ts:9-23`。

**要拍的板**：预算耗尽后是 fail、排队重试，还是保留现场等人工介入。

---

### B5. 没有插件事件钩子，外部只能 2 秒轮询 HTTP

**现状**

- `src/` 里检索不到 `ctx.emit` / `.emit(`：任务状态变化没有对外事件。
- 唯一的集成面是 `GET /board`、`/board/stats`、`/board/analytics` 等 HTTP 路由；客户端固定 2 秒轮询（`client/index.js` `POLL_MS`）。
- 上游有 `session/event`、`agent/request` 等事件总线用法（`role-models.ts:25-39`）。

**不改会怎样**

其他插件想「任务结算时做点什么」（通知、写日志、触发下一批）只能轮询 HTTP；而 HTTP 是 loopback + 自定义头的写保护面，读虽然开放，但把内部面板接口当公共 API 用，等于把 `boardTask()` 的字段形状变成事实契约。

**建议**

用 Cordis 的 `ctx.emit('dsh-mini-superagent/task-settled', card)`（并 `ctx.effect` 清理），只发**结算**与**创建**两个事件，payload 直接复用 `card()`。不做请求-响应式钩子，避免变成第二个调度器。

**成本**：1–2 天（含事件契约文档与一条订阅测试）。

**依据**：`src/` 无 `ctx.emit`；`src/board.js` 路由表；上游 `src/app/role-models.ts:25-39` 的事件用法。

**要拍的板**：事件一旦发布就是对外契约，字段只能加不能改；是否现在就要承担这个稳定性义务。

---

## 5. 为什么不照抄某些上游做法

| 上游做法 | 为什么本插件不适用 |
| --- | --- |
| GitHub / Feishu `Source` 监听（`src/sources/`） | 本插件的输入是主会话的 `dispatch_launch`，没有「外部来源 + 身份 + 去重」问题。照抄要引入授权模型、来源注册、轮询游标三套东西，收益为零。 |
| `policy.rules` 自动准入（copy fix / visual fix 规则） | 那套规则解决「监听到一条请求后，判断该不该开工」。本插件的派发本身就是显式决定，没有需要自动判断的入口。只借「独立评估 + observe 先行」（B3）。 |
| SQLite + 事务迁移（`src/app/migration.ts` 全量） | 本账本是单 JSON 文件、任务量级在百条以内，完整迁移框架是过度设计。只借 `SCHEMA_VERSION` / `OLDEST_SCHEMA` 的**拒绝语义**（A4）。 |
| PR 创建与 CI 合并门禁 | 本插件没有远端分支与合并概念，worker 产出的是报告而不是 PR。验收只能落在「报告自洽 + 本地命令」，不能照搬合并门禁。 |
| 按角色注入 `model/selection` 的完整实现（`role-models.ts`） | 它需要 `ctx.llm.resolveCallConfig` 与 `system-prompt/assemble` 钩子；本插件当前只透传 `model` 字符串。可以借「按角色默认 + reasoningEffort」（B2 的一部分），但不必复制整套事件拦截。 |

---

## 6. 优先级排序

| 顺序 | 项 | 类型 | 收益 | 成本 | 前置 |
| --- | --- | --- | --- | --- | --- |
| 1 | A1 文档闸门 | 工程债 | 消除新用户第一眼困惑；防复发 | 0.5–1 h | 无 |
| 2 | A3 `wait` 超时语义 | 错误信息质量 | 防止模型把未完成任务当完成 | 1–2 h | 无 |
| 3 | A4 存储版本闸门 | 工程债 | 下次格式变更可回退、可拒绝 | 2–3 h | 无 |
| 4 | A5 最小 CI | 测试覆盖 | 客户端回归不再靠人记 | 2–4 h | 无 |
| 5 | A2 工具面补齐 plan/依赖 | 可用性 | 不必翻账本文件 | 2–4 h | 无 |
| 6 | A6 重试健康度 | 可观测性 | 「重试几次」一眼可见 | 2–4 h | 无 |
| 7 | A7 计划更新提示 | 交互补口 | 兑现 PRD-01 的一条验收 | 2–3 h | 无 |
| 8 | B1 依赖传递结果 | 能力边界 | 链式任务真正协作 | 1.5–3 d | 需拍板 |
| 9 | B4 预算识别（仅识别） | 可观测性 | 不再把预算耗尽当限流重试 | 1–2 d | 可与 A6 合并 |
| 10 | B2 角色化装配 | 扩展方式 | 任务类型与工具面匹配 | 3–5 d | 需拍板 |
| 11 | B3 报告第二意见（observe） | 能力边界 | 完成质量有第二个信号 | 3–5 d | 需拍板 |
| 12 | B5 插件事件 | 扩展方式 | 其他插件可订阅 | 1–2 d | 需拍板契约稳定性 |

建议节奏：1–7 先作为一个「收口小批次」一次做完（约 1 人天）；B1 单独评估，因为它是唯一会改变任务协作方式的项。

---

## 7. 依据与不确定性

**本报告直接核对过的文件**

- `README.md`（根）、`dsh-mini-superagent/package.json`、`dsh-mini-superagent/CHANGELOG.md`
- `dsh-mini-superagent/src/`：`constants.js`、`tools.js`、`tasks.js`、`dispatch.js`、`store.js`、`board.js`、`sessions.js`、`prompt.js`
- `dsh-mini-superagent/test/`：`contract-consistency.test.js`、`board.test.js` 及测试清单
- `dsh-mini-superagent/docs/tools.md`、`plans/README.md`
- `reference/README.md`、`reference/dsh-superagent-prototype/` 的 `README.md`、`src/limits.ts`、`src/policy.ts`、`src/app/migration.ts`、`src/app/role-models.ts`、`src/app/retry-health.ts`

**推测或未逐项核实的部分（已在正文标注）**

- A1 的版本号差异：0.9.0 可能是「未发布的工作区版本」，根 README 写 0.8.0 可能是「当前发布版」。这一点仓库里没有明说，所以报告只把**同一文件内 9 vs 10 的矛盾**当作确定问题，版本号作为次要说明。
- A5：没有 CI 是「仓库里没有配置」的事实；用户是否在本地另有流水线，无法从仓库判断。
- B1 / B3 的成本区间基于本仓库现有测试与提示词改动的经验估算，不是排期承诺。
- 未验证项（本报告未作为结论使用）：客户端是否监听 `visibilitychange`（grep 无命中，但未检查宿主容器是否代为暂停）；`locale/*.json` 与客户端内联文案是否逐键对齐（无对应用例，但也未证明有漂移）。

**与既有结论的偏差（供后续文档修正）**

1. 两份 PRD 已实现，2026-11-11 的「待排期」表述已过期。
2. 版本基线是 0.9.0，不是 0.8.0。
3. `plans/README.md` 已自记三个 PRD 审计缺口，引用时不要再写成「未发现」。
