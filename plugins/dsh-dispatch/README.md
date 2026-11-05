# dsh-dispatch · 任务派发

给 DeepSeek Harness 装一个「主会话当指挥、子会话干活」的能力。

主会话用 `dispatch_launch` 把任务派给**独立的后台子会话**（自己的 Session、自己的工作目录、独立跑完整的一轮或多轮），
`dispatch_launch` **立即返回**；子会话干完活用 `dispatch_report` 汇报，报告会作为一条消息**自己回到主会话**——
主会话空闲时会被唤醒，忙碌时并入下一个 step。于是主会话可以不停地「派发 → 收报告 → 追问/纠偏 → 再派发」，
而不是卡在等结果上。

灵感来自 DSH 官方的 [dsh-superagent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype)，但只保留「派发」这一件事：
**没有** GitHub/飞书监听、没有工单与授权策略、没有管理面板、没有数据库、没有构建步骤。整个插件是一个约 800 行的纯 ESM 文件，
零运行时依赖。

---

## 它解决了什么

普通 subagent 调用是「同步委托」：调用方等结果，等的时候什么也做不了。真正需要的是：

- 一次派 5 个互不相关的任务，谁先好谁先报；
- 主会话在等报告的同时继续跟用户对话、继续拆任务；
- 子会话不是一次性的——可以追问、纠偏、让它接着做下一步；
- 子会话卡住了能看见、能取消，不会变成黑洞。

`dsh-dispatch` 就是这张「任务台」。

---

## 安装

插件是纯 ESM，**不需要构建、不需要 pnpm install、不需要任何依赖**。

### 方式一：让 agent 安装（推荐）

把下面这句话交给 DSH 里的任意会话：

> 用 plugin_manager 的 install_bundle，把 `plugins/dsh-dispatch` 这个目录安装成 bundle，装完确认 8 个 `dispatch_*` 工具已注册。

### 方式二：手动

```bash
# 在 DeepSeek Harness 里（或让 agent 代劳）：
plugin_manager(install_bundle, target="<绝对路径>/plugins/dsh-dispatch")
```

安装后插件立即激活（HMR）。确认方式：让会话调用 `dispatch_list`，能返回
`{"version": "0.1.0", "total": 0, ...}` 就说明装好了。

> 状态：本机已在 `desktop` profile 上安装并跑通（见文末「验证记录」）。

---

## 8 个工具

| 工具 | 谁用 | 做什么 |
| --- | --- | --- |
| `dispatch_launch` | 主会话 | 派发一个任务，立即返回 `task_id` + 子会话 id。并发位满时进 `queued` 队列 |
| `dispatch_launch_many` | 主会话 | 一次派发 1–16 个互相独立的任务 |
| `dispatch_list` | 主会话 | 看本会话派出的任务与状态 |
| `dispatch_inspect` | 主会话 | 看单个任务的详情：简报、最近报告、worker 最后输出 |
| `dispatch_message` | 主会话 | 给子会话追问、纠偏、下发下一步；任务重新变 `running` |
| `dispatch_cancel` | 主会话 | 结束子会话当前回合、释放并发位 |
| `dispatch_wait` | 主会话 | 阻塞等待若干任务结算（**少用**，报告本来就会自己回来） |
| `dispatch_report` | 子会话 | worker 向派发者汇报 `done` / `blocked` / `failed` / `progress` |

工具注册在插件根 context，所以**对所有会话可见**；权限靠「调用者是不是已登记的 worker」区分：
主会话可以派发，worker 只能汇报（在主会话里调 `dispatch_report` 会明确报错，反之亦然）。

---

## 一次典型的使用

```
用户：把这个项目的三个模块分别重构一下，互相独立。

主会话：
  dispatch_launch_many(tasks=[
    {title: "重构 auth 模块", brief: "……目标、约束、验收、相关路径……"},
    {title: "重构 billing 模块", brief: "……"},
    {title: "重构 notify 模块", brief: "……"},
  ])
  → 立即拿到 3 个 task_id，本轮结束，不阻塞。
```

之后：

1. 子会话各自开工（`running`，最多 `maxWorkers` 个同时跑）。
2. 第一个完成后 `dispatch_report(done)` → 主会话被唤醒，收到一条带 `[dispatch]` 前缀的消息。
3. 主会话发现 auth 那个的摘要里「遗留风险：没跑集成测试」，于是
   `dispatch_message(task_id, "补跑 test/auth 下的集成测试，失败就修到绿")` → 任务重新 `running`。
4. 全部完成后主会话汇总给用户。

### 怎么写 brief

子会话**看不到主会话的历史**，所以 brief 必须自包含。一条好的 brief 包含：

- 目标（要达成什么，不是要执行哪些命令）
- 约束（不能改的接口、必须遵守的规范、可用/不可用的依赖）
- 验收标准（怎么算做完；建议写成可执行的检查）
- 已知事实（已经排查出的结论、相关文件路径、报错原文）

反例：「修一下那个 bug」——worker 会瞎猜。

---

## 状态流转

```
queued ──pump──> running ──dispatch_report(done)────> done
                    │  ├──dispatch_report(blocked)──> blocked ──dispatch_message──> running
                    │  ├──dispatch_report(failed)───> failed
                    │  ├──dispatch_cancel───────────> cancelled
                    │  └──回合结束但没显式报告──────> ended（自动把最后一段输出回报给主会话）
                    └──插件/进程重启───────────────> interrupted
```

`done / blocked / failed / cancelled / ended / interrupted` 都不再占用并发位。

**自动回报**：worker 的回合结束时（`agent/status` 变为 `idle`），如果它这一轮没有调用过 `dispatch_report`，
插件会抓它的最后一条 assistant 文本，作为「一轮执行结束（worker 未显式报告）」回报给主会话。
所以即使 worker 忘了报告，主会话也不会永远干等。

---

## 配置

全部可选，写在 bundle 的 `cordis.patch.yml` 里（或安装后由 `plugin_manager` 覆盖）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxWorkers` | `6` | 同时 `running` 的子会话上限；超出的进 `queued`，有空位自动开始 |
| `maxTasksPerSession` | `64` | 每个主会话累计派发上限（防递归派发失控） |
| `inheritWorkingDirectory` | `true` | 子会话继承主会话的工作目录 |
| `permissionPreset` | `''` | 子会话权限预设。后台无人看管时建议 `danger-full-access`，否则可能卡在审批上 |
| `stateDir` | `''` | 任务表落盘目录；空表示 `<DSH_HOME>/dsh-dispatch` |
| `reportOnTurnEnd` | `true` | worker 回合结束自动回报 |
| `maxBriefChars` | `12000` | 任务简报的最大字符数 |

单个任务还可以在 `dispatch_launch` 时覆盖 `cwd` / `model` / `agent_preset` / `permission_preset`。

---

## 落盘与重启

任务表写在 `<DSH_HOME>/dsh-dispatch/tasks.json`（UTF-8，800ms 防抖）。插件重启后读回历史任务；
进程之间没有活的 worker，所以**未结算的任务会被标成 `interrupted`**，不会假装还活着。
子会话本身是普通 DSH Session，会话内容由 DSH 自己持久化，在侧边栏里可以直接打开查看。

---

## 设计要点（为什么是这样）

```
主会话 ──dispatch_launch──► 新建 Session（workspace 可见）
   │                              │
   │                         独立跑一轮/多轮
   │                              │
   │◄──dispatch_report / 回合结束──┘
   │        （插件来源的 user message，主会话空闲时唤醒）
   └── dispatch_message ──► 追问、纠偏、下一步
```

- **会话而非一次性子任务**：worker 是有历史的 Session，所以「追问」不需要重讲一遍背景，
  而且人可以直接在侧边栏打开它、接手它。
- **不阻塞**：派发只登记 + 投递首条消息就返回。等待是被动收到消息，而不是占着 step 等。
- **报告是消息**：投递走 Agent 收件箱（`agent.followup` / `agent.steer`），消息带稳定 id 去重，
  并用插件自己的 `source` 标记（`{kind: 'dsh-dispatch', form: 'relay'}`），所以不会被误认为用户输入。
- **并发靠队列不是拒绝**：超限进 `queued`，`pump()` 在并发位释放时按登记顺序启动。
- **提示词只在用过之后注入**：第一次从某个会话派发时，才给那个会话加一段
  `[dsh-dispatch 工作方式]` 系统提示，告诉模型「派发—收报告—再派发，不要空等」。
  没用过派发的会话完全不受影响。
- **失败要显式**：子会话创建失败 → 任务 `failed` 并回报主会话；worker 被外部关闭 → `interrupted`；
  主会话已不在 → 只落库并记日志，不假装投递成功。

---

## 已知限制

- **没有持久化队列**：插件重启时正在排队的任务不会自动重跑，标成 `interrupted`，由主会话决定要不要重新派发。
- **`maxWorkers` 是软的**：`dispatch_message` 唤醒一个已结算的 worker 会直接把它置为 `running`，可能短暂超过上限。
  这是有意的——人的追问不该排在批量任务后面。
- **`dispatch_wait` 会阻塞当前 step**：只适合「没有它就真的没法继续」。默认提示词也会劝模型别用。
- **worker 的工具集 = 当前 profile 的全局工具**：插件没有为 worker 裁剪工具，它会看到所有工具（包括 `dispatch_launch`）。
  如果你需要更严格的白名单，用 `agent_preset` 给子会话指定一个收紧的 preset。
- **状态文件是单写的**：多个 Harness 实例共用同一个 `DSH_HOME` 时可能互相覆盖，`stateDir` 可以指到别处。

---

## 验证记录

在本机 `desktop` profile 上完成的实测（2026-11-05）：

| 用例 | 结果 |
| --- | --- |
| 安装 bundle、8 个工具注册 | ✅ `dispatch_list` 返回 `version: 0.1.0` |
| 派发 → worker 建文件 → `dispatch_report(done)` → 报告回流主会话 | ✅ |
| worker 回合结束但**不**显式报告 → 自动抓最后输出回报 | ✅ 收到 `PONG-OK` |
| `dispatch_wait` 阻塞至任务结算 | ✅ 返回 `status: done` 与完整摘要 |
| 对已结算任务 `dispatch_message` 追问 → worker 恢复会话继续做 → 再次汇报 | ✅ 文件被追加第二行 |
| `dispatch_cancel` 长任务 | ✅ 状态变 `cancelled`，并发位释放 |
| 插件重启后从 `tasks.json` 恢复历史任务 | ✅ 任务与报告都在 |
| 首次派发后注入 `[dsh-dispatch 工作方式]` 系统提示 | ✅ 出现在该会话的下一轮提示里 |
| 主会话**空闲**时被报告唤醒（派发后直接结束本轮） | ✅ 20 秒后会话自行醒来并收到完整报告 |

八条链路全部实测通过，没有只靠契约推断的部分。最后一条尤其关键：主会话派完任务就可以结束回合，
子会话完成后报告会唤醒它，不需要任何人来催。

---

## 排障

| 现象 | 看哪里 |
| --- | --- |
| 工具没出现 | `plugin_manager(list_plugins)` 里找 `include:dsh-dispatch` 是否 `fiberPhase: active` |
| 任务一直 `running` | 打开子会话 `dispatch-<task_id>` 看它卡在哪一步；必要时 `dispatch_cancel` |
| 任务 `failed` | `dispatch_inspect` 里的 `error` 字段，通常是建会话失败（权限/预设名写错） |
| 收不到报告 | 确认主会话没被删除；插件日志里搜 `dsh-dispatch:` |
| 状态错乱 | 删掉 `<DSH_HOME>/dsh-dispatch/tasks.json` 重启插件即可（只影响历史展示） |

日志前缀统一是 `dsh-dispatch:`。

---

## 目录

```
plugins/dsh-dispatch/
  index.js            # 全部实现（Host 插件，纯 ESM）
  cordis.patch.yml    # 插入插件行 + 默认配置
  package.json        # dsh.bundle.patch 声明
  locale/{zh,en}.json # 插件管理面板里的标题与描述
  icon.svg            # 派发图标
  README.md
```

## License

MIT
