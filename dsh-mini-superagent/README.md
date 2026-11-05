# dsh-mini-superagent · 任务派发

给 DeepSeek Harness 装一张任务台：主会话派活，子会话干活，报告自己回来。

主会话用 `dispatch_launch` 把任务派给**独立的后台子会话**（自己的 Session、自己的工作目录、独立跑完整的一轮或多轮），
命令**立即返回**；子会话干完用 `dispatch_report` 汇报，报告作为一条插件来源的消息回到主会话——
主会话空闲时被唤醒，忙碌时并入下一个 step。于是主会话可以「派发 → 收报告 → 追问/纠偏 → 再派发」，
而不是卡在等结果上。

能力模型参考 DSH 官方 [dsh-superagent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype)，
但只保留派发这一件事：**没有** GitHub/飞书监听、没有工单与授权策略、没有管理面板、没有数据库、没有构建步骤。
纯 ESM，零运行时依赖。

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

实测环境：DSH `0.2.1-rc.5`，`desktop` profile。

---

## 安装

插件是纯 ESM，不需要构建、不需要 `npm install`。

### 方式一：让 agent 安装（推荐）

把这句话交给 DSH 里的任意会话：

> 用 plugin_manager 的 install_bundle，把 `dsh-mini-superagent` 这个目录安装成 bundle，装完确认 8 个 `dispatch_*` 工具已注册。

### 方式二：手动

```text
plugin_manager(action="install_bundle", target="<仓库根>/dsh-mini-superagent")
```

安装到 live profile 后立即生效；工具在会话的下一轮可见。

验证：

```text
dispatch_list()
→ {"version":"0.2.0","total":0,"running":0,"max_workers":6,"tasks":[]}
```

`version` 是 `0.2.0` 说明跑的是这一版；`max_workers` 应等于配置里的 `maxWorkers`（默认 6）。

> **迁移注意**：不要和旧插件 `dsh-dispatch` 同时安装。两者注册同名的 8 个工具，同一全局层重复注册会直接抛错。
> 先 `plugin_manager` 的 `remove_bundle` 移除旧 bundle（准确的 id 以 `list_bundles` 为准），再装这个。

旧任务表可选迁移（不迁也能用，只是历史列表为空）：

```powershell
Copy-Item "$env:DSH_HOME\dsh-dispatch\tasks.json" "$env:DSH_HOME\dsh-mini-superagent\tasks.json"
```

旧文件是 version 1，新代码读取时不强校验版本；其中未结算的任务照样会被标成 `interrupted`。
（若 `DSH_HOME` 未设，两处路径换成 `~/.dsh/...`。）

---

## 8 个工具

| 工具 | 谁用 | 做什么 |
| --- | --- | --- |
| `dispatch_launch` | 主会话 | 派发一个任务，立即返回 `task_id` + 子会话 id。并发位满时进 `queued` |
| `dispatch_launch_many` | 主会话 | 一次派发 1–16 个互相独立的任务 |
| `dispatch_list` | 主会话 | 看本会话派出的任务与状态 |
| `dispatch_inspect` | 主会话 | 看单个任务的详情：简报、最近报告、worker 最后输出 |
| `dispatch_message` | 主会话 | 给子会话追问、纠偏、下发下一步；任务重新变 `running` |
| `dispatch_cancel` | 主会话 | 结束子会话当前回合、释放并发位 |
| `dispatch_wait` | 主会话 | 阻塞等待若干任务结算（**少用**，报告本来就会自己回来） |
| `dispatch_report` | 子会话 | worker 向派发者汇报 `done` / `blocked` / `failed` / `progress` |

工具注册在插件根 context，**对所有会话可见**；权限不靠注册作用域，而是在 `execute` 里判断
「调用者是不是已登记的 worker」：`dispatch_report` 只接受 worker，其余工具只操作本会话派出的任务。
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

## 配置

全部可选，写在 bundle 的 `cordis.patch.yml` 的 `config` 里（默认值见 `src/constants.js` 的 `DEFAULTS`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxWorkers` | `6` | **全局**同时 `running` 的上限；超出的进 `queued`，有空位自动开始（按登记顺序） |
| `maxTasksPerSession` | `64` | 每个主会话累计派发上限（防递归派发失控） |
| `inheritWorkingDirectory` | `true` | 子会话继承主会话的工作目录 |
| `permissionPreset` | `''` | 子会话权限预设。后台无人看管时建议 `danger-full-access`，否则可能卡在审批上 |
| `stateDir` | `''` | 任务表落盘目录；空表示 `$DSH_HOME/dsh-mini-superagent`（`DSH_HOME` 未设时用 `~/.dsh`） |
| `reportOnTurnEnd` | `true` | worker 回合结束自动回报 |
| `maxBriefChars` | `12000` | 投给 worker 的任务简报最大字符数 |

单个任务还可以在 `dispatch_launch` / `dispatch_launch_many` 时覆盖 `cwd` / `model` / `agent_preset` / `permission_preset`。

---

## 落盘与重启

- 任务表在 `<stateDir>/tasks.json`（默认 `$DSH_HOME/dsh-mini-superagent/tasks.json`），UTF-8，覆盖写，800ms 防抖。
- 文件结构 `{version: 2, savedAt, tasks: [...]}`；读取时不强校验版本，坏文件只记日志、不阻止插件启动。
- 插件重启后读回历史任务；进程之间没有活的 worker，所以**未结算的一律标 `interrupted`**，不假装还活着。
- 子会话本身是普通 DSH Session，内容由 DSH 自己持久化，在侧边栏里可以直接打开。
- 每个任务最多保留 50 条报告；简报落盘时截到 2000 字符（完整简报在 worker 首条消息里）。

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

最后一条同时是 0.2.0 的修复验证：0.1.0 只在派发与插件加载时推进队列，结算后不会补 `pump()`，
并发位满时后面的任务会一直 `queued`。这个问题是整理代码时被测出来的，修法与依据见 [docs/architecture.md](docs/architecture.md) 的「pump 的触发点」。

`test/tasks.test.js` 另外覆盖任务表的纯逻辑（`npm test`），但那不是上面这些端到端实测的替代。

---

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/tools.md](docs/tools.md) | 8 个工具的参数、返回、错误、何时用/何时别用 |
| [docs/architecture.md](docs/architecture.md) | 模块职责、数据流、设计取舍与依据 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 排障表、日志前缀与恢复动作 |
| [docs/api-contracts.md](docs/api-contracts.md) | DSH 主机 API 契约取证（消息/Agent/事件/会话控制器/工具作用域） |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0（原名 dsh-dispatch）与 0.2.0 的差异 |

---

## 目录

```text
dsh-mini-superagent/
  package.json        # name/version、engines、dsh.bundle.patch 声明
  cordis.patch.yml    # 插入插件行 + 默认配置（可整段删掉，靠代码默认值）
  src/
    index.js          # 入口：建 Dispatch、注册工具、接宿主事件
    constants.js      # 名称/版本/日志前缀/source kind/默认配置/状态集合
    tasks.js          # TaskTable（并发位/排队/结算/等待）+ 纯函数
    store.js          # tasks.json 读写
    sessions.js       # DSH 适配：建会话、取 Agent、权限预设、提示注入、投递
    prompt.js         # 给模型的文本：工作方式提示 + worker 首条简报
    tools.js          # 8 个工具定义
    dispatch.js       # Dispatch 服务：launch/pump/settle/start/report/relay/message/cancel
  test/tasks.test.js  # TaskTable 单测
  locale/{zh,en}.json # 管理面板里的标题与描述
  icon.svg
  LICENSE             # MIT
  docs/
    architecture.md   # 模块职责、数据流、设计取舍
    tools.md          # 8 个工具的参数/返回/错误
    troubleshooting.md  # 排障表与日志前缀
    api-contracts.md  # DSH 主机 API 契约取证
  CHANGELOG.md
```

---

## License

MIT
