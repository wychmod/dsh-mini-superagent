# 工作区

0.4.0 新增。三件事：**默认工作区**（含固定主会话）、**每天一个【派发】工作区**（子会话住这里）、**按工作区派发与自动归档**。
Host 侧实现全在 `src/workspaces.js`（约 160 行），`dispatch.js` 负责把解析结果落到任务与会话上。

---

## 模型

```text
<workspaceRoot>                         工作区根，默认 <用户文档目录>/mini-superagent
  ├─ （工作区自身）                      标题 mini-superagent，默认主会话 mas-lead 住这里
  └─ 派发/
       ├─ 2026-11-04/                    标题【派发】2026-11-04
       └─ 2026-11-05/                    标题【派发】2026-11-05，子会话默认住这里
```

| 概念 | 位置 | 标题 | 谁建 |
| --- | --- | --- | --- |
| 工作区根 | `workspaceRoot` 或 `<homedir>/Documents/mini-superagent` | — | 插件（`mkdir -p`）+ 注册 |
| 默认工作区 | 根目录本身 | `mini-superagent` | 启动时 `provision()` |
| 默认主会话 | 默认工作区内 | 会话 id `mas-lead`，标题「mini-superagent 主会话」 | 启动时 `provision()` |
| 【派发】工作区 | `<根>/派发/<YYYY-MM-DD>`（本地日期） | `【派发】YYYY-MM-DD` | 第一次当天派发时按需 |
| 命名工作区 | `<根>/<safeDirName(标题)>` | 传入的标题 | `create_workspace` 解析不到时 |

`safeDirName` 把 `\ / : * ? " < > |` 与控制字符换成 `-`，去掉开头连续的点，空白压成一个空格，截到 60 字符；
结果为空时用 `dispatch`。只用于目录名，工作区标题保持原样。

0.7.0 起另外处理两类 Windows 特例（它们会让 `mkdir` 失败或建出非法目录）：

- **保留名**：`CON` / `PRN` / `AUX` / `NUL` / `COM1`-`COM9` / `LPT1`-`LPT9`。判定取第一个点之前的部分
  （所以 `CON.txt` 也能抓到），命中时在**第一个点之前**插入 `-`：`CON` → `CON-`、`CON.txt` → `CON-.txt`。
  插在点前而不是末尾，是因为 `CON.txt-` 去掉扩展名之后仍然是 `CON`。
- **尾部点号与空格**：Windows 会静默去掉它们，导致 `abc` 和 `abc.` 撞同一个目录。现在直接删掉，
  且在 60 字符截断**前后各做一次**（截断点可能正好落在点号后）。

---

## 启动准备（幂等）

插件 `apply()` 里在 `restore()` 之后调 `dispatch.provision()`，`provisionDefaultWorkspace` 默认 `true`：

1. `mkdir -p <workspaceRoot>`，然后 `workspaceRegistry.create(root, 'mini-superagent')`。
   宿主按路径去重，重复激活不会建出第二个。
2. `sessionController.inspect(leadSessionId)` 判断默认主会话是否存在；不存在才
   `create({sessionId, workspaceId})`，再 `rename` 成「mini-superagent 主会话」。
3. 任一步失败只记 `dsh-mini-superagent: 创建默认工作区失败（不影响派发）: …`，插件继续启动。

`leadSessionId` 默认 `mas-lead`，改成别的值等于换一个新默认主会话（旧的不会删）。

实测：激活后 `dispatch_workspaces` 返回该工作区且 `sessions: 1`，磁盘上目录已创建。

---

## 会话住在【派发】，活干在目标目录

这是 0.4.0 最需要理解的一条：**会话归属**与**工作目录**是两件事。

```text
dispatch_launch({ workspace: "某项目", ... })
  1. 解析工作区 → target（id/title/path）
  2. 任务 cwd = target.path（目标目录）
  3. 建子会话：
       workerWorkspace: day    → 会话挂到当天【派发】工作区
       workerWorkspace: target → 会话挂到 target 工作区
  4. 若 会话所在地 ≠ 任务 cwd：workingDirectory.set(agent, 任务 cwd)
```

- 默认 `workerWorkspace: day`：侧边栏只在【派发】工作区下看到当天的子会话，不会把每个项目的会话列表塞满。
- `workerWorkspace: target`：子会话直接混在项目工作区里，便于按项目看会话。
- `workingDirectory.set` 失败只记 warn：子会话照样跑，只是落在会话自己的工作区目录里（不是目标目录）。

实测：子会话里 `Get-Location` 返回 `C:\Users\…\Documents\mini-superagent`（目标工作区根），
而它的会话挂在【派发】工作区下 —— 两者确实是分开的。

**没有指定 `workspace` 时**：先看输入框里选的「派发目标」（0.5.0，见 [composer.md](composer.md)）；没有目标时任务 cwd 才用调用者会话的工作目录
（`inheritWorkingDirectory` 或显式 `cwd`）。无论哪种，子会话仍然被放进当天【派发】工作区（`day` 模式）。
也就是说会话归属从 0.3.0 的「按目录反查工作区」改成了「统一住【派发】」。

---

## `workspace` 参数与解析顺序

`dispatch_launch` / `dispatch_launch_many` 的每个任务都接受：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `workspace` | string | — | 工作区 id / 绝对路径 / 标题，三者都可以 |
| `create_workspace` | boolean | `true` | 解析不到时是否新建 |

解析顺序（`WorkspaceGateway.resolve`，只解析不创建）：

1. 工作区 **id**：`workspaceRegistry.get(value)`。
2. **绝对路径**：`resolveByPath(value)`；路径未注册或不存在时返回 `undefined`（不会在这里建）。
3. **标题精确匹配**：`title.toLowerCase() === value.toLowerCase()`。
4. **标题包含匹配**：`title.toLowerCase().includes(value.toLowerCase())`。

关于第 4 步，0.7.0 起有两条约束（都是为了不再「静默挑错一个」）：

- 单字符查询（按码点数，代理对算 1 个）**跳过**包含匹配——`'a'` 命中「第一个含 a 的工作区」没有意义；
- 包含匹配**收集全部命中**：0 个 → `undefined`；1 个 → 返回它（`resolve('派发')` 仍命中【派发】工作区）；
  多个 → 记一条 warn 列出全部候选，返回 `undefined`，**不抛错**。

不抛错是有意的：`dispatch.setTarget` 依赖「找不到返回 undefined」这个契约，抛错会改变它的错误信息
并牵动调用方。返回 undefined 之后，`setTarget` 的 `!workspace` 分支本来就会列出全部工作区，够用。

注意「歧义」与「不存在」必须分开处理，否则会凭空建重复目录：`resolveOrCreate` 在真正新建之前
会再判一次歧义（`fuzzyMatches`），命中多个就 warn 并放弃新建——而不是把歧义当成「不存在」
然后 `mkdir` 一个同名新目录。

解析不到且 `create_workspace !== false` 时：

- 给的是**绝对路径** → 在**该路径**上 `mkdir -p` 并注册，标题取路径最后一段（经 `safeDirName`）。
  **0.7.0 起会检查该路径是否在工作区根之内**：越界时记一条 warn
  （`已在 workspaceRoot 之外创建工作区：<path>`）但**仍然创建**——这是「可审计」优先于「可禁止」的取舍，
  agent 可能真的要在别的盘上开项目，但这件事必须留痕。
- 给的是**名字** → 在 `<workspaceRoot>/<safeDirName(名字)>` 建目录并注册，标题就是这个名字。

解析不到且 `create_workspace === false` → `dispatch_launch` 抛错，错误里带现有工作区清单：

```text
找不到工作区「…」，且允许新建被关闭。现有：<标题>（<路径>）；…
```

同时给 `workspace` 和 `cwd` 时，**工作区的路径优先**：任务 cwd 取 `target.path`，`cwd` 被忽略。
要指定别的目录，别用 `workspace`，用 `cwd`。

---

## `dispatch_workspaces`（只读）

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

- `sessions` 是该工作区下的会话数（`sessionIds.length`），不是任务数。
- 工作区注册表不可用时返回空数组（`count: 0`），不会抛错。
- 它不需要 Agent，任何会话都能调。

---

## 自动归档

子会话结束后，会话列表会越积越长。归档把「已结算且超过保留期」的子会话从会话列表里收起来，**不删任务、不删报告**。

### 规则

- 巡检间隔 `archiveSweepMinutes`（默认 10 分钟），首次延迟 20 秒；`0` 表示不巡检。
- 保留期 `archiveAfterHours`（默认 24 小时）；`0` 表示不自动归档（巡检也不会启动）。
- 候选：任务已结算（`done / blocked / failed / cancelled / ended / interrupted`）、没有 `archivedAt`、
  `updatedAt` 早于 `now - archiveAfterHours`。
- 动作：`workspaceRegistry.archiveSession(workerSessionId, { stopActivity: true })`。
- 成功：任务上记 `archivedAt`，清掉 `archiveError`。
- 失败：记 `archiveError` 并 warn，下一次巡检会重试（没有退避、没有次数上限）。

### 手动触发

看板接口 `POST /dsh-mini-superagent/board/archive` 立即跑一次巡检（不需要 body，仍需同源）：

```json
{ "ok": true, "scanned": 4, "archived": 4, "failed": 0, "counts": { "…": "…", "archived": 4 } }
```

- `scanned` 是本次符合条件的任务数；全部已归档后再调返回 `scanned: 0`。
- 即使 `archiveSweepMinutes` 或 `archiveAfterHours` 为 0，这个手动接口也会按当前 `archiveAfterHours` 计算候选
  （`0` 时 cutoff = 现在，所有已结算任务都算过期）。

### 归档之后

- 会话从侧边栏的会话列表收起；任务表、看板、报告都不受影响，`counts.archived` 与任务卡 `archived_at` 会变。
- 已取消的任务也能归档。
- 归档不是任务状态：`status` 不变，只是多了一个 `archivedAt` 标记。
- 归档失败只在看板快照的 `archive_error` 里出现；`dispatch_list` / `dispatch_inspect` 的卡片不带这个字段。

实测：把 `archiveAfterHours` 临时改成 `0.001`、`archiveSweepMinutes` 改成 `0.05`，约 20 秒后 4 个任务全部归档成功
（`counts.archived: 4`）；随后配置已改回 24h / 10min。

---

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `workspaceRoot` | `''` | 工作区根；空表示 `<用户文档目录>/mini-superagent` |
| `provisionDefaultWorkspace` | `true` | 启动时创建默认工作区与主会话；失败只记日志 |
| `workerWorkspace` | `day` | 子会话放哪：`day` = 当天【派发】；`target` = 任务的目标工作区 |
| `archiveAfterHours` | `24` | 结束多少小时后归档；`0` 不归档 |
| `archiveSweepMinutes` | `10` | 巡检间隔（分钟）；`0` 不巡检 |
| `leadSessionId` | `mas-lead` | 默认主会话的固定 id |

---

## 限制

- **`workspaceRegistry.create` 要求目录已存在**：插件先 `mkdir -p` 再注册。目录不可写时（权限/盘符不存在）
  默认工作区创建失败，只记日志，派发仍按调用者目录工作；显式指定 `workspace` 的派发会因新建失败而报错。
- **没有 `workspaceRegistry` 时**：默认工作区、【派发】工作区都建不出来，`day` 模式退化为「会话按任务 cwd 建」；
  显式指定 `workspace` 的派发会报「找不到工作区…，且允许新建被关闭」（实际是注册表不可用，报错文案没区分这一种）。
- **标题匹配是模糊的**：先精确、再包含；包含匹配可能命中不想派发的那个工作区。宁可用 id 或绝对路径。
- **同名工作区不合并**：按标题新建时只看目录名，已存在就复用；不同标题可能落到同一个 `safeDirName` 目录，此时复用已有工作区。
- **不会自动清理目录**：归档只收起会话，不删 `<workspaceRoot>/派发/<日期>` 下的文件，也不删工作区。
- **`leadSessionId` 改了不会迁移**：旧默认主会话仍在旧工作区，新的一次启动会再建一个。
- **归档失败会一直重试**：没有退避；宿主不支持 `archiveSession` 时每次巡检都会失败一次（日志可见）。

---

## 排障

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| 没有默认工作区 | 日志 `创建默认工作区失败`；`workspaceRoot` 是否可写 | 修目录权限/换 `workspaceRoot`；`provisionDefaultWorkspace` 为 true 才自动建 |
| `dispatch_launch` 报「找不到工作区 … 且允许新建被关闭」 | `create_workspace` 是否为 false；`dispatch_workspaces` 里有没有 | 去掉 `create_workspace: false`，或用 id/绝对路径 |
| 子会话不在预期的项目工作区 | `workerWorkspace` | 要按项目看会话就设 `target`；默认 `day` 是有意把会话收进【派发】 |
| 子会话工作目录不对 | 是否同时给了 `workspace` 和 `cwd` | 两者同时给时 workspace 路径优先；改用 `cwd` |
| 看板 `counts.archived` 不涨 | `archiveAfterHours` 是否为 0；任务是否已结算；`updatedAt` 是否够旧 | 调小保留期或手动 `POST /board/archive` |
| 归档一直失败 | 看板任务卡的 `archive_error`；日志 `归档子会话 … 失败` | 宿主是否提供 `workspaceRegistry.archiveSession`；目录/会话是否还在 |
| 默认主会话不见了 | `leadSessionId` 是否被改过；工作区是否被删 | 改回原 id，或让插件重建（随便重启即会创建） |
