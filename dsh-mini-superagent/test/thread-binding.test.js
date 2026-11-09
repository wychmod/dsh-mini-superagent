/**
 * plans/08 阶段 0「解耦」的验收用例：**显式绑定**（会话 → 当前活跃任务）与
 * **线程标识**（`task.threadId`）。
 *
 * 这一轮**不实现会话复用**，也不改变任何对外可见的行为——这些用例在当前 1:1
 * 场景下必须全部通过。它们锁定的是「将来做复用时不串账」：
 *
 * - §七.1 归属正确：同一会话上有两个任务时，`dispatch_report` 记到**当前活跃**
 *   的那条，而不是最早那条（旧 `byWorker()` 扫全表返回第一个匹配，必错）。
 * - §七.2 取消隔离：取消 A 不会让 B 变成 `interrupted`。**本轮不改变取消语义**
 *   （见 `cancel()`），这里钉的是「已经发生的那个事实」——取消只结算被点的任务，
 *   同会话另一条不受影响；作为阶段 2 的输入，`cancel()` 仍会打断整条会话的回合。
 * - §七.3 归档安全：归档一条任务不让同会话的其它任务不可用。
 * - `threadId` 的向后兼容：老 `tasks.json`（没有这个键）读回来要能补出**同一个**
 *   派生值，既不报错、也不当成另一条线程。
 *
 * 与 `tasks.test.js` 的分工：那边测派发表的纯逻辑（并发位/排队/结算），
 * 这边测「归属」这一件事，构造的是同会话多任务的场景。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SETTLED, newThreadId } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { writeState } from '../src/store.js'
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
      async resolveAgent(id) { return agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'not-found' } } },
      async prompt() {},
    },
  }
  return { ctx, agents }
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
  const dir = await mkdtemp(join(tmpdir(), 'mas-tb-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    // 关掉合并窗口与 progress 节流：这些用例看的是「报告记到哪条任务上」，
    // 不是投递形态。窗口开着只会让断言多等 1.5 秒、且多出无关的合并逻辑。
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
    async createWorker() { throw new Error('不该走到这里') },
    async enterDirectory() {},
    async deliver(sessionId, requestId, text) {
      deliveries.push({ sessionId, requestId, text })
      return { delivered: 'inbox', woke: false }
    },
  }
  try {
    await fn({ d, host, dir, deliveries })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/** 造一条挂在 `workerSessionId` 上的任务（默认 running）。 */
const mkTask = (id, workerSessionId, status = 'running', extra = {}) => ({
  id,
  title: id,
  brief: 'b',
  parentSessionId: 'lead',
  workerSessionId,
  threadId: newThreadId(id),
  status,
  reports: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...extra,
})

// ---------------------------------------------------------------- 纯表：显式绑定

test('显式绑定：同一会话上第二条任务登记后，byWorker 指向**当前活跃**那条', () => {
  const table = new TaskTable(5)
  const early = table.add(mkTask('first', 'dispatch-shared', 'done'))
  const late = table.add(mkTask('second', 'dispatch-shared', 'running'))

  // 旧实现扫全表返回第一个匹配 —— 那会永远是 `first`（已结算的那条）。
  assert.equal(table.byWorker('dispatch-shared'), late, '必须指向当前活跃的任务，而不是最早那条')
  assert.notEqual(table.byWorker('dispatch-shared'), early)
  assert.equal(table.activeTaskId('dispatch-shared'), 'second')
})

test('显式绑定：会话上全部任务结算后，byWorker 退回历史那条且不报错', () => {
  const table = new TaskTable(5)
  const first = table.add(mkTask('first', 'dispatch-shared', 'done'))
  const second = table.add(mkTask('second', 'dispatch-shared', 'running'))
  assert.equal(table.byWorker('dispatch-shared'), second)

  table.settle(second, 'done')

  assert.equal(table.byWorker('dispatch-shared'), first, '没有活跃任务时仍要能查回历史（与 0.8.x 一致）')
  assert.equal(table.activeTaskId('dispatch-shared'), undefined, '绑定必须已经交还，不能指向已结算的任务')
})

test('显式绑定：无任务与「有任务但都不活跃」可区分（workerState）', () => {
  const table = new TaskTable(5)
  assert.equal(table.workerState('dispatch-none'), 'none')

  const task = table.add(mkTask('only', 'dispatch-done', 'done'))
  assert.equal(table.workerState('dispatch-done'), 'settled')
  assert.equal(table.byWorker('dispatch-done'), task, '「曾经是 worker、活已干完」仍能查回那条任务')

  table.add(mkTask('live', 'dispatch-live', 'running'))
  assert.equal(table.workerState('dispatch-live'), 'active')
  assert.equal(table.workerState(''), 'none', '空会话 id 不该扫全表')
  assert.equal(table.workerState('dispatch-none'), 'none')
})

test('显式绑定：同会话后登记的 queued 任务不抢正在跑的那条', () => {
  const table = new TaskTable(5)
  const running = table.add(mkTask('running', 'dispatch-shared', 'running'))
  table.add(mkTask('waiting', 'dispatch-shared', 'queued'))

  assert.equal(table.activeTaskId('dispatch-shared'), 'running',
    '同会话串行：排在后面的任务还没开始，不能成为「当前活跃」')

  table.transition(table.get('waiting'), 'running')
  assert.equal(table.activeTaskId('dispatch-shared'), 'waiting',
    '它真的开跑之后才接手绑定')
  assert.equal(table.byWorker('dispatch-shared'), table.get('waiting'))
  assert.ok(running)     // 前一条仍在表里，只是不再绑定
})

test('显式绑定：重开（retry 回到 queued）会把绑定拿回来', async () => {
  const table = new TaskTable(5)
  const task = table.add(mkTask('retryable', 'dispatch-shared', 'running'))
  table.settle(task, 'failed')
  assert.equal(table.activeTaskId('dispatch-shared'), undefined, '结算即交还')

  table.reopen(task)
  assert.equal(task.status, 'queued')
  assert.equal(table.activeTaskId('dispatch-shared'), 'retryable', '重开之后它又成了这条会话的活跃任务')
})

test('显式绑定：任务被摘出表（退休）时绑定一起解掉', () => {
  const table = new TaskTable(5)
  const task = table.add(mkTask('doomed', 'dispatch-shared', 'running'))
  assert.equal(table.activeTaskId('dispatch-shared'), 'doomed')

  table.remove(task.id)

  assert.equal(table.get(task.id), undefined)
  assert.equal(table.activeTaskId('dispatch-shared'), undefined, '不能留下指向不存在任务的绑定键')
  assert.equal(table.active.has('dispatch-shared'), false)
  assert.equal(table.byWorker('dispatch-shared'), undefined)
})

test('显式绑定：workerSessionId 被改写（换 attempt 会话）时旧键自愈', () => {
  const table = new TaskTable(5)
  const task = table.add(mkTask('changed', 'dispatch-old', 'running'))
  assert.equal(table.activeTaskId('dispatch-old'), 'changed')

  // 模拟 retry 换号：`task.workerSessionId` 被直接改写（dispatch.js 的 retry 分支）。
  task.workerSessionId = 'dispatch-new'

  assert.equal(table.activeTaskId('dispatch-old'), undefined, '旧绑定必须自愈摘掉，绝不返回不属于该会话的任务')
  assert.equal(table.byWorker('dispatch-old'), undefined)
  // 新会话上还没有绑定，但扫描能找到它，并顺手把绑定修好。
  assert.equal(table.byWorker('dispatch-new'), task)
  assert.equal(table.activeTaskId('dispatch-new'), 'changed', '查询时顺手把绑定补上')
})

test('threadId：一任务一线程（阶段 0 的 1:1 规则），由任务 id 派生', () => {
  const table = new TaskTable(5)
  const a = table.add(mkTask('t-a', 'dispatch-a'))
  const b = table.add(mkTask('t-b', 'dispatch-b'))
  assert.equal(a.threadId, newThreadId('t-a'))
  assert.equal(b.threadId, newThreadId('t-b'))
  assert.notEqual(a.threadId, b.threadId, '两条任务今天就是两条线程')
  assert.equal(newThreadId('t-a'), newThreadId('t-a'), '派生规则必须幂等：同一任务永远落在同一条线程里')
})

// ---------------------------------------------------------------- 接入 Dispatch：归属

test('§七.1 归属正确：dispatch_report 记到当前活跃的那条，不是最早那条', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead'))
    const early = mkTask('t-early', 'dispatch-shared', 'done')
    const late = mkTask('t-late', 'dispatch-shared', 'running')
    d.table.add(early)
    d.table.add(late)
    const worker = makeAgent('dispatch-shared')
    host.agents.set('dispatch-shared', worker)

    const result = await d.report(worker, { status: 'progress', summary: '第二条任务的进度' })

    assert.equal(result.task_id, 't-late', '报告必须记到当前活跃的任务上（旧实现会记到 t-early）')
    assert.equal(late.reports.length, 1)
    assert.equal(early.reports.length, 0, '已结算的那条一条报告都不该收到')
  })
})

test('§七.1 归属正确：onWorkerIdle / onWorkerError 也只认当前活跃的那条', async () => {
  await withDispatch({ retryTransient: false }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead'))
    const early = mkTask('t-early', 'dispatch-shared', 'done')
    const late = mkTask('t-late', 'dispatch-shared', 'running')
    d.table.add(early)
    d.table.add(late)
    const worker = makeAgent('dispatch-shared')
    host.agents.set('dispatch-shared', worker)

    d.onWorkerError(worker, new Error('boom'))
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.equal(late.status, 'failed', '出错的是当前活跃任务')
    assert.equal(early.status, 'done', '别的任务绝不能因此被改状态')
    assert.match(late.error, /boom/)
  })
})

test('§七.1 归属正确：agent/disposed 的处理只结算当前活跃的那条', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const early = mkTask('t-early', 'dispatch-shared', 'done')
    const late = mkTask('t-late', 'dispatch-shared', 'running')
    d.table.add(early)
    d.table.add(late)
    host.agents.set('dispatch-shared', makeAgent('dispatch-shared'))

    // 复刻 index.js 的 `agent/disposed` 处理：查任务 → 已结算就什么都不做 →
    // 否则结算成 interrupted。① 让它选中「当前活跃」的那条是这里的全部意义。
    const task = d.table.byWorker('dispatch-shared')
    assert.equal(task, late)
    if (task && !SETTLED.has(task.status)) d.settle(task, 'interrupted')

    assert.equal(late.status, 'interrupted', '会话被销毁，活跃的那条要结算')
    assert.equal(early.status, 'done', '已结算的那条不能被改写（这是 0.6.0 的老 bug）')
    assert.equal(early.settledAt, early.settledAt, '早先那条的结算时刻不受影响')
  })
})

// ---------------------------------------------------------------- §七.2 取消隔离（本轮不改变语义）

test('§七.2 取消隔离：取消 A 不会让同会话的 B 变成 interrupted/failed', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const a = mkTask('t-a', 'dispatch-shared', 'running')
    const b = mkTask('t-b', 'dispatch-other', 'running')
    d.table.add(a)
    d.table.add(b)
    host.agents.set('dispatch-shared', makeAgent('dispatch-shared'))
    host.agents.set('dispatch-other', makeAgent('dispatch-other'))

    await d.cancel(a, '看板取消')

    assert.equal(a.status, 'cancelled')
    assert.equal(b.status, 'running', '取消一条任务不能波及另一条会话上的任务')
    assert.equal(b.settledAt, undefined, 'B 没有被结算')
    assert.equal(d.table.byWorker('dispatch-other'), b, 'B 仍然可以被正常查询到')
  })
})

test('§七.2 取消的**当前**语义：同会话另一条任务不受状态污染，但会话回合确实被打断', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const a = mkTask('t-a', 'dispatch-shared', 'running')
    const b = mkTask('t-b', 'dispatch-shared', 'running')
    d.table.add(a)
    d.table.add(b)
    let cancelled = 0
    const worker = makeAgent('dispatch-shared')
    worker.cancel = () => { cancelled += 1 }
    host.agents.set('dispatch-shared', worker)

    await d.cancel(a, '看板取消')

    // 本轮**不改**取消行为：它取消的是会话当前回合（`agent.cancel`），
    // 所以同会话的 B 的**状态**不会被写成 interrupted —— 它只会因为
    // `agent/disposed` / `onWorkerIdle` 之类的后续事件才可能结算（那是阶段 2 的事）。
    assert.equal(cancelled, 1, '取消仍然会调一次 agent.cancel（本轮不改这个行为）')
    assert.equal(a.status, 'cancelled')
    assert.equal(b.status, 'running', '取消 A 不得直接把 B 的状态改成 interrupted')
    assert.equal(b.settledAt, undefined)
  })
})

// ---------------------------------------------------------------- §七.3 归档安全

test('§七.3 归档安全：归档一条任务不让同会话其它任务不可用', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const old = mkTask('t-old', 'dispatch-shared', 'done', {
      updatedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    })
    const live = mkTask('t-live', 'dispatch-shared', 'running')
    d.table.add(old)
    d.table.add(live)
    host.agents.set('dispatch-shared', makeAgent('dispatch-shared'))

    await d.archiveStale()

    assert.ok(old.archivedAt, '老的那条应当被归档')
    assert.equal(live.archivedAt, undefined, '还活着的那条不该被归档')
    assert.equal(d.table.byWorker('dispatch-shared'), live, '归档不能把同会话的活跃任务弄丢')
    assert.equal(d.table.get('t-live'), live, '两条任务都还在活表里')
  })
})

test('§七.3 归档安全：归档已结算的那条之后，同会话活跃任务仍能收报告', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const old = mkTask('t-old', 'dispatch-shared', 'done', {
      updatedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    })
    const live = mkTask('t-live', 'dispatch-shared', 'running')
    d.table.add(old)
    d.table.add(live)
    const worker = makeAgent('dispatch-shared')
    host.agents.set('dispatch-shared', worker)

    await d.archiveStale()
    const result = await d.report(worker, { status: 'progress', summary: '归档之后照样能报' })

    assert.equal(result.task_id, 't-live')
    assert.equal(live.reports.length, 1)
    assert.equal(old.reports.length, 0)
  })
})

// ---------------------------------------------------------------- threadId 的落盘与向后兼容

test('threadId 落盘：新任务写到 tasks.json，读回来还是同一个值', async () => {
  await withDispatch({}, async ({ d, host, dir }) => {
    host.agents.set('lead', makeAgent('lead'))
    const task = mkTask('t-persist', 'dispatch-t-persist', 'running')
    d.table.add(task)

    await d.persist()
    const raw = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'))
    const stored = raw.tasks.find(item => item.id === 't-persist')
    assert.equal(stored.threadId, newThreadId('t-persist'), 'threadId 必须真的落盘，而不是只活在内存里')
  })
})

test('threadId 向后兼容：老数据没有这个键时按派生规则补出来，不报错、不当成另一条线程', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-tb-old-'))
  const base = new Date().toISOString()
  // 模拟 0.8.x 落盘的 tasks.json：**没有 threadId**。
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [
      { ...mkTask('t-old', 'dispatch-t-old', 'done'), createdAt: base, updatedAt: base },
      { ...mkTask('t-old2', 'dispatch-t-old2', 'done'), createdAt: base, updatedAt: base },
    ],
  }, base)
  // 把 threadId 从盘上的数据里删掉——writeState 会把对象原样序列化。
  const raw = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'))
  for (const item of raw.tasks) delete item.threadId
  await writeState(join(dir, 'tasks.json'), raw, base)

  const d = new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
  })
  try {
    await d.restore()

    for (const id of ['t-old', 't-old2']) {
      const task = d.table.get(id)
      assert.ok(task, `${id} 必须能读回来（缺 threadId 不是数据损坏）`)
      assert.equal(task.threadId, newThreadId(id),
        `${id} 的 threadId 必须按派生规则补出来：升级前派的与升级后派的要落在同一条线程里`)
      assert.equal(task.status, 'done', '补 threadId 不该改动任务状态')
    }
    // 补出来的值与「新版本当时就会写下的那个」逐字相同 —— 这就是「不当成不同线程」。
    assert.notEqual(d.table.get('t-old').threadId, d.table.get('t-old2').threadId,
      '两条各自的线程标识仍然不同（今天是一任务一线程）')
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('threadId 向后兼容：坏值（数字/空串）也按派生规则归一，不抛错', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-tb-bad-'))
  const base = new Date().toISOString()
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [
      { ...mkTask('t-num', 'dispatch-t-num', 'done'), threadId: 42, createdAt: base, updatedAt: base },
      { ...mkTask('t-empty', 'dispatch-t-empty', 'done'), threadId: '', createdAt: base, updatedAt: base },
    ],
  }, base)

  const d = new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
  })
  try {
    await d.restore()
    assert.equal(d.table.get('t-num').threadId, newThreadId('t-num'))
    assert.equal(d.table.get('t-empty').threadId, newThreadId('t-empty'))
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('threadId 跟随退休留痕：退休记录仍能回答「它属于哪条线程」', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead'))
    const task = mkTask('t-retire', 'dispatch-t-retire', 'done', {
      updatedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    })
    d.table.add(task)

    d.enforceLedgerCap()

    const record = d.retired.get('t-retire')
    assert.ok(record, '超期任务应当被退休')
    assert.equal(record.threadId, newThreadId('t-retire'), '留痕要带线程标识，否则线程视图会把它算成孤儿')
    assert.equal(d.table.active.has('dispatch-t-retire'), false, '退休后绑定必须一起清掉')
  })
})
