/**
 * 派发记忆治理（P0 五项）的**独立**回归测试，逐条对应 `plans/07-memory-governance.md` §七。
 *
 * 这个文件不重复已有用例（`test/p0-regression.test.js` 守状态机/落盘，`test/board.test.js`
 * 守看板投影，`test/recovery.test.js` 守恢复与节流）。它只回答一件事：
 * **治理的每一条承诺，在真实代码上有没有可观测的信号**。所以每条都配一个能对账的读数，
 * 不写「看起来对」的断言：
 *
 * - 验收 1 消息条数：一次派发 + 一次收尾，回流给主会话的插件消息 ≤ 3 条；progress 默认 0 条。
 *   钉的缺陷是「每任务 50 条报告 + 终态/进度混在一条流里」，主会话上下文随时长线性膨胀。
 * - 验收 2 不重复：同一任务 60 秒内未消费通知 ≤ 1 条；整轮投递里重复 message id 计数 = 0。
 *   钉的缺陷是「重试换新 id → 同一份报告投两遍」与「progress 每步刷屏」。
 * - 验收 3 不再投票：归档/退休任务必须离开活表，指标口径只拿到活表。
 *   钉的缺陷是「上个月失败的任务仍在给今天的成功率投票」。
 * - 验收 4 有上界：活表条数压回 `ledgerMaxTasks`；每条退休记录带 `retiredAt` / `retiredReason`。
 *   钉的缺陷是「任务表只增不减，写放大无上界」。
 * - 验收 5 不残留：会话销毁只清 targets 不删任务；`inputPendingAt` 超 TTL 降级成 `inputUnknownAt`。
 *   钉的缺陷是「孤儿目标重启后复活」与「永远显示待读」。
 * - 验收 6 自检一致：`selfCheck().memory` 的每个数与直接遍历账本算出的值逐个相等。
 *   钉的缺陷是「自检说一套、账本存另一套」——口径分裂时自检就失去全部价值。
 * - 验收 7 守恒：活表 + 退休留痕 = 全量事实，不重复计数，落盘重启后仍成立。
 * - 验收 8 不变量：`report()` 不删已有报告条目（只截字段、只受 `MAX_REPORTS` 约束）。
 *   钉的缺陷是「治理误变成删历史」——模型可见即已记录，能做的只有写入前与投影前。
 *
 * 全部离线：假宿主 + 临时状态目录（mkdtemp），不联网、不碰真实 `~/.dsh`。
 * 时间类断言一律直接改任务字段（`inputPendingAt` / `updatedAt`），不等真实定时器。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_REPORTS, RETIRED_REASONS } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'

// ---------------------------------------------------------------- 夹具

/** 相对现在的时间串。所有「多久以前」都由调用方显式给，不用真实等待。 */
const iso = msAgo => new Date(Date.now() - msAgo).toISOString()

function makeHost() {
  const agents = new Map()
  /** 每一次真实投递（= 会话里新增的一条插件来源 user/message）。 */
  const deliveries = []
  /** 投递重试前的判重查询（见 #deliverWithRetry）。 */
  const holdsCalls = []
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
      // selfCheck 的探针：宿主没有 state 时退回 list。这里两者都给，且都不激活 Agent。
      async state() { throw Object.assign(new Error('not found'), { code: 'not-found' }) },
      async list() { return { items: [] } },
      async prompt() {},
    },
  }
  return { ctx, agents, deliveries, holdsCalls }
}

function makeAgent(id, status = 'running', events = []) {
  return {
    id,
    status,
    session: { snapshotEvents: () => events, header: {} },
    ctx: { systemPrompt: { section: () => () => {} } },
    steer() {}, followup() {}, inject() {}, cancel() {},
  }
}

/** 把 Dispatch 的两个网关换成桩：不碰真实工作区注册表与 sessionController。 */
function stubGateways(d, host, dir) {
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
      // 一次 deliver = 会话里新增一条**插件来源**的 user/message。
      // 真实网关会补 `${SOURCE_KIND}:` 前缀，这里原样记下调用方给的 id，
      // 断言的是「同一个 requestId 有没有被复用」，前缀不影响这个判据。
      host.deliveries.push({ sessionId, requestId, text })
      return { delivered: 'inbox', woke: false }
    },
  }
}

async function withDispatch(config, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-mem-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    ...config,
  })
  stubGateways(d, host, dir)
  try {
    await fn({ d, host, dir })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/** 造一条任务记录；`updatedAt` 默认「30 秒前」，让「最老」有确定性。 */
function mkTask(id, status = 'done', extra = {}) {
  return {
    id,
    title: id,
    brief: 'b',
    parentSessionId: 'lead',
    workerSessionId: `dispatch-${id}`,
    status,
    reports: [],
    createdAt: iso(60_000),
    updatedAt: iso(30_000),
    ...extra,
  }
}

/** 某个会话收到的插件消息。 */
const deliveredTo = (host, sessionId) => host.deliveries.filter(item => item.sessionId === sessionId)

/** 等一个异步条件成立（只用于等 pump 的微任务，不是时间语义的等待）。 */
async function waitFor(label, probe, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

/**
 * 验收 6 的对账函数：拿 `selfCheck().memory` 与**直接遍历账本**算出的数字逐个比。
 *
 * 为什么不逐字段写死数字：写死的数字只证明「今天恰好是 3」，而这个函数证明
 * 「自检的每一个数都等于账本的真实值」——口径以后怎么改，它都还把两边钉在一起。
 *
 * @returns {string[]} 差异清单；空数组 = 完全对账
 */
function reconcile(d, memory) {
  const tasks = [...d.table.tasks.values()]
  const retired = [...d.retired.values()]
  const pendingInputs = tasks.filter(task => task.inputPendingAt && !task.inputReadAt).length
  const unknownInputs = tasks.filter(task => !(task.inputPendingAt && !task.inputReadAt)
    && task.inputUnknownAt && !task.inputReadAt).length
  const latestRetiredAt = retired.length
    ? retired.map(record => String(record.retiredAt ?? '')).sort().at(-1)
    : null

  const checks = [
    ['ledger.tasks', memory?.ledger?.tasks, d.table.tasks.size],
    ['ledger.retired', memory?.ledger?.retired, d.retired.size],
    ['ledger.archived', memory?.ledger?.archived, tasks.filter(task => !!task.archivedAt).length],
    ['ledger.retiredDropped', memory?.ledger?.retiredDropped, d.retiredDropped],
    ['admission.direct', memory?.admission?.direct, d.admissionCounts.direct],
    ['admission.ledger', memory?.admission?.ledger, d.admissionCounts.ledger],
    ['pending.inputs', memory?.pending?.inputs, pendingInputs],
    ['pending.unknown', memory?.pending?.unknown, unknownInputs],
    ['retired.count', memory?.retired?.count, d.retired.size],
    ['retired.latestAt', memory?.retired?.latestAt, latestRetiredAt],
    ['window.days', memory?.window?.days, Number(d.config.memoryWindowDays)],
    ['window.tasks', memory?.window?.tasks, Number(d.config.memoryWindowTasks)],
  ]

  const problems = []
  for (const [name, actual, expected] of checks) {
    if (actual !== expected) {
      problems.push(`${name}: selfCheck=${JSON.stringify(actual)} 账本=${JSON.stringify(expected)}`)
    }
  }
  // 直通状态列表必须与 `admissionOf()` 读同一份来源，否则「自检说直通什么」与
  // 「实际直通什么」会各说各话。
  if (JSON.stringify(memory?.admission?.directStatuses) !== JSON.stringify(d.directStatuses())) {
    problems.push(`admission.directStatuses: selfCheck=${JSON.stringify(memory?.admission?.directStatuses)} `
      + `实际=${JSON.stringify(d.directStatuses())}`)
  }
  return problems
}

const leadDeliveries = host => deliveredTo(host, 'lead')

// ---------------------------------------------------------------- 验收 1：消息条数

test('验收1 消息条数：一次派发 + 一次收尾，主会话只多 1 条插件消息（progress 默认 0 条）', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = await d.launch(host.agents.get('lead'), { title: '一次派发', brief: '做一件小事' })
    await waitFor('任务启动', () => host.agents.has(task.workerSessionId))
    const worker = host.agents.get(task.workerSessionId)

    // 过程信息：progress 默认只入库，不回流。
    await d.report(worker, { status: 'progress', summary: '第一步' })
    const beforeClose = leadDeliveries(host)
    assert.equal(beforeClose.length, 0, 'progress 默认不该在主会话里留下任何消息（P0-2 准入分级）')

    // 收尾：done 恒直通。
    const closing = await d.report(worker, { status: 'done', summary: '做完了' })
    assert.equal(closing.admission, 'direct')

    const inLead = leadDeliveries(host)
    assert.ok(inLead.length <= 3,
      `一次派发 + 一次收尾最多 3 条插件消息，实际 ${inLead.length} 条：`
      + JSON.stringify(inLead.map(item => item.text.slice(0, 40))))
    assert.equal(inLead.length, 1, '默认配置下只有终态那一条会回流')
    assert.match(inLead[0].text, /做完了/)

    // 派发简报发给 worker，不算主会话的历史消息。
    assert.equal(deliveredTo(host, task.workerSessionId).length, 1)
    assert.equal(host.deliveries.length, 2, '整轮只该有「简报 → worker」与「报告 → 主会话」两条投递')
    assert.deepEqual(d.admissionCounts, { direct: 1, ledger: 1 })
  })
})

// ---------------------------------------------------------------- 验收 2：不重复

test('验收2 不重复：同一任务 60 秒内第二条 progress 不回流（未消费通知 ≤ 1 条）', async () => {
  await withDispatch({
    progressRelayIntervalMs: 60_000,
    directReportStatuses: ['blocked', 'failed', 'progress'],
  }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-throttle', 'running')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running'))

    const first = await d.report(host.agents.get(task.workerSessionId), { status: 'progress', summary: '第一步' })
    const second = await d.report(host.agents.get(task.workerSessionId), { status: 'progress', summary: '第二步' })

    assert.equal(first.admission, 'direct', '这条用例显式放开了 progress，准入才可能是 direct')
    assert.equal(second.throttled, true, '一分钟内第二条 progress 不该再回流')
    assert.equal(leadDeliveries(host).length, 1, '同一任务 60 秒内的未消费通知最多 1 条')
    assert.equal(task.reports.length, 2, '被挡下的 progress 仍然入库，dispatch_inspect 看得到')
  })
})

test('验收2 不重复：一次完整回合里没有重复的 message id', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = await d.launch(host.agents.get('lead'), { title: '完整回合', brief: '做点事' })
    await waitFor('任务启动', () => host.agents.has(task.workerSessionId))
    const worker = host.agents.get(task.workerSessionId)

    await d.report(worker, { status: 'progress', summary: '进行中' })
    await d.report(worker, { status: 'done', summary: '完成' })
    await d.message(task, '再补一句', 'queue')

    // 宿主对同一 id 的待投递消息会直接抛「already pending」，所以重复 id 是硬缺陷。
    const keys = host.deliveries.map(item => `${item.sessionId}#${item.requestId}`)
    const duplicates = keys.length - new Set(keys).size
    assert.equal(duplicates, 0, `重复 message id 计数必须为 0，实际 ${duplicates}：${keys.join(' | ')}`)
    // 投递 id 带任务 id，重试时才追得回是哪条任务的报告。
    for (const item of host.deliveries) assert.ok(item.requestId.includes(task.id), `投递 id 应能追回任务：${item.requestId}`)
    // 简报投给 worker、报告投给主会话：两条投递落在两个不同会话上，没有一条重复。
    assert.deepEqual(new Set(host.deliveries.map(item => item.sessionId)),
      new Set([task.workerSessionId, 'lead']))
  })
})

test('验收2 不重复：报告重试复用同一个 id，已在会话里就不再投第二遍', async () => {
  await withDispatch({ relayRetryMs: [1] }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-retry', 'running')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running'))

    const tried = []
    let attempts = 0
    d.sessions.deliver = async (sessionId, requestId) => {
      attempts += 1
      tried.push(requestId)
      // 模拟「其实已经投进收件箱，只是后面抛错」——0.8.0 的重复报告正是这么来的。
      if (attempts === 1) throw new Error('收件箱暂时不可用')
      throw new Error('不该有第二次真实投递')
    }
    d.sessions.holds = (_agent, requestId) => {
      host.holdsCalls.push(requestId)
      return true
    }

    await d.report(host.agents.get(task.workerSessionId), { status: 'done', summary: '好了' })

    assert.equal(tried.length, 1, '第一次投递抛错后应先进 holds 判重，而不是直接重投')
    assert.equal(host.holdsCalls.length, 1)
    assert.equal(host.holdsCalls[0], tried[0], '重试必须复用同一个 requestId，否则主会话收到两条一样的报告')
    assert.equal(task.delivery.outcome, 'delivered', '判重命中应当记成已送达')
  })
})

// ---------------------------------------------------------------- 验收 3：不再投票

test('验收3 不再投票：归档与退休任务都移出活表，指标口径只拿到活表', async () => {
  await withDispatch({ ledgerMaxTasks: 2, ledgerMaxDays: 3650 }, async ({ d }) => {
    // 三条已结算事实：一条已归档、一条将被退休、一条保留。
    const archived = mkTask('t-arch', 'done', { archivedAt: iso(3_600_000), updatedAt: iso(3_600_000) })
    const oldest = mkTask('t-old', 'done', { updatedAt: iso(7_200_000) })
    const keep = mkTask('t-keep', 'done', { updatedAt: iso(60_000) })
    for (const task of [archived, oldest, keep]) d.table.add(task)

    const before = await d.memoryStats()
    assert.equal(before.ledger.tasks, 3)
    assert.equal(before.ledger.archived, 1, '归档是活表里的一个标记，不是另一份人口')
    assert.equal(before.ledger.retired, 0)

    // 封顶：归档优先退休。退休之后它既不在活表里，也不该再被算作「归档」。
    const capped = d.enforceLedgerCap()
    assert.equal(capped.retired, 1)
    assert.equal(capped.reasons[RETIRED_REASONS.CAP_COUNT], 1)

    const after = await d.memoryStats()
    assert.equal(after.ledger.tasks, 2, 'ledger.tasks 就是指标能看到的全部人口')
    assert.equal(after.ledger.archived, 0, '整体退休的归档任务不能继续被算成归档')
    assert.equal(after.ledger.retired, 1)
    assert.equal(d.table.tasks.has('t-arch'), false,
      '退休后不能再留在 Tasks 表里，否则它继续给成功率/中位耗时/并行节省投票')
    assert.equal(d.table.get('t-arch'), undefined)

    // 退休 ≠ 消失：仍可从退休留痕查回「它什么时候、为什么不见的」。
    const record = d.resolveTask('t-arch')
    assert.ok(record && d.isRetired(record), '退休记录必须仍可查询（dispatch_inspect 的契约）')
    assert.equal(record.retiredReason, RETIRED_REASONS.CAP_COUNT)
    assert.ok(Number.isFinite(Date.parse(record.retiredAt)))
    // 活表与留痕不重叠：同一个 id 不能既投票又可查。
    for (const id of d.retired.keys()) assert.equal(d.table.tasks.has(id), false, `${id} 不能同时在两处`)
  })
})

// ---------------------------------------------------------------- 验收 4：有上界

test('验收4 有上界：条数超 ledgerMaxTasks 时活表被压回上限，每条留痕带 retiredAt/retiredReason', async () => {
  const cap = 5
  await withDispatch({ ledgerMaxTasks: cap, ledgerMaxDays: 3650 }, async ({ d }) => {
    // 造 cap + 3 条已结算任务，updatedAt 递增（t-cap-0 最老）。
    for (let index = 0; index < cap + 3; index += 1) {
      d.table.add(mkTask(`t-cap-${index}`, 'done', { updatedAt: iso((cap + 3 - index) * 60_000) }))
    }
    assert.equal(d.table.tasks.size, cap + 3)

    const result = d.enforceLedgerCap()

    assert.equal(result.retired, 3)
    assert.ok(d.table.tasks.size <= cap, `活表条数必须 ≤ cap=${cap}，实际 ${d.table.tasks.size}`)
    assert.equal(d.table.tasks.size, cap)
    assert.equal(d.retired.size, 3)
    for (const record of d.retired.values()) {
      assert.ok(record.retiredAt, `${record.id} 的留痕必须带 retiredAt`)
      assert.ok(Number.isFinite(Date.parse(record.retiredAt)), `retiredAt 必须可解析：${record.retiredAt}`)
      assert.ok(Object.values(RETIRED_REASONS).includes(record.retiredReason),
        `retiredReason 必须属于 RETIRED_REASONS，实际 ${record.retiredReason}`)
      assert.equal(record.retiredReason, RETIRED_REASONS.CAP_COUNT)
    }
    // 退休的是最老的三条，最新的五条留下（按「最老的非活跃」而不是随便丢）。
    assert.deepEqual([...d.retired.keys()].sort(), ['t-cap-0', 't-cap-1', 't-cap-2'])
    for (let index = 3; index < cap + 3; index += 1) {
      assert.ok(d.table.tasks.has(`t-cap-${index}`), `t-cap-${index} 不该被退休`)
    }
    // 幂等：再判一次什么都不做。
    assert.equal(d.enforceLedgerCap().retired, 0)
  })
})

test('验收4 有上界：非活跃且超 ledgerMaxDays 的任务按 cap-days 退休（条数上限关闭时也生效）', async () => {
  await withDispatch({ ledgerMaxTasks: 0, ledgerMaxDays: 1 }, async ({ d }) => {
    const old = mkTask('t-stale-days', 'done', { updatedAt: iso(10 * 86_400_000) })
    const fresh = mkTask('t-fresh-days', 'done', { updatedAt: iso(60_000) })
    d.table.add(old)
    d.table.add(fresh)

    const result = d.enforceLedgerCap()

    assert.equal(result.reasons[RETIRED_REASONS.CAP_DAYS], 1)
    assert.ok(d.retired.has('t-stale-days'), '10 天没动过的非活跃任务必须按 cap-days 退休')
    assert.equal(d.retired.get('t-stale-days').retiredReason, RETIRED_REASONS.CAP_DAYS)
    assert.ok(d.table.tasks.has('t-fresh-days'), '新任务不能被天数判据误伤')
    assert.equal(d.table.tasks.size, 1, '条数上限配 0 = 关闭，只按天数治理')
  })
})

// ---------------------------------------------------------------- 验收 5：不残留

test('验收5 不残留：forgetTargets 只删 targets 不删任务，且幂等', async () => {
  await withDispatch({}, async ({ d, host, dir }) => {
    await d.setTarget('lead-1', 'auto')
    await d.setTarget('lead-2', 'auto')
    const task = mkTask('t-keep', 'done', { parentSessionId: 'lead-1' })
    d.table.add(task)
    host.agents.set('lead-1', makeAgent('lead-1', 'idle'))

    assert.equal(d.targets.size, 2)
    assert.equal(d.forgetTargets('lead-1'), true)

    assert.equal(d.targets.has('lead-1'), false, '会话销毁后不能留下孤儿目标（重启后会复活成有效设置）')
    assert.equal(d.targets.size, 1, '不能新增任何孤儿条目')
    assert.equal(d.targets.has('lead-2'), true, '别人的目标不能被误删')

    // 只删 targets，不删任务：任务属于账本，该由退休管，不归会话生命周期管。
    assert.ok(d.table.tasks.has('t-keep'), '会话没了不代表它派出过的任务不需要查了')
    assert.equal(d.resolveTask('t-keep'), task)
    assert.equal(d.resolveTask('t-keep').parentSessionId, 'lead-1')

    // 幂等 + 空 id 不误删。
    assert.equal(d.forgetTargets('lead-1'), false)
    assert.equal(d.forgetTargets(''), false)
    assert.equal(d.targets.size, 1)

    // 落盘里也不能再出现孤儿目标。
    await d.persist()
    const state = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'))
    assert.deepEqual(Object.keys(state.targets), ['lead-2'])
  })
})

test('验收5 不残留：inputPendingAt 超 TTL 后降级成 inputUnknownAt（不用真实定时器）', async () => {
  await withDispatch({ inputPendingTtlMs: 60_000 }, async ({ d }) => {
    // 直接改字段驱动时间：不 setTimeout 等 30 分钟，也不依赖宿主发 session/event。
    const stale = mkTask('t-stale-pending', 'running', { inputPendingAt: iso(120_000) })
    const fresh = mkTask('t-fresh-pending', 'running', { inputPendingAt: iso(1_000) })
    d.table.add(stale)
    d.table.add(fresh)

    const before = await d.memoryStats()
    assert.equal(before.pending.inputs, 2, '两条都还在 TTL 内/外混着，先确认口径')

    assert.equal(d.sweepMemory(), 1, '只有超 TTL 的那条该被清理')
    assert.equal(stale.inputPendingAt, undefined, '超时后不能继续挂着永久 pending')
    assert.ok(stale.inputUnknownAt, '超时后要降级成「不知道读没读到」，而不是假装读过')
    assert.equal(stale.inputReadAt, undefined, '不能伪造已读')
    assert.ok(fresh.inputPendingAt, 'TTL 内的待读标记必须保留')

    const after = await d.memoryStats()
    assert.equal(after.pending.inputs, 1)
    assert.equal(after.pending.unknown, 1)

    const card = d.card(stale)
    assert.equal(card.input_pending_at, undefined, 'unknown 之后卡片不再显示「已投递未读」')
    assert.ok(card.input_unknown_at, '仍要能从 input_unknown_at 看到曾经发生过什么')

    assert.equal(d.sweepMemory(), 0, '清扫必须幂等')
  })
})

// ---------------------------------------------------------------- 验收 6：自检一致

test('验收6 自检一致：selfCheck().memory 的每个数与账本对账为零差异', async () => {
  await withDispatch({ ledgerMaxDays: 1, ledgerMaxTasks: 1000 }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))

    // 活任务 1：跑着，有一条「已投递未读」。
    const live = mkTask('t-live', 'running', { inputPendingAt: iso(60_000) })
    d.table.add(live)
    host.agents.set(live.workerSessionId, makeAgent(live.workerSessionId, 'running'))
    // 活任务 2：已归档，输入状态已降级成 unknown。
    d.table.add(mkTask('t-arch', 'done', { archivedAt: iso(3_600_000), inputUnknownAt: iso(120_000) }))
    // 退休候选：非活跃且超过 1 天。
    d.table.add(mkTask('t-ret', 'done', { updatedAt: iso(10 * 86_400_000) }))

    // 真实跑两次准入，让 admissionCounts 也有非零值（对账不能只在全零上成立）。
    await d.report(host.agents.get(live.workerSessionId), { status: 'progress', summary: '进度' })
    await d.report(host.agents.get(live.workerSessionId), { status: 'done', summary: '收尾' })

    // 退休可能已经由前面 `report(done)` → `settle()` → `enforceLedgerCap()` 那次判过了，
    // 所以这里断言**最终状态**而不是某一次调用的返回值（幂等，谁先跑都算）。
    d.enforceLedgerCap()
    assert.equal(d.retired.size, 1, '退休必须真的发生，否则账本这一半是空的')
    assert.equal([...d.retired.values()][0].retiredReason, RETIRED_REASONS.CAP_DAYS)

    const memory = (await d.selfCheck()).memory
    // 先确认这五个数都非零：全零时「对账相等」毫无信息量。
    assert.ok(memory.ledger.tasks >= 2, `ledger.tasks 应 ≥ 2，实际 ${memory.ledger.tasks}`)
    assert.ok(memory.ledger.retired >= 1, `ledger.retired 应 ≥ 1，实际 ${memory.ledger.retired}`)
    assert.ok(memory.ledger.archived >= 1, `ledger.archived 应 ≥ 1，实际 ${memory.ledger.archived}`)
    assert.ok(memory.pending.inputs >= 1, `pending.inputs 应 ≥ 1，实际 ${memory.pending.inputs}`)
    assert.ok(memory.pending.unknown >= 1, `pending.unknown 应 ≥ 1，实际 ${memory.pending.unknown}`)
    assert.ok(memory.admission.direct >= 1 && memory.admission.ledger >= 1)

    assert.deepEqual(reconcile(d, memory), [], '自检的每个数都必须等于账本的实际值')
  })
})

// ---------------------------------------------------------------- 验收 7：守恒

test('验收7 守恒：活表 + 退休留痕 = 全量事实，不重复计数，落盘重启后仍成立', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-mem-keep-'))
  const config = {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    ledgerMaxTasks: 3,
    ledgerMaxDays: 3650,
  }
  const host = makeHost()
  const d = new Dispatch(host.ctx, config)
  stubGateways(d, host, dir)
  try {
    const total = 4
    for (let index = 0; index < total; index += 1) {
      d.table.add(mkTask(`t-keep-${index}`, 'done', { updatedAt: iso((total - index) * 60_000) }))
    }
    assert.equal(d.enforceLedgerCap().retired, 1)

    const liveIds = [...d.table.tasks.keys()]
    const retiredIds = [...d.retired.keys()]
    assert.equal(liveIds.length + retiredIds.length + d.retiredDropped, total,
      '活表 + 退休留痕 + 被丢的留痕 = 全量事实，一条不多一条不少')
    assert.deepEqual(liveIds.filter(id => retiredIds.includes(id)), [], '同一个 id 不能同时在活表与留痕里')

    // 落盘：退休留痕必须一起写（否则重启后「任务去哪了」无从回答）。
    await d.persist()
    const raw = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'))
    assert.equal(raw.version, 4, 'FILE_VERSION=4 才带 retired 数组')
    assert.equal(raw.tasks.length, 3)
    assert.equal(raw.retired.length, 1)

    // 重启：新实例读回同一份事实。
    const again = new Dispatch(host.ctx, config)
    stubGateways(again, host, dir)
    await again.restore()
    try {
      assert.deepEqual([...again.table.tasks.keys()].sort(), liveIds.slice().sort())
      assert.deepEqual([...again.retired.keys()].sort(), retiredIds.slice().sort())
      assert.equal(again.table.tasks.size + again.retired.size + again.retiredDropped, total,
        '重启后守恒关系必须依然成立')
      assert.equal(again.retired.get(retiredIds[0]).retiredReason, RETIRED_REASONS.CAP_COUNT)
      // 读回的留痕绝不能被当成活任务塞回去（否则又开始给指标投票）。
      for (const id of again.retired.keys()) assert.equal(again.table.tasks.has(id), false)
    } finally {
      await again.dispose()
    }
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 验收 8：不变量

test('验收8 不变量：report() 不删已有报告条目（只截字段、只受 MAX_REPORTS 约束）', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const task = mkTask('t-append', 'running')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running'))
    const worker = host.agents.get(task.workerSessionId)

    let previous = []
    for (let index = 1; index <= MAX_REPORTS + 10; index += 1) {
      await d.report(worker, { status: 'progress', summary: `第 ${index} 步` })
      const reports = task.reports
      // 治理不含「删历史」语义：长度单调不减，且只在超过 MAX_REPORTS 后由上限裁掉队头。
      assert.ok(reports.length >= Math.min(index, MAX_REPORTS),
        `第 ${index} 条之后 reports.length=${reports.length} 小于 min(${index}, ${MAX_REPORTS})`)
      if (index <= MAX_REPORTS) {
        assert.equal(reports.length, index, '上限内每写一条只增一条')
        assert.deepEqual(reports.slice(0, previous.length), previous, '已有条目一条都不能被治理删掉')
      } else {
        // 超上限时裁掉的是最老的队头，而不是把历史的中间挖空。
        assert.deepEqual(reports.slice(0, MAX_REPORTS - 1), previous.slice(-(MAX_REPORTS - 1)),
          '超上限时只允许按 MAX_REPORTS 裁掉最老的，已有条目顺序不得改变')
      }
      previous = reports.slice()
    }
    assert.equal(task.reports.length, MAX_REPORTS)
    assert.equal(task.reports.at(-1).summary, `第 ${MAX_REPORTS + 10} 步`)
    assert.equal(task.reports[0].summary, `第 11 步`, '留下的应当是最新 MAX_REPORTS 条')
  })
})

// ---------------------------------------------------------------- P0-3：单条消息预算

test('P0-3 单条消息预算：入库 summary/detail 超限被截并标 truncated（不超限不标）', async () => {
  const summaryLimit = 100
  const detailLimit = 80
  await withDispatch({ maxReportSummaryChars: summaryLimit, maxReportDetailChars: detailLimit }, async ({ d, host }) => {
    const task = mkTask('t-clip', 'running')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running'))
    const worker = host.agents.get(task.workerSessionId)

    const longSummary = 'S'.repeat(500)
    const longDetail = 'D'.repeat(400)
    await d.report(worker, { status: 'progress', summary: longSummary, detail: longDetail })
    const entry = task.reports.at(-1)

    // 只断言上界与「原长被记录」：`clip()` 头尾各半的具体切法不是契约，别写死。
    assert.ok(entry.summary.length <= summaryLimit,
      `入库 summary 必须 ≤ ${summaryLimit}，实际 ${entry.summary.length}`)
    assert.ok(entry.summary.length < longSummary.length, '超长 summary 必须真的被截，而不是原样入库')
    assert.ok(entry.detail.length <= detailLimit,
      `入库 detail 必须 ≤ ${detailLimit}，实际 ${entry.detail.length}`)
    assert.equal(entry.truncated.summary, longSummary.length, '必须记住被截之前的原始长度')
    assert.equal(entry.truncated.detail, longDetail.length)

    // 不超限时不带 truncated：一个恒存在的空对象会让「是否截过」永远为真。
    await d.report(worker, { status: 'progress', summary: '短摘要', detail: '短详情' })
    const short = task.reports.at(-1)
    assert.equal(short.summary, '短摘要')
    assert.equal(short.truncated, undefined)
    const memory = await d.memoryStats()
    assert.equal(memory.ledger.capPerTask.summary, summaryLimit, '自检里也要能看到单条预算')
    assert.equal(memory.ledger.capPerTask.detail, detailLimit)
  })
})

test('P0-3 单条消息预算：lastText 入库即截断（不等外发才截）', async () => {
  const limit = 200
  await withDispatch({ maxLastTextChars: limit }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-lasttext', 'running')
    d.table.add(task)
    const longText = `开头${'x'.repeat(2000)}结尾`
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running', [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: longText }] } } },
    ]))

    await d.onWorkerIdle(task.workerSessionId)

    assert.ok(task.lastText.length <= limit, `入库 lastText 必须 ≤ ${limit}，实际 ${task.lastText.length}`)
    assert.ok(task.lastText.length < longText.length, '不能把 worker 的整段总结原样存进 tasks.json')
  })
})

// ---------------------------------------------------------------- P0-2：准入分级

test('P0-2 准入分级：progress 走 ledger，blocked/failed/done 走 direct', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-admission', 'running')
    d.table.add(task)

    // 判据本身（单点）：unknown 状态宁可只入库，也不能冒充结论。
    const mapping = {
      progress: 'ledger',
      done: 'direct',
      blocked: 'direct',
      failed: 'direct',
      cancelled: 'direct',
      somethingElse: 'ledger',
    }
    for (const [status, expected] of Object.entries(mapping)) {
      assert.equal(d.admissionOf(task, { status }), expected, `${status} 的准入判定应是 ${expected}`)
    }
    // 终态永远直通，配置清空也不该让 done 失声。
    const statuses = d.directStatuses()
    for (const status of ['done', 'blocked', 'failed', 'cancelled']) {
      assert.ok(statuses.includes(status), `directStatuses 必须包含终态 ${status}`)
    }
    assert.equal(statuses.includes('progress'), false, 'progress 默认不在直通列表里')

    // 端到端：progress 只入库，三个终态各回流一条。
    for (const id of ['t-p', 't-b', 't-f', 't-d']) {
      const item = mkTask(id, 'running')
      d.table.add(item)
      host.agents.set(item.workerSessionId, makeAgent(item.workerSessionId, 'running'))
    }
    await d.report(host.agents.get('dispatch-t-p'), { status: 'progress', summary: '进度' })
    assert.equal(leadDeliveries(host).length, 0)
    await d.report(host.agents.get('dispatch-t-b'), { status: 'blocked', summary: '被阻塞' })
    await d.report(host.agents.get('dispatch-t-f'), { status: 'failed', summary: '失败' })
    await d.report(host.agents.get('dispatch-t-d'), { status: 'done', summary: '完成' })
    assert.equal(leadDeliveries(host).length, 3, 'blocked / failed / done 各要直通一条')
    assert.deepEqual(d.admissionCounts, { direct: 3, ledger: 1 })
  })
})

// ---------------------------------------------------------------- 附加值：归档冻结与退休是两件事

test('P0-4 归档冻结：archiveStale 写 archivedAt/frozenAt，不写 retiredAt', async () => {
  await withDispatch({ archiveAfterHours: 1 }, async ({ d }) => {
    const task = mkTask('t-freeze', 'done', { updatedAt: iso(2 * 3_600_000) })
    d.table.add(task)

    const result = await d.archiveStale()

    assert.equal(result.archived, 1)
    assert.ok(task.archivedAt, '归档必须打 archivedAt')
    assert.ok(task.frozenAt, '冻结时刻要单独记：detail() 靠它显示「已归档」')
    assert.equal(task.retiredAt, undefined,
      '归档不能复用 retiredAt——那会让「已归档」被误读成「已退休」')
    assert.equal(d.retired.size, 0, '归档不是退休：任务仍在活表里，只是只读')
    assert.ok(d.table.tasks.has('t-freeze'))

    const memory = await d.memoryStats()
    assert.equal(memory.ledger.archived, 1)
    assert.equal(memory.ledger.retired, 0)
    assert.equal(memory.ledger.tasks, 1)
    assert.equal(d.detail(task).frozen_at, task.frozenAt)
  })
})
