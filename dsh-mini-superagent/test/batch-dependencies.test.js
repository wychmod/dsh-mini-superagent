/**
 * PRD-02：批次依赖（`depends_on` / `depends_on_index`）的行为测试。
 *
 * 这个文件按 PRD §9 的八条验收口径组织，外加 §6 边界表里逐行可测的那些：
 *
 * | PRD | 用例 |
 * | --- | --- |
 * | §9.1 顺序链 | 「顺序链 A→B→C…」 |
 * | §9.2 并行汇合 | 「并行汇合：C 依赖 A+B…」 |
 * | §9.3 前置失败 | 「前置失败：后继在同一次 pump 内被取消…」 |
 * | §9.4 重启 | 「重启：A=interrupted、B=cancelled…」「重启时前置还在排队…」 |
 * | §9.5 校验 | 「校验：未知 id / 9 个前置 / 自引用 / 下标越界…」 |
 * | §9.6 无空转 | 「队列里只有阻塞任务时…」+ contract-consistency 的「不新增定时器」 |
 * | §9.7 兼容 | 「不传依赖时任务形状与行为都不变」 |
 * | §9.8 看板 | 「看板五个依赖字段…」 |
 *
 * 另有一组边界用例：退休留痕、重试不复活、运行中的后继不回溯、成环、跨批依赖。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BLOCK_REASONS, CANCEL_REASONS, ERROR_CODES, newThreadId,
} from '../src/constants.js'
import { boardTask } from '../src/board.js'
import { Dispatch } from '../src/dispatch.js'
import { readState, writeState } from '../src/store.js'
import { TaskTable } from '../src/tasks.js'
import { toolDefinitions } from '../src/tools.js'

// ---------------------------------------------------------------- 夹具

/** 一个不需要宿主的最小 ctx：agents 是 Map，sessionController 只会被 resolve 探针用到。 */
function makeHost() {
  const agents = new Map()
  const warns = []
  const ctx = {
    logger: {
      warn: (...args) => warns.push(args.map(String).join(' ')),
      info() {},
      error() {},
    },
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
  return { ctx, agents, warns }
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
 * 驱动真实 `Dispatch` 的夹具。
 *
 * 三样东西是断言需要的：
 * - `deliveries`：投递到主会话的文本（批次汇总文案在这里）；
 * - `created`：**真的被创建出来的 worker 会话 id**（PRD §9.4 要证明「没有为 B 建 worker」）；
 * - `warns`：「不回溯」这类只记日志的行为只能从日志里看。
 */
async function withDispatch(fn, config = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-dep-'))
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
  const created = []
  d.sessions = {
    cwdFor: () => dir,
    hint: () => {},
    dispose: () => {},
    restrictTools: () => () => {},
    forgetRestrict: () => {},
    holds: () => false,
    async createWorker(sessionId) {
      created.push(sessionId)
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
  // 主会话必须在场：批次汇总的 relay 找不到它就会降级成「只落库」。
  host.agents.set('lead', makeWorker('lead'))
  const tools = Object.fromEntries(toolDefinitions(d).map(item => [item.name, item]))
  const launch = async (args) => {
    const result = await call(tools.dispatch_launch, args)
    return d.table.get(result.task.task_id)
  }
  try {
    await fn({ d, host, dir, deliveries, created, tools, launch })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

const call = (tool, args) => tool.execute(args, { agent: { id: 'lead' } })

/** 让 pump / start / maybeSummarize / 落盘这些异步链跑完。 */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function drain(times = 8) {
  for (let index = 0; index < times; index += 1) await tick()
}

/**
 * 轮询等一个条件成立，返回耗时（毫秒）；超时返回 undefined。
 *
 * 为什么不 `setTimeout(1000)` 之后再看：PRD §9.1 的「1 秒内启动」是一个上界，
 * 用轮询才能既验证上界、又不让用例固定睡满一秒。
 */
async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return Date.now() - started
    if (Date.now() - started > timeoutMs) return undefined
    await tick()
  }
}

const byTitle = (d, title) => [...d.table.tasks.values()].find(task => task.title === title)

/** 造一条能写进 tasks.json 的最小任务。 */
const storedTask = (id, status, extra = {}) => ({
  id,
  title: `任务 ${id}`,
  brief: '简报',
  parentSessionId: 'lead',
  workerSessionId: `dispatch-${id}`,
  threadId: newThreadId(id),
  status,
  attempt: 1,
  reports: [],
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z',
  ...extra,
})

/** 直接往活表里放一条已结算任务（测「前置在派发前就已经失败」这类场景）。 */
function seedSettled(d, id, status, extra = {}) {
  const task = {
    ...storedTask(id, status, extra),
    parentSessionId: 'lead',
    cwd: 'D:\\proj',
    workerSessionId: `dispatch-${id}`,
  }
  d.table.add(task)
  return task
}

// ---------------------------------------------------------------- §9.1 顺序链

test('顺序链 A→B→C：任一时刻只有一个 running，前置结算后 1 秒内启动', async () => {
  await withDispatch(async ({ d, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    assert.ok(await waitFor(() => a.status === 'running') !== undefined, 'A 应当被 pump 启动')

    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    const c = await launch({ title: 'C', brief: 'c', depends_on: [b.id] })
    await drain()

    assert.equal(b.status, 'queued', 'B 的前置没结算时必须在队列里等')
    assert.equal(c.status, 'queued')
    assert.equal(b.blockedBy, a.id, 'blockedBy 指向第一个未满足的前置')
    assert.equal(b.blockedReason, BLOCK_REASONS.RUNNING)
    assert.equal(d.table.runningCount(), 1, '顺序链上同一时刻只能有一个在跑')

    const startedAt = Date.now()
    d.settle(a, 'done')
    const bElapsed = await waitFor(() => b.status === 'running')
    assert.ok(bElapsed !== undefined, 'A 结算后 B 必须被启动')
    assert.ok(Date.now() - startedAt < 1000, `B 应在 1 秒内启动，实际 ${Date.now() - startedAt}ms`)
    assert.equal(b.blockedBy, undefined, '依赖满足后 blockedBy 必须被清空')
    assert.equal(d.table.runningCount(), 1)
    assert.equal(c.status, 'queued', 'C 还在等 B')

    d.settle(b, 'done')
    const cElapsed = await waitFor(() => c.status === 'running')
    assert.ok(cElapsed !== undefined && cElapsed < 1000, `C 也应在 1 秒内启动（实际 ${cElapsed}ms）`)
    assert.equal(d.table.runningCount(), 1)
  })
})

// ---------------------------------------------------------------- §9.2 并行汇合

test('并行汇合：C 依赖 A+B，两者都 done 后才启动', async () => {
  await withDispatch(async ({ d, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    const b = await launch({ title: 'B', brief: 'b' })
    await drain()
    assert.equal(a.status, 'running')
    assert.equal(b.status, 'running')
    assert.equal(d.table.runningCount(), 2, 'A、B 应当并行')

    const c = await launch({ title: 'C', brief: 'c', depends_on: [a.id, b.id] })
    await drain()
    assert.equal(c.status, 'queued')
    assert.equal(c.blockedBy, a.id, '第一个未满足的前置是 A')

    d.settle(a, 'done')
    await drain()
    assert.equal(c.status, 'queued', '只满足一个前置时 C 不能启动')
    assert.equal(c.blockedBy, b.id, 'A 满足后应指向下一个未满足的前置 B')

    d.settle(b, 'done')
    assert.ok(await waitFor(() => c.status === 'running') !== undefined, '两个前置都 done 后 C 才启动')
  })
})

// ---------------------------------------------------------------- §9.3 前置失败

test('前置失败：后继在同一次 pump 内 cancelled、写原因，批次汇总点出「未执行」', async () => {
  await withDispatch(async ({ d, tools, deliveries }) => {
    const result = await call(tools.dispatch_launch_many, {
      tasks: [
        { title: 'A', brief: 'a' },
        { title: 'B', brief: 'b', depends_on_index: [0] },
      ],
    })
    // launch_many 的每个结果项都要回解析后的依赖（PRD §4.1）。
    assert.deepEqual(result.launched[1].depends_on, [result.launched[0].task_id],
      'depends_on_index 必须被替换成真实 task id')
    await drain()

    const a = d.table.get(result.launched[0].task_id)
    const b = d.table.get(result.launched[1].task_id)
    assert.equal(a.status, 'running')
    assert.equal(b.status, 'queued')
    assert.equal(b.blockedReason, BLOCK_REASONS.RUNNING)

    d.settle(a, 'failed')
    await drain(12)

    assert.equal(b.status, 'cancelled', '前置失败后后继必须有一个确定的终局')
    assert.equal(b.cancelReason, CANCEL_REASONS.DEPENDENCY_FAILED)
    assert.equal(b.errorCode, ERROR_CODES.DEPENDENCY_FAILED)
    assert.equal(d.table.queue.includes(b.id), false, '账本里不能留下长期 queued 的 B')

    const summary = deliveries.map(item => item.text).find(text => text.includes('【批次】'))
    assert.ok(summary, '批次汇总必须照常发出（所有成员都已结算）')
    assert.match(summary, /1 条未执行/, '汇总要说「未执行」，而不是把它算成「没成」')
    assert.match(summary, /· 未执行：/, '未执行必须逐条点名')
  })
})

// ---------------------------------------------------------------- §9.4 重启

test('重启：A=interrupted，B=cancelled，且没有为 B 创建 worker', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-dep-restore-'))
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [
      storedTask('t-a', 'running', { startedAt: '2026-11-11T00:00:01.000Z' }),
      storedTask('t-b', 'queued', { dependsOn: ['t-a'] }),
    ],
  }, '2026-11-11T00:00:02.000Z')

  const created = []
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  d.workspaces = {
    list: () => [],
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined,
    defaultWorkspace: async () => undefined,
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
      created.push(sessionId)
      host.agents.set(sessionId, makeWorker(sessionId))
      return { agent: host.agents.get(sessionId), sessionId }
    },
    async enterDirectory() {},
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  host.agents.set('lead', makeWorker('lead'))
  try {
    await d.restore()
    const a = d.table.get('t-a')
    const b = d.table.get('t-b')
    assert.equal(a.status, 'interrupted', '跑到一半的任务重启后必须变 interrupted')
    assert.equal(b.status, 'cancelled', '前置已经中断，后继不能偷偷开跑')
    assert.equal(b.cancelReason, CANCEL_REASONS.DEPENDENCY_FAILED)
    assert.equal(b.errorCode, ERROR_CODES.DEPENDENCY_FAILED)
    assert.deepEqual(created, [], '恢复收敛不能创建任何 worker')

    // 恢复后的正常 pump 用同一份准入判定，仍然轮不到 B——而且不该为它建会话。
    await d.pump()
    await drain()
    assert.deepEqual(created, [], '没有为 B（或任何任务）创建 worker')
    assert.equal(b.status, 'cancelled')
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('重启时前置还在排队：两者都重排，按依赖顺序启动', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-dep-restore-q-'))
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [
      storedTask('t-a', 'queued'),
      storedTask('t-b', 'queued', { dependsOn: ['t-a'] }),
    ],
  }, '2026-11-11T00:00:02.000Z')
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  d.workspaces = {
    list: () => [],
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined,
    defaultWorkspace: async () => undefined,
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
      host.agents.set(sessionId, makeWorker(sessionId))
      return { agent: host.agents.get(sessionId), sessionId }
    },
    async enterDirectory() {},
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  host.agents.set('lead', makeWorker('lead'))
  try {
    await d.restore()
    const a = d.table.get('t-a')
    const b = d.table.get('t-b')
    assert.equal(a.status, 'queued')
    assert.equal(b.status, 'queued', '前置还在队列里 → 保留等待，不取消')
    assert.equal(b.blockedBy, 't-a')
    assert.equal(b.blockedReason, BLOCK_REASONS.RUNNING)

    await d.pump()
    await waitFor(() => a.status === 'running')
    assert.equal(a.status, 'running')
    assert.equal(b.status, 'queued', 'A 没结算前 B 不能开跑')

    d.settle(a, 'done')
    assert.ok(await waitFor(() => b.status === 'running') !== undefined, 'A 之后轮到 B')
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- §9.5 校验

test('校验：未知 id / 9 个前置 / 非数组都报错且不登记任务', async () => {
  await withDispatch(async ({ d, tools }) => {
    await assert.rejects(
      () => call(tools.dispatch_launch, { title: 'X', brief: 'x', depends_on: ['t-nope'] }),
      error => error.code === ERROR_CODES.UNKNOWN_DEPENDENCY,
      '未知前置必须报 UNKNOWN_DEPENDENCY',
    )
    assert.equal(d.table.tasks.size, 0, '校验失败不能登记任务')

    const nine = Array.from({ length: 9 }, (_, index) => `t-${index}`)
    await assert.rejects(
      () => call(tools.dispatch_launch, { title: 'X', brief: 'x', depends_on: nine }),
      error => error.code === ERROR_CODES.BAD_ARGS,
      '超过 maxDependsOn 必须报错（不静默截断）',
    )
    assert.equal(d.table.tasks.size, 0)

    await assert.rejects(
      () => call(tools.dispatch_launch, { title: 'X', brief: 'x', depends_on: 't-a' }),
      error => error.code === ERROR_CODES.BAD_ARGS,
      'depends_on 必须是数组',
    )
    assert.equal(d.table.tasks.size, 0)
  })
})

test('校验：批内下标自引用 / 越界 / 指向后面的 item 都报错且不登记', async () => {
  await withDispatch(async ({ d, tools }) => {
    // 第一项指向自己（下标 0）——这就是「自引用」在批内的形状。
    const selfRef = await call(tools.dispatch_launch_many, {
      tasks: [{ title: 'A', brief: 'a', depends_on_index: [0] }],
    })
    assert.equal(selfRef.launched[0].code, ERROR_CODES.BAD_ARGS)
    assert.equal(d.table.tasks.size, 0, '自引用不能留下任务')

    // 第一项指向第二项（下标 1）——「指向后面」也不允许。
    const forward = await call(tools.dispatch_launch_many, {
      tasks: [
        { title: 'A', brief: 'a', depends_on_index: [1] },
        { title: 'B', brief: 'b' },
      ],
    })
    assert.equal(forward.launched[0].code, ERROR_CODES.BAD_ARGS)
    assert.ok(
      ['queued', 'running'].includes(forward.launched[1].status),
      '独立任务不受别人校验失败影响（它该被登记并开始跑）',
    )
    assert.equal(d.table.tasks.size, 1, '只有 B 被登记')

    // 越界（下标远大于本批长度）。
    await withDispatch(async ({ d: innerD, tools: innerTools }) => {
      const outOfRange = await call(innerTools.dispatch_launch_many, {
        tasks: [{ title: 'C', brief: 'c', depends_on_index: [99] }],
      })
      assert.equal(outOfRange.launched[0].code, ERROR_CODES.BAD_ARGS)
      assert.equal(innerD.table.tasks.size, 0)
    })
  })
})

test('校验：引用了本批启动失败的那一项 → 该条 UNKNOWN_DEPENDENCY，其他独立任务照常', async () => {
  await withDispatch(async ({ d, tools }) => {
    const result = await call(tools.dispatch_launch_many, {
      tasks: [
        { title: 'A', brief: 'a', depends_on: ['t-missing'] },
        { title: 'B', brief: 'b', depends_on_index: [0] },
        { title: 'C', brief: 'c' },
      ],
    })
    assert.equal(result.launched[0].code, ERROR_CODES.UNKNOWN_DEPENDENCY)
    assert.equal(result.launched[1].code, ERROR_CODES.UNKNOWN_DEPENDENCY,
      '被引用的那一项没成功启动 → 下标解析不到 id')
    await drain()
    assert.ok(
      ['queued', 'running'].includes(result.launched[2].status),
      '第三条是独立任务，不受影响',
    )
    assert.equal(d.table.tasks.size, 1, '只有第三条入账')
  })
})

test('归一：重复 id 去重、空串丢弃、顺序保持不变；8 个前置合法', async () => {
  await withDispatch(async ({ d, tools }) => {
    const seeds = []
    for (let index = 0; index < 8; index += 1) {
      seeds.push(seedSettled(d, `t-seed-${index}`, 'done'))
    }
    const ids = seeds.map(task => task.id)
    const result = await call(tools.dispatch_launch, {
      title: 'B',
      brief: 'b',
      depends_on: [ids[1], '', '  ', ids[1], ids[0], ids[2], ids[3], ids[4], ids[5], ids[6], ids[7]],
    })
    assert.deepEqual(d.table.get(result.task.task_id).dependsOn, [ids[1], ids[0], ...ids.slice(2)],
      '去重、去空并保持**声明顺序**（不是排序）')
    assert.deepEqual(result.depends_on, [ids[1], ids[0], ...ids.slice(2)], '返回值是解析后的 id 数组')
  })
})

test('校验：账本里手工改出的环 → DEPENDENCY_CYCLE，且不登记新任务', async () => {
  await withDispatch(async ({ d, tools }) => {
    seedSettled(d, 't-a', 'queued', { dependsOn: ['t-b'] })
    seedSettled(d, 't-b', 'queued', { dependsOn: ['t-a'] })
    const before = d.table.tasks.size
    await assert.rejects(
      () => call(tools.dispatch_launch, { title: 'C', brief: 'c', depends_on: ['t-a'] }),
      error => error.code === ERROR_CODES.DEPENDENCY_CYCLE,
      '成环的依赖链会让后继永远排队，必须在登记前拒绝',
    )
    assert.equal(d.table.tasks.size, before)
  })
})

// ---------------------------------------------------------------- §9.6 无空转

test('队列里只有阻塞任务时：pump 扫一遍就返回，队列顺序与状态都不动', async () => {
  await withDispatch(async ({ d, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    const c = await launch({ title: 'C', brief: 'c', depends_on: [a.id] })
    await drain()

    const queueBefore = [...d.table.queue]
    const started = Date.now()
    await d.pump()
    const elapsed = Date.now() - started

    assert.ok(elapsed < 500, `只有阻塞任务时 pump 不能空转（实际 ${elapsed}ms）`)
    assert.deepEqual(d.table.queue, queueBefore, '被跳过的任务按原序留在队列里')
    assert.equal(b.status, 'queued')
    assert.equal(c.status, 'queued')
    assert.equal(d.table.runningCount(), 1)
  })
})

test('maxWorkers 已满时：annotate 只写派生字段，不改状态也不动队列', async () => {
  await withDispatch(async ({ d, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()
    const queueBefore = [...d.table.queue]
    await d.pump()
    assert.equal(a.status, 'running')
    assert.equal(b.status, 'queued')
    assert.deepEqual(d.table.queue, queueBefore)
  }, { maxWorkers: 1 })
})

// ---------------------------------------------------------------- §9.7 兼容

test('不传依赖：任务上没有 dependsOn，blockedBy 恒空，两个任务照常并行', async () => {
  await withDispatch(async ({ d, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    const b = await launch({ title: 'B', brief: 'b' })
    await drain()
    assert.equal(Object.hasOwn(a, 'dependsOn'), false, '无依赖的任务不该凭空多一个字段')
    assert.equal(a.blockedBy, undefined)
    assert.equal(b.blockedBy, undefined)
    assert.equal(a.status, 'running')
    assert.equal(b.status, 'running')
  }, { maxWorkers: 2 })
})

// ---------------------------------------------------------------- §9.8 看板

test('看板五个依赖字段都能读到，且 depends_on 恒定是数组', () => {
  const shaped = boardTask({
    id: 't-dep-1',
    title: '带依赖的任务',
    status: 'queued',
    reports: [],
    dependsOn: ['t-a', 't-b'],
    blockedBy: 't-a',
    blockedReason: BLOCK_REASONS.RUNNING,
    cancelReason: CANCEL_REASONS.DEPENDENCY_FAILED,
    errorCode: ERROR_CODES.DEPENDENCY_FAILED,
  })
  assert.deepEqual(shaped.depends_on, ['t-a', 't-b'])
  assert.equal(shaped.blocked_by, 't-a')
  assert.equal(shaped.blocked_reason, BLOCK_REASONS.RUNNING)
  assert.equal(shaped.cancel_reason, CANCEL_REASONS.DEPENDENCY_FAILED)
  assert.equal(shaped.error_code, ERROR_CODES.DEPENDENCY_FAILED)

  // 没有依赖时给空数组：客户端不必判属性存在。
  const plain = boardTask({ id: 't-plain', reports: [] })
  assert.deepEqual(plain.depends_on, [])
  assert.equal(plain.blocked_by, undefined)
  assert.equal(plain.cancel_reason, undefined)
  assert.equal(plain.error_code, undefined)

  // 手工改坏的账本（>8 个）也不能把 2 秒轮询的快照撑大。
  const many = boardTask({
    id: 't-many',
    reports: [],
    dependsOn: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  })
  assert.equal(many.depends_on.length, 8)
})

// ---------------------------------------------------------------- 边界表

test('退休留痕：done 视为满足；非 done 视为 missing 并连带取消', async () => {
  await withDispatch(async ({ d, tools }) => {
    d.retired.set('t-archived-done', { id: 't-archived-done', status: 'done', retiredReason: 'cap-count' })
    const ok = await call(tools.dispatch_launch, {
      title: 'B', brief: 'b', depends_on: ['t-archived-done'],
    })
    await drain()
    assert.equal(d.table.get(ok.task.task_id).status, 'running', '退休且 done 的前置已经做完，应当满足')

    d.retired.set('t-archived-failed', { id: 't-archived-failed', status: 'failed', retiredReason: 'cap-count' })
    const bad = await call(tools.dispatch_launch, {
      title: 'C', brief: 'c', depends_on: ['t-archived-failed'],
    })
    await drain()
    const c = d.table.get(bad.task.task_id)
    assert.equal(c.status, 'cancelled')
    assert.equal(c.cancelReason, CANCEL_REASONS.DEPENDENCY_MISSING)
    assert.equal(c.errorCode, ERROR_CODES.DEPENDENCY_MISSING)
  })
})

test('派发时前置就已经失败：登记后在下一次 pump 内被取消（不留 queued）', async () => {
  await withDispatch(async ({ d, launch }) => {
    seedSettled(d, 't-dead', 'failed', { error: '早失败了' })
    const b = await launch({ title: 'B', brief: 'b', depends_on: ['t-dead'] })
    await drain()
    assert.equal(b.status, 'cancelled')
    assert.equal(b.cancelReason, CANCEL_REASONS.DEPENDENCY_FAILED)
    assert.equal(b.errorCode, ERROR_CODES.DEPENDENCY_FAILED)
  })
})

test('重试不复活：前置失败 → 后继已取消；前置重开后重新 done，后继仍是 cancelled', async () => {
  await withDispatch(async ({ d, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()

    d.settle(a, 'failed')
    await drain()
    assert.equal(b.status, 'cancelled')

    // 前置被重开（换一轮跑），再结算成 done：已经取消的后继不复活。
    d.table.reopen(a)
    a.status = 'queued'
    d.table.tasks.set(a.id, a)
    d.table.queue.unshift(a.id)
    await d.pump()
    await drain()
    assert.equal(a.status, 'running')
    d.settle(a, 'done')
    await drain()
    assert.equal(b.status, 'cancelled', 'PRD §6：已取消的后继不复活')
    assert.equal(b.cancelReason, CANCEL_REASONS.DEPENDENCY_FAILED)
  })
})

test('retry 重开前置：已因它取消的后继不复活，并记一条点名的 warn（PRD-02 §6）', async () => {
  await withDispatch(async ({ d, host, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()

    d.settle(a, 'failed')
    await drain()
    assert.equal(b.status, 'cancelled')

    await d.retry(a)
    await drain()

    // ① 不复活：B 的取消在「前置那一刻确实没成」时是正确的，重开不追认。
    assert.equal(b.status, 'cancelled', 'PRD-02 §6：已连带取消的后继不会被 retry 复活')
    assert.equal(b.cancelReason, CANCEL_REASONS.DEPENDENCY_FAILED)
    // ② 记一条 warn，且点出被留下的那条 id——否则用户不知道要单独去重做谁。
    const line = host.warns.find(item => item.includes('不会自动复活'))
    assert.ok(line, `应当记一条重开前置的 warn，实际：${host.warns.join(' | ')}`)
    assert.ok(line.includes(b.id), `warn 里要能读到被留下的后继 id，实际：${line}`)
  })
})

test('retry 没有已取消的后继：不记「不会自动复活」的 warn（避免噪音）', async () => {
  await withDispatch(async ({ d, host, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    d.settle(a, 'failed')
    await drain()

    await d.retry(a)
    await drain()

    assert.equal(
      host.warns.some(item => item.includes('不会自动复活')),
      false,
      `没有任何后继被取消时不该说这句话，实际：${host.warns.join(' | ')}`,
    )
  })
})

test('运行中的后继在前置重开后再次失败：不回溯、不打断，只记一条 warn', async () => {
  await withDispatch(async ({ d, host, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()

    d.settle(a, 'done')
    assert.ok(await waitFor(() => b.status === 'running') !== undefined)

    // 前置被重试（续跑同一个 worker 会话），随后这一轮又失败。
    await d.retry(a)
    await drain()
    assert.equal(a.status, 'running')
    d.settle(a, 'failed')
    await drain()

    assert.equal(b.status, 'running', 'PRD §4.4：已经在 running 的后继不回溯')
    assert.ok(
      host.warns.some(line => line.includes('不回溯')),
      `应当记一条「不回溯」warn，实际：${host.warns.join(' | ')}`,
    )
  })
})

test('跨批依赖：可以引用别的会话派出的任务', async () => {
  await withDispatch(async ({ d, launch }) => {
    const foreign = seedSettled(d, 't-foreign', 'queued')
    foreign.parentSessionId = 'someone-else'
    const b = await launch({ title: 'B', brief: 'b', depends_on: ['t-foreign'] })
    await drain()
    assert.equal(b.status, 'queued', '跨批依赖同样要等')
    d.settle(d.table.get('t-foreign'), 'done')
    assert.ok(await waitFor(() => b.status === 'running') !== undefined)
  })
})

test('依赖随账本落盘与读回（PRD §4.2）：重启后依赖边仍然生效', async () => {
  await withDispatch(async ({ d, dir, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()
    await d.persistCritical()

    const state = await readState(join(dir, 'tasks.json'))
    const stored = state.tasks.find(task => task.id === b.id)
    assert.ok(stored, '任务必须落盘')
    assert.deepEqual(stored.dependsOn, [a.id], 'dependsOn 原样序列化（不需要改 store.js）')
    // blockedBy 是派生值：顺手落盘，但读回时会被清空重算（见 restore 的归一）。
    assert.equal(stored.blockedBy, a.id)
  })
})

test('前置被归档：归档不改变 status，按原状态判定（done 仍然满足）', async () => {
  await withDispatch(async ({ d, launch }) => {
    seedSettled(d, 't-archived-done', 'done', { archivedAt: '2026-11-11T00:00:03.000Z' })
    const b = await launch({ title: 'B', brief: 'b', depends_on: ['t-archived-done'] })
    await drain()
    assert.equal(b.status, 'running', '归档只是只读冻结，不改变「它已经做完」这个事实')
  })
})

test('前置被用户取消：按失败同样处理，后继连带取消', async () => {
  await withDispatch(async ({ d, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()
    await d.cancel(d.table.get(a.id), '换个做法')
    await drain()
    assert.equal(b.status, 'cancelled')
    assert.equal(b.cancelReason, CANCEL_REASONS.DEPENDENCY_FAILED)
  })
})

test('级联：A→B→C，A 失败后 B、C 都连带取消（BFS 向后传递）', async () => {
  await withDispatch(async ({ d, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    const c = await launch({ title: 'C', brief: 'c', depends_on: [b.id] })
    await drain()
    assert.equal(d.table.runningCount(), 1)

    d.settle(a, 'failed')
    await drain(12)
    assert.equal(b.status, 'cancelled')
    assert.equal(c.status, 'cancelled', 'B 被连带取消后，C 的前置同样没成 → 继续向后传递')
    assert.equal(c.cancelReason, CANCEL_REASONS.DEPENDENCY_FAILED)
    assert.equal(c.errorCode, ERROR_CODES.DEPENDENCY_FAILED)
    assert.equal(d.table.queue.length, 0, '级联之后不能留下任何排队项')
  })
})

test('续派（continue_task_id）不能同时声明 depends_on：报错而不是静默忽略', async () => {
  await withDispatch(async ({ d, tools, launch }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    await drain()
    d.settle(a, 'done')
    await drain()
    await assert.rejects(
      () => call(tools.dispatch_launch, {
        title: '补一句',
        brief: '…',
        continue_task_id: a.id,
        depends_on: ['t-whatever'],
      }),
      error => error.code === ERROR_CODES.BAD_ARGS,
    )
  })
})

test('takeRunnable 的只读谓词：被跳过的任务按原序留在队首', () => {
  const table = new TaskTable(5)
  for (const id of ['a', 'b', 'c']) {
    table.add({ id, status: 'queued', workerSessionId: `dispatch-${id}`, reports: [] })
  }
  // 不让 a 走：b 可以先跑，但 a 必须原样留在队首、c 仍在它后面。
  assert.equal(table.takeRunnable(task => task.id !== 'a').id, 'b')
  assert.deepEqual(table.queue, ['a', 'c'])
  assert.equal(table.tasks.get('a').status, 'queued')

  // 全被挡：返回 undefined，队列与状态都不动（不空转）。
  assert.equal(table.takeRunnable(() => false), undefined)
  assert.deepEqual(table.queue, ['a', 'c'])
  assert.equal(table.tasks.get('a').status, 'queued')
  assert.equal(table.tasks.get('c').status, 'queued')
})
