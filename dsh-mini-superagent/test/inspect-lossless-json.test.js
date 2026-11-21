/**
 * 回归：工具返回值里**不能有 `undefined`**（宿主判定 "not lossless JSON"）。
 *
 * ## 这条用例钉住的真实故障
 *
 * `dispatch_inspect` 曾对某些任务稳定返回：
 *
 *   Error: tool "dispatch_inspect" returned invalid output: value is not lossless JSON
 *
 * 复现条件不是「输出太长」，也不是 emoji / 截断——是任务里存在一条**不带
 * `detail` 的报告**（`progress` 最常见）。`#admitEntry()` 里 `detail,` 那一行
 * 会给条目创建一个自有键 `detail: undefined`，`recent_reports` 又把它原样转发，
 * 于是工具返回值里出现 `undefined`。
 *
 * 为什么以前一直没被发现：
 * - `JSON.stringify` 会**静默丢掉** undefined 值，所以落盘的账本、快照对比、
 *   以及只做 `JSON.parse(JSON.stringify(x))` 的断言全部照常通过；
 * - 宿主校验的不是「序列化后的文本」，而是**值本身**（app.asar
 *   `util/values` 的 `walkJsonValue`）：字符串/布尔/有限数字之外，
 *   `typeof v !== 'object'` 一律判失败，`undefined` 命中这一条。
 *
 * 所以这里**不能用 JSON 往返来断言**——那正是当初漏过去的检测方式。
 * 必须直接遍历值，见 `hostLosslessViolations()`。
 *
 * ## 为什么把宿主规则抄一份进测试
 *
 * 宿主校验器在 app.asar 里，测试不能 import 它。抄一份有「抄错就白测」的风险，
 * 所以这里只抄**会导致本次故障的那几条**，并且额外用一条自检用例
 * （`宿主规则自检`）证明这份抄写确实会拒绝 undefined、确实接受孤立代理项——
 * 后者是本案里**被排除**的那个假设，也必须钉住，否则以后有人会再往那个方向查。
 *
 * 全部离线：假宿主 + 临时状态目录，不联网、不碰真实 `~/.dsh`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatch } from '../src/dispatch.js'
import { toolDefinitions } from '../src/tools.js'

// ---------------------------------------------------------------- 宿主校验规则

/**
 * 抄自 app.asar `util/values` 的 `walkJsonValue`（只保留判失败的几条分支）。
 *
 * 原文（压缩后）关键片段：
 *   if (current === null) assign(null)
 *   else if (typeof current === 'boolean' || typeof current === 'string') assign(current)
 *   else if (typeof current === 'number') { if (!Number.isFinite(current) || Object.is(current, -0)) return void 0; ... }
 *   else { if (typeof current !== 'object') return void 0; ... }
 *
 * 注意 `typeof current === 'string'` 是**无条件接受**的：字符串里有没有孤立代理项、
 * 能不能无损转 UTF-8，宿主这条路径**完全不看**。所以「emoji 切断代理对」不是本案
 * 的成因（见 `宿主规则自检`）。
 *
 * @param {unknown} root 工具返回值
 * @returns {string[]} 违规路径；空数组 = 宿主会接受
 */
function hostLosslessViolations(root) {
  const problems = []
  const ancestors = new Set()

  const isIntrinsicObjectPrototype = value => {
    if (Object.getPrototypeOf(value) !== null) return false
    const ctor = Object.getOwnPropertyDescriptor(value, 'constructor')?.value
    return typeof ctor === 'function' && ctor.name === 'Object' && ctor.prototype === value
  }
  const hasPlainObjectPrototype = value => {
    const proto = Object.getPrototypeOf(value)
    return proto === null || (typeof proto === 'object' && isIntrinsicObjectPrototype(proto))
  }
  const hasPlainArrayPrototype = value => {
    const proto = Object.getPrototypeOf(value)
    return Array.isArray(proto) && (() => {
      const grand = Object.getPrototypeOf(proto)
      return typeof grand === 'object' && grand !== null && isIntrinsicObjectPrototype(grand)
    })()
  }

  const visit = (current, path) => {
    if (current === null) return
    const type = typeof current
    if (type === 'boolean' || type === 'string') return
    if (type === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) problems.push(`${path}: 非法数字 ${current}`)
      return
    }
    if (type !== 'object') {
      // undefined / function / symbol / bigint 全落这里——本次故障就是 undefined。
      problems.push(`${path}: typeof ${type}（${String(current)}）`)
      return
    }
    if (ancestors.has(current)) { problems.push(`${path}: 循环引用`); return }
    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) problems.push(`${path}: 非普通数组原型`)
      if (Reflect.ownKeys(current).length !== current.length + 1) problems.push(`${path}: 数组带额外自有键`)
      ancestors.add(current)
      current.forEach((item, index) => visit(item, `${path}[${index}]`))
      ancestors.delete(current)
      return
    }
    if (!hasPlainObjectPrototype(current)) { problems.push(`${path}: 非普通对象（${current?.constructor?.name}）`); return }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(current, key)) {
        problems.push(`${path}: 不可枚举键或 symbol 键 ${String(key)}`)
      }
    }
    ancestors.add(current)
    for (const key of Reflect.ownKeys(current)) visit(current[key], `${path}.${String(key)}`)
    ancestors.delete(current)
  }

  visit(root, '$')
  return problems
}

/** 断言宿主会接受这个工具返回值；失败时把违规路径全部打出来。 */
function assertHostAccepts(value, label) {
  const problems = hostLosslessViolations(value)
  assert.deepEqual(problems, [], `${label}：工具返回值含宿主会拒绝的值 →\n  ${problems.join('\n  ')}`)
}

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

async function withDispatch(fn, config = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-lossless-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    noticeMergeWindowMs: 0,
    ...config,
  })
  // 网关全部替身化：本文件只关心「报告怎么入库、怎么投影」，不需要真会话。
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
  host.agents.set('lead', makeWorker('lead'))

  const tools = Object.fromEntries(toolDefinitions(d).map(item => [item.name, item]))
  const callTool = (tool, args, caller = { agent: { id: 'lead' } }) => tool.execute(args, caller)
  const launch = async args => d.table.get((await callTool(tools.dispatch_launch, args)).task.task_id)
  const inspect = async id => callTool(tools.dispatch_inspect, { task_id: id })
  const list = () => callTool(tools.dispatch_list, {})
  // `dispatch_report` 只认被派发的 worker，必须用 worker 身份调用。
  const reportAs = async (task, input) => callTool(
    tools.dispatch_report, input, { agent: host.agents.get(task.workerSessionId) },
  )
  try {
    await fn({ d, host, dir, tools, callTool, launch, inspect, list, reportAs })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function drain(times = 8) {
  for (let index = 0; index < times; index += 1) await tick()
}

// ---------------------------------------------------------------- 抄写自检

test('宿主规则自检：确实拒绝 undefined、确实接受孤立代理项', () => {
  // 必须拒绝：undefined 是本次故障的成因。
  assert.deepEqual(
    hostLosslessViolations({ task: { recent_reports: [{ at: 'x', summary: 's', detail: undefined }] } }),
    ['$.task.recent_reports[0].detail: typeof undefined（undefined）'],
    'undefined 必须被这份抄写判失败，否则下面的用例全是假的绿',
  )
  // 必须接受：字符串宿主持无条件接受，孤立代理项不会让它失败。
  // 这一条钉住「emoji 假设已被排除」，防止以后又往那个方向查。
  const lone = 'x\uD83Dy'
  assert.equal(lone.length, 3)
  assert.deepEqual(hostLosslessViolations({ s: lone }), [], '宿主对字符串不做代理项校验')
  // 对照组：JSON 往返确实有损——证明「JSON 往返」不能用来发现这个问题。
  assert.notEqual(Buffer.from(lone, 'utf8').toString('utf8'), lone, '孤立代理项在 UTF-8 往返里会变成 U+FFFD')
  assert.equal(JSON.stringify({ s: lone }).includes('\\ud83d'), true, 'JSON.stringify 会把孤立代理项写成转义序列，看不出异常')
})

// ---------------------------------------------------------------- 核心回归

test('回归：只给 summary 的 progress 报告，不能让 dispatch_inspect 返回 undefined', async () => {
  await withDispatch(async ({ launch, inspect, reportAs }) => {
    const task = await launch({ title: '进度不写 detail 的任务', brief: 'b' })
    const worker = task.workerSessionId

    // 关键形状：**不带 detail**。这正是线上翻车的报告形态。
    await reportAs(task, { status: 'progress', summary: '只给摘要，不给 detail' })
    await reportAs(task, { status: 'progress', summary: '第二条同样不给 detail', headline: '还在跑' })

    const stored = task.reports.at(-1)
    assert.equal(Object.hasOwn(stored, 'detail'), false, '账本条目不该带一个值为 undefined 的 detail 自有键')

    const result = await inspect(task.id)
    assertHostAccepts(result, 'dispatch_inspect（无 detail 的 progress 报告）')

    // 正文一个都不能少：报告照样入库、照样可读。
    assert.equal(result.task.recent_reports.length, 2)
    assert.equal(result.task.recent_reports[0].summary, '只给摘要，不给 detail')
    assert.equal('detail' in result.task.recent_reports[0], false, '没有 detail 就不输出这个键（而不是输出 undefined）')
    assert.equal(result.task.recent_reports[1].headline, '还在跑')
    // worker 身份确实被认出来了（否则上面两条 report 会抛错，任务根本没起来）
    assert.ok(worker)
  })
})

test('回归：带 detail 的报告照旧完整可读（条件展开没有误删正文）', async () => {
  await withDispatch(async ({ launch, inspect, reportAs }) => {
    const task = await launch({ title: '带 detail 的任务', brief: 'b' })
    await reportAs(task, {
      status: 'progress',
      summary: '有摘要',
      detail: '这里有很长的改动清单\n第二行',
      headline: '一句话结论',
    })
    await reportAs(task, { status: 'done', summary: '收尾' })

    const result = await inspect(task.id)
    assertHostAccepts(result, 'dispatch_inspect（带 detail）')
    const entry = result.task.recent_reports[0]
    assert.equal(entry.detail, '这里有很长的改动清单\n第二行', 'detail 正文必须原样保留')
    assert.equal(entry.headline, '一句话结论')
    // 混合形态：一条有 detail、一条没有，是线上最常见的组合。
    assert.equal('detail' in result.task.recent_reports[1], false)
    assertHostAccepts(result, 'dispatch_inspect（有 detail 与无 detail 混排）')
  })
})

test('回归：dispatch_list 与 dispatch_report 的返回值也过宿主校验', async () => {
  await withDispatch(async ({ launch, inspect, list, reportAs }) => {
    const task = await launch({ title: '列表路径', brief: 'b' })
    const receipt = await reportAs(task, { status: 'progress', summary: '无 detail' })
    assertHostAccepts(receipt, 'dispatch_report 回执')
    // `truncated` 只在真截断时出现——没有它时不能是 `undefined`。
    assert.equal('truncated' in receipt, false)

    const listed = await list()
    assertHostAccepts(listed, 'dispatch_list')
    // 有 progress 报告的任务在列表里也要能读（列表读的是 summary，不读 detail）。
    assert.ok(listed.tasks.some(card => card.task_id === task.id))
    assertHostAccepts(await inspect(task.id), 'dispatch_inspect')
  })
})

test('回归：长 detail（被 clip 截断）+ 无 detail 的进度报告同时存在时仍然可读', async () => {
  await withDispatch(async ({ launch, inspect, reportAs }) => {
    const task = await launch({ title: '长正文任务', brief: 'b' })
    // 先来一条超长 detail（会被 clip 到 maxReportDetailChars），再来一条不带 detail 的。
    const longDetail = '改'.repeat(9000)
    await reportAs(task, { status: 'progress', summary: '长正文', detail: longDetail })
    await reportAs(task, { status: 'progress', summary: '无 detail' })

    const result = await inspect(task.id)
    assertHostAccepts(result, 'dispatch_inspect（长 detail + 无 detail）')
    const [withDetail, withoutDetail] = result.task.recent_reports
    assert.ok(withDetail.detail.length <= 4000, '入库截断上限仍然生效')
    assert.equal(Object.hasOwn(withoutDetail, 'detail'), false)
  })
})

test('回归：emoji 出现在 detail 里也不会让工具失败（排除长度/代理项假设）', async () => {
  await withDispatch(async ({ launch, inspect, reportAs }) => {
    const task = await launch({ title: 'emoji 任务', brief: 'b' })
    // 构造一条正好在 clip 头部边界切到代理对中间的长文本：
    // clip(x, 4000) 的头部预算 = (4000-40)/2 = 1980，把 emoji 摆在 1979。
    const detail = `${'a'.repeat(1979)}🚀${'b'.repeat(6000)}`
    await reportAs(task, { status: 'done', summary: 'emoji', detail })

    const result = await inspect(task.id)
    // 即使截断真的把代理对切开了，宿主也接受（字符串无条件通过）——
    // 这条断言的意义是证明「emoji 不是本故障的成因」。
    assertHostAccepts(result, 'dispatch_inspect（detail 内含 emoji）')
    assert.equal(result.task.status, 'done')
  })
})

test('回归：账本里存量的「坏形状」条目也必须能读（升级后不必清洗历史数据）', async () => {
  await withDispatch(async ({ d, launch, inspect }) => {
    const task = await launch({ title: '存量坏数据', brief: 'b' })
    // 模拟 0.10.2 及更早写进账本的条目：`detail` 是一个值为 undefined 的自有键。
    // 磁盘上的 JSON 里这个键其实**不存在**（stringify 丢掉了），但内存里如果
    // 有人重新造出这个形状，投影层也必须挡住——这是纵深防御，不是重复修同一处。
    task.reports.push({ at: '2026-11-20T16:59:49.677Z', status: 'progress', summary: '存量进度', detail: undefined })

    const result = await inspect(task.id)
    assertHostAccepts(result, 'dispatch_inspect（内存里带着 undefined 的存量条目）')
    assert.equal('detail' in result.task.recent_reports[0], false)
    assert.equal(result.task.recent_reports[0].summary, '存量进度')
    assert.ok(d)
  })
})
