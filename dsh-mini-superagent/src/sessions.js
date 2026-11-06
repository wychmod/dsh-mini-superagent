/**
 * DSH 适配层：所有会被宿主 API 变更影响到的调用都收在这里——
 * 建子会话、取 Agent、设权限预设、注入提示段、把消息投递进另一个 Session。
 *
 * 逻辑层（dispatch.js）只调用这里的语义方法，不直接碰 ctx.sessionController /
 * agent.steer 这些细节，换版本时只需要改这一个文件。
 */
import { LOG_PREFIX, PROMPT_SECTION, SOURCE_KIND } from './constants.js'

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
    /** 每个会话当前的提示求值函数；换模式时只替换这里，不重复注册段。 */
    this.hintTexts = new Map()
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
   * 把一条消息投递给另一个 Session。
   *
   * @param {string} sessionId 目标会话
   * @param {string} requestId 去重用的稳定 id（同 id 重复投递会被宿主拒绝）
   * @param {string} text 内容
   * @param {{ mode?: 'steer'|'queue', wake?: boolean }} [options]
   *   - `mode: 'steer'` 期望并入当前回合的下一步；对方空闲时自动降级为 followup（唤醒它开新一轮）。
   *   - `mode: 'queue'` 排到下一轮，空闲时唤醒。
   *   - `wake: false` 表示**不要唤醒**空闲的会话：只追加到下一步，等它自己下一轮再看。
   * @returns {Promise<{ delivered: 'inbox'|'prompt'|'injected', woke: boolean }>}
   */
  async deliver(sessionId, requestId, text, options = {}) {
    const { mode = 'queue', wake = true } = typeof options === 'string' ? { mode: options } : options
    const agent = this.ctx.agents.get(sessionId)

    // 不唤醒：用 inject 只把消息放进下一步，不打断也不叫醒。
    // 这是 relay 里 wake=false 分支该走的路径——0.6.0 之前它走 steer，
    // 而 steer 对空闲 agent 会静默降级成 followup（唤醒），与「不打扰」的意图相反。
    if (agent && wake === false && typeof agent.inject === 'function') {
      const frozen = await this.userMessage(`${SOURCE_KIND}:${requestId}`, text)
      try {
        agent.inject(frozen)
        return { delivered: 'injected', woke: false }
      } catch (error) {
        this.warn(`${LOG_PREFIX} inject 投递失败，改用 followup: %s`, String(error))
      }
    }

    if (agent) {
      const message = await this.userMessage(`${SOURCE_KIND}:${requestId}`, text)
      try {
        // steer 只在对方确实在跑时用；空闲时 followup 会唤醒它开新一轮。
        if (mode === 'steer' && agent.status === 'running') {
          agent.steer(message)
          return { delivered: 'inbox', woke: false }
        }
        agent.followup(message)
        // followup 对空闲 agent 等于「叫醒它」，对运行中的就是排到下一轮
        return { delivered: 'inbox', woke: agent.status !== 'running' }
      } catch (error) {
        this.warn(`${LOG_PREFIX} 收件箱投递失败，改用 prompt: %s`, String(error))
      }
    }

    // 降级路径：sessionController.prompt 构造的消息来源是 { kind: 'user' }，
    // 主会话模型会把这报告当成**用户亲口说的**。这与 constants.js 里
    // 「报告以自己的来源出现，不会被误当成用户手打的消息」的承诺直接矛盾。
    // 不能既不送达也不说清楚，所以：照常投递（总比丢了强），但记一条 warn
    // 明确说明来源被降级，并把 delivered 标成 'prompt' 让调用方能区分。
    this.warn(`${LOG_PREFIX} 会话 %s 的收件箱不可用，降级用 prompt 投递；`
      + '该消息的来源会退化成 user（主会话会把它当成用户消息）', sessionId)
    await this.ctx.sessionController.prompt({
      requestId: `${SOURCE_KIND}:${requestId}`,
      sessionId,
      mode: mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
    })
    return { delivered: 'prompt', woke: true }
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
   *
   * 关于返回值：`create({ sessionId })` 在「会话已存在且非空白」时**可能换号**，
   * 返回值里的 sessionId 才是真的。0.6.0 之前这里丢掉了返回值，紧接着用
   * 请求里的 sessionId 去 resolveAgent —— 换号的情况下必然 not-found，
   * 任务 failed 而真会话成了孤儿。现在优先采用返回值里的 id。
   *
   * @returns {Promise<{ agent: object, sessionId: string }>}
   */
  async createWorker(sessionId, cwd, title, options) {
    // 显式给了 workspaceId 就直接用（子会话住在【派发】工作区）；否则按目录反查/登记。
    let request
    if (options.workspaceId) {
      request = { sessionId, workspaceId: options.workspaceId }
    } else {
      const workspace = await this.workspaceFor(cwd)
      request = { sessionId, ...(workspace ? { workspaceId: workspace.id } : { cwd }) }
    }
    if (options.agentPreset) request.agentPreset = options.agentPreset
    const created = await this.ctx.sessionController.create(request)

    // create 可能换了号（已存在且非空白时铸新 id）；以返回值为准。
    const actualId = typeof created?.sessionId === 'string' && created.sessionId
      ? created.sessionId
      : sessionId
    if (actualId !== sessionId) {
      this.warn(`${LOG_PREFIX} 会话 id 被宿主换成 %s（原请求 %s），后续按新 id 使用`, actualId, sessionId)
    }

    const resolved = await this.ctx.sessionController.resolveAgent(actualId)
    if (resolved?.error) throw new Error(`无法解析子会话 ${actualId}: ${resolved.error.code ?? 'unknown'}`)
    const agent = resolved.agent

    const preset = options.permissionPreset || this.config.permissionPreset
    if (preset) {
      try { this.ctx.get('permissionPresets')?.set?.(agent.session, preset) }
      catch (error) { this.warn(`${LOG_PREFIX} 设置权限预设失败: %s`, String(error)) }
    }

    // 标题只影响可读性，失败不算任务失败。
    try { await this.ctx.sessionController.rename({ sessionId: actualId, title }) }
    catch { /* 忽略 */ }
    return { agent, sessionId: actualId }
  }

  /**
   * 把会话的工作目录切到别处。
   * 子会话住在【派发】工作区（侧边栏干净），但活要干在目标任务的工作区里。
   * 失败只记 warn：目录切不过去时子会话仍能跑，只是落在自己的目录里。
   */
  async enterDirectory(agent, directory) {
    const working = this.ctx.get('workingDirectory')
    if (typeof working?.set !== 'function') return
    try {
      await working.set(agent, directory)
    } catch (error) {
      this.warn(`${LOG_PREFIX} 切换子会话工作目录到 %s 失败: %s`, directory, String(error))
    }
  }

  /**
   * 给会话装上「工作方式」提示段。
   *
   * 段文本是**函数**：DSH 每次装配系统提示都会重新求值，所以模式一变
   * （在输入框里切换派发目标），下一轮请求就用新的文本——不需要重载插件。
   *
   * @param {object} agent 目标会话
   * @param {() => string} text 每次装配时求值的提示文本
   */
  hint(agent, text) {
    this.hintTexts.set(agent.id, text)
    if (this.hinted.has(agent.id)) return
    this.hinted.add(agent.id)
    try {
      const prompt = agent.ctx?.systemPrompt
      if (typeof prompt?.section !== 'function') return
      const resolve = () => {
        const current = this.hintTexts.get(agent.id)
        try { return typeof current === 'function' ? current() : String(current ?? '') }
        catch { return '' }
      }
      const dispose = prompt.section({ name: PROMPT_SECTION, order: 9998, text: resolve })
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
    this.hintTexts.clear()
  }
}
