/**
 * dsh-dispatch — 后台任务派发（Host 插件，纯 ESM，无构建、无运行时依赖）
 *
 * 能力模型，与 dsh-superagent 的“主会话 + 执行器 Session”一致，但只保留派发这一件事：
 *   主会话 --dispatch_launch--> 新建子 Session（默认自己的工作目录）--独立跑一轮或多轮-->
 *   子会话 --dispatch_report / 回合结束--> 报告回流主会话（唤醒主会话的下一轮）
 *
 * 设计要点：
 * - 工具注册在插件根 context 上，因此对所有 Session 可见；用“调用者是不是已登记的
 *   worker Session”来区分权限：主会话可以派发，worker 只能报告。
 * - 不阻塞：dispatch_launch 立即返回；报告通过 Agent 收件箱以插件来源的 user message
 *   投递，主会话空闲时被唤醒、忙碌时并入下一步。
 * - 任务表落盘（JSON），插件重启后把未结束的任务标成 interrupted，不假装还活着。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-dispatch'
export const inject = ['tools', 'agents', 'sessionController']

/** 插件版本，出现在 dispatch_list 里便于排查“跑的是哪一版”。 */
const VERSION = '0.1.0'

/** 默认配置；cordis.patch.yml 里的 config 会覆盖这里的字段。 */
const DEFAULTS = {
  /** 同时真正在跑（running）的子会话上限；超出的任务进入 queued，有空位自动开始。 */
  maxWorkers: 6,
  /** 每个主会话最多累计派发多少个任务。 */
  maxTasksPerSession: 64,
  /** 子会话默认继承主会话的工作目录。 */
  inheritWorkingDirectory: true,
  /** 子会话权限预设；空字符串表示继承 DSH 默认。 */
  permissionPreset: '',
  /** 任务表落盘目录；空字符串表示 <DSH_HOME>/dsh-dispatch。 */
  stateDir: '',
  /** worker 回合结束后自动回报给主会话。 */
  reportOnTurnEnd: true,
  /** 注入 worker 的首条消息里，任务简报的最大字符数（超出会写进会话的初始消息并截断）。 */
  maxBriefChars: 12000,
}

/** 已结算（不再占并发位、不再等它）的状态。 */
const SETTLED = new Set(['done', 'blocked', 'failed', 'cancelled', 'ended', 'interrupted'])

/** 本进程内的消息序号；配合每次启动的随机前缀，保证报告/追问的消息 id 跨重启也不重复。 */
let messageSeq = 0
const BOOT = Math.random().toString(36).slice(2, 8)
const nextMessageId = (taskId, kind) => `${taskId}:${kind}:${BOOT}:${++messageSeq}`

/** 已经结束、不该再触发自动回报的报告状态。 */
const TERMINAL_REPORT = new Set(['done', 'blocked', 'failed', 'cancelled'])

/** 单次进程最多保留多少条报告（落盘同样受限，防止任务表无限增长）。 */
const MAX_REPORTS = 50

const now = () => new Date().toISOString()
let counter = 0
/** 生成短任务 id：t-<时间36>-<序号36>，便于人读且不复用。 */
function newTaskId() {
  counter = (counter + 1) % 46656
  return `t-${Date.now().toString(36)}-${counter.toString(36)}`
}

/** 从 Session 事件里取最后一条 assistant 文本；取不到就返回空串。 */
function lastAssistantText(agent) {
  let events = []
  try {
    const session = agent?.session
    events = (typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events?.()) ?? []
  } catch { return '' }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content ?? []
    const text = content.filter(block => block?.type === 'text').map(block => block.text).join('\n').trim()
    if (text) return text
  }
  return ''
}

/** 把长文本截断到 limit 字符，保留结尾（结尾通常是结论）。 */
function clip(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 400))}\n…（已截断 ${value.length - limit + 400} 字符）…\n${value.slice(-400)}`
}

/** 单行摘要，供列表展示。 */
function oneLine(text, limit = 160) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

/**
 * 只注入给“用过派发的”主会话，不进 worker 的提示词。
 * 目的是把模型从“同步等结果”拉回“派发—收报告—再派发”的循环。
 */
const DISPATCH_HINT = [
  '[dsh-dispatch 工作方式]',
  '你可以把任务派给后台子会话并行执行：dispatch_launch 立即返回，子会话在自己的 Session 里独立工作。',
  '不要用 dispatch_wait 空等结果，也不要自己重复执行已经派出去的工作——报告会作为消息自己回来。',
  '收到报告后：合并结论、必要时用 dispatch_message 追问或纠偏、然后继续派发下一批。',
].join('\n')

/**
 * 派发表：持有任务、并发位与“等待某个任务结算”的等待者。
 * 它自己不做 I/O；落盘由 Dispatch 负责。
 */
class TaskTable {
  constructor(maxWorkers) {
    this.maxWorkers = Math.max(1, Number(maxWorkers) || 1)
    /** @type {Map<string, any>} */
    this.tasks = new Map()
    /** 按登记顺序排队、尚未开始的 task id。 */
    this.queue = []
    /** 等待结算的 resolver：taskId -> Set<fn>。 */
    this.waiters = new Map()
  }

  get(id) { return this.tasks.get(id) }

  /** 某个 worker Session 对应的任务。 */
  byWorker(sessionId) {
    for (const task of this.tasks.values()) if (task.workerSessionId === sessionId) return task
    return undefined
  }

  /** 某个主会话派出的任务，最新在前。 */
  ofSession(sessionId) {
    return [...this.tasks.values()].filter(task => task.parentSessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  runningCount() {
    let count = 0
    for (const task of this.tasks.values()) if (task.status === 'running') count += 1
    return count
  }

  add(task) {
    this.tasks.set(task.id, task)
    if (task.status === 'queued') this.queue.push(task.id)
    return task
  }

  /** 取出下一个能开始的任务：队列里仍有 queued 且有空位时返回它。 */
  takeRunnable() {
    if (this.runningCount() >= this.maxWorkers) return undefined
    while (this.queue.length) {
      const id = this.queue.shift()
      const task = this.tasks.get(id)
      if (task && task.status === 'queued') return task
    }
    return undefined
  }

  /** 标记一个任务进入结算状态，并唤醒等待者。 */
  settle(task, status) {
    task.status = status
    task.updatedAt = now()
    const waiting = this.waiters.get(task.id)
    if (waiting) {
      this.waiters.delete(task.id)
      for (const resolve of waiting) resolve(task)
    }
  }

  /** 等一组任务全部结算；超时后按当前状态返回。 */
  waitFor(tasks, timeoutMs) {
    const pending = tasks.filter(task => !SETTLED.has(task.status))
    if (!pending.length) return Promise.resolve(tasks)
    return new Promise(resolve => {
      let done = false
      const timer = setTimeout(() => { done = true; resolve(tasks) }, timeoutMs)
      timer.unref?.()
      let remaining = pending.length
      const finishOne = () => {
        remaining -= 1
        if (remaining > 0 || done) return
        done = true
        clearTimeout(timer)
        resolve(tasks)
      }
      for (const task of pending) {
        const set = this.waiters.get(task.id) ?? new Set()
        set.add(finishOne)
        this.waiters.set(task.id, set)
      }
    })
  }
}

/** 插件主体。 */
class Dispatch {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = { ...DEFAULTS, ...(config ?? {}) }
    this.table = new TaskTable(this.config.maxWorkers)
    this.log = (...args) => ctx.logger?.info?.(...args)
    this.warn = (...args) => ctx.logger?.warn?.(...args)
    this.freezePromise = undefined
    this.persistTimer = undefined
    this.disposed = false
    this.stateFile = join(this.config.stateDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-dispatch'), 'tasks.json')
    /** 已经加过工作方式提示的主会话。 */
    this.hinted = new Set()
  }

  /** 第一次从这个会话派发时，把“派发—收报告—再派发”的工作方式写进它的系统提示（只加一次）。 */
  hint(agent) {
    if (this.hinted.has(agent.id)) return
    this.hinted.add(agent.id)
    try {
      const prompt = agent.ctx?.systemPrompt
      if (typeof prompt?.section !== 'function') return
      prompt.section({ name: 'dsh-dispatch', order: 9998, text: DISPATCH_HINT })
    } catch (error) {
      this.warn('dsh-dispatch: 无法为该会话注册工作方式提示: %s', String(error))
    }
  }

  /** 懒加载 freezeMessage；拿不到就退化为普通冻结对象（投递仍可能成功）。 */
  async freeze() {
    this.freezePromise ??= import('@deepseek-ai/dsh-llm')
      .then(mod => mod.freezeMessage)
      .catch(error => { this.warn('dsh-dispatch: 无法加载 @deepseek-ai/dsh-llm（将退化投递）: %s', String(error)); return undefined })
    return this.freezePromise
  }

  /** 构造一条“插件来源”的 user message，交给 Agent 收件箱。 */
  async userMessage(id, text, summary) {
    const freeze = await this.freeze()
    const source = summary ? { kind: 'dsh-dispatch', form: 'notice', summary } : { kind: 'dsh-dispatch', form: 'relay' }
    const raw = { id, role: 'user', content: [{ type: 'text', text }], source }
    return freeze ? freeze(raw) : Object.freeze(raw)
  }

  /**
   * 把一条文本投递给另一个 Session。
   * mode: 'steer' 进入当前/下一步；'queue' 进入下一轮（空闲时会唤醒它）。
   * 优先走 Agent 收件箱（带插件来源与去重 id）；失败时退回 sessionController.prompt。
   */
  async deliver(sessionId, requestId, text, mode) {
    const agent = this.ctx.agents.get(sessionId)
    if (agent) {
      const message = await this.userMessage(`dsh-dispatch:${requestId}`, text)
      try {
        if (mode === 'steer' && agent.status === 'running') agent.steer(message)
        else agent.followup(message)
        return 'inbox'
      } catch (error) {
        this.warn('dsh-dispatch: 收件箱投递失败，改用 prompt: %s', String(error))
      }
    }
    await this.ctx.sessionController.prompt({
      requestId: `dsh-dispatch:${requestId}`,
      sessionId,
      mode: mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
    })
    return 'prompt'
  }

  // ---------------------------------------------------------------- 会话

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

  /** 解析或登记一个 workspace，使子会话在工作区列表里可见。 */
  async workspaceFor(cwd) {
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry) return undefined
    try {
      const existing = await registry.resolveByPath(cwd)
      if (existing) return existing
    } catch { /* 目录尚未登记 */ }
    return registry.create(cwd)
  }

  /** 新建子 Session 并取回 Agent。 */
  async createWorkerSession(sessionId, cwd, title, options) {
    const workspace = await this.workspaceFor(cwd)
    const request = { sessionId, ...(workspace ? { workspaceId: workspace.id } : { cwd }) }
    if (options.agentPreset) request.agentPreset = options.agentPreset
    await this.ctx.sessionController.create(request)
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if (resolved?.error) throw new Error(`无法解析子会话 ${sessionId}: ${resolved.error.code ?? 'unknown'}`)
    const agent = resolved.agent
    const preset = options.permissionPreset || this.config.permissionPreset
    if (preset) {
      try { this.ctx.get('permissionPresets')?.set?.(agent.session, preset) } catch (error) { this.warn('dsh-dispatch: 设置权限预设失败: %s', String(error)) }
    }
    try { await this.ctx.sessionController.rename({ sessionId, title }) } catch { /* 标题非关键 */ }
    return agent
  }

  // ---------------------------------------------------------------- 任务

  /** 派发一个任务：登记 + 建会话 + 投递简报。并发位不够时排队。 */
  async launch(agent, input) {
    const sessionId = agent.id
    const existing = this.table.ofSession(sessionId)
    if (existing.length >= this.config.maxTasksPerSession) {
      throw new Error(`本会话已派发 ${existing.length} 个任务，达到上限 ${this.config.maxTasksPerSession}；请先收束旧任务`)
    }
    const id = newTaskId()
    const task = {
      id,
      title: oneLine(input.title, 120) || '未命名任务',
      brief: String(input.brief ?? ''),
      parentSessionId: sessionId,
      workerSessionId: `dispatch-${id}`,
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
      turnStartedAt: undefined,
      lastReportAt: undefined,
      lastText: '',
      reports: [],
      cwd: this.cwdFor(agent, input.cwd),
      model: input.model,
      agentPreset: input.agentPreset,
      permissionPreset: input.permissionPreset,
    }
    this.table.add(task)
    this.hint(agent)
    this.schedulePersist()
    void this.pump()
    return task
  }

  /** 把排队中的任务按并发位依次启动。 */
  async pump() {
    if (this.disposed) return
    for (;;) {
      const task = this.table.takeRunnable()
      if (!task) return
      try {
        await this.start(task)
      } catch (error) {
        task.error = String(error)
        this.table.settle(task, 'failed')
        this.schedulePersist()
        this.ctx.logger?.error?.('dsh-dispatch: 任务 %s 启动失败: %s', task.id, String(error))
        await this.relayFailure(task)
      }
    }
  }

  /** 真正启动一个任务：建会话 → 投递任务简报。 */
  async start(task) {
    task.status = 'running'
    task.startedAt = now()
    task.updatedAt = task.startedAt
    this.schedulePersist()
    const agent = await this.createWorkerSession(task.workerSessionId, task.cwd, `[派发] ${task.title}`, task)
    task.lastText = ''
    const text = this.workerPrompt(task)
    await this.deliver(task.workerSessionId, `${task.id}:start`, text, 'queue')
    this.log('dsh-dispatch: 任务 %s 已启动，子会话 %s', task.id, task.workerSessionId)
    return agent
  }

  /** worker 的首条消息：任务简报 + 工作规则 + 报告协议。 */
  workerPrompt(task) {
    const brief = clip(task.brief, this.config.maxBriefChars)
    return [
      `你是主会话派发的后台执行者（worker）。独立完成下面这个任务，完成后向派发者汇报。`,
      ``,
      `任务 ID: ${task.id}`,
      `任务标题: ${task.title}`,
      `工作目录: ${task.cwd}`,
      ``,
      `任务简报:`,
      brief || '（未提供简报；请依据标题自行判断，并在报告里说明你的假设）',
      ``,
      `工作规则:`,
      `1. 直接开工，不要等待进一步指示；能自己判断的就自行决定，并在报告里写明假设。`,
      `2. 完成后必须调用工具 dispatch_report 汇报：status="done"，summary 用 3-6 行说清做了什么、改了哪些文件、如何验证、遗留风险。`,
      `3. 只有在真正被阻塞（缺凭据、需要人决策、外部依赖不可用）时才用 dispatch_report 报 status="blocked"，并说明需要什么。`,
      `4. 汇报之后，用一段简短的话收尾并结束本轮，不要做无关动作，也不要空转。`,
      `5. dispatch_launch / dispatch_cancel / dispatch_wait 是主会话的工具，你不要调用；你的工具是 dispatch_report（以及常规的读写、搜索、执行工具）。`,
      `6. 任务超出你的能力边界时，报 blocked 并给出你判断的原因，不要伪造结果。`,
    ].join('\n')
  }

  /** 记录一次 worker 报告，并按需回流主会话。 */
  async report(agent, input) {
    const workerId = agent.id
    const task = this.table.byWorker(workerId)
    if (!task) throw new Error('dispatch_report 只能由被派发的 worker 调用；当前会话不属于任何派发任务')
    if (task.status === 'cancelled') return { recorded: false, task_id: task.id, note: '任务已取消，报告不再回流' }
    const status = String(input.status || 'progress')
    const summary = String(input.summary ?? '').trim()
    if (!summary) throw new Error('dispatch_report 需要 summary')
    const entry = { at: now(), status, summary, detail: input.detail ? String(input.detail) : undefined }
    task.reports.push(entry)
    if (task.reports.length > MAX_REPORTS) task.reports.splice(0, task.reports.length - MAX_REPORTS)
    task.lastReportAt = entry.at
    task.updatedAt = entry.at
    if (status === 'done' || status === 'failed' || status === 'cancelled' || status === 'blocked') {
      this.table.settle(task, status)
    }
    this.schedulePersist()
    const wake = status !== 'progress'
    await this.relay(task, this.reportText(task, entry), wake)
    return { recorded: true, task_id: task.id, status: task.status }
  }

  /** 报告文本：给主会话模型看的紧凑结构化消息。 */
  reportText(task, entry) {
    const head = `[dispatch] 任务 ${task.id} · ${task.title} · 报告 ${entry.status}`
    const tail = entry.detail ? `\n详情：\n${clip(entry.detail, 4000)}` : ''
    return `${head}\n摘要：\n${clip(entry.summary, 6000)}${tail}\n（子会话 ${task.workerSessionId}）`
  }

  /** 把报告投递回派发它的主会话；wake=false 且主会话空闲时只记录不打扰。 */
  async relay(task, text, wake) {
    const parentId = task.parentSessionId
    const parent = this.ctx.agents.get(parentId)
    if (!parent) {
      this.warn('dsh-dispatch: 主会话 %s 已不在运行，报告只落到任务表', parentId)
      return 'dropped'
    }
    if (!wake && parent.status !== 'running') return 'recorded'
    try {
      await this.deliver(parentId, nextMessageId(task.id, 'relay'), text, 'steer')
      return 'delivered'
    } catch (error) {
      this.warn('dsh-dispatch: 报告投递失败 %s: %s', task.id, String(error))
      return 'failed'
    }
  }

  async relayFailure(task) {
    await this.relay(task, `[dispatch] 任务 ${task.id} · ${task.title} 启动失败：${task.error ?? '未知错误'}`, true)
  }

  /** worker 回合结束（status 变 idle）时的自动回报。 */
  async onWorkerIdle(sessionId) {
    const task = this.table.byWorker(sessionId)
    if (!task || task.status !== 'running') return
    const agent = this.ctx.agents.get(sessionId)
    const text = agent ? lastAssistantText(agent) : ''
    task.lastText = text
    task.updatedAt = now()
    // 本回合已经给过终态报告（done/blocked/failed），就不再补一条自动汇报；
    // 只报过 progress 的，仍然要有一次“回合结束”的回报，否则主会话会干等。
    const reportedThisTurn = !!task.turnStartedAt
      && task.reports.some(item => item.at >= task.turnStartedAt && TERMINAL_REPORT.has(item.status))
    if (reportedThisTurn) {
      if (task.status === 'running') this.table.settle(task, 'done')
      this.schedulePersist()
      return
    }
    this.table.settle(task, 'ended')
    this.schedulePersist()
    if (!this.config.reportOnTurnEnd) return
    const body = text ? clip(text, 5000) : '（worker 本轮没有输出文本）'
    await this.relay(task,
      `[dispatch] 任务 ${task.id} · ${task.title} · 一轮执行结束（worker 未显式报告）\n最后一条消息：\n${body}\n`
      + `\n用 dispatch_inspect 看细节，或用 dispatch_message 继续指派；任务已释放并发位。`, true)
  }

  /** 给某个任务追加一条消息（主会话 → worker），任务重新进入 running。 */
  async message(task, text, mode) {
    if (task.status === 'cancelled') throw new Error(`任务 ${task.id} 已取消；请重新 dispatch_launch 一个新任务`)
    const agent = this.ctx.agents.get(task.workerSessionId)
    if (!agent) {
      // 会话可能被关闭；先尝试恢复，恢复不了就明确报错，不要假装投递成功。
      const resolved = await this.ctx.sessionController.resolveAgent(task.workerSessionId)
      if (resolved?.error) throw new Error(`子会话 ${task.workerSessionId} 不可用：${resolved.error.code}`)
    }
    task.status = 'running'
    task.turnStartedAt = now()
    task.updatedAt = task.turnStartedAt
    this.schedulePersist()
    const delivery = mode === 'steer' ? 'steer' : 'queue'
    await this.deliver(task.workerSessionId, nextMessageId(task.id, 'msg'), text, delivery)
    return task
  }

  /** 取消一个任务：结束 worker 的当前回合，任务置为 cancelled。 */
  async cancel(task, reason) {
    this.table.queue = this.table.queue.filter(id => id !== task.id)
    const agent = this.ctx.agents.get(task.workerSessionId)
    if (agent) {
      try { agent.cancel({ kind: 'user' }, { keepInbox: false }) } catch (error) { this.warn('dsh-dispatch: 取消失败: %s', String(error)) }
    }
    task.cancelReason = reason
    this.table.settle(task, 'cancelled')
    this.schedulePersist()
    return task
  }

  // ---------------------------------------------------------------- 工具返回的视图

  /** 列表/详情里展示的任务摘要。 */
  card(task) {
    return {
      task_id: task.id,
      title: task.title,
      status: task.status,
      session_id: task.workerSessionId,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      ...(task.lastReportAt ? { last_report_at: task.lastReportAt } : {}),
      ...(task.reports.length ? { reports: task.reports.length } : {}),
      summary: task.reports.length ? oneLine(task.reports.at(-1).summary, 200) : oneLine(task.lastText, 200),
      ...(task.error ? { error: oneLine(task.error, 300) } : {}),
    }
  }

  /** 详情：卡片 + 最近报告 + worker 最后输出。 */
  detail(task) {
    return {
      ...this.card(task),
      brief: clip(task.brief, 2000),
      cwd: task.cwd,
      ...(task.reports.length ? { recent_reports: task.reports.slice(-5) } : {}),
      ...(task.lastText ? { last_worker_text: clip(task.lastText, 3000) } : {}),
    }
  }

  // ---------------------------------------------------------------- 落盘

  schedulePersist() {
    if (this.persistTimer || this.disposed) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.persist()
    }, 800)
    this.persistTimer.unref?.()
  }

  async persist() {
    try {
      const tasks = [...this.table.tasks.values()].map(task => ({ ...task, brief: clip(task.brief, 2000) }))
      await mkdir(dirname(this.stateFile), { recursive: true })
      await writeFile(this.stateFile, JSON.stringify({ version: 1, savedAt: now(), tasks }, null, 2), 'utf8')
    } catch (error) {
      this.warn('dsh-dispatch: 状态落盘失败: %s', String(error))
    }
  }

  /** 启动时读回任务表；进程之间没有活的 worker，所以未结算的一律标为 interrupted。 */
  async restore() {
    try {
      const raw = JSON.parse(await readFile(this.stateFile, 'utf8'))
      for (const saved of raw?.tasks ?? []) {
        if (!saved?.id || !saved?.workerSessionId) continue
        const task = { ...saved, reports: Array.isArray(saved.reports) ? saved.reports : [] }
        if (!SETTLED.has(task.status)) {
          task.status = 'interrupted'
          task.updatedAt = now()
        }
        this.table.tasks.set(task.id, task)
      }
      this.log('dsh-dispatch: 读回 %d 个历史任务（%s）', this.table.tasks.size, this.stateFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn('dsh-dispatch: 读取历史任务失败: %s', String(error))
    }
  }

  /** 插件卸载：停掉排队、冲刷状态。运行中的子会话交给 DSH 自身管理。 */
  async dispose() {
    this.disposed = true
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    await this.persist()
  }
}

// ------------------------------------------------------------------ 工具定义

/** 工具返回值的渲染：JSON 文本。 */
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const TaskRefSchema = { type: 'string', description: '任务 ID，例如 t-m0abc-1；也可以用 dispatch_list 查。' }

/** 注册全部工具。 */
function registerTools(ctx, dispatch) {
  const caller = exec => exec?.agent
  const requireCaller = exec => {
    const agent = caller(exec)
    if (!agent) throw new Error('该工具只能在某个会话（Agent）中调用')
    return agent
  }

  const definitions = [
    {
      name: 'dispatch_launch',
      description: '把一个任务派发给新的后台子会话执行，立即返回、不等待结果。子会话在自己的 Session 里独立工作，'
        + '完成或被阻塞时会用 dispatch_report 汇报，报告会作为消息回流到本会话（本会话空闲时会被唤醒）。'
        + '并发位满时任务进入 queued，有空位自动开始。适合可以并行、彼此独立的工作。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务短标题（不超过 120 字），用于列表与子会话标题。' },
          brief: { type: 'string', description: '完整任务简报：目标、约束、验收标准、相关文件路径、已知事实。子会话看不到本会话的历史，必须自包含。' },
          cwd: { type: 'string', description: '可选。子会话工作目录的绝对路径；省略则继承本会话的工作目录。' },
          model: { type: 'string', description: '可选。子会话使用的模型 id；省略则用 DSH 默认模型。' },
          agent_preset: { type: 'string', description: '可选。子会话使用的 agent preset id；省略则用部署默认 preset。' },
          permission_preset: { type: 'string', description: '可选。子会话的权限预设（如 danger-full-access）；省略则继承插件配置或 DSH 默认。' },
        },
        required: ['title', 'brief'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const task = await dispatch.launch(agent, {
          title: args.title,
          brief: args.brief,
          cwd: args.cwd,
          model: args.model,
          agentPreset: args.agent_preset,
          permissionPreset: args.permission_preset,
        })
        return { task: dispatch.card(task), note: '已入队/启动；不要在本轮等待它完成，报告会自己回来。' }
      },
    },
    {
      name: 'dispatch_launch_many',
      description: '一次派发多个互相独立的任务（批量版 dispatch_launch）。每个任务各自一个子会话，全部立即入队，'
        + '不会阻塞；完成的报告会陆续回流。适合“把这 5 个模块分别重构”这类可并行工作。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                brief: { type: 'string' },
                cwd: { type: 'string' },
                model: { type: 'string' },
                agent_preset: { type: 'string' },
                permission_preset: { type: 'string' },
              },
              required: ['title', 'brief'],
              additionalProperties: false,
            },
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const results = []
        for (const item of args.tasks) {
          try {
            const task = await dispatch.launch(agent, {
              title: item.title,
              brief: item.brief,
              cwd: item.cwd,
              model: item.model,
              agentPreset: item.agent_preset,
              permissionPreset: item.permission_preset,
            })
            results.push({ task_id: task.id, title: task.title, status: task.status })
          } catch (error) {
            results.push({ title: item.title, error: String(error) })
          }
        }
        return { launched: results }
      },
    },
    {
      name: 'dispatch_list',
      description: '列出本会话派出的任务及其状态（running/queued/done/blocked/ended/failed/cancelled/interrupted），最新在前。'
        + '派发后想确认进度先看这里，再看 dispatch_inspect。',
      parameters: {
        type: 'object',
        properties: {
          all: { type: 'boolean', description: 'true 时包含已结算的任务（默认包含）；false 只看未结算的。' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数上限，默认 20。' },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const all = args.all !== false
        const limit = args.limit ?? 20
        const tasks = dispatch.table.ofSession(agent.id).filter(task => all || !SETTLED.has(task.status)).slice(0, limit)
        return {
          version: VERSION,
          total: dispatch.table.ofSession(agent.id).length,
          running: dispatch.table.runningCount(),
          max_workers: dispatch.table.maxWorkers,
          tasks: tasks.map(task => dispatch.card(task)),
        }
      },
    },
    {
      name: 'dispatch_inspect',
      description: '查看一个任务的详情：状态、简报、最近几次报告、worker 最后一段输出。要判断“它到底做到哪了”时用它。',
      parameters: {
        type: 'object',
        properties: { task_id: TaskRefSchema },
        required: ['task_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const task = dispatch.table.get(args.task_id)
        if (!task) throw new Error(`没有任务 ${args.task_id}`)
        if (task.parentSessionId !== agent.id) throw new Error(`任务 ${args.task_id} 不属于本会话`)
        return { task: dispatch.detail(task) }
      },
    },
    {
      name: 'dispatch_message',
      description: '给某个任务的子会话追加一条消息：补充信息、修正方向、回答它的问题，或让它接着做下一步。'
        + 'mode=queue 排到下一轮（子会话空闲时会唤醒它），mode=steer 并入当前回合的下一步。任务会重新变为 running。',
      parameters: {
        type: 'object',
        properties: {
          task_id: TaskRefSchema,
          message: { type: 'string', description: '要投递给子会话的完整文本，自包含，不要依赖本会话上下文。' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: '默认 queue。' },
        },
        required: ['task_id', 'message'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const task = dispatch.table.get(args.task_id)
        if (!task) throw new Error(`没有任务 ${args.task_id}`)
        if (task.parentSessionId !== agent.id) throw new Error(`任务 ${args.task_id} 不属于本会话`)
        await dispatch.message(task, String(args.message), args.mode ?? 'queue')
        return { task: dispatch.card(task), note: '消息已投递；子会话处理完会再次汇报。' }
      },
    },
    {
      name: 'dispatch_cancel',
      description: '取消一个任务：结束子会话当前回合并释放并发位。已经产生的工作不会回滚，需要时自己检查工作目录。',
      parameters: {
        type: 'object',
        properties: {
          task_id: TaskRefSchema,
          reason: { type: 'string', description: '可选，取消原因，会记录在任务上。' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const task = dispatch.table.get(args.task_id)
        if (!task) throw new Error(`没有任务 ${args.task_id}`)
        if (task.parentSessionId !== agent.id) throw new Error(`任务 ${args.task_id} 不属于本会话`)
        await dispatch.cancel(task, args.reason)
        return { task: dispatch.card(task) }
      },
    },
    {
      name: 'dispatch_wait',
      description: '阻塞等待若干个任务结算，最多 timeout_ms 毫秒。只在“没有这些结果就无法继续下一步”时使用；'
        + '能先做别的就不要等——报告本来就会自己回流。',
      parameters: {
        type: 'object',
        properties: {
          task_ids: { type: 'array', items: { type: 'string' }, description: '省略表示等待本会话全部未结算任务。' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, description: '默认 60000。' },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const mine = dispatch.table.ofSession(agent.id)
        const targets = args.task_ids?.length
          ? args.task_ids.map(id => dispatch.table.get(id)).filter(Boolean)
          : mine.filter(task => !SETTLED.has(task.status))
        if (!targets.length) return { waited: false, tasks: mine.slice(0, 10).map(task => dispatch.card(task)) }
        await dispatch.table.waitFor(targets, args.timeout_ms ?? 60_000)
        return { waited: true, tasks: targets.map(task => dispatch.card(task)) }
      },
    },
    {
      name: 'dispatch_report',
      description: '（仅被派发的 worker 使用）向派发你的主会话汇报：done 完成、blocked 被阻塞、failed 失败、progress 阶段性进展。'
        + '主会话会收到这条报告并据此继续。主会话不要调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['done', 'blocked', 'failed', 'progress'], description: '报告类型。' },
          summary: { type: 'string', description: '3-6 行摘要：做了什么、结果如何、需要主会话做什么（如有）。' },
          detail: { type: 'string', description: '可选的长详情：改动清单、验证命令与输出、遗留问题。' },
        },
        required: ['status', 'summary'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        return dispatch.report(agent, args)
      },
    },
  ]

  for (const definition of definitions) {
    ctx.tools.register({ ...definition, output })
  }
}

// ------------------------------------------------------------------ 入口

export async function apply(ctx, config) {
  const dispatch = new Dispatch(ctx, config)
  await dispatch.restore()
  registerTools(ctx, dispatch)

  // worker 回合开始：记录，用于判断本回合是否已经显式报告过。
  ctx.on('agent/status', ({ agent, status }) => {
    const task = dispatch.table.byWorker(agent.id)
    if (!task) return
    if (status === 'running') {
      task.status = 'running'
      task.turnStartedAt = now()
      task.updatedAt = task.turnStartedAt
      dispatch.schedulePersist()
      return
    }
    if (status === 'idle') void dispatch.onWorkerIdle(agent.id)
  })

  // 子会话被外部关闭/删除时，别让任务永远挂在 running。
  ctx.on('agent/disposed', ({ agent }) => {
    const task = dispatch.table.byWorker(agent.id)
    if (!task || SETTLED.has(task.status)) return
    dispatch.table.settle(task, 'interrupted')
    dispatch.schedulePersist()
  })

  ctx.effect(() => () => { void dispatch.dispose() })

  // 子会话被删除后重新派发时，pump 仍能继续工作。
  void dispatch.pump()
  ctx.logger?.info?.('dsh-dispatch 已加载：maxWorkers=%d', dispatch.table.maxWorkers)
}
