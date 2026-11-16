/**
 * 看板路由注册的失败隔离（plans/14 L3）。
 *
 * 看板是可选投影：`webServer` 可能晚到、可能没有、`register` 也可能因重复路由抛错。
 * 这三种情况都只该让看板消失，绝不能把整个 `apply` 拖垮——否则 10 个工具也一起没了。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerBoardRoutes } from '../src/board.js'
import { BOARD_BASE } from '../src/constants.js'

function makeCtx({ inject, server } = {}) {
  const warns = []
  const ctx = {
    logger: { warn: (...args) => warns.push(args.map(String).join(' ')), info() {}, error() {} },
    get: name => (name === 'webServer' ? server : undefined),
    inject,
  }
  return { ctx, warns }
}

const dispatch = {}

test('webServer 晚到：ctx.inject 回调触发前不注册，触发后注册一次', () => {
  let pending
  const { ctx } = makeCtx({
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['webServer'])
      pending = callback
    },
  })
  const calls = []
  const server = { register: spec => { calls.push(spec); return () => {} } }

  assert.equal(registerBoardRoutes(ctx, dispatch), undefined)
  assert.equal(calls.length, 0, '服务没到之前不该注册')

  pending({ webServer: server })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'prefix')
  assert.equal(calls[0].path, BOARD_BASE)
  assert.equal(typeof calls[0].handler, 'function')
})

test('server.register 抛错时只 warn，不把 apply 拖垮', () => {
  const server = { register: () => { throw new Error('route already registered') } }
  const { ctx, warns } = makeCtx({ server })

  assert.doesNotThrow(() => registerBoardRoutes(ctx, dispatch))
  assert.equal(warns.length, 1)
  assert.match(warns[0], /看板路由注册失败/)
})

test('ctx.inject 自身抛错时只 warn，不把 apply 拖垮', () => {
  const { ctx, warns } = makeCtx({ inject: () => { throw new Error('no such service') } })

  assert.doesNotThrow(() => registerBoardRoutes(ctx, dispatch))
  assert.equal(warns.length, 1)
  assert.match(warns[0], /订阅 webServer 失败/)
})

test('没有 ctx.inject 的旧夹具退回同步读取', () => {
  const calls = []
  const server = { register: spec => { calls.push(spec); return () => {} } }
  const { ctx } = makeCtx({ server })

  const dispose = registerBoardRoutes(ctx, dispatch)
  assert.equal(calls.length, 1)
  assert.equal(typeof dispose, 'function')
})
