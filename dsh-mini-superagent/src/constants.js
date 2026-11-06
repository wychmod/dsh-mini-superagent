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

/** 默认配置；cordis.patch.yml 里的 config 会覆盖这里的字段。 */export const DEFAULTS = {
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
   * 子会话放在哪个工作区：
   * - `day`：每天的【派发】工作区（默认，侧边栏保持干净）
   * - `target`：任务指定的目标工作区（子会话混在项目里）
   */
  workerWorkspace: 'day',
  /** 默认主会话的固定 id；改成别的值等于换一个新默认会话。 */
  leadSessionId: 'mas-lead',
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
