/**
 * 文案契约（plans/10 §七.1）：把「说人话」钉成可自动检查的断言。
 *
 * 为什么需要它：风格规则写在提示词里，模型会漂移；写在文档里，没人执行。
 * 能自动检查的只有**报告文本本身**——它既是主会话唯一的输入，也是最容易
 * 退化成机器日志的地方（首行 id、英文状态、大段摘要）。
 *
 * 覆盖 §七.1 的 8 条：
 * 1. `reportText` 首行是 `【任务】`，且不含 `t-` 开头的 task id；
 * 2. 首行不含 `done|failed|blocked|ended|interrupted`；
 * 3. 任务名行 ≤40 字，整个首句 ≤60 字；
 * 4. 失败/阻塞报告包含「需要」或「要你」这类行动指向；
 * 5. 批次汇总包含「批次短标签 + 成了/没成」计数；
 * 6. 批次里没成的任务**必须点名**；
 * 7. 任务 id 只出现在末尾「细节」行；
 * 8. 账本原始 `summary` / `detail` 不被压缩（只压缩投影）。
 *
 * 全部离线：纯函数 + 假宿主（mkdtemp），不联网、不碰真实 `~/.dsh`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HEADLINE_MAX, LABEL, REPORT_SECTIONS } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { toolDefinitions } from '../src/tools.js'
import {
  batchLabel, batchText, failureText, fallbackHeadline, headlineOf, idleText,
  labelLength, needText, reportText, shortLabel, sliceLabel, taskLabel, voiceViolations,
} from '../src/voice.js'

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
      async state() { throw Object.assign(new Error('nf'), { code: 'not-found' }) },
      async list() { return { items: [] } },
      async prompt() {},
    },
  }
  return { ctx, agents }
}

function makeAgent(id, status = 'running', events = []) {
  return {
    id, status,
    session: { snapshotEvents: () => events, header: {} },
    ctx: { systemPrompt: { section: () => () => {} } },
    inject() {}, steer() {}, followup() {}, cancel() {},
  }
}

function stub(d, host, dir) {
  d.workspaces = {
    list: () => [], resolve: async () => undefined,
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined, defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return dir },
  }
  d.sessions = {
    cwdFor: () => dir, hint: () => {}, refreshHint: () => {}, dispose: () => {},
    restrictTools: () => () => {}, forgetRestrict: () => {}, holds: () => false,
    async createWorker(sessionId) {
      const agent = makeAgent(sessionId, 'idle')
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    async enterDirectory() {},
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  return d
}

async function withDispatch(fn, config = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-voice-'))
  const d = stub(new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0, archiveAfterHours: 0, ...config,
  }), host, dir)
  try {
    await fn({ d, host, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const mkTask = (id, title, extra = {}) => ({
  id, title, brief: 'b', parentSessionId: 'lead', workerSessionId: `dispatch-${id}`,
  status: 'running', reports: [], createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), ...extra,
})

/** 取报告文本里某一行的内容（段名之后的部分）。 */
const sectionOf = (text, section) => {
  const line = String(text).split('\n').find(item => item.startsWith(section))
  return line === undefined ? undefined : line.slice(section.length)
}

const lines = text => String(text).split('\n')

// ---------------------------------------------------------------- 短标签

test('语法契约 shortLabel 剥掉版本号/编号/括号补充/批次前缀', () => {
  const cases = [
    ['07-P0 登录超时修复', '登录超时修复'],
    ['10-P0 报告文案人话化（headline + 四段式）', '报告文案人话化'],
    ['【批次】重构 auth', '重构 auth'],
    ['批次 3：结算接口测试', '结算接口测试'],
    ['**07-P0** 补集成测试 (no prompt.js)', '补集成测试'],
    ['P1 未发布：CLI 缓存迁移 v1.2', '未发布：CLI 缓存迁移'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(shortLabel(input), expected, `「${input}」的短标签应当是「${expected}」`)
  }
})

test('语法契约 shortLabel 剥完没信息时退回原标题，绝不退回 id', () => {
  // 只有编号的标题：剥完是空的，这时宁可给一个不理想的标签，也不能给 id。
  for (const input of ['07-P0', 'P1', '（补充）', '']) {
    const label = shortLabel(input)
    assert.ok(label.length > 0, `「${input}」不能产出空标签`)
    assert.doesNotMatch(label, /^t-/, '标签绝不能退化成任务 id')
  }
  assert.equal(shortLabel(''), '未命名任务')
})

test('语法契约 shortLabel 截短长标题到 6–12 字，且不切碎西文词', () => {
  const long = shortLabel('把整个后端的会话存储从内存改成基于 sqlite 的持久化实现并补测试')
  assert.ok(labelLength(long) <= LABEL.MAX, `长标题必须被截到 ≤${LABEL.MAX} 字，实际 ${labelLength(long)}：${long}`)

  // 按词截：不能出现半个 `webhook`/`sqlite`。
  const mixed = shortLabel('把 webhook 的重试逻辑挪到独立模块并补超时')
  for (const word of ['webhook', 'sqlite']) {
    if (!mixed.includes(word.slice(0, 3))) continue
    assert.ok(mixed.includes(word) || !mixed.includes(word.slice(0, 3)),
      `不能把「${word}」切成半截：${mixed}`)
  }
  // 极短预算也不能返回空串。
  assert.ok(sliceLabel('webhook 重试', 1).length > 0, '预算比一个词还小时只能硬切，但不能为空')
})

test('语法契约 labelLength 按「读起来几个字」计数（西文词算 1 个）', () => {
  assert.equal(labelLength('登录超时修复'), 6)
  assert.equal(labelLength('CI 缓存迁移'), 5)
  assert.equal(labelLength('webhook'), 1)
  assert.equal(labelLength(''), 0)
})

test('语法契约 同名任务用工作区后缀区分，不撞名时不加后缀', () => {
  const a = mkTask('t-aaa-1', '补集成测试', { workspaceTitle: '结算服务' })
  const b = mkTask('t-bbb-2', '补集成测试', { workspaceTitle: 'dsh-mini-superagent' })
  assert.equal(taskLabel(a, [a]), '补集成测试', '没有同名任务时不该加后缀')
  assert.equal(taskLabel(a, [a, b]), '补集成测试·结算服务')
  assert.equal(taskLabel(b, [a, b]), '补集成测试·dsh-mini-superagent')
  assert.notEqual(taskLabel(a, [a, b]), taskLabel(b, [a, b]), '同名任务必须能区分开')

  // 同一工作区里的同名任务：后缀自己也会撞，只能用 id 尾段兜底。
  const c = mkTask('t-ccc-3', '补集成测试', { workspaceTitle: 'X' })
  const d = mkTask('t-ddd-4', '补集成测试', { workspaceTitle: 'X' })
  assert.notEqual(taskLabel(c, [c, d]), taskLabel(d, [c, d]), '同一工作区下的同名任务也必须区分开')
})

test('语法契约 撞名后缀也不能把标签撑过 40 字硬界', () => {
  const longTitle = '把整个后端的会话存储从内存改成基于 sqlite 的持久化实现并补测试'
  const a = mkTask('t-aaa-1', longTitle, { workspaceTitle: '一个特别特别特别特别长的工作区名字' })
  const b = mkTask('t-bbb-2', longTitle, { workspaceTitle: '另一个特别特别特别特别长的工作区名字' })
  for (const task of [a, b]) {
    const label = taskLabel(task, [a, b])
    assert.ok(labelLength(label) <= LABEL.LINE_MAX,
      `补完后缀也必须 ≤${LABEL.LINE_MAX} 字，实际 ${labelLength(label)}：${label}`)
  }
})

// ---------------------------------------------------------------- headline

test('语法契约 headline 缺省时用「标题 + 状态」兜底，且不能空着', () => {
  for (const status of ['done', 'failed', 'blocked', 'interrupted', 'cancelled', 'ended', 'progress', 'weird']) {
    const task = mkTask('t-h-1', '07-P0 登录超时修复')
    const text = fallbackHeadline(task, { status })
    assert.ok(text.trim().length > 0, `${status} 的兜底结论不能空着`)
    assert.ok(labelLength(text) <= HEADLINE_MAX, `${status} 的兜底句必须 ≤${HEADLINE_MAX} 字：${text}`)
    // 兜底句不能把内部状态词漏给用户。
    assert.doesNotMatch(text, /\b(?:done|failed|blocked|ended|interrupted|cancelled)\b/,
      `${status} 的兜底句里出现了英文状态词：${text}`)
  }

  // 兜底句的形状是「短标签 + 状态」，且**不拿摘要首句充数**：
  // 那样会让【结果】与【说明】两行一模一样，重复一行只会让人开始跳读。
  const done = fallbackHeadline(mkTask('t-h-2', '登录超时修复'), {
    status: 'done', summary: '登录超时修好了，补了 3 个回归测试。还有 webhook 没动。',
  })
  assert.equal(done, '登录超时修复做完了')
  assert.ok(!done.includes('回归测试'), '兜底句不该复述摘要（摘要留在【说明】行）')
})

test('语法契约 headlineOf 保留 worker 的措辞，超长只截不编', () => {
  const task = mkTask('t-h-3', '07-P0 登录超时修复')
  assert.equal(headlineOf(task, { status: 'done', headline: '登录超时修好了' }), '登录超时修好了')
  const long = headlineOf(task, { status: 'done', headline: '好'.repeat(200) })
  assert.ok(labelLength(long) <= HEADLINE_MAX, `超长 headline 必须被截到 ≤${HEADLINE_MAX} 字`)
})

test('语法契约 dispatch_report 的 schema 有可选 headline 字段', () => {
  const def = toolDefinitions({}).find(item => item.name === 'dispatch_report')
  assert.ok(def, 'dispatch_report 必须存在')
  const headline = def.parameters.properties.headline
  assert.ok(headline, 'dispatch_report 必须接受 headline 参数')
  assert.equal(headline.type, 'string')
  assert.deepEqual(def.parameters.required, ['status', 'summary'], 'headline 必须是可选的')
  assert.match(headline.description, /40/, '描述里要写明 40 字的上限')
  assert.match(headline.description, /不含任务 id|不含 id/, '描述里要写明不含任务 id')
  assert.equal(def.parameters.additionalProperties, false)
})

// ---------------------------------------------------------------- 四段式

test('文案契约 reportText 首行是【任务】短标签，不含 id、不含英文状态（§七.1 第 1、2 条）', () => {
  const task = mkTask('t-1a9f-1', '07-P0 重构 auth 模块的令牌刷新')
  for (const status of ['done', 'blocked', 'failed', 'progress', 'ended', 'interrupted']) {
    const text = reportText(task, { status, summary: '随便一句摘要', headline: '登录超时修好了' })
    const first = lines(text)[0]
    assert.ok(first.startsWith(REPORT_SECTIONS.TASK), `${status}：首行必须是「${REPORT_SECTIONS.TASK}」开头：${first}`)
    assert.equal(first, `${REPORT_SECTIONS.TASK}重构 auth 模块的令牌刷新`)
    assert.doesNotMatch(first, /t-[a-z0-9]+-[a-z0-9]+/, `${status}：首行不能出现任务 id`)
    assert.doesNotMatch(first, /\b(?:done|failed|blocked|ended|interrupted|cancelled)\b/,
      `${status}：首行不能出现英文状态词：${first}`)
    // 首句（任务行 + 结果行）也要 ≤60 字。
    const firstSentenceLength = labelLength(lines(text)[0]) + labelLength(lines(text)[1])
    assert.ok(firstSentenceLength <= 60,
      `${status}：首句（任务行+结果行）必须 ≤60 字，实际 ${firstSentenceLength}`)
  }
})

test('文案契约 任务名行 ≤40 字（§七.1 第 3 条）', () => {
  const task = mkTask('t-t3', '把整个后端的会话存储从内存改成基于 sqlite 的持久化实现并补测试')
  const text = reportText(task, { status: 'done', headline: '存储换成 sqlite 了' })
  const name = sectionOf(text, REPORT_SECTIONS.TASK)
  assert.ok(labelLength(name) <= LABEL.LINE_MAX, `任务名行必须 ≤${LABEL.LINE_MAX} 字，实际 ${labelLength(name)}：${name}`)
  // 结果行也要 ≤40 字。
  const result = sectionOf(text, REPORT_SECTIONS.RESULT)
  assert.ok(labelLength(result) <= HEADLINE_MAX, `结果行必须 ≤${HEADLINE_MAX} 字，实际 ${labelLength(result)}：${result}`)
})

test('文案契约 任务 id 只出现在末尾「细节」行', () => {
  const task = mkTask('t-1a9f-1', '07-P0 重构 auth')
  const text = reportText(task, { status: 'done', headline: '修好了', summary: '改了 3 个文件' })
  const rows = lines(text)
  const idRows = rows.filter(row => row.includes('t-1a9f-1'))
  assert.equal(idRows.length, 1, `任务 id 只能出现一次，实际 ${idRows.length} 次：${idRows.join(' / ')}`)
  assert.ok(rows.at(-1).startsWith(REPORT_SECTIONS.DETAIL), '最后一行的段名必须是「细节」')
  assert.ok(rows.at(-1).includes('dispatch_inspect'), '「细节」行要给一个能查的入口')
})

test('文案契约 成功报告不出现「需要你」段（避免这四个字贬值）', () => {
  const task = mkTask('t-ok', '07-P0 登录超时修复')
  const text = reportText(task, { status: 'done', headline: '登录超时修好了', summary: '测试全绿。' })
  assert.doesNotMatch(text, /【需要你】/, '做完了不该喊「需要你」')
})

test('文案契约 失败/阻塞报告必须包含行动指向（§七.1 第 4 条）', () => {
  const task = mkTask('t-bad', '10-P1 CI 缓存迁移')
  for (const [status, summary] of [
    ['blocked', '需要 GitHub 组织级 token 才能改 cache 权限'],
    ['failed', '压测环境连不上，3 次重试均失败'],
    ['interrupted', '宿主重启，会话被关'],
  ]) {
    const text = reportText(task, { status, summary })
    const need = sectionOf(text, REPORT_SECTIONS.NEED)
    assert.ok(need, `${status}：必须出现「需要你」段`)
    assert.match(need, /需要|要你|要不要|重试|定|选/, `${status}：行动指向必须能在「需要你」段里读到：${need}`)
  }
})

test('文案契约 阻塞报告把原因放在说明段，行动放在需要段（不重复）', () => {
  const task = mkTask('t-blk', '10-P1 CI 缓存迁移')
  const text = reportText(task, { status: 'blocked', summary: '需要 GitHub 组织级 token 才能改 cache 权限' })
  const note = sectionOf(text, REPORT_SECTIONS.NOTE)
  const need = sectionOf(text, REPORT_SECTIONS.NEED)
  assert.match(note, /token/, '原因必须在说明段里说清楚')
  assert.doesNotMatch(need, /token/, '行动段不该复述原因（重复一次只会让人跳读）')
})

test('文案契约 needText 只在没成 / 明确要决策时非空', () => {
  assert.equal(needText({}, { status: 'done' }), '')
  assert.equal(needText({}, { status: 'progress' }), '')
  assert.equal(needText({}, { status: 'blocked' }).length > 0, true)
  assert.equal(needText({}, { status: 'failed' }).length > 0, true)
  // 调用方明确写了 need 时照用，不被状态覆盖。
  assert.equal(needText({}, { status: 'done', need: '选 A 还是 B？' }), '选 A 还是 B？')
})

test('文案契约 摘要作为投影被压缩，但账本里的原文不被压缩（§七.1 第 8 条）', async () => {
  const longSummary = `开头${'过'.repeat(3000)}结尾`
  const longDetail = `D${'细'.repeat(3000)}节`
  await withDispatch(async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-cap', '07-P0 长报告预算')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running'))

    const relays = []
    d.relay = async (t, text) => { relays.push(text); return 'delivered' }
    await d.report(host.agents.get(task.workerSessionId), {
      status: 'done', headline: '做完了但写了很长', summary: longSummary, detail: longDetail,
    })

    // 账本：原文一字不少（入库上限是 6000，这里 3006 字，没到上限）。
    const entry = task.reports.at(-1)
    assert.ok(entry.summary.includes('开头') && entry.summary.includes('结尾'), '账本必须保留完整正文')
    assert.ok(entry.detail.includes('D') && entry.detail.includes('节'), 'detail 也必须完整入库')

    // 投影：给模型看的那份被压缩到投影预算内，且短于原文。
    assert.equal(relays.length, 1)
    const projected = sectionOf(relays[0], REPORT_SECTIONS.NOTE)
    assert.ok(projected.length < longSummary.length, `投影必须被压缩，实际 ${projected.length} / ${longSummary.length}`)
    assert.ok(relays[0].length < longSummary.length, '整条回流消息不该比原始摘要还长')
    // detail 不进投影：它是账本与 dispatch_inspect 的东西。
    assert.ok(!relays[0].includes('细细细'), 'detail 不该随报告回流')
  })
})

test('文案契约 账本里的 headline 原样保留，缺省时库里不补兜底句', async () => {
  await withDispatch(async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-hl', '07-P0 登录超时修复')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running'))
    d.relay = async () => 'delivered'
    const worker = host.agents.get(task.workerSessionId)

    await d.report(worker, { status: 'progress', summary: '第一步' })
    assert.equal(task.reports.at(-1).headline, undefined,
      'worker 没写 headline 时，库里不该替他编一句——「没写」与「编了一句」是两件不同的事实')

    await d.report(worker, { status: 'progress', headline: '登录超时已经修好一半', summary: '第二步' })
    assert.equal(task.reports.at(-1).headline, '登录超时已经修好一半', 'worker 的原话必须原样入库')
  })
})

// ---------------------------------------------------------------- 失败 / 中断

test('文案契约 启动失败文案带任务短标签，且不说「启动失败」这种工程词', () => {
  const task = mkTask('t-fail', '07-P0 登录超时修复', { error: 'ENOENT: spawn 失败' })
  const text = failureText(task, { peers: [task] })
  assert.ok(text.startsWith('登录超时修复：'), `必须先说哪条：${text}`)
  assert.match(text, /没能开始/, '要用「没能开始」而不是「启动失败」')
  assert.match(text, /ENOENT/, '原因要带上')
  assert.match(text, /重试/, '失败文案必须有行动指向')
  assert.doesNotMatch(text, /t-fail/, '失败文案不该暴露任务 id')
})

test('文案契约 跑完无结论文案说「它跑完了，但没给结论」', () => {
  const task = mkTask('t-idle', '10-P0 报告文案人话化（headline + 四段式）')
  const text = idleText(task, { body: '我看了一下，还没开始改' })
  assert.ok(text.startsWith('报告文案人话化：'), `必须先说哪条：${text}`)
  assert.match(text, /跑完了/, '要说「跑完了」')
  assert.match(text, /没给结论/, '要说清它没给结论')
  assert.doesNotMatch(text, /本轮没有输出/, '不能用「本轮没有输出」这种机器句')
  assert.match(text, /追问/, '要给出下一步（追问）')
  assert.ok(text.includes('t-idle'), '细节行要带 id')
})

// ---------------------------------------------------------------- 批次

test('文案契约 批次汇总含批次短标签 + 成了/没成计数（§七.1 第 5 条）', () => {
  const members = [
    mkTask('t-1', '重构 auth', { status: 'done' }),
    mkTask('t-2', '重构 billing', { status: 'done' }),
    mkTask('t-3', '重构 notify', { status: 'done' }),
    mkTask('t-4', '补集成测试', { status: 'failed', error: '压测环境连不上' }),
  ]
  const text = batchText(members, { group: 'g-7f21' })
  const rows = lines(text)
  assert.ok(rows[0].startsWith(REPORT_SECTIONS.BATCH), `首行必须是「${REPORT_SECTIONS.BATCH}」：${rows[0]}`)
  assert.match(rows[0], /重构这批 4 条/, '首行要有批次短标签（从成员标题的多数派前缀来）')
  assert.match(text, /4 条成了 3 条/, '必须给出比例')
  assert.match(text, /1 条没成/, '必须给出没成的条数')
  // 批次 id 只能出现在末尾的「细节」行：正文里出现 `g-7f21` 等于把内部编号推给用户。
  const body = rows.filter(row => !row.startsWith(REPORT_SECTIONS.DETAIL)).join('\n')
  assert.doesNotMatch(body, /g-7f21/, '批次 id 不该出现在正文里（细节行除外）')
})

test('文案契约 批次里没成的任务必须点名（不能只写「1 条失败」）', () => {
  const members = [
    mkTask('t-1', '重构 auth', { status: 'done' }),
    mkTask('t-2', '补集成测试', { status: 'failed', error: '压测环境连不上' }),
    mkTask('t-3', '补数据迁移', { status: 'blocked', error: '缺组织级 token' }),
  ]
  const text = batchText(members)
  assert.match(text, /补集成测试/, '失败的任务必须按短标签点名')
  assert.match(text, /补数据迁移/, '阻塞的任务也必须点名')
  assert.match(text, /压测环境连不上/, '点名要带原因')
  assert.match(text, /缺组织级 token/, '阻塞也要带原因')
})

test('文案契约 批次里取消的任务不算「没成」', () => {
  const members = [
    mkTask('t-1', '重构 auth', { status: 'done' }),
    mkTask('t-2', '重构 billing', { status: 'cancelled' }),
  ]
  const text = batchText(members)
  assert.match(text, /已取消/, '取消要单列：它是用户自己收回的，不是失败')
  assert.doesNotMatch(text, /没成/, '全部成功 + 一条取消时不该出现「没成」')
})

test('文案契约 批次全成时不说「需要你」', () => {
  const text = batchText([
    mkTask('t-1', '重构 auth', { status: 'done' }),
    mkTask('t-2', '重构 billing', { status: 'done' }),
  ])
  assert.doesNotMatch(text, /【需要你】/, '全部成功时喊「需要你」纯属噪音')
  assert.match(text, /2 条成了 2 条/)
})

test('文案契约 批次短标签在找不到共同主题时退回条数，不退回 group id', () => {
  const label = batchLabel(['登录超时修复', 'CI 缓存迁移', '结算接口测试'])
  assert.match(label, /这批 3 条/, `找不到共同前缀时给条数，实际 ${label}`)
  assert.doesNotMatch(label, /g-/, '绝不能把 group id 当标签')
  assert.equal(batchLabel([]), '这批任务')
})

// ---------------------------------------------------------------- 真实入口

test('文案契约 真实 report() 回流的文本满足全部契约（taskLabel + 四段式）', async () => {
  await withDispatch(async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-real-1', '07-P0 重构 auth 模块的令牌刷新')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running'))

    const relays = []
    d.relay = async (t, text) => { relays.push(text); return 'delivered' }
    await d.report(host.agents.get(task.workerSessionId), {
      status: 'done',
      headline: '登录超时修好了，补了 3 个回归测试',
      summary: '替换了 refresh 调用点 6 处；新增 3 条用例；测试全绿。',
    })

    assert.equal(relays.length, 1, 'done 必须回流一条')
    const text = relays[0]
    assert.equal(lines(text)[0], `${REPORT_SECTIONS.TASK}重构 auth 模块的令牌刷新`)
    assert.equal(lines(text)[1], `${REPORT_SECTIONS.RESULT}登录超时修好了，补了 3 个回归测试`)
    assert.ok(text.includes('替换了 refresh 调用点 6 处'), '摘要要进说明行')
    assert.equal(lines(text).at(-1), `${REPORT_SECTIONS.DETAIL}dispatch_inspect t-real-1`)
    assert.deepEqual(voiceViolations(text), [], '整段文本不该有任何文案违规')
  })
})

test('文案契约 真实 report() 的 blocked 文本带行动指向', async () => {
  await withDispatch(async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-real-2', '10-P1 CI 缓存迁移')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running'))
    const relays = []
    d.relay = async (t, text) => { relays.push(text); return 'delivered' }
    await d.report(host.agents.get(task.workerSessionId), {
      status: 'blocked', summary: '需要 GitHub 组织级 token 才能改 cache 权限',
    })
    const text = relays[0]
    assert.match(sectionOf(text, REPORT_SECTIONS.NEED) ?? '', /需要|要不要|定/, '阻塞必须告诉用户要干什么')
    assert.deepEqual(voiceViolations(text), [])
  })
})

test('文案契约 真实 relayFailure 的文本带短标签与原因', async () => {
  await withDispatch(async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-real-3', '07-P0 登录超时修复', { status: 'failed', error: 'ENOENT: spawn 失败' })
    d.table.add(task)
    const relays = []
    d.relay = async (t, text) => { relays.push(text); return 'delivered' }
    await d.relayFailure(task)
    assert.equal(relays.length, 1)
    assert.match(relays[0], /^登录超时修复：没能开始——/, `实际：${relays[0]}`)
    assert.match(relays[0], /ENOENT/)
  })
})

test('文案契约 真实 finishIdleTurn 的兜底文本是「跑完了但没给结论」', async () => {
  await withDispatch(async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const task = mkTask('t-real-4', '10-P0 报告文案人话化')
    d.table.add(task)
    host.agents.set(task.workerSessionId, makeAgent(task.workerSessionId, 'running'))
    const relays = []
    d.relay = async (t, text) => { relays.push(text); return 'delivered' }
    await d.finishIdleTurn(task, '我看了三个文件，还没开始改')
    assert.equal(relays.length, 1)
    assert.match(relays[0], /跑完了/, '兜底文案必须说「跑完了」')
    assert.match(relays[0], /没给结论/, '兜底文案必须说清它没结论')
    assert.doesNotMatch(relays[0], /未显式报告/, '不能用「未显式报告」这种机器句')
  })
})

test('文案契约 真实 maybeSummarize 的批次汇总点名失败项', async () => {
  await withDispatch(async ({ d, host }) => {
    host.agents.set('lead', makeAgent('lead', 'running'))
    const members = [
      mkTask('t-b1', '重构 auth', { status: 'running', group: 'g-9' }),
      mkTask('t-b2', '重构 billing', { status: 'running', group: 'g-9' }),
      mkTask('t-b3', '补集成测试', { status: 'running', group: 'g-9' }),
    ]
    for (const item of members) {
      d.table.add(item)
      host.agents.set(item.workerSessionId, makeAgent(item.workerSessionId, 'running'))
    }
    const relays = []
    d.relay = async (t, text) => { relays.push(text); return 'delivered' }

    members[0].status = 'done'
    members[1].status = 'done'
    members[2].status = 'failed'
    members[2].error = '压测环境连不上'
    await d.maybeSummarize(members[2])

    assert.equal(relays.length, 1, '整批只该有一条汇总')
    const text = relays[0]
    assert.match(text, /^【批次】/m, '首行必须是「【批次】」')
    assert.match(text, /3 条成了 2 条/, '要给比例')
    assert.match(text, /1 条没成/, '要给没成的条数')
    assert.match(text, /补集成测试/, '没成的必须点名')
    assert.match(text, /压测环境连不上/, '点名要带原因')
  })
})

test('文案契约 voiceViolations 自检：能抓到反例（防止判据退化成恒真）', () => {
  // 旧形状的报告必须被判违规——否则这条契约等于没写。
  const old = '[dispatch] 任务 t-1a9f-1 · 重构 auth · 报告 done\n摘要：\n改了三处'
  assert.ok(voiceViolations(old).length > 0, '旧形状的报告必须被判违规')

  const good = [
    `${REPORT_SECTIONS.TASK}重构 auth`,
    `${REPORT_SECTIONS.RESULT}登录超时修好了`,
    `${REPORT_SECTIONS.DETAIL}dispatch_inspect t-1a9f-1`,
  ].join('\n')
  assert.deepEqual(voiceViolations(good), [], `合规文本不该报违规：${JSON.stringify(voiceViolations(good))}`)

  // 首行里混进状态词 / id 都要被抓到。
  assert.ok(voiceViolations(`${REPORT_SECTIONS.TASK}重构 auth done`).length > 0)
  assert.ok(voiceViolations(`${REPORT_SECTIONS.TASK}t-abc-1 重构 auth`).length > 0)
})
