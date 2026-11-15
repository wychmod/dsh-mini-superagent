/**
 * 「说话方式」提示段的门禁（plans/10 §五、§七.1、§八 P1）。
 *
 * 为什么需要它：plans/10 §九 把「提示词继续膨胀」列成风险——规则越多，每条被读到的
 * 概率越低，最后受害的恰是本段。所以 §七.1 给了两个数：**≤ 8 行、≤ 500 字**。
 * 没有门禁时，「再加一句」永远是最省事的改法，一年后这段会变成第二个 `BACKGROUND_CONTRACT`。
 *
 * 三个容易被写错的地方，本文件刻意避开：
 *
 * 1. **量的对象**：必须量**真正装配进请求的那段文本**，不是源码里常量的长度。
 *    源码长度可以靠注释排版变短，装配出来的才是模型读到的东西。所以这里走真实的
 *    装配链路：`Dispatch` → `refreshHint()` → `agent.ctx.systemPrompt.section()` 的
 *    `text()` 求值，拿到的就是宿主下一次 `project()` 会写进 `system/message` 的字符串。
 *    连 `ROUTER_LOCKED` 追加那段也一起量——它同样会进同一个提示段。
 *
 * 2. **怎么读文件**：只通过 import 拿模块导出的值。绝不用 shell 重定向/`git show > file`
 *    之类的方式读源码——PowerShell 的默认重定向会倒出 UTF-16/BOM，按字节或按行数统计
 *    都会失真（本仓库上一个任务已经踩过这个坑）。字符串一旦经过 shell，长度就不再可信。
 *
 * 3. **怎么数**：行数按 `\n` 切（`split('\n').length`）；字数按 **code point** 数
 *    （`Array.from(text).length`），不是 `String.length`（UTF-16 码元）。中文 BMP 内
 *    两者相同，但 emoji / 生僻字是代理对，用码元数会虚高，把一次正常润色误判成超限。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HANDOFF_JUDGE_SECTION, VOICE_SECTION } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { DISPATCH_HINT, FORCED_HINT, HANDOFF_JUDGE_RULE } from '../src/prompt.js'

// ---------------------------------------------------------------- 夹具

function makeHost() {
  const agents = new Map()
  return {
    agents,
    ctx: {
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
    },
  }
}

/**
 * 假 agent，与 `test/hint-sync.test.js` 同一套驱动器：`renderHint()` 模拟宿主
 * 每步装配系统提示时对 `text()` 求值。这里只要这一个能力，所以不复制它的 pre-step 部分。
 */
function makeAgent(id) {
  const sections = new Map()
  return {
    id,
    status: 'running',
    session: { snapshotEvents: () => [] },
    ctx: {
      on: () => () => {},
      systemPrompt: {
        section(spec) {
          sections.set(spec.name, spec)
          return () => sections.delete(spec.name)
        },
      },
    },
    renderHint() {
      const spec = sections.get('dsh-mini-superagent')
      assert.ok(spec, '提示段必须已注册')
      return typeof spec.text === 'function' ? spec.text() : spec.text
    },
  }
}

async function withDispatch(fn, options = {}) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-voice-prompt-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
    ...(options.config ?? {}),
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
  try {
    await fn({ d, host, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 切段

/**
 * 从**装配后的完整提示**里切出「说话方式」段。
 *
 * 切法：找到标题行，往下取到段结束为止。段结束的判据有两条，任一命中即停：
 * - **空行**：提示段之间用 `\n\n` 分隔（`SPEAK_RULE` 是作为一个整体拼进去的），
 *   所以空行就是段边界；
 * - **既不以空白也不以 `-` 开头的行**：段内只可能是「`- ` 列表项」或「两个空格缩进的
 *   示例行」，其余一律是下一段的正文（下一段 `HANDOFF_RULE` 的首行是 `**派发即移交**`）。
 *
 * 为什么不能只按空行切：路由模式下 `ROUTER_LOCKED` 是 `${base}\n\n${ROUTER_LOCKED}` 追加的，
 * 靠空行同样能断开——但若哪天有人把某段改成以 `\n` 单换行拼接，只按空行切会把下一段
 * 一起吞进来，门禁就会在「段已经超长」时报通过。两条判据叠加后**失败是朝安全方向的**：
 * 吞多了只会让行数/字数看起来更大，超限照样被抓到。
 *
 * 另有一条兜底上限（`MAX_LINES + 4`）：切段逻辑本身出错时不要吞掉整份提示，
 * 让断言报出「切出来太长」而不是在错误的对象上给出通过。
 *
 * @param {string} text 装配后的完整提示
 * @returns {string} 段原文（含标题行，不含分隔空行）
 */
function sliceVoiceSection(text) {
  const lines = String(text).split('\n')
  const start = lines.findIndex(line => line.includes(VOICE_SECTION.TITLE))
  if (start < 0) return ''
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') break                        // 段落之间的空行 = 段结束
    if (!/^[\s-]/.test(line)) break                       // 下一段以正文或 `**粗体**` 开头
    if (out.length > VOICE_SECTION.MAX_LINES + 4) break   // 兜底：别吞掉整份提示
    out.push(line)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- 门禁

test('两种模式下装配出的提示都含「说话方式」段（防止拼接时整段丢失）', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)

    // 轻提示：不派发。
    d.refreshHint(lead)
    const soft = lead.renderHint()
    assert.equal(soft, DISPATCH_HINT)
    assert.ok(sliceVoiceSection(soft).length > 0, '轻提示里必须有「说话方式」段')

    // 强制派发：设一个具体工作区。
    d.targets.set('lead', { workspace_id: 'w-proj', title: '项目 A', path: 'D:\\work\\a' })
    d.refreshHint(lead)
    const forced = lead.renderHint()
    assert.equal(forced, FORCED_HINT)
    assert.ok(sliceVoiceSection(forced).length > 0, '强制提示里必须有「说话方式」段')
  })
})

test('「说话方式」段 ≤ 8 行（plans/10 §七.1 第一条门禁）', async () => {
  for (const [name, hint] of [['DISPATCH_HINT', DISPATCH_HINT], ['FORCED_HINT', FORCED_HINT]]) {
    const section = sliceVoiceSection(hint)
    assert.ok(section, `${name}：切不出「说话方式」段，门禁无从谈起`)
    const lines = section.split('\n').length
    assert.ok(
      lines <= VOICE_SECTION.MAX_LINES,
      `${name}：风格段 ${lines} 行，超过 ${VOICE_SECTION.MAX_LINES} 行上限。`
        + `提示词膨胀会稀释每条规则——要加内容先删一段重复解释（plans/10 §九）：\n${section}`,
    )
  }
})

test('「说话方式」段 ≤ 500 字（plans/10 §七.1 第二条门禁，按 code point 数）', async () => {
  for (const [name, hint] of [['DISPATCH_HINT', DISPATCH_HINT], ['FORCED_HINT', FORCED_HINT]]) {
    const section = sliceVoiceSection(hint)
    // 用 Array.from 而不是 String.length：后者数的是 UTF-16 码元，emoji/生僻字会虚高。
    const chars = Array.from(section).length
    assert.ok(
      chars <= VOICE_SECTION.MAX_CHARS,
      `${name}：风格段 ${chars} 字，超过 ${VOICE_SECTION.MAX_CHARS} 字上限：\n${section}`,
    )
  }
})

test('门禁量的是装配后的文本，且路由锁段追加进来也不超限（不是只量常量）', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    d.sessions.restrictTools = () => () => {}
    d.sessions.forgetRestrict = () => {}
    d.targets.set('lead', { workspace_id: 'w-proj', title: '项目 A', path: 'D:\\work\\a' })
    d.refreshHint(lead)
    d.enforceRouter(lead)
    assert.equal(d.routerLocked(lead), true, '前提：必派发下应已上锁')

    const text = lead.renderHint()
    assert.match(text, /路由模式/, '前提：路由模式下提示里应追加 ROUTER_LOCKED')
    // 路由锁段在「说话方式」段**之后**，不能改变后者的长度；这里同时确认
    // 装配链路真的把两段拼在一起了（量的是这个最终字符串，不是常量）。
    const section = sliceVoiceSection(text)
    assert.ok(Array.from(section).length <= VOICE_SECTION.MAX_CHARS,
      `带路由锁的装配结果里，风格段超限：${Array.from(section).length} 字`)
  })
})

// ---------------------------------------------------------------- 内容锚点

test('段落把七条说话规则都钉住了（防止润色时漏掉某条）', async () => {
  // 只断言**语义锚点**，不断言整段排版：措辞还会改，断言整段会把测试变成绊脚石，
  // 然后被绕过——那正是 plans/10 §七 说的「规则写在文档里，没人执行」。
  const anchors = [
    ['先认领再结论', /先说哪条任务/],
    ['默认 2-3 行', /默认 2-3 行/],
    ['说人话 / 不报内部词', /不出现任务 id、子会话 id、done\/failed\/blocked/],
    ['不写流水账', /不写过程流水账/],
    ['失败说清卡哪 + 你只需做什么', /卡在哪 \+ 你只需做什么/],
    ['有建议才写', /有下一步建议才写/],
    ['细节从 dispatch_inspect 取', /细节从 dispatch_inspect 取/],
  ]
  for (const [name, hint] of [['DISPATCH_HINT', DISPATCH_HINT], ['FORCED_HINT', FORCED_HINT]]) {
    for (const [what, pattern] of anchors) {
      assert.match(hint, pattern, `${name}：「说话方式」段缺「${what}」`)
    }
  }
})

test('段落写明优先级：风格规则不得覆盖事实与安全规则，简洁与准确冲突时先准确', () => {
  for (const [name, hint] of [['DISPATCH_HINT', DISPATCH_HINT], ['FORCED_HINT', FORCED_HINT]]) {
    assert.match(hint, /不得覆盖事实与安全规则/, `${name}：没有优先级声明，风格会压过事实`)
    assert.match(hint, /简洁与准确冲突时先准确/, `${name}：没写「准确优先」`)
  }
})

test('段落带 1–2 组改前/改后示例，且标明只是兜底参考（plans/10 §八 P1 / §九）', () => {
  for (const [name, hint] of [['DISPATCH_HINT', DISPATCH_HINT], ['FORCED_HINT', FORCED_HINT]]) {
    const section = sliceVoiceSection(hint)
    // 示例组数按「改前…→…」的箭头数算。
    const pairs = (section.match(/→/g) ?? []).length
    assert.ok(pairs >= 1 && pairs <= 2, `${name}：示例应为 1–2 组，实际 ${pairs} 组`)
    // 只有示例句、没有「别照抄」的约束时，模型会把示例当模板——§九 把这条列为风险。
    assert.match(section, /兜底参考/, `${name}：示例没说明只是兜底参考`)
    assert.match(section, /别照抄句式|不要照抄/, `${name}：示例没说明不要照抄句式（模板句会让话变僵）`)
  }
})

// ---------------------------------------------------------------- 接续判断段（plans/11 §七）

/**
 * 从装配后的完整提示里切出「接续判断」段。
 *
 * 切法与 `sliceVoiceSection()` 同一套：段之间用 `\n\n` 分隔，段内只有标题行与
 * `- ` 列表项。三条判据叠加后失败一律朝安全方向（吞多了只会显得更长，超限照样被抓）。
 *
 * @param {string} text 装配后的完整提示
 * @returns {string} 段原文（含标题行，不含分隔空行）
 */
function sliceJudgeSection(text) {
  const lines = String(text).split('\n')
  const start = lines.findIndex(line => line.includes(HANDOFF_JUDGE_SECTION.TITLE))
  if (start < 0) return ''
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') break
    if (!/^[\s-]/.test(line)) break
    if (out.length > HANDOFF_JUDGE_SECTION.MAX_LINES + 4) break
    out.push(line)
  }
  return out.join('\n')
}

test('P1：autoHandoff 关闭（默认）时，两种模式的提示都不含接续判断段', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)

    // 轻提示模式。
    d.refreshHint(lead)
    assert.equal(lead.renderHint(), DISPATCH_HINT, 'autoHandoff 关闭时轻提示必须逐字不变')
    assert.ok(!sliceJudgeSection(lead.renderHint()), 'autoHandoff 关闭时不该注入接续段')

    // 强制派发模式。
    d.targets.set('lead', { workspace_id: 'w-proj', title: '项目 A', path: 'D:\\work\\a' })
    d.refreshHint(lead)
    assert.equal(lead.renderHint(), FORCED_HINT, 'autoHandoff 关闭时强制提示必须逐字不变')
    assert.ok(!sliceJudgeSection(lead.renderHint()), 'autoHandoff 关闭时不该注入接续段')
  })
})

test('P2：autoHandoff 打开时含接续段，且 ≤5 行 / ≤250 字（两种模式）', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)

    const check = (name, text) => {
      const section = sliceJudgeSection(text)
      assert.ok(section, `${name}：autoHandoff 打开时必须注入接续段`)
      const lines = section.split('\n').length
      const chars = Array.from(section).length
      assert.ok(lines <= HANDOFF_JUDGE_SECTION.MAX_LINES,
        `${name}：接续段 ${lines} 行，超过 ${HANDOFF_JUDGE_SECTION.MAX_LINES} 行上限：\n${section}`)
      assert.ok(chars <= HANDOFF_JUDGE_SECTION.MAX_CHARS,
        `${name}：接续段 ${chars} 字，超过 ${HANDOFF_JUDGE_SECTION.MAX_CHARS} 字上限：\n${section}`)
    }

    d.refreshHint(lead)
    check('DISPATCH_HINT（软提示）', lead.renderHint())

    d.targets.set('lead', { workspace_id: 'w-proj', title: '项目 A', path: 'D:\\work\\a' })
    d.refreshHint(lead)
    check('FORCED_HINT（强制派发）', lead.renderHint())
  }, { config: { autoHandoff: true } })
})

test('P3：接续段的位置在 SPEAK_RULE 之后、HANDOFF_RULE 之前（两种模式一致）', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)

    d.refreshHint(lead)
    d.targets.set('lead', { workspace_id: 'w-proj', title: '项目 A', path: 'D:\\work\\a' })
    d.refreshHint(lead)
    const text = lead.renderHint()
    const order = [
      text.indexOf(VOICE_SECTION.TITLE),
      text.indexOf(HANDOFF_JUDGE_SECTION.TITLE),
      text.indexOf('**派发即移交**'),
    ]
    assert.ok(order[0] >= 0 && order[1] >= 0 && order[2] >= 0, '三个锚点都必须出现')
    assert.ok(order[0] < order[1] && order[1] < order[2],
      `接续段的顺序错了：说话方式@${order[0]}、接续判断@${order[1]}、派发即移交@${order[2]}`)
  }, { config: { autoHandoff: true } })
})

test('P4：注入接续段后，「说话方式」段仍是 8 行 / ≤500 字（没有挤爆既有门禁）', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    d.refreshHint(lead)
    const section = sliceVoiceSection(lead.renderHint())
    assert.equal(section.split('\n').length, VOICE_SECTION.MAX_LINES,
      '说话方式段的行数不该因为新增独立段而变化')
    assert.ok(Array.from(section).length <= VOICE_SECTION.MAX_CHARS,
      '说话方式段不该因为新增独立段而超字数')
  }, { config: { autoHandoff: true } })
})

test('P5：接续段里必须有「由你判断」与「不打分」两个锚点（防止改回插件推荐）', () => {
  const section = sliceJudgeSection(HANDOFF_JUDGE_RULE)
  assert.ok(section, 'HANDOFF_JUDGE_RULE 自身必须能切出整段')
  assert.match(section, /由你判断/, '必须把判定权明确交给模型')
  assert.match(section, /不打分/, '必须否定「插件打分」这件事')
})

/**
 * P6：接续段必须给**可照做的正反例**，而不是一句「酌情判断」。
 *
 * 为什么单独立一条测试，而不是并进 P5（P5 管的是「权在模型、插件不打分」）：
 * 那是**边界**断言（不许退回插件推荐），本测试是**可操作性**断言（模型读完知道
 * 下一步怎么选）。两者会各自退化：这一版之前 P5 一直绿——「由你判断」写得很清楚，
 * 边界守住了；但判据只是一句「同一份产物 / 同一条工作线」的形容词，模型无以照做，
 * 于是连续 6 条同质任务一条都没接（用户实测）。**边界对、判据空**，一样是错。
 *
 * 断言只钉「关键短语还在」，不钉整段原文：整段比对会让任何一次正常润色都变红，
 * 门禁就从「防膨胀」退化成「防改字」，最后大家只能删测试。
 * 这里钉的四组词各自对应一条不可删的语义：
 *   - `handoff_from` / `handoff_reason`：动作名。只说「该复用」而不给参数名，模型知道该接
 *     也不知道传什么；`handoff_reason` 尤其容易在压缩字数时被删掉，但它是「人话解释」的入口。
 *   - `该接` / `该新开`：正反例**成对**出现。只剩一边时，模型只有「接」的样例，
 *     会退化成同质就接；只剩另一边则等于回到保守默认（本 bug 的状态）。
 *   - `干净假设`：反向例子里最容易被删掉的一条——独立复核不该带着旧结论。
 *   - `重建认知`：那句「复用省的是认知、不是思考」，是两组例子的共同前提。
 *   - `workspace` / `preset`：复用的硬约束，不写模型会在被拒后才发现。
 */
test('P6：接续段给正反例（该接 / 该新开）与复用边界，不是「酌情判断」', () => {
  const section = sliceJudgeSection(HANDOFF_JUDGE_RULE)
  assert.ok(section, '前提：HANDOFF_JUDGE_RULE 自身必须能切出整段')

  // 动作名：判据必须落到能传的参数上。
  assert.match(section, /handoff_from/, '必须点名 handoff_from，否则模型知道「该接」也不知道怎么接')
  assert.match(section, /handoff_reason/, '必须同时点名 handoff_reason（接续要给一句给用户看懂的理由）')

  // 正反例成对：缺任一边，判据都会退回单向默认。
  assert.match(section, /该接/, '必须给出「该复用」的正例')
  assert.match(section, /该新开/, '必须给出「该新开」的反例——只给正例会让模型一律去接')
  // 同质任务是这次事故的原型，必须留一个能认出来的具体情形。
  assert.match(section, /同质任务/, '正例里必须包含「一批同质任务」——那是本次实测事故的场景')

  // 反向例子里最容易被当成冗余删掉的一条。
  assert.match(section, /干净假设/, '反例必须包含「需要干净假设」的情形（独立复核不该带旧结论）')

  // 共同前提：省的是认知，不是思考；用不到那份认知时复用只是污染窗口。
  assert.match(section, /重建认知/, '必须保留「复用省的是重建认知」这句区分')

  // 复用的硬约束（机制侧会直接报错，提示侧要先说清）。
  assert.match(section, /workspace/, '必须提醒不能跨 workspace')
  assert.match(section, /preset/, '必须提醒复用沿用原模型与 preset（不能改）')
})

/**
 * P7：门禁上限**只许收紧，不许放宽**。
 *
 * 为什么要单独钉住这两个数字：`HANDOFF_JUDGE_SECTION.MAX_LINES / MAX_CHARS` 是常量，
 * 而所有长度断言都是拿段落的真实长度去比常量——**把常量调大，全部长度测试依旧全绿**，
 * 门禁等于被一行改动悄悄取消。这类「判据自己可以改判据」的漏洞，只能靠一个朝着
 * 单一方向（≤）的断言堵住：想收紧随便改，想放宽就会红。
 *
 * 用 ≤ 而不是 === ：收紧是本段希望的演化方向（提示词只该变短），不该被测试挡住。
 */
test('P7：接续段门禁上限只许收紧不许放宽（≤5 行 / ≤250 字）', () => {
  assert.ok(HANDOFF_JUDGE_SECTION.MAX_LINES <= 5,
    `接续段行数上限被放宽到 ${HANDOFF_JUDGE_SECTION.MAX_LINES} 行（不得大于 5）`)
  assert.ok(HANDOFF_JUDGE_SECTION.MAX_CHARS <= 250,
    `接续段字数上限被放宽到 ${HANDOFF_JUDGE_SECTION.MAX_CHARS} 字（不得大于 250）`)
  // 段落实测必须仍在上限内，且不是「刚好顶死」到没有余量（余量留给下一次必须的措辞修正）。
  const section = sliceJudgeSection(HANDOFF_JUDGE_RULE)
  const chars = Array.from(section).length
  assert.ok(chars <= HANDOFF_JUDGE_SECTION.MAX_CHARS,
    `接续段 ${chars} 字，超过 ${HANDOFF_JUDGE_SECTION.MAX_CHARS} 字上限`)
})

test('门禁能真的失败（负向对照：判据不许退化成恒真）', () => {
  // 门禁类测试最危险的不是漏报，是**恒真**：切段函数切错了对象、或者数字写成了
  // 一个永远不会被触发的阈值，测试照样全绿，而提示词可以无限膨胀。
  // 这里把当前段落人为撑长，确认同一个判据会给出「超限」——判据本身是对的。
  const section = sliceVoiceSection(DISPATCH_HINT)
  assert.ok(section, '前提：必须能切出段落')

  const tooManyLines = `${section}\n- 第 9 行\n  第 10 行`
  assert.ok(
    tooManyLines.split('\n').length > VOICE_SECTION.MAX_LINES,
    '负向对照失效：补 2 行后仍未超过行数上限，说明判据算错了对象',
  )

  const tooLong = `${section}${'额外'.repeat(20)}`
  assert.ok(
    Array.from(tooLong).length > VOICE_SECTION.MAX_CHARS,
    '负向对照失效：补 40 字后仍未超过字数上限',
  )
})
