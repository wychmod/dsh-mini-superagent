/**
 * 看板统计的 Host 半边：对**完整账本**聚合，不受 `/board` 200 条快照上限影响。
 *
 * 为什么单独一个文件、单独的只读路由（plans/09 §六.1）：`/board` 是每 2 秒轮询的
 * 任务快照，它服务「现在要我做什么」；统计服务「这段时间干得怎么样」，遍历全部历史、
 * 偶尔查一次就够。把全量聚合塞进快照会让轮询成本随账本规模线性增长，而快照本来
 * 就**只带 200 条**——拿它算比例，分母从一开始就是错的。
 *
 * 三条不变式（改这个文件前先读）：
 * 1. **口径只有一份**：完成率分母来自 `COMPLETION_BASE`，取消单列。这里不新造状态集合。
 * 2. **不知道就说不知道**：n=0 给 null 而不是 0；1≤n<5 带 `sampleLow`；缺时间、
 *    被夹紧的跨度、被丢弃的留痕都要在 coverage 里看得见。
 * 3. **两个工作区维度不混用**：`workspaceId` 是派发目标，`hostWorkspaceId` 是子会话
 *    实际归属。分组结果分成 `byTarget` / `byHost` 两份，绝不合并成一个数组。
 *
 * 契约见 plans/09 §六.1。`boardStats(dispatch, scope)` 是纯函数（不读盘、不发网络），
 * test/stats.test.js 直接调它，不需要起 HTTP 服务。
 */
import {
  COMPLETION_BASE, SETTLED, STATS_VERSION, STATS_WINDOW_ALL, STATUS_ORDER, TIME_BASIS, now,
} from './constants.js'

/**
 * 「样本少」的门槛：1 ≤ n < 5。
 *
 * 与 plans/09 §三.4 一致：不到 5 个样本仍可以显示数值（总比什么都不显示好），
 * 但必须同时带上这个标记，否则一个 3 样本的 100% 会被当成结论读。
 */
export const SAMPLE_LOW_BELOW = 5

/** 窗口键的合法语法：`all` 或 `<n>h` / `<n>d`。 */
const WINDOW_RE = /^(\d+)([hd])$/i

/** 可解析的时间戳（毫秒）；null/垃圾一律 NaN，由调用方决定怎么算「不知道」。 */
function timeOf(value) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : NaN
}

/** 0..1 的比值，保留 4 位小数；分母为 0 时返回 null（不是 0）。 */
function ratio(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null
  return Math.round((part / whole) * 10_000) / 10_000
}

/** 保留 2 位小数，用于倍数/天数这类人读的派生值；非法输入返回 null。 */
function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

/** 某个任务是否已归档（归档 = 只读冻结，不参与任何效果指标）。 */
const isArchived = task => Boolean(task?.archivedAt)

/** 当前工作：还没结算的任务。时间窗不隐藏它们（plans/09 §三.1）。 */
const isCurrent = task => !SETTLED.has(task?.status)

/**
 * 升序数值数组的分位数（线性插值）；空数组返回 null。
 *
 * 用线性插值而不是「取第 k 个」：后者在 n=2 时 P90 恒等于最大值，看起来像
 * 「长尾很重」，其实只是样本太少。n=1 时直接返回那个值。
 */
export function quantile(sorted, q) {
  if (!Array.isArray(sorted) || !sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower)
}

/** 中位数；空数组返回 null。 */
export function median(values) {
  const sorted = (Array.isArray(values) ? values : []).filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  return sorted.length ? quantile(sorted, 0.5) : null
}

/** 一组时长的分布块：P50 / P90 / 样本量 / 样本少标记。空样本时两个值都是 null。 */
function distribution(values) {
  const sorted = (Array.isArray(values) ? values : []).filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  const count = sorted.length
  return {
    p50: count ? quantile(sorted, 0.5) : null,
    p90: count ? quantile(sorted, 0.9) : null,
    count,
    // n=0 时 sampleLow 必须是 false：「没有样本」与「样本少」是两件事，
    // 前者界面显示 em dash，后者才显示「样本少」。
    sampleLow: count > 0 && count < SAMPLE_LOW_BELOW,
  }
}

/**
 * 把 `?window=` 归一成窗口对象。
 *
 * 默认值**不在这里编**：plans/09 §三.1 要求沿用 `memory.window`，否则前端一个默认、
 * 宿主另一个默认，同一个筛选条件会得到两个分母。默认天数由调用方从
 * `dispatch.config.memoryWindowDays` 传进来（见 `defaultWindowDays()`）。
 *
 * 非法值不抛错也不静默：`fallbackFrom` 记下原始输入，前端可以显示「筛选条件无效，
 * 已退回 N 天」，而不是让人盯着一个自己没选过的窗口怀疑缓存。
 *
 * @param {string|undefined} raw 查询参数
 * @param {number} defaultDays 兜底天数（来自配置）
 */
export function normalizeWindow(raw, defaultDays) {
  const fallbackDays = Number.isFinite(Number(defaultDays)) && Number(defaultDays) > 0 ? Number(defaultDays) : 7
  const text = String(raw ?? '').trim().toLowerCase()
  const invalid = Boolean(text) && text !== STATS_WINDOW_ALL && !WINDOW_RE.test(text)
  const key = invalid ? `${fallbackDays}d` : (text || `${fallbackDays}d`)

  if (key === STATS_WINDOW_ALL) {
    return {
      key: STATS_WINDOW_ALL,
      days: null,
      since: null,
      requested: text || null,
      fallbackFrom: invalid ? text : null,
    }
  }
  const match = WINDOW_RE.exec(key)
  const amount = match ? Math.max(1, Number(match[1])) : fallbackDays
  const unit = match ? match[2].toLowerCase() : 'd'
  const hours = unit === 'h' ? amount : amount * 24
  return {
    // 回显归一后的键（`24h` 不会变成 `1d`），前端据此点亮自己选中的 chip。
    key: match ? `${amount}${unit}` : `${fallbackDays}d`,
    // 天数是给吞吐用的自然日数：小时窗按 1/24 天保留小数，
    // 取整会让 24h 窗口的吞吐凭空翻一倍。
    days: hours / 24,
    since: new Date(Date.now() - hours * 3_600_000).toISOString(),
    requested: text || null,
    fallbackFrom: invalid ? text : null,
  }
}

/** 默认窗口天数：优先 `memoryWindowDays`，取不到就 7。 */
export function defaultWindowDays(dispatch) {
  const configured = Number(dispatch?.config?.memoryWindowDays)
  return Number.isFinite(configured) && configured > 0 ? configured : 7
}

/**
 * 一条已结算任务的**权威结算时刻**（plans/09 §三.2）。
 *
 * 优先 `settledAt`；旧数据没有这个字段时回退 `updatedAt`，并**明确标出**回退。
 * 绝不静默混用：`updatedAt` 会被报告、追问、归档、后台巡检刷新，拿它算出来的
 * 「完成时间」在事后还会变，按天趋势与并行节省跟着一起漂。
 *
 * @returns {{at: number, basis: string}} at 为 NaN 表示时间未知（不是 0）
 */
export function settleTimeOf(task) {
  const settled = timeOf(task?.settledAt)
  if (Number.isFinite(settled)) return { at: settled, basis: TIME_BASIS.SETTLED }
  const updated = timeOf(task?.updatedAt)
  if (Number.isFinite(updated)) return { at: updated, basis: TIME_BASIS.FALLBACK }
  return { at: NaN, basis: TIME_BASIS.MISSING }
}

/**
 * 窗口是**左闭**的：结算时刻恰好等于窗口起点时算在窗口内。
 *
 * 为什么把这个判据导出成一个函数：它是「同一份账本在不同毫秒问一次会不会
 * 得到不同数字」的唯一决定点。0.6.0 的等价物散在三处各写一遍（`>=` / `>` 都
 * 出现过），结果是「窗口起点恰好那条」在总览与效果里归属不同。
 *
 * 上界是开放的（`+∞`）：时钟回拨或未来时间戳不该让一条真实事实凭空消失——
 * 它会落成 daily 里的另一天，看得见，而不是被悄悄丢掉。
 *
 * @param {number} atMs 事实时刻（毫秒）
 * @param {number} sinceMs 窗口起点（毫秒）；NaN 表示「全部时间」
 */
export function inWindow(atMs, sinceMs) {
  if (!Number.isFinite(atMs)) return false
  if (!Number.isFinite(sinceMs)) return true
  return atMs >= sinceMs
}

/** 内部别名：历史注释里一直叫 jwithinWindow，保留一个名字避免两套语义。 */
const withinWindow = inWindow

/**
 * 把账本切成「参与统计的」「被排除的」「时间未知的」三摞。
 *
 * 这是唯一遍历任务的地方：其余函数只接收切好的行，避免同一份数据被不同口径
 * 重复过滤出不同结果——那种分裂在「总览 vs 效果对不上」时最难查。
 */
function collect(dispatch, scope) {
  const sinceMs = scope.window.since ? timeOf(scope.window.since) : NaN
  const tasks = [...(dispatch?.table?.tasks?.values?.() ?? [])]
  const retired = [...(dispatch?.retired?.values?.() ?? [])]
  const workspaceId = scope.workspaceId
  const hostWorkspaceId = scope.hostWorkspaceId

  /**
   * 两个工作区维度分别判定，绝不互相替代。
   * 派发目标是「用户把任务派向哪里」，实际归属是「子会话挂在哪个工作区」；
   * 没有目标时任务照样有实际归属——两者相等只是巧合，不能当成同义词。
   */
  const matchesScope = task => {
    if (workspaceId && String(task?.workspaceId ?? '') !== workspaceId) return false
    if (hostWorkspaceId && String(task?.hostWorkspaceId ?? '') !== hostWorkspaceId) return false
    return true
  }

  const settled = []
  const current = []
  let excludedArchived = 0
  let missingTimes = 0
  let fallbackCount = 0
  const basisSeen = new Set()

  for (const task of tasks) {
    if (!matchesScope(task)) continue
    // 归档优先判：归档是只读冻结，既不进效果指标，也不属于「当前工作」。
    // 判据用 archivedAt（§三.2），所以「窗口内归档了多少」是可复核的。
    if (isArchived(task)) {
      if (withinWindow(timeOf(task.archivedAt), sinceMs)) excludedArchived += 1
      continue
    }
    if (isCurrent(task)) {
      // 当前工作不看窗口：一个跑了 10 天的任务不能在 24h 视图里消失。
      current.push(task)
      continue
    }
    const { at, basis } = settleTimeOf(task)
    basisSeen.add(basis)
    if (!Number.isFinite(at)) {
      /**
       * 时间未知：**绝不能从分母里悄悄消失**（§三.4「不能悄悄从分母消失」）。
       *
       * 两个窗口形态的处理不同，但都不能让它凭空不见：
       * - **没有窗口**（`all`）：没有任何时间约束需要它满足，它进分母。
       * - **有窗口**：无法证明它落在窗口内，所以不进这个窗口的分母——但
       *   `missingTimes` 会如实报出条数，界面上写「时间未知 n」，读者立刻知道
       *   这个分母是**下界**。这比两个选项都糟的第三种做法（当成 0 时间戳 →
       *   永远在窗口外 → 连计数都没有）会让一条真实任务彻底消失。
       */
      missingTimes += 1
      if (!scope.window.since) settled.push({ task, at, basis })
      continue
    }
    if (!withinWindow(at, sinceMs)) continue
    if (basis === TIME_BASIS.FALLBACK) fallbackCount += 1
    settled.push({ task, at, basis })
  }

  // 退休留痕：不在活表里，只用于「退休量与退休原因」与 coverage。
  // 它们只有 retiredAt，所以只按它归属窗口；工作区筛选对它们不生效
  //（留痕刻意只存 workspaceTitle、没有 id，按 id 筛就无从判起）。
  // 与 `tasks` 一样，**先全量收进来**：`sourceTasks` 要能证明「读了多少账本」，
  // 拿窗口筛过的子集去数会让这个数随筛选条件漂移，那就不是证据了。
  const retiredInWindow = retired.filter(record => withinWindow(timeOf(record?.retiredAt), sinceMs))

  return {
    tasks,
    retired,
    settled,
    current,
    retiredInWindow,
    excludedArchived,
    missingTimes,
    fallbackCount,
    basisSeen,
  }
}

/**
 * 一条任务参与时长/并行计算所需的三个时刻。
 *
 * 缺 `startedAt` 或结算时刻 → 返回 undefined，这条不进时长分布（也无法算并行）。
 * 结算早于开始（时钟回拨、手工改库）→ 夹到 0 而不是丢掉整条：丢掉会让
 * 「已结算 n」与「有效耗时 n」的差变成一笔糊涂账，夹紧后它仍如实出现在分布里，
 * 另外在 `durations.clamped` 里记账。
 */
function spansOf(task, at) {
  const started = timeOf(task?.startedAt)
  const created = timeOf(task?.createdAt)
  if (!Number.isFinite(at) || !Number.isFinite(started)) return undefined
  return {
    occupied: Math.max(0, at - started),
    queueWait: Number.isFinite(created) ? Math.max(0, started - created) : NaN,
    endToEnd: Number.isFinite(created) ? Math.max(0, at - created) : NaN,
    clamped: at - started < 0,
  }
}

/** 一条任务的活动时刻：结算时刻、更新时间、创建时间里最大的那个（用于「最后活动」）。 */
function activityOf(task, settledAt) {
  const candidates = [settledAt, timeOf(task?.updatedAt), timeOf(task?.createdAt)].filter(Number.isFinite)
  return candidates.length ? Math.max(...candidates) : 0
}

/** 结果分布与各种比率（plans/09 §四 A）。 */
function outcomeOf(settledTasks, currentTasks, windowDays, createdInScope) {
  const tally = { done: 0, ended: 0, failed: 0, blocked: 0, interrupted: 0, cancelled: 0 }
  for (const task of settledTasks) {
    if (task.status in tally) tally[task.status] += 1
  }
  const settled = settledTasks.length
  const completionBase = settledTasks.filter(task => COMPLETION_BASE.has(task.status)).length
  // 一次完成率与重试后恢复率各看一个 attempt 子集，且同样**排除取消**——
  // 取消既不是「一次做完」，也不是「返工」。用 COMPLETION_BASE 过滤而不是
  // 只判两个状态：取消进任一侧都会让「重试后恢复率」被用户取消污染。
  const countable = settledTasks.filter(task => COMPLETION_BASE.has(task.status))
  const firstAttempt = countable.filter(task => (task.attempt ?? 1) === 1)
  const retried = countable.filter(task => (task.attempt ?? 1) > 1)
  const firstAttemptDone = firstAttempt.filter(task => task.status === 'done').length
  const retriedDone = retried.filter(task => task.status === 'done').length
  // 返工率的分母是「窗口内派发的任务」，不是已结算数：刚派出去还没跑的任务
  // 也算一次派发，否则重试多的时候返工率反而被算低。
  const reworked = createdInScope.filter(task => (task.attempt ?? 1) > 1).length

  return {
    settled,
    // 分母单独给出来：每个比例都必须能追到分子分母（§八.1）。
    completionBase,
    ...tally,
    completionRate: ratio(tally.done, completionBase),
    firstPassRate: ratio(firstAttemptDone, firstAttempt.length),
    reworkRate: ratio(reworked, createdInScope.length),
    // 取消率的分母是**全部已结算（含取消）**，与完成率不是同一个分母。
    // 共用分母等于把「用户改了主意」算成「任务没做成」。
    cancelRate: ratio(tally.cancelled, settled),
    failureRate: ratio(tally.failed, settled),
    blockRate: ratio(tally.blocked, settled),
    interruptedRate: ratio(tally.interrupted, settled),
    recoveryRate: ratio(retriedDone, retried.length),
    firstAttemptCount: firstAttempt.length,
    retriedCount: retried.length,
    reworkedCount: reworked,
    dispatched: createdInScope.length,
    throughput: {
      done: tally.done,
      // 分母是窗口自然日数，不是「有任务的天数」：低活跃期按有任务的天数算，
      // 吞吐会凭空翻几倍，那个数字没法用。
      //
      // 没有任何已结算样本时给 null 而不是 0：0/天 会被读成「整整 7 天什么都没
      // 做成」，而事实是「这个窗口里没有可统计的事实」。有样本但 done=0 时
      // 0/天 才是真的——那是「跑了但都失败了」，读者需要看到的正是这个。
      perDay: settled > 0 && windowDays > 0 ? ratio(tally.done, windowDays) : null,
      days: windowDays > 0 ? round2(windowDays) : null,
    },
    // 当前工作（不看窗口）：拆解页要能同时看到「过去怎样」与「现在几个在跑」。
    running: currentTasks.filter(task => task.status === 'running').length,
    queued: currentTasks.filter(task => task.status === 'queued').length,
    sampleLow: completionBase > 0 && completionBase < SAMPLE_LOW_BELOW,
  }
}

/** 速度与等待（plans/09 §四 B）：三个分布的 P50/P90，n=0 时是 null。 */
function durationsOf(rows, clamped) {
  const queueWait = []
  const occupied = []
  const endToEnd = []
  for (const row of rows) {
    if (Number.isFinite(row.queueWait)) queueWait.push(row.queueWait)
    if (Number.isFinite(row.occupied)) occupied.push(row.occupied)
    if (Number.isFinite(row.endToEnd)) endToEnd.push(row.endToEnd)
  }
  const occupiedDist = distribution(occupied)
  return {
    queueWait: distribution(queueWait),
    occupied: occupiedDist,
    endToEnd: distribution(endToEnd),
    // 长尾比 P90/P50：P50 为 0 或没有样本时是 null，不编一个 ∞ 或 0。
    longTail: occupiedDist.p50 > 0 && occupiedDist.p90 !== null ? round2(occupiedDist.p90 / occupiedDist.p50) : null,
    // 被夹紧的跨度数：>0 说明有任务的结算时刻早于开始时刻，时长分布偏小。
    clamped,
  }
}

/**
 * 并行效果（plans/09 §四 C）：粗算，明确它不是工时结算。
 *
 * `estimated` **恒为 true**：`Σ占用 - 墙钟跨度` 本来就是粗算（它假设所有任务
 * 都在同一批并发位上跑，而事实上有排队、有追问、有后台收尾），任何样本量下
 * 都不是工时结算。所以这里不是一个「有时精确有时不精确」的布尔，而是一个
 * 恒假的精确性断言。
 *
 * 更粗的情形另用 `degraded` + `reasons` 表达：样本少、有回退时间基准、
 * 有被夹紧的跨度、留痕有丢失——它们让这个数字离事实更远，但改变不了
 * 「它本来就是个估计」这件事。把两者混成一个布尔，会让人以为样本够时就精确了。
 */
function parallelOf(rows) {
  const measured = rows.filter(row => Number.isFinite(row.occupied))
  if (!measured.length) {
    // 没有任何可用样本：四个数全部 null。给 0 会被读成「完全没省」，
    // 而事实是「算不出来」——这两件事在界面上必须长得不一样。
    return {
      occupiedMs: null,
      wallMs: null,
      savedMs: null,
      factor: null,
      sample: 0,
      sampleLow: false,
      estimated: true,
      degraded: false,
      reasons: [],
    }
  }
  const starts = measured.map(row => row.startedAt).filter(Number.isFinite)
  const ends = measured.map(row => row.settledAt).filter(Number.isFinite)
  const occupiedMs = measured.reduce((sum, row) => sum + row.occupied, 0)
  const wallMs = starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0
  return {
    occupiedMs,
    wallMs,
    savedMs: Math.max(0, occupiedMs - wallMs),
    // 墙钟跨度为 0 时倍数无意义（单条任务、或所有任务同一秒结算）。
    factor: wallMs > 0 ? round2(occupiedMs / wallMs) : null,
    sample: measured.length,
    sampleLow: measured.length < SAMPLE_LOW_BELOW,
    estimated: true,
    degraded: false,
    reasons: [],
  }
}

/** 当前状态下的投递与后台健康（plans/09 §四 D，取当前值，不看窗口）。 */
function reliabilityOf(tasks) {
  let undeliveredReports = 0
  let inputPending = 0
  let inputUnknown = 0
  let background = 0
  let backgroundKilled = 0
  let archiveErrors = 0
  let retryPending = 0
  for (const task of tasks) {
    if (task.delivery?.outcome === 'failed') undeliveredReports += 1
    // 与 board.js / dispatch.card() 的判据**完全一致**：unknown 压过 pending，
    // 已读之后两个都不算。三处各写一套是「同一页面两个数字对不上」的经典来源。
    if (task.inputPendingAt && !task.inputReadAt && !task.inputUnknownAt) inputPending += 1
    else if (task.inputUnknownAt && !task.inputReadAt) inputUnknown += 1
    if (task.background) background += 1
    if (task.backgroundKilled) backgroundKilled += Number(task.backgroundKilled) || 0
    if (task.archiveError) archiveErrors += 1
    if (task.retryAt) retryPending += 1
  }
  return {
    undeliveredReports,
    inputPending,
    inputUnknown,
    background,
    backgroundKilled,
    archiveErrors,
    retryPending,
  }
}

/**
 * 某个分组的一行聚合。
 *
 * 三种分组（工作区/批次/主会话）刻意返回**同一套字段**：三张表要能并排读，
 * 字段名不一样会导致「完成率」在三处是三种算法。比率在分母为 0 时一律 null。
 */
function groupRow(rows, extra = {}) {
  const settled = rows.filter(row => !isCurrent(row.task))
  const current = rows.filter(row => isCurrent(row.task))
  const completionBase = settled.filter(row => COMPLETION_BASE.has(row.task.status)).length
  const countOf = status => settled.filter(row => row.task.status === status).length
  const durations = rows.map(row => row.occupied).filter(Number.isFinite)
  const activity = rows.reduce((latest, row) => Math.max(latest, row.activity ?? 0), 0)
  return {
    ...extra,
    dispatched: rows.length,
    running: current.filter(row => row.task.status === 'running').length,
    queued: current.filter(row => row.task.status === 'queued').length,
    settled: settled.length,
    done: countOf('done'),
    failed: countOf('failed'),
    blocked: countOf('blocked'),
    interrupted: countOf('interrupted'),
    cancelled: countOf('cancelled'),
    // 与 summary.outcome 同一个口径：取消不进分母。
    completionRate: ratio(countOf('done'), completionBase),
    medianOccupiedMs: median(durations),
    savedMs: parallelOf(rows).savedMs,
    // 没有任何可解析时间时为 null（不编造「现在」）。
    lastActivityAt: activity > 0 ? new Date(activity).toISOString() : null,
  }
}

/**
 * 按天趋势（plans/09 §五.2 趋势区）。
 *
 * 字段与 plans/09 §六.1 的 `daily` **逐字对齐**。只为有事实的天产生一行：
 * 空天由前端按窗口补齐，Host 不编造 0——「这天没有任务」与「这天数据丢了」
 * 在图上必须是两件事。
 */
function dailyOf(createdTasks, settledRows) {
  /** @type {Map<string, {created: number, done: number, failed: number, blocked: number, interrupted: number, durations: number[], rows: object[]}>} */
  const days = new Map()
  const bucket = day => {
    if (!days.has(day)) {
      days.set(day, { created: 0, done: 0, failed: 0, blocked: 0, interrupted: 0, durations: [], rows: [] })
    }
    return days.get(day)
  }
  // 天键统一用 UTC：宿主可能跨时区部署，而「按天」的边界必须确定。
  // 用本地时区会让同一份账本在两台机器上分出不同的天。
  const dayOf = at => new Date(at).toISOString().slice(0, 10)

  for (const task of createdTasks) {
    const at = timeOf(task?.createdAt)
    if (!Number.isFinite(at)) continue
    bucket(dayOf(at)).created += 1
  }
  for (const row of settledRows) {
    if (!Number.isFinite(row.settledAt)) continue
    const entry = bucket(dayOf(row.settledAt))
    if (row.task.status in entry && typeof entry[row.task.status] === 'number') {
      entry[row.task.status] += 1
    }
    if (Number.isFinite(row.occupied)) entry.durations.push(row.occupied)
    entry.rows.push(row)
  }

  return [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, entry]) => ({
      day,
      created: entry.created,
      done: entry.done,
      failed: entry.failed,
      blocked: entry.blocked,
      interrupted: entry.interrupted,
      medianDuration: entry.durations.length ? median(entry.durations) : null,
      // 单日并行节省只在这天自己的结算任务里算，不跨天借数据。
      saved: parallelOf(entry.rows).savedMs,
    }))
}

/** 按某个键把行分组（跳过空键）。 */
function groupBy(rows, keyOf) {
  const map = new Map()
  for (const row of rows) {
    const key = keyOf(row.task)
    if (key === undefined || key === null || key === '') continue
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  return map
}

/** 组内第一个非空标题；用于工作区 id → 标题。 */
function titleOf(rows, field) {
  for (const row of rows) {
    const value = row.task?.[field]
    if (typeof value === 'string' && value) return value
  }
  return null
}

/**
 * 工作区分组——**两个维度各一份**（plans/09 §三.3）。
 *
 * `byTarget` 读 `workspaceId`（用户把任务派向哪里，总览筛选继续沿用它）；
 * `byHost` 读 `hostWorkspaceId`（子会话实际挂在哪个工作区）。
 * 合成一份的代价：没有派发目标的任务会与「派到某工作区」的任务混在同一行，
 * 而它们解释的是两件不同的事。`dimension` 原样给出两个字段名，让表头能
 * 如实写明当前口径，而不是靠回忆。
 */
function workspacesOf(rows) {
  const byTarget = [...groupBy(rows, task => task?.workspaceId)]
    .map(([id, members]) => groupRow(members, { workspaceId: id, title: titleOf(members, 'workspaceTitle') }))
    .sort((a, b) => b.dispatched - a.dispatched)
  const byHost = [...groupBy(rows, task => task?.hostWorkspaceId)]
    .map(([id, members]) => groupRow(members, { hostWorkspaceId: id, title: titleOf(members, 'hostWorkspaceTitle') }))
    .sort((a, b) => b.dispatched - a.dispatched)
  return {
    dimension: { target: 'workspace_id', host: 'host_workspace_id' },
    byTarget,
    byHost,
  }
}

/** 状态分布：只为真实出现过的状态出行，顺序按 `STATUS_ORDER`。 */
function statusesOf(rows) {
  const counts = new Map()
  for (const row of rows) {
    const status = String(row.task?.status ?? '')
    if (!status) continue
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const order = status => {
    const index = STATUS_ORDER.indexOf(status)
    return index === -1 ? STATUS_ORDER.length : index
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count, share: ratio(count, total) }))
    .sort((a, b) => order(a.status) - order(b.status) || b.count - a.count)
}

/** 批次：进度、墙钟、完成率、并行节省、最后活动（plans/09 §五.3 批次表）。 */
function batchesOf(rows) {
  return [...groupBy(rows, task => task?.group)].map(([name, members]) => {
    const created = members.map(row => timeOf(row.task?.createdAt)).filter(Number.isFinite)
    const activity = members.map(row => row.activity).filter(Number.isFinite)
    // 批次墙钟 = max(updatedAt) - min(createdAt)；全成员已结算后 updatedAt 不再变，
    // 它自然停止增长——所以这里用 activity 而不是 now。
    const wallClockMs = created.length && activity.length
      ? Math.max(0, Math.max(...activity) - Math.min(...created))
      : null
    return groupRow(members, { group: name, total: members.length, wallClockMs })
  }).sort((a, b) => b.dispatched - a.dispatched)
}

/**
 * 账本是否处于「统计可能低估」的状态（plans/09 §三.4「不装全量」）。
 *
 * 三种来源分别记账，因为它们对结论的影响不同：
 * - `retiredDropped`：留痕本身被丢了，这部分历史**彻底不可查**，最严重；
 * - `atLedgerCap`：活表已达 `ledgerMaxTasks`，往后每条新任务都会把旧事实挤出；
 * - `durationsClamped`：有跨度被夹紧，时长分布偏小。
 *
 * 一条都没有时返回 null 而不是 `{...false}`：一个恒存在的对象会让「有没有截断」
 * 永远为真，前端就再也没法用它做条件渲染。
 */
function truncationOf(dispatch, clamped) {
  const maxTasks = Number(dispatch?.config?.ledgerMaxTasks)
  const cap = Number.isFinite(maxTasks) && maxTasks > 0 ? maxTasks : null
  const live = dispatch?.table?.tasks?.size ?? 0
  const retiredDropped = Number(dispatch?.retiredDropped) || 0
  const atLedgerCap = cap !== null && live >= cap
  if (!retiredDropped && !atLedgerCap && !clamped) return null
  return {
    retiredDropped,
    atLedgerCap,
    ledgerCap: cap,
    durationsClamped: clamped,
    // 给前端一句话用：任何一条成立都只能显示「结果可能低估」。
    mayUnderestimate: retiredDropped > 0 || atLedgerCap,
  }
}

/**
 * 对账本做一次完整聚合。
 *
 * @param {object} dispatch Dispatch 实例（读 `table.tasks` / `retired` / `retiredDropped` / `config`）
 * @param {{window?: string, workspaceId?: string, hostWorkspaceId?: string}} [scope]
 * @returns {object} 形状见 plans/09 §六.1
 */
export function boardStats(dispatch, scope = {}) {
  const window = normalizeWindow(scope?.window, defaultWindowDays(dispatch))
  const resolved = {
    window,
    workspaceId: scope?.workspaceId ? String(scope.workspaceId) : null,
    hostWorkspaceId: scope?.hostWorkspaceId ? String(scope.hostWorkspaceId) : null,
  }
  const parts = collect(dispatch, resolved)
  const sinceMs = window.since ? timeOf(window.since) : NaN

  // 窗口内新派的任务：派发量按 createdAt 归属（§三.2），与结算时刻是两条独立口径。
  const createdInScope = parts.tasks.filter(task => {
    if (isArchived(task)) return false
    if (resolved.workspaceId && String(task?.workspaceId ?? '') !== resolved.workspaceId) return false
    if (resolved.hostWorkspaceId && String(task?.hostWorkspaceId ?? '') !== resolved.hostWorkspaceId) return false
    return withinWindow(timeOf(task?.createdAt), sinceMs)
  })

  // 行形状只造一次：`spansOf` 解析三个时间戳，重复调用不只是多做两遍活，
  // 更容易**分叉**——某处夹紧、某处不夹紧，时长分布与并行节省就对不上。
  const settledRows = []
  const measured = []
  let clamped = 0
  for (const entry of parts.settled) {
    const span = spansOf(entry.task, entry.at)
    if (span?.clamped) clamped += 1
    const row = {
      task: entry.task,
      settledAt: entry.at,
      startedAt: timeOf(entry.task?.startedAt),
      occupied: span ? span.occupied : NaN,
      queueWait: span ? span.queueWait : NaN,
      endToEnd: span ? span.endToEnd : NaN,
      activity: activityOf(entry.task, entry.at),
    }
    settledRows.push(row)
    // 只有时间完整的已结算任务才进时长/并行分布（§四 C）。
    if (span) measured.push(row)
  }
  const currentRows = parts.current.map(task => ({
    task,
    settledAt: NaN,
    startedAt: timeOf(task?.startedAt),
    occupied: NaN,
    queueWait: NaN,
    endToEnd: NaN,
    activity: activityOf(task, NaN),
  }))
  // 分组与状态分布用「已结算 + 当前工作」的合集，保证拆解页点进来看到的
  // 任务集合与总览一致（§八.7）。
  const allRows = [...settledRows, ...currentRows]

  const outcome = outcomeOf(parts.settled.map(entry => entry.task), parts.current, window.days ?? 0, createdInScope)
  const durations = durationsOf(measured, clamped)
  const parallel = parallelOf(measured)
  const truncated = truncationOf(dispatch, clamped)
  /**
   * 「为什么这个并行节省更粗」。
   *
   * `estimated` 恒真（粗算不是工时结算），所以「还算准」与「明显更粗」必须
   * 用另一个字段区分：样本少、有回退时间基准、有被夹紧的跨度、留痕有丢失。
   * 每一条都是可核对的事实，不是形容词。把两者压成一个布尔会让人以为
   * 样本够了就精确——它不是。
   */
  const reasons = []
  if (parallel.sampleLow) reasons.push('sample-low')
  if (parts.fallbackCount) reasons.push('updatedAt-fallback')
  if (clamped) reasons.push('durations-clamped')
  if (truncated?.mayUnderestimate) reasons.push('ledger-truncated')
  if (parts.missingTimes) reasons.push('missing-times')
  parallel.degraded = reasons.length > 0
  parallel.reasons = reasons

  return {
    statsVersion: STATS_VERSION,
    generatedAt: now(),
    scope: {
      // window 与 memory.window 形状接近（key/days/since），前端不必为两处口径写两套渲染。
      window: {
        key: window.key,
        days: round2(window.days),
        since: window.since,
        ...(window.fallbackFrom ? { fallbackFrom: window.fallbackFrom } : {}),
      },
      workspaceId: resolved.workspaceId,
      hostWorkspaceId: resolved.hostWorkspaceId,
    },
    coverage: {
      // sourceTasks = 全量候选（活表 + 退休留痕）：证明统计读的是完整账本，
      // 不是 /board 那份 200 条快照（plans/09 §七 P1 与 §八.2 的验收点）。
      sourceTasks: parts.tasks.length + parts.retired.length,
      inWindow: settledRows.length + currentRows.length,
      settled: outcome.settled,
      validDurations: measured.length,
      excludedArchived: parts.excludedArchived,
      excludedRetired: parts.retiredInWindow.length,
      missingTimes: parts.missingTimes,
      truncated,
      // 扩展字段（statsVersion 允许加）：时间基准不是恒定值时必须说出来（§三.2）。
      // 混用 updatedAt 与 settledAt 的比例不可精确比较，哪怕结论方向对。
      timeBasis: parts.basisSeen.size > 1
        ? TIME_BASIS.MIXED
        : (parts.basisSeen.has(TIME_BASIS.FALLBACK) ? TIME_BASIS.FALLBACK : TIME_BASIS.SETTLED),
      fallbackCount: parts.fallbackCount,
    },
    summary: {
      outcome,
      durations,
      parallel,
      // 只看非归档任务：归档是只读冻结，它的投递/待读不再是「当前健康」。
      reliability: reliabilityOf(parts.tasks.filter(task => !isArchived(task))),
    },
    daily: dailyOf(createdInScope, settledRows),
    groups: {
      workspaces: workspacesOf(allRows),
      batches: batchesOf(allRows),
      parentSessions: [...groupBy(allRows, task => task?.parentSessionId)]
        .map(([id, members]) => groupRow(members, { parentSessionId: id }))
        .sort((a, b) => b.dispatched - a.dispatched),
      statuses: statusesOf(allRows),
      /**
       * 退休原因直接用稳定代码（cap-count / cap-days），不拿错误文本猜类别（§五.3）。
       *
       * 这里**不能**复用 `groupBy`：那个函数按 `row.task.xxx` 取值，而退休留痕
       * 是扁平记录（没有 `.task` 包装）。复用会让每一行的键都是 undefined，
       * 整张表静默变成空数组——退休了 3 条、原因分布却是空的，看起来像退休
       * 从没发生过。所以这里自己数。
       */
      retiredReasons: retiredReasons(parts.retiredInWindow),
    },
  }
}

/** 退休原因分布：按稳定代码分组计数，数量倒序（同量按代码字母序，保证可复现）。 */
function retiredReasons(records) {
  const counts = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    const reason = typeof record?.retiredReason === 'string' && record.retiredReason
      ? record.retiredReason
      : null
    if (!reason) continue
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

/**
 * 统计失败时的降级结果（plans/09 §八.10）。
 *
 * 为什么不是 500：看板每 2 秒轮询一次，一个 500 会让客户端进入「报错 → 重试 →
 * 再报错」的循环，而事实上任务列表还是好的。降级返回让总览照常按快照工作，
 * 效果区显示「统计暂不可用」。
 *
 * 形状刻意与成功结果**同构**（字段都在，值为 null/空数组），前端不需要写第二条
 * 渲染路径；`ok:false` + `degraded:true` + `reason` 是唯一的新信息。
 *
 * @param {{window?: string, workspaceId?: string, hostWorkspaceId?: string}} [scope]
 * @param {unknown} error
 */
export function degradedStats(scope = {}, error) {
  const window = normalizeWindow(scope?.window, 7)
  return {
    statsVersion: STATS_VERSION,
    generatedAt: now(),
    ok: false,
    degraded: true,
    reason: String(error?.message ?? error ?? '统计聚合失败'),
    scope: {
      window: { key: window.key, days: round2(window.days), since: window.since },
      workspaceId: scope?.workspaceId ? String(scope.workspaceId) : null,
      hostWorkspaceId: scope?.hostWorkspaceId ? String(scope.hostWorkspaceId) : null,
    },
    coverage: {
      sourceTasks: 0,
      inWindow: 0,
      settled: 0,
      validDurations: 0,
      excludedArchived: 0,
      excludedRetired: 0,
      missingTimes: 0,
      truncated: null,
      timeBasis: null,
      fallbackCount: 0,
    },
    // summary 给 null：失败时任何数字都不可信，给一个空对象会被读成「全是 0」。
    summary: null,
    // daily / groups 给空容器而不是 null：客户端对它们的循环可以无条件写。
    daily: [],
    groups: {
      workspaces: { dimension: { target: 'workspace_id', host: 'host_workspace_id' }, byTarget: [], byHost: [] },
      batches: [],
      parentSessions: [],
      statuses: [],
      retiredReasons: [],
    },
  }
}
