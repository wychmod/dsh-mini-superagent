/**
 * 看板快照的单测：只测纯函数（boardTask / boardSnapshot / retiredSnapshot），不需要起 HTTP 服务。
 * 形状是客户端契约的一部分，改字段会在这里先失败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { VERSION } from '../src/constants.js'
import { boardSnapshot, boardTask, createBoardHandler, retiredSnapshot } from '../src/board.js'

const BASE = '/dsh-mini-superagent/board'

/**
 * 假的 IncomingMessage：够 readJson 用（on/data/end/error）。
 *
 * 默认带本机 Host，并带上准入头 `x-dsh-mini-superagent`——看板的写操作
 * 现在要求它（见 src/constants.js 的 BOARD_HEADER）。需要测拒绝路径时，
 * 在 headers 里传 `'x-dsh-mini-superagent': ''` 覆盖掉。
 */
function fakeReq({ method = 'GET', url = BASE, headers = {}, body } = {}) {
  const finalHeaders = { host: '127.0.0.1:11586', 'x-dsh-mini-superagent': '1', ...headers }
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: finalHeaders,
    on(event, callback) {
      listeners.set(event, [...(listeners.get(event) ?? []), callback])
      return req
    },
    destroy() {},
    emit(event, argument) { for (const callback of listeners.get(event) ?? []) callback(argument) },
  }
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  }, 0)
  return req
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

/** 造一个最小任务对象。 */
function makeTask(id, overrides = {}) {
  return {
    id,
    title: `任务 ${id}`,
    status: 'running',
    attempt: 1,
    parentSessionId: 's1',
    workerSessionId: `dispatch-${id}`,
    cwd: 'C:\\work',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    turnStartedAt: undefined,
    reports: [],
    lastText: '',
    ...overrides,
  }
}

/** 假的 Dispatch：board 只需要 table.tasks 与 table.maxWorkers。 */
function fakeDispatch(tasks, maxWorkers = 6) {
  return { table: { tasks: new Map(tasks.map(task => [task.id, task])), maxWorkers } }
}

test('boardTask 把内部结构拍平成客户端字段', () => {
  const task = makeTask('a', {
    reports: [{ at: '2026-01-01T00:00:05.000Z', status: 'done', summary: '做完了' }],
    lastText: '最后一段输出',
  })
  const card = boardTask(task)

  assert.equal(card.task_id, 'a')
  assert.equal(card.worker_session_id, 'dispatch-a')
  assert.equal(card.parent_session_id, 's1')
  assert.equal(card.attempt, 1)
  assert.equal(card.report_count, 1)
  assert.deepEqual(card.last_report, { at: '2026-01-01T00:00:05.000Z', status: 'done', summary: '做完了' })
  assert.equal(card.last_text_preview, '最后一段输出')
  assert.equal(card.error, undefined, '没有 error 字段时不该凭空造一个')
  assert.ok(card.elapsed_ms >= 0)
})

test('boardTask 在没有报告时 last_report 是 null', () => {
  assert.equal(boardTask(makeTask('a')).last_report, null)
})

test('boardTask 截断超长的最后输出', () => {
  const card = boardTask(makeTask('a', { lastText: 'x'.repeat(2000) }))
  assert.equal(card.last_text_preview.length, 500)
})

test('boardTask 保留失败任务的 error', () => {
  const card = boardTask(makeTask('a', { status: 'failed', error: '建会话失败' }))
  assert.equal(card.error, '建会话失败')
})

/* ───────────── P0 记忆治理：把 host 新增的事实投影进快照（P2 修复 3） ───────────── */

/**
 * 归档 = **只读冻结**（P0-4）。`frozenAt` 必须投影成 `frozen_at`。
 *
 * 少了它，看板会把「已归档冻结」显示成普通已结算行。冻结本来就是为了
 * 「这条不会再变了」，不显示等于让用户以为它还能被改、还该去等它的报告。
 * 注意归档（`frozenAt`，任务仍在表里）与退休（`retiredAt`，已移出账本）是两件事。
 */
test('P2 boardTask 带 frozenAt 时输出 frozen_at（归档冻结，不能显示成普通行）', () => {
  const card = boardTask(makeTask('a', {
    status: 'done',
    archivedAt: '2026-01-02T00:00:00.000Z',
    frozenAt: '2026-01-02T00:00:01.000Z',
  }))
  assert.equal(card.frozen_at, '2026-01-02T00:00:01.000Z', '归档冻结时刻必须上快照')
  assert.equal(card.archived_at, '2026-01-02T00:00:00.000Z', 'archived_at 仍保留（两个字段不互斥）')
})

test('P2 boardTask 没有 frozenAt 时不输出 frozen_at（不写 null，与现有可选字段同风格）', () => {
  const card = boardTask(makeTask('a'))
  assert.equal('frozen_at' in card, false, '缺失时不该凭空造一个 null 字段')
})

/**
 * 「待读」超 TTL 后被 `sweepMemory()` 改写成 `inputUnknownAt`（P0-4）。
 *
 * 两个字段**必须互斥**：unknown 出现时 pending 不能再输出，否则看板会同时显示
 * 「还在等它读」——那是个永远不会结束的状态，比不显示更误导人。
 */
test('P2 boardTask 带 inputUnknownAt 时输出 input_unknown_at，且不再输出 input_pending_at', () => {
  const card = boardTask(makeTask('a', {
    status: 'running',
    inputPendingAt: '2026-01-01T00:00:05.000Z',
    inputUnknownAt: '2026-01-01T00:10:00.000Z',
  }))
  assert.equal(card.input_unknown_at, '2026-01-01T00:10:00.000Z', '「不知道读没读到」要能看见')
  assert.equal('input_pending_at' in card, false,
    'unknown 之后不能再报 pending，否则又是「永久待读」')
})

test('P2 boardTask 只在 TTL 内输出 input_pending_at', () => {
  const card = boardTask(makeTask('a', { status: 'running', inputPendingAt: '2026-01-01T00:00:05.000Z' }))
  assert.equal(card.input_pending_at, '2026-01-01T00:00:05.000Z', 'TTL 内的待读仍要显示')
  assert.equal('input_unknown_at' in card, false)
})

test('P2 boardTask 已读之后 pending 与 unknown 都不输出', () => {
  const card = boardTask(makeTask('a', {
    status: 'running',
    inputPendingAt: '2026-01-01T00:00:05.000Z',
    inputUnknownAt: '2026-01-01T00:10:00.000Z',
    inputReadAt: '2026-01-01T00:11:00.000Z',
  }))
  assert.equal('input_pending_at' in card, false, '已读就不该再说「待读」')
  assert.equal('input_unknown_at' in card, false, '已读就不该再说「不知道」')
  assert.equal(card.input_read_at, '2026-01-01T00:11:00.000Z')
})

/**
 * 报告被截断过：只给**布尔**小标记，不把正文搬上快照。
 *
 * 快照是每轮轮询都要重传的东西；把 6000 字的报告塞进来等于用带宽换一个小标记，
 * 而要看正文的人本来就该走 `dispatch_inspect`。
 */
test('P2 boardTask 任一 report 带 truncated 时输出 has_truncated', () => {
  const card = boardTask(makeTask('a', {
    reports: [
      { at: '2026-01-01T00:00:01.000Z', status: 'progress', summary: '短' },
      { at: '2026-01-01T00:00:02.000Z', status: 'done', summary: '被截过', truncated: { summary: 6000 } },
    ],
  }))
  assert.equal(card.has_truncated, true, '被截过的报告要能从小标记看出来')
  // 关键：只给布尔，**不搬全文**。
  assert.equal(typeof card.has_truncated, 'boolean', '客户端只要一个小标记，不是正文')
  assert.ok(!JSON.stringify(card).includes('6000'), '截断的原始长度不该出现在快照里')
})

test('P2 boardTask 简报截断标记 briefTruncated 也并入 has_truncated', () => {
  const card = boardTask(makeTask('a', { briefTruncated: 50000 }))
  assert.equal(card.has_truncated, true,
    '落盘时简报被截过同样算「有内容被截」，否则 retry 重投残版简报没人发现')
})

test('P2 boardTask 没有被截过的报告时不输出 has_truncated', () => {
  const card = boardTask(makeTask('a', {
    reports: [{ at: '2026-01-01T00:00:01.000Z', status: 'done', summary: '正常' }],
  }))
  assert.equal('has_truncated' in card, false, '一个恒为 false 的字段会让标记失去意义')
})

test('P2 boardSnapshot 的 cards 带着上面三个新字段（端到端过一遍快照）', () => {
  const dispatch = fakeDispatch([
    makeTask('frozen', { status: 'done', frozenAt: '2026-01-02T00:00:00.000Z' }),
    makeTask('unknown', { status: 'running', inputUnknownAt: '2026-01-01T00:10:00.000Z' }),
    makeTask('trunc', { status: 'done', reports: [{ at: '2026-01-01T00:00:01.000Z', status: 'done', summary: 's', truncated: { summary: 9 } }] }),
  ])
  const byId = Object.fromEntries(boardSnapshot(dispatch).tasks.map(card => [card.task_id, card]))
  assert.equal(byId.frozen.frozen_at, '2026-01-02T00:00:00.000Z')
  assert.equal(byId.unknown.input_unknown_at, '2026-01-01T00:10:00.000Z')
  assert.equal('input_pending_at' in byId.unknown, false)
  assert.equal(byId.trunc.has_truncated, true)
})

test('boardSnapshot 统计每个状态的数量', () => {
  const dispatch = fakeDispatch([
    makeTask('a', { status: 'running' }),
    makeTask('b', { status: 'running' }),
    makeTask('c', { status: 'queued' }),
    makeTask('d', { status: 'done' }),
    makeTask('e', { status: 'failed' }),
    makeTask('f', { status: 'cancelled' }),
    makeTask('g', { status: 'interrupted' }),
  ])
  const snap = boardSnapshot(dispatch)

  assert.equal(snap.counts.total, 7)
  assert.equal(snap.counts.running, 2)
  assert.equal(snap.counts.queued, 1)
  assert.equal(snap.counts.done, 1)
  assert.equal(snap.counts.failed, 1)
  assert.equal(snap.counts.cancelled, 1)
  assert.equal(snap.counts.interrupted, 1)
  assert.deepEqual(snap.concurrency, { running: 2, queued: 1, max: 6 })
})

test('boardSnapshot 排序：running → queued → 其余按更新时间倒序', () => {
  const dispatch = fakeDispatch([
    makeTask('old-done', { status: 'done', updatedAt: '2026-01-01T00:00:01.000Z' }),
    makeTask('new-done', { status: 'done', updatedAt: '2026-01-01T00:00:09.000Z' }),
    makeTask('waiting', { status: 'queued', updatedAt: '2026-01-01T00:00:02.000Z' }),
    makeTask('busy', { status: 'running', updatedAt: '2026-01-01T00:00:03.000Z' }),
  ])
  assert.deepEqual(boardSnapshot(dispatch).tasks.map(task => task.task_id), ['busy', 'waiting', 'new-done', 'old-done'])
})

test('boardSnapshot 最多返回 200 条，但计数按全量算', () => {
  const tasks = Array.from({ length: 250 }, (_, index) => makeTask(`t${index}`, { status: 'done' }))
  const snap = boardSnapshot(fakeDispatch(tasks))
  assert.equal(snap.tasks.length, 200)
  assert.equal(snap.counts.total, 250)
})

/**
 * 截断必须显式说出来：否则「总计 500 / 列表 200」看起来像数据丢了，
 * 用户会去翻根本不存在的第 201 条。
 */
test('boardSnapshot 截断时带上 truncated，明确告诉看板少显示了', () => {
  const tasks = Array.from({ length: 500 }, (_, index) => makeTask(`t${index}`, { status: 'done' }))
  const snap = boardSnapshot(fakeDispatch(tasks))
  assert.deepEqual(snap.truncated, { shown: 200, total: 500 })
})

test('boardSnapshot 未截断时 truncated 为 null（含恰好 200 的边界）', () => {
  assert.equal(boardSnapshot(fakeDispatch([])).truncated, null)
  const exactly = Array.from({ length: 200 }, (_, index) => makeTask(`t${index}`, { status: 'done' }))
  assert.equal(boardSnapshot(fakeDispatch(exactly)).truncated, null, '恰好 200 条不该误报截断')
})

/**
 * elapsed_ms 的基准必须能「停住」：已结算任务量到结算时刻（updated_at），
 * 未结算的才量到现在。0.7.0 之前一律用 now，一个 26 小时前就 done 的任务
 * 会一直显示「26 时 0 分」并继续增长。
 */
test('boardTask 已结算任务的 elapsed_ms 量到结算时刻，不随 now 增长', async () => {
  const task = makeTask('d', {
    status: 'done',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
  })
  const first = boardTask(task).elapsed_ms
  assert.equal(first, 5 * 60_000, '应当是 startedAt → updatedAt 的 5 分钟')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(boardTask(task).elapsed_ms, first, 'done 的耗时必须冻结，否则看板一直走表')
})

test('boardTask 未结算任务的 elapsed_ms 仍然量到现在', () => {
  const task = makeTask('r', { status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString() })
  assert.ok(boardTask(task).elapsed_ms >= 60_000, 'running 要继续走表')
})

test('boardSnapshot 带上版本号与生成时间', () => {
  const snap = boardSnapshot(fakeDispatch([]))
  assert.equal(snap.version, VERSION)
  assert.ok(!Number.isNaN(Date.parse(snap.generatedAt)))
  assert.deepEqual(snap.tasks, [])
  assert.equal(snap.concurrency.max, 6)
})

/* ───────────────── 记忆治理：快照里的 memory 块（plans/07 P0-1 / P0-5） ───────────────── */

/**
 * 一份符合冻结契约的 memoryStats 返回值。
 * 形状来自 plans/07 §六：window / ledger / admission / pending / retired 五块。
 */
function makeMemoryStats(overrides = {}) {
  return {
    window: { days: 7, tasks: 200, since: '2026-01-01T00:00:00.000Z' },
    ledger: {
      tasks: 12,
      retired: 3,
      archived: 4,
      retiredDropped: 1,
      capPerTask: { summary: 6000, detail: 4000 },
    },
    admission: { direct: 5, ledger: 7, directStatuses: ['blocked', 'failed'] },
    pending: { inputs: 1, unknown: 0 },
    retired: { count: 3, latestAt: '2026-01-02T00:00:00.000Z' },
    ...overrides,
  }
}

test('boardSnapshot 带上 memory 块且形状对', () => {
  const dispatch = fakeDispatch([makeTask('a', { status: 'done' })])
  dispatch.memoryStats = () => makeMemoryStats()
  const snap = boardSnapshot(dispatch)

  assert.ok(snap.memory && typeof snap.memory === 'object', 'memory 必须是对象，客户端靠它拿窗口')
  assert.deepEqual(snap.memory.window, { days: 7, tasks: 200, since: '2026-01-01T00:00:00.000Z' })
  assert.equal(snap.memory.ledger.retiredDropped, 1)
  assert.equal(snap.memory.ledger.capPerTask.summary, 6000)
  assert.equal(snap.memory.retired.count, 3)
  assert.equal(snap.counts.retired, 3, 'counts.retired 取 memory.retired.count')
})

/**
 * memoryStats 是 host 核心的另一半，可能还没落地、也可能抛错。
 * 两种情况下看板都必须照常给出任务列表 —— 指标口径坏掉不该让人看不见任务。
 */
test('宿主没有 memoryStats 时 memory 为 null 且不抛错', () => {
  const snap = boardSnapshot(fakeDispatch([makeTask('a', { status: 'done' })]))
  assert.equal(snap.memory, null)
  assert.equal(snap.counts.retired, 0)
  assert.equal(snap.tasks.length, 1, '任务列表照常返回')
})

test('memoryStats 抛错时降级为 null，不让整块看板 500', () => {
  const dispatch = fakeDispatch([makeTask('a', { status: 'done' })])
  dispatch.memoryStats = () => { throw new Error('窗口计算炸了') }
  const snap = boardSnapshot(dispatch)
  assert.equal(snap.memory, null)
  assert.equal(snap.counts.retired, 0)
  assert.equal(snap.tasks.length, 1)
})

test('memoryStats 返回垃圾形状时 memory 为 null 而不是半个对象', () => {
  const dispatch = fakeDispatch([])
  dispatch.memoryStats = () => 'not-an-object'
  assert.equal(boardSnapshot(dispatch).memory, null)
})

/**
 * host 的 `memoryStats()` 实际是 **async**（它要读活表与留痕两份）。
 *
 * 这是最容易踩的一脚：同步快照里拿到的是 Promise，直接塞进 JSON 会被
 * `JSON.stringify` 变成 `{}` —— 客户端读到的是一个「空 memory 块」，
 * 比 null 更难排查，而且看起来像宿主在正常工作。所以：
 * - 同步调用（boardSnapshot 自己取）必须识别 thenable 并退成 null；
 * - HTTP 路由必须先把值 await 出来再放进快照。
 */
test('memoryStats 是 async 时，同步快照退成 null 而不是塞进一个 Promise', () => {
  const dispatch = fakeDispatch([makeTask('a', { status: 'done' })])
  dispatch.memoryStats = async () => makeMemoryStats()
  const snap = boardSnapshot(dispatch)
  assert.equal(snap.memory, null, 'Promise 不能被当成 memory 块')
  assert.equal(snap.counts.retired, 0)
  // 真正的证据：序列化后不该出现一个空对象把「没提供」伪装成「提供了但为空」。
  const wire = JSON.parse(JSON.stringify(snap))
  assert.equal(wire.memory, null)
  assert.equal(wire.tasks.length, 1)
})

test('memoryStats 是 async 时，显式传入已解析的值仍然生效', async () => {
  const dispatch = fakeDispatch([])
  dispatch.memoryStats = async () => makeMemoryStats()
  const resolved = await dispatch.memoryStats()
  const snap = boardSnapshot(dispatch, resolved)
  assert.equal(snap.memory.window.days, 7)
  assert.equal(snap.counts.retired, 3)
})

test('GET /board 会 await 异步的 memoryStats（真机上它是 async）', async () => {
  const { handler, dispatch } = fakeHost([makeTask('a', { status: 'done' })])
  let calls = 0
  dispatch.memoryStats = async () => {
    calls += 1
    return makeMemoryStats()
  }
  const result = await call(handler, {})
  assert.equal(result.status, 200)
  assert.equal(calls, 1, '一次快照只取一次口径')
  assert.equal(result.json.memory.window.days, 7, '异步值必须被 await 出来，不能是 {}')
  assert.equal(result.json.memory.window.since, '2026-01-01T00:00:00.000Z')
  assert.equal(result.json.counts.retired, 3)
})

/* ───────────────── 已退休：纯函数 + 路由 ───────────────── */

/** 造一条退休记录（形状来自已冻结的 host 契约）。 */
function makeRetired(id, retiredAt, overrides = {}) {
  return {
    id,
    title: `退休任务 ${id}`,
    status: 'done',
    parentSessionId: 's1',
    workerSessionId: `dispatch-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T01:00:00.000Z',
    archivedAt: '2026-01-01T02:00:00.000Z',
    retiredAt,
    retiredReason: 'cap-count',
    workspaceTitle: '项目 A',
    reportCount: 3,
    summary: '已合并到主分支',
    ...overrides,
  }
}

test('retiredSnapshot 把退休记录拍平成客户端字段', () => {
  const dispatch = { retired: new Map([['r1', makeRetired('r1', '2026-01-03T00:00:00.000Z')]]) }
  const snap = retiredSnapshot(dispatch)
  assert.equal(snap.ok, true)
  assert.equal(snap.count, 1)
  assert.equal(snap.dropped, 0)
  assert.deepEqual(snap.entries, [{
    task_id: 'r1',
    title: '退休任务 r1',
    status: 'done',
    retired_at: '2026-01-03T00:00:00.000Z',
    retired_reason: 'cap-count',
    archived_at: '2026-01-01T02:00:00.000Z',
    updated_at: '2026-01-01T01:00:00.000Z',
    summary: '已合并到主分支',
  }])
})

test('retiredSnapshot 没有 dispatch.retired 时返回空表（旧版宿主/headless）', () => {
  assert.deepEqual(retiredSnapshot({}), { ok: true, count: 0, dropped: 0, entries: [] })
  assert.deepEqual(retiredSnapshot({ retired: null }), { ok: true, count: 0, dropped: 0, entries: [] })
  // 形状不是 Map 时也不该炸：宁可当成「没有」。
  assert.deepEqual(retiredSnapshot({ retired: [] }), { ok: true, count: 0, dropped: 0, entries: [] })
})

test('retiredSnapshot 按 retiredAt 倒序（最近退休的排最前）', () => {
  const dispatch = {
    retired: new Map([
      ['old', makeRetired('old', '2025-12-01T00:00:00.000Z')],
      ['new', makeRetired('new', '2026-01-05T00:00:00.000Z')],
      ['mid', makeRetired('mid', '2026-01-03T00:00:00.000Z')],
    ]),
  }
  assert.deepEqual(retiredSnapshot(dispatch).entries.map(entry => entry.task_id), ['new', 'mid', 'old'])
})

test('retiredSnapshot 超过 200 条时截断并给出 dropped', () => {
  const records = Array.from({ length: 230 }, (_, index) => {
    const id = `r${String(index).padStart(3, '0')}`
    // retiredAt 随 index 递增，倒序后最新的（r229）排最前。
    return [id, makeRetired(id, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString())]
  })
  const snap = retiredSnapshot({ retired: new Map(records) })
  assert.equal(snap.count, 230, 'count 是全量，不是截断后的条数')
  assert.equal(snap.dropped, 30, '明说少给了多少')
  assert.equal(snap.entries.length, 200)
  assert.equal(snap.entries[0].task_id, 'r229', '截断保留的是最新的那批')
})

test('GET /board/retired 无 dispatch.retired 时返回空表（只读，不要求写头）', async () => {
  const { handler } = fakeHost([makeTask('a')])
  const result = await call(handler, { url: `${BASE}/retired`, headers: { 'x-dsh-mini-superagent': '' } })
  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.deepEqual(result.json, { ok: true, count: 0, dropped: 0, entries: [] })
})

test('GET /board/retired 有记录时返回倒序与 dropped', async () => {
  const { handler, dispatch } = fakeHost([])
  dispatch.retired = new Map([
    ['old', makeRetired('old', '2025-12-01T00:00:00.000Z')],
    ['new', makeRetired('new', '2026-01-05T00:00:00.000Z', { retiredReason: 'cap-days' })],
  ])
  const result = await call(handler, { url: `${BASE}/retired` })
  assert.equal(result.status, 200)
  assert.equal(result.json.count, 2)
  assert.equal(result.json.dropped, 0)
  assert.deepEqual(result.json.entries.map(entry => entry.task_id), ['new', 'old'])
  assert.equal(result.json.entries[0].retired_reason, 'cap-days')
})

test('GET /board/retired 被跨站请求拒绝（与 GET /board 同档准入）', async () => {
  const { handler, dispatch } = fakeHost([])
  dispatch.retired = new Map([['r1', makeRetired('r1', '2026-01-03T00:00:00.000Z')]])
  const result = await call(handler, {
    url: `${BASE}/retired`,
    headers: { host: 'evil.example:9735', origin: 'http://evil.example:9735' },
  })
  assert.equal(result.status, 403)
  assert.equal(result.json.ok, false)
})

test('POST /board/retired 不成立（退休是 host 的决定，面板只能看）', async () => {
  const { handler } = fakeHost([])
  const result = await call(handler, { method: 'POST', url: `${BASE}/retired`, body: {} })
  assert.equal(result.status, 404)
})

/**
 * 退休记录不得回落进 tasks 列表。
 *
 * 否则「账本有上界」这件事在快照上不可验证（plans/07 §七 4），
 * 面板上看起来也像退休根本没发生过。
 */
test('退休记录不回落进快照的 tasks 列表', () => {
  const dispatch = fakeDispatch([makeTask('alive', { status: 'running' })])
  dispatch.retired = new Map([['gone', makeRetired('gone', '2026-01-03T00:00:00.000Z')]])
  dispatch.memoryStats = () => makeMemoryStats()
  const snap = boardSnapshot(dispatch)
  assert.deepEqual(snap.tasks.map(task => task.task_id), ['alive'])
  assert.equal(snap.counts.total, 1, '退休记录不占 counts.total')
  assert.equal(snap.counts.retired, 3, '退休数走 memory.retired.count，不进 total')
})

// ---------------------------------------------------------------- HTTP 路由

/** 假宿主：handler 需要 table.get / cancel / retry / message。 */
function fakeHost(tasks, { cancelThrows = false, messageThrows = false } = {}) {
  const calls = { cancel: [], retry: [], message: [] }
  const agents = new Map([['s1', { id: 's1' }], ['s2', { id: 's2' }]])
  const dispatch = {
    config: { leadSessionId: 'mas-lead' },
    ctx: { agents: { get: id => agents.get(id) } },
    table: {
      tasks: new Map(tasks.map(task => [task.id, task])),
      maxWorkers: 6,
      get: id => dispatch.table.tasks.get(id),
    },
    async cancel(task, reason) {
      if (cancelThrows) throw new Error('这个任务不能取消')
      calls.cancel.push([task.id, reason])
      return task
    },
    async retry(task) {
      calls.retry.push(task.id)
      task.attempt = (task.attempt ?? 1) + 1
      return task
    },
    /** 续派走 `message()`：handler 不新建路由，只把用户的文本转发给它。 */
    async message(task, text, mode) {
      if (messageThrows) throw new Error('子会话不可用')
      calls.message.push({ id: task.id, text, mode })
      return task
    },
    workspaces: { list: () => [{ id: 'w-1', title: '项目 A', path: 'C:\\a' }] },
    targets: new Map(),
    async setTarget(sessionId, workspace) {
      calls.target = { sessionId, workspace }
      if (!workspace) { dispatch.targets.delete(sessionId); return undefined }
      if (workspace === 'nope') throw new Error('找不到工作区「nope」')
      const target = { workspace_id: 'w-1', title: '项目 A', path: 'C:\\a' }
      dispatch.targets.set(sessionId, target)
      return target
    },
    async archiveStale() {
      calls.archive = (calls.archive ?? 0) + 1
      return { scanned: 2, archived: 1, failed: 1 }
    },
  }
  const ctx = { logger: { info() {}, warn() {} } }
  return { ctx, dispatch, calls, handler: createBoardHandler(ctx, dispatch) }
}

test('GET /board 返回快照且不缓存', async () => {
  const { handler } = fakeHost([makeTask('a', { status: 'running' })])
  const result = await call(handler, {})
  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.json.version, VERSION)
  assert.equal(result.json.tasks.length, 1)
})

test('GET 未知子路径返回 404 而不是快照', async () => {
  const { handler } = fakeHost([])
  const result = await call(handler, { url: `${BASE}/nope` })
  assert.equal(result.status, 404)
  assert.equal(result.json.ok, false)
})

test('非回环且非同源的 GET 被拒绝（避免暴露任务名与工作目录）', async () => {
  const { handler } = fakeHost([makeTask('a')])
  const result = await call(handler, { headers: { host: '192.168.1.5:3080' } })
  assert.equal(result.status, 403)
})

/**
 * 0.7.0 的行为变更：非回环 Host 默认拒绝，即使 Origin 与它同源。
 *
 * 原因：0.6.0 的「Origin.host === Host 即放行」对 DNS rebinding 恒真
 * （攻击者页面与目标同源，两个头都由攻击者的域名决定）。要开放
 * 远程访问，必须把 Host 显式写进 BOARD_ALLOWED_HOSTS —— 见下一条测试。
 */
test('非回环 Host 即使同源也默认拒绝（防 DNS rebinding）', async () => {
  const { handler } = fakeHost([makeTask('a')])
  const result = await call(handler, {
    headers: { host: '192.168.1.5:3080', origin: 'http://192.168.1.5:3080' },
  })
  assert.equal(result.status, 403)
})

test('DNS rebinding 的典型形态被拒绝（Host 与 Origin 都是攻击者域名）', async () => {
  const { handler } = fakeHost([makeTask('a')])
  const result = await call(handler, {
    headers: { host: 'evil.example:9735', origin: 'http://evil.example:9735' },
  })
  assert.equal(result.status, 403)
})

test('回环 Host 的写操作需要准入头', async () => {
  const { handler } = fakeHost([makeTask('a', { status: 'running' })])
  const result = await call(handler, {
    method: 'POST', url: `${BASE}/cancel`,
    headers: { 'x-dsh-mini-superagent': '' },
    body: { task_id: 'a' },
  })
  assert.equal(result.status, 403)
})

test('POST cancel 调用取消并回卡片', async () => {
  const { handler, calls } = fakeHost([makeTask('a', { status: 'running' })])
  const result = await call(handler, { method: 'POST', url: `${BASE}/cancel`, body: { task_id: 'a' } })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.task.task_id, 'a')
  assert.deepEqual(calls.cancel, [['a', '看板取消']])
})

test('POST retry 调用重试并让 attempt 递增', async () => {
  const { handler, calls } = fakeHost([makeTask('a', { status: 'failed' })])
  const result = await call(handler, { method: 'POST', url: `${BASE}/retry`, body: { task_id: 'a' } })
  assert.equal(result.status, 200)
  assert.deepEqual(calls.retry, ['a'])
  assert.equal(result.json.task.attempt, 2)
})

test('跨站 POST 被拒绝且不产生副作用', async () => {
  const { handler, calls } = fakeHost([makeTask('a', { status: 'running' })])
  const result = await call(handler, {
    method: 'POST',
    url: `${BASE}/cancel`,
    headers: { origin: 'https://evil.example', host: '127.0.0.1:11586' },
    body: { task_id: 'a' },
  })
  assert.equal(result.status, 403)
  assert.deepEqual(calls.cancel, [])
})

test('同源 POST 允许（Origin 与 Host 一致）', async () => {
  const { handler } = fakeHost([makeTask('a', { status: 'running' })])
  const result = await call(handler, {
    method: 'POST',
    url: `${BASE}/cancel`,
    headers: { origin: 'http://127.0.0.1:11586', host: '127.0.0.1:11586' },
    body: { task_id: 'a' },
  })
  assert.equal(result.status, 200)
})

test('任务不存在返回 404', async () => {
  const { handler } = fakeHost([])
  const result = await call(handler, { method: 'POST', url: `${BASE}/cancel`, body: { task_id: 'ghost' } })
  assert.equal(result.status, 404)
  assert.match(result.json.error, /ghost/)
})

test('请求体不是 JSON 返回 400', async () => {
  const { handler } = fakeHost([makeTask('a')])
  const result = await call(handler, { method: 'POST', url: `${BASE}/retry`, body: '{not json' })
  assert.equal(result.status, 400)
})

test('取消失败返回 409 并带上原因', async () => {
  const { handler } = fakeHost([makeTask('a', { status: 'running' })], { cancelThrows: true })
  const result = await call(handler, { method: 'POST', url: `${BASE}/cancel`, body: { task_id: 'a' } })
  assert.equal(result.status, 409)
  assert.match(result.json.error, /不能取消/)
})

test('快照带工作区列表与归档计数', async () => {
  const { handler } = fakeHost([
    makeTask('a', { status: 'done', workspaceId: 'w-1', workspaceTitle: '项目 A' }),
    makeTask('b', { status: 'done', archivedAt: '2026-01-02T00:00:00.000Z' }),
  ])
  const result = await call(handler, {})
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.workspaces, [{ id: 'w-1', title: '项目 A', path: 'C:\\a' }])
  assert.equal(result.json.counts.archived, 1)
  const [first, second] = result.json.tasks
  assert.equal(first.workspace_id, 'w-1')
  assert.equal(first.workspace_title, '项目 A')
  assert.equal(second.archived_at, '2026-01-02T00:00:00.000Z')
})

test('POST /archive 触发一次归档巡检并回计数', async () => {
  const { handler, calls } = fakeHost([makeTask('a', { status: 'done' })])
  const result = await call(handler, { method: 'POST', url: `${BASE}/archive`, body: {} })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.scanned, 2)
  assert.equal(result.json.archived, 1)
  assert.equal(calls.archive, 1)
  assert.ok(result.json.counts, '要带一份最新计数')
})

test('POST /target 设置派发目标工作区', async () => {
  const { handler, calls } = fakeHost([])
  const result = await call(handler, {
    method: 'POST', url: `${BASE}/target`,
    body: { session_id: 's1', workspace: 'w-1' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.target.workspace_id, 'w-1')
  assert.deepEqual(calls.target, { sessionId: 's1', workspace: 'w-1' })
})

test('POST /target 传空字符串表示清除', async () => {
  const { handler } = fakeHost([])
  const result = await call(handler, {
    method: 'POST', url: `${BASE}/target`,
    body: { session_id: 's1', workspace: '' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.target, null)
})

test('POST /target 缺 session_id 返回 400', async () => {
  const { handler } = fakeHost([])
  const result = await call(handler, { method: 'POST', url: `${BASE}/target`, body: { workspace: 'w-1' } })
  assert.equal(result.status, 400)
  assert.match(result.json.error, /session_id/)
})

test('POST /target 解析失败返回 409 并带候选', async () => {
  const { handler } = fakeHost([])
  const result = await call(handler, {
    method: 'POST', url: `${BASE}/target`,
    body: { session_id: 's1', workspace: 'nope' },
  })
  assert.equal(result.status, 409)
  assert.match(result.json.error, /nope/)
})

test('快照带每个会话的派发目标', async () => {
  const { handler, dispatch } = fakeHost([makeTask('a')])
  dispatch.targets.set('s1', { workspace_id: 'w-1', title: '项目 A', path: 'C:\\a' })
  const result = await call(handler, {})
  assert.deepEqual(result.json.targets, { s1: { workspace_id: 'w-1', title: '项目 A', path: 'C:\\a' } })
})

// ---------------------------------------------------------------- 续派（plans/08 阶段 1）

/*
 * 看板的「续派」按钮**不新造 HTTP 路由**：它复用 `/retry` 这条既有写入通道，
 * 只是多给一个可选的 `message`。用户填的那句话就是 `dispatch.message()` 的正文，
 * 而 `retry()` 内部走的也是同一个方法——两条入口同源，语义不会分叉。
 *
 * 这几条用例钉的是三件事：带 `message` 时走 message 而不走 retry；任务还在跑时
 * **拒绝**（409，不能把要求插进正在跑的回合）；message 抛错时也回 409 并带原因。
 */

test('POST /retry 带 message → 走续派（message）而不是 retry', async () => {
  const { handler, calls } = fakeHost([makeTask('a', { status: 'done' })])
  const result = await call(handler, {
    method: 'POST', url: `${BASE}/retry`,
    body: { task_id: 'a', message: '把 lint 也跑一遍' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.deepEqual(calls.retry, [], '带 message 时不该再走 retry（那会换指令语义）')
  assert.equal(calls.message.length, 1)
  assert.equal(calls.message[0].id, 'a')
  assert.match(calls.message[0].text, /把 lint 也跑一遍/, '用户写的话必须原样进会话')
  assert.match(calls.message[0].text, /【续派】/, '前缀必须与 dispatch_launch 的那份同源')
  assert.equal(calls.message[0].mode, 'queue')
})

test('POST /retry 带 message 时任务未结算 → 409，且什么都不投递', async () => {
  const { handler, calls } = fakeHost([makeTask('a', { status: 'running' })])
  const result = await call(handler, {
    method: 'POST', url: `${BASE}/retry`,
    body: { task_id: 'a', message: '插一句' },
  })
  assert.equal(result.status, 409)
  assert.match(result.json.error, /还在 running，不能续派/, '必须说清「还在跑」与「不能续派」两件事')
  assert.deepEqual(calls.message, [], '拒绝时一条消息都不该投出去')
  assert.deepEqual(calls.retry, [])
})

test('POST /retry 不带 message（或只有空白）仍是原来的重试', async () => {
  const { handler, calls } = fakeHost([makeTask('a', { status: 'failed' })])
  const result = await call(handler, {
    method: 'POST', url: `${BASE}/retry`,
    body: { task_id: 'a', message: '   ' },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(calls.retry, ['a'], '空白 message 按「没给」处理，走重试')
  assert.deepEqual(calls.message, [])
  assert.equal(result.json.task.attempt, 2)
})

test('POST /retry 续派时 message() 抛错 → 409 并带上原因', async () => {
  const { handler } = fakeHost([makeTask('a', { status: 'done' })], { messageThrows: true })
  const result = await call(handler, {
    method: 'POST', url: `${BASE}/retry`,
    body: { task_id: 'a', message: '补一句' },
  })
  assert.equal(result.status, 409)
  assert.match(result.json.error, /子会话不可用/, '投递失败的原因要原样透给看板')
})

test('POST /cancel 带 message 时仍按取消处理（message 只对 /retry 有意义）', async () => {
  const { handler, calls } = fakeHost([makeTask('a', { status: 'running' })])
  const result = await call(handler, {
    method: 'POST', url: `${BASE}/cancel`,
    body: { task_id: 'a', message: '顺手带了一句' },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(calls.cancel, [['a', '看板取消']])
  assert.deepEqual(calls.message, [], '取消口不读 message，别让它悄悄变成两条副作用')
})
