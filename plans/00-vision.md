# 00 · 项目愿景与可行性总览

> 五条需求的判定、依据与分期。逐条调研证据在 [01-composer.md](01-composer.md)（输入框与 @）和
> [02-workspace-ui.md](02-workspace-ui.md)（侧边栏与跳转）。本文只做合并与决策，不重复证据。

## 一页结论

| # | 需求 | 判定 | 关键约束 | 现状 |
|---|---|---|---|---|
| 1 | 开子会话说任务，完成后收集信息反馈 | **已实现** | 报告回流靠消息投递，主会话空闲会被唤醒 | 0.1–0.3 有，缺「批量汇总」 |
| 2 | 装上就有默认工作区 + 默认主会话 | **可行** | `workspaceRegistry.create` 要求目录已存在；必须是幂等的 | 未做 |
| 3 | 输入框选工作区（像选模型）+ @ 选 | **可行，但语义要改** | 会话的工作区不可变 → 选择器只能表示「这次派到哪」 | 未做 |
| 4 | 自动识别工作区、必要时新建 | **可行，主要靠工具+提示词** | 需要给 agent 一个列工作区的工具；新建要有根目录策略 | 未做 |
| 5 | 界面看分派情况 | **已有初版，待验收** | 面板要在浏览器里实测；跳会话依赖 `uiWorkspace.openSession` | 0.3.0 有，未目视 |

**一句话**：五条都能做，没有一条卡在 DSH 能力缺失上。真正要你拍板的是四个**产品语义**问题（下一节），
不是技术可行性。

---

## 需要你先拍板的四件事

### A. 「工作区」到底表示什么

DSH 里一个会话绑定一个工作区，而且**建会话之后不可迁移**（全网关没有 session→workspace 的迁移 API）。
所以「在会话里选工作区」不可能等于「让这个会话换到别的工作区」。

我的建议：把选择器定义成「**这次派发到哪**」，也就是 `dispatch_launch` 的默认目标工作区。
会话本身仍属于它原来的工作区。这样语义干净，也不和官方 UI 打架。

> 如果你要的是「让当前会话变成另一个工作区的会话」，那是另一个功能，需要对 DSH 上游提需求。

### B. worker 会话要不要隔离

现在子会话是**普通会话**，建在主会话所在的工作区里。跑十几轮之后侧边栏会多出一串 `dispatch-t-xxx`。

三个选项：

| 方案 | 效果 | 代价 |
|---|---|---|
| 混在一起（现状） | 最少改动，子会话就地可见 | 侧边栏会被撑满 |
| 建一个「mini-superagent 工作区」专门放 worker | 主工作区干净，看板按工作区分组更清楚 | 子会话不在你项目的目录树里，跨工作区操作 |
| 完成后自动 `archiveSession` | 侧边栏只留活跃的 | 归档后要找历史得去归档里翻 |

我倾向**第二个**，和需求 2 的默认工作区天然合流：默认工作区既是主会话的家，也是 worker 的窝。

### C. 默认工作区放哪

`workspaceRegistry.create(path)` 要求目录**已存在**（`realpath` 规范化的绝对路径；相对路径/不存在/非目录直接拒）。
所以插件得自己 `mkdir` 再注册。

建议：默认 `<用户文档目录>/mini-superagent`，可配置。不要放 `.dsh` 里——那是配置目录，用户不会去那儿放代码。

### D. 「自动新建工作区」的边界

「没明确指定也能识别」有三种可能，强度递增：

1. **只在已有工作区里挑**（按名字/路径模糊匹配），挑不到就沿用当前会话的工作区 —— 最保守
2. 挑不到时，**在默认根目录下新建**一个（目录名由任务标题生成）—— 推荐
3. 允许 agent 用任意绝对路径新建 —— 风险最大，等于给 agent 开权限在磁盘任意位置建目录

建议 **2**，并且把「新建」记进任务和看板，让人能看见它替你建了什么。

---

## 逐条详解

### 1 · 子会话执行任务，完成后把结果收回来

**已实现**（0.1–0.3）：`dispatch_launch` 建独立 Session → worker 干活 → `dispatch_report` 或回合结束自动回报 →
报告作为插件来源的消息回流，主会话空闲时被唤醒。

**唯一缺口是「收」的那一下太碎**：派 5 个任务，就收到 5 条独立消息，主会话要自己合并。

建议补一个小功能：`dispatch_launch_many` 派出去的批次带一个 `group` 标记，全部结算后由插件生成**一条汇总报告**
（每个任务的状态 + 摘要首行 + 失败原因），再投给主会话。这样人看到的是「这一批的结论」，不是五条流水。

### 2 · 装好就有默认工作区 + 默认主会话

**可行**。宿主侧 API 都确认了：

- `workspaceRegistry.create(path, title?)`：目录必须已存在；**同一路径重复调用返回已有实体**（天然幂等）；
  新建的工作区插在列表最前。
- `workspaceRegistry.initializeDefault(resolveDirectory)`：会自动递归建目录，但只在「注册表和历史都为空」时生效，
  之后不再创建 —— 不能当我们的默认工作区用，得自己调 `create`。
- `sessionController.create({sessionId, workspaceId, agentPreset?})`：建会话并绑工作区（现有代码已在用）。
- `Workspace.attachSession / insertSessionBefore / setTitle / status()`：建完可以收拾。

实现要点：

1. 首次激活时 `mkdir -p <默认根>/mini-superagent` → `workspaceRegistry.create(dir, 'mini-superagent')`。
2. 建一个默认主会话（固定 id 或存进状态文件），绑到该工作区。
3. **幂等**：每次启动先读状态文件里的 sessionId，确认它还活着（`sessionController.inspect`），不在才新建。
   否则每重启一次就多一个空会话。
4. 失败要静默降级：建不出来只记日志，不能让插件起不来（用户可能在只读盘/无权限目录）。

**风险**：`sessionController.create` 的文档写着「reusing the named blank Session while it is reusable」——
空白会话可能被「新建会话」流程复用掉。默认主会话必须在建好后立刻投递一条开场消息，把它从 blank 状态带出来，
否则可能被当成草稿会话。这条要实测。

### 3 · 输入框里选工作区（像选模型）+ @ 选

**技术可行，三个坑要认。**

能做的：

- 控件挂 `conversation.input.left`（空置的 list 槽，会话作用域，自带 `useWorkspaces` 等标准 hook）。
  **工作区列表不用走 Remote 也不用我们的 HTTP 路由**，`useWorkspaces(s => s.items)` 直接给
  `[{workspaceId, title, path}]`。
- 下拉抄官方 `ModelSelect`：`conversation.input.overlay` 槽 + `createPortal(document.body)` + `fixed` 定位 +
  外部 `mousedown` 关闭。控件高度跟工具行 28px 对齐，不要 `flex:1`。
- `@` 能扩展：`ctx.get('inputTriggers').registerSource({trigger:'@', name:'workspace', ...})`，
  和官方 `@reference` 并存、按 source 分组。
- 选中值传给模型的唯一官方钩子是 `codec.serialize(ref)`，在发送时替换 chip 占位文本；
  也可以用 `inputActions.setDraft({text, references})` 直接写结构化草稿。

做不成的：

- **chip 外观锁死**：草稿节点的 `appearance` 是 zod 闭集 `session|file|folder`，传自定义值会让整条草稿在读回时被清空。
  只能用 `undefined` 或 `session`，想要自定义图标不行。
- **`@中文名` 纯文本自动变 chip 不可行**：装饰扫描正则是 `[\w-]+`，JS 的 `\w` 不含中文。
  必须走「选择器插入 reference 节点」的路，不能靠用户手打。
- **不能替换模型选择器**：`conversation.input.model` 是 single 槽且已被 `ModelSelect` 占用，注册即替换官方控件。
- **空白会话（hero）里看不到**：`conversation.input.left` 只在有活跃会话时渲染；hero 的工作区选择器是官方 single 槽，别去覆盖。
- 语音输入展开时工具行整体隐藏，我们的控件会跟着消失 —— 可接受，但要写进说明。

### 4 · 自动识别工作区、必要时新建

**主要不是 UI 问题，是工具与提示词设计。**

`dispatch_launch` 现在只有 `cwd`。建议改成 `workspace` 参数，接受三种写法，按顺序解析：

1. 工作区 id（`w-xxx`）
2. 绝对路径 → `workspaceRegistry.resolveByPath`（不创建）
3. 标题（大小写不敏感匹配 `list()`）
4. 都匹配不上 → 如果调用方给了 `create: true`，在默认根下 `mkdir` + `create`；否则报错并返回候选列表

同时加一个 `dispatch_workspaces` 工具（只读），让 agent 能看到有哪些工作区、各自的 path 与会话数。
主会话的系统提示里加一句：优先复用已存在的工作区，只有任务明显属于一个新项目时才新建。

**「识别」的准确含义**：模糊匹配交给 agent（它有任务的完整语义），插件只负责按 id/路径/标题解析和创建。
插件自己不该猜任务属于哪个工作区——它看不到 brief 的语义。

### 5 · 看分派情况的界面

**已有初版**（0.3.0 的看板：并发、过滤、进度、取消、重试），但有三件事没闭环：

1. **面板本身还没在浏览器里验证过**（客户端模块要页面加载后才挂载，而我们改过 `dsh.client`，reboot 才能重扫）。
2. **按工作区分组**：快照里还没有 `workspaceId`，要补一层数据。
3. **点任务行跳到子会话**：可行，走 client service
   `ctx.get('uiWorkspace').openSession(id | {parentSessionId, childSessionId, mode})`。
   **注意**：`dsh-better-sidebar` 的注释说 0.1.6 起旧的 `ISessions.open/openSubagent` 已被移除，照抄旧写法会**静默无效**。
   **前提**：子会话必须在 `sessions.list` 里，否则 `openSession` 会 not-listed、界面不动。这条没实测过，是下一步最高优先级验证项。

顺带一个不可行的：**工作区行上没有挂载点**，`sidebar.workspaces` 是 single 槽被官方 WorkspaceBrowser 独占，
所以「在每个工作区行加一个派发按钮」做不了。能做的是 `sidebar.footer.action` 放全局入口，
以及会话行上的 `sidebar.session.row.leading / .hover / .workspace.session.row.action / .session.menu.item`。

---

## 不建议做的

| 想法 | 为什么不做 |
|---|---|
| 让当前会话切换工作区 | 网关没有迁移 API，只能新建会话 |
| 工作区行加插件按钮 | 该槽没有子槽，只能整体替换官方 UI |
| 靠 `@中文名` 纯文本触发 | 装饰正则不认中文，只能走选择器插入节点 |
| 自己造 HTTP 代理去建工作区 | 客户端已有 Remote；绕过 client model 收不到状态广播，界面不会自动刷新 |
| 用 `initializeDefault` 做默认工作区 | 它只在注册表和历史都为空时生效，控制不了 |

---

## 分期建议

### P0 · 先闭环已有东西（不写新功能）
1. 重启 DSH，确认看板图标真的出现、面板能开（0.3.0 的验收）
2. 验证子会话是否在 `sessions.list` 里 → 决定「跳会话」能不能做
3. 补上这批调研文档到仓库

### P1 · 需求 2 + 4（宿主侧，改动集中在一个文件）
- 默认工作区与默认主会话（幂等、失败降级）
- `dispatch_launch` 的 `workspace` 参数 + 解析与新建
- `dispatch_workspaces` 工具
- 看板快照补 `workspaceId`，按工作区分组
- 工作量：中等，主要是幂等与边界

### P2 · 需求 3（界面，风险最高）
- `conversation.input.left` 的工作区控件 + overlay 下拉
- `@` 触发源（`inputTriggers.registerSource`）+ `codec.serialize`
- 先只做「选目标工作区」，不做「切换会话工作区」
- 工作量：大，需要真机反复调样式与交互

### P3 · 需求 1 的汇总与看板跳转
- 批次汇总报告
- 看板点行跳子会话（依赖 P0 的第 2 条）

---

## 动手前必须确认的三件事

1. **看板面板在浏览器里到底能不能渲染** —— 决定 P2/P3 是不是建在沙子上。
2. **子会话在不在 `sessions.list`** —— 决定「跳会话」有没有意义。
3. **默认主会话会不会被「新建会话」流程当成空白草稿复用** —— 决定需求 2 的实现方式。

这三条都是「跑一次就能知道」的，不需要再读源码。
