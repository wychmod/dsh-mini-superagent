/**
 * plans/08 阶段 2（模型 B）：**新任务复用已有子会话**。
 *
 * 与 `continue-launch.test.js`（阶段 1 · 模型 A）的分工：
 * - 模型 A：`continue_task_id` = 同一个任务追加要求，**不新建任务**；
 * - 模型 B：`handoff_from` = **新建任务**，但 `workerSessionId` / `threadId` 指向
 *   来源任务，`parentTaskId` 记下来源。它必须有独立的记录、报告链与看板行。
 *
 * 这个文件钉的是「复用上线后最容易串的六件事」：
 * 1. 新任务真的新建了，会话/线程真的复用了；
 * 2. 四条硬校验（存在且已结算、未退休未归档、归属、形状）与工作区/模型一致性；
 * 3. **串账**：同会话 A(done) + B(running) 时报告必须记到 B；
 * 4. **互斥**：同会话第二个任务保持 queued 且不被丢出队列；
 * 5. **取消 / 归档闸门**：不能因为一条任务打断或冻住同会话的另一条；
 * 6. **回滚**：`allowSessionReuse:false` 时降级为普通新派，且返回值说明原因。
 *
 * 另有 `handoffPrompt()` 的文本契约：四段、长度受控、只来自账本事实。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { boardSnapshot } from '../src/board.js'
import { HANDOFF_MAX_CHARS, HANDOFF_REASON_MAX_CHARS, WORKER_PREFIX, newThreadId } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { handoffPrompt } from '../src/prompt.js'
import { writeState } from '../src/store.js'
import { TaskTable } from '../src/tasks.js'
import { toolDefinitions } from '../src/tools.js'

// ---------------------------------------------------------------- 夹具

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()

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
      async state() { return { sessionId: 'x' } },
      async list() { return { items: [] } },
    },
  }
  return { ctx, agents }
}

function makeWorker(id, status = 'idle') {
  return {
    id, status,
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    cancelled: 0,
    cancel() { this.cancelled += 1 },
    steer() {}, followup() {}, inject() {},
  }
}

const WORKSPACES = [
  { id: 'ws-a', title: '项目 A', path: 'D:\\proj\\a' },
  { id: 'ws-b', title: '项目 B', path: 'D:\\proj\\b' },
]

/**
 * 一个能驱动 `Dispatch` 与 `dispatch_launch` 的离线夹具。
 *
 * `createdSessions` 记录每一次 `createWorker`——复用用例靠它证明「真的没建会话」；
 * `deliveries` 记录每一次投递——首条消息到底进了哪条会话只能从这里看。
 */
async function withDispatch(fn, options = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-reuse-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    noticeMergeWindowMs: 0,
    ...(options.config ?? {}),
  })
  const archives = []
  d.workspaces = {
    list: () => WORKSPACES,
    resolve: async ref => WORKSPACES.find(item => item.id === ref || item.title === ref || item.path === ref),
    resolveOrCreate: async ref => {
      const found = WORKSPACES.find(item => item.id === ref || item.title === ref || item.path === ref)
      return { workspace: found, created: false }
    },
    dayWorkspace: async () => undefined,
    defaultWorkspace: async () => undefined,
    archiveSession: async sessionId => { archives.push(sessionId); return { ok: true } },
    get root() { return dir },
  }
  const deliveries = []
  const createdSessions = []
  d.sessions = {
    cwdFor: () => dir,
    hint: () => {},
    dispose: () => {},
    restrictTools: () => () => {},
    forgetRestrict: () => {},
    holds: () => false,
    async createWorker(sessionId) {
      createdSessions.push(sessionId)
      if (options.createWorker) return options.createWorker(sessionId)
      const agent = makeWorker(sessionId, 'running')
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver(sessionId, requestId, text) {
      deliveries.push({ sessionId, requestId, text })
      return { delivered: 'inbox', woke: false }
    },
  }
  const tools = Object.fromEntries(toolDefinitions(d).map(item => [item.name, item]))
  try {
    await fn({ d, host, dir, archives, deliveries, createdSessions, tools, launch: tools.dispatch_launch })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/** 造一条任务；默认是「已经跑完、等着被复用」的来源任务。 */
const mkTask = (id, workerSessionId, status = 'done', extra = {}) => ({
  id,
  title: `任务 ${id}`,
  brief: '原始简报',
  parentSessionId: 'lead',
  workerSessionId,
  threadId: newThreadId(id),
  status,
  attempt: 1,
  reports: [],
  cwd: 'D:\\proj\\a',
  workspaceId: 'ws-a',
  workspaceTitle: '项目 A',
  createdAt: iso(60_000),
  updatedAt: iso(60_000),
  ...extra,
})

/**
 * 主线夹具：主会话 lead、一条来源任务、它的 worker 会话都已登记。
 * `options.createWorker` 可换成「抛错」以证明复用分支从不建会话。
 */
async function withSource(fn, options = {}) {
  return withDispatch(async ctx => {
    const lead = makeWorker('lead')
    ctx.host.agents.set('lead', lead)
    const source = mkTask('t-source', `${WORKER_PREFIX}t-source`, options.status ?? 'done', options.extra)
    if (options.reports) source.reports = options.reports
    ctx.d.table.add(source)
    const worker = makeWorker(source.workerSessionId)
    ctx.host.agents.set(source.workerSessionId, worker)
    return fn({ ...ctx, lead, source, worker })
  }, options)
}

const call = (tool, args) => tool.execute(args, { agent: { id: 'lead' } })

/** 等异步的 `void pump()` / 投递链落定。 */
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

/** 一份典型的「调研已完成」报告。 */
const SOURCE_REPORT = {
  at: iso(30_000),
  status: 'done',
  summary: '完成了 Trae 调研，产出 analysis/trae-comparison.md',
  detail: '改了 analysis/trae-comparison.md；未决：缺少企业版价格页截图',
}

const NEW_BRIEF = '把 analysis/trae-comparison.md 压缩到 800 字，保留结论与数据来源。'

// ---------------------------------------------------------------- 工具层：schema

test('dispatch_launch schema 增加 handoff_from，并写明与 continue_task_id 的区别', () => {
  const def = toolDefinitions({}).find(item => item.name === 'dispatch_launch')
  const prop = def.parameters.properties.handoff_from
  assert.ok(prop, '必须暴露 handoff_from 参数')
  assert.equal(prop.type, 'string')
  assert.equal(def.parameters.additionalProperties, false, '保持 additionalProperties:false')
  // 两个参数的区别必须写在模型读得到的地方：一个新建任务、一个不新建。
  assert.match(def.description, /新建一个任务/)
  assert.match(def.description, /同一个任务追加要求/)
  assert.match(def.description, /只能二选一/)
  assert.match(prop.description, /独立/, 'handoff_from 的描述必须点明「新任务有独立记录」')
  assert.match(prop.description, /沿用/, 'handoff_from 的描述必须点明「沿用来源任务的子会话」')
  // 补充口径：逃生门与审计字段也必须让模型看得到。
  assert.equal(def.parameters.properties.no_reuse.type, 'boolean')
  assert.match(def.parameters.properties.no_reuse.description, /强制新开会话/)
  assert.match(def.description, /no_reuse: true` > `handoff_from`/, '优先级链必须写死在描述里')
  assert.equal(def.parameters.properties.handoff_reason.type, 'string')
  assert.match(def.parameters.properties.handoff_reason.description, /不参与任何判定或打分/)
})

// ---------------------------------------------------------------- 逃生门：no_reuse

test('no_reuse + handoff_from：不报错，按 no_reuse 强制新会话，并在 note 里说明忽略', async () => {
  // 来源任务故意处于 running（正常复用会被第四条校验拒绝）：no_reuse 是逃生门，
  // 它的优先级最高，连校验都不该走到。
  await withSource(async ({ d, launch, source, createdSessions }) => {
    const value = await call(launch, {
      title: '另起一条', brief: '不要接上一轮', handoff_from: source.id, no_reuse: true,
    })
    await tick()
    const task = d.table.get(value.task.task_id)

    assert.ok(task, 'no_reuse 不应该因为 handoff_from 的组合而被挡住')
    assert.equal(task.parentTaskId, undefined, '按 no_reuse 处理 = 不是复用')
    assert.notEqual(task.workerSessionId, source.workerSessionId, '必须新开会话')
    assert.equal(createdSessions.length, 1, '必须真的走普通 createWorker')
    assert.equal(value.handoff, undefined)
    assert.equal(value.forced_new_session, true)
    assert.match(value.note, /no_reuse=true/)
    assert.match(value.note, /忽略 handoff_from/)
  }, { status: 'running' })
})

test('no_reuse 单独使用：就是普通新派（不产生复用血缘字段）', async () => {
  await withSource(async ({ d, launch, source }) => {
    const value = await call(launch, { title: '普通任务', brief: 'x', no_reuse: true })
    const task = d.table.get(value.task.task_id)
    assert.equal(task.parentTaskId, undefined)
    assert.equal(task.handoffSource, undefined)
    assert.equal(value.forced_new_session, true)
    assert.notEqual(task.workerSessionId, source.workerSessionId)
  })
})

// ---------------------------------------------------------------- 审计：handoff_reason

test('handoff_reason 落库为 handoffReason，来源类型记 agent，并投影到看板', async () => {
  await withSource(async ({ d, launch, source }) => {
    const reason = '压缩的是上一轮刚生成的调研文档'
    const value = await call(launch, {
      title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id, handoff_reason: reason,
    })
    const task = d.table.get(value.task.task_id)

    assert.equal(task.handoffReason, reason)
    assert.equal(task.handoffSource, 'agent', '给了理由 = 模型判断的痕迹')
    assert.equal(value.task.handoff_reason, reason, '工具返回值也要能看到审计字段')

    const row = boardSnapshot(d).tasks.find(item => item.task_id === task.id)
    assert.equal(row.handoff_from, source.id, 'boardTask 要投影「接续自哪条」')
    assert.equal(row.handoff_source, 'agent')
    assert.equal(row.handoff_reason, reason)
  })
})

test('只传 handoff_from、不传 reason → handoffSource 记 explicit，看板不带 reason', async () => {
  await withSource(async ({ d, launch, source }) => {
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id })
    const task = d.table.get(value.task.task_id)

    assert.equal(task.handoffSource, 'explicit')
    assert.equal(task.handoffReason, undefined)
    const row = boardSnapshot(d).tasks.find(item => item.task_id === task.id)
    assert.equal(row.handoff_source, 'explicit')
    assert.equal(row.handoff_reason, undefined, '没有理由就不该凭空出现空字段')
  })
})

test('handoff_reason 超长：截断到上限并留 truncated 原始长度，不参与任何判定', async () => {
  await withSource(async ({ d, launch, source }) => {
    const reason = '因'.repeat(HANDOFF_REASON_MAX_CHARS + 300)
    const value = await call(launch, {
      title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id, handoff_reason: reason,
    })
    const task = d.table.get(value.task.task_id)

    assert.ok(task.handoffReason.length <= HANDOFF_REASON_MAX_CHARS,
      `handoffReason 必须 ≤ ${HANDOFF_REASON_MAX_CHARS} 字，实际 ${task.handoffReason.length}`)
    assert.equal(task.handoffReasonTruncated, reason.length, '要留下原始长度，回答「它被截过」')
    assert.match(task.handoffReason, /已截断/)
    // 审计字段不改判定：任务仍然是复用出来的那一条。
    assert.equal(task.parentTaskId, source.id)
    assert.equal(task.handoffSource, 'agent')
  })
})

test('continue_task_id 与 handoff_from 同时传 → 明确报错，不猜优先级', async () => {
  await withSource(async ({ launch, source }) => {
    await assert.rejects(
      () => call(launch, { title: 'x', brief: 'y', continue_task_id: source.id, handoff_from: source.id }),
      /只能二选一[\s\S]*同一个任务[\s\S]*新建一个任务/,
    )
  })
})

test('两个参数都是空串/空白时按「没传」处理（不误报互斥）', async () => {
  await withSource(async ({ launch, d }) => {
    const before = d.table.tasks.size
    await call(launch, { title: '普通新派', brief: 'x', continue_task_id: '  ', handoff_from: '' })
    assert.equal(d.table.tasks.size, before + 1, '空参数应当走普通新派')
  })
})

// ---------------------------------------------------------------- 成功路径

test('handoff_from：新建任务、复用会话与线程、记录 parentTaskId（不调用 createWorker）', async () => {
  await withSource(async ({ d, launch, source, createdSessions }) => {
    const before = d.table.tasks.size
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id })
    await tick()
    const task = d.table.get(value.task.task_id)

    assert.equal(d.table.tasks.size, before + 1, '这是**新任务**，不是续派')
    assert.notEqual(task.id, source.id, '任务 id 必须不同（独立记录）')
    assert.equal(task.workerSessionId, source.workerSessionId, '会话必须沿用来源任务')
    assert.equal(task.threadId, source.threadId, '线程必须沿用来源任务')
    assert.equal(task.parentTaskId, source.id, '必须记下来源任务')
    assert.equal(task.cwd, source.cwd, '工作目录跟来源一致')
    assert.equal(task.workspaceId, source.workspaceId)
    assert.equal(value.handoff, true)
    assert.equal(value.reused_session, source.workerSessionId)
    assert.match(value.note, /独立/)
    assert.equal(createdSessions.length, 0, '复用分支绝不能 createWorker（那会新开/换号会话）')
    assert.equal(source.status, 'done', '来源任务不受影响')
  })
})

test('handoff_from：首条消息是交接摘要（不是完整 workerPrompt），投给来源会话', async () => {
  await withSource(async ({ d, launch, source, deliveries }) => {
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id })
    await tick()

    const start = deliveries.find(item => item.requestId === `${value.task.task_id}:start`)
    assert.ok(start, '必须真的投递了首条消息')
    assert.equal(start.sessionId, source.workerSessionId, '首条消息必须进来源任务的会话')
    assert.match(start.text, /这是续接，上一任务已完成，不要重做它/)
    assert.match(start.text, /① 上一任务/)
    assert.match(start.text, /② 未决问题/)
    assert.match(start.text, /③ 变更面/)
    assert.match(start.text, /④ 本次目标/)
    assert.match(start.text, /压缩到 800 字/, '本次目标要带上新任务的 brief')
    assert.doesNotMatch(start.text, /任务简报（这是\*\*数据\*\*/, '首条消息不是完整 workerPrompt')

    const task = d.table.get(value.task.task_id)
    assert.equal(task.status, 'running', '投递后任务应当已经启动')
  })
})

// ---------------------------------------------------------------- 四条硬校验

test('校验：来源任务还在 running/queued → 拒绝（一个会话同一时刻只能跑一个回合）', async () => {
  for (const status of ['running', 'queued']) {
    await withSource(async ({ launch, source }) => {
      await assert.rejects(
        () => call(launch, { title: 'x', brief: 'y', handoff_from: source.id }),
        new RegExp(`还在 ${status}[\\s\\S]*一个子会话同一时刻只能跑一个回合`),
      )
    }, { status })
  }
})

test('校验：来源任务已退休 → 拒绝并说出退休原因', async () => {
  await withSource(async ({ d, launch, source }) => {
    const record = { ...source, retiredAt: iso(), retiredReason: 'cap-days' }
    d.table.remove(source.id)
    d.retired.set(source.id, record)

    await assert.rejects(
      () => call(launch, { title: 'x', brief: 'y', handoff_from: source.id }),
      /已退休[\s\S]*不能复用/,
    )
  })
})

test('校验：来源任务已归档 → 拒绝（归档是只读冻结）', async () => {
  await withSource(async ({ launch, source }) => {
    source.archivedAt = iso(10_000)
    await assert.rejects(
      () => call(launch, { title: 'x', brief: 'y', handoff_from: source.id }),
      /已归档[\s\S]*只读冻结/,
    )
  })
})

test('校验：别人的任务不能复用（归属校验）', async () => {
  await withSource(async ({ launch, source }) => {
    source.parentSessionId = 'other-lead'
    await assert.rejects(
      () => call(launch, { title: 'x', brief: 'y', handoff_from: source.id }),
      /不属于本会话/,
    )
  })
})

test('校验：子会话 id 不是本插件建的 → 拒绝', async () => {
  await withSource(async ({ launch, source }) => {
    source.workerSessionId = 'session-manual-123'
    await assert.rejects(
      () => call(launch, { title: 'x', brief: 'y', handoff_from: source.id }),
      /不是本插件建的/,
    )
  })
})

test('校验：跨目录 / 跨工作区 → 拒绝，并说明复用沿用来源会话', async () => {
  await withSource(async ({ launch, source }) => {
    await assert.rejects(
      () => call(launch, { title: 'x', brief: 'y', cwd: 'D:\\proj\\b', handoff_from: source.id }),
      /工作目录与任务 t-source 不一致[\s\S]*沿用来源任务的子会话/,
    )
    await assert.rejects(
      () => call(launch, { title: 'x', brief: 'y', workspace: 'ws-b', handoff_from: source.id }),
      /工作区与任务 t-source 不一致/,
    )
  })
})

test('校验：cwd 只是大小写/分隔符不同 → 放行（Windows 同一目录）', async () => {
  await withSource(async ({ launch, d }) => {
    const value = await call(launch, { title: 'x', brief: 'y', cwd: 'd:/PROJ/A/', handoff_from: 't-source' })
    assert.equal(d.table.get(value.task.task_id).cwd, 'D:\\proj\\a')
  })
})

test('校验：换模型 / preset → 拒绝（会话创建时已定死）', async () => {
  await withSource(async ({ launch, source }) => {
    source.model = 'provider/old-model'
    await assert.rejects(
      () => call(launch, { title: 'x', brief: 'y', model: 'provider/new-model', handoff_from: source.id }),
      /复用不能换模型或 preset[\s\S]*model/,
    )
    await assert.rejects(
      () => call(launch, { title: 'x', brief: 'y', agent_preset: 'stronger', handoff_from: source.id }),
      /复用不能换模型或 preset/,
    )
    // 与来源一致的值不算「换」。
    const value = await call(launch, { title: 'x', brief: 'y', model: 'provider/old-model', handoff_from: source.id })
    assert.ok(value.task.task_id)
  })
})

// ---------------------------------------------------------------- 会话级互斥

test('纯表：takeRunnable 跳过「目标会话已有 running」的队首，但不丢它', () => {
  const table = new TaskTable(5)
  table.add(mkTask('busy-1', 'dispatch-shared', 'running'))
  table.add(mkTask('wait-1', 'dispatch-shared', 'queued'))
  table.add(mkTask('other-1', 'dispatch-other', 'queued'))

  // 队列顺序是 [wait-1, other-1]；wait-1 的会话被占着，所以先起 other-1。
  assert.equal(table.takeRunnable().id, 'other-1')
  assert.equal(table.get('wait-1').status, 'queued', '被跳过的任务必须保持 queued')
  assert.deepEqual(table.queue, ['wait-1'], '必须留在队列里，不能被丢掉')

  // 会话空出来后，它就能开始。
  table.settle(table.get('busy-1'), 'done')
  assert.equal(table.takeRunnable().id, 'wait-1')
})

test('互斥：同会话排两个复用任务，第二个在前一个结算前保持 queued；结算后能启动', async () => {
  await withSource(async ({ d, launch, source, deliveries }) => {
    const first = await call(launch, { title: 'B', brief: '第一段', handoff_from: source.id })
    const second = await call(launch, { title: 'C', brief: '第二段', handoff_from: source.id })
    await tick()

    const b = d.table.get(first.task.task_id)
    const c = d.table.get(second.task.task_id)
    assert.equal(b.status, 'running')
    assert.equal(c.status, 'queued', '同一会话同一时刻只能跑一个任务')
    assert.ok(d.table.queue.includes(c.id), 'C 必须留在队列里，不能被丢出')
    assert.equal(d.table.sessionBusy(source.workerSessionId), true)

    // B 结算 → pump 把 C 顶上来。
    d.settle(b, 'done')
    await tick()
    assert.equal(c.status, 'running', '前一个结算后，第二个必须能启动')
    assert.equal(d.table.queue.includes(c.id), false)
    const startC = deliveries.find(item => item.requestId === `${c.id}:start`)
    assert.equal(startC.sessionId, source.workerSessionId, 'C 的首条消息也进同一条会话')
  })
})

// ---------------------------------------------------------------- 归属

test('串账：同会话 A(done) + B(running) 时，dispatch_report 记到 B', async () => {
  await withSource(async ({ d, launch, source, worker }) => {
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id })
    await tick()
    const b = d.table.get(value.task.task_id)
    assert.equal(b.status, 'running')

    const result = await d.report(worker, { status: 'progress', summary: 'B 正在压缩' })

    assert.equal(result.task_id, b.id, '报告必须记到当前活跃的 B')
    assert.equal(b.reports.length, 1)
    assert.equal(source.reports.length, 0, '已结算的 A 一条报告都不能收到')
  })
})

test('串账：同会话 A(done) + B(running) 时，onWorkerIdle 只收尾 B', async () => {
  await withSource(async ({ d, launch, source }) => {
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id })
    await tick()
    const b = d.table.get(value.task.task_id)
    b.reportedSinceTurn = true

    await d.onWorkerIdle(source.workerSessionId)

    assert.equal(b.status, 'done', '当前活跃的 B 被收尾')
    assert.equal(source.status, 'done', 'A 早就是 done，不能被这次 idle 改写')
    assert.equal(source.settledAt, source.settledAt)
  })
})

test('串账：同会话 A(done) + B(running) 时，agent/disposed 只结算 B', async () => {
  await withSource(async ({ d, launch, source }) => {
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id })
    await tick()
    const b = d.table.get(value.task.task_id)

    // 复刻 index.js 的 agent/disposed：byWorker 必须选中当前活跃的那条。
    const task = d.table.byWorker(source.workerSessionId)
    assert.equal(task, b)
    if (task) d.settle(task, 'interrupted')

    assert.equal(b.status, 'interrupted')
    assert.equal(source.status, 'done', 'A 不能被会话销毁改成 interrupted')
  })
})

// ---------------------------------------------------------------- 取消 / 归档闸门

test('cancel 闸门：同会话还有未结算任务时拒绝，并给出人类可读原因', async () => {
  await withSource(async ({ d, launch, source }) => {
    const first = await call(launch, { title: 'B', brief: '第一段', handoff_from: source.id })
    const second = await call(launch, { title: 'C', brief: '第二段', handoff_from: source.id })
    await tick()
    const b = d.table.get(first.task.task_id)
    const c = d.table.get(second.task.task_id)

    await assert.rejects(
      () => d.cancel(b, '看板取消'),
      /同会话还有 1 个未结算任务[\s\S]*取消会打断它们的回合/,
    )
    assert.equal(b.status, 'running', '被拒的取消不能改状态')
    assert.equal(c.status, 'queued', 'C 原样留在队列里')
    assert.equal(d.table.queue.includes(c.id), true)

    // 出路：先取消排队中的 C（它没占会话回合），再取消 B。
    await d.cancel(c, '先取消排队的')
    assert.equal(c.status, 'cancelled')
    await d.cancel(b, '看板取消')
    assert.equal(b.status, 'cancelled')
  })
})

test('归档安全：归档 A 只标记任务，不动与 B 共用的会话；B 仍能收报告', async () => {
  await withSource(async ({ d, launch, source, worker, archives }) => {
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id })
    await tick()
    const b = d.table.get(value.task.task_id)
    assert.equal(b.status, 'running')

    const result = await d.archiveTask(source.id)

    assert.equal(result.ok, true)
    assert.equal(result.archived, true)
    assert.ok(source.archivedAt, '任务标记必须写下（用户点的是归档）')
    assert.match(source.archiveError, /同会话还有其它未结算任务/, '必须留下「为什么没归档会话」')
    assert.match(result.reason, /同会话还有其它未结算任务/)
    assert.equal(archives.includes(source.workerSessionId), false, '不能调用底层归档同一条会话')
    assert.equal(b.status, 'running', 'B 不能被打断')

    const reported = await d.report(worker, { status: 'progress', summary: 'B 还在跑' })
    assert.equal(reported.task_id, b.id, '归档 A 之后 B 仍能正常收报告')
    assert.equal(b.reports.length, 1)
  })
})

// ---------------------------------------------------------------- 回滚

test('回滚：allowSessionReuse=false 时降级为普通新派，并在 note 里说明原因', async () => {
  await withSource(async ({ d, launch, source, createdSessions }) => {
    const before = d.table.tasks.size
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id })
    await tick()
    const task = d.table.get(value.task.task_id)

    assert.equal(d.table.tasks.size, before + 1, '仍然是新派一条任务')
    assert.notEqual(task.id, source.id)
    assert.equal(task.parentTaskId, undefined, '降级后不是复用')
    assert.notEqual(task.workerSessionId, source.workerSessionId, '降级后不沿用来源会话')
    assert.equal(value.handoff, undefined)
    assert.equal(value.reuse_degraded, true)
    assert.match(value.note, /降级/)
    assert.match(value.note, /allowSessionReuse=false/)
    assert.equal(createdSessions.length, 1, '降级路径应当走普通 createWorker')
  }, { config: { allowSessionReuse: false } })
})

test('回滚：不传 handoff_from 时行为与今天一致（普通新派，note 不变）', async () => {
  await withSource(async ({ d, launch }) => {
    const before = d.table.tasks.size
    const value = await call(launch, { title: '普通任务', brief: '独立工作' })
    const task = d.table.get(value.task.task_id)

    assert.equal(d.table.tasks.size, before + 1)
    assert.equal(value.continued, undefined)
    assert.equal(value.handoff, undefined)
    assert.equal(value.reuse_degraded, undefined)
    assert.match(value.note, /已入队\/启动/)
    assert.equal(task.workerSessionId, `${WORKER_PREFIX}${task.id}`, '普通新派的会话 id 形状不变')
  })
})

// ---------------------------------------------------------------- 会话不存在

test('复用启动：来源会话已不存在 → 任务 failed，且不新建会话冒充复用', async () => {
  await withSource(async ({ d, host, launch, source, deliveries, createdSessions }) => {
    host.agents.delete(source.workerSessionId)
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: source.id })
    await tick()

    const task = d.table.get(value.task.task_id)
    assert.equal(task.status, 'failed', '会话不在时必须明确失败，不能假装接上上下文')
    assert.match(task.error, /已不存在[\s\S]*不能新建一条会话冒充复用/)
    assert.equal(createdSessions.length, 0, '绝不能偷偷新建一条会话')
    assert.equal(
      deliveries.some(item => item.sessionId === source.workerSessionId && item.requestId === `${task.id}:start`),
      false,
      '没有会话就不该投递首条消息',
    )
  })
})

// ---------------------------------------------------------------- 落盘 / 恢复 / 退休

test('落盘：parentTaskId 真的写进 tasks.json，重启后恢复', async () => {
  // 在同一个夹具里起第二个 Dispatch 复刻「重启」：外层 finally 会删临时目录，
  // 所以不能等 withSource 返回之后再去读盘。
  await withSource(async ({ d, launch, dir: stateDir }) => {
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: 't-source' })
    await d.persist()
    const raw = JSON.parse(await readFile(join(stateDir, 'tasks.json'), 'utf8'))
    const stored = raw.tasks.find(item => item.id === value.task.task_id)
    assert.equal(stored.parentTaskId, 't-source', 'parentTaskId 必须落盘，不能只活在内存里')

    const host = makeHost()
    const restarted = new Dispatch(host.ctx, {
      stateDir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
    })
    try {
      await restarted.restore()
      const child = [...restarted.table.tasks.values()].find(task => task.parentTaskId === 't-source')
      assert.ok(child, '重启后 parentTaskId 必须恢复')
      assert.equal(child.workerSessionId, `${WORKER_PREFIX}t-source`)
    } finally {
      await restarted.dispose()
    }
  })
})

test('恢复兼容：老数据没有 parentTaskId → 视为独立任务，不报错', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-reuse-old-'))
  const base = iso()
  await writeState(join(dir, 'tasks.json'), {
    targets: {},
    tasks: [{ ...mkTask('t-old', `${WORKER_PREFIX}t-old`, 'done'), createdAt: base, updatedAt: base }],
  }, base)
  const raw = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'))
  delete raw.tasks[0].parentTaskId
  await writeState(join(dir, 'tasks.json'), raw, base)

  const d = new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
  })
  try {
    await d.restore()
    const task = d.table.get('t-old')
    assert.ok(task, '老数据必须能读回来')
    assert.equal(task.parentTaskId, undefined, '没有这个键 = 独立任务，不臆造来源')
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('退休留痕带上 parentTaskId（与 threadId 同样处理）', async () => {
  await withSource(async ({ d, launch }) => {
    const value = await call(launch, { title: '压缩调研', brief: NEW_BRIEF, handoff_from: 't-source' })
    const task = d.table.get(value.task.task_id)
    task.status = 'done'
    task.updatedAt = iso(400 * 86_400_000)

    d.enforceLedgerCap()

    const record = d.retired.get(task.id)
    assert.ok(record, '超期任务应当被退休')
    assert.equal(record.parentTaskId, 't-source', '留痕必须回答「它沿用的是哪条任务」')
    assert.equal(record.threadId, task.threadId)
  }, { config: { ledgerMaxDays: 1 } })
})

// ---------------------------------------------------------------- 交接摘要文本

test('handoffPrompt：四段都在，内容只来自账本事实，长度受控', () => {
  const task = { id: 't-b', title: '压缩调研', brief: NEW_BRIEF, cwd: 'D:\\proj\\a', parentTaskId: 't-a' }
  const parent = {
    id: 't-a',
    title: '调研 Trae',
    status: 'done',
    settledAt: '2026-11-11T00:00:00.000Z',
    workspaceTitle: '项目 A',
    reports: [SOURCE_REPORT],
  }
  const text = handoffPrompt(task, parent)

  assert.ok(text.length <= HANDOFF_MAX_CHARS, `交接摘要必须 ≤ ${HANDOFF_MAX_CHARS} 字，实际 ${text.length}`)
  for (const anchor of ['① 上一任务', '② 未决问题', '③ 变更面', '④ 本次目标']) {
    assert.ok(text.includes(anchor), `缺少段落：${anchor}`)
  }
  assert.match(text, /这是续接，上一任务已完成，不要重做它/)
  assert.match(text, /调研 Trae/)
  assert.match(text, /完成了 Trae 调研，产出 analysis\/trae-comparison\.md/, '① 必须用来源任务的报告摘要')
  assert.match(text, /analysis\/trae-comparison\.md；未决：缺少企业版价格页截图/, '③ 必须用来源任务的 detail')
  assert.match(text, /项目 A/, '③ 必须带来源任务的工作区')
  assert.match(text, /压缩到 800 字/, '④ 必须带本次 brief')
})

test('handoffPrompt：来源没有任何可读事实时如实说「账本没有记录」，不编造', () => {
  const task = { id: 't-b', title: '新任务', brief: '做点事', cwd: 'D:\\proj\\a', parentTaskId: 't-a' }
  const text = handoffPrompt(task, { id: 't-a', title: '旧任务', status: 'failed', reports: [] })

  assert.match(text, /它做了什么：账本没有记录/)
  assert.match(text, /账本没有记录未决问题/)
  assert.match(text, /账本没有记录改动清单/)
  // 账本里没有的东西不许出现：没有报告就不该出现任何「已完成 / 改了某文件」的具体断言。
  assert.doesNotMatch(text, /产出|改了 \S+\.md/)
})

test('handoffPrompt：超长字段逐段截断并标注，整体仍不超上限', () => {
  const huge = '很长的内容'.repeat(2000)
  // 连 id / cwd / taskDir 都超长：这是最容易被整体 clip 吃掉 ②/③ 的输入形状。
  const task = { id: huge, title: huge, brief: huge, cwd: huge, parentTaskId: huge }
  const parent = {
    id: huge, title: huge, status: 'done', settledAt: huge, workspaceTitle: huge, taskDir: huge,
    reports: [{ status: 'done', summary: huge, detail: huge }],
    lastText: huge,
  }
  const text = handoffPrompt(task, parent)

  assert.ok(text.length <= HANDOFF_MAX_CHARS, `必须受 ${HANDOFF_MAX_CHARS} 字上限约束，实际 ${text.length}`)
  assert.match(text, /已截断/, '截断必须标注，不能静默丢内容')
  for (const anchor of ['① 上一任务', '② 未决问题', '③ 变更面', '④ 本次目标']) {
    assert.ok(text.includes(anchor), `整体截断后仍要保留段落：${anchor}`)
  }
})

// ---------------------------------------------------------------- 端到端

test('端到端复现：A 完成 → handoff_from 派 B → 同会话收到交接摘要 → 报告记在 B → 看板两行', async () => {
  await withSource(async ({ d, launch, source, worker, deliveries }) => {
    source.reports = [SOURCE_REPORT]
    // 1) A 已完成（来源任务 already done）
    assert.equal(source.status, 'done')

    // 2) 带 handoff_from 派 B
    const value = await call(launch, { title: '压缩这份调研文档', brief: NEW_BRIEF, handoff_from: source.id })
    await tick()
    const b = d.table.get(value.task.task_id)
    assert.notEqual(b.id, source.id)
    assert.equal(b.status, 'running')

    // 3) B 收到的是交接摘要，会话 id 与 A 相同
    const start = deliveries.find(item => item.requestId === `${b.id}:start`)
    assert.equal(start.sessionId, source.workerSessionId)
    assert.match(start.text, /这是续接，上一任务已完成，不要重做它/)
    assert.match(start.text, /完成了 Trae 调研/)

    // 4) B 的报告记在 B 上
    const reported = await d.report(worker, { status: 'done', summary: '压缩完成，产出 analysis/trae-800.md' })
    assert.equal(reported.task_id, b.id)
    assert.equal(b.reports.at(-1).summary, '压缩完成，产出 analysis/trae-800.md')
    assert.equal(source.reports.length, 1, 'A 只有自己原来那条报告')

    // 5) 看板是独立两行，B 有自己的行与状态
    const snap = boardSnapshot(d)
    const rows = snap.tasks.map(item => item.task_id)
    assert.ok(rows.includes(source.id), 'A 仍在看板上')
    assert.ok(rows.includes(b.id), 'B 有独立的看板行')
    assert.equal(snap.tasks.find(item => item.task_id === b.id).status, 'done')
    assert.equal(snap.tasks.find(item => item.task_id === source.id).status, 'done')
  })
})
