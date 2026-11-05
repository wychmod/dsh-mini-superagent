/**
 * 纯逻辑单测：并发位、排队、结算、等待、文本截断。
 * 只覆盖 tasks.js / constants.js，不需要宿主环境，`npm test` 直接跑。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { SETTLED } from '../src/constants.js'
import { TaskTable, clip, oneLine } from '../src/tasks.js'

/** 造一个最小任务对象；createdAt 递增，便于验证排序。 */
function makeTask(id, overrides = {}) {
  return {
    id,
    status: 'queued',
    createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
    updatedAt: '',
    workerSessionId: `dispatch-${id}`,
    parentSessionId: 's1',
    reports: [],
    ...overrides,
  }
}

test('takeRunnable 在并发位用尽时返回 undefined', () => {
  const table = new TaskTable(2)
  table.add(makeTask('a'))
  table.add(makeTask('b'))
  table.add(makeTask('c'))

  assert.equal(table.takeRunnable().id, 'a')
  assert.equal(table.takeRunnable().id, 'b')
  assert.equal(table.takeRunnable(), undefined, '两个位都占了，第三个不该起来')
})

test('takeRunnable 按登记顺序出队', () => {
  const table = new TaskTable(5)
  for (const id of ['a', 'b', 'c']) table.add(makeTask(id))

  assert.deepEqual([table.takeRunnable().id, table.takeRunnable().id, table.takeRunnable().id], ['a', 'b', 'c'])
})

test('takeRunnable 跳过已被取消/改状态的排队项', () => {
  const table = new TaskTable(5)
  table.add(makeTask('a'))
  table.add(makeTask('b'))
  table.tasks.get('a').status = 'cancelled'

  assert.equal(table.takeRunnable().id, 'b')
})

test('runningCount 只数 running', () => {
  const table = new TaskTable(5)
  table.add(makeTask('a'))
  table.add(makeTask('b'))
  table.add(makeTask('c', { status: 'done' }))
  table.tasks.get('a').status = 'running'

  assert.equal(table.runningCount(), 1)
})

test('settle 写入状态与时间并一次性唤醒等待者', async () => {
  const table = new TaskTable(5)
  const task = table.add(makeTask('a'))

  let woke = 0
  const waiting = table.waitFor([task], 1000).then(() => { woke += 1 })

  // 还没结算前不该醒
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(woke, 0)

  table.settle(task, 'done')
  await waiting

  assert.equal(woke, 1)
  assert.equal(task.status, 'done')
  assert.ok(task.updatedAt, 'settle 应该刷新 updatedAt')
  assert.ok(SETTLED.has(task.status))
})

test('waitFor 等全部结算才返回', async () => {
  const table = new TaskTable(5)
  const a = table.add(makeTask('a'))
  const b = table.add(makeTask('b'))

  let finished = false
  const waiting = table.waitFor([a, b], 1000).then(() => { finished = true })

  table.settle(a, 'done')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(finished, false, '只结算了一个，不该结束')

  table.settle(b, 'failed')
  await waiting
  assert.equal(finished, true)
})

test('waitFor 对已全部结算的任务立即返回', async () => {
  const table = new TaskTable(5)
  const a = table.add(makeTask('a', { status: 'done' }))
  const started = Date.now()
  const result = await table.waitFor([a], 5000)
  assert.equal(result[0], a)
  assert.ok(Date.now() - started < 1000, '不该真的等满超时')
})

test('waitFor 超时后按当前状态返回', async () => {
  const table = new TaskTable(5)
  const task = table.add(makeTask('a'))
  const started = Date.now()
  await table.waitFor([task], 30)
  assert.equal(task.status, 'queued', '超时不该改状态')
  assert.ok(Date.now() - started >= 20)
})

test('byWorker 按子会话回查任务', () => {
  const table = new TaskTable(5)
  const task = table.add(makeTask('a'))
  assert.equal(table.byWorker('dispatch-a'), task)
  assert.equal(table.byWorker('dispatch-zzz'), undefined)
})

test('ofSession 只返回本会话的任务，最新在前', () => {
  const table = new TaskTable(5)
  table.add(makeTask('old', { parentSessionId: 's1', createdAt: '2026-01-01T00:00:01.000Z' }))
  table.add(makeTask('new', { parentSessionId: 's1', createdAt: '2026-01-01T00:00:02.000Z' }))
  table.add(makeTask('other', { parentSessionId: 's2', createdAt: '2026-01-01T00:00:03.000Z' }))

  assert.deepEqual(table.ofSession('s1').map(task => task.id), ['new', 'old'])
  assert.equal(table.ofSession('s3').length, 0)
})

test('clip 截断时保留结尾', () => {
  const text = 'A'.repeat(1000) + 'TAIL'
  const result = clip(text, 200)
  assert.ok(result.length < text.length)
  assert.ok(result.endsWith('TAIL'), '结尾通常是结论，必须保留')
  assert.ok(result.includes('已截断'))
})

test('clip 对短文本与非法输入是安全的', () => {
  assert.equal(clip('short', 100), 'short')
  assert.equal(clip(undefined, 100), '')
  assert.equal(clip(null, 100), '')
})

test('oneLine 压成单行并限长', () => {
  assert.equal(oneLine('a\n\n  b\t c '), 'a b c')
  assert.equal(oneLine('x'.repeat(300), 10).length, 10)
  assert.equal(oneLine(undefined), '')
})
