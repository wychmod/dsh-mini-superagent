/**
 * 看板统计口径（plans/09 P0）的**独立**回归测试。
 *
 * 这个文件不重复已有用例：`test/tasks.test.js` 守纯逻辑（并发位/队列/等待）、
 * `test/board.test.js` 守快照投影、`test/memory.test.js` 守记忆治理。它只回答一件事：
 * **`settledAt` 与 `boardStats` 的每条口径，在真实代码上有没有可验证的读数**。
 *
 * 逐条对应 plans/09 §七 P0 验收与 §八 的边界清单：
 * - §八.1 同源：同一批任务的完成数与完成率只有一份算法（summary / groups 一致）；
 * - §八.2 全量：1000 条任务时统计按完整账本算，不受 `/board` 的 200 条快照上限影响；
 * - §八.3 边界：窗口起点恰好相等、跨天、缺 startedAt / settledAt 都有确定结果；
 * - §八.4 不混淆：取消不进完成率分母；目标工作区与实际归属不混用；
 * - §八.5 不投票：归档与退休不进效果指标，但仍在 coverage 里可见；
 * - §八.6 不装全量：n=0 显示 null；1≤n<5 带 sampleLow；时间未知单独计数；
 * - §八.10 可回退：统计抛错时降级返回同构结构，而不是 500。
 *
 * 时间类断言一律直接改任务字段，不等真实定时器；不联网、不碰真实 `~/.dsh`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPLETION_BASE, SETTLED, STATS_VERSION, TIME_BASIS,
} from '../src/constants.js'
import { boardTask, createBoardHandler } from '../src/board.js'
import {
  boardStats, degradedStats, inWindow, median, normalizeWindow, quantile, settleTimeOf,
} from '../src/stats.js'
import { TaskTable } from '../src/tasks.js'

// ---------------------------------------------------------------- 夹具

/**
 * 时间基准**相对真实 now**，而不是写死一个绝对时刻。
 *
 * 为什么不能用固定日期：窗口（`24h` / `7d`）是相对「现在」算的。写死
 * `2026-03-10` 之后，只要今天不是那天，所有带窗口的断言都会因为「数据全在窗口外」
 * 而失败——那种失败看起来像代码坏了，其实只是夹具过期了。基准相对 now，
 * 用例就永远测的是它想测的那件事。
 */
const BASE = Date.now()
/** 相对 BASE 的时间串。 */
const at = offsetMs => new Date(BASE + offsetMs).toISOString()
const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 造一条任务。
 *
 * 默认是一条「窗口内已结算的 done」：`createdAt` 前 10 分钟、`startedAt` 前 9 分钟、
 * `settledAt` 就是 BASE。窗口用 `all` 或足够宽的天数即可把它算进去。
 */
function mkTask(id, overrides = {}) {
  return {
    id,
    title: id,
    status: 'done',
    attempt: 1,
    parentSessionId: 'lead',
    workerSessionId: `dispatch-${id}`,
    createdAt: at(-10 * MINUTE),
    updatedAt: at(0),
    startedAt: at(-9 * MINUTE),
    // 权威结算时刻：默认与 updatedAt 一致，需要区分两者时显式覆盖其中一个。
    settledAt: at(0),
    reports: [],
    ...overrides,
  }
}

/**
 * 假 Dispatch：stats 只需要 `table.tasks`、`retired`、`retiredDropped`、`config`。
 * 不做任何 I/O，所以不需要真 Dispatch，也不需要临时目录。
 */
function fakeDispatch(tasks = [], { retired = [], retiredDropped = 0, config = {} } = {}) {
  return {
    table: { tasks: new Map(tasks.map(task => [task.id, task])), maxWorkers: 6 },
    retired: new Map(retired.map(record => [record.id, record])),
    retiredDropped,
    config: { memoryWindowDays: 7, ledgerMaxTasks: 1000, ...config },
  }
}

/** 造一条退休留痕。 */
function mkRetired(id, retiredAt, overrides = {}) {
  return { id, status: 'done', retiredAt, retiredReason: 'cap-count', ...overrides }
}

// ---------------------------------------------------------------- settledAt：唯一权威结算时刻

/**
 * `settle()` 是一次性事实：第二次调用不覆盖状态，也**绝不能**改写结算时刻。
 *
 * 钉的缺陷：0.8.x 各处拿 `updatedAt` 当结算时刻，而它会被报告、追问、归档巡检
 * 反复刷新。一个 3 小时前 done 的任务只要 worker 又发一条报告，看板上的完成时间
 * 就往前跳一次，「按天趋势」跟着把这条任务挪到另一天。
 */
test('settle 写 settledAt 且只写一次（重复 settle 不改时间）', async () => {
  const table = new TaskTable(4)
  const task = table.add({ id: 'a', status: 'running', reports: [] })

  assert.equal(table.settle(task, 'done'), true)
  const first = task.settledAt
  assert.ok(first, 'settle 必须写权威结算时刻')
  assert.ok(Number.isFinite(Date.parse(first)))

  // 等一会儿再结算一次：既能测「不覆盖」，也能测「时间真的没动」。
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(table.settle(task, 'cancelled'), false, '已结算的任务不能被二次结算')
  assert.equal(task.status, 'done', '状态不能被覆盖')
  assert.equal(task.settledAt, first, '结算时刻是一次性事实，不能被第二次结算改写')
})

/**
 * `transition()` 是**唯一**的状态写入口，`force: true` 的重开/强改都从这里过。
 * 只在 settle 里写 settledAt 会漏掉这条路径。
 */
test('transition 直接进终态时也写 settledAt（看板 cancel 走的就是这条路）', () => {
  const table = new TaskTable(4)
  const task = table.add({ id: 'a', status: 'running', reports: [] })

  assert.equal(table.transition(task, 'interrupted', { force: true }), true)
  assert.equal(task.status, 'interrupted')
  assert.ok(task.settledAt, '经 transition 强改进终态同样必须有权威结算时刻')
  assert.equal(task.settledAt, task.updatedAt, '同一时刻写的两个字段应当一致')

  // 再强制跃迁一次：状态变了，但结算时刻不能被改写。
  const first = task.settledAt
  table.transition(task, 'failed', { force: true })
  assert.equal(task.settledAt, first, '换一个终态不产生新的结算时刻')
})

/**
 * reopen（retry）必须清掉 settledAt：任务重新活跃之后，「结算时刻」不再存在。
 *
 * 不清的代价很具体——第二次结算时 `#markSettled` 看到旧值就什么都不写，
 * 看板会把这条任务算在**上一次**结算那一天里。
 */
test('reopen 清掉 settledAt，二次结算写的是新时刻', async () => {
  const table = new TaskTable(4)
  const task = table.add({ id: 'a', status: 'running', reports: [] })

  table.settle(task, 'done')
  const first = task.settledAt
  assert.ok(first)

  assert.equal(table.reopen(task), true, 'retry 必须能从终态重开')
  assert.equal(task.status, 'queued')
  assert.equal(task.settledAt, undefined, '重开后不能留着上一次的结算时刻')

  await new Promise(resolve => setTimeout(resolve, 15))
  table.settle(task, 'done')
  assert.ok(task.settledAt)
  assert.notEqual(task.settledAt, first, '第二次结算必须是新的时刻，而不是沿用旧的')
  assert.ok(Date.parse(task.settledAt) > Date.parse(first))
})

/**
 * 旧数据没有 settledAt：回退 updatedAt，但**必须**标出回退。
 *
 * 静默混用的代价：同一个「完成时间」在两个任务上含义不同（一个是真结算时刻，
 * 一个是最后更新时刻），而它们的差值会直接进入速度分布。
 */
test('settleTimeOf 对旧数据回退 updatedAt 并标 updatedAt-fallback', () => {
  const legacy = mkTask('old', { settledAt: undefined, updatedAt: at(-2 * HOUR) })
  const fresh = mkTask('new', { settledAt: at(-3 * HOUR), updatedAt: at(-1 * HOUR) })

  assert.equal(settleTimeOf(fresh).basis, TIME_BASIS.SETTLED)
  assert.equal(settleTimeOf(fresh).at, BASE - 3 * HOUR, '有权威字段时以它为准，不看 updatedAt')

  const fallback = settleTimeOf(legacy)
  assert.equal(fallback.basis, TIME_BASIS.FALLBACK, '回退必须可区分，不能静默混用')
  assert.equal(fallback.at, BASE - 2 * HOUR)

  // 两个时间都没有：返回 NaN + missing，而不是 0（0 = 1970 年，会污染分布）。
  const broken = settleTimeOf({ id: 'x' })
  assert.equal(broken.basis, TIME_BASIS.MISSING)
  assert.ok(Number.isNaN(broken.at), '时间未知必须是 NaN，不能是 0')
})

test('boardStats 的 coverage 报出时间基准与回退条数', () => {
  const dispatch = fakeDispatch([
    mkTask('new', { settledAt: at(-1 * HOUR) }),
    mkTask('old', { settledAt: undefined, updatedAt: at(-2 * HOUR) }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })

  assert.equal(stats.coverage.fallbackCount, 1, '一条回退')
  assert.equal(stats.coverage.timeBasis, TIME_BASIS.MIXED, '两种基准混用要说 mixed，不能报成精确')

  const uniform = boardStats(fakeDispatch([mkTask('a')]), { window: 'all' })
  assert.equal(uniform.coverage.timeBasis, TIME_BASIS.SETTLED)
  assert.equal(uniform.coverage.fallbackCount, 0)
})

// ---------------------------------------------------------------- 契约字段对齐（plans/09 §六.1）

test('boardStats 顶层字段与 plans/09 §六.1 逐字段对齐', () => {
  const stats = boardStats(fakeDispatch([mkTask('a')]), { window: 'all' })

  assert.equal(stats.statsVersion, STATS_VERSION)
  assert.ok(Number.isFinite(Date.parse(stats.generatedAt)))

  // scope：window / workspaceId / hostWorkspaceId 三个键都在。
  assert.deepEqual(Object.keys(stats.scope).sort(), ['hostWorkspaceId', 'window', 'workspaceId'])
  assert.ok(stats.scope.window.key)
  assert.ok('days' in stats.scope.window)
  assert.ok('since' in stats.scope.window)

  // coverage：§六.1 列的七个字段一个不少。
  for (const key of ['sourceTasks', 'inWindow', 'settled', 'validDurations',
    'excludedArchived', 'excludedRetired', 'missingTimes', 'truncated']) {
    assert.ok(key in stats.coverage, `coverage 缺字段 ${key}`)
  }

  // summary：四块。
  assert.deepEqual(Object.keys(stats.summary).sort(), ['durations', 'outcome', 'parallel', 'reliability'])

  // daily 的每一行字段与 §六.1 逐字一致。
  assert.ok(stats.daily.length >= 1)
  assert.deepEqual(Object.keys(stats.daily[0]).sort(), [
    'blocked', 'created', 'day', 'done', 'failed', 'interrupted', 'medianDuration', 'saved',
  ])

  // groups：五块。
  assert.deepEqual(Object.keys(stats.groups).sort(),
    ['batches', 'parentSessions', 'retiredReasons', 'statuses', 'workspaces'])
  assert.deepEqual(stats.groups.workspaces.dimension, { target: 'workspace_id', host: 'host_workspace_id' })
})

// ---------------------------------------------------------------- §八.4 不混淆：取消不进分母

/**
 * 完成率的分母是 `done+ended+failed+blocked+interrupted`，**不含取消**。
 *
 * 取消是用户主动收回，不是执行结果。算进分母等于「我今天取消了 3 个排错的任务」
 * 直接压低成功率，而那个数字随后会被当质量信号解读。
 */
test('完成率不含取消，取消率单独用「含取消」的分母', () => {
  const dispatch = fakeDispatch([
    mkTask('done1'),
    mkTask('done2'),
    mkTask('failed1', { status: 'failed' }),
    mkTask('cancelled1', { status: 'cancelled' }),
    mkTask('cancelled2', { status: 'cancelled' }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })
  const { outcome } = stats.summary

  assert.equal(outcome.settled, 5, '五条都已结算')
  assert.equal(outcome.cancelled, 2)
  assert.equal(outcome.completionBase, 3, '分母 = done 2 + failed 1，取消不进分母')
  assert.equal(outcome.completionRate, 0.6667, '2/3')
  assert.equal(outcome.cancelRate, 0.4, '取消率分母 = 全部已结算 5（含取消）')

  // 两个分母必须能被复核到。
  assert.equal(outcome.completionBase + outcome.cancelled, outcome.settled,
    '完成率分母 + 取消数 = 已结算总数，中间不能有第三种归属')
})

test('COMPLETION_BASE 与 SETTLED 的差集只有 cancelled', () => {
  const onlyInSettled = [...SETTLED].filter(status => !COMPLETION_BASE.has(status))
  assert.deepEqual(onlyInSettled, ['cancelled'],
    '两个集合的差别必须只有取消；多一个状态意味着口径漂了')
  for (const status of COMPLETION_BASE) assert.ok(SETTLED.has(status), `${status} 必须也算已结算`)
})

// ---------------------------------------------------------------- §八.3 边界：窗口起点恰好相等

/**
 * 窗口是左闭的：结算时刻**恰好等于**窗口起点时算在窗口内。
 *
 * 这是最容易两边都说得通的边界。定成「包含」是为了让「窗口起点 = 某条任务的
 * 结算时刻」这件事有确定结果——否则同一份账本在不同毫秒问一次会得到不同数字。
 */
test('窗口起点恰好相等的任务算在窗口内（左闭）', () => {
  // 直接测判据本身：这是「同一份账本在不同毫秒问一次会不会得到不同数字」的
  // 唯一决定点。构造时间戳去测「恰好等于」是不可靠的——`boardStats` 在函数内部
  // 才算 `since = now - 24h`，与断言里算的 now 差着几微秒，那条「边界」任务
  // 会随机落到起点之前（实测 6 次里有 1 次失败）。边界值由函数本身钉住。
  const since = Date.parse('2026-03-10T00:00:00.000Z')
  assert.equal(inWindow(since, since), true, '恰好等于起点必须算在窗口内')
  assert.equal(inWindow(since + 1, since), true)
  assert.equal(inWindow(since - 1, since), false, '早一毫秒就不在窗口内')
  assert.equal(inWindow(NaN, since), false, '时间未知不算在窗口内')
  assert.equal(inWindow(since - 10 * DAY, NaN), true, '没有窗口时任何可解析时间都在里面')

  // 端到端：留足余量（不贴边界），证明这套判据确实接在聚合里。
  const nowMs = Date.now()
  const stats = boardStats(fakeDispatch([
    mkTask('inside', { settledAt: new Date(nowMs - 23 * HOUR).toISOString() }),
    mkTask('outside', { settledAt: new Date(nowMs - 25 * HOUR).toISOString() }),
  ]), { window: '24h' })
  assert.equal(stats.coverage.settled, 1, '23 小时前的在窗口内，25 小时前的不在')
  assert.equal(stats.summary.outcome.done, 1)
})

test('窗口只约束统计，不隐藏当前工作（跑了 10 天也还在）', () => {
  const dispatch = fakeDispatch([
    mkTask('long-run', {
      status: 'running',
      createdAt: at(-10 * DAY),
      startedAt: at(-10 * DAY),
      settledAt: undefined,
      updatedAt: at(-1 * MINUTE),
    }),
  ])
  const stats = boardStats(dispatch, { window: '24h' })
  assert.equal(stats.coverage.inWindow, 1, '当前工作不看窗口')
  assert.equal(stats.summary.outcome.running, 1, '24h 视图里必须看到这个跑了 10 天的任务')
  assert.equal(stats.coverage.settled, 0, '但它不算已结算样本')
})

// ---------------------------------------------------------------- §八.3 跨天

test('按天聚合：跨天的结算落成两天，天键用 UTC', () => {
  // 造两天：BASE 当天 23:59:59 与 BASE 次日 00:00:01。
  // 用「当天 UTC 零点」重建，避免 BASE 本身恰好跨过午夜导致这两天并成一天。
  const midnight = Date.parse(`${new Date(BASE).toISOString().slice(0, 10)}T00:00:00.000Z`)
  const late = new Date(midnight + 23 * HOUR + 59 * MINUTE + 59 * SECOND).toISOString()
  const early = new Date(midnight + DAY + SECOND).toISOString()
  const dispatch = fakeDispatch([
    mkTask('d1', { settledAt: late, createdAt: late, startedAt: late }),
    mkTask('d2', { settledAt: early, createdAt: early, startedAt: early }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })

  assert.equal(stats.daily.length, 2, '跨午夜的两条必须落在相邻的两天')
  const days = stats.daily.map(day => day.day)
  assert.deepEqual(days, [days[0], days[1]].sort(), '按天键升序')
  assert.notEqual(days[0], days[1], '两天不能并成一天')
  assert.equal(stats.daily[0].done, 1)
  assert.equal(stats.daily[1].done, 1)
  // created 按 createdAt 归属，这里与结算同天，所以各是 1。
  assert.equal(stats.daily[0].created, 1)
  assert.equal(stats.daily[1].created, 1)
})

test('按天聚合只为有事实的天出行，不编造空天', () => {
  const day = offset => new Date(BASE + offset).toISOString()
  const dispatch = fakeDispatch([
    mkTask('a', { settledAt: day(-5 * DAY), createdAt: day(-5 * DAY), startedAt: day(-5 * DAY) }),
    mkTask('b', { settledAt: day(0), createdAt: day(0), startedAt: day(0) }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })
  assert.equal(stats.daily.length, 2,
    '中间的空档由前端补齐；宿主编造 0 会让「没任务」和「数据丢了」长得一样')
  assert.notEqual(stats.daily[0].day, stats.daily[1].day)
})

// ---------------------------------------------------------------- §八.3 缺 startedAt / settledAt

test('缺 startedAt 的任务进分母但不进时长分布', () => {
  const dispatch = fakeDispatch([
    mkTask('ok', { startedAt: at(-9 * MINUTE) }),
    mkTask('no-start', { startedAt: undefined }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })

  assert.equal(stats.coverage.settled, 2, '两条都已结算，完成率的分母必须是 2')
  assert.equal(stats.summary.outcome.done, 2)
  assert.equal(stats.coverage.validDurations, 1, '缺开始时间的那条算不出占用时长')
  assert.equal(stats.summary.durations.occupied.count, 1)
  // 差值本身就是给读者的口径证据：2 已结算 vs 1 有效耗时。
  assert.equal(stats.coverage.settled - stats.coverage.validDurations, 1)
})

test('缺 settledAt 也无 updatedAt 的任务被记成 missingTimes，不从 coverage 消失', () => {
  const dispatch = fakeDispatch([
    mkTask('ok'),
    mkTask('blind', { settledAt: undefined, updatedAt: undefined }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })

  assert.equal(stats.coverage.missingTimes, 1, '时间未知必须单独可见（§三.4）')
  assert.equal(stats.coverage.settled, 2, '没有窗口约束时它仍然进分母（时间未知不等于不在窗口内）')

  // 有窗口时无法证明它在窗口内：只计数、不进分母，但 missingTimes 仍要说出来。
  const windowed = boardStats(dispatch, { window: '24h' })
  assert.equal(windowed.coverage.missingTimes, 1)
  assert.equal(windowed.coverage.settled, 1, '只有能证明在窗口内的一条进分母')
})

// ---------------------------------------------------------------- §八.5 归档与退休不投票

test('归档任务不进任何效果指标，但在 coverage 里可见', () => {
  const dispatch = fakeDispatch([
    mkTask('live'),
    mkTask('archived', { archivedAt: at(-1 * HOUR) }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })

  assert.equal(stats.coverage.settled, 1, '归档的不能给完成率投票')
  assert.equal(stats.summary.outcome.done, 1)
  assert.equal(stats.coverage.excludedArchived, 1, '排除数必须显式可见，不能悄悄消失')
  // 归档任务也不该出现在分组与状态分布里（那是「参与本次统计」的任务集合）。
  const total = stats.groups.statuses.reduce((sum, entry) => sum + entry.count, 0)
  assert.equal(total, 1, '状态分布里只能有那一条活任务')
})

test('退休留痕只用于退休量与原因，不进效果指标', () => {
  const dispatch = fakeDispatch(
    [mkTask('live')],
    {
      retired: [
        mkRetired('r1', at(-1 * HOUR), { retiredReason: 'cap-count' }),
        mkRetired('r2', at(-2 * HOUR), { retiredReason: 'cap-days' }),
        mkRetired('r3', at(-3 * HOUR), { retiredReason: 'cap-count' }),
      ],
    },
  )
  const stats = boardStats(dispatch, { window: 'all' })

  assert.equal(stats.coverage.settled, 1, '退休任务不在活表里，不能进分母')
  assert.equal(stats.coverage.excludedRetired, 3)
  assert.equal(stats.coverage.sourceTasks, 4, 'sourceTasks = 活表 1 + 留痕 3（这是「完整账本」的证据）')
  assert.deepEqual(stats.groups.retiredReasons, [
    { reason: 'cap-count', count: 2 },
    { reason: 'cap-days', count: 1 },
  ], '退休原因直接用稳定代码，按数量倒序')
})

test('退休留痕被丢弃时 coverage.truncated 明确报出「可能低估」', () => {
  const dispatch = fakeDispatch([mkTask('a')], { retiredDropped: 7 })
  const stats = boardStats(dispatch, { window: 'all' })
  assert.ok(stats.coverage.truncated, '有丢痕就必须报 truncated，不能装作全量')
  assert.equal(stats.coverage.truncated.retiredDropped, 7)
  assert.equal(stats.coverage.truncated.mayUnderestimate, true)
})

// ---------------------------------------------------------------- §八.2 全量：1000 条不受 200 快照上限影响

/**
 * 统计必须按**完整账本**算，而不是 `/board` 那份 200 条快照。
 *
 * 这是 P0 的核心验收之一：账户里有 1000 条任务时，如果统计跟着快照走，
 * 分母会永远停在 200，完成率就成了「最近 200 条」的完成率，而界面上的
 * 文案写着「窗口内完成率」——口径与标签对不上，谁也发现不了。
 */
test('1000 条任务时统计按完整账本算，不受 /board 的 200 条上限影响', () => {
  const tasks = []
  for (let index = 0; index < 1000; index += 1) {
    // 900 done / 100 failed：一个不会被凑巧整除的比例，答错了看得出来。
    tasks.push(mkTask(`t${index}`, { status: index < 900 ? 'done' : 'failed' }))
  }
  const stats = boardStats(fakeDispatch(tasks), { window: 'all' })

  assert.equal(stats.coverage.sourceTasks, 1000)
  assert.equal(stats.coverage.settled, 1000, '分母是账本全量，不是快照的 200')
  assert.equal(stats.summary.outcome.done, 900)
  assert.equal(stats.summary.outcome.failed, 100)
  assert.equal(stats.summary.outcome.completionRate, 0.9)
  assert.equal(stats.coverage.validDurations, 1000)
})

test('sourceTasks 在带窗口时仍是全量（证明统计不依赖窗口筛选后的子集）', () => {
  const old = Array.from({ length: 30 }, (_, i) => mkTask(`old${i}`, { settledAt: at(-90 * DAY) }))
  const fresh = Array.from({ length: 5 }, (_, i) => mkTask(`fresh${i}`))
  const stats = boardStats(fakeDispatch([...old, ...fresh]), { window: '7d' })
  assert.equal(stats.coverage.sourceTasks, 35, 'sourceTasks 是候选总数，与窗口无关')
  assert.equal(stats.coverage.settled, 5, '窗口只筛分母，不改变「读了多少账本」')
})

// ---------------------------------------------------------------- §八.6 不装全量：n=0 / 样本少 / 分位数

test('n=0 时所有分布与比率是 null 而不是 0', () => {
  const stats = boardStats(fakeDispatch([]), { window: '7d' })
  const { outcome, durations, parallel } = stats.summary

  assert.equal(outcome.completionRate, null, '没有样本时完成率是 null，0% 会被读成「全失败」')
  assert.equal(outcome.cancelRate, null)
  assert.equal(outcome.throughput.perDay, null)
  assert.equal(durations.occupied.p50, null)
  assert.equal(durations.occupied.p90, null)
  assert.equal(durations.occupied.count, 0)
  assert.equal(durations.occupied.sampleLow, false, '没有样本 ≠ 样本少')
  assert.equal(durations.longTail, null)
  assert.equal(parallel.savedMs, null, '算不出来时是 null，0 会被读成「完全没省」')
  assert.equal(parallel.wallMs, null)
  assert.equal(parallel.factor, null)
  assert.deepEqual(stats.daily, [])
})

test('1≤n<5 时数值照给，但带 sampleLow', () => {
  const dispatch = fakeDispatch([mkTask('a'), mkTask('b'), mkTask('c')])
  const stats = boardStats(dispatch, { window: 'all' })
  assert.equal(stats.summary.outcome.completionRate, 1, '3 条全 done 仍然是 100%')
  assert.equal(stats.summary.outcome.sampleLow, true, '但必须标样本少，否则 100% 会被当结论')
  assert.equal(stats.summary.durations.occupied.sampleLow, true)
  assert.equal(stats.summary.parallel.sampleLow, true)
})

test('n≥5 时不再带 sampleLow', () => {
  const tasks = Array.from({ length: 5 }, (_, i) => mkTask(`t${i}`))
  const stats = boardStats(fakeDispatch(tasks), { window: 'all' })
  assert.equal(stats.summary.outcome.sampleLow, false)
  assert.equal(stats.summary.durations.occupied.sampleLow, false)
})

test('分位数按线性插值计算（P50 与 P90 都有确定值）', () => {
  // 1..10 的十个数：P50 = 5.5（索引 4.5），P90 = 9.1（索引 8.1）。
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(quantile(ten, 0.5), 5.5)
  assert.equal(quantile(ten, 0.9), 9.1)
  assert.equal(median(ten), 5.5)
  // 单元素：两个分位数都是它本身，不插值。
  assert.equal(quantile([7], 0.9), 7)
  assert.equal(quantile([], 0.5), null)
  assert.equal(median([]), null)
})

test('任务分位数：占用时长的 P50/P90 与手算一致', () => {
  // 五条任务占用 1,2,3,4,5 分钟 → P50 = 3 分钟，P90 = 4.6 分钟。
  const tasks = [1, 2, 3, 4, 5].map((minutes, index) => mkTask(`t${index}`, {
    startedAt: at(-minutes * MINUTE),
    settledAt: at(0),
  }))
  const stats = boardStats(fakeDispatch(tasks), { window: 'all' })
  const occupied = stats.summary.durations.occupied

  assert.equal(occupied.count, 5)
  assert.equal(occupied.p50, 3 * MINUTE)
  assert.equal(occupied.p90, 4.6 * MINUTE)
  // 长尾比 = P90/P50，保留两位。
  assert.equal(stats.summary.durations.longTail, 1.53)
})

// ---------------------------------------------------------------- §四 C 并行节省

test('并行节省 = max(0, Σ占用 - 墙钟跨度)', () => {
  // 三条任务都在 BASE-10min 到 BASE 之间，时长各 5/6/7 分钟，墙钟跨度 10 分钟。
  const tasks = [
    mkTask('a', { startedAt: at(-10 * MINUTE), settledAt: at(-5 * MINUTE) }),
    mkTask('b', { startedAt: at(-9 * MINUTE), settledAt: at(-3 * MINUTE) }),
    mkTask('c', { startedAt: at(-7 * MINUTE), settledAt: at(0) }),
  ]
  const parallel = boardStats(fakeDispatch(tasks), { window: 'all' }).summary.parallel

  assert.equal(parallel.occupiedMs, 5 * MINUTE + 6 * MINUTE + 7 * MINUTE)
  assert.equal(parallel.wallMs, 10 * MINUTE, '墙钟跨度 = max(settledAt) - min(startedAt)')
  assert.equal(parallel.savedMs, 18 * MINUTE - 10 * MINUTE)
  assert.equal(parallel.factor, 1.8)
  assert.equal(parallel.estimated, true, '粗算恒为估算：它不是工时结算，样本再多也一样')
  assert.equal(parallel.sampleLow, true, '3 条样本同时要标样本少')
  assert.ok(parallel.reasons.includes('sample-low'), '「为什么更粗」要能逐条读出来')
})

test('并行节省不为负：串行执行时是 0 而不是负数', () => {
  // 两条完全串行的任务：Σ占用 = 墙钟跨度，节省 = 0。
  const tasks = [
    mkTask('a', { startedAt: at(-10 * MINUTE), settledAt: at(-5 * MINUTE) }),
    mkTask('b', { startedAt: at(-5 * MINUTE), settledAt: at(0) }),
  ]
  const parallel = boardStats(fakeDispatch(tasks), { window: 'all' }).summary.parallel
  assert.equal(parallel.savedMs, 0)
  assert.equal(parallel.factor, 1)
})

test('回退基准会把并行节省标成更粗的估算', () => {
  // 五条任务（达到样本量门槛），其中一条回退到 updatedAt。
  const tasks = [
    ...Array.from({ length: 4 }, (_, i) => mkTask(`f${i}`, {
      startedAt: at(-10 * MINUTE), settledAt: at(-5 * MINUTE + i * MINUTE),
    })),
    mkTask('legacy', { settledAt: undefined, updatedAt: at(-5 * MINUTE), startedAt: at(-10 * MINUTE) }),
  ]
  const stats = boardStats(fakeDispatch(tasks), { window: 'all' })
  assert.equal(stats.summary.parallel.sampleLow, false, '五条样本不算少')
  assert.equal(stats.summary.parallel.estimated, true, '粗算恒为估算')
  assert.equal(stats.summary.parallel.degraded, true, '但回退基准让它**更粗**')
  assert.ok(stats.summary.parallel.reasons.includes('updatedAt-fallback'))

  // 全是权威时刻、无夹紧、无丢痕、样本足够：不再 degraded。
  const clean = boardStats(fakeDispatch(Array.from({ length: 5 }, (_, i) => mkTask(`c${i}`, {
    startedAt: at(-10 * MINUTE), settledAt: at(-5 * MINUTE + i * MINUTE),
  }))), { window: 'all' })
  assert.equal(clean.summary.parallel.estimated, true, 'estimated 与精确性无关，恒为 true')
  assert.equal(clean.summary.parallel.degraded, false, '干净数据不该被标成更粗')
  assert.deepEqual(clean.summary.parallel.reasons, [])
})

// ---------------------------------------------------------------- §三.3 两个工作区维度不混用

test('目标工作区与实际归属分成两份，绝不合并', () => {
  const dispatch = fakeDispatch([
    // 派到 w-1，但实际挂在 h-9（没有目标时落到日期工作区的情形）。
    mkTask('a', { workspaceId: 'w-1', workspaceTitle: '项目 A', hostWorkspaceId: 'h-9', hostWorkspaceTitle: '【派发】03-10' }),
    mkTask('b', { workspaceId: 'w-1', workspaceTitle: '项目 A', hostWorkspaceId: 'h-9', hostWorkspaceTitle: '【派发】03-10' }),
    // 没有派发目标，只有实际归属。
    mkTask('c', { hostWorkspaceId: 'h-9', hostWorkspaceTitle: '【派发】03-10' }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })

  assert.equal(stats.groups.workspaces.byTarget.length, 1)
  assert.equal(stats.groups.workspaces.byTarget[0].workspaceId, 'w-1')
  assert.equal(stats.groups.workspaces.byTarget[0].dispatched, 2, '按派发目标只能数到 2 条')

  assert.equal(stats.groups.workspaces.byHost.length, 1)
  assert.equal(stats.groups.workspaces.byHost[0].hostWorkspaceId, 'h-9')
  assert.equal(stats.groups.workspaces.byHost[0].dispatched, 3, '按实际归属要数到全部 3 条')

  // 两份结果的键必须不同，防止有人把两个数组 concat 成一个维度。
  assert.notEqual('hostWorkspaceId' in stats.groups.workspaces.byTarget[0], true)
  assert.notEqual('workspaceId' in stats.groups.workspaces.byHost[0], true)
})

test('scope.workspaceId 只按派发目标筛，scope.hostWorkspaceId 只按归属筛', () => {
  const dispatch = fakeDispatch([
    mkTask('a', { workspaceId: 'w-1', hostWorkspaceId: 'h-1' }),
    mkTask('b', { workspaceId: 'w-1', hostWorkspaceId: 'h-2' }),
  ])
  assert.equal(boardStats(dispatch, { window: 'all', workspaceId: 'w-1' }).coverage.settled, 2)
  assert.equal(boardStats(dispatch, { window: 'all', hostWorkspaceId: 'h-1' }).coverage.settled, 1)
  // 同时给 = 交集，不互相替代。
  const both = boardStats(dispatch, { window: 'all', workspaceId: 'w-1', hostWorkspaceId: 'h-1' })
  assert.equal(both.coverage.settled, 1)
  assert.equal(both.scope.workspaceId, 'w-1')
  assert.equal(both.scope.hostWorkspaceId, 'h-1')
})

// ---------------------------------------------------------------- §八.1 同源：summary 与 groups 对得上

test('summary 与 groups 的完成数一致（同一筛选条件只能有一个答案）', () => {
  const dispatch = fakeDispatch([
    mkTask('a', { parentSessionId: 's1', group: 'batch-1', workspaceId: 'w-1', hostWorkspaceId: 'h-1' }),
    mkTask('b', { parentSessionId: 's1', group: 'batch-1', workspaceId: 'w-1', hostWorkspaceId: 'h-1', status: 'failed' }),
    mkTask('c', { parentSessionId: 's2', workspaceId: 'w-2', hostWorkspaceId: 'h-1' }),
    mkTask('d', { parentSessionId: 's2', status: 'cancelled', workspaceId: 'w-2', hostWorkspaceId: 'h-1' }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })

  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0)
  assert.equal(sum(stats.groups.parentSessions, 'done'), stats.summary.outcome.done,
    '主会话表的 done 之和必须等于 summary 的完成量')
  assert.equal(sum(stats.groups.workspaces.byTarget, 'done'), stats.summary.outcome.done)
  assert.equal(sum(stats.groups.workspaces.byHost, 'done'), stats.summary.outcome.done)
  assert.equal(sum(stats.groups.parentSessions, 'cancelled'), stats.summary.outcome.cancelled)

  // 批次表的 done 之和只覆盖带 group 的那一批，但比例口径必须与 summary 一致。
  const batch = stats.groups.batches[0]
  assert.equal(batch.done, 1)
  assert.equal(batch.completionRate, 0.5, '批次内 1 done / 2 进分母 = 50%')
})

test('状态分布覆盖全部参与统计的任务（含当前工作）', () => {
  const dispatch = fakeDispatch([
    mkTask('done'),
    mkTask('running', { status: 'running', settledAt: undefined }),
    mkTask('queued', { status: 'queued', settledAt: undefined, startedAt: undefined }),
  ])
  const stats = boardStats(dispatch, { window: 'all' })
  const byStatus = Object.fromEntries(stats.groups.statuses.map(entry => [entry.status, entry.count]))
  assert.equal(byStatus.done, 1)
  assert.equal(byStatus.running, 1)
  assert.equal(byStatus.queued, 1)
  // 顺序按 STATUS_ORDER：running 在 queued 之前，queued 在 done 之前。
  assert.deepEqual(stats.groups.statuses.map(entry => entry.status), ['running', 'queued', 'done'])
})

// ---------------------------------------------------------------- 窗口归一

test('normalizeWindow 归一合法窗口，缺省沿用配置天数', () => {
  const fallback = normalizeWindow(undefined, 7)
  assert.equal(fallback.key, '7d')
  assert.equal(fallback.days, 7)
  assert.ok(Number.isFinite(Date.parse(fallback.since)))

  assert.equal(normalizeWindow('24h', 7).key, '24h')
  assert.equal(normalizeWindow('24h', 7).days, 1, '24 小时 = 1 个自然日，吞吐的分母才对')
  assert.equal(normalizeWindow('7d', 7).key, '7d')
  assert.equal(normalizeWindow('30d', 7).days, 30)
  assert.equal(normalizeWindow('all', 7).key, 'all')
  assert.equal(normalizeWindow('all', 7).days, null, '「全部」没有自然日数')
  assert.equal(normalizeWindow('all', 7).since, null)
})

test('normalizeWindow 对非法值退回默认并带上 fallbackFrom', () => {
  const result = normalizeWindow('nonsense', 7)
  assert.equal(result.key, '7d', '非法值不能决定窗口')
  assert.equal(result.fallbackFrom, 'nonsense', '必须让前端能说明「筛选条件无效」')
  assert.equal(result.requested, 'nonsense')
})

test('boardStats 的 scope.window 回显归一后的键', () => {
  const stats = boardStats(fakeDispatch([]), { window: '24h' })
  assert.equal(stats.scope.window.key, '24h')
  assert.equal(stats.scope.window.days, 1)
  assert.ok(Number.isFinite(Date.parse(stats.scope.window.since)))
})

// ---------------------------------------------------------------- §八.6 / §四 A 其它口径

test('一次完成率与重试后恢复率按 attempt 拆分，取消不进任一侧', () => {
  const dispatch = fakeDispatch([
    mkTask('first-done', { attempt: 1 }),
    mkTask('first-failed', { attempt: 1, status: 'failed' }),
    mkTask('retry-done', { attempt: 2 }),
    mkTask('retry-failed', { attempt: 3, status: 'failed' }),
    mkTask('retry-cancelled', { attempt: 2, status: 'cancelled' }),
  ])
  const { outcome } = boardStats(dispatch, { window: 'all' }).summary

  assert.equal(outcome.firstAttemptCount, 2, 'attempt=1 的已结算只有两条')
  assert.equal(outcome.firstPassRate, 0.5, '1/2')
  assert.equal(outcome.retriedCount, 2, '取消的那条不算「重试过的已结算」')
  assert.equal(outcome.recoveryRate, 0.5, '重试后 1 done / 2')
})

test('返工率的分母是窗口内派发的任务数（含还没跑的）', () => {
  const dispatch = fakeDispatch([
    mkTask('a'),
    mkTask('b', { attempt: 2 }),
    mkTask('queued', { status: 'queued', attempt: 1, settledAt: undefined, startedAt: undefined }),
  ])
  const { outcome } = boardStats(dispatch, { window: 'all' }).summary
  assert.equal(outcome.dispatched, 3, '已派发 = 窗口内 createdAt 命中的全部任务')
  assert.equal(outcome.reworkedCount, 1)
  assert.equal(outcome.reworkRate, 0.3333, '1/3')
})

test('吞吐用窗口自然日数做分母，不是「有任务的天数」', () => {
  // 30 天窗口里只有 1 天有任务：10 条 done → 10/30，而不是 10/1。
  const tasks = Array.from({ length: 10 }, (_, i) => mkTask(`t${i}`, { settledAt: at(-29 * DAY + i * SECOND) }))
  const stats = boardStats(fakeDispatch(tasks), { window: '30d' })
  assert.equal(stats.summary.outcome.throughput.done, 10)
  assert.equal(stats.summary.outcome.throughput.days, 30)
  assert.equal(stats.summary.outcome.throughput.perDay, 0.3333)
})

test('可靠性块只统计当前值，且 unknown 压过 pending', () => {
  const dispatch = fakeDispatch([
    mkTask('delivery-failed', { delivery: { outcome: 'failed' }, status: 'done' }),
    mkTask('pending', { status: 'running', settledAt: undefined, inputPendingAt: at(-MINUTE) }),
    mkTask('unknown', { status: 'running', settledAt: undefined, inputPendingAt: at(-HOUR), inputUnknownAt: at(-MINUTE) }),
    mkTask('background', { status: 'running', settledAt: undefined, background: { jobs: 1, subagents: 0, since: at(-MINUTE) } }),
    mkTask('archive-error', { status: 'done', archiveError: '会话已不存在' }),
  ])
  const { reliability } = boardStats(dispatch, { window: '7d' }).summary

  assert.equal(reliability.undeliveredReports, 1)
  assert.equal(reliability.inputPending, 1, 'unknown 的那条不能再算 pending（与 card() 判据一致）')
  assert.equal(reliability.inputUnknown, 1)
  assert.equal(reliability.background, 1)
  assert.equal(reliability.archiveErrors, 1)
})

// ---------------------------------------------------------------- 降级（§八.10）

/**
 * 统计失败时**不能** 500：看板每 2 秒轮询，一个 500 会让客户端进入
 * 「报错→重试→再报错」的循环，而任务列表其实还是好的。
 */
test('degradedStats 与成功结果同构，只是 summary 为 null 并带原因', () => {
  const stats = degradedStats({ window: '24h', workspaceId: 'w-1' }, new Error('聚合炸了'))

  assert.equal(stats.ok, false)
  assert.equal(stats.degraded, true)
  assert.equal(stats.reason, '聚合炸了')
  assert.equal(stats.statsVersion, STATS_VERSION)
  assert.equal(stats.summary, null, '失败时任何数字都不可信，给空对象会被读成「全是 0」')

  // 结构必须与成功时一致，前端不用写第二条渲染路径。
  assert.deepEqual(Object.keys(stats).sort(), [
    'coverage', 'daily', 'degraded', 'generatedAt', 'groups', 'ok', 'reason', 'scope', 'statsVersion', 'summary',
  ])
  assert.deepEqual(stats.daily, [])
  assert.deepEqual(stats.groups.workspaces.byTarget, [])
  assert.equal(stats.scope.window.key, '24h')
  assert.equal(stats.scope.workspaceId, 'w-1')
})

test('degradedStats 在没有 scope 时也给出完整形状', () => {
  const stats = degradedStats()
  assert.equal(stats.degraded, true)
  assert.equal(stats.scope.workspaceId, null)
  assert.equal(stats.scope.hostWorkspaceId, null)
  assert.ok(stats.coverage)
})

// ---------------------------------------------------------------- HTTP 路由（GET /board/stats）

/** 假的 IncomingMessage：够路由用（headers + url + 无请求体）。 */
function fakeReq({ method = 'GET', url = '/dsh-mini-superagent/board/stats', headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:11586', ...headers },
    on() { return this },
    destroy() {},
  }
}

/** 假的 ServerResponse：捕获 status / headers / body。 */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(payload) { this.body = payload ?? '' },
  }
}

/** 跑一次请求，返回解析后的结果。 */
async function call(handler, options) {
  const res = fakeRes()
  await handler(fakeReq(options), res)
  return { status: res.status, headers: res.headers, json: res.body ? JSON.parse(res.body) : undefined }
}

/** 建一个能过 readAllowed 的 handler：dispatch 只需要 stats 依赖的那几个字段。 */
function handlerFor(dispatch) {
  const ctx = { logger: { info() {}, warn() {} } }
  return createBoardHandler(ctx, dispatch)
}

test('GET /board/stats 返回真实 JSON 且不缓存', async () => {
  const dispatch = fakeDispatch([mkTask('a'), mkTask('b', { status: 'failed' })])
  const handler = handlerFor(dispatch)

  const result = await call(handler, {})
  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.json.statsVersion, STATS_VERSION)
  assert.equal(result.json.summary.outcome.settled, 2, '真实聚合，不是空壳')
  assert.ok(result.json.coverage)
})

test('GET /board/stats 支持 window / workspaceId 两个查询参数', async () => {
  const dispatch = fakeDispatch([
    mkTask('a', { workspaceId: 'w-1' }),
    mkTask('old', { workspaceId: 'w-1', settledAt: at(-90 * DAY), createdAt: at(-90 * DAY) }),
    mkTask('other-ws', { workspaceId: 'w-2' }),
  ])
  const handler = handlerFor(dispatch)

  const wide = await call(handler, { url: '/dsh-mini-superagent/board/stats?window=all' })
  assert.equal(wide.json.coverage.settled, 3)

  const narrow = await call(handler, {
    url: '/dsh-mini-superagent/board/stats?window=7d&workspaceId=w-1',
  })
  assert.equal(narrow.json.coverage.settled, 1, '7d 窗口 + w-1 只留下那条新任务')
  assert.equal(narrow.json.scope.workspaceId, 'w-1')
  assert.equal(narrow.json.scope.window.key, '7d')
})

test('GET /board/stats 聚合抛错时降级返回 200，不把看板拖垮', async () => {
  // 让 table.tasks 的迭代抛错：模拟账本损坏这类真实故障。
  const broken = {
    table: {
      get tasks() { throw new Error('账本读取失败') },
      size: 0,
    },
    retired: new Map(),
    config: { memoryWindowDays: 7 },
  }
  const handler = handlerFor(broken)

  const result = await call(handler, { url: '/dsh-mini-superagent/board/stats?window=24h' })
  assert.equal(result.status, 200, '不能 500：轮询会进入报错循环')
  assert.equal(result.json.degraded, true)
  assert.equal(result.json.ok, false)
  assert.match(result.json.reason, /账本读取失败/)
  // 结构仍然完整，客户端不用写第二条渲染路径。
  assert.equal(result.json.summary, null)
  assert.deepEqual(result.json.daily, [])
  assert.deepEqual(result.json.groups.statuses, [])
})

test('GET /board/stats 与 /board 同档准入：跨站被拒绝', async () => {
  const dispatch = fakeDispatch([mkTask('a')])
  const handler = handlerFor(dispatch)

  const result = await call(handler, {
    url: '/dsh-mini-superagent/board/stats',
    headers: { host: 'evil.example:9735', origin: 'http://evil.example:9735' },
  })
  assert.equal(result.status, 403)
  assert.equal(result.json.ok, false)
})

test('POST /board/stats 不成立（统计是只读的）', async () => {
  const handler = handlerFor(fakeDispatch([]))
  const result = await call(handler, { method: 'POST', url: '/dsh-mini-superagent/board/stats' })
  assert.equal(result.status, 404)
})

// ---------------------------------------------------------------- 快照投影：settled_at / time_basis

test('boardTask 对已结算任务输出 settled_at 与 time_basis', () => {
  const fresh = boardTask(mkTask('a'))
  assert.equal(fresh.settled_at, at(0))
  assert.equal(fresh.time_basis, 'settledAt', '有权威字段时基准是 settledAt')

  const legacy = boardTask(mkTask('b', { settledAt: undefined, updatedAt: at(-HOUR) }))
  assert.equal(legacy.settled_at, at(-HOUR), '旧数据回退到 updated_at')
  assert.equal(legacy.time_basis, 'updatedAt-fallback', '但必须标出回退，不能静默混用')
})

test('boardTask 对未结算任务不输出 settled_at（它们没有结算时刻）', () => {
  const card = boardTask(mkTask('a', { status: 'running', settledAt: undefined }))
  assert.equal('settled_at' in card, false)
  assert.equal('time_basis' in card, false)
})

test('boardTask 的 elapsed_ms 量到 settled_at 而不是 updated_at', () => {
  // settledAt 是 5 分钟前，updatedAt 是 1 分钟前（报告刷新过）。
  // 耗时必须量到**结算那一刻**：5 分钟。量到 updatedAt 会得到 9 分钟，
  // 而且只要再来一条报告还会继续变。
  const task = mkTask('a', {
    startedAt: at(-10 * MINUTE),
    settledAt: at(-5 * MINUTE),
    updatedAt: at(-1 * MINUTE),
  })
  assert.equal(boardTask(task).elapsed_ms, 5 * MINUTE)
})
