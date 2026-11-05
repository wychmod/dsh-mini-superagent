/**
 * 工作区：默认工作区、每天一个【派发】工作区、按 id/路径/标题解析、以及过期归档。
 *
 * 关键宿主事实（`docs/api-contracts.md` 之外，这轮实测/查到的）：
 * - `workspaceRegistry.create(path, title)` 要求**目录已存在**（realpath 规范化，相对路径/不存在/非目录直接拒），
 *   同一路径重复调用返回已有实体 —— 所以幂等靠路径，不靠我们自己记状态。
 * - 新建的工作区会插在注册表最前面（所以默认工作区只会在第一次出现时排第一）。
 * - `resolveByPath` 只查不建；路径不存在会 reject。
 * - `Workspace` 自带 `status()` 可判断目录是否还在。
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

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

/** 把任意标题压成安全的目录名（去路径分隔符与控制字符，限长）。 */
export function safeDirName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned || 'dispatch'
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
   * @returns {Promise<object | undefined>}
   */
  async resolve(ref) {
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
    return items.find(item => String(item.title).toLowerCase() === lower)
      ?? items.find(item => String(item.title).toLowerCase().includes(lower))
  }

  /**
   * 解析或按需新建。
   * - 能解析到 → 直接用
   * - 给的是绝对路径但没注册 → 在**那个路径**建（agent 明确指了目录）
   * - 给的是名字 → 在工作区根下建
   * @param {string} ref 工作区 id / 绝对路径 / 标题
   * @param {{ create?: boolean }} [options]
   */
  async resolveOrCreate(ref, options = {}) {
    const resolved = await this.resolve(ref)
    if (resolved) return { workspace: resolved, created: false }
    if (options.create === false) return { workspace: undefined, created: false }

    const value = String(ref ?? '').trim()
    if (!value) return { workspace: undefined, created: false }
    const workspace = isAbsolute(value)
      ? await this.ensure(value, safeDirName(value.split(/[\\/]/).filter(Boolean).at(-1) ?? 'dispatch'))
      : await this.createNamed(value)
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
