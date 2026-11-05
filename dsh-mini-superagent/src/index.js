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
import { LOG_PREFIX, NAME, SETTLED, now } from './constants.js'
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
  ctx.on('agent/status', ({ agent, status }) => {
    const task = dispatch.table.byWorker(agent.id)
    if (!task) return
    if (status === 'running') {
      task.status = 'running'
      task.turnStartedAt = now()
      task.updatedAt = task.turnStartedAt
      dispatch.schedulePersist()
      return
    }
    if (status === 'idle') void dispatch.onWorkerIdle(agent.id)
  })

  // 子会话被外部关闭/删除时，别让任务永远挂在 running。
  ctx.on('agent/disposed', ({ agent }) => {
    const task = dispatch.table.byWorker(agent.id)
    if (!task || SETTLED.has(task.status)) return
    dispatch.settle(task, 'interrupted')
    dispatch.schedulePersist()
  })

  // 任务看板的 HTTP 路由（宿主没有 webServer 时安静跳过）。
  const disposeBoard = registerBoardRoutes(ctx, dispatch)
  if (disposeBoard) ctx.effect(() => disposeBoard)

  // 卸载时冲刷状态；运行中的子会话归 DSH 自己管。
  ctx.effect(() => () => { void dispatch.dispose() })

  void dispatch.pump()
  // 过期子会话自动归档（archiveAfterHours / archiveSweepMinutes 都为 0 时不起）。
  dispatch.startArchiveSweep()
  ctx.logger?.info?.('%s 已加载：maxWorkers=%d', LOG_PREFIX, dispatch.table.maxWorkers)
}

export { DEFAULTS, VERSION } from './constants.js'
