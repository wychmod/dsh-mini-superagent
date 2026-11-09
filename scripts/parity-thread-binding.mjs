#!/usr/bin/env node
/**
 * plans/08 阶段 0 的**行为不变**对照证据：同一组 1:1 场景，分别在
 * 「重构前的 src 副本」与「当前 src」上跑一遍，把 8 个 `byWorker()` 调用点
 * 背后的判据值打印出来，逐项比对。
 *
 * 为什么需要它：`npm test` 全绿只能证明既有断言没被改坏，证明不了「读同一条任务」。
 * 而本轮的改动**正是**把 `byWorker()` 从「扫全表返回第一个匹配」换成「查显式绑定」——
 * 一个纯内部的重构，必须有前后两份可对照的观测记录，否则「行为不变」只是一句声明。
 *
 * 用法：
 *   node scripts/parity-thread-binding.mjs <重构前 src 的目录>
 *
 * 例：
 *   node scripts/parity-thread-binding.mjs %TEMP%\mas-before-src-08p0
 *
 * 零依赖；退出码 0 = 两份完全一致。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 插件本体在 <repo>/dsh-mini-superagent/src；这个脚本在 <repo>/scripts（仓库根）。
const NEW_SRC = resolve(HERE, '..', 'dsh-mini-superagent', 'src')
const OLD_SRC = process.argv[2] ? resolve(process.argv[2]) : undefined

if (!OLD_SRC) {
  console.error('用法：node scripts/parity-thread-binding.mjs <重构前的 src 目录>')
  process.exit(2)
}

/** 按目录加载一份 Dispatch（两份代码各自独立，互不共享模块状态）。 */
async function load(srcDir) {
  const dispatch = await import(pathToFileURL(join(srcDir, 'dispatch.js')).href)
  return dispatch.Dispatch
}

/** 造宿主桩：agents 表 + 空的 gateway 依赖。 */
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
    },
  }
  return { ctx, agents }
}

function makeAgent(id, status = 'running') {
  return {
    id, status,
    session: { snapshotEvents: () => [] },
    ctx: { systemPrompt: { section: () => () => {} } },
    steer() {}, followup() {}, inject() {}, cancel() {},
  }
}

/** 在某个 Dispatch 实例上复刻 8 个调用点，返回它们各自看到的东西。 */
async function observe(Dispatch, dir) {
  const host = makeHost()
  const d = new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
    noticeMergeWindowMs: 0,
  })
  d.workspaces = {
    list: () => [], resolve: async () => undefined,
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined, defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return dir },
  }
  const deliveries = []
  d.sessions = {
    cwdFor: () => dir, hint: () => {}, dispose: () => {},
    restrictTools: () => () => {}, forgetRestrict: () => {}, holds: () => false,
    async createWorker(sessionId) {
      const agent = makeAgent(sessionId, 'idle')
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver(sessionId, requestId, text) {
      deliveries.push({ sessionId, requestId })
      return { delivered: 'inbox', woke: false }
    },
  }

  const out = {}
  const ts = '2026-01-01T00:00:00.000Z'
  const mk = (id, workerSessionId, status, extra = {}) => ({
    id, title: id, brief: 'b', parentSessionId: 'lead', workerSessionId,
    status, reports: [], createdAt: ts, updatedAt: ts, ...extra,
  })

  try {
    // ── 场景 1：一条任务（今天唯一会出现的形状）─────────────────────────
    host.agents.set('lead', makeAgent('lead'))
    const lead = host.agents.get('lead')
    const worker = makeAgent('dispatch-t-one', 'running')
    host.agents.set('dispatch-t-one', worker)
    const one = mk('t-one', 'dispatch-t-one', 'running')
    d.table.add(one)

    // ① dispatch.js `enforceRouter`（源码注释里写作 byWorker(agent.id)，判「不是 worker」）
    out['enforceRouter/byWorker(worker)'] = !!d.table.byWorker('dispatch-t-one')
    // ② dispatch.js `decorateSubagent`（worker 本身不算 subagent）
    out['decorateSubagent/byWorker(worker)'] = !!d.table.byWorker('dispatch-t-one')
    // ③ dispatch.js `workerAncestorOf`（沿 parentSession 链找 worker）
    out['workerAncestorOf/byWorker(worker)'] = !!d.table.byWorker('dispatch-t-one')
    // ④ dispatch.js `report`（报告记到哪条任务上）
    const reported = await d.report(worker, { status: 'progress', summary: '进度' })
    out['report/task_id'] = reported.task_id
    out['report/target-reports'] = one.reports.length
    // ⑤ dispatch.js `onWorkerIdle`（换一个已结算的场景看它选中谁）
    out['onWorkerIdle/byWorker(worker)'] = d.table.byWorker('dispatch-t-one')?.id ?? null
    // ⑥ dispatch.js `onWorkerError`（同样只看选中谁）
    out['onWorkerError/byWorker(worker)'] = d.table.byWorker('dispatch-t-one')?.id ?? null
    // ⑦ index.js `agent/status → running`：workerTurnStarted 会刷新 turnStartedAt
    const beforeTurn = one.turnStartedAt ?? null
    d.workerTurnStarted(d.table.byWorker('dispatch-t-one'))
    out['agent-status/running-updated'] = (one.turnStartedAt ?? null) !== beforeTurn
    // ⑧ index.js `agent/disposed`：查出来的任务是不是「已结算就跳过」那一条
    out['agent-disposed/target'] = d.table.byWorker('dispatch-t-one')?.id ?? null
    out['agent-disposed/target-settled'] = (() => {
      const task = d.table.byWorker('dispatch-t-one')
      return !!task && ['done', 'blocked', 'failed', 'cancelled', 'ended', 'interrupted'].includes(task.status)
    })()

    // 结算之后：8 个调用点里「查出已结算任务」的形态（agent/disposed 走这条）
    d.settle(one, 'done')
    out['after-settle/byWorker'] = d.table.byWorker('dispatch-t-one')?.id ?? null
    out['after-settle/status'] = d.table.byWorker('dispatch-t-one')?.status ?? null
    out['after-settle/onWorkerIdle-early-return'] = (() => {
      const task = d.table.byWorker('dispatch-t-one')
      return !task || task.status !== 'running'
    })()

    // ── 场景 2：未派发过的会话（两个调用点必须判「不是 worker」）──────────
    host.agents.set('plain', makeAgent('plain'))
    out['unknown-session/byWorker'] = d.table.byWorker('plain-session')?.id ?? null

    // ── 场景 3：retry 换 attempt 会话后，旧会话不再命中、新会话命中 ────────
    const retried = mk('t-retry', 'dispatch-t-retry', 'failed', { attempt: 2 })
    d.table.add(retried)
    out['retry/old-session'] = d.table.byWorker('dispatch-t-retry')?.id ?? null
    retried.workerSessionId = 'dispatch-t-retry-a2'
    out['retry/new-session'] = d.table.byWorker('dispatch-t-retry-a2')?.id ?? null
    out['retry/stale-session'] = d.table.byWorker('dispatch-t-retry')?.id ?? null

    // ── 场景 4：两个主会话各派一条（互不干扰）────────────────────────────
    const other = mk('t-other', 'dispatch-t-other', 'running', { parentSessionId: 'lead-2' })
    d.table.add(other)
    host.agents.set('dispatch-t-other', makeAgent('dispatch-t-other'))
    out['two-sessions/first'] = d.table.byWorker('dispatch-t-one')?.id ?? null
    out['two-sessions/second'] = d.table.byWorker('dispatch-t-other')?.id ?? null
    out['two-sessions/count'] = d.table.tasks.size

    // ── 场景 5：退休之后 byWorker 查不到（活表里已经没有它）──────────────
    d.enforceLedgerCap()
    out['after-cap/tasks'] = [...d.table.tasks.keys()].sort().join(',')
    out['after-cap/retired'] = [...d.retired.keys()].sort().join(',')

    // ── 场景 6：真实派发（`launch()` 造出的任务形状，含新增的 threadId）─────
    const launched = await d.launch(lead, { title: '派一条', brief: '看看形状' })
    // 等 pump 把 start() 走完（createWorker 是同步返回的桩，仍在微任务里）
    await new Promise(resolve => setTimeout(resolve, 5))
    // 任务 id 带时间戳，两份代码必然不同——归一成占位符，比的是**形状**而不是那串随机数。
    const norm = value => String(value).split(launched.id).join('<taskId>')
    out['launch/status-after-pump'] = launched.status
    out['launch/workerSessionId-shape'] = (/^dispatch-<taskId>$/.test(norm(launched.workerSessionId)))
    out['launch/threadId'] = typeof launched.threadId === 'string' ? norm(launched.threadId) : 'n/a'
    out['launch/delivered-kinds'] = deliveries
      .filter(item => item.sessionId === launched.workerSessionId)
      .map(item => norm(item.requestId).replace(/:\d+$/, ':N')).join(',')
    out['launch/byWorker-returns-it'] = d.table.byWorker(launched.workerSessionId)?.id === launched.id

    // ── 场景 7：落盘形状（threadId 是唯一新增的键）────────────────────────
    await d.persist()
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'))
    out['persist/version'] = raw.version
    out['persist/task-keys'] = (() => {
      const keys = new Set()
      for (const item of raw.tasks) for (const key of Object.keys(item)) keys.add(key)
      // `threadId` 是本轮**唯一**预期的数据结构变化：它不是行为差异，而是
      // 「任务多了线程标识」这件事本身。为了让这张对照表只回答「行为变没变」，
      // 把它从集合里摘掉单独列一行；其余任何新增/缺失的键都会照样暴露成差异。
      keys.delete('threadId')
      return [...keys].sort().join(',')
    })()
    out['persist/has-threadId'] = raw.tasks.every(item => item.threadId === undefined)
      ? 'no (老形状)'
      : 'yes (本轮新增)'
    return out
  } finally {
    await d.dispose()
  }
}

const OldDispatch = await load(OLD_SRC)
const NewDispatch = await load(NEW_SRC)

const dirOld = await mkdtemp(join(tmpdir(), 'mas-parity-old-'))
const dirNew = await mkdtemp(join(tmpdir(), 'mas-parity-new-'))
let oldOut
let newOut
try {
  oldOut = await observe(OldDispatch, dirOld)
  newOut = await observe(NewDispatch, dirNew)
} finally {
  await rm(dirOld, { recursive: true, force: true })
  await rm(dirNew, { recursive: true, force: true })
}

const keys = [...new Set([...Object.keys(oldOut), ...Object.keys(newOut)])].sort()
const width = Math.max(...keys.map(key => key.length))
/**
 * **允许出现差异的观测量**，且只允许是这一个方向（重构后才有值）。
 *
 * 它们不是行为，而是「任务多了线程标识」这件事本身 —— 本轮**就是要**加它。
 * 白名单写在代码里而不是「看到差异就放过」：任何别的键一旦不同，脚本必须失败。
 */
const EXPECTED = new Map([
  ['launch/threadId', value => value === 'thread-<taskId>'],
  ['persist/has-threadId', value => value.startsWith('yes')],
])
const diffs = []
console.log(`${'调用点 / 观测量'.padEnd(width)} | 重构前                          | 重构后`)
console.log(`${'-'.repeat(width)}-+---------------------------------+--------------------------------`)
for (const key of keys) {
  const before = JSON.stringify(oldOut[key] ?? null)
  const after = JSON.stringify(newOut[key] ?? null)
  const same = before === after
  const expected = !same && EXPECTED.get(key)?.(newOut[key])
  if (!same && !expected) diffs.push({ key, before, after })
  const mark = same ? '' : (expected ? '   ← 预期（新增字段）' : '   ← 差异')
  console.log(`${key.padEnd(width)} | ${String(before).padEnd(31)} | ${String(after)}${mark}`)
}

console.log('')
if (diffs.length) {
  console.error(`✖ ${diffs.length} 项不一致：`)
  for (const diff of diffs) console.error(`  - ${diff.key}: 重构前 ${diff.before} / 重构后 ${diff.after}`)
  process.exitCode = 1
} else {
  const changed = keys.filter(key => JSON.stringify(oldOut[key] ?? null) !== JSON.stringify(newOut[key] ?? null))
  console.log(`✔ ${keys.length} 项观测量中，${keys.length - changed.length} 项逐字一致；`
    + `${changed.length} 项差异全部是**预期的数据结构新增**（${changed.join('、')}）。`)
  console.log('  1:1 场景下 8 个 byWorker() 调用点的行为未变。')
}
