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
  ADMISSION, AUTO, BLOCK_REASONS, CANCEL_REASONS, DEFAULTS, ERROR_CODES, HANDOFF_REASON_MAX_CHARS,
  HANDOFF_SOURCE, HEADLINE_LEDGER_MAX, LOG_PREFIX,
  MAX_REPORTS, MERGEABLE_REPORT_STATUSES,
  MODE_ALWAYS, MODE_OFF, NAME, NONE, NOTICE_MERGE_MAX_MS, PROJECTION, REPORT_SECTIONS, REPORT_VIEW,
  RETIRED_REASONS, SETTLED, SOURCE_KIND, STATE_DIR, TERMINAL_REPORT, TIME_BASIS, VERSION,
  WORKER_PREFIX, WORKER_WORKSPACE_CWD, fail, isWorkerSessionId, newTaskId, newThreadId, nextMessageId,
  normalizeWorkerWorkspace, now,
} from './constants.js'
import { FORCED_HINT, ROUTER_LOCKED, SOFT_HINT, handoffPrompt, withHandoffJudge, workerPrompt } from './prompt.js'
import { prepareEnv, runPrepare, taskDirectory } from './prepare.js'
import { SessionGateway } from './sessions.js'
import { isLedgerVersionError, readState, writeState } from './store.js'
import { TaskTable, canTransition, clip, lastAssistantText, oneLine } from './tasks.js'
import { TOOL_NAMES } from './tools.js'
import { batchText, failureText, idleText, reportText } from './voice.js'
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

/** 计划步骤的合法状态。未知值按 `pending` 处理（PRD-01 §4.1「缺省按 pending」）。 */
const PLAN_STATUSES = new Set(['pending', 'doing', 'done'])

/**
 * 同一段步骤文案最多保留几条（PRD-01 §4.1）。
 *
 * 为什么只限「完全相同的文案」而不做去重：计划的顺序有意义（第一步改文件、
 * 第二步跑测试，文案不同），去重会改掉 worker 表达的执行顺序。但模型偶尔会把
 * 同一条复制好几遍（尤其是「跑全量测试」），那种重复没有任何信息量，还会让
 * `plan_done / plan_total` 看起来永远做不完。
 */
const PLAN_MAX_SAME_TEXT = 3

/**
 * 把 worker 给的 `plan` 归一化成账本里的形状（PRD-01 §4.1）。
 *
 * 三条边界都在这里收口，`report()` 只负责调用：
 * - **整版替换**：不做增量合并，worker 不用维护 step id；
 * - **上限**：步数 / 单步字数超出就截断并回报 `truncated`，**不报错**——
 *   计划是汇报的附属信息，不能因为计划太长让结论回不来；
 * - **空文案**：丢弃该步；全空视同没传（调用方据此保持已有计划不变）。
 *
 * 字符串条目按 `{text, status: 'pending'}` 容错接受：schema 只声明对象形状，
 * 但模型偶尔会直接给字符串数组，为一个纯格式问题拒掉整条计划没有收益。
 *
 * @param {unknown} raw `dispatch_report` 的 `plan` 参数
 * @param {object} config 已合并的配置（取 `maxPlanSteps` / `maxPlanStepChars`）
 * @returns {{steps: Array<{text: string, status: string}>|undefined, accepted: boolean, truncated: boolean}}
 */
function normalizePlan(raw, config) {
  // 配置写成 0 视为「不接收计划」：上限为 0 时任何一步都存不下，早退比逐条截断更诚实。
  const maxSteps = Math.max(0, Math.floor(Number(config?.maxPlanSteps) || 0))
  const maxChars = Math.max(0, Math.floor(Number(config?.maxPlanStepChars) || 0))
  if (!Array.isArray(raw) || !maxSteps || !maxChars) {
    return { steps: undefined, accepted: false, truncated: false }
  }
  const steps = []
  /** 已收集的同文案次数；键是**截断后的**文案，避免两条超长文案截完相同却各占一份额度。 */
  const seen = new Map()
  let truncated = false
  for (const item of raw) {
    const source = typeof item === 'string' ? { text: item } : (item && typeof item === 'object' ? item : null)
    if (!source) continue
    // 单行化：步骤文案会进 2 秒轮询的看板与抽屉的一行，换行会把布局撑坏。
    const text = String(source.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const chars = Array.from(text)
    if (chars.length > maxChars) truncated = true
    const clipped = chars.length > maxChars ? chars.slice(0, maxChars).join('') : text
    const count = seen.get(clipped) ?? 0
    // 重复文案只保留前 3 条；这属于清洗而不是超限，不置 truncated（返回值只说「超限截断」）。
    if (count >= PLAN_MAX_SAME_TEXT) continue
    // 收满上限后还能看到一条**有效**步骤，才说明真的被截了；全是空/重复则不算。
    if (steps.length >= maxSteps) {
      truncated = true
      break
    }
    seen.set(clipped, count + 1)
    steps.push({
      text: clipped,
      status: PLAN_STATUSES.has(String(source.status ?? '')) ? String(source.status) : 'pending',
    })
  }
  return { steps: steps.length ? steps : undefined, accepted: steps.length > 0, truncated }
}

/**
 * 续派时追加给 worker 的那条消息的**开头**（plans/08 阶段 1 · 模型 A）。
 *
 * 为什么必须有这一段，而不是直接把调用方的文本塞进去：模型 A 的代价就是
 * 「这次要求与上次要求混在同一个任务里」（plans/08 §二）。worker 看到的是**同一条**
 * 会话历史，它无从分辨新消息是一条补充要求、还是「上一轮没做对，重做一遍」。
 * 这两种理解会导向完全不同的动作：前者只做增量，后者会把已经通过的验收全部推翻。
 * 一行前缀把歧义消掉，代价是每次续派多几十个字。
 *
 * 措辞里「不要重做」必须有：worker 的默认读法常常是「重新执行这个任务」，
 * 而续派的语义恰恰是「增量」。
 */
const CONTINUE_LEAD = '【续派】主会话在**同一个任务**上追加了一条新要求（没有新建任务，会话与历史都是上一轮的）。'
  + '只处理这条新要求；已经完成并通过验收的部分不要重做，除非这条要求与它冲突。'
  + '完成后照常用 dispatch_report 汇报。'

/**
 * 续派消息的前缀（**导出**给看板用）。
 *
 * 为什么不能各写一份字面量：同一条要求从 `dispatch_launch({continue_task_id})` 与
 * 看板「续派」按钮进来，worker 看到的东西必须一样。两份字面量今天一样、明天就会
 * 有人改一处忘另一处，而症状是「同一句话在工具里有效、在看板里被理解成另一件事」——
 * 这种偏差没有报错、只有行为差异，最难查。
 *
 * @returns {string}
 */
export function continueLead() { return CONTINUE_LEAD }

/**
 * 两个目录是不是同一个（续派的一致性校验用）。
 *
 * 为什么不直接比字符串：Windows 上 `D:\Idea\X` 与 `d:\idea\x` 是同一目录，
 * 宿主 realpath 之后还可能改写盘符大小写；比字符串会把同一个目录判成两个，
 * 于是「明明没换工作区」的续派被拒。不做 realpath：那是 async 且会抛错，
 * 而这里只需要判断「调用方是不是在指另一个目录」，粗粒度比较足够。
 */
function sameDir(left, right) {
  const norm = value => String(value ?? '').trim().replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\')
  const a = norm(left)
  return !!a && a === norm(right)
}

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
   * 依赖级联取消的**重入闸**（PRD-02 §4.4）。
   *
   * `#cancelDependents()` 会通过 `settle()` 触发嵌套 `pump()`，而嵌套 pump 又会算出
   * 新的「可取消后继」。没有这道闸，同一条链会在每一层被重算一遍（幂等所以不会
   * 错，但会随链长做 O(n²) 的重复扫描）。闸只在**级联期间**为真，最外层的工作队列
   * 会按 BFS 把整条链走完，所以放过内层不会漏掉任何一条。
   */
  #cascadingDependencies = false

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
     * 恢复期间为 true：`pump()` 一律直接返回（PRD-02 §4.6）。
     *
     * 依赖收敛必须走 `settle()`（终态、`settledAt`、等待者都挂在那里），而 `settle()`
     * 会 `void this.pump()`。`restore()` 跑在 `apply()` 里、工具还没注册、工作区还没
     * provision——此刻启动 worker 比不启动危险得多。所以恢复窗口内用这个闸挡住推进，
     * 等 `apply()` 末尾的正常 pump 用**同一份** `takeRunnable(blockedBy)` 判定接手。
     */
    this.restoring = false
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
    /**
     * 会话 id → 上一次**真正装配进请求**的提示文本（见 `refreshHint`）。
     *
     * 为什么要记：宿主能追加提示的路由（`systemPromptUpdate: 'in-history'`，本机的
     * deepseek 路由就是）在文本变化时**不替换**面里的旧提示节点，而是追加一个新的
     * `system/message`；只有开新请求序列时才改写节点 0 并把后续仍非空的旧节点逐条
     * 清空（app.asar 的 `SystemPromptProjection.project`）。旧的强制段因此仍参与
     * `deriveMessages()`，模型会同时看到两套矛盾指令。文本函数只决定「下一次装配
     * 发什么」，改不了「历史里剩什么」——必须自己记下装配过什么，才知道何时收敛。
     */
    this.hintLive = new Map()
    /** 会话 id → 本请求序列里上一段已装配的提示；`#hintDrifted` 比较并推进它。 */
    this.hintBaseline = new Map()
    /** 任务 id → 已用掉的瞬时故障续跑次数；成功报告或回合正常结束时清零。 */
    this.retryCounts = new Map()
    /**
     * 任务 id → **首次**进入瞬时故障续跑的 ISO 时间（A6 / PRD §10.3）。
     *
     * 为什么必须与 `retryCounts` 共用**同一套**生命周期：两张表回答的是同一个问题的
     * 两半——「这条任务现在还在续跑吗、从什么时候开始的」。凡是「退出续跑」的出口，
     * 都只会发生一次（成功报告的入库、`failTurn()` 的结算、插件卸载的清空），
     * 漏掉任何一处，另一张表就留下一条**再也没人来删**的孤儿键：它不属于任何已结算
     * 的任务，`sweepMemory()` 也不会碰它，插件跑几天就是一条只增不减的内存
     * （PRD §10.8 点名过这个风险）。所以三处清理点全部收进 `#forgetRetry()` /
     * 同一个 `clear()` 里，不允许分头写。
     */
    this.retrySince = new Map()
    /** 待触发的续跑定时器，卸载时统一清掉。 */
    this.retryTimers = new Set()
    /** worker 的 subagent：agent id → 它所属的 worker 会话 id（只用于记账与清理）。 */
    this.subagentOf = new Map()
    /** 任务 id → 「后台活还在跑」的巡检定时器。 */
    this.backgroundTimers = new Map()
    /**
     * 重启恢复出来的「后台活巡检待重挂」任务 id。
     *
     * `restore()` 只读账本，此刻 `pump()` 还没跑、`table` 也还没装完；
     * 直接在这里起定时器，它的收尾可能反过来触发 `settle → pump`。
     * 所以先记账，等 `apply()` 把队列推进完再由 `resumeBackgroundWatches()` 统一重挂。
     */
    this.pendingBackgroundWatchers = []
    /** 本进程累计终止过的后台 job 数（供 selfCheck 回显，不落盘）。 */
    this.backgroundKills = 0
    /** 持久化屏障不可用时只 warn 一次，避免每条报告刷一条日志。 */
    this.durabilityWarned = false
    /**
     * 已退休任务的薄留痕：任务 id → record（P0-5）。
     *
     * 与 `table.tasks` 的区别是「可查但不再参与任何计算」：不进指标、
     * 不占并发位、不出现在 `dispatch_list` 的 total 里，但 `dispatch_inspect`
     * 仍能回答「它什么时候、为什么不见了」。
     */
    this.retired = new Map()
    /** 因 `ledgerMaxRetired` 上限被丢弃的留痕条数（单调递增，供自检）。 */
    // 刻意**不落盘**：它是「本次进程内丢了多少」，落盘后与 retired 的条数
    // 一起读回会让人以为那些丢弃是可追溯的——而它们的定义就是「已经不在了」。
    // 重启归零是诚实的：新进程没有丢弃过任何东西。
    this.retiredDropped = 0
    /**
     * 准入决策计数（P0-2）：`{ direct, ledger }`。
     *
     * 只做可观测，不参与决策。没有它就没法回答「这条报告到底回流了没有」——
     * 而「报告会自己回来」正是本插件的核心承诺。
     */
    this.admissionCounts = { direct: 0, ledger: 0 }
    /**
     * 合并窗口的待发通知（P1-1）：任务 id → `{ task, text, wake, timer, since }`。
     *
     * 为什么按 `task.id` 而不是按会话：合并的前提是「后一条**取代**前一条」。
     * 跨任务合并会把两条不同任务的进度压成一条，用户看到的「哪条在做什么」直接
     * 丢了——那比两条消息更糟。同一任务的多条进度说的才是同一件事。
     *
     * 只装 `mergeableOf()` 判为真的通知；终态、失败、批次汇总根本不进这里
     * （见 `notify()`）。这是 §九「直通类永不参与合并」在数据结构上的落点：
     * 不进队列的东西不可能被延迟。
     */
    this.pendingNotices = new Map()
    /**
     * 合并发生次数与省下的投递数（P1-1 的可观测读数，供自检对账）。
     *
     * `collapsed` 是「被合并掉的条数」而不是「窗口数」：一次窗口里来了 3 条，
     * 只发 1 条，省下 2 条。这个数直接回答「合并到底减了多少消息」。
     */
    this.mergeStats = { windows: 0, collapsed: 0 }
    /**
     * 投递形态计数（P1-2）：`{ full, digest, ledger }`。
     *
     * 与 `admissionCounts` 分开：准入回答「该不该进会话」，投影回答「进了多长」。
     * 两件事混成一个计数之后，「progress 没进会话」与「progress 进了但被压短」
     * 就再也分不出来——而这恰好是 P1-2 想让人看见的差别。
     */
    this.projectionCounts = { full: 0, digest: 0, ledger: 0 }
    /**
     * 复用调用被降级时的说明（任务对象 → note，plans/08 阶段 2 的回滚开关）。
     *
     * 为什么用 WeakMap 而不是在任务上挂一个字段：`launch()` 的返回值同时是
     * 工具层与测试的契约，任务对象会被 `persist()` 原样落盘（`{...task}`）。
     * 把「这次调用为什么没有复用」写进任务，重启后它会变成一条**永远为真**的
     * 历史字段，而它其实只是一次调用的结果；随任务对象一起回收才是它该有的生命周期。
     */
    this.reuseNotices = new WeakMap()
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
      // 求值点就是装配点：记下**这次真正装配进请求的文本**。
      // 不能记「本该发的文本」——装配早于 agent/pre-step，轮到判断时那个值
      // 已被本步自己的装配刷新过，比较恒等，序列就永远不会开。
      const text = this.#hintTextFor(agent)
      this.hintLive.set(agent.id, text)
      return text
    })
    // 装配出去的是新文本，但**历史里那段旧提示不会因此消失**：宿主的 in-history 路由
    // 对变化的提示是「追加一个新 system 节点」，只有在开新请求序列时才改写节点 0
    // 并把后续非空的旧节点逐条清空（app.asar 的 `SystemPromptProjection.project`）。
    // 于是切回「不派发」后，模型会同时看到旧强制段和新轻提示两套互相矛盾的指令。
    // 挂一个 pre-step 钩子：本步装配的文本与本序列上一段不同时，开新序列让它收敛。
    this.sessions.startSeriesWhenStale?.(agent, () => this.#hintDrifted(agent))
  }

  /**
   * 本步装配出去的提示与本序列上一段是否不同（= 旧语义还留在历史里，需要收敛）。
   *
   * 基准 `hintBaseline` 在这里推进：钩子保证每步只问一次，所以「比较 + 推进」
   * 必须原子。第一次见到某个会话时不主动开序列——插件刚加载/会话刚建，
   * 历史里还没有可收敛的旧段，白发一次前缀缓存不值得。
   *
   * @param {object} agent 目标会话
   * @returns {boolean}
   */
  #hintDrifted(agent) {
    const live = this.hintLive.get(agent.id)
    if (live === undefined) return false
    const previous = this.hintBaseline.get(agent.id)
    this.hintBaseline.set(agent.id, live)
    if (previous === undefined) return false
    return live !== previous
  }

  /** 此刻该发给 `agent` 的提示文本（纯求值，无副作用）。 */
  #hintTextFor(agent) {
    const base = this.modeOf(agent.id) === MODE_ALWAYS ? FORCED_HINT : SOFT_HINT
    /**
     * 接续判断段只在 `autoHandoff` 打开时注入（plans/11 §七.2、§八）。
     *
     * 注意这个开关的语义**不是**「让插件自动绑定」：插件里没有任何相似度、
     * 阈值或自动选择，接不接永远由调用方（主会话的模型）判断。它只决定提示里
     * 提不提「派发前先想一次这是不是接着上一条」——关掉它，`dispatch_candidates`
     * 与 `handoff_from` 照常可用。
     *
     * 注入点固定在 `SPEAK_RULE` 之后、`HANDOFF_RULE` 之前（见 `withHandoffJudge`），
     * 两种模式共用同一段文本，顺序由结构保证而不是靠两处各拼一遍。
     */
    const text = this.config.autoHandoff === true ? withHandoffJudge(base) : base
    // 进了路由模式就把「write/edit 已不可用」说出来：模型看不到工具时，
    // 一句提示能让它直接改道派发，而不是反复试错或声称自己没有能力。
    return this.routerLocked(agent) ? `${text}\n\n${ROUTER_LOCKED}` : text
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
   * 会话被销毁时清掉它的派发目标（P0-4）。
   *
   * 为什么不在 `dispose()` 里清：会话销毁与插件卸载是两件事——插件的
   * `dispose` 时所有会话都还在（宿主自己管生命周期），清空 targets 等于把
   * 用户的输入框选择全部丢掉。只有 `agent/disposed` 才是「这个会话再也不会
   * 派发」的确定时刻，那才是唯一该删它的点。
   *
   * **只删 targets，不删任务**：任务记录属于账本（P0-5 用退休管），
   * 会话没了不代表它派出过的任务不需要查了。
   *
   * @returns {boolean} 是否真的删了条目（供调用方判断要不要落盘）
   */
  forgetTargets(sessionId) {
    if (!sessionId) return false
    if (!this.config.clearTargetsOnDispose) return false
    if (!this.targets.delete(sessionId)) return false
    // 删了顺手落盘：这个时刻之后不会再有任何东西触发 schedulePersist，
    // 而孤儿目标一旦留在 tasks.json 里，重启后会重新变回「有效设置」。
    this.schedulePersist()
    this.log('%s 会话 %s 已销毁，清掉它的派发目标', LOG_PREFIX, sessionId)
    return true
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
   * 为什么需要：10 个工具注册在全局层，所以 worker 的 subagent 也能看到 `dispatch_launch`，
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
   * 校验并归一 `depends_on`（PRD-02 §4.1 / §5）。
   *
   * 顺序是刻意的，每一步对应一个明确的错误码：
   *
   * 1. **形状**：必须是数组、元素必须是字符串（`null` / `undefined` 当没传）；
   * 2. **去空 + 去重**：保留首次出现的顺序——`depends_on` 的声明顺序就是看板与
   *    `dispatch_inspect` 里的展示顺序，重排会让「A、B」变成「B、A」；
   * 3. **数量上限** `maxDependsOn`：超过直接报错，**不静默截断**。少一条依赖
   *    等于让后继在错误的时机开跑，而那种错在账本里看起来完全正常（状态、报告
   *    都对，只是顺序错了），事后极难发现；
   * 4. **存在性**：必须在活表或退休留痕里，否则 `UNKNOWN_DEPENDENCY`；
   * 5. **自引用**：不能包含自己的 id；
   * 6. **环**：从每个前置沿 `dependsOn` 做 DFS，有环报 `DEPENDENCY_CYCLE`。
   *    正常路径构造不出环（只能指向已存在的任务；批内只能指向前面的下标），
   *    这一步是防御**账本被手工改过**——有环的链会永远等下去，不会报错也不会结束。
   *
   * 调用点必须在 `table.add` 之前：任一步抛错都不能留下半条任务（PRD-02 §6）。
   *
   * @param {object} agent 调用者。**目前不参与判定**：跨批依赖允许引用其它会话的
   *   任务（PRD-02 §10 决策 2），所以这里不做归属校验；保留这个参数是为了与 PRD
   *   的签名一致，也让以后「按会话收紧可依赖范围」有一个明确的落点。
   * @param {object} input `launch()` 的输入（读取 `dependsOn`）
   * @param {string} taskId 这条任务自己的 id（自引用检查用）
   * @returns {string[]} 归一后的前置 id（去重、去空、保持声明顺序）
   */
  #resolveDependencies(agent, input, taskId) {
    const raw = input?.dependsOn
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) throw fail('BAD_ARGS', 'depends_on 必须是任务 id 数组')
    const seen = new Set()
    const ids = []
    for (const item of raw) {
      if (item === undefined || item === null) continue
      if (typeof item !== 'string') {
        throw fail('BAD_ARGS', `depends_on 里只能放任务 id 字符串，收到的是「${String(item)}」`)
      }
      const id = item.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    if (!ids.length) return ids
    const max = Math.max(0, Math.floor(Number(this.config.maxDependsOn) || 0))
    if (ids.length > max) {
      throw fail('BAD_ARGS', `一个任务最多声明 ${max} 个前置（收到 ${ids.length} 个）。`
        + '依赖少一条会让后继在错误的时机开跑，所以这里直接报错，不静默截断')
    }
    for (const id of ids) {
      if (id === taskId) {
        throw fail('BAD_ARGS', `depends_on 不能包含任务自己（${taskId}）`)
      }
      if (!this.resolveTask(id)) {
        throw fail('UNKNOWN_DEPENDENCY', `没有任务 ${id}：depends_on 只能引用活任务或退休留痕`
          + '（先用 dispatch_list 查现有任务；本批内的前后关系用 depends_on_index）')
      }
    }
    this.#assertNoDependencyCycle(ids)
    return ids
  }

  /**
   * 沿 `dependsOn` 边做 DFS，检测已存在于账本里的依赖环（PRD-02 §6）。
   *
   * 为什么必须查「整条链」而不是只看直接前置：`launch` 只新增**出边**，所以新任务
   * 自己不可能成环；可能成环的是账本里已经存在的 A → B → A（手工改过 tasks.json、
   * 或将来某条重开路径写坏了）。这种环不会报错，只会让链上的任务永远 `queued`，
   * 占着 `maxTasksPerSession` 的名额却不占 worker 位——从看板上看就是「排队中」，没人能解释。
   *
   * @param {string[]} ids 待检查的入口节点（新的前置）
   */
  #assertNoDependencyCycle(ids) {
    /** 当前 DFS 栈上的节点：再次遇到就是环。 */
    const visiting = new Set()
    /** 已经完全展开过的节点：同一条边不必重复走。 */
    const finished = new Set()
    const walk = (id, path) => {
      if (finished.has(id)) return
      if (visiting.has(id)) {
        throw fail('DEPENDENCY_CYCLE', `依赖成环：${[...path, id].join(' → ')}。`
          + '环上的任务都在等对方，永远不会开始')
      }
      visiting.add(id)
      const task = this.table.get(id)
      for (const next of Array.isArray(task?.dependsOn) ? task.dependsOn : []) {
        walk(next, [...path, id])
      }
      visiting.delete(id)
      finished.add(id)
    }
    for (const id of ids) walk(id, [])
  }

  /**
   * 派发一个任务：登记 → 排队 → 由 pump 按并发位启动。
   * 立即返回，不等子会话干活。
   *
   * **续派（plans/08 阶段 1 · 模型 A）**：传了 `input.continueTaskId` 时不再新建任务，
   * 而是把这条要求转发成对**已有任务**的 `dispatch_message`（见 `continueLaunch()`）。
   * 不传时本函数的行为与 0.8.x **逐字相同**——这是回滚保证：只要有任何一个调用方
   * 没带这个参数，它就走的是完全没有改过的那条路径。
   *
   * **复用会话（plans/08 阶段 2 · 模型 B）**：传了 `input.handoffFrom` 时照常新建
   * 一条任务记录，但把 `workerSessionId` / `threadId` 指向来源任务的子会话
   * （见 `#launchReused()`）。它与 `continue_task_id` 是两件事：前者有独立记录，
   * 后者没有。`allowSessionReuse: false` 时这一支降级为普通新派，并在返回值里
   * 留一条 note（`reuseNotice()`），绝不静默忽略参数。
   *
   * @param {object} agent 调用者（主会话）
   * @param {{title: string, brief: string, cwd?: string, workspace?: string, createWorkspace?: boolean, model?: string, agentPreset?: string, permissionPreset?: string, group?: string, continueTaskId?: string, handoffFrom?: string, handoffReason?: string, noReuse?: boolean, dependsOn?: string[]}} input
   */
  async launch(agent, input) {
    // 续派要在**任何**登记动作之前分流：走过去就会被建出一条新任务，
    // 而模型 A 的全部意义就是「不新建任务」。
    if (input.continueTaskId !== undefined && input.continueTaskId !== null && input.continueTaskId !== '') {
      return this.continueLaunch(agent, input)
    }
    const handoffId = typeof input.handoffFrom === 'string' ? input.handoffFrom.trim() : ''
    /**
     * 优先级链（补充口径）：**`no_reuse: true` > `handoff_from` > 都不传**。
     *
     * `no_reuse` 是逃生门：调用方（大模型）明确判断「这次不该接上一轮」时，
     * 即使同一条调用里还带着 `handoff_from` 也必须新开。它**不是错误组合**——
     * 用参数冲突把逃生门挡住，只会让调用方卡在「想走却走不了」。
     *
     * `allowSessionReuse: false` 是部署级的回滚开关，排在 `no_reuse` 之后：
     * 两者都关时，返回值解释「因为 no_reuse」更容易让人理解当场发生了什么。
     */
    const forcedFresh = input.noReuse === true
    const reuseSession = !forcedFresh && handoffId !== '' && this.config.allowSessionReuse !== false
    const degradedNote = handoffId !== '' && !reuseSession
      ? (forcedFresh
          ? 'no_reuse=true：已按 no_reuse 强制新开会话，忽略 handoff_from。'
            + `任务 ${handoffId} 的子会话没有被使用，本次是一条独立的普通新任务。`
          : `配置 allowSessionReuse=false：本次已降级为普通新派，没有沿用任务 ${handoffId} 的子会话。`
            + '要恢复复用请打开该配置；要显式另起会话请去掉 handoff_from。')
      : undefined
    const used = this.quotaUsed(agent.id)
    if (used >= this.config.maxTasksPerSession) {
      throw new Error(`本会话还有 ${used} 个未收尾的任务，达到上限 ${this.config.maxTasksPerSession}；`
        + '请先取消或等待它们结束（归档与超过 24 小时的已结算任务不计入）')
    }
    /**
     * 任务 id 提前生成（PRD-02 §4.1）：依赖校验必须发生在 `table.add` **之前**，
     * 而「自引用」只能拿这条任务自己的 id 去比。id 只是 `newTaskId()` 的进程内计数，
     * 提前取不会改变任何可观察行为——工作区解析失败时它被丢弃，账本里什么都没有。
     */
    const id = newTaskId()
    // 未知 id / 自引用 / 超过 `maxDependsOn` / 成环都在这里收口：全部抛错且不登记任务
    // （PRD-02 §6「校验在 table.add 之前」）。
    const dependsOn = this.#resolveDependencies(agent, input, id)
    if (reuseSession) return this.#launchReused(agent, input, handoffId, id, dependsOn)

    /**
     * 显式参数与「记住的设置」谁优先——本函数最容易改错的一处，规则写死在这里：
     *
     * | 调用方给了什么                      | 结果                                                   |
     * |-------------------------------------|--------------------------------------------------------|
     * | 只给 cwd（会话有 auto / 记住的目标） | **cwd 胜**：auto 与记住的目标这一轮当没设过             |
     * | 只给 cwd（会话没有目标）             | 用 cwd（与旧版一致）                                    |
     * | 只给 workspace                       | 用 workspace（与旧版一致）                              |
     * | workspace 与 cwd 同时给              | **workspace 胜**（已发布语义，不改）；cwd 仍不当垃圾扔掉 |
     *
     * 判断依据只有一条：**显式参数优先级高于记住的设置**。记住的 auto / 目标只是
     * 「调用方没指定时的默认」，它没有资格压掉调用方当场给出的参数。
     *
     * 为什么要把这张表写成注释：2026-11-08 12:10 实测过一次「显式 cwd 被静默丢弃」——
     * 主会话目标是 auto，`dispatch_launch({ cwd: 'D:\idea\dsh-mini-superagent' })` 派出的
     * 两个子会话分别落到了 `…\Documents\mini-superagent\派发\2026-11-07` 与
     * `…\Documents\mini-superagent`，用户给的 cwd 从头到尾没生效，`src/` 一个字节没变，
     * 现场看起来像「根本没派发」。根因就是旧代码 `target?.path ?? cwdFor(agent, cwd)`：
     * 只要存在任何 target（包括 auto），显式 cwd 一次都没被读到，而且**没有任何提示**。
     *
     * 教训：静默丢弃调用方输入比报错贵得多。报错只让人重试一次；静默丢弃让人在
     * 完全错误的方向上排半天，最后还得怀疑工具坏了。所以现在要么让参数生效，
     * 要么把「它去哪了」如实写进返回值。
     */
    /** 调用方显式给的工作目录；空白串按「没给」处理（与旧版一致）。 */
    const cwdInput = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined
    // 只传 cwd 时，会话记住的 auto / 目标一律不参与（见上表第一行）。
    const sticky = cwdInput && !input.workspace ? undefined : this.targetFor(agent.id)
    // 目标是 auto 时不锁定具体工作区：等任务标题/简报就位后再挑（见下面的 autoTarget）。
    const autoTarget = !input.workspace && sticky?.auto === true
    const ref = input.workspace ?? (autoTarget ? undefined : sticky?.workspace_id)
    let target
    if (ref) {
      // 只有显式指定时才允许按需新建；来自选择器的目标失效则忽略，避免凭空建目录。
      const create = !!input.workspace && input.createWorkspace !== false
      let result
      try {
        result = await this.workspaces.resolveOrCreate(ref, { create })
      } catch (error) {
        /**
         * 新建这条路**抛错**了（mkdir 失败、注册表 create 拒绝、盘满、权限不足……）。
         *
         * 这个分支以前根本不存在：`resolveOrCreate` 里 `ensure()` 抛的错会直接冒泡，
         * 调用方只看到一句「磁盘满了」——完全不知道这是「工作区没解析到、于是去新建、
         * 新建又失败了」这条链。而它恰恰是 `reason` 三条文案里最难凑的那种：
         * 既不是「找不到」（可以新建），也不是「新建被关闭」，是「试着建了但没建成」。
         *
         * 只有**显式** workspace 才改写成可读文案：来自选择器的目标失效仍按旧规矩
         * 忽略并退回调用者目录（那种情况下用户没提要求，报错只会打断他）。
         */
        if (!input.workspace) throw error
        throw new Error(`${this.#workspaceError(input.workspace, result?.reason ?? 'not-found', create)}`
          + `（新建时出错：${String(error?.message ?? error)}）`)
      }
      target = result.workspace
      if (!target) {
        if (input.workspace) {
          // 失败原因必须分开说（P1 修复 1）：旧代码不看 `reason`，一律写成
          // 「且允许新建被关闭」。歧义时那句话是**假的**——调用方根本没传
          // create_workspace，默认就是 true，没有任何人关掉新建。
          throw new Error(this.#workspaceError(input.workspace, result.reason, create))
        }
        this.warn(`${LOG_PREFIX} 会话 %s 的派发目标工作区已不存在，按调用者目录派发`, agent.id)
      } else if (result.created) {
        this.log(`${LOG_PREFIX} 已新建工作区 %s（%s）`, target.title, target.path)
      }
    }

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

    /**
     * 工作目录优先级：显式 cwd → 目标工作区路径 → 会话继承的目录。
     *
     * `workspace` 胜 `cwd` 是已发布的语义（别改），但**不能因此把 cwd 扔掉**。
     * 两者同时给时的落法见上面那张表：会话住在 workspace 里（侧边栏归到那个工作区），
     * 活干在 cwd 里 —— `start()` 里的 `enterDirectory(agent, task.cwd)` 负责切换。
     * 所以这里 `task.cwd` 必须保留 cwd，否则 `task.cwd === placement.path`，
     * enterDirectory 直接短路，cwd 又变成一句空话（这正是旧版的三元短路：
     * 只要 target 存在，`input.cwd` 连被读一次的机会都没有）。
     *
     * 顺序反过来写（cwd 在前）不会影响「只给 workspace」的路径：那时 cwdInput 是空的。
     */
    const resolvedCwd = cwdInput ?? target?.path ?? this.sessions.cwdFor(agent, undefined)

    const task = {
      id,
      title,
      brief,
      parentSessionId: agent.id,
      workerSessionId: `${WORKER_PREFIX}${id}`,
      /**
       * 线程标识（plans/08 阶段 0）：今天一任务 = 一线程，所以由任务 id 派生。
       *
       * 不做成「复用会话时才有的可选字段」：那样每条读取路径都要判空，而判空的
       * 分支永远没人测。恒定有值、恒定 1:1，阶段 2 只需要改**赋值那一处**
       * （同线程的第二个任务复制第一个的 threadId），读取方（归档、统计、看板）
       * 一行都不用动。
       */
      threadId: newThreadId(id),
      status: 'queued',
      attempt: 1,
      createdAt: now(),
      updatedAt: now(),
      turnStartedAt: undefined,
      lastReportAt: undefined,
      lastText: '',
      reports: [],
      cwd: resolvedCwd,
      workspaceId: target?.id,
      workspaceTitle: target?.title,
      ...(autoTarget ? { workspaceAuto: true } : {}),
      ...(cwdInput ? { cwdExplicit: cwdInput } : {}),
      ...(input.group ? { group: input.group } : {}),
      /**
       * 前置依赖（PRD-02 §4.2）：**按声明顺序**保留；去重、去空、查存在性、查环
       * 都在 `#resolveDependencies()` 里做完了，这里只负责落账。
       *
       * 没有依赖时整个键都不写：旧账本、旧调用方的任务形状因此与今天逐字相同，
       * `#annotateDependencies()` 读到 undefined 也不会凭空补一个空数组。
       */
      ...(dependsOn.length ? { dependsOn } : {}),
      model: input.model,
      agentPreset: input.agentPreset,
      permissionPreset: input.permissionPreset,
    }
    this.table.add(task)
    // 回滚开关的留痕：只挂在这条任务对象上（WeakMap），不落盘、不进卡片的公开形状。
    if (degradedNote) this.reuseNotices.set(task, degradedNote)
    // 第一次从某个会话派发 → 这个会话就是「主会话」，进路由模式（改代码只能派下去）。
    // 放在 refreshHint 之前：提示文本的求值函数会读 routers，先锁再刷能把新文本带上。
    this.enforceRouter(agent)
    this.refreshHint(agent)
    // 任务登记必须先落盘再 pump：否则进程在「pump 已经建了会话、账本还没写」
    // 之间被 kill，会留下一个没有任务记录的孤儿 worker。
    await this.persistCritical()
    void this.pump()
    return task
  }

  /**
   * 读取一次派发被降级的原因（`allowSessionReuse: false` 时）。
   *
   * 只给工具层用：任务落盘时**不**带它（WeakMap），所以重启后不会出现
   * 「一条历史任务永远带着一句『本次已降级』」的假事实。
   *
   * @param {object} task
   * @returns {string|undefined}
   */
  reuseNotice(task) {
    return task ? this.reuseNotices.get(task) : undefined
  }

  /**
   * 复用会话前的**四条硬校验**（plans/08 §四）。
   *
   * 顺序刻意是「便宜的判据在前」：先查 id 是否存在（调用方最可能打错），再查
   * 退休/归档（它已经不是可用的历史），再查归属（它不是你的），再查它是否结算
   * （一个会话同一时刻只能跑一个回合），最后才查形状、模型与工作区。
   * 这样报错永远指向真正的病因，而不是笼统的「不能复用」。
   *
   * 为什么必须要求来源任务**已结算**：复用是把一条新要求投进**同一个会话**。
   * 来源任务还在 running/queued 时，那条会话正被一个回合占着；再投一条只会
   * 让两个任务共用同一段上下文，报告归属与取消都会立刻串账（§三.1、§三.3）。
   *
   * 为什么模型/preset 必须一致而不是「新任务覆盖」：模型与权限在会话创建时
   * 定死（§三.4），复用沿用旧会话就是沿用旧模型。允许「填一个新模型」会让
   * 工具 schema 承诺一件做不到的事——静默用旧模型比直接拒绝更贵。
   *
   * @param {object} agent 调用者（主会话）
   * @param {object} input `launch()` 的输入
   * @param {string} taskId 来源任务 id
   * @returns {Promise<object>} 通过校验的来源任务
   */
  async #handoffSource(agent, input, taskId) {
    const parent = this.resolveTask(taskId)
    if (!parent) {
      throw new Error(`没有任务 ${taskId}：无法沿用它的子会话。`
        + '先用 dispatch_list 查现有任务，或去掉 handoff_from 新派一个任务')
    }
    if (this.isRetired(parent)) {
      throw new Error(`任务 ${taskId} 已退休（记录已移出活表，原因：${parent.retiredReason}）：`
        + '它的会话已经没有可核对的上下文，不能复用。请新派一个任务')
    }
    if (parent.archivedAt) {
      throw new Error(`任务 ${taskId} 已归档（${parent.archivedAt}）：归档是只读冻结，不能拿它的会话接着干。`
        + '请新派一个任务')
    }
    if (parent.parentSessionId !== agent.id) {
      throw new Error(`任务 ${taskId} 不属于本会话（它是 ${parent.parentSessionId} 派出的）：不能复用别人的子会话`)
    }
    if (!SETTLED.has(parent.status)) {
      throw new Error(`任务 ${taskId} 还在 ${parent.status}，不能复用它的子会话：`
        + '一个子会话同一时刻只能跑一个回合。请等它结算后再用 handoff_from，或去掉参数新派一个任务')
    }
    if (!isWorkerSessionId(parent.workerSessionId)) {
      throw new Error(`任务 ${taskId} 的子会话 id「${parent.workerSessionId ?? '(空)'}」不是本插件建的`
        + `（应以「${WORKER_PREFIX}」开头）：不能复用`)
    }

    const changed = (label, given, actual) => {
      const value = given === undefined || given === null ? '' : String(given).trim()
      if (!value) return ''
      const current = actual === undefined || actual === null ? '' : String(actual).trim()
      return value === current ? '' : `${label}（来源任务用的是「${current || '(部署默认)'}」，这次给的是「${value}」）`
    }
    const optionDiff = [
      changed('model', input.model, parent.model),
      changed('agent_preset', input.agentPreset, parent.agentPreset),
      changed('permission_preset', input.permissionPreset, parent.permissionPreset),
    ].filter(Boolean)
    if (optionDiff.length) {
      throw new Error(`复用不能换模型或 preset：${optionDiff.join('；')}。`
        + '这些参数在会话创建时已经定死，复用沿用原来的模型。要换请去掉 handoff_from 新开一个任务')
    }

    // 工作区 / cwd：复用是「在**同一条会话、同一个目录**里接着干」，跨目录会让任务 A
    // 的代码被任务 B 改掉（§三.5）。这里复用 `sameDir()`（Windows 大小写/分隔符不敏感）。
    if (!parent.cwd) {
      throw new Error(`任务 ${taskId} 没有记录工作目录，无法确认这次复用是否会跨目录。`
        + '请去掉 handoff_from 新派一个任务，并显式给 cwd')
    }
    const cwdInput = typeof input.cwd === 'string' ? input.cwd.trim() : ''
    if (cwdInput && !sameDir(cwdInput, parent.cwd)) {
      throw new Error(`复用的工作目录与任务 ${taskId} 不一致：这次给的是「${cwdInput}」，`
        + `该任务的工作目录是「${parent.cwd}」。复用沿用来源任务的子会话与目录——`
        + '要在别的目录干活，请去掉 handoff_from 新派一个任务')
    }
    const workspaceRef = typeof input.workspace === 'string' ? input.workspace.trim() : ''
    if (workspaceRef) {
      const asked = await this.workspaces.resolve(workspaceRef)
      if (!asked) {
        throw new Error(`复用指定的工作区「${workspaceRef}」解析不到。复用沿用来源任务的工作区`
          + `（${parent.workspaceTitle ?? parent.workspaceId ?? parent.cwd}）`)
      }
      if (parent.workspaceId) {
        if (asked.id !== parent.workspaceId) {
          throw new Error(`复用的工作区与任务 ${taskId} 不一致：这次是「${asked.title}」，`
            + `该任务在「${parent.workspaceTitle ?? parent.workspaceId}」。复用沿用来源任务的工作区——`
            + '要在别的工作区干活，请去掉 handoff_from 新派一个任务')
        }
      } else if (!sameDir(asked.path, parent.cwd)) {
        throw new Error(`复用的工作区与任务 ${taskId} 不一致：这次是「${asked.title}」（${asked.path}），`
          + `该任务在「${parent.cwd}」。复用不能跨工作区`)
      }
    }
    return parent
  }

  /**
   * 新建一条**复用来源任务子会话**的任务（plans/08 阶段 2 · 模型 B）。
   *
   * 与普通新派唯一的结构差别是三个字段：`workerSessionId` 指向来源、`threadId`
   * 复制来源（同一条线程）、`parentTaskId` 记下来源。其余（标题、简报、报告链、
   * 看板行、状态）全部独立——这正是模型 B 相对模型 A 的全部价值。
   *
   * 为什么 `cwd` / `workspaceId` 直接抄来源而不是重新解析：会话的目录已经在
   * `createWorker` 时定死，重新解析只能得到「这次想要哪个目录」，改不了会话事实。
   * 抄来源既不会凭空建出日期工作区，也不会让任务的元数据与会话实际所在位置分家。
   *
   * @param {object} agent 调用者（主会话）
   * @param {object} input `launch()` 的输入
   * @param {string} taskId 来源任务 id
   * @param {string} id 这条新任务的 id（由 `launch()` 提前生成，依赖校验已经用过它）
   * @param {string[]} dependsOn 已校验的前置 id 数组
   */
  async #launchReused(agent, input, taskId, id, dependsOn = []) {
    const parent = await this.#handoffSource(agent, input, taskId)
    const title = oneLine(input.title, 120) || '未命名任务'
    const brief = String(input.brief ?? '')
    const threadId = typeof parent.threadId === 'string' && parent.threadId
      ? parent.threadId
      : newThreadId(parent.id)
    /**
     * 交接原因（补充口径）：调用方（大模型）对自己判断的一句话解释。
     *
     * **只用于审计与事后解释**：插件不拿它做任何相似度、权重或阈值判断，
     * 连续性由模型自己判断。超长按 `HANDOFF_REASON_MAX_CHARS` 截断，并在任务上
     * 留 `handoffReasonTruncated`（原始长度），与 `briefTruncated` 同一套做法。
     */
    const reason = typeof input.handoffReason === 'string' ? input.handoffReason.trim() : ''
    const storedReason = reason ? clip(reason, HANDOFF_REASON_MAX_CHARS) : ''
    const task = {
      id,
      title,
      brief,
      parentSessionId: agent.id,
      // 复用：会话与线程都指向来源任务；这是与普通新派**唯一**的结构差异。
      workerSessionId: parent.workerSessionId,
      threadId,
      parentTaskId: parent.id,
      // 审计字段：`agent` = 调用方给了理由（模型判断的痕迹）；`explicit` = 只给了
      // handoff_from。两者都是显式复用，没有任何自动推断。
      handoffSource: reason ? HANDOFF_SOURCE.AGENT : HANDOFF_SOURCE.EXPLICIT,
      ...(storedReason ? { handoffReason: storedReason } : {}),
      ...(reason.length > HANDOFF_REASON_MAX_CHARS ? { handoffReasonTruncated: reason.length } : {}),
      status: 'queued',
      attempt: 1,
      createdAt: now(),
      updatedAt: now(),
      turnStartedAt: undefined,
      lastReportAt: undefined,
      lastText: '',
      reports: [],
      cwd: parent.cwd,
      workspaceId: parent.workspaceId,
      workspaceTitle: parent.workspaceTitle,
      // 会话实际挂在哪个工作区也一起复制：`start()` 的复用分支不会重新 placement，
      // 不复制的话看板会把这条显示成「没有归属」。
      hostWorkspaceId: parent.hostWorkspaceId,
      hostWorkspaceTitle: parent.hostWorkspaceTitle,
      // 模型/preset 在会话创建时定死，复用沿用原值（`#handoffSource` 已挡住「换模型」）。
      model: parent.model,
      agentPreset: parent.agentPreset,
      permissionPreset: parent.permissionPreset,
      // 复用任务同样可以声明前置（PRD-02 §4.1）：语义与普通新派完全一致，
      // 「等上一批的 A 做完，再用已结算任务的会话接着干」是合法组合。
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(input.group ? { group: input.group } : {}),
    }
    this.table.add(task)
    this.enforceRouter(agent)
    this.refreshHint(agent)
    // 与普通派发同一条因果：任务登记必须先落盘再 pump，避免「会话已经在跑、账本没写」。
    await this.persistCritical()
    void this.pump()
    return task
  }

  /**
   * 续派（plans/08 阶段 1 · **模型 A**）：把一条新要求追加给**已有任务**的子会话。
   *
   * 语义就是「对目标任务的 `dispatch_message`」：不新建任务、不新建会话、不换模型，
   * 只把一条文本投进那条会话的收件箱，然后任务重新回到 `running`。转发路径刻意
   * 复用 `message()` 而不是自己投递——投递顺序（先投递、成功后才跃迁状态）、
   * 「已取消的任务不能复活」、「回收站标记、后台巡检作废」这些不变式都在那里，
   * 另写一条会立刻分叉（这正是 `docs/tools.md` 说「对已结算任务发消息等价于续跑」的同一段代码）。
   *
   * **四条硬校验（plans/08 §四，缺一即拒绝并说明原因）**——顺序是刻意的：
   * 先查「有没有这条任务」（调用方最可能的错就是 id 打错），再查归属，再查会话形状，
   * 再查工作区，最后才判「有没有别的活跃任务」。把便宜的判据放前面，报错就指向真正的病因。
   *
   * 为什么第 4 条要用「整张表」而不是 `workerState()`：`workerState(sessionId)` 只看
   * **这一条会话**上的任务，而这一条要判的是「**别的**任务正在占着并发位/正在跑」。
   * 两条判据不同源：同会话多任务在模型 A 下不存在（一任务一会话），所以按会话判
   * 会永远返回 `settled`，形同没判。缺的就是「整表活跃任务」这一层，见 §四.4 的注。
   *
   * @param {object} agent 调用者（主会话）
   * @param {{title?: string, brief?: string, cwd?: string, workspace?: string, createWorkspace?: boolean, model?: string, agentPreset?: string, permissionPreset?: string, group?: string, continueTaskId: string}} input
   * @returns {Promise<object>} 目标任务本身（**不是**新任务）
   */
  async continueLaunch(agent, input) {
    const taskId = String(input.continueTaskId ?? '').trim()
    if (!taskId) throw new Error('continue_task_id 需要一个任务 id；不知道 id 时先用 dispatch_list 查')

    // ① 目标任务存在。用 resolveTask() 而不是 table.get()：退休任务要能被**明确拒绝**
    //    （「它已经不在了」），而不是笼统地说「没有任务」——后者会让人以为 id 打错了。
    const task = this.resolveTask(taskId)
    if (!task) {
      throw new Error(`没有任务 ${taskId}：无法续派。先用 dispatch_list 查现有任务，`
        + '或去掉 continue_task_id 新派一个任务')
    }
    // ① 退休 / 归档 / 归属 / 会话形状：四条共用一条校验（见 `#assertContinuable`）。
    //    看板入口也走同一条，所以两个入口的准入口径不会再分叉。
    this.#assertContinuable(task, agent.id)

    // ② 工作区 / cwd 一致。`continue_task_id` **没有自己的 workspace 参数**，
    //    所以这里判的是「调用方这次给的东西与目标任务是否冲突」：
    //    给了 cwd 就必须是同一个目录，给了 workspace 就必须解析到同一个工作区。
    //    不做 realpath 比较（见 `sameDir` 的注释）。
    if (typeof input.cwd === 'string' && input.cwd.trim() && !sameDir(input.cwd, task.cwd)) {
      throw new Error(`续派的工作目录与任务 ${taskId} 不一致：这次给的是「${input.cwd.trim()}」，`
        + `该任务的工作目录是「${task.cwd ?? '(未设置)'}」。续派沿用目标任务的工作区——`
        + '要在别的目录干活，请去掉 continue_task_id 新派一个任务')
    }
    if (typeof input.workspace === 'string' && input.workspace.trim()) {
      const asked = await this.workspaces.resolve(input.workspace)
      if (!asked) {
        throw new Error(`续派指定的工作区「${input.workspace}」解析不到。续派沿用目标任务的工作区，`
          + `该任务是「${task.workspaceTitle ?? '(未指定，跟随会话目录)'}」`)
      }
      if (task.workspaceId && asked.id !== task.workspaceId) {
        throw new Error(`续派的工作区与任务 ${taskId} 不一致：这次是「${asked.title}」，`
          + `该任务在「${task.workspaceTitle ?? task.workspaceId}」。续派沿用目标任务的工作区——`
          + '要在别的工作区干活，请去掉 continue_task_id 新派一个任务')
      }
    }

    // ③ 当前没有别的活跃任务。判据是**整张表**里除目标之外还有没有 queued/running：
    //    模型 A 不新建任务，所以续派本身不占新并发位；但「一边续派一边还有活没跑完」
    //    会让主会话误以为这条是排队的，而它其实是插进一条正在跑的会话里的第二条要求。
    const busy = [...this.table.tasks.values()]
      .filter(other => other !== task && (other.status === 'running' || other.status === 'queued'))
    if (busy.length) {
      const listed = busy.slice(0, 5).map(other => `${other.id}（${other.status}）`).join('、')
      throw new Error(`现在还有 ${busy.length} 个活跃任务，不能续派：${listed}`
        + (busy.length > 5 ? ' 等' : '')
        + '。等它们结算后再续派，或先 dispatch_cancel 掉不需要的那些')
    }

    /**
     * 读回执与「上一轮的结论」要不要在这里补：**都不补**。
     *
     * - 读回执（`inputPendingAt` / `inputReadAt`）由 `message()` 自己维护，
     *   在这里再写一遍会和它抢同一个字段。
     * - 上一轮结论**不抄进消息**：那是模型 A 的一个已声明的代价（「这次要求与上次要求
     *   混在同一任务里」），worker 自己的会话历史里就有上一轮的完整输出；主会话再抄一段
     *   摘要进去，等于让同一份事实在会话里出现两遍，而两遍一旦不一致就无法判断谁是对的。
     *   要交接摘要的是模型 B（阶段 2），那里才有独立的「新任务」需要它。
     *
     * 唯一补的是**调用方这次写的要求**：`title`/`brief` 是 `dispatch_launch` 的必填参数，
     * 续派时它们承载的就是「这次要做什么」。两个都给时都带上——title 作为一行小标题，
     * brief 作为正文；只给其中一个就用那一个，两个都空直接报错（否则 worker 收到一条
     * 只有前缀、没有任何要求的消息）。
     */
    const title = oneLine(input.title, 120)
    const brief = String(input.brief ?? '').trim()
    if (!title && !brief) {
      throw new Error('continue_task_id 需要 title 或 brief 说明这次要做什么；'
        + '否则 worker 只会收到一条没有要求的续派消息')
    }
    const body = [title ? `这次的要求：${title}` : '', brief].filter(Boolean).join('\n\n')

    // 转发：这就是模型 A 的全部实现——一条 message。
    // 投递本身走 `continueTask()`，看板入口也走它，所以「续派」这件事只有一份实现。
    await this.continueTask(task, body)
    return task
  }

  /**
   * 续派前的**共同前置校验**（工具入口与看板入口共用一条）。
   *
   * 为什么必须共用：续派有两个入口——`dispatch_launch({continue_task_id})`
   * 与看板上的「续派」按钮。0.8.x 之前看板那条直接调 `dispatch.message()`，
   * 于是绕开了这里的每一条校验：可以对**别人的**任务续派、可以对**已归档**的
   * 任务续派、可以往一个不是本插件建的会话里塞要求。工具入口拒绝、看板入口放行，
   * 这不是「两条路径的细节差异」，是同一个动作有两套准入。
   *
   * 四条判据的顺序也是刻意的：先说「它已经不在了」（退休 / 归档），再说
   * 「它不是你的」（归属），最后说「那个会话不能塞」（形状）。
   * 读错误的人按这个顺序就知道该做什么。
   *
   * @param {object} task 目标任务
   * @param {string|null} agentId 调用方主会话 id；看板入口没有调用方，传 null（跳过归属校验）
   */
  #assertContinuable(task, agentId) {
    const id = task?.id ?? '(未知)'
    // ① 退休留痕：记录已移出活表，正文与报告都不在了，续派没有上下文可用。
    if (this.isRetired(task)) {
      throw new Error(`任务 ${id} 已退休（记录已移出活表，原因：${task.retiredReason}）：`
        + '它的正文与报告都不在了，续派没有上下文可用。请新派一个任务')
    }
    // ② 归档 = 只读冻结。归档的任务统计里已排除它，让它复活会造出
    //    「归档与在跑并存」：历史被算成当下，而它其实正在改同一个工作目录。
    if (task?.archivedAt) {
      throw new Error(`任务 ${id} 已归档（${task.archivedAt}）：归档是只读冻结，不能再往里续派。`
        + '请新派一个任务')
    }
    // ③ 归属：续派是把要求投进**别人的** worker 会话，跨会话必须拒绝。
    if (agentId && task?.parentSessionId !== agentId) {
      throw new Error(`任务 ${id} 不属于本会话（它是 ${task.parentSessionId} 派出的）：不能续派别人的任务`)
    }
    // ④ worker 会话存在且是本插件建的（`dispatch-*` 形状）。形状判据挡的是
    //    「手填一个真实会话 id」——那条会话不是我们派的，往里塞要求等于盗用它的上下文。
    if (!isWorkerSessionId(task?.workerSessionId)) {
      throw new Error(`任务 ${id} 的子会话 id「${task?.workerSessionId ?? '(空)'}」不是本插件建的`
        + `（应以「${WORKER_PREFIX}」开头）：不能往里续派`)
    }
  }

  /**
   * 续派：把一句话投进任务的子会话，让它接着干。
   *
   * 这是**唯一**的续派投递口（工具入口与看板入口都走它），这样两个入口的
   * 准入、话术与副作用就只有一份实现。
   *
   * @param {object} task 目标任务（已结算）
   * @param {string} text 用户写的这次要求
   * @param {{ agentId?: string|null }} [options] 调用方主会话 id（看板入口没有）
   */
  async continueTask(task, text, options = {}) {
    const body = String(text ?? '').trim()
    if (!body) throw new Error('续派需要一句话内容；否则 worker 只会收到一条没有要求的续派消息')
    this.#assertContinuable(task, options.agentId ?? null)
    await this.message(task, `${CONTINUE_LEAD}\n\n${body}`, 'queue')
    this.log(`${LOG_PREFIX} 任务 %s 续派：要求已投递给子会话 %s`, task.id, task.workerSessionId)
    return task
  }

  /**
   * 显式 `workspace` 解析不到时，给调用方一句**与事实相符**的错误。
   *
   * 三种失败原因必须分开说（这是 P1 修复 1，2026-11-08 12:10 的事故就是它们的代价）：
   *
   * 1. `ambiguous`：注册表里有多个同名/同前缀的工作区，**无法确定是哪一个**。
   *    这种情况我们**故意不新建**——那些目录是真实存在的，再建一个同名目录
   *    只会制造第三个候选，把「两个分不清」升级成「三个分不清」。
   *    旧代码在这里报的是「且允许新建被关闭」，而调用方**根本没传** create_workspace
   *    （默认 true），没有任何人关掉新建。一句话把「有歧义，所以故意不建」误报成
   *    「你关了开关」，排障方向直接被带偏到配置上去。
   * 2. `not-found` + 调用方真的关了新建：这时「且允许新建被关闭」是**真话**，
   *    保留原措辞——用户确实能靠它想起自己传过 create_workspace: false。
   * 3. `not-found` + 允许新建但仍失败：如实说「找不到，而且尝试新建也失败了」，
   *    不要和前一句捆在一起（两句不相关的原因捆成一句，读的人会以为它们互为因果）。
   *
   * 还有一个容易漏的分支：`resolveOrCreate` 对**空引用**（`''` / 纯空格）不给 `reason`——
   * 空引用是「没给目标」而不是「找不到」，给它编错误文案本身就是错的。所以
   * `reason` 缺失且不是上面几种情况时，只如实说「没解析到」。
   *
   * @param {string} ref 调用方传进来的 workspace
   * @param {'ambiguous'|'not-found'|undefined} reason resolveOrCreate 的归因
   * @param {boolean} create 本次是否允许新建
   * @returns {string}
   */
  #workspaceError(ref, reason, create) {
    // 候选必须带 path：同名工作区之间 id 对人毫无区分度，path 一眼能看出是哪个目录。
    const all = this.workspaces.list()
    const describe = items => items.map(item => `${item.title}（${item.path || '无路径'}）`).join('；')
    const candidates = describe(all) || '（暂无工作区）'

    if (reason === 'ambiguous') {
      // 同名的全部列出来，让调用方能一眼挑中；有精确同名就优先列精确的
      //（`resolveOrCreate` 只回 reason，不回命中集合，所以这里按标题重算一遍）。
      const lower = String(ref ?? '').trim().toLowerCase()
      const exact = all.filter(item => String(item.title).toLowerCase() === lower)
      const matches = exact.length > 1 ? exact : all.filter(item => String(item.title).toLowerCase().includes(lower))
      const listed = describe(matches.length ? matches : all)
      return `工作区「${ref}」对应多个工作区，无法确定是哪一个：${listed}。`
        + '为避免建出重复目录，本次不自动新建。请改用工作区 id 或绝对路径重新派发。'
    }

    if (reason === 'not-found') {
      if (create) {
        return `找不到工作区「${ref}」。已按名字尝试新建，但没有成功。现有：${candidates}`
      }
      return `找不到工作区「${ref}」，且允许新建被关闭。现有：${candidates}`
    }

    // 空引用或宿主没给归因：不编造原因，只说事实。
    return `没有解析到工作区「${ref}」（既不是已知工作区，也不是可新建的名字）。现有：${candidates}`
  }

  /**
   * 子会话放在哪个工作区。
   *
   * 语义（0.8.1 起重写）：**有目标就用目标，没有目标才退回日期工作区**。
   *
   *   1. 任务带 `workspaceId` 且注册表里能查到 → 用它。这一步**不可关闭**，
   *      与 `workerWorkspace` 配成什么都不相干。
   *   2. 否则 → 当天的【派发】工作区（`workerWorkspace: day`，默认）。
   *      例外：**调用方显式给了 cwd 时不用日期兜底**（见下）。
   *   3. 再否则 → 任务的 `cwd`（会话按目录反查/登记）。
   *
   * 为什么重写：0.8.0 及更早这里是 `workerWorkspace === 'target' && target`，
   * 而 `workerWorkspace` 默认是 `day`，于是**用户明确指定了工作区也被塞进【派发】**，
   * 每次启动都凭空多出一个 `【派发】YYYY-MM-DD`。用户的意图恰恰相反：选了目标就
   * 应该在目标里，「退回日期工作区」只是找不到目标时的兜底，不是常态。
   *
   * 显式 cwd 为什么也跳过第 2 步：日期兜底是「调用方什么都没说，我们替他挑一个
   * 干净目录」，而显式 cwd 是「调用方明确说了要在哪干活」。有明确指示时还把他
   * 挪进【派发】目录，等于把 2026-11-08 12:10 那次事故重演一遍（显式 cwd 被
   * 静默丢掉，`task.cwd` 记的是调用方的路径，子会话却住在日期工作区里）。
   *
   * `workerWorkspace: 'cwd'` 时同样跳过第 2 步：不建【派发】工作区，直接按目录归属。
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

    // 2. 没有目标：显式 cwd 就是调用方的明确指示，不再用日期工作区覆盖它。
    if (task.cwdExplicit) return { path: task.cwd }
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
    // 恢复窗口内不推进（PRD-02 §4.6）：见 constructor 里 `restoring` 的注释。
    if (this.restoring) return
    /**
     * 依赖判定**先于**取任务（PRD-02 §4.3）：`blockedBy` 是唯一的准入位。
     * `#annotateDependencies()` 只写派生的看板字段，不改状态、不动队列；没有
     * `dependsOn` 的任务这一步什么都不写，行为与今天完全一致。
     */
    const doomed = this.#annotateDependencies()
    if (doomed.length) {
      // 前置已经确定没成：当场收敛（PRD-02 §4.4「在下一次 pump() 内变 cancelled」）。
      this.#cancelDependents(doomed)
      // 取消改变了前置状态；重新标注一次，避免拿旧 `blockedBy` 放跑一条后继。
      this.#annotateDependencies()
    }
    const launching = []
    for (;;) {
      const task = this.table.takeRunnable(candidate => !candidate.blockedBy)
      if (!task) break
      launching.push(this.#launchOne(task))
    }
    await Promise.all(launching)
  }

  /**
   * 计算每条**排队中**任务的 `blockedBy` / `blockedReason`（PRD-02 §4.3）。
   *
   * 三个边界：
   * - 只扫 `table.queue`：准入只对队列里的任务有意义，已结算的任务不该有「被挡」这个概念；
   * - **只写派生字段**：不改状态、不动队列顺序、不启动会话。所以 `maxWorkers` 已满时
   *   调用它也不会产生副作用（`takeRunnable` 会提前返回，下一轮再判）；
   * - 清空是写 `undefined` 而不是 `delete`：序列化时两者都消失，但 `undefined` 不会
   *   让对象的键形状在「曾被挡过」之后与「从没被挡过」不同。
   *
   * @returns {Array<{task: object, cancelReason: string, errorCode: string}>}
   *   前置已经**确定没成**、应当连带取消的后继。调用方决定何时取消（pump / restore）。
   */
  #annotateDependencies() {
    const doomed = []
    // 先取快照：本轮不修改队列（取消在调用方），但 `settle()` 会改，迭代中不能边读边改。
    for (const id of [...this.table.queue]) {
      const task = this.table.get(id)
      if (!task || task.status !== 'queued') continue
      const verdict = this.#blockedStateOf(task)
      task.blockedBy = verdict.blockedBy
      task.blockedReason = verdict.blockedReason
      if (!verdict.blockedBy) continue
      if (verdict.blockedReason === BLOCK_REASONS.FAILED) {
        doomed.push({
          task,
          cancelReason: CANCEL_REASONS.DEPENDENCY_FAILED,
          errorCode: ERROR_CODES.DEPENDENCY_FAILED,
        })
      } else if (verdict.blockedReason === BLOCK_REASONS.MISSING) {
        doomed.push({
          task,
          cancelReason: CANCEL_REASONS.DEPENDENCY_MISSING,
          errorCode: ERROR_CODES.DEPENDENCY_MISSING,
        })
      }
    }
    return doomed
  }

  /**
   * 一条任务的依赖判定——PRD-02 §4.3 的规则表**逐行**落在这里，只读。
   *
   * | 前置状态 | 结论 |
   * | --- | --- |
   * | `done` | 满足，继续看下一个 |
   * | `queued` / `running` | 等待，`blockedReason: 'running'` |
   * | `failed` / `cancelled` / `interrupted` / `ended` / `blocked` | 不满足，`'failed'` |
   * | 不在活表、退休留痕 `status === 'done'` | 满足（它做完了，只是被移出计算） |
   * | 不在活表、退休留痕非 done 或不存在 | `'missing'` |
   *
   * 返回**第一个**不满足的前置（声明顺序），因为看板与抽屉只需要说「现在等谁」；
   * 全部满足时两个字段都是 `undefined`。
   *
   * @param {object} task
   * @returns {{blockedBy?: string, blockedReason?: string}}
   */
  #blockedStateOf(task) {
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
    for (const id of deps) {
      const dep = this.table.get(id)
      if (!dep) {
        const trace = this.retired.get(id)
        // 退休留痕 `done` = 它已经做完、只是被移出计算（PRD-02 §4.3 最后两行）。
        if (trace && trace.status === 'done') continue
        return { blockedBy: id, blockedReason: BLOCK_REASONS.MISSING }
      }
      if (dep.status === 'done') continue
      // 还没结算 → 正常等待：任务留在 queued，不占 worker 并发位；前置结算时走
      // settle → pump 的现成链路触发后继，不需要定时器（PRD-02 §4.3「触发点」）。
      if (dep.status === 'queued' || dep.status === 'running') {
        return { blockedBy: id, blockedReason: BLOCK_REASONS.RUNNING }
      }
      return { blockedBy: id, blockedReason: BLOCK_REASONS.FAILED }
    }
    return { blockedBy: undefined, blockedReason: undefined }
  }

  /** 直接依赖某个任务的全部任务（扫全表，不只看队列：旧数据里两者可能不一致）。 */
  #dependentsOf(taskId) {
    const found = []
    for (const task of this.table.tasks.values()) {
      if (!Array.isArray(task.dependsOn) || !task.dependsOn.includes(taskId)) continue
      found.push(task)
    }
    return found
  }

  /**
   * 直接依赖 `taskId` 的任务里，**已经因为它的失败被连带取消**的那些（PRD-02 §6）。
   *
   * 判据必须同时看 `status` / `cancelReason` / `errorCode` 三样：
   * 只看 `cancelReason` 会把「用户手动取消、恰好也记了依赖原因」的边界数据算进来；
   * 只看 `status === 'cancelled'` 又会把用户主动取消的普通任务算成「被前置连坐」。
   * 三个一起判，才只剩「这条取消是依赖机制造成的」这一种。
   *
   * **只扫活表**：退休留痕（`#retire()`）只搬身份与摘要，不带 `dependsOn` /
   * `cancelReason`，事后无法判断它当初是不是被这位前置连坐——而且它已经离开
   * 账本，`retry()` 本来就复活不了它。所以「查不到」在这里不是漏，是事实。
   *
   * @param {string} taskId
   * @returns {object[]} 被它连坐取消的后继
   */
  #cancelledDependentsOf(taskId) {
    return this.#dependentsOf(taskId).filter(task => task.status === 'cancelled'
      && task.cancelReason === CANCEL_REASONS.DEPENDENCY_FAILED
      && task.errorCode === ERROR_CODES.DEPENDENCY_FAILED)
  }

  /**
   * 把「前置没成」的后继**连带取消**（PRD-02 §4.4）。BFS，不做深递归。
   *
   * 三条规则：
   * - **只动 `queued`**：已经在 `running` 的后继不回溯、不打断。正常路径不会出现
   *   （后继只在前置 `done` 后才启动），只有「前置被 retry 重开、又再次失败」这种
   *   事后情况才会遇到；那时按 PRD 定义为不回溯，只记一条 warn；
   * - **幂等**：`seen` 挡重复入队，`TaskTable.settle()` 对已结算任务返回 `false`，
   *   所以同一条后继不会被取消两次，也不会覆盖别人的取消原因；
   * - **原因会传递**：B 因 A 失败被取消后，C（依赖 B）的原因仍是 `dependency_failed`
   *   ——对 C 来说，它的前置确实「没成」。
   *
   * 重入闸 `#cascadingDependencies` 见字段注释：`settle()` 会触发嵌套 `pump()`，
   * 让最外层的工作队列独自走完整条链，内层直接放行，避免 O(n²) 的重复扫描。
   *
   * @param {Array<{task: object, cancelReason: string, errorCode: string}>} seeds
   * @returns {number} 本次真正取消了几个任务（供恢复收敛判断是否需要再扫一遍）
   */
  #cancelDependents(seeds) {
    if (this.#cascadingDependencies) return 0
    this.#cascadingDependencies = true
    let cancelled = 0
    try {
      const worklist = Array.isArray(seeds) ? [...seeds] : []
      const seen = new Set()
      while (worklist.length) {
        const item = worklist.shift()
        const task = item?.task
        if (!task || seen.has(task.id)) continue
        seen.add(task.id)
        if (task.status === 'running') {
          this.warn(`${LOG_PREFIX} 任务 %s 正在运行，但它的前置 %s 没成：不回溯、不打断（PRD-02 §4.4）`,
            task.id, task.blockedBy ?? '(未知)')
          continue
        }
        if (task.status !== 'queued') continue
        // 原因先落在任务上，再取消：`cancel()` 那条路径也会写 `cancelReason`，
        // 但依赖取消不经过 `cancel()`（它没有子会话可取消），必须在这里自己写。
        task.cancelReason = item.cancelReason
        task.errorCode = item.errorCode
        // `settle` 幂等：重复取消在这里被挡下，不会产生第二次通知/第二次写盘。
        if (!this.settle(task, 'cancelled')) continue
        cancelled += 1
        for (const next of this.#dependentsOf(task.id)) {
          if (next.status === 'running') {
            this.warn(`${LOG_PREFIX} 任务 %s 正在运行，但它的前置 %s 被连带取消：不回溯、不打断（PRD-02 §4.4）`,
              next.id, task.id)
            continue
          }
          if (next.status !== 'queued') continue
          // 让看板/抽屉说清「为什么没执行」：原因落在任务上，取消之后再补就晚了。
          next.blockedBy = next.blockedBy ?? task.id
          next.blockedReason = next.blockedReason ?? BLOCK_REASONS.FAILED
          worklist.push({
            task: next,
            cancelReason: CANCEL_REASONS.DEPENDENCY_FAILED,
            errorCode: ERROR_CODES.DEPENDENCY_FAILED,
          })
        }
      }
    } finally {
      this.#cascadingDependencies = false
    }
    return cancelled
  }

  /**
   * 一条任务结算后，把「还在排队等它」的后继连带取消（PRD-02 §4.4）。
   *
   * 为什么挂在 `settle()` 里、且在 `pump()` **之后**：pump 负责让**满足条件**的后继
   * 启动，这里负责让**永远满足不了**的后继有一个确定的终局。两件事分开写，取消才不会
   * 和启动在同一个循环里互相干扰；顺序反了的话，先取消会改变队列，pump 就得重扫。
   *
   * `done` 直接返回：前置做成了，后继由 pump 正常启动，没有要取消的东西。
   * 其余终态都向后传递；`blockedReason`/`blockedBy` 已经由 annotate 写好的不覆盖
   * （它们指向的是更早的那个未满足前置，信息更准）。
   *
   * @param {object} settledTask 刚结算的任务
   */
  #failDependents(settledTask) {
    if (!settledTask || settledTask.status === 'done') return
    const seeds = []
    for (const task of this.#dependentsOf(settledTask.id)) {
      if (task.status === 'running') {
        this.warn(`${LOG_PREFIX} 任务 %s 正在运行，但它的前置 %s 结算成 %s：不回溯、不打断（PRD-02 §4.4）`,
          task.id, settledTask.id, settledTask.status)
        continue
      }
      if (task.status !== 'queued') continue
      // 不在 `queue` 数组里也要收：`#annotateDependencies()` 只扫队列，这一支是
      // 它的补集（旧数据里 status 与 queue 可能不一致），保证后继不会永远挂着。
      if (!task.blockedBy) {
        task.blockedBy = settledTask.id
        task.blockedReason = BLOCK_REASONS.FAILED
      }
      seeds.push({
        task,
        cancelReason: CANCEL_REASONS.DEPENDENCY_FAILED,
        errorCode: ERROR_CODES.DEPENDENCY_FAILED,
      })
    }
    if (seeds.length) this.#cancelDependents(seeds)
  }

  /** 启动一个任务；失败则结算成 failed 并回报主会话。 */
  async #launchOne(task) {
    try {
      await this.start(task)
    } catch (error) {
      task.error = String(error)
      this.settle(task, 'failed')
      await this.persistCritical()
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
    /**
     * 前置没成 → 后继连带取消（PRD-02 §4.4）。放在 `pump()` 之后：
     * pump 已经让「满足条件」的后继启动，这里只收拾「永远满足不了」的那些。
     * `settle()` 自身幂等（`TaskTable.settle`），所以级联取消不会重复取消同一条。
     */
    this.#failDependents(task)
    void this.maybeSummarize(task)
    // P0-5：结算后立刻判一次封顶。放在这里而不是放定时器里，是因为
    // 「体积在增长」这件事恰好发生在结算点；幂等，多调几次没有代价。
    this.enforceLedgerCap()
    // 结算是账本里最不能丢的事实，但 `settle()` 是同步方法，不能在这里
    // 起一个无人等待的异步写盘（会与调用方的清理动作竞态）。所有调用点
    // 都在 async 方法里，由它们在结算后 `await persistCritical()`；这里
    // 只留防抖兜底，防止将来新增调用点漏掉。
    this.schedulePersist()
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

    try {
      // 批次汇总是「一次派发 N 个任务」的结算信号，属于必须直通的一类（P0-2）：
      // 批次成员自己只入库，如果汇总也不回流，整批就会彻底静默。
      //
      // 文案按 plans/10 §四.3 改成「结果分组」：旧形状 `done 3 / failed 1` +
      // 每条一行状态清单，要求用户自己数、自己归类，而且「failed 1」不点名——
      // 用户看不出是哪一条没成，等于没报。新形状先给批次短标签与比例，
      // 再按「成了 / 没成」分组，没成的逐条点名并带原因。
      this.admissionCounts[ADMISSION.DIRECT] += 1
      // 汇总前先冲掉**每个成员**窗口里还躺着的进度。
      //
      // 为什么不能只靠 `notify()`：汇总用的是 `group` 键，而成员的进度用的是各自
      // 的 `task.id`——键不同，`notify()` 里那句「先冲本任务」找不到它们。
      // 不冲的结果是「整批汇总」先到、成员进度 1.5 秒后才到，用户先读结论再读过程。
      // 逐条冲刷是安全的：这些进度本来就已在各自窗口里等着发，只是提前了不到 2 秒。
      for (const item of members) {
        if (this.pendingNotices.has(item.id)) await this.flushNotice(item.id)
      }
      await this.relay(
        { parentSessionId: task.parentSessionId, id: group, workerSessionId: '' },
        batchText(members, { group }),
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
      await this.persistCritical()
      await this.relayFailure(task)
      return false
    }
  }

  async start(task) {
    // 占位：status 已经是 running（takeRunnable 占的），这里只记开始时间。
    task.startedAt = now()
    task.updatedAt = task.startedAt
    this.schedulePersist()

    /**
     * 复用会话的任务（plans/08 阶段 2）：**不建会话、不重新 placement、不建任务目录**。
     *
     * 三条都不能做：
     * - `createWorker` 会新开或换号会话，等于把「复用」静默撤销；
     * - `placementFor` 在来源工作区被删时会顺手建一个日期工作区，而任务实际仍住在
     *   来源会话里，元数据会与事实分家；
     * - `taskDirRoot` 会给出一个新目录，来源会话的 cwd 已经定死，切过去就跨目录了。
     *
     * 所以这一支只做一件事：确认来源会话还活着，然后投递交接摘要。
     */
    if (task.parentTaskId) return this.#startReused(task)

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
   * 复用分支的启动：确认来源会话仍存活，然后投递**交接摘要**。
   *
   * 为什么找不到会话时必须让任务失败，而不是 `createWorker` 新建一条：
   * 新建出来的会话是一个空上下文，worker 会以为自己「刚被派了一个新任务」，
   * 而用户以为「上下文接上了」。这种错不是报错，是**看起来成功**——最难发现。
   * 所以这里明确失败，并把「不要 handoff_from」的下一步写进错误里。
   */
  async #startReused(task) {
    const parent = this.resolveTask(task.parentTaskId)
    // 只确认存活；拿到的 Agent 不需要再操作（投递走 sessions.deliver）。
    await this.#resolveReusedAgent(task)
    if (this.abortIfSettled(task, '复用确认子会话之后')) return task

    task.lastText = ''
    await this.sessions.deliver(
      task.workerSessionId,
      `${task.id}:start`,
      handoffPrompt(task, parent),
      { mode: 'queue' },
    )
    // 中止时**不能** cancel 这条 agent：它是来源任务的会话，后续任务还在用。
    // 普通派发的会话是这条任务独占的，才可以顺手取消。
    if (this.abortIfSettled(task, '投递交接摘要之后')) return task

    this.log(`${LOG_PREFIX} 任务 %s 已启动（复用子会话 %s，来源任务 %s，工作目录 %s）`,
      task.id, task.workerSessionId, task.parentTaskId, task.cwd)
    return task
  }

  /**
   * 确认一个复用目标的子会话还活着。
   *
   * 优先用 `resolveAgent()`（与 `message()` / `retry()` 同一条探测口径）；
   * 它抛错时退回 `ctx.agents` 里的活引用——活引用本身就是「会话存在」的证据，
   * 不该因为一次探测失败把一条本来能用的会话判死。
   */
  async #resolveReusedAgent(task) {
    const sessionId = task.workerSessionId
    const live = this.ctx.agents.get(sessionId)
    let resolved
    try {
      resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    } catch (error) {
      if (live) return live
      throw new Error(`任务 ${task.id} 要沿用子会话 ${sessionId}，但无法确认它是否还存在`
        + `（${oneLine(String(error?.message ?? error), 200)}）：不能新建一条会话冒充复用。`
        + '请去掉 handoff_from 新派一个任务')
    }
    if (!resolved || resolved.error || !resolved.agent) {
      if (live) return live
      throw new Error(`任务 ${task.id} 要沿用子会话 ${sessionId}，但它已不存在`
        + `（${resolved?.error?.code ?? 'not-found'}）：不能新建一条会话冒充复用——那样上下文其实是断的。`
        + '请去掉 handoff_from 新派一个任务')
    }
    return resolved.agent
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

  /**
   * 记一条报告并按准入分级决定要不要回流主会话。
   *
   * P0-3 **入库就截断**：0.8.x 只在 `reportText()` 外发时 `clip`，`task.reports`
   * 里存的是调用方给的原样长度，于是「单任务体积由调用方决定」——一个爱写长
   * 报告的 worker 能把账本撑到任意大，而 `dispatch_inspect` 读回来的也是那份
   * 巨大的正文。现在同一个上限同时作用于入库与外发（外发限长就是入库限长，
   * 库里的东西和主会话看到的是同一份），被截的条目留 `entry.truncated` 记录
   * 原始长度，便于回答「这是不是被截过」。
   *
   * P0-2 准入分级：`admissionOf()` 决定这条报告是 `direct`（回流）还是
   * `ledger`（只入库）。默认只有结论类与需要人处理的状态直通，`progress`
   * 只入账本——「进度」是过程信息，不该进会话长期历史。
   *
   * plans/10 §四.1 的 `headline`：worker 可以给一句**给用户看的结论**。
   * 它跟 `summary` 一起入库，但角色不同——`summary` 是技术摘要（做了什么、
   * 改了哪些文件），`headline` 是一句话结论。缺了**不在库里补**（补在投影层，
   * 见 `voice.js` 的 `headlineOf`）：「worker 没写」与「系统替他编了一句」
   * 是两件不同的事实，账本必须分得开；混成一个字段就再也分不出来了。
   */
  async report(agent, input) {
    const task = this.table.byWorker(agent.id)
    if (!task) throw new Error('dispatch_report 只能由被派发的 worker 调用；当前会话不属于任何派发任务')
    // 已取消的任务不再写账本：计划也没有可写的宿主，直接回绝（与 recorded:false 同一口径）。
    if (task.status === 'cancelled') {
      return {
        recorded: false,
        task_id: task.id,
        plan_accepted: false,
        plan_truncated: false,
        note: '任务已取消，报告不再回流',
      }
    }

    const status = String(input.status || 'progress')
    const summary = String(input.summary ?? '').trim()
    if (!summary) throw new Error('dispatch_report 需要 summary')

    /**
     * 撤回「假定死亡」（回归 t-mwcbmq2a-2：已完成的任务被显示成已中断）。
     *
     * `interrupted` 不是 worker 的结论，而是一条**推断**：`restore()` 按「进程重启
     * ⇒ 没有活的 worker」把还没结算的 `running` 判死。插件**热重载**不满足这条前提
     * ——重载只换插件实例，宿主的子会话与它正在跑的回合都还在；于是账本记着
     * interrupted，worker 却继续干到几十分钟后才报 done。
     *
     * 这份报告本身就是「它没死」的证据：先撤回状态，再走下面的正常结算路径，
     * worker 自己的结论（done / failed / …）才能落到账本上。不撤回的代价是实打实的：
     * `TaskTable.settle()` 见到 `SETTLED` 直接返回 false，报告只能入库，
     * 状态永远停在 interrupted——完成率、并发位、看板全错，后继还会被
     * `#failDependents()` 连带取消（事故里那 20 分钟就是这种状态）。
     *
     * 只撤回 `interrupted`，别的终态都不碰：`done`/`blocked`/`failed`/`ended` 是
     * 真实结论，`cancelled` 是用户意图（它在上面已经早退了），归档任务是只读冻结，
     * 都不该被一条报告改写。
     */
    if (task.status === 'interrupted' && !task.archivedAt) {
      this.table.transition(task, 'running', { force: true })
      this.warn(`${LOG_PREFIX} 任务 %s 被标成 interrupted，但子会话 %s 仍在发报告：撤回死亡假定，按 worker 的结论收尾`,
        task.id, task.workerSessionId)
    }

    const entry = this.#admitEntry(status, input)
    /**
     * 计划（PRD-01 §4.2）：**只写 `task.plan`，不进 `entry`**。
     *
     * 为什么不写进每条 report entry：`MAX_REPORTS = 50`，12 步 × 50 条会把账本
     * 放大一个量级，而看板只需要「最新一版」；历史计划没有决策价值。
     *
     * 为什么必须在下面的 `settle()` **之前**：终态报告可以带计划，按 PRD 是
     * 「先应用计划、再结算、然后冻结」。`#applyPlan` 自己会判终态冻结，所以
     * 结算之后迟到的 `progress` 带计划只会拿到 `plan_accepted:false`。
     *
     * 幂等也由 `#applyPlan` 负责：内容相同不更新 `planUpdatedAt`、不追加写盘动作。
     */
    const plan = normalizePlan(input.plan, this.config)
    const planAccepted = this.#applyPlan(task, plan.steps, entry.at)
    task.reports.push(entry)
    if (task.reports.length > MAX_REPORTS) task.reports.splice(0, task.reports.length - MAX_REPORTS)
    task.lastReportAt = entry.at
    task.updatedAt = entry.at
    // 报告能到就说明这一轮活过来了：瞬时续跑的计数清零，下次再 5xx 重新从头数。
    // 起点（`retrySince`）必须同时清（A6 清理点 1）——否则「已经好了」的任务会留着
    // 一条永远没人删的孤儿键，计数表却是空的。见 `#forgetRetry()`。
    this.#forgetRetry(task)
    task.retryAt = undefined
    // 记下「本回合已经给过终态报告」，供 onWorkerIdle 判断要不要补一条。
    // 用标记而不是时间戳比较，是因为 turnStartedAt 会被每一步 running 刷新。
    if (TERMINAL_REPORT.has(status)) task.reportedSinceTurn = true
    // 终态报告也要过后台活门禁（P0-1）：worker 报 done 时，它起的 dev server
    // 或 subagent 可能还在改同一个目录。直接 settle 会立刻让出并发位，
    // 而后台活并不知道自己「被完成」了。此前只有 `onWorkerIdle()` 走门禁，
    // 于是显式 `dispatch_report(status:'done')` 成了一条完全绕过它的后门。
    //
    // 报告本身照常入库、照常回流——worker 的结论不必等后台；被推迟的只有
    // 「结算」这一件事。终态先记在 `pendingTerminal` 上，等巡检收尾时按
    // worker 自己给的结论结算，不能退化成 `done`。
    let deferred = false
    if (TERMINAL_REPORT.has(status)) {
      task.pendingTerminal = status
      deferred = await this.handOffToBackground(task)
      if (!deferred) {
        task.pendingTerminal = undefined
        this.settle(task, status)
      }
    }
    await this.persistCritical()

    const admission = this.admissionOf(task, entry)
    this.admissionCounts[admission] += 1

    // progress 只在主会话正忙时顺带并入，不为了它把人叫醒。
    // 批次内的终态报告只入库，等整批结束由 maybeSummarize 统一回流一条——
    // 但如果这一批已经汇总过了、或这条任务被重开过，就再也等不到汇总了，
    // 此时必须自己回流，否则它会彻底静默。
    const selfRelay = !task.group || task.groupClosed || task.groupReopened
    // progress 节流：长任务每完成一步就报一次，会把主会话刷成一条流水线。
    // 被挡下的仍然入库（dispatch_inspect 看得到），只是不再单独回流。
    //
    // P0-2 之后 progress 的默认准入是 `ledger`，这条节流逻辑只在用户把
    // progress 配进 `directReportStatuses` 时才用得上——保留它是因为配置
    // 一旦放开，没有节流会比放开前更糟（每一小步都回流）。
    const interval = Math.max(0, Number(this.config.progressRelayIntervalMs) || 0)
    const lastProgressAt = task.progressRelayAt ? Date.parse(task.progressRelayAt) : 0
    const throttled = status === 'progress' && admission === ADMISSION.DIRECT
      && interval > 0 && Date.now() - lastProgressAt < interval
    // `admission === direct` 是新增的必要条件：只入账本的状态连投递都不该尝试，
    // 否则「不回流」只是靠后面的分支顺序维持，改一行就破。
    const shouldRelay = admission === ADMISSION.DIRECT
      && (selfRelay || status === 'progress')
      && !throttled
    // P1-2：投递形态单独记账。`ledger` 也要记数——否则「没进会话」这件事在
    // 自检里看不见，只能靠人去数 admission，而两个口径迟早会漂。
    // 投影**只算一次**（`projectReport()` 单点决定），返回值里的 `projection`
    // 与计数读的是同一个值：两处各判一次会让「自检说 digest、实际发全文」漂开。
    let projection = PROJECTION.LEDGER
    let relayed = false
    let merged = false
    if (shouldRelay) {
      if (status === 'progress') task.progressRelayAt = entry.at
      const projected = this.projectReport(task, entry)
      projection = projected.projection
      // P1-1：可合并的通知进窗口，其余立即投（`notify()` 内部按 `mergeableOf()` 分流）。
      const outcome = await this.notify(task, projected.text, status !== 'progress', {
        status,
        admission,
      })
      relayed = outcome === 'delivered' || outcome === 'recorded' || outcome === 'delivered-degraded'
      merged = outcome === 'merged'
    }
    this.projectionCounts[projection] += 1
    return {
      recorded: true,
      task_id: task.id,
      status: task.status,
      admission,
      projection,
      // 计划的两个回执（PRD-01 §4.2）：没传 plan 时也是 false —— 语义是
      // 「本条报告没有一版计划被接受」，而不是「计划被拒绝」。被终态冻结拒绝时
      // 同样是 false，模型据此知道这版计划没生效。
      plan_accepted: planAccepted,
      plan_truncated: plan.truncated,
      // 状态仍是 running 时给模型一句解释，否则它会以为报告没被接受。
      ...(deferred ? { deferred: true, note: '报告已记录；后台还有 job/subagent 在跑，任务等后台清空后再结算' } : {}),
      ...(entry.truncated ? { truncated: entry.truncated } : {}),
      grouped: !selfRelay,
      ...(throttled ? { throttled: true } : {}),
      ...(merged ? { merged: true } : {}),
      ...(relayed || merged ? {} : { relayed: false }),
    }
  }

  /**
   * 一条通知该不该进合并窗口（P1-1）。**这是 §九 那条硬约束的唯一定义处。**
   *
   * 判据只有两条，任意一条说不就**立即投递**（不进队列，也就不可能被延迟）：
   * 1. 窗口开着（`mergeWindowMs() > 0`）；
   * 2. 状态属于 `MERGEABLE_REPORT_STATUSES`（只有 `progress`）。终态
   *    `done`/`blocked`/`failed`/`cancelled` 天然不在里面——结论与「需要人处理」
   *    晚 1.5 秒，用户就会以为它卡住了。批次汇总、启动失败、回合兜底也不经过
   *    `report()`（它们直接调 `relay()`），结构上进不来。
   *
   * 为什么**不**按配置的直通列表再排一次：`progress` 的默认准入是 `ledger`，
   * 它根本不会被投递，也就无所谓合并；用户把 `progress` 加进 `directReportStatuses`
   * 是唯一让它进会话的途径。若判据里再排除「配置点名的状态」，合并功能就只在
   * 它唯一能生效的配置下被关掉——那等于这个功能不存在。
   * P1-1 的**单独回退开关**因此就是 `noticeMergeWindowMs: 0`（§九 每批能单独回退）。
   *
   * @param {{status?: string}} meta
   * @returns {boolean}
   */
  mergeableOf(meta) {
    if (this.mergeWindowMs() <= 0) return false
    return MERGEABLE_REPORT_STATUSES.has(String(meta?.status ?? ''))
  }

  /**
   * 当前生效的合并窗口（毫秒）。`0` = 关闭合并。
   *
   * 硬上限 `NOTICE_MERGE_MAX_MS`（2 秒）从这里夹：配置写了 10 秒也只按 2 秒算。
   * §九 的「合并窗口上限 2 秒」是**上限**而不是默认值，所以截断比报警更合适
   * ——配错的人要的是「合并」，不是「让通知晚 10 秒」。
   */
  mergeWindowMs() {
    const raw = Number(this.config.noticeMergeWindowMs)
    if (!Number.isFinite(raw) || raw <= 0) return 0
    return Math.min(raw, NOTICE_MERGE_MAX_MS)
  }

  /**
   * 投递一条通知：可合并的进窗口，其余立刻发。
   *
   * 窗口的语义是**「后一条覆盖前一条」**（与上游 `Effects.enqueue` 的同名 key
   * 覆盖一致）：同一任务在窗口内又来一条时，替换掉待发的那条、重置计时器，
   * 于是窗口内不管来多少条，最后只发**最新**的一条。这不是节流——节流会丢
   * 当前态，合并只丢中间态。
   *
   * 为什么计时器从**最后一条**重新起算而不是固定窗口：固定窗口下，窗口末尾
   * 1ms 来的那条仍然要等满窗口才发；从最后一条起算能保证「安静 1.5 秒后就发」，
   * 上限仍是 `NOTICE_MERGE_MAX_MS`（因为每个新条目的等待时间都不超过它）。
   *
   * @param {object} task
   * @param {string} text 已经投影过的文本
   * @param {boolean} wake
   * @param {{status?: string, admission?: string, wake?: boolean}} [meta]
   * @returns {Promise<string>} `merged` 表示进了窗口（还没真的发出去）
   */
  async notify(task, text, wake, meta = {}) {
    if (!this.mergeableOf(meta)) {
      // 直通类先把这个任务窗口里躺着的进度冲掉，再发自己。
      //
      // 为什么顺序有意义：不冲的话，`progress`（还在等窗口）会让位给后到的
      // `done`，主会话看到的是「先结论、后进度」——因果颠倒，读起来像系统错乱。
      // 冲刷在 `relay()` 之前 await，保证「过程 → 结论」的顺序不被打乱。
      // 顺带还修掉一个隐患：不冲的话那条进度要等到窗口到点才发，而那时任务
      // 可能已经结算、甚至已被退休，投递会落到一条「已经结束」的任务上。
      if (this.pendingNotices.has(task.id)) await this.flushNotice(task.id)
      return this.relay(task, text, wake)
    }
    const key = task.id
    const existing = this.pendingNotices.get(key)
    if (existing) {
      // 覆盖：文本换成最新的，计时器重起，并把「省下几条」记进统计。
      if (existing.timer) clearTimeout(existing.timer)
      this.mergeStats.collapsed += 1
      existing.text = text
      existing.wake = wake
      existing.at = now()
      existing.timer = this.#scheduleNoticeFlush(key)
      return 'merged'
    }
    this.pendingNotices.set(key, {
      task,
      text,
      wake,
      at: now(),
      timer: this.#scheduleNoticeFlush(key),
    })
    return 'merged'
  }

  /**
   * 给某个任务挂一个「窗口到点就发」的定时器。
   *
   * `unref()`：一个纯投递定时器不该拖住进程退出。插件卸载时 `dispose()` 会统一
   * 清掉它们（见 `dispose()` 里的 pendingNotices 段），所以不会有「卸载后还在投」。
   */
  #scheduleNoticeFlush(key) {
    const timer = setTimeout(() => { void this.flushNotice(key) }, this.mergeWindowMs())
    timer.unref?.()
    return timer
  }

  /**
   * 把某个任务累积的待发通知真正发出去（窗口到点、或被 `dispose()` 冲刷时调用）。
   *
   * 幂等：条目先删再发，重复调用第二次时已经没有条目，直接返回。
   *
   * @param {string} key 任务 id
   * @returns {Promise<string|undefined>} 投递结果；没有待发条目时 undefined
   */
  async flushNotice(key) {
    const entry = this.pendingNotices.get(key)
    if (!entry) return undefined
    // 先摘掉再 await：投递期间又来一条新通知时，它应当开一个新的窗口，
    // 而不是把自己追加进一条已经在飞的投递里（那样它会随这次投递一起消失）。
    this.pendingNotices.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    this.mergeStats.windows += 1
    return this.relay(entry.task, entry.text, entry.wake)
  }

  /**
   * 立即冲刷全部待发通知（插件卸载 / 测试收尾用）。
   *
   * 为什么卸载必须冲刷：窗口里躺着的是「已经决定要告诉用户」的内容，
   * 让它们随进程消失等于静默丢消息——那比晚 1.5 秒糟得多。
   *
   * @returns {Promise<number>} 被冲刷的条数
   */
  async flushNotices() {
    const keys = [...this.pendingNotices.keys()]
    for (const key of keys) await this.flushNotice(key)
    return keys.length
  }

  /**
   * 造一条入库的报告条目（P0-3 截断 + 留痕）。
   *
   * 为什么截断放在「入库前」而不是「外发前」：账本才是权威副本（G1）。
   * 外发是投影，投影可以更短；但库里的长度必须**有硬界**，否则容量膨胀
   * 只能等 P2 的存储分片来救。两者取同一个数是为了避免「库里 10 万字、
   * dispatch_inspect 看到的是残版、主会话看到的是另一个残版」这种三方错位。
   */
  #admitEntry(status, input) {
    const limitSummary = Math.max(0, Number(this.config.maxReportSummaryChars) || 0)
    const limitDetail = Math.max(0, Number(this.config.maxReportDetailChars) || 0)
    const rawSummary = String(input.summary ?? '').trim()
    const rawDetail = input.detail ? String(input.detail) : undefined
    // `headline` 不是必填：给了才入库，且**原样保留 worker 的措辞**（只 clip 长度）。
    // 这里不做「缺了就补兜底句」——兜底是投影层的事，见 voice.js 的 headlineOf()。
    const rawHeadline = String(input.headline ?? '').replace(/\s+/g, ' ').trim()
    const summary = clip(rawSummary, limitSummary)
    const detail = rawDetail === undefined ? undefined : clip(rawDetail, limitDetail)
    const headline = rawHeadline ? clip(rawHeadline, HEADLINE_LEDGER_MAX) : undefined
    /** @type {{summary?: number, detail?: number, headline?: number}} */
    const truncated = {}
    if (summary.length < rawSummary.length) truncated.summary = rawSummary.length
    if (detail !== undefined && detail.length < rawDetail.length) truncated.detail = rawDetail.length
    if (headline !== undefined && headline.length < rawHeadline.length) truncated.headline = rawHeadline.length
    return {
      at: now(),
      status,
      ...(headline ? { headline } : {}),
      summary,
      detail,
      // 只在真被截时出现：一个恒存在的空对象会让「是否截过」变成永远 true。
      ...(Object.keys(truncated).length ? { truncated } : {}),
    }
  }

  /**
   * 把一版已经归一化的计划**整版**写进任务（PRD-01 §4.2）。
   *
   * 三条语义在这里收口：
   * - **整版替换**：不做增量合并，worker 不需要 step id；每一步的 status 由 worker 给，
   *   插件不推断「前面 done 了后面就也算完成」——计划可能被缩减，推断会把事实编出来。
   * - **终态冻结**：结算之后任何计划更新都被拒（返回 false），避免「明明完了还停在第 2 步」。
   *   终态报告自己的计划是在 `settle()` 之前调用的，所以那一版能被接受。
   * - **幂等**：内容完全相同就原样返回 true，**不刷新 `planUpdatedAt`、不额外写盘**。
   *   重投同一条报告不该让「计划更新时间」往前走，否则看板上的时间会随重投漂移。
   *
   * 只改 `task.plan` / `task.planUpdatedAt` 两个字段，不碰 `updatedAt`：计划是报告的
   * 附属信息，报告本身已经负责刷新 `updatedAt`（见 `report()`）。
   *
   * @param {object} task
   * @param {Array<{text: string, status: string}>|undefined} steps 已归一化的步骤
   * @param {string} at 本次报告的时间戳（与 `entry.at` 同一个值）
   * @returns {boolean} 计划是否被接受（幂等命中也算接受）
   */
  #applyPlan(task, steps, at) {
    if (!task || !Array.isArray(steps) || !steps.length) return false
    // `queued` 还没有 worker 起来，计划没有意义；终态后冻结（PRD-01 §4.2 / §6）。
    if (task.status === 'queued' || SETTLED.has(task.status)) return false
    const current = Array.isArray(task.plan) ? task.plan : []
    const same = current.length === steps.length
      && current.every((step, index) => step?.text === steps[index].text && step?.status === steps[index].status)
    if (same) return true
    task.plan = steps
    task.planUpdatedAt = at
    return true
  }

  /**
   * 一条报告的准入判定（P0-2）：`'direct'` 回流 / `'ledger'` 只入库。
   *
   * 判据（顺序有意义，先判的不能被配置翻掉）：
   * - `TERMINAL_REPORT` 里的状态（`done`/`blocked`/`failed`/`cancelled`）→ **恒 direct**。
   *   结论与「需要人处理」是主会话唯一必须知道的两类事，任何配置都不该把它们
   *   降级成静默——用户把 `directReportStatuses` 清空也不该让 done 失声；
   * - 配置 `directReportStatuses` 里点名的状态 → direct（默认 `blocked`/`failed`，
   *   用户可以把 `progress` 加进来换回旧行为）；
   * - 其余（含 `progress` 与未知状态）→ ledger（未知 = 不敢保证是结论，宁可只入库）。
   *
   * @param {object} task 所属任务（当前判据不看它，但准入以后可能要按批次/工作区走）
   * @param {{status: string}} entry 报告条目
   * @returns {'direct'|'ledger'}
   */
  admissionOf(task, entry) {
    const status = String(entry?.status ?? '')
    if (TERMINAL_REPORT.has(status)) return ADMISSION.DIRECT
    if (this.directStatuses().includes(status)) return ADMISSION.DIRECT
    return ADMISSION.LEDGER
  }

  /**
   * 当前配置下**额外**直通的状态列表（含硬编码的终态，去重后按稳定顺序）。
   *
   * 单一来源：`admissionOf()` 与 `memoryStats().admission.directStatuses`
   * 都读它。两处各写一份的代价是「自检说 progress 直通，实际没直通」——
   * 而自检的全部价值就是能对账。
   */
  directStatuses() {
    const configured = Array.isArray(this.config.directReportStatuses)
      ? this.config.directReportStatuses.map(String)
      : []
    return [...new Set([...TERMINAL_REPORT, ...configured])]
  }

  /**
   * 报告文本：给主会话模型看的**四段式**消息（plans/10 §四.2）。
   *
   * 形状（第一行必须是任务短标签，id 只在最后的「细节」行）：
   *
   * ```text
   * 【任务】auth 令牌刷新
   * 【结果】登录超时修好了，补了 3 个回归测试
   * 【说明】替换了 refresh 调用点 6 处；新增 3 条用例；测试全绿。
   * 【细节】dispatch_inspect t-1a9f-1
   * ```
   *
   * 为什么改掉旧形状 `[dispatch] 任务 <id> · <标题> · 报告 <status>`：
   * 主会话会把这段话转述给用户，而首行里 3 个成分对用户都没用——id 对不上，
   * 「报告 done」得翻译一次，标题还得和 id 抢注意力。首行放短标签之后，
   * 主会话第一句就能是「auth 令牌刷新那条：做好了」。
   *
   * 为什么正文里**只保留 `summary`**：`detail` 是长详情，按设计只进账本
   * （`dispatch_inspect` 读得到）。把它塞进回流消息，等于把「给模型看的那份」
   * 又变成大段日志——压缩只作用于投影，而投影就是这里。
   *
   * 截断上限与外发**同一个配置**，但入库时已经截过一次（见 `#admitEntry`），
   * 所以正常情况下这里是幂等的（长度没变，`clip` 原样返回）。保留这层是给
   * 两件事兜底：一是历史库里的老条目（升级前入库的超长报告），二是调用方
   * 绕过 `report()` 直接构造条目（`maybeSummarize` 之类）。
   */
  reportText(task, entry) {
    return reportText(task, entry, { peers: this.#labelPeers(task) })
  }

  /**
   * 把一条**已经生成好**的报告文本压成「摘要 + 指针」（P1-2）。
   *
   * 为什么在投影层二次处理，而不是去改 `voice.reportText()`：四段式是 10-P0 定下
   * 的文案契约（首行短标签、id 只在细节行、需要你段带行动指向），
   * `test/voice-contract.test.js` 逐条钉着它。它是对的——错的是**整段进会话**。
   * 所以压的是「这一份投递」，不是「那一份文案」：文案层保持单一形状，
   * 投影层决定发多长，将来调预算不用碰契约。
   *
   * 压法是**按行取舍**而不是重排：`【任务】` 与 `【细节】`（指针）必留，
   * `【结果】` 必留（那是用户唯一一定要读到的一句），`【需要你】` 有就必留
   * （行动指向不能省），只有 `【说明】` 按预算裁。这样压完仍然是一份合法的
   * 四段式投影，`voiceViolations()` 照常通过。
   *
   * 什么时候**不压**：文本本来就在预算内（实测典型报告 34–120 字，远小于
   * `REPORT_VIEW.SUMMARY`），压它等于凭空制造信息损失。只有超过预算才切。
   *
   * @param {string} text `reportText()` 的产物
   * @returns {string} 可以投进会话的那一份
   */
  projectText(text) {
    const value = String(text ?? '')
    const budget = Math.max(0, Number(REPORT_VIEW.SUMMARY) || 0)
    if (value.length <= budget) return value
    const rows = value.split('\n')
    const note = rows.find(row => row.startsWith(REPORT_SECTIONS.NOTE))
    // 没有说明行就没有可压的东西，原样发：硬砍结果行或需要行是在删事实。
    if (!note) return value
    const body = note.slice(REPORT_SECTIONS.NOTE.length)
    const limit = Math.max(0, Number(REPORT_VIEW.DIGEST) || 0)
    if (body.length <= limit) return value
    // **不用 `clip()`**：它会在中间插一段「…（已截断 N 字符）…」并且**带换行**，
    // 那会把单行的【说明】段撑成三段，四段式的「一行一段」直接破掉
    //（`voiceViolations()` 与全部文案契约测试都是按行找段名的）。
    // 投影这里是「取开头 + 一句指针」，本来也不需要头尾各半：读者要的是
    // 「这段开始讲什么」，剩下的交给 `dispatch_inspect`。
    const room = Math.max(0, limit - 1)
    const keep = room > 0 ? `${body.slice(0, room)}…` : '…'
    // 余量说清「差了多少字」，而不是含糊的「已省略」：主会话据此判断要不要去查。
    const rest = `（另有 ${body.length - Math.max(0, room)} 字在账本里，用「细节」行的 dispatch_inspect 查）`
    return rows
      .map(row => (row === note ? `${REPORT_SECTIONS.NOTE}${keep}${rest}` : row))
      .join('\n')
  }

  /**
   * 把一条报告压成「摘要 + 指针」的**唯一入口**（P1-2）。
   *
   * 为什么要有这一层、而不是让调用方自己判断该不该压：`projectText()` 单独看是
   * 「超过 800 字才压」，而 `projectionOf()` 认为「带 detail 的就该是 digest」。
   * 两个判据各在一处，就会出现「自检说这条是 digest、实际投出去的是全文」——
   * 那正是 §七 第 6 条（自检与账本一致）最想避免的口径分裂。
   * 所以判据只留在一处（`projectionOf()`），压不压由它决定，`projectText()` 只负责怎么压。
   *
   * 带 detail 但摘要很短时，压了也不会变短（`body.length <= DIGEST` 时原样返回），
   * 那属于「没有可压的东西」，不是口径不一致。
   *
   * @param {object} task
   * @param {object} entry 账本条目
   * @returns {{text: string, projection: 'full'|'digest'}}
   */
  projectReport(task, entry) {
    const text = this.reportText(task, entry)
    const projection = this.projectionOf(entry)
    return {
      text: projection === PROJECTION.DIGEST ? this.projectText(text) : text,
      projection,
    }
  }

  /**
   * 这一条报告该以哪种形态投进会话（P1-2）。
   *
   * 判据按「谁更需要完整」排序，先命中的先算：
   * - 有 `detail`：账本里已经有一份长正文，会话里再放摘要全文就是重复搬运——
   *   摘要本身很短时也不影响，因为 `projectText()` 对预算内的文本是恒等的；
   * - 其余按长度：超过投影预算就压，没超就原样。
   *
   * @param {{summary?: string, detail?: string}} entry
   * @returns {'full'|'digest'}
   */
  projectionOf(entry) {
    const summary = String(entry?.summary ?? '').trim()
    if (String(entry?.detail ?? '').trim()) return PROJECTION.DIGEST
    return summary.length > Math.max(0, Number(REPORT_VIEW.SUMMARY) || 0)
      ? PROJECTION.DIGEST
      : PROJECTION.FULL
  }

  /**
   * 造短标签时要参考的「可能撞名」的任务集合。
   *
   * 为什么用**同一主会话**的范围：用户看到的是同一个主会话回流来的报告，
   * 撞名也只会发生在这里面。全库扫描会把毫不相干的同名任务也算进来，
   * 于是每条标签都平白多一个后缀。
   *
   * 隐私边界：只取 `id/title/workspaceTitle`，且只在撞名时用到它们。
   */
  #labelPeers(task) {
    const parentId = task?.parentSessionId
    if (!parentId) return []
    return this.table.ofSession(parentId)
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
  noteDelivery(task, outcome, attempt, durable) {
    task.delivery = {
      at: now(),
      outcome,
      ...(attempt ? { attempt } : {}),
      // true = 已 flush 到持久化日志；false = 宿主不支持/调用失败；
      // undefined = 这条结果不涉及投递（dropped / recorded / failed）。
      ...(durable === undefined ? {} : { durable }),
    }
  }

  /**
   * 投递成功后尽量刷一次会话持久化日志，再对生产者确认「已送达」。
   *
   * 官方原型 `AgentDelivery.send()` 是「稳定 MessageId → 扫历史 → 投递 →
   * `sessionPersistence.flush()` → 确认」（plans/05 §1.5）。缺这道屏障时，
   * 「消息已进收件箱、但事件还没落盘」的崩溃窗口会让重启后重复报告或漏报。
   *
   * `flush()` 的签名在本机仍是静态取证（docs/api-contracts.md §8 #3），
   * 所以整段只作**可选屏障**：拿不到服务或调用抛错都退回弱幂等，并明确
   * 记在 `task.delivery.durable` 上，由 selfCheck 汇总，绝不假装已持久化。
   */
  async #flushSessionPersistence() {
    const persistence = this.ctx.get('sessionPersistence')
    if (typeof persistence?.flush !== 'function') return 'unsupported'
    try {
      await persistence.flush()
      return true
    } catch (error) {
      if (!this.durabilityWarned) {
        this.durabilityWarned = true
        this.warn(`${LOG_PREFIX} sessionPersistence.flush() 不可用（跨重启投递幂等退化为弱级别）: %s`, String(error))
      }
      return false
    }
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
        const durable = await this.#flushSessionPersistence()
        this.noteDelivery(task, 'delivered', attempt + 1, durable)
        return 'delivered'
      }
      try {
        const result = await this.sessions.deliver(parentId, requestId, text, {
          mode: 'steer',
          wake: !!wake,
        })
        const outcome = result.delivered === 'prompt' ? 'delivered-degraded' : 'delivered'
        const durable = await this.#flushSessionPersistence()
        this.noteDelivery(task, outcome, attempt > 0 ? attempt + 1 : undefined, durable)
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

  /**
   * 任务启动失败时也要让主会话知道，而不是只留在任务表里。
   *
   * 文案按 plans/10 §四.4：`<任务短标签>：没能开始——<原因>`。
   * 旧文案 `[dispatch] 任务 <id> · <标题> 启动失败：<error>` 三样都有，但
   * 「启动失败」是工程词，「没能开始」才是用户能判断的事；而且 id 占据了首句。
   * 末尾带一句「要我重试吗？」是**行动指向**：这条消息的全部用途就是让用户
   * 决定下一步，没有这一句就只是通知。
   */
  async relayFailure(task) {
    // 走 `notify()` 而不是 `relay()`：这条是结论（「没能开始」），必须先冲掉该任务
    // 窗口里还躺着的进度，否则用户会先看到「结论」、后看到「过程」。
    // `mergeableOf('failed')` 恒 false，所以它自己绝不会被合并。
    await this.notify(task, failureText(task, { peers: this.#labelPeers(task) }), true, { status: 'failed' })
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
    // P0-3：`lastText` 同样入库即截断。它是「worker 最后说了什么」的备份，
    // 而 worker 的一段总结可以很长；不截的话 `tasks.json` 的体积会由
    // worker 的啰嗦程度决定，跟报告一样没有硬界。外发时还会再 clip 一次
    //（finishIdleTurn 里的 5000），两者不冲突：入库是硬界，外发是投影预算。
    task.lastText = clip(text, this.#maxLastTextChars())
    task.updatedAt = now()

    // 回合结束 ≠ 活干完：后台还有 shell job / subagent 在跑时先不结算。
    // 结算会释放并发位，而后台仍在改同一个目录——上游把占用单位定成 Assignment，
    // 就是为了这件事。这里用「延迟结算 + 巡检」近似它。
    if (await this.handOffToBackground(task)) return

    await this.finishIdleTurn(task, task.lastText ?? '')
  }

  /** `lastText` 的入库上限（可配，0 表示不截）。 */
  #maxLastTextChars() {
    const limit = Number(this.config.maxLastTextChars)
    return Number.isFinite(limit) && limit > 0 ? limit : 5000
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

    // 终态报告因后台活被推迟结算（report() 里的 pendingTerminal）。
    // 按 worker 自己给的结论收尾，不要退化成 `done`；也不能再发
    // 「worker 本轮没给结论」的兜底回报——它明明给过了。
    const pending = task.pendingTerminal
    task.pendingTerminal = undefined
    if (pending) {
      if (extra.note) task.backgroundNote = extra.note
      if (!SETTLED.has(task.status)) {
        this.settle(task, canTransition(task.status, pending) ? pending : 'ended')
      }
      await this.persistCritical()
      return
    }

    if (reportedThisTurn) {
      if (task.status === 'running') this.settle(task, 'done')
      await this.persistCritical()
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
    await this.persistCritical()
    if (!this.config.reportOnTurnEnd) return

    // settle() 里的 maybeSummarize 可能**刚刚**为这一批发了汇总（尤其单成员批次，
    // 结算瞬间就满足「全部结算」）。那种情况下再单独回流一条就是重复。
    const summarizedNow = !!task.group && !!task.groupClosed && !reopened
    if (summarizedNow) return

    // 未汇总的批次成员不单独回流：整批结束时有一条汇总，逐条发等于没汇总。
    if (task.group && !task.groupClosed && !reopened) return

    // 这里的 5000 与 `maxLastTextChars` 默认值一致：`text` 参数可能来自
    // `task.lastText`（已按 maxLastTextChars 截过），也可能来自 watchBackground
    // 的旧值。统一按配置再夹一次，避免改了配置后这条路径还按老数字走。
    const body = text ? clip(text, this.#maxLastTextChars()) : '（worker 本轮没有输出文本）'
    // 文案按 plans/10 §四.4：先说哪条，再说「它跑完了但没给结论」。
    // 旧文案 `一轮执行结束（worker 未显式报告）` 是机制描述，用户读不出
    // 「这条路走不通了、要不要追问」这层意思。
    //
    // 走 `notify()`：这是一条结论，必须先冲掉该任务窗口里还躺着的进度。
    // 用 `relay()` 会把它插到待发进度前面——用户先看到「它跑完了」再看到
    // 「第三步在跑」，因果颠倒。`mergeableOf('ended')` 恒 false，它自己不会被合并。
    await this.notify(task, idleText(task, {
      peers: this.#labelPeers(task),
      body,
      note: extra.note,
    }), true, { status: 'ended' })
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
    // 「还有后台活」是一条会决定结算与否的事实：不能等 800ms 防抖，
    // 否则这中间崩溃，重启后会以为任务已经可以结算了。
    await this.persistCritical()
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
      const killed = over ? await this.killBackground(task) : 0
      const hadJobs = task.background?.jobs ?? 0
      task.background = undefined
      if (killed) task.backgroundKilled = killed
      task.updatedAt = now()
      await this.persistCritical()
      const note = over
        ? `后台活超过 ${Math.round(limit / 60000)} 分钟上限，已结束（终止 ${killed}/${hadJobs} 个 job）`
        : '后台活已结束'
      await this.finishIdleTurn(task, task.lastText ?? '', { note })
    }

    schedule()
  }

  /**
   * 终止还在跑的 shell job（best-effort：失败只记日志，不阻塞结算）。
   *
   * `jobs.list` 在宿主里是异步的。此前这里漏了 `await`，`Array.isArray(Promise)`
   * 恒为 false，于是「到上限终止 job」一个 job 都杀不到，任务却被结算掉、
   * 报告里还写着「已结束」。评估 §2.4 把它列为一行可修的 P0 缺陷。
   */
  async killBackground(task) {
    let killed = 0
    const sessionId = task?.workerSessionId
    if (!sessionId) return killed
    const service = this.ctx.get('jobs')
    if (typeof service?.list !== 'function' || typeof service.kill !== 'function') return killed
    try {
      const listed = await service.list(sessionId)
      for (const job of Array.isArray(listed) ? listed : []) {
        if (job?.owner !== sessionId) continue
        if (job.status !== 'running' && job.status !== 'stopping') continue
        try {
          await service.kill(job.id, sessionId, 'dsh-mini-superagent background limit')
          killed += 1
        } catch (error) {
          this.warn(`${LOG_PREFIX} 终止后台 job %s 失败: %s`, job.id, String(error))
        }
      }
    } catch (error) {
      this.warn(`${LOG_PREFIX} 终止任务 %s 的后台活失败: %s`, task?.id, String(error))
    }
    this.backgroundKills += killed
    return killed
  }

  /**
   * 重启后重挂后台活巡检（由 `apply()` 在 `pump()` 之后调用）。
   *
   * `restore()` 只负责读账本与记待办；真正起定时器要等队列推进完，
   * 否则巡检收尾触发的 `settle → pump` 会和启动时的 pump 抢同一批任务。
   */
  resumeBackgroundWatches() {
    const ids = this.pendingBackgroundWatchers
    this.pendingBackgroundWatchers = []
    for (const id of ids) {
      const task = this.table.tasks.get(id)
      if (task && !SETTLED.has(task.status) && task.background) this.watchBackground(task)
    }
    if (ids.length) this.log(`${LOG_PREFIX} 重启后重新接管 %d 个后台活巡检`, ids.length)
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
    // 归档是**只读冻结**：统计里已排除它，看板上也没有任何操作按钮。
    // 让它重新活起来会造出「归档与在跑并存」的任务——历史被算成当下，
    // 而它其实正在改同一个工作目录。这一条挡在**投递之前**，不留半条投递。
    if (task.archivedAt) {
      throw new Error(`任务 ${task.id} 已归档（${task.archivedAt}）：归档是只读冻结，不能再往里投递要求。`
        + '请新派一个任务')
    }

    /**
     * 依赖准入：**还在等前置的排队任务不接受任何投递**（PRD-02 §4.3 的反向约束）。
     *
     * 为什么必须挡在这里：`dependsOn` 是调用方自己声明的顺序约束。被挡住的任务停在
     * `queued`，`blockedBy` 非空；而 `message()` 下面的 `transition(force)` 会把它直接
     * 改成 `running` 并摘出队列——用户看到的是「还在等 A，B 却开跑了」，声明好的先后
     * 顺序被一条追问打乱。这不是「消息发错了」，是**约定本身失效了**：没有任何信号表明
     * 调用方知道自己要插队。
     *
     * 为什么默认拒绝而不是收 `force` 参数：这里没有「用户明确要求插队」这条事实可以
     * 依据（`dispatch_cancel` 才是用户表达「这条我不要了」的入口）。一个默认关闭的
     * 开关在这里只会让模型在不知道自己在干什么的时候把它打开。
     *
     * 为什么用 `#blockedStateOf()` 现算而不是读 `task.blockedBy`：后者是 `pump()` 每轮
     * 重算的派生快照，只在队列里刷新；现算保证「此刻到底等不等前置」是事实而不是
     * 缓存，也不会因为前置刚结算、下一轮 pump 还没跑就把一条已经可以开始的任务拒掉。
     *
     * 复用的错误码是 `CONFLICT`：与同一文件里「已结算不能取消」「会话被其他任务占用」
     * 同族，语义都是「当前状态不允许这个动作」。没有为它新造错误码——依赖相关的四个码
     * （UNKNOWN_DEPENDENCY / DEPENDENCY_CYCLE / DEPENDENCY_FAILED / DEPENDENCY_MISSING）
     * 描述的都是「依赖声明本身出了问题」，而这里声明是合法的，只是**还没轮到**。
     *
     * 三条入口共用这一道闸：`dispatch_message`、`dispatch_launch({continue_task_id})`
     * 与看板的「续派」都经由本方法投递，所以文案里同时点明「追问与续派都会被挡」。
     * （`dispatch_wait` 不经过 `message()`，它只是等结算，不受影响。）
     */
    if (task.status === 'queued') {
      const verdict = this.#blockedStateOf(task)
      if (verdict.blockedBy) {
        const stateText = {
          [BLOCK_REASONS.RUNNING]: '还在运行',
          [BLOCK_REASONS.FAILED]: '已经以非 done 的终态结算',
          [BLOCK_REASONS.MISSING]: '已不在账本里（退休留痕不是 done，或查不到）',
        }[verdict.blockedReason] ?? '还没结算'
        throw fail('CONFLICT', `任务 ${task.id} 还在等前置 ${verdict.blockedBy}（它${stateText}）：`
          + '这条任务的 depends_on 还没满足，现在投递消息会把它直接变成 running，'
          + '声明好的先后顺序就失效了。等前置结算后这条任务会自动开始；'
          + '要放弃它，请用 dispatch_cancel 取消（追问与续派都是往子会话投消息，走的是同一条准入）')
      }
    }

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

    /**
     * 投递期间任务可能已经被取消（`dispatch_cancel` 与 `dispatch_message` 并发）。
     *
     * 取消是用户的明确动作，优先级高于这次投递：此时**不能**把任务拉回 running，
     * 否则「取消」会被静默撤销——用户看到取消成功，任务却又在跑（实测取消后又变回 running）。
     *
     * 消息已经进了子会话的收件箱，这一点改不回去了；能守住的是「任务不再继续」：
     * 状态留在 cancelled，结算时刻留着，统计口径也不会把它算成在跑。
     *
     * 这一段到 `transition()` 之间**没有 await**，所以「复查 → 改状态」是原子的：
     * 不会有第三个状态插进这两步之间。
     */
    if (task.status === 'cancelled') {
      throw new Error(`任务 ${task.id} 在投递途中已被取消：消息已进子会话收件箱，但任务不再继续`
        + '（取消优先，任务保持已取消）')
    }

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
      // force 复活会经 `transition()` 清掉上一轮的 settledAt（离开终态 = 结算时刻失效），
      // 于是第二次结算写的是**新的**时刻，而不是沿用第一轮。
      this.table.transition(task, 'running', { force: true })
      task.turnStartedAt = now()
      task.updatedAt = task.turnStartedAt
    }
    /**
     * 新回合开始 = 上一回合的「已给过终态报告」标记作废。
     *
     * 不清的后果很具体：第一轮报了 done（标记置位）→ 续派 → 第二轮 worker
     * 没给结论就结束 → `finishIdleTurn()` 读到残留的 true，把任务判成 done
     * 并**跳过兜底通知**。用户看到的只是第一轮的报告，第二轮静默消失
     * （实测第二轮零报告被判 done 且完全不发通知）。
     */
    task.reportedSinceTurn = false
    await this.persistCritical()
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
      throw fail('CONFLICT', `任务 ${task.id} 已结算（${task.status}），不能取消`)
    }
    /**
     * 会话级取消闸门（plans/08 §八「同会话有活跃任务时，取消返回 409 并说明」）。
     *
     * 为什么要拒绝而不是照样取消：`cancel()` 调用的是 `agent.cancel()`，取消的是
     * **整条会话的当前回合**。复用之后一条会话可能正被另一条任务使用，取消其中一条
     * 就会打断另一条的回合——用户看到的是「我取消了 A，B 却失败了」。
     *
     * 只挡 **running** 的任务：排队中的任务还没占用会话回合，取消它只是把它移出队列。
     * 这样用户仍然有出路——先取消排队中的那条，再取消正在跑的那条。
     */
    const siblings = task.status === 'running'
      ? this.table.tasksOfWorker(task.workerSessionId)
        .filter(other => other.id !== task.id && !SETTLED.has(other.status))
      : []
    if (siblings.length) {
      const listed = siblings.slice(0, 5).map(other => `${other.id}（${other.status}）`).join('、')
      throw fail('CONFLICT', `任务 ${task.id} 正在使用子会话 ${task.workerSessionId}，`
        + `同会话还有 ${siblings.length} 个未结算任务：${listed}${siblings.length > 5 ? ' 等' : ''}。`
        + '取消会打断它们的回合（一个会话同一时刻只能跑一个回合）；'
        + '请先取消排队中的任务，或等它们结算后再取消这条')
    }
    this.table.dequeue(task.id)
    /**
     * 排队中的任务从没跑过：它没有后台活、也没有自己的回合可取消。
     * 尤其**不能** `agent.cancel()`——这个 agent 属于正占用会话的另一条任务。
     */
    if (task.status === 'queued') {
      task.cancelReason = reason
      this.settle(task, 'cancelled')
      await this.persistCritical()
      return task
    }
    // 取消必须连后台活一起停（P0-2）：worker 回合被 cancel 之后，它起的
    // dev server / subagent 仍在跑，而任务已经释放了并发位。此前这里只
    // `agent.cancel()`，评估里 `jobs.kill` 的调用次数实测为 0。
    // subagent 没有可验证的终止接口（docs/api-contracts.md §8），所以只终止
    // jobs，剩下的明确记在 backgroundNote 里，不假装「干净地停了」。
    const killed = await this.killBackground(task)
    if (killed) {
      task.backgroundKilled = killed
      this.log(`${LOG_PREFIX} 取消任务 %s 时终止了 %d 个后台 job`, task.id, killed)
    }
    const hadSubagents = Number(task.background?.subagents) || 0
    if (hadSubagents) {
      task.backgroundNote = `取消时还有 ${hadSubagents} 个 subagent；插件没有可验证的终止接口，由宿主自行回收`
      this.warn(`${LOG_PREFIX} 任务 %s 取消时仍有 %d 个 subagent，宿主需自行回收`, task.id, hadSubagents)
    }
    this.stopBackgroundWatch(task.id)
    task.background = undefined
    task.pendingTerminal = undefined
    const agent = this.ctx.agents.get(task.workerSessionId)
    if (agent) {
      try { agent.cancel({ kind: 'user' }, { keepInbox: false }) }
      catch (error) { this.warn(`${LOG_PREFIX} 取消失败: %s`, String(error)) }
    }
    task.cancelReason = reason
    this.settle(task, 'cancelled')
    await this.persistCritical()
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
    /**
     * 归档是**只读冻结**，重试不能把它复活。
     *
     * 为什么必须单独挡在这里：`retry()` 有两条分支，子会话还活着的那条走
     * `message()`（那里已有归档闸），但**会话已死**的那条直接 `reopen()` 换新
     * 会话，根本不经过 `message()`。只在 `message()` 里挡的话，归档任务恰好子
     * 会话已死时仍会被复活成 running，而 `archivedAt` 还留着——统计把它当历史
     * 排除，它却在真实跑（实测 status=running、archivedAt 仍在）。
     *
     * 判据与 `#assertContinuable()` 的归档闸同源：归档 = 只读冻结，任何「再干
     * 一轮」的入口都不该穿过它。
     */
    if (task.archivedAt) {
      throw new Error(`任务 ${task.id} 已归档（${task.archivedAt}）：归档是只读冻结，不能再重试。`
        + '要重做请派发一个新任务')
    }

    // attempt 只在**投递成功之后**才递增：0.6.0 之前先自增再投递，
    // 投递失败时 attempt 已经消耗掉、状态还卡在 running。
    const nextAttempt = (task.attempt ?? 1) + 1
    /*
     * PRD-02 §6：前置被 `retry` 重开时，**已经因它失败而被连带取消**的后继不复活。
     *
     * 这不是遗漏，是定义——那些后继的取消原因在当时是真的（前置确实没成），而
     * 重开只是把这条前置再跑一遍，不代表后继该跟着重来；「仍在排队等它的」才会
     * 继续等新一次结算。坑在于用户点「重试」时往往以为整条链一起重来，任务表上
     * 却只剩前一条在跑、后继还是 cancelled，看起来像漏做了。
     *
     * 所以记一条 warn 明说现状（含条数与 id），用户/排障都能对上。
     * N=0 不记：一条都没被取消时这句话只是噪音。
     */
    const strandedDependents = this.#cancelledDependentsOf(task.id)
    if (strandedDependents.length) {
      this.warn(`${LOG_PREFIX} 任务 %s 被重开（第 %d 次），但已因它失败而取消的 %d 条后继不会自动复活`
        + '：%s（PRD-02 §6；要重做请单独 retry 那几条）',
      task.id, nextAttempt, strandedDependents.length, strandedDependents.map(item => item.id).join(', '))
    }
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
    task.workerSessionId = `${WORKER_PREFIX}${task.id}-a${task.attempt}`
    /**
     * 换 attempt 会话 = 复用关系结束。
     *
     * `parentTaskId` 的含义是「这条任务的 workerSessionId 是来源任务的会话」。
     * 现在会话换了号，它已经不成立。不清掉的话 `start()` 会继续走复用分支、
     * 去 resolve 一条早就不存在的旧会话，任务直接 failed——而用户明明点的是
     * 「重试」、期望换一条新会话从简报重来。`threadId` 保留：工作线还是同一条。
     *
     * 审计三件套（handoffSource / handoffReason / handoffReasonTruncated）一起清：
     * 它们的不变式是「有 parentTaskId 才有交接来源」。只清 parentTaskId 会留下
     * 「来源未知、但有一个理由」的孤儿字段，看板只能显示半条血缘。
     */
    task.parentTaskId = undefined
    task.handoffSource = undefined
    task.handoffReason = undefined
    task.handoffReasonTruncated = undefined
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
    // 新一轮开始，上一轮被后台活推迟的终态不再作数：这一轮会有自己的结论。
    task.pendingTerminal = undefined
    task.turnStartedAt = now()
    task.updatedAt = task.turnStartedAt
    this.schedulePersist()
  }

  /**
   * 「续跑健康度」的投影源（A6 / PRD §10.3）：次数、起点、最近一次错误。
   *
   * 三个值都来自 `Dispatch` 的内存（`retryCounts` / `retrySince` / `task.retryAt`），
   * 返回 `undefined` 表示**此刻不在续跑**——这是唯一的「不输出」判据，调用方不需要
   * 自己判 `attempts > 0`。
   *
   * 为什么 `last_error` 单独记而不是复用 `card().error`：`task.error` 只在
   * `failTurn()`（放弃 / 非瞬时故障）与启动、目录准备失败时写，语义是**结算原因**。
   * 续跑中的任务还没结算，若为了展示去写 `task.error`，「还在重试」就会长得跟
   * 「已经失败」一样，看板上分不出来（PRD §10.5 的 [TBD] 项，结论：需要补）。
   */
  #retryHealthOf(task) {
    const attempts = this.retryCounts.get(task.id) ?? 0
    if (attempts <= 0) return undefined
    const since = this.retrySince.get(task.id)
    return {
      attempts,
      ...(since ? { since } : {}),
      // 下一次续跑还没安排（`resumeAfterError()` 投递成功后清掉了）时不写空串：
      // 空串会被前端当成「有一刻叫空」，省略才是「这一刻不存在」。
      ...(task.retryAt ? { last_at: task.retryAt } : {}),
      ...(task.retryError ? { last_error: task.retryError } : {}),
    }
  }

  /**
   * 把派生快照刷到任务对象上：`task.retryHealth`（`undefined` = 未续跑）。
   *
   * 为什么要挂到任务上，而不是给 `boardTask()` 加参数：看板快照是 `boardTask(task)`
   * 这个纯函数的产物（单测直接喂任务对象、内部多处调用），加参数会把它变成
   * 「必须拿到 Dispatch 才能算」的东西。把算好的三个标量挂在任务上，签名一字不动
   * （PRD §10.4 的推荐做法）。代价是派生值必须跟着源一起变，所以计数或
   * `retryAt` 一变就调这里。
   */
  #syncRetryHealth(task) {
    task.retryHealth = this.#retryHealthOf(task)
  }

  /**
   * 让一条任务彻底退出「续跑中」：次数、起点、派生快照、最近错误**一起**清。
   *
   * 为什么收成一个动作而不是在各调用点分别写两行 `delete`：`retryCounts` 与
   * `retrySince` 是同一件事的两半，分头写就一定会有人漏掉一半——漏掉的那一张表
   * 会留下永远没人删的孤儿键（PRD §10.8 的长期内存增长就是这么来的）。
   * 三个清理点（报告入库、`failTurn()`、卸载）全部走这里，改顺序也改不坏。
   */
  #forgetRetry(task) {
    this.retryCounts.delete(task.id)
    this.retrySince.delete(task.id)
    task.retryError = undefined
    this.#syncRetryHealth(task)
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
    // 只在**首次**进入续跑时记起点：第二次及以后的退避不该刷新它，否则看板上
    // 「自 HH:mm 起」会随着每一次失败往后跳，永远指不出这一轮是从什么时候开始的。
    if (tries === 0) this.retrySince.set(task.id, now())
    const delay = Math.max(0, Number(delays[tries]) || 0)
    const reason = oneLine(String(error?.message ?? error), 160)
    this.warn(`${LOG_PREFIX} 任务 %s 的 worker 遇到瞬时故障（%s），%d ms 后续跑（第 %d/%d 次）`,
      task.id, reason, delay, tries + 1, delays.length)
    task.retryAt = new Date(Date.now() + delay).toISOString()
    // 最近一次瞬时错误（A6）：与 `task.error` 分开记，后者是结算原因（见 `#retryHealthOf`）。
    task.retryError = oneLine(String(error?.message ?? error), 300)
    this.#syncRetryHealth(task)
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
      // 投递成功 = 下一次续跑已经安排掉了，`last_at` 随之消失；次数与起点**不清**
      //（这一轮还没结束，`retry_health` 仍要如实说「已经续跑过 N 次」）。
      this.#syncRetryHealth(task)
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
    // 结算成 failed 之后就没有「续跑中」这回事了：次数与起点一起清（A6 清理点 2）。
    this.#forgetRetry(task)
    task.retryAt = undefined
    this.settle(task, 'failed')
    await this.persistCritical()
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
    // 读到了就不再是「不知道」：清掉超时留下的 unknown 标记。
    task.inputUnknownAt = undefined
    task.updatedAt = task.inputReadAt
    this.schedulePersist()
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 清掉过期状态（P0-4，幂等）。
   *
   * 目前只有一件事：**「已投递未读」的 TTL**。
   *
   * 为什么必须是 TTL 而不是等事件：宿主在部分部署（headless、精简宿主）里
   * 根本不发 `session/event`，于是 `onSessionEvent` 永远不会被调用，
   * `inputPendingAt` 就永久挂着。看板把它显示成「已投递未读」——
   * 一个永远不结束的状态，比不显示更误导人。
   *
   * 超时后**不假装读过**（那会掩盖真正的问题），而是改写成一个更弱的断言：
   * `inputUnknownAt = now()`，含义是「我们不知道 worker 读没读到」。
   * `card()` / `detail()` 只在有 pending 时报 pending，所以 unknown 之后
   * 那张卡片不再显示「待读」，但仍能从 `input_unknown_at` 看到曾经发生过什么。
   *
   * 触发点：`schedulePersist` 的防抖回调与 `persist()` 之前。**不新开定时器**——
   * 为一个纯内存清扫起一条常驻链路不值得，而写盘本来就是这些状态变化的汇合点。
   *
   * @returns {number} 本次被改成 unknown 的任务数（供自检/日志）
   */
  sweepMemory() {
    const ttl = Number(this.config.inputPendingTtlMs)
    if (!Number.isFinite(ttl) || ttl <= 0) return 0
    const cutoff = Date.now() - ttl
    let swept = 0
    for (const task of this.table.tasks.values()) {
      if (!task.inputPendingAt || task.inputReadAt) continue
      const at = Date.parse(task.inputPendingAt)
      if (!Number.isFinite(at) || at > cutoff) continue
      task.inputPendingAt = undefined
      task.inputUnknownAt = now()
      swept += 1
    }
    if (swept) {
      this.log('%s 有 %d 条「已投递未读」超过 %d ms 未确认，标记为 unknown', LOG_PREFIX, swept, ttl)
    }
    return swept
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
    // 退休记录没有 reports / lastText（P0-5 有意不搬正文），而 `card()` 同时
    // 要给活任务与退休记录用（`detail()` 也走它）。所以这里先归一，
    // 不去要求调用方保证字段齐——否则「查一个退休任务」会直接抛 TypeError。
    const reports = Array.isArray(task.reports) ? task.reports : []
    /**
     * 依赖（PRD §6.3 的 A2）。两件事都直接读账本上**已有的**字段，不在这里重算：
     *
     * - `depends_on` 读 `task.dependsOn`。`[]` 是**恒定输出**（PRD §6.3 的例外）：
     *   表示「已检查过，确实没有依赖」，调用方不必再判属性存在。
     * - `blocked_by` 读 `task.blockedBy`——它是 pump/annotate 维护的派生值，语义是
     *   「此刻第一个没满足的前置」。投影层再写一遍依赖判定，就会在看板与工具之间
     *   出现两套「谁在挡着」的算法，迟早给出不同答案；这里只做类型包装。
     *
     * 为什么工具面用数组而看板仍是标量：PRD §6.3 字段表把 `blocked_by` 定为
     * `string[]`（工具面一次看全「在等谁」），看板为 2 秒轮询的体积仍只发第一个。
     * 第 0 项就是看板那个值，字段名逐字一致，没有第二套拼写。
     *
     * **这里绝不能放 `plan`。** `card()` 同时服务 `dispatch_list` 与 `dispatch_inspect`，
     * 把步骤数组塞进列表会让返回体膨胀数倍（PRD §6.8 点名的坑）。计划只在
     * `detail()` 里给——`dispatch_list` 要的是「一眼看多少条」，不是每条的执行细节。
     */
    const dependsOn = Array.isArray(task.dependsOn)
      // 上限与看板同一口径（`DEFAULTS.maxDependsOn`）：准入已经卡过，这里再 slice
      // 一次只是防手工改账本把列表返回体撑大。
      ? task.dependsOn.filter(id => typeof id === 'string' && id).slice(0, DEFAULTS.maxDependsOn)
      : []
    const blockedBy = task.blockedBy ? [task.blockedBy] : []
    /**
     * 重试健康度（A6 / PRD §10.3）：`attempts > 0` 才有，`undefined` 时整块不输出。
     *
     * 现算而不是读 `task.retryHealth`：`card()` 是工具面的投影（`dispatch_list` /
     * `dispatch_inspect`），它跑在 Dispatch 里、拿得到真值；`task.retryHealth`
     * 那个快照是给拿不到计数的 `boardTask()` 用的，两者同一份算法（`#retryHealthOf`）。
     */
    const retryHealth = this.#retryHealthOf(task)
    return {
      task_id: task.id,
      title: task.title,
      status: task.status,
      session_id: task.workerSessionId,
      // 复用血缘（plans/08 阶段 2）：只在真的复用出现，独立任务不凭空多字段。
      // 与看板同名，工具返回值与看板对同一件事用同一套字段名。
      ...(task.parentTaskId ? { handoff_from: task.parentTaskId } : {}),
      ...(task.handoffSource ? { handoff_source: task.handoffSource } : {}),
      ...(task.handoffReason ? { handoff_reason: task.handoffReason } : {}),
      ...(task.workspaceTitle ? { workspace: task.workspaceTitle } : {}),
      ...(task.hostWorkspaceTitle ? { host_workspace: task.hostWorkspaceTitle } : {}),
      ...(task.archivedAt ? { archived_at: task.archivedAt } : {}),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      ...(task.lastReportAt ? { last_report_at: task.lastReportAt } : {}),
      ...(reports.length ? { reports: reports.length } : {}),
      // 退休记录没有 reports，只有 reportCount（P0-5 有意不搬正文）。
      ...(!reports.length && task.reportCount ? { report_count: task.reportCount } : {}),
      summary: reports.length ? oneLine(reports.at(-1).summary, 200) : oneLine(task.lastText, 200),
      ...(task.error ? { error: oneLine(task.error, 300) } : {}),
      ...(task.delivery && task.delivery.outcome !== 'delivered'
        ? { report_delivery: task.delivery }
        : {}),
      // 「追问问出去没有」：已投递未读是异常态（worker 那一步没拿到消息），值得显示。
      // P0-4 之后只有**仍在 TTL 内**的 pending 才报 pending；超时被 `sweepMemory()`
      // 改写成 inputUnknownAt，语义从「在读」降级成「不知道」，不再显示成卡住。
      // `!task.inputUnknownAt` 是双保险：万一有路径同时留下两个标记（旧数据、
      // 或 future 的清理顺序变了），unknown 必须压过 pending——「不知道」
      // 是比「在读」更弱也更诚实的断言，弱断言不该被强断言盖住。
      ...(task.inputPendingAt && !task.inputReadAt && !task.inputUnknownAt
        ? { input_pending_at: task.inputPendingAt }
        : {}),
      ...(task.inputReadAt ? { input_read_at: task.inputReadAt } : {}),
      ...(task.inputUnknownAt && !task.inputReadAt ? { input_unknown_at: task.inputUnknownAt } : {}),
      ...(task.retryAt ? { retry_at: task.retryAt } : {}),
      /**
       * A6：重试了几次、从什么时候开始（`{attempts, since?, last_at?, last_error?}`）。
       *
       * 与 `report_delivery`（投递重试：报告有没有送到主会话）是**两件完全不同的事**，
       * 字段名刻意不共享、也不合并成一块：把两者放在一起展示，用户会以为
       * 「重试 2 次」的意思是「报告没送到」，而实际是模型/连接瞬时故障（PRD §10.8）。
       * 最近错误不在这里重复一份 `card().error` 意义上的「结算原因」，理由见
       * `#retryHealthOf()`。
       */
      ...(retryHealth ? { retry_health: retryHealth } : {}),
      ...(task.taskDir ? { task_dir: task.taskDir } : {}),
      ...(task.prepareAt ? { prepare_at: task.prepareAt } : {}),
      // 后台活：回合结束了但 job/subagent 还在跑，任务仍占着并发位。
      ...(task.background ? { background: task.background } : {}),
      ...(task.backgroundKilled ? { background_killed: task.backgroundKilled } : {}),
      // 依赖（PRD §6.3）：两个短字段，列表里就能看出「这条在等谁」。
      // 其余依赖字段（blocked_reason / cancel_reason / error_code）留在 `detail()`：
      // 列表只需要「有没有在等、等谁」，原因这类排查信息走显式查询。
      depends_on: dependsOn,
      ...(blockedBy.length ? { blocked_by: blockedBy } : {}),
    }
  }

  /** 详情：卡片 + 最近报告 + worker 最后输出。 */
  detail(task) {
    // 退休记录也可以走这里（`resolveTask()` 返回的对象若 `isRetired()` 为真）：
    // 它没有 brief / reports / lastText，`clip(undefined)` 返回空串、
    // `Array.isArray` 全 false，输出自然退化成只剩留痕字段。
    // 这样 `dispatch_inspect` 的调用方不必为「退休」写第二条组装路径。
    const reports = Array.isArray(task.reports) ? task.reports : []
    /**
     * 计划（PRD §6.3）：全量步骤**只在这里**给，`card()` 里没有。
     *
     * 为什么已结算任务照样返回：看板不下发 `plan_*` 是为了省 2 秒轮询的带宽
     * （终态 > 计划，PRD-01 §4.3），而 `dispatch_inspect` 是显式查询，不适用那条
     * 取舍——「完了，但它当时分了几步、哪步没做」恰恰是事后最想查的事。
     *
     * 边界（PRD §6.5）：`task.plan` 不是数组、或任一步缺 `text`，整份按空计划处理
     * （不输出 `plan`）。不输出「半份计划」是刻意的：一个只有 status 没有正文的
     * 步骤会让调用方以为「这步没写文案」，而实际是账本坏了——两种事实不该长得一样。
     * 截断不在这里标记：入库时已经截到上限，能存下来的部分就是全部事实，
     * 截断标记走报告回执的 `plan_truncated`。
     */
    let plan
    if (Array.isArray(task.plan) && task.plan.length
      && task.plan.every(step => step && typeof step.text === 'string' && step.text)) {
      plan = task.plan.map(step => ({
        text: step.text,
        // 与 `normalizePlan()` 同一口径：未知状态按 pending（缺省按未开始），
        // 不把脏值原样透出去让调用方自己猜区间。
        status: PLAN_STATUSES.has(step.status) ? step.status : 'pending',
      }))
    }
    return {
      ...this.card(task),
      brief: clip(task.brief, 2000),
      cwd: task.cwd,
      ...(task.briefTruncated ? { brief_truncated_to: task.brief.length } : {}),
      ...(reports.length ? { recent_reports: reports.slice(-5) } : {}),
      ...(task.lastText ? { last_worker_text: clip(task.lastText, 3000) } : {}),
      // 计划（详情独有）：步骤数组只在这里出现。
      ...(plan ? { plan } : {}),
      // 依赖的排查字段（PRD §6.3）。`depends_on` / `blocked_by` 已经由 `card()`
      // 投影过，这里只补三个「出过这件事才有」的可选键；空值不输出，避免详情里
      // 堆一排空数组/空串。字段名与看板逐字一致（`blocked_reason` / `cancel_reason`
      // / `error_code`），不新造驼峰别名。
      ...(task.blockedReason ? { blocked_reason: task.blockedReason } : {}),
      ...(task.cancelReason ? { cancel_reason: task.cancelReason } : {}),
      ...(task.errorCode ? { error_code: task.errorCode } : {}),
      // P0-4：归档是「只读冻结」，冻结时刻要能在详情里看到。
      // 注意归档与退休是两件事：归档 = 会话收了（任务还在表里，可取消归档）；
      // 退休 = 任务记录移出活表（只在 retired 留痕）。所以归档用 frozenAt，
      // **不能**复用 retiredAt——那会让「已归档」被误读成「已退休」。
      ...(task.frozenAt ? { frozen_at: task.frozenAt } : {}),
      // P0-5：退休记录的两个关键字段。它们只在 retiredCard() 里出现，
      // 这里重复一次是为了让「退休记录也能过 detail()」这件事显式可见。
      ...(task.retiredAt ? { retired_at: task.retiredAt } : {}),
      ...(task.retiredReason ? { retired_reason: task.retiredReason } : {}),
    }
  }

  /**
   * 按 id 查任务：先查活表，再查退休留痕（P0-5）。
   *
   * 返回**对象本身**（活任务 或 退休记录），查不到返回 undefined——这是与
   * board/client 共享的字面契约。判定「这是不是退休记录」看
   * `retiredReason` 有没有值：退休记录一定带它，活任务一定不带
   * （活任务的归档标记是 `archivedAt` / `frozenAt`，与退休是两个概念）。
   *
   * 为什么需要它：退休之后 `table.get()` 返回 undefined，而
   * 「没有任务 xxx」在本插件里是**用户点错了/任务不存在**的意思。退休的
   * 任务不是不存在，它是「存在过、被收起、原因可查」。两者混成一个错误
   * 就等于静默丢历史。
   *
   * @returns {object | undefined} 活任务、退休记录，或 undefined
   */
  resolveTask(id) {
    const key = String(id ?? '')
    return this.table.get(key) ?? this.retired.get(key)
  }

  /** 这条记录是不是退休留痕（而非活任务）。 */
  isRetired(record) {
    return !!record && typeof record.retiredReason === 'string' && record.retiredReason !== ''
  }

  /**
   * 把退休记录投影成一张**任务形状**的卡片，让 `dispatch_inspect` 的输出
   * 对调用方保持同一个形状（`{task: {...}}`），不必让模型学一套新字段。
   *
   * 注意这里返回的是**内部形状**（camelCase，`retiredAt` / `retiredReason`），
   * 因为它是给 `detail()` 吃的——`detail()` 再统一转成 snake_case。
   * 早先的版本在这里直接写 `retired_at`，结果是 `detail()` 读
   * `task.retiredAt` 拿到 undefined，`dispatch_inspect` 输出的退休时刻为空：
   * 两个「同名字段」的两种拼法之间没有任何编译期约束，只能靠一条用例钉住。
   *
   * @param {object} record `this.retired` 里的记录
   */
  retiredCard(record) {
    return {
      ...record,
      // `card()`/`detail()` 读的都是这几个 camelCase 字段；退休记录没有
      // reports / lastText / brief，留空让它们自然退化成「无正文」。
      reports: [],
      lastText: '',
      // 最后一条摘要对退休记录是**唯一**可读的正文残留，放进 lastText 让
      // `card().summary` 能落到它上面（card 在没有 reports 时读 lastText）。
      ...(record.summary ? { lastText: record.summary } : {}),
    }
  }

  // ---------------------------------------------------------------- 候选

  /**
   * `dispatch_candidates` 的实现：**只读候选 + 判定素材**。
   *
   * 这个方法的全部职责是**缩小范围**（本会话、已结算、时间窗内、同域）并把
   * 能让模型判断「这是不是接着上一条」的素材摊开——标题、简报、最后一条报告的
   * 摘要、终态、结束时点、线程、是否已有后继/活跃任务。**它不做语义判断**：
   * 没有相似度、没有权重、没有阈值、没有推荐排序（排序只有「结算时间降序」
   * 这一条确定性规则）。接不接由调用方（主会话的模型）显式传 `handoff_from` 决定。
   *
   * 为什么不在这里判定「像不像」：插件零运行时依赖、没有任何调用模型的通道，
   * 账本里也没有代码/diff/意图；任何「插件自己判断」最终都只能退化成写死的
   * 字符串匹配。误判代价不对称（错接会把旧结论、旧模型、旧权限一起带进新任务，
   * 且基本不可逆；漏接只是多一条会话），所以判定权必须留在模型手里。
   *
   * 取数规则（与 plans/11 §3.4 逐条对齐）：
   * 1. 范围：`table.ofSession(agent.id)`（只看本会话派出的任务，跨会话复用一律拒绝）；
   * 2. 排除 cancelled / archived / 退休 / 未结算；退休记录不在活表，单独从
   *    `this.retired` 计数（它的正文不搬出来，只让 `excluded.retired` 可回答
   *    「为什么没有候选」）；
   * 3. 时间窗：`settledAt ?? updatedAt` 距今 ≤ `days` 天（缺失时标 `updatedAt-fallback`）；
   * 4. 同域：`sameDir(task.cwd, scope.cwd)`；给了 workspace 时还要求
   *    `task.workspaceId` 一致（来源没有 id 时按 cwd 比，与 `#handoffSource()` 同一判据）；
   *    `all_workspaces: true` 时跳过（返回 `scope.same_domain: false`）；
   * 5. 排序：`settled_at` 降序，同刻按 `createdAt` 降序——**不按「像不像」排**；
   * 6. 截断到 `limit`；`excluded` 按原因累加。
   *
   * 只读保证：本方法**不写账本、不建任务、不碰会话**。`reuse_check` 也只报告
   * 事实（这条会话现在忙不忙），真正的校验仍然只在 `dispatch_launch` 里发生一次。
   *
   * @param {object} agent 调用者（主会话）
   * @param {{limit?: number, days?: number, cwd?: string, workspace?: string, allWorkspaces?: boolean}} [input]
   * @returns {Promise<object>} `{candidates, count, considered, excluded, scope, note}`
   */
  async candidates(agent, input = {}) {
    const cfg = this.config
    /** 取一个整型参数并夹到区间里：越界按边界处理，不做静默丢弃。 */
    const clampInt = (value, fallback, min, max) => {
      const raw = Number(value)
      const base = Number.isFinite(raw) ? Math.trunc(raw) : Math.trunc(Number(fallback))
      const safe = Number.isFinite(base) ? base : min
      return Math.min(max, Math.max(min, safe))
    }
    const days = clampInt(input.days, cfg.handoffCandidatesDays, 1, 30)
    const limit = clampInt(input.limit, cfg.handoffCandidatesLimit, 1, 10)
    const allWorkspaces = input.allWorkspaces === true

    // 圈定「同域」：显式参数 > 输入框里记住的派发目标 > 会话当前目录。
    // 与 `launch()` 同一套优先级（显式参数压过记住的设置），否则候选范围
    // 会和真正派发时落到的地方不一致。
    const explicitCwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : ''
    const explicitWorkspace = typeof input.workspace === 'string' && input.workspace.trim()
      ? input.workspace.trim()
      : ''
    const target = this.targetFor(agent.id)
    const asked = explicitWorkspace ? await this.workspaces.resolve(explicitWorkspace) : undefined
    if (explicitWorkspace && !asked) {
      // 显式给了 workspace 却解析不到：**不静默退回全量**。那会让调用方以为
      // 「这个工作区里没有候选」，其实它筛的是另一个目录。
      throw fail('NOT_FOUND', `找不到工作区「${explicitWorkspace}」：先用 dispatch_workspaces 看有哪些，`
        + '或去掉 workspace 参数按会话当前目录筛选')
    }
    const useTarget = !explicitCwd && !explicitWorkspace
    const workspaceId = asked?.id ?? (useTarget ? target?.workspace_id : undefined)
    const cwd = explicitCwd
      || asked?.path
      || (useTarget ? target?.path : '')
      || (typeof this.sessions.cwdFor === 'function' ? this.sessions.cwdFor(agent, undefined) : '')
      || ''
    const source = explicitCwd || explicitWorkspace
      ? 'explicit-args'
      : target ? 'session-target' : 'session-cwd'
    // `all_workspaces` 或确实圈不出范围时不按域过滤；`same_domain` 如实反映
    // 「这一次到底有没有做同域筛选」，而不是假装筛过。
    const hasDomain = !allWorkspaces && !!(workspaceId || cwd)

    const inDomain = task => {
      if (!hasDomain) return true
      if (cwd && !sameDir(task.cwd, cwd)) return false
      if (workspaceId) {
        if (task.workspaceId) return task.workspaceId === workspaceId
        // 旧账本没有 workspaceId：按目录比，与 `#handoffSource()` 的兜底判据一致。
        return sameDir(task.cwd, asked?.path || cwd)
      }
      return true
    }

    const excluded = {
      not_settled: 0,
      cancelled: 0,
      archived: 0,
      retired: 0,
      outside_window: 0,
      other_domain: 0,
    }
    const live = this.table.ofSession(agent.id)
    const retired = [...this.retired.values()].filter(record => record.parentSessionId === agent.id)

    const cutoff = Date.now() - days * 24 * 3_600_000
    const entries = []
    for (const task of live) {
      // 排除顺序 = 原因优先级：取消是用户明确收回，归档是只读冻结，
      // 未结算不能当来源，最后才是窗口与同域。每条只记一个原因。
      if (task.status === 'cancelled') { excluded.cancelled += 1; continue }
      if (task.archivedAt) { excluded.archived += 1; continue }
      if (!SETTLED.has(task.status)) { excluded.not_settled += 1; continue }
      const settledAt = task.settledAt || task.updatedAt
      const settledMs = Date.parse(settledAt ?? '')
      if (!Number.isFinite(settledMs) || settledMs < cutoff) {
        excluded.outside_window += 1
        continue
      }
      if (!inDomain(task)) { excluded.other_domain += 1; continue }
      entries.push({ task, settledAt, basis: task.settledAt ? TIME_BASIS.SETTLED : TIME_BASIS.FALLBACK })
    }
    // 退休记录：只计数，不参与候选（它的 brief / reports 已被 `#retire()` 丢弃，
    // 拿不出「判定素材」，也不能当复用来源）。
    excluded.retired += retired.length

    entries.sort((a, b) => {
      const bySettled = Date.parse(b.settledAt ?? '') - Date.parse(a.settledAt ?? '')
      if (bySettled) return bySettled
      return String(b.task.createdAt ?? '').localeCompare(String(a.task.createdAt ?? ''))
    })

    // 全部任务（含退休留痕）一次扫出后继关系：`parentTaskId` 是「谁接过我」的唯一来源。
    const every = [...this.table.tasks.values(), ...this.retired.values()]
    const successorsOf = id => {
      const active = []
      let settledCount = 0
      for (const item of every) {
        if (item.parentTaskId !== id) continue
        if (SETTLED.has(item.status)) settledCount += 1
        else if (active.length < 3) active.push({ task_id: item.id, status: item.status, title: item.title })
      }
      return { active, settled_count: settledCount }
    }

    const project = entry => {
      const task = entry.task
      const reports = Array.isArray(task.reports) ? task.reports : []
      const last = reports.length ? reports.at(-1) : undefined
      const briefText = String(task.brief ?? '')
      const briefCap = Math.max(0, Number(cfg.handoffBriefChars) || 0)
      const summaryCap = Math.max(0, Number(cfg.handoffReportSummaryChars) || 0)
      const activeId = this.table.activeTaskId(task.workerSessionId)
      // 会话忙不忙是**事实**，不是打分：`ok:true` 只表示「没有已知的会话级冲突」，
      // 不等于「建议接」。校验的完整判据（模型/preset/工作区）依赖这次还没出现的
      // launch 参数，所以只在 `dispatch_launch` 里跑；这里不复制第二套判据。
      const busy = !!activeId
      const settledMs = Date.parse(entry.settledAt ?? '')
      return {
        task_id: task.id,
        title: task.title,
        status: task.status,
        settled_at: entry.settledAt ?? null,
        settled_basis: entry.basis,
        age_hours: Number.isFinite(settledMs)
          ? Math.round(((Date.now() - settledMs) / 3_600_000) * 10) / 10
          : null,
        brief: clip(briefText, briefCap),
        brief_chars: briefText.length,
        ...(briefText.length > briefCap ? { brief_truncated_to: briefCap } : {}),
        // 最后一条报告是「它做到了哪一步」最权威的素材：简报只说明要做什么，
        // 摘要才说明做成了什么。没有报告时明确给 null，而不是空对象。
        last_report: last
          ? {
              status: last.status ?? null,
              at: last.at ?? null,
              // `headline` 只在 worker 真的写了的时候出现，不补空串。
              ...(last.headline ? { headline: last.headline } : {}),
              summary: clip(last.summary, summaryCap),
            }
          : null,
        report_count: reports.length,
        // 有报告时不给 last_text：两份「结论」并排会让模型不知道信哪个。
        last_text: reports.length ? null : (task.lastText ? clip(task.lastText, 600) : null),
        error: task.error ? clip(task.error, 200) : null,
        cancel_reason: task.cancelReason ? clip(task.cancelReason, 200) : null,
        thread_id: task.threadId ?? null,
        parent_task_id: task.parentTaskId ?? null,
        workspace_id: task.workspaceId ?? null,
        workspace_title: task.workspaceTitle ?? null,
        host_workspace_id: task.hostWorkspaceId ?? null,
        host_workspace_title: task.hostWorkspaceTitle ?? null,
        cwd: task.cwd ?? null,
        worker_session_id: task.workerSessionId ?? null,
        model: task.model ?? null,
        agent_preset: task.agentPreset ?? null,
        permission_preset: task.permissionPreset ?? null,
        group: task.group ?? null,
        attempt: task.attempt ?? null,
        created_at: task.createdAt ?? null,
        session: { busy, active_task_id: activeId ?? null },
        successors: successorsOf(task.id),
        reuse_check: { ok: !busy, blocked_by: busy ? ['session-busy'] : [] },
      }
    }

    const picked = entries.slice(0, limit)
    return {
      candidates: picked.map(project),
      count: picked.length,
      considered: live.length + retired.length,
      excluded,
      scope: {
        same_domain: hasDomain,
        workspace_id: workspaceId ?? null,
        cwd: cwd || null,
        days,
        limit,
        source,
      },
      note: '只读候选，接不接由你判断；这里没有分数也没有推荐。'
        + '要接就 dispatch_launch({ handoff_from, handoff_reason })。',
    }
  }

  // ---------------------------------------------------------------- 落盘

  /**
   * 关键事实立即落盘：撤销待触发的防抖定时器，直接排进串行写盘链。
   *
   * 为什么需要它：0.8.x 只有 800ms 防抖。实测 4 条 `running` 里至少 1 条
   * 已经 `dispatch_report done`——报告入库与结算都发生在内存里，进程恰好
   * 在这个窗口被 kill，重启后读到的仍是 `running`，于是被 `restore()` 标成
   * `interrupted`，完成率、并发位与看板状态全部不可信。
   *
   * **必须 `await`**：调用方全是 async 方法，等写完再返回，测试夹具删临时
   * 目录时才不会和写盘抢文件句柄（Windows 上表现为 EBUSY）。若在这里用
   * `void` 启动写盘，进程外的清理动作会与它并发——这本身就是「事实已落盘」
   * 这个承诺的漏洞，不只是测试问题。
   *
   * `persist()` 内部是串行 promise 链，后一次一定在前一次写完之后，
   * 不会互相覆盖；错误也在链内吞掉。卸载期间直接跳过——`dispose()` 会
   * 自己 `await persist()` 冲刷最后一次。
   */
  async persistCritical() {
    if (this.disposed) return
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    await this.persist()
  }

  /** 800ms 防抖写盘：密集的状态变化只落一次。 */
  schedulePersist() {
    if (this.persistTimer || this.disposed) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      // P0-4：TTL 清扫挂在防抖回调里，**不新开定时器**。
      // 理由：这些状态变化（投递、读回执、结算）本来就汇流到写盘，
      // 在这里顺手清一次既覆盖了「确实有变化」的时刻，又不会为一条纯内存
      // 清扫拉起常驻链路。代价是最长要等 800ms 才知道过期——对这个
      // 30 分钟量级的 TTL 完全不敏感。
      this.sweepMemory()
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
      .then(() => {
        // 直接调用 persist() 的路径（dispose、测试、看板归档）不经过防抖回调，
        // 所以这里再清一次，保证「任何一次落盘前状态都是清过的」。
        this.sweepMemory()
        return this.#writeOnce()
      })
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
      // 退休留痕按「最老在前」写盘：读回来时保持同样的顺序，`ledgerMaxRetired`
      // 裁掉的就是队头，不需要在恢复时重排。
      const retired = [...this.retired.values()]
      await writeState(this.stateFile, { tasks, targets, retired }, now())
      this.persistError = undefined
    } catch (error) {
      this.persistError = String(error)
      this.warn(`${LOG_PREFIX} 状态落盘失败: %s`, String(error))
    }
  }

  /**
   * 宿主里这条子会话是不是还活着、且正在干活。
   *
   * 只问 `ctx.agents` 这一个活引用（与 `message()`、`#resolveReusedAgent()` 同一口径）：
   * 活引用本身就是「会话存在」的直接证据，不需要额外探测。宿主没装 agents 服务、
   * 或查询抛错时一律返回 false —— 恢复流程不能因为一次探测失败把插件起不来，
   * 那种情况下退回旧行为（一律标 interrupted）也是安全的。
   *
   * 为什么还要看 `status`：会被读到 `idle` 的会话活着但没在干活（重载之前那一轮
   * 就结束了），没有回合会再给它送报告——留成 `running` 会永久占住一个并发位、
   * 而且永远等不到结算。只有「活着且不是在 idle」才值得保留。宿主没暴露这个字段时
   * （`undefined`）按「还活着」处理：宁可等那份迟到的报告，也不要重演这次的误判。
   *
   * 为什么需要它：`restore()` 的旧前提是「进程重启 ⇒ 没有活的 worker」，而插件
   * **热重载**只换插件实例、不销毁宿主的子会话与它正在跑的回合（回归 t-mwcbmq2a-2）。
   */
  #liveWorker(sessionId) {
    if (!sessionId) return false
    try {
      const agent = this.ctx.agents?.get?.(sessionId)
      return !!agent && agent.status !== 'idle'
    } catch {
      return false
    }
  }

  /**
   * 启动时读回任务表与派发目标；进程之间没有活的 worker，所以未结算的一律标为 interrupted。
   *
   * 例外：插件热重载。`#liveWorker()` 能查到的子会话（热重载后仍然活着）保留
   * `running`，不替它宣布死亡——详见下面恢复循环里的活会话兜底。
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
      /**
       * 账本版本不兼容（A4）：**重新抛出**，让 `apply()` 失败、插件不加载
       * （fail-closed）。
       *
       * 为什么不能像「文件损坏」那样 warn 后拿空表继续：空表 + 下一次 `persist()`
       * 会把「插件读不懂的那份账本」整文件覆盖掉。用户升级插件后账本已经没了，
       * 那才是不可逆的损失。拒绝加载只让工具暂时消失，账本还在原地。
       *
       * 为什么先 warn 再抛：`selfCheck()` / 看板都随插件未加载而不可用，
       * 启动日志是唯一出口；异常栈由宿主打印，但可能被静默跳过，所以这里主动留一条。
       */
      if (isLedgerVersionError(error)) {
        this.warn(`${LOG_PREFIX} %s`, String(error?.message ?? error))
        throw error
      }
      // 主文件与备份都不可用：明确报出来，不要静默拿空表继续跑。
      this.warn(`${LOG_PREFIX} 读取历史状态失败（文件已损坏且无可用备份）：%s`, String(error))
      this.restoreError = String(error)
      return
    }

    try {
      let requeued = 0
      let healed = 0
      let resumedBackground = 0
      // 热重载：会话还活着、不能判死的 running 任务（见下面 `#liveWorker()` 那段）
      let keptAlive = 0
      // 被误判成 interrupted、但账本里有更晚的终态报告 —— 按 worker 的结论纠正的条数
      let reconciled = 0
      for (const item of state.tasks) {
        if (!item?.id || !item?.workerSessionId) continue
        const task = {
          ...item,
          reports: Array.isArray(item.reports) ? item.reports : [],
          /**
           * 老数据没有 `threadId`（0.8.x 落盘的 tasks.json）：按**派生规则**补出来，
           * 与「新版本当时就会写下的那个」逐字相同（见 `newThreadId`）。
           *
           * 为什么不「没有就当不同线程」：那会让升级前派的、升级后又在同一条线
           * 上派的任务被算成两条线程，线程预算与线程级归档（阶段 2/3）从一开始
           * 就漏账；而这种漏账只在特定升级时刻出现，事后极难解释。
           *
           * 为什么不报错/不标记：缺这个键是**完全正常的历史形状**，它不是数据损坏。
           * 读不回就警告、就迁移、就拒启动，都是拿一个纯展示字段换插件起不来的风险。
           * 补出来的值只活在内存里，下次 persist 自然落盘——不做一次性迁移脚本。
           */
          threadId: typeof item.threadId === 'string' && item.threadId ? item.threadId : newThreadId(item.id),
          /**
           * 复用关系（plans/08 阶段 2）：老数据没有这个键 → 视为独立任务。
           *
           * 为什么不补一个「看起来合理」的值：`parentTaskId` 的含义是「这条任务的
           * workerSessionId 是另一条任务的会话」。升级前的任务全部是 1:1，它们
           * 本来就没有来源；补出来的任何值都会让一条独立任务假装成复用的产物，
           * 并在线程/复用统计里被多算一次。
           */
          parentTaskId: typeof item.parentTaskId === 'string' && item.parentTaskId
            ? item.parentTaskId
            : undefined,
          /**
           * 依赖（PRD-02 §4.2 / §4.6）：`dependsOn` 随账本原样读回，重启后仍然生效。
           *
           * `blockedBy` / `blockedReason` 是**派生值**（只描述「此刻」谁挡着它），
           * 这里一律清空、由 `#annotateDependencies()` 重算：沿用旧快照会让看板
           * 说「在等一条已经不存在的任务」，而真实的等待原因在重启后早就变了。
           */
          dependsOn: Array.isArray(item.dependsOn)
            ? item.dependsOn.filter(id => typeof id === 'string' && id)
            : undefined,
          blockedBy: undefined,
          blockedReason: undefined,
          /**
           * A6：重试健康度是**纯内存**的派生值（PRD §10.4「不落盘；重启后归零」）。
           *
           * `#writeOnce()` 是对任务对象做 `{...task}`，所以续跑中的任务确实会把
           * `retryHealth` 写进账本；重启后计数表是空的，若照抄这份快照，看板就会
           * 显示一条「重试 2 次」而真实次数是 0。读回时一律丢掉这两项，
           * 让「重启后不再显示 retry_health」由**数据源头**保证，而不是靠渲染层判空。
           */
          retryHealth: undefined,
          retryError: undefined,
        }
        // 血缘字段的不变式：没有来源任务就不该留下 handoffSource / handoffReason。
        // 历史坏数据（或旧版本只写了一半）在这里归一，避免看板出现「来源未知但有理由」的半条记录。
        if (!task.parentTaskId) {
          task.handoffSource = undefined
          task.handoffReason = undefined
          task.handoffReasonTruncated = undefined
        }
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
          /**
           * 后台活巡检随进程一起消失，但账本记着「还有活」（P0-3）。
           *
           * 两个可选服务都还没就绪时**不要**把这条事实抹掉：先原样重挂巡检，
           * 等宿主服务可用后由 `watchBackground()` 自己判；否则一次重启
           * 就会把「后台还在跑」悄悄改写成 interrupted。服务确实在、却查不到
           * 活，说明活已经结束，清掉标记继续走下面的收敛。
           */
          if (task.background) {
            const jobs = this.ctx.get('jobs')
            const subagents = this.ctx.get('subagents')
            const left = jobs || subagents ? await this.backgroundOfWork(task) : task.background
            if (left) {
              task.background = { ...left, since: task.background.since || now() }
              task.updatedAt = now()
              this.table.tasks.set(task.id, task)
              this.pendingBackgroundWatchers.push(task.id)
              resumedBackground += 1
              continue
            }
            task.background = undefined
          }
          /**
           * stale `running` 自愈：账本里已经有终态报告（或一条待结算的
           * `pendingTerminal`），状态却还是 running——说明结算那次落盘丢了，
           * 正是 800ms 防抖窗口内被 kill 的形状。按 worker 自己给的结论收敛，
           * 而不是一律标 interrupted：那会把「已完成」算成「被中断」，
           * 完成率与并发位同时失真（评估 §7 P1-7）。
           */
          const conclusion = task.pendingTerminal && TERMINAL_REPORT.has(task.pendingTerminal)
            ? { status: task.pendingTerminal }
            : [...(task.reports ?? [])].reverse().find(entry => TERMINAL_REPORT.has(entry?.status))
          task.pendingTerminal = undefined
          if (task.status === 'running' && conclusion) {
            this.table.tasks.set(task.id, task)
            this.table.transition(task, conclusion.status, {
              force: !canTransition(task.status, conclusion.status),
            })
            healed += 1
            continue
          }
          /**
           * 活会话兜底（回归 t-mwcbmq2a-2）。上面每一条判据的前提都是「进程重启
           * ⇒ 没有活的 worker」，而**插件热重载**不满足它：重载只换插件实例，
           * 宿主的子会话与它正在跑的回合都还在。此时把它标成 `interrupted`，
           * 等于在 worker 干活时替它宣布死亡——它后来那份 done 报告会被
           * `TaskTable.settle()` 的幂等挡掉，账本永远停在「已中断」。
           *
           * 判据是「宿主里这条会话还在、而且不是在 idle」（与 `message()` 同一口径的
           * `ctx.agents` 活引用，见 `#liveWorker()`）。真重启时它不在（会话随进程没了），
           * 照旧走下面的 interrupted；活会话万一之后还是死了，`agent/disposed` 与
           * `onWorkerIdle()` 这两条现成路径照样会收尾。
           *
           * 只对 `running` 生效：`queued` 带着上一轮 `startedAt` 的任务不在队列里，
           * 保留它反而会让它卡死；那种情况仍按原逻辑收敛成 interrupted。
           */
          if (task.status === 'running' && this.#liveWorker(task.workerSessionId)) {
            keptAlive += 1
            this.log(`${LOG_PREFIX} 重启后任务 %s 的子会话 %s 仍然活着：保留 running，不标 interrupted`,
              task.id, task.workerSessionId)
            this.table.tasks.set(task.id, task)
            continue
          }
          /**
           * 这里必须走正规入口，不能裸写 `task.status`（plans/09 P0）。
           *
           * 裸写的代价有两层：`interrupted` 在 `SETTLED` 里是终态，裸写不会写
           * `settledAt`，于是 `stats.js` 的 `settleTimeOf()` 只能回退 `updatedAt`
           * 并把它计进 `coverage.fallbackCount` / `timeBasis: 'updatedAt-fallback'`
           * ——一条**刚恢复的新任务**被标成「旧数据欠账」，回退计数就此失去诊断意义。
           *
           * `force` 按实际判据决定，不是一律加上：`running → interrupted` 是
           * `TRANSITIONS.running` 里的合法边，不需要 force；但 `queued` 带着上一轮的
           * `startedAt`（`retry()` 的 `reopen()` 只清 `settledAt`、不清 `startedAt`）
           * 也会落到这里，而 `queued → interrupted` **不在**跃迁表里。对这种任务用
           * 普通 transition 会被静默拒绝（只加 `rejectedTransitions` 计数），任务永远
           * 卡在 `queued`、既不在队列里也不再被 pump 推进——比裸写更糟。所以用
           * `canTransition` 的返回值决定，而不是靠猜。
           *
           * 队列/唤醒安全：此刻任务是从 state 里重建出来的对象、**还没进** `table`，
           * 队列里也不可能有它（队列只装本进程登记过的 id），`transition` 里那两句
           * 队列维护对它都是空操作；`waiters` 不归 `transition` 管（只有 `settle`
           * 唤醒），但重启恢复发生在启动阶段、还没有任何调用方在等，无需唤醒。
           */
          this.table.transition(task, 'interrupted', { force: !canTransition(task.status, 'interrupted') })
        } else if (task.status === 'interrupted') {
          /**
           * 「假定死亡」被更晚的终态报告推翻（回归 t-mwcbmq2a-2 的存量修法）。
           *
           * `interrupted` 是推断，账本里的终态报告才是 worker 自己的结论。判据是
           * **报告晚于 settledAt**：那才证明「我们宣布它死之后它其实还活着、还给了
           * 结论」。只比「有没有终态报告」会误伤——前置被 retry 重开的任务会留着
           * 上一轮的 done，那不是这一轮的事实。
           *
           * 纠正必须现在做，而不是留给「下一次报告」：任务已经收工，不会再有报告；
           * 不纠正的话，一条已完成的任务会永久显示成「已中断」，完成率与后继判定
           * 都跟着错。
           */
          const announcedAt = Date.parse(task.settledAt)
          const late = Number.isFinite(announcedAt)
            ? [...task.reports].reverse().find(entry => TERMINAL_REPORT.has(entry?.status)
              && typeof entry.at === 'string' && Date.parse(entry.at) > announcedAt)
            : undefined
          if (late) {
            /**
             * 结算时刻用**报告自己的时刻**：误判那一笔（事故里是 16:20:08）比真实
             * 收尾早了 20 分钟，沿用它会让完成时刻、按天趋势、占用时长一起前移。
             * `#markSettled()` 幂等（见到已有值就不写），所以先写正确的值再 transition。
             */
            const announcedIso = task.settledAt
            task.settledAt = late.at
            // 先进表再 transition：`transition()` 的绑定维护会校验「这条任务在不在表里」，
            // 顺序反了（先 transition 再进表）它会把这次状态变化当成别的任务的事。
            this.table.tasks.set(task.id, task)
            this.table.transition(task, late.status, { force: true })
            this.warn(`${LOG_PREFIX} 任务 %s 被判成 interrupted（%s），但它在 %s 报了 %s：按 worker 的结论纠正`,
              task.id, announcedIso, late.at, late.status)
            reconciled += 1
            continue
          }
        }
        this.table.tasks.set(task.id, task)
      }
      if (requeued) this.log(`${LOG_PREFIX} 重启后重新入队 %d 个未启动的任务`, requeued)
      if (resumedBackground) this.log(`${LOG_PREFIX} 重启后待重挂 %d 个后台活巡检`, resumedBackground)
      if (keptAlive) this.log(`${LOG_PREFIX} 重启后保留 %d 条活会话支撑的 running 任务`, keptAlive)
      if (reconciled) this.warn(`${LOG_PREFIX} 重启后按晚到的终态报告纠正 %d 条误判的 interrupted`, reconciled)
      if (healed) this.log(`${LOG_PREFIX} 重启后按账本里的终态报告纠正 %d 条 stale running`, healed)
      // P0-5：退休留痕读回 `this.retired`，**绝不当活任务恢复**。
      // 它们是「已经决定不再参与计算」的记录：塞回 table.tasks 会让它们
      // 重新给指标投票，等于没退休；而恢复时再跑一次 enforceLedgerCap 也没必要——
      // 能落盘就说明当时已经过一遍上限判据，重复判只会白改一遍状态。
      let retiredCount = 0
      for (const record of state.retired) {
        if (!record?.id) continue
        this.retired.set(record.id, record)
        retiredCount += 1
      }
      // 读回的留痕也可能超过上限（旧文件 + 上限调小）：只裁不留痕，不要再写回盘，
      // 下一次 persist 自然收敛。
      this.#trimRetired()
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
      /**
       * 无 `version` 的极旧账本（A4）：按现有「缺字段按空读」正常启动，
       * 只在 `restoreError` 与日志里留一条 warn。
       *
       * 为什么不拦：它没有「未来格式」的覆盖风险——缺字段本身就说明是旧版写的，
       * 现有 `normalize()` 能完整解释；拦下来只会让老用户升级即不可用。
       * 不写 `missingVersion` 进账本：这是读取期的一次性提示，不是任务数据。
       */
      if (state.missingVersion) {
        const note = '账本缺少 version，按旧格式读取'
        this.warn(`${LOG_PREFIX} %s`, note)
        this.restoreError = this.restoreError ? `${this.restoreError}; ${note}` : note
      }
      this.log(`${LOG_PREFIX} 读回 %d 个历史任务、%d 个退休留痕、%d 个派发目标（%s）`,
        this.table.tasks.size, retiredCount, this.targets.size, this.stateFile)
    } catch (error) {
      this.warn(`${LOG_PREFIX} 恢复历史状态失败: %s`, String(error))
      this.restoreError = String(error)
    }
    /**
     * PRD-02 §4.6：恢复收敛——重建完 `table` 与 `retired` 之后、**第一次 pump 之前**，
     * 把「前置已经 interrupted / failed / 缺失」的后继按 §4.4 连带取消。
     *
     * `restoring` 挡住 `settle()` → `pump()` 的嵌套启动：此刻工具还没注册、工作区
     * 还没 provision，启动 worker 比不启动危险得多。等 `apply()` 末尾那次 pump 用
     * **同一份** `takeRunnable(blockedBy)` 判定接手，恢复期与运行期不会分叉。
     */
    this.restoring = true
    try {
      this.#convergeDependencies()
    } finally {
      this.restoring = false
    }
    // P0-5：读回之后判一次上限（幂等，通常什么都不做）。这里判的是**活表**
    // 是否超限（配置被调小、换了更严的配置），而不是把刚读回的留痕再退休一遍
    // ——留痕从来没进过 `table.tasks`，天然不可能被二次退休。
    // 不在这里判的代价：上限要等到下一次结算才生效，期间 tasks.json 已经超了。
    this.enforceLedgerCap()
    // 恢复本身就是一次状态变更（interrupted / stale 自愈 / 巡检待重挂），
    // 必须固化，否则下次重启会对同一批任务重复判一次。
    await this.persistCritical()
  }

  /**
   * 恢复后的依赖收敛（PRD-02 §4.6）。
   *
   * 只做两件事，且都用**运行期同一份代码**：`#annotateDependencies()` 算出谁还在等、
   * 谁等的东西已经没了；对「确定没成」的后继走 `#cancelDependents()`。
   * 前置仍是 `queued`（也在恢复队列里）的任务保留等待，启动顺序由随后的 pump 保证。
   *
   * 为什么循环而不是单次：取消本身改变状态（B 被取消 → C 的「前置」从 queued 变成
   * cancelled），所以取消完必须重算一遍。正常账本一轮就收敛；`#cancelDependents()`
   * 返回 0（例如重入闸挡住了内层）时立即退出，不会空转。
   */
  #convergeDependencies() {
    for (;;) {
      const doomed = this.#annotateDependencies()
      if (!doomed.length) return
      if (!this.#cancelDependents(doomed)) return
    }
  }

  /**
   * 账本封顶（P0-5，幂等）。
   *
   * 判据两条，任一成立就退休（`RETIRED_REASONS` 对应两条）：
   * - **条数**：`table.tasks.size > ledgerMaxTasks`
   * - **天数**：存在「非活跃（已结算、非 running/queued）且 `updatedAt` 早于
   *   `ledgerMaxDays` 天」的任务
   *
   * 退休顺序：**已归档优先，其次最老 `updatedAt`**。为什么归档优先——归档
   * 是用户已经明确表示「不想再看」的动作，它比「单纯很老」更该先走。
   *
   * 退休做两件事：从 `table.tasks` / `table.queue` 移出，往 `this.retired`
   * 写一条薄记录。**不搬 reports**——搬了等于把正文换了个地方存，容量上限
   * 就成了笑话；只留 `summary`（最后一条报告的单行摘要）与计数。
   *
   * 触发点：`settle()` 后、`archiveStale()` 后、`restore()` 后各一次。
   * 都不新开定时器：体积增长只发生在这些点，幂等调用没有代价。
   *
   * @returns {{ retired: number, reasons: Record<string, number> }}
   */
  enforceLedgerCap() {
    // 与 `archiveAfterHours: 0 表示不归档` 保持同一套约定：<= 0 或非数字 = 不限制。
    // 这样用户想关掉治理时不用去理解「0 到底是一个很严的上限还是关闭」。
    const rawMaxTasks = Number(this.config.ledgerMaxTasks)
    const maxTasks = Number.isFinite(rawMaxTasks) && rawMaxTasks > 0 ? rawMaxTasks : undefined
    const maxDays = Number(this.config.ledgerMaxDays)
    const cutoff = Number.isFinite(maxDays) && maxDays > 0 ? Date.now() - maxDays * 86_400_000 : undefined
    /** 退休原因计数（供日志/自检，不落盘）。 */
    const reasons = {}

    /** 非活跃 = 已结算且不在跑。running/queued 永远不退休：它们还会写。 */
    const isInactive = task => SETTLED.has(task.status) && task.status !== 'running' && task.status !== 'queued'
    const updatedAtOf = task => Date.parse(task.updatedAt ?? '') || 0

    /**
     * 候选按「最该先走」排序：已归档优先 → 更老的 updatedAt 优先。
     * 排序键用 `updatedAt` 的数字而不是字符串比较：ISO 串能比大小，但
     * 一旦有任务写了不带毫秒的旧格式，字典序与时间序就会分岔。
     */
    const candidates = () => [...this.table.tasks.values()]
      .filter(isInactive)
      .sort((a, b) => (!!b.archivedAt - !!a.archivedAt) || (updatedAtOf(a) - updatedAtOf(b)))

    let retired = 0
    // 1) 天数：先按超期条件逐个退休。这一条与条数无关——即使总量很少，
    //    放了 90 天没人碰的记录也不该继续给指标投票。
    if (cutoff !== undefined) {
      for (const task of candidates()) {
        if (updatedAtOf(task) >= cutoff) continue
        this.#retire(task, RETIRED_REASONS.CAP_DAYS)
        reasons[RETIRED_REASONS.CAP_DAYS] = (reasons[RETIRED_REASONS.CAP_DAYS] ?? 0) + 1
        retired += 1
      }
    }
    // 2) 条数：还超就继续按同样的顺序退休，直到回到上限。
    //    重新取一次候选：上一轮已经改过 table.tasks。
    //    `maxTasks === undefined` 表示「不设条数上限」（配置 <= 0），此时跳过。
    if (maxTasks !== undefined && this.table.tasks.size > maxTasks) {
      for (const task of candidates()) {
        if (this.table.tasks.size <= maxTasks) break
        this.#retire(task, RETIRED_REASONS.CAP_COUNT)
        reasons[RETIRED_REASONS.CAP_COUNT] = (reasons[RETIRED_REASONS.CAP_COUNT] ?? 0) + 1
        retired += 1
      }
    }
    if (retired) {
      this.log('%s 账本封顶：退休 %d 个任务（%s），留痕 %d 条',
        LOG_PREFIX, retired, JSON.stringify(reasons), this.retired.size)
      this.schedulePersist()
    }
    return { retired, reasons }
  }

  /**
   * 把一个任务移出活表并写一条退休留痕。
   *
   * 只删 `table.tasks` / `table.queue`，**不动** worker 会话（归档是别的事），
   * 也不动 `reports`（它们随任务记录一起消失——这是「退休」的定义，
   * 详见计划书 G4：退休记录带「何时、为什么」，不承诺正文）。
   */
  #retire(task, reason) {
    const at = now()
    const last = Array.isArray(task.reports) && task.reports.length ? task.reports.at(-1) : undefined
    const record = {
      id: task.id,
      title: task.title,
      status: task.status,
      parentSessionId: task.parentSessionId,
      workerSessionId: task.workerSessionId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      // 可选字段显式写 null 而不是留 undefined：留 undefined 会被
      // `JSON.stringify` 整个丢掉，落盘后「这条记录有没有归档过」就只能靠
      // 字段**不存在**来判断，读回方再也分不清「没有」与「存的时候就没值」。
      archivedAt: task.archivedAt ?? null,
      retiredAt: at,
      retiredReason: reason,
      workspaceTitle: task.workspaceTitle ?? null,
      reportCount: Array.isArray(task.reports) ? task.reports.length : 0,
      summary: oneLine(last?.summary ?? task.lastText ?? '', 200),
      // 线程标识跟着留痕走：退休是「移出活表、原因可查」，而「它属于哪条线程」
      // 恰恰是事后回答「这条工作线怎么结束的」唯一还剩下的线索。缺了它，
      // 线程级统计会把这条任务算成一条孤儿线程（阶段 2/3 的线程视图直接用这个字段）。
      threadId: task.threadId,
      // 复用关系跟着留痕走：与 threadId 同样处理。事后要回答「这条任务沿用的是
      // 哪条任务的会话」（以及它的上下文从哪来），只有这个字段还留着；留 null
      // 而不是 undefined，落盘后才分得清「独立任务」与「字段丢了」。
      parentTaskId: task.parentTaskId ?? null,
      // 交接原因的审计字段：退休之后仍要能回答「当时为什么接了上一条」。
      // 它不参与任何判定，所以照原样搬走即可。
      handoffSource: task.handoffSource ?? null,
      handoffReason: task.handoffReason ?? null,
      handoffReasonTruncated: task.handoffReasonTruncated ?? null,
    }
    // 走 `table.remove()` 而不是裸删：删除与**解绑活跃任务**必须是同一个动作
    // （见 TaskTable.remove 的注释）。裸删会留下指向不存在任务的绑定键，
    // 虽然查询会自愈，但「删掉的任务仍是这条会话的活跃任务」本身就是错的。
    this.table.remove(task.id)
    this.retired.set(task.id, record)
    this.#trimRetired()
    return record
  }

  /**
   * 留痕列表封顶：超过 `ledgerMaxRetired` 丢最老的（Map 保持插入顺序，
   * 而插入顺序就是退休顺序）。
   */
  #trimRetired() {
    const max = Math.max(1, Number(this.config.ledgerMaxRetired) || 5000)
    while (this.retired.size > max) {
      const oldest = this.retired.keys().next()
      if (oldest.done) break
      this.retired.delete(oldest.value)
      this.retiredDropped += 1
    }
  }

  /**
   * 记忆治理的当前口径（P0-1，host 只提供口径，不算派生指标的漂亮数字）。
   *
   * 形状是与看板/文档共享的契约，**字段名不得改**。它回答的是
   * 「现在这套治理到底发生了什么」：
   * - `window`：指标窗口（最近 N 天 / M 条），`since` 是窗口起点；
   * - `ledger`：活表规模、退休数、归档数、被丢的留痕数、单条预算；
   * - `admission`：准入决策计数（direct / ledger）与当前直通状态列表；
   * - `pending`：仍在 TTL 内的「已投递未读」数，与已降级成 unknown 的数量；
   * - `retired`：留痕条数与最近一次退休时刻。
   *
   * 注意这里的 `ledger.tasks` 是**活表**条数（退休/归档都还在活表里，归档只
   * 打标记不下移），`retired` 是另外一份。两者相加才是「曾经有过多少任务」
   * ——这就是计划书 §七 第 7 条「守恒」的口径。
   */
  async memoryStats() {
    const days = Number(this.config.memoryWindowDays)
    const windowDays = Number.isFinite(days) && days > 0 ? days : 7
    const tasksCfg = Number(this.config.memoryWindowTasks)
    const windowTasks = Number.isFinite(tasksCfg) && tasksCfg > 0 ? tasksCfg : 200
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()

    let archived = 0
    let pendingInputs = 0
    let unknownInputs = 0
    /**
     * 窗口里**实际命中多少条**（未套 `tasks` 条数上限）。
     *
     * 为什么必须有这个数：没有它，`window` 只是一份配置回显（7 天 / 200 条），
     * 而 `ledger.tasks` 报的是**活表全量**（含归档、含窗口外）——两个数摆在一起
     * 谁也解释不了谁，窗口就成了装饰。给出 `count` 之后，
     * 「窗口命中 37 条 / 账本 1200 条」是可以互相核对的两个事实。
     *
     * 口径与客户端「效果条」那一条**完全一致**：按 `updatedAt`（没有则 `settledAt`）
     * 落在 `since` 之后、且**非归档**。归档任务不进效果指标，这里也不计。
     */
    let windowCount = 0
    const sinceMs = Date.now() - windowDays * 86_400_000
    for (const task of this.table.tasks.values()) {
      if (task.archivedAt) {
        archived += 1
      } else {
        const at = Date.parse(task.updatedAt || task.settledAt || '')
        if (Number.isFinite(at) && at >= sinceMs) windowCount += 1
      }
      if (task.inputPendingAt && !task.inputReadAt) pendingInputs += 1
      else if (task.inputUnknownAt && !task.inputReadAt) unknownInputs += 1
    }
    let latestRetiredAt
    for (const record of this.retired.values()) {
      if (!latestRetiredAt || String(record.retiredAt ?? '') > latestRetiredAt) {
        latestRetiredAt = String(record.retiredAt ?? '')
      }
    }
    return {
      window: {
        days: windowDays,
        tasks: windowTasks,
        since,
        // 窗口实际命中的条数（未套 tasks 上限）。窗口从此不是装饰性的配置回显，
        // 而是一个能被 ledger 核对的口径。
        count: windowCount,
      },
      ledger: {
        tasks: this.table.tasks.size,
        retired: this.retired.size,
        archived,
        retiredDropped: this.retiredDropped,
        capPerTask: {
          summary: Math.max(0, Number(this.config.maxReportSummaryChars) || 0),
          detail: Math.max(0, Number(this.config.maxReportDetailChars) || 0),
        },
      },
      admission: {
        direct: this.admissionCounts.direct,
        ledger: this.admissionCounts.ledger,
        // 与 `admissionOf()` 读同一份来源：自检说直通什么，判定就必须直通什么。
        directStatuses: this.directStatuses(),
      },
      pending: { inputs: pendingInputs, unknown: unknownInputs },
      retired: { count: this.retired.size, latestAt: latestRetiredAt ?? null },
      /**
       * P1 新增的两块已读数：合并窗口与投递形态。
       *
       * 为什么放在 `memory` 里而不是另开顶层键：§六 P1-3 要求自检的 memory 块能回答
       * 「注入预算」与「当前窗口」，而这两件恰好是 P1 新增的注入侧治理——
       * 分开放会让「上下文占用」这个话题要翻两个地方才能拼出来。
       *
       * `mergeWindowMs` 是**生效值**（已被 2 秒硬上限夹过），不是配置原值：
       * 自检要回答「现在实际多久合并一次」，回显配置会把配错的值伪装成生效值。
       */
      merge: {
        windowMs: this.mergeWindowMs(),
        pending: this.pendingNotices.size,
        windows: this.mergeStats.windows,
        collapsed: this.mergeStats.collapsed,
        mergeableStatuses: [...MERGEABLE_REPORT_STATUSES],
      },
      projection: {
        full: this.projectionCounts.full,
        digest: this.projectionCounts.digest,
        ledger: this.projectionCounts.ledger,
        budget: {
          // 投进会话的正文预算（P1-2）；超过它才切「摘要 + 指针」。
          view: Math.max(0, Number(REPORT_VIEW.SUMMARY) || 0),
          digest: Math.max(0, Number(REPORT_VIEW.DIGEST) || 0),
        },
      },
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
        /**
         * 追问已投递但 worker 还没读的任务数（持续 >0 通常是那一步挂了）。
         *
         * P0-4 之后必须排除 `inputUnknownAt`：TTL 到期时 `sweepMemory()` 会清
         * `inputPendingAt`，所以这里天然不会重复计数；但如果清理没跑（例如
         * 部署里既没有写盘也没有别的触发点），unknown 存在说明「已经判定为
         * 不知道」，再算成「未读」就是报假警。
         */
        unreadInputs: [...this.table.tasks.values()]
          .filter(task => task.inputPendingAt && !task.inputReadAt && !task.inputUnknownAt).length,
        /** 来源被降级成 user 的投递数（收件箱不可用时走了 prompt）。 */
        degraded: [...this.table.tasks.values()]
          .filter(task => task.delivery?.outcome === 'delivered-degraded').length,
        /** 跨重启投递幂等的实际级别：有 flush 能力才可能是 strong。 */
        durability: typeof this.ctx.get('sessionPersistence')?.flush === 'function' ? 'flush' : 'weak',
        /** 已确认刷到持久化日志的投递数（弱级别部署里恒为 0 是正常现象）。 */
        durableOk: [...this.table.tasks.values()].filter(task => task.delivery?.durable === true).length,
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
      /** 后台活巡检：评估里「真实证据 0 条」的那一块，现在可以随时自查。 */
      background: {
        active: [...this.table.tasks.values()].filter(task => task.background).length,
        watchers: this.backgroundTimers.size,
        pendingRestore: this.pendingBackgroundWatchers.length,
        killedJobs: this.backgroundKills,
        deferredTerminals: [...this.table.tasks.values()].filter(task => task.pendingTerminal).length,
      },
      // P0-1：记忆治理口径。自检是唯一能一次性看到「账本 + 退休 + 待读 + 窗口」
      // 的地方，§七 第 6 条要求这五个数与账本实际值一致，就在这里对账。
      memory: await this.memoryStats(),
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

  /**
   * 这条任务所在的会话上还有没有**未结算**的其它任务。
   *
   * 归档的安全判据（plans/08 §七.3）：`workspaceRegistry.archiveSession()` 收走的是
   * 整条会话，复用之后它可能正被另一条任务使用。归档其中一条任务时若还有别的
   * 未结算任务，**只标记任务、不动会话**——否则另一条正在跑的活会被一起冻住。
   *
   * 只看「未结算」，不看「同线程还有几条历史」：已结算的任务不再写会话，归档
   * 它是安全的，没必要因此把整条线程的会话永远留着。
   */
  #hasActiveSibling(task) {
    if (!task?.workerSessionId) return false
    return this.table.tasksOfWorker(task.workerSessionId)
      .some(other => other.id !== task.id && !SETTLED.has(other.status))
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
      /**
       * 会话还有别的未结算任务 → **只标记任务，不归档会话**。
       *
       * `archiveSession(stopActivity: true)` 会停掉整条会话的活动，而同会话的
       * 另一条任务可能正在跑（plans/08 §三.2 的「归档拆线程」）。这里不调用底层，
       * 并把原因写进 `archiveError`：用户看到的是「已归档 + 一句实话」，而不是
       * 另一条任务莫名其妙被打断。
       */
      const shared = this.#hasActiveSibling(task)
      const result = shared
        ? { ok: false, error: `同会话还有其它未结算任务，本次只标记任务、未归档子会话（${task.workerSessionId}）` }
        : await this.workspaces.archiveSession(task.workerSessionId)
      const archivedAt = now()
      task.archivedAt = archivedAt
      // P0-4 归档冻结：归档是「只读」的开始，冻结时刻必须和归档时刻分开记。
      // 为什么不用 retiredAt：退休是 P0-5 的「移出活表」，两件事的触发点、
      // 后果、可见性都不同。把归档写成退休会让 `dispatch_inspect` 认为
      // 任务已经不可查（其实还在活表里），也让 `memoryStats` 少算一条活任务。
      task.frozenAt = archivedAt
      if (result.ok) {
        task.archiveError = undefined
        archived += 1
        this.log(`${LOG_PREFIX} 已归档子会话 %s（任务 %s）`, task.workerSessionId, task.id)
      } else if (shared) {
        // 安全检查导致的「跳过会话归档」不是失败：任务标记已经写下，另一条任务照常可用。
        task.archiveError = result.error
        archived += 1
        this.log(`${LOG_PREFIX} 任务 %s 已冻结；同会话仍有活跃任务，未归档子会话 %s`,
          task.id, task.workerSessionId)
      } else {
        task.archiveError = result.error
        failed += 1
        this.warn(`${LOG_PREFIX} 任务 %s 归档失败: %s`, task.id, result.error)
      }
    }
    if (scanned) this.schedulePersist()
    // P0-5：归档是退休排序里「更该先走」的一类，刚归档完正是重判一次的时机。
    this.enforceLedgerCap()
    return { scanned, archived, failed }
  }

  /**
   * 单独归档**一个**任务（看板行上的「归档」按钮走这里）。
   *
   * 与 `archiveStale()` 的分工：那个是**巡检**——按 `archiveAfterHours` 扫全表、
   * 只碰超期的、没有「指定这一条」的入口；这里是**手动**——用户点哪条就归档哪条，
   * 不等保留期、不看 `updatedAt`。两者写下的字段完全一致（`archivedAt` +
   * `frozenAt`），所以下游（`boardTask` / `memoryStats` / 退休排序）不需要知道
   * 这次归档是从哪条路来的。
   *
   * 为什么另起一个方法而不是给 `archiveStale()` 加参数：巡检的返回值是
   * `{scanned, archived, failed}` 这种**批量**口径，被 `POST /board/archive`
   * 与启动定时器共用，还钉着既有断言；塞一个「只处理某条」的开关进去，会让
   * 「一次巡检」与「一次单点归档」共用一份返回形状，谁都读不懂哪个字段有用。
   *
   * 三条语义决定：
   * - **未结算一律拒绝**。running/queued 的子会话还在写，归档它等于让一个还在
   *   产出的会话变成只读，任务状态却还是 running——这是数据损坏，不是清理。
   * - **决策 B：子会话归档失败也要落 `archivedAt` + `frozenAt`**，真实原因写进
   *   `archiveError`。用户点归档的意图是「这条别再挡在我面前了」，而会话可能
   *   随重启消失了、也可能是启动就失败的（这类任务**必然**没有活动会话）。
   *   如果失败就不归档，这些任务会永远卡在待办区——那正是用户报的缺陷本身。
   *   但必须留痕：返回值带 `reason`、任务上带 `archiveError`，绝不假装干净成功。
   * - **幂等**。已归档的再点一次不报错、不重写时间戳：`archivedAt` 是「第一次
   *   被归档的时刻」，被重复点击刷新会让看板上的「几小时前归档」反复归零。
   *
   * @param {string} taskId 任务 id（内部 id，即看板的 `task_id`）
   * @returns {Promise<{ ok: true, archived: boolean, reason?: string, task: object }>}
   *   `archived` 表示**本次调用**是否真的写了归档标记（已归档过再调为 false）；
   *   `reason` 只在「归档了但子会话没归档成功」时出现，内容就是 `archiveError`。
   * @throws 任务不存在 / 未结算时抛人类可读错误（路由据此回 404 / 409）
   */
  async archiveTask(taskId) {
    const id = String(taskId ?? '').trim()
    if (!id) throw new Error('需要 task_id')
    const task = this.table.get(id)
    if (!task) throw new Error(`没有任务 ${id}`)
    // 未结算的任务还在写。归档 = 只读冻结，冻一个还在跑的会话没有正确语义。
    if (!SETTLED.has(task.status)) {
      throw new Error(`任务 ${id} 还没结算（${task.status}），不能归档；要停掉它请用取消`)
    }
    // 幂等：已归档就原样返回，**不**刷新 archivedAt / frozenAt。
    if (task.archivedAt) {
      return {
        ok: true,
        archived: false,
        ...(task.archiveError ? { reason: task.archiveError } : {}),
        task,
      }
    }

    /**
     * 会话还有别的未结算任务时，**只冻结这条任务，不归档会话**。
     *
     * 与 `archiveStale()` 共用同一条安全判据（见 `#hasActiveSibling`）：底层
     * `archiveSession()` 收走的是整条会话，复用之后另一条任务可能正在里面跑。
     * 归档失败/跳过都必须留痕——`archiveError` 会让看板显示「已归档 + 原因」，
     * 而不是假装干净成功。
     */
    const shared = this.#hasActiveSibling(task)
    const result = shared
      ? { ok: false, error: `同会话还有其它未结算任务，本次只标记任务、未归档子会话（${task.workerSessionId}）` }
      : await this.workspaces.archiveSession(task.workerSessionId)
    const at = now()
    task.archivedAt = at
    // 与 `archiveStale()` 同一条不变量：归档一定同时写冻结时刻。
    // 两个时刻刻意分开记（当前实现同值），因为冻结的语义是「只读开始」，
    // 将来允许「先冻结、后归档」时这个字段不用改含义。
    task.frozenAt = at
    if (result.ok) {
      task.archiveError = undefined
      this.log(`${LOG_PREFIX} 已归档子会话 %s（任务 %s，手动）`, task.workerSessionId, task.id)
    } else {
      // 决策 B：会话没了也要放行归档，但把原因留在任务上，看板会渲染成
      // 「归档失败：<原因>」——用户看到的是「已归档 + 一句实话」，不是假成功。
      // `shared` 分支同样走这里：任务已冻结，只是会话被有意保留。
      task.archiveError = result.error
      this.warn(`${LOG_PREFIX} 任务 %s 已归档，但子会话 %s 归档失败: %s`,
        task.id, task.workerSessionId, result.error)
    }
    this.schedulePersist()
    // 归档会改变退休排序（已归档的更该先走），与巡检收尾同一处理。
    this.enforceLedgerCap()
    return {
      ok: true,
      archived: true,
      ...(result.ok ? {} : { reason: String(result.error ?? '未知原因') }),
      task,
    }
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
    // P1-1：窗口里躺着的是「已经决定要告诉用户」的内容，随进程消失等于静默丢消息。
    // 必须在 `disposed = true` 之后、persist 之前冲掉：`relay()` 不看 disposed
    //（它只看主会话在不在），所以这里冲得出去；而接着的 persist 能把 delivery
    // 结果一起落盘。
    try { await this.flushNotices() } catch (error) { this.warn('%s 卸载时冲刷合并通知失败: %s', LOG_PREFIX, String(error)) }
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
    // A6 清理点 3：起点表跟着计数一起清。卸载后这个实例就该「什么都没在续跑」，
    // 单清计数会让 `retrySince` 原地留着全部键（PRD §10.8 点名的那处泄露）。
    this.retrySince.clear()
    // 后台巡检同理：卸载后不该再有人去结算任务。
    for (const timer of this.backgroundTimers.values()) clearTimeout(timer)
    this.backgroundTimers.clear()
    this.pendingBackgroundWatchers = []
    this.subagentOf.clear()
    this.sessions.dispose()
    await this.persist()
  }
}
