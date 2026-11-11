/**
 * 文档 / 常量一致性闸门。
 *
 * 这个包刻意不引入构建步骤，Host 与浏览器半边（plain ModuleLoader）无法共享
 * import，于是有几组字符串必然存在两份。此前已经漂移过：环境变量写成
 * `_TASK / _TITLE` 缩写、README 的 `dispatch_list` 示例还停在 0.5.0、
 * `tools.js` 头部写「8 个工具」而实际有 9 个、CHANGELOG 出现两个 0.5.2。
 *
 * 把「同一份事实只能有一个值」变成可执行的断言，而不是靠下一次人工复核。
 * 这里只做文本比对，不 import 浏览器代码，也不碰运行时行为。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BOARD_BASE, BLOCK_REASONS, CANCEL_REASONS, DEFAULTS, ERROR_CODES, VERSION } from '../src/constants.js'
import { boardTask } from '../src/board.js'
import { TOOL_NAMES, toolDefinitions } from '../src/tools.js'

/** 相对包根读文件；测试文件位于 test/ 下。 */
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Host 与 Client 的看板路由前缀逐字一致', async () => {
  const client = await read('client/index.js')
  const match = client.match(/const API = '([^']+)'/)
  assert.ok(match, 'client/index.js 里应有 const API = ...')
  assert.equal(match[1], BOARD_BASE, '改 BOARD_BASE 时必须同步改 client/index.js')

  const board = await read('src/board.js')
  assert.match(board, /const BASE = BOARD_BASE/, 'Host 侧必须从 constants.js 取前缀')
})

test('README 的 dispatch_list 示例版本与 constants.VERSION 一致', async () => {
  const readme = await read('README.md')
  assert.ok(
    readme.includes(`"version":"${VERSION}"`),
    `README.md 的示例里应出现 "version":"${VERSION}"`,
  )
})

test('tools.js 头部声明的工具数与 TOOL_NAMES 一致', async () => {
  const tools = await read('src/tools.js')
  const match = tools.match(/^ \* (\d+) 个工具的模型可见定义/m)
  assert.ok(match, 'tools.js 头部应有「N 个工具」的声明')
  assert.equal(Number(match[1]), TOOL_NAMES.length)
})

test('prepare 的环境变量全名同时出现在配置与文档里', async () => {
  const prepare = await read('src/prepare.js')
  const names = [...new Set([...prepare.matchAll(/DSH_DISPATCH_[A-Z]+/g)].map(m => m[0]))].sort()
  assert.deepEqual(names, [
    'DSH_DISPATCH_CWD',
    'DSH_DISPATCH_DIR',
    'DSH_DISPATCH_TASK',
    'DSH_DISPATCH_TITLE',
    'DSH_DISPATCH_WORKSPACE',
  ])
  for (const file of ['cordis.patch.yml', 'README.md', 'docs/architecture.md']) {
    const text = await read(file)
    for (const name of names) {
      assert.ok(text.includes(name), `${file} 缺少环境变量 ${name}（不要写 _TASK 这类缩写）`)
    }
  }
})

test('store.js 不再声称任务表是辅助信息', async () => {
  const store = await read('src/store.js')
  assert.doesNotMatch(store, /丢了不影响子会话本身/, 'docs/architecture.md §26 已否定这个口径')
})

test('CHANGELOG 没有重复的发布版本号', async () => {
  const changelog = await read('CHANGELOG.md')
  const versions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+) /gm)].map(m => m[1])
  const duplicates = versions.filter((value, index) => versions.indexOf(value) !== index)
  assert.deepEqual(duplicates, [], `重复的版本号：${duplicates.join(', ')}`)
})

test('错误码闭集的值唯一且命名空间一致', () => {
  const values = Object.values(ERROR_CODES)
  assert.ok(values.length >= 5)
  assert.equal(new Set(values).size, values.length, '错误码不能重复')
  for (const value of values) assert.match(value, /^dispatch\//)
})

/**
 * 计划（PRD-01）的横切契约：一个功能同时出现在三处，三处必须说同一件事。
 *
 * - **工具 schema**：`dispatch_report.plan` 的形状与状态闭集；
 * - **常量上限**：`maxPlanSteps` / `maxPlanStepChars` 是截断的唯一事实源，
 *   schema 的说明文字必须**引用**它，不能在 description 里另抄一组数字；
 * - **看板投影**：`boardTask()` 的三个标量字段名（`plan_total` / `plan_done` /
 *   `plan_current`）与语义（done 计数、当前步骤文案），以及「终态优先」——
 *   已结算任务不下发计划标量。
 *
 * 不这样做的话，最常见的漂移是：有人把 DEFAULTS 调成 20，schema 还写着 12，
 * 模型按 12 规划、插件按 20 存，两边都「没错」，但契约已经不是同一份。
 */
test('计划契约：工具 schema ↔ DEFAULTS 上限 ↔ 看板 plan_* 字段一致', () => {
  const report = toolDefinitions({}).find(definition => definition.name === 'dispatch_report')
  assert.ok(report, '必须能找到 dispatch_report 的定义')

  const plan = report.parameters.properties.plan
  assert.ok(plan, 'dispatch_report 必须声明可选 plan（否则 worker 无法上报计划）')
  assert.equal(plan.type, 'array')
  assert.equal(plan.items.type, 'object')
  assert.deepEqual(plan.items.properties.status.enum, ['pending', 'doing', 'done'], '状态闭集必须与 #applyPlan 一致')
  assert.ok(plan.items.required.includes('text'), '每个步骤必须有 text')

  // 上限只允许有一个事实源：schema 说明文字里的数字必须来自 DEFAULTS。
  assert.ok(Number.isInteger(DEFAULTS.maxPlanSteps) && DEFAULTS.maxPlanSteps > 0)
  assert.ok(Number.isInteger(DEFAULTS.maxPlanStepChars) && DEFAULTS.maxPlanStepChars > 0)
  assert.match(plan.description, new RegExp(`最多${DEFAULTS.maxPlanSteps} 步`),
    'schema 说明里的步数必须引用 DEFAULTS.maxPlanSteps')
  assert.match(plan.description, new RegExp(`每步 ${DEFAULTS.maxPlanStepChars} 字`),
    'schema 说明里的字数必须引用 DEFAULTS.maxPlanStepChars')
  assert.match(plan.items.properties.text.description, new RegExp(`最多 ${DEFAULTS.maxPlanStepChars} 字`),
    '步骤说明里的字数必须引用 DEFAULTS.maxPlanStepChars')

  const shaped = boardTask({
    id: 't-contract-plan',
    status: 'running',
    reports: [],
    plan: [
      { text: '改 tools.js 参数', status: 'done' },
      { text: '补 dispatch 单测', status: 'pending' },
    ],
  })
  assert.equal(shaped.plan_total, 2)
  assert.equal(shaped.plan_done, 1)
  assert.equal(shaped.plan_current, '补 dispatch 单测', '没有 doing 时取第一条 pending')
  // 快照只带三个短标量，**不能**把步骤数组搬上看板（2 秒轮询的体积约束）。
  assert.equal(shaped.plan, undefined, 'boardTask 不能返回完整 plan 数组')

  // 终态优先：已结算任务不下发计划标量，客户端不会画出「done 了还停在第 2 步」。
  const settled = boardTask({
    id: 't-contract-settled',
    status: 'done',
    reports: [],
    plan: [{ text: 'a', status: 'done' }],
  })
  assert.equal(settled.plan_total, undefined)
  assert.equal(settled.plan_done, undefined)
  assert.equal(settled.plan_current, undefined)
})

/**
 * 批次依赖（PRD-02）的横切契约：同一个概念出现在**四层**，四层必须说同一件事。
 *
 * | 层 | 事实源 |
 * | --- | --- |
 * | 工具 schema | `dispatch_launch.depends_on` / `launch_many.depends_on(_index)` |
 * | 任务字段 | `dependsOn` / `blockedBy` / `blockedReason` / `cancelReason` / `errorCode` |
 * | 看板字段 | `depends_on` / `blocked_by` / `blocked_reason` / `cancel_reason` / `error_code` |
 * | 错误码 | `UNKNOWN_DEPENDENCY` / `DEPENDENCY_CYCLE` / `DEPENDENCY_FAILED` / `DEPENDENCY_MISSING` |
 *
 * 这层的漂移不会报错、只会让看板与工具说两件事（例如任务写 `blockedReason: 'running'`
 * 而客户端只认 `'waiting'`，于是「等前置」永远不显示）。所以字段名用**映射表**
 * 钉死，新增字段时两列必须同时改。
 */
test('依赖契约：工具 schema ↔ 任务字段 ↔ 看板字段 ↔ ERROR_CODES 一致', () => {
  const launch = toolDefinitions({}).find(definition => definition.name === 'dispatch_launch')
  assert.ok(launch, '必须能找到 dispatch_launch 的定义')
  const dependsOn = launch.parameters.properties.depends_on
  assert.ok(dependsOn, 'dispatch_launch 必须声明可选 depends_on（否则调用方无法声明依赖）')
  assert.equal(dependsOn.type, 'array')
  assert.equal(dependsOn.items.type, 'string')
  // 上限只有一个事实源：schema 说明里的数字必须来自 DEFAULTS，不能另抄一份。
  assert.equal(DEFAULTS.maxDependsOn, 8, 'PRD-02 §5 定的默认上限是 8')
  assert.match(dependsOn.description, new RegExp(`最多${DEFAULTS.maxDependsOn} 个`),
    'schema 说明里的上限必须引用 DEFAULTS.maxDependsOn')

  /*
   * 工具描述里那段「依赖什么时候生效」是 PRD 明确要求写明的，且它最容易被人
   * 在其他描述里改写。这里逐句钉住核心语义，任何一个说法漂了都会红。
   */
  for (const sentence of ['依赖在**任务开始前**判定', '不占 worker 并发位', '不会自动改派']) {
    assert.ok(launch.description.includes(sentence), `dispatch_launch 描述缺少「${sentence}」`)
  }

  const many = toolDefinitions({}).find(definition => definition.name === 'dispatch_launch_many')
  assert.ok(many, '必须能找到 dispatch_launch_many 的定义')
  const items = many.parameters.properties.tasks.items.properties
  assert.ok(items.depends_on, 'launch_many 的 item 必须支持 depends_on')
  assert.ok(items.depends_on_index, 'launch_many 的 item 必须支持 depends_on_index')
  assert.equal(items.depends_on_index.items.type, 'integer')
  assert.match(items.depends_on_index.description, /排在自己前面/,
    '批内下标的限制（只能指向前面的 item）必须写进 schema 说明')
  for (const sentence of ['依赖在**任务开始前**判定', '不占 worker 并发位', '不会自动改派']) {
    assert.ok(many.description.includes(sentence), `dispatch_launch_many 描述缺少「${sentence}」`)
  }

  // 任务字段 ↔ 看板字段：一对一同值。加字段时这张表就是唯一的改动点。
  const pairs = [
    { task: 'dependsOn', board: 'depends_on', value: ['t-a', 't-b'] },
    { task: 'blockedBy', board: 'blocked_by', value: 't-a' },
    { task: 'blockedReason', board: 'blocked_reason', value: BLOCK_REASONS.RUNNING },
    { task: 'cancelReason', board: 'cancel_reason', value: CANCEL_REASONS.DEPENDENCY_FAILED },
    { task: 'errorCode', board: 'error_code', value: ERROR_CODES.DEPENDENCY_FAILED },
  ]
  for (const pair of pairs) {
    const shaped = boardTask({ id: `t-contract-${pair.task}`, status: 'queued', reports: [], [pair.task]: pair.value })
    assert.deepEqual(shaped[pair.board], pair.value,
      `任务字段 ${pair.task} 必须投影成看板字段 ${pair.board}（同名同值，不能各写一份）`)
  }

  // 三个 blockedReason 与两种 cancelReason 都必须是闭集里的值，且看板原样透传。
  assert.deepEqual(Object.values(BLOCK_REASONS).sort(), ['failed', 'missing', 'running'])
  assert.deepEqual(Object.values(CANCEL_REASONS).sort(), ['dependency_failed', 'dependency_missing'])
  for (const value of Object.values(BLOCK_REASONS)) {
    const shaped = boardTask({ id: 't-blocked', reports: [], blockedBy: 't-a', blockedReason: value })
    assert.equal(shaped.blocked_reason, value)
  }

  /*
   * 错误码 ↔ 取消原因：两者是同一次取消的两个面向（给人看 / 给程序判断），
   * 必须成对存在。少了任何一个，调用方就只能解析中文。
   */
  const expectedCodes = ['UNKNOWN_DEPENDENCY', 'DEPENDENCY_CYCLE', 'DEPENDENCY_FAILED', 'DEPENDENCY_MISSING']
  for (const name of expectedCodes) {
    assert.ok(ERROR_CODES[name], `ERROR_CODES 缺少 ${name}`)
    assert.match(ERROR_CODES[name], /^dispatch\//)
  }
  const cancelToError = {
    [CANCEL_REASONS.DEPENDENCY_FAILED]: ERROR_CODES.DEPENDENCY_FAILED,
    [CANCEL_REASONS.DEPENDENCY_MISSING]: ERROR_CODES.DEPENDENCY_MISSING,
  }
  for (const [reason, code] of Object.entries(cancelToError)) {
    const shaped = boardTask({ id: 't-cancel', reports: [], cancelReason: reason, errorCode: code })
    assert.equal(shaped.cancel_reason, reason)
    assert.equal(shaped.error_code, code)
  }

  // 没有依赖的任务不能凭空多字段：兼容性以「空数组」而不是 `undefined` 表达。
  const plain = boardTask({ id: 't-plain', reports: [] })
  assert.deepEqual(plain.depends_on, [])
  assert.equal(plain.blocked_by, undefined)
  assert.equal(plain.cancel_reason, undefined)
})

test('依赖不引入轮询定时器（PRD-02 §9.6）', async () => {
  const dispatch = await read('src/dispatch.js')
  // 依赖的触发点只有「结算 → pump」这一条链；新增 setInterval/轮询会让
  // 「队列里全是阻塞任务」变成持续的 CPU 占用（PRD §6 明确禁止）。
  assert.doesNotMatch(dispatch, /setInterval/, 'dispatch.js 里不允许出现 setInterval（依赖不新增轮询）')
  assert.doesNotMatch(dispatch, /while\s*\(\s*true\s*\)\s*\{[^}]*setTimeout/s, '不允许用 setTimeout 自旋等待依赖')
})

