/**
 * 插件配置的 Schemastery 契约。
 *
 * 为什么要有这个文件：`src/dispatch.js` 的构造函数只做 `{ ...DEFAULTS, ...config }`，
 * 没有类型/范围校验。配置写错（`maxWorkers: 0`、`workerWorkspace: 'target'` 之外的
 * 未知值、`retryBackoffMs: 'slow'`）时插件照样启动，错误要到运行期才以更难解释的
 * 方式出现。Cordis 在 `apply` 之前用这里导出的 `Config` 校验并填默认值，错配置
 * 直接让插件加载失败，而不是半残运行；插件管理器的配置表单也从同一份 schema 取字段。
 *
 * 默认值只有一个事实源：全部引用 `src/constants.js` 的 `DEFAULTS`，不在这里抄数字。
 * `workerWorkspace` 额外接受旧值 `target`（0.8.1 及更早），运行时按 `day` 处理；
 * schema 不拦它，否则老配置升级后直接起不来。
 */
import Schema from '@deepseek-ai/schemastery'

import { DEFAULTS } from './constants.js'

const nonNegativeInt = (key, max = Number.MAX_SAFE_INTEGER) =>
  Schema.number().min(0).max(max).step(1).default(DEFAULTS[key])

const positiveInt = (key, max = Number.MAX_SAFE_INTEGER) =>
  Schema.number().min(1).max(max).step(1).default(DEFAULTS[key])

export const Config = Schema.object({
  // ---- 派发与并发 ----
  maxWorkers: positiveInt('maxWorkers', 64)
    .description('同时真正在跑的子会话上限；超出的任务进入 queued，有空位自动开始。'),
  maxTasksPerSession: positiveInt('maxTasksPerSession', 10_000)
    .description('每个会话累计可派发多少任务；防止递归派生失控。'),
  allowSessionReuse: Schema.boolean().default(DEFAULTS.allowSessionReuse)
    .description('允许 dispatch_launch({ handoff_from }) 复用来源子会话；关闭后降级为普通新派。'),
  autoHandoff: Schema.boolean().default(DEFAULTS.autoHandoff)
    .description('是否在提示里注入「接续判断」指引；只影响提示，不改变 handoffFrom 的可用性。'),
  handoffCandidatesDays: positiveInt('handoffCandidatesDays', 3650)
    .description('dispatch_candidates 的候选窗口（天），只看最近 N 天结算的任务。'),
  handoffCandidatesLimit: positiveInt('handoffCandidatesLimit', 50)
    .description('dispatch_candidates 每次返回的候选上限。'),
  handoffBriefChars: nonNegativeInt('handoffBriefChars', 100_000)
    .description('候选里简报的截断长度（字符）。'),
  handoffReportSummaryChars: nonNegativeInt('handoffReportSummaryChars', 100_000)
    .description('候选里最后一条报告摘要的二次截断长度（字符）。'),

  // ---- 子会话与工作区 ----
  inheritWorkingDirectory: Schema.boolean().default(DEFAULTS.inheritWorkingDirectory)
    .description('子会话是否继承调用者的工作目录；显式指定 workspace 时以 workspace 为准。'),
  permissionPreset: Schema.string().default(DEFAULTS.permissionPreset)
    .description('子会话的权限预设；留空继承 DSH 默认。'),
  stateDir: Schema.string().default(DEFAULTS.stateDir)
    .description('任务表落盘目录；留空为 $DSH_HOME/dsh-mini-superagent。'),
  reportOnTurnEnd: Schema.boolean().default(DEFAULTS.reportOnTurnEnd)
    .description('worker 回合结束后是否自动把最后输出回报给主会话。'),
  maxBriefChars: nonNegativeInt('maxBriefChars', 1_000_000)
    .description('投给 worker 的任务简报最大字符数，超出截断。'),
  workspaceRoot: Schema.string().default(DEFAULTS.workspaceRoot)
    .description('工作区根目录；留空为 <用户文档目录>/mini-superagent。'),
  provisionDefaultWorkspace: Schema.boolean().default(DEFAULTS.provisionDefaultWorkspace)
    .description('首次激活时创建默认工作区与其中的默认主会话。'),
  archiveAfterHours: nonNegativeInt('archiveAfterHours', 87_600)
    .description('子会话结束多少小时后自动归档；0 表示不归档。'),
  archiveSweepMinutes: nonNegativeInt('archiveSweepMinutes', 1_440)
    .description('归档巡检间隔（分钟）；0 表示不巡检。'),
  workerWorkspace: Schema.union(['day', 'cwd', 'target']).default(DEFAULTS.workerWorkspace)
    .description('没有目标工作区时子会话放哪：day=当天的【派发】工作区，cwd=任务目录；旧值 target 按 day 处理。'),
  leadSessionId: Schema.string().max(120).default(DEFAULTS.leadSessionId)
    .description('默认主会话的固定 id；改它等于换一个新默认会话。'),
  restrictRouter: Schema.boolean().default(DEFAULTS.restrictRouter)
    .description('「必派发」会话是否收走 routerDenyTools 里的工具（默认收走 write/edit）。'),
  routerDenyTools: Schema.array(Schema.string()).default([...DEFAULTS.routerDenyTools])
    .description('路由模式下收走的工具名；只影响「必派发」的会话。'),

  // ---- 投递、重试与通知 ----
  relayRetryMs: Schema.array(Schema.number().min(0).max(600_000).step(1))
    .default([...DEFAULTS.relayRetryMs])
    .description('报告投递失败的退避序列（毫秒），按顺序使用，用完即放弃。'),
  retryTransient: Schema.boolean().default(DEFAULTS.retryTransient)
    .description('worker 遇到瞬时故障（408/429/5xx、连接重置等）时是否自动续跑。'),
  retryBackoffMs: Schema.array(Schema.number().min(0).max(600_000).step(1))
    .default([...DEFAULTS.retryBackoffMs])
    .description('瞬时故障续跑的退避序列（毫秒），长度即最大重试次数。'),
  progressRelayIntervalMs: nonNegativeInt('progressRelayIntervalMs', 3_600_000)
    .description('同一任务的 progress 最短回流间隔（毫秒）；0 表示不节流。'),
  noticeMergeWindowMs: nonNegativeInt('noticeMergeWindowMs')
    .description('未消费通知的合并窗口（毫秒，上限 2000）；0 表示关闭合并。'),
  directReportStatuses: Schema.array(Schema.union(['progress', 'blocked', 'failed', 'cancelled', 'interrupted', 'ended', 'done']))
    .default([...DEFAULTS.directReportStatuses])
    .description('必须直通主会话的报告状态；done 恒直通，不能把结论类状态降级。'),
  workerAgentPreset: Schema.string().default(DEFAULTS.workerAgentPreset)
    .description('子会话默认 agent preset；留空用部署默认。'),

  // ---- 后台活与任务目录 ----
  backgroundPollMs: nonNegativeInt('backgroundPollMs', 3_600_000)
    .description('worker 回合结束后，后台还有 shell job / subagent 在跑时的巡检间隔（毫秒）。'),
  backgroundLimitMs: nonNegativeInt('backgroundLimitMs', 86_400_000)
    .description('后台活最多再占多久（毫秒）；到点终止剩余 shell job 再结算，0 表示不限。'),
  taskDirRoot: Schema.string().default(DEFAULTS.taskDirRoot)
    .description('每任务目录的根；留空表示不启用。'),
  prepareCommand: Schema.string().default(DEFAULTS.prepareCommand)
    .description('任务目录不存在时在父目录执行一次的 prepare 命令。'),
  prepareTimeoutMs: Schema.number().min(1_000).max(3_600_000).step(1).default(DEFAULTS.prepareTimeoutMs)
    .description('prepare 命令超时（毫秒）。'),

  // ---- 指标窗口与账本 ----
  memoryWindowDays: nonNegativeInt('memoryWindowDays', 3_650)
    .description('派生指标窗口（天）；只影响指标口径，不影响任务是否存在。'),
  memoryWindowTasks: nonNegativeInt('memoryWindowTasks', 10_000)
    .description('派生指标窗口（最近 N 条已结算）；与天数取交集，先到先算。'),
  maxReportSummaryChars: nonNegativeInt('maxReportSummaryChars', 1_000_000)
    .description('单条报告 summary 的入库上限（字符）。'),
  maxReportDetailChars: nonNegativeInt('maxReportDetailChars', 1_000_000)
    .description('单条报告 detail 的入库上限（字符）。'),
  maxLastTextChars: nonNegativeInt('maxLastTextChars', 1_000_000)
    .description('worker 最后一段输出的入库上限（字符）。'),
  maxPlanSteps: nonNegativeInt('maxPlanSteps', 100)
    .description('任务计划的步骤数上限；超出截断并在返回值里标记 plan_truncated。'),
  maxPlanStepChars: nonNegativeInt('maxPlanStepChars', 10_000)
    .description('单个计划步骤的文案字数上限；超出截断。'),
  maxDependsOn: nonNegativeInt('maxDependsOn', 64)
    .description('单个任务最多声明几个前置；超限报错，不静默截断。'),
  inputPendingTtlMs: nonNegativeInt('inputPendingTtlMs', 86_400_000)
    .description('「已投递未读」的存活上限（毫秒）；超时改写成「不知道读没读到」。'),
  clearTargetsOnDispose: Schema.boolean().default(DEFAULTS.clearTargetsOnDispose)
    .description('会话销毁时是否清掉它的派发目标。'),
  ledgerMaxTasks: nonNegativeInt('ledgerMaxTasks', 1_000_000)
    .description('账本全局条数上限；超出按已归档优先、最老 updatedAt 退休。'),
  ledgerMaxDays: nonNegativeInt('ledgerMaxDays', 36_500)
    .description('账本保留天数；非活跃且更早的任务退休。'),
  ledgerMaxRetired: nonNegativeInt('ledgerMaxRetired', 1_000_000)
    .description('退休留痕列表上限；超出丢弃最老的并累加 retiredDropped。'),
})
