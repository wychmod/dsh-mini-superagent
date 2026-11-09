/**
 * 看板「归档」逃生门的回归测试。
 *
 * 钉的缺陷是用户在看板上提的那句：「已经中断的任务应该加取消或者归档按钮，
 * 要不然只有重试会一直卡着」。根因在服务端：`dispatch.cancel()` 见到
 * `SETTLED` 直接抛（终态**没有**取消入口），唯一出路 `archiveStale()` 又是
 * 全量巡检、只处理超过 `archiveAfterHours` 的任务。于是 `interrupted` /
 * `failed` / `blocked` / `ended` 这些行只剩「重试」，永远停在
 * 「需要你处理」区。
 *
 * 四条实现决定各有对应用例，缺一条这条逃生门就会以别的方式再坏一遍：
 * 1. `interrupted` 能单独归档 → 归档后离开「需要处理」集合（用户要的效果本身）。
 * 2. 未结算被拒 → 归档是只读冻结，冻一个还在写的会话会丢数据。
 * 3. 幂等 → `archivedAt` 是「第一次被归档的时刻」，重复点击不能刷新它。
 * 4. 决策 B → 子会话没了也放行归档，但必须留 `archiveError`（不许假装干净成功）。
 * 5. 决策 A 的反面 → `cancel()` 对终态**仍然**拒绝（这条不是新行为，是防止
 *    有人为了让按钮能点，顺手把 `cancel()` 的闸拆掉：那会把 `interrupted`
 *    写成 `cancelled`，同时污染取消率与完成率）。
 *
 * 全部离线：假宿主 + 临时状态目录，不联网、不碰真实 `~/.dsh`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBoardHandler } from '../src/board.js'
import { Dispatch } from '../src/dispatch.js'

const BASE = '/dsh-mini-superagent/board'

// ---------------------------------------------------------------- 夹具

const iso = msAgo => new Date(Date.now() - msAgo).toISOString()

/**
 * 假宿主。
 *
 * `archiveSession` 的结果由 `archiveOutcome` 控制：默认成功；决策 B 的用例
 * 把它切成 `{ ok: false, error: '会话已不存在' }`——真实宿主在会话随重启消失时
 * 就是这个形状（见 `src/workspaces.js` 的 `archiveSession`：失败不抛，返回原因）。
 */
function makeHost({ archiveOutcome } = {}) {
  const calls = { archive: [] }
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
      async resolveAgent(id) {
        return agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'not-found' } }
      },
      async state() { throw Object.assign(new Error('not found'), { code: 'not-found' }) },
      async list() { return { items: [] } },
      async prompt() {},
    },
  }
  // `archiveOutcome` 必须挂在 host 上：`stubGateways` 通过 `host.archiveOutcome`
  // 决定子会话归档成功还是失败（决策 B 的用例靠它）。
  return { ctx, agents, calls, archiveOutcome }
}

/** 把两个网关换成桩：不碰真实工作区注册表与 sessionController。 */
function stubGateways(d, host, dir) {
  d.workspaces = {
    list: () => [],
    resolve: async () => undefined,
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined,
    defaultWorkspace: async () => undefined,
    async archiveSession(sessionId) {
      host.calls.archive.push(sessionId)
      if (host.archiveOutcome) return host.archiveOutcome
      return { ok: true }
    },
    get root() { return dir },
  }
  d.sessions = {
    cwdFor: () => dir,
    hint: () => {},
    dispose: () => {},
    restrictTools: () => () => {},
    forgetRestrict: () => {},
    holds: () => false,
    async createWorker(sessionId) { return { agent: {}, sessionId } },
    async enterDirectory() {},
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
}

async function withDispatch(config, fn) {
  const host = makeHost(config.archiveOutcome ? { archiveOutcome: config.archiveOutcome } : {})
  const dir = await mkdtemp(join(tmpdir(), 'mas-arch-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    ...(config.dispatch || {}),
  })
  stubGateways(d, host, dir)
  try {
    await fn({ d, host, dir })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/** 造一条任务记录并塞进活表。`updatedAt` 给「刚刚」，证明归档不看保留期。 */
function mkTask(d, id, status, extra = {}) {
  const task = {
    id,
    title: id,
    brief: 'b',
    parentSessionId: 'lead',
    workerSessionId: `dispatch-${id}`,
    status,
    reports: [],
    createdAt: iso(2_000),
    updatedAt: iso(1_000),
    ...extra,
  }
  d.table.add(task)
  return task
}

// ---------------------------------------------------------------- 1. 能归档

test('interrupted 任务能单独归档，且归档后离开「需要处理」集合', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const task = mkTask(d, 't-int', 'interrupted')

    /*
     * 「需要处理」的判据必须与客户端 `ATTENTION_STATUS` 一致
     *（`client/index.js` 的 `ATTENTION_STATUS = new Set(['failed','blocked','interrupted'])`）
     * 并且`filter.attention` 的 `match` 还有一条 `!task.archived_at`。
     * 两处都是真的，这里把两条规则显式写出来：归档**不改变 status**
     *（用户明确否决了「把 interrupted 改成 cancelled」），它只让这一行
     * 从「需要处理」里消失。
     */
    const ATTENTION_STATUS = new Set(['failed', 'blocked', 'interrupted'])
    const attentionOf = item => !item.archivedAt && ATTENTION_STATUS.has(item.status)

    assert.equal(attentionOf(task), true, '前置：归档前它确实在需要处理区')

    const result = await d.archiveTask('t-int')

    assert.equal(result.ok, true)
    assert.equal(result.archived, true, '第一次调用应该是「真的写了归档」')
    assert.equal(result.reason, undefined, '子会话归档成功时不该带 reason')
    assert.ok(task.archivedAt, '必须写 archivedAt')
    assert.ok(task.frozenAt, '归档一定同时写冻结时刻（与 archiveStale 同一不变量）')
    assert.equal(task.frozenAt, task.archivedAt, '当前实现两个时刻同值，但字段各存一份')
    assert.equal(task.status, 'interrupted', '归档不改状态：改成 cancelled 会污染两项指标')
    assert.equal(task.archiveError, undefined, '干净归档不该留 archiveError')
    assert.equal(attentionOf(task), false, '归档后它必须离开「需要处理」区（用户要的效果）')
    assert.deepEqual(host.calls.archive, ['dispatch-t-int'], '要真的去归档那个子会话')
  })
})

test('决策 A：全部终态都能归档（done / cancelled 没有主操作也能收走）', async () => {
  await withDispatch({}, async ({ d }) => {
    for (const status of ['done', 'cancelled', 'failed', 'blocked', 'ended', 'interrupted']) {
      const task = mkTask(d, `t-${status}`, status)
      const result = await d.archiveTask(`t-${status}`)
      assert.equal(result.archived, true, `${status} 应该能归档`)
      assert.ok(task.archivedAt, `${status} 归档后要有 archivedAt`)
    }
  })
})

test('归档不看保留期：刚更新的任务也能手动归档（区别于 archiveStale 的 24h 门槛）', async () => {
  await withDispatch({ dispatch: { archiveAfterHours: 24 } }, async ({ d }) => {
    // updatedAt 是 1 秒前，远没到 24 小时保留期。
    const task = mkTask(d, 't-fresh', 'interrupted')
    const stale = await d.archiveStale()
    assert.equal(stale.archived, 0, '前置：巡检不会碰它——正是「只有重试会一直卡着」的根因')

    const result = await d.archiveTask('t-fresh')
    assert.equal(result.archived, true, '手动归档不该受保留期约束')
    assert.ok(task.archivedAt)
  })
})

// ---------------------------------------------------------------- 2. 未结算被拒

test('未结算任务被拒绝归档（running / queued）', async () => {
  await withDispatch({}, async ({ d, host }) => {
    for (const status of ['running', 'queued']) {
      const task = mkTask(d, `t-${status}`, status)
      await assert.rejects(
        () => d.archiveTask(`t-${status}`),
        /还没结算/,
        `${status} 不该被归档：归档会把还在写的会话冻成只读`,
      )
      assert.equal(task.archivedAt, undefined, `${status} 被拒后不能留下半个归档标记`)
      assert.equal(task.frozenAt, undefined, `${status} 被拒后不能留下冻结标记`)
    }
    assert.equal(host.calls.archive.length, 0, '拒绝必须发生在碰子会话之前')
  })
})

test('任务不存在时抛人类可读错误', async () => {
  await withDispatch({}, async ({ d }) => {
    await assert.rejects(() => d.archiveTask('t-none'), /没有任务 t-none/)
    await assert.rejects(() => d.archiveTask(''), /需要 task_id/)
  })
})

// ---------------------------------------------------------------- 3. 幂等

test('幂等：连调两次，archivedAt 不被重写、子会话只归档一次', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const task = mkTask(d, 't-idem', 'failed')
    const first = await d.archiveTask('t-idem')
    const firstAt = task.archivedAt
    const firstFrozen = task.frozenAt
    assert.equal(first.archived, true)

    // 让时间真的往前走一点，否则「没变」可能是因为时钟精度不够。
    await new Promise(resolve => setTimeout(resolve, 5))

    const second = await d.archiveTask('t-idem')
    assert.equal(second.ok, true, '重复归档不报错')
    assert.equal(second.archived, false, '第二次没有真的写归档，返回值要能区分')
    assert.equal(task.archivedAt, firstAt, 'archivedAt 是「第一次被归档的时刻」，不能被刷新')
    assert.equal(task.frozenAt, firstFrozen, '冻结时刻同理')
    assert.equal(host.calls.archive.length, 1, '已归档的任务不该再去归档子会话')
  })
})

// ---------------------------------------------------------------- 4. 决策 B

test('决策 B：子会话归档失败仍然写 archivedAt/frozenAt，但把原因留在 archiveError', async () => {
  await withDispatch({ archiveOutcome: { ok: false, error: '会话已不存在' } }, async ({ d }) => {
    const task = mkTask(d, 't-gone', 'interrupted')

    const result = await d.archiveTask('t-gone')

    assert.equal(result.ok, true, '会话没了不等于用户不能把它收走')
    assert.equal(result.archived, true, '归档标记必须写：否则这类任务永远卡在待办区')
    assert.equal(result.reason, '会话已不存在', '返回值要能区分「干净归档」与「归档但留了原因」')
    assert.ok(task.archivedAt, 'archivedAt 必须有值')
    assert.ok(task.frozenAt, '冻结标记同样要写（看板靠它显示只读语义）')
    assert.equal(task.archiveError, '会话已不存在', '不许假装干净成功：原因必须落在任务上')
  })
})

// ---------------------------------------------------------------- 5. 决策 A 的反面

test('cancel() 对终态仍然拒绝（不许为了加按钮把这道闸拆掉）', async () => {
  await withDispatch({}, async ({ d }) => {
    for (const status of ['interrupted', 'failed', 'blocked', 'ended', 'done', 'cancelled']) {
      const task = mkTask(d, `t-c-${status}`, status)
      await assert.rejects(
        () => d.cancel(task, '看板取消'),
        /不能取消/,
        `${status} 已结算，取消必须仍然被拒`,
      )
      assert.equal(task.status, status, '被拒的取消不能顺手改状态')
    }
  })
})

// ---------------------------------------------------------------- 6. 新路由

/** 假的 IncomingMessage：够 readJson 用（on/data/end/error），并带准入头。 */
function fakeReq({ method = 'POST', url, headers = {}, body } = {}) {
  const finalHeaders = { host: '127.0.0.1:11586', 'x-dsh-mini-superagent': '1', ...headers }
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: finalHeaders,
    on(event, callback) {
      listeners.set(event, [...(listeners.get(event) ?? []), callback])
      return req
    },
    destroy() {},
    emit(event, argument) { for (const callback of listeners.get(event) ?? []) callback(argument) },
  }
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  }, 0)
  return req
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(payload) { this.body = payload ?? '' },
  }
}

async function call(handler, options) {
  const res = fakeRes()
  await handler(fakeReq(options), res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : undefined }
}

/**
 * 路由用例用一个**真 Dispatch**（只把网关换成桩）：错误码来自真实实现，
 * 不是给路由单独写一套假 `archiveTask`——那样只能测出「路由调了那个假方法」。
 */
async function withBoard(fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-arch-http-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  stubGateways(d, host, dir)
  // `archiveStale` 计数：用例要证明新路由**没有**顺手触发一次巡检。
  let sweepCalls = 0
  const realArchiveStale = d.archiveStale.bind(d)
  d.archiveStale = async function () {
    sweepCalls += 1
    return realArchiveStale()
  }
  const handler = createBoardHandler({ logger: { warn() {}, info() {} } }, d)
  try {
    await fn({ d, handler, sweep: () => sweepCalls })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

test('POST /archive-task：缺 task_id → 400', async () => {
  await withBoard(async ({ handler }) => {
    const result = await call(handler, { url: `${BASE}/archive-task`, body: {} })
    assert.equal(result.status, 400)
    assert.match(result.json.error, /task_id/)
  })
})

test('POST /archive-task：任务不存在 → 404', async () => {
  await withBoard(async ({ handler }) => {
    const result = await call(handler, { url: `${BASE}/archive-task`, body: { task_id: 't-none' } })
    assert.equal(result.status, 404)
    assert.match(result.json.error, /没有任务/)
  })
})

test('POST /archive-task：未结算 → 409', async () => {
  await withBoard(async ({ d, handler }) => {
    mkTask(d, 't-run', 'running')
    const result = await call(handler, { url: `${BASE}/archive-task`, body: { task_id: 't-run' } })
    assert.equal(result.status, 409)
    assert.match(result.json.error, /不能归档/)
  })
})

test('POST /archive-task：成功回 200 + 归档后的任务投影，且不触发巡检', async () => {
  await withBoard(async ({ d, handler, sweep }) => {
    mkTask(d, 't-ok', 'interrupted')
    const result = await call(handler, { url: `${BASE}/archive-task`, body: { task_id: 't-ok' } })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.archived, true)
    assert.equal(result.json.reason, undefined, '干净归档不该回 reason')
    assert.ok(result.json.task.archived_at, '回体要带 `boardTask` 投影的 archived_at')
    assert.ok(result.json.task.frozen_at, '冻结时刻同样是投影的一部分')
    assert.equal(result.json.task.status, 'interrupted', '归档不改状态')
    assert.equal(sweep(), 0, '/archive-task 绝不能顺手跑一次全量巡检')
  })
})

test('POST /archive-task：决策 B 的失败原因经路由回成 reason（HTTP 仍 200）', async () => {
  const host = makeHost({ archiveOutcome: { ok: false, error: '会话已不存在' } })
  const dir = await mkdtemp(join(tmpdir(), 'mas-arch-http2-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  stubGateways(d, host, dir)
  try {
    mkTask(d, 't-kept', 'interrupted')
    const handler = createBoardHandler({ logger: { warn() {}, info() {} } }, d)
    const result = await call(handler, { url: `${BASE}/archive-task`, body: { task_id: 't-kept' } })
    assert.equal(result.status, 200, '归档动作本身成功了，不该用 4xx/5xx 表示「会话没了」')
    assert.equal(result.json.archived, true)
    assert.equal(result.json.reason, '会话已不存在')
    assert.equal(result.json.task.archive_error, '会话已不存在', '原因要出现在快照投影里')
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /archive-task：没有准入头 → 403（与其它写操作同一档）', async () => {
  await withBoard(async ({ d, handler }) => {
    mkTask(d, 't-403', 'failed')
    const result = await call(handler, {
      url: `${BASE}/archive-task`,
      headers: { 'x-dsh-mini-superagent': '' },
      body: { task_id: 't-403' },
    })
    assert.equal(result.status, 403)
  })
})

test('POST /archive 的巡检语义没有被动过（新路由是加出来的，不是改出来的）', async () => {
  await withBoard(async ({ d, handler, sweep }) => {
    mkTask(d, 't-sweep', 'done')
    const result = await call(handler, { url: `${BASE}/archive`, body: {} })
    assert.equal(result.status, 200)
    assert.equal(sweep(), 1, '老的 /archive 仍然触发一次巡检')
    assert.equal(typeof result.json.scanned, 'number', '返回形状仍是巡检口径')
    assert.ok(result.json.counts, '仍然带最新计数')
  })
})
