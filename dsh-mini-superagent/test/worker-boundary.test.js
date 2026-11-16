/**
 * worker 的硬工具边界。
 *
 * worker 能派发时，`maxTasksPerSession` 只是限速：64 条子任务各自还能再派 64 条。
 * 创建 worker 后立刻收走「除 dispatch_report 以外的全部 dispatch_*」，
 * 让「worker 不再派生」成为工具层事实，而不是提示词里的请求。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatch } from '../src/dispatch.js'
import { SessionGateway } from '../src/sessions.js'
import { TOOL_NAMES } from '../src/tools.js'

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

function makeAgent(id) {
  return {
    id,
    status: 'running',
    session: { header: {}, snapshotEvents: () => [] },
    ctx: { tools: {} },
  }
}

async function withDispatch(fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-worker-boundary-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  d.workspaces = {
    list: () => [], resolve: async () => undefined,
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined, defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return dir },
  }
  d.placementFor = async () => ({ path: dir, workspaceId: undefined, title: '' })
  try {
    await fn({ d, host, dir })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

function addTask(d, overrides = {}) {
  const task = {
    id: 't-worker-1',
    title: '干一件活',
    brief: 'b',
    parentSessionId: 'lead',
    workerSessionId: 'dispatch-t-worker-1',
    status: 'running',
    reports: [],
    cwd: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
  d.table.tasks.set(task.id, task)
  return task
}

test('SessionGateway.restrictWorkerTools 只留 dispatch_report', () => {
  const calls = []
  const agent = {
    id: 'worker-1',
    ctx: {
      tools: {
        get: () => true,
        restrict: ({ deny }) => { calls.push([...deny]); return () => {} },
      },
    },
  }
  const gateway = new SessionGateway({ logger: { warn() {}, info() {} } }, {})

  gateway.restrictWorkerTools(agent)

  assert.deepEqual(calls[0], TOOL_NAMES.filter(name => name !== 'dispatch_report'))
  assert.ok(calls[0].includes('dispatch_launch'))
  assert.ok(!calls[0].includes('dispatch_report'))
})

test('同一 worker 二次收窄不会重复注册', () => {
  let restrictCalls = 0
  const agent = {
    id: 'worker-2',
    ctx: {
      tools: {
        get: () => true,
        restrict: () => { restrictCalls += 1; return () => {} },
      },
    },
  }
  const gateway = new SessionGateway({ logger: { warn() {}, info() {} } }, {})

  gateway.restrictWorkerTools(agent)
  gateway.restrictWorkerTools(agent)

  assert.equal(restrictCalls, 1, '复用时不该重复挂限制')
})

test('start() 在投递简报前收窄 worker 工具面', async () => {
  await withDispatch(async ({ d }) => {
    const calls = []
    d.sessions = {
      cwdFor: () => '',
      hint: () => {},
      dispose: () => {},
      restrictTools: () => () => {},
      restrictWorkerTools: agent => { calls.push(agent.id) },
      forgetRestrict: () => {},
      holds: () => false,
      async createWorker(sessionId) { return { agent: makeAgent(sessionId), sessionId } },
      async enterDirectory() {},
      async deliver() { return { delivered: 'inbox', woke: false } },
    }
    const task = addTask(d)

    await d.start(task)

    assert.deepEqual(calls, ['dispatch-t-worker-1'])
  })
})

test('升级/HMR 后对存量 worker 补收一次边界', async () => {
  await withDispatch(async ({ d, host }) => {
    const calls = []
    d.sessions.restrictWorkerTools = agent => { calls.push(agent.id) }
    addTask(d, { id: 't-live', workerSessionId: 'dispatch-t-live' })
    addTask(d, { id: 't-done', status: 'done', workerSessionId: 'dispatch-t-done' })
    host.agents.set('dispatch-t-live', makeAgent('dispatch-t-live'))
    host.agents.set('dispatch-t-done', makeAgent('dispatch-t-done'))

    d.restrictExistingWorkers()

    assert.deepEqual(calls, ['dispatch-t-live'], '已结算任务的会话不该再动')
  })
})

test('复用路径也会补一次 worker 收窄（覆盖老版本派出的会话）', async () => {
  await withDispatch(async ({ d, host }) => {
    const calls = []
    d.sessions = {
      cwdFor: () => '',
      hint: () => {},
      dispose: () => {},
      restrictTools: () => () => {},
      restrictWorkerTools: agent => { calls.push(agent.id) },
      forgetRestrict: () => {},
      holds: () => false,
      async enterDirectory() {},
      async deliver() { return { delivered: 'inbox', woke: false } },
    }
    addTask(d, { id: 't-parent', status: 'done', workerSessionId: 'dispatch-t-parent' })
    host.agents.set('dispatch-t-parent', makeAgent('dispatch-t-parent'))
    const task = addTask(d, { id: 't-child', parentTaskId: 't-parent', workerSessionId: 'dispatch-t-parent' })

    await d.start(task)

    assert.deepEqual(calls, ['dispatch-t-parent'])
  })
})
