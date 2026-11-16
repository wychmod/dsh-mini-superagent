/**
 * DSH 适配层：所有会被宿主 API 变更影响到的调用都收在这里——
 * 建子会话、取 Agent、设权限预设、注入提示段、把消息投递进另一个 Session。
 *
 * 逻辑层（dispatch.js）只调用这里的语义方法，不直接碰 ctx.sessionController /
 * agent.steer 这些细节，换版本时只需要改这一个文件。
 */
import { LOG_PREFIX, PROMPT_SECTION, SOURCE_KIND } from './constants.js'

/**
 * 两条路径是否指向同一个目录（用于「这个标题是不是被**别的**目录占着」）。
 *
 * 只在工作区登记这一处用得上，所以不进 `workspaces.js` 的公开表面。
 * 大小写不敏感：Windows 上 `D:\Idea\X` 与 `d:\idea\x` 是同一个目录，宿主 realpath 之后
 * 也可能把盘符/大小写规范化成另一种写法；不做这一步会因为「看起来不一样」而误判成撞车，
 * 于是明明同一个目录却拿到一个被加长过的标题。
 * 不做 realpath：那是 async 且可能抛错，而这里只是给标题做去重，粗粒度比较足够。
 */
function samePath(left, right) {
  const norm = value => String(value ?? '').trim().replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\')
  const a = norm(left)
  return !!a && a === norm(right)
}

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
    /**
     * 路由模式的工具收窄 disposer，按 agent id 记。
     * 同上：`agent.ctx` 的生命周期比插件长，卸载时要主动收回。
     */
    this.restrictDisposers = new Map()
    /**
     * 提示收敛钩子（`agent/pre-step` 的 disposer），按 agent id 记。
     * 与提示段同源：都挂在 `agent.ctx` 上，生命周期比插件长，卸载时要主动收回。
     */
    this.seriesWatchers = new Map()
    /** 宿主没有 `agent.ctx.on` 时只告警一次（见 `startSeriesWhenStale`）。 */
    this.seriesUnsupported = false
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

  /**
   * 这条 requestId 的消息是否**已经**在这条会话里——待处理的收件箱，或已进入历史的 user/message。
   *
   * 用途：投递重试前判重。报告的重试必须复用同一个 requestId，否则「第一次其实已投递、
   * 只是后面抛错」会变成两条一样的报告（0.8.0 及更早的 #deliverWithRetry 就是这样）。
   *
   * 两处都要查，因为它们是两个阶段：还在 `nextTurn`/`nextStep` 里 = 已入队未消费；
   * 出现在 `user/message` 事件里 = 已经被某一步取进上下文。只查前者会漏掉后者。
   *
   * @param {object} agent 目标 Agent
   * @param {string} requestId 调用方给的稳定 id（不含来源前缀）
   * @returns {boolean}
   */
  holds(agent, requestId) {
    const id = `${SOURCE_KIND}:${requestId}`
    try {
      const inbox = agent?.inbox
      const pending = [...(inbox?.nextTurn ?? []), ...(inbox?.nextStep ?? [])]
      if (pending.some(message => message?.id === id)) return true
    } catch { /* 收件箱读不到：继续查历史 */ }
    try {
      const session = agent?.session
      const events = (typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events?.()) ?? []
      for (const event of events) {
        if (event?.type === 'user/message' && event.data?.id === id) return true
      }
    } catch { /* 历史读不到：按未投处理，宁可重投也不静默丢 */ }
    return false
  }

  /**
   * 在这个 agent 的作用域上收窄工具面（路由模式：主会话不许改代码）。
   *
   * `restrict` 的三条硬约束决定了这里的写法：
   * 1. 必须在 `agent.ctx` 上调用，根 ctx 会抛 `requires a scoped context`；
   * 2. 只过滤**继承来的**工具（全局 + 祖先层），本层自己注册的滤不掉；
   * 3. **名字未知会抛错**——所以先 `get()` 探一下，缺哪个就跳过哪个。
   *
   * 用 `deny` 而不是 `allow`：各部署的工具集不一样，allow 一旦写死就会把
   * 我们不认识的工具一起收走（包括本插件自己的 9 个）。
   *
   * @param {object} agent 目标 Agent
   * @param {string[]} deny 要收走的工具名
   * @returns {(() => void) | undefined} disposer；宿主不支持时返回 undefined
   */
  restrictTools(agent, deny) {
    const tools = agent?.ctx?.tools
    if (typeof tools?.restrict !== 'function') {
      this.warn(`${LOG_PREFIX} 宿主没有 agent.ctx.tools.restrict，跳过路由模式的工具收窄`)
      return undefined
    }
    const names = []
    for (const raw of Array.isArray(deny) ? deny : []) {
      const name = String(raw ?? '').trim()
      if (!name) continue
      let exists = true
      try {
        if (typeof tools.get === 'function') exists = !!tools.get(name, agent)
      } catch { exists = false }
      if (exists) names.push(name)
    }
    if (!names.length) {
      // 一个都没命中就明确记一条：配了却没生效，静默会让「说好的禁止」变成空话。
      this.warn(`${LOG_PREFIX} 路由模式没有可收窄的工具（配置：%s）`, (deny ?? []).join(', ') || '(空)')
      return undefined
    }
    try {
      const dispose = tools.restrict({ deny: names })
      if (typeof dispose !== 'function') return undefined
      // 由这里统一持有，插件卸载时一次性收回；Dispatch 只记「谁的已经收窄过」。
      this.restrictDisposers.set(agent.id, dispose)
      return dispose
    } catch (error) {
      this.warn(`${LOG_PREFIX} 路由模式收窄工具失败: %s`, String(error))
      return undefined
    }
  }

  /** 会话被销毁时收回它的工具收窄，别让登记表随会话数一直长。 */
  forgetRestrict(agentId) {
    const dispose = this.restrictDisposers.get(agentId)
    if (!dispose) return
    this.restrictDisposers.delete(agentId)
    try { dispose() } catch { /* 宿主已回收 */ }
  }

  /**
   * 把 `model` 应用到刚建好的子会话上。
   *
   * 为什么不能在建会话时传：`SessionCreateRequest` 只有
   * `{workspaceId?, cwd?, sessionId?, agentPreset?}`，没有模型字段；
   * 模型是「首个请求之前记一条 model/selection」来定的（官方原型同样这么做，
   * 且特意避开会改全局默认的 selectModel）。
   *
   * 拿不到能力时**抛错**而不是假装成功：工具 schema 承诺了 model，
   * 悄悄用默认模型比报错更贵——用户会以为自己在用便宜/更强的那个模型。
   *
   * @param {object} agent 刚建好的 Agent
   * @param {string} spec `provider/model` 或裸 `model` id
   */
  async applyModel(agent, spec) {
    const raw = String(spec ?? '').trim()
    if (!raw) return undefined
    const llm = this.ctx.get('llm')
    if (typeof llm?.resolveCallConfig !== 'function') {
      throw new Error(`宿主没有 llm.resolveCallConfig，无法应用 model="${raw}"；去掉 model 参数再派发`)
    }
    const cut = raw.indexOf('/')
    const provider = cut > 0 ? raw.slice(0, cut) : undefined
    const model = cut > 0 ? raw.slice(cut + 1) : raw
    const resolved = await llm.resolveCallConfig({ ...(provider ? { provider } : {}), model })
    const selection = {
      provider: resolved?.provider,
      model: resolved?.model,
      ...(resolved?.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
    }
    const session = agent?.session
    if (typeof session?.append !== 'function') {
      throw new Error('宿主 session 不支持 append，无法记下 model/selection；去掉 model 参数再派发')
    }
    session.append('model/selection', selection)
    return selection
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

  /**
   * 解析或登记一个 workspace，让子会话在工作区列表里可见。
   *
   * **标题为什么必须显式给**：`workspaceRegistry.create(path)` 不传 title 时，宿主用目录 basename
   * 当标题。于是「仓库根 `...\dsh-mini-superagent`」和「包根 `...\dsh-mini-superagent\dsh-mini-superagent`」
   * 各自登记出一条**同名**工作区。实测（2026-11-08 12:10）就是这么冒出两个 title 相同的条目的：
   * 一个在 `C:\...\派发\2026-11-07`，另一个在 `C:\...\mini-superagent`，用户在列表里根本分不清。
   * 而且它不是一次性脏数据 —— 每次按目录反查登记都会再撞一次，所以修在登记这一侧。
   *
   * 已注册的目录仍然原样返回（不改已有工作区的标题，那是用户可能已经认过的名字）。
   */
  async workspaceFor(cwd) {
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry) return undefined
    try {
      const existing = await registry.resolveByPath(cwd)
      if (existing) return existing
    } catch { /* 该目录尚未登记，下面新建 */ }
    // 注册表读不到时按「没有已占用标题」处理：宁可这次可能撞名，也不能因此不登记工作区。
    let items = []
    try { items = registry.list?.() ?? [] } catch { items = [] }
    return registry.create(cwd, this.distinctTitle(cwd, items))
  }

  /**
   * 给 `cwd` 挑一个不与**已有工作区**撞车的标题。
   *
   * 三条硬约束（来自实际踩坑）：
   * - **人能从标题看出是哪个目录**：用路径末段拼接，而不是 uuid、随机数或自增号；
   * - **不与已有标题重复**：先试 basename，撞了就逐段加长（`proj` → `idea/proj` → `D:/idea/proj`）；
   * - **不改已有工作区的标题**：只决定本次新建那一个；谁先登记谁拿短名，先后顺序变了标题会变，
   *   但已有条目一个字都不动 —— 改别人的标题等于把用户认过的名字偷偷换掉。
   *
   * 为什么用 `/` 拼：标题是给人读的，`/` 任何平台都不需要转义，且天然表示「父/子」，
   * 与路径语序一致（`idea/proj` 读作「idea 下的 proj」）。
   *
   * 极端情况下（不同路径末段全同且都很深）才退回数字后缀 —— 有后缀总比再产出一条同名工作区好。
   *
   * @param {string} cwd 目录
   * @param {Array<{id?:string,title?:string,path?:string}>} items 注册表现有条目
   * @returns {string}
   */
  distinctTitle(cwd, items) {
    const path = String(cwd ?? '')
    const parts = path.split(/[\\/]+/).filter(Boolean)
    // 同一目录的既有条目不算撞车：那种情况宿主会复用同一个工作区，传去的标题会被忽略。
    const taken = new Set(
      (Array.isArray(items) ? items : [])
        .filter(item => !samePath(item?.path, path))
        .map(item => String(item?.title ?? '').trim().toLowerCase())
        .filter(Boolean),
    )
    // 从「只有末段」逐段加长：最短的可读形式优先，只有真的撞了才变得更长。
    for (let count = 1; count <= parts.length; count += 1) {
      const candidate = parts.slice(-count).join('/')
      if (!taken.has(candidate.toLowerCase())) return candidate
    }
    const base = parts.at(-1) ?? path ?? 'workspace'
    let suffix = 2
    let candidate = base
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${base}（${suffix}）`
      suffix += 1
    }
    return candidate || 'workspace'
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

    // 模型：建会话时给不了（SessionCreateRequest 没有模型字段），只能在首个请求之前
    // 记一条 model/selection。失败就抛出去让任务 failed——静默用默认模型等于骗人。
    if (options.model) await this.applyModel(agent, options.model)

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

  /**
   * 提示语义变了就开一个新的模型消息序列，让宿主把历史里的旧提示清掉。
   *
   * 为什么需要：宿主的 `in-history` 路由对**变化的提示是追加，不是替换**
   * （app.asar 的 `SystemPromptProjection.project`：文本变了就 `append` 一个新的
   * `system/message`；只有开新序列时才改写节点 0 并逐条清空后续非空的旧节点）。
   * 于是切回「不派发」之后旧的强制段并没有消失，仍在面里、仍随 `deriveMessages()`
   * 进请求——模型同时看到两段互相矛盾的指令。文本函数只决定「下一次装配发什么」，
   * 改不了「历史里剩什么」。
   *
   * `startsRequestSeries` 是宿主自己的收敛入口，借用它即可，不需要改宿主。
   * （走提示上下文也绕不过去：`systemPrompt.context()` 的追加快照会连带清掉旧的
   * **上下文**节点，但系统提示节点不归它管。）
   *
   * 代价：开新序列会让提供方的前缀缓存从系统提示处失效一次。所以判据必须是
   * 「语义真的变了」，由调用方给（`stale`，每步问一次），只在那一步置位。
   *
   * @param {object} agent 目标会话
   * @param {() => boolean} stale 本步是否需要收敛（每步调用一次，最多一次）
   */
  startSeriesWhenStale(agent, stale) {
    if (!agent?.id) return
    if (this.seriesWatchers.has(agent.id)) return
    // 宿主不支持时的告警只记一次：`refreshHint` 在每次切模式/启动时都会调到这里，
    // 不去重就会把同一条 warn 刷成噪音，反而盖掉真正有用的日志。
    if (this.seriesUnsupported) return
    const target = agent.ctx
    if (typeof target?.on !== 'function') {
      // 记成「宿主整体不支持」而不是按会话记：拿不到 ctx.on 是版本问题，不是个别会话的问题。
      this.seriesUnsupported = true
      this.warn(`${LOG_PREFIX} 宿主没有 agent.ctx.on，提示段切模式后无法收敛（旧段会留在历史里）`)
      return
    }
    try {
      const dispose = target.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        // 只接管 enter：reject 是别的监听器的决定，原样传下去。
        if (decision?.kind !== 'enter') return decision
        try {
          if (!stale()) return decision
          // spread 保留调用方与其它监听器写进去的字段（消息批次等）。
          return { ...decision, startsRequestSeries: true }
        } catch { return decision }
      })
      if (typeof dispose !== 'function') return
      this.seriesWatchers.set(agent.id, dispose)
    } catch (error) {
      this.warn(`${LOG_PREFIX} 无法为该会话注册提示收敛钩子: %s`, String(error))
    }
  }

  /** 插件卸载：收回所有已注册的提示段与工具收窄。 */
  dispose() {
    for (const dispose of this.hintDisposers) {
      try { dispose() } catch { /* 宿主已回收 */ }
    }
    this.hintDisposers.clear()
    for (const dispose of this.seriesWatchers.values()) {
      try { dispose() } catch { /* 宿主已回收 */ }
    }
    this.seriesWatchers.clear()
    this.hinted.clear()
    this.hintTexts.clear()
    // 工具收窄是挂在 agent.ctx 上的副作用，作用域比插件长，卸载时必须收回，
    // 否则重载后主会话仍然看不到 write/edit（用户会以为插件坏了）。
    for (const dispose of this.restrictDisposers.values()) {
      try { dispose() } catch { /* 宿主已回收 */ }
    }
    this.restrictDisposers.clear()
  }
}
