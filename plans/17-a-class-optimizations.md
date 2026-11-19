# PRD：A 类七条工程收口（v0.9.1）

| 项 | 值 |
| --- | --- |
| 状态 | 待评审 |
| 日期 | 2026-11-12 |
| 适用版本 | 0.9.1（补丁版，`[Assumption, TBD]`：也可并入下一个次版本） |
| 范围 | A1–A7，七条全部为工程收口；不含 B 类能力立项 |
| 代码基线 | `package.json` 0.9.0，HEAD `fcadac8`，另有 3 个未提交文件 |
| 前置事实 | PRD-01（计划透出）、PRD-02（批次依赖）已实现，不再作为待做项 |

---

## 1. 这一版解决什么问题

当前代码里已经存在一批**事实**：计划、依赖、重试次数、账本版本、客户端渲染断言。问题是这些事实只在某一条路径上可见，或者根本没有被检查：

- 根 README 说 9 个工具，代码里有 10 个；说 0.8.0，包已经是 0.9.0。
- 看板能看到计划和依赖，`dispatch_inspect` 读不到。
- `dispatch_wait` 超时和全部结算返回同一个 `waited: true`。
- 账本写了 `version`，读的时候完全不看。
- 客户端有几百条渲染断言，但不在 `npm test` 里，也没有 CI。
- 重试次数只在内存里，看板只显示"重试中"。
- PRD-01 写过的"计划已更新"提示没实现，看板数字静默变化。

这一版不新增调度能力，只做一件事：**把已经写进代码的事实，在文档、工具面、存储闸门、CI 和看板上钉住**，让下一次改动有参照、有拦截、有可见性。

## 2. 为什么这七条打包在一起

七个问题分属不同层，但它们共享同一个特征：**改动小、验证方式相同、失败模式都是"静默"**。

| 类型 | 条目 | 共同点 |
| --- | --- | --- |
| 正确性闸门 | A1、A4 | 错了不会报错，只会让人误判 |
| 契约一致性 | A2、A3 | 同一事实在两条路径上说法不同 |
| 可观测性 | A6、A7 | 数据已经在内存/快照里，只是没露出来 |
| 回归保护 | A5 | 其余六条都需要它兜底 |

分开做的代价是：每条都要单独跑一次全量回归，而 A5 上线后回归成本会降下来。所以 A5 排在最前，其余六条在同一批次里收口。

**明确不做**：B1 依赖传递结果、B2 角色化装配、B3 报告第二意见、B4 任务预算、B5 插件事件。它们会改变任务协作方式或对外契约，需要单独立项。

## 3. 依赖与实施顺序

```
A5（CI/check 入口）
 ├─ A1（文档闸门）        ← 与 A4、A3 无代码依赖，可并行
 ├─ A3（wait 语义）
 ├─ A4（账本版本闸门）
 └─ A2（工具面补齐 plan/依赖）
      └─ A6（重试健康度）
           └─ A7（计划已更新提示）
```

| 顺序 | 条目 | 依赖 | 说明 |
| --- | --- | --- | --- |
| 1 | A5 | 无 | 先把 `npm run check` 建起来，后面每条都在它下面验证 |
| 2 | A1、A3、A4 | A5 | 三条互不碰同一段代码，可同一批次并行 |
| 3 | A2 | A5 | 先定 `card()` / `detail()` 的字段风格 |
| 4 | A6 | A2 | 复用 A2 定下的短字段投影方式，避免两套风格 |
| 5 | A7 | 无（建议在 A2 后） | 纯客户端，但字段语义以 A2 的说明为准 |

## 4. 整体成功标准

- [ ] `npm run check` 一条命令完成语法检查、`node --test`、客户端 smoke，CI 与本地共用同一入口。
- [ ] 根 README 的工具数量与版本号同代码一致，且有一致性测试守住。
- [ ] `dispatch_wait` 能在返回值上区分"全部结算"与"超时"。
- [ ] 版本高于当前插件的账本能被拒绝，且原文件一个字节都不被改写。
- [ ] `dispatch_inspect` 能读到计划步骤与依赖关系；`dispatch_list` 不被步骤数组撑大。
- [ ] 看板能看到当前任务重试了几次、从什么时候开始重试。
- [ ] 计划变化时看板出现一次"计划已更新"，不重复、不补提示。
- [ ] 所有新增字段只加不改，旧字段名与语义不变；不新增运行时依赖。

---

## 5. A1 文档闸门

### 5.1 现状与问题

- 根 `README.md:28` 要求装完确认"9 个 `dispatch_*` 工具"。
- 同一文件 `README.md:47` 写"10 个工具"，并列出包含 `dispatch_candidates` 的 10 项。
- `src/tools.js:51-62` 的 `TOOL_NAMES` 实际是 10 项。
- 根 `README.md:14` 写"插件包本体（0.8.0）"，`package.json` 的 `version` 是 `0.9.0`，`src/constants.js:10` 的 `VERSION` 也是 `0.9.0`。
- `test/contract-consistency.test.js:33-39` 的一致性断言读的是 `read('README.md')`，解析到 `dsh-mini-superagent/README.md`（包内），**仓库根 README 不在任何断言里**。

### 5.2 目标与非目标

**目标**：根 README 的对外数字与代码一致，并由测试守住，避免下一次改动再漂移。

**非目标**：不重写根 README 的叙述结构；不把包内 README 与根 README 合并；不引入文档生成工具。

### 5.3 功能与交互细节

1. 根 README 第 28 行的工具数改为 10，与第 47 行一致。
2. 根 README 第 14 行的版本写法改为能同时表达两件事：「当前工作区版本 0.9.0；已发布版本以 CHANGELOG 为准」。具体措辞由评审确认（见开放问题 Q1）。
3. 在 `test/contract-consistency.test.js` 新增一条测试：
   - 读 `../README.md`（仓库根）；
   - 用正则取出「确认 N 个 `dispatch_*` 工具」中的 N，断言等于 `TOOL_NAMES.length`；
   - 读 `package.json`，断言 `version === VERSION`。
4. 失败信息要写清「改代码时同步改根 README 的哪一句」，而不是只报数字不等。

### 5.4 数据与接口改动

无运行时字段变化。新增测试断言与文档文本；不新增配置项。

### 5.5 边界与异常

- 根 README 将来若改成表格或英文表述，正则不能匹配时应**测试失败**而不是跳过，逼迫维护者同时更新断言。
- 包内 README 与根 README 允许措辞不同，但工具数与版本必须相同。

### 5.6 对既有机制的影响

ADMISSION、PROJECTION、`settledAt`、投递 durability 均不受影响；不改代码，不改看板。

### 5.7 验收标准

- [ ] 根 README 全文只出现一个工具数量，且为 10。
- [ ] 根 README 的版本表述与 `package.json` / `constants.VERSION` 不矛盾。
- [ ] 故意把根 README 的工具数改回 9，`npm test` 失败并指出该文件。
- [ ] `npm run check` 通过。

### 5.8 成本估算与风险点

**成本**：0.5–1 小时。

**风险**：版本号可能本来就想表达「已发布版 vs 工作区版」，直接改成 0.9.0 会抹掉这个区分。所以必须先定 Q1，再改文案。

**一句话结论**：一小时消掉新用户第一眼的困惑，做。

---

## 6. A2 工具面补齐 plan / depends_on

### 6.1 现状与问题

- `src/dispatch.js:3349-3396` 的 `card()` 不投影 `plan`、`dependsOn`、`blockedBy`。
- `src/dispatch.js:3398-3422` 的 `detail()` 同样没有这些字段。
- `src/board.js` 的 `boardTask()` 已经有 `plan_total` / `plan_done` / `plan_current`，以及 `depends_on` / `blocked_by` / `blocked_reason` / `cancel_reason` / `error_code`。
- `docs/tools.md:58-62` 因此写「想看全量计划走……读 `<stateDir>/tasks.json`」，等于让调用方绕过工具去翻文件。
- `plans/README.md:20` 已把这一条记为 PRD-01 的审计缺口，但尚未排期。

### 6.2 目标与非目标

**目标**：`dispatch_inspect` 能回答「这条任务分几步、走到哪、为什么还没开始」；`dispatch_list` 不被步骤数组撑大。

**非目标**：不改变看板快照的字段（看板已经够用）；不把 `plan` 加进回流消息；不新增工具。

### 6.3 功能与交互细节

`detail()` 新增以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `plan` | `Array<{text: string, status: 'pending'\|'doing'\|'done'}>` | 全量步骤，直接读 `task.plan`；最多 12 步（入库上限） |
| `depends_on` | `string[]` | 前置任务 id，读 `task.dependsOn`；无依赖时为 `[]` |
| `blocked_by` | `string[]` | 尚未结算的前置 id |
| `blocked_reason` | `string` | 可选，与看板同名字段同义 |
| `cancel_reason` | `string` | 可选，仅连带取消时出现 |
| `error_code` | `string` | 可选，与现有 `ERROR_CODES` 闭集一致 |

`card()` 只新增：

| 字段 | 类型 | 理由 |
| --- | --- | --- |
| `depends_on` | `string[]` | 短数组，列表里能看出批次关系 |
| `blocked_by` | `string[]` | 短数组，能看出「在等谁」 |

约束：

- 字段名与 `boardTask()` **逐字一致**，不新造 `dependsOn` / `blockedBy` 这类驼峰别名。
- 空值不输出（沿用 `card()` 现有的 `...(cond ? {k:v} : {})` 写法），避免返回体里出现一堆空数组。`depends_on` 例外：按 `docs/tools.md` 现有口径，无依赖时输出 `[]`，表示「已检查且没有依赖」。
- **已结算任务仍然返回 `plan`**。看板对已结算任务不下发 `plan_*` 是为了省 2 秒轮询带宽；`dispatch_inspect` 是显式查询，不适用这条取舍。

### 6.4 数据与接口改动

只改投影，不改存储：`task.plan`、`task.dependsOn`、`task.blockedBy`、`task.blockedReason`、`task.cancelReason`、`task.errorCode` 均已存在。

受影响接口：`dispatch_inspect`（新增 6 个字段）、`dispatch_list`（新增 2 个字段）。均为只加不改。

### 6.5 边界与异常

- 退休记录没有 `plan` / `dependsOn`：按现有 `detail()` 的退化路径返回，不抛错。
- `task.plan` 不是数组或步骤缺 `text`：按空计划处理，不输出 `plan`。
- 依赖指向已退休任务：`depends_on` 照常返回 id，`blocked_by` 为空（它已结算），与看板一致。
- 计划被截断过：`plan` 只返回存下来的部分，不额外标记；截断标记仍走 `plan_truncated` 的报告回执。

### 6.6 对既有机制的影响

| 机制 | 影响 |
| --- | --- |
| ADMISSION / PROJECTION 分离 | 只动 PROJECTION；ADMISSION 的准入判定不变 |
| `settledAt` | 不读、不写、不改语义 |
| 投递 durability | 不涉及；`dispatch_report` 的入参与回执不变 |
| 只加不改 | 是。旧字段全部保留，新增字段均为可选 |

### 6.7 验收标准

- [ ] 一条带 5 步计划的任务，`dispatch_inspect` 返回 `plan` 5 项，`status` 与账本一致。
- [ ] `dispatch_list` 的任意一条都不含 `plan` 键。
- [ ] 一条有前置的任务，`dispatch_inspect` 返回 `depends_on` 与 `blocked_by`，字段名与看板相同。
- [ ] 无依赖任务的 `depends_on` 是 `[]`，不是缺字段。
- [ ] 已结算任务仍能在 `dispatch_inspect` 里读到 `plan`。
- [ ] 退休任务调用 `dispatch_inspect` 不抛错。
- [ ] `docs/tools.md:58-62` 不再写「读 `tasks.json`」。
- [ ] `npm run check` 通过。

### 6.8 成本估算与风险点

**成本**：2–4 小时（含测试与文档）。

**风险**：
- `card()` 同时服务 `dispatch_list` 与 `dispatch_inspect`，误把 `plan` 放进 `card()` 会让列表返回体膨胀数倍。实现时用一条测试钉住「list 不含 plan」。
- 字段名若与看板不一致，会形成第二套口径，后续排查时两边对不上。

**一句话结论**：看板已有的事实让工具也读得到，低成本高一致性，做。

---

## 7. A3 dispatch_wait 区分超时与全部结算

### 7.1 现状与问题

- `src/tasks.js:512-555` 的 `waitFor()` 无论「全部结算」还是「超时」都 `resolve(tasks)`，两条路径共用 `finish()`，没有标志。
- `src/tools.js:543-556` 因此无条件返回 `{ waited: true, tasks }`。
- 工具描述（`src/tools.js:527-534`）已经写了「超时后任务可能仍在 running」，但返回值本身没有给这个信号。

### 7.2 目标与非目标

**目标**：模型拿到返回值就能判断「是不是真的等到了」，不需要逐条反推 `status`。

**非目标**：不改变 `dispatch_wait` 的阻塞语义、默认超时（60000）与上限（600000）；不新增轮询式等待；不改 `waiters` 的清理逻辑。

### 7.3 功能与交互细节

- `waitFor()` 的返回形状从 `tasks` 改为 `{ timedOut: boolean, tasks }`。
- `finish()` 接受一个来源参数（`'settled'` 或 `'timeout'`），在 resolve 前写入 `timedOut`；`done` 守卫保持只走一次。
- 工具返回改为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `waited` | `boolean` | 保留原字段。`targets` 为空时仍为 `false` |
| `timed_out` | `boolean` | 本次是否因超时返回 |
| `unsettled` | `string[]` | 仍未结算的 `task_id`；全部结算时为 `[]` |
| `tasks` | `object[]` | 原样保留，元素仍是 `card()` |

- `timed_out === true` 时，`tasks` 中未结算项照常返回当前 `status`，不做任何伪造。

### 7.4 数据与接口改动

`dispatch_wait` 返回体新增 `timed_out`、`unsettled`；`waited`、`tasks` 不变。不落盘、不进账本。

### 7.5 边界与异常

- `task_ids` 为空且本会话没有未结算任务：维持现有 `{ waited: false, tasks }`，并补 `timed_out: false`、`unsettled: []`。
- 重复 id：`waitFor()` 已按 id 去重，`unsettled` 也只出现一次。
- 超时后残留 waiter：现有实现已在 `finish()` 里统一摘除，改造时不能因为新增来源参数破坏这条清理。
- 等待期间任务被取消：按已结算处理（`SETTLED` 包含 `cancelled`），`unsettled` 不包含它。

### 7.6 对既有机制的影响

| 机制 | 影响 |
| --- | --- |
| ADMISSION / PROJECTION | 不涉及 |
| `settledAt` | 只读 `SETTLED` 集合，不改结算 |
| 投递 durability | 不涉及 |
| 只加不改 | 是。`waited` / `tasks` 保留，新增两个字段 |

### 7.7 验收标准

- [ ] 一个永不结算的任务 + `timeout_ms: 1000`：返回 `timed_out: true`，`unsettled` 含该 id。
- [ ] 全部结算的任务：返回 `timed_out: false`，`unsettled: []`。
- [ ] 空 `task_ids` 且无未结算任务：`waited: false`，新增字段为 `false` / `[]`。
- [ ] 等待期间取消任务：不把它算进 `unsettled`。
- [ ] `docs/tools.md` 的 `dispatch_wait` 返回值示例已同步。
- [ ] `npm run check` 通过。

### 7.8 成本估算与风险点

**成本**：1–2 小时。

**风险**：`finish()` 同时承担「计数归零」和「定时器触发」两条路径，改动时要保证清理只执行一次；否则会留下悬挂 waiter 或重复 resolve。

**一句话结论**：改一个返回值就消掉一个误判源，最便宜的一条，先做。

---

## 8. A4 账本 version 读取校验

### 8.1 现状与问题

- `src/store.js:49` 定义 `FILE_VERSION = 4`，`writeState()`（`114-141`）把 `version` 写进文件。
- `readState()`（`80-105`）解析后交给 `normalize()`（`59-70`），后者**完全不读 `version`**。
- 主文件解析失败时回退 `.bak`；文件不存在时也尝试 `.bak`。
- 上游原型 `reference/dsh-superagent-prototype/src/app/migration.ts:20-25` 有 `SCHEMA_VERSION`、`OLDEST_SCHEMA`，并对过旧库直接拒绝并给操作指引。

### 8.2 目标与非目标

**目标**：账本版本高于当前插件时，插件拒绝读取，并且**绝不覆盖原文件**；错误信息直接告诉用户下一步怎么做。

**非目标**：不写迁移函数；不自动降级字段；不把账本从 JSON 换成数据库；不处理版本 1/2 字段级迁移（现有「缺字段按空读」已覆盖）。

### 8.3 功能与交互细节

新增常量：

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `FILE_VERSION` | `4`（已有） | 当前写出的版本 |
| `OLDEST_FILE_VERSION` | `3`（`[Assumption, TBD]`） | 可读的最低版本；依据是 CHANGELOG 里 v3 引入 `targets`、v4 引入 `retired` |

读取规则：

1. 解析主文件成功：
   - `version > FILE_VERSION`：抛错，`error.code = 'LEDGER_TOO_NEW'`，message 含「账本版本 X 高于当前插件支持的 Y；请升级插件，或改用新的 state 目录」。
   - `version < OLDEST_FILE_VERSION`：抛错，`error.code = 'LEDGER_TOO_OLD'`，message 给同样的操作指引。
   - `version` 缺失（极旧文件）：按现有兼容路径读取，并在 `restoreError` 留一条「账本缺少 version，按旧格式读取」的 warn，不阻断启动。
   - `version` 在 `[3, 4]` 内：正常读取。
2. 主文件不存在：现有 `.bak` 回退逻辑不变；回退成功后同样执行上面的版本判断。
3. 主文件存在但解析失败：先走 `.bak` 回退；只有回退也失败才抛主文件错误。版本判断不改变这条顺序。

启动行为：`restore()` 捕获 `LEDGER_TOO_NEW` / `LEDGER_TOO_OLD` 后**重新抛出**，让 `apply()` 失败、插件不加载（fail-closed）。这样不会出现「空表 + 下一次写盘覆盖新文件」的最坏情况。

错误出口：插件启动日志（`LOG_PREFIX`）是唯一出口；`selfCheck()` 因为插件未加载而不可用，这一点要在错误文案里说明。

### 8.4 数据与接口改动

- 账本文件格式不变，仍写 `version: 4`。
- 新增两个错误码字符串（`error.code`，不是 `ERROR_CODES` 的 `dispatch/*` 闭集）：`LEDGER_TOO_NEW`、`LEDGER_TOO_OLD`。
- `selfCheck()` 不新增字段（fail-closed 时它不会被执行）。

### 8.5 边界与异常

- `.bak` 是旧版本、主文件是新版本：以主文件为准，拒绝；不能因为备份「能读」就降级读取。
- 手工把 `version` 改成字符串 `"4"`：按非法版本处理，抛 `LEDGER_TOO_NEW` 或明确报「version 不是整数」，不静默当 4。
- 文件为空：沿用现有解析失败路径，不当成版本问题。
- 首次安装（无文件）：`ENOENT` → 空状态，不触发任何版本判断。

### 8.6 对既有机制的影响

| 机制 | 影响 |
| --- | --- |
| ADMISSION / PROJECTION | 不涉及 |
| `settledAt` | 不涉及 |
| 投递 durability | 不涉及 |
| 只加不改 | 文件格式不变；改变的是「读到不支持版本时的行为」，属于有意的 fail-closed |

### 8.7 验收标准

- [ ] `version: 99` 的账本：启动抛 `LEDGER_TOO_NEW`，原文件内容与修改时间不变。
- [ ] `version: 2` 的账本：启动抛 `LEDGER_TOO_OLD`。
- [ ] `version: 4` / `version: 3`：正常启动，任务读回。
- [ ] 无 `version` 的旧文件：正常启动，`restoreError` 有 warn。
- [ ] 主文件损坏 + `.bak` 为 v4：仍能从 `.bak` 恢复。
- [ ] 主文件 v99 + `.bak` v4：拒绝启动，不回退到 `.bak`。
- [ ] `npm run check` 通过。

### 8.8 成本估算与风险点

**成本**：2–3 小时。

**风险**：
- 版本判断放在 `.bak` 回退之后，等于白拦；实现时必须先判主文件版本。
- `OLDEST_FILE_VERSION` 取 3 还是 4 会直接影响老用户能否升级。取 3 更宽容，取 4 更严格；需要评审拍板（Q3）。
- fail-closed 会让插件整体不可用。如果宿主对插件加载失败的处理是「静默跳过」，用户可能只看到工具消失；错误文案必须同时写进日志。

**一句话结论**：给下一次格式变更留退路，便宜但现在必须做。

---

## 9. A5 最小 CI

### 9.1 现状与问题

- 仓库根没有 `.github/`，也没有任何 CI 配置。
- `package.json` 的 `scripts` 只有 `"test": "node --test"`。
- `scripts/client-smoke.mjs` 是离线渲染 smoke，需要人工执行；`test/` 目录里没有任何引用（grep 无命中）。
- 客户端断言目前有数百项，但不在默认回归路径里。

### 9.2 目标与非目标

**目标**：一条命令覆盖「语法 + 单测 + 客户端渲染」，本地与 CI 共用；提交前漏跑客户端断言的情况不再发生。

**非目标**：不引入 ESLint / Prettier / 类型检查；不要求 100% 覆盖率；不做真机浏览器视觉验收（那属于另一条已知缺口）。

### 9.3 功能与交互细节

新增脚本：

| 脚本 | 内容 |
| --- | --- |
| `scripts/check-syntax.mjs` | 遍历 `src/**/*.js`、`client/**/*.js`、`scripts/**/*.mjs`，对每个文件执行 `node --check`；失败时打印文件路径与原始错误 |
| `npm run check` | `node scripts/check-syntax.mjs && node --test && node scripts/client-smoke.mjs` |

CI（GitHub Actions，`[Assumption, TBD]`：若主仓库不在 GitHub，改用等价流水线）步骤：

1. checkout；
2. `actions/setup-node`，Node 22（与 `engines.node` 对齐）；
3. `node scripts/check-syntax.mjs`；
4. `node --test`；
5. `node scripts/client-smoke.mjs`。

不执行 `npm ci`：本包零运行时依赖，也没有 lockfile，直接调 `node` 更稳。

### 9.4 数据与接口改动

新增 `scripts/check-syntax.mjs`、`package.json` 的 `check` 脚本、CI workflow 文件。不改运行时、不改工具 schema。

### 9.5 边界与异常

- Windows 与 Linux 的路径分隔符不同：遍历用 `fs.readdir` + 递归，不用 shell 通配。
- `node --check` 对 `.mjs` 与 `.js` 都支持；对非 JS 文件跳过。
- 客户端 smoke 若依赖 `--experimental-*` 标志，统一写进脚本，不写进 CI 命令。
- 首次接入时若发现既有失败，先修失败再合并 CI，不能用 `continue-on-error` 掩盖。

### 9.6 对既有机制的影响

无运行时影响；只影响贡献流程与回归成本。ADMISSION、PROJECTION、`settledAt`、投递均不涉及。

### 9.7 验收标准

- [ ] `npm run check` 在本地一次通过。
- [ ] 故意在某文件写入语法错误，`check` 失败并指出该文件。
- [ ] 故意让一条客户端 smoke 断言失败，`check` 失败。
- [ ] CI 在 PR 上运行，且与本地命令完全一致。
- [ ] `package.json` 未新增运行时 `dependencies`。

### 9.8 成本估算与风险点

**成本**：2–4 小时（不含首次跑通时可能修的既有失败）。

**风险**：
- 首次接入可能暴露既有 flaky 用例（仓库里有 `test/` 的时序相关用例），需要先稳定再上 CI。
- `client-smoke.mjs` 依赖宿主 shim，CI 环境若缺 Node 版本会有差异；用 `engines.node` 的 22 版本对齐。

**一句话结论**：把三条人工命令变成一条闸门，做。

---

## 10. A6 重试健康度投影

### 10.1 现状与问题

- `src/dispatch.js:233` 的 `this.retryCounts` 记录「这条任务已续跑几次」。
- `retry()`（`3217-3223`）累加；成功或回合结束时删除（`1986`、`3265`）。
- `card()`（`3389`）只投影 `retry_at`，没有次数、没有首次重试时间。
- 看板有 attempt 标签（`client/index.js` 约 4265），但拿不到次数。

### 10.2 目标与非目标

**目标**：看板与 `dispatch_inspect` 能回答「重试了几次、从什么时候开始」，用户据此判断该等还是该介入。

**非目标**：不改变重试策略、次数上限、退避间隔；不把重试计数落盘；不新增"自动放弃"逻辑。

### 10.3 功能与交互细节

新增内部状态：`this.retrySince = new Map()`（任务 id → 首次重试的 ISO 时间）。生命周期与 `retryCounts` 完全一致：

- `retry()` 里首次累加时写入 `retrySince`；
- `1986`、`3265` 两处删除 `retryCounts` 时同步删除；
- `4742` 的 `retryCounts.clear()` 处同步 `retrySince.clear()`。

`card()` 新增字段（`attempts > 0` 时才输出）：

| 字段 | 类型 | 来源 |
| --- | --- | --- |
| `retry_health` | `{attempts: number, since: string, last_at: string}` | `retryCounts` / `retrySince` / `task.retryAt` |

最近错误复用 `card().error`（已有，截断 300 字），不在 `retry_health` 里重复一份。

看板：attempt 标签显示 `retry_health.attempts`，文案形如「重试 2 次」；有 `since` 时提供 `title` 提示「自 HH:mm 起」。

### 10.4 数据与接口改动

- `dispatch_list` / `dispatch_inspect`：新增可选 `retry_health`。
- 看板快照：`boardTask()` 新增同名 `retry_health`（需要 Host 侧读取 `retryCounts`，因此 `boardTask()` 需要拿到 `Dispatch` 的计数；实现方式二选一：把计数写进任务对象 `task.retryHealth`，或由 `boardTask()` 接收可选参数。**推荐前者**，因为不改变 `boardTask(task)` 的签名）。
- 不落盘；重启后归零。

### 10.5 边界与异常

- 重启后 `retryCounts` 归零，卡片不显示 `retry_health`；这是诚实行为，不能显示历史次数。
- 任务结算后计数被删除，字段消失。
- `retryAt` 缺失（尚未安排下一次）时 `last_at` 省略，不写空串。
- 同一任务多次失败但未触发 `retry()`（例如非瞬时错误）：`attempts` 为 0，不显示。
- 若实现时发现 `task.error` 在重试路径上未被写入，则 `retry_health` 增加 `last_error`（`[TBD]`，需在实现前确认 `retry()` 是否写 `task.error`）。

### 10.6 对既有机制的影响

| 机制 | 影响 |
| --- | --- |
| ADMISSION / PROJECTION | 只动 PROJECTION；准入不变 |
| `settledAt` | 不变 |
| 投递 durability | 不变；重试次数与投递重试（`task.delivery`）是两回事，字段名必须区分，不能混用 |
| 只加不改 | 是；`retry_at` 保留 |

### 10.7 验收标准

- [ ] 模拟两次瞬时失败：`dispatch_inspect` 返回 `retry_health.attempts = 2`，`since` 非空。
- [ ] 看板对应任务显示「重试 2 次」。
- [ ] 任务结算后字段消失。
- [ ] 重启插件后同一任务不再显示 `retry_health`。
- [ ] `card().retry_at` 与既有语义不变。
- [ ] `npm run check` 通过。

### 10.8 成本估算与风险点

**成本**：2–4 小时。

**风险**：
- 新增 `retrySince` 必须在三处清理（`1986`、`3265`、`4742`）同步，漏一处就是长期内存增长。
- 若把 `retry_health` 与投递重试混在一起展示，会让用户误以为「报告没送到」。两者必须分开展示。

**一句话结论**：把已经在内存里的计数露出来，做。

---

## 11. A7 PRD-01 的「计划已更新」提示

### 11.1 现状与问题

- `plans/README.md:25` 自记：PRD-01 §6 的「计划更新后显示一次『计划已更新』」没有实现。
- 看板的 `plan_total` / `plan_done` / `plan_current` 每 2 秒轮询一次（`client/index.js` 的 `POLL_MS = 2000`），worker 上报新计划后数字会静默变化。
- `plans/README.md:29-30` 同时记录：本批能力尚无真机视觉验收。

### 11.2 目标与非目标

**目标**：计划发生变化时，用户能注意到一次，而不是数字自己变。

**非目标**：不新增消息、不改 `dispatch_report`、不改快照字段、不做通知中心、不补历史提示。

### 11.3 功能与交互细节

纯客户端内存状态（不落盘、不进协议）：

- `lastPlan: Map<task_id, {total, done, current}>`：上一轮快照的计划三元组。
- `planNotice: Map<task_id, timestamp>`：本轮需要显示提示的时刻。

每轮快照到达后：

1. 任务没有 `plan_total`（已结算或没有计划）→ 删除两张表里的该 id。
2. 任务首次出现（`lastPlan` 没有该 id）→ 只记录，不提示。
3. 三元组任一变化 → 写 `planNotice[task_id] = Date.now()`，并更新 `lastPlan`。
4. 三元组未变且 `planNotice` 里有记录 → 保留到展示窗口结束（建议 6 秒，即 3 个轮询周期），之后删除。

渲染：任务行在 `planNotice` 有效期内显示一个徽标「计划已更新」；抽屉打开时同样显示。徽标不阻塞任何操作。

### 11.4 数据与接口改动

无 Host 改动、无快照字段改动、无协议改动。新增两个客户端内存 Map 与一个徽标。

### 11.5 边界与异常

- 页面刷新：没有上一轮基线，不补提示。
- 轮询失败（快照 `stale`）：**不比较、不提示**，避免拿同一份旧数据自我对比。恢复后第一轮只重建基线。
- 三个字段同时变化：只产生一条提示。
- 视图切换（任务看板 ↔ 分析看板）：`lastPlan` 保留，不重建基线，避免切换后误提示。
- 任务从列表消失（退休/归档过滤）：清理两张表，避免内存累积。
- 计划从有到无（终态）：清理，不提示「计划已删除」。

### 11.6 对既有机制的影响

| 机制 | 影响 |
| --- | --- |
| ADMISSION / PROJECTION | 不涉及；只消费已有快照 |
| `settledAt` | 不涉及 |
| 投递 durability | 不涉及 |
| 只加不改 | 是；不改任何字段与接口 |

### 11.7 验收标准

- [ ] worker 上报 `2/5` 后改为 `3/5`：看板行出现一次「计划已更新」。
- [ ] 约 6 秒后提示消失，数字保留。
- [ ] 连续两轮上报相同计划：不重复提示。
- [ ] 页面刷新后：不补提示。
- [ ] 快照请求失败期间：不产生提示。
- [ ] 已结算任务：不显示提示。
- [ ] `npm run check` 通过。

### 11.8 成本估算与风险点

**成本**：2–3 小时。

**风险**：
- 在 `stale` 快照上对比会制造假提示，必须在数据源失败时跳过比较。
- 提示窗口依赖 2 秒轮询，若将来 `POLL_MS` 调整，6 秒窗口要跟着改成常量而不是魔法数字。

**一句话结论**：补一条 PRD 明确写过的验收，顺手做。

---

## 12. 横切：对既有机制的统一影响

| 机制 | A1 | A2 | A3 | A4 | A5 | A6 | A7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ADMISSION（`src/constants.js` 的 `ADMISSION`） | — | 不变 | 不变 | — | — | 不变 | — |
| PROJECTION（`PROJECTION`） | — | 新增字段 | — | — | — | 新增字段 | 只读 |
| `settledAt` / `SETTLED` | — | 只读 | 只读 | — | — | 不变 | 只读 |
| 投递 durability（`task.delivery`） | — | 不变 | — | — | — | 与重试计数区分 | — |
| 账本格式 | — | — | — | 不变（仅读校验） | — | 不落盘 | — |
| 只加不改 | 是 | 是 | 是 | 文件格式不变 | 是 | 是 | 是 |

**兼容原则**：所有新增字段都是可选的；旧客户端忽略它们即可。唯一的行为变化是 A4 的 fail-closed——它只在「账本版本不受支持」时触发，正常升级路径不受影响。

## 13. 兼容与迁移

- 账本：不需要迁移。v3 / v4 正常读取；v1 / v2 缺 `version` 按旧格式读并 warn。
- 工具返回值：新增字段，旧调用方不受影响；没有字段改名或删除。
- 看板快照：A6 新增 `retry_health`；客户端旧版本忽略即可。
- 客户端：A7 是纯前端状态，不需要 Host 同步升级；但建议与 A2/A6 同批发布，避免字段语义文档分叉。

## 14. 成本汇总

| 条目 | 区间 | 主要风险 |
| --- | --- | --- |
| A1 | 0.5–1 h | 版本号措辞未定 |
| A2 | 2–4 h | `card()` 体积、字段名漂移 |
| A3 | 1–2 h | `finish()` 共用收尾 |
| A4 | 2–3 h | fail-closed 的启动影响、版本下界 |
| A5 | 2–4 h | 首次接入暴露既有失败 |
| A6 | 2–4 h | 三处清理、与投递重试混淆 |
| A7 | 2–3 h | `stale` 快照假提示 |
| 合计 | 约 12–21 h | 不含评审与真机验收 |

## 15. 开放问题（评审需拍板）

| ID | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| Q1 | 根 README 的版本该写什么 | A. 工作区版本 0.9.0；B. 已发布版本；C. 两者都写 | C。读者能同时知道「仓库里是什么」和「市场装的是什么」 |
| Q2 | 本批发布号 | A. 0.9.1 补丁；B. 0.10.0 次版本 | A。七条无破坏性协议变更；A4 的 fail-closed 只影响跨版本 |
| Q3 | A4 的最低可读版本 | A. 3；B. 4 | A。v3 只差 `retired`，现有「缺字段按空读」能覆盖；取 4 会让 0.7.x 用户无法直接升级 |
| Q4 | A4 版本过新时的行为 | A. fail-closed（插件不加载）；B. 只读降级（能看不能写） | A。B 需要在所有写路径加闸门，改动面大，且容易漏 |
| Q5 | A2 的 `depends_on` 空值 | A. 输出 `[]`；B. 不输出 | A。与 `docs/tools.md` 现有口径一致，也表达「已检查且无依赖」 |
| Q6 | A6 是否显示 `last_error` | A. 复用 `card().error`；B. 在 `retry_health` 里单独放 | 先 A；实现前确认 `retry()` 是否写 `task.error`，不写再补 B |
| Q7 | A7 提示窗口 | A. 6 秒；B. 一轮轮询 | A。一轮太短，用户可能正好没看；6 秒与 2 秒轮询对齐 |
| Q8 | A5 的 CI 平台 | A. GitHub Actions；B. 其他 | 按主仓库实际托管平台决定 `[TBD]` |

## 16. 不在本 PRD 范围

- B1 依赖传递上游结果、B2 角色化装配、B3 报告第二意见、B4 任务级预算、B5 插件事件钩子。
- 真机浏览器视觉验收（`plans/README.md:29-30` 已记为独立缺口）。
- `docs/voice-samples.md` 的人工盲评。
- 任何会改变 `depends_on` 准入语义、`settledAt` 权威性或投递 durability 的改动。
