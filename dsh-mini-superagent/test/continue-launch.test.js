/**
 * plans/08 阶段 1「最小可用」= **模型 A**：`dispatch_launch({ continue_task_id })`
 * 转发为对已有任务的 `dispatch_message`。
 *
 * 这个文件钉的是三件事，缺一条这个功能就不该上线：
 *
 * 1. **不新建任务**：续派之后 `table.tasks.size` 不变、目标任务的 id 不变、
 *    看板上不会有第二行。这是模型 A 与「再派一个」的全部区别。
 * 2. **要求真的进了那条会话**：投递的文本带着 `CONTINUE_LEAD` 前缀与调用方给的内容，
 *    且落进**目标任务**的 `workerSessionId`，不是别处。
 * 3. **四条硬校验**（plans/08 §四）逐条拒绝并给人类可读原因——尤其是第 4 条
 *    「没有别的活跃任务」，它用的是整张表而不是 `workerState()`（见 `continueLaunch` 注释）。
 *
 * 另有 §七.6「可回滚」：**不传** `continue_task_id` 时走的是完全没有改过的那条路径，
 * 这里用「照常新建任务 + 会话 id 仍以 `dispatch-` 开头」把这条保证钉住。
 *
 * 与 `thread-binding.test.js` 的分工：那边测「归属」在**已经有**同会话多任务时对不对，
 * 这边测「续派**不制造**新任务」以及它的拒绝路径。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WORKER_PREFIX, isWorkerSessionId, newThreadId } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { toolDefinitions } from '../src/tools.js'

// ---------------------------------------------------------------- 夹具

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

function makeWorker(id) {
  return {
    id, status: 'idle',
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    cancel() {}, steer() {}, followup() {}, inject() {},
  }
}

/**
 * 一个可以直接驱动 `Dispatch` 与 `dispatch_launch` 的夹具。
 *
 * `deliver` 记录每一次投递的 `{sessionId, text}`：续派到底有没有把要求送到
 * **目标任务**的会话上，只能从这份记录里看。
 */
async function withDispatch(fn, config) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-cont-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    noticeMergeWindowMs: 0,
    ...config,
  })
  d.workspaces = {
    list: () => [{ id: 'ws-a', title: '项目 A', path: 'D:\\proj\\a' }, { id: 'ws-b', title: '项目 B', path: 'D:\\proj\\b' }],
    resolve: async ref => ({
      'ws-a': { id: 'ws-a', title: '项目 A', path: 'D:\\proj\\a' },
      'ws-b': { id: 'ws-b', title: '项目 B', path: 'D:\\proj\\b' },
    }[ref]),
    resolveOrCreate: async ref => ({ workspace: ref ? { id: ref, title: ref, path: `D:\\proj\\${ref}` } : undefined, created: false }),
    dayWorkspace: async () => undefined,
    defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return dir },
  }
  const deliveries = []
  d.sessions = {
    cwdFor: () => dir,
    hint: () => {},
    dispose: () => {},
    restrictTools: () => () => {},
    forgetRestrict: () => {},
    holds: () => false,
    async createWorker(sessionId, cwd) {
      const agent = makeWorker(sessionId)
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
    await fn({ d, host, dir, deliveries, tools, launchTool: tools.dispatch_launch })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 造一条已结算的任务（续派的典型对象：上一轮做完了，这一轮补一句）。
 *
 * 刻意带齐 `threadId`：阶段 0 之后每条任务都有它，缺了会让「续派不改线程」的断言失真。
 */
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
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  ...extra,
})

/** 主线夹具：一条主会话、一条已结算任务、它的 worker 会话都登记好。 */
async function withSettledTask(fn, options = {}) {
  return withDispatch(async ctx => {
    const { d, host } = ctx
    host.agents.set('lead', makeWorker('lead'))
    const task = options.task ?? mkTask('t-prev', `${WORKER_PREFIX}t-prev`, 'done')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeWorker(task.workerSessionId))
    return fn({ ...ctx, task })
  }, options.config)
}

const call = (tool, args) => tool.execute(args, { agent: { id: 'lead' } })

// ---------------------------------------------------------------- 模型 A：转发

test('续派不新建任务：table 大小不变、返回的还是原任务', async () => {
  await withSettledTask(async ({ d, launchTool, task }) => {
    const before = d.table.tasks.size
    const value = await call(launchTool, { title: '补一句', brief: '再跑一下 lint', continue_task_id: task.id })

    assert.equal(d.table.tasks.size, before, '续派绝不能多出一条任务（模型 A 的全部意义）')
    assert.equal(value.task.task_id, task.id, '返回的必须是原任务，不是新任务')
    assert.equal(value.continued, true, '返回值要能区分「续派」与「新派发」')
    assert.match(value.note, /没有新建任务/, 'note 必须说明没有新建任务，否则调用方会去找那条不存在的任务')
  })
})

test('续派把要求投进**目标任务**的子会话，且带「不要重做」的前缀', async () => {
  await withSettledTask(async ({ deliveries, launchTool, task }) => {
    await call(launchTool, { title: '补一句', brief: '再跑一下 lint', continue_task_id: task.id })

    const last = deliveries.at(-1)
    assert.equal(last.sessionId, task.workerSessionId, '要求必须投给目标任务的会话')
    assert.match(last.text, /【续派】/, '缺这个前缀，worker 会分不清是增量还是重做')
    assert.match(last.text, /不要重做/, '「不要重做」是模型 A 消歧义的关键半句')
    assert.match(last.text, /再跑一下 lint/, '正文必须原样带上')
    assert.match(last.text, /补一句/, 'title 也要带上（它是「这次要做什么」的一行小标题）')
  })
})

test('续派之后任务重新回到 running（等价于 dispatch_message 的续跑语义）', async () => {
  await withSettledTask(async ({ launchTool, task }) => {
    assert.equal(task.status, 'done')
    await call(launchTool, { title: '补一句', brief: 'x', continue_task_id: task.id })
    assert.equal(task.status, 'running', '续派对已结算任务就是续跑：任务重新 running')
    assert.ok(task.turnStartedAt, '新一轮的回合起点要刷新，否则耗时统计会算进上一轮')
  })
})

test('续派不改任务的线程标识（阶段 0 的 threadId 依然指向同一条线程）', async () => {
  await withSettledTask(async ({ launchTool, task }) => {
    const before = task.threadId
    await call(launchTool, { title: '补一句', brief: 'x', continue_task_id: task.id })
    assert.equal(task.threadId, before, '续派是同一任务的延续，不是新线程')
  })
})

test('续派只给 brief、不给 title 也成立（title/brief 任一个能说明要求即可）', async () => {
  await withSettledTask(async ({ deliveries, launchTool, task }) => {
    await call(launchTool, { title: '', brief: '只看 brief 也行', continue_task_id: task.id })
    assert.match(deliveries.at(-1).text, /只看 brief 也行/)
  })
})

// ---------------------------------------------------------------- 四条硬校验

test('校验①：目标任务不存在 → 报错并指向 dispatch_list（不是笼统的 400）', async () => {
  await withSettledTask(async ({ launchTool }) => {
    await assert.rejects(
      () => call(launchTool, { title: 'x', brief: 'y', continue_task_id: 't-nope' }),
      /没有任务 t-nope.*dispatch_list/s,
      '必须说清「没有这条任务」并给出下一步（查列表或去掉参数新派）',
    )
  })
})

test('校验①（补充）：已退休的任务被明确拒绝，并说出退休原因', async () => {
  await withSettledTask(async ({ d, launchTool }) => {
    const task = mkTask('t-gone', `${WORKER_PREFIX}t-gone`, 'done', {
      updatedAt: '2020-01-01T00:00:00.000Z',
    })
    d.table.add(task)
    d.enforceLedgerCap()
    assert.ok(d.retired.get('t-gone'), '夹具前提：这条确实被退休了')

    await assert.rejects(
      () => call(launchTool, { title: 'x', brief: 'y', continue_task_id: 't-gone' }),
      /已退休.*没有上下文/s,
      '退休任务要说「已退休」而不是「没有任务」：前者是历史，后者是打错 id',
    )
  }, { config: { ledgerMaxDays: 1 } })
})

test('校验②：别人的任务不能续派（归属校验）', async () => {
  await withSettledTask(async ({ d, launchTool, task }) => {
    task.parentSessionId = 'other-lead'
    await assert.rejects(
      () => call(launchTool, { title: 'x', brief: 'y', continue_task_id: task.id }),
      /不属于本会话/,
      '续派是把要求投进别人的会话，跨会话必须拒绝',
    )
    assert.equal(d.table.tasks.size, 1, '拒绝时不该留下任何产物')
  })
})

test('校验③：子会话 id 不是本插件建的 → 拒绝（挡住手填真实会话 id）', async () => {
  await withSettledTask(async ({ launchTool, task }) => {
    task.workerSessionId = 'session-manual-123'
    await assert.rejects(
      () => call(launchTool, { title: 'x', brief: 'y', continue_task_id: task.id }),
      /不是本插件建的/,
      '往里塞要求等于盗用别人的上下文，必须按形状拒绝',
    )
  })
})

test('校验④：cwd 与目标任务不一致 → 拒绝，并说明「续派沿用目标任务的工作区」', async () => {
  await withSettledTask(async ({ launchTool, task }) => {
    await assert.rejects(
      () => call(launchTool, { title: 'x', brief: 'y', cwd: 'D:\\proj\\b', continue_task_id: task.id }),
      /工作目录与任务 t-prev 不一致[\s\S]*沿用目标任务的工作区/,
      '校验文案必须同时给出「哪里不一致」和「为什么不能换」',
    )
  })
})

test('校验④：cwd 只是大小写/分隔符不同时**不算**不一致（Windows 同一目录）', async () => {
  await withSettledTask(async ({ deliveries, launchTool, task }) => {
    await call(launchTool, { title: 'x', brief: 'y', cwd: 'd:/PROJ/A/', continue_task_id: task.id })
    assert.match(deliveries.at(-1).text, /【续派】/, '同一个目录换个写法不该被拒')
  })
})

test('校验④：workspace 与目标任务不同 → 拒绝', async () => {
  await withSettledTask(async ({ launchTool, task }) => {
    await assert.rejects(
      () => call(launchTool, { title: 'x', brief: 'y', workspace: 'ws-b', continue_task_id: task.id }),
      /工作区与任务 t-prev 不一致/,
    )
  })
})

test('校验④：workspace 与目标任务相同 → 放行', async () => {
  await withSettledTask(async ({ deliveries, launchTool, task }) => {
    await call(launchTool, { title: 'x', brief: 'y', workspace: 'ws-a', continue_task_id: task.id })
    assert.match(deliveries.at(-1).text, /【续派】/)
  })
})

test('校验⑤：还有别的活跃任务时拒绝续派，并列出是哪几条', async () => {
  await withSettledTask(async ({ d, launchTool, task }) => {
    d.table.add(mkTask('t-busy', `${WORKER_PREFIX}t-busy`, 'running'))
    await assert.rejects(
      () => call(launchTool, { title: 'x', brief: 'y', continue_task_id: task.id }),
      /还有 1 个活跃任务[\s\S]*t-busy（running）/,
      '拒绝时要指名道姓，否则用户只能一条条去数',
    )
  })
})

test('校验⑤：只有**目标自己**活跃时不算「别的活跃任务」（同一任务续派两次是允许的）', async () => {
  await withSettledTask(async ({ launchTool, task }) => {
    await call(launchTool, { title: '第一句', brief: 'a', continue_task_id: task.id })
    assert.equal(task.status, 'running')
    await call(launchTool, { title: '第二句', brief: 'b', continue_task_id: task.id })
    assert.equal(task.status, 'running', '同一条任务的连续续派不该被自己挡住')
  })
})

test('校验：title 与 brief 都为空 → 拒绝（否则 worker 收到一条没有要求的消息）', async () => {
  await withSettledTask(async ({ launchTool, task }) => {
    await assert.rejects(
      () => call(launchTool, { title: '   ', brief: '', continue_task_id: task.id }),
      /需要 title 或 brief 说明这次要做什么/,
    )
  })
})

test('续派不能复活已取消的任务（转发路径继承 message() 的这条规矩）', async () => {
  await withSettledTask(async ({ launchTool, task }) => {
    task.status = 'cancelled'
    await assert.rejects(
      () => call(launchTool, { title: 'x', brief: 'y', continue_task_id: task.id }),
      /已取消/,
    )
  })
})

// ---------------------------------------------------------------- §七.6 可回滚

test('§七.6 可回滚：不传 continue_task_id 时照常新建一条独立任务（旧行为零变化）', async () => {
  await withSettledTask(async ({ d, launchTool, task }) => {
    const before = d.table.tasks.size
    const value = await call(launchTool, { title: '新任务', brief: '完全独立' })

    assert.equal(d.table.tasks.size, before + 1, '不传参数就是新派一个任务（回滚保证）')
    assert.notEqual(value.task.task_id, task.id)
    assert.equal(value.continued, undefined, '非续派的返回值里不该出现 continued')
    assert.match(value.note, /已入队/, '非续派的 note 必须与旧版逐字一致')
    const fresh = d.table.get(value.task.task_id)
    assert.equal(fresh.workerSessionId, `${WORKER_PREFIX}${fresh.id}`, '新任务的会话 id 形状不变')
    assert.equal(task.status, 'done', '老任务不受影响')
  })
})

test('isWorkerSessionId：前缀判据的边界（空、裸前缀、别的会话形状）', () => {
  assert.equal(isWorkerSessionId(`${WORKER_PREFIX}t-abc`), true)
  assert.equal(isWorkerSessionId(`${WORKER_PREFIX}t-abc-a2`), true, 'retry 换 attempt 的会话也算本插件建的')
  assert.equal(isWorkerSessionId(WORKER_PREFIX), false, '裸前缀不是任何合法会话')
  assert.equal(isWorkerSessionId(''), false)
  assert.equal(isWorkerSessionId(undefined), false)
  assert.equal(isWorkerSessionId('session-manual'), false)
  assert.equal(isWorkerSessionId(' dispatch-t-abc '), true, '两侧空白的粘贴输入宽容一点')
})
