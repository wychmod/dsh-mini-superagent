/**
 * 「派发非阻塞」的行为回归测试。
 *
 * 为什么需要它：提示词里写「派发不阻塞」是一回事，调用方真的不会被挂住是另一回事。
 * 之前只有 prompt 文本的断言，证明不了运行时行为——一旦哪天 `launch()` 里多了一个
 * 等待子会话的 `await`，文本断言仍然全绿，但用户会重新开始卡死。
 *
 * 这里直接驱动 `toolDefinitions()` 返回的 `dispatch_launch.execute`，用计时与
 * 「子会话那步尚未完成」两个信号证明它确实提前返回。
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
    // 路由模式的两个口子：这里只要不抛错，测试不关心它们做了什么。
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
  const dir = await mkdtemp(join(tmpdir(), 'mas-nb-'))
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

test('dispatch_launch 在子会话干活之前就返回', async () => {
  await withDispatch(async ({ d, host, tools }) => {
    let deliverDone = false
    d.sessions.deliver = async () => {
      await new Promise(resolve => setTimeout(resolve, 250))
      deliverDone = true
      return { delivered: 'inbox', woke: false }
    }
    const agent = parent()
    host.agents.set('lead', agent)

    const startedAt = Date.now()
    const value = await tools.dispatch_launch.execute({ title: '慢任务', brief: 'x' }, exec(agent))
    const elapsed = Date.now() - startedAt

    assert.equal(deliverDone, false, 'launch 返回时，子会话的简报投递不该已经完成')
    assert.ok(elapsed < 200, `launch 应当立即返回（实际 ${elapsed}ms）`)
    assert.equal(value.task.status, 'running')

    await new Promise(resolve => setTimeout(resolve, 300))
  })
})

test('等待期间可以连续派发多个任务，不互相阻塞', async () => {
  await withDispatch(async ({ d, host, tools }) => {
    d.table.maxWorkers = 3
    d.sessions.deliver = async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return { delivered: 'inbox', woke: false }
    }
    const agent = parent()
    host.agents.set('lead', agent)

    const startedAt = Date.now()
    const values = await Promise.all([
      tools.dispatch_launch.execute({ title: 'A', brief: 'a' }, exec(agent)),
      tools.dispatch_launch.execute({ title: 'B', brief: 'b' }, exec(agent)),
      tools.dispatch_launch.execute({ title: 'C', brief: 'c' }, exec(agent)),
    ])
    const elapsed = Date.now() - startedAt

    assert.equal(values.length, 3)
    assert.equal(new Set(values.map(item => item.task.task_id)).size, 3, '三个任务各自独立')
    assert.ok(elapsed < 500, `三次派发应当并发完成（实际 ${elapsed}ms；串行的话至少 600ms）`)
    assert.equal(d.table.runningCount(), 3)

    await new Promise(resolve => setTimeout(resolve, 300))
  })
})

test('子会话报告后自动投递给主会话，主会话无需主动取', async () => {
  await withDispatch(async ({ d, host }) => {
    const agent = { id: 'lead', status: 'idle' }
    host.agents.set('lead', agent)

    const workerId = 'dispatch-t1'
    host.agents.set(workerId, {
      id: workerId, status: 'running',
      session: { snapshotEvents: () => [] },
      ctx: { systemPrompt: { section: () => () => {} } },
      cancel() {}, steer() {}, followup() {},
    })

    const delivered = []
    d.sessions.deliver = async (sessionId, requestId, text) => {
      if (sessionId === 'lead') delivered.push(text)
      return { delivered: 'inbox', woke: true }
    }

    const task = {
      id: 't1', title: '任务', brief: 'b', parentSessionId: 'lead',
      workerSessionId: workerId, status: 'running', reports: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    d.table.add(task)

    await d.report(host.agents.get(workerId), { status: 'done', summary: '干完了' })

    assert.equal(delivered.length, 1, '报告应自动投递给主会话')
    assert.match(delivered[0], /干完了/)
    assert.equal(task.status, 'done')
  })
})

test('dispatch_wait 确实阻塞（作为对照，说明它不该被滥用）', async () => {
  await withDispatch(async ({ d, host, tools }) => {
    const agent = parent()
    host.agents.set('lead', agent)
    d.table.add({
      id: 'w1', title: 'x', brief: 'b', parentSessionId: 'lead',
      workerSessionId: 'dispatch-w1', status: 'running', reports: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })

    const keepAlive = setInterval(() => {}, 5)
    const startedAt = Date.now()
    await tools.dispatch_wait.execute({ task_ids: ['w1'], timeout_ms: 120 }, exec(agent))
    const elapsed = Date.now() - startedAt
    clearInterval(keepAlive)

    assert.ok(elapsed >= 110, `dispatch_wait 应当阻塞到超时（实际 ${elapsed}ms）`)
  })
})
