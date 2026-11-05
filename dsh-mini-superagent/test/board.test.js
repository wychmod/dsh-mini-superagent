/**
 * 看板快照的单测：只测纯函数（boardTask / boardSnapshot），不需要起 HTTP 服务。
 * 形状是客户端契约的一部分，改字段会在这里先失败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { VERSION } from '../src/constants.js'
import { boardSnapshot, boardTask, createBoardHandler } from '../src/board.js'

const BASE = '/dsh-mini-superagent/board'

/** 假的 IncomingMessage：够 readJson 用（on/data/end/error）。默认带本机 Host。 */
function fakeReq({ method = 'GET', url = BASE, headers = {}, body } = {}) {
  const finalHeaders = { host: '127.0.0.1:11586', ...headers }
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
  const dispatch = {
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

test('非回环但同源页面可以读（远程浏览器访问自己的页面）', async () => {
  const { handler } = fakeHost([makeTask('a')])
  const result = await call(handler, {
    headers: { host: '192.168.1.5:3080', origin: 'http://192.168.1.5:3080' },
  })
  assert.equal(result.status, 200)
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
