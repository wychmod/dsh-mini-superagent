/**
 * 后台活续占槽位的回归测试。
 *
 * 语义（对齐上游 `dsh-superagent` 的 Assignment 级槽位）：worker 回合结束时，
 * 如果它的 shell job 或 subagent 还在跑，任务**不结算**——并发位继续占着，
 * 直到后台清空或到 `backgroundLimitMs`（默认 30 分钟，到点终止 job 再结算）。
 *
 * 0.8.1 及更早：`agent/status → idle` 直接 `settle('ended')`，于是「留了个 dev server」
 * 的任务被判完成，并发位被释放，而后台还在改同一个目录。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatch } from '../src/dispatch.js'

function makeHost() {
  const agents = new Map()
  const services = {}
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    get: name => services[name],
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
  return { ctx, agents, services }
}

function makeAgent(id, status = 'running') {
  return {
    id, status,
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    steer() {}, followup() {}, inject() {}, cancel() {},
  }
}

const workerTask = () => ({
  id: 't-bg', title: '起个服务', brief: 'b', parentSessionId: 'lead',
  workerSessionId: 'dispatch-t-bg', status: 'running', reports: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
})

async function withDispatch(config, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-bg-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    backgroundPollMs: 10,
    ...config,
  })
  d.workspaces = {
    list: () => [], resolve: async () => undefined,
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined, defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return dir },
  }
  d.sessions = {
    cwdFor: () => dir, hint: () => {}, dispose: () => {},
    restrictTools: () => () => {}, forgetRestrict: () => {},
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('回合结束但 job 还在跑：不结算，记下后台活', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.services.jobs = { list: () => [{ id: 'j1', owner: 'dispatch-t-bg', status: 'running' }] }
    const worker = makeAgent('dispatch-t-bg')
    host.agents.set('dispatch-t-bg', worker)
    const task = workerTask()
    d.table.add(task)

    await d.onWorkerIdle('dispatch-t-bg')

    assert.equal(task.status, 'running', '后台还在跑，不能结算（否则并发位被释放、目录还在被改）')
    assert.deepEqual(task.background && { jobs: task.background.jobs, subagents: task.background.subagents },
      { jobs: 1, subagents: 0 })
    assert.ok(task.background.since)
  })
})

test('后台清空后自动收尾并回流', async () => {
  await withDispatch({}, async ({ d, host }) => {
    let running = true
    host.services.jobs = { list: () => (running ? [{ id: 'j1', owner: 'dispatch-t-bg', status: 'running' }] : []) }
    const delivered = []
    d.sessions.deliver = async (_s, _r, text) => { delivered.push(text); return { delivered: 'inbox', woke: false } }
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-bg')
    host.agents.set('dispatch-t-bg', worker)
    const task = workerTask()
    d.table.add(task)

    await d.onWorkerIdle('dispatch-t-bg')
    assert.equal(task.status, 'running')

    running = false
    await sleep(60)

    assert.equal(task.status, 'ended', '后台清空后应当正常收尾')
    assert.equal(task.background, undefined)
    assert.equal(delivered.length, 1)
    assert.match(delivered[0], /后台活已结束/)
  })
})

test('到上限：终止剩余 job 再结算，并在报告里说明', async () => {
  await withDispatch({ backgroundLimitMs: 30 }, async ({ d, host }) => {
    const killed = []
    host.services.jobs = {
      list: () => [{ id: 'j1', owner: 'dispatch-t-bg', status: 'running' }],
      kill: id => killed.push(id),
    }
    const delivered = []
    d.sessions.deliver = async (_s, _r, text) => { delivered.push(text); return { delivered: 'inbox', woke: false } }
    host.agents.set('lead', makeAgent('lead'))
    host.agents.set('dispatch-t-bg', makeAgent('dispatch-t-bg'))
    const task = workerTask()
    d.table.add(task)

    await d.onWorkerIdle('dispatch-t-bg')
    await sleep(80)

    assert.equal(task.status, 'ended', '到上限必须结算，不能永久占着并发位')
    assert.deepEqual(killed, ['j1'])
    assert.equal(task.backgroundKilled, 1)
    assert.match(delivered[0], /上限/)
  })
})

test('没有 jobs / subagents 服务时行为和以前一样：立即结算', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.agents.set('dispatch-t-bg', makeAgent('dispatch-t-bg'))
    const task = workerTask()
    d.table.add(task)

    await d.onWorkerIdle('dispatch-t-bg')

    assert.equal(task.status, 'ended')
    assert.equal(task.background, undefined)
  })
})

test('有 subagent 在跑同样算后台活', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.services.subagents = { listChildren: async () => [{ id: 'child-1' }] }
    host.agents.set('dispatch-t-bg', makeAgent('dispatch-t-bg'))
    const task = workerTask()
    d.table.add(task)

    await d.onWorkerIdle('dispatch-t-bg')

    assert.equal(task.status, 'running')
    assert.equal(task.background.subagents, 1)
  })
})

test('新一轮开始时作废巡检：后台活还在也不能把这一轮结算掉', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.services.jobs = { list: () => [{ id: 'j1', owner: 'dispatch-t-bg', status: 'running' }] }
    host.agents.set('dispatch-t-bg', makeAgent('dispatch-t-bg'))
    const task = workerTask()
    d.table.add(task)

    await d.onWorkerIdle('dispatch-t-bg')
    assert.equal(task.status, 'running')

    // dispatch_message 唤醒 → agent/status running → workerTurnStarted
    d.workerTurnStarted(task)
    await sleep(40)

    assert.equal(task.status, 'running', '巡检必须被作废，否则它会在新一轮中途结算任务')
    assert.equal(task.background, undefined)
  })
})
