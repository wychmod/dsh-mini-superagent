/**
 * A2：工具面补齐 `plan` / `depends_on`（PRD §6）的回归测试。
 *
 * 这个文件逐条对应 PRD §6.7 的验收标准与 §6.5 的边界表，并且**走真实的工具入口**
 * （`toolDefinitions()` → `dispatch_inspect` / `dispatch_list`），而不是直接调
 * `card()` / `detail()`：要钉住的恰恰是「调用方能不能从工具里读到」，只测投影函数
 * 会漏掉工具层漏传参、返回包装之类的问题。
 *
 * 其中两条是 PRD 点名的坑：
 * - `dispatch_list` 的任何一条都**不能**有 `plan`（`card()` 同时服务 list 与 inspect，
 *   误放进去会让列表返回体膨胀数倍）；
 * - 字段名必须与 `boardTask()` 逐字一致（snake_case），不能出现 `dependsOn` /
 *   `blockedBy` 这类驼峰别名形成第二套口径。
 *
 * 全部离线：假宿主 + 临时状态目录（mkdtemp），不联网、不碰真实 `~/.dsh`。
 * 时间类行为不需要等真实定时器：状态直接由 `settle()` / 账本字段驱动。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BLOCK_REASONS, CANCEL_REASONS, ERROR_CODES } from '../src/constants.js'
import { boardTask } from '../src/board.js'
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
      async resolveAgent(id) {
        return agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'not-found' } }
      },
      async prompt() {},
      async state() { return { sessionId: 'x' } },
      async list() { return { items: [] } },
    },
  }
  return { ctx, agents }
}

function makeWorker(id) {
  return {
    id,
    status: 'idle',
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    cancel() {}, steer() {}, followup() {}, inject() {},
  }
}

/**
 * 驱动真实 `Dispatch` + 真实工具定义。
 *
 * 与 `batch-dependencies.test.js` 的夹具同构，但只保留本文件需要的部分：
 * `launch()` 拿到任务对象，`inspect()` / `list()` 直接走工具执行（带调用者），
 * 这样断言读到的就是调用方真正会看到的形状。
 */
async function withDispatch(fn, config = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-a2-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    noticeMergeWindowMs: 0,
    ...config,
  })
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
      const agent = makeWorker(sessionId)
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  // 主会话必须在场：`dispatch_inspect` 的归属校验看 `parentSessionId`。
  host.agents.set('lead', makeWorker('lead'))
  const tools = Object.fromEntries(toolDefinitions(d).map(item => [item.name, item]))
  const call = (tool, args) => tool.execute(args, { agent: { id: 'lead' } })
  // 注意：工具的入参是 snake_case（`depends_on`），与账本字段（`dependsOn`）不同层，
  // 这正是本文件要钉住的「投影层只认 snake_case」的一部分。
  const launch = async (args) => {
    const result = await call(tools.dispatch_launch, args)
    return d.table.get(result.task.task_id)
  }
  const inspect = async id => (await call(tools.dispatch_inspect, { task_id: id })).task
  const list = () => call(tools.dispatch_list, {})
  try {
    await fn({ d, host, dir, tools, call, launch, inspect, list })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function drain(times = 8) {
  for (let index = 0; index < times; index += 1) await tick()
}

/** 一份 5 步计划：状态刻意覆盖 done / doing / pending 三种。 */
const FIVE_STEPS = [
  { text: '读规格与现有投影', status: 'done' },
  { text: '改 card 与 detail', status: 'done' },
  { text: '补回归测试', status: 'doing' },
  { text: '跑 npm test / npm run check', status: 'pending' },
  { text: '写汇报', status: 'pending' },
]

// ---------------------------------------------------------------- §6.7 验收

test('验收 1：5 步计划在 dispatch_inspect 里逐项可读，status 与账本一致', async () => {
  await withDispatch(async ({ launch, inspect }) => {
    const task = await launch({ title: '计划任务', brief: 'b' })
    task.plan = FIVE_STEPS

    const detail = await inspect(task.id)
    assert.equal(Array.isArray(detail.plan), true, 'detail 必须投影 plan 数组')
    assert.equal(detail.plan.length, 5)
    assert.deepEqual(detail.plan, FIVE_STEPS, '逐项（text + status）与账本完全一致，不是只对长度')
    assert.deepEqual(detail.plan.map(step => step.status), ['done', 'done', 'doing', 'pending', 'pending'])
  })
})

test('验收 2：dispatch_list 的每一条都不含 plan 键（PRD §6.8 点名的坑）', async () => {
  await withDispatch(async ({ launch, inspect, list }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    const b = await launch({ title: 'B', brief: 'b' })
    a.plan = FIVE_STEPS
    b.plan = FIVE_STEPS

    const listed = await list()
    assert.ok(listed.tasks.length >= 2, '至少两条任务才谈得上「任意一条」')
    for (const card of listed.tasks) {
      assert.equal(Object.hasOwn(card, 'plan'), false, `dispatch_list 的 ${card.task_id} 不应有 plan`)
      assert.equal('plan' in card, false)
    }
    // 反向确认：同一条任务在详情里**有** plan。否则「列表没有 plan」可能只是这个键
    // 根本没被投影过，测试会假的绿。
    assert.equal((await inspect(a.id)).plan.length, 5, '详情里必须有 plan，否则上面那条断言没有意义')
  })
})

test('验收 3：有前置时 depends_on / blocked_by 都有，字段名与看板逐字相同', async () => {
  await withDispatch(async ({ launch, inspect }) => {
    const a = await launch({ title: 'A', brief: 'a' })
    const b = await launch({ title: 'B', brief: 'b', depends_on: [a.id] })
    await drain()

    const detail = await inspect(b.id)
    // 值：工具面给数组（PRD §6.3 字段表），看板给标量；第 0 项是同一事实。
    assert.deepEqual(detail.depends_on, [a.id])
    assert.deepEqual(detail.blocked_by, [a.id], '前置没结算时 blocked_by 要有它')
    assert.equal(detail.blocked_reason, BLOCK_REASONS.RUNNING)

    // 与看板对账：字段名逐字一致，值是同一事实（不是两套各自算出来的结果）。
    const board = boardTask(b)
    assert.deepEqual(detail.depends_on, board.depends_on)
    assert.equal(detail.blocked_by[0], board.blocked_by)
    assert.equal(detail.blocked_reason, board.blocked_reason)

    // 没有驼峰别名：出现第二套拼写就是 PRD §6.3 明令禁止的口径分裂。
    for (const shaped of [detail, board]) {
      assert.equal(Object.hasOwn(shaped, 'dependsOn'), false)
      assert.equal(Object.hasOwn(shaped, 'blockedBy'), false)
    }
  })
})

test('验收 4：无依赖任务的 depends_on 是 []（不是缺字段）', async () => {
  await withDispatch(async ({ launch, inspect, list }) => {
    const plain = await launch({ title: '独立任务', brief: 'b' })

    const detail = await inspect(plain.id)
    assert.equal(Object.hasOwn(detail, 'depends_on'), true, 'depends_on 必须恒定出现在返回体里')
    assert.deepEqual(detail.depends_on, [], '[] 表示「已检查且没有依赖」')

    const listed = await list()
    const card = listed.tasks.find(item => item.task_id === plain.id)
    assert.deepEqual(card.depends_on, [], '列表里的口径与详情一致')
    assert.equal('blocked_by' in card, false, '没有挡路的前置时 blocked_by 按「空值不输出」省略')
  })
})

test('验收 5：已结算任务仍能从 dispatch_inspect 读到 plan', async () => {
  await withDispatch(async ({ d, launch, inspect }) => {
    const task = await launch({ title: '会结算的任务', brief: 'b' })
    task.plan = FIVE_STEPS
    d.settle(task, 'done')
    await drain()

    const detail = await inspect(task.id)
    assert.equal(detail.status, 'done')
    assert.equal(detail.plan.length, 5, '看板不发 plan_* 是省轮询带宽，显式查询仍要给全量')
    assert.deepEqual(detail.plan, FIVE_STEPS)
  })
})

test('验收 6：退休任务调用 dispatch_inspect 不抛错（没有 plan / dependsOn 也不伪造）', async () => {
  await withDispatch(async ({ d, tools, call }) => {
    d.retired.set('t-retired-a2', {
      id: 't-retired-a2',
      title: '已退休任务',
      status: 'done',
      parentSessionId: 'lead',
      workerSessionId: 'dispatch-t-retired-a2',
      retiredAt: '2026-11-12T00:00:00.000Z',
      retiredReason: 'cap-count',
      summary: '最后一条摘要',
    })

    const result = await call(tools.dispatch_inspect, { task_id: 't-retired-a2' })
    assert.equal(result.retired, true)
    assert.equal(result.task.retired_reason, 'cap-count')
    // 退休记录没有计划：按空计划处理，不输出半成品键，也不抛错。
    assert.equal('plan' in result.task, false)
    assert.deepEqual(result.task.depends_on, [], 'depends_on 例外：没有也要给 []')
    assert.equal('blocked_by' in result.task, false)
  })
})

test('验收 7：docs/tools.md 不再让调用方去读 tasks.json', async () => {
  const doc = await readFile(new URL('../docs/tools.md', import.meta.url), 'utf8')
  assert.equal(/tasks\.json/.test(doc), false, '完整计划改走 dispatch_inspect，不应再指向账本文件')
  assert.match(doc, /dispatch_inspect/, '要指到能被调用的工具上')
  assert.match(doc, /`plan`/, '要写明读的是 plan 字段')
})

// ---------------------------------------------------------------- §6.5 边界

test('边界：task.plan 非数组 / 步骤缺 text → 按空计划处理，不输出 plan', async () => {
  await withDispatch(async ({ d, launch, inspect }) => {
    const task = await launch({ title: '坏计划', brief: 'b' })

    task.plan = 'not-an-array'
    assert.equal('plan' in await inspect(task.id), false, '非数组不能让 inspect 抛错或输出假计划')

    // 步骤缺 text：不输出「半份计划」——那会让「这步本来就没文案」与「账本坏了」
    // 长得一样，两种事实必须可区分。
    task.plan = [{ text: '第一步', status: 'done' }, { status: 'pending' }]
    assert.equal('plan' in await inspect(task.id), false)

    // 空数组也视同没有计划。
    task.plan = []
    assert.equal('plan' in await inspect(task.id), false)

    // 正常的计划仍要能读回来：上面三次断言不能是因为整条投影坏了。
    task.plan = FIVE_STEPS
    assert.equal((await inspect(task.id)).plan.length, 5)
  })
})

test('边界：依赖指向已退休任务 → depends_on 照常返回 id，blocked_by 为空', async () => {
  await withDispatch(async ({ d, launch, inspect }) => {
    // 退休留痕 done = 前置已经做完、只是被移出计算（PRD-02 §4.3）。
    d.retired.set('t-retired-done', {
      id: 't-retired-done', status: 'done', parentSessionId: 'lead', retiredReason: 'cap-count',
    })
    const task = await launch({ title: '依赖退休前置', brief: 'b', depends_on: ['t-retired-done'] })
    await drain()

    const detail = await inspect(task.id)
    assert.deepEqual(detail.depends_on, ['t-retired-done'], '依赖边照常可读，不因为前置退休而消失')
    assert.equal('blocked_by' in detail, false, '它已经结算（done），不该再算「在等谁」')
    assert.equal(detail.status, 'running', 'done 的前置应当满足，任务能开跑')
  })
})

test('边界：计划被截断过 → 只返回存下来的部分，不额外标记', async () => {
  await withDispatch(async ({ launch, inspect }) => {
    const task = await launch({ title: '截断计划', brief: 'b' })
    // 入库上限就是 12 步（`DEFAULTS.maxPlanSteps`），这里直接摆一份满额的账本数据。
    task.plan = Array.from({ length: 12 }, (_, index) => ({ text: `第 ${index + 1} 步`, status: 'pending' }))

    const detail = await inspect(task.id)
    assert.equal(detail.plan.length, 12, '存下来多少就给多少，不再二次截断')
    // 截断标记只走报告回执的 `plan_truncated`，投影里不重复标记。
    assert.equal('plan_truncated' in detail, false)
    assert.equal('plan_truncated_to' in detail, false)
  })
})

test('边界：依赖排查字段只在出过这件事时出现（blocked_reason / cancel_reason / error_code）', async () => {
  await withDispatch(async ({ d, launch, inspect }) => {
    // 前置已失败 → 后继被连带取消，账本记 cancelReason / errorCode。
    const dead = await launch({ title: '会失败的前置', brief: 'b' })
    d.settle(dead, 'failed')
    const successor = await launch({ title: '后继', brief: 'b', depends_on: [dead.id] })
    await drain()

    const detail = await inspect(successor.id)
    assert.equal(detail.status, 'cancelled')
    assert.equal(detail.cancel_reason, CANCEL_REASONS.DEPENDENCY_FAILED)
    assert.equal(detail.error_code, ERROR_CODES.DEPENDENCY_FAILED)
    assert.ok(detail.blocked_reason, '被前置挡住的原因要能看到')
    assert.ok(Array.isArray(detail.blocked_by) && detail.blocked_by.length === 1)

    // 一条从来没有依赖问题的任务：这三个键都不出现（空值不输出）。
    const plain = await launch({ title: '干净任务', brief: 'b' })
    const clean = await inspect(plain.id)
    assert.equal('blocked_reason' in clean, false)
    assert.equal('cancel_reason' in clean, false)
    assert.equal('error_code' in clean, false)
  })
})
