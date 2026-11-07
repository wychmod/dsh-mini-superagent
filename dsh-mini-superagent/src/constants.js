/**
 * 稳定标识与常量：日志前缀、消息来源、状态目录、提示段名都在这里定义一次，
 * 避免各处字符串漂移。
 */

/** 插件名（= package.json 的 name）。 */
export const NAME = 'dsh-mini-superagent'

/** 插件版本，会出现在 dispatch_list 与看板快照里，便于确认“跑的是哪一版”。 */
export const VERSION = '0.8.0'

/** 日志前缀。 */
export const LOG_PREFIX = `${NAME}:`

/**
 * 投递进会话的消息来源 kind。
 * 报告以自己的来源出现，不会被误当成用户手打的消息；
 * DSH 对未知 kind 不做运行时校验（见 docs/api-contracts.md）。
 */
export const SOURCE_KIND = NAME

/** 注入主会话系统提示时用的段名。 */
export const PROMPT_SECTION = NAME

/** 状态文件在 $DSH_HOME 下的目录名。 */
export const STATE_DIR = NAME

/**
 * 派发目标的「自动」标记值。
 * 写进 targets 时表示：不锁定具体工作区，每次派发按任务内容重新挑。
 */
export const AUTO = 'auto'

/**
 * 派发目标的「不派发」标记值。
 *
 * 这是**默认模式**：目标里没有这个会话的条目，就等同于不派发。
 * 设成它 = 删掉条目，会话按普通方式直接干活，不创建子会话。
 */
export const NONE = 'none'

/**
 * 派发模式（会话级开关）：
 * - `off`    不派发：往返于本会话，怎么干由模型自己决定
 * - `always` 必派发：除纯问答外，一切执行型任务都必须 dispatch_launch 下去
 */
export const MODE_OFF = 'off'
export const MODE_ALWAYS = 'always'

/**
 * `workerWorkspace` 的两个取值：**只在没有目标工作区时才生效**。
 *
 * 为什么语义变了（0.8.1）：0.8.0 及更早，这个配置决定「用不用目标工作区」，
 * 而它的默认值 `day` 意味着**即使用户明确指定了工作区，子会话也被塞进【派发】**，
 * 于是每次启动都凭空多出一个 `【派发】YYYY-MM-DD` 工作区。用户的意图是：
 * 选了目标就该在目标里，「退回日期工作区」只是找不到目标时的兜底。
 * 所以「有目标用目标」现在是**不可关闭**的默认行为，这个配置只剩兜底这一件事。
 */
export const WORKER_WORKSPACE_DAY = 'day'
export const WORKER_WORKSPACE_CWD = 'cwd'

/**
 * 把 `workerWorkspace` 归一成新语义的取值。
 *
 * 兼容处理（不抛错）：这个键在 0.2.0 起就写进了配置契约，旧 profile 里可能还留着
 * `target`。它想表达的「有目标就用目标」现在是默认且不可关的行为，所以这个值本身
 * 已经没有意义了；剩下要决定的是它在**无目标**时退化到哪里 —— 旧 `target` 模式下
 * 无目标同样走 `dayWorkspace()`，因此未知值（含 `target`）一律退回 `day`，
 * 能保持旧 profile 的兜底行为不变。
 *
 * 反过来把未知值当错误抛出去，会让升级后的插件直接起不来——为一个已经变成默认
 * 行为的旧开关付这个代价不值得。
 *
 * @param {unknown} value 配置里的原始值
 * @returns {string} `'day'` 或 `'cwd'`
 */
export function normalizeWorkerWorkspace(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  return raw === WORKER_WORKSPACE_CWD ? WORKER_WORKSPACE_CWD : WORKER_WORKSPACE_DAY
}

/** 默认配置；cordis.patch.yml 里的 config 会覆盖这里的字段。 */
export const DEFAULTS = {
  /** 同时真正在跑（running）的子会话上限；超出的任务进入 queued，有空位自动开始。 */
  maxWorkers: 6,
  /** 每个主会话最多累计派发多少个任务。 */
  maxTasksPerSession: 64,
  /** 子会话默认继承主会话的工作目录。 */
  inheritWorkingDirectory: true,
  /** 子会话权限预设；空字符串表示继承 DSH 默认。 */
  permissionPreset: '',
  /** 任务表落盘目录；空字符串表示 $DSH_HOME/dsh-mini-superagent。 */
  stateDir: '',
  /** worker 回合结束后自动回报给主会话。 */
  reportOnTurnEnd: true,
  /** 注入 worker 的首条消息里，任务简报的最大字符数。 */
  maxBriefChars: 12000,
  /** 工作区根目录；空字符串表示 `<用户文档目录>/mini-superagent`。 */
  workspaceRoot: '',
  /** 首次激活时创建默认工作区（mini-superagent）与其中的默认主会话。 */
  provisionDefaultWorkspace: true,
  /** 子会话结束多少小时后自动归档；0 表示不归档。 */
  archiveAfterHours: 24,
  /** 归档巡检间隔（分钟）；0 表示不巡检。 */
  archiveSweepMinutes: 10,
  /**
   * **没有目标工作区时**子会话放哪（有目标时一律用目标，与这里无关）。
   * - `day`：当天的【派发】工作区（默认，侧边栏保持干净）
   * - `cwd`：不建【派发】工作区，直接挂在任务的 cwd 上
   *
   * 语义在 0.8.1 被重新定义：见 `normalizeWorkerWorkspace` 上方的长注释。
   */
  workerWorkspace: WORKER_WORKSPACE_DAY,
  /** 默认主会话的固定 id；改成别的值等于换一个新默认会话。 */
  leadSessionId: 'mas-lead',
  /**
   * 「必派发」的会话是否禁止它改代码（默认开）。
   *
   * 语义（与上游 dsh-superagent 的 router preset 对齐，但**只对路由器生效**）：
   * 当输入框里把派发目标设成某个工作区或「自动」（`modeOf() === 'always'`）时，
   * 在该会话的 agent 作用域上 `tools.restrict({ deny: routerDenyTools })`，
   * 于是模型看不到 write / edit，改代码只能派给子会话。
   *
   * 为什么挂在「必派发」上而不是「派发过一次」：任何会话都可能是主会话，
   * 而且「不派发」是默认选项。只要派过一次就永久收走 write/edit，等于用插件的
   * 产品假设覆盖用户的当场意图。挂在自己的开关上，用户随时能切回来。
   *
   * 为什么用 deny 而不是 allow：`restrict` 的名字未知会抛错，而各部署的工具集不同；
   * deny 只碰我们点名的两个工具，缺一个就跳过那一个，不会误伤别的。
   *
   * 为什么不是 preset：我们的主会话是用户自己的会话，不是插件建的，
   * 改不了它的 preset；作用域 restrict 是当前 API 里唯一能按 agent 收窄工具面的口子。
   */
  restrictRouter: true,
  /**
   * 路由模式下要收走的工具名。默认只收走「改文件」的两个。
   *
   * 注意边界（与上游一致）：`bash` 仍可用，所以 shell 里 `echo > file` 依然能写文件。
   * 想要硬边界就把它也加进来：`['write', 'edit', 'bash', 'pwsh']`。
   */
  routerDenyTools: ['write', 'edit'],
  /**
   * 报告投递失败的退避序列（毫秒），按顺序用，用完即放弃。
   * 抽成配置只为可测：默认的 2s/4s/8s 会让「重试复用同一 id」的用例至少跑 2 秒。
   */
  relayRetryMs: [2000, 4000, 8000],
  /**
   * worker 回合因**瞬时故障**中断时是否自动续跑（默认开）。
   * 瞬时 = HTTP 408/429/5xx、连接被拒/重置/超时、DNS 失败、限流。
   * 依据：上游 `DshExecutor` 的 `transient()` 与 3 次退避续跑。
   */
  retryTransient: true,
  /** 续跑的退避序列（毫秒），长度即最大重试次数。 */
  retryBackoffMs: [15000, 30000, 60000],
  /**
   * 同一任务的 `progress` 报告最短回流间隔（毫秒）；0 表示不节流。
   *
   * 目的：长任务每完成一步就报一次 progress，会把主会话刷屏。
   * 上游用「同名 notice 覆盖未发送的那条」实现合并，我们没有那个队列，
   * 退化成「按时间节流」——被挡下的 progress 仍然入库，`dispatch_inspect` 看得到。
   */
  progressRelayIntervalMs: 60000,
  /**
   * 子会话默认使用的 agent preset id；空表示用部署默认。
   * 想让 worker 的前台命令更早转后台（上游是 5 秒），把这里指向一个收紧的 preset。
   */
  workerAgentPreset: '',
  /**
   * worker 回合结束后，后台还有 shell job / subagent 在跑时的巡检间隔（毫秒）。
   *
   * 为什么要等：回合结束 ≠ 活干完。worker 常会留一个 dev server、或还有 subagent 在跑。
   * 0.8.1 及更早 `idle` 就结算，并发位被释放，但后台其实还在改同一个目录。
   * 上游把占用单位定成 Assignment，job/subagent 还在跑就一直占着槽位。
   */
  backgroundPollMs: 15000,
  /**
   * 后台活最多再占多久（毫秒）。到点终止还剩的 shell job 并结算，默认 30 分钟。
   * 0 表示不限——不建议，一个卡住的 job 会永久占住并发位。
   */
  backgroundLimitMs: 1800000,
  /**
   * 每任务目录的根；空表示不启用（子会话仍在工作区/调用者目录里干活）。
   * 启用后每个任务得到 `<root>/<标题>-<id后6位>` 作为工作目录，并可选跑一次 prepare 命令。
   */
  taskDirRoot: '',
  /**
   * prepare 命令：任务目录**不存在**时在父目录执行一次，典型用法是 `git worktree add`。
   * 失败即任务失败，不自动重试（目录可能已被写了一半）。见 `src/prepare.js`。
   */
  prepareCommand: '',
  /** prepare 命令超时（毫秒），默认 10 分钟。 */
  prepareTimeoutMs: 600000,
}

/**
 * 看板准入用的自定义请求头。
 *
 * 为什么需要它：`Origin` 与 `Host` 都可由客户端伪造，所以
 * 「Origin.host === Host」这个判据对 DNS rebinding 恒真——攻击者页面从
 * `http://evil.example:9735` 加载、该域名解析到 127.0.0.1 时，
 * 两个头都是 `evil.example:9735`，判据成立。实测该请求能读到全部任务
 * 标题、工作目录与报告摘要。
 *
 * 自定义头是浏览器跨站请求带不上的：
 * - 带自定义头的跨站请求会触发 CORS 预检，预检不带这个头，服务端拒绝；
 * - 不触发预检的「简单请求」也带不上自定义头。
 * 所以「必须带这个头」等价于「必须是脚本主动发的、且已通过预检」。
 * 本机命令行/脚本自己带上它即可，不受影响。
 */
export const BOARD_HEADER = 'x-dsh-mini-superagent'

/**
 * 看板额外放行的 Host（例如要直连的局域网地址，形如 `192.168.1.5:3080`）。
 * 留空 = 只认回环名与同源页面。放行任意 Host 用 `['*']`（不推荐）。
 * @type {string[]}
 */
export const BOARD_ALLOWED_HOSTS = []

/** 已结算：不再占并发位、不再等它。 */
export const SETTLED = new Set(['done', 'blocked', 'failed', 'cancelled', 'ended', 'interrupted'])

/** 已经给出终态、不该再触发“回合结束自动回报”的报告状态。 */
export const TERMINAL_REPORT = new Set(['done', 'blocked', 'failed', 'cancelled'])

/** 单进程最多保留多少条报告，防止任务表无限增长。 */
export const MAX_REPORTS = 50

/** 当前时间（ISO 8601）。 */
export const now = () => new Date().toISOString()

let counter = 0

/** 生成短任务 id：t-<时间36>-<序号36>，便于人读且不复用。 */
export function newTaskId() {
  counter = (counter + 1) % 46656
  return `t-${Date.now().toString(36)}-${counter.toString(36)}`
}

let messageSeq = 0
/** 每次加载的随机前缀：配合进程内序号，保证消息 id 跨插件重启也不冲突。 */
const BOOT = Math.random().toString(36).slice(2, 8)

/**
 * 生成消息 id。
 * DSH 对同一 id 的待投递消息会直接抛 “already pending”，所以绝不能重复。
 */
export const nextMessageId = (taskId, kind) => `${taskId}:${kind}:${BOOT}:${++messageSeq}`
