/**
 * 「进终态必须写 `settledAt`」的执行侧不变式（plans/09 P0）。
 *
 * `test/stats.test.js` 已经守住了 `settle()` 与 `transition()` 这两条**正规入口**；
 * 这个文件守的是另一件事：**没有别的路径能绕开它们**。
 *
 * 起因是一个真实缺陷：`dispatch.js` 的重启恢复分支裸写
 * `task.status = 'interrupted'` + `task.updatedAt = now()`。`interrupted` 是终态，
 * 但裸写不写 `settledAt`，于是 `stats.js` 的 `settleTimeOf()` 只能回退 `updatedAt`，
 * 把一条**刚恢复的新任务**计进 `coverage.fallbackCount` 与
 * `timeBasis: 'updatedAt-fallback'`——「旧数据欠账」的诊断数字被自己的新数据污染。
 *
 * 两条防线：
 * 1. 行为侧：对 `SETTLED` 里的**每一个**终态，经两个入口都写 `settledAt`，且只写一次；
 * 2. 源码侧：`src/*.js` 里不允许再出现「字面量终态」的裸赋值。
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { SETTLED } from '../src/constants.js'
import { TaskTable } from '../src/tasks.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// ---------------------------------------------------------------- 行为侧

test('settledAt 对每个终态都只写一次（settle 入口）', () => {
  for (const status of SETTLED) {
    const table = new TaskTable(4)
    const task = table.add({ id: `a-${status}`, status: 'running', reports: [] })

    assert.equal(table.settle(task, status), true, `${status} 应当能被 settle 进终态`)
    const first = task.settledAt
    assert.ok(first, `settle 到 ${status} 必须写 settledAt`)
    // 严格相等曾经是 flake：旧实现里 `updatedAt` 与 `settledAt` 各读一次 `now()`，
    // 跨毫秒边界就差 1ms（实测约 0.08%）。现在两个字段由**同一次读表**写出
    // （见 `src/tasks.js` 的 `settle` / `transition`），相等是结构上的必然，
    // 所以这里改回严格比对——它钉的正是「只读一次表」这条因果。
    assert.ok(Number.isFinite(Date.parse(first)), `${status} 的 settledAt 必须可解析`)
    assert.equal(first, task.updatedAt,
      `${status}：同一入口写出的 settledAt 与 updatedAt 必须是同一个值`)

    // 第二次结算必须被拒，且不能改写时间。
    assert.equal(table.settle(task, 'failed'), false, `${status} 已是终态，不能被二次结算`)
    assert.equal(task.settledAt, first, `${status} 的结算时刻是一次性事实，不能被改写`)
  }
})

test('settledAt 对每个终态都只写一次（transition 入口，含 force 强改）', () => {
  for (const status of SETTLED) {
    const table = new TaskTable(4)
    const task = table.add({ id: `b-${status}`, status: 'running', reports: [] })

    assert.equal(table.transition(task, status), true, `running → ${status} 是合法边，不需要 force`)
    const first = task.settledAt
    assert.ok(first, `transition 到 ${status} 必须写 settledAt`)

    // 终态之间互改只能走 force；状态变了，但结算时刻不能再写一次。
    table.transition(task, 'failed', { force: true })
    assert.equal(task.settledAt, first, `${status} → failed 不该产生新的结算时刻`)
  }
})

test('reopen 之后重新结算写的是新时刻（否则被算在上一次结算那天）', async () => {
  const table = new TaskTable(4)
  const task = table.add({ id: 'c', status: 'running', reports: [] })

  table.settle(task, 'done')
  const first = task.settledAt
  assert.ok(first)

  assert.equal(table.reopen(task), true)
  assert.equal(task.settledAt, undefined, '重开后「结算时刻」不再存在')

  await new Promise(resolve => setTimeout(resolve, 15))
  table.settle(task, 'done')
  assert.ok(task.settledAt)
  assert.notEqual(task.settledAt, first, '第二次结算必须是新时刻')
})

// ---------------------------------------------------------------- 源码侧

/**
 * 把注释抹成空格（保留换行与全部字符偏移，行号因此可以直接对回原文）。
 *
 * 为什么要抹：注释里完全可能写到 `task.status = 'done'` 这种**历史说明**
 * （本仓库就有先例），那不是可执行的裸写，不该让不变式变红。抹成空格而不是
 * 删除，是为了让 `index → 行号` 的换算与原文完全一致。
 *
 * 引号状态机让字符串里的 `//`（例如 'http://…'）不会被当成注释开头。
 */
function blankComments(source) {
  const chars = [...source]
  const out = [...source]
  const blank = index => {
    if (index >= out.length) return
    if (out[index] !== '\n' && out[index] !== '\r') out[index] = ' '
  }
  let mode = null
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    const next = chars[i + 1]
    if (mode === 'line') {
      if (ch === '\n') mode = null
      else blank(i)
      i += 1
      continue
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { blank(i); blank(i + 1); mode = null; i += 2; continue }
      blank(i)
      i += 1
      continue
    }
    if (mode === "'" || mode === '"' || mode === '`') {
      if (ch === '\\') { i += 2; continue }
      if (ch === mode) mode = null
      i += 1
      continue
    }
    if (ch === '/' && next === '/') { mode = 'line'; blank(i); blank(i + 1); i += 2; continue }
    if (ch === '/' && next === '*') { mode = 'block'; blank(i); blank(i + 1); i += 2; continue }
    if (ch === "'" || ch === '"' || ch === '`') mode = ch
    i += 1
  }
  return out.join('')
}

/**
 * 裸写终态的判据：`<某个对象>.status = '<字面量终态>'`。
 *
 * 收窄的理由（这一条决定这个测试抓什么、不抓什么）：
 * - **只认字面量终态**。`tasks.js` 里 `transition()` / `settle()` 内部那两句
 *   `task.status = status` 是**唯一合法**的写法，但静态正则分不清「变量」是
 *   调用方传进来的合法目标还是别的东西；只抓字面量，既不会误伤正规入口，
 *   又正好覆盖已知缺陷的形状（恢复路径当年就是写死的 `'interrupted'`）。
 * - **只扫 `src/*.js`**：测试夹具当然要造终态任务，那不是产品代码。
 * - 状态串仍然只在 `constants.js` 定义（`SETTLED`），这里只把它拼进正则，
 *   不另立一份名单——否则新增终态时这个测试会静默放行。
 */
const TERMINAL_ALTERNATION = [...SETTLED].join('|')
const BARE_TERMINAL_WRITE = new RegExp(
  `\\b\\w+\\.status\\s*=\\s*['"\`](?:${TERMINAL_ALTERNATION})['"\`]`,
  'g',
)

test('src/*.js 里不存在对任务对象裸写终态状态的语句', async () => {
  const names = (await readdir(SRC_DIR)).filter(name => name.endsWith('.js'))
  // 空目录会让下面的断言**空转通过**，所以先证明真的扫到了源码。
  assert.ok(names.length >= 8, `应当扫到全部源文件，实际只有 ${names.length} 个`)
  for (const required of ['dispatch.js', 'tasks.js', 'constants.js']) {
    assert.ok(names.includes(required), `扫描范围必须包含 ${required}`)
  }

  const offenders = []
  for (const name of names) {
    const source = await readFile(join(SRC_DIR, name), 'utf8')
    const stripped = blankComments(source)
    for (const match of stripped.matchAll(BARE_TERMINAL_WRITE)) {
      const line = stripped.slice(0, match.index).split('\n').length
      offenders.push(`${name}:${line}  ${source.split('\n')[line - 1].trim()}`)
    }
  }

  assert.deepEqual(offenders, [],
    `终态只能经 TaskTable.transition()/settle() 进入；以下位置裸写了状态，`
    + `会漏掉 settledAt 并污染 stats 的回退计数：\n${offenders.join('\n')}`)
})

test('不变式扫描器本身能抓到裸写（自检，防止正则退化成恒真）', () => {
  // 若有人把正则写坏，上面那条会因为「永远匹配不到」而恒绿。这条用两段样本钉住它。
  const bad = "  task.status = 'interrupted'\n  task.updatedAt = now()\n"
  assert.equal([...bad.matchAll(BARE_TERMINAL_WRITE)].length, 1, '裸写终态必须被匹配到')

  const good = '  this.table.transition(task, \'interrupted\', { force: true })\n'
  assert.equal([...good.matchAll(BARE_TERMINAL_WRITE)].length, 0, '走入口不能被误伤')

  // 注释里的历史说明不是可执行裸写：抹掉注释后应当匹配不到。
  const commented = "// 当年这里是 task.status = 'interrupted'\n"
  assert.equal([...blankComments(commented).matchAll(BARE_TERMINAL_WRITE)].length, 0)
})
