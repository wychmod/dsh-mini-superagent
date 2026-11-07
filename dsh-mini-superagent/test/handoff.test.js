/**
 * 「派发即移交」与「派发后结束本轮」的提示词回归测试。
 *
 * 为什么需要它：这两条不是假想的边界，是**两次真实事故**。
 *
 * - 事故 A（重做）：主会话把「只读定位某现象根因」派给子会话之后，自己又读了三个源码模块、
 *   跑了 30000 局模拟、跑了候选手合法性穷举、开浏览器复现并截图、查了 git 历史、解析了历史录像。
 *   这些全是子会话正在做的事，最后两边给出同一结论。
 *   原因是旧的执行条款只点名了 `write / edit / pwsh / bash`——只读操作没有被点名，
 *   模型就把它当成许可。
 * - 事故 B（干等）：同一事故里主会话连续调了约 10 次 `dispatch_wait`（180/240/300/180/180/180/
 *   120/120/180/240 秒），累计约 33 分钟原地阻塞，期间零产出。
 *   根因不是不知道它会阻塞，而是提示词没说清「结束本轮」就是正确动作。
 *
 * 这些用例钉的是**文本契约**：提示词一改回去，行为就会退回去，所以必须在源码层面钉住。
 * 只断言语义锚点，不断言整段排版——否则每次润色措辞都要改测试，测试反而会被绕过。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DISPATCH_HINT, FORCED_HINT, SOFT_HINT } from '../src/prompt.js'
import { toolDefinitions } from '../src/tools.js'

/** 两种模式都该带上这三段共享文本（强制派发只多「要不要派」的差别）。 */
const HINTS = [
  ['SOFT_HINT', SOFT_HINT],
  ['FORCED_HINT', FORCED_HINT],
]

test('两种模式的提示都必须非空（防止拼接时整段丢失）', () => {
  for (const [name, hint] of HINTS) {
    assert.ok(typeof hint === 'string' && hint.length > 500, `${name} 文本过短：${hint?.length}`)
  }
})

// ------------------------------------------------------------ 事故 B：干等

test('提示写明「派发之后的默认动作是结束本轮」', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /默认动作就是结束本轮/, `${name} 缺「默认动作是结束本轮」`)
  }
})

test('提示写明「结束本轮 ≠ 没回答」，正面回答事故 B 的推理链', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /结束本轮 ≠ 没回答/, `${name} 没解释「结束本轮不等于没作答」`)
    // 事故 B 的真实推理是「用户问了问题 → 必须当场给答案才能结束这一轮」，
    // 提示里必须直接否定这条，否则模型会自己重新推出来。
    assert.match(hint, /问句不等于必须当场作答/, `${name} 没否定「问句必须当场作答」这条推理`)
  }
})

test('dispatch_wait 的判据是「用户在同一条消息里明确要求等结果」这一条硬边界', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /同一条消息里/, `${name} 的 dispatch_wait 判据没有绑定到用户的原话`)
    assert.match(hint, /等结果再继续/, `${name} 没写出允许等待的唯一条件`)
    assert.match(hint, /硬边界/, `${name} 没有把判据说成硬约束`)
  }
})

test('提示显式禁止「用 dispatch_wait 代替结束本轮」', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /用 dispatch_wait 代替结束本轮/, `${name} 没有点名这个反模式`)
  }
})

test('提示把「连续多次 dispatch_wait」标成严重问题，并给出实测量级', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /连续多次 dispatch_wait/, `${name} 没点名单次之外连续等待的情况`)
    // 没有量级的警告读起来像模板话术，模型会当口头禅跳过。
    assert.match(hint, /33 分钟/, `${name} 缺少事故的实测量级，警告不够具体`)
  }
})

// ------------------------------------------------------------ 事故 A：重做

test('移交范围穷举了只读动作，而不是只点名 write / edit', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /派发即移交/, `${name} 没有「派发即移交」这条规则`)
    // 这几个是事故 A 里主会话真正重做过的动作。少写一个，模型就从那个缺口钻过去。
    for (const action of ['读代码', 'grep', 'glob', '跑脚本', '开浏览器', '查网络', '验数据', 'git 历史']) {
      assert.ok(hint.includes(action), `${name} 的移交范围漏了「${action}」`)
    }
  }
})

test('移交判据是「是不是那个任务的目标」，不是「用了哪个工具」', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /是不是那个任务的目标/, `${name} 没有给出工具无关的判据`)
    assert.match(hint, /只读调查同样属于移交范围/, `${name} 没声明只读调查也在移交范围内`)
  }
})

test('派发之后剩余动作只有两个：读报告、dispatch_message', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /只剩两个动作/, `${name} 没把剩余动作限定住`)
    assert.match(hint, /读回流回来的报告/, `${name} 缺少「读报告」这个允许动作`)
    assert.match(hint, /dispatch_message/, `${name} 缺少「dispatch_message 追问/纠偏」这个允许动作`)
  }
})

test('带自检条款：与在跑任务重叠就停手', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /自检/, `${name} 没有自检条款`)
    assert.match(hint, /立刻停手/, `${name} 自检没有给出明确动作`)
    assert.match(hint, /重叠/, `${name} 自检没有说明「怎样算重叠」`)
  }
})

// ------------------------------------------------------------ 白名单

test('有任务在飞时的白名单是穷举的，并把「结束本轮」作为兜底出口', () => {
  for (const [name, hint] of HINTS) {
    assert.match(hint, /只有这四条/, `${name} 的白名单没有声明是穷举`)
    // 四条可做的事，缺一条白名单就不完整，模型会自己补一条最省事的（通常就是去重做或干等）。
    assert.match(hint, /回答纯问答/, `${name} 白名单缺「纯问答」`)
    assert.match(hint, /不冲突/, `${name} 白名单缺「派发下一批不冲突的任务」`)
    assert.match(hint, /已经回流/, `${name} 白名单缺「对已回流的报告做合并」`)
    assert.match(hint, /以上都不是 → 结束本轮/, `${name} 白名单缺兜底出口`)
  }
})

// ------------------------------------------------------------ 两种模式一致性

test('两种模式共用同一份契约：三段共享文本都必须在', () => {
  // 这个仓库的头号历史教训就是「两种模式各写一套 → 语义漂移」。
  // 只比较锚点，不比较整段文本（各自的正文本来就不同）。
  const anchors = [
    '后台派发机制（以下是机制事实，请按它理解派发）:',
    '**派发即移交**',
    '有任务在飞时，你能做的事只有这四条',
  ]
  for (const [name, hint] of HINTS) {
    for (const anchor of anchors) {
      assert.ok(hint.includes(anchor), `${name} 缺少共享段「${anchor}」`)
    }
  }
})

test('SOFT_HINT 与 DISPATCH_HINT 仍是同一份文本（轻提示只有一种写法）', () => {
  assert.equal(SOFT_HINT, DISPATCH_HINT)
})

test('强制派发模式额外点明「只读定位根因」也要派发', () => {
  // 事故 A 就是从「查代码、分析」这条缝钻过去的：模型把「只读定位根因」当成分析而不是执行。
  assert.match(FORCED_HINT, /只读定位根因/, 'FORCED_HINT 必须把只读定位根因列进必派发范围')
})

// ------------------------------------------------------------ 工具描述

test('dispatch_wait 的工具描述写明「默认不要调用」与唯一允许情形', () => {
  const wait = toolDefinitions({}).find(item => item.name === 'dispatch_wait')
  assert.ok(wait, 'dispatch_wait 必须存在')
  const text = wait.description
  assert.match(text, /默认不要调用/, '工具描述必须说明默认不要用')
  assert.match(text, /同一条消息里/, '工具描述必须把允许情形绑定到用户原话')
  assert.match(text, /结束本轮/, '工具描述必须点明「默认动作是结束本轮」')
  assert.match(text, /不要用本工具代替结束本轮/, '工具描述必须禁止这个反模式')
})

test('dispatch_wait 的工具描述明确「它不是 sleep」', () => {
  const wait = toolDefinitions({}).find(item => item.name === 'dispatch_wait')
  assert.match(wait.description, /不是 sleep|不是延时器/, '必须挡住把 dispatch_wait 当延时器的用法')
})

test('dispatch_launch / dispatch_launch_many 的描述都写了「派发即移交」', () => {
  for (const name of ['dispatch_launch', 'dispatch_launch_many']) {
    const tool = toolDefinitions({}).find(item => item.name === name)
    assert.ok(tool, `${name} 必须存在`)
    assert.match(tool.description, /派发即移交/, `${name} 的描述缺「派发即移交」`)
    // 光说「别等」不够——模型会理解为「别用 wait，直接接着干」。必须同时说「别重做」。
    assert.match(tool.description, /结束本轮/, `${name} 的描述没说明派完该结束本轮`)
  }
})

test('dispatch_launch 的返回值也带上「接下来结束本轮」的提示', async () => {
  // 工具返回值是模型最靠近决策点的一手信息，比提示段更晚被读到。
  const def = toolDefinitions({
    card: task => ({ task_id: task.id }),
    async launch() { return { id: 't1' } },
  }).find(item => item.name === 'dispatch_launch')
  const value = await def.execute({ title: 'x', brief: 'y' }, { agent: { id: 'lead' } })
  assert.match(value.note, /默认结束本轮/, '返回值 note 必须提示接下来结束本轮')
  assert.match(value.note, /报告会自己回来/, '返回值 note 必须说明报告会自己回流')
})
