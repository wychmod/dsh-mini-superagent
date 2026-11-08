/**
 * 切回「不派发」之后，系统提示段必须**真的**从模型眼前消失。
 *
 * 这条回归对应的真实故障（2026-11-08 14:0x）：用户把输入框里的「派发 →」从某个
 * 工作区切回「不派发」，下一轮模型却仍然读着 `[dsh-mini-superagent 强制派发]` 段，
 * 并照样把活派了出去。当事人当场问「这次我选择了不派发，为什么还是派发了，是 bug 吗」。
 *
 * 为什么旧实现会这样：插件一直假定「提示段文本是函数，装配时重新求值，所以切模式
 * 下一轮就换文案」。这句话只对了**一半**——求值确实换了，但宿主的请求装配不是替换：
 *
 *   宿主 SystemPromptProjection.project()（app.asar，dsh-agent-loop/runtime-context）
 *   - 路由声明 systemPromptUpdate: 'in-history' 时，文本一旦变化，
 *     它 **append** 一个新的 system/message，而不是改写面上原有的那个；
 *   - 只有「开新请求序列」时，才改写节点 0 并把后续仍然非空的旧节点逐条清空。
 *
 * 于是旧节点留在面上，继续被 deriveMessages() 送进请求——模型同时看到
 * 「强制派发」和「工作方式」两段互相矛盾的指令。实测本机会话 session-<redacted> 的
 * 三份 system/message 快照就是这样叠起来的（turn1 FORCED、turn2 FORCED、turn7 SOFT，
 * 三份都还在面上）。
 *
 * 所以修法不是改文案，而是在**语义变了的那一步**主动开新序列（startsRequestSeries），
 * 把收敛这件事交回宿主自己的机制。
 *
 * 这些用例钉的是行为契约，不是实现细节：只要「切模式后下一步会声明新序列」不成立，
 * 它们就必须失败。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatch } from '../src/dispatch.js'
import { FORCED_HINT, SOFT_HINT } from '../src/prompt.js'

// ---------------------------------------------------------------- 夹具

function makeHost() {
  const agents = new Map()
  const warns = []
  const ctx = {
    logger: { warn: (...args) => warns.push(args.map(String).join(' ')), info() {}, error() {} },
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
  return { ctx, agents, warns }
}

/**
 * 假 agent：`ctx.on` 记录监听器（宿主在 agent 作用域上分发 pre-step），
 * `ctx.systemPrompt.section` 记录提示段。暴露两个驱动器：
 *
 * - `renderHint()`：模拟宿主每步装配系统提示（**先于** pre-step）。
 * - `preStep()`：模拟宿主随后分发 agent/pre-step。
 *
 * 这两个的顺序是真实顺序，也是本次缺陷的关键：装配在前，判定在后。
 */
function makeAgent(id) {
  const listeners = new Map()
  const sections = new Map()
  return {
    id,
    status: 'running',
    session: { snapshotEvents: () => [] },
    listeners,
    ctx: {
      on(name, handler) {
        listeners.set(name, handler)
        return () => listeners.delete(name)
      },
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
    async preStep() {
      const handler = listeners.get('agent/pre-step')
      assert.ok(handler, '插件必须注册 agent/pre-step 监听器，否则切模式后无法收敛')
      return handler({ agent: this, messages: [], turn: 1, step: 1 }, async () => ({
        kind: 'enter',
        messages: [],
      }))
    },
  }
}

async function withDispatch(fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-hint-'))
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

/** 把会话设成「必派发」。 */
function mustDispatch(d, sessionId) {
  d.targets.set(sessionId, { workspace_id: 'w-proj', title: '项目 A', path: 'D:\\work\\a' })
}

/** 让收窄真的生效（单纯断言 router 状态的用例都需要它）。 */
function stubRestrict(d) {
  const forgotten = []
  d.sessions.restrictTools = () => () => {}
  d.sessions.forgetRestrict = id => forgotten.push(id)
  return forgotten
}

// ---------------------------------------------------------------- 核心回归

test('切回「不派发」后，下一步必须声明开启新请求序列（否则旧强制段留在历史里）', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')

    // 会话在「必派发」下建立提示段并装配一轮：宿主此时把强制段写进历史。
    d.refreshHint(lead)
    assert.match(lead.renderHint(), /强制派发/, '前提：必派发模式下装配的应是强制段')
    assert.notEqual((await lead.preStep()).startsRequestSeries, true,
      '第一轮装配没有「上一段」可比，不该开新序列')

    // 用户切回「不派发」。
    await d.setTarget('lead', '')

    // 下一步：宿主先装配（此时求值出新文本），再分发 pre-step。
    assert.equal(lead.renderHint(), SOFT_HINT, '装配出来的应是轻提示')
    const decision = await lead.preStep()

    assert.equal(decision.kind, 'enter')
    assert.equal(decision.startsRequestSeries, true,
      '切回不派发之后必须开新序列；否则旧强制段仍在面上，模型会继续照它派发')
  })
})

test('连续装配文本没变时不再重复开新序列（否则每步都白打掉前缀缓存）', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')
    d.refreshHint(lead)

    // 建立基准
    lead.renderHint()
    await lead.preStep()

    // 文本没变：之后每一步都不该开新序列。
    for (let step = 0; step < 3; step += 1) {
      lead.renderHint()
      assert.notEqual((await lead.preStep()).startsRequestSeries, true,
        `第 ${step + 2} 步文本没变，不该开新序列`)
    }
  })
})

test('切回「不派发」后装配的文本是轻提示，且不再带路由锁段', async () => {
  await withDispatch(async ({ d, host }) => {
    stubRestrict(d)
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')
    d.refreshHint(lead)
    d.enforceRouter(lead)      // 进路由模式（真实流程里由首次派发触发）
    assert.equal(d.routerLocked(lead), true, '前提：必派发下应已上锁')
    assert.match(lead.renderHint(), /路由模式/, '前提：路由模式下应带锁段')

    await d.setTarget('lead', '')

    const text = lead.renderHint()
    assert.equal(text, SOFT_HINT, '切回不派发后装配的必须正好是轻提示')
    assert.doesNotMatch(text, /强制派发/, '不该再出现强制段标题')
    assert.doesNotMatch(text, /路由模式/, '不该再出现「write/edit 已收窄」的锁段')
  })
})

test('切回「不派发」后路由锁必须释放，modeOf 回到 off', async () => {
  await withDispatch(async ({ d, host }) => {
    const forgotten = stubRestrict(d)
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')
    d.enforceRouter(lead)
    assert.equal(d.routerLocked(lead), true, '前提：必派发下应已上锁')

    await d.setTarget('lead', '')

    assert.equal(d.routerLocked(lead), false, '锁必须解开')
    assert.equal(d.modeOf('lead'), 'off', 'modeOf 必须回到 off')
    assert.ok(forgotten.includes('lead'), '必须把 restrict 的 disposer 收回去')
  })
})

test('从「不派发」切到必派发也要收敛（反向同样会残留轻提示）', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    d.refreshHint(lead)
    assert.equal(lead.renderHint(), SOFT_HINT)
    await lead.preStep()   // 建立基准

    // 用户选了某个工作区 → 进入必派发。
    await d.setTarget('lead', 'auto')

    assert.match(lead.renderHint(), /强制派发/)
    const decision = await lead.preStep()
    assert.equal(decision.startsRequestSeries, true,
      '反向切换同样要开新序列，否则旧轻提示会和新强制段并存')
  })
})

test('别的监听器已经决定 reject 时原样传下去，不抢决定', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    mustDispatch(d, 'lead')
    d.refreshHint(lead)
    lead.renderHint()
    await lead.preStep()          // 建立基准

    await d.setTarget(d && 'lead', '')   // 制造漂移
    lead.renderHint()

    const handler = lead.listeners.get('agent/pre-step')
    assert.ok(handler, '必须已注册 pre-step handler')
    const out = await handler({ agent: lead }, async () => ({ kind: 'reject' }))
    assert.deepEqual(out, { kind: 'reject' }, 'reject 必须原样返回，不能被改写成 enter')
  })
})

test('开新序列时保留调用方写进决定里的字段（startsRequestSeries 不能被吃掉）', async () => {
  await withDispatch(async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    d.refreshHint(lead)
    lead.renderHint()
    await lead.preStep()

    await d.setTarget('lead', 'auto')
    lead.renderHint()

    const handler = lead.listeners.get('agent/pre-step')
    const messages = [{ id: 'm-1' }]
    const out = await handler({ agent: lead }, async () => ({ kind: 'enter', messages }))
    assert.equal(out.kind, 'enter')
    assert.deepEqual(out.messages, messages, '消息批次必须原样保留')
    assert.equal(out.startsRequestSeries, true)
  })
})

test('轻提示与强制段都真的存在（前提校验，防止文案改名后本组用例失去意义）', () => {
  assert.match(FORCED_HINT, /强制派发/)
  assert.match(SOFT_HINT, /工作方式/)
  assert.doesNotMatch(SOFT_HINT, /强制派发/)
})
