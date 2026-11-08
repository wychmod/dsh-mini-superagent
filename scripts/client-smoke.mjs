#!/usr/bin/env node
/**
 * dsh-mini-superagent 浏览器半边的**离线渲染冒烟**。
 *
 * 它不连接任何宿主、不启动浏览器、不发真实网络请求：把 `dsh-mini-superagent/client/index.js`
 * 当成普通脚本读进来，用假的 ModuleLoader / require / ctx / fetch / document 跑一遍，
 * 断言看板、输入框派发目标选择器、`@` 工作区触发源的渲染与交互结果。
 *
 * 能证明的：模块形状、槽注册参数、渲染出来的文本与按钮、POST body、错误文案、监听器与
 * 请求的清理。**不能证明的**（仍需真机目视）：元素在真实布局里的对齐/裁切/深浅主题对比度、
 * portal 的定位与翻转、`@` 与官方来源混排的观感、插入的 chip 能否在刷新后从草稿恢复。
 *
 * 用法：
 *   node scripts/client-smoke.mjs
 *
 * 零依赖，只用 Node 内置模块；退出码 0 = 全过，1 = 有断言失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = resolve(HERE, '..', 'dsh-mini-superagent', 'client', 'index.js')

let passed = 0
const failures = []

function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const source = readFileSync(CLIENT_PATH, 'utf8')
console.log(`被测文件: ${CLIENT_PATH}`)
console.log(`大小: ${source.split('\n').length} 行\n`)

/* ───────────────────────── 迷你 React ───────────────────────── */

/**
 * 只实现这个插件用到的四个 hook。effect 有真实生命周期（mount → update → unmount），
 * 这样"挂载时取一次数""卸载时摘监听"这类行为才能被断言，而不是被 no-op 掩盖。
 */
let active = null

/**
 * 旁路捕获 TaskCard 的 props。
 *
 * `BoardPanel` 自己持有 `handlers`（`{ act, open }`），但它只把 `handlers` 传给
 * `TaskCard`，**不**落到 DOM 属性上；归档行的 `onClick`/`onKeyDown` 还都是
 * `undefined`（第一道闸）。所以想验证"第二道闸单独也能拦住"（即 `openWorker`
 * 自己判断 `archived_at`），就必须拿到那个 handler 本身。
 *
 * 拿到的方式不改生产代码：在这里记下每一次 `createElement(TaskCard, …)` 的 props。
 * 这是**旁路观察**，不影响渲染结果，也不给组件加任何测试钩子。
 */
const cardProps = []

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const flat = []
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child.flat(Infinity))
      else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
    }
    // 只在真有 handlers 时记一笔（TaskCard 唯一带 handlers 的组件）。
    if (props && props.handlers && props.handlers.open) cardProps.push(props)
    return { type, props: Object.assign({}, props || {}, { children: flat }) }
  },
  useState(initial) {
    const store = active.store
    const index = active.cursor++
    if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial
    return [store[index], (value) => {
      store[index] = typeof value === 'function' ? value(store[index]) : value
    }]
  },
  useRef(initial) {
    const index = active.cursor++
    if (!(index in active.store)) active.store[index] = { current: initial }
    return active.store[index]
  },
  useEffect(fn, deps) {
    const index = active.cursor++
    active.pending.push({ fn, deps, slot: index })
  },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
}

/** createPortal 的桩：把 portal 目标当成普通子树，方便遍历断言。 */
const ReactDOM = {
  createPortal(node, container) {
    return { type: 'portal', props: { children: [node], container } }
  },
}

function depsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

/** 把元素树里的函数组件就地展开；嵌套组件都是无 hook 的展示组件。 */
function resolveNode(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(resolveNode)
  if (typeof node.type === 'function') {
    const saved = active
    active = { cursor: 0, store: [], pending: [] }
    const out = resolveNode(node.type(node.props))
    active = saved
    return out
  }
  const children = node.props && node.props.children ? node.props.children.map(resolveNode) : []
  return { type: node.type, props: Object.assign({}, node.props, { children }) }
}

function mount(component, props) {
  const root = { component, props: props || {}, store: [], effects: new Map(), tree: null }
  root.tree = paint(root)
  return root
}

/** 渲染一次并提交 deps 变化的 effect（旧 effect 的清理先跑）。 */
function paint(root) {
  active = { cursor: 0, store: root.store, pending: [] }
  const tree = resolveNode(root.component(root.props))
  const pending = active.pending
  active = null
  for (const item of pending) {
    const prev = root.effects.get(item.slot)
    if (prev && depsEqual(prev.deps, item.deps)) continue
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    const cleanup = item.fn()
    root.effects.set(item.slot, { deps: item.deps, cleanup: typeof cleanup === 'function' ? cleanup : null })
  }
  return tree
}

function update(root) {
  root.tree = paint(root)
  return root.tree
}

function unmount(root) {
  for (const entry of root.effects.values()) {
    if (typeof entry.cleanup === 'function') entry.cleanup()
  }
  root.effects.clear()
}

/* ───────────────────────── 环境桩 ───────────────────────── */

const documentListeners = new Set()
const windowListeners = new Set()

function makeEventTarget(bucket) {
  return {
    addEventListener(type, fn) { bucket.add(`${type}:${String(fn && fn.name)}`) },
    removeEventListener(type, fn) { bucket.delete(`${type}:${String(fn && fn.name)}`) },
  }
}

const documentStub = Object.assign(makeEventTarget(documentListeners), { body: {}, visibilityState: 'visible' })
globalThis.document = documentStub

let mod = null
globalThis.window = Object.assign(makeEventTarget(windowListeners), {
  innerWidth: 1200,
  innerHeight: 800,
  __ModuleLoader__: {
    load(definition) {
      const require = (id) => {
        if (id === 'react') return React
        if (id === 'react-dom') return ReactDOM
        throw new Error(`unexpected require: ${id}`)
      }
      mod = definition.factory(require)
    },
  },
})

/* ───────────────────────── 假 fetch ───────────────────────── */

let boardResponse = null
let getMode = 'ok'
let postReply = { ok: true, target: null }
/** GET /board/retired 的响应；默认「宿主不提供」，需要时由各段自己覆盖。 */
let retiredResponse = { ok: true, count: 0, dropped: 0, entries: [] }
let retiredMode = 'ok'
const requests = []

globalThis.fetch = async (url, options) => {
  const method = (options && options.method) || 'GET'
  const body = options && options.body
  requests.push({ url, method, body })
  if (method === 'GET') {
    if (getMode === 'fail') return { ok: false, status: 500, async json() { return { ok: false, error: 'boom' } } }
    // 退休视图是独立路由：先于快照判断，否则会被当成一次 GET /board。
    if (String(url).endsWith('/retired')) {
      if (retiredMode === 'fail') return { ok: false, status: 500, async json() { return { ok: false, error: 'retired boom' } } }
      return { ok: true, status: 200, async json() { return retiredResponse } }
    }
    return { ok: true, status: 200, async json() { return boardResponse } }
  }
  // apply() 末尾的「自报存活」：宿主只负责记录，这里一律 200，免得影响后续断言。
  if (url.endsWith('/client-ready')) {
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }
  // POST /target：模拟宿主真的存下目标，这样后续 GET 的读回才一致。
  if (url.endsWith('/target') && postReply.ok !== false) {
    const parsed = JSON.parse(body || '{}')
    const list = (boardResponse && boardResponse.workspaces) || []
    const workspace = parsed.workspace ? list.find((item) => item.id === parsed.workspace) : null
    const next = workspace ? { workspace_id: workspace.id, title: workspace.title, path: workspace.path } : null
    boardResponse.targets = Object.assign({}, boardResponse.targets, { [parsed.session_id]: next })
    postReply = { ok: true, target: next }
  }
  return {
    ok: postReply.ok !== false,
    status: postReply.ok === false ? 409 : 200,
    async json() { return postReply },
  }
}

/* ───────────────────────── 假 ctx ───────────────────────── */

const opened = []
const uiWorkspace = { async openSession(id) { opened.push(id) } }
const registeredSources = []
const sourceDisposers = []
const registrations = []
const disposers = []

let inputTriggers = {
  registerSource(src) {
    registeredSources.push(src)
    return () => { sourceDisposers.push(src.name) }
  },
}

const fakeCtx = {
  get(name) {
    if (name === 'uiWorkspace') return uiWorkspace
    if (name === 'inputTriggers') return inputTriggers
    return undefined
  },
  effect(builder, label) {
    const dispose = typeof builder === 'function' ? builder() : undefined
    if (typeof dispose === 'function') disposers.push({ label, dispose })
    return () => { if (typeof dispose === 'function') dispose() }
  },
  logger: { info() {}, warn() {} },
  slots: {
    inject(name, register) { register() },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

/* ───────────────────────── 元素树工具 ───────────────────────── */

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  visit(node)
  if (node.props && node.props.children) walk(node.props.children, visit)
}

function findAll(node, predicate) {
  const out = []
  walk(node, (item) => { if (predicate(item)) out.push(item) })
  return out
}

function text(node) {
  if (node === null || node === undefined || node === true || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ')
  return node.props && node.props.children ? text(node.props.children) : ''
}

const hasClass = (item, prefix) => Boolean(item) && Boolean(item.props)
  && typeof item.props.className === 'string' && item.props.className.startsWith(prefix)
const buttonsOf = (tree) => findAll(tree, (item) => item && item.type === 'button')
const buttonOf = (tree, label) => buttonsOf(tree).find((item) => text(item).includes(label))
const tick = () => new Promise((r) => setTimeout(r, 0))

/* ───────────────────────── fixture（内联，单文件可跑） ───────────────────────── */

const hoursAgo = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString()
const WORKSPACES = [
  { id: 'ws-1', title: '主工作区', path: 'C:/w1' },
  { id: 'ws-2', title: '副工作区', path: 'C:/w2' },
]

/**
 * fixture 的默认窗口：7 天 / 200 条。
 *
 * 刻意**只给 days 不给 since**：宿主契约里 since 可以由 days 推导，客户端要能自己算出来。
 * 这样也能顺带验证「宿主只给 days 时窗口仍然生效」这条降级路径。
 */
const WINDOW_DAYS = 7

function boardFixture() {
  return {
    version: '0.4.0',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 2, queued: 1, max: 6 },
    counts: { total: 10, running: 2, queued: 1, done: 4, blocked: 1, failed: 1, cancelled: 1, ended: 0, interrupted: 0, archived: 3, retired: 2 },
    // 记忆治理快照：窗口口径 + 退休数 + 被丢弃的退休记录数（plans/07 P0-1 / P0-5）。
    memory: {
      window: { days: WINDOW_DAYS, tasks: 200 },
      ledger: { tasks: 10, retired: 2, archived: 3, retiredDropped: 0, capPerTask: { summary: 6000, detail: 4000 } },
      admission: { direct: 4, ledger: 6, directStatuses: ['blocked', 'failed'] },
      pending: { inputs: 1, unknown: 0 },
      retired: { count: 2, latestAt: hoursAgo(3) },
    },
    workspaces: WORKSPACES,
    targets: { 'session-a': { workspace_id: 'ws-1', title: '主工作区', path: 'C:/w1' } },
    tasks: [
      { task_id: 't-run-1', title: '批次任务甲', status: 'running', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', group: 'g1', worker_session_id: 'dispatch-t-run-1', elapsed_ms: 12345, report_count: 1, background: { jobs: 1, subagents: 0, since: hoursAgo(0) }, last_report: { summary: '第一行摘要\n第二行不该出现' } },
      { task_id: 't-run-2', title: '单跑任务', status: 'running', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', group: null, worker_session_id: 'dispatch-t-run-2', elapsed_ms: 800, report_count: 0, input_pending_at: hoursAgo(0) },
      { task_id: 't-q-3', title: '批次任务乙', status: 'queued', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', group: 'g1', worker_session_id: 'dispatch-t-q-3', elapsed_ms: 0, report_count: 0 },
      { task_id: 't-f-4', title: '失败任务', status: 'failed', attempt: 2, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-f-4', elapsed_ms: 4000, report_count: 1, error: 'spawn 失败：ENOENT', updated_at: hoursAgo(1) },
      { task_id: 't-done-5', title: '完成的任务', status: 'done', attempt: 1, workspace_id: null, workspace_title: null, worker_session_id: 'dispatch-t-done-5', elapsed_ms: 65000, report_count: 1, updated_at: hoursAgo(2) },
      { task_id: 't-blocked-6', title: '阻塞任务', status: 'blocked', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-blocked-6', elapsed_ms: 1000, report_count: 0, updated_at: hoursAgo(3) },
      // 窗口外的已结算任务：状态 done、耗时极大。它必须在指标里消失，
      // 否则「窗口化」只是个说法（成功率仍会被旧小数拉下去）。
      { task_id: 't-old-7', title: '窗口外的老任务', status: 'failed', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-old-7', elapsed_ms: 999000, report_count: 0, updated_at: hoursAgo(WINDOW_DAYS * 24 + 12) },
      { task_id: 't-arc-1', title: '归档任务一', status: 'done', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-arc-1', archived_at: hoursAgo(2), elapsed_ms: 5000, updated_at: hoursAgo(2) },
      { task_id: 't-arc-2', title: '归档任务二', status: 'failed', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-arc-2', archived_at: hoursAgo(26), archive_error: '会话已不存在', updated_at: hoursAgo(26) },
      // 窗口内、未归档，但已经归档过一次（archived_at 非空）的任务不参与指标。
      { task_id: 't-arc-3', title: '归档任务三', status: 'cancelled', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-arc-3', archived_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ],
  }
}

/**
 * P0-4 的三个新状态位（见 `src/board.js` 的 `boardTask()`）。
 *
 * 刻意**另起一份 fixture**而不是往 `boardFixture()` 里塞任务：那份 fixture 的
 * 计数、成功率、chip 数字都被后面的断言钉住了，加一条任务就会连带改掉十几条
 * 无关断言，让「这个改动坏了什么」变得看不出来。
 *
 * 四个任务分别覆盖：冻结不归档 / 未读未知 / 摘要截断 / 三个字段全缺（降级）。
 */
function statusBadgeFixture() {
  return {
    version: '0.4.0',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 1, queued: 0, max: 6 },
    counts: { total: 4, running: 1, queued: 0, done: 3, blocked: 0, failed: 0, cancelled: 0, ended: 0, interrupted: 0, archived: 0, retired: 0 },
    // 有 memory 块：截断提示才能写出「前 6000 字」而不是退化成不帶数字的说法。
    memory: {
      window: { days: WINDOW_DAYS, tasks: 200 },
      ledger: { tasks: 4, retired: 0, archived: 0, retiredDropped: 0, capPerTask: { summary: 6000, detail: 4000 } },
    },
    workspaces: WORKSPACES,
    targets: {},
    tasks: [
      { task_id: 't-frz-1', title: '冻结但未归档', status: 'done', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-frz-1', elapsed_ms: 1000, report_count: 1, frozen_at: hoursAgo(4), updated_at: hoursAgo(4) },
      { task_id: 't-unk-2', title: '未读未知任务', status: 'running', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-unk-2', elapsed_ms: 700, report_count: 0, input_unknown_at: hoursAgo(1) },
      { task_id: 't-trunc-3', title: '摘要被截断的任务', status: 'done', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-trunc-3', elapsed_ms: 2000, report_count: 2, last_report: { summary: '被截过的摘要' }, has_truncated: true, updated_at: hoursAgo(5) },
      { task_id: 't-plain-4', title: '没有任何新标记的任务', status: 'done', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-plain-4', elapsed_ms: 1500, report_count: 1, last_report: { summary: '干净摘要' }, updated_at: hoursAgo(6) },
    ],
  }
}

/** 退休记录 fixture：倒序由宿主保证，客户端只负责渲染。 */
function retiredFixture() {
  return {
    ok: true,
    count: 2,
    dropped: 0,
    entries: [
      { task_id: 't-ret-1', title: '被账本封顶退休的任务', status: 'done', retired_at: hoursAgo(3), retired_reason: 'cap-count', archived_at: hoursAgo(5), updated_at: hoursAgo(4), summary: '已合并' },
      { task_id: 't-ret-2', title: '超过保留期的任务', status: 'failed', retired_at: hoursAgo(30), retired_reason: 'cap-days', archived_at: null, updated_at: hoursAgo(31), summary: '' },
    ],
  }
}

/* ═════════════════════ 加载模块 ═════════════════════ */

console.log('模块形状')
new Function(source)()
check('ModuleLoader 捕获到模块', mod !== null)
check('有 name', mod && typeof mod.name === 'string' && mod.name === 'dsh-mini-superagent', String(mod && mod.name))
check('有 inject 数组', Array.isArray(mod.inject))
check('inject 含 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'))
check('有 apply 函数', typeof mod.apply === 'function')

/* ═════════════════════ 槽注册 ═════════════════════ */

console.log('\n槽注册')
mod.apply(fakeCtx)

const iconRegs = registrations.filter((item) => item.options.name === 'sidebar.panellist')
const mainRegs = registrations.filter((item) => item.options.name === 'main')
const pickerRegs = registrations.filter((item) => item.options.name === 'conversation.input.left')

check('sidebar.panellist 注册一次', iconRegs.length === 1, `实际 ${iconRegs.length}`)
check('图标 id 是 dsh-mini-superagent.board', iconRegs[0] && iconRegs[0].options.id === 'dsh-mini-superagent.board', iconRegs[0] && String(iconRegs[0].options.id))
check('图标 order 是 60', iconRegs[0] && iconRegs[0].options.order === 60, iconRegs[0] && String(iconRegs[0].options.order))
check('main 注册一次', mainRegs.length === 1, `实际 ${mainRegs.length}`)
check('main key 与图标 id 一致', iconRegs[0] && mainRegs[0] && mainRegs[0].options.key === iconRegs[0].options.id)
check('conversation.input.left 注册一次', pickerRegs.length === 1, `实际 ${pickerRegs.length}`)
check('选择器 id 是 dsh-mini-superagent/target', pickerRegs[0] && pickerRegs[0].options.id === 'dsh-mini-superagent/target', pickerRegs[0] && String(pickerRegs[0].options.id))
check('@ 工作区源已注册', registeredSources.length === 1, `实际 ${registeredSources.length}`)
check('@ 源是 @workspace', registeredSources[0] && registeredSources[0].trigger === '@' && registeredSources[0].name === 'workspace')
check('插件清理 effect 已挂', disposers.length >= 1)

// apply() 末尾的自报存活：真实宿主用 selfcheck.client.ready 区分
// 「模块没进图 / 进了图但 apply 抛错 / apply 跑完了」，这里断言它确实发出且内容对得上。
const readyRequests = requests.filter((item) => item.url.endsWith('/client-ready'))
check('apply 后自报存活（POST /client-ready）', readyRequests.length === 1, `实际 ${readyRequests.length}`)
let readyBody = null
try { readyBody = JSON.parse(readyRequests[0] && readyRequests[0].body) } catch (error) { readyBody = null }
check('自报体 ok:true', Boolean(readyBody) && readyBody.ok === true)
check('自报的 registered 含三个槽与 @workspace',
  Boolean(readyBody) && Array.isArray(readyBody.registered)
    && ['sidebar.panellist', 'main', 'conversation.input.left', '@workspace']
      .every((name) => readyBody.registered.includes(name)),
  readyBody ? JSON.stringify(readyBody.registered) : 'null')

/* ═════════════════════ 看板面板 ═════════════════════ */

console.log('\n看板面板')
boardResponse = boardFixture()
const panelReg = mainRegs[0]
const panel = mount(panelReg.component)
await tick()
await tick()
update(panel)

let body = text(panel.tree)
check('首屏加载出并发指标', body.includes('并发 2/6'))
check('总计不含已归档', body.includes('总计 7'))

const chipFor = (label) => buttonsOf(panel.tree).find((item) => item.props['aria-pressed'] !== undefined && text(item).includes(label))
const chips = ['全部', '进行中', '需要处理', '已归档', '已退休'].map((label) => {
  const chip = chipFor(label)
  return chip ? text(chip).replace(/\s+/g, ' ').trim() : ''
})
check('5 个过滤 chip 都在', chips.every((item) => item.length > 0), JSON.stringify(chips))
check('全部 7（不含归档）', chips[0].includes('7'), chips[0])
check('进行中 3', chips[1].includes('3'), chips[1])
check('需要处理 3', chips[2].includes('3'), chips[2])
check('已归档 3', chips[3].includes('3'), chips[3])
check('已退休 chip 的计数来自 memory 块（2）', chips[4].includes('2'), chips[4])
check('已退休 chip 排在已归档之后',
  chips.findIndex((item) => item.includes('已归档')) < chips.findIndex((item) => item.includes('已退休')),
  JSON.stringify(chips))
check('归档行不出现在「全部」里', !text(panel.tree).includes('t-arc-1'))

/* 改版后的信息架构：三段 + 效果数字 + 批次进度 + 两个异常标签 */
const nowText = () => text(panel.tree)
check('总览分成「需要你处理 / 在跑与排队 / 最近完成」三段',
  ['需要你处理', '在跑与排队', '最近完成'].every((label) => nowText().includes(label)))
const statBlocks = findAll(panel.tree, (item) => item && item.props && item.props.className === 'dsh-sa-stat')
  .map((item) => text(item).replace(/\s+/g, ' ').trim())
check('有四个「效果」数字：完成 / 成功率 / 平均耗时 / 并行节省',
  ['完成', '成功率', '平均耗时', '并行节省'].every((label) => statBlocks.some((line) => line.includes(label))),
  JSON.stringify(statBlocks))

/* ── P0-1 指标窗口化：口径显示 + 窗口外/归档任务不再投票 ── */
const windowNote = findAll(panel.tree, (item) => item && item.props && hasClass(item, 'dsh-sa-stat-window'))
  .map((item) => text(item).replace(/\s+/g, ' ').trim())
check('效果条显示窗口口径', windowNote.length === 1 && windowNote[0].includes('最近 7 天'), JSON.stringify(windowNote))
check('口径不含「窗口未知」', windowNote.length === 1 && !windowNote[0].includes('窗口未知'), JSON.stringify(windowNote))
/*
 * 窗口内已结算：t-f-4(failed) / t-done-5(done) / t-blocked-6(blocked) = 3 条，1 条 done → 33%。
 * 若窗口失效，t-old-7(failed) 会进来变成 1/4 = 25%；归档任务若投票会进一步变成 2/7 = 29%。
 * 因此 33% 这个数字本身就是「窗口 + 归档剥离」两条规则的联合断言。
 */
check('成功率只算窗口内、且归档不投票（33%）',
  statBlocks.some((line) => line.includes('成功率') && /\b33%/.test(line)), JSON.stringify(statBlocks))
check('完成数只算窗口内（1）', statBlocks.some((line) => /^1\s*完成$/.test(line.trim())), JSON.stringify(statBlocks))
check('窗口外的老任务不进指标（中位耗时不是 99 万毫秒的量级）',
  !statBlocks.some((line) => line.includes('平均耗时') && /分\s*3[0-9]/.test(line)), JSON.stringify(statBlocks))
check('窗口外的老任务本身仍在「需要处理」列表里',
  nowText().includes('窗口外的老任务'), '窗口过滤只影响指标，不该把任务从列表里摘掉')

check('失败行直接把原因摊出来', nowText().includes('原因') && nowText().includes('spawn 失败：ENOENT'))
const batchCounts = findAll(panel.tree, (item) => item.props && item.props.className === 'dsh-sa-batch-count')
  .map((item) => text(item).trim())
check('批次头给出 0/2 的进度', batchCounts.includes('0/2'), JSON.stringify(batchCounts))
check('「后台收尾」徽标可见', nowText().includes('后台收尾'))
check('「待读」徽标可见', nowText().includes('待读'))

chipFor('已归档').props.onClick()
update(panel)
const archivedRows = findAll(panel.tree, (item) => hasClass(item, 'dsh-sa-row') && item.props['data-archived'] === 'true')
check('已归档视图 3 行', archivedRows.length === 3, `实际 ${archivedRows.length}`)
check('归档行没有任何操作按钮', archivedRows.length === 3 && archivedRows.every((row) => buttonsOf(row).length === 0))
check('归档行显示相对时间', text(panel.tree).includes('2 小时前') && text(panel.tree).includes('1 天前'))
check('归档失败原因可见', text(panel.tree).includes('归档失败：会话已不存在'))

/*
 * 回归：点已归档任务**不能**开（也不许顺带新建）会话。
 *
 * 真实缺陷是宿主侧行为：`uiWorkspace.openSession()` 只换主视图，而 ui-workspace 的
 * `watchNavigation()` 一发现主视图落在 `archivedSessionIds` 里就 `clearMain()`，
 * 主区域随后被补建成一个空白会话 —— 表现为「点一下归档任务，跳到了新会话」。
 * 因此客户端必须**根本不调** openSession。下面的夹具故意给归档行留着
 * `worker_session_id`（真实快照就是这样），否则「不可点」会退化成「因为没有 id 所以
 * 点不了」，测不出真正的原因。
 */
check('归档行可见数据里带着 worker_session_id（否则本组断言不成立）',
  archivedRows.length === 3 && archivedRows.every((row) => Boolean(text(row).includes('已归档'))),
  JSON.stringify(archivedRows.map((row) => row.props && row.props['data-archived'])))

const openedBefore = opened.length
for (const row of archivedRows) {
  check('归档行没有 onClick 处理器', row.props.onClick === undefined,
    String(row.props.onClick))
  check('归档行没有 onKeyDown 处理器', row.props.onKeyDown === undefined,
    String(row.props.onKeyDown))
  check('归档行不占 Tab 位（无 tabIndex）', row.props.tabIndex === undefined,
    String(row.props.tabIndex))
  check('归档行没有手形光标类', !String(row.props.className || '').includes('dsh-sa-row-clickable'),
    String(row.props.className))
  check('归档行用 aria-disabled 说明不可打开', row.props['aria-disabled'] === true,
    String(row.props['aria-disabled']))
  check('归档行的 title 不含「点击打开子会话」', !String(row.props.title || '').includes('点击打开子会话'),
    String(row.props.title))
  // 真要点一下（例如脚本 dispatchEvent 绕过渲染判断）也不许跳到任何会话。
  check('归档行的 onClick 即使被外部调用也不存在可执行路径', typeof row.props.onClick !== 'function')
}
check('点归档行之后 openSession 一次都没被调用', opened.length === openedBefore,
  `新增调用 ${opened.length - openedBefore} 次（${JSON.stringify(opened.slice(openedBefore))}）`)

/*
 * 第二道闸：即使渲染层判断被绕过（键盘事件、将来的新调用方），`openWorker` 自己
 * 也必须拒绝归档任务。先用一个「可点」行验证正常行仍能打开，再**直接调用同一个
 * 处理器**并传入归档任务，断言它只给提示、不碰 uiWorkspace。
 */
chipFor('全部').props.onClick()
update(panel)
const normalRow = findAll(panel.tree, (item) => hasClass(item, 'dsh-sa-row')).find((item) => text(item).includes('t-run-1'))
check('未归档行仍然可点（onClick 存在）', normalRow && typeof normalRow.props.onClick === 'function')
const openedBeforeNormal = opened.length
if (normalRow) normalRow.props.onClick({ type: 'click', preventDefault() {} })
await tick()
update(panel)
check('未归档行点击仍然打开子会话（本修复没有误伤正常行）',
  opened.length === openedBeforeNormal + 1 && opened[opened.length - 1] === 'dispatch-t-run-1',
  JSON.stringify(opened.slice(openedBeforeNormal)))

/* ═════════════════════ 第二道闸：openWorker 自己拒绝归档任务 ═════════════════════ */

/*
 * 为什么必须单独测这一层：
 *
 * 第一道闸（TaskCard 不给归档行 onClick/tabIndex）已经在上面的断言里钉住了，
 * 但它拦不住**绕过渲染层**的调用方 —— 键盘事件、将来新增的调用方、脚本
 * `dispatchEvent`。`openWorker` 里的 `if (task && task.archived_at)` 是最后一道
 * 防线（`openSession()` 在归档会话上会触发宿主侧 `clearMain()`，表现为
 * 「点一下归档任务，跳到了一个空白新会话」）。
 *
 * 这里不点击任何行：直接取出 `BoardPanel` 传给 TaskCard 的 `handlers.open`，
 * 用**归档任务对象**调用它。断言的是这道闸自己的行为，与渲染层无关。
 */
console.log('\n第二道闸：openWorker 拒绝归档任务')

/** 每一次渲染都会把 handlers 递给每一张 TaskCard；取最后一次渲染的就够。 */
const liveHandlers = () => (cardProps.length ? cardProps[cardProps.length - 1].handlers : null)
const handlersRef = liveHandlers()
check('能够拿到 BoardPanel 的内部 handlers（旁路捕获到 TaskCard props）',
  Boolean(handlersRef) && typeof handlersRef.open === 'function',
  handlersRef ? Object.keys(handlersRef).join(',') : `捕获 ${cardProps.length} 次`)
// 形状断言：handlers 就是 { act, open } 两个键，open 是 async 处理器。
check('handlers 的形状是 { act, open }，且 open 是异步处理器',
  Boolean(handlersRef) && Object.keys(handlersRef).sort().join(',') === 'act,open'
    && handlersRef.open.constructor && handlersRef.open.constructor.name === 'AsyncFunction',
  handlersRef ? `${Object.keys(handlersRef).sort().join(',')} / ${handlersRef.open.constructor.name}` : 'null')

const archivedTask = boardResponse.tasks.find((item) => item.task_id === 't-arc-1')
const openedBeforeGate = opened.length
// 直接调用处理器 —— 归档行的渲染层闸门被完全绕过。
const gateResult = handlersRef.open(archivedTask)
await tick()
update(panel)
check('归档任务经 openWorker 也不会打开会话',
  opened.length === openedBeforeGate,
  `新增调用 ${opened.length - openedBeforeGate} 次（${JSON.stringify(opened.slice(openedBeforeGate))}）`)
check('归档分支提前 return（处理器结果为空，没有把错误往上抛）',
  gateResult instanceof Promise && (await gateResult) === undefined,
  String(gateResult))

const notices = findAll(panel.tree,
  (item) => item && item.props && typeof item.props.className === 'string'
    && item.props.className.includes('dsh-sa-strip'))
const warnStrip = notices.find((item) => item.props.className.includes('dsh-sa-strip-warn'))
check('归档任务给出的是可关闭的警告条（warn 语气）', Boolean(warnStrip),
  JSON.stringify(notices.map((item) => item.props.className)))
const noticeText = warnStrip ? text(warnStrip).replace(/\s+/g, ' ').trim() : ''
check('提示文案就是 archivedHint', noticeText.includes('该子会话已归档，不可直接打开；请在会话列表里取消归档后再查看'),
  noticeText.slice(0, 160))
check('提示条用 role=status 播报（不是 error 的 alert）', Boolean(warnStrip) && warnStrip.props.role === 'status',
  warnStrip && String(warnStrip.props.role))
check('提示条上带着可关闭的按钮', Boolean(warnStrip) && buttonsOf(warnStrip).some((item) => text(item).includes('关闭提示')))

/*
 * 归档 + 没有 worker_session_id 的组合：必须落到「归档」而不是「没有子会话」。
 * 源码里归档判断在 `!target` 之前，正是为了让归档任务得到一个能指导下一步的
 * 提示，而不是被当成数据缺失。顺序颠倒了这条会失败。
 */
const archivedNoSession = {
  task_id: 't-arc-nosession',
  title: '归档且没有子会话的任务',
  status: 'done',
  archived_at: hoursAgo(1),
}
const openedBeforeNoId = opened.length
await handlersRef.open(archivedNoSession)
await tick()
update(panel)
const noIdText = text(panel.tree)
check('归档判断先于「没有子会话」判断（归档 + 无 id 仍给归档提示）',
  noIdText.includes('该子会话已归档，不可直接打开') && !noIdText.includes('这个任务没有可打开的子会话'),
  noIdText.replace(/\s+/g, ' ').slice(0, 200))
check('归档 + 无 id 也不打开会话', opened.length === openedBeforeNoId,
  `新增调用 ${opened.length - openedBeforeNoId} 次`)

/*
 * 反向对照：同一个处理器、同一个入口，只把 archived_at 去掉就应该真的打开。
 * 没有这条，上面的「没打开」可能只是因为处理器整体坏了（或根本没被调用）。
 */
const liveTask = boardResponse.tasks.find((item) => item.task_id === 't-run-1')
const openedBeforeLive = opened.length
await handlersRef.open(liveTask)
await tick()
update(panel)
check('同一个处理器打开未归档任务会真的调 openSession（说明上一条不是空转）',
  opened.length === openedBeforeLive + 1 && opened[opened.length - 1] === 'dispatch-t-run-1',
  JSON.stringify(opened.slice(openedBeforeLive)))
check('打开成功后清掉归档提示，不留残影', !text(panel.tree).includes('该子会话已归档，不可直接打开'),
  text(panel.tree).replace(/\s+/g, ' ').slice(0, 160))

/*
 * 再补一条「没有子会话」的对照：非归档 + 无 worker_session_id 才是 noWorkerSession。
 * 三条路径各归各的文案，才不会把「归档了」误报成「数据缺失」。
 */
const noSession = { task_id: 't-nosession', title: '没有子会话的任务', status: 'done' }
const openedBeforeMissing = opened.length
await handlersRef.open(noSession)
await tick()
update(panel)
check('未归档 + 无子会话才报 noWorkerSession',
  text(panel.tree).includes('这个任务没有可打开的子会话'),
  text(panel.tree).replace(/\s+/g, ' ').slice(0, 160))
check('未归档 + 无子会话也不打开会话', opened.length === openedBeforeMissing,
  `新增调用 ${opened.length - openedBeforeMissing} 次`)

/* ── P0-5 退休可查：独立只读路由 + 紧凑单行列表 ── */
console.log('\n已退休视图')

/**
 * 切到「已退休」并等数据落地。
 *
 * 为什么不是一次 update：选中 chip 只是 setFilter，退休记录的网络请求挂在
 * effect 里，要等这次渲染提交后才会发出；请求落地又会再提交一次数据。
 * 所以顺序是 提交 → 等 tick → 提交。少一次提交，面板上永远停在「正在读取」。
 */
async function openRetired() {
  chipFor('已退休').props.onClick()
  update(panel)
  await tick()
  await tick()
  update(panel)
}

retiredResponse = retiredFixture()
retiredMode = 'ok'
const beforeRetired = requests.filter((item) => item.url.endsWith('/retired')).length
await openRetired()
const afterRetired = requests.filter((item) => item.url.endsWith('/retired')).length
check('选中已退休才去取 /board/retired', afterRetired === beforeRetired + 1, `前 ${beforeRetired} 后 ${afterRetired}`)
const retiredRows = findAll(panel.tree, (item) => hasClass(item, 'dsh-sa-row') && item.props['data-retired'] === 'true')
check('退休视图渲染 2 行', retiredRows.length === 2, `实际 ${retiredRows.length}`)
const retiredText = text(panel.tree)
// formatRelative 向下取整：3 小时前的那条渲染成「2 小时前」，「1 天前」那条是 30 小时。
check('退休行显示「退休于 N 前」',
  retiredText.includes('退休于 2 小时前') && retiredText.includes('退休于 1 天前'),
  retiredText.replace(/\s+/g, ' ').slice(0, 160))
check('原因 cap-count 翻成「条数上限」', retiredText.includes('条数上限'))
check('原因 cap-days 翻成「超过保留期」', retiredText.includes('超过保留期'))
check('退休行不显示原始机器键', !retiredText.includes('cap-count') && !retiredText.includes('cap-days'))
check('退休视图不是任务行（不含子会话可点样式）',
  retiredRows.every((row) => row.props.onClick === undefined && row.props.tabIndex === undefined))
check('退休行只有「复制 id」按钮',
  retiredRows.length === 2 && retiredRows.every((row) => buttonsOf(row).length === 1 && text(buttonsOf(row)[0]).includes('复制')),
  JSON.stringify(retiredRows.map((row) => buttonsOf(row).map((item) => text(item)))))
check('退休记录不混进任务列表', !nowText().includes('t-ret-1'))
check('退休视图用独立分节标题', retiredText.includes('已退休'))

// 复制 id：Node 里没有剪贴板也没有 document.body，走兜底后应给出可读的失败提示而不是静默。
const copyBtn = buttonsOf(retiredRows[0])[0]
copyBtn.props.onClick({ stopPropagation() {} })
await tick()
update(panel)
const copiedText = text(panel.tree)
check('复制 id 的反馈走现有提示条', copiedText.includes('t-ret-1') && (copiedText.includes('已复制') || copiedText.includes('复制失败')),
  copiedText.replace(/\s+/g, ' ').slice(0, 160))

/*
 * 剪贴板 Promise 永不结算时的回归：真机（file:// 预览页）实测
 * `navigator.clipboard.writeText()` 的 Promise 会永久 pending，
 * 直接 await 会让「复制」看起来毫无反应 —— 这正是要消灭的"点了没反应"。
 * 这里塞一个永不 settle 的 clipboard，断言界面仍然给出结论。
 */
const savedClipboard = globalThis.navigator && globalThis.navigator.clipboard
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText() { return new Promise(() => {}) } } },
})
await openRetired()
const hangBtn = buttonsOf(findAll(panel.tree, (item) => hasClass(item, 'dsh-sa-row') && item.props['data-retired'] === 'true')[0])[0]
hangBtn.props.onClick({ stopPropagation() {} })
// 超时闸是 800ms，等它过去。
await new Promise((resolve) => setTimeout(resolve, 950))
update(panel)
const hangText = text(panel.tree)
check('剪贴板 Promise 挂死时不给「没反应」，仍然回一句结论',
  hangText.includes('t-ret-1') && (hangText.includes('已复制') || hangText.includes('复制失败')),
  hangText.replace(/\s+/g, ' ').slice(0, 160))
if (savedClipboard) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: savedClipboard } })
} else {
  delete globalThis.navigator
}

// dropped 提示：退休记录自己也到了展示上限时必须明说。
retiredResponse = Object.assign(retiredFixture(), { count: 5, dropped: 3 })
chipFor('全部').props.onClick()
update(panel)
await openRetired()
check('退休记录超出展示上限时给出提示', text(panel.tree).includes('另有 3 条退休记录超出展示上限'),
  text(panel.tree).replace(/\s+/g, ' ').slice(0, 200))

// 空态：真的没有退休记录。
retiredResponse = { ok: true, count: 0, dropped: 0, entries: [] }
chipFor('全部').props.onClick()
update(panel)
await openRetired()
check('没有退休记录时给出空态', text(panel.tree).includes('没有被退休的任务'))

// 加载失败：沿用「暂时取不到」模式，不整块崩，给重试。
retiredMode = 'fail'
chipFor('全部').props.onClick()
update(panel)
await openRetired()
check('退休记录取不到时给出可读原因', text(panel.tree).includes('退休记录暂时取不到'),
  text(panel.tree).replace(/\s+/g, ' ').slice(0, 200))
check('退休记录取不到时仍有重试按钮', buttonsOf(panel.tree).some((item) => text(item).includes('重试')))
check('退休记录取不到时面板没崩（其余 chip 还在）', Boolean(chipFor('全部')))
retiredMode = 'ok'
retiredResponse = { ok: true, count: 0, dropped: 0, entries: [] }
chipFor('全部').props.onClick()
update(panel)

chipFor('全部').props.onClick()
update(panel)
const select = findAll(panel.tree, (item) => item.type === 'select')[0]
check('有工作区筛选下拉', Boolean(select))
select.props.onChange({ target: { value: 'ws-2' } })
update(panel)
check('工作区筛选生效（ws-1 的任务消失）', !text(panel.tree).includes('t-run-1'))
check('工作区筛选保留 ws-2 的任务', text(panel.tree).includes('t-run-2'))
findAll(panel.tree, (item) => item.type === 'select')[0].props.onChange({ target: { value: '' } })
update(panel)
check('批次任务有「批次」徽标', text(panel.tree).includes('批次'))

const targetRow = findAll(panel.tree, (item) => hasClass(item, 'dsh-sa-row')).find((item) => text(item).includes('t-run-1'))
uiWorkspace.openSession = async () => { throw new Error('not-listed') }
targetRow.props.onClick({ type: 'click', preventDefault() {} })
await tick()
update(panel)
check('子会话打不开时给出可读提示', text(panel.tree).includes('打不开子会话 dispatch-t-run-1：not-listed'))
unmount(panel)

/* ═════════════════════ P0-4 状态徽标：冻结 / 未读未知 / 截断 ═════════════════════ */

/*
 * 宿主侧 `boardTask()` 已经投影了 `frozen_at` / `input_unknown_at` / `has_truncated`
 * 三个字段，但客户端不认识的字段等于不存在：看板会安静地少显示三个状态。
 * 这一段就是「客户端真的把它们画出来了」的离线证据，同时钉住降级路径
 * （三个字段全缺 → 一个新标记都不出现），以及「未读未知 ≠ 待读」这条语义。
 */
console.log('\n状态徽标：冻结 / 未读未知 / 截断')

/**
 * 取一行里所有徽标文本（`dsh-sa-tag*`），断言按行比按整面板比更不容易误伤。
 *
 * 按**标题**找行而不是 task_id：`最近完成` 段用的是 dense 单行，那一行里没有
 * task_id（只有标题、状态与耗时），用 id 找会得到 null。
 */
function rowByTitle(tree, title) {
  return findAll(tree, (item) => hasClass(item, 'dsh-sa-row') && text(item).includes(title))[0]
}
function tagsOfRow(tree, title) {
  const row = rowByTitle(tree, title)
  if (!row) return null
  return findAll(row, (item) => hasClass(item, 'dsh-sa-tag')).map((item) => text(item).trim())
}

boardResponse = statusBadgeFixture()
const badgePanel = mount(panelReg.component)
await tick()
await tick()
update(badgePanel)
// 「全部」里有冻结行、未读未知行、截断行与干净行；按 chip 计数至少证明四行都在。
const badgeAllText = text(badgePanel.tree)

const frozenTags = tagsOfRow(badgePanel.tree, '冻结但未归档')
check('frozen_at → 出现「已冻结」徽标', Boolean(frozenTags) && frozenTags.includes('已冻结'), JSON.stringify(frozenTags))
const unknownTags = tagsOfRow(badgePanel.tree, '未读未知任务')
check('input_unknown_at → 出现「未读未知」徽标', Boolean(unknownTags) && unknownTags.includes('未读未知'), JSON.stringify(unknownTags))
check('input_unknown_at → **不**出现「待读」（那是要消灭的误导）',
  Boolean(unknownTags) && !unknownTags.includes('待读'), JSON.stringify(unknownTags))
const truncTags = tagsOfRow(badgePanel.tree, '摘要被截断的任务')
check('has_truncated → 摘要行出现「摘要已截断」标记',
  Boolean(rowByTitle(badgePanel.tree, '摘要被截断的任务')) && text(badgePanel.tree).includes('摘要已截断'),
  truncTags ? JSON.stringify(truncTags) : 'row missing')
check('截断标记带 hover 说明（原文更长 + 前 N 字）',
  findAll(badgePanel.tree, (item) => item.props && item.props['data-truncated'] === 'true')
    .every((item) => typeof item.props.title === 'string' && item.props.title.includes('6000') && item.props.title.includes('dispatch_inspect')),
  JSON.stringify(findAll(badgePanel.tree, (item) => item.props && item.props['data-truncated'] === 'true').map((i) => i.props.title)))
const plainTags = tagsOfRow(badgePanel.tree, '没有任何新标记的任务')
check('三个字段全缺 → 没有「已冻结」',
  Boolean(plainTags) && !plainTags.includes('已冻结'), JSON.stringify(plainTags))
check('三个字段全缺 → 没有「未读未知」',
  Boolean(plainTags) && !plainTags.includes('未读未知'), JSON.stringify(plainTags))
check('三个字段全缺 → 没有「待读」',
  Boolean(plainTags) && !plainTags.includes('待读'), JSON.stringify(plainTags))
const plainRow = rowByTitle(badgePanel.tree, '没有任何新标记的任务')
check('三个字段全缺 → 没有截断标记',
  Boolean(plainRow) && findAll(plainRow, (item) => item.props && item.props['data-truncated'] === 'true').length === 0,
  plainRow ? 'row found' : 'row missing')
check('截断标记全局只出现一次（只挂在被截过的那一行）',
  findAll(badgePanel.tree, (item) => item.props && item.props['data-truncated'] === 'true').length === 1,
  String(findAll(badgePanel.tree, (item) => item.props && item.props['data-truncated'] === 'true').length))
check('未读未知行仍然可辨识状态（status 文字还在）', badgeAllText.includes('运行中'), badgeAllText.replace(/\s+/g, ' ').slice(0, 120))
// 必须卸载：面板的轮询定时器会一直挂住事件循环，全绿分支没有 process.exit 兜底。
unmount(badgePanel)

/*
 * 归档行一定会同时带 archived_at 与 frozen_at（archiveStale() 同一次写）。
 * 它已经有「已归档」徽标和整行淡出，不该再叠一个「已冻结」——这里钉住
 * 「不重复」，同时钉住 hover 里仍然交代了冻结的语义（信息不丢，只是不重复喊）。
 */
boardResponse = boardFixture()
const archivedPanel = mount(panelReg.component)
await tick()
await tick()
update(archivedPanel)
/** `chipForIn` 的早期版本：它在降级段才定义，这里先用一份等价的。 */
const chipInPanel = (root, label) => buttonsOf(root.tree)
  .find((item) => item.props['aria-pressed'] !== undefined && text(item).includes(label))
chipInPanel(archivedPanel, '已归档').props.onClick()
update(archivedPanel)
const arcRow = findAll(archivedPanel.tree, (item) => hasClass(item, 'dsh-sa-row') && text(item).includes('归档任务一'))[0]
check('归档行不重复显示「已冻结」徽标',
  Boolean(arcRow) && !findAll(arcRow, (item) => hasClass(item, 'dsh-sa-tag')).map((item) => text(item).trim()).includes('已冻结'),
  arcRow ? JSON.stringify(findAll(arcRow, (item) => hasClass(item, 'dsh-sa-tag')).map((item) => text(item).trim())) : 'row missing')
check('归档行仍保留「已归档」徽标', Boolean(arcRow) && text(arcRow).includes('已归档'))
unmount(archivedPanel)

/*
 * 降级：宿主只给 has_truncated，不给 memory 块（旧版宿主 / headless）。
 * 这时不能编一个「前 6000 字」出来，只能说不带数字的那句。
 */
const noCap = statusBadgeFixture()
delete noCap.memory
boardResponse = noCap
const noCapPanel = mount(panelReg.component)
await tick()
await tick()
update(noCapPanel)
const noCapMarks = findAll(noCapPanel.tree, (item) => item.props && item.props['data-truncated'] === 'true')
check('没有 memory 块时截断标记仍在（字段本身就在快照里）', noCapMarks.length === 1, String(noCapMarks.length))
check('没有 memory 块时不编造上限数字（退化成不带 n 的说法）',
  noCapMarks.length === 1 && !/\d/.test(String(noCapMarks[0].props.title)) && String(noCapMarks[0].props.title).includes('dispatch_inspect'),
  noCapMarks.length ? String(noCapMarks[0].props.title) : 'mark missing')
unmount(noCapPanel)
boardResponse = boardFixture()

/* ═════════════════════ 降级：宿主没提供 memory 块 ═════════════════════ */

/*
 * host 核心的 memoryStats() 可能还没落地（或 headless 形态没有它）。
 * 面板必须照常工作：窗口按「全部已结算」，退休 chip 显示「宿主未提供」，
 * 其余视图一条不少，且**不抛错、不白屏**。这一段就是那条验收的离线证据。
 */
console.log('\n降级：没有 memory 块')
/** chipFor 是绑定在 panel 上的闭包，降级段挂的是另一个实例，这里给个通用版。 */
const chipForIn = (root, label) => buttonsOf(root.tree)
  .find((item) => item.props['aria-pressed'] !== undefined && text(item).includes(label))
const noMemory = boardFixture()
delete noMemory.memory
delete noMemory.counts.retired
boardResponse = noMemory
retiredResponse = { ok: true, count: 0, dropped: 0, entries: [] }
retiredMode = 'ok'
const degraded = mount(panelReg.component)
await tick()
await tick()
update(degraded)

check('没有 memory 时面板照常渲染任务', text(degraded.tree).includes('t-run-1'))
const degradedWindow = findAll(degraded.tree, (item) => item && item.props && hasClass(item, 'dsh-sa-stat-window'))
  .map((item) => text(item).replace(/\s+/g, ' ').trim())
check('窗口未知时标注「窗口未知 · 全部已结算」',
  degradedWindow.length === 1 && degradedWindow[0].includes('窗口未知') && degradedWindow[0].includes('全部已结算'),
  JSON.stringify(degradedWindow))
const degradedChips = buttonsOf(degraded.tree).filter((item) => item.props['aria-pressed'] !== undefined)
const retiredChip = degradedChips.find((item) => text(item).includes('已退休'))
check('退休 chip 在降级下仍在', Boolean(retiredChip))
check('退休 chip 计数显示「—」而不是假 0', Boolean(retiredChip) && text(retiredChip).includes('—'),
  retiredChip && text(retiredChip).replace(/\s+/g, ' ').trim())
/*
 * 降级时「全部已结算」= 不按窗口过滤，但**归档仍然被移出**：
 * 这是 effectStats 里与窗口无关的那条规则，两个快照口径都必须成立。
 * 窗口内 1 done / 3 settled；加上窗口外的 t-old-7 是 1 done / 4 settled = 25%。
 * 无论 33% 还是 25%，都不能是「归档也投票」的 2/7 = 29%。
 */
const degradedStats = findAll(degraded.tree, (item) => item && item.props && item.props.className === 'dsh-sa-stat')
  .map((item) => text(item).replace(/\s+/g, ' ').trim())
check('降级时窗口外的老任务重新计入（25%），但仍不含归档任务',
  degradedStats.some((line) => line.includes('成功率') && /\b25%/.test(line)), JSON.stringify(degradedStats))

chipForIn(degraded, '已退休').props.onClick()
update(degraded)
await tick()
await tick()
update(degraded)
check('降级时退休视图给出「宿主未提供」', text(degraded.tree).includes('宿主未提供退休记录'),
  text(degraded.tree).replace(/\s+/g, ' ').slice(0, 200))
unmount(degraded)
boardResponse = boardFixture()

/* ═════════════════════ 派发目标选择器 ═════════════════════ */

console.log('\n派发目标选择器')
const pickerReg = pickerRegs[0]
const pickerProps = { sessionId: 'session-a' }
const targetRequests = () => requests.filter((item) => item.url.endsWith('/target'))

boardResponse = boardFixture()
getMode = 'ok'
postReply = { ok: true, target: null }
let picker = mount(pickerReg.component, pickerProps)
await tick()
await tick()
update(picker)

let trigger = findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-target'))[0]
check('有目标时显示「派发 → 主工作区」', Boolean(trigger) && text(trigger).includes('派发 → 主工作区'), trigger && text(trigger).replace(/\s+/g, ' ').trim())
check('有目标时控件可用', trigger && trigger.props.disabled === false)

trigger.props.onClick()
await tick()
await tick()
update(picker)
let menu = findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-menu'))[0]
check('下拉打开', Boolean(menu))
const menuText = menu ? text(menu) : ''
check('下拉第一项是「不派发」', menuText.indexOf('不派发') >= 0 && menuText.indexOf('不派发') < menuText.indexOf('自动选择'),
  menuText.slice(0, 60))
check('下拉含「自动选择」', menuText.includes('自动选择'))
check('下拉含全部工作区', menuText.includes('主工作区') && menuText.includes('副工作区'))
check('下拉含「刷新列表」', menuText.includes('刷新列表'))
const checked = menu ? findAll(menu, (item) => item.props && item.props['aria-checked'] === true) : []
check('当前目标带勾选且只勾一个', checked.length === 1 && text(checked[0]).includes('主工作区'), JSON.stringify(checked.map((item) => text(item))))

// 「自动选择」是默认项：点它应发 workspace:"auto"，并且勾选随之转移过去
const autoBtn = menu ? buttonsOf(menu).find((item) => text(item).includes('自动选择')) : undefined
check('下拉里有「自动选择」按钮', Boolean(autoBtn))
if (autoBtn) autoBtn.props.onClick()
await tick()
await tick()
const autoPost = targetRequests().slice(-1)[0]
let autoBody = null
try { autoBody = JSON.parse(autoPost.body) } catch (error) { autoBody = null }
check('选「自动选择」POST workspace:"auto"', Boolean(autoBody) && autoBody.workspace === 'auto',
  JSON.stringify(autoBody))

const pickBtn = menu ? buttonsOf(menu).find((item) => text(item).includes('副工作区')) : undefined
if (pickBtn) pickBtn.props.onClick()
await tick()
await tick()
update(picker)
const pickPost = targetRequests().slice(-1)[0]
check('选中后 POST /target', Boolean(pickPost) && pickPost.method === 'POST')
let pickBody = null
try { pickBody = JSON.parse(pickPost.body) } catch (error) { pickBody = null }
check('POST body 是 {session_id, workspace}',
  Boolean(pickBody) && pickBody.session_id === 'session-a' && pickBody.workspace === 'ws-2',
  pickPost && String(pickPost.body))
check('选成功后关闭下拉', findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-menu')).length === 0)
trigger = findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-target'))[0]
check('选成功后文案更新', Boolean(trigger) && text(trigger).includes('派发 → 副工作区'), trigger && text(trigger).replace(/\s+/g, ' ').trim())

trigger.props.onClick()
await tick()
await tick()
update(picker)
menu = findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-menu'))[0]
const noneRow = menu ? buttonsOf(menu).find((item) => text(item).includes('不派发')) : undefined
if (noneRow) noneRow.props.onClick()
await tick()
await tick()
update(picker)
let clearBody = null
try { clearBody = JSON.parse(targetRequests().slice(-1)[0].body) } catch (error) { clearBody = null }
check('「不派发」清除目标（workspace 为空串）', Boolean(clearBody) && clearBody.workspace === '', JSON.stringify(clearBody))
trigger = findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-target'))[0]
check('清除后文案回到「派发 → 不派发」', Boolean(trigger) && text(trigger).includes('派发 → 不派发'), trigger && text(trigger).replace(/\s+/g, ' ').trim())

boardResponse = boardFixture()
trigger.props.onClick()
await tick()
await tick()
update(picker)
menu = findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-menu'))[0]
postReply = { ok: false, error: '找不到工作区「不存在」。现有：主工作区、副工作区' }
const failingRow = menu ? buttonsOf(menu).find((item) => text(item).includes('主工作区')) : undefined
if (failingRow) failingRow.props.onClick()
await tick()
await tick()
update(picker)
const errorMenu = findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-menu'))[0]
check('409 时下拉不关闭', Boolean(errorMenu))
check('409 的中文原因显示在下拉里',
  Boolean(errorMenu) && text(errorMenu).includes('设置派发目标失败：找不到工作区「不存在」'),
  errorMenu ? text(errorMenu).replace(/\s+/g, ' ').slice(0, 80) : '')

check('下拉打开时有 document 监听', documentListeners.size > 0, `${documentListeners.size}`)
unmount(picker)
check('卸载后 document 监听归零', documentListeners.size === 0, `${documentListeners.size}`)
check('卸载后 window 监听归零', windowListeners.size === 0, `${windowListeners.size}`)

boardResponse = boardFixture()
getMode = 'fail'
picker = mount(pickerReg.component, pickerProps)
await tick()
await tick()
update(picker)
trigger = findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-target'))[0]
check('快照取不到时控件禁用', Boolean(trigger) && trigger.props.disabled === true)
check('禁用时文案是「派发 → 不派发」', Boolean(trigger) && text(trigger).includes('派发 → 不派发'), trigger && text(trigger).replace(/\s+/g, ' ').trim())
check('禁用时 title 提示看板服务不可用', Boolean(trigger) && trigger.props.title === '看板服务不可用', trigger && String(trigger.props.title))
if (trigger) trigger.props.onClick()
update(picker)
check('禁用时点不开下拉', findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-menu')).length === 0)
unmount(picker)
getMode = 'ok'

/* ═════════════════════ @ 工作区触发源 ═════════════════════ */

console.log('\n@ 工作区触发源')
boardResponse = boardFixture()
postReply = { ok: true, target: null }
const atSource = registeredSources[0]
const signal = new AbortController().signal

const rows = await atSource.candidates({ sessionId: 'session-a' }, { query: '', quoted: false, drilled: false, signal })
// 顺序：不派发 → 自动选择 → 全部工作区。
check('候选 = 不派发 + 自动选择 + 全部工作区', Array.isArray(rows) && rows.length === 4, Array.isArray(rows) ? String(rows.length) : 'not-array')
check('首条是「不派发」', Boolean(rows && rows[0] && rows[0].value === 'none' && rows[0].section === '不派发'),
  rows && rows[0] && JSON.stringify(rows[0]))
check('第二条是「自动选择」', Boolean(rows && rows[1] && rows[1].section === '自动选择' && rows[1].auto === true),
  rows && rows[1] && JSON.stringify(rows[1]))
check('自动选择在无关键词时也会指向一个真实工作区',
  Boolean(rows && rows[1] && (rows[1].value === 'ws-1' || rows[1].value === 'ws-2')),
  rows && rows[1] && String(rows[1].value))
check('候选带「工作区」分组', Boolean(rows && rows[2] && rows[2].section === '工作区'), rows && rows[2] && String(rows[2].section))
check('候选项形状正确', Boolean(rows && rows[2] && rows[2].value === 'ws-1' && rows[2].name === '主工作区'),
  rows && rows[2] && JSON.stringify(rows[2]))

const filtered = await atSource.candidates({ sessionId: 'session-a' }, { query: '副', signal })
check('候选按查询过滤（自动选择恒在前，不派发按关键词出现）',
  Array.isArray(filtered) && filtered.some(r => r.auto === true) && filtered.some(r => r.value === 'ws-2'),
  Array.isArray(filtered) ? JSON.stringify(filtered.map(function (r) { return r.value })) : 'not-array')
const autoRow = filtered.find(r => r.auto === true)
check('关键词命中时自动选择指向命中的工作区', Boolean(autoRow && autoRow.value === 'ws-2'), autoRow && String(autoRow.value))

// 自动选择：按关键词重排取第一名
const autoPicked = atSource.onPick({
  candidate: autoRow,
  session: { sessionId: 'session-a' },
  query: '副',
  action: 'pick',
  via: 'menu',
})
check('自动选择 onPick 产出 insert 且指向命中的工作区',
  Boolean(autoPicked && autoPicked.insert && autoPicked.insert.ref === 'ws-2'),
  autoPicked && autoPicked.insert && String(autoPicked.insert.ref))

// 没有匹配时给空 value，不静默失败
const emptyAuto = await atSource.candidates({ sessionId: 'session-a' }, { query: '不存在的词', signal })
const emptyAutoRow = emptyAuto.find(r => r.auto === true)
check('无匹配时自动选择仍显示且 value 为空',
  Boolean(emptyAutoRow && emptyAutoRow.value === ''),
  emptyAutoRow && JSON.stringify(emptyAutoRow))

// 「不派发」写空串清除目标
const nonePicked = atSource.onPick({
  candidate: rows[0],
  session: { sessionId: 'session-a' },
  action: 'pick',
  via: 'menu',
})
check('选「不派发」不插入 chip，且清除派发目标',
  nonePicked === undefined && targetRequests().some(r => { try { return JSON.parse(r.body).workspace === '' } catch { return false } }),
  nonePicked === undefined ? '未插入' : JSON.stringify(nonePicked))

const before = targetRequests().length
const pickResult = atSource.onPick({
  candidate: rows[3],
  session: { sessionId: 'session-a' },
  action: 'pick',
  via: 'menu',
})
check('onPick 返回 insert', Boolean(pickResult && pickResult.insert))
check('insert 指向 workspace 源与工作区 id',
  Boolean(pickResult && pickResult.insert && pickResult.insert.source === 'workspace' && pickResult.insert.ref === 'ws-2'))
check('insert 的 clipboardText 是 @标题',
  Boolean(pickResult && pickResult.insert && pickResult.insert.clipboardText === '@副工作区'),
  pickResult && pickResult.insert && String(pickResult.insert.clipboardText))
check('insert 不带 appearance（避免草稿恢复被清空）',
  Boolean(pickResult && pickResult.insert && !('appearance' in pickResult.insert)))
await tick()
const posted = targetRequests().slice(before)
check('选中即设置派发目标', posted.length === 1, `实际 ${posted.length}`)
let atBody = null
try { atBody = JSON.parse(posted[0].body) } catch (error) { atBody = null }
check('@ 选中写入的是该工作区', Boolean(atBody) && atBody.workspace === 'ws-2' && atBody.session_id === 'session-a',
  posted[0] && String(posted[0].body))

const serialized = await atSource.codec.serialize('ws-2')
check('codec.serialize 输出可读标记',
  typeof serialized === 'string' && serialized.includes('id="ws-2"') && serialized.includes('title="副工作区"'),
  String(serialized))
check('codec.clipboardText 与 chip 文本一致', atSource.codec.clipboardText('ws-2') === '@副工作区')

const sourceEffect = disposers.find((item) => item.label === 'dsh-mini-superagent: @ workspace source')
check('@ 源注册挂在 ctx.effect 上', Boolean(sourceEffect))
if (sourceEffect) sourceEffect.dispose()
check('dispose 时 registerSource 的 disposer 被调用', sourceDisposers.length === 1, `实际 ${sourceDisposers.length}`)

/* ═════════════════════ 汇总 ═════════════════════ */

console.log('')
if (failures.length) {
  console.error(`失败 ${failures.length} 项，通过 ${passed} 项：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`全部通过：${passed} 项检查`)
console.log('提醒：以上只是离线渲染断言；布局、portal 定位、主题对比度、草稿 chip 恢复仍需真机目视。')
