/**
 * 派发表与纯函数：并发位、排队、结算、等待都在这里，不碰任何 I/O，
 * 因此可以被 test/tasks.test.js 直接单测。
 */
import { SETTLED, now } from './constants.js'

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
   * 从队列取出下一个能开始的任务，并在返回前就把它的状态置为 running
   * ——也就是“占住这个并发位”。调用方拿到之后无需再判断容量，
   * 并发的 pump 也不会因为都读到旧计数而超发。
   * 没有空位或队列已空时返回 undefined。
   */
  takeRunnable() {
    if (this.runningCount() >= this.maxWorkers) return undefined
    while (this.queue.length) {
      const id = this.queue.shift()
      const task = this.tasks.get(id)
      if (!task || task.status !== 'queued') continue
      task.status = 'running'
      task.updatedAt = now()
      return task
    }
    return undefined
  }

  /** 标记一个任务进入结算状态，并唤醒等它的等待者。 */
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

/** 把长文本截断到 limit 字符，保留结尾（结尾通常是结论）。 */
export function clip(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 400))}\n…（已截断 ${value.length - limit + 400} 字符）…\n${value.slice(-400)}`
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
