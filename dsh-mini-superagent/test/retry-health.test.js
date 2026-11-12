/**
 * A6：重试健康度投影（`retry_health`）。
 *
 * 这一份测试只钉 PRD §10.7 的六条验收 + §10.5 的边界，不重测续跑策略本身
 *（退避与放弃在 recovery.test.js 里）。
 *
 * 为什么边界比功能更值得测：`retry_health` 是**内存派生值**，它的全部价值是
 * 「说真话」。显示错一次，用户就会按错的次数决定「再等等」还是「该介入」。
 * 所以「重启后不显示」「结算后消失」「没触发续跑就别显示」都要有断言，
 * 而不是只看「一切正常时显示得对」。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { boardTask } from '../src/board.js'
import { Dispatch } from '../src/dispatch.js'

// ---------------------------------------------------------------- 夹具（照 recovery.test.js）

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

/** 起一个可用的 Dispatch（与 recovery.test.js 同一套替身）。 */
async function withDispatch(config, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-a6-'))
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

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return true
    if (Date.now() - started > timeoutMs) return false
    await tick()
  }
}

const workerTask = (extra = {}) => ({
  id: 't-a6', title: '任务', brief: 'b', parentSessionId: 'lead',
  workerSessionId: 'dispatch-t-a6', status: 'running', reports: [],
  attempt: 1,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...extra,
})

/** 起一条 running 任务并把它绑到 worker 上（`byWorker()` 靠会话 id 找任务）。 */
function liveTask(d, host, extra = {}) {
  host.agents.set('lead', makeAgent('lead'))
  const worker = makeAgent('dispatch-t-a6')
  host.agents.set('dispatch-t-a6', worker)
  const task = workerTask(extra)
  d.table.add(task)
  return { task, worker }
}

const transient = (message = 'model overloaded') => Object.assign(new Error(message), { status: 503 })

/**
 * 从 client 源码里抽出 zh / en 两份文案（A6 只需要看自己的键）。
 *
 * 用源码而不是运行时对象：`TEXT` / `TEXT_EN` 都在客户端工厂作用域里，外面拿不到。
 * 缩进规则与 `scripts/client-smoke.mjs` 的「TEXT 与 TEXT_EN 键集合一致」同一条，
 * 这样「键写在了错的地方、locale 注册收不到」也能在这里先报警。
 */
function localeBlocks(source) {
  const zhBlock = source.slice(source.indexOf('const TEXT = {'), source.indexOf('const TEXT_EN = {'))
  const enBlock = source.slice(source.indexOf('const TEXT_EN = {'), source.indexOf('/** 当前翻译函数'))
  const pick = block => {
    const out = {}
    for (const line of block.split('\n')) {
      const match = /^\s{6}(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(line)
      if (match) out[match[1] || match[2]] = match[3]
    }
    return out
  }
  return { zh: pick(zhBlock), en: pick(enBlock) }
}

// ---------------------------------------------------------------- 验收 1：两次续跑后次数与起点

test('A6 验收 1：两次瞬时失败后 retry_health.attempts=2、since 非空（dispatch_inspect 口径）', async () => {
  await withDispatch({ retryBackoffMs: [1, 1] }, async ({ d, host }) => {
    const { task, worker } = liveTask(d, host)

    d.onWorkerError(worker, transient('第一次 503'))
    // 等 `resumeAfterError()` 投递完并清掉 retryAt，再制造第二次失败。
    await waitFor(() => task.retryAt === undefined)
    d.onWorkerError(worker, transient('第二次 503'))
    await waitFor(() => task.retryAt === undefined)

    // `dispatch_inspect` 走的是 `detail()`，而 `detail()` 铺开 `card()`。
    const inspected = d.detail(task)
    assert.ok(inspected.retry_health, '两次续跑之后必须投影 retry_health')
    assert.equal(inspected.retry_health.attempts, 2)
    assert.equal(typeof inspected.retry_health.since, 'string')
    assert.ok(inspected.retry_health.since.length > 0, 'since 不能是空串')
    // since 是**首次**续跑的起点，不是最近一次：两次失败之间只前进，不会被刷新。
    assert.ok(Number.isFinite(Date.parse(inspected.retry_health.since)))
    assert.equal(task.status, 'running', '续跑中不该结算任务')
    assert.equal(inspected.retry_health.last_error, '第二次 503', '最近一次瞬时错误要能查到')
    // `task.error` 在续跑路径上不写（那是「结算原因」），所以最近错误必须单独记。
    assert.equal(inspected.error, undefined, '续跑中不能有结算错误，否则像已经失败')
  })
})

// ---------------------------------------------------------------- 验收 2：看板文案

test('A6 验收 2：看板快照带 retry_health，标签文案「重试 2 次」+「自 HH:mm 起」', async () => {
  await withDispatch({ retryBackoffMs: [1] }, async ({ d, host }) => {
    const { task, worker } = liveTask(d, host)
    d.onWorkerError(worker, transient())
    await waitFor(() => task.retryAt === undefined)

    // 快照只做投影：`boardTask(task)` 签名不变，值来自 Host 挂在任务上的快照。
    const shaped = boardTask(task)
    assert.ok(shaped.retry_health, '看板要能看到续跑次数')
    assert.equal(shaped.retry_health.attempts, 1)
    assert.equal(shaped.retry_health.since, task.retryHealth.since)

    // 文案是客户端的事，单元层读源码钉三件事：键在（按 locales 的 6 空格缩进规则
    // 真能被抽到）、中英成对、渲染真的用了它。
    const client = await readFile(new URL('../client/index.js', import.meta.url), 'utf8')
    const texts = localeBlocks(client)
    assert.equal(texts.zh.retryTag, '重试 {n} 次', '中文标签必须是「重试 {n} 次」')
    assert.equal(texts.en.retryTag, 'retried {n}×', '英文标签不能缺')
    assert.equal(texts.zh.retrySinceHint, '自 {time} 起', '中文提示必须是「自 {time} 起」')
    assert.equal(texts.en.retrySinceHint, 'since {time}', '英文提示不能缺')
    assert.match(client, /h\('span', retryTagProps, fill\(tr\('retryTag'\), \{ n: retryAttempts \}\)\)/,
      '标签必须真的按 retryTag 渲染（不是只加了文案没接线）')
    assert.match(client, /title = fill\(tr\('retrySinceHint'\), \{ time: retrySinceAt \}\)/,
      '有 since 时要给出「自 HH:mm 起」的 title')
    // 展开后的实际文字（测试里手算一遍，防止模板与实参对不上）。
    assert.equal(texts.zh.retryTag.replace('{n}', '2'), '重试 2 次')
  })
})

// ---------------------------------------------------------------- 验收 3：结算后字段消失

test('A6 验收 3：报告到达（任务活过来）后 retry_health 消失、retry_at 也清掉', async () => {
  await withDispatch({ retryBackoffMs: [1] }, async ({ d, host }) => {
    const { task, worker } = liveTask(d, host)
    d.onWorkerError(worker, transient())
    await waitFor(() => task.retryAt === undefined)
    assert.ok(d.card(task).retry_health, '前置条件：此刻确实在续跑')

    await d.report(worker, { status: 'done', summary: '活干完了' })

    assert.equal(d.card(task).retry_health, undefined, '计数清了，字段就必须消失')
    assert.equal(d.card(task).retry_at, undefined, 'retry_at 语义不变：没有下一次续跑就没有它')
    // 内存里的三张表也要一起空（漏一处就是长期内存增长）。
    assert.equal(d.retryCounts.has(task.id), false)
    assert.equal(d.retrySince.has(task.id), false)
    assert.equal(task.retryHealth, undefined, '派生快照不能留残影')
    assert.equal(boardTask(task).retry_health, undefined)
  })
})

// ---------------------------------------------------------------- 验收 4：重启后归零

test('A6 验收 4：重启插件（新的 Dispatch 实例）后同一任务不再显示 retry_health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-a6-restart-'))
  try {
    // ---- 第一个实例：制造一次续跑并落盘
    const hostA = makeHost()
    const first = new Dispatch(hostA.ctx, {
      stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
      retryBackoffMs: [1],
    })
    first.workspaces = {
      list: () => [], resolve: async () => undefined,
      resolveOrCreate: async () => ({ workspace: undefined, created: false }),
      dayWorkspace: async () => undefined, defaultWorkspace: async () => undefined,
      archiveSession: async () => ({ ok: true }), get root() { return dir },
    }
    first.sessions = {
      cwdFor: () => dir, hint: () => {}, dispose: () => {},
      restrictTools: () => () => {}, forgetRestrict: () => {}, holds: () => false,
      async createWorker() { throw new Error('不该走到这里') },
      async enterDirectory() {},
      async deliver() { return { delivered: 'inbox', woke: false } },
    }
    const worker = makeAgent('dispatch-t-a6')
    hostA.agents.set('dispatch-t-a6', worker)
    hostA.agents.set('lead', makeAgent('lead'))
    const task = workerTask()
    first.table.add(task)
    first.onWorkerError(worker, transient())
    await waitFor(() => task.retryAt === undefined)
    assert.ok(first.card(task).retry_health, '前置条件：续跑中')
    await first.persist()
    // 续跑中的任务确实会把派生快照写进账本（`#writeOnce()` 是 `{...task}`）。
    const ledger = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'))
    assert.ok(ledger.tasks.some(item => item.id === 't-a6' && item.retryHealth),
      '账本里会有 retryHealth：这正是重启时必须清掉它的原因')
    await first.dispose()

    // ---- 第二个实例：同一份账本、新的内存表
    const hostB = makeHost()
    const second = new Dispatch(hostB.ctx, {
      stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
    })
    second.workspaces = first.workspaces
    second.sessions = {
      cwdFor: () => dir, hint: () => {}, dispose: () => {},
      restrictTools: () => () => {}, forgetRestrict: () => {}, holds: () => false,
      async createWorker() { throw new Error('不该走到这里') },
      async enterDirectory() {},
      async deliver() { return { delivered: 'inbox', woke: false } },
    }
    await second.restore()

    const restored = second.table.get('t-a6')
    assert.ok(restored, '重启后任务还在表里（这条断言保证下面不是「查不到所以没字段」）')
    assert.equal(second.retryCounts.has('t-a6'), false, '计数是纯内存的，重启必须归零')
    assert.equal(second.card(restored).retry_health, undefined,
      '重启后不能显示历史次数——那是在编造一个内存里不存在的计数')
    assert.equal(boardTask(restored).retry_health, undefined)
    assert.equal(restored.retryHealth, undefined, '账本里带回来的派生快照也要清掉')
    await second.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 验收 5：retry_at 语义不变

test('A6 验收 5（回归）：retry_at 仍只在「已安排下一次续跑」时出现，与 retry_health 同步', async () => {
  await withDispatch({ retryBackoffMs: [30] }, async ({ d, host }) => {
    const { task, worker } = liveTask(d, host)
    d.onWorkerError(worker, transient())

    // 退避还没结束：`retry_at` 在，`last_at` 与它同值（同一个事实两种投影）。
    const waiting = d.card(task)
    assert.ok(waiting.retry_at, 'retry_at 语义不变：安排了下一次就要有')
    assert.equal(waiting.retry_health.last_at, waiting.retry_at)

    // 投递成功之后：retry_at 消失，但次数与起点还在（这一轮还没结束）。
    await waitFor(() => task.retryAt === undefined)
    const resumed = d.card(task)
    assert.equal(resumed.retry_at, undefined, '没有下一次续跑了就不能留 retry_at')
    assert.equal(resumed.retry_health.attempts, 1)
    assert.equal(resumed.retry_health.last_at, undefined, 'last_at 缺失时省略，不写空串')
    assert.ok(resumed.retry_health.since)
  })
})

// ---------------------------------------------------------------- 验收 6 的边界：非瞬时错误不算续跑

test('A6 边界：非瞬时故障不触发续跑 → attempts 为 0，不显示 retry_health', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const { task, worker } = liveTask(d, host)
    d.onWorkerError(worker, new Error('permission denied'))
    await waitFor(() => task.status === 'failed')

    const card = d.card(task)
    assert.equal(card.retry_health, undefined, '一次都没续跑过就不能有 retry_health')
    assert.match(card.error, /permission denied/, '失败原因仍由 card().error 承担')
    assert.equal(d.retrySince.size, 0, '没续跑过就不该在起点表里留键')
    assert.equal(boardTask(task).retry_health, undefined)
  })
})

test('A6 边界：续跑次数用完转 failed 后 retry_health 消失（结算点也同步清理）', async () => {
  await withDispatch({ retryBackoffMs: [1] }, async ({ d, host }) => {
    const { task, worker } = liveTask(d, host)
    d.onWorkerError(worker, transient())
    await waitFor(() => task.retryAt === undefined)
    d.onWorkerError(worker, transient())
    await waitFor(() => task.status === 'failed')

    assert.equal(d.card(task).retry_health, undefined, '结算成 failed 就没有「还在续跑」这回事')
    assert.equal(d.retryCounts.size + d.retrySince.size, 0, '两张表必须同步清空')
    assert.match(d.card(task).error, /瞬时故障连续 1 次/, '放弃原因仍然写进 card().error')
  })
})

// ---------------------------------------------------------------- 「必须是两件事」：与投递重试分开

test('A6 边界：retry_health 与投递重试（report_delivery）是两件事，字段名不混用', async () => {
  await withDispatch({ retryBackoffMs: [1] }, async ({ d, host }) => {
    const { task, worker } = liveTask(d, host)
    d.onWorkerError(worker, transient())
    await waitFor(() => task.retryAt === undefined)

    // 同一个任务上同时出现：续跑次数 + 报告没送到的投递结果。
    task.delivery = { outcome: 'failed', attempts: 3 }
    const card = d.card(task)
    const shaped = boardTask(task)

    assert.deepEqual(Object.keys(card.retry_health).sort(), ['attempts', 'last_error', 'since'])
    assert.equal(card.retry_health.attempts, 1)
    assert.equal(card.retry_health.delivery, undefined, '续跑块里绝不能塞投递字段')
    assert.equal(card.report_delivery.outcome, 'failed', '投递结果是自己的字段')
    assert.equal(shaped.report_delivery, undefined, '快照没有投递块时也不该凭空造一个')
    assert.notEqual(shaped.retry_health, undefined)
    task.delivery = undefined
  })
})

test('A6：retrySince 与 retryCounts 同生命周期（卸载清空、报告与失败双清）', async () => {
  // 卸载：两表一起空。这里用 `dispose()` 观察一个真在续跑的实例。
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-a6-dispose-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
    retryBackoffMs: [60000],
  })
  d.workspaces = {
    list: () => [], resolve: async () => undefined,
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined, defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }), get root() { return dir },
  }
  d.sessions = {
    cwdFor: () => dir, hint: () => {}, dispose: () => {},
    restrictTools: () => () => {}, forgetRestrict: () => {}, holds: () => false,
    async createWorker() { throw new Error('不该走到这里') },
    async enterDirectory() {},
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  try {
    const { task, worker } = liveTask(d, host)
    d.onWorkerError(worker, transient())
    assert.equal(d.retrySince.size, 1, '前置条件：起点表里有键')
    assert.equal(task.status, 'running')

    await d.dispose()
    assert.equal(d.retryCounts.size, 0)
    assert.equal(d.retrySince.size, 0, '漏掉这处 clear 就是长期内存增长（PRD §10.8）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
