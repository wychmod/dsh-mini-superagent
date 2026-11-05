/**
 * 给模型看的文本：worker 的首条任务简报，以及主会话的工作方式提示。
 * 单独放一层，方便对照修改而不碰逻辑。
 */
import { NAME } from './constants.js'
import { clip } from './tasks.js'

/**
 * 只注入给“用过派发的”主会话，不进 worker 的提示词。
 * 目的是把模型从“同步等结果”拉回“派发—收报告—再派发”的循环。
 */
export const DISPATCH_HINT = [
  `[${NAME} 工作方式]`,
  '你可以把任务派给后台子会话并行执行：dispatch_launch 立即返回，子会话在自己的 Session 里独立工作。',
  '不要用 dispatch_wait 空等结果，也不要自己重复执行已经派出去的工作——报告会作为消息自己回来。',
  '收到报告后：合并结论、必要时用 dispatch_message 追问或纠偏、然后继续派发下一批。',
].join('\n')

/**
 * worker 的首条消息：任务简报 + 工作规则 + 报告协议。
 * 子会话看不到派发者的历史，所以这里必须把“怎么做完、怎么汇报”讲全。
 */
export function workerPrompt(task, config) {
  const brief = clip(task.brief, config.maxBriefChars)
  return [
    '你是主会话派发的后台执行者（worker）。独立完成下面这个任务，完成后向派发者汇报。',
    '',
    `任务 ID: ${task.id}`,
    `任务标题: ${task.title}`,
    `工作目录: ${task.cwd}`,
    '',
    '任务简报:',
    brief || '（未提供简报；请依据标题自行判断，并在报告里说明你的假设）',
    '',
    '工作规则:',
    '1. 直接开工，不要等待进一步指示；能自己判断的就自行决定，并在报告里写明假设。',
    '2. 完成后必须调用工具 dispatch_report 汇报：status="done"，summary 用 3-6 行说清做了什么、改了哪些文件、如何验证、遗留风险。',
    '3. 只有在真正被阻塞（缺凭据、需要人决策、外部依赖不可用）时才用 dispatch_report 报 status="blocked"，并说明需要什么。',
    '4. 汇报之后，用一段简短的话收尾并结束本轮，不要做无关动作，也不要空转。',
    '5. dispatch_launch / dispatch_cancel / dispatch_wait 是主会话的工具，你不要调用；你的工具是 dispatch_report（以及常规的读写、搜索、执行工具）。',
    '6. 任务超出你的能力边界时，报 blocked 并给出你判断的原因，不要伪造结果。',
  ].join('\n')
}
