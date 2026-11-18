/**
 * 看板路由注册的失败隔离（0.10.1 回归）。
 *
 * 钉的是一个**真实故障形态**：宿主在 HMR 重载时对同一条 prefix 路由重复注册
 * 会抛错（路径已被占用），而 0.10.0 的 `registerBoardRoutes()` 直接
 * `return server.register(...)`，没有 try/catch。于是异常从 `apply()` 里冒出去，
 * **整个插件加载失败** —— 10 个 `dispatch_*` 工具和看板一起消失。
 *
 * 用户的观感是「插件没装」，实际只是面板那一小块没挂上。这两件事的代价差得很远：
 * 看板起不来 = 少一块面板；插件没装 = 派发功能整个没了。所以这里钉住三个结论：
 * 1. 注册抛错时 `apply()` **不抛**，`dispatch_*` 工具仍全部注册成功；
 * 2. 抛错时有 warn（不记日志的话「看板不见了」永远查不到原因）；
 * 3. 正常情况行为不变（成功时仍把 disposer 交给 `ctx.effect`，卸载时会被调用）。
 *
 * 关键验收：这些用例在**去掉 try/catch 的实现上会红**（第一、二条直接抛错到
 * 测试外面）。验证方法记在报告里。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.js'
import { TOOL_NAMES } from '../src/tools.js'

// ---------------------------------------------------------------- 夹具

/**
 * 最小假宿主，够 `apply()` 走完一整轮。
 *
 * 与 `ledger-version.test.js` 的 `makeHost()` 同一套思路：只实现 `apply()` 真正
 * 会碰到的成员。`get(name)` 按服务表返回，`webServer` 由每个用例决定。
 *
 * `registerError` 给定时，`webServer.register()` 抛这个错——用来模拟宿主对
 * 重复路由的拒绝。返回值是「注册成功时的 disposer」本该长什么样。
 */
function makeHost({ registerError, tools } = {}) {
  const warns = []
  const infos = []
  const effects = []
  /** 卸载时要跑的 disposer 集合（`ctx.effect(fn)` 的返回值是 fn 本身）。 */
  const disposers = []
  const registeredRoutes = []
  const registeredTools = []
  /** 路由注销函数（只有注册成功时才有）；用来判断它有没有被交给 ctx.effect。 */
  const routeDisposers = []

  const webServer = {
    register(route) {
      if (registerError) throw registerError
      registeredRoutes.push(route)
      const dispose = () => { registeredRoutes.pop() }
      routeDisposers.push(dispose)
      return dispose
    },
  }

  const ctx = {
    logger: {
      warn: (...args) => warns.push(args.map(String).join(' ')),
      info: (...args) => infos.push(args.map(String).join(' ')),
      error: (...args) => warns.push(args.map(String).join(' ')),
    },
    get: name => (name === 'webServer' ? webServer : undefined),
    on: () => () => {},
    effect: fn => { effects.push(fn); return fn },
    agents: { get: () => undefined, list: () => [] },
    sessionController: {
      async create() {},
      async rename() {},
      async resolveAgent() { return { error: { code: 'not-found' } } },
      async state() { throw Object.assign(new Error('nf'), { code: 'nf' }) },
      async list() { return { items: [] } },
      async prompt() {},
    },
    tools: {
      register(definition) {
        registeredTools.push(definition.name)
        const dispose = () => {}
        disposers.push(dispose)
        return dispose
      },
    },
  }

  return { ctx, warns, infos, effects, disposers, registeredRoutes, registeredTools, routeDisposers, tools }
}

/** 在独立临时目录里跑 `apply()`；`stateDir` 指过去，免得碰真实账本。 */
async function withApply(hostOptions, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mas-board-registration-'))
  try {
    const host = makeHost(hostOptions)
    await apply(host.ctx, {
      stateDir: dir,
      provisionDefaultWorkspace: false,
      archiveSweepMinutes: 0,
      archiveAfterHours: 0,
    })
    return await fn(host)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 核心：失败隔离

test('看板路由注册抛错：apply() 不抛错，10 个工具全部注册成功', async () => withApply(
  { registerError: Object.assign(new Error('route already registered: /dsh-mini-superagent/board'), { code: 'EEXIST' }) },
  async host => {
    // 走到这里就说明 apply() 没有把宿主的注册异常变成插件加载失败。
    assert.equal(host.registeredTools.length, TOOL_NAMES.length,
      '路由注册失败不能让工具少注册一个——看板起不来不等于插件没装')
    assert.deepEqual([...host.registeredTools].sort(), [...TOOL_NAMES].sort(),
      '注册的工具集合必须与 TOOL_NAMES 完全一致')
  },
))

test('看板路由注册抛错：有 warn 日志，且文案说明「看板不可用但工具照常」', async () => withApply(
  { registerError: new Error('route already registered') },
  async host => {
    const hit = host.warns.find(line => line.includes('看板路由注册失败'))
    assert.ok(hit, `注册失败必须留一条可检索的 warn，实际日志：${JSON.stringify(host.warns)}`)
    assert.match(hit, /看板不可用但工具照常/, '文案要说清降级范围，否则用户以为整个插件挂了')
    assert.match(hit, /route already registered/, '要带上原始错误，排障时才知道是哪种注册失败')
  },
))

test('看板路由注册抛错：不登记 disposer（没有东西需要注销）', async () => withApply(
  { registerError: new Error('boom') },
  async host => {
    // 注册失败时 `registerBoardRoutes()` 返回 undefined，`apply()` 的
    // `if (disposeBoard) ctx.effect(...)` 就不该把它包成一个 effect。
    // 判据是「有没有任何一个 effect 的返回值是路由的 disposer」——比数 effect
    // 条数更直接：`ctx.effect(() => dispatch.dispose())` 那条是必须存在的。
    const calledRouteDisposers = host.effects
      .map(fn => { try { return fn() } catch { return undefined } })
      .filter(value => host.routeDisposers.includes(value))
    assert.equal(calledRouteDisposers.length, 0,
      '注册失败时不能凭空交一个 disposer 给 ctx.effect——那会在卸载时调一个不存在的路由注销')
  },
))

test('看板路由注册抛错：宿主没有 webServer 时仍是老行为（跳过、只 info）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-board-registration-'))
  try {
    const host = makeHost({})
    // 把 webServer 服务摘掉，模拟 headless 形态。
    host.ctx.get = () => undefined
    await apply(host.ctx, {
      stateDir: dir,
      provisionDefaultWorkspace: false,
      archiveSweepMinutes: 0,
      archiveAfterHours: 0,
    })
    assert.equal(host.registeredTools.length, TOOL_NAMES.length, 'headless 形态下工具必须照常注册')
    assert.equal(host.warns.length, 0, '没有 webServer 是正常形态，不该 warn')
    assert.ok(host.infos.some(line => line.includes('没有 webServer')), '信息级日志仍要留一条')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 正常路径不变

test('看板路由注册成功：行为不变，路由注册了、disposer 交给了 ctx.effect', async () => withApply(
  {},
  async host => {
    assert.equal(host.registeredRoutes.length, 1, '正常路径必须注册一条 prefix 路由')
    assert.equal(host.registeredRoutes[0].kind, 'prefix')
    assert.equal(host.registeredRoutes[0].path, '/dsh-mini-superagent/board')
    assert.equal(typeof host.registeredRoutes[0].handler, 'function')
    assert.equal(host.warns.length, 0, '正常路径不该产生 warn')
    assert.ok(host.effects.length >= 1, 'disposer 要交给 ctx.effect，卸载时才收得回来')
  },
))
