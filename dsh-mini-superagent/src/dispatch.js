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
import { readState, writeState } from './store.js'
import { TaskTable, clip, lastAssistantText, oneLine } from './tasks.js'
import { WorkspaceGateway, dayKey } from './workspaces.js'

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
    this.workspaces = new WorkspaceGateway(ctx, this.config)
    this.persistTimer = undefined
    this.sweepTimer = undefined
    this.disposed = false
    /**
     * 每个主会话的「派发目标工作区」：会话 id → `{ workspace_id, title, path }`。
     * 输入框里的工作区选择器写这里，dispatch_launch 没显式给 workspace 时读这里。
     */
    this.targets = new Map()
    const stateRoot = this.config.stateDir
      || join(process.env.DSH_HOME || join(homedir(), '.dsh'), STATE_DIR)
    this.stateFile = join(stateRoot, 'tasks.json')
  }

  warn(...args) { this.ctx.logger?.warn?.(...args) }
  log(...args) { this.ctx.logger?.info?.(...args) }

  // ---------------------------------------------------------------- 任务

  /** 读一个会话的派发目标工作区；没有就是 undefined（= 沿用调用者目录）。 */
  targetFor(sessionId) {
    return this.targets.get(sessionId)
  }

  /**
   * 设置或清除一个会话的派发目标工作区。
   * @param {string} sessionId 主会话 id
   * @param {string} ref 工作区 id / 路径 / 标题；空字符串表示清除
   * @returns {Promise<object | undefined>} 解析后的目标，清除时为 undefined
   */
  async setTarget(sessionId, ref) {
    const value = String(ref ?? '').trim()
    if (!value) {
      this.targets.delete(sessionId)
      this.schedulePersist()
      return undefined
    }
    const workspace = await this.workspaces.resolve(value)
    if (!workspace) {
      const candidates = this.workspaces.list().map(item => `${item.title}（${item.id}）`).join('；') || '（暂无工作区）'
      throw new Error(`找不到工作区「${value}」。现有：${candidates}`)
    }
    const target = { workspace_id: workspace.id, title: workspace.title, path: workspace.path }
    this.targets.set(sessionId, target)
    this.schedulePersist()
    return target
  }

  /**
   * 派发一个任务：登记 → 排队 → 由 pump 按并发位启动。
   * 立即返回，不等子会话干活。
   * @param {object} agent 调用者（主会话）
   * @param {{title: string, brief: string, cwd?: string, workspace?: string, createWorkspace?: boolean, model?: string, agentPreset?: string, permissionPreset?: string, group?: string}} input
   */
  async launch(agent, input) {
    const existing = this.table.ofSession(agent.id)
    if (existing.length >= this.config.maxTasksPerSession) {
      throw new Error(`本会话已派发 ${existing.length} 个任务，达到上限 ${this.config.maxTasksPerSession}；请先收束旧任务`)
    }

    // 显式 workspace 优先；否则用输入框里选的「派发目标工作区」（如果有）。
    const sticky = this.targetFor(agent.id)
    const ref = input.workspace ?? sticky?.workspace_id
    let target
    if (ref) {
      // 只有显式指定时才允许按需新建；来自选择器的目标失效则忽略，避免凭空建目录。
      const result = await this.workspaces.resolveOrCreate(ref, {
        create: !!input.workspace && input.createWorkspace !== false,
      })
      target = result.workspace
      if (!target) {
        if (input.workspace) {
          const candidates = this.workspaces.list().map(item => `${item.title}（${item.path}）`).join('；') || '（暂无工作区）'
          throw new Error(`找不到工作区「${input.workspace}」，且允许新建被关闭。现有：${candidates}`)
        }
        this.warn(`${LOG_PREFIX} 会话 %s 的派发目标工作区已不存在，按调用者目录派发`, agent.id)
      } else if (result.created) {
        this.log(`${LOG_PREFIX} 已新建工作区 %s（%s）`, target.title, target.path)
      }
    }

    const id = newTaskId()
    const task = {
      id,
      title: oneLine(input.title, 120) || '未命名任务',
      brief: String(input.brief ?? ''),
      parentSessionId: agent.id,
      workerSessionId: `dispatch-${id}`,
      status: 'queued',
      attempt: 1,
      createdAt: now(),
      updatedAt: now(),
      turnStartedAt: undefined,
      lastReportAt: undefined,
      lastText: '',
      reports: [],
      // 工作目录 = 目标工作区路径；没有目标就沿用调用者目录。
      cwd: target?.path ?? this.sessions.cwdFor(agent, input.cwd),
      workspaceId: target?.id,
      workspaceTitle: target?.title,
      ...(input.group ? { group: input.group } : {}),
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

  /**
   * 子会话放在哪个工作区。
   * - `target` 模式且任务指定了目标 → 放进目标工作区（子会话混在项目里）
   * - 其余情况 → 当天的【派发】工作区（侧边栏保持干净）
   * @returns {Promise<{ workspaceId?: string, path: string }>}
   */
  async placementFor(task) {
    const target = task.workspaceId ? this.workspaces.list().find(item => item.id === task.workspaceId) : undefined
    if (this.config.workerWorkspace === 'target' && target) {
      return { workspaceId: target.id, path: target.path }
    }
    const day = await this.workspaces.dayWorkspace(dayKey())
    if (day) return { workspaceId: day.id, path: day.path }
    return { path: task.cwd }
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
    void this.maybeSummarize(task)
  }

  /**
   * 一批任务（同一个 `group`）全部结算后，发**一条**汇总，而不是 N 条流水。
   * 组内任一成员带上 `groupClosed` 就说明已经汇总过，避免重复。
   */
  async maybeSummarize(task) {
    const group = task.group
    if (!group) return
    const members = [...this.table.tasks.values()].filter(item => item.group === group)
    if (!members.length) return
    if (members.some(item => item.groupClosed)) return
    if (members.some(item => !SETTLED.has(item.status))) return

    for (const item of members) item.groupClosed = true
    this.schedulePersist()

    const tally = {}
    for (const item of members) tally[item.status] = (tally[item.status] ?? 0) + 1
    const summary = Object.entries(tally).map(([status, count]) => `${status} ${count}`).join(' / ')
    const lines = members.map(item => {
      const last = item.reports.at(-1)
      const reason = item.error
        ?? last?.summary
        ?? item.lastText
        ?? ''
      const head = `- ${item.title} · ${item.status}${(item.attempt ?? 1) > 1 ? ` · 第 ${item.attempt} 次` : ''}`
      return reason ? `${head}：${oneLine(reason, 120)}` : head
    })

    try {
      await this.relay(
        { parentSessionId: task.parentSessionId, id: group, workerSessionId: '' },
        `[dispatch] 批次 ${group} 全部结束（${members.length} 个任务：${summary}）\n${lines.join('\n')}\n`
        + '需要明细用 dispatch_inspect 按 task_id 查。',
        true,
      )
    } catch (error) {
      this.warn(`${LOG_PREFIX} 批次 %s 汇总投递失败: %s`, group, String(error))
    }
  }

  /** 真正启动一个任务：建会话 → 投递简报。 */
  async start(task) {
    task.status = 'running'
    task.startedAt = now()
    task.updatedAt = task.startedAt
    this.schedulePersist()
    const placement = await this.placementFor(task)
    const agent = await this.sessions.createWorker(task.workerSessionId, placement.path, `[派发] ${task.title}`, {
      agentPreset: task.agentPreset,
      permissionPreset: task.permissionPreset,
      workspaceId: placement.workspaceId,
    })
    // 会话住在【派发】工作区，但活要干在目标任务的工作区里。
    if (task.cwd && task.cwd !== placement.path) await this.sessions.enterDirectory(agent, task.cwd)
    task.lastText = ''
    await this.sessions.deliver(task.workerSessionId, `${task.id}:start`, workerPrompt(task, this.config), 'queue')
    this.log(`${LOG_PREFIX} 任务 %s 已启动，子会话 %s（工作目录 %s）`, task.id, task.workerSessionId, task.cwd)
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
    // 批次内的终态报告只入库，等整批结束由 maybeSummarize 统一回流一条。
    if (!task.group || status === 'progress') {
      await this.relay(task, this.reportText(task, entry), status !== 'progress')
    }
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
    // 批次成员不单独回流：整批结束时有一条汇总，逐条发等于没汇总。
    if (task.group) return

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

  /**
   * 重试一个已结算的任务（看板上的「重试」按钮走这里）。
   *
   * 分两种情况：
   * - 子会话还活着/还能 resume（blocked、ended、failed 的常见情况）→ 续跑同一会话，
   *   它自己的历史还在，不用重讲背景；
   * - 会话随进程没了（interrupted，或创建失败）→ 换一个新的 attempt 会话，重投原始简报。
   */
  async retry(task) {
    if (task.status === 'running' || task.status === 'queued') {
      throw new Error(`任务 ${task.id} 正在运行，不需要重试；要打断它请用取消`)
    }
    if (task.status === 'cancelled') {
      throw new Error(`任务 ${task.id} 已被取消；要重新做请派发一个新任务`)
    }

    task.attempt = (task.attempt ?? 1) + 1
    task.error = undefined
    task.lastReportAt = undefined
    task.updatedAt = now()

    const existing = this.ctx.agents.get(task.workerSessionId)
    let resumable = !!existing
    if (!resumable) {
      const resolved = await this.ctx.sessionController.resolveAgent(task.workerSessionId).catch(() => undefined)
      resumable = !!resolved && !resolved.error
    }

    if (resumable) {
      // 已完成的任务被重试，语义是「再执行一次」，不是「接着没做完的地方」。
      const instruction = task.status === 'done'
        ? `主会话要求把原任务再执行一次（第 ${task.attempt} 次）。上一轮已报过 done；`
          + '请重新核对当前状态与要求是否仍然满足，按需补做，然后照常用 dispatch_report 汇报结论。'
        : `主会话要求重试（第 ${task.attempt} 次尝试）。上一轮没有正常完成或被打断；`
          + '请从中断处继续完成原任务，完成后照常调用 dispatch_report 汇报。'
      this.log(`${LOG_PREFIX} 重试任务 %s：续跑子会话 %s`, task.id, task.workerSessionId)
      await this.message(task, instruction, 'queue')
      return task
    }

    // 会话不在了：换一个 worker 会话，把原始简报重投一遍。
    task.workerSessionId = `dispatch-${task.id}-a${task.attempt}`
    task.turnStartedAt = undefined
    task.lastText = ''
    task.status = 'queued'
    this.table.add(task)
    this.schedulePersist()
    this.log(`${LOG_PREFIX} 重试任务 %s：新开子会话 %s`, task.id, task.workerSessionId)
    void this.pump()
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
      ...(task.workspaceTitle ? { workspace: task.workspaceTitle } : {}),
      ...(task.archivedAt ? { archived_at: task.archivedAt } : {}),
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
      const targets = Object.fromEntries(this.targets)
      await writeState(this.stateFile, { tasks, targets }, now())
    } catch (error) {
      this.warn(`${LOG_PREFIX} 状态落盘失败: %s`, String(error))
    }
  }

  /** 启动时读回任务表与派发目标；进程之间没有活的 worker，所以未结算的一律标为 interrupted。 */
  async restore() {
    try {
      const state = await readState(this.stateFile)
      for (const item of state.tasks) {
        if (!item?.id || !item?.workerSessionId) continue
        const task = { ...item, reports: Array.isArray(item.reports) ? item.reports : [] }
        if (!SETTLED.has(task.status)) {
          task.status = 'interrupted'
          task.updatedAt = now()
        }
        this.table.tasks.set(task.id, task)
      }
      for (const [sessionId, target] of Object.entries(state.targets)) {
        if (target?.workspace_id) this.targets.set(sessionId, target)
      }
      this.log(`${LOG_PREFIX} 读回 %d 个历史任务、%d 个派发目标（%s）`, this.table.tasks.size, this.targets.size, this.stateFile)
    } catch (error) {
      this.warn(`${LOG_PREFIX} 读取历史状态失败: %s`, String(error))
    }
  }

  /** 会话是否存在（活着的或已持久化的）。 */
  async sessionExists(sessionId) {
    try { await this.ctx.sessionController.inspect(sessionId); return true }
    catch { return false }
  }

  /**
   * 首次激活时准备默认工作区（mini-superagent）与其中的默认主会话。
   * 幂等：工作区按路径复用，会话按固定 id 存在性判断。
   * 失败只记日志——目录不可写或注册表不可用，都不该让插件起不来。
   */
  async provision() {
    if (!this.config.provisionDefaultWorkspace) return
    try {
      const workspace = await this.workspaces.defaultWorkspace()
      if (!workspace) return
      this.defaultWorkspace = workspace
      const leadId = String(this.config.leadSessionId || 'mas-lead')
      this.leadSessionId = leadId
      if (await this.sessionExists(leadId)) return
      await this.ctx.sessionController.create({ sessionId: leadId, workspaceId: workspace.id })
      try { await this.ctx.sessionController.rename({ sessionId: leadId, title: 'mini-superagent 主会话' }) }
      catch { /* 标题非关键 */ }
      this.log(`${LOG_PREFIX} 已创建默认工作区「%s」（%s）与主会话 %s`, workspace.title, workspace.path, leadId)
    } catch (error) {
      this.warn(`${LOG_PREFIX} 创建默认工作区失败（不影响派发）: %s`, String(error))
    }
  }

  /** 启动归档巡检：结束超过 archiveAfterHours 的子会话自动归档，看板仍能查到。 */
  startArchiveSweep() {
    const minutes = Number(this.config.archiveSweepMinutes)
    const hours = Number(this.config.archiveAfterHours)
    if (!(minutes > 0) || !(hours > 0)) return
    const tick = () => {
      void this.archiveStale()
      this.sweepTimer = setTimeout(tick, minutes * 60_000)
      this.sweepTimer.unref?.()
    }
    // 启动后先等一会，避开初始化的忙乱。
    this.sweepTimer = setTimeout(tick, 20_000)
    this.sweepTimer.unref?.()
  }

  /** 归档已结算且超过保留期的子会话；失败原因记在任务上，下一次巡检重试。 */
  async archiveStale() {
    if (this.disposed) return { scanned: 0, archived: 0, failed: 0 }
    const cutoff = Date.now() - Number(this.config.archiveAfterHours) * 3_600_000
    let scanned = 0
    let archived = 0
    let failed = 0
    for (const task of [...this.table.tasks.values()]) {
      if (task.archivedAt || !SETTLED.has(task.status)) continue
      const at = Date.parse(task.updatedAt ?? '')
      if (!Number.isFinite(at) || at > cutoff) continue
      scanned += 1
      const result = await this.workspaces.archiveSession(task.workerSessionId)
      if (result.ok) {
        task.archivedAt = now()
        task.archiveError = undefined
        archived += 1
        this.log(`${LOG_PREFIX} 已归档子会话 %s（任务 %s）`, task.workerSessionId, task.id)
      } else {
        task.archiveError = result.error
        failed += 1
        this.warn(`${LOG_PREFIX} 任务 %s 归档失败: %s`, task.id, result.error)
      }
    }
    if (scanned) this.schedulePersist()
    return { scanned, archived, failed }
  }

  /** 插件卸载：收回注册的提示段、冲刷状态。运行中的子会话交给 DSH 自身管理。 */
  async dispose() {
    this.disposed = true
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    this.sweepTimer = undefined
    this.sessions.dispose()
    await this.persist()
  }
}
