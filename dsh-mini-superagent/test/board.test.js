/**
 * 看板快照的单测：只测纯函数（boardTask / boardSnapshot），不需要起 HTTP 服务。
 * 形状是客户端契约的一部分，改字段会在这里先失败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { VERSION } from '../src/constants.js'
import { boardSnapshot, boardTask, createBoardHandler } from '../src/board.js'

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

// ---------------------------------------------------------------- HTTP 路由

/** 假宿主：handler 需要 table.get / cancel / retry。 */
function fakeHost(tasks, { cancelThrows = false } = {}) {
  const calls = { cancel: [], retry: [] }
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
