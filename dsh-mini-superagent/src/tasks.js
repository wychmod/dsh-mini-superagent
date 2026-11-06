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
    /** 被拒绝的跃迁计数：只用于自检，避免静默吞掉调用方的逻辑错误。 */
    this.rejectedTransitions = 0
  }

  get(id) { return this.tasks.get(id) }

  /** 某个 worker Session 对应的任务。 */
  byWorker(sessionId) {
    for (const task of this.tasks.values()) if (task.workerSessionId === sessionId) return task
    return undefined
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

  /** 登记一个任务；queued 的进入队列。 */
  add(task) {
    this.tasks.set(task.id, task)
    if (task.status === 'queued') this.queue.push(task.id)
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
    task.updatedAt = now()
    if (status === 'queued' && !this.queue.includes(task.id)) this.queue.push(task.id)
    if (status !== 'queued') this.queue = this.queue.filter(id => id !== task.id)
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
    task.updatedAt = now()
    this.queue = this.queue.filter(id => id !== task.id)
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
