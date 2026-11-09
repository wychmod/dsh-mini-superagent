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
/**
 * GET /board/stats 的响应（plans/09 P1）。
 *
 * `statsMode` 三档，对应真实宿主上的三种情形：
 * - `'ok'`    正常聚合；
 * - `'404'`   宿主进程还是旧代码，路由根本没注册（**这是活宿主上最常见的真实情况**）；
 * - `'degraded'` 路由在，但聚合抛错，Host 返回 200 + `degraded:true` 的同构空结构。
 */
let statsResponse = null
let statsMode = 'ok'
const requests = []

globalThis.fetch = async (url, options) => {
  const method = (options && options.method) || 'GET'
  const body = options && options.body
  requests.push({ url, method, body })
  if (method === 'GET') {
    if (getMode === 'fail') return { ok: false, status: 500, async json() { return { ok: false, error: 'boom' } } }
    // 统计路由先于快照判断：它和 /board 是两个路由，判错会把 stats 当成一次普通快照。
    if (String(url).includes('/board/stats')) {
      if (statsMode === '404') return { ok: false, status: 404, async json() { return { ok: false, error: 'not found' } } }
      if (statsMode === 'degraded') {
        return { ok: true, status: 200, async json() { return degradedStatsFixture() } }
      }
      return { ok: true, status: 200, async json() { return statsResponse } }
    }
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
      { task_id: 't-q-3', title: '批次任务乙', status: 'queued', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', group: 'g1', worker_session_id: 'dispatch-t-q-3', elapsed_ms: 0, report_count: 0, created_at: hoursAgo(2) },
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

/**
 * plans/09 P2 的历史视图 fixture。
 *
 * 为什么另起一份而不复用 `boardFixture()`：那份的任务数、chip 计数、成功率都被
 * P0/P1 十几条断言钉住了，往里加行会连带改掉无关断言，让「这次改坏了什么」
 * 看不出来。这份只服务历史视图的断言，覆盖四件事：
 * - **搜索的四个字段**各有一条能命中（task_id / 标题 / worker_session_id / 工作区）；
 * - **排序可区分**：三个时间与耗时都不相同，换了排序键行序真的会变；
 * - **分页**：三条足够验证「每页 50 条」的边界与页码夹紧；
 * - **退休行**：没有 created_at / 没有 worker_session_id，必须不可打开、只能复制。
 */
function historyFixture() {
  return {
    version: '0.9.0',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 0, queued: 0, max: 6 },
    counts: { total: 4, running: 0, queued: 0, done: 2, blocked: 0, failed: 1, cancelled: 1, ended: 0, interrupted: 0, archived: 1, retired: 0 },
    memory: {
      window: { days: WINDOW_DAYS, tasks: 200 },
      ledger: { tasks: 4, retired: 0, archived: 1, retiredDropped: 0, capPerTask: { summary: 6000, detail: 4000 } },
    },
    workspaces: WORKSPACES,
    targets: {},
    tasks: [
      {
        task_id: 't-hist-a', title: '审计历史视图的抽屉', status: 'done', attempt: 2,
        workspace_id: 'ws-1', workspace_title: '主工作区',
        host_workspace_id: 'host-a', host_workspace_title: '主工作区（实际）',
        worker_session_id: 'dispatch-t-hist-a',
        created_at: hoursAgo(10), started_at: hoursAgo(9.5), settled_at: hoursAgo(9),
        time_basis: 'settledAt', elapsed_ms: 1800000,
        report_count: 3, last_report: { at: hoursAgo(9.2), status: 'done', summary: '抽屉六块都渲染了' },
        last_text_preview: '抽屉六块都渲染了，生命周期缺的一步写「没有记录」',
        cwd: 'C:/w1', task_dir: 'C:/w1/audit-hist-a', prepare_at: hoursAgo(9.9),
        background: { jobs: 1, subagents: 2, since: hoursAgo(9.4) },
        input_read_at: hoursAgo(9.1),
        error: '第一次尝试因为 fixture 缺字段失败',
      },
      {
        task_id: 't-hist-b', title: '结算时刻缺失的老任务', status: 'failed', attempt: 1,
        workspace_id: 'ws-2', workspace_title: '副工作区',
        worker_session_id: 'dispatch-t-hist-b',
        created_at: hoursAgo(40), updated_at: hoursAgo(39), elapsed_ms: 60000,
        report_count: 1, last_report: { at: hoursAgo(39.5), status: 'failed', summary: '验收没过' },
        error: '验收没过：少了 settled_at',
        archive_error: '会话已不存在',
      },
      {
        task_id: 't-hist-c', title: '已归档的历史记录', status: 'cancelled', attempt: 1,
        workspace_id: 'ws-1', workspace_title: '主工作区',
        worker_session_id: 'dispatch-t-hist-c',
        created_at: hoursAgo(200), updated_at: hoursAgo(199), archived_at: hoursAgo(190),
        frozen_at: hoursAgo(190), elapsed_ms: 30000, report_count: 0,
      },
    ],
  }
}

/** 历史视图「已退休」子视图用的留痕：没有 created_at、没有 worker_session_id。 */
function historyRetiredFixture() {
  return {
    ok: true,
    count: 1,
    dropped: 0,
    entries: [
      {
        task_id: 't-hist-ret', title: '被账本封顶退休的历史行', status: 'done',
        retired_at: hoursAgo(5), retired_reason: 'cap-count',
        archived_at: hoursAgo(6), updated_at: hoursAgo(5.5),
        summary: '被移出账本前的最后一条摘要',
      },
    ],
  }
}


/* ───────────────────── /board/stats fixture（plans/09 P1） ───────────────────── */

/** 一个成功聚合的最小但完整的响应，形状逐字对齐 src/stats.js 的 `boardStats()`。 */
function statsFixture() {
  return {
    statsVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: { window: { key: '7d', days: 7, since: hoursAgo(24 * 7) }, workspaceId: null, hostWorkspaceId: null },
    coverage: {
      sourceTasks: 42,
      inWindow: 12,
      settled: 8,
      validDurations: 6,
      excludedArchived: 3,
      excludedRetired: 2,
      missingTimes: 1,
      truncated: null,
      timeBasis: 'settledAt',
      fallbackCount: 0,
    },
    summary: {
      outcome: {
        settled: 8,
        completionBase: 6,
        done: 5,
        ended: 0,
        failed: 2,
        blocked: 1,
        interrupted: 0,
        cancelled: 2,
        completionRate: 0.8333,
        firstPassRate: 0.75,
        reworkRate: 0.2,
        cancelRate: 0.25,
        failureRate: 0.25,
        blockRate: 0.125,
        interruptedRate: 0,
        recoveryRate: 0.5,
        firstAttemptCount: 4,
        retriedCount: 2,
        reworkedCount: 3,
        dispatched: 15,
        throughput: { done: 5, perDay: 0.71, days: 7 },
        running: 2,
        queued: 1,
        sampleLow: false,
      },
      durations: {
        queueWait: { p50: 120000, p90: 900000, count: 6, sampleLow: false },
        occupied: { p50: 600000, p90: 3600000, count: 6, sampleLow: false },
        endToEnd: { p50: 720000, p90: 4500000, count: 6, sampleLow: false },
        longTail: 6,
        clamped: 0,
      },
      parallel: {
        occupiedMs: 21600000,
        wallMs: 7200000,
        savedMs: 14400000,
        factor: 3,
        sample: 6,
        sampleLow: false,
        estimated: true,
        degraded: false,
        reasons: [],
      },
      reliability: { undeliveredReports: 1, inputPending: 2, inputUnknown: 0, background: 1, backgroundKilled: 0, archiveErrors: 0, retryPending: 0 },
    },
    daily: [
      { day: '2026-11-06', created: 4, done: 3, failed: 1, blocked: 0, interrupted: 0, medianDuration: 480000, saved: 3600000 },
      { day: '2026-11-07', created: 6, done: 2, failed: 1, blocked: 1, interrupted: 0, medianDuration: 600000, saved: 10800000 },
    ],
    groups: {
      workspaces: {
        dimension: { target: 'workspace_id', host: 'host_workspace_id' },
        byTarget: [
          {
            workspaceId: 'ws-1', title: '主工作区', dispatched: 9, running: 2, queued: 1, settled: 6,
            done: 4, failed: 1, blocked: 1, interrupted: 0, cancelled: 1, completionRate: 0.8,
            medianOccupiedMs: 540000, savedMs: 9000000, lastActivityAt: hoursAgo(1),
          },
          {
            workspaceId: 'ws-2', title: '副工作区', dispatched: 3, running: 0, queued: 0, settled: 2,
            done: 1, failed: 1, blocked: 0, interrupted: 0, cancelled: 0, completionRate: 0.5,
            medianOccupiedMs: 300000, savedMs: 1800000, lastActivityAt: hoursAgo(2),
          },
        ],
        byHost: [
          {
            hostWorkspaceId: 'host-9', title: '实际归属工作区', dispatched: 12, running: 2, queued: 1, settled: 8,
            done: 5, failed: 2, blocked: 1, interrupted: 0, cancelled: 1, completionRate: 0.625,
            medianOccupiedMs: 600000, savedMs: 14400000, lastActivityAt: hoursAgo(1),
          },
        ],
      },
      batches: [
        {
          group: '批次甲', total: 5, dispatched: 5, running: 1, queued: 0, settled: 4,
          done: 3, failed: 1, blocked: 0, interrupted: 0, cancelled: 0, completionRate: 0.75,
          medianOccupiedMs: 420000, savedMs: 5400000, wallClockMs: 18000000, lastActivityAt: hoursAgo(1),
        },
      ],
      parentSessions: [
        {
          parentSessionId: 'session-lead', dispatched: 12, running: 2, queued: 1, settled: 8,
          done: 5, failed: 2, blocked: 1, interrupted: 0, cancelled: 1, completionRate: 0.625,
          medianOccupiedMs: 600000, savedMs: 14400000, lastActivityAt: hoursAgo(1),
        },
      ],
      statuses: [
        { status: 'running', count: 2, share: 0.1667 },
        { status: 'queued', count: 1, share: 0.0833 },
        { status: 'done', count: 5, share: 0.4167 },
        { status: 'failed', count: 2, share: 0.1667 },
        { status: 'blocked', count: 1, share: 0.0833 },
        { status: 'cancelled', count: 1, share: 0.0833 },
      ],
      retiredReasons: [
        { reason: 'cap-count', count: 2 },
        { reason: 'cap-days', count: 1 },
      ],
    },
  }
}

/** 一个「有数据但样本全空」的响应：所有 n=0，用来钉住 em dash 而不是 0。 */
function emptyStatsFixture() {
  const stats = statsFixture()
  return Object.assign({}, stats, {
    coverage: {
      sourceTasks: 8, inWindow: 0, settled: 0, validDurations: 0,
      excludedArchived: 0, excludedRetired: 0, missingTimes: 2, truncated: null,
      timeBasis: 'settledAt', fallbackCount: 0,
    },
    summary: {
      outcome: {
        settled: 0, completionBase: 0, done: 0, ended: 0, failed: 0, blocked: 0, interrupted: 0, cancelled: 0,
        completionRate: null, firstPassRate: null, reworkRate: null, cancelRate: null,
        failureRate: null, blockRate: null, interruptedRate: null, recoveryRate: null,
        firstAttemptCount: 0, retriedCount: 0, reworkedCount: 0, dispatched: 0,
        throughput: { done: 0, perDay: null, days: 7 },
        running: 0, queued: 0, sampleLow: false,
      },
      durations: {
        queueWait: { p50: null, p90: null, count: 0, sampleLow: false },
        occupied: { p50: null, p90: null, count: 0, sampleLow: false },
        endToEnd: { p50: null, p90: null, count: 0, sampleLow: false },
        longTail: null, clamped: 0,
      },
      parallel: {
        occupiedMs: null, wallMs: null, savedMs: null, factor: null,
        sample: 0, sampleLow: false, estimated: true, degraded: false, reasons: [],
      },
      reliability: { undeliveredReports: 0, inputPending: 0, inputUnknown: 0, background: 0, backgroundKilled: 0, archiveErrors: 0, retryPending: 0 },
    },
    daily: [],
    groups: {
      workspaces: { dimension: { target: 'workspace_id', host: 'host_workspace_id' }, byTarget: [], byHost: [] },
      batches: [],
      parentSessions: [],
      statuses: [],
      retiredReasons: [],
    },
  })
}

/**
 * 时间基准是「回退」的响应：`timeBasis: 'updatedAt-fallback'`。
 * 界面必须把这件事写出来（plans/09 §三.4、§八.6），否则「完成时间」会
 * 被当成权威值读，而它其实会被报告/追问/归档刷新。
 */
function fallbackStatsFixture() {
  const stats = statsFixture()
  const coverage = Object.assign({}, stats.coverage, { timeBasis: 'updatedAt-fallback', fallbackCount: 4 })
  return Object.assign({}, stats, { coverage })
}

/** Host 聚合抛错时的降级响应：形状同构、summary=null、`degraded:true`。 */
function degradedStatsFixture() {
  return {
    statsVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: false,
    degraded: true,
    reason: '聚合失败：ledger 损坏',
    scope: { window: { key: '7d', days: 7, since: hoursAgo(24 * 7) }, workspaceId: null, hostWorkspaceId: null },
    coverage: {
      sourceTasks: 0, inWindow: 0, settled: 0, validDurations: 0,
      excludedArchived: 0, excludedRetired: 0, missingTimes: 0, truncated: null,
      timeBasis: null, fallbackCount: 0,
    },
    summary: null,
    daily: [],
    groups: {
      workspaces: { dimension: { target: 'workspace_id', host: 'host_workspace_id' }, byTarget: [], byHost: [] },
      batches: [],
      parentSessions: [],
      statuses: [],
      retiredReasons: [],
    },
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
/*
 * 临时换掉 `uiWorkspace.openSession` 来模拟 `not-listed`。
 *
 * **用完必须换回来**：`uiWorkspace` 是整份冒烟脚本共用的一个对象，漏掉恢复会让
 * 后面所有「打开子会话」的断言都变成「抛错」，而失败信息会指向那些断言本身
 * （看起来像抽屉/历史视图坏了），排查方向完全跑偏。
 */
const realOpenSession = uiWorkspace.openSession
uiWorkspace.openSession = async () => { throw new Error('not-listed') }
targetRow.props.onClick({ type: 'click', preventDefault() {} })
await tick()
update(panel)
check('子会话打不开时给出可读提示', text(panel.tree).includes('打不开子会话 dispatch-t-run-1：not-listed'))
uiWorkspace.openSession = realOpenSession
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

/* ═════════════════════ plans/09 P1：效果 / 拆解 两视图 ═════════════════════ */

/*
 * 这一段的证明目标（逐条对应 plans/09 §八 的验收项）：
 *
 * - 视图切换存在，三个分段可点，且**总览的三段结构没被动**（§五.1）；
 * - 效果视图的五块都在，且每个比例都能看到分母（§八.1）；
 * - 样本口径行：n=0 显示 `—`、1≤n<5 标「样本少」、timeBasis 回退可见（§三.4、§八.6）；
 * - 趋势区图表/表格双形态可切换（§五.2），切换后仍是同一份数据；
 * - 拆解视图四块都在，表头写明 `workspace_id` vs `host_workspace_id`（§三.3）；
 * - 点行下钻 → 回到总览 + 顶部「已筛选 ×，清除」，清除后过滤消失（§五.3、§八.7）；
 * - **stats 404 / degraded 时降级回总览且不抛错**（这是活宿主上的真实情形，§八.10）。
 *
 * 全程只靠假 fetch：`statsMode` 决定 /board/stats 返回什么，因此「宿主还没加载
 * 新路由」这个最常见的情况可以被离线断言，而不需要重启真宿主。
 */
console.log('\nplans/09 P1：效果 / 拆解 两视图')

boardResponse = boardFixture()
statsResponse = statsFixture()
statsMode = 'ok'
getMode = 'ok'
retiredResponse = retiredFixture()
retiredMode = 'ok'

const p1 = mount(panelReg.component)
await tick()
await tick()
update(p1)

/** 按 `data-view-tab` 找视图分段按钮（比按文字找稳：文字会随语言变）。 */
const tabOf = (root, id) => findAll(root.tree, (item) => item && item.props && item.props['data-view-tab'] === id)[0]
const tabTexts = () => findAll(p1.tree, (item) => item && item.props && typeof item.props['data-view-tab'] === 'string')
  .map((item) => text(item).replace(/\s+/g, ' ').trim())

check('存在「总览 / 效果 / 拆解 / 历史」四个视图分段（plans/09 P2 的第四个）',
  ['overview', 'effect', 'breakdown', 'history'].every((id) => Boolean(tabOf(p1, id))), JSON.stringify(tabTexts()))
check('分段文字正确且顺序固定为 总览 / 效果 / 拆解 / 历史',
  tabTexts().join('|') === '总览|效果|拆解|历史', JSON.stringify(tabTexts()))
check('默认停在总览（不是记住上次的视图）',
  Boolean(tabOf(p1, 'overview')) && tabOf(p1, 'overview').props['aria-selected'] === true,
  tabOf(p1, 'overview') && String(tabOf(p1, 'overview').props['aria-selected']))

/* ── 总览：三段没动 + 只多了三个信号 ── */
check('总览仍然分成「需要你处理 / 在跑与排队 / 最近完成」三段（plans/09 §五.1 不让推翻 06）',
  ['需要你处理', '在跑与排队', '最近完成'].every((label) => text(p1.tree).includes(label)),
  text(p1.tree).replace(/\s+/g, ' ').slice(0, 120))
check('总览出现「当前排队最久」（data-oldest）',
  findAll(p1.tree, (item) => item.props && item.props['data-oldest'] === 'true').length >= 1,
  String(findAll(p1.tree, (item) => item.props && item.props['data-oldest'] === 'true').length))
const scopeEntry = findAll(p1.tree, (item) => item.props && item.props['data-scope-entry'] === 'true')[0]
check('总览有「样本口径入口」，点了进效果视图', Boolean(scopeEntry) && text(scopeEntry).includes('样本口径'),
  scopeEntry ? text(scopeEntry).replace(/\s+/g, ' ').trim() : 'missing')

/* ── 效果视图 ── */
scopeEntry.props.onClick()
update(p1)
await tick()
await tick()
update(p1)

const statsRequests = () => requests.filter((item) => String(item.url).includes('/board/stats'))
check('进入效果视图才去取 /board/stats（总览不拉全量聚合）', statsRequests().length >= 1,
  `实际 ${statsRequests().length} 次`)
check('stats 请求带上了 window 参数', statsRequests().some((item) => /[?&]window=/.test(item.url)),
  statsRequests().map((item) => item.url).join(' '))
check('默认窗口沿用 memory.window（7 天 → window=7d）',
  statsRequests().some((item) => /[?&]window=7d\b/.test(item.url)),
  statsRequests().map((item) => item.url).join(' '))

const effectText = () => text(p1.tree).replace(/\s+/g, ' ')
const cardTexts = () => findAll(p1.tree, (item) => hasClass(item, 'dsh-sa-card'))
  .map((item) => text(item).replace(/\s+/g, ' ').trim())
const cardText = (id) => {
  const card = findAll(p1.tree, (item) => item && item.props && item.props['data-card'] === id)[0]
  return card ? text(card).replace(/\s+/g, ' ').trim() : ''
}

check('效果视图渲染（data-view=effect）',
  findAll(p1.tree, (item) => item.props && item.props['data-view'] === 'effect').length === 1)
check('效果视图五块齐全：结果 / 速度 / 稳定 / 趋势 / 并行',
  ['result', 'speed', 'stable', 'trend', 'parallel'].every((id) =>
    findAll(p1.tree, (item) => item.props && item.props['data-group'] === id).length === 1),
  JSON.stringify(findAll(p1.tree, (item) => item.props && item.props['data-group']).map((item) => item.props['data-group'])))

/* 结果卡：完成量 / 完成率 / 一次完成率 / 返工率 / 吞吐 / 并行节省 */
const resultIds = ['done', 'rate', 'first', 'rework', 'throughput', 'saved']
check('结果卡六个都在（完成量 / 完成率 / 一次完成率 / 返工率 / 吞吐 / 并行节省）',
  resultIds.every((id) => cardText(id).length > 0), JSON.stringify(resultIds.map((id) => cardText(id))))
check('完成量是 5 且带文字标签', cardText('done').includes('完成量') && cardText('done').includes('5'), cardText('done'))
check('完成率 83.3% 且写出分母 n=6（取消不进分母）',
  cardText('rate').includes('83.3%') && cardText('rate').includes('n=6'), cardText('rate'))
check('一次完成率 75% 且分母是 attempt=1 的样本 n=4',
  cardText('first').includes('75%') && cardText('first').includes('n=4'), cardText('first'))
check('返工率 20% 且分母是窗口内派发数 n=15',
  cardText('rework').includes('20%') && cardText('rework').includes('n=15'), cardText('rework'))
check('吞吐按自然日数给（0.71 / 天，不是按有任务的天数）',
  cardText('throughput').includes('/ 天') && cardText('throughput').includes('0.71'), cardText('throughput'))
check('并行节省是粗算且标了「估算」',
  cardText('saved').includes('估算'), cardText('saved'))

/* 速度卡：三个分布的 P50/P90 */
check('速度卡给出队列等待 / 占用时长 / 端到端三张',
  ['queueWait', 'occupied', 'endToEnd'].every((id) => cardText(id).length > 0),
  JSON.stringify(['queueWait', 'occupied', 'endToEnd'].map((id) => cardText(id))))
check('每张速度卡同时给 P50 与 P90（%s 与 %s 两个标签都在）',
  cardText('queueWait').includes('P90') && cardText('occupied').includes('P90'), cardText('queueWait'))
check('速度卡带样本量（n=6）', cardText('occupied').includes('n=6'), cardText('occupied'))

/* 稳定卡：失败 / 阻塞 / 中断分开 */
check('稳定卡把失败 / 阻塞 / 中断三项分开（不合成一个「失败」）',
  ['failed', 'blocked', 'interrupted'].every((id) => cardText(id).length > 0),
  JSON.stringify(['failed', 'blocked', 'interrupted'].map((id) => cardText(id))))
check('取消单列，且分母写成「全部已结算」（含取消）',
  cardText('cancelled').includes('n=8'), cardText('cancelled'))
check('重试后恢复率带 attempt>1 的样本量 n=2',
  cardText('recovery').includes('50%') && cardText('recovery').includes('n=2'), cardText('recovery'))

/* 并行区：四个数一起给，才能复核「节省」 */
check('并行区给占用总和 / 墙钟跨度 / 并行节省 / 并行倍数',
  ['occupied-total', 'wall', 'saved-total', 'factor'].every((id) => cardText(id).length > 0),
  JSON.stringify(['occupied-total', 'wall', 'saved-total', 'factor'].map((id) => cardText(id))))
check('并行倍数写成 3.00×', cardText('factor').includes('3.00×'), cardText('factor'))

/* ── 趋势区：图表 / 表格双形态 ── */
const trendRowTexts = () => findAll(p1.tree, (item) => hasClass(item, 'dsh-sa-trend-row'))
  .map((item) => text(item).replace(/\s+/g, ' ').trim())
check('趋势区默认是图表形态', trendRowTexts().length === 2, JSON.stringify(trendRowTexts()))
check('趋势图的每一行都有文字读数（颜色之外还有文字）',
  trendRowTexts().length === 2 && trendRowTexts().every((line) => line.includes('完成') && line.includes('新派')),
  JSON.stringify(trendRowTexts()))
check('趋势图能读到失败·阻塞·中断的合计（2026-11-07 是 2）',
  trendRowTexts().some((line) => line.includes('2026-11-07') && /失败·阻塞·中断\s*2/.test(line)),
  JSON.stringify(trendRowTexts()))
const trendTableBtn = findAll(p1.tree, (item) => item.props && item.props['data-trend-mode'] === 'table')[0]
check('趋势区有「图表 / 表格」切换', Boolean(trendTableBtn) && text(trendTableBtn).includes('表格'))
trendTableBtn.props.onClick()
update(p1)
/** 用 type==='table' 找，而不是按 className 前缀：它同时带 dsh-sa-table 与 dsh-sa-trend-table。 */
const trendTable = findAll(p1.tree, (item) => item.type === 'table' && Array.isArray(item.props.children))[0]
check('切到表格形态后出现真正的 <table>', Boolean(trendTable))
check('表格给出 6 列（日期 / 新派 / 完成 / 问题 / 中位数 / 节省）',
  Boolean(trendTable) && findAll(trendTable, (item) => item.type === 'th').length >= 6,
  String(findAll(trendTable || { props: {} }, (item) => item.type === 'th').length))
check('表格里的数值与图表同源（2026-11-06 新派 4）',
  Boolean(trendTable) && text(trendTable).replace(/\s+/g, ' ').includes('2026-11-06'),
  trendTable ? text(trendTable).replace(/\s+/g, ' ').slice(0, 120) : 'no table')
const trendChartBtn = findAll(p1.tree, (item) => item.props && item.props['data-trend-mode'] === 'chart')[0]
check('能切回图表形态', Boolean(trendChartBtn))
trendChartBtn.props.onClick()
update(p1)
check('切回图表后条形行重新出现', trendRowTexts().length === 2, JSON.stringify(trendRowTexts()))

/* ── 样本口径行 ── */
const scopeLine = () => findAll(p1.tree, (item) => item.props && item.props['data-scope'] === 'true')[0]
check('效果视图固定显示样本口径行', Boolean(scopeLine()), 'missing')
const scopeText = () => (scopeLine() ? text(scopeLine()).replace(/\s+/g, ' ') : '')
check('样本口径行含五要素（结算 / 有效耗时 / 排除归档 / 退休 / 时间未知）',
  ['窗口内结算', '有效耗时', '排除归档', '退休', '时间未知'].every((label) => scopeText().includes(label)),
  scopeText())
check('样本口径行报出真实数字（结算 8 / 有效 6 / 归档 3 / 退休 2 / 未知 1）',
  /n=8/.test(scopeText()) && /n=6/.test(scopeText()) && scopeText().includes('排除归档 3')
    && scopeText().includes('退休 2') && scopeText().includes('时间未知 1'),
  scopeText())

/* ── 窗口选择器 ── */
const windowBtns = () => findAll(p1.tree, (item) => item.props && typeof item.props['data-window'] === 'string')
check('窗口选择器有 24h / 7天 / 30天 / 全部 四档',
  ['24h', '7d', '30d', 'all'].every((id) => windowBtns().some((item) => item.props['data-window'] === id)),
  JSON.stringify(windowBtns().map((item) => item.props['data-window'])))
check('默认点亮的是 memory.window 对应的 7d',
  windowBtns().some((item) => item.props['data-window'] === '7d' && item.props['aria-pressed'] === true),
  JSON.stringify(windowBtns().filter((item) => item.props['aria-pressed'] === true).map((item) => item.props['data-window'])))
const beforeWindow = statsRequests().length
findAll(p1.tree, (item) => item.props && item.props['data-window'] === '30d')[0].props.onClick()
update(p1)
await tick()
await tick()
update(p1)
check('切到 30 天会用 window=30d 重取统计',
  statsRequests().length > beforeWindow && statsRequests().slice(beforeWindow).some((item) => /window=30d/.test(item.url)),
  statsRequests().slice(beforeWindow).map((item) => item.url).join(' '))
const scopeNote = () => findAll(p1.tree, (item) => item.props && item.props['data-scope-note'])[0]
check('切窗口时提示「只统计最近 30 天」（plans/07 §九）',
  Boolean(scopeNote()) && text(scopeNote()).includes('只统计最近 30 天'),
  scopeNote() ? text(scopeNote()).replace(/\s+/g, ' ') : 'missing')
const beforeAll = statsRequests().length
findAll(p1.tree, (item) => item.props && item.props['data-window'] === 'all')[0].props.onClick()
update(p1)
await tick()
await tick()
update(p1)
check('切到「全部」用 window=all 重取', statsRequests().slice(beforeAll).some((item) => /window=all/.test(item.url)),
  statsRequests().slice(beforeAll).map((item) => item.url).join(' '))
check('「全部」时提示不再限制时间窗',
  text(scopeNote()).includes('统计全部历史事实'), text(scopeNote()).replace(/\s+/g, ' '))

/* ── 拆解视图 ── */
tabOf(p1, 'breakdown').props.onClick()
update(p1)
await tick()
await tick()
update(p1)
const breakdownText = () => text(p1.tree).replace(/\s+/g, ' ')
check('拆解视图渲染（data-view=breakdown）',
  findAll(p1.tree, (item) => item.props && item.props['data-view'] === 'breakdown').length === 1)
check('拆解视图四块齐全：工作区 / 批次 / 主会话 / 状态与退休原因',
  ['workspaces', 'batches', 'sessions', 'distribution'].every((id) =>
    findAll(p1.tree, (item) => item.props && item.props['data-group'] === id).length === 1),
  JSON.stringify(findAll(p1.tree, (item) => item.props && item.props['data-group']).map((item) => item.props['data-group'])))
check('工作区表默认按派发目标，表头写明 workspace_id',
  breakdownText().includes('派发目标') && breakdownText().includes('workspace_id'),
  breakdownText().slice(0, 200))
/*
 * 两个工作区维度的证据分两处：
 * - `.dsh-sa-dim-note`：**当前**口径（切换后跟着变，见后面的 host 断言）；
 * - 两个 `data-dim` 切换按钮：两个维度都摆在界面上，用户能看见「还有另一个」。
 */
const dimNotes = findAll(p1.tree, (item) => hasClass(item, 'dsh-sa-dim-note'))
  .map((item) => text(item).replace(/\s+/g, ' ').trim())
const dimBtns = findAll(p1.tree, (item) => item.props && typeof item.props['data-dim'] === 'string')
check('表头写明当前口径是派发目标 workspace_id',
  dimNotes.some((line) => line.includes('workspace_id') && line.includes('派发目标')),
  JSON.stringify(dimNotes.slice(0, 4)))
check('另一个维度 host_workspace_id 也在界面上（两个维度不混用）',
  dimBtns.length === 2
    && dimBtns.some((item) => item.props['data-dim'] === 'target')
    && dimBtns.some((item) => item.props['data-dim'] === 'host')
    && dimBtns.every((item) => typeof item.props.title === 'string' && item.props.title.includes('workspace_id')),
  JSON.stringify(dimBtns.map((item) => item.props.title)))
const wsTable = findAll(p1.tree, (item) => item.props && item.props['data-table'] === 'workspaces')[0]
check('工作区表有表头（工作区 / 在跑 / 排队 / 完成 / 完成率 / P50 占用 / 失败 / 阻塞 / 并行节省 / 最后活动）',
  Boolean(wsTable) && findAll(wsTable, (item) => item.type === 'th').length >= 10,
  String(findAll(wsTable || { props: {} }, (item) => item.type === 'th').length))
check('工作区表按派发目标渲染两行（主工作区 / 副工作区）',
  Boolean(wsTable) && text(wsTable).includes('主工作区') && text(wsTable).includes('副工作区'))
check('工作区行给出完成率及其分母',
  Boolean(wsTable) && /80%\s*\/\s*n=6/.test(text(wsTable).replace(/\s+/g, ' ')),
  wsTable ? text(wsTable).replace(/\s+/g, ' ').slice(0, 200) : 'no table')
const hostDimBtn = findAll(p1.tree, (item) => item.props && item.props['data-dim'] === 'host')[0]
check('工作区维度可切到「实际归属」', Boolean(hostDimBtn) && text(hostDimBtn).includes('实际归属'))
hostDimBtn.props.onClick()
update(p1)
await tick()
await tick()
update(p1)
const hostWsTable = findAll(p1.tree, (item) => item.props && item.props['data-table'] === 'workspaces')[0]
check('切到实际归属后表里是 host_workspace_id 的行（实际归属工作区）',
  Boolean(hostWsTable) && text(hostWsTable).includes('实际归属工作区'),
  hostWsTable ? text(hostWsTable).replace(/\s+/g, ' ').slice(0, 160) : 'no table')
check('切维度后口径行也变成 host_workspace_id',
  text(p1.tree).replace(/\s+/g, ' ').includes('host_workspace_id'))
findAll(p1.tree, (item) => item.props && item.props['data-dim'] === 'target')[0].props.onClick()
update(p1)
await tick()
await tick()
update(p1)

const batchTable = findAll(p1.tree, (item) => item.props && item.props['data-table'] === 'batches')[0]
check('批次表存在且给出 done/total 进度', Boolean(batchTable) && text(batchTable).includes('3/5'),
  batchTable ? text(batchTable).replace(/\s+/g, ' ').slice(0, 160) : 'no table')
check('批次表头含「待处理」与「批次墙钟」',
  Boolean(batchTable) && ['待处理', '批次墙钟'].every((label) => text(batchTable).includes(label)),
  batchTable ? text(batchTable).replace(/\s+/g, ' ').slice(0, 200) : 'no table')
check('批次行的待处理数 = 失败 + 阻塞 + 中断（本例 1）',
  Boolean(batchTable) && /批次甲\s*3\/5\s*1\s*1/.test(text(batchTable).replace(/\s+/g, ' ')),
  batchTable ? text(batchTable).replace(/\s+/g, ' ').slice(0, 200) : 'no table')
const sessionTable = findAll(p1.tree, (item) => item.props && item.props['data-table'] === 'sessions')[0]
check('主会话表存在且按 parent_session_id 聚合', Boolean(sessionTable) && text(sessionTable).includes('session-lead'),
  sessionTable ? text(sessionTable).replace(/\s+/g, ' ').slice(0, 160) : 'no table')

/* 状态与退休原因：横向条形，不是九色 donut */
check('状态分布用横向条形（.dsh-sa-dist），不是 donut',
  findAll(p1.tree, (item) => hasClass(item, 'dsh-sa-dist')).length >= 6,
  String(findAll(p1.tree, (item) => hasClass(item, 'dsh-sa-dist')).length))
check('条形上写着状态名与数量（颜色之外有文字）',
  breakdownText().includes('已完成') && breakdownText().includes('失败'),
  breakdownText().slice(0, 200))
check('退休原因用稳定代码翻成人话（条数上限 / 超过保留期）',
  breakdownText().includes('条数上限') && breakdownText().includes('超过保留期'),
  breakdownText().slice(0, 240))
check('退休原因不显示机器键', !breakdownText().includes('cap-count') && !breakdownText().includes('cap-days'))

/* ── 下钻：点行 → 回总览 + 已筛选提示 + 清除 ── */
const targetRow2 = findAll(p1.tree, (item) => item.props && item.props['data-drill'] === 'true'
  && text(item).includes('主工作区'))[0]
check('工作区行可点下钻（data-drill）', Boolean(targetRow2))
targetRow2.props.onClick({ type: 'click', preventDefault() {} })
update(p1)
const drillText = () => text(p1.tree).replace(/\s+/g, ' ')
check('下钻后回到总览（默认视图分段被点亮）',
  Boolean(tabOf(p1, 'overview')) && tabOf(p1, 'overview').props['aria-selected'] === true,
  String(tabOf(p1, 'overview') && tabOf(p1, 'overview').props['aria-selected']))
check('顶部出现「已筛选 工作区（派发目标）：主工作区」',
  drillText().includes('已筛选') && drillText().includes('工作区（派发目标）：主工作区'),
  drillText().slice(0, 200))
check('下钻后总览只剩该工作区的任务（t-run-1 在，t-run-2 不在）',
  drillText().includes('t-run-1') && !drillText().includes('t-run-2'),
  drillText().slice(0, 240))
const clearBtn = buttonsOf(p1.tree).find((item) => text(item).includes('清除'))
check('有「清除」按钮', Boolean(clearBtn))
clearBtn.props.onClick()
update(p1)
check('清除后过滤消失（顶部没有「已筛选」，ws-2 的任务回来）',
  !text(p1.tree).replace(/\s+/g, ' ').includes('已筛选') && text(p1.tree).includes('t-run-2'),
  text(p1.tree).replace(/\s+/g, ' ').slice(0, 200))

/* 批次 / 主会话 / 状态下钻：只筛总览列表，并说明 stats 不接受这些参数 */
tabOf(p1, 'breakdown').props.onClick()
update(p1)
await tick()
await tick()
update(p1)
const batchRow = findAll(p1.tree, (item) => item.props && item.props['data-drill'] === 'true'
  && text(item).includes('批次甲'))[0]
check('批次行可点下钻', Boolean(batchRow))
batchRow.props.onClick({ type: 'click', preventDefault() {} })
update(p1)
check('批次下钻后提示条说明只作用于总览列表',
  text(p1.tree).replace(/\s+/g, ' ').includes('只作用于总览列表'),
  text(p1.tree).replace(/\s+/g, ' ').slice(0, 240))
check('批次下钻把筛选写成「批次：批次甲」',
  text(p1.tree).replace(/\s+/g, ' ').includes('批次：批次甲'))
buttonsOf(p1.tree).find((item) => text(item).includes('清除')).props.onClick()
update(p1)

/* ── n=0：显示 — 而不是 0 ── */
statsResponse = emptyStatsFixture()
tabOf(p1, 'effect').props.onClick()
update(p1)
await tick()
await tick()
update(p1)
const emptyScope = () => (findAll(p1.tree, (item) => item.props && item.props['data-scope'] === 'true')[0] || { props: {} })
const emptyScopeText = text(emptyScope()).replace(/\s+/g, ' ')
check('n=0 时样本口径行显示 — 而不是 0',
  emptyScopeText.includes('窗口内结算 n=—') && emptyScopeText.includes('有效耗时 n=—'), emptyScopeText)
check('n=0 时完成率显示 — 而不是 0%', cardText('rate') === '完成率 —' || cardText('rate').includes('—'), cardText('rate'))
check('n=0 时并行倍数显示 —（不是 0.00×）', cardText('factor').includes('—'), cardText('factor'))
check('n=0 时趋势区说明「还没有可统计的事实」而不是画一条 0',
  text(p1.tree).replace(/\s+/g, ' ').includes('窗口内还没有按天可统计的事实'),
  text(p1.tree).replace(/\s+/g, ' ').slice(0, 200))

/* ── 样本少：1 ≤ n < 5 显示数值但标「样本少」 ── */
const lowStats = emptyStatsFixture()
lowStats.coverage = Object.assign({}, lowStats.coverage, { settled: 3, validDurations: 3, missingTimes: 0 })
lowStats.summary.outcome = Object.assign({}, lowStats.summary.outcome, {
  settled: 3, completionBase: 3, done: 2, failed: 1, completionRate: 0.6667, sampleLow: true,
})
statsResponse = lowStats
findAll(p1.tree, (item) => item.props && item.props['data-window'] === '24h')[0].props.onClick()
update(p1)
await tick()
await tick()
update(p1)
const lowScopeText = text(findAll(p1.tree, (item) => item.props && item.props['data-scope'] === 'true')[0]).replace(/\s+/g, ' ')
check('1≤n<5 时数值照常显示（n=3）', lowScopeText.includes('n=3'), lowScopeText)
check('1≤n<5 时标出「样本少」', lowScopeText.includes('样本少'), lowScopeText)
check('1≤n<5 时完成率仍给数值（66.7%），只是带标记', cardText('rate').includes('66.7%'), cardText('rate'))

/* ── timeBasis 回退必须可见 ── */
statsResponse = fallbackStatsFixture()
findAll(p1.tree, (item) => item.props && item.props['data-window'] === '30d')[0].props.onClick()
update(p1)
await tick()
await tick()
update(p1)
const fallbackScopeText = text(findAll(p1.tree, (item) => item.props && item.props['data-scope'] === 'true')[0]).replace(/\s+/g, ' ')
check('timeBasis 是 updatedAt-fallback 时样本行里可见',
  fallbackScopeText.includes('时间基准') && fallbackScopeText.includes('最后更新'),
  fallbackScopeText)

/* ── stats 404：降级回总览且不抛错 ── */
/*
 * 这是**活宿主上最可能发生的真实情形**：宿主进程已经加载了旧的 host 侧代码，
 * `GET /board/stats` 根本没注册，于是 404。这时看板必须：
 * - 不白屏、不抛错；
 * - 分析视图给出「统计暂不可用」+ 原因 + 重试 + 回总览；
 * - **总览照常**按 /board 快照工作（三个分段、任务行都还在）。
 */
statsMode = '404'
statsResponse = null
// 重新挂一个面板，确保 stats 状态从 idle 开始（旧实例里还留着上一次成功的数据）。
const p404 = mount(panelReg.component)
await tick()
await tick()
update(p404)
const tab404 = (id) => findAll(p404.tree, (item) => item && item.props && item.props['data-view-tab'] === id)[0]
tab404('effect').props.onClick()
update(p404)
await tick()
await tick()
update(p404)
const notFoundText = text(p404.tree).replace(/\s+/g, ' ')
check('stats 404 时效果视图给出「统计暂不可用」', notFoundText.includes('统计暂不可用'), notFoundText.slice(0, 200))
check('stats 404 时说明总览不受影响', notFoundText.includes('总览不受影响'), notFoundText.slice(0, 240))
check('stats 404 时有明确状态码（HTTP 404）', notFoundText.includes('404'), notFoundText.slice(0, 200))
check('stats 404 时给「重试统计」按钮', buttonsOf(p404.tree).some((item) => text(item).includes('重试统计')))
check('stats 404 时不白屏（视图分段仍在，可切回总览）', Boolean(tab404('overview')))
tab404('overview').props.onClick()
update(p404)
const overviewAfter404 = text(p404.tree).replace(/\s+/g, ' ')
check('stats 404 后切回总览仍然按快照工作（三段结构在）',
  ['需要你处理', '在跑与排队', '最近完成'].every((label) => overviewAfter404.includes(label)),
  overviewAfter404.slice(0, 200))
check('stats 404 不影响总览的任务行', overviewAfter404.includes('t-run-1'))
const requestsBeforeIdle = statsRequests().length
update(p404)
check('stats 404 不会在总览里反复重取（不进入报错循环）',
  statsRequests().length === requestsBeforeIdle, `${requestsBeforeIdle} → ${statsRequests().length}`)

/* ── stats degraded（Host 聚合抛错但返回 200）也要降级 ── */
statsMode = 'degraded'
const pDeg = mount(panelReg.component)
await tick()
await tick()
update(pDeg)
findAll(pDeg.tree, (item) => item && item.props && item.props['data-view-tab'] === 'breakdown')[0].props.onClick()
update(pDeg)
await tick()
await tick()
update(pDeg)
const degradedText = text(pDeg.tree).replace(/\s+/g, ' ')
check('Host 降级（degraded:true）时拆解视图也说不可用', degradedText.includes('统计暂不可用'), degradedText.slice(0, 200))
check('降级时把 Host 给的原因显示出来', degradedText.includes('聚合失败：ledger 损坏'), degradedText.slice(0, 240))
check('降级时页面没崩（视图分段仍在）', Boolean(findAll(pDeg.tree, (item) => item && item.props && item.props['data-view-tab'] === 'overview')[0]))
statsMode = 'ok'
statsResponse = statsFixture()

unmount(p404)
unmount(pDeg)
unmount(p1)
boardResponse = boardFixture()

/* ═════════════════════ plans/09 P2：历史视图 + 任务详情抽屉 ═════════════════════ */

console.log('\n历史视图')

/*
 * 这一段的三条证据链：
 * 1. **不依赖 stats**：整段把 `statsMode` 设成 `'404'`（= 活宿主上最常见的真实
 *    情形：宿主进程还是旧代码）。历史视图这时必须照常渲染，否则「查证据」的
 *    地方会跟着统计一起失效（§八.10）。
 * 2. **表格 + 分页**：断言 `data-table="history"`、页码文字与翻页按钮的真实可用性。
 * 3. **退休行不可打开**：只有复制 id 的按钮，没有「打开子会话」，`openSession` 计数为 0。
 */
statsMode = '404'
statsResponse = null
boardResponse = historyFixture()
retiredResponse = historyRetiredFixture()
retiredMode = 'ok'

const h1 = mount(panelReg.component)
await tick()
await tick()
update(h1)
const hTab = (id) => findAll(h1.tree, (item) => item && item.props && item.props['data-view-tab'] === id)[0]
check('第四个视图分段是「历史」', Boolean(hTab('history')) && text(hTab('history')).includes('历史'),
  hTab('history') ? text(hTab('history')) : 'missing')
hTab('history').props.onClick()
update(h1)
await tick()
await tick()
update(h1)

const histText = () => {
  const view = findAll(h1.tree, (item) => item.props && item.props['data-view'] === 'history')[0]
  return view ? text(view).replace(/\s+/g, ' ') : ''
}
const histRows = () => findAll(h1.tree, (item) => item.props && typeof item.props['data-history-row'] === 'string')
const histSubBtns = () => findAll(h1.tree, (item) => item.props && typeof item.props['data-hist-sub'] === 'string')
const histField = (id) => findAll(h1.tree, (item) => item.props && item.props['data-hist-field'] === id)[0]
const histRowIds = () => histRows().map((row) => row.props['data-history-row'])

check('历史视图渲染（data-view=history）',
  findAll(h1.tree, (item) => item.props && item.props['data-view'] === 'history').length === 1)
check('stats 404 时历史视图仍能工作（不降级、不白屏）',
  Boolean(findAll(h1.tree, (item) => item.props && item.props['data-table'] === 'history')[0]),
  histText().slice(0, 200))

/* ── 三个子视图：全部 / 已归档 / 已退休 ── */
check('历史子视图三个都在（全部 / 已归档 / 已退休）',
  ['all', 'archived', 'retired'].every((id) => histSubBtns().some((item) => item.props['data-hist-sub'] === id)),
  JSON.stringify(histSubBtns().map((item) => item.props['data-hist-sub'])))
check('子视图文字是 全部 / 已归档 / 已退休',
  histSubBtns().map((item) => text(item).trim()).join('|') === '全部|已归档|已退休',
  JSON.stringify(histSubBtns().map((item) => text(item).trim())))
check('默认停在「全部」子视图',
  histSubBtns().some((item) => item.props['data-hist-sub'] === 'all' && item.props['aria-selected'] === true))
check('「全部」子视图列出快照里的全部任务（含已归档 3 条）',
  histRows().length === 3, JSON.stringify(histRowIds()))

const subBtn = (id) => histSubBtns().find((item) => item.props['data-hist-sub'] === id)
subBtn('archived').props.onClick()
update(h1)
check('「已归档」子视图只剩 archived_at 非空的行',
  histRows().length === 1 && histRowIds()[0] === 't-hist-c', JSON.stringify(histRowIds()))
subBtn('retired').props.onClick()
update(h1)
await tick()
await tick()
update(h1)
check('「已退休」子视图走 /board/retired 并渲染留痕行',
  histRows().length === 1 && histRowIds()[0] === 't-hist-ret', JSON.stringify(histRowIds()))
/*
 * 退休原因的「人话」证据放在两个地方，缺一不可：
 * - 行内 `title`（hover）与抽屉里保留完整原因；
 * - 机器键（cap-count）从不直接出现在表格文字里。
 * 表格那一列现在只写「退休 5 小时前」，原因收进 hover —— 面板宽度不够时，
 * 一列里塞「时间 + 原因」会把整张表挤到需要横向滚动。
 */
const retiredReasonLabelOk = (() => {
  const row = histRows()[0]
  if (!row) return false
  const retireCell = findAll(row, (item) => item.props && item.props.className === 'dsh-sa-hist-end')[0]
  return Boolean(retireCell) && typeof retireCell.props.title === 'string' && retireCell.props.title.includes('条数上限')
})()
check('退休原因翻成人话放在 hover 里（不显示机器键）', retiredReasonLabelOk,
  histRows().length ? JSON.stringify(histRows()[0].props.title) : 'no row')
check('退休行标明退休时刻与原因（不显示机器键）',
  // 表里这一列现在叫「结束」，内容是「退休 5 小时前」；退休原因在 hover 与抽屉里
  // 仍然完整可读，且始终翻成人话（不含 cap-count 这种机器键）。
  histText().includes('退休 5 小时前')
    && !histText().includes('cap-count')
    && retiredReasonLabelOk,
  histText().slice(0, 240))
check('退休行没有「可打开的子会话」（没有 openSession 按钮）',
  findAll(h1.tree, (item) => item.props && item.props['data-drawer-open']).length === 0
    && buttonsOf(histRows()[0]).every((item) => !text(item).includes('打开子会话')),
  JSON.stringify(buttonsOf(histRows()[0] || {}).map((item) => text(item))))
check('退休行给出「复制 id」按钮',
  buttonsOf(histRows()[0]).some((item) => text(item).includes('复制')),
  JSON.stringify(buttonsOf(histRows()[0] || {}).map((item) => text(item))))
const openedBeforeRetiredCopy = opened.length
buttonsOf(histRows()[0]).find((item) => text(item).includes('复制')).props.onClick({ stopPropagation() {} })
await tick()
update(h1)
check('点退休行的复制按钮只复制 id，不去打开子会话',
  opened.length === openedBeforeRetiredCopy && text(h1.tree).includes('t-hist-ret'),
  `openSession ${openedBeforeRetiredCopy} → ${opened.length}`)
subBtn('all').props.onClick()
update(h1)

/* ── 搜索：task_id / 标题 / worker_session_id / 工作区 ── */
const searchBox = () => findAll(h1.tree, (item) => item.props && item.props['data-hist-search'] === 'true')[0]
check('历史视图有搜索框', Boolean(searchBox()))
const typeSearch = (value) => {
  searchBox().props.onChange({ target: { value } })
  update(h1)
}
typeSearch('t-hist-b')
check('搜索能按 task_id 命中（只剩 1 行）',
  histRowIds().length === 1 && histRowIds()[0] === 't-hist-b', JSON.stringify(histRowIds()))
typeSearch('已归档的历史记录')
check('搜索能按标题命中',
  histRowIds().length === 1 && histRowIds()[0] === 't-hist-c', JSON.stringify(histRowIds()))
typeSearch('dispatch-t-hist-a')
check('搜索能按 worker_session_id 命中',
  histRowIds().length === 1 && histRowIds()[0] === 't-hist-a', JSON.stringify(histRowIds()))
typeSearch('副工作区')
check('搜索能按工作区命中（标题与 id 都算）',
  histRowIds().length === 1 && histRowIds()[0] === 't-hist-b', JSON.stringify(histRowIds()))
typeSearch('根本不存在的东西')
check('搜不到时给空态而不是空表', histText().includes('这个筛选下没有任务'), histText().slice(0, 160))
typeSearch('')

/* ── 筛选：状态 / 工作区 / 是否重试 / 是否有后台 ── */
check('历史视图有状态、工作区、时间、排序四个下拉',
  ['status', 'workspace', 'time', 'sort'].every((id) => Boolean(histField(id))),
  JSON.stringify(['status', 'workspace', 'time', 'sort'].map((id) => Boolean(histField(id)))))
histField('status').props.onChange({ target: { value: 'failed' } })
update(h1)
check('状态筛选生效（只剩 failed）',
  histRowIds().length === 1 && histRowIds()[0] === 't-hist-b', JSON.stringify(histRowIds()))
histField('status').props.onChange({ target: { value: '' } })
update(h1)
histField('workspace').props.onChange({ target: { value: 'ws-1' } })
update(h1)
check('工作区筛选按派发目标过滤（ws-1 两条）',
  histRowIds().length === 2 && histRowIds().every((id) => id !== 't-hist-b'), JSON.stringify(histRowIds()))
histField('workspace').props.onChange({ target: { value: '' } })
update(h1)
const histToggle = (id) => findAll(h1.tree, (item) => item.props && item.props['data-hist-toggle'] === id)[0]
check('有「是否重试」与「是否有后台」两个开关',
  Boolean(histToggle('retried')) && Boolean(histToggle('background')))
histToggle('retried').props.onClick()
update(h1)
check('「是否重试」筛出 attempt > 1 的行',
  histRowIds().length === 1 && histRowIds()[0] === 't-hist-a', JSON.stringify(histRowIds()))
histToggle('retried').props.onClick()
update(h1)
histToggle('background').props.onClick()
update(h1)
check('「是否有后台」筛出 background 非空的行',
  histRowIds().length === 1 && histRowIds()[0] === 't-hist-a', JSON.stringify(histRowIds()))
histToggle('background').props.onClick()
update(h1)

/* ── 排序：创建 / 结算 / 耗时 / 状态 ── */
check('排序下拉有四档（创建 / 结算 / 耗时 / 状态）',
  ['created', 'settled', 'elapsed', 'status'].every((id) => Boolean(histField('sort')))
    && findAll(histField('sort'), (item) => item.type === 'option').length === 4,
  String(findAll(histField('sort'), (item) => item.type === 'option').length))
const sortRows = (key) => {
  histField('sort').props.onChange({ target: { value: key } })
  update(h1)
  return histRowIds()
}
const byCreated = sortRows('created')
check('按创建时间排序：最新在前（t-hist-a 10h → t-hist-b 40h → t-hist-c 200h）',
  byCreated.join(',') === 't-hist-a,t-hist-b,t-hist-c', JSON.stringify(byCreated))
const byElapsed = sortRows('elapsed')
check('按耗时排序：最长在前（1800000 > 60000 > 30000）',
  byElapsed.join(',') === 't-hist-a,t-hist-b,t-hist-c', JSON.stringify(byElapsed))
check('按结算时间排序时缺 settled_at 的行排到末尾（不当成 1970 年）',
  (() => {
    const rows = sortRows('settled')
    // 只有 t-hist-a 有 settled_at；其余两行没有结算时刻，必须排在它后面。
    return rows[0] === 't-hist-a' && rows.length === 3
  })(), JSON.stringify(sortRows('settled')))
const byStatus = sortRows('status')
check('按状态排序时认不出的状态排最后、且顺序稳定',
  byStatus.length === 3 && byStatus[0] === 't-hist-a', JSON.stringify(byStatus))
histField('sort').props.onChange({ target: { value: 'created' } })
update(h1)

/* ── 分页 / 分段：每页 50 条 ── */
check('分页条显示「第 1–3 / 共 3 条」',
  histText().includes('第 1–3 / 共 3 条'), histText().slice(0, 200))
const pageBtn = (dir) => findAll(h1.tree, (item) => item.props && item.props['data-hist-page'] === dir)[0]
check('首页的「上一页」是禁用的', Boolean(pageBtn('prev')) && pageBtn('prev').props.disabled === true)
check('只有一页时「下一页」也是禁用的', Boolean(pageBtn('next')) && pageBtn('next').props.disabled === true)
/*
 * 分页真的翻得动：造 60 条任务，第一页 50 条、第二页 10 条。
 * 不用 100 条那种「刚好两页」的边界——50/10 能同时验证「每页 50」与
 * 「末页不足一页时也只显示剩余条数」。
 *
 * 必须**重挂面板**才能让新 fixture 生效：快照轮询只在挂载时与 `generation`
 * 变化时跑一次，直接改 `boardResponse` 不会让已经挂着的面板知道数据变了。
 */
const manyTasks = []
for (let i = 0; i < 60; i += 1) {
  manyTasks.push({
    task_id: 't-page-' + String(i).padStart(2, '0'),
    title: '分页任务 ' + i,
    status: 'done',
    attempt: 1,
    workspace_id: 'ws-1',
    workspace_title: '主工作区',
    worker_session_id: 'dispatch-t-page-' + i,
    created_at: hoursAgo(i + 1),
    updated_at: hoursAgo(i + 1),
    settled_at: hoursAgo(i + 1),
    time_basis: 'settledAt',
    elapsed_ms: 1000 * (i + 1),
    report_count: 0,
  })
}
boardResponse = Object.assign(historyFixture(), { tasks: manyTasks })
boardResponse.counts = Object.assign({}, boardResponse.counts, { total: 60, done: 60, failed: 0, cancelled: 0, archived: 0 })
const hP = mount(panelReg.component)
await tick()
await tick()
update(hP)
findAll(hP.tree, (item) => item && item.props && item.props['data-view-tab'] === 'history')[0].props.onClick()
update(hP)
await tick()
await tick()
update(hP)
const pRows = () => findAll(hP.tree, (item) => item.props && typeof item.props['data-history-row'] === 'string')
const pText = () => {
  const view = findAll(hP.tree, (item) => item.props && item.props['data-view'] === 'history')[0]
  return view ? text(view).replace(/\s+/g, ' ') : ''
}
const pBtn = (dir) => findAll(hP.tree, (item) => item.props && item.props['data-hist-page'] === dir)[0]
check('60 条时第一页只渲染 50 行（分页而不是无限长列表）',
  pRows().length === 50, `实际 ${pRows().length}`)
check('分页条改成「第 1–50 / 共 60 条」', pText().includes('第 1–50 / 共 60 条'), pText().slice(0, 200))
check('有下一页时「下一页」可用', pBtn('next').props.disabled === false)
pBtn('next').props.onClick()
update(hP)
check('翻到第二页只剩 10 行', pRows().length === 10, `实际 ${pRows().length}`)
check('第二页分页条是「第 51–60 / 共 60 条」', pText().includes('第 51–60 / 共 60 条'), pText().slice(0, 200))
check('末页的「下一页」重新禁用', pBtn('next').props.disabled === true)
pBtn('prev').props.onClick()
update(hP)
check('能翻回第一页', pRows().length === 50 && pText().includes('第 1–50 / 共 60 条'), pText().slice(0, 160))
unmount(hP)

/* ── 详情抽屉：生命周期与七块 ── */
boardResponse = historyFixture()
/*
 * 重挂面板：上面分页那段把 `boardResponse` 换成了 60 条任务，而快照只在
 * 挂载时 / `generation` 变化时取一次。不重挂的话，这一段会拿 60 条任务去断言
 * 抽屉内容，失败原因看起来像「抽屉坏了」，其实是数据换了。
 */
unmount(h1)
const h2 = mount(panelReg.component)
await tick()
await tick()
update(h2)
const hTab2 = (id) => findAll(h2.tree, (item) => item && item.props && item.props['data-view-tab'] === id)[0]
hTab2('history').props.onClick()
update(h2)
await tick()
await tick()
update(h2)
const histText2 = () => {
  const view = findAll(h2.tree, (item) => item.props && item.props['data-view'] === 'history')[0]
  return view ? text(view).replace(/\s+/g, ' ') : ''
}
const rowOf = (id) => findAll(h2.tree, (item) => item.props && item.props['data-history-row'] === id)[0]
check('点历史行打开详情抽屉（data-drawer）',
  (() => {
    const row = rowOf('t-hist-a')
    if (!row) return false
    row.props.onClick({ type: 'click', preventDefault() {} })
    update(h2)
    return Boolean(findAll(h2.tree, (item) => item.props && item.props['data-drawer'] === 't-hist-a')[0])
  })(),
  histText2().slice(0, 200))
const drawerText = () => {
  const drawer = findAll(h2.tree, (item) => item.props && typeof item.props['data-drawer'] === 'string')[0]
  return drawer ? text(drawer).replace(/\s+/g, ' ') : ''
}
check('抽屉七块齐全（生命周期 / 简报与目录 / 报告 / 重试与错误 / 追问 / 后台 / prepare）',
  ['lifecycle', 'scope', 'reports', 'faults', 'delivery', 'background', 'prepare'].every((id) =>
    findAll(h2.tree, (item) => item.props && item.props['data-drawer-block'] === id).length === 1),
  JSON.stringify(findAll(h2.tree, (item) => item.props && item.props['data-drawer-block']).map((item) => item.props['data-drawer-block'])))
check('生命周期六个时刻都渲染（创建 / 开始 / 报告 / 结算 / 归档 / 退休）',
  ['created', 'started', 'reported', 'settled', 'archived', 'retired'].every((id) =>
    findAll(h2.tree, (item) => item.props && item.props['data-step'] === id).length === 1),
  JSON.stringify(findAll(h2.tree, (item) => item.props && typeof item.props['data-step'] === 'string').map((item) => item.props['data-step'])))
check('缺失的生命周期步骤写「没有记录」而不是留空（这条任务没有归档/退休）',
  findAll(h2.tree, (item) => item.props && item.props['data-step'] === 'retired'
    && item.props['data-step-known'] === 'false').length === 1
    && drawerText().includes('没有记录'),
  drawerText().slice(0, 240))
check('抽屉里写明「完整简报请用 dispatch_inspect <id>」',
  drawerText().includes('dispatch_inspect t-hist-a') && drawerText().includes('完整简报'),
  drawerText().slice(0, 300))
check('抽屉给出目标工作区与目录（cwd / 任务目录）',
  drawerText().includes('C:/w1') && drawerText().includes('audit-hist-a'),
  drawerText().slice(0, 300))
check('抽屉给出报告数与最后一次报告',
  drawerText().includes('报告数') && drawerText().includes('抽屉六块都渲染了'),
  drawerText().slice(0, 300))
check('抽屉给出 attempt / 错误 / 归档失败三块的标签',
  ['第几次', '错误', '归档失败'].every((label) => drawerText().includes(label)),
  drawerText().slice(0, 300))
check('抽屉给出追问投递状态', drawerText().includes('追问投递'), drawerText().slice(0, 300))
check('抽屉给出后台 job / subagent 数量',
  drawerText().includes('shell job') && drawerText().includes('subagent'), drawerText().slice(0, 300))
check('抽屉给出 prepare 结果', drawerText().includes('准备时刻'), drawerText().slice(0, 300))
check('有活会话时抽屉给「打开子会话」按钮',
  Boolean(findAll(h2.tree, (item) => item.props && item.props['data-drawer-open'] === 't-hist-a')[0]))
const openedBeforeDrawer = opened.length
findAll(h2.tree, (item) => item.props && item.props['data-drawer-open'] === 't-hist-a')[0].props.onClick()
await tick()
check('抽屉的「打开子会话」真的调用 openSession',
  opened.length === openedBeforeDrawer + 1 && opened[opened.length - 1] === 'dispatch-t-hist-a',
  `${openedBeforeDrawer} → ${opened.length} ${JSON.stringify(opened.slice(-1))}`)
findAll(h2.tree, (item) => item.props && item.props['data-drawer-close'] === 'true')[0].props.onClick()
update(h2)
check('抽屉能关闭', !findAll(h2.tree, (item) => item.props && typeof item.props['data-drawer'] === 'string')[0])

/* 归档行：能开抽屉，但抽屉里不给「打开子会话」（归档会被宿主清成空白主视图）。 */
const openedBeforeArchived = opened.length
rowOf('t-hist-c').props.onClick({ type: 'click', preventDefault() {} })
update(h2)
check('归档行仍能在抽屉里查留痕',
  Boolean(findAll(h2.tree, (item) => item.props && item.props['data-drawer'] === 't-hist-c')[0]))
check('归档行的抽屉不给「打开子会话」，只给复制 id',
  !findAll(h2.tree, (item) => item.props && item.props['data-drawer-open'])[0]
    && Boolean(findAll(h2.tree, (item) => item.props && item.props['data-drawer-copy'] === 't-hist-c')[0]),
  JSON.stringify(buttonsOf(findAll(h2.tree, (item) => item.props && item.props['data-drawer'])[0] || {}).map((item) => text(item))))
check('归档行抽屉里说明「没有可打开的子会话」的原因', drawerText().includes('没有可打开的子会话'), drawerText().slice(0, 240))
check('从归档行抽屉里点复制也不会打开子会话',
  (() => {
    findAll(h2.tree, (item) => item.props && item.props['data-drawer-copy'] === 't-hist-c')[0].props.onClick()
    return opened.length === openedBeforeArchived
  })(), `openSession ${openedBeforeArchived} → ${opened.length}`)

/* 退休行：只有留痕，抽屉里明确说报告正文不可用。 */
const subBtn2 = (id) => findAll(h2.tree, (item) => item.props && item.props['data-hist-sub'] === id)[0]
subBtn2('retired').props.onClick()
update(h2)
await tick()
await tick()
update(h2)
findAll(h2.tree, (item) => item.props && item.props['data-history-row'] === 't-hist-ret')[0]
  .props.onClick({ type: 'click', preventDefault() {} })
update(h2)
check('退休行的抽屉说「已退休：报告正文不可用」',
  drawerText().includes('已退休') && drawerText().includes('报告正文不可用'), drawerText().slice(0, 300))
check('退休行抽屉里没有「打开子会话」，只有复制 id',
  !findAll(h2.tree, (item) => item.props && item.props['data-drawer-open'])[0]
    && Boolean(findAll(h2.tree, (item) => item.props && item.props['data-drawer-copy'] === 't-hist-ret')[0]))
check('退休行抽屉里保留最后一条摘要（唯一的正文残留）',
  drawerText().includes('被移出账本前的最后一条摘要'), drawerText().slice(0, 300))
subBtn2('all').props.onClick()
update(h2)

/* ── 清除筛选 ── */
const searchBox2 = () => findAll(h2.tree, (item) => item.props && item.props['data-hist-search'] === 'true')[0]
const typeSearch2 = (value) => {
  searchBox2().props.onChange({ target: { value } })
  update(h2)
}
typeSearch2('t-hist-b')
findAll(h2.tree, (item) => item.props && item.props['data-hist-field'] === 'status')[0]
  .props.onChange({ target: { value: 'failed' } })
update(h2)
check('清除按钮存在', Boolean(findAll(h2.tree, (item) => item.props && item.props['data-hist-clear'] === 'true')[0]))
findAll(h2.tree, (item) => item.props && item.props['data-hist-clear'] === 'true')[0].props.onClick()
update(h2)
check('清除后搜索与筛选都归零（三行全回来）',
  findAll(h2.tree, (item) => item.props && typeof item.props['data-history-row'] === 'string').length === 3
    && searchBox2().props.value === '',
  histText2().slice(0, 200))
unmount(h2)
statsMode = 'ok'
statsResponse = statsFixture()
boardResponse = boardFixture()
retiredResponse = { ok: true, count: 0, dropped: 0, entries: [] }

/* ═════════════════════ 行内「归档」按钮（终态任务的逃生门） ═════════════════════ */

/*
 * 用户在看板上报的原话：「已经中断的任务应该加取消或者归档按钮，要不然只有重试
 * 会一直卡着」。服务端侧 `cancel()` 对 `SETTLED` 直接抛（终态**没有**取消入口），
 * 唯一出路 `archiveStale()` 又是全量巡检、只处理过期的——所以纯服务端修不了这个
 * 交互，必须有一个「点这一条就收走」的按钮。
 *
 * 这一段钉四件事：
 * 1. 终态行**同时**有「重试」和「归档」，`running` 行**没有**归档（不能冻活会话）；
 * 2. 两步确认：第一次点击不发请求，第二次才发，且打到 `/archive-task`；
 * 3. `done` 行没有主操作但有归档——它是「只有重试」之外的另一类终态；
 * 4. 决策 B：宿主回 `reason` 时提示条用警告语气、并把原因说出来。
 */
console.log('\n行内归档按钮')

boardResponse = boardFixture()
const arcBtnPanel = mount(panelReg.component)
await tick()
await tick()
update(arcBtnPanel)

const arcRowOf = (tree, title) => findAll(tree, (item) => hasClass(item, 'dsh-sa-row') && text(item).includes(title))[0]
const labelsOf = (row) => buttonsOf(row).map((item) => text(item).trim())

const stalledRow = arcRowOf(arcBtnPanel.tree, '失败任务')
check('终态行同时给出「重试」与「归档」两个按钮',
  Boolean(stalledRow) && labelsOf(stalledRow).some((label) => label.includes('重试'))
    && labelsOf(stalledRow).some((label) => label === '归档'),
  stalledRow ? JSON.stringify(labelsOf(stalledRow)) : 'row missing')

const runningRow = arcRowOf(arcBtnPanel.tree, '单跑任务')
check('running 行没有归档按钮（不许冻一个还在写的会话）',
  Boolean(runningRow) && !labelsOf(runningRow).some((label) => label === '归档')
    && labelsOf(runningRow).some((label) => label.includes('取消')),
  runningRow ? JSON.stringify(labelsOf(runningRow)) : 'row missing')

const doneRow = arcRowOf(arcBtnPanel.tree, '完成的任务')
check('done 行没有主操作但有归档（终态也能被收走）',
  Boolean(doneRow) && !labelsOf(doneRow).some((label) => label.includes('重试'))
    && labelsOf(doneRow).some((label) => label === '归档'),
  doneRow ? JSON.stringify(labelsOf(doneRow)) : 'row missing')

/* 两步确认：第一次点击只进确认态，**不发请求**。 */
const archivePosts = () => requests.filter((item) => item.method === 'POST' && item.url.endsWith('/archive-task'))
const beforeAsk = archivePosts().length
const archiveBtn = () => {
  const row = arcRowOf(arcBtnPanel.tree, '失败任务')
  return buttonsOf(row).find((item) => text(item).includes('归档'))
}
archiveBtn().props.onClick({ stopPropagation() {} })
update(arcBtnPanel)
check('第一次点归档只进确认态、不发请求',
  archivePosts().length === beforeAsk
    && labelsOf(arcRowOf(arcBtnPanel.tree, '失败任务')).some((label) => label.includes('再点一次确认归档')),
  JSON.stringify(labelsOf(arcRowOf(arcBtnPanel.tree, '失败任务'))))

/* 第二次点击才真的发，且打到单条路由。 */
postReply = { ok: true, archived: true }
archiveBtn().props.onClick({ stopPropagation() {} })
await tick()
await tick()
update(arcBtnPanel)
const archiveRequest = archivePosts().at(-1)
check('第二次点归档发到 /archive-task（不是 /archive 巡检）',
  archivePosts().length === beforeAsk + 1
    && archiveRequest && archiveRequest.url.endsWith('/board/archive-task')
    && !archiveRequest.url.endsWith('/board/archive'),
  archiveRequest ? archiveRequest.url : 'no request')
check('归档请求体带上 task_id',
  Boolean(archiveRequest) && JSON.parse(archiveRequest.body).task_id === 't-f-4',
  archiveRequest ? archiveRequest.body : '')
check('干净归档的提示条说「已归档」',
  text(arcBtnPanel.tree).includes('已归档（历史里仍可查到）'),
  text(arcBtnPanel.tree).slice(-260))

/* 决策 B：宿主回 reason 时要明说「归档了，但子会话没归档成功」。 */
postReply = { ok: true, archived: true, reason: '会话已不存在' }
// 归档成功后确认态会复位，所以这一轮仍然要点两次：第一次进确认态，第二次才发。
archiveBtn().props.onClick({ stopPropagation() {} })
update(arcBtnPanel)
archiveBtn().props.onClick({ stopPropagation() {} })
await tick()
await tick()
update(arcBtnPanel)
const keptText = text(arcBtnPanel.tree)
check('决策 B：归档留痕的提示条说出真实原因',
  keptText.includes('已归档，但子会话没归档成功') && keptText.includes('会话已不存在'),
  keptText.slice(-300))
unmount(arcBtnPanel)
postReply = { ok: true, target: null }

/* ═════════════════════ 行内「续派」按钮（plans/08 阶段 1 · 模型 A） ═════════════════════ */

/*
 * 续派的界面口径（与「归档」那一段同构，但判据不同）：
 *
 * 1. **只给已结算的行**。宿主侧 `POST /retry` + `message` 对未结算任务回 409
 *    （不能把要求插进正在跑的回合），所以 `running` 行不该出现这个按钮——
 *    按钮出现在必然失败的组合上比不出现更糟。
 * 2. **提交只打一条既有路由** `POST /retry`，body 带 `message`，**不新造路由**。
 * 3. 成功后任务状态会变回运行中；界面不弹「成功」提示条（状态本身就是结果），
 *    失败必须弹——用户写的那句话还在框里，不能悄悄吞掉。
 */
console.log('\n行内续派按钮')

boardResponse = boardFixture()
const contPanel = mount(panelReg.component)
await tick()
await tick()
update(contPanel)

const contRowOf = (title) => findAll(contPanel.tree,
  (item) => hasClass(item, 'dsh-sa-row') && text(item).includes(title))[0]
const contLabelsOf = (row) => buttonsOf(row).map((item) => text(item).trim())

const contDoneRow = contRowOf('完成的任务')
check('已结算行给出「续派」按钮',
  Boolean(contDoneRow) && contLabelsOf(contDoneRow).includes('续派'),
  contDoneRow ? JSON.stringify(contLabelsOf(contDoneRow)) : 'row missing')

const contRunningRow = contRowOf('单跑任务')
check('running 行没有「续派」按钮（未结算任务续派必被 409 拒）',
  Boolean(contRunningRow) && !contLabelsOf(contRunningRow).includes('续派'),
  contRunningRow ? JSON.stringify(contLabelsOf(contRunningRow)) : 'row missing')

/* 点一下展开输入框：此刻**不应**发任何请求（只是开输入）。 */
const retryPosts = () => requests.filter((item) => item.method === 'POST' && item.url.endsWith('/board/retry'))
const beforeContinue = retryPosts().length
const continueBtn = () => buttonsOf(contRowOf('完成的任务')).find((item) => text(item).includes('续派'))
continueBtn().props.onClick({ stopPropagation() {} })
update(contPanel)
check('点「续派」只展开输入框、不发请求',
  retryPosts().length === beforeContinue
    && Boolean(findAll(contPanel.tree, (item) => item.props && item.props['data-continue-input'] === 't-done-5')[0]),
  `posts ${beforeContinue} → ${retryPosts().length}`)

/* 输入内容 → 点发送 → 打到 /retry 且 body 带 message。 */
const contInput = () => findAll(contPanel.tree, (item) => item.props && item.props['data-continue-input'] === 't-done-5')[0]
const typed = '把 lint 也跑一遍'
contInput().props.onInput({ target: { value: typed }, stopPropagation() {} })
update(contPanel)
check('输入框回写草稿（面板持有，不落在展示组件里）',
  contInput().props.value === typed, JSON.stringify(contInput().props.value))

postReply = { ok: true, task: { task_id: 't-done-5', status: 'running' } }
findAll(contPanel.tree, (item) => item.props && item.props['data-continue-send'] === 't-done-5')[0]
  .props.onClick({ stopPropagation() {} })
await tick()
await tick()
update(contPanel)

const contRequest = retryPosts().at(-1)
check('续派打到既有路由 /retry（不新造路由）',
  retryPosts().length === beforeContinue + 1
    && Boolean(contRequest) && contRequest.url.endsWith('/board/retry'),
  contRequest ? contRequest.url : 'no request')
check('续派请求体带上 message（这就是「给同一任务补一句」）',
  Boolean(contRequest) && JSON.parse(contRequest.body).message === typed
    && JSON.parse(contRequest.body).task_id === 't-done-5',
  contRequest ? contRequest.body : '')

/* 失败路径：宿主 409 时必须把原因显示出来，且不静默清空草稿。 */
postReply = { ok: false, error: '任务还在 running，不能续派' }
continueBtn().props.onClick({ stopPropagation() {} })
update(contPanel)
findAll(contPanel.tree, (item) => item.props && item.props['data-continue-input'] === 't-done-5')[0]
  .props.onInput({ target: { value: '再补一句' }, stopPropagation() {} })
update(contPanel)
findAll(contPanel.tree, (item) => item.props && item.props['data-continue-send'] === 't-done-5')[0]
  .props.onClick({ stopPropagation() {} })
await tick()
await tick()
update(contPanel)
check('续派被拒时提示条带出原因（不静默吞掉用户写的话）',
  text(contPanel.tree).includes('不能续派'),
  text(contPanel.tree).slice(-280))
check('续派失败后输入框仍然开着、草稿还在',
  Boolean(findAll(contPanel.tree, (item) => item.props && item.props['data-continue-input'] === 't-done-5')[0]))
unmount(contPanel)
postReply = { ok: true, target: null }

/* ═════════════════════ 文案成对（zh/en） ═════════════════════ */

/*
 * 这个文件里的文案是 zh/en **成对硬编码**的，没有构建期抽取：新增一条只写中文的
 * 键，英文界面下会静默退回中文，而「英文界面里夹一句中文」通常没人报 bug。
 * 这里直接按源码文本数一遍：TEXT 与 TEXT_EN 的键集合必须完全一致。
 *
 * 用源码而不是运行时对象：`TEXT`/`TEXT_EN` 都在工厂作用域里，外面拿不到；
 * 而这两段的形状足够固定（缩进 6 空格 + `键:` 或 `'键':`），按行扫不会被误伤。
 */
function textKeys(block) {
  const keys = new Set()
  for (const line of block.split('\n')) {
    const match = /^\s{6}(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(line)
    if (match) keys.add(match[1] || match[2])
  }
  return keys
}
const zhStart = source.indexOf('const TEXT = {')
const enStart = source.indexOf('const TEXT_EN = {')
const zhBlock = source.slice(zhStart, enStart)
const enBlock = source.slice(enStart, source.indexOf('/** 当前翻译函数', enStart))
const zhKeys = textKeys(zhBlock)
const enKeys = textKeys(enBlock)
const missingEn = [...zhKeys].filter((key) => !enKeys.has(key))
const missingZh = [...enKeys].filter((key) => !zhKeys.has(key))
check('TEXT 与 TEXT_EN 的键集合完全一致（不留下只有中文的文案）',
  missingEn.length === 0 && missingZh.length === 0,
  `只有中文 ${missingEn.length} 条 ${JSON.stringify(missingEn.slice(0, 8))}；只有英文 ${missingZh.length} 条 ${JSON.stringify(missingZh.slice(0, 8))}`)
const p1Keys = [...zhKeys].filter((key) => /^(view|win|scope|eff|card|speed|st|trend|par|br|drill|stats|unit)\./.test(key))
check('plans/09 P1 新增的文案键数量合理（≥ 100 条，zh/en 各一份）',
  p1Keys.length >= 100, `实际 ${p1Keys.length} 条`)
check('每个 P1 文案键在源码里都出现两次（zh + en）',
  p1Keys.every((key) => {
    const pattern = new RegExp(`(['"]?)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*:`, 'g')
    return (source.match(pattern) || []).length === 2
  }),
  JSON.stringify(p1Keys.filter((key) => {
    const pattern = new RegExp(`(['"]?)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*:`, 'g')
    return (source.match(pattern) || []).length !== 2
  })))

/* ═════════════════════ 汇总 ═════════════════════ */

console.log('')
if (failures.length) {
  console.error(`失败 ${failures.length} 项，通过 ${passed} 项：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`全部通过：${passed} 项检查`)
console.log('提醒：以上只是离线渲染断言；布局、portal 定位、主题对比度、草稿 chip 恢复仍需真机目视。')
