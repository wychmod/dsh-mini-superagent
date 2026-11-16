/**
 * 0.8.2 的三条回归：路由模式、model 透传、报告重试幂等。
 *
 * 三条都来自与上游 `dsh-superagent` 对照时发现的偏差（见 plans/05-superagent-router-worker.md）：
 * 1. 主会话能直接改代码，只有提示词在劝——上游是结构性地收走 write/edit；
 * 2. `dispatch_launch` 的 model 参数存进任务就没了下文，工具 schema 在骗模型；
 * 3. 报告重试每次换新 message id，「已投递但抛错」会变成两条一样的报告。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULTS, SOURCE_KIND } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { SessionGateway } from '../src/sessions.js'

// ---------------------------------------------------------------- 夹具

/** 只实现被调用到的表面：logger / get / on / effect / agents / sessionController。 */
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

function makeAgent(id, extra = {}) {
  return {
    id,
    status: 'running',
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    steer() {},
    followup() {},
    inject() {},
    cancel() {},
    ...extra,
  }
}

async function withDispatch(config, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-router-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    ...config,
  })
  // 工作区与宿主 API 的桩：这三条用例测的是策略，不是宿主。
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
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 路由模式

/** 把某个会话设成「必派发」——路由模式只对这个状态生效。 */
function mustDispatch(d, sessionId) {
  d.targets.set(sessionId, { workspace_id: 'w-proj', title: '项目 A', path: 'D:\\work\\a' })
}

test('默认「不派发」的会话照常派发，工具一个都不收', async () => {
  await withDispatch({}, async ({ d, host }) => {
    let count = 0
    d.sessions.restrictTools = () => { count += 1; return () => {} }
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)

    await d.launch(lead, { title: '改点东西', brief: 'b' })

    assert.equal(count, 0, '「不派发」下主会话必须能自己改文件——任何会话都可能是主会话')
    assert.equal(d.routerLocked(lead), false)
  })
})

test('「必派发」的会话第一次派发时收窄，默认收走 write / edit', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const calls = []
    d.sessions.restrictTools = (agent, deny) => {
      calls.push({ agentId: agent.id, deny: [...deny] })
      return () => {}
    }
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')

    await d.launch(lead, { title: '改点东西', brief: 'b' })

    assert.equal(calls.length, 1, '第一次派发应当收窄一次')
    assert.deepEqual(calls[0].deny, DEFAULTS.routerDenyTools)
    assert.equal(d.routerLocked(lead), true)
  })
})

test('切回「不派发」时立刻解锁，工具还回去', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const forgotten = []
    d.sessions.restrictTools = () => () => {}
    d.sessions.forgetRestrict = id => forgotten.push(id)
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')
    await d.launch(lead, { title: 'a', brief: 'b' })
    assert.equal(d.routerLocked(lead), true)

    await d.setTarget('lead', '')

    assert.equal(d.routerLocked(lead), false, '模式切回不派发，锁必须立刻解开')
    assert.deepEqual(forgotten, ['lead'])
  })
})

test('同一个会话只收窄一次，后续派发不重复登记', async () => {
  await withDispatch({}, async ({ d, host }) => {
    let count = 0
    d.sessions.restrictTools = () => { count += 1; return () => {} }
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')

    await d.launch(lead, { title: 'a', brief: 'b' })
    await d.launch(lead, { title: 'b', brief: 'b' })

    assert.equal(count, 1, 'restrict 多次调用只会多挂 disposer，没有收益')
  })
})

test('worker 自己再派发时不会被收窄（它还要干活）', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const calls = []
    d.sessions.restrictTools = (agent) => { calls.push(agent.id); return () => {} }
    const worker = makeAgent('dispatch-t-parent')
    host.agents.set('dispatch-t-parent', worker)
    // 连 worker 都被设成必派发，验证「执行者身份」这一条独立生效。
    mustDispatch(d, 'dispatch-t-parent')
    d.table.add({
      id: 't-parent', title: '父任务', brief: 'b', parentSessionId: 'lead',
      workerSessionId: 'dispatch-t-parent', status: 'running', reports: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })

    await d.launch(worker, { title: '子任务', brief: 'b' })

    assert.deepEqual(calls, [], 'worker 递归派发不该把 write/edit 从它自己手里拿走')
  })
})

test('restrictRouter=false 时即使必派发也不收窄', async () => {
  await withDispatch({ restrictRouter: false }, async ({ d, host }) => {
    let count = 0
    d.sessions.restrictTools = () => { count += 1; return () => {} }
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')

    await d.launch(lead, { title: 'a', brief: 'b' })

    assert.equal(count, 0)
    assert.equal(d.routerLocked(lead), false)
  })
})

test('宿主不支持 restrict 时不上锁，但派发照常', async () => {
  await withDispatch({}, async ({ d, host }) => {
    d.sessions.restrictTools = () => undefined
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')

    const task = await d.launch(lead, { title: 'a', brief: 'b' })

    assert.equal(d.routerLocked(lead), false, '收窄没成功就不该声称已上锁')
    assert.equal(task.parentSessionId, 'lead')
  })
})

test('SessionGateway.restrictTools 只 deny 宿主机真有的工具（未知名字会让 restrict 抛错）', () => {
  const warns = []
  const gw = new SessionGateway({ get: () => undefined, logger: { warn: (...a) => warns.push(a.join(' ')), info() {} } }, {})

  let captured
  const agent = {
    id: 'a1',
    ctx: {
      tools: {
        get: name => (name === 'write' ? { name } : undefined),
        restrict: filter => { captured = filter; return () => {} },
      },
    },
  }
  const dispose = gw.restrictTools(agent, ['write', 'edit', 'bash'])

  assert.deepEqual(captured, { deny: ['write'] }, '只有真的存在的 write 才会被 deny')
  assert.equal(typeof dispose, 'function')
  assert.equal(warns.length, 0)
})

test('SessionGateway.restrictTools 在 restrict 抛错时返回 undefined 而不是炸掉派发', () => {
  const warns = []
  const gw = new SessionGateway({ get: () => undefined, logger: { warn: (...a) => warns.push(a.join(' ')), info() {} } }, {})
  const agent = {
    id: 'a2',
    ctx: { tools: { get: () => true, restrict: () => { throw new Error('requires a scoped context') } } },
  }

  assert.equal(gw.restrictTools(agent, ['write']), undefined)
  assert.match(warns.join('\n'), /收窄工具失败/)
})

test('一个工具都不存在时明说，不静默当成已上锁', () => {
  const warns = []
  const gw = new SessionGateway({ get: () => undefined, logger: { warn: (...a) => warns.push(a.join(' ')), info() {} } }, {})
  const agent = { id: 'a3', ctx: { tools: { get: () => undefined, restrict: () => () => {} } } }

  assert.equal(gw.restrictTools(agent, ['write', 'edit']), undefined)
  assert.match(warns.join('\n'), /没有可收窄的工具/)
})

// ---------------------------------------------------------------- model 透传

test('launch 的 model 会一路传到 createWorker（不再只是存进任务）', async () => {
  await withDispatch({}, async ({ d, host }) => {
    let options
    d.sessions.createWorker = async (sessionId, cwd, title, received) => {
      options = received
      const agent = makeAgent(sessionId)
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    }

    const task = {
      id: 't-model', title: '用便宜的模型', brief: 'b', parentSessionId: 'lead',
      workerSessionId: 'dispatch-t-model', status: 'running', reports: [],
      model: 'deepseek/cheap-model',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    d.table.add(task)

    await d.start(task)

    assert.equal(options.model, 'deepseek/cheap-model',
      '0.8.1 及更早这里没有 model 字段，工具 schema 承诺的模型实际不生效')
  })
})

test('SessionGateway.applyModel 在宿主没有 llm 时抛错，而不是悄悄用默认模型', async () => {
  const gw = new SessionGateway({ get: () => undefined, logger: { warn() {}, info() {} } }, {})
  const agent = makeAgent('w1', { session: { append() {}, snapshotEvents: () => [] } })

  await assert.rejects(() => gw.applyModel(agent, 'deepseek/cheap-model'), /llm\.resolveCallConfig/)
})

test('SessionGateway.applyModel 解析 provider/model 并记一条 model/selection', async () => {
  const seen = []
  const llm = { async resolveCallConfig(input) { seen.push(input); return { provider: 'deepseek', model: 'cheap-model' } } }
  const gw = new SessionGateway({ get: name => (name === 'llm' ? llm : undefined), logger: { warn() {}, info() {} } }, {})
  const agent = makeAgent('w2', { session: { append: (type, value) => seen.push({ type, value }) } })

  const selection = await gw.applyModel(agent, 'deepseek/cheap-model')

  assert.deepEqual(seen[0], { provider: 'deepseek', model: 'cheap-model' })
  assert.equal(seen[1].type, 'model/selection')
  assert.deepEqual(selection, { provider: 'deepseek', model: 'cheap-model' })
})

// ---------------------------------------------------------------- 报告重试幂等

const workerTask = () => ({
  id: 't-relay', title: '任务', brief: 'b', parentSessionId: 'lead',
  workerSessionId: 'dispatch-t-relay', status: 'running', reports: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
})

test('报告重试复用同一个 requestId（否则「已投递但抛错」会变成两条）', async () => {
  await withDispatch({ relayRetryMs: [1] }, async ({ d, host }) => {
    const ids = []
    let attempt = 0
    d.sessions.deliver = async (_sessionId, requestId) => {
      ids.push(requestId)
      attempt += 1
      if (attempt === 1) throw new Error('收件箱暂时不可用')
      return { delivered: 'inbox', woke: false }
    }
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-relay')
    host.agents.set('dispatch-t-relay', worker)
    const task = workerTask()
    d.table.add(task)

    await d.report(worker, { status: 'done', summary: '干完了' })

    assert.equal(ids.length, 2, '第一次失败后应当重试一次')
    assert.equal(ids[0], ids[1], '重试必须复用同一个 id，否则会重复投递')
    assert.equal(task.delivery.outcome, 'delivered')
  })
})

test('重试前发现消息已在会话里，就不再重投', async () => {
  await withDispatch({ relayRetryMs: [1] }, async ({ d, host }) => {
    let delivered = 0
    d.sessions.deliver = async () => { delivered += 1; throw new Error('发送后抛错') }
    // 模拟「第一次其实已经进了收件箱」。
    d.sessions.holds = () => true
    host.agents.set('lead', makeAgent('lead'))
    const worker = makeAgent('dispatch-t-relay')
    host.agents.set('dispatch-t-relay', worker)
    const task = workerTask()
    d.table.add(task)

    await d.report(worker, { status: 'done', summary: '干完了' })

    assert.equal(delivered, 1, '查重命中就不该再投一次')
    assert.equal(task.delivery.outcome, 'delivered')
  })
})

test('SessionGateway.holds 同时认收件箱与已进入历史的消息', () => {
  const gw = new SessionGateway({ get: () => undefined, logger: { warn() {}, info() {} } }, {})
  const id = `${SOURCE_KIND}:req-1`

  const queued = makeAgent('q', {
    inbox: { nextTurn: [{ id }], nextStep: [] },
    session: { snapshotEvents: () => [] },
  })
  const history = makeAgent('h', {
    inbox: { nextTurn: [], nextStep: [] },
    session: { snapshotEvents: () => [{ type: 'user/message', data: { id } }] },
  })
  const neither = makeAgent('n', { inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => [] } })

  assert.equal(gw.holds(queued, 'req-1'), true, '还在收件箱里也算已投')
  assert.equal(gw.holds(history, 'req-1'), true, '已被某一步取进历史也算已投')
  assert.equal(gw.holds(neither, 'req-1'), false)
  assert.equal(gw.holds(neither, 'req-2'), false)
})
