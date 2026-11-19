/**
 * 看板路由的宿主准入闸门（0.10.2）。
 *
 * 钉的是一个**对外可见的安全缺口**：看板路由是 `webServer.register({ kind: 'prefix' })`
 * 注册的，而 `webServer` 只做路径分发、不做准入。准入长在 `connection` 服务里
 * （Host 信任清单 + 浏览器登录凭据）——DSH 自己的 `/api` 会问它，我们的 handler
 * 此前一行都没问。后果：本机任意进程 `curl 127.0.0.1:<port>/dsh-mini-superagent/board`
 * 免凭据能读到全部任务标题 / 工作目录 / 报告摘要，也能归档、取消、改派发目标、
 * 往会话投话。
 *
 * 这里钉五件事：
 * 1. `requestRejection` 回 403 → **任意**路由回 403，且没往下走（快照没被读、动作没执行）；
 * 2. 回 401 → 回 401（「没登录」与「地址不可信」在文案上也要分得开）；
 * 3. 回 undefined → 正常放行，原有行为逐字段不变；
 * 4. `ctx.get('connection')` 为 undefined（headless / 旧宿主）→ 仍放行、不抛错；
 * 5. 闸门在**所有**路由分支之前——包括未知路由（404 之前也该先被拒）。
 *
 * 关键验收：去掉 handler 开头那段 `requestRejection` 检查，前两组用例会红
 * （会拿到 200 与真实数据）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createBoardHandler } from '../src/board.js'

const BASE = '/dsh-mini-superagent/board'

/* ---------------------------------------------------------------- 夹具 */

/**
 * 假的 IncomingMessage：够 `readJson` 用（on / data / end / error）。
 *
 * 默认带**回环 Host** 与准入头 `x-dsh-mini-superagent`——这样请求能穿过
 * `readAllowed` / `writeAllowed`，于是测试真正钉住的是 `connection` 这一层：
 * 如果闸门没拦住，请求会一路走到底并拿到 200。
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

/** 造一个最小任务对象（与 board.test.js 的同名字段形状一致）。 */
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

/**
 * 假宿主 + 假 Dispatch。
 *
 * `rejection` 决定 `connection.requestRejection` 的返回值：`undefined` 表示放行。
 * `mode: 'absent'` 时 `ctx.get('connection')` 返回 undefined（headless 形态）；
 * `service` 可直接给一个自定义形状的服务（用来测「有服务但没有这个方法」）。
 * `calls` 记录「有没有真的往下走」——归档 / 取消 / 投递都记在这里，闸门生效时
 * 它们必须一条都没有。
 */
function fakeHost({ rejection, mode = 'present', service } = {}) {
  const calls = { archive: 0, cancel: 0, message: 0, rejected: 0 }

  const tasks = new Map([
    ['a', makeTask('a')],
    ['done-1', makeTask('done-1', { status: 'done' })],
  ])

  const dispatch = {
    ctx: { agents: { get: () => undefined } },
    config: { leadSessionId: 'mas-lead' },
    table: { tasks, maxWorkers: 6, get: id => tasks.get(id), byWorker: () => undefined },
    clientReady: undefined,
    targets: new Map(),
    workspaces: { list: () => [{ id: 'w-1', title: '项目 A', path: 'C:\\a' }] },
    async archiveStale() { calls.archive += 1; return { scanned: 0, archived: 0, failed: 0 } },
    /*
     * 写动作**不抛错**：抛错会让「闸门放行」与「闸门拒绝了但代码继续跑」两种
     * 情况在状态码上分不开（都变成 409）。这里只记计数，让用例能断言
     * 「动作真的执行了 / 真的没执行」。
     */
    async cancel() { calls.cancel += 1 },
    async message() { calls.message += 1 },
    async continueTask() { calls.message += 1 },
    async retry() { calls.cancel += 1 },
    async setTarget() { calls.target = (calls.target ?? 0) + 1; return undefined },
    async selfCheck() {
      return { version: '0.10.2', client: { inGraph: false, path: null, ready: null } }
    },
  }

  /** 宿主那半边 `connection` 服务的假实现：只实现我们用到的那一个方法。 */
  const hostService = service ?? {
    requestRejection() {
      calls.rejected += 1
      return rejection
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    get: name => (name === 'connection' && mode === 'present' ? hostService : undefined),
  }

  return { ctx, dispatch, calls, handler: createBoardHandler(ctx, dispatch) }
}

/** 一条包着 403 / 401 的拒绝，语义上「不该读到任何东西」。 */
function assertRefused(result, status, label) {
  assert.equal(result.status, status, `${label}：应回 ${status}`)
  assert.equal(result.json?.ok, false, `${label}：拒绝体必须是 ok:false`)
  assert.equal(typeof result.json?.error, 'string', `${label}：拒绝体要说清原因`)
  assert.equal(result.json?.tasks, undefined, `${label}：拒绝时不能泄露任务列表`)
  assert.equal(result.headers['cache-control'], 'no-store', `${label}：拒绝响应同样不缓存`)
}

/* ---------------------------------------------------------------- 错误码 */

test('401 与 403 映射成不同的 error_code（排障脚本不该靠读中文分辨）', async () => {
  const forbidden = await call(fakeHost({ rejection: 403 }).handler, {})
  const unauthorized = await call(fakeHost({ rejection: 401 }).handler, {})
  assert.equal(forbidden.json.code, 'dispatch/forbidden')
  assert.equal(unauthorized.json.code, 'dispatch/unauthenticated',
    '401 若也落到 dispatch/internal，排障脚本会把「去登录」误判成「服务内部错误」')
  assert.notEqual(forbidden.json.code, unauthorized.json.code)
})

/* ---------------------------------------------------------------- 403 */

test('requestRejection 回 403：GET /board 被拒，且没读到任何任务', async () => {
  const host = fakeHost({ rejection: 403 })
  const result = await call(host.handler, {})
  assertRefused(result, 403, 'GET /board')
  assert.match(result.json.error, /不受信任/, '403 的文案要说「地址不可信」，不能与「没登录」混用')
  assert.equal(host.calls.rejected, 1, '每条请求只问一次准入')
})

test('requestRejection 回 403：写路由（POST /archive、/cancel、/retry、/target）同样被拒且不执行', async () => {
  const host = fakeHost({ rejection: 403 })
  const posts = [
    ['/archive', { task_id: 'done-1' }],
    ['/archive-task', { task_id: 'done-1' }],
    ['/cancel', { task_id: 'a' }],
    ['/retry', { task_id: 'a' }],
    ['/target', { session_id: 's1', workspace: 'w-1' }],
    ['/client-ready', { ok: true }],
  ]
  for (const [suffix, body] of posts) {
    const result = await call(host.handler, { method: 'POST', url: `${BASE}${suffix}`, body })
    assertRefused(result, 403, `POST ${suffix}`)
  }
  assert.equal(host.calls.archive + host.calls.cancel + host.calls.message, 0,
    '闸门生效时归档 / 取消 / 投递一条都不能执行——读路由被拒不等于写路由安全')
})

test('requestRejection 回 403：未知路由也先被拒（闸门在 404 之前）', async () => {
  const host = fakeHost({ rejection: 403 })
  const result = await call(host.handler, { url: `${BASE}/nope` })
  assert.equal(result.status, 403, '未知路径不能先回 404：那会告诉陌生调用方「哪些端点存在」')
})

test('requestRejection 回 403：所有只读端点一起被拒（闸门覆盖全部路由，不是逐条加）', async () => {
  const host = fakeHost({ rejection: 403 })
  const gets = ['', '/selfcheck', '/retired', '/stats', '/analytics']
  for (const suffix of gets) {
    const result = await call(host.handler, { url: `${BASE}${suffix}` })
    assertRefused(result, 403, `GET ${suffix || '(根)'}`)
  }
})

/* ---------------------------------------------------------------- 401 */

test('requestRejection 回 401：回 401，文案指向「先登录 DSH」', async () => {
  const host = fakeHost({ rejection: 401 })
  const result = await call(host.handler, {})
  assertRefused(result, 401, 'GET /board')
  assert.match(result.json.error, /登录/, '401 是「没登录」，文案要能指导用户去登录')
  assert.doesNotMatch(result.json.error, /不受信任/, '401 不能套用 403 的文案——两种拒绝的排障方向不同')
})

test('requestRejection 回 401：写路由也是 401（先登录，不是先查权限）', async () => {
  const host = fakeHost({ rejection: 401 })
  const result = await call(host.handler, { method: 'POST', url: `${BASE}/archive`, body: { task_id: 'a' } })
  assertRefused(result, 401, 'POST /archive')
  assert.equal(host.calls.archive, 0, '未登录的归档请求不能真的执行')
})

/* ---------------------------------------------------------------- 放行 */

test('requestRejection 回 undefined：放行，GET /board 的原有行为不变', async () => {
  const host = fakeHost({ rejection: undefined })
  const result = await call(host.handler, {})
  assert.equal(result.status, 200, 'undefined = 放行')
  assert.equal(result.json.concurrency.max, 6, '快照里的并发上限要照旧读自 dispatch.table.maxWorkers')
  assert.ok(result.json.tasks.some(task => task.task_id === 'a'), '放行时任务必须真的读得出来')
  assert.equal(host.calls.rejected, 1, '放行路径也要问过准入（问过才叫闸门）')
})

test('requestRejection 回 undefined：写路由照常执行，但仍要过自建栅栏', async () => {
  const host = fakeHost({ rejection: undefined })

  // 带自定义头：穿过 writeAllowed，真的执行取消。
  const ok = await call(host.handler, { method: 'POST', url: `${BASE}/cancel`, body: { task_id: 'a' } })
  assert.equal(ok.status, 200, '带齐 Host 与自定义头时 writeAllowed 应放行')
  assert.equal(host.calls.cancel, 1, '放行路径必须真的执行动作（否则这条用例证明不了任何事）')

  // 不带自定义头：connection 放行了，但自建的 CSRF 栅栏必须拦住。
  const noHeader = await call(host.handler, {
    method: 'POST',
    url: `${BASE}/cancel`,
    headers: { 'x-dsh-mini-superagent': '' },
    body: { task_id: 'a' },
  })
  assert.equal(noHeader.status, 403, '两层栅栏是叠加的：connection 放行不等于写操作免检')
})

/* ---------------------------------------------------------------- headless */

test('宿主没有 connection 服务（headless）：静默放行，不抛错', async () => {
  const host = fakeHost({ mode: 'absent' })
  const result = await call(host.handler, {})
  assert.equal(result.status, 200, '缺服务时退回旧行为，不能打成 500')
  assert.ok(result.json.tasks.some(task => task.task_id === 'a'))
})

test('宿主没有 connection 服务：写路由仍受自建栅栏保护（不是完全裸奔）', async () => {
  const host = fakeHost({ mode: 'absent' })
  const noHeader = await call(host.handler, {
    method: 'POST',
    url: `${BASE}/cancel`,
    headers: { 'x-dsh-mini-superagent': '' },
    body: { task_id: 'a' },
  })
  assert.equal(noHeader.status, 403, '闸门缺席时 writeAllowed 是唯一还站着的防线，不能被一起拆掉')
  assert.equal(host.calls.cancel, 0, '被自建栅栏拦下时动作不能执行')
})

test('ctx.get 本身不提供 connection 键：可选链不抛错', async () => {
  const host = fakeHost({ rejection: 403 })
  // 模拟「ctx 没有 get 方法」这种更旧的宿主形态。
  const bare = { logger: { info() {}, warn() {} } }
  const handler = createBoardHandler(bare, host.dispatch)
  const result = await call(handler, {})
  assert.equal(result.status, 200, '没有 ctx.get 时应静默放行，而不是 TypeError')
})

test('requestRejection 不是函数（旧宿主只给了别的形状）：静默放行', async () => {
  const host = fakeHost({ mode: 'present', service: { requestRejection: undefined } })
  const result = await call(host.handler, {})
  assert.equal(result.status, 200, '服务存在但没有这个方法时，退回旧行为')
})
