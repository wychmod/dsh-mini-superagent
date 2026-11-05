/**
 * DSH 适配层：所有会被宿主 API 变更影响到的调用都收在这里——
 * 建子会话、取 Agent、设权限预设、注入提示段、把消息投递进另一个 Session。
 *
 * 逻辑层（dispatch.js）只调用这里的语义方法，不直接碰 ctx.sessionController /
 * agent.steer 这些细节，换版本时只需要改这一个文件。
 */
import { LOG_PREFIX, PROMPT_SECTION, SOURCE_KIND } from './constants.js'
import { DISPATCH_HINT } from './prompt.js'

export class SessionGateway {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx 插件 context
   * @param {object} config 已合并默认值的插件配置
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.freezePromise = undefined
    /** 已经加过工作方式提示的会话，避免重复注册。 */
    this.hinted = new Set()
    /**
     * 提示段的 disposer。注册挂在 agent.ctx 上，生命周期比插件长，
     * 所以插件卸载时必须主动收回，否则重载后同一会话会出现两段提示。
     */
    this.hintDisposers = new Set()
  }

  warn(...args) { this.ctx.logger?.warn?.(...args) }

  /**
   * 懒加载 freezeMessage。拿不到就退化为普通冻结对象：消息仍然能投递，
   * 只是少了宿主的规范化，所以不把它当成硬依赖。
   */
  async freeze() {
    this.freezePromise ??= import('@deepseek-ai/dsh-llm')
      .then(mod => mod.freezeMessage)
      .catch(error => {
        this.warn(`${LOG_PREFIX} 无法加载 @deepseek-ai/dsh-llm（将退化投递）: %s`, String(error))
        return undefined
      })
    return this.freezePromise
  }

  /** 构造一条“插件来源”的 user message，交给 Agent 收件箱。 */
  async userMessage(id, text) {
    const freeze = await this.freeze()
    const raw = {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'relay' },
    }
    return freeze ? freeze(raw) : Object.freeze(raw)
  }

  /**
   * 把一条文本投递给另一个 Session。
   * @param {string} sessionId 目标会话
   * @param {string} requestId 去重用的稳定 id（同 id 重复投递会被宿主拒绝）
   * @param {string} text 内容
   * @param {'steer'|'queue'} mode steer 进入当前/下一步；queue 进入下一轮（空闲时唤醒）
   */
  async deliver(sessionId, requestId, text, mode) {
    const agent = this.ctx.agents.get(sessionId)
    if (agent) {
      const message = await this.userMessage(`${SOURCE_KIND}:${requestId}`, text)
      try {
        // steer 只在对方确实在跑时用；空闲时 followup 会唤醒它开新一轮。
        if (mode === 'steer' && agent.status === 'running') agent.steer(message)
        else agent.followup(message)
        return 'inbox'
      } catch (error) {
        this.warn(`${LOG_PREFIX} 收件箱投递失败，改用 prompt: %s`, String(error))
      }
    }
    await this.ctx.sessionController.prompt({
      requestId: `${SOURCE_KIND}:${requestId}`,
      sessionId,
      mode: mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
    })
    return 'prompt'
  }

  /** 子会话的工作目录：优先显式 cwd，其次主会话目录，最后进程 cwd。 */
  cwdFor(agent, explicit) {
    if (explicit) return explicit
    if (this.config.inheritWorkingDirectory && agent) {
      try {
        const directory = this.ctx.get('workingDirectory')?.get(agent.session)
        if (directory) return directory
      } catch { /* 服务缺失时退回进程 cwd */ }
    }
    return process.cwd()
  }

  /** 解析或登记一个 workspace，让子会话在工作区列表里可见。 */
  async workspaceFor(cwd) {
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry) return undefined
    try {
      const existing = await registry.resolveByPath(cwd)
      if (existing) return existing
    } catch { /* 该目录尚未登记，下面新建 */ }
    return registry.create(cwd)
  }

  /**
   * 新建子 Session 并取回 Agent。
   * 注意（见 docs/api-contracts.md）：create 会立即建 Agent，resolveAgent 只做 resume；
   * workspaceId 与 cwd 互斥，二者只能给一个。
   */
  async createWorker(sessionId, cwd, title, options) {
    const workspace = await this.workspaceFor(cwd)
    const request = { sessionId, ...(workspace ? { workspaceId: workspace.id } : { cwd }) }
    if (options.agentPreset) request.agentPreset = options.agentPreset
    await this.ctx.sessionController.create(request)

    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if (resolved?.error) throw new Error(`无法解析子会话 ${sessionId}: ${resolved.error.code ?? 'unknown'}`)
    const agent = resolved.agent

    const preset = options.permissionPreset || this.config.permissionPreset
    if (preset) {
      try { this.ctx.get('permissionPresets')?.set?.(agent.session, preset) }
      catch (error) { this.warn(`${LOG_PREFIX} 设置权限预设失败: %s`, String(error)) }
    }

    // 标题只影响可读性，失败不算任务失败。
    try { await this.ctx.sessionController.rename({ sessionId, title }) }
    catch { /* 忽略 */ }
    return agent
  }

  /**
   * 第一次从这个会话派发时，把工作方式写进它的系统提示（只加一次）。
   * 注册在 agent.ctx 上，所以只影响该会话，不影响部署里的其他会话。
   */
  hint(agent) {
    if (this.hinted.has(agent.id)) return
    this.hinted.add(agent.id)
    try {
      const prompt = agent.ctx?.systemPrompt
      if (typeof prompt?.section !== 'function') return
      const dispose = prompt.section({ name: PROMPT_SECTION, order: 9998, text: DISPATCH_HINT })
      if (typeof dispose === 'function') this.hintDisposers.add(dispose)
    } catch (error) {
      this.warn(`${LOG_PREFIX} 无法为该会话注册工作方式提示: %s`, String(error))
    }
  }

  /** 插件卸载：收回所有已注册的提示段。 */
  dispose() {
    for (const dispose of this.hintDisposers) {
      try { dispose() } catch { /* 宿主已回收 */ }
    }
    this.hintDisposers.clear()
    this.hinted.clear()
  }
}
