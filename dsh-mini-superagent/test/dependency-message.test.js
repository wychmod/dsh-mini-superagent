/**
 * 依赖准入：**追问不能越过 `dependsOn`**。
 *
 * 审计里确认的漏洞：一条因前置没满足而停在 `queued` 的任务（`blockedBy` 非空）
 * 能被 `dispatch_message` 显式唤醒，`message()` 只挡 `cancelled` / `archived`，
 * 之后 `transition(force)` 把它改成 `running`——用户看到「还在等 A，B 却开跑了」，
 * 声明好的先后顺序被一条追问打乱。
 *
 * 修法：`message()` 在投递**之前**复用 `#blockedStateOf()` 现算一次依赖判定，
 * 被挡就抛 `dispatch/conflict`，状态与队列原样不动。三条入口
 * （`dispatch_message` / `dispatch_launch({continue_task_id})` / 看板续派）都经由
 * `message()`，所以这一道闸对三者同时生效。
 *
 * 本文件四个用例：
 *   1. 被挡任务 `dispatch_message` → 拒，且状态仍是 `queued`、没有半条投递；
 *   2. 前置 `done` 之后同一条 `dispatch_message` → 放行（闸门不能把正常路径也挡住）；
 *   3. 没有 `dependsOn` 的排队任务 → 与改动前完全一致（回归）；
 *   4. 续派（`continueTask`，工具与看板共用）撞上同一道闸 → 同样被拒。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BLOCK_REASONS, ERROR_CODES } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { toolDefinitions } from '../src/tools.js'

// ---------------------------------------------------------------- 夹具

function makeHost() {
  const agents = new Map()
  return {
    ctx: {
      logger: { warn() {}, info() {}, error() {} },
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
        async state() { return { sessionId: 'x' } },
        async list() { return { items: [] } },
      },
    },
    agents,
  }
}

function makeWorker(id) {
  return {
    id,
    status: 'idle',
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    cancel() {}, steer() {}, followup() {}, inject() {},
  }
}

/**
 * 真实 `Dispatch` 的最小夹具。
 *
 * `deliveries` 只记 `sessions.deliver` 的调用：被拒的投递**必须一条都不新增**——
 * 这道闸要是放在投递之后，任务状态虽然会被拒，消息却已经进了子会话收件箱，
 * 那等于挡了个寂寞。注意 launch 本身也会投一条初始 prompt，所以断言都取基线增量。
 */
async function withDispatch(fn, config = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-dep-msg-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    noticeMergeWindowMs: 0,
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
  const deliveries = []
  d.sessions = {
    cwdFor: () => dir,
    hint: () => {},
    dispose: () => {},
    restrictTools: () => () => {},
    forgetRestrict: () => {},
    holds: () => false,
    async createWorker(sessionId) {
      const agent = makeWorker(sessionId)
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver(sessionId, requestId, text) {
      deliveries.push({ sessionId, requestId, text })
      return { delivered: 'inbox', woke: false }
    },
  }
  host.agents.set('lead', makeWorker('lead'))
  const tools = Object.fromEntries(toolDefinitions(d).map(item => [item.name, item]))
  const launch = async args => {
    const result = await call(tools.dispatch_launch, args)
    return d.table.get(result.task.task_id)
  }
  /** 只数投给某条子会话的条数（launch 的初始 prompt 也在里面）。 */
  const countTo = sessionId => deliveries.filter(item => item.sessionId === sessionId).length
  try {
    await fn({ d, host, deliveries, tools, launch, countTo })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

const call = (tool, args) => tool.execute(args, { agent: { id: 'lead' } })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function drain(times = 8) {
  for (let index = 0; index < times; index += 1) await tick()
}
async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return true
    if (Date.now() - started > timeoutMs) return false
    await tick()
  }
}

/** 抓到异步断言里的错误，简化「必须抛」的写法。 */
async function catchError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

// ---------------------------------------------------------------- 用例

test('被前置挡住的排队任务：dispatch_message 被拒，状态仍是 queued 且没有半条投递', async () => {
  await withDispatch(async ({ d, host, deliveries, tools, launch, countTo }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    assert.ok(await waitFor(() => a.status === 'running'), 'A 应当被 pump 启动')

    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()
    assert.equal(b.status, 'queued', '前置没结算时 B 必须在队列里等')
    assert.equal(b.blockedBy, a.id, '前置没满足时 blockedBy 指向它')
    assert.equal(b.blockedReason, BLOCK_REASONS.RUNNING)
    // 给它一个**活着的**子会话：这正是审计里的现场（任务被 retry / 续派复活过、
    // 会话还在）。不补这一条的话，旧代码会先撞「子会话不可用」，
    // 这条用例就证明不了「依赖准入」这道闸本身（负向对照见报告）。
    host.agents.set(b.workerSessionId, makeWorker(b.workerSessionId))
    const queuedBefore = [...d.table.queue]
    const deliveredBefore = deliveries.length

    const error = await catchError(call(tools.dispatch_message, { task_id: b.id, message: '顺便把这个也做了' }))

    assert.ok(error, '对被挡任务追问必须报错，而不是静默插队')
    assert.equal(error.code, ERROR_CODES.CONFLICT, '错误码复用 CONFLICT（当前状态不允许这个动作）')
    // 文案必须说清「等谁」「为什么」「怎么办」，否则调用方只能盲试。
    assert.match(error.message, new RegExp(b.id), '要点名是哪条任务被挡')
    assert.match(error.message, new RegExp(a.id), '要点名它在等哪个前置')
    assert.match(error.message, /dispatch_cancel/, '要给出唯一可行的出路')
    assert.match(error.message, /depends_on/, '要说清被挡的约束来自哪里')

    assert.equal(b.status, 'queued', '被拒之后状态不能变成 running')
    assert.equal(b.blockedBy, a.id, '派生字段也不该被这次调用改掉')
    assert.deepEqual([...d.table.queue], queuedBefore, '队列与顺序原样不动')
    assert.equal(deliveries.length, deliveredBefore, '闸门在投递之前：一条消息都不许多出来')
    assert.equal(countTo(b.workerSessionId), 0, 'B 的子会话一条消息都没收到（它还没启动过）')
    assert.equal(b.turnStartedAt, undefined, '被拒的投递不能开一个新回合')
    assert.equal(d.table.runningCount(), 1, '并发位仍然只有 A 那条')
  })
})

test('前置 done 之后：同一条排队任务的 dispatch_message 正常放行', async () => {
  await withDispatch(async ({ d, host, tools, launch, countTo }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    assert.ok(await waitFor(() => a.status === 'running'), 'A 应当被 pump 启动')
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()
    assert.equal(b.status, 'queued')

    // 前置结算：B 会被 pump 顶上来（此时它已经不受依赖约束，追问是合法动作）。
    d.settle(a, 'done')
    // `transition(running)` 发生在 `start()` 之前，而 worker 会话是在 `start()` 里
    // 才建的——所以要等会话真的在场，否则 message() 撞的是「子会话不可用」。
    assert.ok(await waitFor(() => b.status === 'running' && host.agents.has(b.workerSessionId)),
      '前置 done 之后 B 应当自动开始，且它的子会话应当被创建')
    // 基线里包含 start() 投给 B 的初始 prompt，这里只关心追问带来的增量。
    const deliveredBefore = countTo(b.workerSessionId)

    const result = await call(tools.dispatch_message, { task_id: b.id, message: '再补一个用例' })

    assert.equal(result.task.status, 'running', '追问照常生效')
    assert.equal(b.status, 'running')
    assert.ok(b.turnStartedAt, '放行的投递要开新回合')
    assert.equal(countTo(b.workerSessionId), deliveredBefore + 1, '恰好新增一条消息投进 B 的子会话')
  })
})

test('没有 depends_on 的排队任务：message 行为与改动前完全一致（回归）', async () => {
  // 并发位只有 1：A 占满，B 只能排队——它**不是**被依赖挡住的，而是排队等容量。
  await withDispatch(async ({ d, host, tools, launch, countTo }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    assert.ok(await waitFor(() => a.status === 'running' && host.agents.has(a.workerSessionId)),
      'A 应当先跑起来')
    const b = await launch({ title: 'B', brief: 'b' })
    await drain()
    assert.equal(b.status, 'queued', '并发位满时 B 排队')
    assert.equal(b.dependsOn, undefined, '这条任务没有声明依赖')
    assert.equal(b.blockedBy, undefined, '没有依赖就不该有 blockedBy')

    // 真实场景里排队的任务可能已经有会话（retry / 续派复活过），这里补一个活会话，
    // 让这条用例只考察「依赖准入有没有误伤」，而不是被会话来路挡住。
    host.agents.set(b.workerSessionId, makeWorker(b.workerSessionId))

    const deliveredBefore = countTo(b.workerSessionId)
    const result = await call(tools.dispatch_message, { task_id: b.id, message: '先做这个' })

    // 旧行为：排队中的任务收到追问就地转 running，投递一条，并开新回合。
    assert.equal(result.task.status, 'running')
    assert.equal(b.status, 'running', '没有依赖的排队任务照旧可以追问')
    assert.equal(b.blockedBy, undefined)
    assert.ok(b.turnStartedAt, '开新回合')
    assert.equal(d.table.queue.includes(b.id), false, '转 running 就从队列里摘掉（旧行为）')
    assert.equal(countTo(b.workerSessionId), deliveredBefore + 1, '恰好新增一条消息投进 B 的子会话')
  }, { maxWorkers: 1 })
})

test('续派走同一条准入：对被挡任务 continueTask 同样被拒，且不打乱顺序', async () => {
  await withDispatch(async ({ d, host, deliveries, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    assert.ok(await waitFor(() => a.status === 'running'), 'A 应当被 pump 启动')
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()
    assert.equal(b.status, 'queued')
    // 同用例 1：活会话在场，才能证明挡住它的是依赖准入而不是会话来路。
    host.agents.set(b.workerSessionId, makeWorker(b.workerSessionId))
    const deliveredBefore = deliveries.length

    // `continueTask()` 是工具入口与看板「续派」共用的唯一投递口：
    // 它直接调 `message()`，所以这里证明了「续派也绕不过依赖准入」。
    const error = await catchError(d.continueTask(b, '把范围扩大一点'))

    assert.ok(error, '对被挡任务续派必须报错')
    assert.equal(error.code, ERROR_CODES.CONFLICT, '续派与追问共用同一个错误码')
    assert.match(error.message, /depends_on/, '文案对续派调用方同样成立（说的是约束来源，不是某个工具名）')
    assert.match(error.message, /追问与续派/, '文案要点明两条入口都会被挡')

    assert.equal(b.status, 'queued', '续派被拒后状态不变')
    assert.equal(b.attempt ?? 1, 1, '被拒的续派不能消耗 attempt')
    assert.equal(deliveries.length, deliveredBefore, '一条消息都没投出去')
  })
})
