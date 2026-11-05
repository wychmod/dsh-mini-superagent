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

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const flat = []
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child.flat(Infinity))
      else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
    }
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
const requests = []

globalThis.fetch = async (url, options) => {
  const method = (options && options.method) || 'GET'
  const body = options && options.body
  requests.push({ url, method, body })
  if (method === 'GET') {
    if (getMode === 'fail') return { ok: false, status: 500, async json() { return { ok: false, error: 'boom' } } }
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

function boardFixture() {
  return {
    version: '0.4.0',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 2, queued: 1, max: 6 },
    counts: { total: 9, running: 2, queued: 1, done: 3, blocked: 1, failed: 1, cancelled: 1, ended: 0, interrupted: 0, archived: 3 },
    workspaces: WORKSPACES,
    targets: { 'session-a': { workspace_id: 'ws-1', title: '主工作区', path: 'C:/w1' } },
    tasks: [
      { task_id: 't-run-1', title: '批次任务甲', status: 'running', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', group: 'g1', worker_session_id: 'dispatch-t-run-1', elapsed_ms: 12345, report_count: 1, last_report: { summary: '第一行摘要\n第二行不该出现' } },
      { task_id: 't-run-2', title: '单跑任务', status: 'running', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', group: null, worker_session_id: 'dispatch-t-run-2', elapsed_ms: 800, report_count: 0 },
      { task_id: 't-q-3', title: '批次任务乙', status: 'queued', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', group: 'g1', worker_session_id: 'dispatch-t-q-3', elapsed_ms: 0, report_count: 0 },
      { task_id: 't-f-4', title: '失败任务', status: 'failed', attempt: 2, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-f-4', elapsed_ms: 4000, report_count: 1, error: 'spawn 失败：ENOENT' },
      { task_id: 't-done-5', title: '完成的任务', status: 'done', attempt: 1, workspace_id: null, workspace_title: null, worker_session_id: 'dispatch-t-done-5', elapsed_ms: 65000, report_count: 1 },
      { task_id: 't-blocked-6', title: '阻塞任务', status: 'blocked', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-blocked-6', elapsed_ms: 1000, report_count: 0 },
      { task_id: 't-arc-1', title: '归档任务一', status: 'done', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-arc-1', archived_at: hoursAgo(2), elapsed_ms: 5000 },
      { task_id: 't-arc-2', title: '归档任务二', status: 'failed', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-arc-2', archived_at: hoursAgo(26), archive_error: '会话已不存在' },
      { task_id: 't-arc-3', title: '归档任务三', status: 'cancelled', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-arc-3', archived_at: new Date().toISOString() },
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
check('总计不含已归档', body.includes('总计 6'))

const chipFor = (label) => buttonsOf(panel.tree).find((item) => item.props['aria-pressed'] !== undefined && text(item).includes(label))
const chips = ['全部', '进行中', '需要处理', '已归档'].map((label) => {
  const chip = chipFor(label)
  return chip ? text(chip).replace(/\s+/g, ' ').trim() : ''
})
check('4 个过滤 chip 都在', chips.every((item) => item.length > 0), JSON.stringify(chips))
check('全部 6（不含归档）', chips[0].includes('6'), chips[0])
check('进行中 3', chips[1].includes('3'), chips[1])
check('需要处理 2', chips[2].includes('2'), chips[2])
check('已归档 3', chips[3].includes('3'), chips[3])
check('归档行不出现在「全部」里', !text(panel.tree).includes('t-arc-1'))

chipFor('已归档').props.onClick()
update(panel)
const archivedRows = findAll(panel.tree, (item) => hasClass(item, 'dsh-sa-row') && item.props['data-archived'] === 'true')
check('已归档视图 3 行', archivedRows.length === 3, `实际 ${archivedRows.length}`)
check('归档行没有任何操作按钮', archivedRows.length === 3 && archivedRows.every((row) => buttonsOf(row).length === 0))
check('归档行显示相对时间', text(panel.tree).includes('2 小时前') && text(panel.tree).includes('1 天前'))
check('归档失败原因可见', text(panel.tree).includes('归档失败：会话已不存在'))

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
check('下拉含「跟随会话目录」', menuText.includes('跟随会话目录'))
check('下拉含全部工作区', menuText.includes('主工作区') && menuText.includes('副工作区'))
check('下拉含「刷新列表」', menuText.includes('刷新列表'))
const checked = menu ? findAll(menu, (item) => item.props && item.props['aria-checked'] === true) : []
check('当前目标带勾选且只勾一个', checked.length === 1 && text(checked[0]).includes('主工作区'), JSON.stringify(checked.map((item) => text(item))))

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
const followRow = menu ? buttonsOf(menu).find((item) => text(item).includes('跟随会话目录')) : undefined
if (followRow) followRow.props.onClick()
await tick()
await tick()
update(picker)
let clearBody = null
try { clearBody = JSON.parse(targetRequests().slice(-1)[0].body) } catch (error) { clearBody = null }
check('「跟随会话目录」清除目标（workspace 为空串）', Boolean(clearBody) && clearBody.workspace === '', JSON.stringify(clearBody))
trigger = findAll(picker.tree, (item) => hasClass(item, 'dsh-sa-target'))[0]
check('清除后文案回到「派发 → 跟随会话」', Boolean(trigger) && text(trigger).includes('派发 → 跟随会话'))

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
check('禁用时文案是「派发 → 跟随会话」', Boolean(trigger) && text(trigger).includes('派发 → 跟随会话'))
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
check('候选返回全部工作区', Array.isArray(rows) && rows.length === 2, Array.isArray(rows) ? String(rows.length) : 'not-array')
check('候选带「工作区」分组', Boolean(rows && rows[0] && rows[0].section === '工作区'), rows && rows[0] && String(rows[0].section))
check('候选项形状正确', Boolean(rows && rows[0] && rows[0].value === 'ws-1' && rows[0].name === '主工作区'),
  rows && rows[0] && JSON.stringify(rows[0]))

const filtered = await atSource.candidates({ sessionId: 'session-a' }, { query: '副', signal })
check('候选按查询过滤', Array.isArray(filtered) && filtered.length === 1 && filtered[0].value === 'ws-2',
  Array.isArray(filtered) ? String(filtered.length) : 'not-array')

const before = targetRequests().length
const pickResult = atSource.onPick({
  candidate: rows[1],
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
