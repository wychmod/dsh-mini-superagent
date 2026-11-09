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

/**
 * 「说话方式」段的标题行与长度门禁（plans/10 §五、§七.1）。
 *
 * 为什么标题行放在常量里、正文留在 `src/prompt.js`：plans/10 §七.1 要求
 * 「风格提示段 ≤ 8 行、≤ 500 字」，这条门禁必须量**真正装配进请求的那段文本**，
 * 所以测试要有一个**稳定锚点**在渲染结果里把它切出来。正文是会反复润色的散文
 * （「说人话」这类要求本身就得以人话写），锚点和数字不能跟着漂——放在这里，
 * 以后润色措辞时测试不必改，门禁却始终盯着真实的渲染结果。
 *
 * 两个上限是**行为契约**，不是排版偏好：§九 把「提示词继续膨胀」列为风险，
 * 规则越长每条被读到的概率越低，受害的恰恰是本段。改大它们之前先读 §九。
 */
export const VOICE_SECTION = {
  /** 段落首行；测试按它定位整段。改这行等于改契约，两处（提示与测试）会同时看到。 */
  TITLE: '说话方式（对用户说，不是对系统；不得覆盖事实与安全规则，简洁与准确冲突时先准确）:',
  /** 段落最多几行（含标题行与示例行）。 */
  MAX_LINES: 8,
  /** 段落最多多少字（按 code point 数，中文一个字算一个）。 */
  MAX_CHARS: 500,
}

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

/**
 * 账本「退休」原因。
 *
 * 退休是**可查的丢弃**：任务记录从活表移出，只在 `Dispatch.retired` 里留一条
 * 带 `retiredAt` / `retiredReason` 的薄记录。原因必须是稳定的机器串（不能是
 * 中文句子），看板与 `dispatch_inspect` 都按它分类计数；要给人看的中文说明
 * 放在投影层，不要写进账本。
 */
export const RETIRED_REASONS = {
  /** 全局条数超过 `ledgerMaxTasks`。 */
  CAP_COUNT: 'cap-count',
  /** 非活跃且 `updatedAt` 早于 `ledgerMaxDays` 天。 */
  CAP_DAYS: 'cap-days',
}

/**
 * 报告写入后的**准入结论**（P0-2）。
 *
 * - `direct`：必须回流主会话（结论、需要人处理的事）
 * - `ledger`：只入账本，不回流（过程信息）
 *
 * 名字与字段和 board/client 共享，改这里等于改契约。
 */
export const ADMISSION = {
  DIRECT: 'direct',
  LEDGER: 'ledger',
}

/**
 * 投递形态（P1-2）：同一条报告，**账本里存什么**与**会话里发什么**分开两件事。
 *
 * - `full`：正文照发（短报告，四段式原样）；
 * - `digest`：只发「摘要 + 指针」（有 `detail` 长正文、或摘要超过投影预算时）；
 * - `ledger`：**没有进会话**。三种情形都归这里：准入是 `ledger` 的过程信息、
 *   被 `progressRelayIntervalMs` 节流挡下、或批次成员等汇总。
 *
 * 为什么不用布尔：`digest` 与 `ledger` 的区别是「发了但短」与「没发」，
 * 用布尔会把它们压成同一个值，过后没人能回答「这条到底进没进会话」。
 */
export const PROJECTION = {
  FULL: 'full',
  DIGEST: 'digest',
  LEDGER: 'ledger',
}

/**
 * 合并窗口只收这一种报告（P1-1）。
 *
 * 为什么只收 `progress`：合并的前提是「后一条会**取代**前一条」。终态、需要人
 * 处理的事、批次汇总都不满足这条——它们每一条都必须各自到达，合并其中任何一条
 * 都等于把结论吞掉。`progress` 是唯一「说的事同一件、只是更新了进度」的状态。
 *
 * 为什么写成集合而不是 `status === 'progress'`：以后要放开别的过程状态时，
 * 判断只改这里一处，不用去翻 `mergeableOf()` 的三层条件。
 */
export const MERGEABLE_REPORT_STATUSES = new Set(['progress'])

/**
 * 合并窗口的**硬上限**（毫秒）。
 *
 * 这是 §九 写死的数字，不是调参建议：窗口一旦超过 2 秒，「过程信息晚到」
 * 就会变成「用户以为卡住了」。配置超过它时按它截断，而不是照配。
 */
export const NOTICE_MERGE_MAX_MS = 2000

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
   * 未消费通知的**合并窗口**（毫秒，P1-1）；0 = 关闭合并（每条通知立即投递）。
   *
   * 为什么需要它，而不是再加一个节流：`progressRelayIntervalMs` 是**丢弃式**的
   * ——一分钟内的第二条进度直接不回流，用户看到的是「一分钟只有一条」，粒度粗、
   * 且信息真的丢了。合并窗口补的是另一个缺口：窗口内的多条过程通知**合成最后
   * 一条**，只丢中间态、不丢当前态。两者并存不冲突：节流管「多久允许一次」，
   * 合并管「一次允许几条」。
   *
   * 为什么默认 1500ms：§九 要求「合并窗口上限 2 秒」（见 `NOTICE_MERGE_MAX_MS`），
   * 而 1–2 秒之间的差别对人是不可感知的，取中位数即可。
   *
   * **谁不参与**是这一项的硬约束，不是优化：终态（`done`/`blocked`/`failed`/
   * `cancelled`）、批次汇总、启动失败、回合兜底都不进合并队列——§九 把「合并导致
   * 延迟」的应对写成了一句话：直通类永不参与合并。判据在 `Dispatch.mergeableOf()`。
   */
  noticeMergeWindowMs: 1500,
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
  /**
   * 派生指标窗口：最近 N 天（P0-1）。
   *
   * 为什么需要窗口：`effectStats()` 原来对**全部**未归档已结算任务计算，
   * 上个月失败的几条会一直给今天的成功率投票，数字越用越不代表现状。
   * 窗口只影响**指标口径**，不影响任务是否存在（退休/归档由 P0-5 管）。
   */
  memoryWindowDays: 7,
  /** 派生指标窗口：最近 M 条已结算（与 `memoryWindowDays` 取交集，先到先算）。 */
  memoryWindowTasks: 200,
  /**
   * 单条报告 `summary` 的入库上限（P0-3）。
   *
   * 与 `reportText()` 外发时的截断长度**取同一个数**，否则会出现
   * 「库里很长、发出去很短」的错位：`dispatch_inspect` 看到的和主会话
   * 看到的不是一份东西。反之若只截外发，账本仍由调用方决定体积。
   */
  maxReportSummaryChars: 6000,
  /** 单条报告 `detail` 的入库上限（P0-3）；同上，与外发截断取同一口径。 */
  maxReportDetailChars: 4000,
  /** `task.lastText`（worker 最后一段输出）的入库上限（P0-3）。 */
  maxLastTextChars: 5000,
  /**
   * 「已投递未读」的存活上限（毫秒，P0-4，默认 30 分钟）。
   *
   * 宿主在某些部署里不发 `session/event`，于是 `inputPendingAt` 会**永久**挂着
   * 「待读」，看板上看起来像 worker 卡住了。超时后不假装读过，而是改写成
   * `inputUnknownAt`——「不知道读没读到」比「永远在读」更接近事实。
   */
  inputPendingTtlMs: 1800000,
  /**
   * 会话销毁时是否清掉它的派发目标（P0-4，默认开）。
   *
   * 不清的代价：`targets` 只增不减，且 `agent/disposed` 是唯一能确定
   * 「这个会话再也不会派发」的时刻。留着孤儿条目还会让 `dispatch_list`
   * 之外的路径（重启恢复）反复读回不存在的会话。
   */
  clearTargetsOnDispose: true,
  /** 账本全局条数上限（P0-5）；超出按「已归档优先 → 最老 updatedAt」退休。 */
  ledgerMaxTasks: 1000,
  /** 账本保留天数（P0-5）：非活跃且更早的任务退休。 */
  ledgerMaxDays: 90,
  /** 退休留痕列表上限（P0-5）；超出丢弃最老的并累加 `retiredDropped`。 */
  ledgerMaxRetired: 5000,
  /**
   * 默认**必须直通**主会话的报告状态（P0-2）。
   *
   * `done` 不在这里的默认值里，但 `admissionOf()` 对 `done` 恒判 `direct`：
   * 配置项只用来扩展（例如把 `progress` 也放开），不能用来把结论类状态降级——
   * 那样主会话会永远等不到「做完了」。
   */
  directReportStatuses: ['blocked', 'failed'],
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

/**
 * 完成率的分母（plans/09 §四 A）。
 *
 * **取消不在这里**：取消是用户主动收回，不是任务执行的结果。把它算进分母会
 * 让「我今天取消了 3 个排错的任务」直接压低成功率——那个数字随后会被当成
 * 质量信号解读，而它其实只反映用户改了主意。取消率在 `boardStats` 里单列。
 *
 * 与 `SETTLED` 的差别只有这一个元素，但两个集合的**含义**不同：`SETTLED` 管
 * 「还占不占并发位/还要不要等它」，这个管「谁有权给完成率投票」。共用一份会让
 * 以后想加状态的人一次改两处语义。
 */
export const COMPLETION_BASE = new Set(['done', 'ended', 'failed', 'blocked', 'interrupted'])

/**
 * 状态的**展示顺序**（不是语义集合）。
 *
 * 只用于把分布排成「进行中 → 完成 → 出问题 → 用户收回」这个读得懂的顺序；
 * 判断「是否已结算」用 `SETTLED`，判断「能不能进完成率分母」用 `COMPLETION_BASE`。
 * 三个东西混成一个，就会有人为了改一下图的顺序去动成功率口径。
 */
export const STATUS_ORDER = ['running', 'queued', 'done', 'ended', 'failed', 'blocked', 'interrupted', 'cancelled']

/**
 * 状态 → **对着用户说的话**（plans/10 §三「禁止词与替换表」）。
 *
 * 为什么放在常量和 `STATUS_ORDER` 挨着：状态词本身在这里定义，它的中文说法
 * 也该在同一个文件里——新增一个状态时最容易漏的恰恰是「对用户的那一面」，
 * 漏了就退化成 `done`/`failed` 这种内部词流进用户视野。
 *
 * 这里只放**单句结论**；「需要你做什么」属于句式，留在 `src/voice.js`。
 */
export const STATUS_VOICE = {
  queued: '排队中',
  running: '正在做',
  done: '做完了',
  ended: '跑完了，但没给结论',
  // 只说「卡住了」，不写「需要你定」：行动指向归【需要你】段，
  // 两处都写会让同一句话在一条报告里出现两遍（重复不会让人更重视，只会让人跳读）。
  blocked: '卡住了',
  failed: '没做成',
  interrupted: '中途断了',
  cancelled: '已取消',
  progress: '还在做',
  unknown: '状态未知',
}

/**
 * 报告文本的段名（plans/10 §四.2 的四段式）。
 *
 * 段名是**机器可读的稳定标记**：测试按它切行，主会话按它找结论。
 * 所以它只在这里出现一次——散在各个拼接处一定会漂移成 `【任务】` / `[任务]`
 * 两种写法，而测试只认其中一种，另一种就静默漏检。
 */
export const REPORT_SECTIONS = {
  TASK: '【任务】',
  RESULT: '【结果】',
  NOTE: '【说明】',
  NEED: '【需要你】',
  DETAIL: '【细节】',
  BATCH: '【批次】',
}

/**
 * 任务短标签的长度预算（plans/10 §三「任务短标签怎么起」）。
 *
 * `MAX` 是常态上限（12 字够放下「对象 + 动作」）；`LINE_MAX` 是**硬界**，
 * 在标签后面补工作区/范围做同名区分时也靠它兜住——没有它，一个 120 字的
 * 标题会把 `【任务】` 行撑成一整段。
 */
export const LABEL = {
  MIN: 6,
  MAX: 12,
  LINE_MAX: 40,
}

/** `headline` 的长度契约（plans/10 §四.1）：给用户看的一句话结论，≤40 字。 */
export const HEADLINE_MAX = 40

/**
 * `headline` 的**入库**上限。
 *
 * 与 `HEADLINE_MAX` 是两件事：展示必须 ≤40（超了就不是一句话了），入库留
 * 一点余量只是为了不让账本的体积由调用方决定。120 足够放下 40 字结论加上
 * 一段前缀说明；真超了在投影时截断，账本里仍能看到「它到底写了多长」。
 */
export const HEADLINE_LEDGER_MAX = 120

/**
 * 给模型看的那份报告的**投影预算**（plans/10 §四.2）。
 *
 * 与 `maxReportSummaryChars`（入库上限）是两件事：入库限长决定账本体积，
 * 这里决定「回流主会话的那一段有多长」。压缩只作用于投影——账本永远是全文，
 * 所以 `dispatch_inspect` 读回来的不会被这里削减。
 */
export const REPORT_VIEW = {
  SUMMARY: 800,
  /**
   * 摘要超过 `SUMMARY` 时的**摘要级预算**（P1-2）。
   *
   * 为什么不是干脆把 `SUMMARY` 调小：800 以内是一段人读得完的说明，硬压到 240
   * 会让「中等长度、本来能完整说清」的报告变成残句。分两档之后，短报告**一个字
   * 都不动**（这也是 10-P0 四段式现在的常态），只有真的写长了才切到「摘要 + 指针」。
   */
  DIGEST: 240,
  REASON: 240,
}

/**
 * 结算时刻的**时间基准标记**（plans/09 §三.2）。
 *
 * `settledAt` 是权威值：只在状态进入终态时写一次，此后不会被报告、追问、归档刷新。
 * 旧数据（0.8.x 及更早落盘的、没有这个字段）读的时候回退 `updatedAt`，但**必须
 * 带上这个标记**——`updatedAt` 会被后续动作改写，拿它算精确生命周期统计等于把
 * 「大概什么时候结束的」冒充成「什么时候结束的」。标记让前端能写出「时间基准：
 * 最后更新」而不是假装精确。`MIXED` 表示窗口内两种基准都有（部分任务回退过）。
 */
export const TIME_BASIS = {
  SETTLED: 'settledAt',
  FALLBACK: 'updatedAt-fallback',
  MIXED: 'mixed',
  MISSING: 'missing',
}

/**
 * `GET /board/stats` 的契约版本（plans/09 §六.1）。
 *
 * 只允许**加字段**，不允许改既有字段的含义；前端按它决定能不能用新字段，
 * 不认识就退回基础视图。改这个数等于告诉所有旧客户端「你看到的口径可能变了」。
 */
export const STATS_VERSION = 1

/**
 * 「全部时间」的窗口键。其余窗口键的语法是 `<n>h` / `<n>d`（见 src/stats.js）。
 * 放在这里是因为它是**跨端字符串**：前端拼 `?window=all`，服务端按同一个字面量判。
 */
export const STATS_WINDOW_ALL = 'all'

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

/**
 * 子会话 id 前缀：本插件建出来的 worker 会话一律长这样。
 *
 * 为什么把它提到常量里（plans/08 阶段 1）：续派（`continue_task_id`）要回答
 * 「这条任务的子会话是不是**本插件**建的」。判据只能落在**形状**上——
 * 宿主不记录「这个会话是谁建的」，而复活一条不是我们派的会话、往里塞一条要求，
 * 是拿别人的上下文当自己的工作线用。形状判据至少能挡住「手填一个真实会话 id」。
 *
 * 同一份形状同时被 `launch()` 与 `retry()`（换 attempt 时是 `<前缀><id>-a<n>`）使用，
 * 所以两处都必须引用这一个常量：字面量散落在两处时，改一处就会让校验与产出分家。
 */
export const WORKER_PREFIX = 'dispatch-'

/**
 * 一个会话 id 是不是本插件建的 worker 会话。
 *
 * 只判前缀与「前缀之后还有内容」：`dispatch-` 本身不是任何合法会话。
 * 不判 `dispatch-<taskId>` 的完整语法——`retry()` 的 `-a<attempt>` 后缀、
 * 以及将来可能加的其它后缀都该算数，校验的目的只是「本插件建的」。
 *
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function isWorkerSessionId(sessionId) {
  const value = typeof sessionId === 'string' ? sessionId.trim() : ''
  return value.startsWith(WORKER_PREFIX) && value.length > WORKER_PREFIX.length
}

/**
 * 线程 id 前缀（plans/08 阶段 0）。
 *
 * **为什么现在就要有线程这个概念**：阶段 0 只做「解耦」——今天一条任务就是一条
 * 会话、也就是一条线程，所以 `threadId` 完全由任务 id 派生、不与任务 id 分家。
 * 但阶段 2（模型 B：新任务复用旧会话）要的是「一条会话 = 一条线程，任务 = 线程上
 * 的一段」，那时 `threadId` 必须**独立于任务 id** 存在：同线程的第二个任务要沿用
 * 第一个任务的 `threadId`，而不是自己铸一个新的。
 *
 * 所以这里先把**标识的形状**定下来（前缀 + 由任务 id 派生），加字段而不加逻辑：
 * 阶段 2 只需要在 `launch()` 里改成「复制活跃任务的 threadId」，其余读取路径
 * （归档按线程、统计按线程）一行都不用改。
 */
export const THREAD_PREFIX = 'thread-'

/**
 * 由任务 id 派生线程 id（阶段 0 的 1:1 规则：一任务一线程）。
 *
 * 用派生而不是随机：**幂等**是这里的全部价值。老数据（tasks.json 里没有
 * `threadId` 的任务）在 `restore()` 时按同一条规则补出来，得到的 id 与「新版本
 * 当时就会写下的那个」逐字相同——于是「升级前派的」与「升级后派的」同一条任务
 * 永远落在同一条线程里，不会因为在哪个版本写的而分裂成两条线程。
 *
 * @param {string} taskId
 * @returns {string}
 */
export function newThreadId(taskId) {
  return `${THREAD_PREFIX}${String(taskId ?? '')}`
}

let messageSeq = 0
/** 每次加载的随机前缀：配合进程内序号，保证消息 id 跨插件重启也不冲突。 */
const BOOT = Math.random().toString(36).slice(2, 8)

/**
 * 生成消息 id。
 * DSH 对同一 id 的待投递消息会直接抛 “already pending”，所以绝不能重复。
 */
export const nextMessageId = (taskId, kind) => `${taskId}:${kind}:${BOOT}:${++messageSeq}`
