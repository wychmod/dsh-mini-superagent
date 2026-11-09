/**
 * 派发表与纯函数：并发位、排队、结算、等待都在这里，不碰任何 I/O，
 * 因此可以被 test/tasks.test.js 直接单测。
 */
import { SETTLED, now } from './constants.js'

/**
 * 任务状态跃迁表：**唯一**允许的状态变化来源。
 *
 * 为什么需要它：0.6.0 之前 `task.status` 有 6 个地方裸赋值
 * （`index.js` 的 agent/status、`takeRunnable`、`settle`、`start`、`message`、`retry`），
 * 没有任何一处校验前置状态，于是派生出四个可复现的 bug：
 *
 * - `done` 被 `settle('cancelled')` 覆盖（看板点取消就能改掉已完成任务）
 * - `index.js` 的 running 分支把已结算任务写回 `running`，并发位被幽灵占用
 * - `message()` 对 `queued` 任务置 `running` 但没从队列摘除，排队顺序错乱
 * - `start()` 的 await 窗口里被 cancel，会话仍被创建（僵尸 worker）
 *
 * 表里的键是「当前状态」，值是「允许去往的状态」。终态没有出边
 * （除 `queued` 的 retry 与 `interrupted` 的 retry 这类显式重开，
 * 它们走 `reopen()` 而不是普通跃迁）。
 *
 * @type {Record<string, string[]>}
 */
export const TRANSITIONS = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['done', 'blocked', 'failed', 'ended', 'cancelled', 'interrupted'],
  // 以下为终态：只能被 reopen() 显式重开，不能经普通跃迁进入。
  done: [],
  blocked: [],
  failed: [],
  cancelled: [],
  ended: [],
  interrupted: [],
}

/**
 * 判断一次跃迁是否被允许。
 * @param {string} from 当前状态
 * @param {string} to 目标状态
 */
export function canTransition(from, to) {
  if (!from) return true                    // 尚未写入状态的初始任务
  if (from === to) return false             // 幂等：同状态不算跃迁
  return (TRANSITIONS[from] ?? []).includes(to)
}

/**
 * 派发表：持有任务、并发位与“等待某个任务结算”的等待者。
 * 它自己不做 I/O；落盘由 Dispatch 负责。
 */
export class TaskTable {
  /** @param {number} maxWorkers 同时 running 的上限（至少 1）。 */
  constructor(maxWorkers) {
    this.maxWorkers = Math.max(1, Number(maxWorkers) || 1)
    /** @type {Map<string, object>} */
    this.tasks = new Map()
    /** 按登记顺序排队、尚未开始的 task id。 */
    this.queue = []
    /** 等待结算的 resolver：taskId -> Set<fn>。 */
    this.waiters = new Map()
    /**
     * **显式绑定**：worker 会话 id → 这条会话当前活跃的任务 id（plans/08 阶段 0）。
     *
     * 为什么需要它：0.8.x 的 `byWorker()` 是「扫全表、返回第一个会话 id 匹配的任务」，
     * 这条判据只在「一条会话 = 一条任务」时成立。一旦复用会话（plans/08 模型 B），
     * 同一会话上的第二条任务永远不会被任何查询选中——`dispatch_report`、`agent/status`、
     * `agent/disposed`、读回执全会记到**最早那条**任务上（§三.1 的串账）。
     * 显式绑定把「谁现在归这条会话」从**扫描顺序**里拿出来，变成一条可查、可校验的事实。
     *
     * 为什么不落盘：它是 `tasks` + 各任务 `status` 的**纯函数**——重启时 `restore()`
     * 会把没跑完的任务标成终态，落盘的绑定必然与事实不符，于是要写第二套「修正」
     * 逻辑。派生一份内存态、由状态跃迁自己维护，永远不会自相矛盾。
     * @type {Map<string, string>}
     */
    this.active = new Map()
    /** 被拒绝的跃迁计数：只用于自检，避免静默吞掉调用方的逻辑错误。 */
    this.rejectedTransitions = 0
  }

  get(id) { return this.tasks.get(id) }

  /**
   * 某个 worker Session 对应的任务：**优先返回显式绑定的活跃任务**。
   *
   * 调用点（都在 dispatch.js / index.js，按函数名，行号会漂）：
   * `enforceRouter`、`decorateSubagent`、`workerAncestorOf`（判「这个会话是不是 worker」，
   * 只看真假）、`report`、`onWorkerIdle`、`onWorkerError`（决定**记到哪条任务**）、
   * `index.js` 的 `agent/status` 与 `agent/disposed` 两个订阅（决定**推进/结算哪条**）。
   *
   * 一条会话上只有一条任务时（今天全部场景），绑定必然就是那条，所以这 8 处
   * 的可观察行为与「扫第一个匹配」逐一致；差别只在出现第二条任务时——旧实现固定
   * 指向最早那条，现在指向当前活跃那条。
   *
   * 没有活跃绑定（这条会话上一条任务都没有，或全部已结算）时，退回**与 0.8.x 逐字
   * 相同的规则**——「扫全表、返回第一个会话 id 匹配的任务」。这里是刻意保持旧语义，
   * 不是懒：这一支只在「没有活跃任务」时走到，而那时调用方要的都是「历史上那条」，
   * 1:1 下它与唯一那条任务重合，行为完全不变；改成「最近那条」这类更聪明的规则
   * 会让本次重构多出一个可观察差异，而阶段 0 的验收标准恰恰是**零差异**。
   */
  byWorker(sessionId) {
    const bound = this.activeTaskOf(sessionId)
    if (bound) return bound
    let found
    for (const task of this.tasks.values()) {
      if (task.workerSessionId !== sessionId) continue
      if (found === undefined) found = task        // 先命中的那条（= 旧 rule）
    }
    // 顺手把绑定修好：`start()` 采用宿主换的号、`retry()` 换 attempt 会话都会改写
    // `workerSessionId`，旧键随之作废（`activeTaskId()` 会摘掉它）。这里补上新键，
    // 下一次查询走显式绑定，不必每次重扫全表。
    if (found && !SETTLED.has(found.status)) this.#bind(found)
    return found
  }

  /**
   * 显式绑定的活跃任务 id；没有就返回 undefined。
   *
   * 返回前**校验**绑定：任务可能已被退休（`remove()`）、被 `settle()` 结算、
   * 或被换到了别的会话。对不上就自愈地摘掉这张键——宁可退化成扫描，也绝不
   * 返回一条不属于这条会话的任务。
   */
  activeTaskId(sessionId) {
    if (!sessionId) return undefined
    const id = this.active.get(sessionId)
    if (id === undefined) return undefined
    const task = this.tasks.get(id)
    if (task && task.workerSessionId === sessionId && !SETTLED.has(task.status)) return id
    this.active.delete(sessionId)
    return undefined
  }

  /** 显式绑定的活跃任务对象；语义与 `activeTaskId()` 相同。 */
  activeTaskOf(sessionId) {
    const id = this.activeTaskId(sessionId)
    return id === undefined ? undefined : this.tasks.get(id)
  }

  /** 这条 worker 会话上的全部任务，按登记顺序（阶段 2 的线程视图要用）。 */
  tasksOfWorker(sessionId) {
    const found = []
    for (const task of this.tasks.values()) if (task.workerSessionId === sessionId) found.push(task)
    return found
  }

  /**
   * 这条会话上「有没有任务、有没有活跃的」——三种状态分开说。
   *
   * 为什么需要区分 `none` 与 `settled`：`byWorker()` 对两者都可能返回 undefined
   * （`none`）或一条已结算的任务（`settled`），而调用方要判断的是完全不同的两件事
   * ——「这条会话不是 worker」与「它曾经是 worker，活已经干完了」。混成一个
   * 「没有活跃任务」的布尔，`agent/disposed` 就无法解释自己为什么什么都不做。
   *
   * @returns {'none'|'settled'|'active'} 没有任务 / 有任务但都不活跃 / 有活跃任务
   */
  workerState(sessionId) {
    if (!sessionId) return 'none'
    const tasks = this.tasksOfWorker(sessionId)
    if (!tasks.length) return 'none'
    return tasks.some(task => !SETTLED.has(task.status)) ? 'active' : 'settled'
  }

  /**
   * 从表里摘掉一条任务（退休用），并维护绑定。
   *
   * 为什么要一个方法而不是让调用方 `tasks.delete()`：绑定表会因为裸删而留下
   * 一张指向不存在任务的键，而 `activeTaskId()` 的自愈只发生在**有人查询时**。
   * 把「删任务」和「解绑」放进同一个入口，删完就是一致的。
   *
   * @returns {object|undefined} 被删掉的任务
   */
  remove(id) {
    const task = this.tasks.get(id)
    this.tasks.delete(id)
    this.dequeue(id)
    for (const [sessionId, activeId] of this.active) {
      if (activeId === id) this.active.delete(sessionId)
    }
    // 同会话还有没结算的任务：把绑定交给它（阶段 2 的线程交接）。
    if (task?.workerSessionId) this.#bindActiveRemaining(task.workerSessionId)
    return task
  }

  /** 把绑定指向这条任务（只接受**在表里**的活跃任务）。 */
  #bind(task) {
    if (!task || this.tasks.get(task.id) !== task) return
    const sessionId = task.workerSessionId
    if (!sessionId) return
    this.active.set(sessionId, task.id)
  }

  /**
   * 这条会话上还没有结算的任务里挑一条作为绑定：**正在 running 的优先**，
   * 其次最后登记的那条；一条都没有就清空。
   *
   * 为什么 running 优先而不是「最后登记」：同一个会话同一时刻只能跑一个回合
   * （plans/08 §三.6），所以「这条会话当前在给谁干活」的答案只可能是那条 running
   * 的任务。排在它后面的 queued 任务还没开始，也还没有任何东西会来认领它。
   */
  #bindActiveRemaining(sessionId) {
    if (!sessionId) return
    let active
    let running
    for (const task of this.tasks.values()) {
      if (task.workerSessionId !== sessionId) continue
      if (SETTLED.has(task.status)) continue
      active = task
      if (task.status === 'running') running = task
    }
    const chosen = running ?? active
    if (chosen) this.active.set(sessionId, chosen.id)
    else this.active.delete(sessionId)
  }

  /**
   * 状态变化后同步绑定：活跃 = 绑到它，结算 = 交还。
   *
   * 挂在 `transition()` / `settle()` / `add()` 三个入口后面，是因为它们是**全部**
   * 写 `status` 的地方（`TRANSITIONS` 的注释里定的不变式），绑定因此不会与状态漂开。
   *
   * 一条额外规则：**后来登记的 queued 任务不抢**已经 running 的绑定。同会话串行
   * （plans/08 §三.6），先来的还在干，后来的排队；等它真的转成 running 时走
   * `transition()`，那时才接手。没有这条，阶段 2 里「队尾任务把正在跑的任务挤掉」
   * 会让 `dispatch_report` 记到一条还没开始的任务上——正好是本次要防的串账。
   */
  #syncBinding(task) {
    const sessionId = task?.workerSessionId
    if (!sessionId) return
    // 先扫掉「这张表按别的会话键还指着这条任务」的旧键：`retry()` 会直接改写
    // `workerSessionId`（换 attempt 会话），不扫的话旧键要等到有人查询才自愈。
    for (const [other, activeId] of this.active) {
      if (activeId === task.id && other !== sessionId) this.active.delete(other)
    }
    if (SETTLED.has(task.status)) {
      // 不是当前绑定：与绑定无关，别去动它（否则一条历史任务被登记/结算时
      // 会把别人刚拿到的绑定顺手改掉）。
      if (this.active.get(sessionId) !== task.id) return
      this.active.delete(sessionId)
      this.#bindActiveRemaining(sessionId)
      return
    }
    if (task.status === 'queued') {
      const currentId = this.active.get(sessionId)
      const current = currentId === undefined ? undefined : this.tasks.get(currentId)
      if (current && current !== task && current.status === 'running' && current.workerSessionId === sessionId) return
    }
    this.#bind(task)
  }

  /** 某个主会话派出的任务，最新在前。 */
  ofSession(sessionId) {
    return [...this.tasks.values()]
      .filter(task => task.parentSessionId === sessionId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  /** 正在 running 的任务数（= 已占用的并发位）。 */
  runningCount() {
    let count = 0
    for (const task of this.tasks.values()) if (task.status === 'running') count += 1
    return count
  }

  /**
   * 登记一个任务；queued 的进入队列。
   *
   * 顺手同步显式绑定：这就是「这条会话现在开始归它」的时刻。1:1 场景下它等于
   * 唯一那条任务，所以绑定不改变任何查询结果；而在阶段 2（同会话第二条任务）里，
   * 「后登记的那条成为活跃任务」正是「当前在干活的那条」的定义。
   */
  add(task) {
    this.tasks.set(task.id, task)
    if (task.status === 'queued') this.queue.push(task.id)
    this.#syncBinding(task)
    return task
  }

  /**
   * 唯一的状态写入口：校验跃迁表，拒绝非法跃迁并返回是否生效。
   *
   * 所有改 `task.status` 的地方都必须走这里。非法跃迁只计数、不改状态，
   * 由调用方决定记日志还是当无事发生——绝不静默覆盖。
   *
   * @param {object} task
   * @param {string} status 目标状态
   * @param {{ force?: boolean }} [options] force=true 用于 reopen（明确要重开终态）
   * @returns {boolean} 是否真的改了
   */
  transition(task, status, options = {}) {
    const from = task.status
    if (from === status) return false                 // 幂等：已经在目标状态
    if (!options.force && !canTransition(from, status)) {
      this.rejectedTransitions += 1
      return false
    }
    task.status = status
    // 同一个时刻只读一次表。`updatedAt`（最后一次改动）与 `settledAt`（进入终态）
    // 在**同一次跃迁**里是同一个事实，各读一次 `now()` 就会跨毫秒边界差 1ms，
    // 于是「结算时刻」与「最后更新时间」在同一入口下居然可以不等（实测约 0.08%）。
    // 读一次、写两处，这个相等就成了结构上的必然，而不是碰巧。
    const at = now()
    task.updatedAt = at
    /**
     * 离开终态 = 「结算时刻」这件事**不再成立**。
     *
     * 为什么在这里统一清，而不是留给 `reopen()`：终态没有普通出边，所以任何
     * 「让一条已结算的任务重新活起来」的动作都只能走 `transition(force)`——
     * 续派（`dispatch.message`）就是其中一条。只在 `reopen()` 里清的话，
     * 续派复活的任务会**留着上一轮的 settledAt**：`#markSettled` 是幂等的，
     * 第二次结算看到旧值就不写，于是这条任务的二次结算沿用第一轮时刻，
     * 按天趋势、完成时刻、占用时长全算到旧日期（实测续派后再结算仍是第一轮时刻）。
     *
     * 清在「状态写入口」这一层，`reopen()` 与 `message()` 就共用同一条不变量，
     * 以后再有人加一条复活路径也不会漏。
     */
    if (!SETTLED.has(status)) task.settledAt = undefined
    // 终态也要在这里落 settledAt（plans/09 P0）。`settle()` 是常规入口，
    // 但 `transition()` 是**唯一**的状态写入口，`force: true` 的重开/强改
    // 都从这里过；只在 settle 里写会漏掉「经 force 直接进终态」的路径，
    // 而那些任务恰恰是最难在事后补时间的。两个入口都走 `#markSettled`，
    // 它自己保证只写一次。
    if (SETTLED.has(status)) this.#markSettled(task, at)
    if (status === 'queued' && !this.queue.includes(task.id)) this.queue.push(task.id)
    if (status !== 'queued') this.queue = this.queue.filter(id => id !== task.id)
    // 绑定跟着状态走（见 `#syncBinding`）：重开回到活跃、进终态则交还。
    this.#syncBinding(task)
    return true
  }

  /**
   * 写权威结算时刻（幂等：已有值就不动）。
   *
   * 为什么不能直接 `task.settledAt = now()`：`settle()` 与 `transition()`
   * 都可能把同一个任务送进终态（看板 cancel、启动失败、回合结束各走一条），
   * 而「结算时刻」是一次性事实——第二次写会让一个 3 小时前就 done 的任务
   * 显示成刚刚完成，并行节省与按天趋势跟着一起错。
   *
   * `transition()` 离开终态时会把它清空：任务重新活跃之后，下一次结算是一个**新的**时刻。
   *
   * @param {object} task
   * @param {string} [at] 调用方已经读到的时刻。传了就复用，不再读表——
   *   同一次结算里 `updatedAt` 与 `settledAt` 必须是同一个值，各读一次 `now()`
   *   会在跨毫秒边界时差 1ms（实测约 0.08%），让「结算时刻」与「最后更新时间」
   *   在同一个入口下自相矛盾。不传时回退 `now()`，兼容只想补一个结算时刻的调用点。
   * @returns {boolean} 是否真的写了
   */
  #markSettled(task, at) {
    if (!task || task.settledAt) return false
    task.settledAt = at ?? now()
    return true
  }

  /**
   * 从队列取出下一个能开始的任务，并在返回前就把它置为 running
   * ——也就是“占住这个并发位”。调用方拿到之后无需再判断容量，
   * 并发的 pump 也不会因为都读到旧计数而超发。
   *
   * 占位也走 `transition()`，保证「所有状态变化都经过同一个入口」这条
   * 不变式没有例外；`transition` 会顺手把它从队列里摘掉。
   * 没有空位或队列已空时返回 undefined。
   */
  takeRunnable() {
    if (this.runningCount() >= this.maxWorkers) return undefined
    while (this.queue.length) {
      const id = this.queue.shift()
      const task = this.tasks.get(id)
      if (!task || task.status !== 'queued') continue
      this.transition(task, 'running')
      return task
    }
    return undefined
  }

  /**
   * 标记一个任务进入结算状态，并唤醒等它的等待者。
   *
   * 幂等：已经结算的任务不会被二次结算覆盖（0.6.0 前这里是裸赋值，
   * `done` 能被改成 `cancelled`，看板点一下「取消」就能改掉已完成任务）。
   *
   * @returns {boolean} 是否真的结算了；false 表示任务已经结算过
   */
  settle(task, status) {
    if (SETTLED.has(task.status)) return false        // 已经结算：不覆盖
    task.status = status
    // 与 `transition()` 同一条因果：一次结算只读一次表，`updatedAt` 与
    // `settledAt` 由同一个值写出。读两次就会在跨毫秒边界时得到两个不同的
    // 「同一次结算」时间（实测约 0.08%），统计口径与测试断言都跟着漂。
    const at = now()
    task.updatedAt = at
    // 权威结算时刻：只在这里写一次（`#markSettled` 幂等）。0.8.x 之前各处
    // 拿 `updatedAt` 当结算时刻，而它会被报告、追问、归档、后台巡检反复刷新，
    // 于是「完成时间」在事后还会变——按天趋势与并行节省都建立在它上面。
    this.#markSettled(task, at)
    this.queue = this.queue.filter(id => id !== task.id)
    // 结算 = 这条任务不再是「这条会话当前在干什么」：绑定交还给同会话还没结算的
    // 最后一条（通常没有），于是 `byWorker()` 退回已结算的那条，行为与 0.8.x 一致。
    this.#syncBinding(task)
    const waiting = this.waiters.get(task.id)
    if (waiting) {
      this.waiters.delete(task.id)
      for (const resolve of waiting) resolve(task)
    }
    return true
  }

  /**
   * 把已结算的任务重开成 `queued`（retry 用）。
   * 这是唯一允许离开终态的路径，显式命名以免被误用成普通跃迁。
   *
   * 重开必须清掉 `settledAt`：任务重新活跃之后，「结算时刻」不再存在。
   * 不清的代价很具体——第二次结算时 `#markSettled` 看到旧值就什么都不写，
   * 看板会把这条任务算在**上一次**结算的那一天里，并行节省也按旧的收尾时刻算。
   *
   * 清的动作由 `transition()` 统一做（进入非终态即失效），这里不再重复写一遍：
   * 两处各写一次就多一个可能漏改的地方，而漏改的后果是「静默沿用旧时刻」。
   * @returns {boolean} 是否重开成功（已在 queued/running 时返回 false）
   */
  reopen(task) {
    if (!SETTLED.has(task.status)) return false
    return this.transition(task, 'queued', { force: true })
  }

  /** 从队列里移除一个任务 id（取消时用，幂等）。 */
  dequeue(taskId) {
    this.queue = this.queue.filter(id => id !== taskId)
  }

  /**
   * 等一组任务全部结算；超时后按当前状态返回。
   *
   * 三个坑，都在 0.7.0 修掉：
   * 1. **重复 id**：`settle` 用 `Set` 去重 `finishOne`，但 `remaining` 按数组长度计，
   *    所以 `waitFor([a, a])` 里 a 结算一次后 `remaining` 还是 1，必须等满超时才返回。
   *    现在先按 id 去重。
   * 2. **超时后残留 waiters**：`waiters` 里的条目在超时分支从不清理，
   *    任务长期不结算就一直挂着 resolver。现在超时时统一摘除。
   * 3. **`unref()` 依赖外部事件循环**：定时器 `unref` 后，若事件循环里没有
   *    别的活，超时永不触发。插件进程常驻所以线上不显形，但这是隐性耦合；
   *    保留 `unref`（避免拖住进程退出），同时保证清理逻辑在 resolve 路径上。
   */
  waitFor(tasks, timeoutMs) {
    // 按 id 去重：同一个任务出现两次时 remaining 只该减一次。
    const seen = new Set()
    const unique = []
    for (const task of tasks) {
      if (!task?.id || seen.has(task.id)) continue
      seen.add(task.id)
      unique.push(task)
    }
    const pending = unique.filter(task => !SETTLED.has(task.status))
    if (!pending.length) return Promise.resolve(tasks)

    return new Promise(resolve => {
      let done = false
      /** 收尾：停表、摘掉全部 waiters、resolve。任何路径都只走一次。 */
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        for (const task of pending) {
          const set = this.waiters.get(task.id)
          if (!set) continue
          set.delete(finishOne)
          if (!set.size) this.waiters.delete(task.id)
        }
        resolve(tasks)
      }
      const timer = setTimeout(finish, timeoutMs)
      timer.unref?.()

      let remaining = pending.length
      const finishOne = () => {
        remaining -= 1
        if (remaining > 0) return
        finish()
      }

      for (const task of pending) {
        const set = this.waiters.get(task.id) ?? new Set()
        set.add(finishOne)
        this.waiters.set(task.id, set)
      }
    })
  }
}

/**
 * 把长文本截断到 limit 字符，保留结尾（结尾通常是结论）。
 *
 * 预算按比例分配，不写死 400：0.6.0 之前是 `limit - 400` + `slice(-400)`，
 * 于是 `limit < 400` 时头部预算变负（`slice(0,0)` 为空）、尾部仍取 400，
 * 输出反而比 limit 长——实测 `clip(1000 字, 200)` 返回 417 字。
 * 这类调用在 `reportText` 与 `card` 里都有，会把消息撑出上下文预算。
 *
 * 现在头部与尾部各占一半（小 limit 也成立），提示语本身也算在预算内。
 */
export function clip(text, limit) {
  const value = typeof text === 'string' ? text : ''
  const cap = Math.max(0, Number(limit) || 0)
  if (value.length <= cap) return value
  // 至少留出提示语的长度，避免只剩省略号
  const note = tail => `\n…（已截断 ${value.length - cap} 字符）…\n${tail}`
  const bodyBudget = Math.max(0, cap - 40)               // 给提示语留位置
  const head = Math.floor(bodyBudget / 2)
  const tailLen = bodyBudget - head
  const out = `${value.slice(0, head)}${note(value.slice(-tailLen))}`
  // 兜底：极端小的 limit 下宁可返回硬截断，也不要超长
  return out.length <= cap ? out : value.slice(0, cap)
}

/** 单行摘要，供列表展示。 */
export function oneLine(text, limit = 160) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** 从 Session 事件里取最后一条 assistant 文本；取不到就返回空串。 */
export function lastAssistantText(agent) {
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
