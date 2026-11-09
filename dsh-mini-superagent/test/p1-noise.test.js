/**
 * P1「降噪」的独立回归测试（plans/07-memory-governance.md §六 P1、§七 1–2）。
 *
 * 这个文件只守 P1 的三条承诺，每条都配一个**能对账的读数**，不写「看起来对」：
 *
 * - P1-1 合并窗口：未消费通知按 `taskId` 合并（默认 1.5 秒，硬上限 2 秒），
 *   **直通类永不参与**。钉的缺陷是「长任务每步一条进度把主会话刷成流水线」。
 * - P1-2 事实/投影分离：报告正文只进账本，会话里发「摘要 + 指针」。
 *   钉的缺陷是「一条 3000 字的摘要整段搬进会话」，同时守住「账本一字不压」。
 * - P1-3 自检：`selfCheck().memory` 的五项与 P1 新增的两块都等于实际值。
 *
 * 全部离线（假宿主 + mkdtemp）。时间语义上**不用真实等待去碰运气**：
 * 合并窗口要么配小（几毫秒）后用 `flushNotices()` 精确收尾，要么直接把
 * `noticeMergeWindowMs` 配成 0 来验证「关掉就走旧路径」。唯一真实等待的地方
 * 是「窗口到点会自己发」那条，等的上限是配置的 30ms，不是默认的 1500ms。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ADMISSION, NOTICE_MERGE_MAX_MS, PROJECTION, REPORT_SECTIONS, REPORT_VIEW,
} from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'

// ---------------------------------------------------------------- 夹具

const iso = msAgo => new Date(Date.now() - msAgo).toISOString()

function makeHost() {
  const agents = new Map()
  /** 每一次真实投递 = 会话里新增的一条插件来源 user/message。 */
  const deliveries = []
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
  return { ctx, agents, deliveries }
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
      host.deliveries.push({ sessionId, requestId, text })
      return { delivered: 'inbox', woke: false }
    },
  }
}

async function withDispatch(config, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-p1-noise-'))
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

function mkTask(id, status = 'running', extra = {}) {
  return {
    id,
    title: id === 't-1' ? '重构 auth 模块的令牌刷新' : id,
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

/** 主会话收到的插件消息。 */
const leadDeliveries = host => host.deliveries.filter(item => item.sessionId === 'lead')

/** 等一个异步条件成立（只用于等定时器回调，上限由调用方给）。 */
async function waitFor(label, probe, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

/** 取报告文本某一行的内容（段名之后的部分）。 */
const sectionOf = (text, section) => {
  const line = String(text).split('\n').find(item => item.startsWith(section))
  return line === undefined ? undefined : line.slice(section.length)
}

// ---------------------------------------------------------------- P1-1：合并判据

test('P1-1 合并判据：只有 progress 可合并，终态一律不合并', async () => {
  await withDispatch({}, async ({ d, host }) => {
    const task = mkTask('t-1')
    d.table.add(task)

    // 默认可合并的只有 progress。
    assert.equal(d.mergeableOf({ status: 'progress' }), true, 'progress 是唯一可合并的状态')
    for (const status of ['done', 'blocked', 'failed', 'cancelled', 'unknown', '']) {
      assert.equal(d.mergeableOf({ status }), false,
        `${status || '(空)'} 不可合并：结论类与需要人处理的事晚 1.5 秒就会被当成卡住`)
    }

    // 关掉窗口 = 整条合并路径的下线开关（§九：每批能单独回退）。
    d.config.noticeMergeWindowMs = 0
    assert.equal(d.mergeableOf({ status: 'progress' }), false, '窗口配 0 后 progress 也不合并')
    assert.equal(host.deliveries.length, 0)
  })
})

test('P1-1 窗口上限：配置超过 2 秒按 2 秒算，配 0 表示关闭', async () => {
  await withDispatch({ noticeMergeWindowMs: 60_000 }, async ({ d }) => {
    assert.equal(d.mergeWindowMs(), NOTICE_MERGE_MAX_MS,
      `§九 的「合并窗口上限 2 秒」是硬上限，配大了要截断，实际 ${d.mergeWindowMs()}`)
    assert.equal(d.mergeableOf({ status: 'progress' }), true, '被截断不等于关闭')
  })
  await withDispatch({ noticeMergeWindowMs: 0 }, async ({ d }) => {
    assert.equal(d.mergeWindowMs(), 0)
    assert.equal(d.mergeableOf({ status: 'progress' }), false,
      '配 0 = 关闭合并，progress 回到「立即发」的旧路径')
  })
})

// ---------------------------------------------------------------- P1-1：真的减少条数

test('P1-1 合并生效：同任务窗口内 3 条通知只投 1 条，最后一条胜出', async () => {
  await withDispatch({
    // 显式放开 progress 直通，才轮得到合并（默认 progress 是 ledger，根本不投）。
    directReportStatuses: ['blocked', 'failed', 'progress'],
    // progress 节流必须关掉，否则「第二条不投」是节流挡的，合并逻辑被掩盖。
    progressRelayIntervalMs: 0,
    noticeMergeWindowMs: 30,
  }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-1')
    d.table.add(task)
    const worker = makeAgent(task.workerSessionId)
    host.agents.set(task.workerSessionId, worker)

    const first = await d.report(worker, { status: 'progress', summary: '第一步：读了三个文件' })
    const second = await d.report(worker, { status: 'progress', summary: '第二步：改了入口' })
    const third = await d.report(worker, { status: 'progress', summary: '第三步：测试在跑' })

    // 三次都「进了窗口」，但会话里一条都还没有——这就是合并与节流的区别：
    // 节流是丢掉，合并是攒着。
    for (const [index, result] of [first, second, third].entries()) {
      assert.equal(result.merged, true, `第 ${index + 1} 条应进合并窗口`)
      // 契约：投成功时 `relayed` 字段**不出现**（缺省即已投）；只有明确没投才写 false。
      assert.notEqual(result.relayed, true, `第 ${index + 1} 条此刻还没真的投递`)
    }
    assert.equal(leadDeliveries(host).length, 0, '窗口未到点前不该有任何消息')
    assert.equal(d.pendingNotices.size, 1, '同一任务只留一个待发槽位')
    assert.equal(d.mergeStats.collapsed, 2, '3 条里合并掉 2 条')

    // 到点后自己发出去（等的是配置的 30ms，不是默认 1500ms）。
    await waitFor('窗口到点投递', () => leadDeliveries(host).length === 1)
    const inLead = leadDeliveries(host)
    assert.equal(inLead.length, 1, `同一任务一个窗口内只能投 1 条，实际 ${inLead.length} 条`)
    assert.match(inLead[0].text, /第三步/, '合并必须保留**最新**那条，而不是最早那条')
    assert.doesNotMatch(inLead[0].text, /第一步/, '中间态可以被合并掉（当前态不行）')
    // 两个读数分别回答不同问题：`windows` 是「真的发了几个窗口」，`collapsed`
    // 是「省下几条」。3 条只触发 1 次窗口、省 2 条——两个数不能互相替代。
    assert.equal(d.mergeStats.windows, 1, '3 条只该真正发 1 个窗口')
    assert.equal(d.mergeStats.collapsed, 2, '省下的条数 = 3 - 1')

    // 账本一条不少：合并只作用于投影，不动事实。
    assert.equal(task.reports.length, 3, '被合并的通知仍然完整入库')
  })
})

test('P1-1 直通类不参与：blocked 在窗口内立即投，不等 1.5 秒', async () => {
  await withDispatch({
    directReportStatuses: ['blocked', 'failed', 'progress'],
    progressRelayIntervalMs: 0,
    // 窗口配到 2 秒（硬上限）。如果终态被误合并，它就要等 2 秒才到——
    // 这里断言「报告返回时已经在会话里」，即证明了它根本没进队列。
    noticeMergeWindowMs: NOTICE_MERGE_MAX_MS,
  }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-1')
    d.table.add(task)
    const worker = makeAgent(task.workerSessionId)
    host.agents.set(task.workerSessionId, worker)

    // 先攒一条 progress，让它占住这个任务的合并槽位。
    await d.report(worker, { status: 'progress', summary: '做到一半' })
    assert.equal(d.pendingNotices.size, 1)

    // 紧接着的 blocked 必须**立刻**到，而不是被塞进那个槽位覆盖掉 progress。
    const result = await d.report(worker, { status: 'blocked', summary: '缺组织级 token' })
    assert.equal(result.merged, undefined, 'blocked 不该走合并')
    // 契约：`relayed: false` 才表示没投；投成功时这个字段**不出现**（缺省即已投）。
    assert.notEqual(result.relayed, false, 'blocked 必须当场投出去')

    const inLead = leadDeliveries(host)
    // 两条：先冲出窗口里那条进度，再发 blocked —— 因果顺序不能颠倒。
    assert.equal(inLead.length, 2, `直通类要先冲掉待发进度再发自己，实际 ${inLead.length} 条`)
    assert.match(inLead[0].text, /做到一半/, '先到的是过程信息（它本来就更早发生）')
    assert.match(inLead[1].text, /token/, '后到的是结论，且必须带原因')

    // 暴露出一个结构性隐患：槽位已空，不会再有一条迟到的进度落在结算之后。
    assert.equal(d.pendingNotices.size, 0, '直通类发完后槽位必须为空')
    assert.equal(task.reports.length, 2)
  })
})

test('P1-1 关掉合并就回到旧路径：每条通知立即投（可单独回退）', async () => {
  await withDispatch({
    directReportStatuses: ['blocked', 'failed', 'progress'],
    progressRelayIntervalMs: 0,
    noticeMergeWindowMs: 0,
  }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-1')
    d.table.add(task)
    const worker = makeAgent(task.workerSessionId)
    host.agents.set(task.workerSessionId, worker)

    for (const step of ['一', '二', '三']) {
      const result = await d.report(worker, { status: 'progress', summary: `第 ${step} 步` })
      assert.equal(result.merged, undefined, '关掉合并后不该有 merged 标记')
      assert.notEqual(result.relayed, false, '关掉合并后每条都要真的投出去')
    }
    assert.equal(leadDeliveries(host).length, 3, '关闭后的行为必须与 P1-1 之前完全一致')
    assert.equal(d.pendingNotices.size, 0)
    assert.equal(d.mergeStats.collapsed, 0)
  })
})

test('P1-1 不同任务不共享槽位：各自的进度不会被压成一条', async () => {
  await withDispatch({
    directReportStatuses: ['blocked', 'failed', 'progress'],
    progressRelayIntervalMs: 0,
    noticeMergeWindowMs: 30,
  }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const one = mkTask('t-1')
    const two = mkTask('t-2', 'running', { title: 'CI 缓存迁移' })
    d.table.add(one)
    d.table.add(two)
    host.agents.set(one.workerSessionId, makeAgent(one.workerSessionId))
    host.agents.set(two.workerSessionId, makeAgent(two.workerSessionId))

    await d.report(host.agents.get(one.workerSessionId), { status: 'progress', summary: '甲任务进度' })
    await d.report(host.agents.get(two.workerSessionId), { status: 'progress', summary: '乙任务进度' })
    assert.equal(d.pendingNotices.size, 2, '合并键是 taskId，两个任务各占一个槽位')

    await d.flushNotices()
    const inLead = leadDeliveries(host)
    assert.equal(inLead.length, 2, '两个任务的进度各自到达（跨任务合并会让人看不出哪条在做什么）')
    assert.ok(inLead.some(item => /甲任务进度/.test(item.text)))
    assert.ok(inLead.some(item => /乙任务进度/.test(item.text)))
  })
})

// ---------------------------------------------------------------- P1-2：投影压缩

test('P1-2 超长摘要只发「摘要 + 指针」，账本原文一字不压', async () => {
  const longSummary = `开头${'过'.repeat(3000)}结尾`
  const longDetail = `D${'细'.repeat(3000)}节`
  await withDispatch({ noticeMergeWindowMs: 0 }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-1', 'done')
    d.table.add(task)
    const worker = makeAgent(task.workerSessionId)
    host.agents.set(task.workerSessionId, worker)

    const result = await d.report(worker, {
      status: 'done', headline: '做完了但写了很长', summary: longSummary, detail: longDetail,
    })
    assert.equal(result.projection, PROJECTION.DIGEST, '有 detail + 超长摘要 → digest 形态')
    assert.equal(d.projectionCounts.digest, 1)

    const text = leadDeliveries(host)[0].text
    // 会话那一份：短、带指针、依然是合法四段式。
    assert.ok(text.length < longSummary.length / 2,
      `投影必须显著短于正文，实际 ${text.length} / ${longSummary.length}`)
    assert.match(sectionOf(text, REPORT_SECTIONS.NOTE) ?? '', /账本/, '压缩后的说明行要指向账本')
    assert.match(sectionOf(text, REPORT_SECTIONS.NOTE) ?? '', /dispatch_inspect|细节/, '要给一个能查的入口')
    assert.ok(text.endsWith(`dispatch_inspect ${task.id}`), '细节行必须完整保留（那是指针的落点）')
    assert.ok(!text.includes('细细细'), 'detail 正文不进会话')

    // 账本：原文完整（入库上限 6000 > 3006），一个字符都没被投影层动过。
    const entry = task.reports.at(-1)
    assert.equal(entry.summary, longSummary, '账本 summary 必须一字不压')
    assert.equal(entry.detail, longDetail, '账本 detail 必须一字不压')
  })
})

test('P1-2 预算内的短报告一个字都不改（不是「有 detail 就压」）', async () => {
  await withDispatch({ noticeMergeWindowMs: 0 }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-1', 'done')
    d.table.add(task)
    const worker = makeAgent(task.workerSessionId)
    host.agents.set(task.workerSessionId, worker)

    const summary = '替换了 refresh 调用点 6 处；新增 3 条用例；测试全绿。'
    const result = await d.report(worker, {
      status: 'done', headline: '登录超时修好了', summary,
    })
    assert.equal(result.projection, PROJECTION.FULL, '短报告是 full 形态')
    const text = leadDeliveries(host)[0].text
    assert.equal(sectionOf(text, REPORT_SECTIONS.NOTE), summary, '预算内的说明行必须原样保留')
    assert.equal(text, d.reportText(task, task.reports.at(-1)),
      'full 形态下发出去的就是 reportText() 原样（P1-2 不改变常态文案）')
  })
})

test('P1-2 投影阈值就是投影预算：刚好超一点才切，且指针在说明行内', async () => {
  await withDispatch({ noticeMergeWindowMs: 0 }, async ({ d }) => {
    const task = mkTask('t-1', 'done')
    const at = 'A'.repeat(REPORT_VIEW.SUMMARY)
    const over = 'B'.repeat(REPORT_VIEW.SUMMARY + 50)

    assert.equal(d.projectionOf({ summary: at }), PROJECTION.FULL,
      `等于预算时仍是 full（阈值是「超过才切」），实际 ${d.projectionOf({ summary: at })}`)
    assert.equal(d.projectionOf({ summary: over }), PROJECTION.DIGEST)
    assert.equal(d.projectionOf({ summary: '短', detail: '有详情' }), PROJECTION.DIGEST,
      '带 detail 时即便摘要短也走 digest：正文在账本，会话不必再放一份')

    // 直接验投影结果：说明行被压到 DIGEST 预算内，其余行原样。
    const text = d.reportText(task, { status: 'done', headline: '好了', summary: over })
    const projected = d.projectText(text)
    const note = sectionOf(projected, REPORT_SECTIONS.NOTE) ?? ''
    assert.ok(note.length <= REPORT_VIEW.DIGEST + 80,
      `说明行（含指针）必须接近 DIGEST 预算，实际 ${note.length}`)
    assert.match(note, /账本/, '必须告诉主会话「剩下那些在哪」')
    assert.equal(sectionOf(projected, REPORT_SECTIONS.TASK), sectionOf(text, REPORT_SECTIONS.TASK),
      '任务行不许被投影改动')
    assert.equal(sectionOf(projected, REPORT_SECTIONS.RESULT), sectionOf(text, REPORT_SECTIONS.RESULT),
      '结果行不许被投影改动（那是用户唯一一定要读到的一句）')
  })
})

test('P1-2 直通类的行动指向不被压缩掉', async () => {
  await withDispatch({ noticeMergeWindowMs: 0 }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-1', 'blocked')
    d.table.add(task)
    const worker = makeAgent(task.workerSessionId)
    host.agents.set(task.workerSessionId, worker)

    await d.report(worker, {
      status: 'blocked',
      summary: `需要 GitHub 组织级 token 才能改 cache 权限。${'背景'.repeat(500)}`,
    })
    const text = leadDeliveries(host)[0].text
    assert.ok(sectionOf(text, REPORT_SECTIONS.NEED), '【需要你】段必须存在')
    assert.match(sectionOf(text, REPORT_SECTIONS.NEED), /需要|要不要|定|重试/,
      '压缩后行动指向仍要可读')
    assert.match(text, new RegExp(task.id), '指针必须带得动任务 id')
  })
})

test('P1-2 投影判据单点：返回值里的 projection 与实际发出去的形态一致', async () => {
  await withDispatch({ noticeMergeWindowMs: 0 }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const short = mkTask('t-1', 'done', { title: '短摘要' })
    const long = mkTask('t-2', 'done', { title: '长摘要' })
    d.table.add(short)
    d.table.add(long)
    host.agents.set(short.workerSessionId, makeAgent(short.workerSessionId))
    host.agents.set(long.workerSessionId, makeAgent(long.workerSessionId))

    // 短：full，投出去的就是 reportText() 原样。
    const a = await d.report(host.agents.get(short.workerSessionId), {
      status: 'done', headline: '好了', summary: '改了三处',
    })
    assert.equal(a.projection, PROJECTION.FULL)
    assert.equal(leadDeliveries(host).at(-1).text, d.reportText(short, short.reports.at(-1)),
      'full 形态必须与 reportText() 完全一致（投影不做任何改动）')

    // 长：digest，投出去的比 reportText() 短，且短在说明行上。
    const b = await d.report(host.agents.get(long.workerSessionId), {
      status: 'done', headline: '也好了', summary: '长'.repeat(REPORT_VIEW.SUMMARY + 200),
    })
    assert.equal(b.projection, PROJECTION.DIGEST)
    const sent = leadDeliveries(host).at(-1).text
    const raw = d.reportText(long, long.reports.at(-1))
    assert.ok(sent.length < raw.length, `digest 必须比 reportText() 短：${sent.length} / ${raw.length}`)
    assert.equal(sectionOf(sent, REPORT_SECTIONS.TASK), sectionOf(raw, REPORT_SECTIONS.TASK))
    assert.equal(sectionOf(sent, REPORT_SECTIONS.RESULT), sectionOf(raw, REPORT_SECTIONS.RESULT))
    assert.ok((sectionOf(sent, REPORT_SECTIONS.NOTE) ?? '').length
      < (sectionOf(raw, REPORT_SECTIONS.NOTE) ?? '').length, '差在说明行')

    // 计数与两次判定的结论一致（这是「口径不分裂」的直接读数）。
    assert.deepEqual(d.projectionCounts, { full: 1, digest: 1, ledger: 0 })
  })
})

test('P1-1 顺序：结论先冲掉窗口里的进度，不制造「先结论、后过程」', async () => {
  // 窗口配到 2 秒（硬上限），确保不冲刷就必然读错顺序。
  await withDispatch({
    directReportStatuses: ['blocked', 'failed', 'progress'],
    progressRelayIntervalMs: 0,
    noticeMergeWindowMs: NOTICE_MERGE_MAX_MS,
  }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    // 必须是 running：`finishIdleTurn()` 对已结算任务直接返回（它只负责「收尾一次回合」）。
    const task = mkTask('t-1', 'running')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId))

    await d.report(host.agents.get(task.workerSessionId), { status: 'progress', summary: '还在改最后一段' })
    assert.equal(leadDeliveries(host).length, 0, '进度确实还躺在窗口里')

    // 回合兜底（finishIdleTurn 走 notify）：必须先把它冲出来。
    await d.finishIdleTurn(task, '我看了一下，还没给结论')

    const texts = leadDeliveries(host).map(item => item.text)
    assert.equal(texts.length, 2, `应当先出进度、再出兜底结论，实际 ${texts.length} 条`)
    assert.match(texts[0], /还在改最后一段/, '第一条必须是更早发生的进度')
    assert.match(texts[1], /没给结论|跑完了/, '第二条才是结论')
    assert.equal(d.pendingNotices.size, 0, '结论之后窗口里不该再留着东西')
  })
})

test('P1-1 顺序：批次汇总先冲掉各成员窗口里的进度（键不同，不能靠 notify 自己冲）', async () => {
  await withDispatch({
    directReportStatuses: ['blocked', 'failed', 'progress'],
    progressRelayIntervalMs: 0,
    noticeMergeWindowMs: NOTICE_MERGE_MAX_MS,
  }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const members = [
      mkTask('t-1', 'running', { group: 'g-9' }),
      mkTask('t-2', 'running', { group: 'g-9', title: 'CI 缓存迁移' }),
    ]
    for (const item of members) {
      d.table.add(item)
      host.agents.set(item.workerSessionId, makeAgent(item.workerSessionId))
    }

    // 两个成员各留一条进度在窗口里（键是各自的 task.id）。
    await d.report(host.agents.get(members[0].workerSessionId), { status: 'progress', summary: '甲还在跑' })
    await d.report(host.agents.get(members[1].workerSessionId), { status: 'progress', summary: '乙还在跑' })
    assert.equal(d.pendingNotices.size, 2, '两个成员各占一个槽位')
    assert.equal(leadDeliveries(host).length, 0)

    // 整批结束 → 汇总。汇总的合并键是 group，那两条进度的键是 task.id，
    // 所以汇总必须自己先把它们冲掉。
    members[0].status = 'done'
    members[1].status = 'done'
    await d.maybeSummarize(members[1])

    const texts = leadDeliveries(host).map(item => item.text)
    assert.equal(texts.length, 3, `两条进度 + 一条汇总，实际 ${texts.length} 条`)
    assert.match(texts[0], /甲还在跑/)
    assert.match(texts[1], /乙还在跑/)
    assert.match(texts[2], /批次/, '汇总必须最后到')
    assert.equal(d.pendingNotices.size, 0, '汇总之后不该还有成员进度没发')
  })
})

// ---------------------------------------------------------------- P1-3：自检五项

test('P1-3 自检 memory 含 §六 五项 + P1 新增两块，且都与实际值一致', async () => {
  await withDispatch({ ledgerMaxTasks: 2, ledgerMaxDays: 3650 }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    // 造一点真实活动：一条 progress（ledger）、一条 done（direct）。
    const task = mkTask('t-1')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId))
    await d.report(host.agents.get(task.workerSessionId), { status: 'progress', summary: '进度' })
    await d.report(host.agents.get(task.workerSessionId), { status: 'done', summary: '完成' })
    d.enforceLedgerCap()

    const memory = (await d.selfCheck()).memory
    // §六 P1-3 要求的五项，逐项定位到字段（不是「有 memory 就算过」）。
    assert.equal(typeof memory.ledger.tasks, 'number', '① 账本条数')
    assert.equal(typeof memory.retired.count, 'number', '② 退休数')
    assert.equal(typeof memory.pending.inputs, 'number', '③ 待读数')
    assert.equal(typeof memory.window.days, 'number', '④ 当前窗口（天数）')
    assert.equal(typeof memory.window.tasks, 'number', '④ 当前窗口（条数）')
    assert.equal(typeof memory.ledger.capPerTask.summary, 'number', '⑤ 注入预算（单条 summary）')
    assert.equal(typeof memory.projection.budget.view, 'number', '⑤ 注入预算（投影 view）')

    // P1 新增两块也要在。
    assert.equal(memory.merge.windowMs, d.mergeWindowMs(), '合并窗口回显的是生效值')
    assert.deepEqual(memory.merge.mergeableStatuses, ['progress'], '可合并状态清单可读')
    assert.equal(memory.projection.digest, 0, '本条用例没有 digest 形态的报告')

    // 五项都对得上实际账本。
    assert.equal(memory.ledger.tasks, d.table.tasks.size)
    assert.equal(memory.retired.count, d.retired.size)
    assert.equal(memory.pending.inputs, 0)
    assert.equal(memory.admission.ledger, d.admissionCounts.ledger)
    assert.equal(memory.admission.direct, d.admissionCounts.direct)
  })
})

// ---------------------------------------------------------------- §七 1–2：整轮读数

test('§七 1：一次派发 + 一次收尾，主会话新增插件消息 ≤ 3 条，progress 默认 0 条', async () => {
  await withDispatch({}, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = await d.launch(host.agents.get('lead'), { title: '一次派发', brief: '做一件小事' })
    await waitFor('任务启动', () => host.agents.has(task.workerSessionId))
    const worker = host.agents.get(task.workerSessionId)

    // 五条进度：默认配置下它们连会话都不该进（admission = ledger）。
    for (let step = 1; step <= 5; step += 1) {
      const result = await d.report(worker, { status: 'progress', summary: `第 ${step} 步` })
      assert.equal(result.admission, ADMISSION.LEDGER, 'progress 默认准入是 ledger')
      assert.equal(result.projection, PROJECTION.LEDGER)
    }
    await d.flushNotices()
    const progressMessages = leadDeliveries(host).length
    assert.equal(progressMessages, 0, `progress 默认必须 0 条，实际 ${progressMessages} 条`)

    // 收尾：done 恒直通。
    await d.report(worker, { status: 'done', headless: true, summary: '做完了' })
    const inLead = leadDeliveries(host)

    assert.ok(inLead.length <= 3,
      `一次派发 + 一次收尾最多 3 条插件消息，实际 ${inLead.length} 条`)
    assert.equal(inLead.length, 1, '默认配置下只有终态那一条回流')
    assert.match(inLead[0].text, /做完了/)

    // 简报发给 worker，不算主会话历史。
    assert.equal(host.deliveries.filter(item => item.sessionId === task.workerSessionId).length, 1)
    assert.deepEqual(d.projectionCounts, { full: 1, digest: 0, ledger: 5 },
      '五条进度进账本、一条终态进会话（投递形态计数可对账）')
  })
})

test('§七 2：同一任务 60 秒内未消费通知 ≤ 1 条，且无重复 message id', async () => {
  const interval = 60_000
  await withDispatch({
    directReportStatuses: ['blocked', 'failed', 'progress'],
    progressRelayIntervalMs: interval,
    noticeMergeWindowMs: 0,       // 这条用例守的是**节流**而不是合并，先关合并看纯净结果
  }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-1')
    d.table.add(task)
    const worker = makeAgent(task.workerSessionId)
    host.agents.set(task.workerSessionId, worker)

    // 10 条进度，密集到全在同一个 60 秒窗口内。
    for (let step = 1; step <= 10; step += 1) {
      await d.report(worker, { status: 'progress', summary: `第 ${step} 步` })
    }
    const inLead = leadDeliveries(host)
    assert.ok(inLead.length <= 1,
      `同一任务 60 秒内未消费通知必须 ≤ 1 条，实际 ${inLead.length} 条`)
    assert.equal(inLead.length, 1, '第一条照常投，其余被节流挡下')
    assert.equal(task.reports.length, 10, '被挡下的仍全部入库')

    // 重复 message id 计数 = 0（宿主对同一 id 的待投递消息会直接抛）。
    const keys = host.deliveries.map(item => `${item.sessionId}#${item.requestId}`)
    const duplicates = keys.length - new Set(keys).size
    assert.equal(duplicates, 0, `重复 message id 计数必须为 0，实际 ${duplicates}：${keys.join(' | ')}`)
  })
})

test('§七 2：合并不制造重复 id——合并多次也只用同一个待发槽位投一次', async () => {
  await withDispatch({
    directReportStatuses: ['blocked', 'failed', 'progress'],
    progressRelayIntervalMs: 0,
    noticeMergeWindowMs: 30,
  }, async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-1')
    d.table.add(task)
    const worker = makeAgent(task.workerSessionId)
    host.agents.set(task.workerSessionId, worker)

    for (let step = 1; step <= 5; step += 1) {
      await d.report(worker, { status: 'progress', summary: `第 ${step} 步` })
    }
    await d.flushNotices()
    await d.flushNotices()   // 幂等：第二次不该再投

    const keys = host.deliveries.map(item => `${item.sessionId}#${item.requestId}`)
    assert.equal(keys.length - new Set(keys).size, 0, '合并路径也不许出现重复 id')
    assert.equal(leadDeliveries(host).length, 1, '5 条合并成 1 条')
    assert.equal(task.reports.length, 5, '账本仍是 5 条')
  })
})

// ---------------------------------------------------------------- 卸载不丢

test('P1-1 卸载时冲刷窗口：已决定要发的通知不随进程消失', async () => {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-p1-flush-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    directReportStatuses: ['blocked', 'failed', 'progress'],
    progressRelayIntervalMs: 0,
    noticeMergeWindowMs: NOTICE_MERGE_MAX_MS,     // 故意配到最大：不冲刷就必然丢
  })
  stubGateways(d, host, dir)
  try {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-1')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId))

    await d.report(host.agents.get(task.workerSessionId), { status: 'progress', summary: '还在做' })
    assert.equal(d.pendingNotices.size, 1)
    assert.equal(leadDeliveries(host).length, 0, '窗口未到点时确实还没发')

    await d.dispose()

    assert.equal(d.pendingNotices.size, 0, '卸载必须清空槽位（不能留下永远不发的条目）')
    assert.equal(leadDeliveries(host).length, 1, '卸载必须把窗口里那条冲出去，而不是静默丢掉')
    assert.match(leadDeliveries(host)[0].text, /还在做/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
