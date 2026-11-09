/**
 * 分析数据看板的 Host 半边：对**完整账本**做一次带筛选的聚合。
 *
 * 与 `src/stats.js` 的分工（两条路由都不是每 2 秒轮询的快照）：
 * - `/board/stats` 服务既有的「效果 / 拆解」视图，口径固定在 plans/09：
 *   按**结算时刻**归属窗口、归档与退休不进效果指标、时间窗不隐藏当前工作；
 * - `/board/analytics` 服务新加的「分析看板」，口径是**队列视角**：
 *   按 `createdAt` 选出「这段时间派出的任务」，这一批任务的总量、状态、
 *   完成率、超时与趋势全部基于同一批行，不做第二次过滤。
 *
 * 两套口径**刻意不同**，界面各自写明分母，绝不互相复用对方的中间结果。
 * 相同的是三条底线：读完整账本（不受 `/board` 的 200 条上限影响）、
 * n=0 给 null 而不是 0、失败降级成同构结构而不是 500。
 *
 * 纯函数，不读盘、不发网络：`test/analytics.test.js` 直接调它。
 */
import { COMPLETION_BASE, SETTLED, STATUS_ORDER, TIME_BASIS, now } from './constants.js'
import {
  SAMPLE_LOW_BELOW, defaultWindowDays, inWindow, normalizeWindow, settleTimeOf,
} from './stats.js'

/** 契约版本；客户端只用它排障，不按它分支渲染。 */
export const ANALYTICS_VERSION = 1

/** 「不筛这个维度」的取值。 */
export const ANALYTICS_ALL = 'all'

/** 缺字段的显式取值：不能与空串混用，否则「没填」和「不筛」长得一样。 */
export const ANALYTICS_UNKNOWN = '__unknown__'

/** 超时代理指标的默认阈值（小时）。业务没有 SLA 字段，所以由用户可调。 */
export const OVERDUE_DEFAULT_HOURS = 24
const OVERDUE_MIN_HOURS = 1
const OVERDUE_MAX_HOURS = 24 * 30

/** 趋势最多铺多少个自然日：`all` 窗口也不能无上限地造空天。 */
const MAX_TREND_DAYS = 366

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** 可解析的时间戳（毫秒）；null / 垃圾一律 NaN，由调用方决定怎么算「不知道」。 */
function timeOf(value) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : NaN
}

/** 0..1 的比值，保留 4 位小数；分母为 0 时返回 null（不是 0）。 */
function ratio(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null
  return Math.round((part / whole) * 10_000) / 10_000
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

/** UTC 自然日；跨时区部署时「按天」的边界必须确定，不能用本地时区。 */
function dayKey(atMs) {
  return new Date(atMs).toISOString().slice(0, 10)
}

function dayMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`)
}

/** 查询参数统一收窄：只取前 cap 个字符，避免把任意长字符串带进账本比较。 */
function text(raw, cap = 120) {
  if (raw === undefined || raw === null) return ''
  return String(raw).trim().slice(0, cap)
}

/** 逗号分隔的状态串 → 去空、去重、去 `all` 后的数组。 */
function statusListOf(raw) {
  const list = text(raw, 240).split(',').map(item => item.trim()).filter(Boolean)
  const unique = [...new Set(list)].filter(item => item !== ANALYTICS_ALL)
  return unique
}

function overdueHoursOf(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return OVERDUE_DEFAULT_HOURS
  return Math.min(OVERDUE_MAX_HOURS, Math.max(OVERDUE_MIN_HOURS, Math.round(value)))
}

/**
 * 把 HTTP 查询参数归一成一份**可回显**的口径。
 *
 * 非法值不抛错也不静默：`warnings` 里留一个稳定代码，界面能说「已退回默认值」，
 * 而不是让人盯着一个自己没选过的窗口怀疑缓存。
 */
export function normalizeAnalyticsScope(raw = {}, dispatch) {
  const window = normalizeWindow(raw.window, defaultWindowDays(dispatch))
  const warnings = []
  if (window.fallbackFrom) warnings.push('invalid-window')

  const statuses = statusListOf(raw.status)
  const optional = key => {
    const value = text(raw[key])
    return value && value !== ANALYTICS_ALL ? value : null
  }
  const overdueRaw = raw.overdueHours
  const overdueHours = overdueHoursOf(overdueRaw)
  if (overdueRaw !== undefined && overdueRaw !== null && String(overdueRaw).trim() !== ''
      && Number(overdueRaw) !== overdueHours) warnings.push('invalid-overdue-hours')

  return {
    window: {
      key: window.key,
      days: round2(window.days),
      since: window.since,
      ...(window.fallbackFrom ? { fallbackFrom: window.fallbackFrom } : {}),
    },
    status: statuses.length ? statuses.join(',') : ANALYTICS_ALL,
    statusList: statuses,
    owner: optional('owner'),
    ownerField: 'parentSessionId',
    workspaceId: optional('workspaceId'),
    hostWorkspaceId: optional('hostWorkspaceId'),
    group: optional('group'),
    overdueHours,
    timeField: 'createdAt',
    warnings,
  }
}

/** 负责人代理键：账本没有人员字段，用派发主会话 id（缺失时显式归到 unknown）。 */
function ownerKeyOf(task) {
  const value = task?.parentSessionId
  return value === undefined || value === null || String(value) === '' ? ANALYTICS_UNKNOWN : String(value)
}

/**
 * 工作区维度的键：缺失与空串**统一**归到「未标注」。
 *
 * 为什么必须归一：facet 造候选值时用的是 `String(id ?? '') || ANALYTICS_UNKNOWN`，
 * 而匹配时用的是 `String(id ?? '') !== scope.workspaceId`——空串与 `__unknown__`
 * 是两个值。于是「未标注」这个选项永远筛不出任何东西（实测 selected 后
 * matched=0，期望 1）：候选值说它是未标注，匹配说它不是。
 *
 * facet 与匹配现在共用这一个函数，一个值只有一个写法。
 */
function workspaceKeyOf(task, field) {
  const value = task?.[field]
  const text = value === undefined || value === null ? '' : String(value)
  return text || ANALYTICS_UNKNOWN
}

/** 只有工作区/状态/负责人/批次这些**非时间**条件，供上一窗口对比复用。 */
function matchesNonTime(task, scope) {
  if (scope.statusList.length && !scope.statusList.includes(String(task?.status ?? ''))) return false
  if (scope.owner && ownerKeyOf(task) !== scope.owner) return false
  if (scope.workspaceId && workspaceKeyOf(task, 'workspaceId') !== scope.workspaceId) return false
  if (scope.hostWorkspaceId && workspaceKeyOf(task, 'hostWorkspaceId') !== scope.hostWorkspaceId) return false
  if (scope.group && String(task?.group ?? '') !== scope.group) return false
  return true
}

/** 时间条件：窗口按 `createdAt` 归属；`all` 时连缺创建时间的行也收进来。 */
function matchesTime(task, scope, sinceMs, allWindow) {
  if (allWindow) return true
  return inWindow(timeOf(task?.createdAt), sinceMs)
}

/** 一个维度的候选值（从**未筛选**的全量账本取，否则选一个筛选项会让其它选项消失）。 */
function facetOf(tasks, keyOf, titleOf) {
  const counts = new Map()
  for (const task of tasks) {
    const id = keyOf(task)
    if (id === null || id === undefined || id === '') continue
    const entry = counts.get(id) ?? { id, title: null, count: 0 }
    entry.count += 1
    if (entry.title === null) entry.title = titleOf(task)
    counts.set(id, entry)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id)))
}

/** 状态分布：只为真实出现过的状态出行，顺序按全局 STATUS_ORDER。 */
function distributionOf(tasks) {
  const counts = new Map()
  for (const task of tasks) {
    const status = String(task?.status ?? '')
    if (!status) continue
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const order = status => {
    const index = STATUS_ORDER.indexOf(status)
    return index === -1 ? STATUS_ORDER.length : index
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count, share: ratio(count, tasks.length) }))
    .sort((a, b) => order(a.status) - order(b.status) || b.count - a.count)
}

/**
 * 超时代理指标。
 *
 * **账本里没有 `due_at` / SLA 字段**（见 dispatch.js 的 task 形状），所以这里不假装
 * 能算「逾期」。能诚实算的只有两件事实：未结算的任务从创建到现在已经放了多久，
 * 已结算的任务从创建到结算走了多久。阈值由界面给定、回显在结果里。
 * `pendingFields: ['due_at']` 是给未来接真实截止时间时留的插槽，不是现在的结论。
 */
function overdueOf(tasks, hours, generatedMs) {
  const thresholdMs = hours * HOUR_MS
  let open = 0
  let settled = 0
  let unknown = 0
  for (const task of tasks) {
    const created = timeOf(task?.createdAt)
    if (!Number.isFinite(created)) { unknown += 1; continue }
    if (!SETTLED.has(task?.status)) {
      if (generatedMs - created > thresholdMs) open += 1
      continue
    }
    const { at } = settleTimeOf(task)
    if (!Number.isFinite(at)) { unknown += 1; continue }
    if (at - created > thresholdMs) settled += 1
  }
  const total = open + settled
  return {
    thresholdHours: hours,
    basis: 'proxy:createdAt',
    dueAtAvailable: false,
    pendingFields: ['due_at'],
    open,
    settled,
    unknown,
    total,
    rate: ratio(total, tasks.length),
  }
}

/** 一个队列（按创建时间切出来的一批任务）的三项读数，供环比使用。 */
function cohortOf(tasks) {
  const done = tasks.filter(task => task?.status === 'done').length
  const base = tasks.filter(task => COMPLETION_BASE.has(task?.status)).length
  return { created: tasks.length, done, base, completionRate: ratio(done, base) }
}

/**
 * 按天趋势。
 *
 * 只为**有事实的天**出行（与 stats.js 一致）：空天由客户端按 `range` 补 0，
 * Host 不把「这天没有任务」和「这天的数据丢了」写成同一个形状。
 * `新建` 按 `createdAt`、`完成/异常` 按权威结算时刻归属，跨天结算会落到另一天——
 * 这是口径，不是误差，界面上要写出来。
 */
function trendOf(matched, scope, generatedMs) {
  const sinceMs = scope.window.since ? timeOf(scope.window.since) : NaN
  const allWindow = scope.window.key === 'all' || !Number.isFinite(sinceMs)
  const facts = new Map()
  const bucket = day => {
    if (!facts.has(day)) {
      facts.set(day, { day, created: 0, done: 0, failed: 0, blocked: 0, interrupted: 0, cancelled: 0, ended: 0, settled: 0 })
    }
    return facts.get(day)
  }
  let earliest = generatedMs
  let latest = generatedMs
  let missingSettledAt = 0
  let fallbackCount = 0

  for (const task of matched) {
    const created = timeOf(task?.createdAt)
    if (Number.isFinite(created)) {
      bucket(dayKey(created)).created += 1
      earliest = Math.min(earliest, created)
      latest = Math.max(latest, created)
    }
    /**
     * 缺 `createdAt` 的行**不在这里数**：有窗口时它们已经被时间条件剔掉了，
     * 在这里数永远是 0。计数放在 `analyticsSnapshot()` 里、时间过滤**之前**做，
     * 那一份才看得见被剔掉的那些行（详见那里的 `missingCreatedAt`）。
     */

    if (!SETTLED.has(task?.status)) continue
    const { at, basis } = settleTimeOf(task)
    if (basis === TIME_BASIS.FALLBACK) fallbackCount += 1
    if (!Number.isFinite(at)) { missingSettledAt += 1; continue }
    const entry = bucket(dayKey(at))
    if (task.status in entry && typeof entry[task.status] === 'number') entry[task.status] += 1
    entry.settled += 1
    earliest = Math.min(earliest, at)
    latest = Math.max(latest, at)
  }

  let from = allWindow ? dayKey(earliest) : dayKey(sinceMs)
  let to = dayKey(Math.max(generatedMs, latest))
  // `all` 且账本很老：把范围夹到最近 MAX_TREND_DAYS 天，并在 coverage 里说明。
  let clamped = false
  const span = Math.floor((dayMs(to) - dayMs(from)) / DAY_MS) + 1
  if (span > MAX_TREND_DAYS) {
    from = dayKey(dayMs(to) - (MAX_TREND_DAYS - 1) * DAY_MS)
    clamped = true
  }
  const days = [...facts.values()]
    .filter(entry => entry.day >= from && entry.day <= to)
    .sort((a, b) => a.day.localeCompare(b.day))
  return {
    days,
    range: { from, to, days: Math.floor((dayMs(to) - dayMs(from)) / DAY_MS) + 1 },
    clamped,
    missingSettledAt,
    fallbackCount,
  }
}

/** 账本是否可能低估：活表触顶、留痕被丢过。 */
function truncationOf(dispatch) {
  const capRaw = Number(dispatch?.config?.ledgerMaxTasks)
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : null
  const live = dispatch?.table?.tasks?.size ?? 0
  const retiredDropped = Number(dispatch?.retiredDropped) || 0
  const atLedgerCap = cap !== null && live >= cap
  if (!retiredDropped && !atLedgerCap) return null
  return { retiredDropped, atLedgerCap, ledgerCap: cap, mayUnderestimate: retiredDropped > 0 || atLedgerCap }
}

/**
 * 对账本做一次完整聚合。
 *
 * @param {object} dispatch Dispatch 实例（读 `table.tasks` / `retired` / `config`）
 * @param {{window?:string,status?:string,owner?:string,workspaceId?:string,
 *          hostWorkspaceId?:string,group?:string,overdueHours?:number|string}} [raw]
 */
export function analyticsSnapshot(dispatch, raw = {}) {
  const scope = normalizeAnalyticsScope(raw, dispatch)
  const generatedAt = now()
  const generatedMs = Date.parse(generatedAt)
  const sinceMs = scope.window.since ? timeOf(scope.window.since) : NaN
  const allWindow = scope.window.key === 'all' || !Number.isFinite(sinceMs)
  const all = [...(dispatch?.table?.tasks?.values?.() ?? [])]
  const retired = [...(dispatch?.retired?.values?.() ?? [])]

  const timeMatched = all.filter(task => matchesTime(task, scope, sinceMs, allWindow))
  const matched = timeMatched.filter(task => matchesNonTime(task, scope))
  /**
   * 缺 `createdAt` 的行**在时间过滤之前**数。
   *
   * 为什么：`matchesTime()` 在有窗口时把没有创建时间的行全部剔掉（`inWindow(NaN)` 为假），
   * 于是它们从分母里消失——而 `coverage.missingCreatedAt` 是在**剔掉之后**数的，
   * 恒为 0（实测 sourceTasks=2 / inWindow=1 / missing=0）。
   * 一条真实任务就这样从「缺时间 n」里也消失了，读者根本不知道分母少了几条。
   *
   * 口径：过了**非时间**筛选、但没有创建时间的行数。它们可能落在窗口里也可能不，
   * 但「无法证明」这件事必须报出来，而不是让它们悄悄蒸发。
   */
  const missingCreatedAt = all.filter(task => matchesNonTime(task, scope)
    && !Number.isFinite(timeOf(task?.createdAt))).length

  const facets = {
    statuses: facetOf(all, task => String(task?.status ?? ''), () => null)
      .sort((a, b) => {
        const ai = STATUS_ORDER.indexOf(a.id)
        const bi = STATUS_ORDER.indexOf(b.id)
        return (ai === -1 ? STATUS_ORDER.length : ai) - (bi === -1 ? STATUS_ORDER.length : bi)
      }),
    owners: facetOf(all, ownerKeyOf, task => task?.parentSessionTitle ?? null),
    workspaces: facetOf(all, task => workspaceKeyOf(task, 'workspaceId'),
      task => task?.workspaceTitle ?? null),
    hostWorkspaces: facetOf(all, task => workspaceKeyOf(task, 'hostWorkspaceId'),
      task => task?.hostWorkspaceTitle ?? null),
    groups: facetOf(all, task => String(task?.group ?? ''), () => null),
  }

  const distribution = distributionOf(matched)
  const byStatus = Object.fromEntries(distribution.map(row => [row.status, row.count]))
  const done = matched.filter(task => task?.status === 'done').length
  const base = matched.filter(task => COMPLETION_BASE.has(task?.status)).length
  const settledCount = matched.filter(task => SETTLED.has(task?.status)).length
  const trend = trendOf(matched, scope, generatedMs)
  const overdue = overdueOf(matched, scope.overdueHours, generatedMs)
  const truncated = truncationOf(dispatch)

  const warnings = [...scope.warnings]
  if (missingCreatedAt || trend.missingSettledAt) warnings.push('missing-times')
  if (trend.fallbackCount) warnings.push('updatedAt-fallback')
  if (trend.clamped) warnings.push('trend-clamped')
  if (truncated?.mayUnderestimate) warnings.push('ledger-truncated')
  warnings.push('owner-proxy', 'due-at-proxy')

  /**
   * 环比：上一个**等长**窗口、套同样的非时间筛选、同样按创建时间切队列。
   * `all` 没有「上一个窗口」，给 available:false 而不是编一个 0 出来。
   */
  let compare = { available: false, reason: 'all-window' }
  if (!allWindow && Number.isFinite(scope.window.days) && scope.window.days > 0) {
    const previousSince = sinceMs - scope.window.days * DAY_MS
    const previous = all.filter(task => {
      const created = timeOf(task?.createdAt)
      return Number.isFinite(created) && created >= previousSince && created < sinceMs
        && matchesNonTime(task, scope)
    })
    const current = cohortOf(matched)
    const prior = cohortOf(previous)
    compare = {
      available: true,
      previousRange: { from: new Date(previousSince).toISOString(), until: new Date(sinceMs).toISOString() },
      current,
      previous: prior,
      createdDelta: current.created - prior.created,
      doneDelta: current.done - prior.done,
      rateDelta: current.completionRate !== null && prior.completionRate !== null
        ? Math.round((current.completionRate - prior.completionRate) * 10_000) / 10_000
        : null,
    }
  }

  return {
    analyticsVersion: ANALYTICS_VERSION,
    generatedAt,
    ok: true,
    scope,
    facets,
    coverage: {
      // sourceTasks 证明读的是完整账本，不是 /board 那份 200 条快照。
      sourceTasks: all.length,
      retiredTraces: retired.length,
      inWindow: timeMatched.length,
      matched: matched.length,
      excludedByFilters: timeMatched.length - matched.length,
      archived: matched.filter(task => Boolean(task?.archivedAt)).length,
      missingCreatedAt,
      missingSettledAt: trend.missingSettledAt,
      fallbackTimeBasis: trend.fallbackCount,
      trendClamped: trend.clamped,
      // 样本门槛复用 `SAMPLE_LOW_BELOW`（stats.js 的那一份），不在这儿另写一个 5。
      // 两个视图各写一个门槛，改了一处就出现「总览说样本够、拆解说样本少」。
      sampleLow: base > 0 && base < SAMPLE_LOW_BELOW,
      truncated,
    },
    summary: {
      total: matched.length,
      active: matched.length - settledCount,
      settled: settledCount,
      archived: matched.filter(task => Boolean(task?.archivedAt)).length,
      cancelled: matched.filter(task => task?.status === 'cancelled').length,
      byStatus,
      distribution,
      completion: {
        done,
        base,
        rate: ratio(done, base),
        sampleLow: base > 0 && base < SAMPLE_LOW_BELOW,
        // 分子分母与排除项都回显，界面上每个比例都能追到账本。
        includes: [...COMPLETION_BASE],
        excludes: [...STATUS_ORDER].filter(status => !COMPLETION_BASE.has(status)),
      },
      overdue,
    },
    trend: {
      days: trend.days,
      range: trend.range,
      compare,
    },
    warnings: [...new Set(warnings)],
  }
}

/**
 * 降级结构：与成功结果同构，客户端不需要第二条渲染路径。
 *
 * `dispatch` 只用来取默认窗口（与成功路径同一个来源 `defaultWindowDays`）；
 * 缺省时退回 7 天。
 */
export function degradedAnalytics(raw = {}, error, dispatch) {
  const scope = normalizeAnalyticsScope(raw, dispatch)
  return {
    analyticsVersion: ANALYTICS_VERSION,
    generatedAt: now(),
    ok: false,
    degraded: true,
    reason: String(error?.message ?? error ?? '分析数据聚合失败'),
    scope,
    facets: { statuses: [], owners: [], workspaces: [], hostWorkspaces: [], groups: [] },
    coverage: {
      sourceTasks: 0, retiredTraces: 0, inWindow: 0, matched: 0, excludedByFilters: 0,
      archived: 0, missingCreatedAt: 0, missingSettledAt: 0, fallbackTimeBasis: 0,
      trendClamped: false, sampleLow: false, truncated: null,
    },
    // 失败时任何数字都不可信：给 null，不给「全是 0」。
    summary: null,
    trend: { days: [], range: null, compare: { available: false, reason: 'degraded' } },
    warnings: ['degraded'],
  }
}
