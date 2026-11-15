# 14 · 卡片能力的降级与验证策略

> 适用对象：plans/12（派发卡）与 plans/13（报告卡）。
> 这份文件只回答两个问题：**坏了怎么退**、**怎么证明没坏**。
> 它不重复两份 PRD 的功能细节；把它当成上线前后的操作手册。

## 一、四条原则

1. **降级只降自己。** 卡片起不来，看板、输入框控件、工具调用照常。任何一处注册失败都不许拖垮整个 client `apply`。
2. **降级必须可观测。** 用户看不到卡片是正常的（回退到宿主原生样式），但 `selfcheck` 必须能回答「它为什么没出现」。
3. **宁可少显示，不可显示错。** 状态查不到就不显示 chip；实时数据断了就标「可能已过期」，不拿旧状态冒充新状态。
4. **投影可回滚，数据不迁移。** 两张卡都不写会话事件、不改账本；回滚只需换回旧版本或关掉常量，不存在数据修复。

## 二、降级阶梯（L0–L3）

| 层级 | 触发条件 | 派发卡 | 报告卡 | 用户看到什么 |
| --- | --- | --- | --- | --- |
| **L0 全功能** | 宿主能力齐全，接口正常 | 卡片 + 实时状态 | 卡片 + 状态 chip | 设计稿的样子 |
| **L1 数据降级** | `/board` 403/404/超时/空 | 卡片保留，用派发时的初始状态，footer 标「状态可能已过期」 | 卡片保留，不显示 chip | 卡片仍在，只是状态不刷新 |
| **L2 单卡拉闸** | 报告卡注册失败 / spike 未通过 / 常量关闭 | 不受影响 | 不注册节点，回到 `context` 行 + 现有「派发报告」分隔线 | 报告是一条上下文行（现状） |
| **L3 双卡拉闸** | `tool.call.toolview` 不存在 / client 脚本异常 / 版本回滚 | 宿主内置通用工具行 | 同 L2 | 完全是插件 0.9.1 的样子 |

关键点：**L2 和 L3 是两张卡各自独立的**。报告卡失败不许把派发卡一起关掉；派发卡失败也不许影响报告卡。

## 三、逐项降级矩阵

### 3.1 派发卡

| 失败点 | 检测方式 | 降级动作 | 禁止 |
| --- | --- | --- | --- |
| 宿主无 `tool.call.toolview` | `ctx.slots.inject` 的回调始终不执行 | 不注册，走内置通用行 | 不许轮询兜底、不许自绘 DOM |
| `result.content` 不是 JSON | `JSON.parse` 抛错 | 标题 + 行标题照常，状态显示「未知」 | 不许把整卡吞掉 |
| `/board?group=` 返回 403/404 | 响应非 2xx | 用 `launched[].status`；连续 3 次失败标「状态可能已过期」 | 不许把已有行删掉 |
| `/board` 不支持 `group` 参数（旧宿主） | 返回的是全量快照（无过滤） | 前端按 `group` 过滤；若该 group 成员不全，**停止轮询并标「状态为派发时快照」** | 不许用截断后的全量快照冒充实时状态 |
| `group` 缺失（单条派发/旧数据） | 解析不到 | 退化为单行卡，不显示批次信息 | 不许编造 group |
| 任务已归档/退休 | board 行查不到 | 保持最后一次已知状态 | 不许删行、不许标成功 |
| 16 条以上 | 数组长度 | 折叠到 4 行 | 不许撑满屏幕 |
| 客户端常量 `CARD_FEATURES.batch=false` | 启动时读 | 不注册 | — |

### 3.2 报告卡

| 失败点 | 检测方式 | 降级动作 | 禁止 |
| --- | --- | --- | --- |
| 宿主无 `uiConversation` | `ctx.inject` 回调不执行 | 不注册，走现有分隔线 + context 行（L2） | 不许把整个插件 `inject` 加死 |
| `events.register` 抛错（重复/形态不符） | try/catch | warn 一次，撤掉已注册的 renderer | 不许重试到日志刷屏 |
| `conversation.chat.node` 槽不存在 | `slots.inject` 不触发 | 连 Definition 都不注册，消息保持 context 行 | 不许先认领再等渲染器（会黑屏） |
| 文本解析失败 | parser 返回 `unknown` | 原文卡 | 不许丢内容 |
| 文本缺段 | 字段 `undefined` | 空段不占位 | 不许抛错 |
| `/board` 查不到任务 | 响应为空/失败 | 不显示 chip | 不许猜状态 |
| `raw` 超长（>32KB） | 长度检查 | 截断到 32KB + 「内容过长」提示 | 不许正则扫全文导致卡顿 |
| 认领后轮次错位 | G2 spike 硬指标 | 停止报告卡，退回 L2 | 不许「先上再修」 |

> **最容易忽略的一条**：如果先注册 Definition、后等 `conversation.chat.node` 槽，会有一段「消息已被独占认领、但还没有渲染器」的窗口——默认 context 行不再渲染，卡片也没人画，那条报告会**直接消失**。
> 因此顺序固定为：`slots.inject('conversation.chat.node', …)` 的回调触发 → 注册 renderer → 再 `events.register(definition)`。
> 反过来没有兜底可言。

## 四、降级怎么被看见

### 4.1 `client-ready` 上报

现有 `POST /dsh-mini-superagent/board/client-ready` 已经在报 `registered` 槽列表（`client/index.js` 的 `apply` 末尾）。扩展一个字段：

```json
{
  "ok": true,
  "registered": ["sidebar.panellist", "main", "conversation.input.left", "conversation.chat.user.before"],
  "cards": {
    "batch": "on",
    "report": "error:register"
  }
}
```

取值约定：

| 值 | 含义 |
| --- | --- |
| `on` | 注册成功 |
| `error:<stage>` | `slot` / `register` / `parse` |
| 键不存在 | 能力没出现（宿主没提供该槽/服务），或还在加载 |

**键不存在 ≠ 失败**：旧宿主本来就没有这个能力，属于正常降级。`selfCheck` 里按「未提供」展示，不报错。

**上报时机**：`cards` 是异步就绪的（`slots.inject` / `ctx.inject` 的回调可能晚于 `apply`）。
因此 `apply` 末尾的第一次 POST 只报同步槽，**两张卡各自注册成功（或失败）后再补一次 POST**，
用同一路径覆盖 `dispatch.clientReady`。不补这一下，`selfcheck` 里永远是空对象，等于没做可观测。

### 4.2 `GET /board/selfcheck`

现有 `selfCheck()` 已经把 `client.ready` 原样带出（`src/dispatch.js` 的 `selfCheck`）。只需在文档与面板里补一句：

```text
client.ready.cards.batch = on
client.ready.cards.report = error:register
```

排障时先看这两行，再看 `registered`——能区分「模块没进图」「进了图但 apply 抛错」「apply 跑了但卡没注册」。

### 4.3 日志

- 每个降级原因**只 warn 一次**（模块级 `Set` 去重），避免 2 秒轮询把日志刷爆。
- 不上 UI toast：降级后用户看到的是宿主原生样式，不该被打扰。只有「状态可能已过期」这种**影响判断**的降级才在卡内提示。

## 五、四道验证闸门

### G0 · 离线闸门（每次提交 / CI）

跑 `npm run check:dev`，并新增：

| 类型 | 内容 | 证明什么 |
| --- | --- | --- |
| 槽注册 | 两个 `tool.call.toolview` key；`conversation.chat.node` key | 注册参数没写错 |
| 渲染 | `preparing/start/result` 三阶段、4/16 条折叠、启动失败占位 | 组件不崩、文本对 |
| 降级 | 假 ctx **不提供** `tool.call.toolview` / `uiConversation` / `chat.node` 时，`apply` 不抛错，其余槽照常注册 | 降级路径真的存在 |
| 失败注入 | `fetch` 返回 500/403/超时/空 body；`clipboard` 缺失 | 不崩、不误报 |
| parser | 4 种形态 + 6 个畸形 fixture（缺段、空值、CRLF、digest 指针、超长、未知） | 文本契约不漂 |
| 契约漂移 | 读 `client/index.js`，断言六个段名都在 | `voice.js` 改段名时两边同时红 |
| Host | `/board?group=` / `?task=`：截断前过滤、交集、未知值、默认响应逐字段不变 | 没破坏旧接口 |

### G1 · 宿主契约闸门（本机，无浏览器）

`scripts/http-smoke.mjs` 扩三项：

1. `GET /board?group=g-xxx` 返回 200，`tasks` 全是该 group；
2. `GET /board` 不带参数时，与基线 fixture 的字段集合一致；
3. 刷新页面后 `GET /board/selfcheck` 的 `client.ready.cards` 与预期一致。

这一关能抓住「路由加了但客户端没发对参数」「client 没进图」两类问题。

### G2 · 真机 spike（只验报告卡，半天）

**目的**：验证「第三方包用 `exclusive` 认领自己的 `user/message`」在真实 chat 里不破坏任何东西。

做法：注册一个最小 Definition（不做卡片样式，只渲染一行文字），然后：

1. 用 `dispatch_launch` 派一个 10 秒能完成的小任务，等真实报告回流；
2. 再派一次 `dispatch_launch_many`（2 条），等批次汇总；
3. 在 standard 与 compact 两种 transcript 视图下各看一遍。

**通过标准（五条全过才算过）**：

| # | 标准 | 不通过说明什么 |
| --- | --- | --- |
| 1 | 报告只出现一次（不是「卡片 + context 行」两条） | `exclusive` 没生效或认领范围错了 |
| 2 | 轮次分隔线、轮次导航正常 | `location`/`anchorSeq` 给错 |
| 3 | compact 模式下卡片不被折进过程区（或与 context 行行为一致） | `groupTree` 语义不对 |
| 4 | 刷新页面后卡片还在，不重复 | 重放/去重有问题 |
| 5 | 插件热重载一次，不重复注册、不崩 | disposer/duplicate key 处理有问题 |

任一条不过 → **不做报告卡**，停在方案 B（只给 context 行加卡头），不要边修边发。

### G3 · 灰度与回滚

| 手段 | 做法 | 生效成本 |
| --- | --- | --- |
| 版本级回滚 | 装回上一版 npm 包 | 刷新页面 |
| 常量级关闭 | `client/index.js` 顶部 `CARD_FEATURES = { batch: true, report: true }`，改 false 后重新发布/本地替换 | 刷新页面 |
| 单卡关闭 | 只关 `report`，派发卡照常 | 刷新页面 |

**为什么不做成宿主配置开关**：客户端读不到 `cordis.patch.yml` 的 config。要做运行时开关，必须新增一条 host→client 的配置通道（例如 `GET /board/features`），客户端在注册前拉一次。这会给「卡片是否出现」增加一个网络依赖：接口挂了卡片就没了。**P0 不做**，理由写在这里，避免以后有人以为是漏了。

如果将来确实需要，做法固定为：`GET /board/features` + 1.5 秒超时 + 失败默认「开」。超时默认开，是因为「少一张卡」比「多一张卡」更难排查。

## 六、失败注入清单（必须真的跑）

| # | 注入 | 期望 |
| --- | --- | --- |
| 1 | `fetch` 抛网络错误 | 卡片保留，footer 提示，3 次后停止重试 |
| 2 | `fetch` 返回 403 | 不弹错、不重试到死；用初始状态 |
| 3 | `fetch` 返回 200 但 `tasks: []` | 不显示「已完成 0/4」这种假聚合 |
| 4 | `content` 是纯文本不是 JSON | 行标题来自 args，状态「未知」 |
| 5 | 报告文本只有首行 | 卡片只有标题，不崩 |
| 6 | 报告文本是 `unknown` 形态 | 原文卡，内容完整 |
| 7 | `navigator.clipboard` 不存在 | 不渲染复制按钮 |
| 8 | `ctx.slots` 只有 `main` | 看板在，卡片不注册，不抛错 |
| 9 | `ctx.inject` 不存在 | 报告卡跳过，`apply` 完成 |
| 10 | `events.register` 抛错 | warn 一次，撤掉已注册的 renderer，context 行还在 |

第 10 条有个前提：**渲染器先注册、Definition 后注册**（见 §3.2 的提醒）。如果顺序反了，第 10 条的期望应该是「消息不显示」——那是事故，不是降级。

## 七、判定表：看到现象先查哪一层

| 现象 | 最可能在哪 | 下一步 |
| --- | --- | --- |
| 派发后还是通用一行 | 槽没注册 / 宿主版本旧 | 看 `selfcheck.client.ready.registered` 有没有 `tool.call.toolview` |
| 卡片在，状态一直「排队中」 | 轮询没起 / `group` 没解析到 | 看 Network 有没有 `?group=`；看 result JSON |
| 卡片在，状态「可能已过期」 | `/board` 失败 | 看 403/404；确认 `readAllowed` |
| 报告变成一条普通用户消息 | 报告卡 L2 | 看 `cards.report` 的值 |
| 报告直接消失 | **认领了但没渲染器**（严重） | 立刻关 `report` 常量，回滚 |
| 报告出现两次 | `exclusive` 没生效 | 检查 match 返回、宿主版本 |
| 刷新后卡片重复 | 节点 id 不稳定 | 检查 `id` 是否用 message id |

## 八、上线顺序与出口条件

| 阶段 | 内容 | 出口（binary） |
| --- | --- | --- |
| S1 | 派发卡 P0（静态状态，不轮询） | G0 全绿 + 真机看 4/16 条两种批次 |
| S2 | 派发卡 P1（实时轮询 + `/board?group=`） | G0 + G1 全绿；断网注入通过 |
| S3 | 报告卡 spike | G2 五条全过 |
| S4 | 报告卡 P0（卡片 + 兜底） | G0 + G2；旧消息 fixture 通过 |
| S5 | 报告卡 P1（状态 chip + 折叠 + 复制） | G0；真机浅/深色目视 |

**S3 不过就停**，S4/S5 不做；S1/S2 与报告卡无依赖，可独立发布。

## 九、这份策略不解决什么

- **不证明好看**：离线断言只证明结构与文本；间距、对比度、窄屏折行仍需真机目视。
- **不覆盖虚拟滚动**：聊天列表的虚拟化由宿主负责，卡片只保证自身卸载清理；长时间滚动后的内存表现需真机观察。
- **不做多实例协调**：两个宿主共用一个 `stateDir` 时，`/board` 数据可能互相覆盖（既有已知限制），卡片只是显示层，不修这个问题。
- **不做远程 kill switch**：见 §5 G3；要做得先加配置通道。
