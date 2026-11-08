/**
 * 工作区模块的纯逻辑与解析顺序测试。
 * `resolve` / `resolveOrCreate` 用假注册表，`ensure` 之外不碰真实磁盘。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkspaceGateway, dayKey, dayTitle, defaultRoot, rootOf, safeDirName } from '../src/workspaces.js'

/** 假注册表：只实现网关用到的那几个方法。 */
function fakeRegistry(items = []) {
  const map = new Map(items.map(item => [item.id, item]))
  let counter = 0
  return {
    list: () => [...map.values()],
    get: id => map.get(id),
    resolveByPath: async path => [...map.values()].find(item => item.path === path),
    create: async (path, title) => {
      counter += 1
      const workspace = { id: `w-${counter}`, path, title, sessionIds: [] }
      map.set(workspace.id, workspace)
      return workspace
    },
    archiveSession: async () => {},
    _map: map,
  }
}

function gatewayWith(registry, config = {}) {
  const ctx = { get: name => (name === 'workspaceRegistry' ? registry : undefined), logger: { warn() {}, info() {} } }
  return new WorkspaceGateway(ctx, { workspaceRoot: '', ...config })
}

test('dayKey 用本地日期并补零', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 13, 0, 0)), '2026-01-05')
  assert.equal(dayKey(new Date(2026, 10, 30, 0, 0, 0)), '2026-11-30')
})

test('dayTitle 带【派发】前缀', () => {
  assert.equal(dayTitle('2026-11-05'), '【派发】2026-11-05')
})

test('safeDirName 去掉路径分隔符与非法字符', () => {
  assert.equal(safeDirName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
  assert.equal(safeDirName('  多  余  空格  '), '多 余 空格')
  assert.equal(safeDirName(''), 'dispatch')
  assert.equal(safeDirName('   '), 'dispatch')
  assert.equal(safeDirName('...hidden'), 'hidden')
})

test('safeDirName 限制长度', () => {
  assert.equal(safeDirName('x'.repeat(200)).length, 60)
})

test('rootOf 优先用配置，否则落到文档目录', () => {
  assert.equal(rootOf({ workspaceRoot: 'D:\\proj' }), 'D:\\proj')
  assert.equal(rootOf({}), defaultRoot())
  assert.ok(defaultRoot().endsWith('mini-superagent'))
})

test('resolve 按 id 命中', async () => {
  const registry = fakeRegistry([{ id: 'w-9', path: 'C:\\a', title: '项目 A' }])
  const workspace = await gatewayWith(registry).resolve('w-9')
  assert.equal(workspace.title, '项目 A')
})

test('resolve 按绝对路径命中', async () => {
  const registry = fakeRegistry([{ id: 'w-1', path: 'C:\\a\\b', title: '项目 B' }])
  const workspace = await gatewayWith(registry).resolve('C:\\a\\b')
  assert.equal(workspace.id, 'w-1')
})

test('resolve 按标题命中，大小写不敏感', async () => {
  const registry = fakeRegistry([{ id: 'w-1', path: 'C:\\a', title: 'Project A' }])
  assert.equal((await gatewayWith(registry).resolve('project a')).id, 'w-1')
})

test('resolve 标题包含匹配兜底', async () => {
  const registry = fakeRegistry([{ id: 'w-1', path: 'C:\\a', title: '【派发】2026-11-05' }])
  assert.equal((await gatewayWith(registry).resolve('派发')).id, 'w-1')
})

test('resolve 找不到时返回 undefined', async () => {
  const registry = fakeRegistry([{ id: 'w-1', path: 'C:\\a', title: '项目 A' }])
  assert.equal(await gatewayWith(registry).resolve('不存在的'), undefined)
  assert.equal(await gatewayWith(registry).resolve('C:\\not\\there'), undefined)
  assert.equal(await gatewayWith(registry).resolve(''), undefined)
})

// ------------------------------------------------- 精确匹配的歧义（0.8.0 的静默取第一个）

/** 造一个会把 warn 记下来的网关。 */
function gatewayRecordingWarns(registry) {
  const warns = []
  const ctx = {
    get: name => (name === 'workspaceRegistry' ? registry : undefined),
    logger: { warn: (...args) => warns.push(args.map(value => String(value)).join(' ')), info() {} },
  }
  // 走 logger 探针：断言必须能证明「没有静默」这件事，所以不能塞一个空 logger。
  return { gateway: new WorkspaceGateway(ctx, { workspaceRoot: '' }), warns }
}

test('resolve 两个同名工作区：返回 undefined 且 warn 出候选（含 path）', async () => {
  // 现场数据（2026-11-08 12:10）：仓库根与包根同名，路径不同。
  const registry = fakeRegistry([
    { id: 'w-repo', path: 'D:\\idea\\dsh-mini-superagent', title: 'dsh-mini-superagent' },
    { id: 'w-pkg', path: 'D:\\idea\\dsh-mini-superagent\\dsh-mini-superagent', title: 'dsh-mini-superagent' },
  ])
  const { gateway, warns } = gatewayRecordingWarns(registry)

  // 关键：0.8.0 这里会返回注册表里的第一个（w-repo），且一条日志都不写。
  assert.equal(await gateway.resolve('dsh-mini-superagent'), undefined,
    '两个同名工作区时必须返回 undefined，不能静默取第一个')

  assert.equal(warns.length, 1, `歧义必须 warn 且只 warn 一次，实际：${warns.join(' | ') || '（无日志）'}`)
  const line = warns[0]
  // 候选必须带 path：同名时 id 对人没有区分度，看不出是包根还是仓库根。
  assert.match(line, /D:\\idea\\dsh-mini-superagent/, 'warn 里必须有仓库根的 path')
  assert.match(line, /D:\\idea\\dsh-mini-superagent\\dsh-mini-superagent/, 'warn 里必须有包根的 path')
  assert.match(line, /精确/, '精确匹配的歧义要说明是精确命中，否则读日志的人以为是模糊匹配撞的')
})

test('resolve 唯一同名时照常解析（别把正常路径改坏）', async () => {
  const registry = fakeRegistry([{ id: 'w-1', path: 'D:\\idea\\proj', title: 'dsh-mini-superagent' }])
  const { gateway, warns } = gatewayRecordingWarns(registry)

  assert.equal((await gateway.resolve('dsh-mini-superagent')).id, 'w-1')
  // 大小写不同也仍然算精确命中。
  assert.equal((await gateway.resolve('DSH-Mini-SuperAgent')).id, 'w-1')
  assert.deepEqual(warns, [], '唯一命中时不该有任何 warn')
})

test('resolve quiet:true 时精确歧义不写日志（内部约定：日志由 resolveOrCreate 统一写）', async () => {
  const registry = fakeRegistry([
    { id: 'w-a', path: 'C:\\a', title: '同名' },
    { id: 'w-b', path: 'C:\\b', title: '同名' },
  ])
  const { gateway, warns } = gatewayRecordingWarns(registry)

  assert.equal(await gateway.resolve('同名', { quiet: true }), undefined)
  assert.deepEqual(warns, [], 'quiet 只压制日志，不改变「歧义返回 undefined」这个结果')
})

test('没有注册表时所有解析都安全返回 undefined', async () => {
  const gateway = new WorkspaceGateway({ get: () => undefined, logger: {} }, {})
  assert.equal(await gateway.resolve('w-1'), undefined)
  assert.deepEqual(gateway.list(), [])
  assert.equal(gateway.root, defaultRoot())
})
