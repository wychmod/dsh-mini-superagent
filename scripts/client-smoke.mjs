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

/**
 * 剥掉注释后的源码，供**源码反向断言**使用。
 *
 * 为什么需要：那些断言是「不许出现 `onToggle` / `noteOpen` / `open:` 这类写法」，
 * 但这份文件里到处是**记录事故经过**的注释——它们会原样写出「不挂 `onToggle`、
 * 不建 `detailOpen` state」这种句子。拿含注释的源码去比对，断言就会被自己的文档
 * 命中：实现是对的，测试却红，而且红得像是实现回退了。
 *
 * 只做「去注释」，不改变断言语义：真正要防的是**代码里**写出受控写法 / JS 管展开态。
 * 正则刻意保守：模板字符串里的 `//` 不会被当成注释行首（只剥「整行注释」与块注释），
 * 宁可少剥也不要误剥掉真实代码。
 */
const sourceNoComments = (() => {
  const blankLineComment = /^\s*\/\//
  const out = []
  let inBlock = false
  for (const line of source.split('\n')) {
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      out.push('')
      continue
    }
    const openAt = line.indexOf('/*')
    const closeAt = line.indexOf('*/', openAt < 0 ? 0 : openAt)
    if (openAt >= 0 && closeAt < 0) {
      inBlock = true
      out.push(line.slice(0, openAt))
      continue
    }
    if (openAt >= 0) {
      out.push(line.slice(0, openAt) + line.slice(closeAt + 2))
      continue
    }
    out.push(blankLineComment.test(line) ? '' : line)
  }
  return out.join('\n')
})()

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

/**
 * 把元素树里的函数组件就地展开。
 *
 * 嵌套组件**也需要自己的 hook store**：`DispatchTailBody` 就是一个带
 * `useState` 的嵌套组件，如果每次渲染都给它一份全新的 `store`，展开态会在
 * 每次 `update()` 时被重置成初值——断言就会永远看到「没展开」。
 *
 * 所以按「组件类型 + 在父组件里第几次出现」给一个稳定的 key，把 store 存在
 * `paint` 上下文的 `nested` 表里（同一组件类型出现多次时下标区分，
 * 顺序稳定的场景下等价于 React 的按位置复用）。`pending`/effect 由外层
 * `paint` 统一提交——嵌套组件的 effect 也走同一张 effects 表。
 */
let childSeq = 0
function resolveNode(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(resolveNode)
  if (typeof node.type === 'function') {
    const saved = active
    const parent = saved
    const key = String(node.type.name || 'anon') + '#' + (childSeq++)
    let store = parent && parent.nested ? parent.nested.get(key) : undefined
    if (!store) {
      store = []
      if (parent && parent.nested) parent.nested.set(key, store)
    }
    active = {
      cursor: 0,
      store,
      pending: [],
      nested: parent ? parent.nested : null,
      effectsSink: parent ? parent.effectsSink : null,
    }
    const out = resolveNode(node.type(node.props))
    // 嵌套组件的 effect 交给外层 paint 一起提交（slot 按组件 key 前缀区分，
    // 否则两个组件第 0 个 effect 会互相覆盖）。
    if (parent && Array.isArray(active.pending)) {
      for (const item of active.pending) parent.pending.push(Object.assign({}, item, { slot: key + ':' + item.slot }))
    }
    active = saved
    return out
  }
  const children = node.props && node.props.children ? node.props.children.map(resolveNode) : []
  return { type: node.type, props: Object.assign({}, node.props, { children }) }
}

function mount(component, props) {
  const root = { component, props: props || {}, store: [], effects: new Map(), nested: new Map(), tree: null }
  root.tree = paint(root)
  return root
}

/** 渲染一次并提交 deps 变化的 effect（旧 effect 的清理先跑）。 */
function paint(root) {
  childSeq = 0
  active = { cursor: 0, store: root.store, pending: [], nested: root.nested, effectsSink: root.effects }
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

/**
 * 事件桩：既有原来那个「按名字记账」的 `Set`（几十条断言靠它数监听器），
 * 又能真的把事件发给监听器。
 *
 * 为什么两套记账并存：现有断言用的是 `<type>:<函数名>` 字符串集合（例如
 * 「下拉卸载后 document 监听归零」），改它的结构会让那些断言的前提变掉。
 * 新增的 Map 只服务 `emit()`——派发卡要验「页面隐藏 → 恢复可见」，
 * 没有真正的监听器调用就只能去读源码字符串，那不是运行时断言。
 */
function makeEventTarget(bucket) {
  const handlers = new Map()
  return {
    addEventListener(type, fn) {
      bucket.add(`${type}:${String(fn && fn.name)}`)
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      bucket.delete(`${type}:${String(fn && fn.name)}`)
      const set = handlers.get(type)
      if (set) set.delete(fn)
    },
    /** 同步调用某个类型的全部监听器（`visibilitychange` 等不需要事件对象）。 */
    emit(type) {
      const set = handlers.get(type)
      if (!set) return 0
      let called = 0
      for (const fn of Array.from(set)) { fn({ type }); called += 1 }
      return called
    },
  }
}

/**
 * 派发卡的共享样式节点（plans/12 §9.4）。
 *
 * 卡片把 `<style>` 插到 `document.head` 而不是自己的子树里，所以这里必须有一个能
 * 记账的 head：断言「只插一次」「卸载后摘掉」都得看得见 appendChild/removeChild。
 * `body` 仍然是个空对象：`copyText()` 的老式兜底会因此走不下去并返回 false，
 * 现有「复制失败」的断言依赖这一点，不要给它补 appendChild。
 */
const styleNodes = []

const documentStub = Object.assign(makeEventTarget(documentListeners), {
  body: {},
  visibilityState: 'visible',
  head: {
    appendChild(node) { styleNodes.push(node); node.parentNode = this },
    removeChild(node) {
      const at = styleNodes.indexOf(node)
      if (at >= 0) styleNodes.splice(at, 1)
      node.parentNode = null
    },
  },
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      attributes: {},
      textContent: '',
      style: {},
      setAttribute(name, value) { this.attributes[name] = String(value) },
      getAttribute(name) { return name in this.attributes ? this.attributes[name] : null },
    }
  },
})
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
/* `GET /board?group=`（派发卡的窄口）专用的响应与三档模式：ok | fail | bad。 */
let cardBoardResponse = { tasks: [] }
let cardBoardMode = 'ok'
const cardBoardRequests = () => requests.filter((item) => String(item.url).includes('?group='))
/**
 * `GET /board?task=` 的请求（单条派发的卡片用）。
 *
 * 必须和 `?group=` 分开数：单条派发没有 group，轮询走的是 `?task=`，而
 * 「批次卡不许额外发 ?task= 请求」那条反向断言就是在数这个列表。混在一起数，
 * 两条断言会互相污染。
 */
const cardTaskRequests = () => requests.filter((item) => String(item.url).includes('?task='))
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
/**
 * GET /board/analytics 的响应（分析数据看板）。
 *
 * `analyticsMode` 四档：'ok' 正常聚合 / '404' 旧版宿主没这条路由 /
 * 'degraded' 路由在但 Host 抛错降级 / 'bad' 形状不对（客户端必须报错而不是白屏）。
 */
let analyticsResponse = null
let analyticsMode = 'ok'
const requests = []
const analyticsRequests = () => requests.filter((item) => String(item.url).includes('/board/analytics'))
/**
 * GET /board 快照的请求——也就是任务看板那条 2 秒轮询。
 *
 * `/board/stats`、`/board/analytics`、`/board/retired` 是另外三条路由，
 * 用 `endsWith('/board')` 正好只留下快照这一条。
 */
const boardSnapshotRequests = () => requests.filter((item) => String(item.url).endsWith('/board'))

globalThis.fetch = async (url, options) => {
  const method = (options && options.method) || 'GET'
  const body = options && options.body
  requests.push({ url, method, body })
  if (method === 'GET') {
    /*
     * 派发卡的窄口 `GET /board?group=`。**必须排在面板快照之前**判：
     * 它们走同一个路径，靠查询串区分；判错会让卡片的请求落到面板那份 fixture 上，
     * 于是「卡片只拉自己那一组」这条断言永远在拿全量数据自证。
     */
    if (String(url).includes('?group=')) {
      if (cardBoardMode === 'fail') return { ok: false, status: 500, async json() { return { ok: false, error: 'boom' } } }
      if (cardBoardMode === 'bad') return { ok: true, status: 200, async json() { return {} } }
      return {
        ok: true,
        status: 200,
        async json() { return JSON.parse(JSON.stringify(cardBoardResponse)) },
      }
    }
    /*
     * 派发卡的窄口 `GET /board?task=`（单条派发用；报告卡的状态 chip 也走这条）。
     *
     * 判在 `?group=` 之后、面板快照之前：三者同一个路径，靠查询串区分。
     * 落错地方的表现是「单条卡的轮询拿到了面板那份全量 fixture」，于是
     * 「running → done」永远等不到——正是要修的 bug 在测试里的复现。
     */
    if (String(url).includes('?task=')) {
      if (cardBoardMode === 'fail') return { ok: false, status: 500, async json() { return { ok: false, error: 'boom' } } }
      if (cardBoardMode === 'bad') return { ok: true, status: 200, async json() { return {} } }
      return {
        ok: true,
        status: 200,
        async json() { return JSON.parse(JSON.stringify(cardBoardResponse)) },
      }
    }
    if (getMode === 'fail') return { ok: false, status: 500, async json() { return { ok: false, error: 'boom' } } }
    // 统计路由先于快照判断：它和 /board 是两个路由，判错会把 stats 当成一次普通快照。
    if (String(url).includes('/board/stats')) {
      if (statsMode === '404') return { ok: false, status: 404, async json() { return { ok: false, error: 'not found' } } }
      if (statsMode === 'degraded') {
        return { ok: true, status: 200, async json() { return degradedStatsFixture() } }
      }
      return { ok: true, status: 200, async json() { return statsResponseFor(url) } }
    }
    // 分析看板是另一条只读路由：判在 /board 快照之前，否则会被当成一次普通快照。
    if (String(url).includes('/board/analytics')) {
      if (analyticsMode === '404') return { ok: false, status: 404, async json() { return { ok: false, error: 'not found' } } }
      if (analyticsMode === 'bad') return { ok: true, status: 200, async json() { return {} } }
      if (analyticsMode === 'degraded') {
        return { ok: true, status: 200, async json() { return degradedAnalyticsFixture() } }
      }
      return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(analyticsResponse)) } }
    }
    // 退休视图是独立路由：先于快照判断，否则会被当成一次 GET /board。
    if (String(url).endsWith('/retired')) {
      if (retiredMode === 'fail') return { ok: false, status: 500, async json() { return { ok: false, error: 'retired boom' } } }
      return { ok: true, status: 200, async json() { return retiredResponse } }
    }
    /*
     * 每次 GET /board 都给一份**深拷贝**，而不是同一个 fixture 对象。
     *
     * 真实 HTTP 每次响应都是新解析出来的对象，快照引用必然变化；直接回同一个对象，
     * 会让「拿到一份新快照」这件事在离线冒烟里隐形——客户端挂在 `[data]` 上的
     * 逐轮比较（例如「计划已更新」的指纹）就再也不会重跑。
     */
    return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(boardResponse)) } }
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

/* ───────────────────────── 可控时钟（派发卡轮询专用） ───────────────────────── */

/**
 * 派发卡的轮询断言**必须**跑在可控时钟上。
 *
 * 这个仓库已经因为真实定时器出过三次随机红：2s/15s 的节奏用 `sleep` 去等，
 * 要么等不够（CI 慢机器上偶发），要么等太久（每次跑测试多十几秒）。更糟的是
 * 「退避阶梯」这类断言——真实时间下你没法证明「现在这次是 8s 那次而不是 4s 那次」，
 * 只能证明「大约差不多」，那不是断言。
 *
 * 这里只接管 `setTimeout`/`clearTimeout`：**不接管 `Promise`**，所以 `await`
 * 仍然正常工作（客户端里 `fetch` 是 async、`json()` 也是 async，都需要 microtask）。
 * `advance(ms)` 只把到期的回调执行一次，并让 `await` 有机会跑完（`await tick()`）。
 *
 * 用法：
 *   const clock = installClock()
 *   try { ...const card = mount(...); await clock.flush(); clock.advance(2000)... }
 *   finally { clock.uninstall() }
 */
function installClock() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let now = 0
  let nextId = 1
  const timers = new Map()
  globalThis.setTimeout = function (fn, delay) {
    const id = nextId++
    timers.set(id, { fn, at: now + Math.max(0, Number(delay) || 0) })
    return id
  }
  globalThis.clearTimeout = function (id) {
    timers.delete(id)
  }
  return {
    /** 当前虚拟时刻（毫秒）。 */
    now: () => now,
    /** 已排期的定时器数量——「卸载后不许再有定时器」用它断言。 */
    size: () => timers.size,
    /** 让所有已排期的微任务跑完（真实 macrotask，不受虚拟时钟影响）。 */
    flush: async function () {
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => realSetTimeout(resolve, 0))
    },
    /** 把时钟往前拨 `ms`，按到期顺序执行期间到期的定时器。 */
    advance: function (ms) {
      const target = now + Math.max(0, Number(ms) || 0)
      // 上限保护：一个「回调里又立刻排一个 0ms 定时器」的 bug 会让这里死循环。
      let guard = 0
      while (guard < 1000) {
        guard += 1
        let dueId = null
        let dueAt = Infinity
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) { dueId = id; dueAt = timer.at }
        }
        if (dueId === null) break
        const timer = timers.get(dueId)
        timers.delete(dueId)
        now = Math.max(now, timer.at)
        timer.fn()
      }
      now = target
      return guard
    },
    uninstall: function () {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      timers.clear()
    },
  }
}

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
    /*
     * 宿主 `boardSnapshot()` 投影的真实归档巡检小时数（默认 = 168 = 7 天）。
     * 工具栏那颗按钮的悬浮提示按它拼句子——写成别的数字，提示就会和实际行为对不上。
     */
    archive_after_hours: 168,
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
      { task_id: 't-run-1', title: '批次任务甲', status: 'running', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', group: 'g1', worker_session_id: 'dispatch-t-run-1', elapsed_ms: 12345, report_count: 1, background: { jobs: 1, subagents: 0, since: hoursAgo(0) }, plan_total: 5, plan_done: 2, plan_current: '补 dispatch 单测', last_report: { summary: '第一行摘要\n第二行不该出现' } },
      { task_id: 't-run-2', title: '单跑任务', status: 'running', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', group: null, worker_session_id: 'dispatch-t-run-2', elapsed_ms: 800, report_count: 0, input_pending_at: hoursAgo(0) },
      { task_id: 't-q-3', title: '批次任务乙', status: 'queued', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', group: 'g1', worker_session_id: 'dispatch-t-q-3', elapsed_ms: 0, report_count: 0, created_at: hoursAgo(2) },
      { task_id: 't-f-4', title: '失败任务', status: 'failed', attempt: 2, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-f-4', elapsed_ms: 4000, report_count: 1, error: 'spawn 失败：ENOENT', updated_at: hoursAgo(1) },
      { task_id: 't-done-5', title: '完成的任务', status: 'done', attempt: 1, workspace_id: null, workspace_title: null, worker_session_id: 'dispatch-t-done-5', elapsed_ms: 65000, report_count: 1, updated_at: hoursAgo(2), plan_total: 5, plan_done: 5 },
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
 * 四个任务分别覆盖：冻结不归档 / 未读未知 / 截断字段（**已不再渲染**）/ 三个字段全缺（降级）。
 */
function statusBadgeFixture() {
  return {
    version: '0.4.0',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 1, queued: 0, max: 6 },
    counts: { total: 4, running: 1, queued: 0, done: 3, blocked: 0, failed: 0, cancelled: 0, ended: 0, interrupted: 0, archived: 0, retired: 0 },
    // 照真实快照给 memory 块：截断标记删了，但字段仍要喂进来证明「不渲染」。
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

/**
 * 截断**分段** fixture（`truncated_fields`）：字段仍在快照里，但界面已不渲染标记。
 *
 * 保留这份 fixture 是为了钉否定断言：旧版这里验「[detail] 说详情已截断、[summary]
 * 说摘要已截断」；标记删除后，两种分段都必须**一个标记都不画**。只删断言不行——
 * 那样以后有人把标记加回来也没人拦。
 *
 * 另起一份 fixture 的理由同 `statusBadgeFixture()`：上面那份的断言钉住了别的计数，
 * 往里加行会连带改坏无关断言。
 */
function truncationScopeFixture() {
  return {
    version: '0.9.0',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 0, queued: 0, max: 6 },
    counts: { total: 2, running: 0, queued: 0, done: 2, blocked: 0, failed: 0, cancelled: 0, ended: 0, interrupted: 0, archived: 0, retired: 0 },
    memory: {
      window: { days: WINDOW_DAYS, tasks: 200 },
      ledger: { tasks: 2, retired: 0, archived: 0, retiredDropped: 0, capPerTask: { summary: 6000, detail: 4000 } },
    },
    workspaces: WORKSPACES,
    targets: {},
    tasks: [
      { task_id: 't-scope-d', title: '仅详情被截', status: 'done', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-scope-d', elapsed_ms: 1000, report_count: 1, last_report: { summary: '摘要完好无损' }, has_truncated: true, truncated_fields: ['detail'], updated_at: hoursAgo(3) },
      { task_id: 't-scope-s', title: '摘要真被截', status: 'done', attempt: 1, workspace_id: 'ws-2', workspace_title: '副工作区', worker_session_id: 'dispatch-t-scope-s', elapsed_ms: 1200, report_count: 1, last_report: { summary: '被裁过的摘要' }, has_truncated: true, truncated_fields: ['summary'], updated_at: hoursAgo(4) },
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

/**
 * 按请求里的 `window` 参数回显 `scope.window.key`。
 *
 * 为什么夹具要回显：真实宿主的 `boardStats()` 会在 `scope.window.key` 里写回
 * 这份数字**实际**用的窗口，客户端的口径行正是靠它对齐数字的。夹具若写死
 * '7d'，就验不到「口径行跟 payload 走」这条不变量（面板会拿旧窗口的标签
 * 配新窗口的数字）。
 */
function statsResponseFor(url) {
  const payload = JSON.parse(JSON.stringify(statsResponse))
  const match = /[?&]window=([^&]+)/.exec(String(url))
  if (match && payload && payload.scope) {
    const key = decodeURIComponent(match[1])
    payload.scope = Object.assign({}, payload.scope, {
      window: Object.assign({}, payload.scope.window, { key }),
    })
  }
  return payload
}

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

/* ───────── 分析数据看板的 fixture：形状逐字对齐 src/analytics.js ───────── */

function dayKey(offsetDays) {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10)
}

function analyticsFixture(overrides = {}) {
  const base = {
    analyticsVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: true,
    scope: {
      window: { key: '7d', days: 7, since: hoursAgo(24 * 7) },
      status: 'all', statusList: [], owner: null, ownerField: 'parentSessionId',
      workspaceId: null, hostWorkspaceId: null, group: null,
      overdueHours: 24, timeField: 'createdAt', warnings: [],
    },
    facets: {
      statuses: [
        { id: 'running', title: null, count: 3 }, { id: 'queued', title: null, count: 1 },
        { id: 'done', title: null, count: 4 }, { id: 'failed', title: null, count: 2 },
        { id: 'blocked', title: null, count: 1 }, { id: 'cancelled', title: null, count: 1 },
      ],
      owners: [
        { id: 'session-lead', title: null, count: 8 },
        { id: 'session-billing', title: null, count: 4 },
      ],
      workspaces: [
        { id: 'ws-1', title: 'dsh-mini-superagent', count: 7 },
        { id: 'ws-2', title: '结算服务', count: 5 },
      ],
      hostWorkspaces: [{ id: 'host-1', title: 'dsh-mini-superagent（实际）', count: 3 }],
      groups: [{ id: 'g-7f21', title: null, count: 4 }],
    },
    coverage: {
      sourceTasks: 15, retiredTraces: 3, inWindow: 12, matched: 12, excludedByFilters: 0,
      archived: 2, missingCreatedAt: 0, missingSettledAt: 0, fallbackTimeBasis: 0,
      trendClamped: false, sampleLow: false, truncated: null,
    },
    summary: {
      total: 12, active: 4, settled: 8, archived: 2, cancelled: 1,
      byStatus: { running: 3, queued: 1, done: 4, failed: 2, blocked: 1, cancelled: 1 },
      distribution: [
        { status: 'running', count: 3, share: 0.25 },
        { status: 'queued', count: 1, share: 0.0833 },
        { status: 'done', count: 4, share: 0.3333 },
        { status: 'failed', count: 2, share: 0.1667 },
        { status: 'blocked', count: 1, share: 0.0833 },
        { status: 'cancelled', count: 1, share: 0.0833 },
      ],
      completion: {
        done: 4, base: 6, rate: 0.6667, sampleLow: false,
        includes: ['done', 'ended', 'failed', 'blocked', 'interrupted'],
        excludes: ['running', 'queued', 'cancelled'],
      },
      overdue: {
        thresholdHours: 24, basis: 'proxy:createdAt', dueAtAvailable: false,
        pendingFields: ['due_at'], open: 1, settled: 2, unknown: 0, total: 3, rate: 0.25,
      },
    },
    trend: {
      days: [
        { day: dayKey(5), created: 3, done: 1, failed: 0, blocked: 0, interrupted: 0, cancelled: 0, ended: 0, settled: 1 },
        { day: dayKey(3), created: 4, done: 2, failed: 1, blocked: 0, interrupted: 0, cancelled: 0, ended: 0, settled: 3 },
        { day: dayKey(1), created: 5, done: 1, failed: 0, blocked: 1, interrupted: 0, cancelled: 1, ended: 0, settled: 3 },
      ],
      range: { from: dayKey(7), to: dayKey(0), days: 8 },
      compare: {
        available: true,
        previousRange: { from: hoursAgo(24 * 14), until: hoursAgo(24 * 7) },
        current: { created: 12, done: 4, base: 6, completionRate: 0.6667 },
        previous: { created: 9, done: 3, base: 5, completionRate: 0.6 },
        createdDelta: 3, doneDelta: 1, rateDelta: 0.0667,
      },
    },
    warnings: ['owner-proxy', 'due-at-proxy'],
  }
  return Object.assign({}, base, overrides)
}

/** 空账本：n=0 必须显示 em dash + 空态，而不是 0% / 0 条。 */
function emptyAnalyticsFixture() {
  const data = analyticsFixture()
  data.coverage = Object.assign({}, data.coverage, { sourceTasks: 0, inWindow: 0, matched: 0, retiredTraces: 0 })
  data.summary = Object.assign({}, data.summary, {
    total: 0, active: 0, settled: 0, archived: 0, cancelled: 0,
    distribution: [], byStatus: {},
    completion: { done: 0, base: 0, rate: null, sampleLow: false, includes: [], excludes: [] },
    overdue: { thresholdHours: 24, basis: 'proxy:createdAt', dueAtAvailable: false, pendingFields: ['due_at'], open: 0, settled: 0, unknown: 0, total: 0, rate: null },
  })
  data.trend = { days: [], range: { from: dayKey(7), to: dayKey(0), days: 8 }, compare: { available: false, reason: 'all-window' } }
  return data
}

/**
 * 跨天取消：那天 `created / done / problems` 都是 0，只有 `cancelled=1`。
 *
 * 这是图表判空的老对头：判空只看「新建 / 完成 / 问题」三项时，这一天会被
 * 标成「空天补 0」——而同一份数据的表格里那一天明明写着 cancelled=1。
 * 图表与表格对同一件事给了两个答案。
 */
function crossDayCancelFixture() {
  const data = analyticsFixture()
  const cancelDay = dayKey(1)
  data.trend = {
    days: [
      { day: dayKey(2), created: 1, done: 1, failed: 0, blocked: 0, interrupted: 0, cancelled: 0, ended: 0, settled: 1 },
      { day: cancelDay, created: 0, done: 0, failed: 0, blocked: 0, interrupted: 0, cancelled: 1, ended: 0, settled: 1 },
    ],
    range: { from: dayKey(3), to: dayKey(0), days: 4 },
    compare: { available: false, reason: 'all-window' },
  }
  data.__cancelDay = cancelDay
  return data
}

function degradedAnalyticsFixture() {  return {
    analyticsVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: false,
    degraded: true,
    reason: '聚合失败：ledger 损坏',
    scope: { window: { key: '7d', days: 7, since: hoursAgo(24 * 7) } },
    facets: { statuses: [], owners: [], workspaces: [], hostWorkspaces: [], groups: [] },
    coverage: {
      sourceTasks: 0, retiredTraces: 0, inWindow: 0, matched: 0, excludedByFilters: 0,
      archived: 0, missingCreatedAt: 0, missingSettledAt: 0, fallbackTimeBasis: 0,
      trendClamped: false, sampleLow: false, truncated: null,
    },
    summary: null,
    trend: { days: [], range: null, compare: { available: false, reason: 'degraded' } },
    warnings: ['degraded'],
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

/*
 * 轮次分隔线（conversation.chat.user.before）：宿主在每条用户消息上方留的 chain 槽。
 * 这里守三件事：**注册一次**、**只接用户行**、**派发报告与人类输入在视觉上分得开**。
 * 槽本身由宿主调用选择器，所以 select 的入参形状必须按 ownerProps（source / kind）断言。
 */
const dividerRegs = registrations.filter((item) => item.options.name === 'conversation.chat.user.before')
check('conversation.chat.user.before 注册一次', dividerRegs.length === 1, `实际 ${dividerRegs.length}`)
check('分隔线注册带 select', Boolean(dividerRegs[0] && typeof dividerRegs[0].options.select === 'function'))
const dividerSelect = dividerRegs[0] ? dividerRegs[0].options.select : () => undefined
check('分隔线不接管 steering 行', dividerSelect({ kind: 'steering', source: {} }) === null)
check('人类输入画普通线', Boolean(dividerSelect({ kind: 'user', source: { kind: 'user' } }))
  && dividerSelect({ kind: 'user', source: { kind: 'user' } }).relay === false)
check('插件回流报告标成派发报告', Boolean(dividerSelect({ kind: 'user', source: { kind: 'dsh-mini-superagent' } }))
  && dividerSelect({ kind: 'user', source: { kind: 'dsh-mini-superagent' } }).relay === true)
check('没有 source 也照样画线', Boolean(dividerSelect({ kind: 'user' })) && dividerSelect({ kind: 'user' }).relay === false)
const userDivider = dividerRegs[0] ? dividerRegs[0].component({ matched: dividerSelect({ kind: 'user', source: { kind: 'user' } }) }) : null
check('普通分隔线带 dsh-sa-divide 类', hasClass(userDivider, 'dsh-sa-divide'))
check('普通分隔线没有文字标签（不制造噪音）', findAll(userDivider, (i) => hasClass(i, 'dsh-sa-divide-tag')).length === 0)
const relayDivider = dividerRegs[0] ? dividerRegs[0].component({ matched: dividerSelect({ kind: 'user', source: { kind: 'dsh-mini-superagent' } }) }) : null
check('派发报告分隔线带「派发报告」标签', text(relayDivider).includes('派发报告'), text(relayDivider))
const dividerStyles = findAll(userDivider, (item) => item && item.type === 'style')
check('分隔线样式走主题 token（不写死颜色）', dividerStyles.length === 1 && text(dividerStyles[0]).includes('--dsw-alias-border-l2'))

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
check('自报的 registered 含 tool.call.toolview（宿主提供了这条槽）',
  Boolean(readyBody) && Array.isArray(readyBody.registered)
    && readyBody.registered.includes('tool.call.toolview'),
  readyBody ? JSON.stringify(readyBody.registered) : 'null')
check('自报的 cards.batch = on（plans/14 §4.1 的可观测字段）',
  Boolean(readyBody) && readyBody.cards && readyBody.cards.batch === 'on',
  readyBody ? JSON.stringify(readyBody.cards) : 'null')
/*
 * `cards` 是**必带字段**，哪怕一个结论都没有也是个空对象。
 * 为什么单独守这条：`cards` 缺失与 `cards: {}` 在自检页上长得一样（都读不出键），
 * 但前者说明「客户端还是旧版本、根本没这段代码」，后者说明「新代码跑了但卡没起来」——
 * 排障时这两种情况要走的下一步完全不同。
 */
check('自报体必带 cards 字段（无结论时是空对象，不是缺字段）',
  Boolean(readyBody) && readyBody.cards !== null && typeof readyBody.cards === 'object'
    && !Array.isArray(readyBody.cards),
  readyBody ? JSON.stringify(readyBody.cards) : 'null')
/*
 * 报告卡的 Definition 只从 `ctx.inject(['uiConversation'], …)` 里注册（`ctx.get` 读到的是
 * 时序快照，读不到 ≠ 服务不存在，见 `registerReportCard` 的头注释）。共用 `fakeCtx`
 * 恰恰**没有** `ctx.inject`，所以这条宿主上它一次都不该注册——`cards.report` 必须缺席，
 * 而不是 `error:slot`（plans/14 §4.1：键不存在 = 能力没出现，不是失败）。
 */
check('宿主没有 ctx.inject 通道时 cards.report 键必须缺席（未提供 ≠ 失败）',
  Boolean(readyBody) && readyBody.cards && !('report' in readyBody.cards),
  readyBody ? JSON.stringify(readyBody.cards) : 'null')

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

/*
 * PRD-01 任务级计划：行标签区给 `2/5`，且**只在 queued / running 显示**。
 * 这里两行用的是同一份「宿主给了 plan_*」的数据：
 * - t-run-1（running）必须显示，否则长任务又只能靠反复 inspect；
 * - t-done-5（done）即使数据里带着 plan_* 也必须不显示——终态优先在客户端是
 *   第二道闸，第一道在宿主 `boardTask()`（已结算不下发这三个标量）。
 */
const planRows = findAll(panel.tree, (item) => hasClass(item, 'dsh-sa-row'))
const planRowOf = (id) => planRows.find((row) => text(row).includes(id))
// 「最近完成」是 dense 行：不渲染 id，只留标题，所以按标题找。
const donePlanRow = planRows.find((row) => text(row).includes('完成的任务'))
check('进行中的任务行显示计划进度 2/5', Boolean(planRowOf('t-run-1')) && text(planRowOf('t-run-1')).includes('2/5'),
  planRowOf('t-run-1') ? text(planRowOf('t-run-1')).slice(0, 120) : '没找到 t-run-1')
check('已完成任务不再显示计划进度（终态优先于计划）',
  Boolean(donePlanRow) && !text(donePlanRow).includes('2/5') && !text(donePlanRow).includes('5/5'),
  donePlanRow ? text(donePlanRow).slice(0, 120) : '没找到「完成的任务」')

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

/* ═════════════════════ 归档按钮改名 + 提示 / 计划已更新 ═════════════════════ */

/*
 * 这一段钉三件事：
 * 1. 工具栏归档按钮改名「立即归档超时会话」，且 title / aria-label 都在；
 * 2. 提示里的时长来自**快照的真实配置**（`archive_after_hours`），不是写死的 168；
 *    字段缺失（旧宿主）时退化成不带数字的说法，不许出现 undefined / NaN / 「0 小时」；
 * 3. PRD-01 §6「计划已更新」：计划指纹变了、且任务仍在跑，才亮一次标记，
 *    并在**下一次轮询**（拿到的还是同一份计划）自动消失。
 */
console.log('\n归档按钮改名与提示 / 计划已更新')

/** 这一段用的小快照：一条在跑的任务带着计划（`extra` 用来加/去掉 archive_after_hours）。 */
function planFixture(extra) {
  return Object.assign({
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 1, queued: 0, max: 6 },
    counts: { total: 1, running: 1, queued: 0, done: 0, blocked: 0, failed: 0, cancelled: 0, ended: 0, interrupted: 0, archived: 0, retired: 0 },
    memory: {
      window: { days: WINDOW_DAYS, tasks: 200 },
      ledger: { tasks: 1, retired: 0, archived: 0, retiredDropped: 0, capPerTask: { summary: 6000, detail: 4000 } },
    },
    workspaces: WORKSPACES,
    targets: {},
    tasks: [
      { task_id: 't-plan-1', title: '会改计划的任务', status: 'running', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-plan-1', elapsed_ms: 1000, report_count: 0, plan_total: 5, plan_done: 2, plan_current: '第一个步骤' },
    ],
  }, extra || {})
}

/**
 * 工具栏那颗归档按钮。
 *
 * 按 `aria-label` 找而不是按文案找：行内的单条「归档」按钮也叫「归档」，按文案会撞；
 * 而且这里要同时验证「aria-label 与可见文案一致」，正好用它当锚点。
 */
const ARCHIVE_LABELS = ['立即归档超时会话', '再次点击确认归档超时会话']
const archiveButtonOf = (root) => buttonsOf(root.tree)
  .find((item) => ARCHIVE_LABELS.includes(item.props['aria-label']))

/**
 * 等下一次真实的 2 秒轮询（`GET /board` 数量增加）再重绘。
 *
 * 看板是纯轮询驱动的：计划指纹比较挂在「新快照到了」这一刻，没有别的推进方式。
 * 不用假定时器，是因为这里要验证的正是「轮询本身能否驱动它」。
 */
async function nextPoll(root) {
  const before = boardSnapshotRequests().length
  const deadline = Date.now() + 3000
  while (boardSnapshotRequests().length === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await tick()
  await tick()
  update(root)
}

boardResponse = planFixture({ archive_after_hours: 168 })
const archivePanel = mount(panelReg.component)
await tick()
await tick()
update(archivePanel)

const toolbarArchiveBtn = archiveButtonOf(archivePanel)
check('工具栏归档按钮改名为「立即归档超时会话」',
  Boolean(toolbarArchiveBtn) && text(toolbarArchiveBtn).trim() === '立即归档超时会话',
  toolbarArchiveBtn ? text(toolbarArchiveBtn).trim() : '没找到按钮')
check('归档按钮的 title 写清「归档什么 + 多久算超时」，数字来自快照配置',
  Boolean(toolbarArchiveBtn)
    && toolbarArchiveBtn.props.title.includes('已结算')
    && toolbarArchiveBtn.props.title.includes('168 小时（7 天）')
    && toolbarArchiveBtn.props.title.includes('已归档'),
  toolbarArchiveBtn ? String(toolbarArchiveBtn.props.title) : '没找到按钮')
check('归档按钮的 aria-label 与可见文案一致（读屏能读）',
  Boolean(toolbarArchiveBtn) && toolbarArchiveBtn.props['aria-label'] === '立即归档超时会话'
    && text(toolbarArchiveBtn).trim() === toolbarArchiveBtn.props['aria-label'],
  toolbarArchiveBtn ? `${text(toolbarArchiveBtn).trim()} / ${toolbarArchiveBtn.props['aria-label']}` : '没找到按钮')

// 第一次点击只是进确认态：文案要能对上「再点一次才会归档超时会话」。
toolbarArchiveBtn.props.onClick()
update(archivePanel)
const confirmBtn = archiveButtonOf(archivePanel)
check('第一次点击进入「再次点击确认归档超时会话」',
  Boolean(confirmBtn) && text(confirmBtn).trim() === '再次点击确认归档超时会话'
    && confirmBtn.props['aria-label'] === '再次点击确认归档超时会话',
  confirmBtn ? `${text(confirmBtn).trim()} / ${confirmBtn.props['aria-label']}` : '没找到按钮')
check('确认态仍带着同一条时长说明（hover 不丢信息）',
  Boolean(confirmBtn) && confirmBtn.props.title.includes('168 小时（7 天）'),
  confirmBtn ? String(confirmBtn.props.title) : '没找到按钮')
unmount(archivePanel)

/* 旧宿主没有 `archive_after_hours`：提示必须退化，不许拼出 undefined / 「0 小时」。 */
boardResponse = planFixture()
const legacyPanel = mount(panelReg.component)
await tick()
await tick()
update(legacyPanel)
const legacyBtn = archiveButtonOf(legacyPanel)
check('快照没有 archive_after_hours（旧宿主）：提示退化成不带数字的说法',
  Boolean(legacyBtn) && legacyBtn.props.title === '归档长期未更新的已结算任务；归档后从「全部」移到「已归档」',
  legacyBtn ? String(legacyBtn.props.title) : '没找到按钮')
check('降级提示里没有 undefined / NaN /「0 小时」',
  Boolean(legacyBtn) && !/undefined|NaN|0 小时/.test(legacyBtn.props.title),
  legacyBtn ? String(legacyBtn.props.title) : '没找到按钮')
unmount(legacyPanel)

/*
 * 「计划已更新」：必须**同一个面板跨两次轮询**才能比较（基线只活在面板的 ref 里），
 * 所以这里挂着不卸载，改掉 fixture 里的计划再等下一次轮询。
 *
 * 展示窗口是 `PLAN_NOTICE_MS = POLL_MS * 3`（PRD §11.3：6 秒 = 3 个轮询周期，Q7 拍板）。
 * 真等 6 秒既慢又会被调度抖动搞成时好时坏，所以这里给 `Date.now` 加一个**偏移**
 * （只改「现在几点」，不改时钟流速）：轮询与超时仍按真实时间走，跨窗口只要挪偏移。
 */
const realNow = Date.now
let planClockOffset = 0
Date.now = () => realNow() + planClockOffset
/** 跨过一次展示窗口：`POLL_MS * 3`（POLL_MS = 2 秒，与下面「真实 2 秒轮询」同源）。 */
const PLAN_WINDOW_MS = 3 * 2000

check('「计划已更新」的窗口按 POLL_MS 推导，不是写死的 6000 毫秒魔法数字（PRD §11.8）',
  /const PLAN_NOTICE_MS = POLL_MS \* 3\b/.test(source) && !/PLAN_NOTICE_MS = \d/.test(source),
  (source.match(/const PLAN_NOTICE_MS[^\n]*/) || ['没找到常量'])[0])

boardResponse = planFixture({ archive_after_hours: 168 })
const planPanel = mount(panelReg.component)
await tick()
await tick()
update(planPanel)
const planPanelText = () => text(planPanel.tree)
const planMarks = () => findAll(planPanel.tree, (item) => item.props && item.props['data-plan-updated'])
const planTags = () => findAll(planPanel.tree, (item) => item.props && Object.prototype.hasOwnProperty.call(item.props, 'data-plan'))
check('第一次看到计划不亮「计划已更新」（那是初次见到，不是改了计划）',
  planMarks().length === 0 && planPanelText().includes('2/5'),
  planPanelText().replace(/\s+/g, ' ').slice(0, 160))

// 计划从 2/5 改成 3/5（当前步骤也换了）：下一次轮询应当亮一次。
boardResponse = planFixture({ archive_after_hours: 168 })
boardResponse.tasks[0].plan_done = 3
boardResponse.tasks[0].plan_current = '第二个步骤'
await nextPoll(planPanel)
// 真实 React 里 effect 里的 setState 会立刻重渲染；离线桩不会，补一次重绘等价于那一帧。
update(planPanel)
const marksAfterChange = planMarks()
check('计划 2/5 → 3/5：出现一次「计划已更新」',
  marksAfterChange.length === 1 && text(marksAfterChange[0]).trim() === '计划已更新',
  JSON.stringify(marksAfterChange.map((item) => text(item).trim())))
check('「计划已更新」带 hover 说明（当前快照 + 新进度）',
  marksAfterChange.length === 1
    && marksAfterChange[0].props.title.includes('3/5')
    && marksAfterChange[0].props.title.includes('当前快照'),
  marksAfterChange.length === 1 ? String(marksAfterChange[0].props.title) : '没有标记')
check('同一行仍然显示新的计划进度 3/5（标记不是替代品）',
  planPanelText().includes('3/5'), planPanelText().replace(/\s+/g, ' ').slice(0, 160))

/*
 * 连续两轮相同计划：**不重复提示**。
 *
 * 两层意思都要钉住：①不是「每轮重新点亮」（那样会一直闪）；②也不是「下一轮就消失」
 * （那是 2 秒，不是 PRD 要的 6 秒）。所以这里断言「窗口内仍是同一个徽标」。
 */
await nextPoll(planPanel)
update(planPanel)
check('连续两轮相同计划：窗口内仍是同一个徽标（不重复点亮，也不提前消失）',
  planMarks().length === 1 && planMarks()[0].props['data-plan-updated'] === '3/5',
  JSON.stringify(planMarks().map((item) => item.props['data-plan-updated'])))

// 跨过展示窗口：徽标消失，但计划数字必须留着。
planClockOffset += PLAN_WINDOW_MS
await nextPoll(planPanel)
update(planPanel)
check('约 6 秒（3 个轮询周期）后提示消失，数字 3/5 保留',
  planMarks().length === 0 && planPanelText().includes('3/5'),
  JSON.stringify(planMarks().map((item) => text(item).trim())))

/*
 * 快照请求失败（stale）：**不比较、不提示**。
 *
 * 失败期间面板手里还是上一次成功的旧快照，拿它和基线比等于自己和自己比。
 * 这里让 `boardResponse` 换成一份新计划、同时让取数失败——若实现去比了这份
 * 「新数据」，就会凭空亮出一个计划根本没被观测到的徽标。
 */
getMode = 'fail'
boardResponse = planFixture({ archive_after_hours: 168 })
boardResponse.tasks[0].plan_done = 4
await nextPoll(planPanel)
update(planPanel)
check('快照请求失败期间：不产生「计划已更新」',
  planMarks().length === 0,
  JSON.stringify(planMarks().map((item) => text(item).trim())))

// 恢复：第一轮只重建基线（PRD §11.5），仍不提示。
getMode = 'ok'
await nextPoll(planPanel)
update(planPanel)
check('取数恢复后的第一轮只重建基线：不提示（上一份是跨空档的旧数据）',
  planMarks().length === 0 && planPanelText().includes('4/5'),
  planPanelText().replace(/\s+/g, ' ').slice(0, 160))

// 恢复之后再改一次计划：判定要照常工作（别把「跳过」做成「永久关掉」）。
boardResponse = planFixture({ archive_after_hours: 168 })
boardResponse.tasks[0].plan_done = 5
boardResponse.tasks[0].plan_current = '收尾步骤'
await nextPoll(planPanel)
update(planPanel)
check('恢复后的下一轮计划再变：照常出现过一次提示',
  planMarks().length === 1 && planMarks()[0].props['data-plan-updated'] === '5/5',
  JSON.stringify(planMarks().map((item) => item.props['data-plan-updated'])))

/*
 * 抽屉打开时同样显示（PRD §11.3）。历史和列表是同一个面板的两块视图，
 * 徽标还在窗口内时切过去、点开那一行，抽屉里也要看得到。
 */
const planHistTab = findAll(planPanel.tree, (item) => item && item.props && item.props['data-view-tab'] === 'history')[0]
check('计划已在窗口内的行可以切到历史视图（抽屉断言的前置条件）', Boolean(planHistTab))
planHistTab.props.onClick()
update(planPanel)
await tick()
await tick()
update(planPanel)
const planHistRow = findAll(planPanel.tree, (item) => item.props && item.props['data-history-row'] === 't-plan-1')[0]
if (planHistRow) planHistRow.props.onClick({ type: 'click', preventDefault() {} })
update(planPanel)
const planDrawer = () => findAll(planPanel.tree, (item) => item.props && typeof item.props['data-drawer'] === 'string')[0]
check('抽屉里同样显示「计划已更新」（徽标不只在列表行上）',
  Boolean(planDrawer()) && text(planDrawer()).includes('计划已更新'),
  planDrawer() ? text(planDrawer()).replace(/\s+/g, ' ').slice(0, 200) : '抽屉没打开')

/*
 * 已结算任务：不显示提示，也不留计划标签。
 *
 * 这条同时钉住「两张表在任务结算时被清掉」——徽标原本是活的（上一步刚亮），
 * 任务一结算就必须**立刻**消失，而不是继续挂满 6 秒。
 */
boardResponse = planFixture({ archive_after_hours: 168 })
boardResponse.tasks[0].plan_done = 5
boardResponse.tasks[0].plan_current = '收尾步骤'
boardResponse.tasks[0].status = 'done'
boardResponse.counts = Object.assign({}, boardResponse.counts, { running: 0, done: 1 })
boardResponse.concurrency = Object.assign({}, boardResponse.concurrency, { running: 0 })
await nextPoll(planPanel)
update(planPanel)
check('已结算任务：徽标立刻消失（不挂满窗口）',
  planMarks().length === 0, JSON.stringify(planMarks().map((item) => text(item).trim())))
check('已结算任务：计划标签也一起消失（终态优先于计划）',
  planTags().length === 0, String(planTags().length))
unmount(planPanel)
Date.now = realNow

/*
 * 页面刷新：新面板没有上一轮基线，**不补提示**。
 * 用的快照就是「刚变过一次」的那份计划——如果实现按快照内容猜，这里会亮。
 */
boardResponse = planFixture({ archive_after_hours: 168 })
boardResponse.tasks[0].plan_done = 5
const refreshedPanel = mount(panelReg.component)
await tick()
await tick()
update(refreshedPanel)
check('页面刷新（无上一轮基线）：不补提示，只显示 5/5',
  findAll(refreshedPanel.tree, (item) => item.props && item.props['data-plan-updated']).length === 0
    && text(refreshedPanel.tree).includes('5/5'),
  text(refreshedPanel.tree).replace(/\s+/g, ' ').slice(0, 160))
unmount(refreshedPanel)

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
/*
 * 截断标记已经从界面删除（0.9.x）：快照本来就不带正文，标记也导不到被裁的那部分。
 * 这里反转成**否定断言**——fixture 照样喂 `has_truncated` / `truncated_fields`，
 * 界面必须一个都不画；谁把标记加回来，这两条会立刻红。
 */
const truncMarksIn = (root) => findAll(root, (item) => item.props
  && (item.props['data-truncated'] !== undefined || hasClass(item, 'dsh-sa-truncated')))
check('has_truncated=true 的行不再渲染截断标记（徽标已删除）',
  Boolean(rowByTitle(badgePanel.tree, '摘要被截断的任务')) && truncMarksIn(badgePanel.tree).length === 0,
  Boolean(rowByTitle(badgePanel.tree, '摘要被截断的任务')) ? `标记 ${truncMarksIn(badgePanel.tree).length} 个` : 'row missing')
check('界面上完全不出现「摘要已截断 / 详情已截断」文案',
  !badgeAllText.includes('摘要已截断') && !badgeAllText.includes('详情已截断'),
  badgeAllText.replace(/\s+/g, ' ').slice(0, 160))
const plainTags = tagsOfRow(badgePanel.tree, '没有任何新标记的任务')
check('三个字段全缺 → 没有「已冻结」',
  Boolean(plainTags) && !plainTags.includes('已冻结'), JSON.stringify(plainTags))
check('三个字段全缺 → 没有「未读未知」',
  Boolean(plainTags) && !plainTags.includes('未读未知'), JSON.stringify(plainTags))
check('三个字段全缺 → 没有「待读」',
  Boolean(plainTags) && !plainTags.includes('待读'), JSON.stringify(plainTags))
const plainRow = rowByTitle(badgePanel.tree, '没有任何新标记的任务')
check('三个字段全缺 → 没有截断标记',
  Boolean(plainRow) && truncMarksIn(plainRow).length === 0,
  plainRow ? 'row found' : 'row missing')
check('整块看板一个截断标记都没有（字段还在快照里，只是不渲染）',
  truncMarksIn(badgePanel.tree).length === 0,
  String(truncMarksIn(badgePanel.tree).length))
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
 * 客户端已经不渲染这个标记了，降级路径同样不该冒出它——这条否定断言同时钉住
 * 「删掉的是渲染，不是字段兼容」：字段在不在快照里都不该出现在界面上。
 */
const noCap = statusBadgeFixture()
delete noCap.memory
boardResponse = noCap
const noCapPanel = mount(panelReg.component)
await tick()
await tick()
update(noCapPanel)
const noCapMarks = findAll(noCapPanel.tree, (item) => item.props
  && (item.props['data-truncated'] !== undefined || hasClass(item, 'dsh-sa-truncated')))
check('没有 memory 块时也不渲染截断标记（字段仍在快照里）', noCapMarks.length === 0, String(noCapMarks.length))
check('没有 memory 块时界面不出现「摘要已截断」文案',
  !text(noCapPanel.tree).includes('摘要已截断'), text(noCapPanel.tree).replace(/\s+/g, ' ').slice(0, 160))
unmount(noCapPanel)
boardResponse = boardFixture()

/*
 * 分段：`truncated_fields` 从前用来区分「哪一段被裁」。标记删除后，两种分段都要
 * **一个标记都不画**——这里继续喂 [detail] / [summary] 两种 fixture，把「删干净了」
 * 钉成否定断言，而不是简单删掉用例（删断言等于以后加回来也没人拦）。
 */
console.log('\n截断标记分段：字段仍在快照里，但界面不渲染')
/** 一行里所有截断标记（属性或类名，任一出现都算）。 */
const truncMarksOfRow = (row) => (row ? findAll(row, (item) => item.props
  && (item.props['data-truncated'] !== undefined || hasClass(item, 'dsh-sa-truncated'))) : [])
boardResponse = truncationScopeFixture()
const scopePanel = mount(panelReg.component)
await tick()
await tick()
update(scopePanel)

const detailRow = rowByTitle(scopePanel.tree, '仅详情被截')
check('truncated_fields: [detail] → 该行不渲染「详情已截断」',
  Boolean(detailRow) && truncMarksOfRow(detailRow).length === 0 && !text(detailRow).includes('详情已截断'),
  detailRow ? `标记 ${truncMarksOfRow(detailRow).length} 个` : 'row missing')

const summaryRow = rowByTitle(scopePanel.tree, '摘要真被截')
check('truncated_fields: [summary] → 该行不渲染「摘要已截断」',
  Boolean(summaryRow) && truncMarksOfRow(summaryRow).length === 0 && !text(summaryRow).includes('摘要已截断'),
  summaryRow ? `标记 ${truncMarksOfRow(summaryRow).length} 个` : 'row missing')
check('两种分段下整块看板都不出现截断文案（标记是真的删了，不是只换段名）',
  !text(scopePanel.tree).includes('摘要已截断') && !text(scopePanel.tree).includes('详情已截断'),
  text(scopePanel.tree).replace(/\s+/g, ' ').slice(0, 160))
unmount(scopePanel)
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
/*
 * 口径行必须跟着**当前展示的 payload** 走，而不是跟着「即将生效的选择」走。
 *
 * 切窗口时新请求还在路上，面板上显示的仍是**旧 payload** 的数字。如果窗口
 * 提示已经换成新窗口，界面上就是「新标签 + 旧数字」——两件事说的不是同一批
 * 数据，读者会以为这批数字是 30 天口径的。
 *
 * 所以在响应到达之前，口径行必须还写着旧窗口。
 */
const noteInFlight = findAll(p1.tree, (item) => item.props && item.props['data-scope-note'])[0]
check('切窗口后新响应到达前，口径行仍写旧窗口（不出现「新标签 + 旧数字」）',
  Boolean(noteInFlight) && text(noteInFlight).includes('最近 7 天'),
  noteInFlight ? text(noteInFlight).replace(/\s+/g, ' ') : 'missing')
const scopeLineInFlight = findAll(p1.tree, (item) => item.props && item.props['data-scope'] === 'true')[0]
check('样本口径行的窗口同样跟着旧 payload 走',
  Boolean(scopeLineInFlight) && text(scopeLineInFlight).includes('7 天'),
  scopeLineInFlight ? text(scopeLineInFlight).replace(/\s+/g, ' ').slice(0, 120) : 'missing')
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
const rowArchiveBtn = () => {
  const row = arcRowOf(arcBtnPanel.tree, '失败任务')
  return buttonsOf(row).find((item) => text(item).includes('归档'))
}
rowArchiveBtn().props.onClick({ stopPropagation() {} })
update(arcBtnPanel)
check('第一次点归档只进确认态、不发请求',
  archivePosts().length === beforeAsk
    && labelsOf(arcRowOf(arcBtnPanel.tree, '失败任务')).some((label) => label.includes('再点一次确认归档')),
  JSON.stringify(labelsOf(arcRowOf(arcBtnPanel.tree, '失败任务'))))

/* 第二次点击才真的发，且打到单条路由。 */
postReply = { ok: true, archived: true }
rowArchiveBtn().props.onClick({ stopPropagation() {} })
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
rowArchiveBtn().props.onClick({ stopPropagation() {} })
update(arcBtnPanel)
rowArchiveBtn().props.onClick({ stopPropagation() {} })
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

/*
 * 回归：点续派输入框**不能**「跳去真实会话」（用户报的原始缺陷）。
 *
 * 成因：任务行整体可点（onClick → openWorker → uiWorkspace.openSession），而续派
 * 输入行是行的子节点。输入框当时只拦了 onInput / onKeyDown，**漏了 mousedown 与
 * click**，于是在输入框里点一下，click 冒泡到行上 → 主视图换成那个子会话 → 输入框
 * 自然也没法打字了。「续派」按钮能用，是因为它自己的 onClick 已经 stopPropagation。
 *
 * 两层闸分别断言：
 * 1. 输入行容器自己拦 mousedown/click（第一层，控件级的默认动作，防同类新控件）；
 * 2. 事件即使绕过第一层直抵行处理，target 落在输入框里也不能打开会话（第二层，
 *    防脚本 dispatchEvent / 将来忘拦冒泡的控件复发）。
 */
const openedBeforeContinueInput = opened.length
const contBox = () => findAll(contPanel.tree, (item) => hasClass(item, 'dsh-sa-continue'))[0]
check('续派输入行容器存在且带 data-no-row-click（第二层闸的显式标记）',
  Boolean(contBox()) && contBox().props['data-no-row-click'] === 'true',
  contBox() ? JSON.stringify(contBox().props['data-no-row-click']) : 'container missing')

const bubbled = []
const eventAt = (type, target) => ({
  type,
  target,
  currentTarget: { tagName: 'DIV' },
  stopPropagation() { bubbled.push('stopped:' + type) },
  preventDefault() { bubbled.push('prevented:' + type) },
})
// 模拟「点在 input 内部」：closest 命中控件选择器。
const inputTarget = { tagName: 'INPUT', closest: (selector) => (selector.includes('input') ? { tagName: 'INPUT' } : null) }
const inputContainer = contBox()
if (inputContainer) {
  inputContainer.props.onMouseDown(eventAt('mousedown', inputTarget))
  inputContainer.props.onClick(eventAt('click', inputTarget))
}
check('输入行容器拦下 mousedown 与 click 的冒泡（行处理收不到这两个事件）',
  bubbled.includes('stopped:mousedown') && bubbled.includes('stopped:click'), JSON.stringify(bubbled))
check('拦冒泡时不调 preventDefault（否则输入框拿不到焦点、打不了字）',
  !bubbled.some((item) => item.startsWith('prevented:')), JSON.stringify(bubbled))

/* 输入框本身仍然可用：默认行为没被拦，onInput 能改写草稿。 */
const probe = '还能继续打字'
contInput().props.onInput({ target: { value: probe }, stopPropagation() {} })
update(contPanel)
check('输入框仍能接收输入（value 随草稿变化，说明焦点没被抢走）',
  contInput().props.value === probe, JSON.stringify(contInput().props.value))
// 还原成下面的提交用例要用的草稿。
contInput().props.onInput({ target: { value: typed }, stopPropagation() {} })
update(contPanel)

/*
 * 第二层闸：绕过容器，直接把「点在输入框里」的事件交给行的 onClick。
 * 期望：一次 openSession 都没有，而且不把这次点击当成行点击（不 preventDefault）。
 */
const openedBeforeRowGuard = opened.length
const guardCalls = []
const rowEvent = (target) => ({
  type: 'click',
  target,
  currentTarget: { tagName: 'DIV' },
  stopPropagation() {},
  preventDefault() { guardCalls.push('prevented') },
})
contRowOf('完成的任务').props.onClick(rowEvent(inputTarget))
await tick()
check('事件绕过容器直抵行处理时，closest 守卫也拦住（0 次 openSession）',
  opened.length === openedBeforeRowGuard,
  `新增 ${opened.length - openedBeforeRowGuard} 次（${JSON.stringify(opened.slice(openedBeforeRowGuard))}）`)
check('守卫命中时不再 preventDefault（点输入框不被误判成行点击）',
  guardCalls.length === 0, JSON.stringify(guardCalls))

/* 反向对照：同一行的空白处点击必须照常打开，证明守卫没有写得太宽。 */
const openedBeforePlainRow = opened.length
contRowOf('完成的任务').props.onClick(rowEvent({ tagName: 'DIV', closest: () => null }))
await tick()
check('对照：点任务行空白处仍然打开子会话（守卫没有误伤正常打开）',
  opened.length === openedBeforePlainRow + 1 && opened[opened.length - 1] === 'dispatch-t-done-5',
  JSON.stringify(opened.slice(openedBeforePlainRow)))


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

/*
 * 键盘可达性：输入框里的 Enter 提交、Esc 收起，而且两个键都必须 stopPropagation。
 * 行的 onKeyDown 把 Enter 当成「打开这一行」——不拦的话，按 Enter 发续派的同时会
 * 跳到子会话，等于把刚才那个「点输入框跳走」的缺陷换了个触发方式。
 */
const openedBeforeKeys = opened.length
const beforeEnterPost = retryPosts().length
const stoppedKeys = []
const keyEvent = (key) => ({
  key,
  type: 'keydown',
  stopPropagation() { stoppedKeys.push(key) },
})
contInput().props.onInput({ target: { value: '用 Enter 发' }, stopPropagation() {} })
update(contPanel)
contInput().props.onKeyDown(keyEvent('Enter'))
await tick()
await tick()
update(contPanel)
check('输入框里按 Enter：停止冒泡、提交续派、不打开会话',
  stoppedKeys.includes('Enter') && retryPosts().length === beforeEnterPost + 1
    && JSON.parse(retryPosts().at(-1).body).message === '用 Enter 发'
    && opened.length === openedBeforeKeys,
  `posts ${beforeEnterPost} → ${retryPosts().length} / opened +${opened.length - openedBeforeKeys}`)

check('输入框里按 Esc：停止冒泡并收起输入框（不打开会话）',
  (() => {
    if (!contInput()) return false
    contInput().props.onKeyDown(keyEvent('Escape'))
    update(contPanel)
    return stoppedKeys.includes('Escape')
      && !findAll(contPanel.tree, (item) => item.props && item.props['data-continue-input'] === 't-done-5')[0]
      && opened.length === openedBeforeKeys
  })(),
  `stopped ${JSON.stringify(stoppedKeys)} / opened +${opened.length - openedBeforeKeys}`)

unmount(contPanel)
postReply = { ok: true, target: null }

/* ═════════════════════ 分析数据看板（切换 / 筛选 / 状态） ═════════════════════ */

console.log('\n分析数据看板')
boardResponse = boardFixture()
statsResponse = statsFixture()
statsMode = 'ok'
retiredResponse = { ok: true, count: 0, dropped: 0, entries: [] }
retiredMode = 'ok'
getMode = 'ok'
postReply = { ok: true, target: null }
analyticsResponse = analyticsFixture()
analyticsMode = 'ok'

const anPanel = mount(panelReg.component)
await tick()
await tick()
update(anPanel)

const surfaceTab = (root, id) => findAll(root.tree, (item) => item && item.type === 'button'
  && item.props && item.props['data-surface-tab'] === id)[0]
const anFind = (root, attr, value) => findAll(root.tree, (item) => item && item.props && item.props[attr] === value)
const anMetric = (root, id) => anFind(root, 'data-an-metric', id)[0]
const anSelect = (root, field) => findAll(root.tree, (item) => item && item.type === 'select'
  && item.props && item.props['data-an-select'] === field)[0]
const anLastQuery = () => analyticsRequests().at(-1).url
const anSettle = async (root) => { await tick(); await tick(); update(root) }

check('默认停在任务看板（不改动原首屏）',
  surfaceTab(anPanel, 'tasks') && surfaceTab(anPanel, 'tasks').props['aria-selected'] === true)
check('任务看板模式下完全不请求 /board/analytics', analyticsRequests().length === 0)
check('顶层切换条只有两项（任务 / 分析）',
  ['tasks', 'analytics'].every((id) => Boolean(surfaceTab(anPanel, id))))
check('并列形态已彻底移除', !surfaceTab(anPanel, 'split')
  && findAll(anPanel.tree, (item) => item && item.props && (item.props['data-pane'] || item.className === 'dsh-sa-split')).length === 0)
check('原有 5 个状态 chip 仍在',
  ['全部', '进行中', '需要处理', '已归档', '已退休'].every((label) => buttonsOf(anPanel.tree)
    .some((item) => item.props['aria-pressed'] !== undefined && text(item).includes(label))))
check('原有任务行操作仍在', buttonsOf(anPanel.tree).some((item) => text(item).includes('取消')))
check('原有任务行仍在', text(anPanel.tree).includes('t-run-1'))

surfaceTab(anPanel, 'analytics').props.onClick()
update(anPanel)
await anSettle(anPanel)
check('切到分析看板会拉 /board/analytics', analyticsRequests().length === 1)
/*
 * 任务看板那条 2 秒轮询在分析看板可见时必须**停掉**。
 *
 * 原来它不看面板：切过去之后任务快照仍然每 2 秒落一次状态，于是整个分析视图
 * 每 2 秒重建一次（分析看板自己的轮询是 10 秒）——两套轮询互相踩，
 * 用户盯着分析数字时整个视图在背后反复重绘。
 *
 * 判据用「有没有再发 /board 快照请求」：轮询停掉 = 不取数也不落状态。
 */
const boardReqsBefore = boardSnapshotRequests().length
await new Promise((resolve) => setTimeout(resolve, 2200))
update(anPanel)
check('切到分析看板后 2 秒任务快照轮询停掉（分析视图不再每 2 秒重建）',
  boardSnapshotRequests().length === boardReqsBefore,
  `${boardReqsBefore} → ${boardSnapshotRequests().length}`)
check('默认查询串带窗口与超时阈值',
  anLastQuery().includes('window=7d') && anLastQuery().includes('overdueHours=24'), anLastQuery())
check('分析视图根节点渲染', anFind(anPanel, 'data-an-view', 'true').length === 1)
check('分析视图不渲染任务看板的 header', anFind(anPanel, 'data-view-tab', 'overview').length === 0)
check('任务总量 KPI = 12', Boolean(anMetric(anPanel, 'total')) && text(anMetric(anPanel, 'total')).includes('12'))
check('完成率 KPI = 66.7%', Boolean(anMetric(anPanel, 'rate')) && text(anMetric(anPanel, 'rate')).includes('66.7%'))
check('超时代理 KPI = 3', Boolean(anMetric(anPanel, 'overdue')) && text(anMetric(anPanel, 'overdue')).includes('3'))
check('未结算 KPI = 4', Boolean(anMetric(anPanel, 'active')) && text(anMetric(anPanel, 'active')).includes('4'))
check('状态分布 6 行（点行可下钻）', anFind(anPanel, 'data-an-section', 'status').length === 1
  && findAll(anPanel.tree, (item) => item && item.props && item.props['data-an-status']).length === 6)
check('趋势按 range 覆盖 8 个自然日（合并后仍可核对到每天）',
  (function () {
    const dayNodes = findAll(anPanel.tree, (item) => item && item.props && item.props['data-an-day'])
    const emptyDays = dayNodes
      .filter((item) => item.props['data-an-empty-range'])
      .reduce((sum, item) => sum + Number(item.props['data-an-empty-range']), 0)
    const factDays = dayNodes.filter((item) => !item.props['data-an-empty-range']).length
    return emptyDays + factDays === 8
  })())
check('图表把连续空天合并成一行（4 段空天，最长一段 2 天）',
  findAll(anPanel.tree, (item) => item && item.props && item.props['data-an-empty-range']).length === 4
  && anFind(anPanel, 'data-an-empty-range', '2').length === 1)
check('核心指标区标题不再与大标题重复',
  text(anFind(anPanel, 'data-an-section', 'kpi')[0]).includes('核心指标'))
check('环比行给出「较上一等长窗口」',
  anFind(anPanel, 'data-an-compare', 'true').length === 1 && text(anPanel.tree).includes('较上一等长窗口'))
/*
 * 口径表已从界面移除（用户原话：「没人看得懂」）——那张表写的是分子分母、字段名
 * 与待接入字段，是给维护者的实现说明。这里改成**否定断言**：只删旧断言的话，
 * 以后谁把它加回来都不会有人拦。
 */
check('分析视图不再渲染统计口径表（data-an-defs 不存在）',
  anFind(anPanel, 'data-an-defs', 'true').length === 0
  && !text(anPanel.tree).includes('统计口径与数据可得性'))
check('口径表的内部术语不再出现在界面上（待接入 / 计算口径 / 数据字段）',
  !text(anPanel.tree).includes('待接入：due_at')
  && !text(anPanel.tree).includes('计算口径')
  && !text(anPanel.tree).includes('数据字段 / 可得性'))
check('分析视图脚注不再指回已删除的口径表，改为指向 docs/board.md',
  text(anPanel.tree).includes('docs/board.md')
  && !text(anPanel.tree).includes('为准'))
check('样本口径行说明退休留痕不并入',
  anFind(anPanel, 'data-an-scope', 'true').length === 1 && text(anPanel.tree).includes('不并入'))
check('负责人与逾期都标注为代理口径（待业务确认）',
  text(anPanel.tree).includes('待业务确认'))

let anBefore = analyticsRequests().length
anSelect(anPanel, 'status').props.onChange({ target: { value: 'done' } })
update(anPanel)
await anSettle(anPanel)
check('状态筛选触发重取且写进查询串',
  analyticsRequests().length === anBefore + 1 && anLastQuery().includes('status=done'), anLastQuery())

anBefore = analyticsRequests().length
anFind(anPanel, 'data-an-window', '30d')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)
check('时间范围切换写进查询串',
  analyticsRequests().length === anBefore + 1 && anLastQuery().includes('window=30d'), anLastQuery())

anBefore = analyticsRequests().length
anFind(anPanel, 'data-an-custom-days', 'true')[0].props.onChange({ target: { value: '14' } })
update(anPanel)
anFind(anPanel, 'data-an-apply', 'true')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)
check('自定义天数生效（14d）',
  analyticsRequests().length === anBefore + 1 && anLastQuery().includes('window=14d'), anLastQuery())

anBefore = analyticsRequests().length
anSelect(anPanel, 'owner').props.onChange({ target: { value: 'session-lead' } })
update(anPanel)
await anSettle(anPanel)
check('负责人筛选写进查询串（现有字段 parentSessionId 代理）',
  anLastQuery().includes('owner=session-lead'), anLastQuery())

anFind(anPanel, 'data-an-trend-mode', 'table')[0].props.onClick()
update(anPanel)
check('表格是图表的等价物', anFind(anPanel, 'data-table', 'analytics-trend').length === 1)
anFind(anPanel, 'data-an-trend-mode', 'chart')[0].props.onClick()
update(anPanel)
check('切回图表形态', anFind(anPanel, 'data-table', 'analytics-trend').length === 0)

/* 跨天取消：图表的「空天」判据必须与表格列同源（cancelled / ended 也算那天有事）。 */
const cancelFixture = crossDayCancelFixture()
const cancelDay = cancelFixture.__cancelDay
analyticsResponse = cancelFixture
anFind(anPanel, 'data-an-refresh', 'true')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)
// 注意用「属性为真」筛，而不是按值等于 undefined 筛——后者会把所有没带这个
// 属性的节点也匹配进来（props 里键存在但值是 undefined）。
const emptyDayRows = findAll(anPanel.tree, (item) => item.props && item.props['data-an-empty-range'])
  .map((row) => row.props['data-an-day'])
const factDayRows = findAll(anPanel.tree, (item) => item.props && item.props['data-an-day']
  && !item.props['data-an-empty-range'])
  .map((row) => row.props['data-an-day'])
check('跨天取消那天不算「空天」（图表判空与表格列同源）',
  !emptyDayRows.includes(cancelDay) && factDayRows.includes(cancelDay),
  `空天行=${JSON.stringify(emptyDayRows)} 有事的天=${JSON.stringify(factDayRows)}`)
analyticsResponse = analyticsFixture()
anFind(anPanel, 'data-an-refresh', 'true')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)

anBefore = analyticsRequests().length
anFind(anPanel, 'data-an-status', 'failed')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)
check('点状态分布行即把状态筛选切过去',
  analyticsRequests().length === anBefore + 1 && anLastQuery().includes('status=failed'), anLastQuery())

anBefore = analyticsRequests().length
anFind(anPanel, 'data-an-clear', 'true')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)
check('清除筛选回到默认窗口与全部状态',
  anLastQuery().includes('window=7d') && !anLastQuery().includes('status='), anLastQuery())

/* n=0：空态；分母为 0：em dash 而不是 0%。 */
analyticsResponse = emptyAnalyticsFixture()
anFind(anPanel, 'data-an-refresh', 'true')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)
check('空数据显示空态 + 清除筛选入口', anFind(anPanel, 'data-an-empty', 'true').length === 1)
check('空数据不说「0%」',
  Boolean(anFind(anPanel, 'data-an-empty', 'true')[0])
  && !text(anFind(anPanel, 'data-an-empty', 'true')[0]).includes('0%'))

const noBase = analyticsFixture()
noBase.summary = Object.assign({}, noBase.summary, {
  total: 2, active: 2, settled: 0, archived: 0, cancelled: 0,
  distribution: [{ status: 'running', count: 1, share: 0.5 }, { status: 'queued', count: 1, share: 0.5 }],
  completion: { done: 0, base: 0, rate: null, sampleLow: false, includes: [], excludes: [] },
  overdue: { thresholdHours: 24, basis: 'proxy:createdAt', dueAtAvailable: false, pendingFields: [], open: 0, settled: 0, unknown: 0, total: 0, rate: null },
})
analyticsResponse = noBase
anFind(anPanel, 'data-an-refresh', 'true')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)
check('完成率分母为 0 时显示 —', Boolean(anMetric(anPanel, 'rate')) && text(anMetric(anPanel, 'rate')).includes('—'))

/* 首次取数就失败：错误态 + 重试 + 回到任务看板，任务看板本身不受影响。 */
for (const mode of ['404', 'degraded', 'bad']) {
  analyticsMode = mode
  const broken = mount(panelReg.component)
  await anSettle(broken)
  surfaceTab(broken, 'analytics').props.onClick()
  update(broken)
  await anSettle(broken)
  check(`分析接口 ${mode} 时显示可解释的错误态`, anFind(broken, 'data-an-error', 'true').length === 1)
  check(`分析接口 ${mode} 时给出「回到任务看板」`, anFind(broken, 'data-an-back', 'true').length > 0)
  unmount(broken)
}

/* 有旧数据时失败：保留内容 + 陈旧提示，而不是白屏。 */
analyticsMode = 'ok'
analyticsResponse = analyticsFixture()
anFind(anPanel, 'data-an-refresh', 'true')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)
analyticsMode = '404'
anFind(anPanel, 'data-an-refresh', 'true')[0].props.onClick()
update(anPanel)
await anSettle(anPanel)
check('刷新失败保留上一次成功汇总 + 陈旧提示',
  anFind(anPanel, 'data-an-content', 'true').length === 1 && text(anPanel.tree).includes('展示的是上一次成功汇总的数据'))
analyticsMode = 'ok'

surfaceTab(anPanel, 'tasks').props.onClick()
update(anPanel)
check('切回任务看板且任务行可见',
  surfaceTab(anPanel, 'tasks').props['aria-selected'] === true && text(anPanel.tree).includes('t-run-1'))
check('切回后原有 chip 与行操作都还在',
  buttonsOf(anPanel.tree).some((item) => item.props['aria-pressed'] !== undefined && text(item).includes('需要处理'))
  && buttonsOf(anPanel.tree).some((item) => text(item).includes('取消')))

surfaceTab(anPanel, 'analytics').props.onClick()
update(anPanel)
await anSettle(anPanel)
check('再次进入分析看板，KPI 与筛选控件都在',
  anFind(anPanel, 'data-an-metric', 'total').length === 1 && Boolean(anSelect(anPanel, 'status')))
unmount(anPanel)

/* ═════════════════════ 批次依赖（PRD-02） ═════════════════════ */

/**
 * 依赖（PRD-02 §4.5）的离线证据：`/board` 快照新增五个字段，客户端必须把它们
 * 变成三处可读的文案，而不是安静地丢掉——
 *
 * - 任务行标签：「等 接口改造」/「前置失败」/「依赖 2」；
 * - 批次头：「3 个成员 · 1 个等待前置 · 1 个未执行」；
 * - 抽屉：「前置：…」「当前等待：…（运行中）」「未执行原因：前置 … 失败」。
 *
 * 另起一份 fixture 而不是往 `boardFixture()` 里塞：那份的计数、chip 数字、三段
 * 结构被十几条断言钉着，加行会连带改掉无关断言。
 */
function dependencyFixture() {
  return {
    version: '0.9.0',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 0, queued: 2, max: 6 },
    counts: { total: 4, running: 0, queued: 2, done: 1, blocked: 0, failed: 0, cancelled: 1, ended: 0, interrupted: 0, archived: 0, retired: 0 },
    memory: {
      window: { days: WINDOW_DAYS, tasks: 200 },
      ledger: { tasks: 4, retired: 0, archived: 0, retiredDropped: 0, capPerTask: { summary: 6000, detail: 4000 } },
    },
    workspaces: WORKSPACES,
    targets: {},
    tasks: [
      // 批次 g-dep：A 已完成；B 在等 A；C 因为 A 没成被连带取消。
      { task_id: 't-dep-a', title: '接口改造', status: 'done', attempt: 1, group: 'g-dep', workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-dep-a', elapsed_ms: 5000, report_count: 1, updated_at: hoursAgo(1) },
      { task_id: 't-dep-b', title: '补实现', status: 'queued', attempt: 1, group: 'g-dep', workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-dep-b', elapsed_ms: 0, report_count: 0, created_at: hoursAgo(1), depends_on: ['t-dep-a'], blocked_by: 't-dep-a', blocked_reason: 'running' },
      { task_id: 't-dep-c', title: '跑测试', status: 'cancelled', attempt: 1, group: 'g-dep', workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-dep-c', elapsed_ms: 0, report_count: 0, updated_at: hoursAgo(1), depends_on: ['t-dep-a'], blocked_by: 't-dep-a', blocked_reason: 'failed', cancel_reason: 'dependency_failed', error_code: 'dispatch/dependency-failed' },
      // 独立任务：声明了两个前置但此刻没被挡 → 行标签只写「依赖 2」。
      { task_id: 't-dep-d', title: '补文档', status: 'queued', attempt: 1, workspace_id: 'ws-1', workspace_title: '主工作区', worker_session_id: 'dispatch-t-dep-d', elapsed_ms: 0, report_count: 0, created_at: hoursAgo(1), depends_on: ['t-dep-a', 't-dep-b'] },
    ],
  }
}

console.log('\n批次依赖：行标签 / 批次头 / 抽屉（PRD-02 §4.5）')

boardResponse = dependencyFixture()
const depPanel = mount(panelReg.component)
await tick()
await tick()
update(depPanel)

const waitingTags = tagsOfRow(depPanel.tree, '补实现')
check('被挡的任务行显示「等 接口改造」（标题按 id 从快照里查）',
  Boolean(waitingTags) && waitingTags.some((label) => label.includes('等 接口改造')),
  JSON.stringify(waitingTags))
const failedTags = tagsOfRow(depPanel.tree, '跑测试')
check('被连带取消的任务行显示「前置失败」',
  Boolean(failedTags) && failedTags.includes('前置失败'), JSON.stringify(failedTags))
const depOnlyTags = tagsOfRow(depPanel.tree, '补文档')
check('有依赖但没被挡的任务行显示「依赖 2」',
  Boolean(depOnlyTags) && depOnlyTags.includes('依赖 2'), JSON.stringify(depOnlyTags))

const batchDepTexts = findAll(depPanel.tree, (item) => item.props && item.props['data-batch-dep'] === 'true')
  .map((item) => text(item).replace(/\s+/g, ' ').trim())
check('批次头给出「3 个成员 · 1 个等待前置 · 1 个未执行」',
  batchDepTexts.length === 1 && batchDepTexts[0] === '3 个成员 · 1 个等待前置 · 1 个未执行',
  JSON.stringify(batchDepTexts))
unmount(depPanel)

/*
 * 抽屉：TaskDrawer 挂在历史视图里（点历史行打开）。这里复用同一份 fixture，
 * 分别点「被挡的 B」与「被连带取消的 C」，验证两条不同路径的文案。
 */
boardResponse = dependencyFixture()
const depHist = mount(panelReg.component)
await tick()
await tick()
update(depHist)
const depHistTab = findAll(depHist.tree, (item) => item && item.props && item.props['data-view-tab'] === 'history')[0]
check('历史视图分段可点开（抽屉依赖块的前置条件）', Boolean(depHistTab))
depHistTab.props.onClick()
update(depHist)
await tick()
await tick()
update(depHist)

const depHistRow = (id) => findAll(depHist.tree, (item) => item.props && item.props['data-history-row'] === id)[0]
const depDrawerText = () => {
  const drawer = findAll(depHist.tree, (item) => item.props && typeof item.props['data-drawer'] === 'string')[0]
  return drawer ? text(drawer).replace(/\s+/g, ' ') : ''
}

depHistRow('t-dep-c').props.onClick({ type: 'click', preventDefault() {} })
update(depHist)
check('抽屉给出前置列表（前置：接口改造）',
  depDrawerText().includes('前置') && depDrawerText().includes('接口改造'),
  depDrawerText().slice(0, 300))
check('抽屉给出未执行原因（前置 接口改造 失败）',
  depDrawerText().includes('未执行原因') && depDrawerText().includes('前置 接口改造 失败'),
  depDrawerText().slice(0, 300))

depHistRow('t-dep-b').props.onClick({ type: 'click', preventDefault() {} })
update(depHist)
check('抽屉给出「当前等待：接口改造（运行中）」',
  depDrawerText().includes('当前等待') && depDrawerText().includes('接口改造（运行中）'),
  depDrawerText().slice(0, 300))
unmount(depHist)

/* ═════════════════════ 派发卡（plans/12 P0） ═════════════════════ */

/**
 * 派发卡的离线证据（plans/12 §12.1 前 8 条 + plans/14 §5 G0 的降级一条）。
 *
 * 卡片是 `tool.call.toolview` 的 keyed 视图：宿主要先提供这个槽，`slots.inject`
 * 的回调才会跑。所以这里**不改**共用的 `fakeCtx`（它的 `inject` 无条件回调，
 * 已经用于断言其余四个槽），而是另起一个只给 `main` 的假 ctx 来验降级：
 * 「宿主没有这条槽时，apply 不抛错、其余槽照常注册」。
 */
console.log('\n派发卡：三阶段 / 行模型 / 折叠 / 降级（plans/12 P0）')

const cardRegs = () => registrations.filter((item) => item.options && item.options.name === 'tool.call.toolview')
const cardReg = (key) => cardRegs().find((item) => item.options.key === key)

check('tool.call.toolview 注册两次', cardRegs().length === 2, `实际 ${cardRegs().length}`)
check('两个 key 分别是 dispatch_launch / dispatch_launch_many',
  Boolean(cardReg('dispatch_launch')) && Boolean(cardReg('dispatch_launch_many')),
  JSON.stringify(cardRegs().map((item) => item.options.key)))
check('两个 key 指向同一个组件',
  Boolean(cardReg('dispatch_launch')) && Boolean(cardReg('dispatch_launch_many'))
    && cardReg('dispatch_launch').component === cardReg('dispatch_launch_many').component)
check('视图组件是函数（可作为 keyed view 渲染）',
  Boolean(cardReg('dispatch_launch')) && typeof cardReg('dispatch_launch').component === 'function')

/** 造一条批量派发的 result content（宿主把工具返回对象序列化成 JSON 文本）。 */
const cardContent = (payload) => [{ type: 'text', text: JSON.stringify(payload) }]

function batchResultFixture() {
  return {
    group: 'g-m0abc',
    launched: [
      { task_id: 't-m0abc-1', title: '拆分 auth/types.js', status: 'running', depends_on: [] },
      { task_id: 't-m0abc-2', title: '拆分 auth/index.js', status: 'done', depends_on: [] },
      { task_id: 't-m0abc-3', title: '补 auth 回归测试', status: 'done', depends_on: ['t-m0abc-2'] },
      { task_id: 't-m0abc-4', title: '更新调用点', status: 'queued', depends_on: [] },
    ],
    note: '全部结算后会收到一条批次汇总。',
  }
}

function manyArgs(count) {
  const tasks = []
  for (let i = 0; i < count; i += 1) tasks.push({ title: '任务 ' + (i + 1), brief: 'b' + i })
  return { tasks }
}

function manyPayload(count) {
  const launched = []
  for (let i = 0; i < count; i += 1) {
    launched.push({ task_id: 't-many-' + (i + 1), title: '任务 ' + (i + 1), status: 'queued', depends_on: [] })
  }
  return { group: 'g-many', launched, note: '' }
}

const cardOf = (root) => findAll(root.tree, (item) => item && item.props && item.props['data-card-root'] === 'true')[0]
const cardRowsOf = (root) => findAll(root.tree, (item) => item && item.props && typeof item.props['data-card-row'] === 'string')
const cardButton = (root) => findAll(root.tree, (item) => item && item.props && item.props['data-card-more'] === 'true')[0]
const reqCount = () => requests.length

/* ── 阶段 1：preparing ── */

let cardReqBefore = reqCount()
const prepTree = mount(cardReg('dispatch_launch_many').component, {
  phase: 'preparing',
  callId: 'c-1',
  toolName: 'dispatch_launch_many',
  block: { name: 'dispatch_launch_many', args: {} },
})
// mount 只渲染一次；effect 已经跑过，这里再 update 一次确认重复渲染也不发请求。
update(prepTree)
const prepCard = cardOf(prepTree)
check('preparing 渲染骨架', Boolean(prepCard)
  && Boolean(findAll(prepTree.tree, (item) => item.props && item.props['data-card-skeleton'] === 'true')[0]),
  prepCard ? 'missing skeleton' : 'missing card root')
check('preparing 不发任何请求', reqCount() === cardReqBefore, `新增 ${reqCount() - cardReqBefore} 次`)
check('preparing 标题是「正在准备派发…」', Boolean(prepCard) && text(prepCard).includes('正在准备派发'))
check('preparing 不渲染行（参数还没到，不许假装知道几条）', cardRowsOf(prepTree).length === 0,
  JSON.stringify(cardRowsOf(prepTree).map((item) => item.props['data-card-row'])))
unmount(prepTree)

/* ── 阶段 2：start ── */

cardReqBefore = reqCount()
const startTree = mount(cardReg('dispatch_launch_many').component, {
  phase: 'start',
  callId: 'c-2',
  toolName: 'dispatch_launch_many',
  block: { argsRaw: '{"tasks":[…]}', args: manyArgs(4) },
})
update(startTree)
const startCard = cardOf(startTree)
const startRows = cardRowsOf(startTree)
check('start 用 args.tasks 出行（4 条）', startRows.length === 4, `实际 ${startRows.length}`)
check('start 每行状态是「待定」', startRows.length === 4
  && startRows.every((row) => text(row).includes('待定')),
  JSON.stringify(startRows.map((row) => text(row).replace(/\s+/g, ' ').trim())))
check('start 行顺序等于 args.tasks 顺序',
  startRows.length === 4 && startRows.every((row, index) => text(row).includes('任务 ' + (index + 1))),
  JSON.stringify(startRows.map((row) => row.props['data-card-row'])))
check('start 不发请求', reqCount() === cardReqBefore, `新增 ${reqCount() - cardReqBefore} 次`)
check('start 阶段 group 显示占位 —（不凭空编造）',
  Boolean(startCard) && findAll(startCard, (item) => item.props && item.props['data-card-group'] === 'true').length === 1)
check('start 阶段不显示「已完成/总数」（那个数字此刻是假的）',
  !findAll(startTree.tree, (item) => item.props && item.props['data-card-ratio'] === 'true')[0])
check('start 阶段头部标题写「派发 4 个任务」', Boolean(startCard) && text(startCard).includes('派发 4 个任务'))
unmount(startTree)

/* ── 阶段 3：result ── */

const resultTree = mount(cardReg('dispatch_launch_many').component, {
  phase: 'result',
  callId: 'c-3',
  toolName: 'dispatch_launch_many',
  block: {
    argsRaw: '{"tasks":[…]}',
    args: manyArgs(4),
    content: cardContent(batchResultFixture()),
    isError: false,
  },
})
update(resultTree)
const resultCard = cardOf(resultTree)
const resultRows = cardRowsOf(resultTree)
const ratioNode = findAll(resultTree.tree, (item) => item.props && item.props['data-card-ratio'] === 'true')[0]
check('result 渲染 group', Boolean(resultCard)
  && Boolean(findAll(resultTree.tree, (item) => item.props && item.props['data-card-group'] === 'g-m0abc')[0]))
check('result 渲染 2/4 聚合', Boolean(ratioNode) && text(ratioNode).trim() === '2/4',
  ratioNode ? text(ratioNode) : 'missing')
check('result 的状态词复用 TEXT[status.*]（运行中 / 已完成 / 排队中）',
  resultRows.length === 4
    && resultRows[0].props.children.some((item) => item && text(item) === '运行中')
    && resultRows[1].props.children.some((item) => item && text(item) === '已完成')
    && resultRows[3].props.children.some((item) => item && text(item) === '排队中'),
  JSON.stringify(resultRows.map((row) => text(row).replace(/\s+/g, ' ').trim())))
check('result 行带 task_id（便于对 dispatch_inspect）',
  resultRows.length === 4 && resultRows[0].props['data-card-row'] === 't-m0abc-1')
check('卡片根有 role=group 与 aria-label 聚合',
  Boolean(resultCard) && resultCard.props.role === 'group'
    && String(resultCard.props['aria-label']).includes('4') && String(resultCard.props['aria-label']).includes('2'),
  resultCard ? String(resultCard.props['aria-label']) : 'missing')
check('行容器 role=list、每行 role=listitem',
  Boolean(findAll(resultTree.tree, (item) => item.props && item.props.role === 'list')[0])
    && resultRows.length > 0 && resultRows.every((row) => row.props.role === 'listitem'))
unmount(resultTree)

/* ── 折叠：16 条 → 4 行 + 「还有 12 条」 ── */

const foldTree = mount(cardReg('dispatch_launch_many').component, {
  phase: 'result',
  callId: 'c-4',
  toolName: 'dispatch_launch_many',
  block: { argsRaw: '', args: manyArgs(16), content: cardContent(manyPayload(16)), isError: false },
})
update(foldTree)
check('16 条默认只渲染 4 行', cardRowsOf(foldTree).length === 4, `实际 ${cardRowsOf(foldTree).length}`)
const moreBtn = cardButton(foldTree)
check('折叠时给「展开全部 16 条」且带「还有 12 条」',
  Boolean(moreBtn) && text(moreBtn).includes('展开全部 16 条') && text(moreBtn).includes('还有 12 条'),
  moreBtn ? text(moreBtn) : 'missing')
check('展开按钮是真 <button> 且 aria-expanded=false',
  Boolean(moreBtn) && moreBtn.type === 'button' && moreBtn.props['aria-expanded'] === false)
moreBtn.props.onClick()
update(foldTree)
check('点开后 16 行全在', cardRowsOf(foldTree).length === 16, `实际 ${cardRowsOf(foldTree).length}`)
const collapseBtn = cardButton(foldTree)
check('展开后 aria-expanded=true 且文案变「收起」',
  Boolean(collapseBtn) && collapseBtn.props['aria-expanded'] === true && text(collapseBtn).trim() === '收起',
  collapseBtn ? `${text(collapseBtn)} / aria=${collapseBtn.props['aria-expanded']}` : 'missing')
collapseBtn.props.onClick()
update(foldTree)
check('再点一下收起回 4 行', cardRowsOf(foldTree).length === 4, `实际 ${cardRowsOf(foldTree).length}`)
unmount(foldTree)

/* ── 启动失败项占位 ── */

const failFixture = {
  group: 'g-part',
  launched: [
    { task_id: 't-part-1', title: '能跑的那条', status: 'running', depends_on: [] },
    { title: '没成的那条', error: '第 2 项的 depends_on 必须是任务 id 数组', code: 'BAD_ARGS' },
    { task_id: 't-part-3', title: '后面的那条', status: 'queued', depends_on: [] },
  ],
  note: '',
}
const failTree = mount(cardReg('dispatch_launch_many').component, {
  phase: 'result',
  callId: 'c-5',
  toolName: 'dispatch_launch_many',
  block: { argsRaw: '', args: manyArgs(3), content: cardContent(failFixture), isError: false },
})
update(failTree)
const failRows = cardRowsOf(failTree)
const failedRow = failRows[1]
check('启动失败项占位不塌陷（仍是第 2 行）',
  failRows.length === 3 && failedRow.props['data-card-row'] === 'failed-1'
    && failedRow.props['data-card-row-index'] === '1',
  JSON.stringify(failRows.map((row) => row.props['data-card-row'])))
check('启动失败项显示「没能开始」而不是「失败」',
  Boolean(failedRow) && failedRow.props.children.some((item) => item && text(item) === '没能开始'),
  failedRow ? text(failedRow) : 'missing')
check('启动失败项显示 code 与原因',
  Boolean(failedRow) && text(failedRow).includes('BAD_ARGS') && text(failedRow).includes('depends_on 必须是任务 id 数组'),
  failedRow ? text(failedRow).replace(/\s+/g, ' ') : 'missing')
check('失败项之后的行没有错位（第 3 行仍是 t-part-3）',
  failRows.length === 3 && failRows[2].props['data-card-row'] === 't-part-3',
  failRows.length === 3 ? String(failRows[2].props['data-card-row']) : 'missing')
check('失败项没有 task_id（不编一个假 id）',
  Boolean(failedRow) && !findAll(failedRow, (item) => item.props && String(item.props.className || '').includes('dsh-sa-dc-id'))[0])
unmount(failTree)

/* ── 单条派发共用同一组件 ── */

const singleTree = mount(cardReg('dispatch_launch').component, {
  phase: 'result',
  callId: 'c-6',
  toolName: 'dispatch_launch',
  block: {
    argsRaw: '',
    args: { title: '修登录超时', brief: 'b' },
    content: cardContent({ task: { task_id: 't-single', title: '修登录超时', status: 'queued' }, depends_on: [], note: '' }),
    isError: false,
  },
})
update(singleTree)
const singleCard = cardOf(singleTree)
check('dispatch_launch 只有 1 行且标题用任务标题', cardRowsOf(singleTree).length === 1
  && Boolean(singleCard) && text(singleCard).includes('修登录超时'),
  singleCard ? text(singleCard).replace(/\s+/g, ' ') : 'missing')
check('单条派发没有 group 时不显示批次信息（不编造）',
  Boolean(singleCard) && !findAll(singleTree.tree, (item) => item.props && item.props['data-card-group'])[0])
check('单条派发仍然给 0/1 聚合（有确定总数就可以算）',
  Boolean(findAll(singleTree.tree, (item) => item.props && item.props['data-card-ratio'] === 'true')[0]))
unmount(singleTree)

/* ── 降级：content 不是 JSON ── */

const junkTree = mount(cardReg('dispatch_launch_many').component, {
  phase: 'result',
  callId: 'c-7',
  toolName: 'dispatch_launch_many',
  block: { argsRaw: '', args: manyArgs(2), content: [{ type: 'text', text: '这不是 JSON，是纯文本' }], isError: false },
})
update(junkTree)
const junkCard = cardOf(junkTree)
const junkRows = cardRowsOf(junkTree)
check('content 不是 JSON 时卡片仍然渲染（不吞整卡）', Boolean(junkCard))
check('解析失败时标题与行标题照常', Boolean(junkCard) && text(junkCard).includes('派发 2 个任务')
  && junkRows.length === 2 && text(junkRows[0]).includes('任务 1'),
  junkCard ? text(junkCard).replace(/\s+/g, ' ') : 'missing')
check('解析失败时状态显示「未知」而不是「待定」',
  junkRows.length === 2 && junkRows.every((row) => text(row).includes('未知')),
  JSON.stringify(junkRows.map((row) => text(row).replace(/\s+/g, ' ').trim())))
check('解析失败时 footer 说明原因',
  Boolean(findAll(junkTree.tree, (item) => item.props && item.props['data-card-unparsed'] === 'true')[0]))
unmount(junkTree)

/* ── 样式节点：只插一次，卸载归零后摘掉 ── */

const cardStyleNodes = () => styleNodes.filter((node) => node.getAttribute && node.getAttribute('data-plugin-css') === 'dsh-mini-superagent/cards')
check('预览页此时没有任何卡片样式残留（上一段全部卸载干净）', cardStyleNodes().length === 0,
  `实际 ${cardStyleNodes().length}`)

const twoA = mount(cardReg('dispatch_launch_many').component, {
  phase: 'start', callId: 'c-8', toolName: 'dispatch_launch_many', block: { argsRaw: '', args: manyArgs(1) },
})
update(twoA)
const twoB = mount(cardReg('dispatch_launch').component, {
  phase: 'start', callId: 'c-9', toolName: 'dispatch_launch', block: { argsRaw: '', args: { title: 'x' } },
})
update(twoB)
check('两张卡同时挂载时样式节点仍然只有一个', cardStyleNodes().length === 1, `实际 ${cardStyleNodes().length}`)
const cardCss = cardStyleNodes()[0] ? cardStyleNodes()[0].textContent : ''
check('样式只含主题 token（不写死主色）',
  cardCss.includes('--dsw-alias-border-l1') && !/#3b82f6|#4d6bfe|#dc2626|#16a34a/.test(cardCss),
  cardCss.slice(0, 160))
check('样式尊重 prefers-reduced-motion', cardCss.includes('prefers-reduced-motion'))
check('样式节点带固定的 data-plugin-css（排障时一眼看出是谁插的）',
  Boolean(cardStyleNodes()[0])
    && cardStyleNodes()[0].getAttribute('data-plugin-css') === 'dsh-mini-superagent/cards')
unmount(twoA)
check('卸掉一张卡不摘样式（还有人在用）', cardStyleNodes().length === 1, `实际 ${cardStyleNodes().length}`)
unmount(twoB)
check('最后一张卡卸载后样式节点被摘掉', cardStyleNodes().length === 0, `实际 ${cardStyleNodes().length}`)

// 插件卸载兜底：卡片没走 React 卸载（宿主直接换包）时也不许留下孤儿节点。
const leftover = mount(cardReg('dispatch_launch_many').component, {
  phase: 'start', callId: 'c-10', toolName: 'dispatch_launch_many', block: { argsRaw: '', args: manyArgs(1) },
})
update(leftover)
check('（前置）卡片挂载会重新插样式', cardStyleNodes().length === 1)
const cardCleanup = disposers.find((item) => item.label === 'dsh-mini-superagent: dispatch card cleanup')
check('插件挂载了派发卡的卸载清理 effect', Boolean(cardCleanup), JSON.stringify(disposers.map((item) => item.label)))
if (cardCleanup) cardCleanup.dispose()
check('插件卸载后样式节点被强制摘掉（没有孤儿 <style>）', cardStyleNodes().length === 0,
  `实际 ${cardStyleNodes().length}`)
unmount(leftover)

/* ── 降级：宿主没有 tool.call.toolview ── */

/**
 * plans/14 §5 G0 的最后一条：假 ctx **不提供** `tool.call.toolview` 时
 * `apply` 不抛错、其余槽照常注册。
 *
 * 这里用一个独立的 ctx（而不是改共用 fakeCtx）：共用 ctx 的注册表已经被上面
 * 几十条断言引用，往里加「条件不回放」的开关会让那些断言的前提变成隐式的。
 * 明确把「宿主根本没这条槽」建模成 `inject` 回调不执行，正是宿主在旧版本里的行为。
 */
const degradedRegs = []
const degradedDisposers = []
const degradedCtx = {
  get(name) {
    if (name === 'uiWorkspace') return uiWorkspace
    if (name === 'inputTriggers') return inputTriggers
    return undefined
  },
  effect(builder, label) {
    const dispose = typeof builder === 'function' ? builder() : undefined
    if (typeof dispose === 'function') degradedDisposers.push({ label, dispose })
    return () => { if (typeof dispose === 'function') dispose() }
  },
  logger: { info() {}, warn() {} },
  slots: {
    // 旧宿主：这条槽不存在，宿主就不回放注册回调。其余槽照常。
    inject(name, register) { if (name !== 'tool.call.toolview') register() },
    register(options, component) {
      degradedRegs.push({ options, component })
      return () => {}
    },
  },
}

let degradeThrew = null
try {
  mod.apply(degradedCtx)
} catch (error) {
  degradeThrew = error
}
check('宿主没有 tool.call.toolview 时 apply 不抛错', degradeThrew === null,
  degradeThrew ? String(degradeThrew) : 'ok')
check('降级时其余槽照常注册（看板 / 图标 / 输入框控件 / 分隔线）',
  ['sidebar.panellist', 'main', 'conversation.input.left', 'conversation.chat.user.before']
    .every((name) => degradedRegs.some((item) => item.options && item.options.name === name)),
  JSON.stringify(degradedRegs.map((item) => item.options && item.options.name)))
check('降级时没有任何 tool.call.toolview 注册（保持内置通用行）',
  !degradedRegs.some((item) => item.options && item.options.name === 'tool.call.toolview'))
check('降级时「派发卡卸载清理」effect 不挂（没有卡就没有需要清的东西）',
  !degradedDisposers.some((item) => item.label === 'dsh-mini-superagent: dispatch card cleanup'),
  JSON.stringify(degradedDisposers.map((item) => item.label)))

/*
 * 降级也要可观测（plans/14 §4.1）：旧宿主下 `registered` 里**没有**
 * `tool.call.toolview`，`cards` 里也**没有** `batch` 键——「键不存在」表示
 * 「宿主没提供这个能力」，不是失败。自检页按「未提供」展示。
 */
const degradedReadyReqs = requests.filter((item) => item.url.endsWith('/client-ready'))
let degradedReadyBody = null
try { degradedReadyBody = JSON.parse(degradedReadyReqs[degradedReadyReqs.length - 1].body) } catch (error) { degradedReadyBody = null }
check('降级时自报仍发出，但 registered 不含 tool.call.toolview',
  Boolean(degradedReadyBody) && Array.isArray(degradedReadyBody.registered)
    && !degradedReadyBody.registered.includes('tool.call.toolview'),
  degradedReadyBody ? JSON.stringify(degradedReadyBody.registered) : 'null')
check('降级时 cards 里没有 batch 键（「未提供」而不是「失败」）',
  Boolean(degradedReadyBody) && degradedReadyBody.cards
    && !('batch' in degradedReadyBody.cards),
  degradedReadyBody ? JSON.stringify(degradedReadyBody.cards) : 'null')

/* ── 异步卡的补报（plans/14 §4.1） ── */

/*
 * `cards` 是异步就绪的：`slots.inject` 的回调由宿主导播，完全可能晚于 `apply` 返回。
 * `apply` 末尾那次 POST 只能报同步就绪的槽，所以**必须**再补一次 POST 覆盖同一个
 * `client.ready`；不补的话自检页里永远是空对象，可观测等于没做。
 *
 * 下面三个 ctx 分别覆盖：排队的回调晚到、注册抛错、重复注册不重复上报。
 * 它们都从 `apply` 的**第一次** POST 之后开始计数，因为前面几十条断言已经在
 * 共用 `requests` 上留下了一堆记录。
 */
const readyCount = () => requests.filter((item) => item.url.endsWith('/client-ready')).length
const lastReadyBody = () => {
  const list = requests.filter((item) => item.url.endsWith('/client-ready'))
  try { return JSON.parse(list[list.length - 1].body) } catch (error) { return null }
}

/**
 * 造一个假的宿主 ctx：`inject` 的回调默认进队列，由测试手动「晚播」。
 * `syncSlots` 里的槽名同步回放（模拟不同宿主的就绪时机）；
 * `throwOnRegister` 只在**指定槽**注册时抛错（注入失败），不影响看板那些槽。
 */
function pendingCtx(options) {
  const opts = options || {}
  const queue = []
  const regs = []
  return {
    queue,
    regs,
    get(name) {
      if (name === 'uiWorkspace') return uiWorkspace
      if (name === 'inputTriggers') return inputTriggers
      return undefined
    },
    effect(builder, label) {
      const dispose = typeof builder === 'function' ? builder() : undefined
      return () => { if (typeof dispose === 'function') dispose() }
    },
    logger: { info() {}, warn() {} },
    slots: {
      inject(slotName, register) {
        if (opts.syncSlots && opts.syncSlots.includes(slotName)) { register(); return }
        queue.push({ slotName, register })
      },
      register(registerOptions) {
        const thrown = opts.throwOnRegister
        if (thrown && registerOptions && registerOptions.name === thrown.slot) {
          throw new Error(thrown.message)
        }
        regs.push({ options: registerOptions })
        return () => {}
      },
    },
  }
}

/* ① 排队就绪：apply 之后第一次 POST 只报同步槽，晚到的注册必须补报 */

const lateCtx = pendingCtx({ syncSlots: ['sidebar.panellist', 'main', 'conversation.input.left', 'conversation.chat.user.before'] })
const beforeLate = readyCount()
mod.apply(lateCtx)
const afterApplyReady = readyCount()
check('补报前：apply 只发一次 client-ready（此时卡还没就绪）',
  afterApplyReady - beforeLate === 1, `实际 ${afterApplyReady - beforeLate}`)
const firstLateBody = lastReadyBody()
check('第一次 POST 的 cards 是空对象（异步卡还没结论）',
  Boolean(firstLateBody) && firstLateBody.cards && Object.keys(firstLateBody.cards).length === 0,
  firstLateBody ? JSON.stringify(firstLateBody.cards) : 'null')

// 宿主现在才回调 tool.call.toolview：两张卡各注册一次，两次状态变化合并成一次补报。
const pendingCardInjects = lateCtx.queue.filter((item) => item.slotName === 'tool.call.toolview')
check('（前置）排队的 tool.call.toolview 回调有两个', pendingCardInjects.length === 2,
  `实际 ${pendingCardInjects.length}`)
for (const item of pendingCardInjects) item.register()
const afterLate = readyCount()
check('派发卡注册成功后补报了一次 client-ready',
  afterLate - afterApplyReady === 1, `实际 ${afterLate - afterApplyReady} 次`)
check('补报体里 cards.batch === on',
  Boolean(lastReadyBody()) && lastReadyBody().cards.batch === 'on',
  JSON.stringify(lastReadyBody() && lastReadyBody().cards))
check('补报体的 registered 补上了 tool.call.toolview',
  Boolean(lastReadyBody()) && lastReadyBody().registered.includes('tool.call.toolview'),
  JSON.stringify(lastReadyBody() && lastReadyBody().registered))
check('补报不把 report 编出来（它还不存在，键必须缺席）',
  Boolean(lastReadyBody()) && !('report' in lastReadyBody().cards),
  JSON.stringify(lastReadyBody() && lastReadyBody().cards))

/* ② 只报一次：同一张卡再注册一遍（HMR/重放）不重复 POST */

const beforeRepeat = readyCount()
for (const item of pendingCardInjects) item.register()
check('重复注册同一张卡不再重复补报（签名没变就不发）',
  readyCount() === beforeRepeat, `实际多发 ${readyCount() - beforeRepeat} 次`)

/*
 * ②' 同步就绪：宿主在 `inject` 里直接回放（最常见的宿主行为）。
 * 此时卡在 `apply` **内部**就注册好了，`markCard` 只把状态记进表（此刻 `readyPayload`
 * 还没赋值，POST 会被自己挡掉），由 `apply` 末尾那一次 POST 一并带出去。
 * 守这条是因为反过来写（先赋值 payload 再注册）会变成「每次加载发两个包」——
 * 功能上看不出差别，但每次热重载都多一次写，属于没人会去查的那种退步。
 */
const syncCtx = pendingCtx({ syncSlots: ['sidebar.panellist', 'main', 'conversation.input.left', 'conversation.chat.user.before', 'tool.call.toolview'] })
const beforeSync = readyCount()
mod.apply(syncCtx)
check('同步就绪时也只发一次 client-ready（不因为卡已注册就多报一遍）',
  readyCount() - beforeSync === 1, `实际 ${readyCount() - beforeSync} 次`)
check('同步就绪时那一次 POST 里就带上了 cards.batch = on',
  Boolean(lastReadyBody()) && lastReadyBody().cards.batch === 'on',
  JSON.stringify(lastReadyBody() && lastReadyBody().cards))

/* ③ 注入失败：slots.register 抛错 → error:register，且只 warn 一次 */

const throwCtx = pendingCtx({
  syncSlots: ['sidebar.panellist', 'main', 'conversation.input.left', 'conversation.chat.user.before'],
  // 只让卡片视图的注册抛错：看板那些槽注册失败会让这条断言的前提变成「apply 垮了」。
  throwOnRegister: { slot: 'tool.call.toolview', message: 'duplicate key' },
})
const beforeThrow = readyCount()
mod.apply(throwCtx)
check('（前置）注册抛错的 ctx 也是先发一次基础上报',
  readyCount() - beforeThrow === 1, `实际 ${readyCount() - beforeThrow}`)
for (const item of throwCtx.queue.filter((entry) => entry.slotName === 'tool.call.toolview')) item.register()
check('slots.register 抛错后 cards.batch === error:register',
  Boolean(lastReadyBody()) && lastReadyBody().cards.batch === 'error:register',
  JSON.stringify(lastReadyBody() && lastReadyBody().cards))
check('注册失败时 registered 不谎报 tool.call.toolview 已就位',
  Boolean(lastReadyBody()) && !lastReadyBody().registered.includes('tool.call.toolview'),
  JSON.stringify(lastReadyBody() && lastReadyBody().registered))

/* ④ 两种失败要分得开：inject 抛错是 error:slot，未提供则键不存在 */

const slotThrowCtx = pendingCtx({
  syncSlots: ['sidebar.panellist', 'main', 'conversation.input.left', 'conversation.chat.user.before'],
})
slotThrowCtx.slots.inject = function (slotName, register) {
  if (slotName === 'tool.call.toolview') throw new Error('unknown slot')
  register()
}
mod.apply(slotThrowCtx)
check('inject 抛错时 cards.batch === error:slot（与「未提供」区分）',
  Boolean(lastReadyBody()) && lastReadyBody().cards.batch === 'error:slot',
  JSON.stringify(lastReadyBody() && lastReadyBody().cards))
check('「未提供」与「error:slot」是可区分的两个状态',
  // 降级 ctx 里 batch 键**不存在**；抛错 ctx 里是字符串 error:slot。
  Boolean(degradedReadyBody) && !('batch' in degradedReadyBody.cards)
    && Boolean(lastReadyBody()) && lastReadyBody().cards.batch === 'error:slot')

/* ═════════════════════ 派发卡 P1：轮询 / 退避 / blocked / 行点击 ═════════════════════ */

/**
 * plans/12 §12.1 第 9–12 条 + P1 补充（13–16）的离线证据。
 *
 * 全部跑在**可控时钟**上（`installClock()`）：2s / 15s / 退避阶梯这些节奏如果
 * 用真实时间等，既慢又不稳。时钟只接管 `setTimeout`/`clearTimeout`，`await`
 * 照常工作，所以一次 `advance(2000)` 就能精确说出「到点的是哪一次 tick」。
 */
console.log('\n派发卡 P1：实时轮询 / 退避 / 旧宿主降级 / blocked / 行点击（plans/12 §8.4、§10、§7.2）')

/** 造一个 `/board?group=` 的响应（形状与 Host 的 `boardSnapshot()` 一致）。 */
function cardBoardPayload(tasks) {
  return {
    version: '0.9.1',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 0, queued: 0, max: 6 },
    counts: {},
    archive_after_hours: 168,
    tasks,
    truncated: null,
  }
}

/** 一行看板任务（只给卡片真正读的那几个字段）。 */
function cardBoardRow(taskId, group, status, extra) {
  return Object.assign({
    task_id: taskId,
    title: '任务 ' + taskId,
    status,
    group,
    depends_on: [],
    worker_session_id: 'dispatch-' + taskId,
    elapsed_ms: 1000,
    last_report: null,
  }, extra || {})
}

const p1Args = () => ({ tasks: [{ title: '甲' }, { title: '乙' }, { title: '丙' }] })
const p1Payload = (group, statuses) => ({
  group,
  launched: statuses.map((status, index) => ({
    task_id: 't-p1-' + (index + 1),
    title: '任务 ' + (index + 1),
    status,
    depends_on: [],
  })),
  note: '',
})

const p1Props = (payload, args) => ({
  phase: 'result',
  callId: 'c-p1',
  toolName: 'dispatch_launch_many',
  block: { argsRaw: '', args: args || p1Args(), content: cardContent(payload), isError: false },
})

const clock = installClock()
try {
  /* ── 9. 轮询 URL 带 ?group=，同一 group 的两个实例只发一次请求 ── */

  cardBoardMode = 'ok'
  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-p1-1', 'g-p1', 'running'),
    cardBoardRow('t-p1-2', 'g-p1', 'queued'),
    cardBoardRow('t-p1-3', 'g-p1', 'queued'),
  ])
  const twoCardsPayload = p1Payload('g-p1', ['queued', 'queued', 'queued'])
  const beforeFeed = cardBoardRequests().length
  const feedA = mount(cardReg('dispatch_launch_many').component, p1Props(twoCardsPayload))
  update(feedA)
  await clock.flush()
  const afterA = cardBoardRequests().length - beforeFeed
  check('轮询 URL 带 ?group=（卡片只拉自己那一组）',
    afterA >= 1 && cardBoardRequests().slice(beforeFeed).every((item) => item.url.includes('?group=g-p1')),
    JSON.stringify(cardBoardRequests().slice(beforeFeed).map((item) => item.url)))
  const feedB = mount(cardReg('dispatch_launch_many').component, p1Props(twoCardsPayload))
  update(feedB)
  await clock.flush()
  check('同一 group 的两张卡共享一个 feed（第二张不再发请求）',
    cardBoardRequests().length - beforeFeed === afterA,
    `第一张 ${afterA} 次，两张合计 ${cardBoardRequests().length - beforeFeed} 次`)

  /* ── 10. 卸载后定时器清空、不再发请求 ── */

  const beforeUnmount = cardBoardRequests().length
  unmount(feedA)
  check('卸掉一张卡后 feed 还活着（另一张还在用）',
    cardBoardRequests().length - beforeUnmount >= 0 && clock.size() > 0,
    `剩余定时器 ${clock.size()}`)
  clock.advance(2100)
  await clock.flush()
  const duringShared = cardBoardRequests().length
  check('共享 feed 在第二张卡还在时不停止轮询',
    duringShared - beforeUnmount >= 1, `${beforeUnmount} → ${duringShared}`)
  unmount(feedB)
  check('最后一张卡卸载后不再有定时器（refcount 归零）', clock.size() === 0, `剩余 ${clock.size()}`)

  /* ── 13. 全部结算后降频到 15s（可控时钟断言） ── */

  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-p1-1', 'g-p1', 'running'),
    cardBoardRow('t-p1-2', 'g-p1', 'queued'),
    cardBoardRow('t-p1-3', 'g-p1', 'queued'),
  ])
  const settleCard = mount(cardReg('dispatch_launch_many').component, p1Props(twoCardsPayload))
  update(settleCard)
  await clock.flush()
  let settleCount = cardBoardRequests().length
  // 有未结算成员：2s 一次。
  clock.advance(2000)
  await clock.flush()
  update(settleCard)
  check('还有成员未结算时按 2s 轮询',
    cardBoardRequests().length === settleCount + 1,
    `2s 后新增 ${cardBoardRequests().length - settleCount} 次`)
  // 全部结算：下一次请求应该被排到 15s 之后。先把这份「都结算了」的响应送进卡片
  // （这一次 2s tick 是**上一轮**排好的，不算降频），再看之后 2s 内会不会再拉。
  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-p1-1', 'g-p1', 'done'),
    cardBoardRow('t-p1-2', 'g-p1', 'failed'),
    cardBoardRow('t-p1-3', 'g-p1', 'cancelled'),
  ])
  clock.advance(2000)
  await clock.flush()
  update(settleCard)
  check('（前置）全部结算的那一版已落进卡片',
    cardRowsOf(settleCard).length === 3
      && cardRowsOf(settleCard).every((row) => text(row).includes('已完成') || text(row).includes('失败') || text(row).includes('已取消')),
    JSON.stringify(cardRowsOf(settleCard).map((row) => text(row).replace(/\s+/g, ' '))))
  settleCount = cardBoardRequests().length
  clock.advance(2000)
  await clock.flush()
  update(settleCard)
  check('全部结算后降频：2s 内不再发请求（不是每 2s 死拉）',
    cardBoardRequests().length === settleCount,
    `2s 后新增 ${cardBoardRequests().length - settleCount} 次`)
  clock.advance(13000)
  await clock.flush()
  update(settleCard)
  check('全部结算后 15s 到点才再拉一次',
    cardBoardRequests().length === settleCount + 1,
    `到 15s 时共新增 ${cardBoardRequests().length - settleCount} 次`)

  /* ── 11. 页面隐藏暂停、恢复可见立即拉一次 ── */

  documentStub.visibilityState = 'hidden'
  const beforeHidden = cardBoardRequests().length
  clock.advance(20000)
  await clock.flush()
  update(settleCard)
  check('页面隐藏时暂停轮询（不再发请求）',
    cardBoardRequests().length === beforeHidden,
    `隐藏期间新增 ${cardBoardRequests().length - beforeHidden} 次`)
  check('页面隐藏时不留定时器（不是空转）', clock.size() === 0, `剩余 ${clock.size()}`)
  documentStub.visibilityState = 'visible'
  const beforeVisible = cardBoardRequests().length
  const fired = documentStub.emit('visibilitychange')
  await clock.flush()
  update(settleCard)
  check('（前置）document 上确实挂着 visibilitychange 监听', fired >= 1, `调用了 ${fired} 个监听器`)
  check('恢复可见立即补一次（不等下一个 tick）',
    cardBoardRequests().length === beforeVisible + 1,
    `恢复后新增 ${cardBoardRequests().length - beforeVisible} 次`)
  unmount(settleCard)

  /* ── 12. 请求失败保留上次状态；连续 3 次后「状态可能已过期」 ── */

  cardBoardMode = 'ok'
  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-p1-1', 'g-p2', 'running'),
    cardBoardRow('t-p1-2', 'g-p2', 'queued'),
    cardBoardRow('t-p1-3', 'g-p2', 'queued'),
  ])
  const failPayload = p1Payload('g-p2', ['queued', 'queued', 'queued'])
  const failCard = mount(cardReg('dispatch_launch_many').component, p1Props(failPayload))
  update(failCard)
  await clock.flush()
  update(failCard)
  check('（前置）中断前已拿到 running 状态',
    cardRowsOf(failCard).some((row) => text(row).includes('运行中')),
    JSON.stringify(cardRowsOf(failCard).map((row) => text(row).replace(/\s+/g, ' '))))
  cardBoardMode = 'fail'
  // 三次失败分别发生在 2s / 4s / 8s（退避阶梯），不能一次 advances 到底。
  for (let i = 0; i < 3; i += 1) {
    clock.advance(30000)
    await clock.flush()
    update(failCard)
  }
  check('请求失败后保留上次状态（行没有被删掉）',
    cardRowsOf(failCard).length === 3 && cardRowsOf(failCard).some((row) => text(row).includes('运行中')),
    JSON.stringify(cardRowsOf(failCard).map((row) => text(row).replace(/\s+/g, ' '))))
  check('连续 3 次失败后出现「状态可能已过期」',
    findAll(failCard.tree, (item) => item.props && item.props['data-card-stale'] === 'true')
      .some((item) => text(item).includes('状态可能已过期')),
    text(cardOf(failCard) || {}))
  unmount(failCard)

  /* ── 14. 旧宿主模拟：忽略 group 返回全量快照 → 自行过滤、成员不全时停表 ── */

  cardBoardMode = 'ok'
  const legacyPayload = p1Payload('g-legacy', ['queued', 'queued', 'queued'])
  /*
   * 旧宿主的 `/board` 忽略 `?group=`：返回的是**全量**快照，而且被 200 条上限截断了。
   * 这一批 3 个成员里只有 2 个还在快照里（第 3 个被别的批次挤掉了）。
   */
  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-p1-1', 'g-legacy', 'running'),
    cardBoardRow('t-p1-2', 'g-legacy', 'done'),
    cardBoardRow('t-other-1', 'g-someone-else', 'running'),
    cardBoardRow('t-other-2', 'g-someone-else', 'queued'),
  ])
  const legacyCard = mount(cardReg('dispatch_launch_many').component, p1Props(legacyPayload))
  update(legacyCard)
  await clock.flush()
  update(legacyCard)
  const legacyRows = cardRowsOf(legacyCard)
  check('旧宿主返回全量快照时前端自行按 group 过滤（不把别批次的行画进来）',
    legacyRows.length === 3 && !text(legacyCard.tree).includes('任务 t-other-1')
      && !text(legacyCard.tree).includes('g-someone-else'),
    `行数 ${legacyRows.length}`)
  check('旧宿主截断导致成员不全时标「状态为派发时快照」',
    findAll(legacyCard.tree, (item) => item.props && item.props['data-card-snapshot'] === 'true')
      .some((item) => text(item).includes('状态为派发时快照')),
    text(cardOf(legacyCard) || {}))
  check('成员不全时停止轮询（定时器已摘掉）', clock.size() === 0, `剩余 ${clock.size()}`)
  const beforeFrozen = cardBoardRequests().length
  clock.advance(20000)
  await clock.flush()
  check('停表之后确实不再请求（不拿截断快照冒充实时状态）',
    cardBoardRequests().length === beforeFrozen,
    `多发了 ${cardBoardRequests().length - beforeFrozen} 次`)
  unmount(legacyCard)

  /*
   * 晚挂载的第二张卡不能把 feed 误判成「成员不全」。
   *
   * 这条守的是上面 `expectedProbes` 的存在理由：`expected` 如果只在建条目那天取一次，
   * 第二张卡（或同一张卡的第一次渲染在 `launched` 补齐之前）报的行数是 0，之后
   * 就再也追不上——于是宿主的正常响应被当成「旧宿主截断」，卡直接停表。
   * 这是**假降级**：它比不降级更糟，因为用户看到的是一张永远停在派发快照的卡。
   */
  cardBoardMode = 'ok'
  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-late-1', 'g-late', 'running'),
    cardBoardRow('t-late-2', 'g-late', 'queued'),
    cardBoardRow('t-late-3', 'g-late', 'queued'),
  ])
  const latePayload = {
    group: 'g-late',
    launched: [
      { task_id: 't-late-1', title: '甲', status: 'queued', depends_on: [] },
      { task_id: 't-late-2', title: '乙', status: 'queued', depends_on: [] },
      { task_id: 't-late-3', title: '丙', status: 'queued', depends_on: [] },
    ],
    note: '',
  }
  const lateA = mount(cardReg('dispatch_launch_many').component, p1Props(latePayload))
  update(lateA)
  await clock.flush()
  // 第二张卡晚到：此时第一张已经把 feed 建好、expected = 3。
  const lateB = mount(cardReg('dispatch_launch_many').component, p1Props(latePayload))
  update(lateB)
  await clock.flush()
  update(lateB)
  check('同 group 的第二张卡直接拿到已有数据（不重复请求）',
    cardRowsOf(lateB).some((row) => text(row).includes('运行中')),
    JSON.stringify(cardRowsOf(lateB).map((row) => text(row).replace(/\s+/g, ' '))))
  check('第二张卡不会把 feed 误判成「成员不全」（没有冻结标记）',
    !findAll(lateB.tree, (item) => item.props && item.props['data-card-snapshot'] === 'true').length)
  unmount(lateA)
  unmount(lateB)

  /* ── 15. blocked_by 行显示「等 t-…」而不是「排队中」 ── */

  cardBoardMode = 'ok'
  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-p1-1', 'g-dep', 'running'),
    cardBoardRow('t-p1-2', 'g-dep', 'queued', { blocked_by: 't-p1-1', blocked_reason: 'running' }),
    cardBoardRow('t-p1-3', 'g-dep', 'blocked', { blocked_reason: '前置 t-p1-2 失败' }),
  ])
  const depPayload = p1Payload('g-dep', ['running', 'queued', 'queued'])
  const depCard = mount(cardReg('dispatch_launch_many').component, p1Props(depPayload))
  update(depCard)
  await clock.flush()
  update(depCard)
  const depRows = cardRowsOf(depCard)
  check('blocked_by 行显示「等 t-…」（不是「排队中」）',
    Boolean(depRows[1]) && text(depRows[1]).includes('等 t-p1-1') && !text(depRows[1]).includes('排队中'),
    depRows[1] ? text(depRows[1]).replace(/\s+/g, ' ') : 'missing')
  check('blocked 行显示「已阻塞」+ 一行 blocked_reason',
    Boolean(depRows[2]) && text(depRows[2]).includes('已阻塞') && text(depRows[2]).includes('前置 t-p1-2 失败'),
    depRows[2] ? text(depRows[2]).replace(/\s+/g, ' ') : 'missing')

  /* ── 行点击准入：已结算/已退休的行不可点 ── */

  const openedBeforeCardClick = opened.length
  const runningRow = depRows[0]
  check('运行中的行可点（拿到 worker_session_id 才给点击）',
    runningRow.props['data-card-open'] === 'true' && typeof runningRow.props.onClick === 'function')
  runningRow.props.onClick()
  await clock.flush()
  check('点可点的行 → uiWorkspace.openSession 拿到那个子会话',
    opened.length === openedBeforeCardClick + 1
      && opened[opened.length - 1] === 'dispatch-t-p1-1',
    JSON.stringify(opened.slice(-2)))

  // 第 2 行（queued + blocked_by）仍可点：它在等前置，子会话还活着。
  check('被挡但还在排队的行可点（等前置 ≠ 已结算）',
    depRows[1].props['data-card-open'] === 'true' && typeof depRows[1].props.onClick === 'function',
    `data-card-open=${String(depRows[1].props['data-card-open'])}`)
  depRows[1].props.onClick()
  await clock.flush()
  check('点被挡的行 → 同样走 openSession',
    opened.length === openedBeforeCardClick + 2 && opened[opened.length - 1] === 'dispatch-t-p1-2',
    JSON.stringify(opened.slice(-2)))
  check('blocked（已结算）行不可点（它不会自己再跑起来）',
    depRows[2].props.onClick === undefined && depRows[2].props['data-card-open'] === undefined,
    `onClick=${String(typeof depRows[2].props.onClick)}`)

  /* ── 16. 已结算行的点击不触发 openSession ── */

  unmount(depCard)
  cardBoardMode = 'ok'
  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-done-a', 'g-settled', 'done'),
    cardBoardRow('t-done-b', 'g-settled', 'failed', { error_code: 'E_BOOM' }),
    cardBoardRow('t-done-c', 'g-settled', 'cancelled', { cancel_reason: 'dependency_failed' }),
  ])
  const settledPayload = {
    group: 'g-settled',
    launched: [
      { task_id: 't-done-a', title: '已完成的那条', status: 'running', depends_on: [] },
      { task_id: 't-done-b', title: '失败的那条', status: 'running', depends_on: [] },
      { task_id: 't-done-c', title: '被连坐的那条', status: 'running', depends_on: [] },
    ],
    note: '',
  }
  const settledCard = mount(cardReg('dispatch_launch_many').component, p1Props(settledPayload))
  update(settledCard)
  await clock.flush()
  update(settledCard)
  const settledRows = cardRowsOf(settledCard)
  const openedBeforeSettled = opened.length
  for (const row of settledRows) {
    if (typeof row.props.onClick === 'function') row.props.onClick()
  }
  await clock.flush()
  check('已结算行的点击不触发 openSession（点不开已完成/失败/取消的行）',
    opened.length === openedBeforeSettled,
    `多开了 ${opened.length - openedBeforeSettled} 次`)
  check('已结算行干脆不挂 onClick（连指针态都不给）',
    settledRows.every((row) => row.props.onClick === undefined && row.props['data-card-open'] === undefined),
    JSON.stringify(settledRows.map((row) => Boolean(row.props.onClick))))
  check('失败行给出 error_code',
    Boolean(settledRows[1]) && text(settledRows[1]).includes('E_BOOM'),
    settledRows[1] ? text(settledRows[1]).replace(/\s+/g, ' ') : 'missing')
  check('已取消行区分「前置未执行」而不是「人取消」',
    Boolean(settledRows[2]) && text(settledRows[2]).includes('前置没成，未执行')
      && !text(settledRows[2]).includes('人取消'),
    settledRows[2] ? text(settledRows[2]).replace(/\s+/g, ' ') : 'missing')
  unmount(settledCard)

  /* ── 人取消：没有 dependency 原因时显示「人取消」 ── */

  cardBoardResponse = cardBoardPayload([cardBoardRow('t-human', 'g-human', 'cancelled', { cancel_reason: 'user' })])
  const humanCard = mount(cardReg('dispatch_launch_many').component, p1Props({
    group: 'g-human',
    launched: [{ task_id: 't-human', title: '人取消的任务', status: 'running', depends_on: [] }],
    note: '',
  }))
  update(humanCard)
  await clock.flush()
  update(humanCard)
  check('人取消显示「人取消」（与前置未执行分开）',
    text(humanCard.tree).includes('人取消') && !text(humanCard.tree).includes('前置没成'),
    text(cardOf(humanCard) || {}).replace(/\s+/g, ' '))
  unmount(humanCard)

  /* ── 降级：/board 返回形状不对时保留快照、不崩 ── */

  cardBoardMode = 'bad'
  const badCard = mount(cardReg('dispatch_launch_many').component, p1Props({
    group: 'g-bad',
    launched: [
      { task_id: 't-bad-1', title: '甲', status: 'running', depends_on: [] },
      { task_id: 't-bad-2', title: '乙', status: 'queued', depends_on: [] },
      { task_id: 't-bad-3', title: '丙', status: 'queued', depends_on: [] },
    ],
    note: '',
  }))
  update(badCard)
  await clock.flush()
  update(badCard)
  check('响应形状不对时卡片仍渲染、状态用派发快照（不白屏）',
    cardRowsOf(badCard).length === 3 && text(badCard.tree).includes('运行中'),
    cardOf(badCard) ? text(cardOf(badCard)).replace(/\s+/g, ' ') : 'missing')
  unmount(badCard)
  cardBoardMode = 'ok'

  /* ── 页面隐藏的全部 feed 都要停表（不是只停最后一个） ── */

  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-v-1', 'g-vis-a', 'running'),
    cardBoardRow('t-v-2', 'g-vis-b', 'running'),
  ])
  const visA = mount(cardReg('dispatch_launch_many').component, p1Props({
    group: 'g-vis-a', launched: [{ task_id: 't-v-1', title: 'A', status: 'running', depends_on: [] }], note: '',
  }))
  update(visA)
  await clock.flush()
  const visB = mount(cardReg('dispatch_launch_many').component, p1Props({
    group: 'g-vis-b', launched: [{ task_id: 't-v-2', title: 'B', status: 'running', depends_on: [] }], note: '',
  }))
  update(visB)
  await clock.flush()
  documentStub.visibilityState = 'hidden'
  documentStub.emit('visibilitychange')
  check('页面隐藏时所有 feed 一起停表（不是一个 group 一个监听器各停各的）',
    clock.size() === 0, `剩余 ${clock.size()}`)
  documentStub.visibilityState = 'visible'
  const beforeResume = cardBoardRequests().length
  documentStub.emit('visibilitychange')
  await clock.flush()
  check('恢复可见时每个 group 各补拉一次',
    cardBoardRequests().length === beforeResume + 2,
    `新增 ${cardBoardRequests().length - beforeResume} 次`)
  unmount(visA)
  unmount(visB)

  /* ═══ 17. ★ 单条派发（没有 group）：状态必须能从 running 变成 done ═══ */

  /*
   * ── 这条断言的由来（真机 bug，必须读） ──
   *
   * 用户实测：任务已经完成、报告都回来了，**派发卡上仍然显示「运行中」**。
   * 账本是正确的：`GET /board?task=t-mwi1e45s-1` 返回 `status: "done"`、
   * `settled_at: "2026-11-15T16:16:49.632Z"`；错的是客户端。
   *
   * 根因（真因是 A + C 的组合，A 是触发条件）：
   *
   *   A. **轮询根本没启动。** `group` 只由 `dispatch_launch_many` 生成
   *      （`src/tools.js`：`const group = \`g-${newTaskId()}\``）；单条
   *      `dispatch_launch` 返回 `{ task: card(task) }`，而 `card()` **不投影
   *      `group`**。所以单条卡的 `view.group === ''`，旧实现在这里
   *      `if (!group) return undefined`——**一个请求都不发**。卡片永远停在工具
   *      返回那一瞬间的快照上，而那个快照是派发瞬间的 `running`。
   *      证据：真机账本里那条任务 `group` 字段是空的（`?task=` 响应里没有
   *      `group` 键），而批量派发的任务都有 `g-…`。
   *
   *   C. **即使轮询起了，也没机会覆盖。** 这是同一个 bug 的第二半：卡片渲染时
   *      先拿 `block.content`（工具返回的一次性快照）算行，`/board` 数据只是
   *      「按 task_id 补充」。一旦 L1 的订阅条件为假，那段合并代码一次都不会跑，
   *      初始的 `running` 就永远是 `running`。
   *
   * 所以修复必须同时做两件事，缺一条这条断言就红：
   *   1. 作用域不再只看 group：没有 group 但有 task_id 时按 `?task=` 订阅；
   *   2. 合并仍然是**覆盖**语义（`mergeBatchRows` 里 `if (board.status) row.status = board.status`），
   *      不是「只补缺失字段」——只补缺失的话初始 `running` 永远盖不掉。
   *
   * ── 这条断言为什么在旧实现上一定红 ──
   *
   * 旧实现在 `group === ''` 时直接 `return undefined`，**连一次 fetch 都不会发**。
   * 下面的断言三件事一起查：
   *   ① 卡片确实发出了 `?task=t-solo-1` 的请求（旧实现：0 次 → 直接红）；
   *   ② 服务端把状态从 running 改成 done 后，卡片行文字变成「已完成」；
   *   ③ `data-card-ratio` 从 0/1 变成 1/1（聚合也真的重算了）。
   * ①②③ 里任何一条单独就够让旧实现红，三条一起是为了说清「不是碰巧过」。
   */
  const soloPayload = {
    // 注意：**没有 group 键**——这就是单条派发的真实返回体形状。
    task: { task_id: 't-solo-1', title: '单条派发的那一条', status: 'running' },
    depends_on: [],
    note: '',
  }
  cardBoardMode = 'ok'
  // 第一版响应：任务还在跑（卡片此刻的真实状态）。
  let soloStatus = 'running'
  cardBoardResponse = {
    version: '0.9.1',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 1, queued: 0, max: 6 },
    counts: {},
    archive_after_hours: 168,
    tasks: [cardBoardRow('t-solo-1', undefined, soloStatus)],
    truncated: null,
  }
  const soloRequestsBefore = cardTaskRequests().length
  const soloCard = mount(cardReg('dispatch_launch').component, {
    phase: 'result',
    callId: 'c-solo',
    toolName: 'dispatch_launch',
    block: { argsRaw: '', args: { title: '单条派发的那一条', brief: 'b' }, content: cardContent(soloPayload), isError: false },
  })
  update(soloCard)
  await clock.flush()
  update(soloCard)

  const soloRequests = cardTaskRequests().slice(soloRequestsBefore)
  check('★ 单条派发（没有 group）也会轮询：发出 ?task= 请求（旧实现 0 次，这条直接红）',
    soloRequests.length >= 1 && soloRequests.every((item) => item.url.includes('?task=t-solo-1')),
    JSON.stringify(soloRequests.map((item) => item.url)))
  check('（前置）单条卡此时显示「运行中」（来自 /board 的 running）',
    cardRowsOf(soloCard).some((row) => text(row).includes('运行中')),
    JSON.stringify(cardRowsOf(soloCard).map((row) => text(row).replace(/\s+/g, ' ').trim())))
  check('（前置）单条派发没有 group 时不显示 group 标记（不编造批次）',
    !findAll(soloCard.tree, (item) => item.props && item.props['data-card-group'])[0])

  /*
   * 服务端那边任务结算了：下一次轮询必须把 done **覆盖**上去。
   * 顺序刻意照真机走：先改响应、再推进时钟、等 tick 落地、再重渲染。
   */
  soloStatus = 'done'
  cardBoardResponse = {
    version: '0.9.1',
    generatedAt: new Date().toISOString(),
    concurrency: { running: 0, queued: 0, max: 6 },
    counts: {},
    archive_after_hours: 168,
    tasks: [cardBoardRow('t-solo-1', undefined, soloStatus, { settled_at: new Date().toISOString() })],
    truncated: null,
  }
  clock.advance(2000)
  await clock.flush()
  update(soloCard)

  const soloRows = cardRowsOf(soloCard)
  const soloRatio = findAll(soloCard.tree, (item) => item && item.props && item.props['data-card-ratio'] === 'true')[0]
  check('★★ 单条派发：初始 running → 轮询返回 done → 卡片显示「已完成」（本次 bug 的回归断言）',
    soloRows.length === 1 && text(soloRows[0]).includes('已完成') && !text(soloRows[0]).includes('运行中'),
    JSON.stringify(soloRows.map((row) => text(row).replace(/\s+/g, ' ').trim())))
  check('★ 单条派发：聚合也跟着从 0/1 变成 1/1（状态覆盖后聚合真的重算了）',
    Boolean(soloRatio) && text(soloRatio).trim() === '1/1',
    soloRatio ? text(soloRatio).trim() : 'missing')
  check('单条派发：结算后行不再可点（已结算的行点不开，与批量同一口径）',
    soloRows.length === 1 && soloRows[0].props['data-card-open'] === undefined,
    soloRows.length === 1 ? String(soloRows[0].props['data-card-open']) : 'missing')
  unmount(soloCard)

  /*
   * 反面：一条**批次**卡不能因为这条修复而多发一份 ?task= 请求。
   * 批次的成员本来就在 ?group= 那份数据里；再按 id 各订一遍，就是 N+1 次请求。
   */
  cardBoardMode = 'ok'
  cardBoardResponse = cardBoardPayload([
    cardBoardRow('t-p1-1', 'g-nosolo', 'running'),
    cardBoardRow('t-p1-2', 'g-nosolo', 'queued'),
  ])
  const noSoloBefore = cardBoardRequests().length
  const noSoloCard = mount(cardReg('dispatch_launch_many').component, p1Props(p1Payload('g-nosolo', ['queued', 'queued']).group
    ? { group: 'g-nosolo', launched: [
        { task_id: 't-p1-1', title: '甲', status: 'queued', depends_on: [] },
        { task_id: 't-p1-2', title: '乙', status: 'queued', depends_on: [] },
      ], note: '' }
    : {}))
  update(noSoloCard)
  await clock.flush()
  update(noSoloCard)
  const noSoloReqs = cardBoardRequests().slice(noSoloBefore)
  check('★ 有 group 的批次卡不再额外发 ?task= 请求（修复没有引入 N+1）',
    noSoloReqs.length >= 1 && noSoloReqs.every((item) => item.url.includes('?group=g-nosolo')),
    JSON.stringify(noSoloReqs.map((item) => item.url)))
  unmount(noSoloCard)
} finally {
  clock.uninstall()
  documentStub.visibilityState = 'visible'
  cardBoardMode = 'ok'
}

/* ── package.json 的注入清单 ── */

const pkg = JSON.parse(readFileSync(resolve(HERE, '..', 'dsh-mini-superagent', 'package.json'), 'utf8'))
const injectList = (pkg.dsh && pkg.dsh.client && Array.isArray(pkg.dsh.client.inject)) ? pkg.dsh.client.inject : []
check('package.json 的 dsh.client.inject 含 @deepseek-ai/dsh-client-ui-tool',
  injectList.includes('@deepseek-ai/dsh-client-ui-tool'), JSON.stringify(injectList))

/* ═════════════ 本轮派发摘要（常驻可见，不被工作详情折叠） ═════════════ */

/*
 * 为什么这一节必须存在：派发卡挂在 `tool.call.toolview`，那是工具调用树里的原子
 * 视图，必然随宿主的「工作详情」一起折叠——用户得先点开才看得见派了什么，正是
 * 要修的症状。所以真正的修复是 `conversation.chat.turnTail` 上的这条摘要，
 * 它落在 Turn 页脚（与「复制/重新生成」同层），**不在 process 分组里**。
 *
 * 这里断言的核心是**默认可见性**：不点任何东西、不展开任何折叠，关键信息
 * （批次标题 + 已完成/总数 + 前 2 条任务标题与状态）就已经在树里。
 */
console.log('\n本轮派发摘要：常驻可见 / 与卡片同源 / 降级（不被折叠）')

const tailRegs = () => registrations.filter((item) =>
  item.options && item.options.name === 'conversation.chat.turnTail')
const tailReg = () => tailRegs()[0]

check('conversation.chat.turnTail 注册一次', tailRegs().length === 1, `实际 ${tailRegs().length}`)
check('摘要注册带自己的稳定 id（不与 deliverables / plan / action-cards 抢同一条）',
  Boolean(tailReg()) && tailReg().options.id === 'dsh-mini-superagent/dispatch-tail',
  tailReg() ? String(tailReg().options.id) : 'missing')
check('摘要 id 与另外三个已知占用者都不同',
  Boolean(tailReg()) && ![
    '@deepseek-ai/dsh-client-ui-action-cards',
    '@deepseek-ai/dsh-client-ui-deliverables',
    '@deepseek-ai/dsh-client-ui-plan',
  ].includes(tailReg().options.id),
  tailReg() ? String(tailReg().options.id) : 'missing')

/**
 * 宿主 `TurnTailOwnerProps.turn` 的**真实形状**：`TurnLocation` 对象，不是数字。
 *
 * 权威定义（`app.asar` 内 `@deepseek-ai/dsh-client-ui-chat/src/client/contract/slots.ts`）：
 *
 *     export interface TurnTailOwnerProps {
 *       turn: TurnLocation
 *       seq: number
 *       openFile: (path: string) => void
 *     }
 *
 * 而 `TurnLocation`（`@deepseek-ai/dsh-client-ui-conversation/src/client/contract/conversation.ts`）：
 *
 *     export interface TurnLocation {
 *       readonly turn: number
 *       readonly start: SessionEvent<'turn/start'> | undefined
 *       readonly end: SessionEvent<'turn/end'> | undefined
 *       readonly status: 'open' | 'closed' | 'unknown'
 *       readonly steps: readonly StepLocation[]
 *       readonly data: ConversationLocationDataStore<ConversationTurnDataMap>
 *     }
 *
 * **这个 helper 就是当初那 bug 的教训**：旧断言喂的是 `turn: 3` 这种自造数字，
 * 于是 `typeof props.turn === 'number'` 在测试里恒为真、在真宿主里恒为假——
 * 589 项全绿但用户在会话里永远看不见摘要。凡是「宿主给的形状」，mock 必须照抄，
 * 不许为了让被测代码通过而简化。
 *
 * @param {number} turn 轮次序号
 * @returns {object} 与 `TurnLocation` 同形的只读对象
 */
function turnLocationOf(turn) {
  return {
    turn: turn,
    start: { type: 'turn/start', seq: turn * 100, time: Date.now(), data: { turn: turn } },
    end: { type: 'turn/end', seq: turn * 100 + 50, time: Date.now(), data: { turn: turn } },
    status: 'closed',
    steps: [],
    // `data` 是 keyed reader（`get` / `source`）；摘要不读 Turn 级业务值，这里给空实现。
    data: { get: () => undefined, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
  }
}

/**
 * 造一个「本轮工具调用」的 useChat：宿主页脚给的是 `{ turn, seq, openFile }`，
 * 其中 `turn` 是上面那个 `TurnLocation` 对象。
 *
 * `locations.getTurn(turn)` 要的是**数字序号**（`ChatLocationNodeIndex`：
 * `getTurn(turn: number): readonly string[]`），所以 stub 这里按数字比较 ——
 * 与宿主一致；生产代码必须先把对象里的 `.turn` 取出来再传进来。
 *
 * `nodes` 是一组 `{ key, name, root }`；只有 `tool-call` 节点会被扫到——
 * 这正是生产代码里那条判据，用假快照也守得住。
 */
function chatStubFor(turn, nodes) {
  const store = new Map(nodes.map((node) => [node.key, {
    kind: 'tool-call',
    data: { root: node.root },
  }]))
  const keys = nodes.map((node) => node.key)
  return {
    snapshot: {
      locations: { getTurn: (t) => (t === turn ? keys : []) },
      nodes: { get: (key) => store.get(key) },
      order: keys,
    },
  }
}

/** 一条 useChat：直接拿假快照喂选择器（等价宿主的 selector hook）。 */
function useChatOf(stub) {
  return function useChat(selector) { return selector(stub.snapshot) }
}

/** 一条真正的批量工具调用节点（result 阶段，与卡片看到的是同一份数据）。 */
function tailCall(key, name, args, content) {
  return {
    key,
    name,
    root: {
      kind: 'tool-result',
      callId: key,
      name,
      seq: 10,
      time: Date.now(),
      args,
      call: { name, argsRaw: JSON.stringify(args) },
      content,
      isError: false,
      subCalls: [],
    },
  }
}

const tailCard = tailReg() ? tailReg().component : null
check('摘要是函数组件（可作为 list 条目渲染）', typeof tailCard === 'function')

/* ── ① 默认可见：不点任何东西，标题 / 聚合 / 前 2 行都在 ── */

const tailArgs = manyArgs(4)
const tailStub = chatStubFor(3, [tailCall('c-tail-1', 'dispatch_launch_many', tailArgs, cardContent(batchResultFixture()))])
const tailTree = typeof tailCard === 'function'
  // `turn` 传**宿主真实形状**（对象），不是数字：见 `turnLocationOf` 的注释。
  ? mount(tailCard, { turn: turnLocationOf(3), seq: 99, useChat: useChatOf(tailStub) })
  : null
const tailRoot = tailTree
  ? findAll(tailTree.tree, (item) => item && item.props && item.props['data-dispatch-tail'] === 'true')[0]
  : null
check('摘要默认渲染（turnTail 槽里不给 useChat 也不白屏）', Boolean(tailRoot),
  tailTree ? text(tailTree.tree).slice(0, 200) : 'missing component')

const tailBody = tailTree ? text(tailTree.tree).replace(/\s+/g, ' ') : ''
const tailRatio = tailTree
  ? findAll(tailTree.tree, (item) => item && item.props && item.props['data-dispatch-tail-ratio'] === 'true')[0]
  : null
const tailRows = tailTree
  ? findAll(tailTree.tree, (item) => item && item.props && typeof item.props['data-dispatch-tail-row'] === 'string')
  : []
check('不展开任何折叠就能看到批次标题「派发 4 个任务」', tailBody.includes('派发 4 个任务'), tailBody.slice(0, 200))
check('不展开就能看到「已完成/总数」（2/4，与卡片同一口径）',
  Boolean(tailRatio) && text(tailRatio).trim() === '2/4', tailRatio ? text(tailRatio) : 'missing')
check('不展开就能看到前 2 条任务标题与状态',
  tailRows.length === 2 && tailBody.includes('拆分 auth/types.js') && tailBody.includes('拆分 auth/index.js')
    && tailBody.includes('运行中') && tailBody.includes('已完成'),
  JSON.stringify(tailRows.map((row) => text(row).replace(/\s+/g, ' ').trim())))
check('摘要默认只列 2 行（它不长成第二张卡）', tailRows.length === 2, `实际 ${tailRows.length}`)
const tailMoreBtn = tailTree
  ? findAll(tailTree.tree, (item) => item && item.props && item.props['data-dispatch-tail-more'] === 'true')[0]
  : null
check('剩下的用「还有 2 条」提示，且那个提示是**真 <button>**（不再是死文本）',
  tailBody.includes('还有 2 条')
    && Boolean(tailMoreBtn) && tailMoreBtn.type === 'button'
    // 摘要的折叠按钮与卡片的 `data-card-more` 必须是两个不同的节点：
    // 否则「摘要展开了」会被误当成「卡片展开了」。
    && !findAll(tailTree.tree, (item) => item && item.props && item.props['data-card-more'] === 'true')[0],
  tailBody.slice(0, 300))
check('折叠态 aria-expanded=false（读屏器能说出「现在只显示前 2 条」）',
  Boolean(tailMoreBtn) && tailMoreBtn.props['aria-expanded'] === false,
  tailMoreBtn ? String(tailMoreBtn.props['aria-expanded']) : 'missing')
check('摘要根是 role=group 且 aria-label 说明这是什么',
  Boolean(tailRoot) && tailRoot.props.role === 'group'
    && String(tailRoot.props['aria-label']).includes('4') && String(tailRoot.props['aria-label']).includes('2'),
  tailRoot ? String(tailRoot.props['aria-label']) : 'missing')
check('摘要不重复渲染卡片根（不会出现「同一批两张卡」）',
  tailTree ? !findAll(tailTree.tree, (item) => item && item.props && item.props['data-card-root'] === 'true')[0] : false)
/*
 * 头部必须**横向排布**：标题与 `已完成/总数` 是同一个 flex 容器的两个子节点。
 * 这条是用户「样式好丑 / 像调试输出」的**结构断言**——上一版把每个字段放进
 * 各自独立的块里垂直堆叠，光看渲染文本是看不出差别的（文本一模一样），
 * 只有盯住「它们是不是同一个容器的兄弟节点」才能钉住这件事。
 */
const tailHead = tailTree
  ? findAll(tailTree.tree, (item) => item && item.props && item.props['data-dispatch-tail-head'] === 'true')[0]
  : null
const tailHeadKids = tailHead && Array.isArray(tailHead.props.children) ? tailHead.props.children : []
check('头部标题与 done/total 在同一个 flex 容器内（横向一行，不是两个独立块）',
  Boolean(tailHead)
    && tailHeadKids.some((kid) => kid && hasClass(kid, 'dsh-sa-dr-title') && text(kid).includes('派发 4 个任务'))
    && tailHeadKids.some((kid) => kid && hasClass(kid, 'dsh-sa-dr-ratio') && text(kid).trim() === '2/4'),
  `head children ${tailHeadKids.length}：${JSON.stringify(tailHeadKids.map((kid) => text(kid).trim()).slice(0, 6))}`)
check('任务行同样横排：圆点 + 标题 + 状态是同一行的三个兄弟节点',
  tailRows.length === 2 && tailRows.every((row) => {
    const kids = Array.isArray(row.props.children) ? row.props.children : []
    return kids.some((kid) => hasClass(kid, 'dsh-sa-dr-name'))
      && kids.some((kid) => hasClass(kid, 'dsh-sa-dr-state'))
  }),
  JSON.stringify(tailRows.map((row) => (row.props.children || []).length)))
check('长标题有省略处理：行与标题节点都带完整 title 属性',
  tailRows.length === 2 && tailRows.every((row) => {
    const nameNode = (row.props.children || []).find((kid) => hasClass(kid, 'dsh-sa-dr-name'))
    // 省略是 CSS 的（text-overflow），所以「全文不丢」只能靠 title 属性保证；
    // 两个节点都带上，鼠标停在哪一段都能看到全文。
    return typeof row.props.title === 'string' && row.props.title.length > 0
      && Boolean(nameNode) && nameNode.props.title === row.props.title
      && text(nameNode).trim() === row.props.title
  }),
  JSON.stringify(tailRows.map((row) => row.props.title)))

/* ── ② 与卡片同源：同一份放在卡片里和摘要里得说同一句话 ── */

if (tailTree) {
  const sameDataCard = mount(cardReg('dispatch_launch_many').component, {
    phase: 'result',
    callId: 'c-tail-1',
    toolName: 'dispatch_launch_many',
    block: {
      argsRaw: JSON.stringify(tailArgs),
      args: tailArgs,
      content: cardContent(batchResultFixture()),
      isError: false,
    },
  })
  update(sameDataCard)
  const cardRatio = findAll(sameDataCard.tree, (item) => item && item.props && item.props['data-card-ratio'] === 'true')[0]
  check('摘要的聚合数字与卡片完全一致（同一套行模型，不各算一套）',
    Boolean(cardRatio) && Boolean(tailRatio) && text(cardRatio).trim() === text(tailRatio).trim(),
    `卡片 ${cardRatio ? text(cardRatio) : 'missing'} / 摘要 ${tailRatio ? text(tailRatio) : 'missing'}`)
  unmount(sameDataCard)
  unmount(tailTree)
}

/* ── ②b 展开 / 收起：「还有 N 条」必须真的能点开看到全部 ── */

/*
 * 这一节直接对应用户的第二条反馈：「没展开的也看不到」。
 *
 * 用 6 条（而不是 4 条）的批次：`CARD_TAIL_ROWS` 是 2，所以要藏 4 条——
 * 与用户截图里的「派发 6 个任务 / 还有 4 条」完全同形。断言必须真的**点**那个
 * 按钮再重新渲染，不能只检查「有没有按钮」：死文本也可以长得像个按钮。
 */
const expandStub = chatStubFor(21, [tailCall('c-exp', 'dispatch_launch_many', manyArgs(6), cardContent(manyPayload(6)))])
const expandTree = mount(tailCard, { turn: turnLocationOf(21), seq: 2101, useChat: useChatOf(expandStub) })
const tailRowCount = (root) => findAll(root.tree, (item) => item
  && item.props && typeof item.props['data-dispatch-tail-row'] === 'string').length
const tailMoreOf = (root) => findAll(root.tree, (item) => item
  && item.props && item.props['data-dispatch-tail-more'] === 'true')[0]

check('6 条批次默认只渲染 2 行 + 「还有 4 条」',
  tailRowCount(expandTree) === 2
    && text(expandTree.tree).replace(/\s+/g, ' ').includes('还有 4 条'),
  `行数 ${tailRowCount(expandTree)} / ${text(expandTree.tree).replace(/\s+/g, ' ').slice(0, 160)}`)
const expandBtn = tailMoreOf(expandTree)
check('「还有 4 条」是真 button 且能点（有 onClick）',
  Boolean(expandBtn) && expandBtn.type === 'button' && typeof expandBtn.props.onClick === 'function',
  expandBtn ? `type=${expandBtn.type} onClick=${typeof expandBtn.props.onClick}` : 'missing')
if (expandBtn) expandBtn.props.onClick()
update(expandTree)
check('点开之后渲染全部 6 行（剩下的 4 条不再是死文本）',
  tailRowCount(expandTree) === 6, `实际 ${tailRowCount(expandTree)}`)
check('点开后 aria-expanded=true（读屏器知道现在是展开态）',
  Boolean(tailMoreOf(expandTree)) && tailMoreOf(expandTree).props['aria-expanded'] === true,
  tailMoreOf(expandTree) ? String(tailMoreOf(expandTree).props['aria-expanded']) : 'missing')
check('点开后按钮文案变「收起」（带总数，展开后仍能一眼看到 6）',
  Boolean(tailMoreOf(expandTree)) && text(tailMoreOf(expandTree)).trim().includes('收起')
    && text(tailMoreOf(expandTree)).includes('6'),
  tailMoreOf(expandTree) ? text(tailMoreOf(expandTree)) : 'missing')
check('点开后 6 条任务标题与状态都能看到（不只是行数对）',
  ['任务 1', '任务 6', '排队中'].every((needle) => text(expandTree.tree).includes(needle))
    && !text(expandTree.tree).includes('还有 4 条'),
  text(expandTree.tree).replace(/\s+/g, ' ').slice(0, 200))
check('展开态记在根节点的 data 属性上（便于排障，不进 store）',
  Boolean(findAll(expandTree.tree, (item) => item && item.props
    && item.props['data-dispatch-tail-expanded'] === 'true')[0]))
const collapseBtn2 = tailMoreOf(expandTree)
if (collapseBtn2) collapseBtn2.props.onClick()
update(expandTree)
check('再点「收起」回到 2 行，aria-expanded 回 false',
  tailRowCount(expandTree) === 2
    && Boolean(tailMoreOf(expandTree)) && tailMoreOf(expandTree).props['aria-expanded'] === false,
  `行数 ${tailRowCount(expandTree)} / aria=${tailMoreOf(expandTree) ? String(tailMoreOf(expandTree).props['aria-expanded']) : 'missing'}`)
check('收起后「还有 4 条」又回来了',
  text(expandTree.tree).replace(/\s+/g, ' ').includes('还有 4 条'),
  text(expandTree.tree).replace(/\s+/g, ' ').slice(0, 160))
unmount(expandTree)

/* 展开后超过 12 条才加滚动容器：摘要不该把整页顶开。 */
const bigStub = chatStubFor(22, [tailCall('c-big', 'dispatch_launch_many', manyArgs(14), cardContent(manyPayload(14)))])
const bigTree = mount(tailCard, { turn: turnLocationOf(22), seq: 2201, useChat: useChatOf(bigStub) })
const bigBtn = tailMoreOf(bigTree)
if (bigBtn) bigBtn.props.onClick()
update(bigTree)
const bigList = findAll(bigTree.tree, (item) => item && item.props && item.props['data-dispatch-tail-list'] === 'true')[0]
check('展开超过 12 条时列表加滚动容器（max-height 由 CSS 给，不撑爆页面）',
  Boolean(bigList) && String(bigList.props.className).includes('dsh-sa-dr-list-scroll'),
  bigList ? String(bigList.props.className) : 'missing')
unmount(bigTree)

/* 2 条及以下没有可展开的东西：按钮不该出现（那会是个点了没反应的死按钮）。 */
const twoStub = chatStubFor(23, [tailCall('c-two', 'dispatch_launch_many', manyArgs(2), cardContent(manyPayload(2)))])
const twoTree = mount(tailCard, { turn: turnLocationOf(23), seq: 2301, useChat: useChatOf(twoStub) })
check('只有 2 条时不给展开按钮（没有藏起来的行就不该有这个按钮）',
  !tailMoreOf(twoTree) && tailRowCount(twoTree) === 2,
  `按钮 ${tailMoreOf(twoTree) ? '出现' : '缺失'} / 行数 ${tailRowCount(twoTree)}`)
unmount(twoTree)

/*
 * 轮次切换：展开态必须被重置，不能把上一轮的展开带进下一轮。
 *
 * 两个 stub 都必须**有 6 条**：如果新一轮是空的，摘要整体返回 null、
 * `tailRowCount` 也是 0，那条断言会因为「什么都没渲染」而假绿——它证明不了
 * 展开态被重置，只证明了「换轮之后没东西可画」。
 */
const turnResetStub = chatStubFor(24, [tailCall('c-t24', 'dispatch_launch_many', manyArgs(6), cardContent(manyPayload(6)))])
const turnResetStub25 = chatStubFor(25, [tailCall('c-t25', 'dispatch_launch_many', manyArgs(6), cardContent(manyPayload(6)))])
const turnResetTree = mount(tailCard, { turn: turnLocationOf(24), seq: 2401, useChat: useChatOf(turnResetStub) })
const turnResetBtn = tailMoreOf(turnResetTree)
if (turnResetBtn) turnResetBtn.props.onClick()
update(turnResetTree)
const expandedBefore = tailRowCount(turnResetTree)
// 换一轮：宿主在同一个位置重新渲染同一个组件（React 会复用实例）。
turnResetTree.props = { turn: turnLocationOf(25), seq: 2501, useChat: useChatOf(turnResetStub25) }
update(turnResetTree)
/*
 * 再 update 一次：**effect 里的 setState 在真实 React 里会触发一次重渲染**，
 * 而这个离线 stub 只提交 effect、不会自己重画。少了这一次，「turn 变了 → 收起」
 * 的效果永远来不及出现在树上（第一次 update 拿到的是 effect 之前的树）。
 * 这不是给被测代码开口子：真实宿主上那一次重渲染是 React 自己做的。
 */
update(turnResetTree)
const resetBtn = tailMoreOf(turnResetTree)
check('轮次切换后展开态被重置（回到 CARD_TAIL_ROWS 行，不带着上一轮的展开）',
  expandedBefore === 6
    && tailRowCount(turnResetTree) === 2
    // 新一轮的摘要必须**真的在**：否则这条只是「什么都没渲染」的假绿。
    && Boolean(findAll(turnResetTree.tree, (item) => item && item.props && item.props['data-dispatch-tail'] === 'true')[0])
    && Boolean(resetBtn) && resetBtn.props['aria-expanded'] === false,
  `切换前 ${expandedBefore} 行 / 切换后 ${tailRowCount(turnResetTree)} 行 / aria=${resetBtn ? String(resetBtn.props['aria-expanded']) : 'missing'}`)
unmount(turnResetTree)

/* ── ③ 空轮次：没有任何派发调用时什么都不画（不占位、不画空条） ── */

const emptyStub = chatStubFor(4, [])
const emptyTree = mount(tailCard, { turn: turnLocationOf(4), seq: 100, useChat: useChatOf(emptyStub) })
check('这一轮没派发时摘要返回 null（不占位、不画空条）',
  !findAll(emptyTree.tree, (item) => item && item.props && item.props['data-dispatch-tail'] === 'true')[0],
  text(emptyTree.tree).slice(0, 120))
unmount(emptyTree)

/* ── ④ 别的轮的派发不算进来 ── */

const otherTurnStub = chatStubFor(5, [tailCall('c-other', 'dispatch_launch_many', manyArgs(2), cardContent(manyPayload(2)))])
const otherTree = mount(tailCard, { turn: turnLocationOf(6), seq: 101, useChat: useChatOf(otherTurnStub) })
check('只统计本轮（turn 不匹配时不算进摘要）',
  !findAll(otherTree.tree, (item) => item && item.props && item.props['data-dispatch-tail'] === 'true')[0],
  text(otherTree.tree).slice(0, 120))
unmount(otherTree)

/* ── ⑤ 单条派发：标题用任务标题（与卡片同一口径） ── */

const singleTailArgs = { title: 'auth 令牌刷新', brief: 'b' }
const singleStub = chatStubFor(7, [tailCall('c-single', 'dispatch_launch', singleTailArgs, cardContent({
  task: { task_id: 't-single-1', title: 'auth 令牌刷新', status: 'running', depends_on: [] },
}))])
const singleTail = mount(tailCard, { turn: turnLocationOf(7), seq: 102, useChat: useChatOf(singleStub) })
const singleBody = text(singleTail.tree).replace(/\s+/g, ' ')
check('单条派发时摘要标题就是任务标题，且聚合是 0/1',
  singleBody.includes('auth 令牌刷新') && singleBody.includes('0/1'), singleBody.slice(0, 200))
unmount(singleTail)

/* ── ⑤b 回归：按 `TurnTailOwnerProps` **真实形状**（turn 为对象）必须渲染出内容 ── */

/*
 * 这一节是那个「注册成功但会话里永远看不见」bug 的**直接回归**。
 *
 * 旧实现写 `typeof props.turn === 'number'`，而宿主给的是 `TurnLocation` 对象，
 * 判据恒假 → 序号 -1 → 选择器立即返回空 → 组件永远 null。当时 589 项断言全绿，
 * 因为所有 mock 都喂的数字。所以这里**只喂宿主真实形状**，并且额外断言
 * `locations.getTurn()` 收到的是**数字**——把对象直接传进去同样会静默返回空
 * （`getTurn(turn: number)`），那是一条不报错的死路，必须单独钉住。
 */

const realArgs = manyArgs(4)
const realStub = chatStubFor(11, [tailCall('c-real-1', 'dispatch_launch_many', realArgs, cardContent(batchResultFixture()))])
// 记下 getTurn 实际收到的实参：它必须是数字，不能是 TurnLocation 对象。
const getTurnCalls = []
const realUseChat = (selector) => selector({
  locations: {
    getTurn: (t) => {
      getTurnCalls.push(t)
      return t === 11 ? ['c-real-1'] : []
    },
  },
  nodes: realStub.snapshot.nodes,
  order: ['c-real-1'],
})
const realTree = mount(tailCard, {
  // 宿主真实形状：turn 是 TurnLocation 对象（含 turn 数字、start/end、status、steps、data）。
  turn: turnLocationOf(11),
  seq: 1101,
  openFile: () => {},
  useChat: realUseChat,
})
const realRoot = findAll(realTree.tree, (item) => item && item.props && item.props['data-dispatch-tail'] === 'true')[0]
const realBody = text(realTree.tree).replace(/\s+/g, ' ')
const realRatio = findAll(realTree.tree, (item) => item && item.props && item.props['data-dispatch-tail-ratio'] === 'true')[0]
check('【回归】按 TurnTailOwnerProps 真实形状（turn 为 TurnLocation 对象）传参时，摘要渲染出内容',
  Boolean(realRoot) && realBody.includes('派发 4 个任务'), realBody.slice(0, 200) || '(空)')
check('【回归】真实形状下「已完成/总数」正确（2/4）',
  Boolean(realRatio) && text(realRatio).trim() === '2/4', realRatio ? text(realRatio) : 'missing')
check('【回归】真实形状下前 2 条任务标题也渲染出来',
  realBody.includes('拆分 auth/types.js') && realBody.includes('拆分 auth/index.js'), realBody.slice(0, 200))
check('【回归】getTurn() 收到的是数字序号，不是 TurnLocation 对象（传对象会静默返回空）',
  getTurnCalls.length > 0 && getTurnCalls.every((value) => typeof value === 'number' && value === 11),
  JSON.stringify(getTurnCalls))
check('【回归】摘要根上的 data-dispatch-tail-turn 是序号字符串',
  Boolean(realRoot) && realRoot.props['data-dispatch-tail-turn'] === '11',
  realRoot ? String(realRoot.props['data-dispatch-tail-turn']) : 'missing')
unmount(realTree)

/* ── ⑤c 兼容：宿主 rc 版本直接给数字 / 给 `{ index }` / 给垃圾时都不炸 ── */

const numericStub = chatStubFor(12, [tailCall('c-num', 'dispatch_launch_many', manyArgs(2), cardContent(manyPayload(2)))])
const numericTree = mount(tailCard, { turn: 12, seq: 1102, useChat: useChatOf(numericStub) })
check('兼容旧形状：turn 直接是数字时摘要照常渲染',
  Boolean(findAll(numericTree.tree, (item) => item && item.props && item.props['data-dispatch-tail'] === 'true')[0])
    && text(numericTree.tree).includes('派发 2 个任务'),
  text(numericTree.tree).replace(/\s+/g, ' ').slice(0, 160))
unmount(numericTree)

// `{ index }`：另一种宿主版本可能给的形状，兜底也要认。
const indexStub = chatStubFor(13, [tailCall('c-idx', 'dispatch_launch_many', manyArgs(2), cardContent(manyPayload(2)))])
const indexTree = mount(tailCard, { turn: { index: 13 }, seq: 1103, useChat: useChatOf(indexStub) })
check('兼容 { index } 形状：摘要照常渲染',
  Boolean(findAll(indexTree.tree, (item) => item && item.props && item.props['data-dispatch-tail'] === 'true')[0]),
  text(indexTree.tree).replace(/\s+/g, ' ').slice(0, 160))
unmount(indexTree)

// 认不出来的形状：安静不渲染，**绝不抛**（页脚还挂着复制/重新生成）。
let badShapeThrew = null
let badShapeTree = null
try {
  badShapeTree = mount(tailCard, { turn: { nope: true }, seq: 1104, useChat: useChatOf(numericStub) })
} catch (error) {
  badShapeThrew = error
}
check('认不出的 turn 形状不抛错，且不渲染摘要（安静降级）',
  badShapeThrew === null
    && !findAll(badShapeTree.tree, (item) => item && item.props && item.props['data-dispatch-tail'] === 'true')[0],
  badShapeThrew ? String(badShapeThrew) : text(badShapeTree.tree).slice(0, 120))
if (badShapeTree) unmount(badShapeTree)

/* ── ⑥ 降级：宿主不给 useChat（旧标准 hook 缺失）时安静返回 null，绝不抛 ── */

let noHookThrew = null
let noHookTree = null
try {
  noHookTree = mount(tailCard, { turn: turnLocationOf(8), seq: 103 })
} catch (error) {
  noHookThrew = error
}
check('拿不到 useChat（旧宿主）时摘要不抛错', noHookThrew === null,
  noHookThrew ? String(noHookThrew) : 'ok')
check('拿不到 useChat 时摘要渲染为空（页脚其余动作不受影响）',
  noHookTree
    ? !findAll(noHookTree.tree, (item) => item && item.props && item.props['data-dispatch-tail'] === 'true')[0]
    : true)
if (noHookTree) unmount(noHookTree)

/* ── ⑦ 自报：摘要槽进了 registered 且 cards.tail = on ── */

check('自报的 registered 含 conversation.chat.turnTail',
  Boolean(readyBody) && Array.isArray(readyBody.registered)
    && readyBody.registered.includes('conversation.chat.turnTail'),
  readyBody ? JSON.stringify(readyBody.registered) : 'null')
check('自报的 cards.tail = on（摘要的可观测字段，与 cards.batch 分开记）',
  Boolean(readyBody) && readyBody.cards && readyBody.cards.tail === 'on',
  readyBody ? JSON.stringify(readyBody.cards) : 'null')
check('摘要的结论不影响 cards.batch（仍为 on）',
  Boolean(readyBody) && readyBody.cards && readyBody.cards.batch === 'on',
  readyBody ? JSON.stringify(readyBody.cards) : 'null')

/* ── ⑧ 降级宿主：没有 turnTail 槽时摘要不注册，但卡片照旧 ── */

const noTailRegs = []
const noTailCtx = {
  get(name) {
    if (name === 'uiWorkspace') return uiWorkspace
    if (name === 'inputTriggers') return inputTriggers
    return undefined
  },
  effect(builder) {
    const dispose = typeof builder === 'function' ? builder() : undefined
    return () => { if (typeof dispose === 'function') dispose() }
  },
  logger: { info() {}, warn() {} },
  slots: {
    // 这个宿主有 tool.call.toolview，但**没有** conversation.chat.turnTail。
    inject(name, register) { if (name !== 'conversation.chat.turnTail') register() },
    register(options, component) {
      noTailRegs.push({ options, component })
      return () => {}
    },
  },
}
let noTailThrew = null
try {
  mod.apply(noTailCtx)
} catch (error) {
  noTailThrew = error
}
check('宿主没有 turnTail 槽时 apply 不抛错', noTailThrew === null, noTailThrew ? String(noTailThrew) : 'ok')
check('宿主没有 turnTail 槽时摘要一个都不注册',
  !noTailRegs.some((item) => item.options && item.options.name === 'conversation.chat.turnTail'),
  JSON.stringify(noTailRegs.map((item) => item.options && item.options.name)))
check('摘要缺席时派发卡照常注册（只降自己）',
  noTailRegs.filter((item) => item.options && item.options.name === 'tool.call.toolview').length === 2,
  JSON.stringify(noTailRegs.map((item) => item.options && item.options.name)))

/* ── ⑨ 摘要样式走主题 token，且不自带折叠按钮 ── */

/*
 * 样式断言用**源码切片**而不是渲染树（离线 stub 不解析 CSS）：只取 `.dsh-sa-dr {`
 * 到卡片样式块结束之间的那一段，检查它是否只使用 `--dsw-alias-*` 主题令牌。
 * 写死颜色在明暗两套主题下必有一边糊掉，而那种问题肉眼很难在暗色里发现。
 */
check('摘要样式只用 --dsw-alias-* 主题令牌（不写死颜色）',
  (() => {
    const start = source.indexOf('const CARD_STYLE =')
    const end = source.indexOf('卡片样式的单例节点', start)
    if (start < 0 || end < 0) return false
    const styleBlock = source.slice(start, end)
    const tailStart = styleBlock.indexOf('.dsh-sa-dr {')
    if (tailStart < 0) return false
    const tailBlock = styleBlock.slice(tailStart)
    const hardcoded = tailBlock.match(/#[0-9a-fA-F]{3,8}|rgb\(/g)
    return tailBlock.includes('--dsw-alias-') && hardcoded === null
  })())
check('摘要源码里没有第二处定义 TAIL_NO_CALLS（空值必须唯一，否则引用比较失效）',
  source.split('const TAIL_NO_CALLS = Object.freeze').length - 1 === 1,
  `实际 ${source.split('const TAIL_NO_CALLS = Object.freeze').length - 1} 处`)

/*
 * 「像调试输出」是个**布局**问题，离线渲染树里看不出来（文本一模一样）。
 * 所以这里直接对样式源码做切片断言：头部与任务行必须是 flex 横排，
 * 而且要真的用到 `text-overflow: ellipsis`（长标题靠它省略，全文靠 title 属性）。
 */
const tailCssBlock = (() => {
  const start = source.indexOf('const CARD_STYLE =')
  const end = source.indexOf('卡片样式的单例节点', start)
  if (start < 0 || end < 0) return ''
  const styleBlock = source.slice(start, end)
  const tailStart = styleBlock.indexOf('.dsh-sa-dr {')
  return tailStart < 0 ? '' : styleBlock.slice(tailStart)
})()
// 取某条选择器后面的规则体（到下一个 `}` 为止），避免「别处的 flex」误判通过。
function cssRuleOf(selector) {
  const at = tailCssBlock.indexOf(selector + ' {')
  if (at < 0) return ''
  return tailCssBlock.slice(at, tailCssBlock.indexOf('}', at) + 1)
}
check('头部规则是 flex 横排（不是 block 垂直堆叠）',
  /display:\s*flex/.test(cssRuleOf('.dsh-sa-dr-head'))
    && /align-items:\s*center/.test(cssRuleOf('.dsh-sa-dr-head')),
  cssRuleOf('.dsh-sa-dr-head').replace(/\s+/g, ' ').slice(0, 160))
check('任务行规则是 flex 横排且标题真的会省略',
  /display:\s*flex/.test(cssRuleOf('.dsh-sa-dr-row'))
    && /text-overflow:\s*ellipsis/.test(cssRuleOf('.dsh-sa-dr-name'))
    && /white-space:\s*nowrap/.test(cssRuleOf('.dsh-sa-dr-name')),
  cssRuleOf('.dsh-sa-dr-name').replace(/\s+/g, ' ').slice(0, 160))
check('摘要容器不铺卡片底色（`--dsw-alias-bg-layer-1` 是卡片自己的表面色）',
  !/background:\s*var\(--dsw-alias-bg-layer-1/.test(cssRuleOf('.dsh-sa-dr')),
  cssRuleOf('.dsh-sa-dr').replace(/\s+/g, ' ').slice(0, 200))
check('展开态超过 CARD_TAIL_MAX_VISIBLE 条时才有滚动容器',
  cssRuleOf('.dsh-sa-dr-list-scroll').includes('max-height')
    && cssRuleOf('.dsh-sa-dr-list-scroll').includes('overflow-y'),
  cssRuleOf('.dsh-sa-dr-list-scroll').replace(/\s+/g, ' ').slice(0, 160))
check('展开按钮的样式类只来自摘要自己的命名空间（不与卡片的 .dsh-sa-dc-more 混用）',
  tailCssBlock.includes('.dsh-sa-dr-more')
    && !tailCssBlock.includes('.dsh-sa-dc-more'), '')

/*
 * hook 顺序：`useChat` 是宿主有条件提供的标准 hook。**绝不能**写成
 * `typeof useChat === 'function' ? useChat(...) : …`——那是有条件调用 hook，
 * React 会抛「Rendered fewer hooks than expected」，把整条轮次页脚（含
 * 复制/重新生成）一起废掉。这层约束只能靠源码守：离线 stub 不跑真实 React。
 */
const dispatchTailSrc = source.slice(source.indexOf('function DispatchTail('), source.indexOf('function DispatchTailBody('))
// 先剥掉注释：这段注释本身就在解释「不要写 useChat(...)」，不剥会自己撞自己。
const dispatchTailCode = dispatchTailSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
check('DispatchTail 外层不做有条件 hook 调用（先判 useChat，再有 hook 的子组件）',
  !dispatchTailCode.includes('useChat(') && dispatchTailCode.includes('DispatchTailBody'),
  dispatchTailCode.replace(/\s+/g, ' ').slice(0, 200))

/* ═════════════ 报告卡（plans/13）：Definition / 认领范围 / 注册顺序 / 降级 ═════════════ */

/*
 * 这块只证明**认领链路**：一个最小 Definition 能注册、`match` 只命中自己的报告、
 * 独占认领的参数对、渲染器在 Definition 之前就位、以及三种降级各自成立。
 *
 * 它**不能**证明 G2 的五条真机标准（报告只出现一次 / 轮次导航正常 / compact 折叠
 * 一致 / 刷新后还在 / 热重载不重注册）——那五条只能在浏览器里看。特别是
 * 「先注册渲染器、再认领」这个顺序，离线只能验到「调用先后的观察顺序」，
 * 真正后果（认领了却没渲染器 = 消息消失）要真机才会暴露。
 */
console.log('\n报告卡：Definition / 认领范围 / 注册顺序 / 降级（plans/13 §8 / plans/14 §3.2）')

/**
 * 造一个能跑报告卡注册流程的宿主 ctx。
 *
 * 与前面的 `pendingCtx` 分开写，是因为这里要验的东西不一样：那条要验的是
 * 「槽什么时候回放」，这条要验的是**服务与槽的有无**，以及**调用先后**。
 *
 * @param {object} options
 * - `withService`：是否提供 `uiConversation`（`false` = 旧宿主，没有这个服务）；
 * - `withNodeSlot`：是否提供 `conversation.chat.node` 槽；
 * - `throwOnRenderer`：渲染器注册抛错的槽名；
 * - `throwOnDefinition`：`events.register` 抛错；
 * - `throwOnInject`：`ctx.inject` 自己抛（依赖名不认）。
 */
function reportCtx(options) {
  const opts = options || {}
  const order = []
  const rendererRegs = []
  const definitions = []
  const disposals = []
  const warns = []
  const ctx = {
    order,
    rendererRegs,
    definitions,
    disposals,
    warns,
    get(name) {
      if (name === 'uiWorkspace') return uiWorkspace
      if (name === 'inputTriggers') return inputTriggers
      return undefined
    },
    effect(builder, label) {
      const dispose = typeof builder === 'function' ? builder() : undefined
      if (typeof dispose === 'function') disposals.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    logger: { info() {}, warn() { warns.push(Array.prototype.slice.call(arguments).join(' ')) } },
    slots: {
      inject(name, register) {
        if (name === 'conversation.chat.node' && opts.withNodeSlot === false) return
        register()
      },
      register(registerOptions, component) {
        if (opts.throwOnRenderer && registerOptions && registerOptions.name === opts.throwOnRenderer) {
          throw new Error('duplicate key')
        }
        // `order` 只记报告卡这条链上的两个动作：别的槽（看板/图标/派发卡）与此无关，
        // 记进来只会让「先渲染器后认领」这条断言被七八个无关条目淹没。
        if (registerOptions && registerOptions.name === 'conversation.chat.node') order.push('renderer')
        rendererRegs.push({ options: registerOptions, component })
        return () => { order.push('dispose-renderer') }
      },
    },
  }
  if (opts.withService !== false) {
    ctx.uiConversation = {
      events: {
        register(definition) {
          if (opts.throwOnDefinition) throw new Error('duplicate kind')
          order.push('definition')
          definitions.push(definition)
          return () => {}
        },
      },
    }
  }
  if (opts.throwOnInject) {
    ctx.inject = function () { throw new Error('unknown dependency uiConversation') }
  } else {
    /*
     * 宿主真实的 `ctx.inject(['uiConversation'], cb)`：服务就绪后**在子 scope 上调** cb。
     * 这里同步回放（最常见的情形），并把同一个 ctx 传进去——子 scope 继承全部服务，
     * 所以 `scopeCtx.slots` 与本 ctx 等价。
     */
    ctx.inject = function (deps, callback) {
      if (opts.withService === false) return
      callback(ctx)
    }
  }
  return ctx
}

/**
 * 一条本插件 relay 报告的假 `user/message` 事件（形状照 SessionEvent）。
 *
 * ⚠️ `id` 必须是**真机那种两层拼接**的形状，不能是 `t-xxx:relay:...`：
 * `dispatch.js:2548` 先算 `requestId = nextMessageId(task.id,'relay')`，然后
 * `sessions.js:105,115` 又把它拼成 `` `${SOURCE_KIND}:${requestId}` ``。落到事件上的
 * `data.id` 因此是 `dsh-mini-superagent:<taskId>:relay:<BOOT>:<seq>`。
 * 用短 fixture 会让「取第一段」这个真机 bug 在离线断言里**照样通过**——那正是它当初
 * 漏过去的原因。
 */
function relayEvent(overrides) {
  const base = {
    type: 'user/message',
    seq: 42,
    time: 1700000000000,
    data: {
      id: 'dsh-mini-superagent:t-m0abc-1:relay:boot:1',
      role: 'user',
      content: [{ type: 'text', text: '【任务】做完了\n总结：全部通过' }],
      source: { kind: 'dsh-mini-superagent', form: 'relay' },
    },
  }
  const patch = overrides || {}
  return Object.assign({}, base, patch, {
    data: Object.assign({}, base.data, patch.data || {}),
  })
}

/**
 * `ui-chat` 的 `groupTree` 深度表（`contract/group-tree.ts` 的 `DEPTH` 逐字照抄）。
 *
 * 为什么要在这里重建它：断言 `groupTree === 'turn'` 只锁住「写的是哪个字」，
 * 锁不住「这个字意味着什么」——而真机出问题的恰恰是语义（`undefined` 被理解成
 * 「并入 step run」，于是被算成过程内容）。所以再补一层语义断言：
 * 节点必须 **at-or-outside `'turn'`**，这才是 `ChatNodeSeat` / `turn-process-presentation`
 * 判定「不进过程区」的真正判据。
 */
const GROUP_TREE_DEPTH = { exchange: 0, input: 1, turn: 2, process: 3 }

/** 与 `ui-chat` 的 `isAtOrOutside` 同义：位置在该处或更外层。 */
function isAtOrOutside(node, position) {
  return node.groupTree !== undefined && GROUP_TREE_DEPTH[node.groupTree] <= GROUP_TREE_DEPTH[position]
}

/* ── ① 有 uiConversation 时注册一次，kind / target 对 ── */

const reportHost = reportCtx({})
let reportThrew = null
try { mod.apply(reportHost) } catch (error) { reportThrew = error }
check('宿主有 uiConversation 时 apply 不抛错', reportThrew === null, reportThrew ? String(reportThrew) : 'ok')
check('events.register 被调用一次', reportHost.definitions.length === 1,
  `实际 ${reportHost.definitions.length}`)
const reportDef = reportHost.definitions[0]
check('Definition kind === dispatch-report', Boolean(reportDef) && reportDef.kind === 'dispatch-report',
  reportDef ? String(reportDef.kind) : 'missing')
check('Definition target === chat', Boolean(reportDef) && reportDef.target === 'chat',
  reportDef ? String(reportDef.target) : 'missing')
check('Definition 声明了 buildViewNode（target 与它必须成对出现）',
  Boolean(reportDef) && typeof reportDef.buildViewNode === 'function')

/* ── ② match 命中本插件 relay 消息 → exclusive: true ── */

const hit = reportDef ? reportDef.match(relayEvent()) : null
check('match 命中本插件 relay 消息', hit !== null && hit.role === 'start', JSON.stringify(hit))
check('命中的 match 返回 exclusive: true（独占认领，不然会和 context 行重复）',
  Boolean(hit) && hit.exclusive === true, JSON.stringify(hit))
check('命中的 match 用 message id 当 id',
  Boolean(hit) && hit.id === 'dsh-mini-superagent:t-m0abc-1:relay:boot:1', hit ? String(hit.id) : 'missing')

/* ── ③ match 不命中：人类消息 / 非 relay / 别的 source.kind / developer/message ── */

const humanHit = reportDef ? reportDef.match(relayEvent({ data: { source: { kind: 'user' } } })) : 'no-def'
check('match 不命中人类消息（source.kind=user）', humanHit === null, JSON.stringify(humanHit))
const formHit = reportDef
  ? reportDef.match(relayEvent({ data: { source: { kind: 'dsh-mini-superagent', form: 'message' } } }))
  : 'no-def'
check('match 不命中 form !== relay（认领范围必须只剩报告）', formHit === null, JSON.stringify(formHit))
const otherKindHit = reportDef
  ? reportDef.match(relayEvent({ data: { source: { kind: 'dsh-free-search', form: 'relay' } } }))
  : 'no-def'
check('match 不命中别的插件 source.kind（不许抢别家的消息）', otherKindHit === null, JSON.stringify(otherKindHit))
const devHit = reportDef ? reportDef.match(relayEvent({ type: 'developer/message' })) : 'no-def'
check('match 不命中 developer/message', devHit === null, JSON.stringify(devHit))
const noSourceHit = reportDef ? reportDef.match(relayEvent({ data: { source: undefined } })) : 'no-def'
check('match 不命中没有 source 的用户消息（不能靠 undefined 猜）',
  noSourceHit === null, JSON.stringify(noSourceHit))

/* ── ④ buildViewNode：groupTree 必须在 'turn' 层、anchorSeq 等于事件 seq ── */

const startMatch = { event: relayEvent(), role: 'start', location: { kind: 'step', turn: {}, step: {} } }
const state = reportDef ? reportDef.start({}, startMatch) : null
const viewNode = reportDef
  ? reportDef.buildViewNode({ key: 'k:1', kind: 'dispatch-report', id: hit && hit.id, start: startMatch, state, matches: [startMatch] })
  : null
check('buildViewNode 返回 kind=dispatch-report 的节点',
  Boolean(viewNode) && viewNode.kind === 'dispatch-report', viewNode ? String(viewNode.kind) : 'missing')
check('buildViewNode 的 target 是 chat', Boolean(viewNode) && viewNode.target === 'chat')
check('anchorSeq 等于事件 seq（轮次分隔线/导航按它定位）',
  Boolean(viewNode) && viewNode.anchorSeq === 42, viewNode ? String(viewNode.anchorSeq) : 'missing')
/*
 * 真机返工点（plans/14 §5 G2 第 3 条）：`groupTree` 曾经是 `undefined`，
 * 于是被 `ui-chat` 当成「并入 step run」→ 算进过程内容 → 随工作详情一起折叠。
 * 这里同时锁「值」和「语义」：值必须逐字是 `'turn'`，且 must be at-or-outside `'turn'`。
 */
check('groupTree === "turn"（留在本轮、但不属于本轮过程区，不被折叠）',
  Boolean(viewNode) && viewNode.groupTree === 'turn', viewNode ? String(viewNode.groupTree) : 'missing')
check('groupTree 的语义是 at-or-outside "turn"（这才是 ui-chat 判定「不进过程区」的判据）',
  Boolean(viewNode) && isAtOrOutside(viewNode, 'turn'),
  viewNode ? `groupTree=${String(viewNode.groupTree)}` : 'missing')
check('groupTree 不是 "input"（否则会触发 hasInterleavedInput，把整轮工作详情强制展开）',
  Boolean(viewNode) && viewNode.groupTree !== 'input')
check('groupTree 不是 "exchange"（否则这条报告会开启新 exchange、重分轮次段）',
  Boolean(viewNode) && viewNode.groupTree !== 'exchange')
check('location 原样透传 start.location（不自己算）',
  Boolean(viewNode) && viewNode.location === startMatch.location)
check('visibility 是 visible', Boolean(viewNode) && viewNode.visibility === 'visible')
/*
 * taskId 必须剥掉包名前缀再取段：真机 `data.id` 是
 * `dsh-mini-superagent:t-m0abc-1:relay:boot:1`，取第一段会得到包名本身
 * （S3 真机上看到的就是「任务 dsh-mini-superagent」这个错值）。
 */
check('data 里带得出来 task id（先剥包名前缀，再取下一段）',
  Boolean(viewNode) && viewNode.data && viewNode.data.taskId === 't-m0abc-1',
  viewNode && viewNode.data ? String(viewNode.data.taskId) : 'missing')
check('taskId 不是包名（这个 bug 真机上出现过：显示成 dsh-mini-superagent）',
  Boolean(viewNode) && viewNode.data && viewNode.data.taskId !== 'dsh-mini-superagent',
  viewNode && viewNode.data ? String(viewNode.data.taskId) : 'missing')
check('state 没准备好时 buildViewNode 返回 null（不许画一个空壳）',
  Boolean(reportDef) && reportDef.buildViewNode({ key: 'k', kind: 'dispatch-report', id: 'i', start: undefined, state: undefined, matches: [] }) === null)

/* ── 注册顺序：渲染器必须在 Definition 之前 ── */

check('注册顺序是「先 renderer、后 definition」（反了会丢消息）',
  reportHost.order.join('>') === 'renderer>definition', reportHost.order.join('>'))
check('渲染器注册在 conversation.chat.node 上、key 等于 Definition 的 kind',
  reportHost.rendererRegs.filter((item) => item.options && item.options.name === 'conversation.chat.node').length === 1
    && reportHost.rendererRegs.filter((item) => item.options && item.options.name === 'conversation.chat.node')[0].options.key === 'dispatch-report',
  JSON.stringify(reportHost.rendererRegs.map((item) => item.options)))
check('渲染器是可渲染的函数组件', (() => {
  const reg = reportHost.rendererRegs.find((item) => item.options && item.options.name === 'conversation.chat.node')
  return Boolean(reg) && typeof reg.component === 'function'
})())
check('注册成功后 cards.report === on（键存在且是 on，不是「未提供」）',
  Boolean(lastReadyBody()) && lastReadyBody().cards.report === 'on',
  JSON.stringify(lastReadyBody() ? lastReadyBody().cards : null))

/* ── 渲染器：正式版的卡片（plans/13 §七）── */

/*
 * 这一段开始验**卡片内容**（S3 验的是认领链路）。
 *
 * 用户对这一版的核心诉求写在最前面，也是下面每条断言背后的判据：
 * 「**做完必须比原来的灰色 context 行信息更多、可读性更好**。如果只是位置变好
 * 但内容变少，不值得。」原来的 context 行会显示完整四段正文，所以这里最先钉住的
 * 不是「卡片长得对」，而是「**内容一点都不少**」。
 */

const reportReg = reportHost.rendererRegs.find((item) => item.options && item.options.name === 'conversation.chat.node')
const reportRow = reportReg ? mount(reportReg.component, { node: viewNode }) : null
const reportTreeText = reportRow ? text(reportRow.tree) : ''
check('渲染器画的是卡片根（data-report-card），不是 spike 那行替身',
  Boolean(reportRow) && findAll(reportRow.tree, (item) => item && item.props && item.props['data-report-card'] === 'true').length === 1,
  reportTreeText.slice(0, 120))
check('spike 的临时标记已彻底移除（data-report-spike 一个都不许剩）',
  Boolean(reportRow) && findAll(reportRow.tree, (item) => item && item.props && item.props['data-report-spike'] !== undefined).length === 0)
check('卡头显示任务短标签（来自【任务】段），不是 task id',
  reportTreeText.includes('做完了'), reportTreeText.replace(/\s+/g, ' ').slice(0, 120))
check('卡头显示短 task id 且已剥包名前缀',
  Boolean(reportRow) && findAll(reportRow.tree, (item) => item && item.props && item.props['data-report-id'] === 't-m0abc-1').length === 1
    && !reportTreeText.includes('dsh-mini-superagent'),
  reportTreeText.replace(/\s+/g, ' ').slice(0, 160))
if (reportRow) unmount(reportRow)

/* ═════════════════════ 报告卡正式版：四形态解析 + 结构化渲染 ═════════════════════ */

/*
 * 判据来源：plans/13 §3.2（四种文本形态）、§8.2（解析契约）、§十二（验收）。
 *
 * 这里的 fixture **照 `voice.js` 的产出形状写**，不是手写的理想文本：
 *   `reportText()`  → 【任务】/【结果】/【说明】?/【需要你】?/【细节】
 *   `batchText()`   → 【批次】/ 比例行 / · 成了：… / · 没成：… /【需要你】?/【细节】?
 *   `failureText()` → `<标签>：没能开始——<原因>。要我重试吗？`
 *   `idleText()`    → `<标签>：它跑完了，但没给结论——…` /【说明】?/【细节】
 *
 * 为什么不用「手写的漂亮文本」：那样断言只能证明「我的解析器认识我的 fixture」，
 * 而真实报告是 `voice.js` 拼出来的，漏掉任何一个真实形状（比如 idleText 会推
 * **两行**【说明】、batchText 的比例行没有段名）都会在真机上才暴露。
 */
console.log('\n报告卡正式版：四形态解析 / 原文兜底 / 缺段 / 折叠 / 复制 / 状态 chip')

/** 挂一张报告卡：走 Definition 的 start → buildViewNode → 渲染器，端到端一条链。 */
function renderReport(rawText, options) {
  const opts = options || {}
  const id = opts.id || 'dsh-mini-superagent:t-rc-1:relay:boot:7'
  const event = relayEvent({ data: { id, content: [{ type: 'text', text: rawText }] } })
  const match = { event, role: 'start', location: { kind: 'step', turn: {}, step: {} } }
  const state = reportDef.start({}, match)
  const node = reportDef.buildViewNode({ key: 'k:rc', kind: 'dispatch-report', id, start: match, state, matches: [match] })
  return { state, node, row: mount(reportReg.component, { node }) }
}

/** 直接打解析器（`content` 可以故意是脏形状，验「任何输入都不抛错」）。 */
function parseReportForTest(rawText) {
  const content = rawText === undefined || rawText === null
    ? rawText
    : (typeof rawText === 'string' ? [{ type: 'text', text: rawText }] : rawText)
  const event = relayEvent({ data: { content } })
  return reportDef.start({}, { event, role: 'start', location: { kind: 'step', turn: {}, step: {} } }).card
}

/** 卡片里所有带某个 `data-report-*` 标记的元素。 */
function reportMarks(row, key) {
  return findAll(row.tree, (item) => item && item.props && item.props[key] !== undefined)
}

/* ── ① 单任务报告：段名齐全、内容出现在正确位置 ── */

const FIXTURE_REPORT = [
  '【任务】报告卡修复验证',
  '【结果】占位文件已建好，报告卡可检查',
  '【说明】按简报先 Start-Sleep 10 秒；这一步只是为了让卡片在真机上停留可看',
  '【需要你】定一下：要不要把 10 秒去掉？',
  '【细节】dispatch_inspect t-rc-1',
].join('\n')
const singleReportCard = renderReport(FIXTURE_REPORT)
check('单任务报告被识别成 shape=report（不是原文兜底）',
  singleReportCard.state.card.shape === 'report', String(singleReportCard.state.card.shape))
check('单任务报告：标题取【任务】的值',
  singleReportCard.state.card.title === '报告卡修复验证', singleReportCard.state.card.title)
check('单任务报告：结果取【结果】的值',
  singleReportCard.state.card.result === '占位文件已建好，报告卡可检查', String(singleReportCard.state.card.result))
check('单任务报告：说明原样保留（不压缩、不改写）',
  singleReportCard.state.card.note === '按简报先 Start-Sleep 10 秒；这一步只是为了让卡片在真机上停留可看',
  String(singleReportCard.state.card.note))
check('单任务报告：需要你取【需要你】的值',
  singleReportCard.state.card.need === '定一下：要不要把 10 秒去掉？', String(singleReportCard.state.card.need))
check('单任务报告：inspectId 从【细节】里取到（校验过 t-/g- 形状）',
  singleReportCard.state.card.inspectId === 't-rc-1', String(singleReportCard.state.card.inspectId))
const singleReportText = text(singleReportCard.row.tree).replace(/\s+/g, ' ')
check('单任务卡渲染出结果段（data-report-result）',
  reportMarks(singleReportCard.row, 'data-report-result').length === 1)
check('单任务卡渲染出需要你段（data-report-need）',
  reportMarks(singleReportCard.row, 'data-report-need').length === 1)
check('单任务卡渲染出说明段（data-report-note）',
  reportMarks(singleReportCard.row, 'data-report-note').length === 1)
check('单任务卡的正文里四段内容全都在（标题 / 结果 / 说明 / 需要你）',
  singleReportText.includes('占位文件已建好') && singleReportText.includes('Start-Sleep 10 秒')
    && singleReportText.includes('要不要把 10 秒去掉') && singleReportText.includes('报告卡修复验证'),
  singleReportText.slice(0, 240))
/*
 * 段落 DOM 顺序是**信息重要性顺序**（plans/13 §7.4）：结果在最上面（用户第一眼要读到
 * 的那句），说明在中间，需要你紧贴折叠的细节之下（它是唯一要人动手的地方，
 * 不能沉在正文中部被跳读略过）。
 */
check('单任务卡段落顺序是 结果 → 说明 → 需要你',
  (() => {
    const seen = []
    walk(singleReportCard.row.tree, (item) => {
      if (!item || !item.props) return
      if (item.props['data-report-result'] !== undefined) seen.push('result')
      if (item.props['data-report-note'] !== undefined) seen.push('note')
      if (item.props['data-report-need'] !== undefined) seen.push('need')
    })
    return seen.join('>') === 'result>note>need'
  })())
unmount(singleReportCard.row)

/* ── ② 解析不了 → 原文卡，且内容**完整**（本组最重要的一条） ── */

/*
 * 这条是本块最高优先的断言。为什么它比「四种形态都渲染对」更重要：
 * 四种形态渲染错，用户看到的是「排版怪」；兜底丢内容，用户看到的是
 * **「它说过的话不见了」**，而且不会有人去比对原文。
 *
 * 三种触发方式都验：首行不认识 / 行首认识但中段混入意外行 / 完全不是报告。
 */
const UNKNOWN_FIXTURES = [
  ['首行不是任何已知段名', '这是一段完全不像报告的自由文本\n第二行\n第三行'],
  ['首行像报告但中段混入意外行', '【任务】某任务\n【结果】做完了\n这一行没有段名，解析器不该吞掉它'],
  ['旧版本写入的老消息', '老格式报告：\n结论：好\n说明：无'],
  ['单行乱码', '??'],
]
for (const [why, fixture] of UNKNOWN_FIXTURES) {
  const card = renderReport(fixture)
  const shown = findAll(card.row.tree, (item) => item && item.props && item.props['data-report-raw'] === 'true')
  const shownText = shown.length ? text(shown[0]) : ''
  check(`解析不了 → 原文卡（${why}）`,
    card.state.card.shape === 'unknown' && shown.length === 1,
    `shape=${card.state.card.shape} rawBlocks=${shown.length}`)
  check(`原文卡内容完整、一行不少（${why}）`,
    fixture.split('\n').every((line) => shownText.includes(line.trim())),
    `期望每行都在，实际：${shownText.replace(/\s+/g, ' ').slice(0, 200)}`)
  unmount(card.row)
}
const emptyCard = renderReport('')
check('空正文不崩、也不画一张空白卡（给一句「没有正文」）',
  emptyCard.state.card.shape === 'unknown'
    && findAll(emptyCard.row.tree, (item) => item && item.props && item.props['data-report-empty'] === 'true').length === 1,
  text(emptyCard.row.tree))
unmount(emptyCard.row)

/* ── ③ 缺段不占位 ── */

const NO_NEED = ['【任务】只成了一半', '【结果】跑完了', '【说明】没需要你', '【细节】dispatch_inspect t-rc-2'].join('\n')
const noNeedCard = renderReport(NO_NEED)
check('缺【需要你】时不渲染那个区块（不是渲染一个空盒子）',
  noNeedCard.state.card.need === undefined
    && reportMarks(noNeedCard.row, 'data-report-need').length === 0,
  text(noNeedCard.row.tree).replace(/\s+/g, ' ').slice(0, 160))
check('缺段不影响其它段（结果 / 说明仍然在）',
  text(noNeedCard.row.tree).includes('跑完了') && text(noNeedCard.row.tree).includes('没需要你'))
unmount(noNeedCard.row)

const headOnlyCard = renderReport('【任务】只有首行')
check('只有首行时只显示卡头，不崩、不画空段',
  headOnlyCard.state.card.shape === 'report'
    && headOnlyCard.state.card.result === undefined
    && reportMarks(headOnlyCard.row, 'data-report-result').length === 0
    && text(headOnlyCard.row.tree).includes('只有首行'),
  text(headOnlyCard.row.tree).replace(/\s+/g, ' ').slice(0, 160))
unmount(headOnlyCard.row)

/* ── ④ 批次汇总：3/4 比例 + 成了 / 没成 两组 ── */

const FIXTURE_BATCH = [
  '【批次】重构这批 4 条',
  '4 条成了 3 条，1 条没成。',
  '· 成了：登录超时、接口重试、日志清理',
  '· 没成：补集成测试（连不上压测环境）',
  '【需要你】1 条没成，看看要重试、换做法，还是先放着？',
  '【细节】dispatch_inspect 按任务查（批次 g-t-rc-9）',
].join('\n')
const batchCard = renderReport(FIXTURE_BATCH, { id: 'dsh-mini-superagent:g-t-rc-9:relay:boot:8' })
const batchCardText = text(batchCard.row.tree).replace(/\s+/g, ' ')
check('批次汇总被识别成 shape=batch', batchCard.state.card.shape === 'batch', String(batchCard.state.card.shape))
check('批次卡头显示 3/4 比例（来自报告文本本身，不是聚合猜的）',
  Boolean(batchCard.state.card.ratio) && batchCard.state.card.ratio.ok === 3 && batchCard.state.card.ratio.total === 4
    && reportMarks(batchCard.row, 'data-report-ratio').length === 1,
  JSON.stringify(batchCard.state.card.ratio))
check('批次卡渲染「成了」组',
  reportMarks(batchCard.row, 'data-report-group').some((item) => item.props['data-report-group'] === 'ok'))
check('批次卡渲染「没成」组',
  reportMarks(batchCard.row, 'data-report-group').some((item) => item.props['data-report-group'] === 'failed'))
check('批次卡里两组的名单都在（登录超时 / 补集成测试）',
  batchCardText.includes('登录超时') && batchCardText.includes('补集成测试'), batchCardText.slice(0, 240))
check('批次卡的 group id 取到的是 g-t-rc-9（不是包名）',
  batchCard.state.card.taskId === 'g-t-rc-9', String(batchCard.state.card.taskId))
check('批次卡也渲染【需要你】',
  reportMarks(batchCard.row, 'data-report-need').length === 1)
unmount(batchCard.row)

/*
 * 认不出的组名**不猜语义**（plans/13 §8.2 第 3 条）：归 `other` 并保留原标签与原文。
 * 这一条守的是「将来文案加了新组」的场景——那种情况下内容仍然看得见。
 */
const OTHER_GROUP = ['【批次】新组名', '2 条成了 1 条，1 条部分完成。', '· 部分完成：半个活'].join('\n')
const otherGroupCard = renderReport(OTHER_GROUP)
check('认不出的组名归 other 且原标签、原文都保留',
  otherGroupCard.state.card.groups.length === 1
    && otherGroupCard.state.card.groups[0].kind === 'other'
    && otherGroupCard.state.card.groups[0].label === '部分完成'
    && otherGroupCard.state.card.groups[0].text === '半个活'
    && text(otherGroupCard.row.tree).includes('部分完成'),
  JSON.stringify(otherGroupCard.state.card.groups))
unmount(otherGroupCard.row)

/* ── ⑤ 启动失败 / 跑完没结论 ── */

const failureCard = renderReport('auth 令牌刷新：没能开始——模型侧 503。要我重试吗？')
check('启动失败被识别成 shape=failure',
  failureCard.state.card.shape === 'failure', String(failureCard.state.card.shape))
check('启动失败：卡头是任务短标签（只取冒号前那一段）',
  failureCard.state.card.title === 'auth 令牌刷新', String(failureCard.state.card.title))
check('启动失败：原因原样显示（含「没能开始」与「要我重试吗」）',
  text(failureCard.row.tree).includes('没能开始——模型侧 503') && text(failureCard.row.tree).includes('要我重试吗'),
  text(failureCard.row.tree).replace(/\s+/g, ' ').slice(0, 160))
unmount(failureCard.row)

const IDLE_TEXT = [
  '日志清理：它跑完了，但没给结论——要我追问一句吗？',
  '【说明】它最后动过 logs/ 目录；没有别的文本输出',
  '【说明】这是第二条说明（idleText 会推两行）',
  '【细节】dispatch_inspect t-rc-3',
].join('\n')
const idleCard = renderReport(IDLE_TEXT)
check('跑完没结论被识别成 shape=idle',
  idleCard.state.card.shape === 'idle', String(idleCard.state.card.shape))
check('idle 卡：两行【说明】都保留（不是后者覆盖前者）',
  Boolean(idleCard.state.card.note)
    && idleCard.state.card.note.includes('logs/ 目录')
    && idleCard.state.card.note.includes('第二条说明'),
  String(idleCard.state.card.note))
check('idle 卡：卡头是任务短标签',
  idleCard.state.card.title === '日志清理', String(idleCard.state.card.title))
unmount(idleCard.row)

/* ── ⑥ 【细节】原生 <details> 折叠（非受控） ── */

/*
 * ⚠️ 这一节守的是一条**被误判过 4 次**的结论，改之前先把来龙去脉读完。
 *
 * 事实：`<details>` + `<summary>` 这条折叠条一直是**好的**，用户原话是
 * 「细节按钮是完全有效的，也是折叠的」。真正坏的是别的东西，而当时的修复
 * 把这段折叠整个删成了「直接铺开原文 + max-height 滚动」——删错了对象。
 *
 * 那次误判的**真因**（后来定位到的）：渲染时给 `<details>` 传了 `open`。
 * 那是受控写法。卡片在报告回流、状态 chip 变化、宿主虚拟滚动重挂时都会
 * 重渲染，React 每次都用那个陈旧的 `open` 值把浏览器刚展开的属性**写回去**，
 * 用户看到的是「点开了，一眨眼又收回去」，而且**全程不报错**。
 *
 * 所以这一节的断言不是「点一下能展开」——那条在离线 stub 里怎么写都通，
 * 证明不了真机（这正是第二版 785 项全绿、真机仍然没反应的教训）。
 * 真正有牙的是第 3 条：**点开 → 强制父级重渲染两次 → 仍然展开**。
 * 它专门检测「受控 open 把展开态写回」这个唯一的真因：
 *
 *   · 非受控实现（不传 open）：重渲染不碰 open 属性 → 断言绿；
 *   · 受控实现（传了 open）：重渲染把它写回 false → 断言红。
 *
 * 为了让这条断言真的能区分两者，下面写了一个**极简 details DOM 模型**：
 * 它按真实 React 的规则更新 open——只有 props 里**存在** `open` 键时才写回，
 * 不存在就一律不动（浏览器自己管）。下面还有一条自检断言，把 `open: false`
 * 喂给这个模型，证明它确实会红——一条永远不会红的回归断言等于没有。
 */

/**
 * 极简 `<details>` 语义模型（模拟真实 DOM 上那个 `open` 属性）。
 *
 * 为什么要自己建模型而不是直接看 props：`open` 到底有没有生效，取决于它
 * **跨重渲染**是保留还是被写回——那是 DOM 节点上的状态，不是元素对象上的字段。
 * stub 每次渲染都造新元素，所以需要一张按 `key` 索引的「DOM 侧」状态表。
 */
function makeDetailsDom(row) {
  const openState = new Map()
  const nodes = new Map()
  function sync() {
    let index = 0
    findAll(row.tree, (item) => Boolean(item) && item.type === 'details').forEach((node) => {
      const key = node.props && node.props.key !== undefined ? String(node.props.key) : '#' + (index++)
      nodes.set(key, node)
      // React 的受控判定：props 里**存在** open 键才算受控，不存在就不碰 DOM 属性。
      const controlled = Object.prototype.hasOwnProperty.call(node.props || {}, 'open')
      if (!openState.has(key) || controlled) {
        openState.set(key, controlled ? Boolean(node.props.open) : (openState.get(key) || false))
      }
    })
    return nodes
  }
  return {
    sync,
    keys: () => Array.from(nodes.keys()),
    node: (key) => nodes.get(key),
    isOpen: (key) => Boolean(openState.get(key)),
    /** 浏览器原生行为：点一次 summary 翻转 open（不经过任何 JS 状态）。 */
    click(key) {
      if (!nodes.has(key)) throw new Error('没有 details 节点：' + key)
      openState.set(key, !openState.get(key))
    },
  }
}

const detailCard = renderReport(FIXTURE_REPORT)
const detailMarks = (key) => reportMarks(detailCard.row, key)
const detailDom = makeDetailsDom(detailCard.row)
detailDom.sync()

/**
 * 报告卡样式表的源码切片。
 *
 * 离线 stub 不解析 CSS，「箭头由 [open] 驱动」「折叠体不再叠 max-height」
 * 这类约定只能用源码断言。取 `const CARD_STYLE =` 到样式块结束之间那一段，
 * 与上面几节的做法一致（同一份切片规则，避免两处漂移）。
 */
const CARD_STYLE_TEXT = (() => {
  const start = source.indexOf('const CARD_STYLE =')
  const end = source.indexOf('卡片样式的单例节点', start)
  return start < 0 || end < 0 ? '' : source.slice(start, end)
})()

/* ── A. 初始状态：收起 ── */

/*
 * 收起态判据用两条：`details` 节点在、且它的 props 里**没有** open。
 * 不看「有没有 open 属性且为 false」——传 `open: false` 也是受控，正是要防的写法。
 */
const detailDetails = detailDom.keys().map((key) => detailDom.node(key))[0]
check('★【细节】卡片里有 details 折叠体（细节按钮回来了）',
  Boolean(detailDetails) && detailDetails.type === 'details',
  detailDetails ? String(detailDetails.type) : 'missing')
check('★【细节】初始是收起的：details 的 props 里没有 open 属性',
  Boolean(detailDetails) && !Object.prototype.hasOwnProperty.call(detailDetails.props, 'open'),
  detailDetails ? JSON.stringify({ hasOwnOpen: Object.prototype.hasOwnProperty.call(detailDetails.props, 'open') }) : 'missing')
check('★【细节】初始收起时原文不可见（浏览器收起 details 就不显示内容区）',
  detailDom.isOpen('detail') === false && Boolean(detailMarks('data-report-detail-raw')[0]),
  JSON.stringify({ open: detailDom.isOpen('detail'), raw: Boolean(detailMarks('data-report-detail-raw')[0]) }))

const detailToggle = detailMarks('data-report-detail-toggle')[0]
check('【细节】折叠条是 summary（原生可点，不需要 JS 事件）',
  Boolean(detailToggle) && detailToggle.type === 'summary',
  detailToggle ? String(detailToggle.type) : 'missing')
check('【细节】折叠条上的文案是「细节」（report.detail 还在）',
  Boolean(detailToggle) && text(detailToggle).includes('细节'),
  detailToggle ? text(detailToggle).trim() : 'missing')
const detailCaret = detailToggle
  ? findAll(detailToggle, (item) => item && item.props && item.props.className === 'dsh-sa-rc-caret')[0]
  : undefined
check('【细节】折叠条里有一个 caret 元素（箭头挂点）',
  Boolean(detailCaret),
  detailCaret ? 'present' : 'missing')
check('★【细节】caret 里没有 JS 写死的字形（▸/▾ 由 CSS 的 content 提供）',
  Boolean(detailCaret) && text(detailCaret) === '',
  detailCaret ? JSON.stringify(text(detailCaret)) : 'missing')

/* ── B. 点一下展开 ── */

detailDom.click('detail')
update(detailCard.row)
detailDom.sync()

check('★【细节】点 summary 后 details 打开（open = true）',
  detailDom.isOpen('detail') === true, String(detailDom.isOpen('detail')))
const openedRaw = detailMarks('data-report-detail-raw')[0]
check('★【细节】展开后原文可见，且是**完整 raw**（四段全在，一行不少）',
  detailDom.isOpen('detail') === true && Boolean(openedRaw)
    && FIXTURE_REPORT.split('\n').every((line) => text(openedRaw).includes(line)),
  openedRaw ? text(openedRaw).replace(/\s+/g, ' ').slice(0, 200) : 'missing')
check('【细节】原文是 pre（等宽 + pre-wrap，缩进换行与原文一致）',
  Boolean(openedRaw) && openedRaw.type === 'pre',
  openedRaw ? String(openedRaw.type) : 'missing')
check('【细节】原文节点上没有 onClick（它是内容，不是控件）',
  Boolean(openedRaw) && openedRaw.props.onClick === undefined,
  openedRaw ? typeof openedRaw.props.onClick : 'missing')

/* ── C. ★ 关键回归：展开后再重渲染两次，仍然展开 ── */

/*
 * ⭐ 这一条是整节的**触发器**，也是那 4 次失败唯一能离线复现的检测器。
 *
 * 做法就是真实宿主的做法：展开之后卡片还会因为别的原因重渲染（报告回流、
 * 状态 chip 变化、虚拟滚动重挂）。这里连续 `update()` 两次，等价于那两帧。
 *
 *   · 非受控（不传 open）→ 渲染不碰 open 属性 → 浏览器保持展开 → 绿；
 *   · 受控（传了 open）→ 每次渲染把 open 写回陈旧值 → 收回 → 红。
 *
 * 下面的 D 段还有一条**自检**：把 `open: false` 喂给同一个模型，证明它确实会红。
 * 没有那条自检，这条断言可能只是「永远不会失败的摆设」。
 */
update(detailCard.row)
update(detailCard.row)
detailDom.sync()

check('★【细节】点击展开 → 强制重渲染两次 → 仍然展开（受控写法会在这里红）',
  detailDom.isOpen('detail') === true,
  JSON.stringify({ open: detailDom.isOpen('detail') }))
const settledRaw = detailMarks('data-report-detail-raw')[0]
check('★【细节】两次重渲染后原文仍然完整（没有被收回或截断）',
  detailDom.isOpen('detail') === true && Boolean(settledRaw)
    && FIXTURE_REPORT.split('\n').every((line) => text(settledRaw).includes(line)),
  settledRaw ? text(settledRaw).replace(/\s+/g, ' ').slice(0, 160) : 'missing')

/* ── D. 自检：这个模型真的能抓到「传了 open」的写法 ── */

/*
 * 用一棵**手工构造的受控树**喂给同一个模型：`open: false` 写在 props 里。
 * 模拟「用户点开 → 父级重渲染」，模型按 React 的规则把 open 写回 false——
 * 于是展开态被收回。这证明 C 段那条断言对受控实现是**有牙的**。
 */
const controlledProbeRow = {
  tree: {
    type: 'div',
    props: {
      children: [{
        type: 'details',
        props: {
          key: 'detail',
          open: false,
          children: [{ type: 'summary', props: { children: ['细节'] } }, { type: 'pre', props: { children: ['原文'] } }],
        },
      }],
    },
  },
}
const controlledProbe = makeDetailsDom(controlledProbeRow)
controlledProbe.sync()
controlledProbe.click('detail')
controlledProbe.sync()
controlledProbe.sync()
check('★[自检] 受控写法（传 open:false）点开后重渲染会被收回 —— 证明上一条断言有牙',
  controlledProbe.isOpen('detail') === false,
  JSON.stringify({ openAfterRerender: controlledProbe.isOpen('detail') }))

/* ── E. 再点一下收起 ── */

detailDom.click('detail')
update(detailCard.row)
detailDom.sync()

check('★【细节】再点 summary 收起（open = false）',
  detailDom.isOpen('detail') === false, String(detailDom.isOpen('detail')))
check('【细节】收起后原文再次不可见',
  detailDom.isOpen('detail') === false, String(detailDom.isOpen('detail')))

/* ── F. 源码反向断言：不许再写成受控 ── */

/*
 * 运行时断言只能守住「现在没传」，源码断言守住「将来也别传回来」。
 * 之所以要两条：`open` 可以写成 `open: undefined`、`open: detailOpen`、
 * 或者被一个 spread 带进来，运行时那条 `hasOwnProperty` 未必拦得住同样的坑。
 */
const detailSourceBlock = (() => {
  const at = sourceNoComments.indexOf("'details'")
  const end = sourceNoComments.indexOf('const foot = []', at)
  return at < 0 || end < 0 ? '' : sourceNoComments.slice(at, end)
})()
check('★[反] details 那一段源码里没有 open: 赋值（防受控回归）',
  detailSourceBlock.length > 0 && !/[{,]\s*open\s*:/.test(detailSourceBlock),
  detailSourceBlock ? 'len=' + detailSourceBlock.length : 'slice failed')
check('[反] details 上没有 onToggle（展开态不交给 JS 管）',
  detailSourceBlock.length > 0 && !/onToggle/.test(detailSourceBlock))
check('[反] details 上没有 open 变量的绑定（不存在 detailOpen 之类的 state）',
  detailSourceBlock.length > 0 && !/detailOpen|setDetailOpen|open:\s*[A-Za-z_$]/.test(detailSourceBlock))
check('[反] 兜底原文卡与折叠卡用的是不同的 class（折叠卡不再被限高）',
  source.includes('dsh-sa-rc-raw dsh-sa-rc-raw-plain'),
  'data-report-raw 需要独有的 dsh-sa-rc-raw-plain')

/* ── G. 箭头 / 折叠条的 CSS 约定 ── */

/*
 * 箭头必须由 CSS 的 `[open]` 后代选择器驱动，不能写死在 JS 里：
 * 字形一旦变成 React 状态，就又要靠一次重渲染去更新它，而重渲染正是
 * 上面那段事故的入口。让 CSS 跟着 DOM 属性走，浏览器自己管。
 */
check('★【细节】箭头默认是 ▸（CSS ::before 提供）',
  /\.dsh-sa-rc-caret::before\s*\{[^}]*content:\s*'▸'/s.test(CARD_STYLE_TEXT),
  '需要 .dsh-sa-rc-caret::before { content: \'▸\' }')
check('★【细节】展开时箭头变成 ▾，由 [open] 后代选择器驱动',
  /\.dsh-sa-rc-detail\[open\]\s+\.dsh-sa-rc-caret::before\s*\{[^}]*content:\s*'▾'/s.test(CARD_STYLE_TEXT),
  '需要 .dsh-sa-rc-detail[open] .dsh-sa-rc-caret::before { content: \'▾\' }')
check('★【细节】折叠条去掉了浏览器默认 marker（display:flex + list-style:none + ::-webkit-details-marker）',
  /\.dsh-sa-rc-detail-toggle\s*\{[^}]*display:\s*flex[^}]*list-style:\s*none/s.test(CARD_STYLE_TEXT)
    && /\.dsh-sa-rc-detail-toggle::-webkit-details-marker\s*\{[^}]*display:\s*none/s.test(CARD_STYLE_TEXT),
  '三条缺一不可，否则原生三角会和 CSS 箭头同时出现')
check('★[反] 折叠体不再叠 max-height + overflow（避免两层滚动）',
  !/\.dsh-sa-rc-raw\s*\{[^}]*max-height:/s.test(CARD_STYLE_TEXT),
  '折叠本身就是长度管理，.dsh-sa-rc-raw 不该再限高')
check('【细节】兜底原文卡仍有限高 + 滚动（它没有折叠，长文必须收住）',
  /\.dsh-sa-rc-raw-plain\s*\{[^}]*max-height:[^;}]+;[^}]*overflow:\s*auto;/s.test(CARD_STYLE_TEXT)
    && /\.dsh-sa-rc-raw-plain\s*\{[^}]*overscroll-behavior:\s*contain/s.test(CARD_STYLE_TEXT),
  'raw-plain 需同时有 max-height、overflow: auto 与 overscroll-behavior: contain')

/* ── H. 兜底卡（解析失败）不受影响 ── */

/*
 * 兜底卡（`shape === 'unknown'`）走的是**另一条渲染分支**（data-report-raw），
 * 与【细节】折叠无关。这条守的是「改了【细节】别把兜底卡带坏」——
 * 兜底卡是整张卡最后的保命绳，它坏了就是真的丢内容。
 */
const unknownStill = renderReport('这行不是任何已知段名\n第二行\n第三行')
check('【细节】改动不影响解析失败卡（data-report-raw 仍在、content 完整）',
  findAll(unknownStill.row.tree, (item) => item && item.props && item.props['data-report-raw'] === 'true').length === 1
    && text(unknownStill.row.tree).includes('第二行'),
  text(unknownStill.row.tree).replace(/\s+/g, ' ').slice(0, 160))
check('【细节】未知形态**不**额外渲染折叠块（原文已经整段显示过了，不该重复一遍）',
  reportMarks(unknownStill.row, 'data-report-detail-raw').length === 0
    && findAll(unknownStill.row.tree, (item) => item && item.type === 'details').length === 0,
  JSON.stringify({
    raw: reportMarks(unknownStill.row, 'data-report-detail-raw').length,
    details: findAll(unknownStill.row.tree, (item) => item && item.type === 'details').length,
  }))
unmount(unknownStill.row)

unmount(detailCard.row)

/* ── I. 宿主会反复挂/摘：重挂回来是**收起**态，不是半开 ── */

/*
 * 宿主虚拟滚动会把卡片整棵摘掉再挂回来。因为展开态完全归浏览器管（没有
 * 任何 React 状态缓存它），重挂回来必然是收起的初值——这是**正确**行为，
 * 也是「没有任何旧 state 能把展开态弄成半开」的证明。
 */
const remountCard = renderReport(FIXTURE_REPORT)
const remountDom = makeDetailsDom(remountCard.row)
remountDom.sync()
update(remountCard.row)
update(remountCard.row)
remountDom.sync()
check('★【细节】重挂载后是收起态（展开态不由任何 JS state 缓存）',
  remountDom.isOpen('detail') === false, String(remountDom.isOpen('detail')))
check('★【细节】重挂载后原文仍完整在 DOM 里（收起不等于丢内容）',
  FIXTURE_REPORT.split('\n').every((line) => text(remountCard.row.tree).includes(line)),
  text(remountCard.row.tree).replace(/\s+/g, ' ').slice(0, 160))
unmount(remountCard.row)



/* ── J. 【说明】原生 <details> 折叠（非受控） ── */

/*
 * ⚠️ 这一节守的是一条**被误判过 5 次**的结论。改之前先把上面【细节】那一节
 * 和下面这段话读完。
 *
 * 用户原话（第 5 次报同一件事）：
 *   「不是说细节能展开，而是细节按钮上面有个展开按钮，点了没效果。」
 *
 * 也就是说：【细节】那条 `<details>` 一直是**好的**，坏的是【说明】下面那个
 * 「展开」——它当时是 `button` + `noteOpen` state。这与【细节】早期的受控 bug
 * 是**同一个真因**，只是换了控件：展开态存在 React state 里，而卡片在报告回流、
 * 状态 chip 变化、宿主虚拟滚动重挂时都会重渲染；渲染一旦被当成纯函数调、
 * 或者 state 被一份陈旧快照写回，`onClick` 更新出来的值下一帧就没了——
 * 于是「点了没反应」，而且**全程不报错**。
 *
 * 所以这里的断言与【细节】同构，用同一个 `makeDetailsDom` 模型：
 *   · 初始：长说明有折叠条、且 details 的 props 里**没有** open（非受控）；
 *   · 点一下：第二段出现；
 *   · ★ 点开 → 强制父级重渲染两次 → 仍然展开（受控写法的唯一检测器）；
 *   · 内容完整性：head + rest 恒等于全文，收起时也不丢字。
 */

/** 【说明】长到需要折叠的样例：5 行说明，超过 REPORT_NOTE_LINES = 3。 */
const LONG_NOTE = [
  '第一行说明：按简报先跑一遍离线用例，确认基线是绿的。',
  '第二行说明：然后只改 client/index.js 与 scripts/client-smoke.mjs 两个文件。',
  '第三行说明：不要碰 src/** 与 package.json，也不要 git commit。',
  '第四行说明：这一行是折叠起来的部分，展开后才应该看见。',
  '第五行说明：这一行也是折叠起来的部分，用来验证尾部没有丢字。',
].join('\n')
/*
 * ⚠️ 每一行都必须带 `【说明】` 前缀。解析器（`parseReportSingle`）遇到**任何**
 * 认不出的行就整份退回原文卡——那是它故意的严格性（见 `parseReportText` 注释），
 * 不是这里要测的东西。曾经这里把 `LONG_NOTE` 整段接在第一个 `【说明】` 后面，
 * 于是第 2–5 行成了「意外行」，卡片退化成原文卡、`note-more` 根本不存在，
 * 十来个断言一起红且看起来像实现坏了。与 ⑤ 段 `IDLE_TEXT` 的写法保持一致：
 * 多行说明 = 多行 `【说明】`，解析器会用 `\n` 把它们接回完整说明。
 */
const FIXTURE_LONG_NOTE = [
  '【任务】说明折叠验证',
  '【结果】按钮换成原生 details',
  ...LONG_NOTE.split('\n').map((line) => '【说明】' + line),
  '【细节】dispatch_inspect t-rc-note',
].join('\n')

const noteCard = renderReport(FIXTURE_LONG_NOTE)
const noteDom = makeDetailsDom(noteCard.row)
noteDom.sync()

/* ── J-1. 初始状态：折叠条在、内容被收起、头部仍然可见 ── */

const noteDetails = noteDom.node('note-more')
check('★【说明】长说明渲染出 details 折叠体（不再是 button + state）',
  Boolean(noteDetails) && noteDetails.type === 'details',
  noteDetails ? String(noteDetails.type) : 'missing')
check('★【说明】初始是收起的：details 的 props 里没有 open 属性（非受控）',
  Boolean(noteDetails) && !Object.prototype.hasOwnProperty.call(noteDetails.props, 'open'),
  noteDetails ? JSON.stringify({ hasOwnOpen: Object.prototype.hasOwnProperty.call(noteDetails.props, 'open') }) : 'missing')

const noteToggle = reportMarks(noteCard.row, 'data-report-note-toggle')[0]
check('★【说明】折叠条是 summary（原生可点，不需要 JS 事件）',
  Boolean(noteToggle) && noteToggle.type === 'summary',
  noteToggle ? String(noteToggle.type) : 'missing')
check('【说明】折叠条上没有 onClick（展开态不交给 React 管）',
  Boolean(noteToggle) && noteToggle.props.onClick === undefined,
  noteToggle ? typeof noteToggle.props.onClick : 'missing')
check('【说明】折叠条文案是「展开」（report.expand 仍在用）',
  Boolean(noteToggle) && text(noteToggle).includes('展开'),
  noteToggle ? text(noteToggle).trim() : 'missing')
check('【说明】折叠条里没有 JS 写死的字形（箭头仍由 CSS 提供）',
  (() => {
    const caret = noteToggle
      ? findAll(noteToggle, (item) => item && item.props && item.props.className === 'dsh-sa-rc-caret')[0]
      : undefined
    return Boolean(caret) && text(caret) === ''
  })())

/*
 * 头部（前 3 行）**必须在 details 外面**：塞进去的话收起态的浏览器会把
 * 它一起隐藏，用户就只剩一条「展开」按钮可看——那等于把说明藏了。
 */
const noteHeadMarks = reportMarks(noteCard.row, 'data-report-note')
check('★【说明】收起态下头部说明仍然可见（头部不在 details 里）',
  noteHeadMarks.length === 1
    && !findAll(noteDetails, (item) => item === noteHeadMarks[0]).length
    && text(noteHeadMarks[0]).includes('第一行说明'),
  noteHeadMarks.length ? text(noteHeadMarks[0]).replace(/\s+/g, ' ').slice(0, 120) : 'missing')
check('【说明】收起态下头部只显示前 3 行（折叠真的截断了显示）',
  noteHeadMarks.length === 1
    && !text(noteHeadMarks[0]).includes('第四行说明')
    && !text(noteHeadMarks[0]).includes('第五行说明'),
  noteHeadMarks.length ? text(noteHeadMarks[0]).replace(/\s+/g, ' ').slice(0, 160) : 'missing')

const noteRestMark = reportMarks(noteCard.row, 'data-report-note-rest')[0]
check('【说明】折叠体里是尾段（第四 / 第五行都在，收起只是被浏览器隐藏）',
  Boolean(noteRestMark)
    && text(noteRestMark).includes('第四行说明')
    && text(noteRestMark).includes('第五行说明'),
  noteRestMark ? text(noteRestMark).replace(/\s+/g, ' ').slice(0, 160) : 'missing')

/* ── J-2. 点一下：完整说明可见 ── */

noteDom.click('note-more')
update(noteCard.row)
noteDom.sync()

check('★【说明】点 summary 后 details 打开（open = true）',
  noteDom.isOpen('note-more') === true, String(noteDom.isOpen('note-more')))
check('★【说明】展开后完整说明可见（五段一行不少）',
  noteDom.isOpen('note-more') === true
    && LONG_NOTE.split('\n').every((line) => text(noteCard.row.tree).includes(line)),
  text(noteCard.row.tree).replace(/\s+/g, ' ').slice(0, 240))

/* ── J-3. ★ 关键回归：展开后再重渲染两次，仍然展开 ── */

/*
 * ⭐ 这一条是整节的触发器。它与【细节】那条是**同一个检测器**，只是换了控件。
 *
 *   · 非受控（不传 open）→ 渲染不碰 open 属性 → 浏览器保持展开 → 绿；
 *   · 受控（传了 open: noteOpen）→ 每次渲染把 open 写回陈旧值 → 收回 → 红。
 *
 * 开发时已按简报第 4 条做过**反向验证**：临时把实现改回受控写法
 * （给 details 加 `open: false`，等价于陈旧 state），这条断言立刻变红，
 * 然后已还原。没有那次反向验证，这条断言可能只是「永远不会失败的摆设」。
 */
update(noteCard.row)
update(noteCard.row)
noteDom.sync()

check('★【说明】点击展开 → 强制重渲染两次 → 仍然展开（受控写法会在这里红）',
  noteDom.isOpen('note-more') === true,
  JSON.stringify({ open: noteDom.isOpen('note-more') }))
check('★【说明】两次重渲染后完整说明仍然在（没有被收回或截断）',
  noteDom.isOpen('note-more') === true
    && LONG_NOTE.split('\n').every((line) => text(noteCard.row.tree).includes(line)),
  text(noteCard.row.tree).replace(/\s+/g, ' ').slice(0, 200))

/* ── J-4. 自检：这个模型真的能抓到「传了 open」的写法 ── */

/*
 * 与 D 段同一个思路，但**用的是【说明】这个 key**：手工构造一棵受控的
 * note-more 树喂给同一个模型，证明 J-3 那条断言对受控实现是有牙的。
 */
const noteControlledProbeRow = {
  tree: {
    type: 'div',
    props: {
      children: [
        { type: 'p', props: { children: ['第一行说明'] } },
        {
          type: 'details',
          props: {
            key: 'note-more',
            open: false,
            children: [
              { type: 'summary', props: { children: ['展开'] } },
              { type: 'p', props: { children: ['第四行说明'] } },
            ],
          },
        },
      ],
    },
  },
}
const noteControlledProbe = makeDetailsDom(noteControlledProbeRow)
noteControlledProbe.sync()
noteControlledProbe.click('note-more')
noteControlledProbe.sync()
noteControlledProbe.sync()
check('★[自检]【说明】受控写法（传 open:false）点开后重渲染会被收回 —— 证明上一条断言有牙',
  noteControlledProbe.isOpen('note-more') === false,
  JSON.stringify({ openAfterRerender: noteControlledProbe.isOpen('note-more') }))

/* ── J-5. 再点一下收起 ── */

noteDom.click('note-more')
update(noteCard.row)
noteDom.sync()
check('★【说明】再点 summary 收起（open = false）',
  noteDom.isOpen('note-more') === false, String(noteDom.isOpen('note-more')))

/* ── J-6. 内容完整性：折叠不改变说明文本本身 ── */

const noteBlockNode = findAll(noteCard.row.tree, (item) => hasClass(item, 'dsh-sa-rc-note-block'))[0]
const noteBlockText = text(noteBlockNode || noteCard.row.tree).replace(/\s+/g, ' ')
const flatNote = LONG_NOTE.replace(/\s+/g, ' ')
check('★【说明】折叠/展开状态变化不影响说明文本（完整文本恒在 DOM 里）',
  flatNote.split('。').filter(Boolean).every((part) => noteBlockText.includes(part.trim())),
  noteBlockText.slice(0, 240))

/* ── J-7. 短说明：不给折叠条（没有藏起来的内容就不该有「展开」） ── */

/*
 * 死按钮是最糟的形态：用户点了没反应，还以为功能坏了。短说明整段显示，
 * 一条折叠条都不渲染——`data-report-note-toggle` 必须为 0。
 */
const shortNoteCard = renderReport(FIXTURE_REPORT)
check('【说明】短说明不给折叠条（没有可展开的内容就不渲染「展开」）',
  reportMarks(shortNoteCard.row, 'data-report-note-toggle').length === 0
    && reportMarks(shortNoteCard.row, 'data-report-note-detail').length === 0
    && reportMarks(shortNoteCard.row, 'data-report-note').length === 1,
  JSON.stringify({
    toggle: reportMarks(shortNoteCard.row, 'data-report-note-toggle').length,
    detail: reportMarks(shortNoteCard.row, 'data-report-note-detail').length,
    note: reportMarks(shortNoteCard.row, 'data-report-note').length,
  }))
check('【说明】短说明整段显示（一行不多一行不少）',
  text(reportMarks(shortNoteCard.row, 'data-report-note')[0]).includes('Start-Sleep 10 秒'))
unmount(shortNoteCard.row)
unmount(noteCard.row)

/* ── J-8. 源码反向断言：不许再写成受控 / 不许再回到 button + state ── */

/*
 * 切片的结束边界用**代码**标记 `key: 'need'`，不用 `需要你`：后者是中文文案，
 * 剥掉注释后一个都不剩（注释里才有），`indexOf` 会返回 -1、切片为空，
 * 断言就会以一个看不懂的「slice failed」红掉。
 */
const noteSourceBlock = (() => {
  const at = sourceNoComments.indexOf("key: 'note-more'")
  const end = sourceNoComments.indexOf("key: 'need'", at)
  return at < 0 || end < 0 ? '' : sourceNoComments.slice(at, end)
})()
check('★[反]【说明】details 那一段源码里没有 open: 赋值（防受控回归）',
  noteSourceBlock.length > 0 && !/[{,]\s*open\s*:/.test(noteSourceBlock),
  noteSourceBlock ? 'len=' + noteSourceBlock.length : 'slice failed')
check('[反]【说明】details 上没有 onToggle / onClick（展开态不交给 JS 管）',
  noteSourceBlock.length > 0 && !/onToggle/.test(noteSourceBlock) && !/onClick/.test(noteSourceBlock))
check('★[反]【说明】不再用 button + useState 折叠（连挂 5 次的那条路）',
  !/setNoteOpen|noteOpen/.test(sourceNoComments),
  (sourceNoComments.match(/setNoteOpen|noteOpen/g) || []).slice(0, 4).join(','))
check('★[反]【说明】的拍开文案由 CSS 的 [open] 后代选择器切换（JS 不写切换逻辑）',
  /\.dsh-sa-rc-note-detail\[open\]\s+\.dsh-sa-rc-note-when-closed\s*\{[^}]*display:\s*none/s.test(CARD_STYLE_TEXT)
    && /\.dsh-sa-rc-note-detail\[open\]\s+\.dsh-sa-rc-note-when-open\s*\{[^}]*display:\s*inline/s.test(CARD_STYLE_TEXT),
  '需要成对 span + [open] 后代选择器，两条缺一不可')



/*
 * 为什么必须复制 `raw` 而不是 DOM 文本：卡片里【说明】可能被折叠到 3 行、
 * 【细节】默认收起，DOM 文本是**残缺**的。用户点「复制」想要的显然是那份完整报告。
 */
const copied = []
const savedNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText(value) { copied.push(String(value)); return Promise.resolve() } } },
})
const copyCard = renderReport(FIXTURE_REPORT)
const rcCopyBtn = reportMarks(copyCard.row, 'data-report-copy')[0]
check('有剪贴板时渲染复制按钮', Boolean(rcCopyBtn))
if (rcCopyBtn) rcCopyBtn.props.onClick()
await tick()
await tick()
update(copyCard.row)
check('复制按钮复制的是完整原文（含【任务】与【需要你】两行）',
  copied.length === 1 && copied[0] === FIXTURE_REPORT,
  copied.length ? JSON.stringify(copied[0]).slice(0, 200) : '没有调用 writeText')
check('复制成功后按钮文字给出结论（不是静默）',
  text(copyCard.row.tree).includes('已复制'), text(copyCard.row.tree).replace(/\s+/g, ' ').slice(-120))
unmount(copyCard.row)

/* ── ⑧ 没有 navigator.clipboard 时**不渲染**复制按钮 ── */

/*
 * plans/14 §6 第 7 条：不是「渲染了但点了没用」，而是**根本不渲染**。
 * 上一版给了一个按钮，点下去走 execCommand 兜底失败后弹「复制失败」——
 * 用户看到的仍然是「有个按钮，点了没用」。
 */
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
const noCopyCard = renderReport(FIXTURE_REPORT)
check('没有 navigator.clipboard 时不渲染复制按钮',
  reportMarks(noCopyCard.row, 'data-report-copy').length === 0,
  text(noCopyCard.row.tree).replace(/\s+/g, ' ').slice(-160))
unmount(noCopyCard.row)
if (savedNavigatorDescriptor) Object.defineProperty(globalThis, 'navigator', savedNavigatorDescriptor)
else delete globalThis.navigator

/* ── ⑨ 状态 chip：查得到显示、查不到不显示、批次不查 ── */

/** `/board?task=` 的响应与模式；与派发卡的 `?group=` 各自独立。 */
let reportStatusMode = 'ok'
let reportStatusResponse = { tasks: [] }
const reportTaskRequests = () => requests.filter((item) => String(item.url).includes('?task='))
const realFetchForReport = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (String(url).includes('?task=')) {
    requests.push({ url, method: 'GET', body: undefined })
    if (reportStatusMode === 'fail') return { ok: false, status: 500, async json() { return { ok: false } } }
    if (reportStatusMode === 'empty') return { ok: true, status: 200, async json() { return { tasks: [] } } }
    return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(reportStatusResponse)) } }
  }
  return realFetchForReport(url, options)
}
reportStatusResponse = { tasks: [{ task_id: 't-rc-1', status: 'done' }] }
const chipCard = renderReport(FIXTURE_REPORT)
await tick()
await tick()
update(chipCard.row)
check('查得到状态时显示 chip（用 TEXT.status.done 的中文，不是英文枚举）',
  reportMarks(chipCard.row, 'data-report-chip').length === 1
    && reportMarks(chipCard.row, 'data-report-chip')[0].props['data-report-chip'] === 'done'
    && text(chipCard.row.tree).includes('已完成'),
  text(chipCard.row.tree).replace(/\s+/g, ' ').slice(0, 120))
check('chip 用的是 ?task= 这条窄口，不是全量快照',
  reportTaskRequests().length >= 1, `实际 ${reportTaskRequests().length} 次`)
unmount(chipCard.row)

/*
 * 下面三条**都换一个新的 taskId**。
 *
 * 为什么不能继续用 t-rc-1：前面那条「查得到就显示 chip」已经把 t-rc-1 的
 * done 写进了 10s 缓存（plans/13 §8.3 要求缓存），后面的卡会在 TTL 内直接命中
 * 那份缓存——于是「查不到时不显示 chip」会因为**缓存里有旧答案**而假失败。
 * 这不是测试技巧，正是真机上会发生的事：同一任务的两张卡（重放/重挂）在 TTL 内
 * 必须给出**相同**的结论，否则用户会看到两张卡状态不一。
 */
reportStatusMode = 'empty'
const noChipCard = renderReport(FIXTURE_REPORT, { id: 'dsh-mini-superagent:t-rc-empty:relay:boot:11' })
await tick()
await tick()
update(noChipCard.row)
check('/board 查不到时不显示 chip，也不编一个「未知」',
  reportMarks(noChipCard.row, 'data-report-chip').length === 0
    && text(noChipCard.row.tree).includes('占位文件已建好'),
  text(noChipCard.row.tree).replace(/\\s+/g, ' ').slice(0, 160))
unmount(noChipCard.row)

/* 请求失败：静默降级（不弹错、不阻塞渲染、卡片照常完整）。 */
reportStatusMode = 'fail'
const failChipCard = renderReport(FIXTURE_REPORT, { id: 'dsh-mini-superagent:t-rc-fail:relay:boot:12' })
await tick()
await tick()
update(failChipCard.row)
check('/board 请求失败时静默：无 chip，但卡片内容照常完整',
  reportMarks(failChipCard.row, 'data-report-chip').length === 0
    && text(failChipCard.row.tree).includes('占位文件已建好'),
  text(failChipCard.row.tree).replace(/\\s+/g, ' ').slice(0, 160))
unmount(failChipCard.row)
reportStatusMode = 'ok'

/*
 * 批次卡**不查**状态：g-… 是一组任务，没有一个「批次状态」字段可查。
 * 给批次编一个聚合状态就是「猜状态」（plans/13 §8.3 明令禁止）。
 */
const beforeBatchChip = reportTaskRequests().length
const batchChipCard = renderReport(FIXTURE_BATCH, { id: 'dsh-mini-superagent:g-t-rc-9:relay:boot:8' })
await tick()
await tick()
update(batchChipCard.row)
check('批次卡不发 ?task= 请求（批次没有单一状态，不许猜）',
  reportTaskRequests().length === beforeBatchChip
    && reportMarks(batchChipCard.row, 'data-report-chip').length === 0,
  '新增 ' + (reportTaskRequests().length - beforeBatchChip) + ' 次请求')
unmount(batchChipCard.row)

/*
 * 状态缓存：同一 taskId 在 TTL 内只查一次。
 *
 * 为什么这条不能省（真机现象）：transcript 是虚拟滚动的，一张卡滚出视口会卸载、
 * 滚回来会重挂。没有缓存的话「往上翻一屏再翻回来」就是一次新的 ?task=，
 * 而它拿的还是同一份数据——用户体感是「翻回去就转圈」。
 */
reportStatusResponse = { tasks: [{ task_id: 't-rc-cache', status: 'done' }] }
const cacheBefore = reportTaskRequests().length
const cacheA = renderReport(FIXTURE_REPORT, { id: 'dsh-mini-superagent:t-rc-cache:relay:boot:13' })
await tick()
await tick()
update(cacheA.row)
unmount(cacheA.row)
const cacheB = renderReport(FIXTURE_REPORT, { id: 'dsh-mini-superagent:t-rc-cache:relay:boot:13' })
await tick()
await tick()
update(cacheB.row)
check('同一 taskId 的第二次挂载命中缓存（不重复发 ?task=）',
  reportTaskRequests().length - cacheBefore === 1,
  '实际 ' + (reportTaskRequests().length - cacheBefore) + ' 次')
unmount(cacheB.row)
globalThis.fetch = realFetchForReport

/* ── ⑩ 超长正文：截断 + 提示，且复制仍取完整原文 ── */

/*
 * plans/14 §3.2：`raw` > 32KB → 截断 + 提示，**不许正则扫全文导致卡顿**。
 * 所以解析前先 `slice`（解析成本有上界），但复制走 `rawFull`（一个字符都不少）。
 */
const hugeCard = renderReport('【任务】巨长报告\n【结果】' + '很长的结果'.repeat(8000) + '\n【细节】dispatch_inspect t-rc-1')
check('超长正文被截断到 32KB 以内（解析成本有上界）',
  hugeCard.state.card.truncated === true && hugeCard.state.card.raw.length <= 32 * 1024,
  `truncated=${hugeCard.state.card.truncated} len=${hugeCard.state.card.raw.length}`)
check('超长正文有「内容过长」提示（不是静默认丢）',
  reportMarks(hugeCard.row, 'data-report-truncated').length === 1,
  text(hugeCard.row.tree).replace(/\s+/g, ' ').slice(-160))
check('超长正文时 rawFull 仍是完整原文（复制不会只剩前半段）',
  hugeCard.state.card.rawFull.length === hugeCard.state.card.truncatedFrom
    && hugeCard.state.card.rawFull.length > 32 * 1024,
  `rawFull=${hugeCard.state.card.rawFull.length} truncatedFrom=${hugeCard.state.card.truncatedFrom}`)
unmount(hugeCard.row)

/* ── ⑪ 长文本省略与 title 全文 ── */

const LONG_TITLE = '很长的任务标题'.repeat(12)
const longTitleCard = renderReport('【任务】' + LONG_TITLE + '\n【结果】完成')
const titleNode = reportMarks(longTitleCard.row, 'data-report-title')[0]
check('长标题在 DOM 里保留全文，靠 CSS 省略（不是先截断再渲染）',
  Boolean(titleNode) && text(titleNode) === LONG_TITLE)
check('长标题的 title 属性是全文（悬停能看完整）',
  Boolean(titleNode) && titleNode.props.title === LONG_TITLE)
unmount(longTitleCard.row)

/* 长 id：显示层截到 14 字 + 省略号，title 属性仍是完整 id。 */
const longIdCard = renderReport(FIXTURE_REPORT, { id: 'dsh-mini-superagent:t-very-long-task-id-xyz:relay:boot:9' })
const longIdNode = reportMarks(longIdCard.row, 'data-report-id')[0]
check('长 id 显示成短形式（≤15 字），title 属性保留完整 id',
  Boolean(longIdNode) && text(longIdNode).length <= 15
    && text(longIdNode).endsWith('…')
    && longIdNode.props.title === 't-very-long-task-id-xyz',
  longIdNode ? `${text(longIdNode)} / ${longIdNode.props.title}` : 'missing')
unmount(longIdCard.row)

/* ── ⑫ 旧消息 / 脏输入：一律不抛错，且仍能看到原文 ── */

const legacyCard = renderReport('【任务】升级前的老报告\n【结果】老消息也得好好的')
check('升级前写入的老消息不报错、能显示',
  legacyCard.state.card.shape === 'report' && text(legacyCard.row.tree).includes('老消息也得好好的'))
unmount(legacyCard.row)

/*
 * 解析器对**任何输入**都不得抛错：`start` 里抛错会被宿主当作「这个节点建不起来」，
 * 而报告正文是模型写的自由文本，什么都可能出现。
 */
const NASTY_INPUTS = [
  ['undefined', undefined],
  ['null', null],
  ['非字符串对象', { hello: 1 }],
  ['只有换行', '\n\n\n'],
  ['段名后面什么都没有', '【任务】\n【结果】\n【说明】\n【需要你】\n【细节】'],
  ['段名重复', '【任务】甲\n【结果】1\n【结果】2\n【说明】x\n【说明】y'],
  ['Windows 换行', '【任务】甲\r\n【结果】1\r\n【细节】dispatch_inspect t-rc-1'],
]
for (const [why, input] of NASTY_INPUTS) {
  let threw = null
  let card = null
  try {
    card = parseReportForTest(input)
  } catch (error) {
    threw = error
  }
  check(`解析器对脏输入不抛错（${why}）`, threw === null, threw ? String(threw) : 'ok')
  check(`脏输入仍然有内容可看、不返回 undefined（${why}）`,
    Boolean(card) && typeof card.raw === 'string' && typeof card.rawFull === 'string',
    card ? String(card.shape) : 'missing')
}
check('重复段名不丢内容（两行都留着，后者不覆盖前者）',
  (() => {
    const card = parseReportForTest('【任务】甲\n【结果】1\n【结果】2\n【说明】x\n【说明】y')
    return card.result === '1\n2' && card.note === 'x\ny'
  })())
check('Windows 换行（\\r\\n）也能正确分段、不留 \\r',
  (() => {
    const card = parseReportForTest('【任务】甲\r\n【结果】1\r\n【细节】dispatch_inspect t-rc-1')
    return card.shape === 'report' && card.title === '甲' && card.result === '1'
      && card.inspectId === 't-rc-1' && !/\r/.test(card.result)
  })())

/* ── ⑬ 只在不该认领时才不认领：surfaceOp / 人类消息 / 别家插件 ── */

check('surfaceOp 是显式的替换型 surface 时不认领（对齐 isAppendSurfaceEvent）',
  reportDef.match(relayEvent({ surfaceOp: 'replace' })) === null)
check('surfaceOp 缺失（老宿主 / 离线 fixture）时放行——拒绝 undefined 会让旧宿主一张卡都不出',
  reportDef.match(relayEvent({ surfaceOp: undefined })) !== null)

/* ── ⑭ 样式：只用主题令牌、不写死主色、复用同一个 <style> 节点 ── */

/*
 * 样式断言用**源码切片**而不是渲染树（离线 stub 不解析 CSS）。取 `const CARD_STYLE`
 * 到「卡片样式的单例节点」之间的那一段，再切出 `.dsh-sa-rc {` 之后属于报告卡的部分。
 *
 * 为什么这条必须存在：写死颜色（`#3b82f6` 之类）在明暗两套主题下必有一边糊掉，
 * 而那种问题肉眼很难在一种主题里发现——它通常是在暗色主题下被用户报上来的。
 */
const reportCss = (() => {
  const start = source.indexOf('const CARD_STYLE =')
  const end = source.indexOf('卡片样式的单例节点', start)
  if (start < 0 || end < 0) return ''
  const styleBlock = source.slice(start, end)
  const at = styleBlock.indexOf('.dsh-sa-rc {')
  return at < 0 ? '' : styleBlock.slice(at)
})()
check('报告卡样式块存在（.dsh-sa-rc 起，到卡片样式块结束）', reportCss.length > 0,
  String(reportCss.length))
check('报告卡样式只含 --dsw-alias-* / --dsw-* 主题令牌（不写死主色）',
  reportCss.includes('--dsw-alias-') && !/#[0-9a-fA-F]{3,8}|rgb\(|hsl\(/.test(reportCss),
  (reportCss.match(/#[0-9a-fA-F]{3,8}|rgb\(|hsl\(/g) || []).slice(0, 5).join(','))
check('报告卡宽度跟随 --dsh-chat-content-width（不写死 680px）',
  reportCss.includes('--dsh-chat-content-width') && !/680px/.test(reportCss))
check('报告卡尊重 prefers-reduced-motion',
  reportCss.includes('prefers-reduced-motion'))
check('报告卡正文可选中复制（user-select: text，不用 canvas / 图片）',
  /user-select:\s*text/.test(reportCss) && !/background-image/.test(reportCss))
/*
 * 【需要你】的视觉权重必须是**至少两个通道**：左侧色条 + 加粗（+ 浅底）。
 * 只靠一种（比如只加粗）在长报告里仍然会被跳读——而这一段是唯一需要人动手的。
 */
check('【需要你】有左侧 2px 色条 + 加粗 + 浅底（多个视觉通道，不靠单一手段）',
  (() => {
    const at = reportCss.indexOf('.dsh-sa-rc-need {')
    if (at < 0) return false
    const rule = reportCss.slice(at, reportCss.indexOf('}', at) + 1)
    const label = (() => {
      const la = reportCss.indexOf('.dsh-sa-rc-need-text {')
      return la < 0 ? '' : reportCss.slice(la, reportCss.indexOf('}', la) + 1)
    })()
    return /border-left:\s*2px/.test(rule)
      && /background:\s*var\(--dsw-alias-/.test(rule)
      && /font-weight:\s*(600|700|bold)/.test(label)
  })())
check('报告卡只有一个 data-plugin-css 节点（与派发卡共用 ensureCardStyles，不另插一份）',
  source.split("const CARD_STYLE_ATTR = 'dsh-mini-superagent/cards'").length - 1 === 1)
check('报告卡源码里没有第二处 STYLE 常量（复用 CARD_STYLE，不新增第二个 <style>）',
  source.split('const CARD_STYLE =').length - 1 === 1
    && source.split("createElement('style')").length - 1 === 1,
  `CARD_STYLE 定义 ${source.split('const CARD_STYLE =').length - 1} 处；createElement('style') ${source.split("createElement('style')").length - 1} 处`)

/*
 * 段名漂移防护（plans/13 FR-13 的客户端一侧）：六个段名必须**全部**出现在客户端源码里，
 * 少任何一个 = 那一段永远解析不出来，而界面上的表现只是「卡片少了半截」。
 * 权威定义在 `src/constants.js` 的 REPORT_SECTIONS，服务端一侧由
 * `test/voice-contract.test.js` 反向钉住（它读本文件、断言六个段名都在）。
 */
for (const [key, value] of [
  ['任务', '【任务】'], ['结果', '【结果】'], ['说明', '【说明】'],
  ['需要你', '【需要你】'], ['细节', '【细节】'], ['批次', '【批次】'],
]) {
  check(`客户端报告卡识别段名「${key}」（${value}）`,
    source.includes(`'${value}'`), `源码里找不到 ${value}`)
}

/* ── ④' taskId 提取：批次汇总的 group id（`g-t-xxx`）与「没有前缀的旧形态」都要对 ── */

/*
 * 批次汇总的 task.id 形如 `g-t-mwgp38pt-1`（`dispatch.js:294` 用 `g-${newTaskId()}`）。
 * 它和单条任务走同一条 relay，所以提取规则必须同时对两种 id 成立；另外要守住
 * 「没有包名前缀时不要多切一刀」——把 `t-xxx:relay:...` 当成有前缀会切掉真 id。
 */
const batchState = reportDef ? reportDef.start({}, { event: relayEvent({ data: { id: 'dsh-mini-superagent:g-t-mwgp38pt-1:relay:q5k3of:1' } }), role: 'start', location: { kind: 'step', turn: {}, step: {} } }) : null
check('批次汇总 id（g-t-xxx）同样剥前缀取到 group id',
  Boolean(batchState) && batchState.taskId === 'g-t-mwgp38pt-1',
  batchState ? String(batchState.taskId) : 'missing')
const bareState = reportDef ? reportDef.start({}, { event: relayEvent({ data: { id: 't-bare-1:relay:boot:1' } }), role: 'start', location: { kind: 'step', turn: {}, step: {} } }) : null
check('没有包名前缀时不误切（t-xxx:relay:... 仍取 t-xxx）',
  Boolean(bareState) && bareState.taskId === 't-bare-1',
  bareState ? String(bareState.taskId) : 'missing')

/* ── ⑤ 没有 uiConversation：apply 不抛错，其余槽照常注册 ── */

const noService = reportCtx({ withService: false })
let noServiceThrew = null
try { mod.apply(noService) } catch (error) { noServiceThrew = error }
check('没有 uiConversation 时 apply 不抛错', noServiceThrew === null,
  noServiceThrew ? String(noServiceThrew) : 'ok')
check('没有 uiConversation 时一个 Definition 都不注册', noService.definitions.length === 0,
  `实际 ${noService.definitions.length}`)
check('没有 uiConversation 时也没有 conversation.chat.node 渲染器',
  !noService.rendererRegs.some((item) => item.options && item.options.name === 'conversation.chat.node'))
check('没有 uiConversation 时其余槽照常注册（看板 / 图标 / 输入框控件 / 分隔线）',
  ['sidebar.panellist', 'main', 'conversation.input.left', 'conversation.chat.user.before']
    .every((name) => noService.rendererRegs.some((item) => item.options && item.options.name === name)),
  JSON.stringify(noService.rendererRegs.map((item) => item.options && item.options.name)))
check('没有 uiConversation 时 cards.report 键缺席（未提供 ≠ 失败）',
  !('report' in (lastReadyBody() ? lastReadyBody().cards : {})),
  JSON.stringify(lastReadyBody() ? lastReadyBody().cards : null))

/* ── ⑥ events.register 抛错：error:register，且 context 行还在（不黑屏） ── */

const defThrows = reportCtx({ throwOnDefinition: true })
let defThrew = null
try { mod.apply(defThrows) } catch (error) { defThrew = error }
check('events.register 抛错时 apply 不抛错（不黑屏）', defThrew === null, defThrew ? String(defThrew) : 'ok')
check('events.register 抛错后 cards.report === error:register',
  Boolean(lastReadyBody()) && lastReadyBody().cards.report === 'error:register',
  JSON.stringify(lastReadyBody() ? lastReadyBody().cards : null))
check('events.register 抛错后渲染器被撤掉（不留没有 Definition 的死渲染器）',
  defThrows.order.includes('dispose-renderer'), defThrows.order.join('>'))
check('events.register 抛错只 warn 一次（不许刷日志）',
  defThrows.warns.length === 1, JSON.stringify(defThrows.warns))
check('events.register 抛错时其余槽照常注册（只降自己）',
  ['sidebar.panellist', 'main', 'conversation.input.left']
    .every((name) => defThrows.rendererRegs.some((item) => item.options && item.options.name === name)),
  JSON.stringify(defThrows.rendererRegs.map((item) => item.options && item.options.name)))

/* ── ⑥' 渲染器注册抛错：error:register，且绝不认领 ── */

const rendererThrows = reportCtx({ throwOnRenderer: 'conversation.chat.node' })
let rendererThrew = null
try { mod.apply(rendererThrows) } catch (error) { rendererThrew = error }
check('渲染器注册抛错时 apply 不抛错', rendererThrew === null, rendererThrew ? String(rendererThrew) : 'ok')
check('渲染器注册抛错后不注册 Definition（没有渲染器就绝不认领）',
  rendererThrows.definitions.length === 0, `实际 ${rendererThrows.definitions.length}`)
check('渲染器注册抛错后 cards.report === error:register',
  Boolean(lastReadyBody()) && lastReadyBody().cards.report === 'error:register',
  JSON.stringify(lastReadyBody() ? lastReadyBody().cards : null))

/* ── ⑥'' 宿主没有 conversation.chat.node 槽：不认领，消息保持 context 行 ── */

const noNodeSlot = reportCtx({ withNodeSlot: false })
let noSlotThrew = null
try { mod.apply(noNodeSlot) } catch (error) { noSlotThrew = error }
check('没有 chat.node 槽时 apply 不抛错', noSlotThrew === null, noSlotThrew ? String(noSlotThrew) : 'ok')
check('没有 chat.node 槽时不注册 Definition（先有渲染器才认领）',
  noNodeSlot.definitions.length === 0, `实际 ${noNodeSlot.definitions.length}`)

/* ── ⑦ CARD_FEATURES.report = false：完全不注册 ── */

/*
 * 这一条**必须改源码再跑一次模块**：`CARD_FEATURES` 是工厂作用域里的常量，
 * 外面拿不到（这正是它作为 kill switch 的形状——用户改的是文件，不是运行时状态）。
 * 用字符串替换把 `report: true` 改成 `report: false`，重新走一遍 ModuleLoader，
 * 断言「一个 Definition / 渲染器都没有，且 cards.report 键缺席」。
 * 顺手守一件事：替换必须真的命中了那一行，否则这条断言会在假前提上通过。
 */
const offSource = source.replace('CARD_FEATURES = { batch: true, report: true }', 'CARD_FEATURES = { batch: true, report: false }')
check('（前置）CARD_FEATURES 的源码形状可被 kill switch 命中',
  offSource !== source && offSource.includes('report: false'))
let offMod = null
const savedLoader = globalThis.window.__ModuleLoader__
globalThis.window.__ModuleLoader__ = {
  load(definition) {
    const requireFn = (id) => {
      if (id === 'react') return React
      if (id === 'react-dom') return ReactDOM
      throw new Error(`unexpected require: ${id}`)
    }
    offMod = definition.factory(requireFn)
  },
}
try { new Function(offSource)() } finally { globalThis.window.__ModuleLoader__ = savedLoader }
const offCtx = reportCtx({})
let offThrew = null
try { if (offMod) offMod.apply(offCtx) } catch (error) { offThrew = error }
check('CARD_FEATURES.report = false 时 apply 不抛错', offThrew === null, offThrew ? String(offThrew) : 'ok')
check('CARD_FEATURES.report = false 时完全不注册 Definition',
  offCtx.definitions.length === 0, `实际 ${offCtx.definitions.length}`)
check('CARD_FEATURES.report = false 时也不注册 chat.node 渲染器',
  !offCtx.rendererRegs.some((item) => item.options && item.options.name === 'conversation.chat.node'))
check('CARD_FEATURES.report = false 时派发卡照常注册（只关自己）',
  offCtx.rendererRegs.filter((item) => item.options && item.options.name === 'tool.call.toolview').length === 2,
  JSON.stringify(offCtx.rendererRegs.map((item) => item.options && item.options.name)))

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
