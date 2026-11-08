/**
 * 工作区解析链路的回归测试（`resolveOrCreate` 的归因 + `SessionGateway.workspaceFor` 的标题去重）。
 *
 * 这批用例钉的是 2026-11-08 12:10 实测到的两条缺陷：
 * 1. `dispatch_launch` 没传 `workspace` 时，用户显式给的 cwd 被丢，子会话落到别的工作区；
 *    而后续想用同名标题重派时，`resolveOrCreate` 只回 `{workspace: undefined, created: false}`，
 *    `dispatch.js` 于是把所有失败都写成「且允许新建被关闭」——实际上没人关闭新建。
 * 2. `sessions.workspaceFor(cwd)` 调 `registry.create(cwd)` 不传标题，宿主拿目录 basename 当标题，
 *    于是「仓库根」与「包根」造出两个同名工作区（注册表里真实存在，见下）。
 *
 * 全部离线：假注册表 + 假宿主，不碰磁盘、不联网。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionGateway } from '../src/sessions.js'
import { WorkspaceGateway } from '../src/workspaces.js'

// ------------------------------------------------------------------ 桩

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
 * 假注册表：实现网关与 SessionGateway 用到的那几个方法。
 * `createLog` 记下每次 create 的入参 —— 「歧义时不许新建」这条断言全靠它。
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
      // 真实宿主按路径幂等：同路径重复 create 返回同一个实体，不会新增条目。
      const found = [...map.values()].find(item => item.path === path)
      if (found) return found
      counter += 1
      // 不给标题时按目录 basename 起名 —— 这正是缺陷 A3 的来源，桩必须照样复现。
      const derived = title ?? String(path).split(/[\\/]/).filter(Boolean).at(-1) ?? 'workspace'
      const workspace = { id: `w-new-${counter}`, path, title: derived, sessionIds: [] }
      map.set(workspace.id, workspace)
      return workspace
    },
    archiveSession: async () => {},
    createLog,
    _map: map,
  }
}

function workspaceGateway(registry) {
  const warns = []
  const ctx = {
    get: name => (name === 'workspaceRegistry' ? registry : undefined),
    logger: { warn: (...args) => warns.push(args.map(value => String(value)).join(' ')), info() {} },
  }
  return { gateway: new WorkspaceGateway(ctx, { workspaceRoot: '', maxTasksPerSession: 64 }), warns }
}

function sessionGateway(registry) {
  const warns = []
  const ctx = { get: name => (name === 'workspaceRegistry' ? registry : undefined), logger: { warn: (...a) => warns.push(a.join(' ')), info() {} } }
  return { gateway: new SessionGateway(ctx, {}), warns }
}

// -------------------------------------------------- A2：resolveOrCreate 的 reason

test('resolveOrCreate 歧义时返回 reason:"ambiguous" 且不新建目录', async () => {
  const registry = fakeRegistry(liveRegistryItems())
  const { gateway, warns } = workspaceGateway(registry)

  // 用户想重派的目标：标题「dsh-mini-superagent」——注册表里有两个同名的（仓库根 + 包根）。
  const result = await gateway.resolveOrCreate('dsh-mini-superagent')

  assert.equal(result.workspace, undefined, '歧义不能猜一个返回')
  assert.equal(result.created, false)
  assert.equal(result.reason, 'ambiguous',
    '必须是 ambiguous：dispatch.js 靠它说明真相，而不是套「允许新建被关闭」那句文案')

  assert.deepEqual(registry.createLog, [], '歧义时绝对不能新建目录（那会造出第三个同名工作区）')
  assert.equal(warns.length, 1, `歧义只该 warn 一次，实际：${warns.join(' | ') || '（无日志）'}`)
  // 候选必须带 path：两个 dsh-mini-superagent 光看标题/id 分不出包根还是仓库根。
  assert.match(warns[0], /D:\\idea\\dsh-mini-superagent/, 'warn 里要有仓库根的 path')
  assert.match(warns[0], /dsh-mini-superagent\\dsh-mini-superagent/, 'warn 里要有包根的 path')
})

test('resolveOrCreate 精确同名歧义也会归因为 ambiguous（不是只判包含匹配）', async () => {
  // 0.8.0 的漏洞：resolve 因精确歧义返回 undefined，而 resolveOrCreate 只重判包含匹配，
  // 于是把精确歧义当成「不存在」→ 直接新建。这条用例专门钉住那个缺口。
  const registry = fakeRegistry([
    { id: 'w-a', path: 'C:\\work\\x', title: 'proj' },
    { id: 'w-b', path: 'D:\\other\\x', title: 'proj' },
  ])
  const { gateway } = workspaceGateway(registry)

  const result = await gateway.resolveOrCreate('proj')

  assert.equal(result.reason, 'ambiguous')
  assert.equal(result.workspace, undefined)
  assert.deepEqual(registry.createLog, [], '精确歧义同样不许新建')
})

test('resolveOrCreate 不存在且 create:false 时返回 reason:"not-found"', async () => {
  const registry = fakeRegistry(liveRegistryItems())
  const { gateway } = workspaceGateway(registry)

  const result = await gateway.resolveOrCreate('根本没这个名字', { create: false })

  assert.equal(result.workspace, undefined)
  assert.equal(result.created, false)
  assert.equal(result.reason, 'not-found', '不存在 ≠ 歧义：两者的错误文案必须能分开')
  assert.deepEqual(registry.createLog, [])
})

test('resolveOrCreate 不存在但允许新建时照旧新建（不把正常路径改坏）', async () => {
  const registry = fakeRegistry(liveRegistryItems())
  const { gateway } = workspaceGateway(registry)

  const result = await gateway.resolveOrCreate('新项目')

  assert.equal(result.created, true)
  assert.equal(result.workspace?.title, '新项目')
  // 成功时没有 reason 字段：调用方按 `reason === undefined` 判断「拿到了」。
  assert.equal('reason' in result, false, '解析/新建成功时不该有 reason 字段')
  assert.equal(registry.createLog.length, 1)
})

test('resolveOrCreate 解析成功时 reason 缺席（向后兼容 {workspace, created}）', async () => {
  const registry = fakeRegistry([{ id: 'w-1', path: 'C:\\a', title: '唯一' }])
  const { gateway } = workspaceGateway(registry)

  const result = await gateway.resolveOrCreate('唯一')
  assert.equal(result.workspace?.id, 'w-1')
  assert.equal(result.created, false)
  // dispatch.js 现在按 { workspace, created } 解构，加字段必须是对它无感的。
  assert.deepEqual(Object.keys(result).sort(), ['created', 'workspace'])
})

test('resolveOrCreate 未注册的绝对路径 + create:false 归因为 not-found', async () => {
  // 绝对路径走的是另一条分支（不查标题），归因也必须是 not-found。
  const registry = fakeRegistry([])
  const { gateway } = workspaceGateway(registry)

  const result = await gateway.resolveOrCreate('D:\\nowhere\\at\\all', { create: false })
  assert.equal(result.workspace, undefined)
  assert.equal(result.reason, 'not-found')
  assert.deepEqual(registry.createLog, [])
})

test('resolveOrCreate 空引用不给 reason（「没给目标」不等于「找不到」）', async () => {
  const registry = fakeRegistry(liveRegistryItems())
  const { gateway } = workspaceGateway(registry)

  // 空引用时 dispatch.js 不该为它编一段错误文案，所以这里必须没有 reason 字段。
  assert.deepEqual(await gateway.resolveOrCreate(''), { workspace: undefined, created: false })
  assert.deepEqual(registry.createLog, [])
})

// -------------------------------------- A3：workspaceFor 不再造同名工作区

test('workspaceFor 在「仓库根 + 包根」场景下产出两个标题不同的工作区', async () => {
  // 现场：先登记了仓库根（标题 dsh-mini-superagent），随后包根按目录反查登记。
  const registry = fakeRegistry([
    { id: 'cb8aac4b', path: 'D:\\idea\\dsh-mini-superagent', title: 'dsh-mini-superagent' },
  ])
  const { gateway } = sessionGateway(registry)

  const repo = await gateway.workspaceFor('D:\\idea\\dsh-mini-superagent')
  const pkg = await gateway.workspaceFor('D:\\idea\\dsh-mini-superagent\\dsh-mini-superagent')

  assert.equal(repo.title, 'dsh-mini-superagent', '已存在的工作区原样返回，标题一个字都不改')
  assert.notEqual(pkg.title, repo.title, '同名目录不能再造出同名工作区')
  assert.equal(pkg.id, 'w-new-1')

  // ① 人能从标题看出是哪个目录：包根的标题里要带上级目录名，读起来像路径。
  assert.match(pkg.title, /dsh-mini-superagent[\\/]dsh-mini-superagent/,
    `标题要能区分出包根，实际：${pkg.title}`)
  assert.ok(!pkg.title.includes('\uFF08dsh-mini-superagent\uFF09'), '不要用「dsh-mini-superagent（dsh-mini-superagent）」这种没信息量的形式')

  // ② 不与已有标题重复（大小写不敏感，宿主可能按 basename 归一）。
  const titles = registry.list().map(item => item.title.toLowerCase())
  assert.equal(new Set(titles).size, titles.length, `注册表里不该有重复标题：${titles.join(' | ')}`)

  // ③ 不改已有工作区的标题。
  assert.equal(registry.get('cb8aac4b').title, 'dsh-mini-superagent')
})

test('workspaceFor 给已登记的目录原样返回（重复调用不新增条目、不换标题）', async () => {
  const registry = fakeRegistry([])
  const { gateway } = sessionGateway(registry)
  const dir = 'D:\\idea\\solo'

  const first = await gateway.workspaceFor(dir)
  const second = await gateway.workspaceFor(dir)

  assert.equal(second.id, first.id)
  assert.equal(registry.list().length, 1, '同一目录第二次调用必须复用，不能再登记一条')
  assert.equal(registry.createLog.length, 1, '第二次不该再调 create')
})

test('workspaceFor 首次登记就用目录名当标题（能读，不加多余前缀）', async () => {
  const registry = fakeRegistry([])
  const { gateway } = sessionGateway(registry)

  const workspace = await gateway.workspaceFor('D:\\idea\\solo')
  assert.equal(workspace.title, 'solo', `首次登记应当直接用目录名，实际：${workspace.title}`)
})

test('workspaceFor 三个同末段目录时逐个加长到可区分', async () => {
  const registry = fakeRegistry([])
  const { gateway } = sessionGateway(registry)

  const a = await gateway.workspaceFor('D:\\idea\\a\\proj')
  const b = await gateway.workspaceFor('D:\\idea\\b\\proj')
  const c = await gateway.workspaceFor('D:\\idea\\c\\proj')

  const titles = [a, b, c].map(item => item.title)
  assert.equal(new Set(titles.map(t => t.toLowerCase())).size, 3, `三个工作区标题必须互不相同：${titles.join(' | ')}`)
  // 可读性：每个标题都要仍以目录名结尾，人能认出是哪个 proj。
  for (const title of titles) assert.match(title, /proj$/, `标题要以目录名结尾：${title}`)
})

test('workspaceFor 无注册表时安全返回 undefined', async () => {
  const gateway = new SessionGateway({ get: () => undefined, logger: {} }, {})
  assert.equal(await gateway.workspaceFor('D:\\idea\\x'), undefined)
})
