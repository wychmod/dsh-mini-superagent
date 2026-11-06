# Changelog

本文件记录 `dsh-mini-superagent` 的版本变化。版本号遵循 SemVer；`0.x` 阶段不保证 API 稳定，但工具名与配置键在 0.2.0 已冻结（见下）。

## 0.8.0 — 2026-11-06

修掉 0.7.0 评审里剩下的 P1/P2。这些问题单个看都不致命，但都是「用久了会咬人」的类型：
越权读、报告丢失、排队错乱、额度永久锁死、提示注入、来源污染。

### 权限与安全

- **`dispatch_wait` 缺归属校验**（`src/tools.js`）
  同文件的 `inspect` / `message` / `cancel` 都校验了 `parentSessionId`，唯独 `wait` 没校验。
  后果：会话 A 传会话 B 的 `task_id`，能读到对方的标题、状态与报告摘要。
  顺带修掉同源的另一半：原来的 `.filter(Boolean)` 还会把**不存在的 id 静默吃掉**并返回
  `waited:false`，让调用方误以为等到了。现在两者都显式报错。
- **`dispatch_report` 的未知 status 让任务永远卡 `running`**（`src/tools.js`）
  schema 声明了 enum，但 execute 直接透传；传 `'finished'` 之类的值既不结算也不报错，
  任务永久占用并发位。现在入口处校验并列出允许值。
- **工作目录可伪造提示规则块**（`src/prompt.js`）
  `工作目录: ${task.cwd}` 未清洗，含换行的 cwd 能伪造出「工作规则」块并插在真规则**之前**。
  现在：结构化字段一律压成单行去控制字符；简报用围栏包住；**规则放到数据块之后**，
  并显式声明「与简报冲突时以规则为准」。
  风险等级要说清：不是远程漏洞（攻击面是能控制 `dispatch_launch` 参数的会话），
  但它破坏了数据/指令边界，而边界破了之后，任何让外部输入流进参数的功能都会变成真漏洞。

### 报告回流

- **报告投递失败无人知晓**（`src/dispatch.js`）
  `relay()` 的返回值被所有调用方忽略，「报告会自己回来」这个核心承诺其实是尽力而为。
  现在：失败按 2s→4s→8s 重试 3 次，结果记在 `task.delivery` 上，
  并通过 `card()` 的 `report_delivery` 暴露——失败的投递在 `dispatch_list` 与看板上一眼可见。
- **降级投递污染消息来源**（`src/sessions.js`）
  收件箱不可用时退回 `sessionController.prompt`，而它构造的消息来源是 `{kind:'user'}`，
  主会话会把报告当成用户亲口说的。现在降级时记 warn，并返回 `delivered:'prompt'`
  让调用方能区分；这直接违背了 `constants.js` 里「不会被误当成用户手打的消息」的注释。
- **`wake=false` 反而会唤醒对方**（`src/sessions.js` / `src/dispatch.js`）
  steer 对空闲 agent 会静默降级成 followup（唤醒），与「不打扰」的意图相反；
  且 `relay` 与 `deliver` 各有一套「目标在不在跑」的判据。
  现在判据只留一处，`wake=false` 走 `agent.inject()`（只追加下一步、不唤醒）。
- **批次成员被 retry 后三条回流路径全关**（`src/dispatch.js`）
  `groupClosed` 永不复位 + `report` 见 group 就 skip + `onWorkerIdle` 见 group 就 return，
  结果重试后的成员彻底静默。现在用独立的 `groupReopened` 标记放行，**不动** `groupClosed`
  （改动它会让 `maybeSummarize` 以为这批没汇总，重复发一条）。

### 状态与额度

- **`maxTasksPerSession` 永久锁死会话**（`src/dispatch.js`）
  原实现数 `ofSession().length`，而任务表只增不减：累计派发满 64 个之后该会话**再也不能派发**，
  即使全部 done、全部归档也不释放。这是「用着用着突然不能派了」的典型成因。
  现在 `quotaUsed()` 只数仍在册的任务：已归档的不计，已结算超过 24 小时的不计。
- **`waitFor` 对重复 id 要等满超时、且超时后不清理等待者**（`src/tasks.js`）
  `finishOne` 被 `Set` 去重但 `remaining` 按数组长度计，所以 `waitFor([a,a])` 里 a 结算后仍要等满超时；
  超时分支也从不摘除 `waiters`，长期不结算的任务会一直挂着 resolver。两者都已修。
- **`retry` 的 attempt 先自增后投递**（`src/dispatch.js`）
  投递失败时 attempt 已消耗、状态卡 `running`。现在投递成功后才记 attempt。
  同时区分「确定不存在」与「探不了」：原来的 `.catch(() => undefined)` 把任意异常都当成
  不可恢复，一次瞬时 `gateway/internal` 就会白白换掉 worker、历史断链。
- **`createWorker` 丢弃 `create()` 的返回值**（`src/sessions.js`）
  `create({sessionId})` 在会话已存在且非空白时**可能换号**，返回值里的 id 才是真的。
  原实现紧接着用请求里的 id 去 `resolveAgent`，换号时必然 not-found，任务 failed 而真会话成孤儿。
  现在以返回值为准，并同步回 `task.workerSessionId`。

### 文本与数据

- **`clip()` 在 `limit < 400` 时输出比上限还长**（`src/tasks.js`）
  原来是 `limit - 400` + `slice(-400)`，短 limit 下头部预算变负、尾部仍取 400，
  实测 `clip(1000 字, 200)` 返回 417 字。这类调用在 `reportText` 与 `card` 里都有，
  会把消息撑出上下文预算。现在按比例分配预算并做硬兜底。
- **简报落盘被截到 2000 字，retry 重投残版**（`src/dispatch.js`）
  重启读回的是残版，`retry` 的「重投原始简报」实际投的是被截断的任务描述，worker 无从得知。
  现在完整落盘（上限放宽到 `maxBriefChars × 2`），超过才截并留 `briefTruncated` 标记。

### 工作区

- **`safeDirName` 放过 Windows 保留名与尾部点号**（`src/workspaces.js`）
  `CON` / `NUL` / `COM1` 会让 `mkdir` 失败或建出非法目录；`abc.` 与 `abc` 会撞同一个目录。
  现在保留名按第一个点之前的部分判定并在点前插入 `-`（`CON.txt` → `CON-.txt`），
  尾部点号与空格在截断前后各清理一次。
- **`resolve` 的包含匹配会误命中短查询**（`src/workspaces.js`）
  `resolve('a')` 会命中「第一个含 a 的工作区」。现在单字符跳过包含匹配；多命中时
  记 warn 列出全部候选并返回 `undefined`，不再静默挑一个。
  同时补掉一个我自己方案里的坑：`resolve` 返回 undefined 后 `resolveOrCreate` 会把歧义
  当成「不存在」然后 `mkdir` 一个重复目录——比原 bug 更糟。现在新建前再判一次歧义。
- **绝对路径无脑 `mkdir -p`，可越界建目录**（`src/workspaces.js`）
  agent 只要把 `workspace` 写成绝对路径，插件就以 Host 进程权限在该路径建目录并注册，
  不受 `workspaceRoot` 约束且无任何痕迹。现在越界时记 warn 说明路径与工作区根
  （仍然创建——「可审计」优先于「可禁止」，但必须留痕）。

### 看板

- **`elapsed_ms` 语义错误**（`src/board.js`）：用 `startedAt → 现在`，已完成任务会一直增长，
  实测一个 26 小时前的 done 任务显示「26 时 0 分」。现在已结算的冻结在 `updatedAt`。
- **200 条截断无提示**（`src/board.js`）：任务数超上限时「总计 500 / 列表 200」看起来像数据丢了。
  快照新增 `truncated: {shown, total}`。
- `/target` 只校验 `session_id` 非空，任意字符串（含 `__proto__`）都会 200 并写进 targets 落盘；
  现在校验会话形状与存在性，不合法 404。
- 请求体超限时 `req.destroy()` 让客户端收到 ECONNRESET 而非 400；改为停止累积并正常返回 400。

### 验证

- `node --test` **95 pass**（0.7.0 为 74；新增 `test/p1-regression.test.js` 17 条 +
  看板新增 4 条）。
- 四个独立验证脚本全通过（共 70 项断言）：
  `verify-p0-fixes.mjs`（11）· `verify-lead-p1.mjs`（11）· `verify-surface-p1.mjs`（19）·
  `verify-workspaces-p1.mjs`（37）。

### 未做

- 未做真机视觉验收。
- 未引入错误码闭集（评审的 P1-13）：13 处 `throw new Error(中文)` 与看板手工状态码仍在，
  这是「文档漂移」与「状态码靠猜」的共同根因，但改动面横跨所有模块，单独一轮做更合适。

## 0.7.0 — 2026-11-06

修掉六个**可复现**的正确性 / 安全问题。它们都属于「平时看不出、出事很难查」的类型：
状态机没有单一入口、落盘不原子、看板准入判据可被绕过。全部有回归测试钉住
（`test/p0-regression.test.js`，16 条用例）。

### 修复（P0）

- **P0-1 看板准入可被 DNS rebinding 绕过**（`src/board.js`）
  0.6.0 的判据是「`Origin.host === Host` 即同源」，没有 `Origin` 时直接放行。
  但 `Host` 与 `Origin` 都由客户端决定：攻击者页面从 `http://evil.example:9735`
  加载（域名解析到 127.0.0.1）时两者都是 `evil.example:9735`，判据恒真。
  实测能读全部任务标题 / 工作目录 / 报告摘要，能归档、改派发目标、取消任务。
  现在：回环 Host 放行（并要求 Origin 也是回环或无 Origin），非回环 Host 默认拒绝、
  需显式写进 `BOARD_ALLOWED_HOSTS`；写操作另需自定义头 `x-dsh-mini-superagent`。
  **行为变更**：非回环地址的看板默认不可访问，需要显式放行。

- **P0-2 `settle()` 无幂等，状态可被任意覆盖**（`src/tasks.js`）
  0.6.0 的 `settle` 是裸赋值：`done` 能被 `settle('cancelled')` 改成 cancelled
  （看板点一下「取消」就能改掉已完成任务）；`index.js` 的 `agent/status` 分支
  更是无条件把任务写成 `running`，让 `done` / `cancelled` 复活、并发位被幽灵占用
  且永不结算。
  现在：新增 `TRANSITIONS` 跃迁表与 `transition()` 唯一入口，`settle` 对已结算
  任务直接返回 false；`index.js` 改为调用事实方法 `dispatch.workerTurnStarted()`。

- **P0-3 `dispatch_message` 先改状态后投递**（`src/dispatch.js`）
  投递失败时状态不回滚：已完成任务被打回 `running` 并永久占用并发位；
  对 `queued` 任务更糟——状态置 running 但没从队列摘除，排队顺序永久错乱。
  现在：先投递，成功后跃迁状态，失败则保持原状态并抛错。

- **P0-4 `cancel()` 与 `start()` 竞态留下僵尸 worker**（`src/dispatch.js`）
  `start()` 有多个 await（解析工作区、建会话、切目录、投递），期间取消任务时
  `agents.get()` 还是空的，`agent.cancel()` 被跳过，但会话照常被创建并投递简报。
  看板显示已取消，实际有子会话在烧模型额度。
  现在：每个 await 之后检查一次状态，已结算就中止启动并取消已建出的会话。

- **P0-5 落盘非原子，写坏即全部历史丢失**（`src/store.js`）
  原来是直接 `writeFile` 覆盖，进程在写入中途崩溃会留下半截 JSON，`restore`
  只 warn 然后以空表启动，用户无法区分「第一次装」和「数据被写坏了」。
  现在：`tmp` → `fsync` → `rename` 原子替换，保留 `.bak`，读时主文件损坏
  自动回退备份并标明 `recovered: 'bak'`；`Dispatch.persist()` 另加串行写链。

- **P0-6 「自动选择」目标重启后丢失**（`src/dispatch.js`）
  `restore()` 只恢复带 `workspace_id` 的目标，`auto` 目标被过滤掉。
  0.6.0 里 auto 还意味着「必派发」模式，所以丢失后会话会**静默退回「不派发」**
  （自己干活），行为反转且界面无提示。
  现在：`auto` 与具体工作区目标都被保留。

### 顺带修复

- `/target` 只校验 `session_id` 非空，任意字符串（含 `__proto__`、不存在的会话）
  都会返回 200 并写进 targets；现在校验会话形状与存在性，不合法返回 404。
- 请求体超限时 `req.destroy()` 让客户端收到 ECONNRESET 而非 400；改为停止累积
  并正常返回 400。
- `pump()` 串行 `await start()`：并发位是 6 但启动永远是 1，冷启动时延 ≈ N × 建会话时延。
  现在一次占满所有空位并行启动。
- `ctx.effect` 的 disposer 用 `void dispatch.dispose()`，宿主拿不到 Promise 不会等它，
  最后一段状态可能没落盘。改为返回该 Promise。

### 客户端

- 所有 fetch 带上 `x-dsh-mini-superagent` 头（写操作现在要求它）。
- 带该头的跨站请求会触发 CORS 预检，预检不带凭据也不带此头，服务端拒绝后真请求不会发出。

### 验证

- `node --test` **74 pass**（0.6.0 为 56；新增 `test/p0-regression.test.js` 16 条 +
  看板准入新增 2 条，同时移除了 1 条与新行为冲突的旧断言）。
- 独立探针 `verify-p0-fixes.mjs` 逐条复验：**11/11 通过**。
- 真实 `tasks.json`（12 个任务）可被新版正常读回；该文件的 `targets` 已为空，
  正是旧版每次重启丢弃 auto 目标的结果。

### 未做

- 未做真机视觉验收；看板界面与 `@` 菜单的观感仍需目视。
- 本轮只修 P0，评审列出的 20 条 P1 未动。

## 0.6.0 — 2026-11-06

把「派发」变成**会话级的模式开关**：默认不派发，选了任何具体目标就强制派发。

### 新增

- **「不派发」项**（`client/index.js`）：下拉第一项，也是默认勾选项。
  选中它 = 清除会话的派发目标，会话按普通方式自己干活，不创建子会话。
  `@` 菜单里也有（关键词匹配到「不派发 / 关 / none / off」时出现），选中不插入 chip、只清目标。
- **强制派发模式**（Host）：目标不是「不派发」时，该会话进入 `always` 模式，
  系统提示换成 `[dsh-mini-superagent 强制派发]` 段——
  除纯问答外，一切执行型工作都必须 `dispatch_launch` 派下去，
  且**本会话不得自己 write / edit / pwsh 去完成派下去的工作**（避免两处同时改同一项目冲突）。
- **动态提示段**（`src/sessions.js`）：`hint()` 改为注册**函数式文本**，DSH 每次装配系统提示都重新求值。
  切换模式只换求值函数，不重复注册段、不重载插件。
- `Dispatch.modeOf(sessionId)`：目标为 `auto` 或具体工作区 → `always`，否则 `off`。
  新增 `refreshHint` / `refreshAllHints`，并在 `agent/created` 与 `setTarget` 时触发。
- 常量 `NONE` / `MODE_OFF` / `MODE_ALWAYS`。

### 变更

- 下拉第二项是「自动选择」（原第一项），其后才是具体工作区列表；
  「跟随会话目录」并入「不派发」的语义（两者都清目标）。
- 触发器文案：没有目标时显示 `派发 → 不派发`（原「跟随会话」）；
  有目标时 title 提示「已开启必派发：除纯问答外，任务都派下去」。

### 验证

- `node --test` **56 pass**（新增 `test/mode.test.js` 6 条，覆盖模式判定与脏数据防御）；
  `node scripts/client-smoke.mjs` **81 pass**（新增不派发项、顺序、清目标等断言）。
- **真机双向验证**：设为具体工作区后，本会话系统提示当场出现 `[dsh-mini-superagent 强制派发]` 段；
  切回「不派发」后又变回 `[dsh-mini-superagent 工作方式]` 轻提示。切换无需重载插件。
- HTTP：`POST /board/target` 传 `""` 或 `"none"` 都返回 `{ok:true,target:null}`。
- **未做视觉验收**：两处菜单的新首项与文案仍需真机目视。

## 0.5.2 — 2026-11-06

`@` 派发目标菜单里加一条常驻的「自动选择」，不用手动翻列表。

### 新增

- **`@` 菜单首条「自动选择」**（`client/index.js`）：候选列表顶部固定一条，按输入的关键词给工作区打分，
  取第一名。命中时显示 `自动：<标题>`，无匹配时显示 `自动：没有匹配的工作区` 且 `value` 为空
  （点了不会静默什么都不做）。
- **打分规则**（`rankWorkspaces`）：只看用户看得见的东西，不做语义猜测——标题完全相等 100 /
  标题包含 40 / 目录名相等 30 / 目录名包含 15 / 路径包含 5；多关键词累加，同分按标题字典序。
  无关键词时全部同分（1 分），退化为按标题排序取第一，所以 `@` 后直接回车也能选到一个。

### 变更

- `@` 候选里「工作区」分组整体下移一位（首条让位给自动选择）；查询过滤逻辑不变。

### 验证

- `node --test` **50 pass**；`node scripts/client-smoke.mjs` **76 pass**
  （新增 6 条：首条是自动选择、无关键词时指向真实工作区、关键词命中时指向命中的那个、
  自动选择 onPick 产出正确 insert、无匹配时 value 为空、候选 = 自动选择 + 全部工作区）。
- 打分逻辑实测（典型输入 `""` / `sable` / `派发` / `mini` / `2026-11-06` / `不存在`）结果符合预期，
  已记入 `docs/composer.md`。
- 已装到 `desktop` profile，`inGraph = true`、`client.ready.ok = true`。
- **未做视觉验收**：菜单里这一条的实际观感（分组标题、与官方 `@reference` 混排）仍需真机目视。

## 0.5.2 — 2026-11-06

「自动选择」成为派发目标的默认模式，并在 `@` 菜单与输入框下拉两处都提供。

### 新增

- **派发目标新增 `auto` 模式**（Host）：`targets[sessionId] = { auto: true, title: "自动选择", path: "" }`。
  `dispatch_launch` 不带 `workspace` 时，按任务的 `title + brief` 前 200 字给所有工作区打分，
  取分数 ≥ 40 的第一名；挑不到退回默认工作区。显式 `workspace` 参数仍然优先。
- **打分逻辑搬到 Host**（`src/workspaces.js` 的 `rankWorkspaces`）：标题完全相等 100 / 标题包含 40 /
  目录名相等 30 / 目录名包含 15 / 路径包含 5；多关键词累加，同分按标题字典序。
  与 Client 侧共用同一套分值，不再两处各写一份。
- **输入框下拉第一项「自动选择」**（`client/index.js`）：带 `✦` 图标与一行说明，是默认勾选项；
  点它写 `workspace: "auto"`。原有「跟随会话目录」下移为第二项并补了说明文字。
- **`@` 菜单首条「自动选择」**：候选列表顶部固定一条，按输入的关键词打分取第一名；
  命中显示 `自动：<标题>`，无匹配显示 `自动：没有匹配的工作区` 且 `value` 为空（点了不会静默失败）。

### 变更

- `@` 候选里「工作区」分组整体下移一位（首条让位给自动选择）；查询过滤逻辑不变。

### 验证

- `node --test` **50 pass**；`node scripts/client-smoke.mjs` **79 pass**
  （新增 3 条：下拉第一项是自动选择、下拉里有该按钮、点它 POST `workspace:"auto"`）。
- **端到端实测**：把会话目标设为 `auto`，派发标题「sableos 项目目录结构梳理」的任务，
  `task.workspace_title = sableos`，子会话 `Get-Location` 返回 `D:\idea\sableos` ——
  自动识别生效，且落在预期工作区。
- 已装到 `desktop` profile，`inGraph = true`。
- **未做视觉验收**：两处菜单的实际观感（`✦` 图标、分组标题、与官方 `@reference` 混排）仍需真机目视。

## 0.5.1 — 2026-11-06

重启宿主后第一次真机验收时发现并修掉一个会误判「主会话丢了」的 bug。**功能面与 0.5.0 相同。**

### 修复

- **`sessionExists` 调了不存在的方法**：0.5.0 用 `sessionController.inspect(sessionId)` 判断默认主会话是否还在，
  但 `sessionController` 上根本没有 `inspect`（那是另一个服务的接口），调用直接抛 `TypeError`，
  被 catch 成「不存在」。后果是每次启动都以为 `mas-lead` 没了，重新 `create` 一遍；
  而 `selfcheck.lead.exists` 也永远报 `false`，看起来像会话丢了。
  - 现在改用 `state({sessionId}, signal)`（只读被动状态，不 resume Agent），并以 `list()` 兜底；
  - 返回 `{exists, error}` 而不是裸 boolean：`inspect`/`state` 抛错的原因不止「不存在」，
    权限、格式、读写失败都会抛，盲建会覆盖或冲突，所以「查不了」时只记 warn 并跳过创建。
  - `selfcheck.lead` 增加 `error` 字段，把失败原因暴露出来。

### 验证（真机，重启宿主后）

三层全绿，这是界面侧代码第一次在真实浏览器里被确认加载并执行：

| 层 | 命令 | 结果 |
| --- | --- | --- |
| 单元 | `npm test` | **50 pass** |
| 宿主集成 | `node scripts/http-smoke.mjs http://127.0.0.1:9270` | **26/26** |
| 客户端离线 | `node scripts/client-smoke.mjs` | **71/71** |

真机证据：

- `client.inGraph = true`，`path` 指向 `dsh-mini-superagent/client/index.js`；
- `client.ready = {ok: true, registered: ['sidebar.panellist','main','conversation.input.left','@workspace']}`，
  且 `ready.at` 晚于 `bootAt`（`17:36:27` > `17:36:25`），确认是本次实例的真实自报而非陈旧记录；
- 槽位注册表实测：`sidebar.panellist` 有 `dsh-mini-superagent.board`（order 60）、
  `conversation.input.left` 有 `dsh-mini-superagent/target`（order 60）、`main` 有 key `dsh-mini-superagent.board`；
- 系统提示里出现 `[dsh-mini-superagent 工作方式]` 段，确认 per-session 提示注入生效；
- 派发到「mini-superagent」工作区的任务，子会话 `Get-Location` 返回该工作区根目录；
- 磁盘上确认 `mas-lead` 的会话日志（`.dsh/sessions/--…mini-superagent--/mas-lead/session.v4.jsonl.zstd`）存在。

仍未做视觉验收（布局对齐、portal 翻转、深浅主题对比度、`@` 混排观感、草稿 chip 恢复），
这些需要人看，见 `plans/04-post-restart.md` 的目视清单。

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
