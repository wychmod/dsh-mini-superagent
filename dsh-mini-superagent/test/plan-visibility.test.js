/**
 * 任务级计划（`dispatch_report.plan`）的独立回归测试，逐条对应 PRD-01 §9 的验收口径。
 *
 * 这个文件只回答一件事：**计划从 worker 传进来之后，到底落在哪、怎么读、什么时候该拒**。
 * 所以每条断言都钉一个可观测事实（`task.plan` / `boardTask()` / 返回值 / 投递文本），
 * 不写「看起来对」的快照断言。
 *
 * 覆盖的验收点：
 * 1. `progress` 带计划 → 落到 `task.plan`，**不写进 report entry**（`MAX_REPORTS = 50` 的体积约束）；
 * 2. 没带 `plan` 的报告不改已有计划（避免「只报结果」把计划清空）；
 * 3. 整版替换（允许缩减），不做增量合并；
 * 4. 终态报告先应用再结算，结算后任何计划更新都被冻结；
 * 5. 20 步 / 单步 500 字 → 截到 12 步 / 120 字，返回 `plan_truncated:true`；
 * 6. 旧账本没有 `plan` → 看板不显示、不报错；
 * 7. 计划随账本恢复（用 `restore()` 模拟重启），且**不进入投递路径**；
 * 8. `#applyPlan` 幂等：同内容不刷新 `planUpdatedAt`。
 *
 * 全部离线：假宿主 + 临时状态目录（mkdtemp），不联网、不碰真实 `~/.dsh`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { boardTask } from '../src/board.js'
import { DEFAULTS, MAX_REPORTS } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { writeState } from '../src/store.js'

// ---------------------------------------------------------------- 夹具

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()

function makeHost() {
  const agents = new Map()
  const deliveries = []
  return {
    agents,
    deliveries,
    ctx: {
      logger: { warn() {}, info() {}, error() {} },
      // 宿主服务一律缺席：`handOffToBackground()` 会把「没有 jobs 服务」当成没有后台活。
      get: () => undefined,
      on: () => () => {},
      effect: fn => fn,
      agents: { get: id => agents.get(id), list: () => [...agents.values()] },
      sessionController: {
        async create() {},
        async rename() {},
        async resolveAgent() { return { error: { code: 'not-found' } } },
        async prompt() {},
      },
    },
  }
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
  id: 't-plan',
  title: '改 5 个文件',
  brief: 'b',
  parentSessionId: 'lead',
  workerSessionId: 'dispatch-t-plan',
  status: 'running',
  reports: [],
  createdAt: iso(60_000),
  updatedAt: iso(30_000),
  ...extra,
})

const twoSteps = () => [
  { text: '改 tools.js 参数', status: 'done' },
  { text: '补 dispatch 单测', status: 'doing' },
]

async function withDispatch(config, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-plan-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
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
      const agent = makeAgent(sessionId)
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver(sessionId, requestId, text) {
      host.deliveries.push({ sessionId, requestId, text })
      return { delivered: 'inbox', woke: false }
    },
  }
  try {
    await fn({ d, host, dir })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 落库与替换

test('progress 带 plan：只写 task.plan，不写进每条 report entry', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    const result = await d.report(worker, {
      status: 'progress',
      summary: '接口层做完了',
      plan: twoSteps(),
    })

    assert.deepEqual(task.plan, twoSteps(), '计划要整版落在一处')
    assert.equal(result.plan_accepted, true)
    assert.equal(result.plan_truncated, false)
    assert.equal(task.reports.length, 1)
    assert.equal(task.reports[0].plan, undefined, '条目里不能带计划：50 条 × 12 步会把账本放大')
    // 计数从计划现算，不额外存冗余字段：看板侧只要最新一版。
    const shaped = boardTask(task)
    assert.equal(shaped.plan_total, 2)
    assert.equal(shaped.plan_done, 1)
    assert.equal(shaped.plan_current, '补 dispatch 单测')
  })
})

test('没带 plan 的报告不改变已有计划（「只报结果」不能把计划清空）', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    const first = await d.report(worker, { status: 'progress', summary: '有进度', plan: twoSteps() })
    const stamp = task.planUpdatedAt
    assert.equal(first.plan_accepted, true)

    const second = await d.report(worker, { status: 'progress', summary: '只报个结果' })
    assert.deepEqual(task.plan, twoSteps(), '计划必须原样保留')
    assert.equal(task.planUpdatedAt, stamp, '幂等：没传 plan 不刷新计划时间')
    assert.equal(second.plan_accepted, false, '本条没有计划被接受，但也不等于清空')
  })
})

test('整版替换：worker 可以把 5 步缩成 3 步，计数跟着变', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    await d.report(worker, {
      status: 'progress',
      summary: '起步',
      plan: [
        { text: 'a', status: 'done' },
        { text: 'b', status: 'done' },
        { text: 'c', status: 'doing' },
        { text: 'd', status: 'pending' },
        { text: 'e', status: 'pending' },
      ],
    })
    assert.equal(boardTask(task).plan_total, 5)

    const result = await d.report(worker, {
      status: 'progress',
      summary: '计划缩了',
      plan: [
        { text: 'a', status: 'done' },
        { text: 'b', status: 'done' },
        { text: 'c', status: 'doing' },
      ],
    })

    assert.equal(result.plan_accepted, true)
    assert.equal(task.plan.length, 3, '整版替换，不是增量合并')
    assert.equal(boardTask(task).plan_total, 3)
    assert.equal(boardTask(task).plan_done, 2)
  })
})

test('终态报告带 plan：先应用再结算；结算后计划冻结，迟到的计划返回 plan_accepted:false', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    const done = await d.report(worker, {
      status: 'done',
      summary: '做完了',
      plan: [
        { text: 'a', status: 'done' },
        { text: 'b', status: 'done' },
      ],
    })

    assert.equal(task.status, 'done')
    assert.equal(done.plan_accepted, true, '终态报告自己的计划必须先应用')
    assert.equal(task.plan.length, 2)
    // 终态优先：看板不再下发计划标量，行上不会出现「2/2」。
    assert.equal(boardTask(task).plan_total, undefined)

    const late = await d.report(worker, {
      status: 'progress',
      summary: '补一条进度',
      plan: [{ text: '偷偷改计划', status: 'doing' }],
    })

    assert.equal(late.plan_accepted, false, '结算后冻结')
    assert.equal(task.status, 'done', '迟到的 progress 不能把任务改回 running')
    assert.deepEqual(task.plan.map(step => step.text), ['a', 'b'], '账本里的计划不能被写回去')
  })
})

// ---------------------------------------------------------------- 上限与清洗

test('超限：20 步 × 500 字 → 12 步 × ≤120 字，返回 plan_truncated:true，不报错', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    // 每步文案带独立前缀，避免命中「完全相同文案只留 3 条」的清洗规则。
    const plan = Array.from({ length: 20 }, (_, index) => ({ text: `step-${index}-` + '长'.repeat(500), status: 'pending' }))
    const result = await d.report(worker, { status: 'progress', summary: '计划很长', plan })

    assert.equal(result.plan_accepted, true)
    assert.equal(result.plan_truncated, true)
    assert.equal(task.plan.length, DEFAULTS.maxPlanSteps)
    for (const step of task.plan) {
      assert.ok(Array.from(step.text).length <= DEFAULTS.maxPlanStepChars, '单步文案超限')
    }
    assert.equal(task.plan[0].status, 'pending', '缺省状态按 pending')
  })
})

test('重复文案超过 3 次只保留前 3 条；不从中间去重', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    await d.report(worker, {
      status: 'progress',
      summary: '有重复',
      plan: [
        { text: '跑全量测试', status: 'pending' },
        { text: '跑全量测试', status: 'pending' },
        { text: '跑全量测试', status: 'pending' },
        { text: '跑全量测试', status: 'pending' },
        { text: '写文档', status: 'pending' },
      ],
    })

    assert.deepEqual(task.plan.map(step => step.text), ['跑全量测试', '跑全量测试', '跑全量测试', '写文档'])
  })
})

test('空文案丢弃；全空视同没传（保持已有计划不变）', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    await d.report(worker, { status: 'progress', summary: '先有计划', plan: twoSteps() })
    const before = structuredClone(task.plan)

    const allEmpty = await d.report(worker, {
      status: 'progress',
      summary: '计划都是空的',
      plan: [{ text: '   ', status: 'done' }, { text: '', status: 'doing' }, {}],
    })
    assert.equal(allEmpty.plan_accepted, false)
    assert.deepEqual(task.plan, before, '全空视同没传，不能把计划清空')

    const mixed = await d.report(worker, {
      status: 'progress',
      summary: '只有一条有效',
      plan: [{ text: '  ', status: 'done' }, { text: ' 有效步骤 ', status: 'doing' }],
    })
    assert.equal(mixed.plan_accepted, true)
    assert.deepEqual(task.plan, [{ text: '有效步骤', status: 'doing' }], '空文案丢弃、首尾空白清掉')
  })
})

test('plan_current：doing 优先，没有 doing 取第一条 pending，全 done 为空串', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    await d.report(worker, {
      status: 'progress',
      summary: '一',
      plan: [
        { text: 'a', status: 'done' },
        { text: 'b', status: 'pending' },
        { text: 'c', status: 'pending' },
      ],
    })
    assert.equal(boardTask(task).plan_current, 'b')

    await d.report(worker, {
      status: 'progress',
      summary: '二',
      plan: [
        { text: 'a', status: 'done' },
        { text: 'b', status: 'done' },
      ],
    })
    const allDone = boardTask(task)
    assert.equal(allDone.plan_total, 2)
    assert.equal(allDone.plan_done, 2)
    assert.equal(allDone.plan_current, '', '全 done 时当前步骤是空串，不编文案')
  })
})

// ---------------------------------------------------------------- 幂等、恢复与投递路径

test('幂等：同内容重复上报不刷新 planUpdatedAt', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    await d.report(worker, { status: 'progress', summary: '一', plan: twoSteps() })
    // 人为把时间戳退到过去：若幂等失效，第二次上报会把它刷成现在。
    task.planUpdatedAt = '2020-01-01T00:00:00.000Z'
    const result = await d.report(worker, { status: 'progress', summary: '重投同一版', plan: twoSteps() })

    assert.equal(result.plan_accepted, true, '幂等命中仍算接受')
    assert.equal(task.planUpdatedAt, '2020-01-01T00:00:00.000Z', '内容相同不能刷新计划时间')
  })
})

test('计划不进入投递路径：progress 回流文本里没有步骤文案', async () => {
  // 把 progress 配成直通，逼它走真实投影 + 投递链路；计划仍然不能出现在消息里。
  await withDispatch({ directReportStatuses: ['progress'], noticeMergeWindowMs: 0 }, async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    const result = await d.report(worker, {
      status: 'progress',
      summary: '过程报告',
      plan: [{ text: '只该出现在账本里的步骤', status: 'doing' }],
    })

    assert.equal(result.plan_accepted, true)
    const texts = host.deliveries.map(item => item.text).join('\n')
    assert.ok(texts.length > 0, '前提：这条 progress 应该真的被投递')
    assert.ok(!texts.includes('只该出现在账本里的步骤'), '计划只改账本，不能进会话消息')
    assert.ok(!texts.includes('"plan"'), '投递文本里不该出现计划字段（任务 id 里的 plan 不算）')
  })
})

test('计划随账本恢复：restore() 之后 task.plan / planUpdatedAt 仍在', async () => {
  await withDispatch({}, async ({ d }) => {
    const task = workerTask({
      status: 'queued',
      startedAt: undefined,
      plan: twoSteps(),
      planUpdatedAt: '2020-01-01T00:00:00.000Z',
    })
    await writeState(d.stateFile, { tasks: [task], targets: {}, retired: [] }, iso())
    await d.restore()

    const restored = d.table.tasks.get(task.id)
    assert.ok(restored, '恢复后应能找到这条任务')
    assert.deepEqual(restored.plan, twoSteps(), '计划必须随任务原样读回')
    assert.equal(restored.planUpdatedAt, '2020-01-01T00:00:00.000Z')
    // queued 且从没启动过：恢复时留在队列里，看板仍能看到计划（重启后仍在）。
    assert.equal(restored.status, 'queued')
    assert.equal(boardTask(restored).plan_total, 2)
  })
})

test('旧账本没有 plan：看板不显示、不报错、不出现 undefined', async () => {
  await withDispatch({}, async ({ d }) => {
    const task = workerTask({ id: 't-old', workerSessionId: 'dispatch-t-old', status: 'running' })
    await writeState(d.stateFile, { tasks: [task], targets: {}, retired: [] }, iso())
    await d.restore()

    const restored = d.table.tasks.get('t-old')
    assert.ok(restored, '旧账本必须能恢复')
    const shaped = boardTask(restored)
    assert.equal(shaped.plan_total, undefined)
    assert.equal(shaped.plan_done, undefined)
    assert.equal(shaped.plan_current, undefined)
    assert.ok(!JSON.stringify(shaped).includes('undefined'))
  })
})

test('report entry 数量上限不受计划影响：50 条后仍只有一版计划', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const worker = makeAgent('dispatch-t-plan')
    host.agents.set(worker.id, worker)
    const task = workerTask()
    d.table.add(task)

    for (let index = 0; index < MAX_REPORTS + 3; index += 1) {
      await d.report(worker, {
        status: 'progress',
        summary: `第 ${index} 条`,
        plan: twoSteps(),
      })
    }

    assert.equal(task.reports.length, MAX_REPORTS, '报告条数仍按 MAX_REPORTS 封顶')
    assert.equal(task.plan.length, 2, '计划只有最新一版，不随报告条数增长')
    assert.equal(task.reports.some(entry => entry.plan !== undefined), false)
  })
})
