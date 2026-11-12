/**
 * 回归：**活着的 worker 被误判成「已中断」**（真实事故 t-mwcbmq2a-2）。
 *
 * 事故链路（账本证据见任务报告）：
 *   1. 16:16:14 派发，任务 `running`，worker 开始干活；
 *   2. 16:20:08 **插件热重载** → 新实例 `restore()` 按旧前提「进程重启 ⇒ 没有活的
 *      worker」把这条 `running` 改写成 `interrupted`（写下了 settledAt）；
 *   3. worker 的会话与回合都还活着，继续干到 16:40:55 才 `dispatch_report(done)`；
 *   4. `report()` 走到 `settle(task,'done')`，被 `TaskTable.settle()` 的幂等判断
 *      挡掉（`SETTLED.has('interrupted')` → false），状态永远停在 interrupted；
 *   5. 看板把一条**已经完成**的任务显示成「已中断」，且它的后继被连带取消。
 *
 * 两条不变式被这次事故破坏，本文件各给一条用例：
 *   - **A. 结算之后不许被改回活跃**：`interrupted` 是「假定死亡」，worker 还能发来
 *     报告就证明它没死，账本必须按 worker 自己的结论收敛；
 *   - **B. 重启恢复不许把活会话判死**：热重载只换插件实例，宿主的子会话与它正在跑
 *     的回合都还在，此时把 `running` 标成 `interrupted` 就是替 worker 宣布死亡。
 *
 * 两个用例在修复前都是红的（见任务报告里的「先红」输出）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { newThreadId } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { writeState } from '../src/store.js'
import { toolDefinitions } from '../src/tools.js'

// ---------------------------------------------------------------- 夹具

/** 一个不需要宿主的最小 ctx：agents 是 Map，sessionController 只服务 resolve 探针。 */
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
    status: 'running',
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    cancel() {}, steer() {}, followup() {}, inject() {},
  }
}

/**
 * 驱动真实 `Dispatch` 的夹具（与 batch-dependencies.test.js 同一份口径）。
 *
 * `sessions.createWorker` 会把 worker 的 agent 放进 `host.agents`，于是
 * 「宿主里这条会话还在不在」这件事与真实宿主一致，`restore()` 的活会话探测
 * 才有东西可查。
 */
async function withDispatch(fn, config = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-false-int-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    noticeMergeWindowMs: 0,
    ...config,
  })
  stubDispatch(d, host)
  const deliveries = []
  d.sessions.deliver = async (sessionId, requestId, text) => {
    deliveries.push({ sessionId, requestId, text })
    return { delivered: 'inbox', woke: false }
  }
  host.agents.set('lead', makeWorker('lead'))
  const tools = Object.fromEntries(toolDefinitions(d).map(item => [item.name, item]))
  try {
    await fn({ d, host, dir, deliveries, tools })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/** workspaces / sessions 的最小替身：只保留恢复与启动真正会碰的那几个方法。 */
function stubDispatch(d, host) {
  d.workspaces = {
    list: () => [],
    resolve: async () => undefined,
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined,
    defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return d.config.stateDir },
  }
  d.sessions = {
    cwdFor: () => d.config.stateDir,
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
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
}

const call = (tool, args, agentId = 'lead') => tool.execute(args, { agent: { id: agentId } })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function drain(times = 8) {
  for (let index = 0; index < times; index += 1) await tick()
}
async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return Date.now() - started
    if (Date.now() - started > timeoutMs) return undefined
    await tick()
  }
}

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

// ---------------------------------------------------------------- A. 假定死亡可以被报告推翻

test('worker 仍活着：被误标 interrupted 的任务收到 done 报告后必须收敛成 done', async () => {
  await withDispatch(async ({ d, host, tools }) => {
    const result = await call(tools.dispatch_launch, { title: '长任务', brief: '干一件事' })
    const task = d.table.get(result.task.task_id)
    assert.ok(await waitFor(() => task.status === 'running') !== undefined, '任务应当被 pump 启动')

    // 复刻事故第 2 步：一次误判把它按「假定死亡」结算成 interrupted。
    // 这里直接调 `settle()`，因为真实事故里那一笔正是 restore() 的
    // `table.transition(task,'interrupted')`（同样写 status + settledAt）。
    d.settle(task, 'interrupted')
    assert.equal(task.status, 'interrupted')
    assert.ok(task.settledAt, '误判也要留下 settledAt（事故账本里就是 16:20:08 那一笔）')

    /**
     * 把误判时刻钉成一个**确定的历史时刻**，复刻事故账本里「16:20:08 判死、
     * 16:40:55 才收到 done」那 20 分钟的间隔。
     *
     * 为什么不能拿上面 `settle()` 刚写的 `now()` 直接比：`settle(interrupted)`
     * 与后面 `report(done)` 里的 `settle(done)` 之间只隔几次微任务，**完全可能
     * 落在同一毫秒**；此时实现完全正确（`transition()` 离开终态已把 settledAt
     * 清空，`settle()` 再写新值），但两个字符串恰好相等。旧断言 `notEqual`
     * 依赖「两次结算必然跨毫秒」这个不成立的前提，实测 4/20 次红——
     * 那是测试在断言时钟分辨率，不是在断言账本行为。
     *
     * 钉成旧时刻之后，「settledAt 被 done 报告纠正」这件事反而**更强**地可证：
     * 新值必须落在下面 done 报告的调用窗口里，而不是沿用这一笔。
     */
    const bogusSettledAt = '2026-11-11T16:20:08.148Z'
    task.settledAt = bogusSettledAt

    // 复刻事故第 3 步：worker 没死，回合继续，最后报 done。
    const worker = host.agents.get(task.workerSessionId)
    assert.ok(worker, '这条子会话在热重载后仍然活着')
    const beforeReport = Date.now()
    const reported = await d.report(worker, { status: 'done', summary: '活干完了', headline: '完成' })
    const afterReport = Date.now()
    assert.equal(reported.recorded, true, '报告必须入库')

    assert.equal(task.status, 'done', 'worker 的结论是权威的：账本不能停在 interrupted')
    assert.notEqual(task.settledAt, bogusSettledAt, '误判那一笔 settledAt 必须被新的结算时刻取代')
    // 只验「不等于旧值」还能被「settledAt 恰好写成别的任意旧值」蒙混；把它夹在
    // done 报告的时间窗里，才真正证明这一笔是**报告触发的结算**写下的。
    const settledMs = Date.parse(task.settledAt)
    assert.ok(settledMs >= beforeReport && settledMs <= afterReport,
      `settledAt 必须是 done 报告那一刻写下的，实际 ${task.settledAt} 不在 [${new Date(beforeReport).toISOString()}, ${new Date(afterReport).toISOString()}] 内`)
    assert.equal(d.table.runningCount(), 0, '收敛成 done 之后不能继续占并发位')
  })
})

test('worker 仍活着：被误标 interrupted 的任务收到 progress 报告后必须回到 running', async () => {
  await withDispatch(async ({ d, host, tools }) => {
    const result = await call(tools.dispatch_launch, { title: '长任务', brief: '干一件事' })
    const task = d.table.get(result.task.task_id)
    assert.ok(await waitFor(() => task.status === 'running') !== undefined)

    d.settle(task, 'interrupted')
    const worker = host.agents.get(task.workerSessionId)
    await d.report(worker, { status: 'progress', summary: '还在写测试' })

    assert.equal(task.status, 'running', 'progress 报告同样证明 worker 没死，不能留在 interrupted')
    assert.equal(task.settledAt, undefined, '回到活跃状态后「结算时刻」不再成立')
    assert.equal(d.table.runningCount(), 1, '活跃任务要重新占住自己的并发位')
  })
})

// ---------------------------------------------------------------- B. 恢复不许把活会话判死

test('插件热重载：worker 会话还活着时 restore() 不能把 running 标成 interrupted', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-false-int-restore-'))
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [storedTask('t-live', 'running', { startedAt: '2026-11-11T00:00:01.000Z' })],
  }, '2026-11-11T00:00:02.000Z')

  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  stubDispatch(d, host)
  // 热重载不销毁宿主的子会话：这条 worker 还活着，回合也在继续。
  host.agents.set('dispatch-t-live', makeWorker('dispatch-t-live'))
  host.agents.set('lead', makeWorker('lead'))
  try {
    await d.restore()
    const task = d.table.get('t-live')
    assert.ok(task, '任务必须被读回活表')
    assert.equal(task.status, 'running', '活着的 worker 不能被替它宣布死亡')
    assert.equal(task.settledAt, undefined, '保留 running 就不该有结算时刻')

    // 它随后自己把结论报上来，账本必须收下。
    const worker = host.agents.get('dispatch-t-live')
    await d.report(worker, { status: 'done', summary: '热重载之前就干完了' })
    assert.equal(task.status, 'done', '活会话的报告必须能把任务正常收尾')
    assert.ok(task.settledAt, '正常结算要留下结算时刻')
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('真重启：宿主里没有这条会话时 restore() 仍然把它标成 interrupted', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-false-int-restart-'))
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [storedTask('t-dead', 'running', { startedAt: '2026-11-11T00:00:01.000Z' })],
  }, '2026-11-11T00:00:02.000Z')

  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  stubDispatch(d, host)
  // 只有主会话在场，worker 会话随进程没了。
  host.agents.set('lead', makeWorker('lead'))
  try {
    await d.restore()
    const task = d.table.get('t-dead')
    assert.equal(task.status, 'interrupted', '没有活会话支撑的 running 仍然按重启处理')
    assert.ok(task.settledAt, 'interrupted 是终态，必须留下结算时刻')
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('会话还活着但已 idle（那一轮早就结束了）：仍按重启处理，不留永远占位的 running', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-false-int-idle-'))
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [storedTask('t-idle', 'running', { startedAt: '2026-11-11T00:00:01.000Z' })],
  }, '2026-11-11T00:00:02.000Z')

  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  stubDispatch(d, host)
  // 会话在，但回合结束了：没有别的东西会再给它送报告，留着 running 就是永久占位。
  host.agents.set('dispatch-t-idle', { ...makeWorker('dispatch-t-idle'), status: 'idle' })
  host.agents.set('lead', makeWorker('lead'))
  try {
    await d.restore()
    const task = d.table.get('t-idle')
    assert.equal(task.status, 'interrupted', 'idle 的会话不能把任务保持成 running')
    assert.equal(d.table.runningCount(), 0, '并发位不能被一条没有回合的任务占着')
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 存量记录的自愈

test('存量记录：interrupted 之后才到的终态报告会让 restore() 把状态纠正回 done', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-false-int-heal-'))
  /**
   * 复刻事故账本 t-mwcbmq2a-2 的真实形状：
   * `settledAt` 是误判时刻（16:20:08），`reports` 里那份 done 比它晚 20 分钟；
   * 另外派一条「中断之前就报过 done」的任务，用来证明自愈不吃上一轮的报告。
   */
  const stored = (id, extra) => ({
    ...storedTask(id, 'interrupted'),
    settledAt: '2026-11-11T16:20:08.148Z',
    updatedAt: '2026-11-11T16:40:55.417Z',
    ...extra,
  })
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [
      stored('t-late', {
        workerSessionId: 'dispatch-t-late',
        reports: [{ at: '2026-11-11T16:40:55.417Z', status: 'done', summary: '后来才报的结论' }],
        lastReportAt: '2026-11-11T16:40:55.417Z',
      }),
      stored('t-early', {
        workerSessionId: 'dispatch-t-early',
        reports: [{ at: '2026-11-11T16:10:00.000Z', status: 'done', summary: '中断之前那一轮' }],
        lastReportAt: '2026-11-11T16:10:00.000Z',
      }),
    ],
  }, '2026-11-11T16:41:00.000Z')

  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  stubDispatch(d, host)
  host.agents.set('lead', makeWorker('lead'))
  try {
    await d.restore()
    const late = d.table.get('t-late')
    assert.equal(late.status, 'done', '晚到的 done 才是权威结论，不能停在 interrupted')
    assert.equal(late.settledAt, '2026-11-11T16:40:55.417Z',
      '结算时刻要用报告自己的时刻，不能沿用误判那一笔（否则完成时间前移 20 分钟）')

    const early = d.table.get('t-early')
    assert.equal(early.status, 'interrupted', '中断之前那一轮的报告不能拿来复活任务')
    assert.equal(early.settledAt, '2026-11-11T16:20:08.148Z', '没被纠正的任务保留原来的结算时刻')
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
