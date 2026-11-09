/**
 * 「同一个入口读一次表」的确定性测试（plans/09 §三.2 的因果钉）。
 *
 * 钉的缺陷：`settle()` / `transition()` 里
 * `task.updatedAt = now()` 与 `#markSettled()` 内部的 `now()` 是**两次独立读表**。
 * 跨毫秒边界时两者差 1ms，于是「结算时刻」与「最后更新时间」在同一入口下
 * 居然可以不等——`test/stats.test.js` 里那条 `assert.equal(settledAt, updatedAt)`
 * 因此偶发假红，实测单条断言 20000 次复现 16 次（约 0.08%）。
 *
 * 为什么不能只靠现有的真时钟测试：真实时钟下这两次读表**绝大多数时候**恰好
 * 落在同一毫秒，相等是「碰巧」而不是「必然」。一条靠运气的断言无法证明实现正确，
 * 只能证明这一次运气不错。所以这里把时钟换成**必然**前进的桩：连续两次读表一定
 * 差 5ms，于是旧实现必然红、修好之后必然绿——结论不再依赖时机。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskTable } from '../src/tasks.js'

/**
 * 装上可控时钟，返回 `{ reads, restore }`。
 *
 * 为什么桩打在 `Date` 而不是 `now`：`src/constants.js` 里
 * `export const now = () => new Date().toISOString()` 是 ESM 的 const 绑定，
 * 不可重新赋值；仓库又是零依赖、不加构建步骤（`mock.module` 在当前 Node 上
 * 需要实验开关，不可用）。而 `new Date()` **正是** `now()` 唯一的读表动作，
 * 桩在它上面等价于桩掉 `now`，且不需要为了让测试能打桩而改产品代码的形状。
 *
 * 影响面严格收窄：只有**无参** `new Date()` 与 `Date.now()` 走桩，
 * `new Date(value)`、`Date.parse`、`Date.UTC` 及其原型方法全部转发给真正的 Date
 * ——被测代码里别的时间解析不会被顺手换掉。`restore()` 在 finally 里调用，
 * 不把全局状态留给同文件后续用例。
 *
 * @param {number[]} values 依次要返回的毫秒时间戳；用完后重复最后一个。
 */
function installClock(values) {
  const RealDate = globalThis.Date
  let reads = 0
  const pick = () => {
    const value = values[Math.min(reads, values.length - 1)]
    reads += 1
    return value
  }

  class StubDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(pick())
      else super(...args)
    }

    static now() { return pick() }
  }

  globalThis.Date = StubDate
  return {
    /** 到目前为止读了几次表。 */
    reads: () => reads,
    /** 必须恢复：全局 Date 是进程级状态。 */
    restore: () => { globalThis.Date = RealDate },
  }
}

const T = Date.parse('2026-01-02T03:04:05.000Z')
/** 每次读表 +5ms：远超真实抖动，且在旧实现下必然造成 settledAt !== updatedAt。 */
const TICK_MS = 5

// ---------------------------------------------------------------- 自检（防止测试空转）

/**
 * 若桩坏了（例如始终返回同一个值），下面两条「同一入口两个字段相等」的断言
 * 会在**旧实现**上也是绿的——那正是这条测试要消灭的「靠运气」。先钉住桩本身。
 */
test('自检：桩让连续两次读表得到不同的时刻', () => {
  const clock = installClock([T, T + TICK_MS])
  try {
    assert.equal(new Date().toISOString(), '2026-01-02T03:04:05.000Z')
    assert.equal(new Date().toISOString(), '2026-01-02T03:04:05.005Z',
      '桩必须真的让第二次读表往前走，否则下面的断言会空转通过')
  } finally {
    clock.restore()
  }
})

test('自检：桩只替换无参 new Date()，带参构造与 Date.parse 不受影响', () => {
  const clock = installClock([T, T + TICK_MS])
  try {
    assert.equal(new Date(0).toISOString(), '1970-01-01T00:00:00.000Z')
    assert.equal(Date.parse('2026-01-02T03:04:05.000Z'), T)
    assert.ok(new Date(0) instanceof globalThis.Date)
  } finally {
    clock.restore()
  }
})

// ---------------------------------------------------------------- 因果钉

/**
 * `settle()` 是常规结算入口：`updatedAt`（事实：最后一次改动）与
 * `settledAt`（事实：进入终态）在这一次结算里是**同一件事**，必须取同一个值。
 */
test('settle 只读一次表：settledAt 与 updatedAt 恒等（时钟前进也不例外）', () => {
  const clock = installClock([T, T + TICK_MS, T + TICK_MS * 2])
  try {
    const table = new TaskTable(4)
    const task = table.add({ id: 'a', status: 'running', reports: [] })

    assert.equal(table.settle(task, 'done'), true)
    assert.equal(task.updatedAt, new Date(T).toISOString(),
      'updatedAt 必须就是当次读到的时刻')
    assert.equal(task.settledAt, task.updatedAt,
      '同一次结算写出的两个时间字段必须相等；不等说明读了两只不同的表')
    assert.equal(clock.reads(), 1,
      '一次结算只该读一次表：读两次就有跨毫秒漂移的可能，靠碰巧相等不算正确')
  } finally {
    clock.restore()
  }
})

/**
 * `transition()` 是**唯一**的状态写入口（看板 cancel、启动失败、重启恢复都走它），
 * 所以同一条因果在这里也要成立：强改进终态时两个字段由同一个值写出。
 */
test('transition 强改进终态只读一次表：两个时间字段恒等', () => {
  const clock = installClock([T, T + TICK_MS, T + TICK_MS * 2])
  try {
    const table = new TaskTable(4)
    const task = table.add({ id: 'b', status: 'running', reports: [] })

    assert.equal(table.transition(task, 'interrupted', { force: true }), true)
    assert.equal(task.updatedAt, new Date(T).toISOString())
    assert.equal(task.settledAt, task.updatedAt,
      '经 transition 进终态时，结算时刻与最后更新时刻必须来自同一次读表')
    assert.equal(clock.reads(), 1)
  } finally {
    clock.restore()
  }
})

/**
 * 已知的**合法例外**：普通跃迁到非终态时只写 `updatedAt`，不写 `settledAt`，
 * 所以这里只需要一次读表；把它钉住是为了防止有人为了「让两个字段相等」
 * 反过来给非终态也写结算时刻——那会让 completion 指标把活跃任务算成已完成。
 */
test('非终态跃迁只写 updatedAt，不产生 settledAt', () => {
  const clock = installClock([T, T + TICK_MS])
  try {
    const table = new TaskTable(4)
    const task = table.add({ id: 'c', status: 'queued', reports: [] })

    assert.equal(table.takeRunnable().id, 'c')
    assert.equal(task.updatedAt, new Date(T).toISOString())
    assert.equal(task.settledAt, undefined, 'running 不是终态，不该有结算时刻')
    assert.equal(clock.reads(), 1, '非终态跃迁只读一次表')
  } finally {
    clock.restore()
  }
})
