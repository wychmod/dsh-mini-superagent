# 输入框：派发目标与 `@` 工作区

0.5.0 的界面增量，两个入口改同一件事：**下一次 `dispatch_launch` 派到哪个工作区**。
Host 侧实现是 `POST /dsh-mini-superagent/board/target` 与会话目标表；Client 侧是输入框左侧的选择器和 `@` 候选。

---

## 先分清两个概念

| 概念 | 谁决定 | 能不能改 |
| --- | --- | --- |
| **会话的工作区**（会话挂在哪个 workspace） | 建会话时定；子会话默认挂当天【派发】 | 不能。DSH 里会话的工作区建完不可迁移 |
| **派发目标工作区**（下一次 `dispatch_launch` 往哪派） | 输入框选择器 / `@` 选择 / `dispatch_launch` 的 `workspace` 参数 | 能，随时改 |

所以选择器写的是**派发目标**，不是「把这个会话搬到某个工作区」。它只影响之后从**这个主会话**派出的任务：

- `dispatch_launch` 显式给了 `workspace` → 用显式值，选择器不生效；
- 没给 `workspace` → 用该会话的派发目标；
- 目标失效（工作区被删/路径没了）→ 只记 warn，退回调用者目录，**不会**凭选择器新建目录。

派发目标的存储：

- Host 内存 `Dispatch.targets: Map<sessionId, {workspace_id, title, path}>`；
- 落盘 `tasks.json` 的 `targets`（状态文件 `version: 3`）；
- HTTP 接口：`POST /dsh-mini-superagent/board/target`，body `{session_id, workspace}`，`workspace` 为空串表示清除；
  成功 `{ok:true, target}`，缺 `session_id` → 400，解析失败 → 409（错误文本带现有工作区候选）。

快照里对应字段（`GET /dsh-mini-superagent/board`）：

```json
{
  "targets": {
    "session-…": { "workspace_id": "ws-…", "title": "项目 A", "path": "D:\\proj\\a" }
  }
}
```

没有目标的会话不出现在 `targets` 里。

---

## 选择器：`conversation.input.left`

| 项 | 值 |
| --- | --- |
| 槽 | `conversation.input.left`（list / session） |
| 注册 | `id: "dsh-mini-superagent/target"`、`order: 60`、`label: "派发目标"` |
| 可见条件 | 有活跃会话（槽注入的 `sessionId` 非空）才渲染；空白/hero 会话看不到 |
| 尺寸 | 高 28px、`flex: none`、`max-width: min(260px, 45cqw)`、左右 padding 8px、圆角 `--dsw-radius-sm` |
| 文案 | 有目标 `派发 → <标题>`；无目标 `派发 → 跟随会话`；`title` 提示里带工作区路径 |
| 图标 | 左侧圆点：有目标实心并取品牌色，无目标空心 |
| 交互 | 点击开下拉；`aria-haspopup="menu"`、`aria-expanded`、`aria-label="派发目标工作区"` |

### 下拉

- 用 `createPortal` 挂到 `document.body`，`position: fixed`，`z-index: 1100`。
- 宽度 `max(220, min(触发宽, 340))`；最大高度 `min(60vh, 420px)`，内部滚动。
- **优先向上展开**（输入框通常在屏幕底部）；上方放不下才向下。左右夹在视口内（左右各留 8px）。
- 窗口 `resize` / 滚动会重新定位。
- 行为：点外部关闭；`Esc` 关闭并把焦点还给触发器。
- 项：`跟随会话目录`（清除目标）、分隔线、全部工作区（标题 + 路径，当前项带 ✓）、分隔线、`刷新列表`。
- 空列表显示「没有可用的工作区」；加载中显示「读取中…」；设置失败把 Host 的中文原因显示在下拉里（下拉不关闭）。

### 数据与刷新

- 挂载时 `GET` 一次快照（拿 `targets[sessionId]` 与 `workspaces`）；每次打开下拉再取一次。
- **不轮询**。快照层有 10 秒缓存，`@` 候选频繁查询时复用它；控件打开下拉时强制取新值。
- `@` 选中后会广播（`targetBus`），选择器随之重取，两个入口不会各说各话。
- 快照取不到：控件禁用，`title` 显示「看板服务不可用」；`createPortal` 不可用：禁用并提示「弹层不可用」。

---

## `@` 工作区

注册在输入框触发源服务上，与官方 `@reference` 并存（同一个 `@` 可以有多个 source）：

```js
ctx.get('inputTriggers').registerSource({
  trigger: '@',
  name: 'workspace',
  order: 40,
  showGroupTitle: false,
  candidates(session, { query, signal }) { … },   // 行：{name, description, section, value}
  onPick(pick) { … },                             // 返回 {insert:{source,ref,label,clipboardText}}
  codec: { serialize(ref), clipboardText(ref) },
})
```

| 项 | 值 |
| --- | --- |
| 触发 | `@` |
| 名称 | `workspace` |
| 顺序 | `order: 40`（官方 `@reference` 也在同一触发下，按各自 order 排序） |
| 候选 | 第一条固定是「自动选择」，其后是工作区标题/路径/id 包含查询串（大小写不敏感）；行给 `name`、`description`（路径）、`section`、`value: workspace_id` |
| 数据 | 看板快照的 `workspaces`，10 秒缓存 |
| 选中 | **同时**做两件事：`POST /target` 设为该会话的派发目标；往草稿插入 chip |

### 「自动选择」这条候选

候选列表**顶部常驻**一条，不用手动翻列表：

| 字段 | 值 |
| --- | --- |
| `section` | `自动选择` |
| `auto` | `true`（客户端内部标记，不参与渲染） |
| `name` | 命中时 `自动：<工作区标题>`；没有匹配时 `自动：没有匹配的工作区` |
| `description` | `按关键词自动匹配一个工作区` |
| `value` | 命中的 `workspace_id`；无匹配时是空串 |

**打分规则**（只看用户看得见的东西，不做语义猜测——猜错比不猜更烦人）：

| 命中方式 | 分值 |
| --- | --- |
| 标题完全相等 | 100 |
| 标题包含关键词 | 40 |
| 目录名完全相等 | 30 |
| 目录名包含关键词 | 15 |
| 路径任意位置包含 | 5 |

多个关键词（空格/逗号分隔）累加计分；同分按标题字典序。**没有关键词时**所有工作区同分（1 分），
即退化为按标题排序取第一——所以 `@` 之后直接回车也能选到一个，不会空转。

实测几种典型输入：

```
""             -> 【派发】2026-11-06(1) | mini-superagent(1) | sableos(1)
"sable"        -> sableos(40)
"派发"          -> 【派发】2026-11-06(40)
"mini"         -> mini-superagent(40) | 【派发】2026-11-06(5)   ← 后者只靠路径弱命中
"2026-11-06"   -> 【派发】2026-11-06(40)
"不存在"        -> （无匹配，value 为空）
```

无匹配时这条仍然显示（点下去不会静默什么都不做），只是 `value` 为空、`onPick` 返回 `undefined`。

### chip 与模型可见文本

- 插入对象：`{source:'workspace', ref:<workspace_id>, label:<标题>, clipboardText:'@<标题>'}`；
- `codec.serialize(ref)` → `<workspace id="ws-2" title="副工作区"/>`；
- `codec.clipboardText(ref)` → `@副工作区`；
- **`appearance` 故意省略**：宿主只认 `session` / `file` / `folder` 三种外观，传别的会让整条草稿在恢复时被清空。
  所以 chip 是裸的默认外观，插件不能自定义图标或颜色。
- 因为必须走 `insert`（没有「只插入纯文本」的返回形态），**`@中文名` 这种纯文本不可行**：
  选中一定产生 chip，模型看到的是 `<workspace …/>` 而不是 `@中文名`。

### 降级

- `inputTriggers` 服务不存在，或没有 `registerSource`：`@` 不出现，看板与选择器照常工作（注册被 `try/catch` 包住）。
- `@` 选中时设置目标失败：下拉菜单已经关闭，没有地方挂错误，只 `console.warn`；选择器下次取数会显示真实目标。
- 候选查询失败（快照取不到）：返回空列表，不抛错。

---

## 与 `dispatch_launch` 的关系

```
输入框选择器 / @  ──POST /board/target──▶  Dispatch.targets[sessionId]
                                                   │
dispatch_launch(没有 workspace 参数) ──────────────┘
                                                   ▼
                                      resolve 目标工作区 → 任务 cwd
                                                   │
                                        失效 → warn + 调用者目录
```

- 显式 `workspace` 永远优先；选择器只是「默认值」。
- 目标工作区决定任务 `cwd` 与子会话的工作目录；子会话的**会话归属**仍按 `workerWorkspace`（默认当天【派发】）。
- 选择器不改变已经派出的任务。

---

## 未验证（重要）

界面侧**一次都没在真浏览器里跑过**——客户端模块要页面重载才挂载，本轮只做了代码审查与 Host 接口/单测。因此不能断言：

- 控件在真实工具行里的对齐、换行与截断（28px 高、45cqw 上限只是 CSS 声明）；
- 弹层向上/向下翻转与左右边缘夹取的实际观感；
- `@` 候选与官方 `@reference` 混排时的分组、排序与视觉一致性；
- chip 在页面刷新后能否从草稿恢复（依赖宿主的草稿持久化）；
- `openSession` 成功后视图是否真的切过去（成功路径没有截图证据）；
- 深色/浅色主题下的对比度；
- `not-listed` 的真实错误码与错误文本（目前只按通用错误展示）。

接口层（`/target`、`targets` 快照、`/archive`）有单测覆盖，但**单测不等于界面可用**。装完/升级后需要刷新浏览器的 GUI 页面，`@` 与控件才会挂载。

---

## 限制

- 选择器只在有活跃会话时出现；空白会话/首页看不到。
- 派发目标只影响这个主会话之后的任务，不影响其它会话，也不能改会话归属。
- 目标失效时静默退回调用者目录（只记 warn），不会提示用户重新选。
- `@` 的 `appearance` 是闭集，chip 不能定制外观；纯文本 `@名称` 不可行。
- 快照 10 秒缓存意味着 `@` 候选可能短暂看到旧工作区列表；选择器打开下拉会强制刷新。
- 选择器与 `@` 都依赖看板 HTTP 接口；接口不可用时选择器禁用、`@` 候选为空，派发本身不受影响。
