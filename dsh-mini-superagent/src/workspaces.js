/**
 * 工作区：默认工作区、每天一个【派发】工作区、按 id/路径/标题解析、以及过期归档。
 *
 * 关键宿主事实（`docs/api-contracts.md` 之外，这轮实测/查到的）：
 * - `workspaceRegistry.create(path, title)` 要求**目录已存在**（realpath 规范化，相对路径/不存在/非目录直接拒），
 *   同一路径重复调用返回已有实体 —— 所以幂等靠路径，不靠我们自己记状态。
 * - 新建的工作区会插在注册表最前面（所以默认工作区只会在第一次出现时排第一）。
 * - `resolveByPath` 只查不建；路径不存在会 reject。
 * - `Workspace` 自带 `status()` 可判断目录是否还在。
 *
 * 返回值契约（`resolveOrCreate`）：`{ workspace, created }` 之外还有一个**可选**的 `reason`，
 * 取值 `'ambiguous' | 'not-found'`（解析成功、或真的新建成功时没有这个字段）。
 * **这个字段是给 `dispatch.js` 用的**：它靠它区分「有歧义」与「不存在」，从而选对错误文案——
 * 0.8.0 及更早版本里两者都是 undefined，`dispatch.js` 只能把所有失败都写成
 * 「找不到工作区「…」，且允许新建被关闭」，而实际上那句话在歧义时是假的（并没有人关掉新建）。
 * 别以为它只是日志附注；也不要再往调用方加第三个布尔值，`reason` 就是那个区分位。
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve as toAbsolute, sep } from 'node:path'

import { LOG_PREFIX } from './constants.js'

/** 默认工作区根的兜底值：`<用户文档目录>/mini-superagent`。 */
export function defaultRoot() {
  return join(homedir(), 'Documents', 'mini-superagent')
}

/** 工作区根：配置优先，否则用默认值。 */
export function rootOf(config) {
  const configured = String(config?.workspaceRoot ?? '').trim()
  return configured || defaultRoot()
}

/** 本地日期的 `YYYY-MM-DD`。用本地时间，因为「过一天归档」是人的日历语义。 */
export function dayKey(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 【派发】工作区的标题。 */
export const dayTitle = day => `【派发】${day}`

/**
 * Windows 保留设备名：这些名字（大小写无关）不能当文件/目录名。
 *
 * 为什么必须躲开：`mkdir` 命中保留名时要么直接失败，要么（经 realpath 后）指到设备上，
 * 两种都比「换个名字」糟得多；而失败发生在 `registry.create` 之前，
 * 用户看到的只是「新建工作区失败」，根本看不出是名字的问题。
 *
 * 带扩展名的形式同样非法（`CON.txt` 在 Windows 上仍指向 CON 设备），所以判定时只看第一个点之前的部分。
 * CONIN$/CONOUT$ 之类扩展名不在集合里 —— 它们日常几乎不出现，加进来只会让规则更难懂。
 */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
])

/**
 * 去掉尾部的点号与空格。
 *
 * Windows **静默**吃掉名字末尾的点和空格：`abc.` 与 `abc`、`abc ` 与 `abc` 都落到同一个目录。
 * 不清理的话，两个不同标题会撞进同一个目录，于是同一个工作区被复用、`create` 也不会新建 ——
 * 这类「看起来成功了其实混在一起」的问题最难查，所以在派生目录名时一次清干净。
 */
function stripTrailing(value) {
  return String(value).replace(/[. ]+$/, '')
}

/**
 * 给命中的保留名加后缀避开：`CON` → `CON-`，`CON.txt` → `CON-.txt`。
 *
 * 后缀必须插在第一个点**之前**：`CON.txt-` 去掉扩展名后仍然是 `CON`，还是设备名，等于没改。
 * 选 `-` 而不是 `_1`：不改长度、不与「用户本来就叫 CON_1」撞名，也不影响后续截断。
 */
function breakReservedName(value) {
  const text = String(value)
  const dot = text.indexOf('.')
  return dot === -1 ? `${text}-` : `${text.slice(0, dot)}-${text.slice(dot)}`
}

/** 把任意标题压成安全的目录名（去路径分隔符与控制字符、避开 Windows 保留名、去尾部点号/空格、限长）。 */
export function safeDirName(name) {
  const cleaned = stripTrailing(
    String(name ?? '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/^\.+/, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  // 截断之后再清一次尾部点号/空格：截断点可能正好落在点号后面，只清一次等于没清。
  const sliced = stripTrailing(cleaned.slice(0, 60))
  if (!sliced) return 'dispatch'
  // 保留名判定放在最后：`CON.` 先被清成 `CON`，只在这一步之后才看得出来是保留名。
  const base = sliced.split('.')[0].toUpperCase()
  return WINDOWS_RESERVED.has(base) ? breakReservedName(sliced) : sliced
}

/**
 * 按关键词给工作区打分，用于「自动选择」。
 *
 * 只看用户看得见的东西（标题、目录名、路径），不做语义猜测——猜错比不猜更烦人。
 * 分值：标题完全相等 100 / 标题包含 40 / 目录名相等 30 / 目录名包含 15 / 路径包含 5。
 * 多个关键词（空格、逗号分隔）累加；同分按标题字典序。
 *
 * @param {Array<{id:string,title?:string,path?:string}>} pool
 * @param {string} query
 * @returns {Array<{ item: object, score: number, title: string }>} 分数降序，不含 0 分项
 */
export function rankWorkspaces(pool, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  const words = needle.split(/[\s,，、]+/).filter(Boolean)
  const scored = []
  for (const item of Array.isArray(pool) ? pool : []) {
    const title = String(item?.title || item?.id || '')
    const path = String(item?.path || '')
    const tail = path.split(/[\\/]/).filter(Boolean).pop() || ''
    const haystack = `${title}\n${tail}\n${path}`.toLowerCase()
    let score = 0
    // 没有关键词时：全部同分，靠调用方的排序兜底。
    if (!words.length) score = 1
    else {
      for (const word of words) {
        if (title.toLowerCase() === word) score += 100
        else if (title.toLowerCase().includes(word)) score += 40
        else if (tail.toLowerCase() === word) score += 30
        else if (tail.toLowerCase().includes(word)) score += 15
        else if (haystack.includes(word)) score += 5
      }
    }
    if (score > 0) scored.push({ item, score, title })
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.title.localeCompare(b.title)))
  return scored
}

/**
 * `target` 是否落在 `root` 之内（含 root 本身）。
 *
 * 用 `relative` 而不是字符串前缀判断：前缀判断会被 `C:\work` vs `C:\workspace2`
 * 这种「同前缀不同目录」骗过去。`relative` 跨盘符会返回绝对路径（如 `D:\x`），
 * 那也一定在 root 之外。
 *
 * 先各自绝对化再比：`workspaceRoot` 被配成相对路径时，直接和绝对路径做相对运算
 * 会把所有合法路径都判成越界，于是天天误报，日志很快就没人看了。
 */
function isInside(root, target) {
  const rel = relative(toAbsolute(root), toAbsolute(target))
  if (!rel) return true                     // 同一个目录
  if (isAbsolute(rel)) return false         // 跨盘符，算不出来相对路径
  return rel.split(sep)[0] !== '..'         // 首段是 `..` 才是往上跑（`..foo` 仍在 root 内）
}

/**
 * 标题包含匹配的全部候选（大小写不敏感）。
 *
 * 单独抽出来是因为 `resolve` 和 `resolveOrCreate` 都要用：前者靠它判断歧义，
 * 后者靠它在**新建之前**拦住歧义引用 —— 否则 `resolve` 因歧义返回 undefined 后，
 * `resolveOrCreate` 会把这当成「不存在」，凭空建出一个同名新目录，
 * 把一个「有两个候选」的问题变成「多出一个重复工作区」，比原来更糟。
 */
function fuzzyMatches(items, lower) {
  return items.filter(item => String(item.title).toLowerCase().includes(lower))
}

/**
 * 标题精确匹配的全部候选（大小写不敏感）。
 *
 * 为什么不用 `find`：`find` 在注册表里有同名工作区时**无条件返回第一个**，而且不吭声。
 * 实测踩到的场景是两个不同路径共用标题 —— 仓库根 `dsh-mini-superagent` 与包根
 * `dsh-mini-superagent\dsh-mini-superagent`（PostMessage 宿主就是按目录 basename 起标题的），
 * 于是用户点「dsh-mini-superagent」时被静默送进**另一个盘上的另一个目录**，
 * 日志里一行线索都没有。精确匹配的歧义比包含匹配更难发现（看起来「就是它」），
 * 所以这里和包含匹配采取同一套规矩：收集全部命中，交给调用方判断。
 */
function exactMatches(items, lower) {
  return items.filter(item => String(item.title).toLowerCase() === lower)
}

/**
 * 把命中列表渲染成给人看的候选项。
 *
 * **带 path**：同名工作区之间 id 对人毫无区分度（都是一串 uuid），而 path 一眼能看出
 * 「哦，这是包根不是仓库根」。`dispatch_workspaces` 的列表里也是 path 才有用。
 */
function describeMatches(items) {
  return items.map(item => `${item.title}（${item.path || '无路径'}，id=${item.id}）`).join('；')
}

/**
 * 一个「标题/名字类」引用（既不是 id 也不是绝对路径）为什么没解析到。
 *
 * 抽出来是因为 `resolveOrCreate` 必须在**新建之前**重跑一遍 `resolve` 的判定：
 * `resolve` 因歧义返回 undefined，如果这里不再判一次，就会把「有两个候选」
 * 当成「不存在」，凭空 `mkdir` 出第三个同名目录 —— 比原来的问题更糟。
 *
 * 判定顺序必须与 `resolve` 完全一致（精确在前、单字符不做包含匹配），
 * 否则会出现「resolve 因精确歧义返回 undefined，这里却判成 not-found 然后新建」的漏洞。
 * 这也正是这次修复里最容易漏的一处：0.8.0 及更早只判了包含匹配。
 *
 * @returns {{ reason: 'ambiguous' | 'not-found', matches: object[], exact: boolean }}
 */
function diagnoseTitleRef(items, value) {
  const lower = value.toLowerCase()
  const exact = exactMatches(items, lower)
  if (exact.length > 1) return { reason: 'ambiguous', matches: exact, exact: true }
  // 单字符不做包含匹配（与 resolve 同一条规矩）；精确匹配不到就到此为止。
  if ([...lower].length >= 2) {
    const fuzzy = fuzzyMatches(items, lower)
    if (fuzzy.length > 1) return { reason: 'ambiguous', matches: fuzzy, exact: false }
  }
  return { reason: 'not-found', matches: [], exact: false }
}

/**
 * 工作区网关：把「注册表 + 目录」的组合封起来，逻辑层只调语义方法。
 */
export class WorkspaceGateway {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  get registry() { return this.ctx.get('workspaceRegistry') }

  /** 工作区根目录（默认工作区与【派发】工作区都建在这下面）。 */
  get root() { return rootOf(this.config) }

  warn(...args) { this.ctx.logger?.warn?.(...args) }

  /** 确保目录存在再注册（`create` 不接受不存在的目录）。 */
  async ensure(path, title) {
    const registry = this.registry
    if (!registry) return undefined
    await mkdir(path, { recursive: true })
    return registry.create(path, title)
  }

  /** 默认工作区（标题 mini-superagent），目录 = 工作区根。 */
  async defaultWorkspace() {
    return this.ensure(rootOf(this.config), 'mini-superagent')
  }

  /** 当天的【派发】工作区，目录 = `<根>/派发/<YYYY-MM-DD>`。 */
  async dayWorkspace(day = dayKey()) {
    return this.ensure(join(rootOf(this.config), '派发', day), dayTitle(day))
  }

  /** 按标题或任务名在工作区根下新建一个工作区（目录名由标题派生）。 */
  async createNamed(name) {
    const title = String(name ?? '').trim()
    if (!title) throw new Error('新建工作区需要一个名字')
    return this.ensure(join(rootOf(this.config), safeDirName(title)), title)
  }

  /** 列出全部工作区（注册表顺序）。 */
  list() {
    return this.registry?.list?.() ?? []
  }

  /**
   * 解析一个工作区引用，顺序：id → 绝对路径 → 标题精确匹配 → 标题包含匹配。
   * 只解析，不创建。
   *
   * 每一级都遵守同一条规矩：**命中多个就返回 undefined 并 warn 出候选，绝不静默取第一个**。
   * 静默取第一个是这个模块最容易复发的一类 bug —— 它不报错、不留日志，
   * 用户只是「莫名其妙被派到别的目录」，事后再查也查不到。
   *
   * 包含匹配的三个取舍（都为了「别猜错」）：
   * - 单字符查询（`'a'`、`'1'`）不做包含匹配：这种查询几乎必然命中一堆无关工作区，
   *   命中第一个纯属偶然，比解析不到更糟。单字符只走精确匹配，解析不到就交给调用方。
   * - 包含匹配**收集全部**命中而不是取第一个：静默取第一个会让用户莫名其妙被派到别的目录。
   * - 多个命中时返回 `undefined` 并 `warn` 出候选，**不抛错**：上层 `Dispatch.setTarget`
   *   的 `if (!workspace)` 分支本来就会把现有工作区全列给用户，退回 undefined 的体验
   *   （「找不到，现有这些」）足够可用；抛错则会改掉那条错误信息，牵动 `dispatch.js`。
   *
   * 精确匹配同样收集全部（见 `exactMatches` 的注释），歧义时也 warn —— 但**候选里必须带 path**：
   * 精确匹配的歧义几乎总是「同名不同目录」，此时 id 对人没有区分度。
   *
   * @param {string} ref 工作区 id / 绝对路径 / 标题
   * @param {{ quiet?: boolean }} [internal] `quiet: true` 时歧义不写日志 ——
   *   只给 `resolveOrCreate` 用：它在同一件事上有更贴切的措辞（「不新建」），
   *   两处都 warn 会让同一歧义在日志里出现两遍。
   * @returns {Promise<object | undefined>}
   */
  async resolve(ref, internal = {}) {
    const registry = this.registry
    const value = String(ref ?? '').trim()
    if (!registry || !value) return undefined

    const byId = registry.get(value)
    if (byId) return byId

    if (isAbsolute(value)) {
      try { return await registry.resolveByPath(value) }
      catch { return undefined }   // 路径不存在 —— 交给上层决定要不要新建
    }

    const lower = value.toLowerCase()
    const items = this.list()

    const exact = exactMatches(items, lower)
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) {
      // 精确匹配的歧义比包含匹配更隐蔽：查询看起来「就是这个名字」，调用方很容易以为是唯一的。
      // 所以这里也要 warn，且候选必须带 path（同名时 id 没有区分度）。
      if (internal.quiet !== true) {
        this.warn(`${LOG_PREFIX} 工作区引用「%s」精确命中 %d 个同名工作区，无法确定是哪一个：%s`,
          value, exact.length, describeMatches(exact))
      }
      return undefined
    }

    // 单字符不做包含匹配（见上方注释）。用数组下标而不是 length 判断，代理对也算 1 个字符。
    if ([...lower].length < 2) return undefined

    const fuzzy = fuzzyMatches(items, lower)
    if (fuzzy.length === 1) return fuzzy[0]
    if (fuzzy.length > 1) {
      // warn 而不是 throw：调用方要的是「解析不到」这个统一信号，候选只是给人看的线索。
      if (internal.quiet !== true) {
        this.warn(`${LOG_PREFIX} 工作区引用「%s」有歧义，命中 %d 个：%s`,
          value, fuzzy.length, describeMatches(fuzzy))
      }
      return undefined
    }
    return undefined
  }

  /**
   * 解析或按需新建。
   * - 能解析到 → 直接用
   * - 给的是绝对路径但没注册 → 在**那个路径**建（agent 明确指了目录）
   * - 给的是名字 → 在工作区根下建
   *
   * 返回值：`{ workspace, created, reason? }`。`reason` 只在**没拿到工作区**时出现，
   * 取值 `'ambiguous'`（注册表里有多个候选，绝不能/没有新建）或 `'not-found'`（确实不存在）。
   * 它是给 `dispatch.js` 选错误文案用的（见文件头注释），不是给人看的日志级别。
   * 别把 `created: false` + `workspace: undefined` 一律当「新建被关闭」——
   * 那正是 0.8.0 把歧义误报成「且允许新建被关闭」的成因。
   *
   * @param {string} ref 工作区 id / 绝对路径 / 标题
   * @param {{ create?: boolean }} [options]
   * @returns {Promise<{ workspace?: object, created: boolean, reason?: 'ambiguous' | 'not-found' }>}
   */
  async resolveOrCreate(ref, options = {}) {
    // quiet：歧义日志由下面「不新建」那条统一写，避免同一歧义打两遍。
    const resolved = await this.resolve(ref, { quiet: true })
    if (resolved) return { workspace: resolved, created: false }

    const value = String(ref ?? '').trim()
    // 空引用：调用方没给目标，不是「找不到」。既不判歧义也不给 reason ——
    // 给它贴 'not-found' 只会让 dispatch.js 为一句空话编出一段错误文案。
    if (!value) return { workspace: undefined, created: false }

    // 先把「为什么没解析到」判出来，再决定要不要新建 —— 两个分支都要用到它，
    // 所以不能像以前那样把判定塞在 create 检查之后（那时 create:false 会丢掉归因）。
    const diagnosis = isAbsolute(value)
      ? { reason: 'not-found', matches: [], exact: false }
      : diagnoseTitleRef(this.list(), value)

    if (diagnosis.reason === 'ambiguous') {
      // 歧义引用不能走到「新建」：那些目录是**真的存在**的，再建一个同名目录只会制造重复。
      // 用 describeMatches（带 path）：同名工作区之间 id 对人没有区分度。
      this.warn(`${LOG_PREFIX} 工作区引用「%s」有歧义（%s命中 %d 个：%s），不新建以避免重复工作区`,
        value, diagnosis.exact ? '精确' : '', diagnosis.matches.length, describeMatches(diagnosis.matches))
      return { workspace: undefined, created: false, reason: 'ambiguous' }
    }

    if (options.create === false) return { workspace: undefined, created: false, reason: diagnosis.reason }

    let workspace
    if (isAbsolute(value)) {
      // 绝对路径是有意允许的：用户/agent 完全可能想在工作区根之外（另一个盘、另一个项目树）建工作区，
      // 一律拒绝会砍掉合法用法。但这条路径不受 `workspaceRoot` 约束、又会以宿主进程权限 `mkdir -p`，
      // 所以必须留痕：越界时记一条 warn，事后能从日志里查到「谁在工作区根之外建了目录」。
      // 这是「可审计」优先于「可禁止」的取舍，不是漏了校验。
      if (!isInside(this.root, value)) {
        this.warn(`${LOG_PREFIX} 已在 workspaceRoot 之外创建工作区：%s（工作区根：%s）`, value, this.root)
      }
      workspace = await this.ensure(value, safeDirName(value.split(/[\\/]/).filter(Boolean).at(-1) ?? 'dispatch'))
    } else {
      workspace = await this.createNamed(value)
    }
    return { workspace, created: true }
  }

  /**
   * 归档一个子会话。失败不抛，把原因返回给调用方记录 —— 归档是清理动作，
   * 但失败原因必须能看见，否则就是「以为归档了其实没有」。
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async archiveSession(sessionId) {
    const registry = this.registry
    if (!registry?.archiveSession) return { ok: false, error: '宿主没有 workspaceRegistry.archiveSession' }
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      return { ok: true }
    } catch (error) {
      const message = String(error?.message ?? error)
      this.warn(`${LOG_PREFIX} 归档子会话 %s 失败: %s`, sessionId, message)
      return { ok: false, error: message }
    }
  }
}
