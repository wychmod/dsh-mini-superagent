/**
 * 「已结算的任务被复活」这条路径上的四个缺陷。
 *
 * 这四条曾经各占一个 bug，但它们其实是**同一件事**的四个面：一条已经结算的
 * 任务被重新拉回 running 时，「上一轮已经结束」这个事实没有跟着失效，于是
 * 结算时刻、回合标记、取消意图、归档冻结全都被上一轮的陈旧状态覆盖：
 *
 * 1. `settledAt` 不刷新 → 二次结算沿用第一轮时刻（按天趋势、完成时刻、
 *    占用时长全算到旧日期）；
 * 2. `reportedSinceTurn` 不清 → 第二轮零报告被判 done 且不发兜底通知
 *    （主会话只看到第一轮报告，看板显示成功）；
 * 3. 投递途中被取消 → 取消被静默撤销（任务又变回 running）；
 * 4. 已归档任务可被复活 → 归档与在跑并存（统计排除它，它却在真实跑）。
 *
 * 与 `test/continue-launch.test.js` 的分工：那边钉「模型 A 转发」的形状与
 * 四条硬校验（续派**能不能**做），这边钉「复活之后**事实**对不对」。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WORKER_PREFIX, newThreadId } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { TaskTable } from '../src/tasks.js'

// ---------------------------------------------------------------- 夹具

function makeHost() {
  const agents = new Map()
  const ctx = {
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
  }
  return { ctx, agents }
}

function makeWorker(id) {
  return {
    id, status: 'idle',
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    cancel() {}, steer() {}, followup() {}, inject() {},
  }
}

/**
 * 一个能驱动 `Dispatch` 的夹具。
 *
 * `deliveries` 记录每一次投递（`{sessionId, text}`）：worker 收到的是要求，
 * 主会话收到的是回报——「这一轮有没有给结论」只能从这份记录里看。
 *
 * `state.onDeliver` 让用例能在**投递途中**插入动作（用来造并发取消）。
 */
async function withDispatch(fn, config = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-resume-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    noticeMergeWindowMs: 0,
    ...config,
  })
  d.workspaces = {
    list: () => [{ id: 'ws-a', title: '项目 A', path: 'D:\\proj\\a' }],
    resolve: async ref => (ref === 'ws-a' ? { id: 'ws-a', title: '项目 A', path: 'D:\\proj\\a' } : undefined),
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined,
    defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return dir },
  }
  const deliveries = []
  const state = { onDeliver: null }
  d.sessions = {
    cwdFor: () => dir,
    hint: () => {},
    dispose: () => {},
    restrictTools: () => () => {},
    forgetRestrict: () => {},
    holds: () => false,
    async createWorker(sessionId, cwd) {
      const agent = makeWorker(sessionId)
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver(sessionId, requestId, text) {
      deliveries.push({ sessionId, requestId, text })
      // 投递途中的钩子：在这次投递「落地」之前插入动作。
      if (state.onDeliver) await state.onDeliver(sessionId, text)
      return { delivered: 'inbox', woke: false }
    },
  }
  try {
    await fn({ d, host, dir, deliveries, state })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/** 造一条任务；默认是「在跑」的样子（由夹具负责结算成第一轮结束）。 */
const mkTask = (id, overrides = {}) => ({
  id,
  title: `任务 ${id}`,
  brief: '原始简报',
  parentSessionId: 'lead',
  workerSessionId: `${WORKER_PREFIX}${id}`,
  threadId: newThreadId(id),
  status: 'running',
  attempt: 1,
  reports: [],
  cwd: 'D:\\proj\\a',
  workspaceId: 'ws-a',
  workspaceTitle: '项目 A',
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  ...overrides,
})

/**
 * 主线夹具：主会话、worker 会话都在，任务已经**结算成 done**（第一轮结束的样子，
 * 带着第一轮的 `settledAt`）。这正是续派的对象。
 */
async function withSettledTask(fn, options = {}) {
  return withDispatch(async ctx => {
    const { d, host } = ctx
    host.agents.set('lead', makeWorker('lead'))
    const task = options.task ?? mkTask('t-prev')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeWorker(task.workerSessionId))
    if (!options.raw) d.settle(task, 'done')
    return fn({ ...ctx, task })
  }, options.config)
}

// ---------------------------------------------------------------- Bug 1：settledAt 不刷新

/**
 * 复活已结算的任务时，上一轮的 `settledAt` 必须失效。
 *
 * 不清的代价很具体：`#markSettled` 是幂等的（终态只写一次时刻），所以第二轮
 * 结算看到旧值就什么都不写——任务被算在**第一次**结算的那一天里，
 * 「完成时刻」与「占用时长」也全按旧的收尾时刻算。
 */
test('Bug1 续派复活已结算任务：旧 settledAt 失效，二次结算写新时刻', async () => {
  await withSettledTask(async ({ d, task }) => {
    const first = task.settledAt
    assert.ok(first, '第一轮结算必须写 settledAt')

    await new Promise(resolve => setTimeout(resolve, 15))
    await d.continueTask(task, '再跑一遍')
    assert.equal(task.status, 'running')
    assert.equal(task.settledAt, undefined,
      '任务重新活跃之后，「结算时刻」不再存在——否则二次结算会沿用第一轮时刻')

    await new Promise(resolve => setTimeout(resolve, 15))
    d.settle(task, 'done')
    const second = task.settledAt
    assert.ok(second, '第二轮结算必须再写一次时刻')
    assert.notEqual(second, first, '第二轮必须是**新的**时刻，不能沿用第一轮')
    assert.ok(Date.parse(second) > Date.parse(first))
  })
})

test('Bug1「离开终态即失效」是 TaskTable 的统一语义（不只在 reopen 上）', async () => {
  // 直接钉住「复活」这条不变式本身：任何从终态回到非终态的跃迁都清 settledAt。
  // 钉在 table 层而不是 dispatch 层，是为了将来再有人加一条复活路径时也会被拦住。
  const table = new TaskTable(4)
  const task = table.add({ id: 'a', status: 'running', reports: [] })

  table.settle(task, 'done')
  const first = task.settledAt
  assert.ok(first)

  // 终态没有普通出边，复活只能走 force（续派走的就是这条）。
  assert.equal(table.transition(task, 'running', { force: true }), true)
  assert.equal(task.settledAt, undefined, '离开终态即失效')

  // 等一会儿再结算：时刻表要走一毫秒，否则两次结算会撞在同一毫秒里。
  await new Promise(resolve => setTimeout(resolve, 15))
  table.settle(task, 'done')
  assert.notEqual(task.settledAt, first, '第二次结算必须是新时刻')
})

// ---------------------------------------------------------------- Bug 2：第二轮零报告

/**
 * 续派后第二轮没有给结论时，任务应当是 `ended`，并且**发出兜底通知**。
 *
 * 原来 `reportedSinceTurn` 只在「回合结束」时清，续派（新一轮开始）不清，
 * 于是第二轮结束时读到的是第一轮残留的 true → 判成 done 且**跳过**兜底通知。
 * 主会话只看到第一轮报告，看板显示成功，而第二轮其实什么也没干完。
 */
test('Bug2 续派后第二轮零报告：判 ended 并发出兜底通知', async () => {
  await withSettledTask(async ({ d, deliveries, host, task }) => {
    // 第一轮：worker 报了 done（这才是「reportedSinceTurn」被置位的那条路径）。
    d.table.transition(task, 'running', { force: true })
    await d.report(host.agents.get(task.workerSessionId), { status: 'done', summary: '第一轮做完了' })
    assert.equal(task.status, 'done')
    assert.equal(task.reportedSinceTurn, true, '第一轮给过终态报告')

    // 续派 = 新一轮开始。
    await d.continueTask(task, '再来一轮')
    assert.equal(task.status, 'running')
    assert.equal(task.reportedSinceTurn, false,
      '新回合开始时，上一回合的「已给过终态报告」标记必须作废')

    const before = deliveries.filter(item => item.sessionId === 'lead').length
    // 第二轮：worker 什么都没报就结束了。
    await d.finishIdleTurn(task, '本轮没有输出')
    assert.equal(task.status, 'ended', '零报告的回合应当判 ended，不能沿用上一轮的 done')

    const after = deliveries.filter(item => item.sessionId === 'lead')
    assert.ok(after.length > before, '兜底通知必须真的发出去——否则用户完全不知道第二轮没了')
    assert.match(after.at(-1).text, /没给结论/,
      '兜底通知要说清「它跑完了，但没给结论」')
  })
})

// ---------------------------------------------------------------- Bug 3：取消被撤销

/**
 * `dispatch_cancel` 与 `dispatch_message` 并发时，**取消优先**。
 *
 * 原来 `message()` 在投递前查一次 `cancelled`，投递（await）之后无条件把任务
 * 改回 running——于是「投递途中被取消」的任务会复活，取消被静默撤销。
 *
 * 夹具用**排队中**的任务：只有「非终态」的任务才能被取消，而 `message()` 对
 * 排队中的任务会走 `transition(force)` 那条复活分支——正是出问题的那条。
 */
test('Bug3 投递途中被取消：取消不被撤销，任务不会复活成 running', async () => {
  await withSettledTask(async ({ d, state, task }) => {
    // 投递正在进行时，用户点了取消。
    state.onDeliver = async sessionId => {
      if (sessionId !== task.workerSessionId) return
      // `cancel()` 的函数体里没有 await，所以调用即同步结算。
      void d.cancel(task, '用户取消')
    }

    await assert.rejects(
      () => d.message(task, '再跑一下', 'queue'),
      /已被取消/,
      '投递途中被取消时必须明确报错，而不是假装投递成功',
    )
    assert.equal(task.status, 'cancelled', '取消优先：任务不能被改回 running')
    assert.ok(task.settledAt, '取消也是一个结算时刻，必须记下来')
  }, { task: mkTask('t-cancel', { status: 'queued' }), raw: true })
})

test('Bug3 取消先到、投递后到：同样不能复活', async () => {
  await withSettledTask(async ({ d, task }) => {
    await d.cancel(task, '用户取消')
    await assert.rejects(() => d.message(task, '再跑一下', 'queue'), /已取消/)
    assert.equal(task.status, 'cancelled')
  }, { task: mkTask('t-cancel', { status: 'queued' }), raw: true })
})

// ---------------------------------------------------------------- Bug 4：归档任务复活

/**
 * 归档是**只读冻结**：统计里已排除它，看板上也没有任何操作按钮。
 * 让它复活会造出「归档与在跑并存」——历史被算成当下，而它其实正在改同一个目录。
 */
test('Bug4 已归档的任务不能被续派（看板与工具共用的那条校验）', async () => {
  await withSettledTask(async ({ d, task }) => {
    task.archivedAt = '2026-11-09T01:00:00.000Z'
    await assert.rejects(
      () => d.continueTask(task, '再跑一下'),
      /已归档/,
      '归档任务必须被明确拒绝，并说清为什么',
    )
    assert.equal(task.status, 'done', '被拒绝时任务状态不许变')
    assert.equal(task.archivedAt, '2026-11-09T01:00:00.000Z', '归档标记不许被清掉')
  })
})

test('Bug4 直接 message 一条已归档的任务同样被拒（复活只有一条入口）', async () => {
  await withSettledTask(async ({ d, deliveries, task }) => {
    task.archivedAt = '2026-11-09T01:00:00.000Z'
    await assert.rejects(() => d.message(task, '再跑一下', 'queue'), /已归档/)
    assert.equal(deliveries.length, 0, '被拒时一条消息都不该投出去')
    assert.equal(task.status, 'done')
  })
})
