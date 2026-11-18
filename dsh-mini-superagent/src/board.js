/**
 * 任务看板的 Host 半边：两个只读快照 + 若干写操作，走普通 HTTP 路由。
 *
 * 为什么不用 Remote/RPC：看板是同源页面里的普通 fetch，走 HTTP 最直接，
 * 也不需要为一个只读面板去定义一套跨进程契约。
 *
 * 路由（prefix 注册，挂在 /dsh-mini-superagent/board 下）：
 *   GET  /dsh-mini-superagent/board           -> BoardSnapshot
 *   GET  /dsh-mini-superagent/board/retired   -> 已退休任务（只读，见 plans/07 P0-5）
 *   GET  /dsh-mini-superagent/board/stats     -> 全量聚合（只读，见 plans/09 P0）
 *   GET  /dsh-mini-superagent/board/analytics-> 分析看板聚合（只读，见 docs/board.md）
 *   POST /dsh-mini-superagent/board/cancel    {"task_id"} -> {ok, task}
 *   POST /dsh-mini-superagent/board/retry     {"task_id"} -> {ok, task}
 */
import { BOARD_ALLOWED_HOSTS, BOARD_BASE, BOARD_HEADER, ERROR_CODES, LOG_PREFIX, SETTLED, VERSION } from './constants.js'
import { analyticsSnapshot, degradedAnalytics } from './analytics.js'
import { boardStats, degradedStats } from './stats.js'

/**
 * 路由前缀的唯一事实源在 constants.js。浏览器半边 `client/index.js` 无法
 * import（plain ModuleLoader），仍保留一份字面量；两份是否一致由
 * `test/contract-consistency.test.js` 在每次 `npm test` 时钉住。
 */
const BASE = BOARD_BASE

/** 单次响应最多带多少条任务。 */
const MAX_TASKS = 200

/**
 * `/board` 只读过滤参数的取值上限（plans/12 §8.2：trim 后截断到 64 字符）。
 *
 * 为什么给上限而不是「拒绝超长」：这两个参数是**精确匹配**的 id，不是搜索框，
 * 超长的值不可能命中任何任务，截断后去比一次即可得出「空结果」；而返回 400 会让
 * 一个只读查询变成需要客户端处理的错误分支。截断是幂等的（长度只会变短），
 * 所以不存在「同一个参数两次请求结果不同」的风险。
 */
const MAX_FILTER_CHARS = 64

/**
 * 单次响应最多带多少条退休记录。
 *
 * 与 MAX_TASKS 取同一个数量级：退休**不参与指标**，面板只用它回答「它什么时候、
 * 为什么消失的」，所以它是一份「够用就行」的答案，不是可翻页的审计导出。
 * 超过上限时用 dropped 明说少给了多少，而不是悄悄截断。
 */
const MAX_RETIRED = 200

/** 快照里 worker 最后输出的预览长度。 */
const PREVIEW_CHARS = 500

/**
 * `client-ready` 允许上报的卡名（plans/14 §4.1 只定义了这两张卡）。
 *
 * 为什么要白名单**键**：这个字段会原样进 `GET /selfcheck`，而 body 是浏览器
 * 发来的、客户端可控的数据。若原样收下 `Object.keys(body.cards)`，等于给页面开了
 * 一个往宿主诊断快照里塞任意键的通道（`hack: 'x'` 会一路出现在 selfcheck 里，
 * 看起来还像一条真的能力结论）。只认这两张卡，排障时读到的每个键都对应一张
 * 真实存在的卡。
 */
const CLIENT_CARD_KEYS = new Set(['batch', 'report'])

/**
 * `error:<stage>` 里允许的阶段（plans/14 §4.1 的三态）。
 *
 * 为什么要白名单**值**：值与「下一步动作」是一一对应的——`error:register` 要改参数、
 * `error:slot` 要核对宿主版本、`error:parse` 是内容契约问题。放任意串进来
 * （`error:evil`、`unknown:xxx`）只会让排障的人去查一个不存在的阶段；而**不报错**
 * 地丢弃它，又保证异常客户端不会把一次自报变成一个 500（自报失败不该反过来干扰页面）。
 */
const CLIENT_CARD_STAGES = new Set(['slot', 'register', 'parse'])

/**
 * 单个卡状态串的长度上限。
 *
 * 正常值只有 `on` 或 `error:register` 这类短串；给上限是为了不把异常客户端的长串
 * 留在内存与自检响应里（超长值截断后必然不等于合法值，随之被下面丢掉）。
 */
const MAX_CARD_STATE_CHARS = 64

/** 排序权重：进行中的排最前，其余按更新时间倒序。 */
const WEIGHT = { running: 0, queued: 1 }

/**
 * 报告/简报里可能被账本裁掉的那几段，顺序就是展示面的顺序。
 *
 * 单独列出来的原因：`has_truncated` 只回答「有没有内容被裁」，而看板行展示的是
 * `summary`。真实账本里被裁的**全部**是 `detail`（入库上限 4000，见 `constants.js`
 * 的 `maxReportDetailChars`），摘要（上限 6000）一条都没被裁过——只给布尔时
 * 客户端只能一律写「摘要已截断」，于是每一行都在说一件没发生的事。字段名跟着布尔
 * 一起投影出去，客户端才有条件按段说人话（`summary` / `headline` / `detail` /
 * `brief`，`brief` 指落盘时被裁过的任务简报）。
 */
const TRUNCATED_FIELDS = ['summary', 'headline', 'detail', 'brief']

/**
 * 一条任务「哪几段被账本裁过」（去重、按 `TRUNCATED_FIELDS` 的展示顺序）。
 *
 * 为什么不复用 `has_truncated` 的写法直接 `some(entry.truncated)`：那个真值判断
 * 分不出「摘要有 6000 字被裁」和「详情有 4013 字被裁」，而这两件事对看板行来说
 * 完全不同——摘要正是那一行展示的内容，详情只在 `dispatch_inspect` 里看得到。
 *
 * 形状兼容：账本里 `entry.truncated` 是 `{summary?: 原长, detail?: 原长, headline?: 原长}`
 * （见 `Dispatch.#admitEntry()`）。手工改过的旧数据也可能只留一个真值；字段未知时
 * 按 `summary` 计——客户端缺字段时本来也画成「摘要已截断」，不能因为形状不标准
 * 就把标记整个丢掉。
 *
 * @param {object} task
 * @returns {string[]} 例如 `['detail']`；没有截断时是空数组
 */
function truncatedFieldsOf(task) {
  const hit = new Set()
  const reports = Array.isArray(task.reports) ? task.reports : []
  for (const entry of reports) {
    const mark = entry?.truncated
    if (mark && typeof mark === 'object') {
      for (const key of Object.keys(mark)) if (TRUNCATED_FIELDS.includes(key)) hit.add(key)
    } else if (mark) {
      hit.add('summary')
    }
  }
  // `briefTruncated` 是落盘时对超长简报的截断（记的是原始长度），与单条报告无关。
  if (task.briefTruncated) hit.add('brief')
  return TRUNCATED_FIELDS.filter(field => hit.has(field))
}

/**
 * 一条任务的「耗时」毫秒数。
 *
 * 已结算的任务必须量到**结算那一刻**，不能量到「现在」：后者会让一个
 * 26 小时前就 done 的任务一直显示「26 时 0 分」并继续增长，看起来像还在跑
 * （看板对 running 还会本地叠加走表，所以这个基准必须是能停住的时刻）。
 *
 * 结算时间优先取权威的 `settledAt`（plans/09 P0），旧数据回退 `updatedAt`。
 * 为什么要有权威字段：`updatedAt` 会被报告、追问、归档巡检、后台巡检刷新，
 * 于是「done 在这一刻」这个事实在事后还会变——耗时与按天趋势跟着一起变。
 * 回退是**兼容**而不是等价：真实的结算时刻没人记过，只能用最后更新时刻近似。
 *
 * 顺带说明：`settle()` 与 `transition()` 都会写 `updatedAt`，而 `archivedAt`
 * 要等归档巡检才补，所以两者都不能单独当结算时间用。
 * 结算时刻不可能早于开始时刻，但仍做一次夹紧，避免时钟回拨变成负数。
 *
 * 已结算却没有可解析的时间（只可能来自损坏或历史数据）时返回 0 表示「不知道」，
 * **不能**退回 Date.now() —— 那等于把「耗时一直增长」这个缺陷在退化数据上又请回来。
 */
function elapsedOf(task, started) {
  if (!Number.isFinite(started)) return 0
  if (!SETTLED.has(task.status)) return Math.max(0, Date.now() - started)
  const settled = task.settledAt
    ? Date.parse(task.settledAt)
    : (task.updatedAt ? Date.parse(task.updatedAt) : NaN)
  if (!Number.isFinite(settled)) return 0
  return Math.max(0, settled - started)
}

/**
 * 一条任务的计划进度（PRD-01 §4.3）：**只算三个短标量**，不回步骤数组。
 *
 * 为什么不上完整步骤：看板是 2 秒轮询的全量快照，200 条任务 × 12 步会把每次
 * 轮询的 payload 放大一个量级；而任务行只需要 `2/5`、抽屉只需要「当前步骤」那句。
 * 想看全量计划的走 `dispatch_inspect`（账本里有 `task.plan`）。
 *
 * `plan_current` 的取法：优先 `doing`（worker 明确说的「正在做」），没有就退到
 * 第一条 `pending`（下一个要做的），全 done 时是空串——**不编一句「已完成」**，
 * 那个结论由任务状态表达，不由计划表达。
 *
 * @param {object} task
 * @returns {{total: number, done: number, current: string}|undefined} 没有计划时 undefined
 */
function planOf(task) {
  const steps = Array.isArray(task.plan)
    ? task.plan.filter(step => step && typeof step.text === 'string' && step.text)
    : []
  if (!steps.length) return undefined
  const done = steps.filter(step => step.status === 'done').length
  const doing = steps.find(step => step.status === 'doing')
  const pending = steps.find(step => step.status === 'pending')
  return { total: steps.length, done, current: (doing ?? pending)?.text ?? '' }
}

/** 一条任务在看板上的形状。字段刻意拍平，客户端不需要理解内部结构。 */
export function boardTask(task) {
  const reports = Array.isArray(task.reports) ? task.reports : []
  const last = reports.length ? reports.at(-1) : undefined
  const started = task.startedAt ? Date.parse(task.startedAt) : NaN
  /**
   * 计划标量的**显示优先级由宿主先做一层**（PRD-01 §4.3「终态 > 计划 > 报告数」）：
   * 已结算的任务不再下发 `plan_*`。这样即使将来有第二个客户端，也不会因为忘了
   * 判状态而给一条 done 的任务画「2/5」——「明明完了还停在第 2 步」是最容易
   * 被当成 bug 报的形态。计划本身仍留在账本里，`dispatch_inspect` 查得到。
   */
  const plan = SETTLED.has(task.status) ? undefined : planOf(task)
  /**
   * 「有内容被截过」+「截的是哪几段」。
   *
   * 只给布尔，**不把正文搬上快照**：快照是每轮轮询都要重传的东西，把 6000 字
   * 的报告塞进来等于用带宽换一个小标记；要看正文的人走 `dispatch_inspect`。
   * 两个来源都要看：`truncated` 是报告条目入库时留的截断长度（P0-3），
   * `briefTruncated` 是落盘时对超长简报的截断标记——后者坏了会让
   * 「retry 重投的是残版简报」再次无声发生。
   *
   * `truncated_fields` 是这次补的第二个字段：光有布尔时，详情被裁（4013 > 4000）
   * 与摘要被裁（6000+）长得一模一样，客户端只能把两者都写成「摘要已截断」。
   * 字段名只有几个短串（`['detail']`），比正文便宜得多，却能让提示说真话。
   */
  const truncatedFields = truncatedFieldsOf(task)
  const hasTruncated = truncatedFields.length > 0
  /**
   * 「待读」的超时改写（P0-4）：`sweepMemory()` 把过期的 `inputPendingAt` 换成
   * `inputUnknownAt`，语义从「已投递未读」降级成「不知道读没读到」。
   *
   * 两个字段互斥：**unknown 必须以 pending 缺席的方式出现**，否则看板会同时显示
   * 「还在等它读」（pending 行）和「不知道」（unknown 行）——而前者是个永远不会
   * 结束的状态，比不显示更误导人。判定照抄 `card()`：read 之后两者都不显。
   */
  const inputPendingAt = task.inputPendingAt && !task.inputReadAt && !task.inputUnknownAt
    ? task.inputPendingAt
    : undefined
  const inputUnknownAt = task.inputUnknownAt && !task.inputReadAt ? task.inputUnknownAt : undefined
  return {
    task_id: task.id,
    title: task.title,
    status: task.status,
    attempt: task.attempt ?? 1,
    parent_session_id: task.parentSessionId,
    worker_session_id: task.workerSessionId,
    /**
     * 复用血缘（plans/08 阶段 2）：这条任务是「接续自哪条」。
     *
     * 三个字段都可选、都只在真的复用时出现——独立任务不会凭空多出
     * `handoff_from: null` 之类需要调用方判空的噪音。`handoff_source` 是审计值
     * （`agent` = 调用方给了理由 / `explicit` = 只给了 handoff_from），
     * `handoff_reason` 是调用方的一句话解释（≤200 字）。**它们只用于展示与审计，
     * 不参与任何判定或打分**；插件不会根据它们自动决定接不接上一轮。
     */
    ...(task.parentTaskId ? { handoff_from: task.parentTaskId } : {}),
    ...(task.handoffSource ? { handoff_source: task.handoffSource } : {}),
    ...(task.handoffReason ? { handoff_reason: task.handoffReason } : {}),
    cwd: task.cwd,
    workspace_id: task.workspaceId ?? null,
    workspace_title: task.workspaceTitle ?? null,
    // 子会话实际挂在哪个工作区（没指定目标时就是当天的【派发】工作区）。
    // 与 workspace_title（派发目标）不是一回事，看板显示这个才有归属感。
    host_workspace_id: task.hostWorkspaceId ?? null,
    host_workspace_title: task.hostWorkspaceTitle ?? null,
    archived_at: task.archivedAt ?? null,
    ...(task.group ? { group: task.group } : {}),
    /**
     * 依赖（PRD-02 §4.5）：五个短字段，都是标量或短 id 数组。
     *
     * 体积约束（看板是 2 秒轮询的全量快照）：`depends_on` 最多 8 个 id（与
     * `DEFAULTS.maxDependsOn` 一致，这里再 slice 一次只是防手工改账本把快照撑大），
     * 其余四个都是单个短串。**不搬前置任务的标题/状态**——客户端从同一份快照里
     * 按 id 查，搬过来会让同一事实在 payload 里出现两次。
     *
     * `depends_on` 恒定给数组（没有依赖就是 `[]`），客户端不必判属性存在；
     * 其余四个是「出过这件事才有」的可选键，与 `frozen_at` 等同风格。
     * `blocked_*` 是派生值（只描述此刻），`cancel_reason` / `error_code` 是终态事实。
     */
    depends_on: Array.isArray(task.dependsOn) ? task.dependsOn.slice(0, 8) : [],
    ...(task.blockedBy ? { blocked_by: task.blockedBy } : {}),
    ...(task.blockedReason ? { blocked_reason: task.blockedReason } : {}),
    ...(task.cancelReason ? { cancel_reason: task.cancelReason } : {}),
    ...(task.errorCode ? { error_code: task.errorCode } : {}),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    turn_started_at: task.turnStartedAt,
    /**
     * 权威结算时刻与它的**时间基准**（plans/09 P0）。
     *
     * 两个字段必须一起给：旧数据（0.8.x 及更早落盘的）没有 `settledAt`，这里
     * 回退成 `updated_at`，但 `time_basis` 会写成 `updatedAt-fallback`。只给时间
     * 不给基准，客户端会把「最后更新时刻」当成「结算时刻」渲染，而前者会被报告、
     * 追问、归档刷新——同一个数字在两次轮询之间会变，谁也查不出为什么。
     *
     * 未结算的任务不输出这两个键（它们没有结算时刻），与 frozen_at 等可选字段同风格。
     */
    ...(SETTLED.has(task.status)
      ? {
          settled_at: task.settledAt ?? task.updatedAt ?? null,
          time_basis: task.settledAt ? 'settledAt' : 'updatedAt-fallback',
        }
      : {}),
    elapsed_ms: elapsedOf(task, started),
    report_count: reports.length,
    // 计划（PRD-01 §4.3）：只有未结算且真有计划时才出现这三个短标量；见 `planOf()`。
    ...(plan ? { plan_total: plan.total, plan_done: plan.done, plan_current: plan.current } : {}),
    last_report: last ? { at: last.at, status: last.status, summary: last.summary } : null,
    last_text_preview: typeof task.lastText === 'string' ? task.lastText.slice(0, PREVIEW_CHARS) : '',
    // 追问的投递阶段：pending = 进了收件箱但 worker 还没读；read = 已经读进上下文。
    // pending 与 unknown 互斥（见上面的注释），所以两者都用可选字段的写法。
    ...(inputPendingAt ? { input_pending_at: inputPendingAt } : {}),
    input_read_at: task.inputReadAt ?? null,
    // P0-4：待读超时后被降级成「不知道」。只在真的发生过时出现。
    ...(inputUnknownAt ? { input_unknown_at: inputUnknownAt } : {}),
    retry_at: task.retryAt ?? null,
    /**
     * 重试健康度（A6 / PRD §10.4）：`retryCounts` 在 `Dispatch` 里，`boardTask(task)`
     * 拿不到，所以由 Host 侧把算好的快照挂在 `task.retryHealth` 上，这里只做投影
     * ——签名保持 `boardTask(task)` 不变（PRD 的推荐做法）。
     *
     * 只在**真的续跑过**时出现（`{attempts, since?, last_at?, last_error?}`）。
     * 与投递重试（`task.delivery` → `report_delivery`）是两件事：前者是模型/连接
     * 瞬时故障后的续跑次数，后者是「报告有没有送到主会话」。字段名不共享，
     * 界面上也不并排，否则「重试 2 次」会被读成「报告没送到」（PRD §10.8）。
     */
    ...(task.retryHealth ? { retry_health: task.retryHealth } : {}),
    // 每任务的独立目录与准备时间（配了 taskDirRoot 才有）。
    task_dir: task.taskDir ?? null,
    prepare_at: task.prepareAt ?? null,
    // 后台活：回合结束了但 job/subagent 还在跑，任务仍占着并发位。
    background: task.background ?? null,
    background_killed: task.backgroundKilled ?? null,
    /**
     * 归档 = 只读冻结（P0-4），冻结时刻必须投影出去。
     *
     * 少了它，看板无法区分「已归档冻结」与普通已结算行——冻结本来就是为了
     * 「这条不会再变了」，不显示等于让用户以为它还能被改。与 `retired_at`
     * 是两件事：归档的任务仍在表里（可取消归档），退休的已经移出账本。
     */
    ...(task.frozenAt ? { frozen_at: task.frozenAt } : {}),
    // 报告被截断过：给布尔做小标记（**不搬全文**），再给被裁的段名让提示说真话。
    ...(hasTruncated ? { has_truncated: true, truncated_fields: truncatedFields } : {}),
    ...(task.error ? { error: String(task.error) } : {}),
    ...(task.archiveError ? { archive_error: String(task.archiveError) } : {}),
  }
}

/**
 * 记忆治理的统计块（见 plans/07 §六 P0-1 / P0-5）。
 *
 * 必须**防御**三层：
 * - `memoryStats()` 可能不存在（旧版宿主 / headless）；
 * - 可能抛错；
 * - 可能是 **async** 的（host 实际就是异步：它要读活表与留痕两份）。
 *
 * 同步快照拿不到 thenable 的值，这时宁可给 null（客户端按「窗口未知 / 宿主未提供」
 * 降级），也**不能**把 Promise 塞进 JSON —— JSON.stringify(Promise) 会得到 `{}`，
 * 客户端会把它读成「宿主给了一个空块」，比 null 更难排查。
 * 需要真实值的调用方（HTTP 路由）走 resolveMemory() 先把值 await 出来再传进来。
 */
function memoryOf(dispatch, provided) {
  if (provided !== undefined) return provided && typeof provided === 'object' ? provided : null
  try {
    if (typeof dispatch.memoryStats !== 'function') return null
    const stats = dispatch.memoryStats()
    if (stats && typeof stats.then === 'function') return null       // 同步快照里的 async 宿主
    return stats && typeof stats === 'object' ? stats : null
  } catch {
    return null
  }
}

/**
 * 取一份**已解析**的记忆统计：同步函数直接用，thenable 在这里 await 掉。
 * 失败一律返回 null，让看板继续可用 —— 指标口径坏掉不该让人看不见任务。
 * @returns {Promise<object|null>}
 */
async function resolveMemory(dispatch) {
  try {
    if (typeof dispatch.memoryStats !== 'function') return null
    const value = dispatch.memoryStats()
    const stats = value && typeof value.then === 'function' ? await value : value
    return stats && typeof stats === 'object' ? stats : null
  } catch {
    return null
  }
}

/**
 * 归档巡检的判定小时数（`dispatch.config.archiveAfterHours`）。
 *
 * 为什么要把配置投影进快照：客户端要在「立即归档超时会话」的悬浮提示里写清
 * 「多久没更新算超时」。把 168 写死在客户端，配置一改（或插件把巡检关掉 = 0）
 * 提示就变成假话——用户拿着一个和实际行为不符的数字去理解归档。
 *
 * `<= 0` / 非数字 = 不自动归档（与 `archiveStale()` 同一套约定，见 `constants.js`
 * 的 `archiveAfterHours`）。这种情况返回 0，客户端据此退化成不带数字的说法，
 * 而不是显示「超过 0 小时」。
 *
 * @param {object} dispatch
 * @returns {number} 小时数；不自动归档时为 0
 */
function archiveAfterHoursOf(dispatch) {
  const raw = Number(dispatch && dispatch.config ? dispatch.config.archiveAfterHours : 0)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * 归一一个过滤参数：`trim` → 截到 64 字符 → 空串表示「没给」。
 *
 * 为什么空串必须等于「没给」：`?group=` 与不带参数是浏览器/拼接代码很容易产生的
 * 两种写法，如果空串被当成「匹配 group === '' 的任务」，同一次点击会因为多了一个
 * `=` 而返回空列表；而真正不带 group 的任务本来就**没有** `group` 键（见
 * `boardTask` 里 `task.group` 的可选展开），所以「匹配空 group」这件事没有意义。
 */
function normalizeFilterValue(raw) {
  return String(raw ?? '').trim().slice(0, MAX_FILTER_CHARS)
}

/**
 * 从查询串取出卡片专用的两个只读过滤参数（plans/12 §8.2）。
 *
 * 只认 `group` 与 `task` 两个**精确匹配**的参数，**刻意不**做模糊/前缀/排序/分页：
 * 这是一个「卡片取自己那一小片数据」的窄口，不是通用查询接口（§13 R3）。
 * 每个参数各自独立归一：空串 drop 掉，避免把「没给」与「给了空值」混成一种语义。
 *
 * @param {URLSearchParams|undefined} searchParams
 * @returns {{group?: string, task?: string}} 没有有效参数时是空对象
 */
export function boardFilterOf(searchParams) {
  const get = value => (typeof searchParams?.get === 'function' ? searchParams.get(value) : null)
  const group = normalizeFilterValue(get('group'))
  const task = normalizeFilterValue(get('task'))
  return {
    ...(group ? { group } : {}),
    ...(task ? { task } : {}),
  }
}

/**
 * 这条任务是否命中过滤条件（两个参数同时给就是交集）。
 * @param {object} task
 * @param {{group?: string, task?: string}|undefined} filter
 */
function matchesFilter(task, filter) {
  if (!filter) return true
  if (filter.group && task.group !== filter.group) return false
  if (filter.task && String(task.id) !== filter.task) return false
  return true
}

/**
 * 整块看板的数据。
 * @param {object} dispatch
 * @param {object|null} [memory] 已解析的 memoryStats；省略时尝试同步取（可能得 null）
 * @param {{group?: string, task?: string}} [filter] 卡片专用的只读过滤（省略 = 全量，与旧响应逐字段一致）
 */
export function boardSnapshot(dispatch, memory, filter) {
  const all = [...dispatch.table.tasks.values()]
  const counts = { total: all.length, running: 0, queued: 0, done: 0, blocked: 0, failed: 0, cancelled: 0, ended: 0, interrupted: 0, archived: 0, retired: 0 }
  for (const task of all) {
    if (task.status in counts) counts[task.status] += 1
    if (task.archivedAt) counts.archived += 1
  }
  // 退休数是「历史上已被移出账本」的条数，它**不在** tasks 里，
  // 所以只能从 memoryStats 拿；拿不到就是 0（= 这块信息宿主没提供）。
  const stats = memoryOf(dispatch, memory)
  counts.retired = Number.isFinite(stats?.retired?.count) ? stats.retired.count : 0
  /**
   * 过滤必须在 `slice(0, MAX_TASKS)` **之前**（plans/12 §8.2「过滤时机」）。
   *
   * 这是整块改动里唯一一处顺序有讲究的地方，理由要写下来：`all` 是**全量**活表
   * （可能上千条），截断只保留展示面能看的 200 条。如果先 `slice` 再按 `group`
   * 过滤，那么「批次成员排在第 201 名之后」时卡片拿到的是空列表——而任务明明
   * 在账本里、明明还在跑，卡片却会显示「一条都没有」，且这个现象只在实例里任务
   * 累积到 200+ 之后才出现（小实例上测不出来，上线很久后才偶发）。
   *
   * 过滤后再截断则是「先选出用户真正要的那一小片，再按同一套展示上限截断」：
   * 单组的成员数远小于 200，所以正常批次永远不会被截；即便真有人造出 200+ 成员的
   * 组，`truncated` 仍会按**过滤后**的条数如实说出来（下面的 `scoped` 变量）。
   *
   * 注意 `counts` **不受过滤影响**：它仍是全量计数（plans/12 §8.2 的 `counts` 一行）。
   * 改成局部计数会让面板顶部与卡片的数字对不上，而面板展示的本来就是整实例口径。
   */
  const scoped = filter ? all.filter(task => matchesFilter(task, filter)) : all
  const tasks = scoped
    .sort((a, b) => (WEIGHT[a.status] ?? 2) - (WEIGHT[b.status] ?? 2)
      || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_TASKS)
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    concurrency: { running: counts.running, queued: counts.queued, max: dispatch.table.maxWorkers },
    /*
     * 归档巡检的判定小时数。客户端拿它拼「立即归档超时会话」的悬浮提示，
     * 所以这里必须是**真实配置**，不能留一个写死的数字（见 `archiveAfterHoursOf`）。
     * 0 = 当前不自动归档，客户端退化成不带数字的说法。
     */
    archive_after_hours: archiveAfterHoursOf(dispatch),
    counts,
    // 任务数超过展示上限时，明确告诉看板「列表被截断了」。
    // 否则「总计 500 / 列表 200」看起来像数据丢了，用户会去翻根本不存在的条目。
    // 注意 total 取截断前的 all.length（counts.total 是同一份数，这里独立算一份，
    // 免得将来 counts 的定义变了，截断比例跟着漂）。
    //
    // `truncated` 的口径跟着**过滤后**的条数走（`scoped`），与 `tasks` 取自同一份：
    // 它的语义是「你这次请求的列表被截了多少」，不是「实例全量被截了多少」。
    // 不带参数时 `scoped === all`，输出与旧版本逐字节一致。
    truncated: scoped.length > MAX_TASKS ? { shown: MAX_TASKS, total: scoped.length } : null,
    // 工作区列表给看板做「按工作区分组 / 切工作区」用；注册表不可用时为空数组。
    workspaces: (dispatch.workspaces?.list?.() ?? []).map(item => ({ id: item.id, title: item.title, path: item.path })),
    // 每个主会话当前选的「派发目标工作区」；没选的不出现。
    targets: Object.fromEntries(dispatch.targets ?? []),
    tasks: tasks.map(boardTask),
    /**
     * 记忆治理统计：窗口口径、账本容量、退休数。
     * 显式放 null 而不是省略字段：客户端要能区分「宿主没提供」与「这是旧版宿主」，
     * 两者都按「窗口未知」降级，但排障时看得出差别。
     */
    memory: stats,
  }
}

/**
 * 已退休任务的一条记录。
 *
 * 字段刻意与 boardTask 用同一套命名（snake_case + `_at` 后缀），
 * 客户端不必为第二种形状再写一遍取值逻辑。
 */
function retiredEntry(record) {
  const id = String(record?.id ?? '')
  return {
    task_id: id,
    title: typeof record?.title === 'string' ? record.title : '',
    status: typeof record?.status === 'string' ? record.status : '',
    retired_at: record?.retiredAt ?? null,
    retired_reason: record?.retiredReason ?? null,
    archived_at: record?.archivedAt ?? null,
    updated_at: record?.updatedAt ?? null,
    // 退休记录的正文只留摘要：账本封顶的目的是「写放大有上界」，
    // 如果退休时把 6000 字正文整段搬到另一个 Map 里，只是换了个地方存。
    summary: typeof record?.summary === 'string' ? record.summary : '',
  }
}

/**
 * 退休视图的数据。
 *
 * 三条约定（都是「不要让用户以为数据丢了」）：
 * - 倒序：最近的退休最该被看到，它最可能是用户刚发现"任务不见了"的那条；
 * - `dropped`：超过 MAX_RETIRED 时明说少给了多少，而不是悄悄截断；
 * - `dispatch.retired` 不存在（旧版宿主 / headless）时返回空表而非报错 ——
 *   这是一个只读诊断视图，宿主没这个能力就该显示「没有」，不该 500。
 */
export function retiredSnapshot(dispatch) {
  const ledger = dispatch.retired
  const entries = ledger instanceof Map ? [...ledger.values()] : []
  const sorted = entries
    .slice()
    .sort((a, b) => String(b?.retiredAt ?? '').localeCompare(String(a?.retiredAt ?? '')))
  const shown = sorted.slice(0, MAX_RETIRED)
  return {
    ok: true,
    count: sorted.length,
    dropped: Math.max(0, sorted.length - shown.length),
    entries: shown.map(retiredEntry),
  }
}

/** 按 HTTP 状态把错误响应映射到错误码闭集，客户端不用再猜中文措辞。 */
function errorCodeFor(status) {
  if (status === 400) return ERROR_CODES.BAD_ARGS
  if (status === 403) return ERROR_CODES.FORBIDDEN
  if (status === 404) return ERROR_CODES.NOT_FOUND
  if (status === 409) return ERROR_CODES.CONFLICT
  return ERROR_CODES.INTERNAL
}

/** 写 JSON 响应。 */
function send(res, status, body) {
  const payload = JSON.stringify(
    body?.ok === false && !body.code ? { ...body, code: errorCodeFor(status) } : body,
  )
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 把 `client-ready` body 里的 `cards` 归一成一份「只剩可信结论」的小对象。
 *
 * 三件事同时成立才落键（plans/14 §4.1）：
 * 1. **键在白名单里**（`batch` / `report`）——否则丢弃，见 CLIENT_CARD_KEYS；
 * 2. **值是 `on` 或 `error:<白名单阶段>`**——否则丢弃，见 CLIENT_CARD_STAGES；
 * 3. **值先按长度截断**，避免异常客户端塞长串。
 *
 * 为什么**没有合法键返回 undefined**（调用方据此**不写** `cards` 字段）：
 * 「键不存在」是三种含义之一，且是最重要的那一条——它表示客户端根本没给出这张卡的
 * 结论（旧客户端、宿主没提供那条槽），属**正常降级**，不是失败。若这里回一个
 * `{}`，`client.ready.cards` 就会永远存在，自检页再也分不清「没上报」与「上报了但
 * 两张卡都没结论」。
 *
 * 为什么整段不抛错：这是浏览器自报的存活信号，一条畸形 body 不该让端点 500——
 * 那会让页面进入「自报失败 → 重试 → 再失败」的循环，反而掩盖了它要报的问题。
 *
 * @param {unknown} raw body.cards 原值（任意形状）
 * @returns {Record<string, string> | undefined} 合法结论；一个都没有时 undefined
 */
function clientCardsOf(raw) {
  // 字符串/数组/数字/布尔都不是「卡片结论表」；`typeof null === 'object'` 单独挡掉。
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const cards = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!CLIENT_CARD_KEYS.has(key)) continue
    if (typeof value !== 'string') continue
    // 先截断再看合法性：截断本身是幂等的，合法值（都很短）不受影响。
    const state = value.slice(0, MAX_CARD_STATE_CHARS)
    if (state === 'on') { cards[key] = state; continue }
    // `error:<stage>`：前缀必须是字面量 `error:`，stage 必须在白名单里。
    // 用 `startsWith` + 精确比较而不是正则，是为了让非法值**安静地丢弃**而不是抛错。
    if (!state.startsWith('error:')) continue
    if (!CLIENT_CARD_STAGES.has(state.slice('error:'.length))) continue
    cards[key] = state
  }
  return Object.keys(cards).length ? cards : undefined
}

/**
 * 读请求体并解析 JSON；超限或非法直接拒绝。
 *
 * 超限时**不要** `req.destroy()`：那会让客户端收到 ECONNRESET 而不是
 * 我们准备好的 400，排障时看起来像服务挂了。正确做法是停止累积，
 * 把剩余数据读完（继续消费 data 事件），让响应能正常发出去。
 */
function readJson(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    let overflow = false
    const chunks = []
    req.on('data', chunk => {
      if (overflow) return
      size += chunk.length
      if (size > limitBytes) {
        overflow = true
        chunks.length = 0
        reject(new Error(`请求体过大（上限 ${limitBytes} 字节）`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) return
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 本机回环地址的 Host 名。 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 取 Host 头里的主机名（去掉端口，IPv6 方括号保留）。 */
function hostnameOf(host) {
  const value = String(host ?? '')
  if (value.startsWith('[')) {                      // [::1]:3082
    const end = value.indexOf(']')
    return end > 0 ? value.slice(0, end + 1) : value
  }
  return value.replace(/:\d+$/, '')
}

/** 是否带了自定义准入头（见 constants.js 的 BOARD_HEADER 说明）。 */
function hasBoardHeader(req) {
  return String(req.headers?.[BOARD_HEADER] ?? '') !== ''
}

/**
 * 准入模型（0.7.0 重写）。
 *
 * 0.6.0 的判据是「`Origin.host === Host` 即同源」，但没有 `Origin` 时
 * 直接放行。这个判据可以被 DNS rebinding 完全绕过：
 *
 *   攻击者页面在 `http://evil.example:9735`（该域名解析到 127.0.0.1），
 *   它向同一个 evil.example:9735 发请求 —— 浏览器的 `Host` 与 `Origin`
 *   都是 `evil.example:9735`，判据恒真；而不带 Origin 的 POST 更是无条件放行。
 *   实测该请求能读全部任务标题/工作目录/报告摘要，能归档、改派发目标、取消任务。
 *
 * 关键认识：**自定义头挡不住 rebinding**。攻击者页面与目标同源，
 * 加自定义头不触发预检，所以「必须带头」对这类攻击无效。真正的判据是
 * Host 必须是我们真正在监听的那个地址——浏览器无法伪造 `Host`
 * （它来自 URL），而攻击者无法让受害者浏览器把 `127.0.0.1:9735`
 * 当作自己的源。
 *
 * 所以：
 * - **回环 Host**（127.0.0.1 / localhost / ::1）放行读；写操作另需
 *   自定义头，挡掉「同源页面里的恶意脚本」与简单的 CSRF。
 * - **非回环 Host** 默认拒绝。要开放远程访问，就把该 Host 显式写进
 *   `BOARD_ALLOWED_HOSTS`（此时仍要求 Origin 与 Host 一致）。
 */
function isLoopbackHost(host) {
  return LOOPBACK.has(hostnameOf(host))
}

/** Host 是否在显式放行清单里。 */
function isAllowedHost(host) {
  const allowed = BOARD_ALLOWED_HOSTS
  if (allowed.includes('*')) return true
  return allowed.includes(String(host ?? ''))
}

/**
 * 读操作准入：回环 Host 直接放行；其它 Host 必须显式放行且同源。
 *
 * 回环放行是安全的：`Host` 由 URL 决定，攻击者页面（evil.example）
 * 想让浏览器发出 `Host: 127.0.0.1:9735` 就必须真的去连 127.0.0.1，
 * 而那时 `Origin` 是 evil.example —— 所以回环分支仍要看 Origin，
 * 只接受「没有 Origin」（本机 curl / 同页面导航）或「Origin 也是回环」。
 */
function isLoopbackOrigin(origin) {
  if (!origin) return true                          // curl / 直接导航
  try { return LOOPBACK.has(hostnameOf(new URL(origin).host)) } catch { return false }
}

function readAllowed(req) {
  const host = String(req.headers?.host ?? '')
  const origin = req.headers?.origin

  if (isLoopbackHost(host)) return isLoopbackOrigin(origin)

  if (!isAllowedHost(host)) return false
  if (!origin) return true
  try { return new URL(origin).host === host } catch { return false }
}

/**
 * 写操作准入：在读操作的基础上，额外要求自定义头。
 *
 * 自定义头在这里的作用不是防 rebinding（那由 Host 判定负责），
 * 而是防**同源页面之外的脚本**与简单 CSRF：跨站发带自定义头的请求
 * 会触发预检，预检不带凭据也不带这个头，服务端拒绝后真请求不会发出。
 */
function writeAllowed(req) {
  if (!readAllowed(req)) return false
  return hasBoardHeader(req)
}

/** 会话 id 的合法形状：DSH 的 sessionId 是 `session-<uuid>`，默认主会话是配置里的固定 id。 */
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/

/**
 * 这个 sessionId 是否值得为它记一个派发目标。
 *
 * 三个来源任一命中即算：
 * - 宿主当前有这个 agent（活的会话）；
 * - 配置里的默认主会话 id（`mas-lead` 那种，可能还没创建）；
 * - 形状合法且看起来是真实会话（`session-…`），交给后续解析。
 *
 * 目的是挡住 `__proto__`、空串、超长垃圾这类无意义写入——它们会
 * 污染 targets 并随 persist 落盘。
 */
function isKnownSession(dispatch, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return false
  if (sessionId === '__proto__' || sessionId === 'constructor' || sessionId === 'prototype') return false
  if (dispatch.ctx?.agents?.get?.(sessionId)) return true
  const lead = String(dispatch.config?.leadSessionId || 'mas-lead')
  if (sessionId === lead) return true
  return sessionId.startsWith('session-')
}

/**
 * 构造看板请求处理器。单独导出是为了能在单测里直接喂假的 req/res，
 * 不必起一个真的 HTTP 服务。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createBoardHandler(ctx, dispatch) {
  return async function boardHandler(req, res) {
    let pathname
    try { pathname = new URL(req.url ?? '', 'http://localhost').pathname }
    catch { return send(res, 400, { ok: false, error: '请求地址不合法' }) }

    try {
      /**
       * `GET /board` —— 整块快照，可带两个**只读**过滤参数（plans/12 §8.2）。
       *
       * `?group=` / `?task=` 是给「派发卡」用的窄口：卡片只要自己那一小片
       * 成员，而 200 条截断会把它挤掉（详见 `boardSnapshot` 里过滤顺序那段）。
       * 两者同时给取交集；都不给时走的还是原来那条路径，输出逐字段不变。
       *
       * 这里**刻意不做**参数白名单校验：未知参数（`?foo=1`）忽略即可，多一个
       * 参数不该让一个只读端点变成 400。而未知的 `group` / `task` 值也**不是 404**
       * ——资源（看板）存在，只是这次过滤没有命中，返回 `tasks: []` 是过滤结果，
       * 不是「看板没了」。
       */
      if (req.method === 'GET' && pathname === BASE) {
        if (!readAllowed(req)) return send(res, 403, { ok: false, error: '看板只对本机或同源页面开放' })
        let query
        try { query = new URL(req.url ?? '', 'http://localhost').searchParams }
        catch { query = undefined }
        const filter = boardFilterOf(query)
        const scoped = filter.group || filter.task ? filter : undefined
        // memoryStats 是 async 的（要读活表与留痕两份），必须先把值 await 出来，
        // 否则 JSON 里会出现一个被序列化成 `{}` 的 Promise。
        return send(res, 200, boardSnapshot(dispatch, await resolveMemory(dispatch), scoped))
      }

      if (req.method === 'POST' && pathname === `${BASE}/client-ready`) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        let body
        try { body = await readJson(req) }
        catch (error) { return send(res, 400, { ok: false, error: String(error?.message ?? error) }) }
        // `cards`：客户端里两张卡的注册结论（plans/14 §4.1）。这一项曾经整个被丢掉，
        // 于是 selfcheck 里永远读不到卡片注册结果——「客户端报了」不等于「宿主记住了」。
        // 归一化函数对**没有合法结论**的输入返回 undefined，这里据此条件写入：
        // 键不存在 ≠ 失败（见 clientCardsOf），旧客户端/旧宿主照旧兼容。
        const cards = clientCardsOf(body?.cards)
        dispatch.clientReady = {
          at: new Date().toISOString(),
          ok: body?.ok !== false,
          ...(Array.isArray(body?.registered) ? { registered: body.registered.slice(0, 20).map(String) } : {}),
          ...(body?.error ? { error: String(body.error).slice(0, 500) } : {}),
          ...(cards ? { cards } : {}),
        }
        return send(res, 200, { ok: true })
      }

      if (req.method === 'GET' && pathname === `${BASE}/selfcheck`) {
        if (!readAllowed(req)) return send(res, 403, { ok: false, error: '看板只对本机或同源页面开放' })
        return send(res, 200, await dispatch.selfCheck())
      }

      /**
       * 已退休任务：只读诊断视图（plans/07 P0-5「退休可查」）。
       *
       * 与 GET /board 同档准入（`readAllowed`），不要求写头：它只读、不含正文、
       * 只回答「这条任务什么时候因为什么被移出账本」。退休本身**不是**写操作，
       * 不能被面板触发 —— 退休由 host 的封顶逻辑决定，面板只能看。
       *
       * 退休记录刻意**不**回落进 tasks 列表：那会让退休行为看起来像没发生，
       * 也会让「账本有上界」这个验收项（plans/07 §七 4）无法从快照上验证。
       */
      if (req.method === 'GET' && pathname === `${BASE}/retired`) {
        if (!readAllowed(req)) return send(res, 403, { ok: false, error: '看板只对本机或同源页面开放' })
        return send(res, 200, retiredSnapshot(dispatch))
      }

      /**
       * 全量统计聚合（plans/09 P0）。
       *
       * 与 GET /board 同档准入（`readAllowed`），不要求写头：它只读、不含任务正文。
       *
       * 两件事必须写清楚：
       * 1. **不受 200 条快照上限影响**。它遍历 `dispatch.table.tasks` 全量 + 退休留痕，
       *    而不是 `/board` 那份截断过的列表——「总计 500 / 列表 200」时若拿列表算比例，
       *    分母从一开始就是错的（§八.2）。
       * 2. **失败降级而不是 500**（§八.10）。看板每 2 秒轮询，一个 500 会让客户端
       *    进入「报错→重试→再报错」的循环，而任务列表其实还是好的。所以聚合抛错时
       *    返回与成功结果同构的最小结构 + `degraded: true`，总览继续按快照工作。
       *
       * 查询参数：`window`（`24h` / `7d` / `30d` / `all`，缺省沿用 `memoryWindowDays`）、
       * `workspaceId`（派发目标）、`hostWorkspaceId`（实际归属）。两个工作区参数
       * 是**两个维度**，同时给就是交集，不互相替代。
       */
      if (req.method === 'GET' && pathname === `${BASE}/stats`) {
        if (!readAllowed(req)) return send(res, 403, { ok: false, error: '看板只对本机或同源页面开放' })
        let query
        try { query = new URL(req.url ?? '', 'http://localhost').searchParams }
        catch { query = new URLSearchParams() }
        const scope = {
          window: query.get('window') ?? undefined,
          workspaceId: query.get('workspaceId') ?? undefined,
          hostWorkspaceId: query.get('hostWorkspaceId') ?? undefined,
        }
        try {
          return send(res, 200, boardStats(dispatch, scope))
        } catch (error) {
          // 降级要记日志：不记的话「效果卡一直显示暂不可用」永远查不到原因。
          ctx.logger?.warn?.('%s 看板统计聚合失败，已降级返回: %s', LOG_PREFIX, String(error))
          // 降级也要用**同一个**默认窗口来源（`defaultWindowDays`）：写死 7 天的话，
          // 宿主把 memoryWindowDays 改成 30，降级响应会回显「7d」而正常响应回显「30d」。
          return send(res, 200, degradedStats(scope, error, dispatch))
        }
      }

      /**
       * 分析数据看板的聚合（与 `/stats` 并列，互不改对方口径）。
       *
       * 准入与 `/board` `/stats` 完全同档：只读、不含任务正文、不带正文预览。
       * 参数全部在 `src/analytics.js` 的 `normalizeAnalyticsScope()` 里归一，
       * 非法值退回默认并在 `warnings` 里留代码，不在这里另写一套校验。
       *
       * 失败降级而不是 500：任务看板每 2 秒轮询，分析看板在窄屏下与它并列，
       * 一个 500 会让两块面板一起进入「报错 → 重试 → 再报错」的循环。
       */
      if (req.method === 'GET' && pathname === `${BASE}/analytics`) {
        if (!readAllowed(req)) return send(res, 403, { ok: false, error: '看板只对本机或同源页面开放' })
        let query
        try { query = new URL(req.url ?? '', 'http://localhost').searchParams }
        catch { query = new URLSearchParams() }
        const scope = {
          window: query.get('window') ?? undefined,
          status: query.get('status') ?? undefined,
          owner: query.get('owner') ?? undefined,
          workspaceId: query.get('workspaceId') ?? undefined,
          hostWorkspaceId: query.get('hostWorkspaceId') ?? undefined,
          group: query.get('group') ?? undefined,
          overdueHours: query.get('overdueHours') ?? undefined,
        }
        try {
          return send(res, 200, analyticsSnapshot(dispatch, scope))
        } catch (error) {
          ctx.logger?.warn?.('%s 分析看板聚合失败，已降级返回: %s', LOG_PREFIX, String(error))
          return send(res, 200, degradedAnalytics(scope, error, dispatch))
        }
      }

      if (req.method === 'POST' && pathname === `${BASE}/archive`) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        const result = await dispatch.archiveStale()
        return send(res, 200, { ok: true, ...result, counts: boardSnapshot(dispatch, await resolveMemory(dispatch)).counts })
      }

      /**
       * 归档**单条**任务（看板行内的「归档」按钮）。
       *
       * 为什么不复用上面的 `POST /archive`：那条是**巡检**入口——不读 body、
       * 按 `archiveAfterHours` 扫全表、回 `{scanned, archived, failed}`，而且
       * 既有用例（`test/board.test.js` 的「POST /archive 触发一次归档巡检」、
       * `test/p0-regression.test.js` 的两条准入用例）钉死了这套语义。给巡检
       * 加一个「只处理某条」的分支，等于让同一个 URL 在不同 body 下有两套返回
       * 形状与两种副作用，谁调谁都要先读实现。两条路各管一件事：
       *   `/archive`      → 批量巡检（「立即归档」按钮、启动定时器）
       *   `/archive-task` → 单条归档（任务行上的按钮，用户明确指了哪一条）
       *
       * 错误码分工（与 `/cancel` `/retry` 同风格，但「未结算」必须是 409 而不是
       * 静默成功）：缺 `task_id` → 400；任务不存在 → 404；还在跑 → 409。
       */
      if (req.method === 'POST' && pathname === `${BASE}/archive-task`) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        let body
        try { body = await readJson(req) }
        catch (error) { return send(res, 400, { ok: false, error: String(error?.message ?? error) }) }
        const taskId = String(body?.task_id ?? '').trim()
        if (!taskId) return send(res, 400, { ok: false, error: '需要 task_id' })
        // 先在这里查一次：这样 404 与 409 的区分不依赖 archiveTask 的错误文案，
        // 文案以后改字也不会把状态码一起改坏。
        if (!dispatch.table.get(taskId)) {
          return send(res, 404, { ok: false, error: `没有任务 ${taskId}` })
        }
        try {
          const result = await dispatch.archiveTask(taskId)
          return send(res, 200, {
            ok: true,
            archived: result.archived,
            ...(result.reason ? { reason: result.reason } : {}),
            task: boardTask(result.task),
          })
        } catch (error) {
          return send(res, 409, { ok: false, error: String(error?.message ?? error) })
        }
      }

      if (req.method === 'POST' && pathname === `${BASE}/target`) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        let body
        try { body = await readJson(req) }
        catch (error) { return send(res, 400, { ok: false, error: String(error?.message ?? error) }) }
        const sessionId = String(body?.session_id ?? '').trim()
        if (!sessionId) return send(res, 400, { ok: false, error: '需要 session_id' })
        // 只允许给「真实存在的主会话」或「已登记的默认主会话」设目标。
        // 0.6.0 之前只校验非空，任意字符串（含 __proto__、不存在的会话）
        // 都会返回 200 并写进 targets，随后随 persist 落到 tasks.json。
        if (!isKnownSession(dispatch, sessionId)) {
          return send(res, 404, { ok: false, error: `没有会话 ${sessionId}` })
        }
        try {
          const target = await dispatch.setTarget(sessionId, body?.workspace)
          return send(res, 200, { ok: true, target: target ?? null })
        } catch (error) {
          return send(res, 409, { ok: false, error: String(error?.message ?? error) })
        }
      }

      if (req.method === 'POST' && (pathname === `${BASE}/cancel` || pathname === `${BASE}/retry`)) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        let body
        try { body = await readJson(req) }
        catch (error) { return send(res, 400, { ok: false, error: String(error?.message ?? error) }) }

        const task = dispatch.table.get(String(body?.task_id ?? ''))
        if (!task) return send(res, 404, { ok: false, error: `没有任务 ${body?.task_id ?? ''}` })

        /**
         * `/retry` 兼作**续派**投递口（plans/08 阶段 1）。
         *
         * 为什么**不新造一条 HTTP 路由**：看板上「续派」与「重试」要的是同一条通道
         * ——「往这条任务的子会话里投一条消息，让它接着干」，区别只有两处：
         * 重试会先按状态挑指令（已完成 → 再执行一次；未完成 → 从中断处继续），
         * 续派则由用户自己写那句话。既然 `dispatch.message()` 就是这条通道
         * （`retry()` 内部也走它），这里只需让 `/retry` 接受一个可选的 `message`：
         * 给了就走用户在填的那句话，没给就是原来的重试。多一条路由等于多一套准入、
         * 多一组错误码、多一次「两条路径的语义什么时候开始分叉」的维护。
         *
         * 为什么**必须限定已结算的任务**：`message()` 会把任务拉回 `running`，
         * 对一条正在跑的任务发续派 = 插进它当前回合的收件箱，那是 `dispatch_message`
         * 里 `mode: 'steer'` 才该有的语义。看板上的按钮不该顺手做这件事，
         * 所以未结算 → 409，让用户先等它跑完（或先取消）。
         */
        const continueText = typeof body?.message === 'string' ? body.message.trim() : ''
        try {
          if (pathname === `${BASE}/cancel`) {
            await dispatch.cancel(task, '看板取消')
          } else if (continueText) {
            if (!SETTLED.has(task.status)) {
              return send(res, 409, {
                ok: false,
                error: `任务 ${task.id} 还在 ${task.status}，不能续派：等它结算后再补要求，或先取消`,
              })
            }
            // 用户写的那句话直接进会话；前缀与派发工具的那份同源，
            // 投递走 `dispatch.continueTask()`——**工具入口与看板入口共用一条路径**。
            // 0.8.x 之前这里直接调 `dispatch.message()`，于是绕开了全部校验：
            // 可以续派别人的任务、可以续派已归档的任务、可以往不是本插件建的
            // 会话里塞要求。同一个动作两套准入，不是细节差异。
            await dispatch.continueTask(task, continueText)
          } else {
            await dispatch.retry(task)
          }
          return send(res, 200, { ok: true, task: boardTask(task) })
        } catch (error) {
          return send(res, 409, { ok: false, error: String(error?.message ?? error) })
        }
      }

      return send(res, 404, { ok: false, error: '未知的看板接口' })
    } catch (error) {
      ctx.logger?.warn?.('%s 看板接口出错: %s', LOG_PREFIX, String(error))
      return send(res, 500, { ok: false, error: '看板接口内部错误' })
    }
  }
}

/**
 * 注册看板路由；宿主没有 webServer（headless 形态）时安静跳过。
 *
 * 为什么注册要**包一层 try/catch**（0.10.1）：`server.register()` 失败是
 * 「看板起不来」，不是「插件不该装」。宿主在 HMR 重载时对同一条 prefix 路由
 * 重复注册会抛错（路径已被占用），而 `apply()` 里这个调用没有防护时，异常会
 * 一路冒到 `apply()`，于是**整个插件加载失败** —— 10 个 `dispatch_*` 工具和看板
 * 一起消失。用户看到的是「插件没装」，实际只是面板没挂上。所以这里降级：记一条
 * warn，返回 undefined（调用方据此不登记 disposer），工具照常工作。
 *
 * 注意**保持同步注册**，不要改成 `ctx.inject` 之类的延迟注入：延迟注入会让
 * 返回的 disposer 在注入回调里才产生，而调用方早已拿到 undefined，于是卸载时
 * 路由不会被注销——HMR 一轮就多一条重复路由，正好把上面这个问题放大成必现。
 *
 * @returns {(() => void) | undefined} 注销函数；注册失败或没有 webServer 时 undefined
 */
export function registerBoardRoutes(ctx, dispatch) {
  const server = ctx.get('webServer')
  if (!server || typeof server.register !== 'function') {
    ctx.logger?.info?.('%s 没有 webServer，跳过任务看板路由', LOG_PREFIX)
    return undefined
  }
  try {
    return server.register({ kind: 'prefix', path: BASE, handler: createBoardHandler(ctx, dispatch) })
  } catch (error) {
    // 路由冲突/HMR 重复注册：只 warn，不让整个 apply 失败。
    // 理由：看板起不来 ≠ 插件没装（10 个工具必须活着）。
    ctx.logger?.warn?.('%s 看板路由注册失败，看板不可用但工具照常：%s', LOG_PREFIX, error?.message ?? error)
    return undefined
  }
}
