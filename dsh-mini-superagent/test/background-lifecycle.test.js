/**
 * 后台活生命周期的 P0 回归（评估 §5.1 O01/O02/O03 的修复验证）。
 *
 * 三条缺陷都出在「显式报告/取消/重启」绕过了 `onWorkerIdle()` 那条唯一的
 * 后台活门禁：
 *   1. `dispatch_report(status:'done')` 直接 settle，后台 job 变孤儿；
 *   2. `cancel()` 只 cancel agent，不终止后台活；
 *   3. `restore()` 不重挂巡检，重启后带 background 的任务永远没人收尾。
 * 外加一行 `jobs.list()` 漏 await，以及 800ms 防抖窗口里的 stale running。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ERROR_CODES } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { registerTools } from '../src/tools.js'

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
    id,
    status,
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    steer() {}, followup() {}, inject() {}, cancel() {},
  }
}

const workerTask = extra => ({
  id: 't-life', title: '起个服务', brief: 'b', parentSessionId: 'lead',
  workerSessionId: 'dispatch-t-life', status: 'running', reports: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...extra,
})

async function withDispatch(config, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-life-'))
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

/** 轮询等条件，不用固定 sleep：写盘耗时在慢盘上会波动。 */
async function waitFor(predicate, label, timeout = 1500) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`等待超时：${label}`)
}

test('终态报告遇到后台活：报告照常入库回流，但结算被推迟', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.services.jobs = { list: async () => [{ id: 'j1', owner: 'dispatch-t-life', status: 'running' }] }
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-life')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    const result = await d.report(worker, { status: 'done', summary: '做完了' })

    assert.equal(task.status, 'running', '后台还在跑，不能释放并发位')
    assert.equal(task.pendingTerminal, 'done', '记住 worker 自己给的结论')
    assert.equal(task.reports.length, 1, '报告必须照常入库')
    assert.equal(result.deferred, true, '要告诉模型为什么状态还是 running')
  })
})

test('后台清空后按 pendingTerminal 结算，不退化成 done 也不发兜底回报', async () => {
  await withDispatch({}, async ({ d, host }) => {
    let running = true
    host.services.jobs = {
      list: async () => (running ? [{ id: 'j1', owner: 'dispatch-t-life', status: 'running' }] : []),
    }
    const delivered = []
    d.sessions.deliver = async (_s, _r, text) => { delivered.push(text); return { delivered: 'inbox', woke: false } }
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-life')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    await d.report(worker, { status: 'blocked', summary: '被人挡住了' })
    const afterReport = delivered.length
    running = false
    await waitFor(() => task.status !== 'running', '巡检收尾')

    assert.equal(task.status, 'blocked', '必须沿用 worker 报的终态')
    assert.equal(task.pendingTerminal, undefined)
    assert.equal(task.background, undefined)
    assert.equal(delivered.length, afterReport, 'worker 已经报过结论，不该再发「没给结论」的兜底')
  })
})

test('取消会终止后台 job，并说明 subagent 无法由插件终止', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const killed = []
    host.services.jobs = {
      list: async () => [{ id: 'j1', owner: 'dispatch-t-life', status: 'running' }],
      kill: async id => { killed.push(id) },
    }
    const task = workerTask({
      background: { jobs: 1, subagents: 2, since: new Date().toISOString() },
    })
    d.table.add(task)

    await d.cancel(task, '用户取消')

    assert.deepEqual(killed, ['j1'], 'cancel 必须真的杀掉后台 job')
    assert.equal(task.status, 'cancelled')
    assert.equal(task.background, undefined)
    assert.equal(task.pendingTerminal, undefined)
    assert.match(task.backgroundNote, /subagent/, '不能假装把 subagent 也停干净了')
  })
})

test('killBackground 等异步 jobs.list：真能杀到 job', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const killed = []
    host.services.jobs = {
      list: async () => [{ id: 'j1', owner: 'dispatch-t-life', status: 'running' }],
      kill: async id => { killed.push(id) },
    }
    const task = workerTask()
    d.table.add(task)

    const count = await d.killBackground(task)

    assert.equal(count, 1, '漏 await 时这里恒为 0')
    assert.deepEqual(killed, ['j1'])
  })
})

test('重启恢复：带 background 的任务重挂巡检，不会被当成 interrupted', async () => {
  await withDispatch({}, async ({ d, host, dir }) => {
    host.services.jobs = { list: async () => [{ id: 'j1', owner: 'dispatch-t-life', status: 'running' }] }
    await writeFile(join(dir, 'tasks.json'), JSON.stringify({
      version: 4,
      savedAt: new Date().toISOString(),
      tasks: [workerTask({
        background: { jobs: 1, subagents: 0, since: new Date().toISOString() },
      })],
      targets: {},
      retired: [],
    }))

    await d.restore()

    assert.equal(d.table.tasks.get('t-life').status, 'running')
    assert.deepEqual(d.pendingBackgroundWatchers, ['t-life'])
    d.resumeBackgroundWatches()
    assert.equal(d.backgroundTimers.has('t-life'), true, '巡检必须真的被重挂')
  })
})

test('重启恢复：账本里有终态报告的 stale running 按结论收敛', async () => {
  await withDispatch({}, async ({ d, dir }) => {
    await writeFile(join(dir, 'tasks.json'), JSON.stringify({
      version: 4,
      savedAt: new Date().toISOString(),
      tasks: [workerTask({
        reports: [{ at: new Date().toISOString(), status: 'done', summary: '做完了' }],
      })],
      targets: {},
      retired: [],
    }))

    await d.restore()

    assert.equal(d.table.tasks.get('t-life').status, 'done', '不能被一律标成 interrupted')
  })
})

test('工具错误带闭集 code，且不改中文 message', async () => {
  const registered = []
  registerTools(
    { tools: { register: definition => { registered.push(definition); return () => {} } } },
    { resolveTask: () => undefined, table: { get: () => undefined } },
  )
  const inspect = registered.find(definition => definition.name === 'dispatch_inspect')
  assert.ok(inspect)

  await assert.rejects(
    () => inspect.execute({ task_id: 't-x' }, {}),
    error => {
      assert.equal(error.code, ERROR_CODES.FORBIDDEN)
      assert.match(error.message, /只能在某个会话/)
      return true
    },
  )
  await assert.rejects(
    () => inspect.execute({ task_id: 't-x' }, { agent: { id: 'lead' } }),
    error => {
      assert.equal(error.code, ERROR_CODES.NOT_FOUND)
      assert.match(error.message, /没有任务/)
      return true
    },
  )
})
