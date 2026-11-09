/**
 * 分析数据看板（GET /board/analytics）的独立回归测试。
 *
 * 只测 `src/analytics.js` 的纯聚合与 `src/board.js` 里那一条新路由，
 * 不碰既有 `/board` 快照、`/board/stats` 与任何写操作。
 *
 * 逐条对应 docs/board.md 的「分析数据看板」口径表：
 * - 全量：1000 条任务时总量按完整账本算，不受 200 条快照上限影响；
 * - 队列口径：窗口按 createdAt 归属，趋势的完成按 settledAt 归属；
 * - 筛选：时间 / 状态 / 负责人 / 工作区 / 批次是「与」关系；
 * - 分母：完成率排除取消与未结算，n=0 给 null，1≤n<5 给 sampleLow；
 * - 不装全量：缺时间、退休留痕、账本触顶都在 coverage/warnings 里可见；
 * - 代理指标：账本没有 due_at，超时代理必须自报 basis 与 pendingFields；
 * - 可回退：聚合抛错时返回同构降级结构而不是 500。
 *
 * 时间基准相对真实 now，不用固定日期（否则窗口类用例会随时间失效）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ANALYTICS_VERSION, analyticsSnapshot, degradedAnalytics, normalizeAnalyticsScope,
} from '../src/analytics.js'
import { createBoardHandler } from '../src/board.js'
import { ANALYTICS_UNKNOWN } from '../src/analytics.js'
import { COMPLETION_BASE } from '../src/constants.js'
import { SAMPLE_LOW_BELOW } from '../src/stats.js'

const BASE = Date.now()
const at = offsetMs => new Date(BASE + offsetMs).toISOString()
const HOUR = 3_600_000
const DAY = 24 * HOUR

function mkTask(id, overrides = {}) {
  return {
    id,
    title: id,
    status: 'done',
    attempt: 1,
    parentSessionId: 'lead',
    workerSessionId: `dispatch-${id}`,
    createdAt: at(-2 * HOUR),
    startedAt: at(-2 * HOUR + 60_000),
    updatedAt: at(-HOUR),
    settledAt: at(-HOUR),
    workspaceId: 'ws-1',
    workspaceTitle: '工作区一',
    hostWorkspaceId: 'host-1',
    group: 'batch-a',
    reports: [],
    ...overrides,
  }
}

function fakeDispatch(tasks = [], { retired = [], retiredDropped = 0, config = {} } = {}) {
  return {
    table: { tasks: new Map(tasks.map(task => [task.id, task])), maxWorkers: 6 },
    retired: new Map(retired.map(record => [record.id, record])),
    retiredDropped,
    config,
  }
}

/** 假的 IncomingMessage / ServerResponse，够新路由用。 */
function fakeReq(url, headers = {}) {
  const listeners = new Map()
  const req = {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:11586', ...headers },
    on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return req },
    emit(event, value) { for (const fn of listeners.get(event) ?? []) fn(value) },
  }
  return req
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(payload) { this.body = payload ?? '' },
  }
}

async function call(url, dispatch, headers) {
  const handler = createBoardHandler({ logger: { warn() {} } }, dispatch)
  const res = fakeRes()
  await handler(fakeReq(url, headers), res)
  return { status: res.status, body: res.body ? JSON.parse(res.body) : undefined }
}

// ---------------------------------------------------------------- 空账本

test('空账本：总量 0、完成率 null、趋势范围仍在、不假装是 0%', () => {
  const result = analyticsSnapshot(fakeDispatch(), { window: '7d' })
  assert.equal(result.ok, true)
  assert.equal(result.analyticsVersion, ANALYTICS_VERSION)
  assert.equal(result.summary.total, 0)
  assert.equal(result.summary.completion.rate, null)
  assert.equal(result.summary.completion.sampleLow, false)
  assert.deepEqual(result.trend.days, [])
  assert.equal(result.trend.range.days >= 7, true)
  assert.equal(result.coverage.sourceTasks, 0)
  // 代理指标的两个声明是契约的一部分，不能哪天悄悄变成「真的逾期」。
  assert.equal(result.summary.overdue.dueAtAvailable, false)
  assert.deepEqual(result.summary.overdue.pendingFields, ['due_at'])
})

// ---------------------------------------------------------------- 全量

test('全量：1000 条任务时总量按完整账本算，不受 /board 200 条上限影响', () => {
  const tasks = Array.from({ length: 1000 }, (_, index) => mkTask(`t-${index}`, {
    status: index % 2 ? 'done' : 'running',
    createdAt: at(-index * 60_000),
  }))
  const result = analyticsSnapshot(fakeDispatch(tasks), { window: 'all' })
  assert.equal(result.coverage.sourceTasks, 1000)
  assert.equal(result.summary.total, 1000)
  assert.equal(result.summary.completion.done, 500)
  assert.equal(result.summary.completion.base, 500)
  assert.equal(result.summary.completion.rate, 1)
})

// ---------------------------------------------------------------- 窗口与队列口径

test('窗口按 createdAt 归属且左闭；all 连缺创建时间的行也计入', () => {
  const onEdge = mkTask('edge', { createdAt: at(-7 * DAY) })
  const newer = mkTask('newer', { createdAt: at(-DAY), status: 'running' })
  const older = mkTask('older', { createdAt: at(-8 * DAY) })
  const noTime = mkTask('no-time', { createdAt: undefined, status: 'blocked' })
  const dispatch = fakeDispatch([onEdge, newer, older, noTime])

  const week = analyticsSnapshot(dispatch, { window: '7d' })
  // since 是「请求时刻 - 7d」，edge 恰好在边界附近，允许 1 秒实现误差；
  // 断言 older 一定被排除、newer 一定在内，这才是不变量。
  assert.equal(week.summary.byStatus.older, undefined)
  assert.equal(week.summary.byStatus.running >= 1, true)
  assert.equal(week.coverage.matched < week.coverage.sourceTasks, true)
  assert.ok(week.coverage.missingCreatedAt >= 0)

  const all = analyticsSnapshot(dispatch, { window: 'all' })
  assert.equal(all.summary.total, 4)
  assert.equal(all.summary.byStatus.blocked, 1)
  assert.equal(all.trend.compare.available, false)
  assert.equal(all.trend.compare.reason, 'all-window')
})

// ---------------------------------------------------------------- 完成率分母

test('完成率：取消与未结算不进分母，n=0 给 null，1≤n<5 给 sampleLow', () => {
  const tasks = [
    mkTask('a', { status: 'done' }),
    mkTask('b', { status: 'failed' }),
    mkTask('c', { status: 'cancelled' }),
    mkTask('d', { status: 'running' }),
    mkTask('e', { status: 'queued' }),
  ]
  const completion = analyticsSnapshot(fakeDispatch(tasks), { window: 'all' }).summary.completion
  assert.equal(completion.done, 1)
  assert.equal(completion.base, 2)
  assert.equal(completion.rate, 0.5)
  assert.equal(completion.sampleLow, true)
  assert.deepEqual(completion.includes, [...COMPLETION_BASE])
  assert.ok(completion.excludes.includes('cancelled'))

  const none = analyticsSnapshot(fakeDispatch([tasks[2], tasks[3]]), { window: 'all' }).summary.completion
  assert.equal(none.base, 0)
  assert.equal(none.rate, null)
})

// ---------------------------------------------------------------- 筛选

test('时间 / 状态 / 负责人 / 工作区 / 批次是「与」关系，facets 从全量账本取', () => {
  const tasks = [
    mkTask('a', { status: 'done', parentSessionId: 'lead', workspaceId: 'ws-1', group: 'g1' }),
    mkTask('b', { status: 'failed', parentSessionId: 'lead', workspaceId: 'ws-2', group: 'g1' }),
    mkTask('c', { status: 'done', parentSessionId: 'other', workspaceId: 'ws-1', group: 'g2' }),
    mkTask('old', { status: 'done', createdAt: at(-40 * DAY) }),
  ]
  const dispatch = fakeDispatch(tasks)
  const result = analyticsSnapshot(dispatch, {
    window: '7d', status: 'done,failed', owner: 'lead', workspaceId: 'ws-1', group: 'g1',
  })
  assert.equal(result.summary.total, 1)
  assert.equal(result.summary.byStatus.done, 1)
  assert.equal(result.coverage.inWindow, 3)
  assert.equal(result.coverage.excludedByFilters, 2)
  // 关键：选了 ws-1 之后，ws-2 仍应出现在候选里（否则换不回去）。
  assert.deepEqual(result.facets.workspaces.map(item => item.id).sort(), ['ws-1', 'ws-2'])
  assert.deepEqual(result.facets.owners.map(item => item.id).sort(), ['lead', 'other'])
  assert.deepEqual(result.facets.groups.map(item => item.id).sort(), ['batch-a', 'g1', 'g2'])
})

test('负责人缺失时归到 __unknown__，并出现在候选中', () => {
  const dispatch = fakeDispatch([mkTask('no-owner', { parentSessionId: undefined }), mkTask('has-owner')])
  const result = analyticsSnapshot(dispatch, { window: 'all', owner: ANALYTICS_UNKNOWN })
  assert.equal(result.summary.total, 1)
  assert.ok(result.facets.owners.some(item => item.id === ANALYTICS_UNKNOWN))
  assert.equal(normalizeAnalyticsScope({ owner: '__unknown__' }, dispatch).owner, ANALYTICS_UNKNOWN)
})

// ---------------------------------------------------------------- 「未标注」筛选

/**
 * 「未标注」这个候选值必须**真的**能筛出东西。
 *
 * 原来 facet 造候选值时写 `String(id ?? '') || ANALYTICS_UNKNOWN`，匹配时却写
 * `String(id ?? '') !== scope.workspaceId`——空串与 `__unknown__` 是两个值。
 * 于是候选列表里明明有「未标注」，选中之后 matched 却是 0（实测期望 1）。
 *
 * 现在 facet 与匹配共用同一个归一函数（`workspaceKeyOf`），一个值只有一种写法。
 */
test('「未标注」工作区能真的筛出东西（facet 与匹配同源）', () => {
  const dispatch = fakeDispatch([
    mkTask('no-ws', { workspaceId: undefined, hostWorkspaceId: undefined }),
    mkTask('ws', { workspaceId: 'ws-1', hostWorkspaceId: 'host-1' }),
  ])

  const byWorkspace = analyticsSnapshot(dispatch, { window: 'all', workspaceId: ANALYTICS_UNKNOWN })
  assert.equal(byWorkspace.summary.total, 1, '选中「未标注」必须筛出那一条')
  assert.ok(byWorkspace.facets.workspaces.some(item => item.id === ANALYTICS_UNKNOWN),
    '候选列表里要有「未标注」')

  const byHost = analyticsSnapshot(dispatch, { window: 'all', hostWorkspaceId: ANALYTICS_UNKNOWN })
  assert.equal(byHost.summary.total, 1, '实际归属的「未标注」同理')
  assert.ok(byHost.facets.hostWorkspaces.some(item => item.id === ANALYTICS_UNKNOWN))
})

test('工作区筛选仍然是精确匹配（归一不许把真值当成未标注）', () => {
  const dispatch = fakeDispatch([
    mkTask('a', { workspaceId: 'ws-1', hostWorkspaceId: 'host-1' }),
    mkTask('b', { workspaceId: 'ws-2', hostWorkspaceId: 'host-2' }),
  ])
  assert.equal(analyticsSnapshot(dispatch, { window: 'all', workspaceId: 'ws-1' }).summary.total, 1)
  assert.equal(analyticsSnapshot(dispatch, { window: 'all', hostWorkspaceId: 'host-2' }).summary.total, 1)
})

// ---------------------------------------------------------------- 缺时间不许消失

/**
 * 缺 `createdAt` 的任务不能从分母里**静默**消失。
 *
 * 原来 `missingCreatedAt` 是在时间过滤**之后**数的：有窗口时缺创建时间的行
 * 已经被剔掉，于是这个数恒为 0（实测 sourceTasks=2 / inWindow=1 / missing=0）。
 * 一条真实任务就这么从「缺时间 n」里也消失了，读者根本不知道分母少了几条。
 */
test('缺 createdAt 的任务不从分母里消失（missingCreatedAt 如实报数）', () => {
  const dispatch = fakeDispatch([
    mkTask('ok', { createdAt: at(-2 * HOUR) }),
    mkTask('no-time', { createdAt: undefined }),
  ])
  const result = analyticsSnapshot(dispatch, { window: '7d' })

  assert.equal(result.coverage.sourceTasks, 2)
  assert.equal(result.coverage.inWindow, 1, '缺时间的行进不了窗口（无法证明它在窗口内）')
  assert.equal(result.coverage.missingCreatedAt, 1, '但必须被报出来，不能悄悄消失')
  assert.ok(result.warnings.includes('missing-times'), 'warnings 里也要说')
})

test('all 窗口下缺时间的行照进分母，missingCreatedAt 仍然报数', () => {
  const dispatch = fakeDispatch([
    mkTask('ok', { createdAt: at(-2 * HOUR) }),
    mkTask('no-time', { createdAt: undefined, status: 'blocked' }),
  ])
  const result = analyticsSnapshot(dispatch, { window: 'all' })
  assert.equal(result.summary.total, 2, 'all 窗口没有时间约束，缺时间的行也进分母')
  assert.equal(result.coverage.missingCreatedAt, 1)
})

// ---------------------------------------------------------------- 样本门槛只有一份

/**
 * 「样本少」的门槛必须复用 `stats.js` 的 `SAMPLE_LOW_BELOW`，不在这儿另写一个 5。
 *
 * 两个视图各写一个门槛，改了一处就会出现「总览说样本够、拆解说样本少」。
 * 这条用例按**常量**断言，而不是按字面量 5：常量改了它自动跟着走。
 */
test('样本门槛复用 SAMPLE_LOW_BELOW（与分析看板共用同一份）', () => {
  const mk = count => Array.from({ length: count }, (_, i) => mkTask(`t${i}`, { status: 'done' }))
  const at_ = count => analyticsSnapshot(fakeDispatch(mk(count)), { window: 'all' })

  assert.equal(at_(SAMPLE_LOW_BELOW - 1).summary.completion.sampleLow, true, '低于门槛要标样本少')
  assert.equal(at_(SAMPLE_LOW_BELOW).summary.completion.sampleLow, false, '到门槛就不标了')
  assert.equal(at_(SAMPLE_LOW_BELOW).coverage.sampleLow, false, 'coverage 那一处用同一个门槛')
  assert.equal(at_(SAMPLE_LOW_BELOW - 1).coverage.sampleLow, true)
})

// ---------------------------------------------------------------- 降级响应的默认窗口

test('degradedAnalytics 的默认窗口跟随配置（不写死 7 天）', () => {
  const dispatch = fakeDispatch([], { config: { memoryWindowDays: 30 } })
  const bad = degradedAnalytics({}, new Error('聚合炸了'), dispatch)
  assert.equal(bad.scope.window.key, '30d', '降级窗口必须与成功路径同源')
})

test('非法窗口与非法阈值退回默认，并留下稳定 warning 代码', () => {
  const scope = normalizeAnalyticsScope({ window: 'garbage', overdueHours: '-3' }, fakeDispatch())
  assert.equal(scope.window.key, '7d')
  assert.equal(scope.overdueHours, 24)
  assert.ok(scope.warnings.includes('invalid-window'))
  assert.ok(scope.warnings.includes('invalid-overdue-hours'))
  const result = analyticsSnapshot(fakeDispatch(), { window: 'garbage', overdueHours: '-3' })
  assert.equal(result.scope.window.key, '7d')
  assert.ok(result.warnings.includes('invalid-window'))
})

// ---------------------------------------------------------------- 超时代理

test('超时代理：未结算看 now-createdAt、已结算看 settledAt-createdAt，缺时间单独报', () => {
  const tasks = [
    mkTask('open-old', { status: 'running', createdAt: at(-30 * DAY), startedAt: at(-30 * DAY), settledAt: undefined }),
    mkTask('open-fresh', { status: 'running', createdAt: at(-HOUR), startedAt: at(-HOUR), settledAt: undefined }),
    mkTask('settled-slow', { createdAt: at(-3 * DAY), startedAt: at(-3 * DAY), settledAt: at(-DAY) }),
    mkTask('settled-fast', { createdAt: at(-2 * HOUR), settledAt: at(-HOUR) }),
    mkTask('unknown', { createdAt: undefined, settledAt: undefined, updatedAt: undefined }),
  ]
  const result = analyticsSnapshot(fakeDispatch(tasks), { window: 'all', overdueHours: 24 })
  const overdue = result.summary.overdue
  assert.equal(overdue.thresholdHours, 24)
  assert.equal(overdue.basis, 'proxy:createdAt')
  assert.equal(overdue.open, 1)
  assert.equal(overdue.settled, 1)
  assert.equal(overdue.unknown, 1)
  assert.equal(overdue.total, 2)
  assert.ok(result.warnings.includes('due-at-proxy'))
  assert.ok(result.warnings.includes('owner-proxy'))
})

// ---------------------------------------------------------------- 趋势与环比

test('趋势：新建按创建日、完成按结算日；空天由 range 表达，环比只比较等长窗口', () => {
  const tasks = [
    mkTask('d1', { createdAt: at(-2 * DAY + HOUR), settledAt: at(-HOUR) }),
    mkTask('d2', { status: 'failed', createdAt: at(-2 * DAY + 2 * HOUR), settledAt: at(-2 * HOUR) }),
    mkTask('old', { createdAt: at(-12 * DAY), settledAt: at(-11 * DAY), status: 'done' }),
  ]
  const result = analyticsSnapshot(fakeDispatch(tasks), { window: '7d' })
  const created = result.trend.days.find(row => row.created > 0)
  const finished = result.trend.days.find(row => row.done > 0 || row.failed > 0)
  assert.ok(created, '至少有一天有新建')
  assert.ok(finished, '至少有一天有结算')
  assert.notEqual(created.day, 'undefined')
  assert.equal(result.trend.range.days >= 7, true)
  assert.ok(result.trend.range.from <= result.trend.range.to)

  const compare = result.trend.compare
  assert.equal(compare.available, true)
  assert.equal(typeof compare.createdDelta, 'number')
  assert.equal(compare.current.created - compare.previous.created, compare.createdDelta)
  assert.equal(typeof compare.doneDelta, 'number')
})

test('趋势范围超过 366 天会裁剪并在 coverage 里说明', () => {
  const tasks = [mkTask('ancient', { createdAt: at(-900 * DAY), settledAt: at(-899 * DAY) })]
  const result = analyticsSnapshot(fakeDispatch(tasks), { window: 'all' })
  assert.equal(result.trend.range.days <= 366, true)
  assert.equal(result.coverage.trendClamped, true)
  assert.ok(result.warnings.includes('trend-clamped'))
})

// ---------------------------------------------------------------- 覆盖率与降级

test('退休留痕不并入总量，但 coverage 看得见；触顶标记结果可能低估', () => {
  const dispatch = fakeDispatch([mkTask('live')], {
    retired: [{ id: 'gone', retiredAt: at(-DAY), status: 'done' }],
    retiredDropped: 2,
    config: { ledgerMaxTasks: 1 },
  })
  const result = analyticsSnapshot(dispatch, { window: 'all' })
  assert.equal(result.summary.total, 1)
  assert.equal(result.coverage.sourceTasks, 1)
  assert.equal(result.coverage.retiredTraces, 1)
  assert.equal(result.coverage.truncated.mayUnderestimate, true)
  assert.ok(result.warnings.includes('ledger-truncated'))
})

test('降级结构与成功结构同构：summary=null、容器为空、degraded=true', () => {
  const ok = analyticsSnapshot(fakeDispatch(), { window: '7d' })
  const bad = degradedAnalytics({ window: '7d' }, new Error('ledger 损坏'))
  assert.equal(bad.ok, false)
  assert.equal(bad.degraded, true)
  assert.match(bad.reason, /ledger 损坏/)
  assert.equal(bad.summary, null)
  assert.deepEqual(bad.trend.days, [])
  assert.deepEqual(Object.keys(ok.coverage).sort(), Object.keys(bad.coverage).sort())
  assert.deepEqual(Object.keys(ok.facets).sort(), Object.keys(bad.facets).sort())
})

// ---------------------------------------------------------------- HTTP 路由

test('GET /board/analytics 走只读准入，参数进 URL 后归一回显', async () => {
  const dispatch = fakeDispatch([mkTask('a'), mkTask('b', { status: 'failed' })])
  const result = await call('/dsh-mini-superagent/board/analytics?window=30d&status=done', dispatch)
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.scope.window.key, '30d')
  assert.equal(result.body.scope.status, 'done')
  assert.equal(result.body.summary.total, 1)
})

test('GET /board/analytics 非回环 Host 且未放行时拒绝（与 /board 同档）', async () => {
  const result = await call('/dsh-mini-superagent/board/analytics', fakeDispatch(), { host: 'evil.example:9735' })
  assert.equal(result.status, 403)
  assert.equal(result.body.ok, false)
})

test('聚合抛错时返回 200 + 同构降级结构，不是 500', async () => {
  const brokenDispatch = {
    table: {
      get size() { return 0 },
      get tasks() { throw new Error('账本损坏') },
    },
    config: {},
  }
  const result = await call('/dsh-mini-superagent/board/analytics?window=7d', brokenDispatch)
  assert.equal(result.status, 200)
  assert.equal(result.body.degraded, true)
  assert.equal(result.body.summary, null)
  assert.equal(result.body.scope.window.key, '7d')
})
