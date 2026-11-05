# 排障

## 先看三处

1. `dispatch_list()`：`version` 确认跑的是哪一版、`running` 与 `max_workers` 确认并发位、`tasks[].status` 看卡在哪。
2. `dispatch_inspect(task_id)`：`error`（启动失败原因）、`cwd`（实际工作目录）、`recent_reports`（worker 自己说了什么）、
   `last_worker_text`（最后一段 assistant 输出）。
3. 宿主日志里搜 `dsh-mini-superagent:`：本插件的所有日志都用这个前缀。

绝大多数问题在 1 和 2 就能定位，日志主要用来区分「投递失败」和「对端不在」。

---

## 日志前缀

统一前缀 `dsh-mini-superagent:`（`src/constants.js` 的 `LOG_PREFIX`）。常见行：

| 日志行（`%s`/`%d` 为占位） | 级别 | 含义 | 下一步 |
| --- | --- | --- | --- |
| `dsh-mini-superagent: 已加载：maxWorkers=6` | info | 插件激活，当前并发上限 | 数字和配置不一致就查 `cordis.patch.yml` |
| `dsh-mini-superagent: 读回 N 个历史任务（<path>）` | info | 启动时读回任务表 | `N=0` 但你派过任务 → 查 `stateDir`/`DSH_HOME` |
| `dsh-mini-superagent: 任务 <id> 已启动，子会话 <sid>` | info | 建会话成功、简报已投递 | — |
| `dsh-mini-superagent: 任务 <id> 启动失败: …` | error | 建会话/投递失败，任务置 `failed` | 看 `dispatch_inspect` 的 `error` |
| `dsh-mini-superagent: 主会话 <id> 已不在运行，报告只落到任务表` | warn | 派发者会话已销毁或未激活 | 重新打开那个会话；或从新会话派发 |
| `dsh-mini-superagent: 报告投递失败 <id>: …` | warn | 收件箱与 `prompt` 双通道都失败 | 看对端会话是否可用；报告仍在任务表里 |
| `dsh-mini-superagent: 收件箱投递失败，改用 prompt: …` | warn | 收件箱抛错，已降级投递 | 报告来源会退化成 `user`，内容不受影响 |
| `dsh-mini-superagent: 无法加载 @deepseek-ai/dsh-llm（将退化投递）: …` | warn | 拿不到 `freezeMessage` | 投递仍能尝试；升级/修复 DSH 安装后重启 |
| `dsh-mini-superagent: 设置权限预设失败: …` | warn | `permissionPresets.set` 失败 | 检查预设名是否存在；任务继续 |
| `dsh-mini-superagent: 无法为该会话注册工作方式提示: …` | warn | 系统提示注入失败 | 不影响派发，只是模型少了行为提示 |
| `dsh-mini-superagent: 状态落盘失败: …` | warn | `tasks.json` 写失败 | 查目录权限/磁盘；内存里的任务仍可用 |
| `dsh-mini-superagent: 读取历史任务失败: …` | warn | 启动读回失败（非 ENOENT） | 文件可能损坏，见「恢复动作」 |
| `dsh-mini-superagent: 取消失败: …` | warn | `agent.cancel` 抛错 | 任务仍会被置 `cancelled`，但 worker 可能继续跑 |

---

## 排障表

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| 模型看不到 `dispatch_*` 工具 | `plugin_manager(list_plugins)` 里 `dsh-mini-superagent` 是否 `fiberPhase: active`；有没有同时装着旧 `dsh-dispatch` | 未激活就重装 bundle；两个都装会因同名工具冲突，移除旧的 |
| 调工具报 `该工具只能在某个会话（Agent）中调用` | 调用上下文里有没有 Agent | 从正常会话里调；脚本/工具测试环境没有 Agent，调不了 |
| `dispatch_launch` 报「达到上限 64」 | `dispatch_list().total` | 取消/收束旧任务，或调大 `maxTasksPerSession` |
| 任务一直 `queued` | `dispatch_list().running` 是否已等于 `max_workers` | 0.2.0 起结算会自动顶上下一个；若队列不动，先看是不是有任务卡在 `running` 占着位 |
| 任务一直 `running` | 打开子会话 `dispatch-<task_id>` 看卡在哪一步；`dispatch_inspect` 的 `last_worker_text` | 等它跑完、`dispatch_message` 追问，或 `dispatch_cancel` |
| 任务 `failed` | `dispatch_inspect().error` | 常见是建会话失败：`workspace/not-found`、`gateway/bad-request`（`cwd`/`workspaceId` 冲突）、`agent_preset` 名字写错 |
| 任务 `blocked` 停着 | `recent_reports` 里 worker 要什么 | 这就是它在等人：用 `dispatch_message` 回答/补凭据 |
| 收到「一轮执行结束（worker 未显式报告）」但没收到 `done` | `reportOnTurnEnd` 是否为 `false`；worker 是否只报了 `progress` | 正常兜底行为；看 `last_worker_text` 判断结果，必要时追问 |
| 状态 `done` 但主会话没收到消息 | 日志 `主会话 … 已不在运行` / `报告投递失败` | 报告只在任务表里；`dispatch_inspect` 可取回，或在新会话重新派发 |
| 任务 `interrupted` | 插件是否重启过；子会话是否被手动关闭/删除 | 新进程里没有活 worker，不假装还在跑；需要就重新 `dispatch_launch` |
| `dispatch_message` 报 `子会话 … 不可用：session/not-found` | 子会话是否被删 | 会话没了就恢复不了；重新派发该任务 |
| `dispatch_message` 报 `session/writer-held` / `session/agent-busy` | 是否多开 Harness 实例、或子会话被 subagent 路由占用 | 关掉其它实例；被占用的会话不能从这边投递 |
| worker 卡在权限审批 | `permissionPreset` 是否为空 | 后台无人看管时设 `danger-full-access`（或给 worker 预授权的 preset），否则它会停在审批上 |
| 子会话工作目录不对 | `dispatch_inspect().cwd` | 检查 `inheritWorkingDirectory`、主会话的 working directory 服务、或显式传 `cwd` |
| `tasks.json` 损坏 / 状态错乱 | 文件能否 JSON 解析 | 备份后删掉，重载插件；只影响历史展示，不影响子会话内容 |
| 多实例状态互相覆盖 | 是否共用同一个 `DSH_HOME` | 给每个实例配不同的 `stateDir` |
| 同一请求报 `message "<id>" is already pending` | 是否重复投递同一条消息 | 消息 id 带随机前缀与序号，正常不会重复；出现说明有其它路径在用同一 id，重启插件即可换前缀 |

---

## 诊断调用

```text
# 版本与并发
dispatch_list()

# 单个任务全貌
dispatch_inspect(task_id="t-m0abc-1")

# 只看未结算
dispatch_list(all=false)

# 等一批任务（少用，会阻塞当前 step）
dispatch_wait(task_ids=["t-m0abc-1","t-m0abc-2"], timeout_ms=120000)
```

```text
# 插件是否激活
plugin_manager(action="list_plugins")

# 旧插件是否还装着（应无结果）
plugin_manager(action="list_bundles")
```

日志检索关键词：`dsh-mini-superagent:`。先 grep 前缀，再按上表匹配具体行。

---

## 恢复动作

| 场景 | 动作 |
| --- | --- |
| 任务跑偏/太久 | `dispatch_cancel(task_id)`；已产生的工作不回滚，自己检查工作目录 |
| 想让它换个方向继续 | `dispatch_message(task_id, "…")`，保留上下文与已有工作 |
| 队列在 0.1.0 上卡住 | 升级到 0.2.0（结算会触发 `pump()`），或再派发一个任务临时触发 |
| 状态文件损坏 | 停插件 → 备份并删除 `<stateDir>/tasks.json` → 重载；历史列表清空，子会话内容不受影响 |
| 从 0.1.0 迁移 | 卸载旧 bundle → 装 `dsh-mini-superagent` → 可选复制旧 `tasks.json` 到新目录；未结算任务会被标 `interrupted` |
| 插件没激活 | 重装 bundle；确认 `inject` 的三个服务（`tools`/`agents`/`sessionController`）都存在 |
| 报告没送到 | 确认主会话还活着；用 `dispatch_inspect` 直接从任务表读报告；必要时 `dispatch_message` 让 worker 再报一次 |

---

## 报障时带上这些

- `dispatch_list()` 的 `version`、`running`、`max_workers`。
- 出问题的 `task_id` 与 `dispatch_inspect` 的完整返回（含 `error`、`cwd`、`recent_reports`）。
- 相关日志行（`dsh-mini-superagent:` 前缀），尤其是 `启动失败` / `报告投递失败` / `主会话 … 已不在运行`。
- DSH 版本与 profile 名；是否多开实例；是否刚从 0.1.0 迁移。

---

## 不要做

- **不要手改 `tasks.json` 当数据库**：它只是展示用快照，写坏了启动会读不回来。
- **不要同时安装 `dsh-dispatch` 和 `dsh-mini-superagent`**：旧插件的 8 个工具名在新插件里都存在，同一全局层重复注册会抛错。
- **不要把 `dispatch_wait` 当 sleep**：它占着当前 step，期间什么也做不了。
- **不要删完子会话还指望任务继续**：`agent/disposed` 会把任务标 `interrupted`，恢复不了就重新派发。
