/**
 * 恢复与容错的回归测试：重启后的排队、瞬时故障续跑、读回执、progress 节流。
 *
 * 四条都来自与上游 `dsh-superagent` 的对照（plans/05 §七「可对齐」第 2/3/4/7 条）：
 * - 上游 `resume()` 会把 pending 的 launch 重新排队；我们原先一律标 interrupted，排队任务要人工重派。
 * - 上游对 `transient()` 错误退避续跑 3 次；我们原先连 `agent/error` 都没订，5xx 会被当成「回合正常结束」。
 * - 上游把「投递」与「读入」拆成两个事实（`inputsDelivered` / `inputsRead`）；我们只有投递。
 * - 上游用同名 notice 覆盖未发送的 progress；我们没有队列，退化成按时间节流。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SOURCE_KIND, TIME_BASIS } from '../src/constants.js'
import { Dispatch, isTransient } from '../src/dispatch.js'
import { boardStats, settleTimeOf } from '../src/stats.js'
import { writeState } from '../src/store.js'

// ---------------------------------------------------------------- 夹具

function makeHost() {
  const agents = new Map()
  const warns = []
  const ctx = {
    logger: { warn: (...args) => warns.push(args.map(String).join(' ')), info() {}, error() {} },
    get: () => undefined,
    on: () => () => {},
    effect: fn => fn,
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    sessionController: {
      async create() {},
      async rename() {},
      async resolveAgent(id) {
        return agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'not-found' } }
      },
      async prompt() {},
    },
  }
  return { ctx, agents, warns }
}

function makeAgent(id, status = 'running') {
  return {
    id, status,
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    steer() {}, followup() {}, inject() {}, cancel() {},
  }
}

async function withDispatch(config, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-rc-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    ...config,
  })
  d.workspaces = {
    list: () => [],
    resolve: async () => undefined,
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined,
    defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return dir },
  }
  d.sessions = {
    cwdFor: () => dir,
    hint: () => {},
    dispose: () => {},
    restrictTools: () => () => {},
    forgetRestrict: () => {},
    holds: () => false,
    async createWorker(sessionId) {
      const agent = makeAgent(sessionId)
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  try {
    await fn({ d, host, dir })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * 等到条件成立再断言，而不是固定睡 N 毫秒。
 *
 * 为什么：`onWorkerError()` 里是 `void this.failTurn(...)`，而 `failTurn()` 先
 * `await persistCritical()`（真实写盘）再 `relayFailure()`。固定 10ms 在单文件里够，
 * 但全量测试会并发跑多个测试文件，CPU 与磁盘排队时偶尔不够——实测全量连跑 10 次
 * 有 1 次在「非瞬时故障」这条上等到投递 0 条（`delivered.length` 0 !== 1）。
 * 那是等待方式的问题，不是投递丢了：超时上限给到 2s，条件成立即返回，
 * 断言仍然是「恰好 1 条」，没有放宽任何事实。
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return true
    if (Date.now() - started > timeoutMs) return false
    await tick()
  }
}

const workerTask = (extra = {}) => ({
  id: 't-rc', title: '任务', brief: 'b', parentSessionId: 'lead',
  workerSessionId: 'dispatch-t-rc', status: 'running', reports: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...extra,
})

// ---------------------------------------------------------------- 重启恢复

test('重启后：没启动过的排队任务重新入队，跑过的标 interrupted', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-rc-restore-'))
  const base = new Date().toISOString()
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [
      // queued 且没有 startedAt：会话还没建过，可以安全重排
      { ...workerTask({ id: 't-q', workerSessionId: 'dispatch-t-q', status: 'queued' }), createdAt: base, updatedAt: base },
      // running 且已经有 startedAt：新进程里可能做了一半，不能重跑
      { ...workerTask({ id: 't-r', workerSessionId: 'dispatch-t-r', status: 'running', startedAt: base }), createdAt: base, updatedAt: base },
      // 已结算：保持原状
      { ...workerTask({ id: 't-d', workerSessionId: 'dispatch-t-d', status: 'done' }), createdAt: base, updatedAt: base },
    ],
  }, base)

  const d = new Dispatch(host.ctx, { stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0 })
  try {
    await d.restore()

    assert.equal(d.table.get('t-q').status, 'queued', '排队中的任务应当接着排队，而不是要人工重派')
    assert.deepEqual(d.table.queue, ['t-q'], '重排的任务必须在队列里，否则 pump 永远看不到它')
    assert.equal(d.table.get('t-r').status, 'interrupted', '跑过的任务不能假装还活着')
    assert.equal(d.table.get('t-d').status, 'done', '已结算的不该被改写')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * 恢复标 `interrupted` 必须**写权威结算时刻**（plans/09 P0）。
 *
 * 钉的缺陷：`restore()` 这条路径曾经裸写 `task.status = 'interrupted'` +
 * `task.updatedAt = now()`，绕过了 `TaskTable.transition()`。`interrupted` 在
 * `SETTLED` 里是终态，于是这条**刚恢复的新任务**没有 `settledAt`，
 * `stats.js` 的 `settleTimeOf()` 只能回退 `updatedAt` 并把它计进
 * `coverage.fallbackCount` / `timeBasis: 'updatedAt-fallback'`——「旧数据欠账」
 * 的计数被自己的新数据污染，那个数字从此失去诊断意义。
 */
test('重启恢复标 interrupted 的任务会写 settledAt，时间基准不是 updatedAt-fallback', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-rc-settled-'))
  const base = new Date().toISOString()
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [
      // running 且已启动：新进程里那个 worker 可能做了一半，恢复时必须标 interrupted
      { ...workerTask({ id: 't-r', workerSessionId: 'dispatch-t-r', status: 'running', startedAt: base }), createdAt: base, updatedAt: base },
      // queued 但带着上一轮的 startedAt（retry 的 reopen 不清它）：走 force 分支
      {
        ...workerTask({ id: 't-qs', workerSessionId: 'dispatch-t-qs', status: 'queued', startedAt: base }),
        createdAt: base, updatedAt: base,
      },
    ],
  }, base)

  const d = new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
  })
  try {
    await d.restore()

    for (const id of ['t-r', 't-qs']) {
      const task = d.table.get(id)
      assert.equal(task.status, 'interrupted', `${id} 必须被标成 interrupted`)
      assert.ok(task.settledAt, `${id} 进了终态就必须有权威结算时刻，否则会被当成旧数据欠账`)
      assert.ok(Number.isFinite(Date.parse(task.settledAt)), `${id} 的 settledAt 必须是可解析的时间`)
      // 不比对 `settledAt === updatedAt`：两者由两次 now() 写入，跨毫秒时差 1ms 是正常的。
      assert.ok(Math.abs(Date.parse(task.settledAt) - Date.parse(task.updatedAt)) < 1000,
        `${id} 的 settledAt 与 updatedAt 应当在同一时刻附近`)
      assert.equal(settleTimeOf(task).basis, TIME_BASIS.SETTLED,
        `${id} 的时间基准必须是 settledAt，不能回退成 updatedAt-fallback`)
    }

    // 整体口径：这两条新恢复的任务不该把 coverage 的回退计数顶起来。
    const stats = boardStats(d, { window: 'all' })
    assert.equal(stats.coverage.fallbackCount, 0, '新恢复的任务不是旧数据，回退条数必须是 0')
    assert.equal(stats.coverage.timeBasis, TIME_BASIS.SETTLED)
    assert.equal(stats.coverage.settled, 2, '两条恢复的任务都要进已结算计数')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * 「queued 且从没启动过」重排之后**不能**有 `settledAt`：它没有被结算，
 * 只回到了队列。留下一个结算时刻会把一条在排队的任务算进已结算口径。
 */
test('重启重排的排队任务不写 settledAt', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-rc-req-'))
  const base = new Date().toISOString()
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [{ ...workerTask({ id: 't-q', workerSessionId: 'dispatch-t-q', status: 'queued' }), createdAt: base, updatedAt: base }],
  }, base)

  const d = new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
  })
  try {
    await d.restore()
    const task = d.table.get('t-q')
    assert.equal(task.status, 'queued')
    assert.equal(task.settledAt, undefined, '重新入队的任务还没结算，不能带结算时刻')
    assert.deepEqual(d.table.queue, ['t-q'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 瞬时故障

test('isTransient 只认网络与限流类错误', () => {
  assert.equal(isTransient(Object.assign(new Error('boom'), { status: 429 })), true)
  assert.equal(isTransient(new Error('fetch failed')), true)
  assert.equal(isTransient(new Error('socket hang up')), true)
  assert.equal(isTransient(Object.assign(new Error('nope'), { status: 401 })), false)
  assert.equal(isTransient(new Error('ENOENT: no such file')), false)
})

test('瞬时故障：退避后续跑，任务保持 running', async () => {
  await withDispatch({ retryBackoffMs: [1] }, async ({ d, host }) => {
    const delivered = []
    d.sessions.deliver = async (sessionId, requestId, text) => { delivered.push({ sessionId, requestId, text }); return { delivered: 'inbox', woke: true } }
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-rc')
    host.agents.set('dispatch-t-rc', worker)
    const task = workerTask()
    d.table.add(task)

    d.onWorkerError(worker, Object.assign(new Error('model overloaded'), { status: 503 }))
    assert.equal(task.status, 'running', '瞬时故障不该结算任务')
    assert.ok(task.retryAt, '应当记下一个重试时间，看板能看到')

    await waitFor(() => delivered.length >= 1)

    assert.equal(delivered.length, 1, '退避结束后应当投一条「继续」的消息')
    assert.equal(delivered[0].sessionId, 'dispatch-t-rc')
    assert.match(delivered[0].text, /继续/)
    assert.equal(task.status, 'running')
    assert.equal(task.retryAt, undefined)
  })
})

test('非瞬时故障：直接 failed 并回报原因，不挂在 running 上', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const delivered = []
    d.sessions.deliver = async (_sessionId, _requestId, text) => { delivered.push(text); return { delivered: 'inbox', woke: false } }
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-rc')
    host.agents.set('dispatch-t-rc', worker)
    const task = workerTask()
    d.table.add(task)

    d.onWorkerError(worker, new Error('permission denied'))
    // 等「结算成 failed + 投递落地」，不是固定睡 10ms（见 `waitFor` 的注释）。
    await waitFor(() => task.status === 'failed' && delivered.length >= 1)
    // 再多走两拍：重复回报要被下面「恰好 1 条」抓到，不能让轮询抢在第二条之前返回。
    await tick()
    await tick()

    assert.equal(task.status, 'failed')
    assert.match(task.error, /permission denied/)
    assert.equal(delivered.length, 1, '失败原因要回报给主会话，而不是只留在任务表里')
  })
})

test('瞬时故障用完次数后转 failed', async () => {
  await withDispatch({ retryBackoffMs: [1] }, async ({ d, host }) => {
    d.sessions.deliver = async () => ({ delivered: 'inbox', woke: true })
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-rc')
    host.agents.set('dispatch-t-rc', worker)
    const task = workerTask()
    d.table.add(task)

    const err = Object.assign(new Error('rate limit'), { status: 429 })
    d.onWorkerError(worker, err)
    // 第一次是退避续跑：`resumeAfterError()` 投递完才清 `retryAt`，等它清空即投递落地。
    await waitFor(() => task.retryAt === undefined)
    assert.equal(task.status, 'running', '第一次应当续跑')

    d.onWorkerError(worker, err)
    await waitFor(() => task.status === 'failed')
    assert.equal(task.status, 'failed', '次数用完就该失败，不能无限重试')
    assert.match(task.error, /瞬时故障连续 1 次/)
  })
})

test('retryTransient=false 时不续跑，直接失败', async () => {
  await withDispatch({ retryTransient: false }, async ({ d, host }) => {
    d.sessions.deliver = async () => ({ delivered: 'inbox', woke: false })
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-rc')
    host.agents.set('dispatch-t-rc', worker)
    const task = workerTask()
    d.table.add(task)

    d.onWorkerError(worker, Object.assign(new Error('overloaded'), { status: 503 }))
    await waitFor(() => task.status === 'failed')

    assert.equal(task.status, 'failed')
  })
})

// ---------------------------------------------------------------- 读回执

test('读回执：msg / retry 的清掉待读标记，relay 不算', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const task = workerTask({ inputPendingAt: new Date().toISOString(), inputReadAt: undefined })
    d.table.add(task)
    const session = { id: 'dispatch-t-rc' }

    // 报告回流用的是 relay：主会话读它，不代表 worker 读了追问
    d.onSessionEvent(session, { type: 'user/message', data: { id: `${SOURCE_KIND}:t-rc:relay:x:1` } })
    assert.equal(task.inputReadAt, undefined, 'relay 不能被当成「输入已读」')

    d.onSessionEvent(session, { type: 'user/message', data: { id: `${SOURCE_KIND}:t-rc:msg:x:1` } })
    assert.ok(task.inputReadAt, 'msg 才是追问，读到就该清标记')
    assert.equal(task.inputPendingAt, undefined)
  })
})

test('dispatch_message 投递成功后留下「待读」标记', async () => {
  await withDispatch({}, async ({ d, host }) => {
    d.sessions.deliver = async () => ({ delivered: 'inbox', woke: true })
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-rc')
    host.agents.set('dispatch-t-rc', worker)
    const task = workerTask()
    d.table.add(task)

    await d.message(task, '补一下测试', 'queue')

    assert.ok(task.inputPendingAt, '只投递不等于 worker 读到了')
    assert.equal(task.inputReadAt, undefined)
    assert.match(d.card(task).input_pending_at, /^\d{4}-/)
  })
})

// ---------------------------------------------------------------- progress 节流
//
// P0-2 之后 progress 的**默认准入是 ledger**（只入库、不回流），所以默认配置下
// 这两条节流用例永远不会触发回流，必须显式把 progress 配进 `directReportStatuses`
// 才谈得上「节流」。用例这样写而不是直接删掉：节流逻辑仍然存在，用户配置放开
// progress 时它就是唯一的防刷屏措施，不能没人守。

test('progress 默认只入库不回流（P0-2 准入分级）', async () => {
  await withDispatch({ progressRelayIntervalMs: 60000 }, async ({ d, host }) => {
    const delivered = []
    d.sessions.deliver = async (_sessionId, _requestId, text) => { delivered.push(text); return { delivered: 'inbox', woke: false } }
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-rc')
    host.agents.set('dispatch-t-rc', worker)
    const task = workerTask()
    d.table.add(task)

    const result = await d.report(worker, { status: 'progress', summary: '第一步' })

    assert.equal(result.admission, 'ledger', '默认配置下 progress 的准入是 ledger')
    assert.equal(delivered.length, 0, 'progress 默认不该叫醒主会话')
    assert.equal(task.reports.length, 1, '只入库不等于丢掉：dispatch_inspect 仍看得到')
  })
})

test('progress 配进 directReportStatuses 后按间隔节流，被挡下的仍然入库', async () => {
  await withDispatch({
    progressRelayIntervalMs: 60000,
    // 这条用例守的是**节流**：`noticeMergeWindowMs: 0` 关掉 P1-1 的合并窗口，
    // 否则第一条 progress 会先进窗口（默认 1.5 秒），测的就不是节流了。
    noticeMergeWindowMs: 0,
    directReportStatuses: ['blocked', 'failed', 'progress'],
  }, async ({ d, host }) => {
    const delivered = []
    d.sessions.deliver = async (_sessionId, _requestId, text) => { delivered.push(text); return { delivered: 'inbox', woke: false } }
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-rc')
    host.agents.set('dispatch-t-rc', worker)
    const task = workerTask()
    d.table.add(task)

    const first = await d.report(worker, { status: 'progress', summary: '第一步' })
    const second = await d.report(worker, { status: 'progress', summary: '第二步' })

    assert.equal(first.admission, 'direct')
    assert.equal(first.throttled, undefined)
    assert.equal(second.throttled, true, '一分钟内的第二条 progress 不该再回流')
    assert.equal(delivered.length, 1)
    assert.equal(task.reports.length, 2, '被节流的报告仍然要入库，dispatch_inspect 看得到')
  })
})

test('progressRelayIntervalMs=0 且 progress 直通时不节流', async () => {
  await withDispatch({
    progressRelayIntervalMs: 0,
    // 同上：关掉 P1-1 的合并窗口，单独看「不节流 = 每条都发」。
    noticeMergeWindowMs: 0,
    directReportStatuses: ['blocked', 'failed', 'progress'],
  }, async ({ d, host }) => {
    const delivered = []
    d.sessions.deliver = async (_sessionId, _requestId, text) => { delivered.push(text); return { delivered: 'inbox', woke: false } }
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-rc')
    host.agents.set('dispatch-t-rc', worker)
    d.table.add(workerTask())

    await d.report(worker, { status: 'progress', summary: '一' })
    await d.report(worker, { status: 'progress', summary: '二' })

    assert.equal(delivered.length, 2)
  })
})
