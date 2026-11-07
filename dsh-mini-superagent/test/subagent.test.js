/**
 * worker 的 subagent 也受工具面约束（对齐上游 `limitSubagent()` 的边界部分）。
 *
 * 全局注册的 9 个工具对每个 Session 可见，所以 worker 的 subagent 也能调
 * `dispatch_launch`——一个任务可以无限往下派生，而 `maxTasksPerSession` 只按主会话计。
 * 这里把 subagent 的 `dispatch_*` 收走，保留读写与执行（subagent 的职责就是干活）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatch } from '../src/dispatch.js'
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
      async create() {}, async rename() {},
      async resolveAgent(id) { return agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'not-found' } } },
      async prompt() {},
    },
  }
  return { ctx, agents }
}

/** `parent` 是 SessionHeader 里的父会话 id（Agent.session.header.parentSession）。 */
function makeAgent(id, parent) {
  return {
    id, status: 'running',
    session: { header: parent ? { parentSession: parent } : {}, snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
  }
}

async function withDispatch(fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-sa-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
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
    restrictTools: () => () => {}, forgetRestrict: () => {}, holds: () => false,
    async createWorker() { throw new Error('不该走到这里') },
    async enterDirectory() {}, async deliver() { return { delivered: 'inbox', woke: false } },
  }
  try {
    await fn({ d, host, dir })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

test('worker 的 subagent 被收走所有 dispatch_* 工具', async () => {
  await withDispatch(async ({ d, host }) => {
    const calls = []
    d.sessions.restrictTools = (agent, deny) => { calls.push({ id: agent.id, deny: [...deny] }); return () => {} }
    d.table.add({
      id: 't-parent', title: '父任务', brief: 'b', parentSessionId: 'lead',
      workerSessionId: 'dispatch-t-parent', status: 'running', reports: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
    const sub = makeAgent('sub-1', 'dispatch-t-parent')

    d.decorateSubagent(sub)

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].deny, TOOL_NAMES, 'subagent 不该能自己派发或汇报')
    assert.equal(d.subagentOf.get('sub-1'), 'dispatch-t-parent')
  })
})

test('普通会话（父会话不是 worker）不收窄', async () => {
  await withDispatch(async ({ d }) => {
    let count = 0
    d.sessions.restrictTools = () => { count += 1; return () => {} }

    d.decorateSubagent(makeAgent('sub-plain', 'lead'))
    d.decorateSubagent(makeAgent('sub-orphan'))

    assert.equal(count, 0)
  })
})

test('worker 自己不算 subagent', async () => {
  await withDispatch(async ({ d }) => {
    let count = 0
    d.sessions.restrictTools = () => { count += 1; return () => {} }
    d.table.add({
      id: 't-parent', title: '父任务', brief: 'b', parentSessionId: 'lead',
      workerSessionId: 'dispatch-t-parent', status: 'running', reports: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })

    d.decorateSubagent(makeAgent('dispatch-t-parent', 'lead'))

    assert.equal(count, 0, 'worker 需要保留全部工具去干活')
  })
})

test('subagent 的 subagent 沿 parentSession 链也能认出来', async () => {
  await withDispatch(async ({ d, host }) => {
    const calls = []
    d.sessions.restrictTools = (agent) => { calls.push(agent.id); return () => {} }
    d.table.add({
      id: 't-parent', title: '父任务', brief: 'b', parentSessionId: 'lead',
      workerSessionId: 'dispatch-t-parent', status: 'running', reports: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
    // sub-1 的父是 worker，sub-2 的父是 sub-1
    host.agents.set('sub-1', makeAgent('sub-1', 'dispatch-t-parent'))
    const nest = makeAgent('sub-2', 'sub-1')

    d.decorateSubagent(nest)

    assert.deepEqual(calls, ['sub-2'], '嵌套的 subagent 也要收窄，否则它是个后门')
  })
})

test('subagent 销毁时收回收窄', async () => {
  await withDispatch(async ({ d, host }) => {
    const forgotten = []
    d.sessions.restrictTools = () => () => {}
    d.sessions.forgetRestrict = id => forgotten.push(id)
    d.table.add({
      id: 't-parent', title: '父任务', brief: 'b', parentSessionId: 'lead',
      workerSessionId: 'dispatch-t-parent', status: 'running', reports: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
    const sub = makeAgent('sub-1', 'dispatch-t-parent')
    host.agents.set('sub-1', sub)
    d.decorateSubagent(sub)

    d.forgetSubagent('sub-1')

    assert.deepEqual(forgotten, ['sub-1'])
    assert.equal(d.subagentOf.has('sub-1'), false)
  })
})

test('parentSession 链成环时不死循环', async () => {
  await withDispatch(async ({ d, host }) => {
    let count = 0
    d.sessions.restrictTools = () => { count += 1; return () => {} }
    const a = makeAgent('a-1', 'a-2')
    const b = makeAgent('a-2', 'a-1')
    host.agents.set('a-1', a)
    host.agents.set('a-2', b)

    d.decorateSubagent(a)

    assert.equal(count, 0, '链上没有 worker 就不该收窄，且必须终止')
  })
})
