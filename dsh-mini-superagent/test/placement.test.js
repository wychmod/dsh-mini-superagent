/**
 * 工作区放置逻辑（`Dispatch.placementFor`）的回归测试。
 *
 * 钉住 0.8.1 重写后的语义：**有目标用目标，没有/找不到目标才退回日期工作区**。
 *
 * 0.8.0 及更早的实现是 `workerWorkspace === 'target' && target`，而该配置默认
 * `day`，于是用户明确指定了工作区也会被塞进【派发】——表现为「每次启动都凭空
 * 多出一个【派发】YYYY-MM-DD 工作区」。这几条用例正是从那个真实缺陷反推出来的。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULTS, WORKER_WORKSPACE_CWD, WORKER_WORKSPACE_DAY, normalizeWorkerWorkspace,
} from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'

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
