/**
 * `dispatch_candidates`：**只读候选 + 判定素材**（plans/11 §三、§九）。
 *
 * 这个文件钉的是契约，不是「像不像」：
 * 1. 候选字段齐全（§3.3 逐字段），且非候选被正确排除并计数；
 * 2. 素材必须够模型判断：最后一条报告的 summary、终态、结束时点、线程、
 *    是否已有后继 / 活跃会话；
 * 3. **红线**：返回里没有 score / rank / recommend / confidence / match / similarity
 *    这类键——插件只缩小范围，判定权在调用方；
 * 4. 只读：不建任务、不落盘、不碰会话；
 * 5. 工具数从 9 变 10 后，TOOL_NAMES 与描述仍然一致。
 *
 * 为什么用「逐字段 deepEqual」而不是「包含某几个键」：候选的返回形状是模型
 * 与后续视图共享的契约，多一个少一个键都算改契约；这条断言让改动必须是有意的。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SETTLED, WORKER_PREFIX, newThreadId } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { TOOL_NAMES, toolDefinitions } from '../src/tools.js'

// ---------------------------------------------------------------- 夹具

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()
const HOUR = 3_600_000

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
      async resolveAgent() { return { error: { code: 'not-found' } } },
      async prompt() {},
    },
  }
  return { ctx, agents }
}

const WORKSPACES = [
  { id: 'ws-a', title: '项目 A', path: 'D:\\proj\\a' },
  { id: 'ws-b', title: '项目 B', path: 'D:\\proj\\b' },
]

async function withDispatch(fn, options = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-candidates-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    noticeMergeWindowMs: 0,
    ...(options.config ?? {}),
  })
  d.workspaces = {
    list: () => WORKSPACES,
    resolve: async ref => WORKSPACES.find(item => item.id === ref || item.title === ref || item.path === ref),
    resolveOrCreate: async ref => ({
      workspace: WORKSPACES.find(item => item.id === ref || item.title === ref || item.path === ref),
      created: false,
    }),
    dayWorkspace: async () => undefined,
    defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return dir },
  }
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
      const agent = { id: sessionId, status: 'running', session: { snapshotEvents: () => [] } }
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  // 默认派发目标 = 项目 A（候选默认按「会话当前目标」圈同域，与真实输入框一致）。
  d.targets.set('lead', { workspace_id: 'ws-a', title: '项目 A', path: 'D:\\proj\\a' })
  const tools = Object.fromEntries(toolDefinitions(d).map(item => [item.name, item]))
  const cand = args => tools.dispatch_candidates.execute(args, { agent: { id: 'lead' } })
  try {
    await fn({ d, host, dir, tools, cand, createdSessions })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/** 造一条账本任务；默认「已结算、在窗口内、与 lead 同域」。 */
const mkTask = (id, extra = {}) => ({
  id,
  title: `任务 ${id}`,
  brief: '原始简报',
  parentSessionId: 'lead',
  workerSessionId: `${WORKER_PREFIX}${id}`,
  threadId: newThreadId(id),
  status: 'done',
  attempt: 1,
  reports: [],
  cwd: 'D:\\proj\\a',
  workspaceId: 'ws-a',
  workspaceTitle: '项目 A',
  createdAt: iso(3 * HOUR),
  updatedAt: iso(2 * HOUR),
  settledAt: iso(2 * HOUR),
  ...extra,
})

/** §3.3 的全部候选字段（`brief_truncated_to` 仅在截断时出现，下面单独测）。 */
const CANDIDATE_KEYS = [
  'task_id', 'title', 'status', 'settled_at', 'settled_basis', 'age_hours',
  'brief', 'brief_chars', 'last_report', 'report_count', 'last_text', 'error',
  'cancel_reason', 'thread_id', 'parent_task_id', 'workspace_id', 'workspace_title',
  'host_workspace_id', 'host_workspace_title', 'cwd', 'worker_session_id', 'model',
  'agent_preset', 'permission_preset', 'group', 'attempt', 'created_at',
  'session', 'successors', 'reuse_check',
].sort()

// ---------------------------------------------------------------- 工具契约

test('dispatch_candidates 是第 10 个工具；描述把判定权交给调用方', () => {
  assert.equal(TOOL_NAMES.length, 10, '新增候选工具后工具数必须是 10')
  assert.ok(TOOL_NAMES.includes('dispatch_candidates'), 'TOOL_NAMES 必须登记新工具')

  const def = toolDefinitions({}).find(item => item.name === 'dispatch_candidates')
  assert.ok(def, '必须存在 dispatch_candidates 定义')
  assert.match(def.description, /本工具只提供候选与素材，是否接续由调用方判断/,
    '描述必须写明：判断由调用方做，插件只给素材')
  assert.match(def.description, /没有分数/, '描述必须否定「分数」')
  assert.match(def.description, /不会自动绑定/, '描述必须否定「自动绑定」')
  for (const key of ['limit', 'days', 'cwd', 'workspace', 'all_workspaces']) {
    assert.ok(def.parameters.properties[key], `必须暴露 ${key} 参数`)
  }
  assert.equal(def.parameters.additionalProperties, false, '保持 additionalProperties:false')
})

// ---------------------------------------------------------------- §九 A 组

test('A1/A2/A3：只返回已结算、未取消、未归档的任务，且字段齐全', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-done', { status: 'done' }))
    d.table.add(mkTask('t-ended', { status: 'ended' }))
    d.table.add(mkTask('t-failed', { status: 'failed', error: '脚本报错：ENOENT' }))
    d.table.add(mkTask('t-running', { status: 'running', settledAt: undefined }))
    d.table.add(mkTask('t-cancelled', { status: 'cancelled' }))
    d.table.add(mkTask('t-archived', { archivedAt: iso(1000) }))

    const value = await cand({})
    const byId = Object.fromEntries(value.candidates.map(item => [item.task_id, item]))

    assert.equal(value.count, 3)
    assert.deepEqual(Object.keys(byId).sort(), ['t-done', 't-ended', 't-failed'])
    assert.equal(value.excluded.not_settled, 1)
    assert.equal(value.excluded.cancelled, 1)
    assert.equal(value.excluded.archived, 1)

    // 逐字段核对 §3.3：多一个少一个都算改契约。
    assert.deepEqual(Object.keys(byId['t-done']).sort(), CANDIDATE_KEYS)
    const done = byId['t-done']
    assert.equal(done.title, '任务 t-done')
    assert.equal(done.status, 'done')
    assert.equal(done.settled_basis, 'settledAt')
    assert.equal(done.thread_id, newThreadId('t-done'))
    assert.equal(done.worker_session_id, `${WORKER_PREFIX}t-done`)
    assert.equal(done.workspace_id, 'ws-a')
    assert.equal(done.cwd, 'D:\\proj\\a')
    assert.equal(done.attempt, 1)
    assert.deepEqual(done.session, { busy: false, active_task_id: null })
    assert.deepEqual(done.successors, { active: [], settled_count: 0 })
    assert.deepEqual(done.reuse_check, { ok: true, blocked_by: [] })
    // failed 的「为什么没成」是模型要判断的信息，必须带出来而不是藏起来。
    assert.equal(byId['t-failed'].status, 'failed')
    assert.equal(byId['t-failed'].error, '脚本报错：ENOENT')
  })
})

test('A4：退休任务只计数、不回正文（brief/reports 已被 #retire 丢弃）', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.retired.set('t-retired', {
      id: 't-retired',
      title: '退休的任务',
      status: 'done',
      parentSessionId: 'lead',
      workerSessionId: `${WORKER_PREFIX}t-retired`,
      retiredAt: iso(1000),
      retiredReason: 'cap-days',
      updatedAt: iso(1000),
      summary: '退休留痕摘要',
      parentTaskId: null,
    })

    const value = await cand({})
    assert.equal(value.count, 0)
    assert.equal(value.excluded.retired, 1)
    assert.equal(value.considered, 1, 'considered 要含退休留痕，否则「为什么没有候选」算不出来')
    assert.ok(!JSON.stringify(value).includes('退休留痕摘要'), '不能把退休记录的正文带出来')
    assert.ok(!JSON.stringify(value).includes('t-retired'), '退休记录不能出现在候选里')
  })
})

test('A5：时间窗按 settled_at 生效（8 天前只在 days=30 时出现）', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-old', {
      settledAt: iso(8 * 24 * HOUR),
      updatedAt: iso(8 * 24 * HOUR),
      createdAt: iso(9 * 24 * HOUR),
    }))

    const week = await cand({ days: 7 })
    assert.equal(week.count, 0)
    assert.equal(week.excluded.outside_window, 1)
    assert.equal(week.scope.days, 7)

    const month = await cand({ days: 30 })
    assert.equal(month.count, 1)
    assert.equal(month.scope.days, 30)
  })
})

test('A6：默认只返回同域；all_workspaces 才跨目录，且 scope.same_domain=false', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-same'))
    d.table.add(mkTask('t-other', { cwd: 'D:\\proj\\b', workspaceId: 'ws-b', workspaceTitle: '项目 B' }))

    const sameDomain = await cand({})
    assert.equal(sameDomain.count, 1)
    assert.equal(sameDomain.candidates[0].task_id, 't-same')
    assert.equal(sameDomain.excluded.other_domain, 1)
    assert.equal(sameDomain.scope.same_domain, true)
    assert.equal(sameDomain.scope.source, 'session-target')

    const everywhere = await cand({ all_workspaces: true })
    assert.equal(everywhere.count, 2)
    assert.equal(everywhere.scope.same_domain, false)

    // 显式 workspace + cwd 时两个条件都要满足。
    const explicit = await cand({ workspace: 'ws-b', cwd: 'D:\\proj\\b' })
    assert.equal(explicit.count, 1)
    assert.equal(explicit.candidates[0].task_id, 't-other')
    assert.equal(explicit.scope.source, 'explicit-args')
  })
})

test('A7：settledAt 缺失的旧账本回退 updatedAt，并标 updatedAt-fallback', async () => {
  await withDispatch(async ({ d, cand }) => {
    const fallbackAt = iso(5 * HOUR)
    d.table.add(mkTask('t-fallback', { settledAt: undefined, updatedAt: fallbackAt }))

    const value = await cand({})
    assert.equal(value.candidates[0].settled_basis, 'updatedAt-fallback')
    assert.equal(value.candidates[0].settled_at, fallbackAt)
  })
})

test('A8：按 settled_at 降序（同刻按 createdAt 降序），不按标题或「像不像」', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-1h', { title: 'A 最新的', settledAt: iso(1 * HOUR) }))
    d.table.add(mkTask('t-2h', { title: 'Z 中间的', settledAt: iso(2 * HOUR) }))
    d.table.add(mkTask('t-3h', { title: 'M 最老的', settledAt: iso(3 * HOUR) }))

    const value = await cand({})
    assert.deepEqual(value.candidates.map(item => item.task_id), ['t-1h', 't-2h', 't-3h'])
  })
})

// ---------------------------------------------------------------- §九 B 组（素材）

test('B1：简报截到 handoffBriefChars，原长与截断长度都给出', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-long', { brief: 'x'.repeat(2000) }))
    const item = (await cand({})).candidates[0]
    assert.equal(item.brief_chars, 2000)
    assert.equal(item.brief_truncated_to, 600)
    assert.ok(Array.from(item.brief).length <= 600, '截断后不能超过预算')
  })
})

test('B2：没有报告时 last_report 是 null（不是 {}），last_text 有值', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-empty', { lastText: '最后一小段输出' }))
    const item = (await cand({})).candidates[0]
    assert.equal(item.last_report, null)
    assert.equal(item.report_count, 0)
    assert.equal(item.last_text, '最后一小段输出')
  })
})

test('B3：last_report 取最后一条；headline 有就有、没有就不出现', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-reports', {
      reports: [
        { at: iso(3 * HOUR), status: 'done', summary: '第一版结论', headline: '旧标题' },
        { at: iso(1 * HOUR), status: 'done', summary: '第二版结论' },
      ],
    }))
    // 另一条有 headline，用来确认「有就带」。
    d.table.add(mkTask('t-headline', {
      settledAt: iso(30 * 60_000),
      lastReportAt: iso(30 * 60_000),
      reports: [{ at: iso(30 * 60_000), status: 'done', summary: '带标题的结论', headline: '短标题' }],
    }))

    const byId = Object.fromEntries((await cand({})).candidates.map(item => [item.task_id, item]))
    assert.equal(byId['t-reports'].last_report.summary, '第二版结论', '必须取最后一条')
    assert.ok(!('headline' in byId['t-reports'].last_report), '没写 headline 就不该出现这个键')
    assert.equal(byId['t-reports'].last_text, null, '有报告时不再给 last_text（避免两份结论打架）')
    assert.equal(byId['t-headline'].last_report.headline, '短标题')
  })
})

test('B4：failed / interrupted 如实带出状态与 error（不隐藏失败）', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-failed', { status: 'failed', error: 'e'.repeat(500) }))
    d.table.add(mkTask('t-interrupted', { status: 'interrupted' }))
    const byId = Object.fromEntries((await cand({})).candidates.map(item => [item.task_id, item]))

    assert.equal(byId['t-failed'].status, 'failed')
    assert.ok(Array.from(byId['t-failed'].error).length <= 200)
    assert.equal(byId['t-interrupted'].status, 'interrupted')
    assert.equal(byId['t-interrupted'].error, null)
  })
})

test('B5：已有后继时标出活跃后继与已结算后继数（避免模型重复选同一条）', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-source'))
    // 活跃后继：同会话上正在跑的一条复用任务。
    d.table.add(mkTask('t-succ-run', {
      status: 'running',
      parentTaskId: 't-source',
      settledAt: undefined,
    }))
    // 已结算后继：用归档把它挡在候选之外，只影响 successors 计数。
    d.table.add(mkTask('t-succ-done', {
      parentTaskId: 't-source',
      archivedAt: iso(1000),
    }))

    const value = await cand({})
    const source = value.candidates.find(item => item.task_id === 't-source')
    assert.equal(source.successors.active.length, 1)
    assert.deepEqual(source.successors.active[0], {
      task_id: 't-succ-run',
      status: 'running',
      title: '任务 t-succ-run',
    })
    assert.equal(source.successors.settled_count, 1)
  })
})

test('B6：来源会话上有活跃任务时，session.busy 与 reuse_check 如实报告', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-source'))
    // 同一条子会话上的另一条 running 任务：复用会与它并发，必须让模型看见。
    d.table.add(mkTask('t-busy', {
      status: 'running',
      workerSessionId: `${WORKER_PREFIX}t-source`,
      settledAt: undefined,
      parentTaskId: undefined,
    }))

    const value = await cand({})
    const source = value.candidates.find(item => item.task_id === 't-source')
    assert.equal(source.session.busy, true)
    assert.equal(source.session.active_task_id, 't-busy')
    assert.equal(source.reuse_check.ok, false)
    assert.deepEqual(source.reuse_check.blocked_by, ['session-busy'])
  })
})

// ---------------------------------------------------------------- §九 G2 / 只读

test('G2：返回 JSON 里没有 score / rank / recommend / confidence / match / similarity', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-a', {
      reports: [{ at: iso(1 * HOUR), status: 'done', summary: '结论', headline: '标题' }],
    }))
    d.table.add(mkTask('t-b', {
      status: 'failed',
      error: '失败了',
      reports: [{ at: iso(2 * HOUR), status: 'failed', summary: '没成' }],
    }))
    const value = await cand({ all_workspaces: true })

    const forbidden = ['score', 'rank', 'recommend', 'confidence', 'match', 'similarity']
    const keys = new Set()
    const walk = node => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (!node || typeof node !== 'object') return
      for (const [key, child] of Object.entries(node)) {
        keys.add(key.toLowerCase())
        walk(child)
      }
    }
    walk(value)
    assert.deepEqual(
      [...keys].filter(key => forbidden.some(word => key.includes(word))),
      [],
      '候选里绝不能出现打分/推荐类字段——判定权在模型，插件不打分',
    )
    assert.doesNotMatch(
      JSON.stringify(value),
      /"(score|rank|recommend|confidence|match|similarity)"/,
      '序列化后的 JSON 里也不能有这些键',
    )
  })
})

test('limit：按上限截断，越界按边界夹取（不静默丢参数）', async () => {
  await withDispatch(async ({ d, cand }) => {
    for (let index = 0; index < 5; index += 1) {
      d.table.add(mkTask(`t-${index}`, { settledAt: iso((index + 1) * HOUR) }))
    }
    const two = await cand({ limit: 2 })
    assert.equal(two.count, 2)
    assert.deepEqual(two.candidates.map(item => item.task_id), ['t-0', 't-1'])

    const clamped = await cand({ limit: 99 })
    assert.equal(clamped.count, 5)
    assert.equal(clamped.scope.limit, 10, 'limit 上限是 10')

    const minimum = await cand({ limit: 0 })
    assert.equal(minimum.scope.limit, 1, 'limit 下限是 1')
  })
})

test('只读：候选调用不建任务、不建会话、不改账本', async () => {
  await withDispatch(async ({ d, cand, createdSessions }) => {
    d.table.add(mkTask('t-a'))
    const before = { tasks: d.table.tasks.size, retired: d.retired.size }

    await cand({})
    await cand({ all_workspaces: true })

    assert.equal(d.table.tasks.size, before.tasks, '候选是只读的：任务表条数不变')
    assert.equal(d.retired.size, before.retired, '候选是只读的：退休留痕不变')
    assert.equal(createdSessions.length, 0, '候选不创建子会话')
  })
})

test('显式 workspace 解析不到时报错，不静默退回全量', async () => {
  await withDispatch(async ({ cand }) => {
    await assert.rejects(
      cand({ workspace: '不存在的项目' }),
      error => error.code === 'dispatch/not-found' && /dispatch_workspaces/.test(error.message),
      '必须报 dispatch/not-found 并给出下一步',
    )
  })
})

test('considered 含全部参与筛选的任务（含被排除的）', async () => {
  await withDispatch(async ({ d, cand }) => {
    d.table.add(mkTask('t-ok'))
    d.table.add(mkTask('t-running', { status: 'running', settledAt: undefined }))
    d.table.add(mkTask('t-cancelled', { status: 'cancelled' }))
    const value = await cand({})
    assert.equal(value.considered, 3)
    // 三种状态都是 SETTLED 语义的一部分：候选只取其中「已结算且未取消」的。
    assert.ok(SETTLED.has('cancelled'), '前提：cancelled 属于 SETTLED，必须靠显式排除挡住')
  })
})
