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

import { VOICE_SECTION } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { DISPATCH_HINT, FORCED_HINT } from '../src/prompt.js'

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

async function withDispatch(fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-voice-prompt-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
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
