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
  AUTO, DEFAULTS, LOG_PREFIX, MAX_REPORTS, MODE_ALWAYS, MODE_OFF, NAME, NONE, SETTLED,
  STATE_DIR, TERMINAL_REPORT, VERSION,
  newTaskId, nextMessageId, now,
} from './constants.js'
import { FORCED_HINT, SOFT_HINT, workerPrompt } from './prompt.js'
import { SessionGateway } from './sessions.js'
import { readState, writeState } from './store.js'
import { TaskTable, clip, lastAssistantText, oneLine } from './tasks.js'
import { WorkspaceGateway, dayKey, rankWorkspaces } from './workspaces.js'

export class Dispatch {
  /** 写盘 promise 链：保证同一文件不会被两次写并发覆盖。 */
  #persistChain = Promise.resolve()

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
    /** 最近一次落盘失败的原因（自检用）。 */
    this.persistError = undefined
    /** 最近一次恢复失败或走了备份的原因（自检用）。 */
    this.restoreError = undefined
    /**
     * 每个主会话的「派发目标工作区」：会话 id → `{ workspace_id, title, path }`。
     * 输入框里的工作区选择器写这里，dispatch_launch 没显式给 workspace 时读这里。
     */
    this.targets = new Map()
    /**
     * 浏览器半边最近一次自报：`{ at, ok, registered?, error? }`。
     * 客户端模块加载失败时页面上什么都看不到，只有这条记录能证明「它跑过 / 它挂了」。
     */
    this.clientReady = undefined
    /** 本插件实例的启动时间：`client.ready.at` 早于它就说明那是上一次实例留下的。 */
    this.bootAt = now()
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
   * 一个会话当前的派发模式。
   *
   * - 目标里没有这个会话，或值是 `none` → `off`（不派发，正常跑）
   * - 任何其他值（auto / 具体工作区） → `always`（强制派发）
   *
   * 这就是输入框里「不派发 / 派发到某处」那个开关的语义：
   * 只要不是「不派发」，一切任务都得派下去。
   */
  modeOf(sessionId) {
    const target = this.targets.get(sessionId)
    if (!target) return MODE_OFF
    if (target.auto) return MODE_ALWAYS
    if (target.workspace_id) return MODE_ALWAYS
    return MODE_OFF
  }

  /**
   * 按会话当前的派发模式，切换它系统提示里那段「工作方式」。
   *
   * 提示段本身只注册一次，文本是函数，每次装配重新求值；这里只是换掉求值函数，
   * 所以切模式不需要重载插件，也不需要重新建段。
   */
  refreshHint(agent) {
    if (!agent) return
    this.sessions.hint(agent, () => (this.modeOf(agent.id) === MODE_ALWAYS ? FORCED_HINT : SOFT_HINT))
  }

  /** 把所有活着的会话的提示按当前模式刷一遍（插件启动时用）。 */
  refreshAllHints() {
    for (const agent of this.ctx.agents?.list?.() ?? []) this.refreshHint(agent)
  }

  /**
   * 设置或清除一个会话的派发目标工作区。
   *
   * 传 `'auto'` 表示「自动」：不锁定具体工作区，每次派发时按任务标题重新挑一个。
   * 这是默认行为，也是「刷新列表」旁边那条「自动选择」要写进去的值。
   *
   * @param {string} sessionId 主会话 id
   * @param {string} ref 工作区 id / 路径 / 标题 / `'auto'`；空字符串表示清除（跟随会话目录）
   * @returns {Promise<object | undefined>} 解析后的目标；清除时为 undefined
   */
  async setTarget(sessionId, ref) {
    const value = String(ref ?? '').trim()
    if (!value || value.toLowerCase() === NONE) {
      this.targets.delete(sessionId)
      this.schedulePersist()
      // 切回「不派发」：把该会话的提示换回轻提示。
      this.refreshHint(this.ctx.agents.get(sessionId))
      return undefined
    }
    if (value.toLowerCase() === AUTO) {
      const target = { auto: true, title: '自动选择', path: '' }
      this.targets.set(sessionId, target)
      this.schedulePersist()
      this.refreshHint(this.ctx.agents.get(sessionId))
      return target
    }
    const workspace = await this.workspaces.resolve(value)
    if (!workspace) {
      const candidates = this.workspaces.list().map(item => `${item.title}（${item.id}）`).join('；') || '（暂无工作区）'
      throw new Error(`找不到工作区「${value}」。现有：${candidates}`)
    }
    const target = { workspace_id: workspace.id, title: workspace.title, path: workspace.path }
    this.targets.set(sessionId, target)
    this.schedulePersist()
    this.refreshHint(this.ctx.agents.get(sessionId))
    return target
  }

  /**
   * 按任务标题自动挑一个工作区。
   * 优先用任务的 `title + brief` 前 200 字做关键词；挑不到就退回默认工作区。
   * @returns {Promise<object | undefined>}
   */
  async autoWorkspace(task) {
    const haystack = `${task.title ?? ''} ${String(task.brief ?? '').slice(0, 200)}`
    const ranked = rankWorkspaces(this.workspaces.list(), haystack)
    // 只有分数足够高才算命中，避免路径里沾一个字就被误判。
    const hit = ranked.find(entry => entry.score >= 40)
    const picked = hit?.item ?? this.defaultWorkspace ?? (await this.workspaces.defaultWorkspace())
    return picked ?? undefined
  }

  /**
   * 这个会话累计派发了多少个任务（用于上限判断）。
   *
   * 只数**仍在册**的任务：已归档的、以及超出保留窗口的旧结算任务不计入。
   * 0.6.0 之前直接数 `ofSession(agent.id).length`，而任务表只增不减，
   * 于是累计派发满 64 个之后该会话**永久**不能再派发——即使全部 done、
   * 全部归档也不释放额度。这是「用着用着突然不能派了」的典型成因。
   *
   * 归档的任务显然已经收了尾；这里还把「已结算且早于保留窗口」的也算作
   * 收尾，避免用户不归档就再也派不出去。
   */
  quotaUsed(sessionId) {
    const cutoff = Date.now() - 24 * 3_600_000        // 24 小时
    let used = 0
    for (const task of this.table.tasks.values()) {
      if (task.parentSessionId !== sessionId) continue
      if (task.archivedAt) continue                    // 归档 = 收尾
      if (SETTLED.has(task.status)) {
        const at = Date.parse(task.updatedAt ?? '')
        if (Number.isFinite(at) && at < cutoff) continue   // 结算超过 24 小时 = 收尾
      }
      used += 1
    }
    return used
  }

  /**
   * 派发一个任务：登记 → 排队 → 由 pump 按并发位启动。
   * 立即返回，不等子会话干活。
   * @param {object} agent 调用者（主会话）
   * @param {{title: string, brief: string, cwd?: string, workspace?: string, createWorkspace?: boolean, model?: string, agentPreset?: string, permissionPreset?: string, group?: string}} input
   */
  async launch(agent, input) {
    const used = this.quotaUsed(agent.id)
    if (used >= this.config.maxTasksPerSession) {
      throw new Error(`本会话还有 ${used} 个未收尾的任务，达到上限 ${this.config.maxTasksPerSession}；`
        + '请先取消或等待它们结束（归档与超过 24 小时的已结算任务不计入）')
    }

    // 显式 workspace 优先；否则看输入框里选的「派发目标工作区」。
    // 目标是 auto 时不锁定具体工作区：等任务标题/简报就位后再挑（见下面的 autoTarget）。
    const sticky = this.targetFor(agent.id)
    const autoTarget = !input.workspace && sticky?.auto === true
    const ref = input.workspace ?? (autoTarget ? undefined : sticky?.workspace_id)
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
    const title = oneLine(input.title, 120) || '未命名任务'
    const brief = String(input.brief ?? '')

    // 目标是「自动」：等标题与简报就位后再挑，挑不到就退回默认工作区。
    if (autoTarget && !target) {
      const picked = await this.autoWorkspace({ title, brief })
      if (picked) {
        target = picked
        this.log(`${LOG_PREFIX} 自动选择工作区 → %s（%s）`, picked.title, picked.path)
      }
    }

    const task = {
      id,
      title,
      brief,
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
      ...(autoTarget ? { workspaceAuto: true } : {}),
      ...(input.group ? { group: input.group } : {}),
      model: input.model,
      agentPreset: input.agentPreset,
      permissionPreset: input.permissionPreset,
    }
    this.table.add(task)
    this.refreshHint(agent)
    this.schedulePersist()
    void this.pump()
    return task
  }

  /**
   * 子会话放在哪个工作区。
   * - `target` 模式且任务指定了目标 → 放进目标工作区（子会话混在项目里）
   * - 其余情况 → 当天的【派发】工作区（侧边栏保持干净）
   * @returns {Promise<{ workspaceId?: string, path: string, title?: string }>}
   */
  async placementFor(task) {
    const target = task.workspaceId ? this.workspaces.list().find(item => item.id === task.workspaceId) : undefined
    if (this.config.workerWorkspace === 'target' && target) {
      return { workspaceId: target.id, path: target.path, title: target.title }
    }
    const day = await this.workspaces.dayWorkspace(dayKey())
    if (day) return { workspaceId: day.id, path: day.path, title: day.title }
    return { path: task.cwd }
  }

  /**
   * 按并发位启动排队中的任务。
   *
   * 0.6.0 之前是 `for(;;) { takeRunnable(); await start() }`——串行启动：
   * 第 N 个任务的建会话+投递完成前，第 N+1 个不会开始，并发位是 6
   * 但启动永远是 1。冷启动时延 ≈ N × 建会话时延。
   *
   * 现在：一次把当前空位全部占满，各自并行启动。
   * 并发位安全仍由 `takeRunnable()` 保证（它在返回前同步占位）。
   */
  async pump() {
    if (this.disposed) return
    const launching = []
    for (;;) {
      const task = this.table.takeRunnable()
      if (!task) break
      launching.push(this.#launchOne(task))
    }
    await Promise.all(launching)
  }

  /** 启动一个任务；失败则结算成 failed 并回报主会话。 */
  async #launchOne(task) {
    try {
      await this.start(task)
    } catch (error) {
      task.error = String(error)
      this.settle(task, 'failed')
      this.schedulePersist()
      this.ctx.logger?.error?.(`${LOG_PREFIX} 任务 %s 启动失败: %s`, task.id, String(error))
      await this.relayFailure(task)
    }
  }

  /**
   * 结算一个任务，并立刻尝试把排队中的任务顶上来。
   * 只在结算点调用：如果等到下一次 dispatch_launch 才 pump，空出的并发位会被白白占着。
   *
   * 幂等：已结算的任务不会被二次结算覆盖（见 TaskTable.settle）。
   */
  settle(task, status) {
    if (!this.table.settle(task, status)) return false
    void this.pump()
    void this.maybeSummarize(task)
    return true
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

  /**
   * 真正启动一个任务：建会话 → 投递简报。
   *
   * 关键点：start 里有多个 await（解析工作区、建会话、切目录、投递），
   * 每一个都可能跨过很长的时间。期间任务可能被 cancel 或被 agent/disposed
   * 置成 interrupted。0.6.0 之前这里不看状态，于是出现「看板显示已取消，
   * 但子会话真被创建、真收到简报」的僵尸 worker，持续消耗模型额度。
   *
   * 现在每个 await 之后都检查一次：任务已结算就中止，并把已经建出来的
   * 会话取消掉。`abortIfSettled` 返回 true 表示应当停止启动流程。
   */
  async start(task) {
    // 占位：status 已经是 running（takeRunnable 占的），这里只记开始时间。
    task.startedAt = now()
    task.updatedAt = task.startedAt
    this.schedulePersist()

    const placement = await this.placementFor(task)
    if (this.abortIfSettled(task, '解析工作区之后')) return task

    // 记下子会话实际挂在哪个工作区。这是「它住在哪」，与 workspaceTitle
    //（「派发目标」）是两件事：没指定目标时子会话住进当天的【派发】工作区，
    // 但 workspaceTitle 是空的。看板要显示前者，否则看起来像没归属。
    task.hostWorkspaceId = placement.workspaceId
    task.hostWorkspaceTitle = placement.title

    const created = await this.sessions.createWorker(task.workerSessionId, placement.path, `[派发] ${task.title}`, {
      agentPreset: task.agentPreset,
      permissionPreset: task.permissionPreset,
      workspaceId: placement.workspaceId,
    })
    // createWorker 可能换了号（`create` 在会话已存在且非空白时会铸新 id）。
    // 以返回值里的 id 为准，否则后续投递会打到不存在的会话上。
    const { agent } = created
    if (created.sessionId && created.sessionId !== task.workerSessionId) {
      task.workerSessionId = created.sessionId
      task.updatedAt = now()
      this.schedulePersist()
    }
    // 会话刚建出来就发现任务已结算：立刻取消它，别留僵尸。
    if (this.abortIfSettled(task, '建会话之后')) {
      this.cancelWorkerAgent(agent)
      return task
    }

    // 会话住在【派发】工作区，但活要干在目标任务的工作区里。
    if (task.cwd && task.cwd !== placement.path) await this.sessions.enterDirectory(agent, task.cwd)
    if (this.abortIfSettled(task, '切换工作目录之后')) {
      this.cancelWorkerAgent(agent)
      return task
    }

    task.lastText = ''
    await this.sessions.deliver(task.workerSessionId, `${task.id}:start`, workerPrompt(task, this.config), { mode: 'queue' })
    if (this.abortIfSettled(task, '投递简报之后')) {
      this.cancelWorkerAgent(agent)
      return task
    }
    this.log(`${LOG_PREFIX} 任务 %s 已启动，子会话 %s（工作目录 %s）`, task.id, task.workerSessionId, task.cwd)
    return task
  }

  /**
   * 启动流程的中止检查：任务是已结算或插件已卸载时返回 true。
   * 放在每个 await 之后调用。
   */
  abortIfSettled(task, where) {
    if (this.disposed) {
      this.warn(`${LOG_PREFIX} 任务 %s 在%s已卸载，中止启动`, task.id, where)
      return true
    }
    if (!SETTLED.has(task.status)) return false
    this.log(`${LOG_PREFIX} 任务 %s 在%s已被结算为 %s，中止启动`, task.id, where, task.status)
    return true
  }

  /** 尽力取消一个已建出来的 worker agent（僵尸清理）。 */
  cancelWorkerAgent(agent) {
    if (!agent) return
    try { agent.cancel?.({ kind: 'user' }, { keepInbox: false }) }
    catch (error) { this.warn(`${LOG_PREFIX} 清理已中止的 worker 失败: %s`, String(error)) }
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
    // 记下「本回合已经给过终态报告」，供 onWorkerIdle 判断要不要补一条。
    // 用标记而不是时间戳比较，是因为 turnStartedAt 会被每一步 running 刷新。
    if (TERMINAL_REPORT.has(status)) task.reportedSinceTurn = true
    // progress 不结束任务；其余都是终态。结算后立刻让出并发位给排队任务。
    if (TERMINAL_REPORT.has(status)) this.settle(task, status)
    this.schedulePersist()

    // progress 只在主会话正忙时顺带并入，不为了它把人叫醒。
    // 批次内的终态报告只入库，等整批结束由 maybeSummarize 统一回流一条——
    // 但如果这一批已经汇总过了、或这条任务被重开过，就再也等不到汇总了，
    // 此时必须自己回流，否则它会彻底静默。
    const selfRelay = !task.group || task.groupClosed || task.groupReopened
    if (selfRelay || status === 'progress') {
      await this.relay(task, this.reportText(task, entry), status !== 'progress')
    }
    return { recorded: true, task_id: task.id, status: task.status, grouped: !selfRelay }
  }

  /** 报告文本：给主会话模型看的紧凑结构化消息。 */
  reportText(task, entry) {
    const head = `[dispatch] 任务 ${task.id} · ${task.title} · 报告 ${entry.status}`
    const tail = entry.detail ? `\n详情：\n${clip(entry.detail, 4000)}` : ''
    return `${head}\n摘要：\n${clip(entry.summary, 6000)}${tail}\n（子会话 ${task.workerSessionId}）`
  }

  /**
   * 把报告投递回派发它的主会话。
   *
   * `wake=false` 表示「只落库，不叫醒人」：主会话空着就什么都不做。
   * 0.6.0 之前这里靠 `parent.status !== 'running'` 自己判断，再让
   * `sessions.deliver` 用 steer —— 但 steer 对空闲 agent 会静默降级成
   * followup（唤醒），与「不打扰」的意图相反，而且两处判据各看各的。
   * 现在判断只留一处（这里），投递方式交给 deliver 的 `wake` 选项。
   *
   * 可靠性：投递失败会重试（2s 起、翻倍、最多 3 次），并把结果记在
   * `task.delivery` 上供 `dispatch_inspect` 与看板查看。0.6.0 之前
   * 返回值被调用方完全忽略，报告丢了只能靠人工去捞——这直接违背了
   * 「报告会自己回来」这个核心承诺。
   *
   * @returns {Promise<'delivered'|'delivered-degraded'|'recorded'|'dropped'|'failed'>}
   */
  async relay(task, text, wake) {
    const parentId = task.parentSessionId
    const parent = this.ctx.agents.get(parentId)
    if (!parent) {
      this.warn(`${LOG_PREFIX} 主会话 %s 已不在运行，报告只落到任务表`, parentId)
      this.noteDelivery(task, 'dropped')
      return 'dropped'
    }
    if (!wake && parent.status !== 'running') {
      this.noteDelivery(task, 'recorded')
      return 'recorded'
    }
    return this.#deliverWithRetry(task, parentId, text, wake)
  }

  /** 记一条投递结果到任务上（不占报告数组，单独字段）。 */
  noteDelivery(task, outcome, attempt) {
    task.delivery = { at: now(), outcome, ...(attempt ? { attempt } : {}) }
  }

  /**
   * 带退避重试的投递：2s → 4s → 8s，共 3 次。
   *
   * 只对「可重试」的失败重试（投递抛错）；`dropped`（主会话不在）不重试，
   * 因为主会话没了重试也没用，那属于需要人看的问题，记在 delivery 上。
   */
  async #deliverWithRetry(task, parentId, text, wake) {
    const delays = [2000, 4000, 8000]
    let lastError
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const result = await this.sessions.deliver(parentId, nextMessageId(task.id, 'relay'), text, {
          mode: 'steer',
          wake: !!wake,
        })
        const outcome = result.delivered === 'prompt' ? 'delivered-degraded' : 'delivered'
        this.noteDelivery(task, outcome, attempt > 0 ? attempt + 1 : undefined)
        if (outcome === 'delivered-degraded') {
          this.warn(`${LOG_PREFIX} 任务 %s 的报告已送达，但来源降级为 user（收件箱不可用）`, task.id)
        }
        return outcome
      } catch (error) {
        lastError = error
        if (attempt === delays.length) break
        this.warn(`${LOG_PREFIX} 报告投递失败（第 %d 次），%d ms 后重试: %s`,
          attempt + 1, delays[attempt], String(error))
        await new Promise(resolve => setTimeout(resolve, delays[attempt]))
        // 重试期间主会话可能已经没了，没必要继续
        if (!this.ctx.agents.get(parentId)) break
      }
    }
    this.warn(`${LOG_PREFIX} 报告投递最终失败 %s: %s`, task.id, String(lastError))
    this.noteDelivery(task, 'failed')
    return 'failed'
  }

  /** 任务启动失败时也要让主会话知道，而不是只留在任务表里。 */
  async relayFailure(task) {
    await this.relay(task, `[dispatch] 任务 ${task.id} · ${task.title} 启动失败：${task.error ?? '未知错误'}`, true)
  }

  /**
   * worker 回合结束（agent/status → idle）时的自动回报。
   * 本回合已经给过终态报告就不重复；只报过 progress 的仍然要补一条，
   * 否则主会话会一直干等。
   *
   * 判断「本回合是否已报告」用的是**显式标记** `task.reportedSinceTurn`，
   * 而不是拿报告时间戳和 `task.turnStartedAt` 比较。原因：`turnStartedAt`
   * 会被每一次 `agent/status → running` 覆盖（多步回合每步一次），
   * 于是「终态报告发生在最后一个 running 之前」的常见情形会被误判成
   * 「本回合没报告」，追发一条「worker 未显式报告」的回流——重复打扰。
   */
  async onWorkerIdle(sessionId) {
    const task = this.table.byWorker(sessionId)
    if (!task || task.status !== 'running') return

    const agent = this.ctx.agents.get(sessionId)
    const text = agent ? lastAssistantText(agent) : ''
    task.lastText = text
    task.updatedAt = now()

    const reportedThisTurn = !!task.reportedSinceTurn
    task.reportedSinceTurn = false
    if (reportedThisTurn) {
      if (task.status === 'running') this.settle(task, 'done')
      this.schedulePersist()
      return
    }

    // 这是重开过的批次成员（retry 过），必须自己回流：它所属的批次早已汇总，
    // 不会再有一条汇总覆盖它。0.6.0 之前 groupClosed 永不复位，配合 report 与
    // onWorkerIdle 的 group 短路，导致被 retry 的批次成员**三条回流路径全关**、彻底静默。
    //
    // 注意这里**不能**把 groupClosed 复位成 false：`settle()` 会触发
    // maybeSummarize，而它一看「有成员未标记汇总」就会再发一条批次汇总，
    // 结果是重复打扰。所以用一个独立标记，不动批次的原状态。
    const reopened = !!task.groupReopened
    this.settle(task, 'ended')
    this.schedulePersist()
    if (!this.config.reportOnTurnEnd) return

    // settle() 里的 maybeSummarize 可能**刚刚**为这一批发了汇总（尤其单成员批次，
    // 结算瞬间就满足「全部结算」）。那种情况下再单独回流一条就是重复。
    const summarizedNow = !!task.group && !!task.groupClosed && !reopened
    if (summarizedNow) return

    // 未汇总的批次成员不单独回流：整批结束时有一条汇总，逐条发等于没汇总。
    if (task.group && !task.groupClosed && !reopened) return

    const body = text ? clip(text, 5000) : '（worker 本轮没有输出文本）'
    await this.relay(task,
      `[dispatch] 任务 ${task.id} · ${task.title} · 一轮执行结束（worker 未显式报告）\n最后一条消息：\n${body}\n`
      + '\n用 dispatch_inspect 看细节，或用 dispatch_message 继续指派；任务已释放并发位。', true)
  }

  /**
   * 给某个任务追加一条消息（主会话 → worker），任务重新进入 running。
   *
   * 顺序很重要：0.6.0 之前先写 `status='running'` 再 await 投递，
   * 投递失败时状态不回滚——一个已完成的任务被打回 running 并永久占用
   * 并发位。对 queued 任务更糟：状态置 running 但没从队列摘除，
   * `takeRunnable` 之后 shift 出它发现状态不符直接丢弃，排队顺序错乱。
   *
   * 现在：先投递，投递成功后才跃迁状态；失败则保持原状态并把错误抛出去。
   */
  async message(task, text, mode) {
    if (task.status === 'cancelled') throw new Error(`任务 ${task.id} 已取消；请重新 dispatch_launch 一个新任务`)

    const agent = this.ctx.agents.get(task.workerSessionId)
    if (!agent) {
      // 会话可能被关掉了；先尝试恢复，恢复不了就明确报错，不要假装投递成功。
      const resolved = await this.ctx.sessionController.resolveAgent(task.workerSessionId)
      if (resolved?.error) throw new Error(`子会话 ${task.workerSessionId} 不可用：${resolved.error.code}`)
    }

    // 投递在前：失败就整体失败，状态不变。
    await this.sessions.deliver(task.workerSessionId, nextMessageId(task.id, 'msg'), text, {
      mode: mode === 'steer' ? 'steer' : 'queue',
      wake: true,
    })

    // 投递成功后重新开一条回合：续跑语义（已结算 → running）走 force，
    // 因为终态没有普通出边；还在 running 的任务保持 running，只刷新回合起点。
    if (task.status === 'running') {
      task.turnStartedAt = now()
      task.updatedAt = task.turnStartedAt
    } else {
      this.table.transition(task, 'running', { force: true })
      task.turnStartedAt = now()
      task.updatedAt = task.turnStartedAt
    }
    this.schedulePersist()
    return task
  }

  /**
   * 取消一个任务：结束 worker 当前回合并释放并发位。已产生的工作不回滚。
   *
   * 前置检查：已经结算的任务不能再被取消——0.6.0 之前没有这个判断，
   * 看板上对已 done 的任务点「取消」会把它改写成 cancelled。
   */
  async cancel(task, reason) {
    if (SETTLED.has(task.status)) {
      throw new Error(`任务 ${task.id} 已结算（${task.status}），不能取消`)
    }
    this.table.dequeue(task.id)
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

    // attempt 只在**投递成功之后**才递增：0.6.0 之前先自增再投递，
    // 投递失败时 attempt 已经消耗掉、状态还卡在 running。
    const nextAttempt = (task.attempt ?? 1) + 1
    task.error = undefined
    task.lastReportAt = undefined

    const existing = this.ctx.agents.get(task.workerSessionId)
    let resumable = !!existing
    if (!resumable) {
      // 这里区分「确定不存在」与「探不了」：只有明确的 not-found 才换会话。
      // 0.6.0 之前是 .catch(() => undefined) 把任意异常都当成不可恢复，
      // 一次瞬时的 gateway/internal 就会白白换掉 worker、历史断链。
      let probe
      try {
        probe = await this.ctx.sessionController.resolveAgent(task.workerSessionId)
      } catch (error) {
        // 探不了：不知道会话在不在。按「在」处理，续跑同一会话——最坏情况是
        // 投递失败并明确报错，比默默丢掉历史好。
        this.warn(`${LOG_PREFIX} 重试任务 %s 时无法确认子会话状态（%s），按可续跑处理`,
          task.id, String(error))
        resumable = true
      }
      if (probe) resumable = !probe.error
      else if (resumable === undefined) resumable = false
    }

    if (resumable) {
      // 已完成的任务被重试，语义是「再执行一次」，不是「接着没做完的地方」。
      const instruction = task.status === 'done'
        ? `主会话要求把原任务再执行一次（第 ${nextAttempt} 次）。上一轮已报过 done；`
          + '请重新核对当前状态与要求是否仍然满足，按需补做，然后照常用 dispatch_report 汇报结论。'
        : `主会话要求重试（第 ${nextAttempt} 次尝试）。上一轮没有正常完成或被打断；`
          + '请从中断处继续完成原任务，完成后照常调用 dispatch_report 汇报。'
      this.log(`${LOG_PREFIX} 重试任务 %s：续跑子会话 %s`, task.id, task.workerSessionId)
      await this.message(task, instruction, 'queue')
      // 投递成功，此时才记入 attempt。
      task.attempt = nextAttempt
      task.updatedAt = now()
      this.schedulePersist()
      return task
    }

    // 重开过的批次成员：它所属的批次早已汇总，不会再有汇总覆盖它。
    // 打一个独立标记，让 report 与 onWorkerIdle 允许它自己回流。
    // 注意**不动** groupClosed——改了它会让 maybeSummarize 以为这批还没汇总，重复发一条。
    if (task.group && !task.groupReopened) task.groupReopened = true

    // 会话不在了：换一个 worker 会话，把原始简报重投一遍。
    task.attempt = nextAttempt
    task.workerSessionId = `dispatch-${task.id}-a${task.attempt}`
    task.turnStartedAt = undefined
    task.lastText = ''
    // reopen 会自己把任务放进队列（且不会重复入队）——0.6.0 之前这里是
    // 「先置 queued 再 table.add」，同一个 id 会在 queue 里出现两次。
    if (!this.table.reopen(task)) {
      throw new Error(`任务 ${task.id} 重试失败：无法从 ${task.status} 回到排队状态`)
    }
    if (!this.table.tasks.has(task.id)) this.table.add(task)
    this.schedulePersist()
    this.log(`${LOG_PREFIX} 重试任务 %s：新开子会话 %s`, task.id, task.workerSessionId)
    void this.pump()
    return task
  }

  // ---------------------------------------------------------------- 事实

  /**
   * 事实：worker 的 Session 进入了 running（宿主 `agent/status` 事件）。
   *
   * 这是一个**事实方法**（过去式命名），不是命令：它只记录发生了什么。
   * 已结算的任务收到这个事实时**什么也不做**——任务已经结束了，
   * 迟到的 running 事件不能把它复活。这一点是 0.6.0 的一个真 bug：
   * 当时 index.js 里无条件 `task.status = 'running'`，把 done/cancelled
   * 的任务改回 running，并发位被幽灵占用且永远不再结算。
   *
   * 对仍在 running 的任务，它只刷新回合起点（用于判断本回合是否已报告）。
   */
  workerTurnStarted(task) {
    if (!task) return
    if (SETTLED.has(task.status)) return          // 迟到的 running：忽略
    if (task.status === 'queued') return          // 还没启动：由 pump 推进
    task.turnStartedAt = now()
    task.updatedAt = task.turnStartedAt
    this.schedulePersist()
  }

  // ---------------------------------------------------------------- 视图

  /**
   * 列表里展示的任务摘要。
   *
   * `report_delivery` 是把「报告有没有真的送到主会话」暴露出来：
   * 0.6.0 之前 relay 的返回值被完全忽略，报告丢了（retry 用尽仍失败、
   * 或主会话已不在）用户只能靠人工去翻日志。现在失败会显示在卡片上，
   * 一行就能看出「这条报告没送到」。
   */
  card(task) {
    return {
      task_id: task.id,
      title: task.title,
      status: task.status,
      session_id: task.workerSessionId,
      ...(task.workspaceTitle ? { workspace: task.workspaceTitle } : {}),
      ...(task.hostWorkspaceTitle ? { host_workspace: task.hostWorkspaceTitle } : {}),
      ...(task.archivedAt ? { archived_at: task.archivedAt } : {}),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      ...(task.lastReportAt ? { last_report_at: task.lastReportAt } : {}),
      ...(task.reports.length ? { reports: task.reports.length } : {}),
      summary: task.reports.length ? oneLine(task.reports.at(-1).summary, 200) : oneLine(task.lastText, 200),
      ...(task.error ? { error: oneLine(task.error, 300) } : {}),
      ...(task.delivery && task.delivery.outcome !== 'delivered'
        ? { report_delivery: task.delivery }
        : {}),
    }
  }

  /** 详情：卡片 + 最近报告 + worker 最后输出。 */
  detail(task) {
    return {
      ...this.card(task),
      brief: clip(task.brief, 2000),
      cwd: task.cwd,
      ...(task.briefTruncated ? { brief_truncated_to: task.brief.length } : {}),
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

  /**
   * 写盘。
   *
   * 串行化：0.6.0 之前这里可以被并发调用（800ms 防抖那次、dispose 那次、
   * 归档巡检那次各自独立），两次写同一文件会互相覆盖，配合非原子写
   * 产生半截 JSON。现在挂一条 promise 链，后一次等前一次结束。
   */
  persist() {
    this.#persistChain = (this.#persistChain ?? Promise.resolve())
      .then(() => this.#writeOnce())
      .catch(() => { /* 已在 #writeOnce 内记日志 */ })
    return this.#persistChain
  }

  async #writeOnce() {
    try {
      // brief **完整落盘**，不在写盘时截断。
      //
      // 0.6.0 之前这里是 `clip(task.brief, 2000)`：落盘截断后，重启读回的是
      // 残版简报；此时 retry 的「重投原始简报」投的是被截断的任务描述，
      // worker 拿到不完整的任务要求却无从得知（实测 5000 字 → 2017 字）。
      // 展示层要短可以在 card/detail 里截（那里本来就截了）。
      //
      // 代价：状态文件会随简报变大。因此对单条 brief 设一个宽松的上限
      // （maxBriefChars 的 2 倍，默认 24000 字），超过才截，并在任务上
      // 留一个 briefTruncated 标记，让 inspect 能看到「这条被截过」。
      const limit = Math.max(2000, Number(this.config.maxBriefChars || 12000) * 2)
      const tasks = [...this.table.tasks.values()].map(task => {
        if (typeof task.brief !== 'string' || task.brief.length <= limit) return { ...task }
        return { ...task, brief: task.brief.slice(0, limit), briefTruncated: task.brief.length }
      })
      const targets = Object.fromEntries(this.targets)
      await writeState(this.stateFile, { tasks, targets }, now())
      this.persistError = undefined
    } catch (error) {
      this.persistError = String(error)
      this.warn(`${LOG_PREFIX} 状态落盘失败: %s`, String(error))
    }
  }

  /**
   * 启动时读回任务表与派发目标；进程之间没有活的 worker，所以未结算的一律标为 interrupted。
   *
   * 派发目标：不能再按 `workspace_id` 过滤——`auto` 目标没有 workspace_id，
   * 0.6.0 之前被这行过滤掉，导致用户设的「自动选择」每次重启都失效。
   * 而 0.6.0 起 auto 还意味着「必派发」模式，丢失后会话会静默退回
   * 「不派发」（自己干活），行为反转且界面无提示。
   */
  async restore() {
    let state
    try {
      state = await readState(this.stateFile)
    } catch (error) {
      // 主文件与备份都不可用：明确报出来，不要静默拿空表继续跑。
      this.warn(`${LOG_PREFIX} 读取历史状态失败（文件已损坏且无可用备份）：%s`, String(error))
      this.restoreError = String(error)
      return
    }

    try {
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
        // 保留所有形态的目标：auto 与具体工作区都算。只要对象非空就是有效设置。
        if (target && typeof target === 'object' && (target.auto || target.workspace_id)) {
          this.targets.set(sessionId, target)
        }
      }
      if (state.recovered === 'bak') {
        this.warn(`${LOG_PREFIX} 主状态文件损坏，已从备份 %s.bak 恢复`, this.stateFile)
        this.restoreError = 'recovered-from-bak'
      }
      this.log(`${LOG_PREFIX} 读回 %d 个历史任务、%d 个派发目标（%s）`, this.table.tasks.size, this.targets.size, this.stateFile)
    } catch (error) {
      this.warn(`${LOG_PREFIX} 恢复历史状态失败: %s`, String(error))
      this.restoreError = String(error)
    }
  }

  /**
   * 会话是否存在（活着的或已持久化的）。
   *
   * 用 `state()` 而不是 `resolveAgent()`：前者只读被动状态，不 resume Agent，
   * 探测本身不该有副作用。也不要传不存在的方法名——0.5.0 曾经写成 `inspect`
   * （那是另一个服务的接口），结果永远返回「不存在」，误判成会话丢了。
   * @returns {Promise<{ exists: boolean, error?: string }>}
   */
  async sessionExists(sessionId) {
    const controller = this.ctx.sessionController
    if (!controller) return { exists: false, error: 'sessionController 不可用' }
    const signal = new AbortController().signal
    try {
      if (typeof controller.state === 'function') {
        await controller.state({ sessionId }, signal)
        return { exists: true }
      }
      // 没有 state 就退回 list 遍历（一次拿到全部可见会话，不激活 Agent）。
      if (typeof controller.list === 'function') {
        const value = await controller.list({}, signal)
        const items = Array.isArray(value?.items) ? value.items : []
        return { exists: items.some(item => item?.sessionId === sessionId) }
      }
      return { exists: false, error: 'sessionController 没有 state 也没有 list' }
    } catch (error) {
      const code = error?.code ?? error?.name ?? 'unknown'
      return { exists: false, error: `${code}: ${String(error?.message ?? error).slice(0, 200)}` }
    }
  }

  /**
   * 自检：回答「宿主这一半到底装好没有」。
   *
   * 关键是 `client.inGraph`：宿主是否把本包的 client 模块编进了 Web 启动图。
   * 为 false 时，页面刷新也不会出现面板/控件——要么插件没重载，要么清单有问题。
   */
  async selfCheck() {
    const clientModules = this.ctx.get('clientModules')
    let clientPath
    try { clientPath = typeof clientModules?.clientPath === 'function' ? clientModules.clientPath(NAME) : undefined }
    catch { clientPath = undefined }

    // 把 Web 启动图里已经编进去的模块 id 列出来：用来区分「需要重启宿主」
    // 和「本包清单有问题」——两者现象一样，原因完全不同。
    let graphModules = []
    try {
      const graph = clientModules?.graph?.()
      const source = graph?.modules ?? graph?.entries ?? graph
      if (Array.isArray(source)) {
        graphModules = source.map(item => (typeof item === 'string' ? item : item?.id)).filter(Boolean)
      } else if (source && typeof source === 'object') {
        graphModules = Object.keys(source)
      }
    } catch { graphModules = [] }

    const registry = this.workspaces.registry
    const leadId = String(this.config.leadSessionId || 'mas-lead')
    const leadProbe = await this.sessionExists(leadId)
    return {
      version: VERSION,
      name: NAME,
      client: {
        inGraph: !!clientPath,
        path: clientPath ?? null,
        // 浏览器半边是否真的执行过（它自己在 apply 末尾回报）；与 inGraph 是两件事：
        // inGraph=true 只说明模块进了图，ready 才说明它在页面里跑起来了。
        ready: this.clientReady ?? null,
        bootAt: this.bootAt,
        // 用几个已知有 client 半边的包做对照，判断 clientPath 这个探针本身是否可靠
        probes: (() => {
          const ids = [NAME, 'dsh-context', 'dsh-ppt', 'eac-design-world', 'dsh-better-sidebar', 'dsh-free-search']
          const out = {}
          for (const id of ids) {
            try { out[id] = typeof clientModules?.clientPath === 'function' ? (clientModules.clientPath(id) ?? null) : null }
            catch { out[id] = 'throw' }
          }
          return out
        })(),
        graphModules: graphModules.slice(0, 80),
        graphModuleCount: graphModules.length,
        // 判据：图里若有别的 profile 插件的 client 模块，说明扫描是工作的，
        // 缺我们就是清单问题；一个都没有则是宿主启动时的那次扫描还没发生。
        peerExample: graphModules.find(id => id !== NAME) ?? null,
      },
      host: {
        webServer: typeof this.ctx.get('webServer')?.register === 'function',
        workspaceRegistry: !!registry,
        sessionController: !!this.ctx.get('sessionController'),
        permissionPresets: typeof this.ctx.get('permissionPresets')?.set === 'function',
        inputTrigger: null,   // 客户端能力，宿主看不到
      },
      workspaces: {
        root: this.workspaces.root,
        count: this.workspaces.list().length,
        default: this.defaultWorkspace
          ? { id: this.defaultWorkspace.id, title: this.defaultWorkspace.title, path: this.defaultWorkspace.path }
          : null,
      },
      lead: { sessionId: leadId, exists: leadProbe.exists, ...(leadProbe.error ? { error: leadProbe.error } : {}) },
      targets: this.targets.size,
      tasks: {
        total: this.table.tasks.size,
        running: this.table.runningCount(),
        archived: [...this.table.tasks.values()].filter(task => task.archivedAt).length,
        maxWorkers: this.table.maxWorkers,
      },
    }
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
      const probe = await this.sessionExists(leadId)
      if (probe.exists) return
      // 「查不了」不等于「不存在」：inspect 可能因权限/格式/读写失败而抛错，
      // 这时盲建会覆盖或冲突，所以只记一条警告，交给下一次启动重试。
      if (probe.error && !/not-found|ENOENT/i.test(probe.error)) {
        this.warn(`${LOG_PREFIX} 无法确认主会话 %s 是否存在（%s），本次跳过创建`, leadId, probe.error)
        return
      }
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

  /**
   * 插件卸载：收回注册的提示段、冲刷状态。运行中的子会话交给 DSH 自身管理。
   *
   * 注意 `disposed = true` 会让 `schedulePersist` 直接返回，所以这里
   * 必须**直接** await persist()（不是 schedule）。调用方（index.js 的
   * disposer）必须返回这个 Promise，宿主才会等写完再卸载。
   */
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
