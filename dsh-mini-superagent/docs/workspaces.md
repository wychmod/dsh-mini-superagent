# 工作区

0.4.0 新增。三件事：**默认工作区**（含固定主会话）、**每天一个【派发】工作区**（子会话住这里）、**按工作区派发与自动归档**。
Host 侧实现全在 `src/workspaces.js`（约 400 行），`dispatch.js` 负责把解析结果落到任务与会话上。

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
| 【派发】工作区 | `<根>/派发/<YYYY-MM-DD>`（本地日期） | `【派发】YYYY-MM-DD` | 第一次**需要兜底**时按需（有目标时不建） |
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

0.8.1 之前，「会话归属」默认放【派发】，即使明确指定了目标工作区也一样 —— 于是每次派发都产生一个新的
`【派发】YYYY-MM-DD` 工作区。现在放置规则改成「**有目标用目标，没有目标才退回日期工作区**」：

```text
dispatch_launch({ workspace: "某项目", ... })
  1. 解析工作区 → target（id/title/path）
  2. 任务 cwd = target.path（目标目录）
  3. 建子会话，会话归属按下面的顺序决定：
       a. 有 target 且注册表里查得到  → 挂到 target 工作区（无条件，不可关闭）
       b. 没有 target / target 已失效 → workerWorkspace 决定：
            day（默认）→ 当天【派发】工作区
            cwd        → 直接挂到任务 cwd
  4. 若 会话所在地 ≠ 任务 cwd：workingDirectory.set(agent, 任务 cwd)
```

- **有目标就一定在目标里**：这是 0.8.1 的核心修复。旧实现把「用不用目标」交给 `workerWorkspace`，
  而它默认 `day`，等于用户的明确选择被默认值压掉。
- **日期工作区是惰性的**：只有真的需要兜底（无目标，或目标已被删除）时才 `mkdir` + 注册。
  有目标的派发从头到尾不碰 `dayWorkspace()`，`provision()`（启动准备）也不建它。
- `workerWorkspace: cwd` 是给「连兜底都不要工作区」的场景留的开关：不建【派发】，会话直接按目录归属。
- `workingDirectory.set` 失败只记 warn：子会话照样跑，只是落在会话自己的工作区目录里（不是目标目录）。

实测：**没有目标**时，子会话挂在当天的【派发】工作区下，而 `Get-Location` 返回目标目录 —— 两者确实是分开的。
（有目标时两者会重合：会话直接住在目标工作区里，`workingDirectory.set` 因此被跳过。）

**没有指定 `workspace` 时**：先看输入框里选的「派发目标」（0.5.0，见 [composer.md](composer.md)）；没有目标时任务 cwd 才用调用者会话的工作目录
（`inheritWorkingDirectory` 或显式 `cwd`）。无论哪种，子会话的归属按上面的 a→b 顺序决定。
也就是说会话归属从 0.3.0 的「按目录反查工作区」改成了「有目标进目标，没目标统一住【派发】」。

### `workerWorkspace` 的语义变更（0.8.0 → 0.8.1）

| 版本 | 取值 | 含义 |
| --- | --- | --- |
| ≤ 0.8.0 | `day`（默认）/ `target` | 决定**用不用**目标工作区。默认 `day` = 一律放【派发】 |
| ≥ 0.8.1 | `day`（默认）/ `cwd` | 只决定**无目标时**的兜底。有目标就用目标，不可关闭 |

旧值 `target` 已废弃：它想表达的「用目标工作区」现在是无条件默认行为，配成 `target` 会被归一成 `day`，
不报错（旧 profile 升级不该让插件起不来）。归一化见 `src/constants.js` 的 `normalizeWorkerWorkspace()`。

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

### 每一级都遵守同一条规矩：命中多个就返回 `undefined`

> **旧文档把第 3 步写成「标题精确匹配」，暗示它是唯一的、没有歧义——那是错的。**
> 精确匹配同样可能命中多个同名工作区，而且它的歧义比包含匹配**更难发现**：查询看起来「就是这个名字」，
> 调用方很容易以为是唯一的。本版未发布起，四级一律按同一条规矩处理：

```text
命中 0 个  → undefined（交给调用方决定要不要新建）
命中 1 个  → 返回它
命中多个   → undefined + warn 出全部候选，绝不静默取第一个
```

实测踩到的场景（2026-11-08 12:10）：仓库根 `D:\idea\dsh-mini-superagent` 与包根
`D:\idea\dsh-mini-superagent\dsh-mini-superagent` 各自登记了一条标题都叫 `dsh-mini-superagent` 的工作区
（宿主按目录 basename 起标题）。用户点「dsh-mini-superagent」时被静默送进**另一个盘上的另一个目录**，
日志里一行线索都没有。

两条配套取舍：

- **候选文案必须带 `path`**：`describeMatches()` 输出 `标题（路径，id=…）`。同名工作区之间 id 对人毫无区分度
  （都是一串 uuid），而 path 一眼能看出「哦，这是包根不是仓库根」。`dispatch_workspaces` 的列表里也是 path 才有用。
- **warn 而不是 throw**：调用方要的是「解析不到」这个统一信号；抛错会改掉 `setTarget()` 的错误信息并牵动 `dispatch.js`。
  `setTarget()` 的 `!workspace` 分支本来就会把现有工作区全列给用户，够用。

关于第 4 步的两条约束（0.7.0 起）：

- 单字符查询（按码点数，代理对算 1 个）**跳过**包含匹配——`'a'` 命中「第一个含 a 的工作区」没有意义；
- 包含匹配**收集全部命中**：0 个 → `undefined`；1 个 → 返回它（`resolve('派发')` 仍命中【派发】工作区）；
  多个 → 记一条 warn 列出全部候选，返回 `undefined`，**不抛错**。

注意「歧义」与「不存在」必须分开处理，否则会凭空建重复目录：`resolveOrCreate` 在真正新建之前
会再判一次歧义（`diagnoseTitleRef`，判定顺序与 `resolve` **完全一致**），命中多个就 warn 并放弃新建——
而不是把歧义当成「不存在」然后 `mkdir` 一个同名新目录。

### `resolveOrCreate()` 的可选 `reason`

返回值是 `{ workspace, created, reason? }`。**`reason` 只在没拿到工作区时出现**，取值两个：

| `reason` | 含义 | 会发生什么 |
| --- | --- | --- |
| `'ambiguous'` | 注册表里有多个候选 | **绝不新建**——那些目录是真的存在的，再建一个同名目录只会把「有两个候选」变成「多出一个重复工作区」 |
| `'not-found'` | 确实不存在 | 按 `create` 决定新建与否 |
| 缺席 | 解析成功 / 新建成功 / **空引用** | 调用方按 `undefined` 判断「拿到了」 |

**空引用不给 `reason`**：调用方没给目标，不是「找不到」。给它贴 `'not-found'` 只会让 `dispatch.js`
为一句空话编出一段错误文案。

**`reason` 是给调用方选文案用的**，不是日志级别。0.8.0 及更早两者都是 `undefined`，`dispatch.js`
只能把所有失败都写成「找不到工作区「…」，且允许新建被关闭」——而这句话在歧义时是**假的**（并没有人关掉新建）。
这才是「用户明明没关新建，却被告诉新建被关了」的成因。

不要给调用方再加第三个布尔值来做这件事：`reason` 就是那个区分位。

---

## 按目录登记工作区时会自动造出标题（历史重复数据的根源）

不指定 `workspace` 的派发，最后可能落到「按任务目录登记一个工作区」这条路上（`SessionGateway.workspaceFor(cwd)`）。
它曾经是重复工作区的来源，两个机制要记住：

- **`workspaceRegistry.create(path)` 不传 `title` 时，宿主用目录 basename 当标题。** 于是「仓库根」与「包根」
  各自登记出一条**同名**工作区，而且它不是一次性脏数据——每次按目录反查登记都会再撞一次。
  现在 `workspaceFor()` **显式传标题**（`registry.create(cwd, this.distinctTitle(cwd, items))`）。
- **`distinctTitle()` 撞名时逐段加长，不改已有工作区的标题。**
  先试末段（`proj`），撞了就加一段（`b/proj`），再撞就继续（`D:/idea/b/proj`）；
  极端情况（不同路径末段全同且都很深）才退回 `（2）` 数字后缀——有后缀总比再产出一条同名工作区好。
  用 `/` 拼接是因为标题是给人读的，`/` 任何平台都不需要转义，且天然表示「父/子」。

三条硬约束（来自实际踩坑）：

1. **人能从标题看出是哪个目录**：用路径末段拼接，而不是 uuid、随机数或自增号；
2. **不与已有标题重复**：大小写不敏感比较；同一目录的既有条目不算撞车（那种情况宿主会复用同一个工作区）；
3. **不改已有工作区的标题**：只决定本次新建那一个。谁先登记谁拿短名，先后顺序变了标题会变，
   但已有条目一个字都不动——改别人的标题等于把用户认过的名字偷偷换掉。

已登记的目录仍然**原样返回**（`resolveByPath(cwd)` 命中就直接返回），不新增条目、不换标题。

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

同时给 `workspace` 和 `cwd` 时，**工作区的路径优先**：任务 `cwd` 取 `target.path`，`input.cwd` 被忽略
（`src/dispatch.js` 的 `cwd: target?.path ?? this.sessions.cwdFor(agent, input.cwd)`）。
要指定别的目录，别用 `workspace`，用 `cwd`。

### 参数优先级：显式参数高于「记住的设置」

`dispatch_launch` 可能同时收到三类「工作目录/工作区」输入：调用方给的 `workspace`、调用方给的 `cwd`、
以及会话里记住的派发目标（输入框选择器 / `@` 写入的 auto 或具体工作区）。判据只有一条：

> **显式参数优先级高于记住的设置。记住的 auto / 目标只是「调用方没指定时的默认」，
> 它没有资格压掉调用方当场给出的参数。**

| 调用方给了什么 | 结果 |
| --- | --- |
| 只给 `cwd`，会话有 auto 或记住的目标 | **`cwd` 胜**：auto 与记住的目标这一轮当没设过 |
| 只给 `cwd`，会话没有目标 | 用 `cwd` |
| 只给 `workspace` | 用 `workspace` |
| `workspace` 与 `cwd` 同时给 | **`workspace` 胜**（已发布语义，不改）——但 `cwd` **不被丢弃** |

`workspace` 与 `cwd` 同时给时，两者的分工是「**会话住在 workspace 里，活干在 cwd 里**」：
`task.cwd` 保留 `cwd`，会话归属给 `workspace`，再由 `start()` 的 `enterDirectory(agent, task.cwd)` 把工作目录切过去。
这样侧边栏归到正确的工作区，读写落在调用方指定的目录。

> 这条是**实际踩过的坑**（2026-11-08 12:10）：主会话目标为 auto 时
> `dispatch_launch({ cwd: 'D:\idea\dsh-mini-superagent' })` 派出的两个子会话分别落到了
> `…\Documents\mini-superagent\派发\2026-11-07` 与 `…\Documents\mini-superagent`，
> 用户给的 `cwd` 从头到尾没生效、`src/` 一个字节没变，现场看起来像「根本没派发」。
> 根因是旧代码 `target?.path ?? cwdFor(agent, cwd)`：只要存在任何 target（包括 auto），
> 显式 `cwd` 一次都没被读到，而且**没有任何提示**。所以现在
> **静默丢弃调用方输入被当作缺陷**——要么让参数生效，要么如实说清它去哪了。

还有一个相关的连带修正：**显式 `cwd` 不做日期兜底**。`placementFor()` 现在在「没有目标」的分支里
先看 `task.cwdExplicit`——调用方明确给了目录，就不该再把它塞进当天【派发】工作区
（那是「没指定」时的兜底，不是「指定了就别处去」）。`workerWorkspace: 'cwd'` 依旧跳过日期兜底，两者并存。

给的是**绝对路径**且没注册时的行为、以及 `create_workspace: false` 的报错文案，见下一节。
报错文案现在按归因分三种（歧义 / 找不到且关了新建 / 找不到但试过新建），不再一律写成「且允许新建被关闭」。

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
| `workerWorkspace` | `day` | **无目标时**的兜底：`day` = 当天【派发】工作区；`cwd` = 直接用任务 cwd。有目标时与它无关 |
| `archiveAfterHours` | `24` | 结束多少小时后归档；`0` 不归档 |
| `archiveSweepMinutes` | `10` | 巡检间隔（分钟）；`0` 不巡检 |
| `leadSessionId` | `mas-lead` | 默认主会话的固定 id |

---

## 限制

- **`workspaceRegistry.create` 要求目录已存在**：插件先 `mkdir -p` 再注册。目录不可写时（权限/盘符不存在）
  默认工作区创建失败，只记日志，派发仍按调用者目录工作；显式指定 `workspace` 的派发会因新建失败而报错。
- **没有 `workspaceRegistry` 时**：默认工作区、【派发】工作区都建不出来，`day` 兜底退化为「会话按任务 cwd 建」；
  显式指定 `workspace` 的派发会报「找不到工作区…，且允许新建被关闭」（实际是注册表不可用，报错文案没区分这一种）。
  注意有目标时的放置只查 `list()`，注册表不可用 = 查不到目标 = 等于没有目标，同样走兜底。
- **标题匹配是模糊的**：先精确、再包含；包含匹配可能命中不想派发的那个工作区。
  而且**精确匹配也可能歧义**（同名不同目录，见上文）——两种歧义都返回 `undefined` 并 warn 出带 `path` 的候选。
  宁可用 id 或绝对路径。
- **同名工作区不合并**：按标题新建时只看目录名，已存在就复用；不同标题可能落到同一个 `safeDirName` 目录，此时复用已有工作区。
- **按目录登记会自动造标题**：`dispatch_launch` 没给 `workspace` 时，子会话可能按任务目录登记出一个新工作区，
  标题由 `distinctTitle()` 从路径末段加长而来（`proj` → `b/proj`），**不改已有工作区的标题**。
  这类自动登记是历史重复数据的根源；见到陌生工作区先用 `dispatch_workspaces` 看它的 `path`。
- **显式 `cwd` 优先于记住的派发目标**：只要调用方给了 `cwd`，会话里的 auto / 目标这一轮不参与
  （判据是「显式参数高于记住的设置」）。`workspace` 与 `cwd` 同时给时 `workspace` 胜，
  但 `cwd` 会被保留为任务的工作目录（会话住在 workspace、活干在 cwd）。
  显式 `cwd` 也不再触发日期工作区兜底。
- **不会自动清理目录**：归档只收起会话，不删 `<workspaceRoot>/派发/<日期>` 下的文件，也不删工作区。
- **`leadSessionId` 改了不会迁移**：旧默认主会话仍在旧工作区，新的一次启动会再建一个。
- **归档失败会一直重试**：没有退避；宿主不支持 `archiveSession` 时每次巡检都会失败一次（日志可见）。

---

## 排障

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| 没有默认工作区 | 日志 `创建默认工作区失败`；`workspaceRoot` 是否可写 | 修目录权限/换 `workspaceRoot`；`provisionDefaultWorkspace` 为 true 才自动建 |
| `dispatch_launch` 报「找不到工作区 … 且允许新建被关闭」 | `create_workspace` 是否为 false；`dispatch_workspaces` 里有没有；日志里有没有「有歧义，命中 N 个」 | 若是**歧义**，那句话是假的（没人关掉新建）：日志里会列出带 `path` 的候选，改用 id 或绝对路径。否则去掉 `create_workspace: false` |
| 两个工作区标题一样 | `dispatch_workspaces` 里它们的 `path` 与 `id` | 本版（未发布）起按目录登记会用 `distinctTitle()` 避开撞名，但**已存在的**同名条目不会被改名（改了等于偷换用户认过的名字）；需要区分就在标题上认 `path` |
| 子会话不在预期的项目工作区 | 目标工作区是否还在注册表里（`dispatch_workspaces`）；`workspace_title` 与 `host_workspace` 分别是什么 | 目标被删了才会退回【派发】；重新指定一个存在的目标。有目标时它一定在目标里，与 `workerWorkspace` 无关 |
| 冒出 `【派发】YYYY-MM-DD` 工作区 | 是否真的没给目标（或目标已被删除） | 这是兜底行为，不是 bug；不想要兜底就设 `workerWorkspace: cwd` |
| 子会话工作目录不对 | 是否同时给了 `workspace` 和 `cwd`；会话里是否记住了派发目标 | 显式 `cwd` 现在**优先于**记住的目标；两者同时给时 `workspace` 胜、`cwd` 仍是任务工作目录。若仍不对，用 `dispatch_inspect().cwd` 看实际值 |
| 看板 `counts.archived` 不涨 | `archiveAfterHours` 是否为 0；任务是否已结算；`updatedAt` 是否够旧 | 调小保留期或手动 `POST /board/archive` |
| 归档一直失败 | 看板任务卡的 `archive_error`；日志 `归档子会话 … 失败` | 宿主是否提供 `workspaceRegistry.archiveSession`；目录/会话是否还在 |
| 默认主会话不见了 | `leadSessionId` 是否被改过；工作区是否被删 | 改回原 id，或让插件重建（随便重启即会创建） |
