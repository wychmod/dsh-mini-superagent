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
  SOURCE_KIND, STATE_DIR, TERMINAL_REPORT, VERSION, WORKER_WORKSPACE_CWD,
  newTaskId, nextMessageId, normalizeWorkerWorkspace, now,
} from './constants.js'
import { FORCED_HINT, ROUTER_LOCKED, SOFT_HINT, workerPrompt } from './prompt.js'
import { prepareEnv, runPrepare, taskDirectory } from './prepare.js'
import { SessionGateway } from './sessions.js'
import { readState, writeState } from './store.js'
import { TaskTable, clip, lastAssistantText, oneLine } from './tasks.js'
import { TOOL_NAMES } from './tools.js'
import { WorkspaceGateway, dayKey, rankWorkspaces } from './workspaces.js'

/**
 * 这个错误是不是**瞬时**的——换一次就能过，值得自动续跑。
 *
 * 判据与上游 `DshExecutor.transient()` 一致：HTTP 408/429/5xx，或连接被拒/重置/超时、
 * DNS 失败、限流。其余（参数错、权限错、脚本真报错）都不该重试——重试只会把同一个
 * 错误演三遍，还白占并发位。
 *
 * 为什么按文本匹配：宿主抛出来的错误形状不稳定（有的是 `Error`，有的是 `{status, message}`），
 * 状态码与网络错误串是最稳定的一组特征。
 */
const TRANSIENT = new RegExp([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR',
  'socket hang up', 'fetch failed', 'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b',
].join('|'), 'i')

/** @param {unknown} error */
export function isTransient(error) {
  const status = /** @type {{status?: unknown}} */ (error)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${String(/** @type {{code?: unknown}} */ (error).code ?? '')}`
    : String(error)
  return TRANSIENT.test(text)
}

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
    /**
     * 已进入「路由模式」的会话 id（工具面已被收窄）。
     * 一个会话第一次派发时登记；disposer 由 SessionGateway 持有，插件卸载或会话销毁时收回。
     */
    this.routers = new Set()
    /** 任务 id → 已用掉的瞬时故障续跑次数；成功报告或回合正常结束时清零。 */
    this.retryCounts = new Map()
    /** 待触发的续跑定时器，卸载时统一清掉。 */
    this.retryTimers = new Set()
    /** worker 的 subagent：agent id → 它所属的 worker 会话 id（只用于记账与清理）。 */
    this.subagentOf = new Map()
    /** 任务 id → 「后台活还在跑」的巡检定时器。 */
    this.backgroundTimers = new Map()
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
    this.sessions.hint(agent, () => {
      const base = this.modeOf(agent.id) === MODE_ALWAYS ? FORCED_HINT : SOFT_HINT
      // 进了路由模式就把「write/edit 已不可用」说出来：模型看不到工具时，
      // 一句提示能让它直接改道派发，而不是反复试错或声称自己没有能力。
      return this.routerLocked(agent) ? `${base}\n\n${ROUTER_LOCKED}` : base
    })
  }

  /**
   * 让一个会话进入「路由模式」：收窄它的工具面，从此改代码只能派给子会话。
   *
   * **只对「必派发」的会话生效**。这是与上一版的关键差别：
   * 在我们的模型里任何会话都可能是主会话，而且「不派发」是默认选项——
   * 只要派过一次就永久收走 write/edit，等于用插件的产品假设覆盖用户的当场意图。
   * 所以判据是用户自己选的开关：`modeOf() === 'always'`（输入框里选了具体工作区或「自动」）。
   * 选回「不派发」时 setTarget 会调 syncRouter 立刻解锁。
   *
   * 其他约束：
   * - worker 递归派发时跳过（收窄它等于让它干不了活）；
   * - 幂等：同一个 agent 只收窄一次。
   *
   * @param {object} agent 目标会话
   */
  enforceRouter(agent) {
    if (!this.config.restrictRouter || !agent?.id) return
    if (this.modeOf(agent.id) !== MODE_ALWAYS) return
    if (this.table.byWorker(agent.id)) return
    if (this.routers.has(agent.id)) return
    const dispose = this.sessions.restrictTools(agent, this.config.routerDenyTools)
    if (typeof dispose !== 'function') return
    this.routers.add(agent.id)
    this.log('%s 会话 %s 进入路由模式，已收窄工具：%s',
      LOG_PREFIX, agent.id, (this.config.routerDenyTools ?? []).join(', ') || '(空)')
  }

  /** 会话被销毁（关窗/删除）时注销它的路由登记，收回工具收窄。 */
  forgetRouter(agentId) {
    if (!agentId) return
    if (!this.routers.delete(agentId)) return
    this.sessions.forgetRestrict?.(agentId)
    this.log('%s 会话 %s 退出路由模式，工具已还回', LOG_PREFIX, agentId)
  }

  /**
   * 按当前模式对齐锁：必派发就上锁，不派发就解锁。
   * setTarget 与启动时的 refreshAllHints 都走这里，保证「模式」和「工具面」永远一致。
   */
  syncRouter(agent) {
    if (!agent?.id) return
    if (this.modeOf(agent.id) === MODE_ALWAYS) this.enforceRouter(agent)
    else this.forgetRouter(agent.id)
  }

  /** 这个会话是否已经进了路由模式（工具面已被收窄）。 */
  routerLocked(agent) {
    return !!agent?.id && this.routers.has(agent.id)
  }

  /**
   * worker 派生出来的 subagent 也受 worker 的工具面约束——至少不能自己再派发。
   *
   * 为什么需要：9 个工具注册在全局层，所以 worker 的 subagent 也能看到 `dispatch_launch`，
   * 于是「一个任务」可以无限往下派生，而 `maxTasksPerSession` 只按主会话计数。
   * 上游用 `limitSubagent()` 把 subagent 限制到 worker 的工作工具，这里对齐它的**边界部分**：
   * 收走全部 `dispatch_*`，保留读写与执行（subagent 的职责本来就是干活）。
   *
   * 不做的那一半：任务结算后收走工作工具。上游的工单结束即终结，而我们允许
   * `dispatch_message` 把任务重新拉回 `running`，收走工具会让续跑直接失效。
   *
   * @param {object} agent 刚创建的 agent
   */
  decorateSubagent(agent) {
    if (!agent?.id) return
    if (this.table.byWorker(agent.id)) return          // worker 本身
    if (this.subagentOf.has(agent.id)) return
    const workerId = this.workerAncestorOf(agent)
    if (!workerId) return
    const dispose = this.sessions.restrictTools(agent, TOOL_NAMES)
    if (typeof dispose !== 'function') return
    this.subagentOf.set(agent.id, workerId)
    this.log('%s subagent %s 继承 worker %s 的工具面（收走 %d 个 dispatch 工具）',
      LOG_PREFIX, agent.id, workerId, TOOL_NAMES.length)
  }

  /** 沿 `parentSession` 链往上找最近的 worker 会话；最多 8 层，防脏数据成环。 */
  workerAncestorOf(agent) {
    let parent = agent?.session?.header?.parentSession
    for (let depth = 0; parent && depth < 8; depth += 1) {
      if (this.table.byWorker(parent)) return parent
      const parentAgent = this.ctx.agents.get(parent)
      parent = parentAgent?.session?.header?.parentSession
    }
    return undefined
  }

  /** subagent 销毁时收回它的工具收窄。 */
  forgetSubagent(agentId) {
    if (!agentId) return
    if (!this.subagentOf.delete(agentId)) return
    this.sessions.forgetRestrict?.(agentId)
  }

  /** 把所有活着的会话按当前模式刷一遍（插件启动时用）：先对齐锁，再换提示文本。 */
  refreshAllHints() {
    for (const agent of this.ctx.agents?.list?.() ?? []) {
      this.syncRouter(agent)
      this.refreshHint(agent)
    }
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
      // 切回「不派发」：提示换回轻提示，同时把路由模式收走的工具还回去。
      this.syncRouter(this.ctx.agents.get(sessionId))
      this.refreshHint(this.ctx.agents.get(sessionId))
      return undefined
    }
    if (value.toLowerCase() === AUTO) {
      const target = { auto: true, title: '自动选择', path: '' }
      this.targets.set(sessionId, target)
      this.schedulePersist()
      this.syncRouter(this.ctx.agents.get(sessionId))
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
    this.syncRouter(this.ctx.agents.get(sessionId))
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
    // 第一次从某个会话派发 → 这个会话就是「主会话」，进路由模式（改代码只能派下去）。
    // 放在 refreshHint 之前：提示文本的求值函数会读 routers，先锁再刷能把新文本带上。
    this.enforceRouter(agent)
    this.refreshHint(agent)
    this.schedulePersist()
    void this.pump()
    return task
  }

  /**
   * 子会话放在哪个工作区。
   *
   * 语义（0.8.1 起重写）：**有目标就用目标，没有目标才退回日期工作区**。
   *
   *   1. 任务带 `workspaceId` 且注册表里能查到 → 用它。这一步**不可关闭**，
   *      与 `workerWorkspace` 配成什么都不相干。
   *   2. 否则 → 当天的【派发】工作区（`workerWorkspace: day`，默认）。
   *   3. 再否则 → 任务的 `cwd`（会话按目录反查/登记）。
   *
   * 为什么重写：0.8.0 及更早这里是 `workerWorkspace === 'target' && target`，
   * 而 `workerWorkspace` 默认是 `day`，于是**用户明确指定了工作区也被塞进【派发】**，
   * 每次启动都凭空多出一个 `【派发】YYYY-MM-DD`。用户的意图恰恰相反：选了目标就
   * 应该在目标里，「退回日期工作区」只是找不到目标时的兜底，不是常态。
   *
   * `workerWorkspace: 'cwd'` 时跳过第 2 步：不建【派发】工作区，直接按目录归属。
   * 这是给「连兜底也不要工作区」的场景留的开关，默认不用。
   *
   * 注意：这里**只在真的需要兜底时**才调 `dayWorkspace()`（它会 mkdir + 注册）。
   * 有目标的时候一次都不碰，所以不会再有凭空的日期工作区。
   *
   * @returns {Promise<{ workspaceId?: string, path: string, title?: string }>}
   */
  async placementFor(task) {
    // 1. 有目标用目标。注册表里查不到（工作区被删了）才算「没有目标」。
    //    用 list() 而不是 registry.get()：list 是网关已有的稳定接口，假宿主也好桩。
    const target = task.workspaceId
      ? this.workspaces.list().find(item => item.id === task.workspaceId)
      : undefined
    if (target) return { workspaceId: target.id, path: target.path, title: target.title }

    // 2. 没有目标：按配置决定兜底到当天的【派发】工作区，还是直接用 cwd。
    if (this.workerWorkspaceMode() === WORKER_WORKSPACE_CWD) return { path: task.cwd }
    const day = await this.workspaces.dayWorkspace(dayKey())
    if (day) return { workspaceId: day.id, path: day.path, title: day.title }
    return { path: task.cwd }
  }

  /**
   * 归一后的 `workerWorkspace`（`'day'` / `'cwd'`）。
   * 每次读配置而不是构造时算好：`dispatch_workspaces` 会回读原始配置值，
   * 而测试与热改配置都可能直接改 `this.config`，缓存反而会读到过期值。
   */
  workerWorkspaceMode() {
    return normalizeWorkerWorkspace(this.config.workerWorkspace)
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
    // 结算就不再占后台巡检：任务已经结束，再巡检只会重复结算。
    this.stopBackgroundWatch(task.id)
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
  /**
   * 准备每任务目录：目录不存在时按 `prepareCommand` 跑一次，然后把任务 cwd 指过去。
   *
   * 为什么 cwd 要改：派发目标目录是「团队共享的仓库」，任务目录才是这个 worker
   * 独占的工作区（典型实现是 `git worktree`）。两者不同时，会话仍挂在目标工作区里
   * （侧边栏干净），但真正读写的是任务目录——`start()` 后面的 `enterDirectory()` 负责切换。
   *
   * 失败即 `failed` 且**不自动重试**：目录可能已被写了一半，重试会把它当作「已准备好」。
   *
   * @returns {Promise<boolean>} false = 已失败结算，调用方应停止启动
   */
  async prepareTaskDir(task, dir) {
    try {
      const result = await runPrepare({
        dir,
        command: this.config.prepareCommand,
        timeoutMs: this.config.prepareTimeoutMs,
        env: prepareEnv(task, dir),
      })
      task.taskDir = dir
      task.cwd = dir
      if (result.ran) task.prepareAt = now()
      if (result.output) task.prepareOutput = clip(result.output, 2000)
      this.schedulePersist()
      if (result.ran) this.log(`${LOG_PREFIX} 任务 %s 已准备目录 %s`, task.id, dir)
      return true
    } catch (error) {
      task.taskDir = dir
      task.error = String(error?.message ?? error)
      this.warn(`${LOG_PREFIX} 任务 %s 目录准备失败: %s`, task.id, task.error)
      this.settle(task, 'failed')
      this.schedulePersist()
      await this.relayFailure(task)
      return false
    }
  }

  async start(task) {
    // 占位：status 已经是 running（takeRunnable 占的），这里只记开始时间。
    task.startedAt = now()
    task.updatedAt = task.startedAt
    this.schedulePersist()

    // 每任务目录（可选）：配了 `taskDirRoot` 就先把目录准备好，再把 cwd 指过去。
    // 放在建会话之前，是因为 prepare 失败时不该留下一个孤儿 worker 会话。
    const taskDir = taskDirectory(this.config.taskDirRoot, task.title, task.id)
    if (taskDir) {
      const prepared = await this.prepareTaskDir(task, taskDir)
      if (!prepared) return task
    }

    const placement = await this.placementFor(task)
    if (this.abortIfSettled(task, '解析工作区之后')) return task

    // 记下子会话实际挂在哪个工作区。这是「它住在哪」，与 workspaceTitle
    //（「派发目标」）是两件事：有目标时它就是目标；没有目标时才可能落到当天的
    //【派发】工作区，此时 workspaceTitle 是空的。看板要显示前者，否则看起来像没归属。
    task.hostWorkspaceId = placement.workspaceId
    task.hostWorkspaceTitle = placement.title

    const created = await this.sessions.createWorker(task.workerSessionId, placement.path, `[派发] ${task.title}`, {
      // 单个任务显式指定的优先；否则用部署配置的默认 preset（指向一个收紧的 preset
      // 能让 worker 的前台命令更早转后台，上游是 5 秒）。
      agentPreset: task.agentPreset || this.config.workerAgentPreset || undefined,
      permissionPreset: task.permissionPreset,
      workspaceId: placement.workspaceId,
      // 0.8.1 及更早：这个字段只存进 task.model 就没了下文，工具 schema 承诺的 model 实际不生效。
      model: task.model,
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

    // 会话可能住在【派发】工作区（没有目标而兜底时），但活要干在目标任务的工作区里。
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
    // 报告能到就说明这一轮活过来了：瞬时续跑的计数清零，下次再 5xx 重新从头数。
    this.retryCounts.delete(task.id)
    task.retryAt = undefined
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
    // progress 节流：长任务每完成一步就报一次，会把主会话刷成一条流水线。
    // 被挡下的仍然入库（dispatch_inspect 看得到），只是不再单独回流。
    const interval = Math.max(0, Number(this.config.progressRelayIntervalMs) || 0)
    const lastProgressAt = task.progressRelayAt ? Date.parse(task.progressRelayAt) : 0
    const throttled = status === 'progress' && interval > 0 && Date.now() - lastProgressAt < interval
    if ((selfRelay || status === 'progress') && !throttled) {
      if (status === 'progress') task.progressRelayAt = entry.at
      await this.relay(task, this.reportText(task, entry), status !== 'progress')
    }
    return {
      recorded: true,
      task_id: task.id,
      status: task.status,
      grouped: !selfRelay,
      ...(throttled ? { throttled: true } : {}),
    }
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
    // 退避序列可配：默认 2s → 4s → 8s，共 3 次重试。
    const delays = Array.isArray(this.config.relayRetryMs) && this.config.relayRetryMs.length
      ? this.config.relayRetryMs
      : [2000, 4000, 8000]
    /**
     * 同一份报告的所有重试共用一个 requestId。
     *
     * 0.8.0 及更早把 `nextMessageId()` 写在循环里，每次重试换一个新 id：
     * 只要「第一次其实已投进收件箱、只是后面抛错」，第二次就会用新 id 再投一遍，
     * 主会话看到两条一模一样的报告，而且两条都记成 delivered。
     *
     * 稳定 id 才有判重的前提，配合下面的 holds() 才叫「至多一次」。
     */
    const requestId = nextMessageId(task.id, 'relay')
    let lastError
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const parent = this.ctx.agents.get(parentId)
      // 重试前先问一句「已经在里面了吗」：在就当作已送达，不再投。
      if (attempt > 0 && parent && this.sessions.holds?.(parent, requestId)) {
        this.warn(`${LOG_PREFIX} 任务 %s 的报告第 %d 次重试前已在会话中，按已送达处理`, task.id, attempt + 1)
        this.noteDelivery(task, 'delivered', attempt + 1)
        return 'delivered'
      }
      try {
        const result = await this.sessions.deliver(parentId, requestId, text, {
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

    // 回合结束 ≠ 活干完：后台还有 shell job / subagent 在跑时先不结算。
    // 结算会释放并发位，而后台仍在改同一个目录——上游把占用单位定成 Assignment，
    // 就是为了这件事。这里用「延迟结算 + 巡检」近似它。
    if (await this.handOffToBackground(task)) return

    await this.finishIdleTurn(task, text)
  }

  /**
   * 真正收尾一次回合：结算、批次汇总判定、兜底回报。
   * 后台活结束（或到上限）后由 `watchBackground()` 再次调用它。
   *
   * @param {object} task
   * @param {string} text worker 最后一条 assistant 文本
   * @param {{ note?: string }} [extra] 附在兜底回报里的说明（例如「后台活被终止」）
   */
  async finishIdleTurn(task, text, extra = {}) {
    if (SETTLED.has(task.status)) return

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
    const note = extra.note ? `\n${extra.note}` : ''
    await this.relay(task,
      `[dispatch] 任务 ${task.id} · ${task.title} · 一轮执行结束（worker 未显式报告）\n最后一条消息：\n${body}\n${note}`
      + '\n用 dispatch_inspect 看细节，或用 dispatch_message 继续指派；任务已释放并发位。', true)
  }

  /**
   * 回合结束时检查后台活：有就记下来并开始巡检，返回 true 表示「先别结算」。
   *
   * 判据只看宿主自己的两个服务：`jobs`（shell job）与 `subagents`（子代理）。
   * 两个服务都不存在时直接返回 false——没有服务就等于没有后台活，
   * 这正是 headless/精简部署的形态，不能因为缺服务把任务卡在 running。
   */
  async handOffToBackground(task) {
    const active = await this.backgroundOfWork(task)
    if (!active) return false
    task.background = { ...active, since: now() }
    task.updatedAt = now()
    this.schedulePersist()
    this.log('%s 任务 %s 回合结束，但后台还有 %d 个 job / %d 个 subagent，暂不结算',
      LOG_PREFIX, task.id, active.jobs, active.subagents)
    this.watchBackground(task)
    return true
  }

  /** 当前有哪些后台活在跑（job 与 subagent 各自计数）；都没有返回 undefined。 */
  async backgroundOfWork(task) {
    const sessionId = task?.workerSessionId
    if (!sessionId) return undefined
    let jobs = 0
    try {
      const listed = await this.ctx.get('jobs')?.list?.(sessionId)
      const list = Array.isArray(listed) ? listed : []
      jobs = list.filter(job => job?.owner === sessionId
        && (job.status === 'running' || job.status === 'stopping')).length
    } catch { jobs = 0 }
    let subagents = 0
    try {
      const children = await this.ctx.get('subagents')?.listChildren?.(sessionId)
      subagents = Array.isArray(children) ? children.filter(Boolean).length : 0
    } catch { subagents = 0 }
    if (!jobs && !subagents) return undefined
    return { jobs, subagents }
  }

  /**
   * 巡检后台活：还在跑就等下一轮；清空就收尾；到 `backgroundLimitMs` 就终止 job 再收尾。
   *
   * 每一个任务同时只有一个巡检器（`backgroundTimers` 记账），重复的 `idle` 不会叠出多个。
   */
  watchBackground(task) {
    if (this.backgroundTimers.has(task.id) || this.disposed) return
    const interval = Math.max(10, Number(this.config.backgroundPollMs) || 15000)
    const limit = Math.max(0, Number(this.config.backgroundLimitMs) || 0)
    const since = Date.parse(task.background?.since ?? '') || Date.now()

    const schedule = () => {
      const timer = setTimeout(() => {
        this.backgroundTimers.delete(task.id)
        void step()
      }, interval)
      timer.unref?.()
      this.backgroundTimers.set(task.id, timer)
    }

    const step = async () => {
      if (this.disposed || SETTLED.has(task.status)) return this.stopBackgroundWatch(task.id)
      const over = limit > 0 && Date.now() - since >= limit
      const left = over ? undefined : await this.backgroundOfWork(task)
      if (left) {
        // 计数会变（job 结束、subagent 换了一批），每轮刷新一次，看板显示的是最新值。
        task.background = { ...left, since: task.background?.since ?? now() }
        task.updatedAt = now()
        schedule()
        return
      }
      this.stopBackgroundWatch(task.id)
      const killed = over ? this.killBackground(task) : 0
      const hadJobs = task.background?.jobs ?? 0
      task.background = undefined
      if (killed) task.backgroundKilled = killed
      task.updatedAt = now()
      this.schedulePersist()
      const note = over
        ? `后台活超过 ${Math.round(limit / 60000)} 分钟上限，已结束（终止 ${killed}/${hadJobs} 个 job）`
        : '后台活已结束'
      await this.finishIdleTurn(task, task.lastText ?? '', { note })
    }

    schedule()
  }

  /** 到上限时终止还在跑的 shell job（best-effort：失败只记日志，不阻塞结算）。 */
  killBackground(task) {
    let killed = 0
    const sessionId = task?.workerSessionId
    if (!sessionId) return killed
    try {
      const service = this.ctx.get('jobs')
      const list = service?.list?.(sessionId)
      for (const job of Array.isArray(list) ? list : []) {
        if (job?.owner !== sessionId) continue
        if (job.status !== 'running' && job.status !== 'stopping') continue
        try {
          service.kill?.(job.id, sessionId, 'dsh-mini-superagent background limit')
          killed += 1
        } catch (error) {
          this.warn(`${LOG_PREFIX} 终止后台 job %s 失败: %s`, job.id, String(error))
        }
      }
    } catch (error) {
      this.warn(`${LOG_PREFIX} 终止任务 %s 的后台活失败: %s`, task?.id, String(error))
    }
    return killed
  }

  /** 停止一个任务的巡检器（幂等）。 */
  stopBackgroundWatch(taskId) {
    const timer = this.backgroundTimers.get(taskId)
    if (timer) clearTimeout(timer)
    this.backgroundTimers.delete(taskId)
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

    // 投递成功只代表「进了收件箱」，不代表 worker 读到了——先记一个「待读」标记，
    // 等 onSessionEvent 看到对应的 user/message 事件才清掉。看板据此区分
    // 「已投递、尚未读」与「已读」，避免消息躺在收件箱里而任务显示在跑。
    task.inputPendingAt = now()
    task.inputReadAt = undefined
    // 新一轮马上开始：上一轮的后台巡检作废，否则它可能在 worker 干活时把任务结算掉。
    this.stopBackgroundWatch(task.id)
    task.background = undefined
    task.backgroundKilled = undefined

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
    // 新一轮开始了（多半是 dispatch_message 唤醒）：后台巡检作废，
    // 否则上一轮的巡检会在这一轮跑到一半时把它结算掉。
    this.stopBackgroundWatch(task.id)
    task.background = undefined
    task.backgroundKilled = undefined
    task.turnStartedAt = now()
    task.updatedAt = task.turnStartedAt
    this.schedulePersist()
  }

  /**
   * worker 的回合抛错（宿主 `agent/error`）。
   *
   * 分两类，**不再一律当作「回合结束」**：
   * - 瞬时故障（408/429/5xx、连接被拒/重置、限流）：退避后续跑，次数用完才失败。
   *   0.8.1 及更早压根没订这个事件，于是模型 5xx 之后 worker 走到 idle，
   *   被自动回报成 `ended`，主会话看到的是一条「本轮没有输出」——像是任务做完了。
   * - 其他错误：直接 `failed` 并把原因回报，别让它挂在 running 上白占并发位。
   *
   * 上游 `DshExecutor` 的做法一致（3 次、15s×2ⁿ、只对 `transient()` 命中）。
   *
   * @param {object} agent 出错的 worker
   * @param {unknown} error 宿主给的错误
   */
  onWorkerError(agent, error) {
    const task = this.table.byWorker(agent?.id)
    if (!task || SETTLED.has(task.status)) return
    if (!this.config.retryTransient || !isTransient(error)) {
      void this.failTurn(task, error)
      return
    }
    const tries = this.retryCounts.get(task.id) ?? 0
    const delays = Array.isArray(this.config.retryBackoffMs) ? this.config.retryBackoffMs : []
    if (tries >= delays.length) {
      void this.failTurn(task, error, `瞬时故障连续 ${tries} 次，已放弃`)
      return
    }
    this.retryCounts.set(task.id, tries + 1)
    const delay = Math.max(0, Number(delays[tries]) || 0)
    const reason = oneLine(String(error?.message ?? error), 160)
    this.warn(`${LOG_PREFIX} 任务 %s 的 worker 遇到瞬时故障（%s），%d ms 后续跑（第 %d/%d 次）`,
      task.id, reason, delay, tries + 1, delays.length)
    task.retryAt = new Date(Date.now() + delay).toISOString()
    task.updatedAt = now()
    this.schedulePersist()

    const timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      void this.resumeAfterError(task, reason)
    }, delay)
    timer.unref?.()
    this.retryTimers.add(timer)
  }

  /** 把一条「从中断处继续」的消息投给 worker；任务保持 running，不重新占位。 */
  async resumeAfterError(task, reason) {
    if (this.disposed || SETTLED.has(task.status)) return
    try {
      await this.sessions.deliver(
        task.workerSessionId,
        nextMessageId(task.id, 'retry'),
        `[dispatch] 上一轮因瞬时故障中断（${reason || '未知原因'}）。请从中断处继续，`
        + '不要重做已经完成的部分；如果已经做完，直接 dispatch_report 收尾。',
        { mode: 'queue', wake: true },
      )
      task.retryAt = undefined
      task.updatedAt = now()
      this.schedulePersist()
    } catch (error) {
      this.warn(`${LOG_PREFIX} 任务 %s 的续跑投递失败: %s`, task.id, String(error))
      await this.failTurn(task, error, '续跑消息投不进去')
    }
  }

  /** 把一次失败的回合落成 `failed`：记原因、结算、回报主会话。 */
  async failTurn(task, error, note) {
    if (SETTLED.has(task.status)) return
    const reason = oneLine(String(error?.message ?? error ?? '未知错误'), 300)
    task.error = note ? `${note}：${reason}` : reason
    this.retryCounts.delete(task.id)
    task.retryAt = undefined
    this.settle(task, 'failed')
    this.schedulePersist()
    await this.relayFailure(task)
  }

  /**
   * worker 把某条**派发消息**读进了上下文（`session/event` 的 `user/message`）。
   *
   * 为什么需要它：`dispatch_message` 投递成功就够了吗？不够——投递只保证「进了收件箱」，
   * 而 worker 可能那一步就被 cancel、或回合在取用之前失败，消息躺在那里没人读，
   * 任务却显示 `running`，并发位被占着，报告永远不会来。上游把这件事拆成
   * `inputsDelivered` 与 `inputsRead` 两个事实，这里对齐「读回执」这一半。
   *
   * 只认 `msg` / `retry` 两种 id：`relay` / `start` 是发出去的，不能被当成「输入已读」。
   */
  onSessionEvent(session, event) {
    if (event?.type !== 'user/message') return
    const id = String(event?.data?.id ?? '')
    if (!id.startsWith(`${SOURCE_KIND}:`)) return
    const [taskId, kind] = id.slice(SOURCE_KIND.length + 1).split(':')
    if (kind !== 'msg' && kind !== 'retry') return
    const task = this.table.get(taskId)
    if (!task) return
    task.inputReadAt = now()
    task.inputPendingAt = undefined
    task.updatedAt = task.inputReadAt
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
      // 「追问问出去没有」：已投递未读是异常态（worker 那一步没拿到消息），值得显示。
      ...(task.inputPendingAt && !task.inputReadAt ? { input_pending_at: task.inputPendingAt } : {}),
      ...(task.inputReadAt ? { input_read_at: task.inputReadAt } : {}),
      ...(task.retryAt ? { retry_at: task.retryAt } : {}),
      ...(task.taskDir ? { task_dir: task.taskDir } : {}),
      ...(task.prepareAt ? { prepare_at: task.prepareAt } : {}),
      // 后台活：回合结束了但 job/subagent 还在跑，任务仍占着并发位。
      ...(task.background ? { background: task.background } : {}),
      ...(task.backgroundKilled ? { background_killed: task.backgroundKilled } : {}),
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
      let requeued = 0
      for (const item of state.tasks) {
        if (!item?.id || !item?.workerSessionId) continue
        const task = { ...item, reports: Array.isArray(item.reports) ? item.reports : [] }
        if (!SETTLED.has(task.status)) {
          /**
           * 「排队中、且从没启动过」是唯一能安全重排的状态：`startedAt` 是空的，
           * 说明 createWorker 还没跑过，既没有子会话也没有副作用，重排就是接着排队。
           *
           * 0.8.1 及更早一律标 `interrupted`，于是重启前排在队列里的任务要人工重派——
           * 上游 `DshExecutor.resume()` 会把 pending 的 launch 重新排队，这里对齐它。
           *
           * `running` 不重排：新进程里那个 worker 可能已经做了一半，重排会重复执行。
           */
          if (task.status === 'queued' && !task.startedAt) {
            task.updatedAt = now()
            this.table.add(task)
            requeued += 1
            continue
          }
          task.status = 'interrupted'
          task.updatedAt = now()
        }
        this.table.tasks.set(task.id, task)
      }
      if (requeued) this.log(`${LOG_PREFIX} 重启后重新入队 %d 个未启动的任务`, requeued)
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
      // 运维可见性：这三块是「配置了但没生效」最容易发生的地方，自检里直接回显。
      router: {
        enabled: !!this.config.restrictRouter,
        locked: this.routers.size,
        deny: Array.isArray(this.config.routerDenyTools) ? this.config.routerDenyTools : [],
      },
      delivery: {
        progressRelayIntervalMs: Math.max(0, Number(this.config.progressRelayIntervalMs) || 0),
        /** 报告最终没送到的任务数（>0 说明主会话不可达或收件箱坏了）。 */
        undelivered: [...this.table.tasks.values()].filter(task => task.delivery?.outcome === 'failed').length,
        /** 追问已投递但 worker 还没读的任务数（持续 >0 通常是那一步挂了）。 */
        unreadInputs: [...this.table.tasks.values()].filter(task => task.inputPendingAt && !task.inputReadAt).length,
      },
      retry: {
        transient: !!this.config.retryTransient,
        /** 正在等退避的续跑数。 */
        pending: this.retryTimers.size,
      },
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
   *
   * **这里刻意不建【派发】工作区。** 日期工作区只在 `placementFor()` 真的需要
   * 兜底时才按需创建（`dayWorkspace()` 自己会 mkdir + 注册）。0.8.1 之前虽然
   * 这里也没建，但 `placementFor()` 在有目标时也会走到 day 分支，等价于每次
   * 派发都建一个 —— 那才是「每次启动多一个【派发】YYYY-MM-DD」的来源。
   * 现在有目标时 `placementFor()` 在第一个 return 就离开了，一次都不碰。
   * `test/placement.test.js` 用桩钉住了这两条（provision 不建日期工作区、
   * 有目标时不调 dayWorkspace）。
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
    // 路由模式的 disposer 由 SessionGateway 统一收回（它持有全部注册），这里只清登记表。
    this.routers.clear()
    // 还没触发的续跑定时器必须清掉，否则插件卸载后它们还会往已经不存在的会话投消息。
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    this.retryCounts.clear()
    // 后台巡检同理：卸载后不该再有人去结算任务。
    for (const timer of this.backgroundTimers.values()) clearTimeout(timer)
    this.backgroundTimers.clear()
    this.subagentOf.clear()
    this.sessions.dispose()
    await this.persist()
  }
}
