/**
 * 工作区放置逻辑（`Dispatch.placementFor`）与 `dispatch_launch` **参数优先级**的回归测试。
 *
 * 前半部分钉住 0.8.1 重写后的放置语义：**有目标用目标，没有/找不到目标才退回日期工作区**。
 * 0.8.0 及更早的实现是 `workerWorkspace === 'target' && target`，而该配置默认
 * `day`，于是用户明确指定了工作区也会被塞进【派发】——表现为「每次启动都凭空
 * 多出一个【派发】YYYY-MM-DD 工作区」。这几条用例正是从那个真实缺陷反推出来的。
 *
 * 后半部分（`launch()` 的参数取舍与错误文案）来自 2026-11-08 12:10 的**真实派发事故**：
 * 1. 错误文案与事实不符：歧义被误报成「且允许新建被关闭」，而调用方**根本没传**
 *    `create_workspace`（默认 true），没有任何人关掉新建；
 * 2. 显式 `cwd` 被记住的 `auto`/目标**静默覆盖**，用户给的目录从头到尾没生效。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULTS, WORKER_WORKSPACE_CWD, WORKER_WORKSPACE_DAY, normalizeWorkerWorkspace,
} from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { WorkspaceGateway } from '../src/workspaces.js'

// ---------------------------------------------------------------- 夹具

/**
 * 造一个只实现 placementFor 所需表面的 Dispatch。
 * 不用真 Dispatch 是因为构造会碰状态目录；这里要测的是纯放置决策。
 */
function makeDispatch({ workspaces = [], config = {} } = {}) {
  const calls = { dayWorkspace: 0, list: 0 }
  const d = new Dispatch({ logger: { warn() {}, info() {}, error() {} }, get: () => undefined }, config)
  d.workspaces = {
    list() { calls.list += 1; return workspaces },
    async dayWorkspace(day) {
      calls.dayWorkspace += 1
      return { id: `day-${day}`, path: `C:\\root\\派发\\${day}`, title: `【派发】${day}` }
    },
  }
  d.calls = calls
  return d
}

const PROJECT = { id: 'w-proj', path: 'D:\\work\\project-a', title: '项目 A' }

// ---------------------------------------------------------------- 有目标

test('有目标工作区时直接用目标，不碰 dayWorkspace', async () => {
  const d = makeDispatch({ workspaces: [PROJECT] })
  const placement = await d.placementFor({ workspaceId: 'w-proj', cwd: 'D:\\work\\project-a' })

  assert.deepEqual(placement, { workspaceId: 'w-proj', path: 'D:\\work\\project-a', title: '项目 A' })
  assert.equal(d.calls.dayWorkspace, 0,
    '有目标时一次都不能调 dayWorkspace —— 这是「凭空多出【派发】工作区」的直接来源')
})

test('默认配置（workerWorkspace: day，就是用户遇到的默认值）下目标依然优先', async () => {
  // 这条是本次修复的核心断言：0.8.0 在默认配置下会把目标忽略掉。
  assert.equal(DEFAULTS.workerWorkspace, WORKER_WORKSPACE_DAY)
  const d = makeDispatch({ workspaces: [PROJECT] })
  const placement = await d.placementFor({ workspaceId: 'w-proj', cwd: 'D:\\elsewhere' })

  assert.equal(placement.workspaceId, 'w-proj')
  assert.equal(d.calls.dayWorkspace, 0)
})

test('workerWorkspace 配成 cwd 时，目标仍然优先（这个配置管不到有目标的情况）', async () => {
  const d = makeDispatch({ workspaces: [PROJECT], config: { workerWorkspace: 'cwd' } })
  const placement = await d.placementFor({ workspaceId: 'w-proj', cwd: 'D:\\elsewhere' })

  assert.equal(placement.workspaceId, 'w-proj',
    'workerWorkspace 只决定「没有目标时怎么办」，不能反过来压掉用户的明确选择')
  assert.equal(d.calls.dayWorkspace, 0)
})

test('workerWorkspace 配成任何奇怪值都不会让目标失效', async () => {
  for (const value of ['target', 'day', 'cwd', 'DAY', '  cwd  ', '', undefined, 'nonsense']) {
    const d = makeDispatch({ workspaces: [PROJECT], config: { workerWorkspace: value } })
    const placement = await d.placementFor({ workspaceId: 'w-proj', cwd: 'D:\\elsewhere' })
    assert.equal(placement.workspaceId, 'w-proj', `workerWorkspace=${JSON.stringify(value)} 时目标仍须优先`)
    assert.equal(d.calls.dayWorkspace, 0, `workerWorkspace=${JSON.stringify(value)} 时不该建日期工作区`)
  }
})

// ---------------------------------------------------------------- 无目标

test('没有目标时退回当天的【派发】工作区', async () => {
  const d = makeDispatch({ workspaces: [PROJECT] })
  const placement = await d.placementFor({ cwd: 'D:\\work\\project-a' })

  assert.equal(d.calls.dayWorkspace, 1, '没有目标才应该调用 dayWorkspace')
  assert.match(placement.title, /^【派发】\d{4}-\d{2}-\d{2}$/)
  assert.equal(placement.path, `C:\\root\\派发\\${placement.title.replace('【派发】', '')}`)
})

test('没有目标且 dayWorkspace 不可用（无注册表）时退回 cwd', async () => {
  const d = makeDispatch()
  d.workspaces = { list: () => [], dayWorkspace: async () => undefined }
  const placement = await d.placementFor({ cwd: 'D:\\work\\project-a' })

  assert.deepEqual(placement, { path: 'D:\\work\\project-a' })
  assert.equal(placement.workspaceId, undefined, '没有工作区可用时不能伪造一个 workspaceId')
})

test('workerWorkspace: cwd 时无目标也不建日期工作区', async () => {
  const d = makeDispatch({ config: { workerWorkspace: WORKER_WORKSPACE_CWD } })
  const placement = await d.placementFor({ cwd: 'D:\\work\\project-a' })

  assert.deepEqual(placement, { path: 'D:\\work\\project-a' })
  assert.equal(d.calls.dayWorkspace, 0, 'cwd 模式就是不想要【派发】兜底，不能偷偷建')
})

// ---------------------------------------------------------------- 目标失效

test('有目标但注册表里找不到该 id → 退回日期工作区', async () => {
  const d = makeDispatch({ workspaces: [PROJECT] })
  const placement = await d.placementFor({ workspaceId: 'w-deleted', cwd: 'D:\\work\\project-a' })

  assert.equal(d.calls.dayWorkspace, 1, '目标已失效就等于没有目标，应该走日期兜底')
  assert.match(placement.title, /^【派发】/)
  assert.notEqual(placement.workspaceId, 'w-deleted', '不能把一个已不存在的 id 传给宿主')
})

test('有目标但注册表为空 → 退回日期工作区', async () => {
  const d = makeDispatch({ workspaces: [] })
  const placement = await d.placementFor({ workspaceId: 'w-proj', cwd: 'D:\\work\\project-a' })

  assert.equal(d.calls.dayWorkspace, 1)
  assert.match(placement.title, /^【派发】/)
})

// ---------------------------------------------------------------- 归一化

test('workerWorkspace 归一化：cwd 保留，其余（含旧值 target）退回 day', () => {
  assert.equal(normalizeWorkerWorkspace('cwd'), WORKER_WORKSPACE_CWD)
  assert.equal(normalizeWorkerWorkspace('CWD'), WORKER_WORKSPACE_CWD)
  assert.equal(normalizeWorkerWorkspace('  cwd  '), WORKER_WORKSPACE_CWD)

  assert.equal(normalizeWorkerWorkspace('day'), WORKER_WORKSPACE_DAY)
  // 0.8.0 的旧值：语义已被「有目标用目标」取代，无目标时按 day 兜底。
  assert.equal(normalizeWorkerWorkspace('target'), WORKER_WORKSPACE_DAY)
  // 未知值/空值不抛错，退回最保守的 day。
  assert.equal(normalizeWorkerWorkspace(''), WORKER_WORKSPACE_DAY)
  assert.equal(normalizeWorkerWorkspace(undefined), WORKER_WORKSPACE_DAY)
  assert.equal(normalizeWorkerWorkspace(null), WORKER_WORKSPACE_DAY)
  assert.equal(normalizeWorkerWorkspace('nonsense'), WORKER_WORKSPACE_DAY)
})

// ---------------------------------------------------------------- 惰性创建

test('provision() 不创建日期工作区（日期工作区必须惰性创建）', async () => {
  const created = []
  const d = makeDispatch({ workspaces: [PROJECT] })
  d.workspaces = {
    list: () => [],
    // 只要有人碰这两个方法就记下来：provision 只该建默认工作区，不该碰【派发】。
    async defaultWorkspace() { created.push('default'); return undefined },
    async dayWorkspace(day) { created.push(`day:${day}`); return undefined },
  }
  d.config.provisionDefaultWorkspace = true

  await d.provision()

  assert.ok(!created.some(item => item.startsWith('day:')),
    `provision() 不该建日期工作区，实际碰了：${created.join(', ') || '（无）'}`)
})

test('反复用同一个目标派发，不会累积出日期工作区', async () => {
  const d = makeDispatch({ workspaces: [PROJECT] })
  for (let i = 0; i < 5; i += 1) {
    const placement = await d.placementFor({ workspaceId: 'w-proj', cwd: 'D:\\work\\project-a' })
    assert.equal(placement.workspaceId, 'w-proj')
  }
  assert.equal(d.calls.dayWorkspace, 0, '5 次带目标的放置，dayWorkspace 调用次数必须是 0')
})

// ================================================================
// `launch()` 的参数优先级与错误文案（P1 修复 1 / 修复 2）
//
// 下面这组跑的是**真** `launch()`，而不是只测放置决策：这次要钉住的两个缺陷
// 全都在 launch() 里（参数取舍、错误文案归因），只测 placementFor 会把它们整段跳过。
// ================================================================

/** 现场实测的注册表顺序（2026-11-08 12:10，`dispatch_workspaces()` 的输出）。 */
function liveRegistryItems() {
  return [
    { id: 'cb8aac4b', path: 'D:\\idea\\dsh-mini-superagent', title: 'dsh-mini-superagent' },
    { id: 'a36c3a05', path: 'D:\\idea\\dsh-mini-superagent\\dsh-mini-superagent', title: 'dsh-mini-superagent' },
    { id: 'b49b7d54', path: 'C:\\Users\\u\\Documents\\mini-superagent', title: 'mini-superagent' },
    { id: 'cf7d05e0', path: 'C:\\Users\\u\\Documents\\mini-superagent\\派发\\2026-11-07', title: '【派发】2026-11-07' },
  ]
}

/**
 * 假注册表：实现 `WorkspaceGateway` 用到的那几个方法，行为对齐真实宿主。
 * `createLog` 记下每次 create 的入参 ——「歧义时不许新建」这条断言全靠它。
 */
function fakeRegistry(items = []) {
  const map = new Map(items.map(item => [item.id, { sessionIds: [], ...item }]))
  const createLog = []
  let counter = 0
  return {
    list: () => [...map.values()],
    get: id => map.get(id),
    resolveByPath: async path => [...map.values()].find(item => item.path === path),
    create: async (path, title) => {
      createLog.push({ path, title })
      const found = [...map.values()].find(item => item.path === path)
      if (found) return found
      counter += 1
      const derived = title ?? String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? 'workspace'
      const workspace = { id: `w-new-${counter}`, path, title: derived, sessionIds: [] }
      map.set(workspace.id, workspace)
      return workspace
    },
    archiveSession: async () => {},
    createLog,
  }
}

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
      async state() { throw Object.assign(new Error('nf'), { code: 'nf' }) },
      async list() { return { items: [] } },
      async prompt() {},
    },
  }
  return { ctx, agents }
}

function makeAgent(id) {
  return {
    id,
    status: 'running',
    session: { snapshotEvents: () => [], header: {} },
    ctx: { systemPrompt: { section: () => () => {} } },
    steer() {}, followup() {}, inject() {}, cancel() {},
  }
}

/**
 * 装一个真实 `Dispatch`，只把「宿主 API」换成桩。
 *
 * 工作区那一半刻意用**真的** `WorkspaceGateway`：歧义判定、`reason` 归因、
 * 「歧义不许新建」的纪律都在它里面，换成假货等于连被测逻辑一起假掉。
 */
async function withLaunchDispatch(registryItems, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-launch-'))
  const registry = fakeRegistry(registryItems)
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  d.workspaces = new WorkspaceGateway({
    get: name => (name === 'workspaceRegistry' ? registry : undefined),
    logger: { warn() {}, info() {}, error() {} },
  }, d.config)
  d.sessions = {
    cwdFor: () => dir,
    hint: () => {},
    refreshHint: () => {},
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
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  try {
    await fn({ d, host, registry, dir })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/** 等 pump 把队列跑空（`launch()` 里的 `void this.pump()` 是异步的）。 */
async function drain(d, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = [...d.table.tasks.values()].at(-1)
    if (task && task.status !== 'queued') return task
    if (Date.now() > deadline) throw new Error('等待 pump 超时')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

// -------------------------------------------------- 修复 1：错误文案与事实相符

test('修复1 歧义时错误文案说明「多个候选」并列出路径，且不说「允许新建被关闭」', async () => {
  await withLaunchDispatch(liveRegistryItems(), async ({ d, host, registry }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    // 调用方目标是 auto：显式 workspace 的失败不能被 auto 掩盖。
    d.targets.set('lead', { auto: true, title: '自动选择', path: '' })

    let error
    try {
      // 注册表里「dsh-mini-superagent」出现两次（仓库根 + 包根）→ resolveOrCreate 归因 ambiguous。
      await d.launch(lead, { title: '改点东西', brief: 'b', workspace: 'dsh-mini-superagent' })
    } catch (caught) {
      error = caught
    }

    assert.ok(error, '歧义时必须抛错，绝不能猜一个目录或者凭空新建')
    const message = String(error.message)

    // ① 必须把「有多个候选」这件事说出来。
    assert.match(message, /多个工作区/, `错误文案要说清「这个名字对应多个工作区」，实际：${message}`)

    // ② 候选必须带 path：两个 dsh-mini-superagent 光看标题/id 分不出包根还是仓库根。
    assert.ok(message.includes('D:\\idea\\dsh-mini-superagent'),
      `候选里要有仓库根的 path，实际：${message}`)
    assert.ok(message.includes('D:\\idea\\dsh-mini-superagent\\dsh-mini-superagent'),
      `候选里要有包根的 path，实际：${message}`)

    // ③ 本条用例的核心：**不能**出现「且允许新建被关闭」。
    //    调用方根本没传 create_workspace（默认 true），没人关闭新建。
    assert.ok(!message.includes('允许新建被关闭'),
      `歧义不是「新建被关闭」，这句文案会把排障方向带偏到配置上。实际：${message}`)

    // ④ 要提示怎么解决，否则用户只知道失败。
    assert.match(message, /id|绝对路径/, `要给出可行的改法，实际：${message}`)

    // ⑤ 歧义时绝不能新建：那会把「两个分不清」升级成「三个分不清」。
    assert.deepEqual(registry.createLog, [], '歧义时一次 create 都不能有')
    assert.equal(d.workspaces.list().length, 4, '注册表条数不该变（没有新建）')

    // ⑥ 一个任务都不该入队。
    assert.equal(d.table.tasks.size, 0, '解析失败就不能留下半个任务')
  })
})

test('修复1 not-found 且调用方真的关了新建 → 保留「且允许新建被关闭」', async () => {
  await withLaunchDispatch(liveRegistryItems(), async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)

    await assert.rejects(
      () => d.launch(lead, { title: 't', brief: 'b', workspace: '根本没这个名字', createWorkspace: false }),
      error => {
        const message = String(error.message)
        // 这一种情况「新建被关闭」是**真话**：用户确实传了 create_workspace: false。
        assert.match(message, /允许新建被关闭/, `调用方真关了新建，就该如实说，实际：${message}`)
        assert.ok(!message.includes('多个工作区'), '这不是歧义，不该说成多个候选')
        assert.match(message, /根本没这个名字/, `错误里要带上原始引用，实际：${message}`)
        return true
      },
    )
    assert.equal(d.table.tasks.size, 0)
  })
})

test('修复1 not-found 且允许新建但仍失败 → 不把两句不相关的原因捆成一句', async () => {
  await withLaunchDispatch(liveRegistryItems(), async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    // 让「允许新建」这条路径真的失败：绝对路径 + 注册表 create 抛错。
    d.workspaces.ensure = async () => { throw new Error('磁盘满了') }

    await assert.rejects(
      () => d.launch(lead, { title: 't', brief: 'b', workspace: 'D:\\nowhere\\brand-new-project' }),
      error => {
        const message = String(error.message)
        // 新建是开着的，所以不能说「允许新建被关闭」。
        assert.ok(!message.includes('允许新建被关闭'),
          `新建开着的，不能说成被关闭。实际：${message}`)
        assert.match(message, /找不到/, `"找不到"仍是事实，实际：${message}`)
        return true
      },
    )
  })
})

// -------------------------------------------------- 修复 2：显式 cwd 不被静默覆盖

test('修复2 显式 cwd + 会话目标是 auto → task.cwd 等于显式目录，且不落日期工作区', async () => {
  await withLaunchDispatch(liveRegistryItems(), async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    // 复现事故现场：该会话的派发目标是 auto。
    d.targets.set('lead', { auto: true, title: '自动选择', path: '' })

    const explicit = await mkdtemp(join(tmpdir(), 'mas-explicit-cwd-'))
    try {
      const task = await d.launch(lead, { title: '在这个目录里改代码', brief: 'b', cwd: explicit })

      // ① 显式 cwd 必须原样成为任务的工作目录（事故现场它被 auto 静默覆盖了）。
      assert.equal(task.cwd, explicit,
        `显式 cwd 必须胜出。实际：${task.cwd}`)

      // ② auto 这一轮必须当没设过，不能凭空挑一个工作区当成目标。
      assert.equal(task.workspaceId, undefined,
        '只传 cwd 时，auto 不该挑出目标工作区')
      assert.equal(task.workspaceAuto, undefined, '也不该留下「已经自动挑过」的标记')

      await drain(d)

      // ③ 子会话的放置也不能被【派发】日期兜底挪走。
      assert.equal(task.hostWorkspaceTitle, undefined,
        `不该落到【派发】日期工作区，实际：${task.hostWorkspaceTitle}`)
      assert.equal(task.hostWorkspaceId, undefined, '日期兜底会带一个 workspaceId，这里必须没有')
      assert.equal(task.cwd, explicit, '启动完成后 cwd 仍必须是显式给的那个')

      // ④ 注册表里不能凭空**新增**日期工作区（夹具里本来就有一条 2026-11-07 的旧条目，
      //    那是事故现场遗留的历史数据，不是这次派发造出来的）。
      const before = liveRegistryItems().length
      assert.equal(d.workspaces.list().length, before,
        `这次派发不该往注册表里加任何条目，实际：${d.workspaces.list().map(i => i.title).join(' | ')}`)
    } finally {
      await rm(explicit, { recursive: true, force: true })
    }
  })
})

test('修复2 只传 cwd 且会话有记住的具体目标 → cwd 胜，目标这一轮不生效', async () => {
  await withLaunchDispatch([
    { id: 'w-remembered', path: 'D:\\idea\\remembered-proj', title: '记住的项目' },
  ], async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)
    // 输入框里记住的是一个**具体**工作区（不是 auto）。
    d.targets.set('lead', {
      workspace_id: 'w-remembered', title: '记住的项目', path: 'D:\\idea\\remembered-proj',
    })

    const explicit = await mkdtemp(join(tmpdir(), 'mas-explicit-cwd2-'))
    try {
      const task = await d.launch(lead, { title: 't', brief: 'b', cwd: explicit })

      assert.equal(task.cwd, explicit, '显式 cwd 必须压过记住的目标（显式参数优先级更高）')
      assert.equal(task.workspaceId, undefined, '记住的目标这一轮必须当没设过')
      await drain(d)
      assert.equal(task.hostWorkspaceTitle, undefined, '不能被塞进记住的目标工作区里')
    } finally {
      await rm(explicit, { recursive: true, force: true })
    }
  })
})

test('修复2 workspace 与 cwd 同时给 → workspace 胜，但 cwd 不静默丢弃', async () => {
  await withLaunchDispatch([
    { id: 'w-proj', path: 'D:\\idea\\target-proj', title: '目标项目' },
  ], async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)

    const explicit = await mkdtemp(join(tmpdir(), 'mas-explicit-cwd3-'))
    try {
      const task = await d.launch(lead, { title: 't', brief: 'b', workspace: 'w-proj', cwd: explicit })

      // 已发布语义：workspace 胜（会话住在那个工作区里，侧边栏才有归属）。
      assert.equal(task.workspaceId, 'w-proj', 'workspace 与 cwd 同时给时 workspace 胜')
      // 但 cwd 不能连被读一次的机会都没有：必须留痕，并真的成为干活目录。
      assert.equal(task.cwdExplicit, explicit, 'cwd 必须被记下，不能静默丢弃')
      assert.equal(task.cwd, explicit,
        'cwd 要作为 enterDirectory 的真实工作目录（start() 里据此切换）')
    } finally {
      await rm(explicit, { recursive: true, force: true })
    }
  })
})

test('修复2 只传 cwd 且会话无目标 → 与旧版一致，直接用 cwd', async () => {
  await withLaunchDispatch([], async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)

    const explicit = await mkdtemp(join(tmpdir(), 'mas-explicit-cwd4-'))
    try {
      const task = await d.launch(lead, { title: 't', brief: 'b', cwd: explicit })
      assert.equal(task.cwd, explicit)
      assert.equal(task.workspaceId, undefined)
    } finally {
      await rm(explicit, { recursive: true, force: true })
    }
  })
})

test('修复2 空白 cwd 按「没给」处理，不制造空目录', async () => {
  await withLaunchDispatch(liveRegistryItems(), async ({ d, host }) => {
    const lead = makeAgent('lead')
    host.agents.set('lead', lead)

    const task = await d.launch(lead, { title: 't', brief: 'b', cwd: '   ' })
    assert.equal(task.cwdExplicit, undefined, '空白 cwd 不是「显式给了目录」')
    assert.ok(task.cwd, '仍要有一个可用的工作目录')
    assert.notEqual(String(task.cwd).trim(), '', '不能把空串当工作目录')
  })
})
