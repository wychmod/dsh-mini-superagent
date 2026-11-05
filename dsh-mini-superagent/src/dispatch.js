/**
 * Dispatch 服务：任务的全部业务动作——派发、排队、启动、汇报、回流、
 * 追问、取消、落盘、重启恢复。
 *
 * 它不直接碰宿主 API：会话相关的事都走 SessionGateway（sessions.js），
 * 纯逻辑（并发位/队列/等待）都在 TaskTable（tasks.js）里。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULTS, LOG_PREFIX, MAX_REPORTS, SETTLED, STATE_DIR, TERMINAL_REPORT,
  newTaskId, nextMessageId, now,
} from './constants.js'
import { workerPrompt } from './prompt.js'
import { SessionGateway } from './sessions.js'
import { readTaskFile, writeTaskFile } from './store.js'
import { TaskTable, clip, lastAssistantText, oneLine } from './tasks.js'

export class Dispatch {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx 插件 context
   * @param {object} [config] cordis.patch.yml 里的 config
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = { ...DEFAULTS, ...(config ?? {}) }
    this.table = new TaskTable(this.config.maxWorkers)
    this.sessions = new SessionGateway(ctx, this.config)
    this.persistTimer = undefined
    this.disposed = false
    const stateRoot = this.config.stateDir
      || join(process.env.DSH_HOME || join(homedir(), '.dsh'), STATE_DIR)
    this.stateFile = join(stateRoot, 'tasks.json')
  }

  warn(...args) { this.ctx.logger?.warn?.(...args) }
  log(...args) { this.ctx.logger?.info?.(...args) }

  // ---------------------------------------------------------------- 任务

  /**
   * 派发一个任务：登记 → 排队 → 由 pump 按并发位启动。
   * 立即返回，不等子会话干活。
   * @param {object} agent 调用者（主会话）
   * @param {{title: string, brief: string, cwd?: string, model?: string, agentPreset?: string, permissionPreset?: string}} input
   */
  async launch(agent, input) {
    const existing = this.table.ofSession(agent.id)
    if (existing.length >= this.config.maxTasksPerSession) {
      throw new Error(`本会话已派发 ${existing.length} 个任务，达到上限 ${this.config.maxTasksPerSession}；请先收束旧任务`)
    }
    const id = newTaskId()
    const task = {
      id,
      title: oneLine(input.title, 120) || '未命名任务',
      brief: String(input.brief ?? ''),
      parentSessionId: agent.id,
      workerSessionId: `dispatch-${id}`,
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
      turnStartedAt: undefined,
      lastReportAt: undefined,
      lastText: '',
      reports: [],
      cwd: this.sessions.cwdFor(agent, input.cwd),
      model: input.model,
      agentPreset: input.agentPreset,
      permissionPreset: input.permissionPreset,
    }
    this.table.add(task)
    this.sessions.hint(agent)
    this.schedulePersist()
    void this.pump()
    return task
  }

  /** 按并发位依次启动排队中的任务。 */
  async pump() {
    if (this.disposed) return
    for (;;) {
      const task = this.table.takeRunnable()
      if (!task) return
      try {
        await this.start(task)
      } catch (error) {
        task.error = String(error)
        // 这里直接用 table.settle：pump 自己的循环会继续，不需要再触发一次 pump。
        this.table.settle(task, 'failed')
        this.schedulePersist()
        this.ctx.logger?.error?.(`${LOG_PREFIX} 任务 %s 启动失败: %s`, task.id, String(error))
        await this.relayFailure(task)
      }
    }
  }

  /**
   * 结算一个任务，并立刻尝试把排队中的任务顶上来。
   * 只在结算点调用：如果等到下一次 dispatch_launch 才 pump，空出的并发位会被白白占着。
   */
  settle(task, status) {
    this.table.settle(task, status)
    void this.pump()
  }

  /** 真正启动一个任务：建会话 → 投递简报。 */
  async start(task) {
    task.status = 'running'
    task.startedAt = now()
    task.updatedAt = task.startedAt
    this.schedulePersist()
    await this.sessions.createWorker(task.workerSessionId, task.cwd, `[派发] ${task.title}`, task)
    task.lastText = ''
    await this.sessions.deliver(task.workerSessionId, `${task.id}:start`, workerPrompt(task, this.config), 'queue')
    this.log(`${LOG_PREFIX} 任务 %s 已启动，子会话 %s`, task.id, task.workerSessionId)
    return task
  }

  /** 记录一次 worker 报告，并按需回流主会话。 */
  async report(agent, input) {
    const task = this.table.byWorker(agent.id)
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
    // progress 不结束任务；其余都是终态。结算后立刻让出并发位给排队任务。
    if (TERMINAL_REPORT.has(status)) this.settle(task, status)
    this.schedulePersist()

    // progress 只在主会话正忙时顺带并入，不为了它把人叫醒。
    await this.relay(task, this.reportText(task, entry), status !== 'progress')
    return { recorded: true, task_id: task.id, status: task.status }
  }

  /** 报告文本：给主会话模型看的紧凑结构化消息。 */
  reportText(task, entry) {
    const head = `[dispatch] 任务 ${task.id} · ${task.title} · 报告 ${entry.status}`
    const tail = entry.detail ? `\n详情：\n${clip(entry.detail, 4000)}` : ''
    return `${head}\n摘要：\n${clip(entry.summary, 6000)}${tail}\n（子会话 ${task.workerSessionId}）`
  }

  /**
   * 把报告投递回派发它的主会话。
   * wake=false 且主会话空闲时只落库，不打扰人。
   */
  async relay(task, text, wake) {
    const parentId = task.parentSessionId
    const parent = this.ctx.agents.get(parentId)
    if (!parent) {
      this.warn(`${LOG_PREFIX} 主会话 %s 已不在运行，报告只落到任务表`, parentId)
      return 'dropped'
    }
    if (!wake && parent.status !== 'running') return 'recorded'
    try {
      await this.sessions.deliver(parentId, nextMessageId(task.id, 'relay'), text, 'steer')
      return 'delivered'
    } catch (error) {
      this.warn(`${LOG_PREFIX} 报告投递失败 %s: %s`, task.id, String(error))
      return 'failed'
    }
  }

  /** 任务启动失败时也要让主会话知道，而不是只留在任务表里。 */
  async relayFailure(task) {
    await this.relay(task, `[dispatch] 任务 ${task.id} · ${task.title} 启动失败：${task.error ?? '未知错误'}`, true)
  }

  /**
   * worker 回合结束（agent/status → idle）时的自动回报。
   * 本回合已经给过终态报告就不重复；只报过 progress 的仍然要补一条，
   * 否则主会话会一直干等。
   */
  async onWorkerIdle(sessionId) {
    const task = this.table.byWorker(sessionId)
    if (!task || task.status !== 'running') return

    const agent = this.ctx.agents.get(sessionId)
    const text = agent ? lastAssistantText(agent) : ''
    task.lastText = text
    task.updatedAt = now()

    const reportedThisTurn = !!task.turnStartedAt
      && task.reports.some(item => item.at >= task.turnStartedAt && TERMINAL_REPORT.has(item.status))
    if (reportedThisTurn) {
      if (task.status === 'running') this.settle(task, 'done')
      this.schedulePersist()
      return
    }

    this.settle(task, 'ended')
    this.schedulePersist()
    if (!this.config.reportOnTurnEnd) return

    const body = text ? clip(text, 5000) : '（worker 本轮没有输出文本）'
    await this.relay(task,
      `[dispatch] 任务 ${task.id} · ${task.title} · 一轮执行结束（worker 未显式报告）\n最后一条消息：\n${body}\n`
      + '\n用 dispatch_inspect 看细节，或用 dispatch_message 继续指派；任务已释放并发位。', true)
  }

  /** 给某个任务追加一条消息（主会话 → worker），任务重新进入 running。 */
  async message(task, text, mode) {
    if (task.status === 'cancelled') throw new Error(`任务 ${task.id} 已取消；请重新 dispatch_launch 一个新任务`)
    const agent = this.ctx.agents.get(task.workerSessionId)
    if (!agent) {
      // 会话可能被关掉了；先尝试恢复，恢复不了就明确报错，不要假装投递成功。
      const resolved = await this.ctx.sessionController.resolveAgent(task.workerSessionId)
      if (resolved?.error) throw new Error(`子会话 ${task.workerSessionId} 不可用：${resolved.error.code}`)
    }
    task.status = 'running'
    task.turnStartedAt = now()
    task.updatedAt = task.turnStartedAt
    this.schedulePersist()
    await this.sessions.deliver(task.workerSessionId, nextMessageId(task.id, 'msg'), text,
      mode === 'steer' ? 'steer' : 'queue')
    return task
  }

  /** 取消一个任务：结束 worker 当前回合并释放并发位。已产生的工作不回滚。 */
  async cancel(task, reason) {
    this.table.queue = this.table.queue.filter(id => id !== task.id)
    const agent = this.ctx.agents.get(task.workerSessionId)
    if (agent) {
      try { agent.cancel({ kind: 'user' }, { keepInbox: false }) }
      catch (error) { this.warn(`${LOG_PREFIX} 取消失败: %s`, String(error)) }
    }
    task.cancelReason = reason
    this.settle(task, 'cancelled')
    this.schedulePersist()
    return task
  }

  // ---------------------------------------------------------------- 视图

  /** 列表里展示的任务摘要。 */
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

  /** 800ms 防抖写盘：密集的状态变化只落一次。 */
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
      await writeTaskFile(this.stateFile, tasks, now())
    } catch (error) {
      this.warn(`${LOG_PREFIX} 状态落盘失败: %s`, String(error))
    }
  }

  /** 启动时读回任务表；进程之间没有活的 worker，所以未结算的一律标为 interrupted。 */
  async restore() {
    try {
      const saved = await readTaskFile(this.stateFile)
      for (const item of saved) {
        if (!item?.id || !item?.workerSessionId) continue
        const task = { ...item, reports: Array.isArray(item.reports) ? item.reports : [] }
        if (!SETTLED.has(task.status)) {
          task.status = 'interrupted'
          task.updatedAt = now()
        }
        this.table.tasks.set(task.id, task)
      }
      this.log(`${LOG_PREFIX} 读回 %d 个历史任务（%s）`, this.table.tasks.size, this.stateFile)
    } catch (error) {
      this.warn(`${LOG_PREFIX} 读取历史任务失败: %s`, String(error))
    }
  }

  /** 插件卸载：收回注册的提示段、冲刷状态。运行中的子会话交给 DSH 自身管理。 */
  async dispose() {
    this.disposed = true
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    this.sessions.dispose()
    await this.persist()
  }
}
