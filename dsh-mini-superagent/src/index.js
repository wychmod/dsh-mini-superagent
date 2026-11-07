/**
 * dsh-mini-superagent — 后台任务派发（Host 插件，纯 ESM，无构建、无运行时依赖）
 *
 * 能力模型沿用 DSH 官方 dsh-superagent 原型的“主会话 + 执行器 Session”，
 * 但只保留派发这一件事：
 *
 *   主会话 --dispatch_launch--> 新建子 Session（默认继承自己的工作目录）
 *   子会话 --独立跑一轮或多轮--> dispatch_report / 回合结束
 *   报告 --插件来源的消息--> 回流主会话（空闲时唤醒它，忙碌时并入下一步）
 *
 * 入口只做三件事：建 Dispatch、注册工具、接两条宿主事件。
 */
import { LOG_PREFIX, NAME, SETTLED } from './constants.js'
import { registerBoardRoutes } from './board.js'
import { Dispatch } from './dispatch.js'
import { registerTools } from './tools.js'

/** 插件名，必须与 package.json 的 name 一致。 */
export const name = NAME

/** 硬依赖的服务；缺任何一个插件都不会激活，而不是半残运行。 */
export const inject = ['tools', 'agents', 'sessionController']

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] cordis.patch.yml 里的 config
 */
export async function apply(ctx, config) {
  const dispatch = new Dispatch(ctx, config)
  await dispatch.restore()
  // 默认工作区与默认主会话：幂等，失败只记日志。
  await dispatch.provision()
  registerTools(ctx, dispatch)

  // worker 回合开始：记下 turnStartedAt，用于判断本回合是否已经给过终态报告。
  //
  // 注意这里**不能**直接写 task.status：0.6.0 之前它无条件把任务写成 running，
  // 于是已结算（done / cancelled / interrupted）的任务会被 worker 的下一次
  // running 事件「复活」，runningCount 虚高、并发位被幽灵占用，
  // 而且这个任务永远不会再被结算。现在交给 dispatch.workerTurnStarted，
  // 由状态跃迁表判定该不该动。
  ctx.on('agent/status', ({ agent, status }) => {
    const task = dispatch.table.byWorker(agent.id)
    if (!task) return
    if (status === 'running') {
      dispatch.workerTurnStarted(task)
      return
    }
    if (status === 'idle') void dispatch.onWorkerIdle(agent.id)
  })

  // 子会话被外部关闭/删除时，别让任务永远挂在 running。
  ctx.on('agent/disposed', ({ agent }) => {
    // 会话没了，它的工具收窄登记也该跟着消失，否则 routers 会随会话数一直长。
    dispatch.forgetRouter(agent?.id)
    dispatch.forgetSubagent(agent?.id)
    const task = dispatch.table.byWorker(agent.id)
    if (!task || SETTLED.has(task.status)) return
    dispatch.settle(task, 'interrupted')
  })

  // 会话新建时按当前模式挂上提示段：模式是「必派发」就装强制段，否则装轻提示。
  // 段文本是函数，之后切模式只换求值函数，不用重载插件。
  ctx.on('agent/created', ({ agent }) => {
    dispatch.refreshHint(agent)
    // worker 派生出来的 subagent 收走 dispatch_*，否则它能无限往下派生任务。
    dispatch.decorateSubagent(agent)
  })

  // worker 的回合抛错：瞬时故障（408/429/5xx、连接重置、限流）退避续跑，其余直接 failed。
  // 0.8.1 及更早没有这个订阅，模型 5xx 之后 worker 走到 idle 就被当成「回合正常结束」，
  // 主会话收到一条「本轮没有输出」，看起来像任务做完了。
  //
  // 宿主版本不认识这个事件时，订阅本身不该让插件起不来——包一层 try 只是保险，
  // 真正的代价是「续跑不生效」，其余功能照常。
  try {
    ctx.on('agent/error', ({ agent, error }) => { dispatch.onWorkerError(agent, error) })
  } catch (error) {
    ctx.logger?.warn?.('%s 订阅 agent/error 失败（瞬时故障续跑不可用）: %s', LOG_PREFIX, String(error))
  }

  // 读回执：worker 把某条派发消息真正读进上下文时，清掉任务上的「已投递未读」。
  try {
    ctx.on('session/event', (session, event) => { dispatch.onSessionEvent(session, event) })
  } catch (error) {
    ctx.logger?.warn?.('%s 订阅 session/event 失败（读回执不可用）: %s', LOG_PREFIX, String(error))
  }

  // 任务看板的 HTTP 路由（宿主没有 webServer 时安静跳过）。
  const disposeBoard = registerBoardRoutes(ctx, dispatch)
  if (disposeBoard) ctx.effect(() => disposeBoard)

  // 卸载时冲刷状态；运行中的子会话归 DSH 自己管。
  //
  // disposer 必须**返回** dispose() 的 Promise：0.6.0 之前写的是
  // `void dispatch.dispose()`，宿主拿不到 Promise 就不会等它，
  // 而 dispose 内部先 `disposed = true` 再 await persist——
  // 期间任何 schedulePersist 都被挡住，最后一段状态可能根本没落盘。
  ctx.effect(() => () => dispatch.dispose())

  void dispatch.pump()
  // 已有会话按当前模式刷新一次（插件重载后不会重复注册段，只换文本）。
  dispatch.refreshAllHints()
  // 过期子会话自动归档（archiveAfterHours / archiveSweepMinutes 都为 0 时不起）。
  dispatch.startArchiveSweep()
  ctx.logger?.info?.('%s 已加载：maxWorkers=%d', LOG_PREFIX, dispatch.table.maxWorkers)
}

export { DEFAULTS, VERSION } from './constants.js'
