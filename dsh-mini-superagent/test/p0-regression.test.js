/**
 * P0 回归测试：守住 0.7.0 修的六个正确性/安全问题。
 *
 * 这些用例对应评审里编号的 P0-1 … P0-6。每个都曾经是**真实可复现的 bug**，
 * 不是假想的边界情况，所以用测试钉住：
 *
 * - P0-1 看板准入可被 DNS rebinding 绕过（读快照、归档、改派发目标）
 * - P0-2 `settle` 无幂等，`done` 能被改成 `cancelled` / 被复活成 `running`
 * - P0-3 `message` 先改状态后投递，失败不回滚，永久占用并发位
 * - P0-4 `cancel` 与 `start` 竞态，任务已取消但会话仍被创建（僵尸 worker）
 * - P0-5 落盘非原子，写坏后全部历史丢失
 * - P0-6 「自动选择」目标重启后丢失，静默退回「不派发」
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBoardHandler } from '../src/board.js'
import { MODE_ALWAYS, MODE_OFF } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { readState, writeState } from '../src/store.js'
import { TaskTable, canTransition } from '../src/tasks.js'

const BASE = '/dsh-mini-superagent/board'

// ---------------------------------------------------------------- 夹具

/** 最小假宿主：只实现 Dispatch 会碰到的成员。 */
function makeHost({ deliverThrows = false, createDelayMs = 0 } = {}) {
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
  return { ctx, agents, deliverThrows, createDelayMs }
}

/** 把 Dispatch 的工作区/会话网关换成桩，避免碰真实宿主。 */
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
    async createWorker(sessionId) {
      if (host.createDelayMs) await new Promise(resolve => setTimeout(resolve, host.createDelayMs))
      const agent = {
        id: sessionId,
        status: 'idle',
        cancelled: false,
        session: { snapshotEvents: () => [] },
        ctx: { systemPrompt: { section: () => () => {} } },
        cancel() { agent.cancelled = true },
        steer() {},
        followup() {},
      }
      host.agents.set(sessionId, agent)
      // 0.7.0 起 createWorker 返回 { agent, sessionId }：`create` 可能换号，
      // 调用方要以返回值里的 id 为准。
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver() {
      if (host.deliverThrows) throw new Error('deliver boom')
      return 'inbox'
    },
  }
  return d
}

async function withDispatch(fn, opts = {}) {
  const host = makeHost(opts)
  const dir = await mkdtemp(join(tmpdir(), 'mas-p0-'))
  const d = stub(new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  }), host, dir)
  try {
    await fn({ d, host, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const mkTask = (id, status, extra = {}) => ({
  id,
  title: id,
  brief: 'b',
  parentSessionId: 'lead',
  workerSessionId: `dispatch-${id}`,
  status,
  reports: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...extra,
})

/** 直接打 handler：假 req/res，够 readJson 用。 */
function call(handler, { method = 'GET', url = BASE, headers = {}, body } = {}) {
  return new Promise(resolve => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:11586', ...headers },
      on(event, callback) {
        if (event === 'data') for (const chunk of chunks) callback(chunk)
        if (event === 'end') setImmediate(callback)
        return req
      },
      destroy() {},
    }
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status; return this },
      end(payload) { this.body = payload ?? ''; resolve({ status: this.status, json: safeJson(this.body) }) },
    }
    void handler(req, res)
  })
}

const safeJson = (text) => { try { return JSON.parse(text) } catch { return undefined } }

function fakeBoard() {
  return {
    table: new TaskTable(6),
    targets: new Map(),
    workspaces: { list: () => [] },
    config: { leadSessionId: 'mas-lead' },
    ctx: { agents: { get: () => undefined } },
    async archiveStale() { return { scanned: 0, archived: 0, failed: 0 } },
  }
}

// ---------------------------------------------------------------- P0-1 看板准入

test('P0-1 DNS rebinding：Host 与 Origin 都是攻击者域名时被拒绝', async () => {
  const handler = createBoardHandler({ logger: { warn() {} } }, fakeBoard())
  const result = await call(handler, {
    headers: { host: 'evil.example:9735', origin: 'http://evil.example:9735' },
  })
  assert.equal(result.status, 403, 'rebinding 请求绝不能读到任务快照')
})

test('P0-1 非回环 Host 不带 Origin 的 POST 被拒绝', async () => {
  const handler = createBoardHandler({ logger: { warn() {} } }, fakeBoard())
  const result = await call(handler, {
    method: 'POST',
    url: `${BASE}/archive`,
    headers: { host: '192.168.1.50:9735' },
    body: {},
  })
  assert.equal(result.status, 403, '局域网脚本不能凭空归档')
})

test('P0-1 回环 Host 但 Origin 是恶意站点时被拒绝', async () => {
  const handler = createBoardHandler({ logger: { warn() {} } }, fakeBoard())
  const result = await call(handler, {
    headers: { host: '127.0.0.1:11586', origin: 'https://evil.example' },
  })
  assert.equal(result.status, 403, '回环放行不能变成「任何页面都能读」')
})

test('P0-1 写操作必须带准入头', async () => {
  const handler = createBoardHandler({ logger: { warn() {} } }, fakeBoard())
  const without = await call(handler, {
    method: 'POST',
    url: `${BASE}/archive`,
    headers: { host: '127.0.0.1:11586' },
    body: {},
  })
  assert.equal(without.status, 403)

  const withHeader = await call(handler, {
    method: 'POST',
    url: `${BASE}/archive`,
    headers: { host: '127.0.0.1:11586', 'x-dsh-mini-superagent': '1' },
    body: {},
  })
  assert.equal(withHeader.status, 200, '合法本机调用不能被误伤')
})

test('P0-1 本机正常读看板仍然可用', async () => {
  const handler = createBoardHandler({ logger: { warn() {} } }, fakeBoard())
  const result = await call(handler, { headers: { host: '127.0.0.1:11586' } })
  assert.equal(result.status, 200)
})

// ---------------------------------------------------------------- P0-2 状态机

test('P0-2 settle 是幂等的：已结算任务不会被二次覆盖', () => {
  const table = new TaskTable(2)
  const task = mkTask('a', 'done')
  table.add(task)
  const changed = table.settle(task, 'cancelled')
  assert.equal(changed, false)
  assert.equal(task.status, 'done', 'done 任务不能因为再 settle 一次就变成 cancelled')
})

test('P0-2 终态不能被普通跃迁复活', () => {
  const table = new TaskTable(2)
  const task = mkTask('a', 'done')
  table.add(task)
  const changed = table.transition(task, 'running')
  assert.equal(changed, false)
  assert.equal(task.status, 'done', 'done 不能回到 running（否则并发位被幽灵占用）')
})

test('P0-2 跃迁表只允许合法边', () => {
  assert.equal(canTransition('queued', 'running'), true)
  assert.equal(canTransition('running', 'done'), true)
  assert.equal(canTransition('done', 'running'), false)
  assert.equal(canTransition('cancelled', 'queued'), false, '回到 queued 只能走 reopen')
  assert.equal(canTransition('running', 'running'), false, '同状态不算跃迁')
})

test('P0-2 cancel 拒绝已结算任务', async () => {
  await withDispatch(async ({ d }) => {
    const task = mkTask('a', 'done')
    d.table.add(task)
    await assert.rejects(() => d.cancel(task, 'test'), /已结算/)
    assert.equal(task.status, 'done')
  })
})

// ---------------------------------------------------------------- P0-3 message

test('P0-3 message 投递失败时不改状态', async () => {
  await withDispatch(async ({ d, host }) => {
    const task = mkTask('c', 'done')
    d.table.add(task)
    host.agents.set('dispatch-c', {
      id: 'dispatch-c', status: 'idle',
      session: { snapshotEvents: () => [] },
      ctx: { systemPrompt: { section: () => () => {} } },
      cancel() {}, steer() {}, followup() {},
    })
    await assert.rejects(() => d.message(task, 'x', 'queue'), /deliver boom/)
    assert.equal(task.status, 'done', '投递失败不该把任务打回 running 白占并发位')
  }, { deliverThrows: true })
})

test('P0-3 message 对 queued 任务不会造成「队列还在但状态已 running」', async () => {
  await withDispatch(async ({ d, host }) => {
    const task = mkTask('q', 'queued')
    d.table.add(task)
    host.agents.set('dispatch-q', {
      id: 'dispatch-q', status: 'idle',
      session: { snapshotEvents: () => [] },
      ctx: { systemPrompt: { section: () => () => {} } },
      cancel() {}, steer() {}, followup() {},
    })
    await d.message(task, 'x', 'queue')
    assert.equal(d.table.queue.includes('q'), false, '投递成功后必须从队列摘除，否则队列顺序错乱')
  })
})

// ---------------------------------------------------------------- P0-4 start/cancel 竞态

test('P0-4 cancel 落在 start 的 await 窗口时，会话被清理而不是变成僵尸', async () => {
  await withDispatch(async ({ d, host }) => {
    const task = mkTask('z', 'queued')
    d.table.add(task)

    const pumping = d.pump()
    await new Promise(resolve => setTimeout(resolve, 15))     // 卡在 createWorker 里
    await d.cancel(task, '测试取消').catch(() => {})
    await pumping

    assert.equal(task.status, 'cancelled')
    const agent = host.agents.get('dispatch-z')
    assert.ok(!agent || agent.cancelled === true, '已建出来的 worker 必须被取消，不能无人回收')
  }, { createDelayMs: 40 })
})

// ---------------------------------------------------------------- P0-5 落盘

test('P0-5 主文件损坏时自动从备份恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-store-'))
  const file = join(dir, 'tasks.json')
  try {
    await writeState(file, { tasks: [{ id: 'first' }], targets: {} }, 'now')
    await writeState(file, { tasks: [{ id: 'second' }], targets: {} }, 'now2')   // 生成 .bak
    const good = await readFile(file, 'utf8')
    await writeFile(file, good.slice(0, 12), 'utf8')                            // 截断主文件

    const state = await readState(file)
    assert.equal(state.recovered, 'bak', '应当标明走了备份恢复')
    assert.ok(state.tasks.length > 0, '不能因为主文件坏了就丢掉全部历史')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('P0-5 写入是原子的：写到一半不会留下半截主文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-store-'))
  const file = join(dir, 'tasks.json')
  try {
    await writeState(file, { tasks: [{ id: 'a' }], targets: {} }, 'now')
    // 用大量内容触发多次写入，再确认主文件始终可解析
    for (let i = 0; i < 5; i += 1) {
      await writeState(file, { tasks: [{ id: `t${i}`, pad: 'x'.repeat(60000) }], targets: {} }, `now${i}`)
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      assert.ok(Array.isArray(parsed.tasks))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- P0-6 auto 目标

test('P0-6 「自动选择」目标重启后仍然生效', async () => {
  await withDispatch(async ({ d, dir, host }) => {
    await d.setTarget('session-x', 'auto')
    assert.equal(d.modeOf('session-x'), MODE_ALWAYS)
    await d.persist()

    const again = stub(new Dispatch(host.ctx, {
      stateDir: dir,
      provisionDefaultWorkspace: false,
      archiveSweepMinutes: 0,
      archiveAfterHours: 0,
    }), host, dir)
    await again.restore()

    assert.equal(again.modeOf('session-x'), MODE_ALWAYS,
      'auto 目标丢失会让会话静默退回「不派发」，行为反转且无提示')
  })
})

test('P0-6 清除目标后重启仍然是不派发', async () => {
  await withDispatch(async ({ d, dir, host }) => {
    await d.setTarget('session-y', 'auto')
    await d.setTarget('session-y', '')
    await d.persist()

    const again = stub(new Dispatch(host.ctx, {
      stateDir: dir,
      provisionDefaultWorkspace: false,
      archiveSweepMinutes: 0,
      archiveAfterHours: 0,
    }), host, dir)
    await again.restore()

    assert.equal(again.modeOf('session-y'), MODE_OFF)
  })
})
