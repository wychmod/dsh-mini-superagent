/**
 * `dispatch_wait` 区分「超时」与「全部结算」的行为回归测试（PRD A3 §7.7）。
 *
 * 为什么需要它：`waitFor()` 以前两条路径共用 `finish()`、返回值没有标志，
 * 于是 `dispatch_wait` 无论等到还是等满都返回同样的 `{ waited: true, tasks }`。
 * 调用方只能逐条看 `status` 反推——而超时那一刻任务本来就还是 `running`，
 * 两种情形在数据上无法区分。这里钉住新返回体的四个字段，以及四条边界：
 * 空 task_ids、重复 id、超时后摘除 waiters、等待期间取消。
 *
 * 为什么走 `toolDefinitions()` 而不是只测 `waitFor()`：字段拼装（`unsettled`
 * 的投影与去重）在工具层，只测 `waitFor()` 证明不了模型实际拿到的 JSON。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatch } from '../src/dispatch.js'
import { toolDefinitions } from '../src/tools.js'

function makeHost() {
  const agents = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    get: () => undefined,
    on: () => () => {},
    effect: fn => fn,
    agents: { get: id => agents.get(id) },
    sessionController: {
      async create() {},
      async rename() {},
      async resolveAgent(id) {
        return agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'not-found' } }
      },
      async state() { throw Object.assign(new Error('nf'), { code: 'nf' }) },
      async list() { return { items: [] } },
      async prompt() {},
    },
  }
  return { ctx, agents }
}

/** 只把 `dispatch_wait` 真正会碰到的外部依赖替换掉，其余保持真实实现。 */
function stub(d, host, dir) {
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
    refreshHint: () => {},
    dispose: () => {},
    restrictTools: () => () => {},
    forgetRestrict: () => {},
    holds: () => false,
    async createWorker(sessionId) {
      const agent = {
        id: sessionId, status: 'idle',
        session: { snapshotEvents: () => [] },
        ctx: { systemPrompt: { section: () => () => {} } },
        cancel() {}, steer() {}, followup() {},
      }
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  return d
}

async function withDispatch(fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-wait-'))
  const d = stub(new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  }), host, dir)
  const tools = Object.fromEntries(toolDefinitions(d).map(item => [item.name, item]))
  try {
    await fn({ d, host, dir, tools })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const parent = () => ({ id: 'lead', status: 'running' })
const exec = agent => ({ agent })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 造一条挂在主会话名下的任务；状态默认 running（永不自行结算）。 */
function addTask(d, id, status = 'running') {
  const task = {
    id,
    title: id,
    brief: 'b',
    parentSessionId: 'lead',
    workerSessionId: `dispatch-${id}`,
    status,
    reports: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  d.table.add(task)
  return task
}

/**
 * 让事件循环保持存活。
 *
 * `waitFor` 的定时器带 `unref()`（避免拖住进程退出），所以测试里必须自己
 * 提供活着的句柄，否则「超时」这条路径根本不会触发，断言会永远挂住。
 */
function keepAlive() {
  const timer = setInterval(() => {}, 5)
  return () => clearInterval(timer)
}

test('dispatch_wait 超时返回 timed_out: true，unsettled 列出未结算任务', async () => {
  await withDispatch(async ({ d, tools }) => {
    const agent = parent()
    addTask(d, 'w1')
    const stop = keepAlive()

    // 验收 §7.7 第 1 条照 PRD 用 1000ms；任务永不结算，只能等到超时。
    const value = await tools.dispatch_wait.execute(
      { task_ids: ['w1'], timeout_ms: 1000 }, exec(agent))
    stop()

    assert.equal(value.waited, true)
    assert.equal(value.timed_out, true, '超时返回必须自带信号')
    assert.deepEqual(value.unsettled, ['w1'])
    assert.equal(value.tasks.length, 1)
    assert.equal(value.tasks[0].task_id, 'w1')
    // 超时不伪造：卡片里就是任务当时的真实状态。
    assert.equal(value.tasks[0].status, 'running', '超时不该改写任务状态')
  })
})

test('dispatch_wait 全部结算返回 timed_out: false、unsettled: []', async () => {
  await withDispatch(async ({ d, tools }) => {
    const agent = parent()
    const a = addTask(d, 'w1')
    const b = addTask(d, 'w2')
    const stop = keepAlive()

    const waiting = tools.dispatch_wait.execute(
      { task_ids: ['w1', 'w2'], timeout_ms: 1000 }, exec(agent))
    await delay(20)
    d.table.settle(a, 'done')
    d.table.settle(b, 'failed')
    const value = await waiting
    stop()

    assert.equal(value.waited, true)
    assert.equal(value.timed_out, false, '全部结算不是超时')
    assert.deepEqual(value.unsettled, [], '没有未结算任务')
    assert.deepEqual(value.tasks.map(item => item.status), ['done', 'failed'])
  })
})

test('dispatch_wait 空 task_ids 且无未结算任务：waited/timed_out 为 false，unsettled 为 []', async () => {
  await withDispatch(async ({ d, tools }) => {
    const agent = parent()
    // 只有已结算任务：`targets` 为空，走「没有可等任务」分支。
    addTask(d, 'old1', 'done')
    const stop = keepAlive()

    const value = await tools.dispatch_wait.execute({}, exec(agent))
    stop()

    assert.equal(value.waited, false)
    assert.equal(value.timed_out, false)
    assert.deepEqual(value.unsettled, [])
    assert.equal(value.tasks.length, 1, '没有可等任务时仍返回最新任务供判断')
  })
})

test('dispatch_wait 等待期间任务被取消：cancelled 算已结算，不进 unsettled', async () => {
  await withDispatch(async ({ d, tools }) => {
    const agent = parent()
    // queued 任务没有后台活，取消只需摘队列 + 结算，不需要真 worker。
    addTask(d, 'w1', 'queued')
    const stop = keepAlive()

    const waiting = tools.dispatch_wait.execute(
      { task_ids: ['w1'], timeout_ms: 1000 }, exec(agent))
    await delay(20)
    await tools.dispatch_cancel.execute({ task_id: 'w1' }, exec(agent))
    const value = await waiting
    stop()

    assert.equal(value.timed_out, false, 'cancelled 属于 SETTLED，应走「全部结算」路径')
    assert.deepEqual(value.unsettled, [], 'cancelled 不是「还在跑」')
    assert.equal(value.tasks[0].status, 'cancelled')
  })
})

test('dispatch_wait 重复 task_id：unsettled 只出现一次', async () => {
  await withDispatch(async ({ d, tools }) => {
    const agent = parent()
    addTask(d, 'w1')
    const stop = keepAlive()

    const value = await tools.dispatch_wait.execute(
      { task_ids: ['w1', 'w1'], timeout_ms: 1000 }, exec(agent))
    stop()

    assert.equal(value.timed_out, true)
    assert.deepEqual(value.unsettled, ['w1'], '同一个 id 不能列两次')
  })
})
