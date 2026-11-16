/**
 * 插件入口的生命周期：可选服务晚到、路由注册失败，都不能把 apply 拖垮。
 *
 * 这一层以前没有测试。它恰好是 P0-2/P0-4 的发生地：
 * `webServer` 不在 apply 时同步就绪，`server.register` 也可能抛错；
 * 只要其中一处把 apply 抛出去，10 个工具就会一起消失。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject } from '../src/index.js'
import { BOARD_BASE } from '../src/constants.js'

function makeCtx() {
  const tools = []
  const effects = []
  let webServerCallback
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    get: () => undefined,
    on: () => () => {},
    effect: fn => { const disposer = fn(); effects.push(disposer); return disposer },
    agents: { get: () => undefined, list: () => [] },
    sessionController: {
      async create() {},
      async rename() {},
      async resolveAgent() { return { error: { code: 'not-found' } } },
      async prompt() {},
    },
    tools: {
      register: definition => { tools.push(definition); return () => {} },
    },
    inject: (deps, callback) => {
      if (deps.length === 1 && deps[0] === 'webServer') webServerCallback = callback
      return () => {}
    },
  }
  return { ctx, tools, effects, webServer: () => webServerCallback }
}

test('inject 声明里包含 workspaceRegistry（provision 的硬依赖）', () => {
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('agents'))
  assert.ok(inject.includes('sessionController'))
  assert.ok(inject.includes('workspaceRegistry'))
})

test('apply 注册 10 个工具；webServer 晚到不影响工具', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-apply-'))
  const { ctx, tools, effects, webServer } = makeCtx()
  try {
    await apply(ctx, {
      stateDir: dir,
      provisionDefaultWorkspace: false,
      archiveSweepMinutes: 0,
      archiveAfterHours: 0,
    })
    assert.equal(tools.length, 10)
    assert.equal(typeof webServer(), 'function', 'webServer 应该走 ctx.inject 等待，而不是 apply 时读一次')
  } finally {
    for (const disposer of effects) if (typeof disposer === 'function') await disposer()
    await rm(dir, { recursive: true, force: true })
  }
})

test('webServer 到达后注册路由；register 抛错也只影响看板', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-apply-route-'))
  const { ctx, tools, effects, webServer } = makeCtx()
  try {
    await apply(ctx, {
      stateDir: dir,
      provisionDefaultWorkspace: false,
      archiveSweepMinutes: 0,
      archiveAfterHours: 0,
    })
    const register = webServer()
    assert.equal(typeof register, 'function')

    assert.doesNotThrow(() => register({
      webServer: { register: () => { throw new Error('duplicate route') } },
    }))
    assert.equal(tools.length, 10, '看板路由失败后工具仍然要注册')

    const calls = []
    register({
      webServer: {
        register: spec => { calls.push(spec); return () => {} },
      },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, BOARD_BASE)
  } finally {
    for (const disposer of effects) if (typeof disposer === 'function') await disposer()
    await rm(dir, { recursive: true, force: true })
  }
})
