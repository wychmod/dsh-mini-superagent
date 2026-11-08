/**
 * 任务看板的 Host 半边：两个只读快照 + 若干写操作，走普通 HTTP 路由。
 *
 * 为什么不用 Remote/RPC：看板是同源页面里的普通 fetch，走 HTTP 最直接，
 * 也不需要为一个只读面板去定义一套跨进程契约。
 *
 * 路由（prefix 注册，挂在 /dsh-mini-superagent/board 下）：
 *   GET  /dsh-mini-superagent/board           -> BoardSnapshot
 *   GET  /dsh-mini-superagent/board/retired   -> 已退休任务（只读，见 plans/07 P0-5）
 *   POST /dsh-mini-superagent/board/cancel    {"task_id"} -> {ok, task}
 *   POST /dsh-mini-superagent/board/retry     {"task_id"} -> {ok, task}
 */
import { BOARD_ALLOWED_HOSTS, BOARD_HEADER, LOG_PREFIX, SETTLED, VERSION } from './constants.js'

/** 路由前缀；客户端 client/index.js 里有一份同样的常量，改一处要改两处。 */
const BASE = '/dsh-mini-superagent/board'

/** 单次响应最多带多少条任务。 */
const MAX_TASKS = 200

/**
 * 单次响应最多带多少条退休记录。
 *
 * 与 MAX_TASKS 取同一个数量级：退休**不参与指标**，面板只用它回答「它什么时候、
 * 为什么消失的」，所以它是一份「够用就行」的答案，不是可翻页的审计导出。
 * 超过上限时用 dropped 明说少给了多少，而不是悄悄截断。
 */
const MAX_RETIRED = 200

/** 快照里 worker 最后输出的预览长度。 */
const PREVIEW_CHARS = 500

/** 排序权重：进行中的排最前，其余按更新时间倒序。 */
const WEIGHT = { running: 0, queued: 1 }

/**
 * 一条任务的「耗时」毫秒数。
 *
 * 已结算的任务必须量到**结算那一刻**，不能量到「现在」：后者会让一个
 * 26 小时前就 done 的任务一直显示「26 时 0 分」并继续增长，看起来像还在跑
 * （看板对 running 还会本地叠加走表，所以这个基准必须是能停住的时刻）。
 *
 * 结算时间取 `updatedAt`：tasks.settle / transition 都会把它写成 now()，
 * 而 archivedAt 要等归档巡检才补，用它会让刚结算的任务显示不出耗时。
 * 结算时刻不可能早于开始时刻，但仍做一次夹紧，避免时钟回拨变成负数。
 *
 * 已结算却没有可解析的 `updatedAt`（只可能来自损坏或历史数据）时返回 0
 * 表示「不知道」，**不能**退回 Date.now() —— 那等于把「耗时一直增长」这个
 * 缺陷在退化数据上又请回来了，而这正是本次要消灭的行为。
 */
function elapsedOf(task, started) {
  if (!Number.isFinite(started)) return 0
  if (!SETTLED.has(task.status)) return Math.max(0, Date.now() - started)
  const settled = task.updatedAt ? Date.parse(task.updatedAt) : NaN
  if (!Number.isFinite(settled)) return 0
  return Math.max(0, settled - started)
}

/** 一条任务在看板上的形状。字段刻意拍平，客户端不需要理解内部结构。 */
export function boardTask(task) {
  const reports = Array.isArray(task.reports) ? task.reports : []
  const last = reports.length ? reports.at(-1) : undefined
  const started = task.startedAt ? Date.parse(task.startedAt) : NaN
  /**
   * 「有一条报告被截过」。
   *
   * 只给布尔，**不把正文搬上快照**：快照是每轮轮询都要重传的东西，把 6000 字
   * 的报告塞进来等于用带宽换一个小标记；要看正文的人走 `dispatch_inspect`。
   * 两个来源都要看：`truncated` 是报告条目入库时留的截断长度（P0-3），
   * `briefTruncated` 是落盘时对超长简报的截断标记——后者坏了会让
   * 「retry 重投的是残版简报」再次无声发生。
   */
  const hasTruncated = reports.some(entry => entry?.truncated) || !!task.briefTruncated
  /**
   * 「待读」的超时改写（P0-4）：`sweepMemory()` 把过期的 `inputPendingAt` 换成
   * `inputUnknownAt`，语义从「已投递未读」降级成「不知道读没读到」。
   *
   * 两个字段互斥：**unknown 必须以 pending 缺席的方式出现**，否则看板会同时显示
   * 「还在等它读」（pending 行）和「不知道」（unknown 行）——而前者是个永远不会
   * 结束的状态，比不显示更误导人。判定照抄 `card()`：read 之后两者都不显。
   */
  const inputPendingAt = task.inputPendingAt && !task.inputReadAt && !task.inputUnknownAt
    ? task.inputPendingAt
    : undefined
  const inputUnknownAt = task.inputUnknownAt && !task.inputReadAt ? task.inputUnknownAt : undefined
  return {
    task_id: task.id,
    title: task.title,
    status: task.status,
    attempt: task.attempt ?? 1,
    parent_session_id: task.parentSessionId,
    worker_session_id: task.workerSessionId,
    cwd: task.cwd,
    workspace_id: task.workspaceId ?? null,
    workspace_title: task.workspaceTitle ?? null,
    // 子会话实际挂在哪个工作区（没指定目标时就是当天的【派发】工作区）。
    // 与 workspace_title（派发目标）不是一回事，看板显示这个才有归属感。
    host_workspace_id: task.hostWorkspaceId ?? null,
    host_workspace_title: task.hostWorkspaceTitle ?? null,
    archived_at: task.archivedAt ?? null,
    ...(task.group ? { group: task.group } : {}),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    turn_started_at: task.turnStartedAt,
    elapsed_ms: elapsedOf(task, started),
    report_count: reports.length,
    last_report: last ? { at: last.at, status: last.status, summary: last.summary } : null,
    last_text_preview: typeof task.lastText === 'string' ? task.lastText.slice(0, PREVIEW_CHARS) : '',
    // 追问的投递阶段：pending = 进了收件箱但 worker 还没读；read = 已经读进上下文。
    // pending 与 unknown 互斥（见上面的注释），所以两者都用可选字段的写法。
    ...(inputPendingAt ? { input_pending_at: inputPendingAt } : {}),
    input_read_at: task.inputReadAt ?? null,
    // P0-4：待读超时后被降级成「不知道」。只在真的发生过时出现。
    ...(inputUnknownAt ? { input_unknown_at: inputUnknownAt } : {}),
    retry_at: task.retryAt ?? null,
    // 每任务的独立目录与准备时间（配了 taskDirRoot 才有）。
    task_dir: task.taskDir ?? null,
    prepare_at: task.prepareAt ?? null,
    // 后台活：回合结束了但 job/subagent 还在跑，任务仍占着并发位。
    background: task.background ?? null,
    background_killed: task.backgroundKilled ?? null,
    /**
     * 归档 = 只读冻结（P0-4），冻结时刻必须投影出去。
     *
     * 少了它，看板无法区分「已归档冻结」与普通已结算行——冻结本来就是为了
     * 「这条不会再变了」，不显示等于让用户以为它还能被改。与 `retired_at`
     * 是两件事：归档的任务仍在表里（可取消归档），退休的已经移出账本。
     */
    ...(task.frozenAt ? { frozen_at: task.frozenAt } : {}),
    // 报告被截断过：只给布尔做小标记（**不搬全文**，见上面的注释）。
    ...(hasTruncated ? { has_truncated: true } : {}),
    ...(task.error ? { error: String(task.error) } : {}),
    ...(task.archiveError ? { archive_error: String(task.archiveError) } : {}),
  }
}

/**
 * 记忆治理的统计块（见 plans/07 §六 P0-1 / P0-5）。
 *
 * 必须**防御**三层：
 * - `memoryStats()` 可能不存在（旧版宿主 / headless）；
 * - 可能抛错；
 * - 可能是 **async** 的（host 实际就是异步：它要读活表与留痕两份）。
 *
 * 同步快照拿不到 thenable 的值，这时宁可给 null（客户端按「窗口未知 / 宿主未提供」
 * 降级），也**不能**把 Promise 塞进 JSON —— JSON.stringify(Promise) 会得到 `{}`，
 * 客户端会把它读成「宿主给了一个空块」，比 null 更难排查。
 * 需要真实值的调用方（HTTP 路由）走 resolveMemory() 先把值 await 出来再传进来。
 */
function memoryOf(dispatch, provided) {
  if (provided !== undefined) return provided && typeof provided === 'object' ? provided : null
  try {
    if (typeof dispatch.memoryStats !== 'function') return null
    const stats = dispatch.memoryStats()
    if (stats && typeof stats.then === 'function') return null       // 同步快照里的 async 宿主
    return stats && typeof stats === 'object' ? stats : null
  } catch {
    return null
  }
}

/**
 * 取一份**已解析**的记忆统计：同步函数直接用，thenable 在这里 await 掉。
 * 失败一律返回 null，让看板继续可用 —— 指标口径坏掉不该让人看不见任务。
 * @returns {Promise<object|null>}
 */
async function resolveMemory(dispatch) {
  try {
    if (typeof dispatch.memoryStats !== 'function') return null
    const value = dispatch.memoryStats()
    const stats = value && typeof value.then === 'function' ? await value : value
    return stats && typeof stats === 'object' ? stats : null
  } catch {
    return null
  }
}

/**
 * 整块看板的数据。
 * @param {object} dispatch
 * @param {object|null} [memory] 已解析的 memoryStats；省略时尝试同步取（可能得 null）
 */
export function boardSnapshot(dispatch, memory) {
  const all = [...dispatch.table.tasks.values()]
  const counts = { total: all.length, running: 0, queued: 0, done: 0, blocked: 0, failed: 0, cancelled: 0, ended: 0, interrupted: 0, archived: 0, retired: 0 }
  for (const task of all) {
    if (task.status in counts) counts[task.status] += 1
    if (task.archivedAt) counts.archived += 1
  }
  // 退休数是「历史上已被移出账本」的条数，它**不在** tasks 里，
  // 所以只能从 memoryStats 拿；拿不到就是 0（= 这块信息宿主没提供）。
  const stats = memoryOf(dispatch, memory)
  counts.retired = Number.isFinite(stats?.retired?.count) ? stats.retired.count : 0
  const tasks = all
    .sort((a, b) => (WEIGHT[a.status] ?? 2) - (WEIGHT[b.status] ?? 2)
      || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_TASKS)
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    concurrency: { running: counts.running, queued: counts.queued, max: dispatch.table.maxWorkers },
    counts,
    // 任务数超过展示上限时，明确告诉看板「列表被截断了」。
    // 否则「总计 500 / 列表 200」看起来像数据丢了，用户会去翻根本不存在的条目。
    // 注意 total 取截断前的 all.length（counts.total 是同一份数，这里独立算一份，
    // 免得将来 counts 的定义变了，截断比例跟着漂）。
    truncated: all.length > MAX_TASKS ? { shown: MAX_TASKS, total: all.length } : null,
    // 工作区列表给看板做「按工作区分组 / 切工作区」用；注册表不可用时为空数组。
    workspaces: (dispatch.workspaces?.list?.() ?? []).map(item => ({ id: item.id, title: item.title, path: item.path })),
    // 每个主会话当前选的「派发目标工作区」；没选的不出现。
    targets: Object.fromEntries(dispatch.targets ?? []),
    tasks: tasks.map(boardTask),
    /**
     * 记忆治理统计：窗口口径、账本容量、退休数。
     * 显式放 null 而不是省略字段：客户端要能区分「宿主没提供」与「这是旧版宿主」，
     * 两者都按「窗口未知」降级，但排障时看得出差别。
     */
    memory: stats,
  }
}

/**
 * 已退休任务的一条记录。
 *
 * 字段刻意与 boardTask 用同一套命名（snake_case + `_at` 后缀），
 * 客户端不必为第二种形状再写一遍取值逻辑。
 */
function retiredEntry(record) {
  const id = String(record?.id ?? '')
  return {
    task_id: id,
    title: typeof record?.title === 'string' ? record.title : '',
    status: typeof record?.status === 'string' ? record.status : '',
    retired_at: record?.retiredAt ?? null,
    retired_reason: record?.retiredReason ?? null,
    archived_at: record?.archivedAt ?? null,
    updated_at: record?.updatedAt ?? null,
    // 退休记录的正文只留摘要：账本封顶的目的是「写放大有上界」，
    // 如果退休时把 6000 字正文整段搬到另一个 Map 里，只是换了个地方存。
    summary: typeof record?.summary === 'string' ? record.summary : '',
  }
}

/**
 * 退休视图的数据。
 *
 * 三条约定（都是「不要让用户以为数据丢了」）：
 * - 倒序：最近的退休最该被看到，它最可能是用户刚发现"任务不见了"的那条；
 * - `dropped`：超过 MAX_RETIRED 时明说少给了多少，而不是悄悄截断；
 * - `dispatch.retired` 不存在（旧版宿主 / headless）时返回空表而非报错 ——
 *   这是一个只读诊断视图，宿主没这个能力就该显示「没有」，不该 500。
 */
export function retiredSnapshot(dispatch) {
  const ledger = dispatch.retired
  const entries = ledger instanceof Map ? [...ledger.values()] : []
  const sorted = entries
    .slice()
    .sort((a, b) => String(b?.retiredAt ?? '').localeCompare(String(a?.retiredAt ?? '')))
  const shown = sorted.slice(0, MAX_RETIRED)
  return {
    ok: true,
    count: sorted.length,
    dropped: Math.max(0, sorted.length - shown.length),
    entries: shown.map(retiredEntry),
  }
}

/** 写 JSON 响应。 */
function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 读请求体并解析 JSON；超限或非法直接拒绝。
 *
 * 超限时**不要** `req.destroy()`：那会让客户端收到 ECONNRESET 而不是
 * 我们准备好的 400，排障时看起来像服务挂了。正确做法是停止累积，
 * 把剩余数据读完（继续消费 data 事件），让响应能正常发出去。
 */
function readJson(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    let overflow = false
    const chunks = []
    req.on('data', chunk => {
      if (overflow) return
      size += chunk.length
      if (size > limitBytes) {
        overflow = true
        chunks.length = 0
        reject(new Error(`请求体过大（上限 ${limitBytes} 字节）`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) return
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 本机回环地址的 Host 名。 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 取 Host 头里的主机名（去掉端口，IPv6 方括号保留）。 */
function hostnameOf(host) {
  const value = String(host ?? '')
  if (value.startsWith('[')) {                      // [::1]:3082
    const end = value.indexOf(']')
    return end > 0 ? value.slice(0, end + 1) : value
  }
  return value.replace(/:\d+$/, '')
}

/** 是否带了自定义准入头（见 constants.js 的 BOARD_HEADER 说明）。 */
function hasBoardHeader(req) {
  return String(req.headers?.[BOARD_HEADER] ?? '') !== ''
}

/**
 * 准入模型（0.7.0 重写）。
 *
 * 0.6.0 的判据是「`Origin.host === Host` 即同源」，但没有 `Origin` 时
 * 直接放行。这个判据可以被 DNS rebinding 完全绕过：
 *
 *   攻击者页面在 `http://evil.example:9735`（该域名解析到 127.0.0.1），
 *   它向同一个 evil.example:9735 发请求 —— 浏览器的 `Host` 与 `Origin`
 *   都是 `evil.example:9735`，判据恒真；而不带 Origin 的 POST 更是无条件放行。
 *   实测该请求能读全部任务标题/工作目录/报告摘要，能归档、改派发目标、取消任务。
 *
 * 关键认识：**自定义头挡不住 rebinding**。攻击者页面与目标同源，
 * 加自定义头不触发预检，所以「必须带头」对这类攻击无效。真正的判据是
 * Host 必须是我们真正在监听的那个地址——浏览器无法伪造 `Host`
 * （它来自 URL），而攻击者无法让受害者浏览器把 `127.0.0.1:9735`
 * 当作自己的源。
 *
 * 所以：
 * - **回环 Host**（127.0.0.1 / localhost / ::1）放行读；写操作另需
 *   自定义头，挡掉「同源页面里的恶意脚本」与简单的 CSRF。
 * - **非回环 Host** 默认拒绝。要开放远程访问，就把该 Host 显式写进
 *   `BOARD_ALLOWED_HOSTS`（此时仍要求 Origin 与 Host 一致）。
 */
function isLoopbackHost(host) {
  return LOOPBACK.has(hostnameOf(host))
}

/** Host 是否在显式放行清单里。 */
function isAllowedHost(host) {
  const allowed = BOARD_ALLOWED_HOSTS
  if (allowed.includes('*')) return true
  return allowed.includes(String(host ?? ''))
}

/**
 * 读操作准入：回环 Host 直接放行；其它 Host 必须显式放行且同源。
 *
 * 回环放行是安全的：`Host` 由 URL 决定，攻击者页面（evil.example）
 * 想让浏览器发出 `Host: 127.0.0.1:9735` 就必须真的去连 127.0.0.1，
 * 而那时 `Origin` 是 evil.example —— 所以回环分支仍要看 Origin，
 * 只接受「没有 Origin」（本机 curl / 同页面导航）或「Origin 也是回环」。
 */
function isLoopbackOrigin(origin) {
  if (!origin) return true                          // curl / 直接导航
  try { return LOOPBACK.has(hostnameOf(new URL(origin).host)) } catch { return false }
}

function readAllowed(req) {
  const host = String(req.headers?.host ?? '')
  const origin = req.headers?.origin

  if (isLoopbackHost(host)) return isLoopbackOrigin(origin)

  if (!isAllowedHost(host)) return false
  if (!origin) return true
  try { return new URL(origin).host === host } catch { return false }
}

/**
 * 写操作准入：在读操作的基础上，额外要求自定义头。
 *
 * 自定义头在这里的作用不是防 rebinding（那由 Host 判定负责），
 * 而是防**同源页面之外的脚本**与简单 CSRF：跨站发带自定义头的请求
 * 会触发预检，预检不带凭据也不带这个头，服务端拒绝后真请求不会发出。
 */
function writeAllowed(req) {
  if (!readAllowed(req)) return false
  return hasBoardHeader(req)
}

/** 会话 id 的合法形状：DSH 的 sessionId 是 `session-<uuid>`，默认主会话是配置里的固定 id。 */
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/

/**
 * 这个 sessionId 是否值得为它记一个派发目标。
 *
 * 三个来源任一命中即算：
 * - 宿主当前有这个 agent（活的会话）；
 * - 配置里的默认主会话 id（`mas-lead` 那种，可能还没创建）；
 * - 形状合法且看起来是真实会话（`session-…`），交给后续解析。
 *
 * 目的是挡住 `__proto__`、空串、超长垃圾这类无意义写入——它们会
 * 污染 targets 并随 persist 落盘。
 */
function isKnownSession(dispatch, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return false
  if (sessionId === '__proto__' || sessionId === 'constructor' || sessionId === 'prototype') return false
  if (dispatch.ctx?.agents?.get?.(sessionId)) return true
  const lead = String(dispatch.config?.leadSessionId || 'mas-lead')
  if (sessionId === lead) return true
  return sessionId.startsWith('session-')
}

/**
 * 构造看板请求处理器。单独导出是为了能在单测里直接喂假的 req/res，
 * 不必起一个真的 HTTP 服务。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createBoardHandler(ctx, dispatch) {
  return async function boardHandler(req, res) {
    let pathname
    try { pathname = new URL(req.url ?? '', 'http://localhost').pathname }
    catch { return send(res, 400, { ok: false, error: '请求地址不合法' }) }

    try {
      if (req.method === 'GET' && pathname === BASE) {
        if (!readAllowed(req)) return send(res, 403, { ok: false, error: '看板只对本机或同源页面开放' })
        // memoryStats 是 async 的（要读活表与留痕两份），必须先把值 await 出来，
        // 否则 JSON 里会出现一个被序列化成 `{}` 的 Promise。
        return send(res, 200, boardSnapshot(dispatch, await resolveMemory(dispatch)))
      }

      if (req.method === 'POST' && pathname === `${BASE}/client-ready`) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        let body
        try { body = await readJson(req) }
        catch (error) { return send(res, 400, { ok: false, error: String(error?.message ?? error) }) }
        dispatch.clientReady = {
          at: new Date().toISOString(),
          ok: body?.ok !== false,
          ...(Array.isArray(body?.registered) ? { registered: body.registered.slice(0, 20).map(String) } : {}),
          ...(body?.error ? { error: String(body.error).slice(0, 500) } : {}),
        }
        return send(res, 200, { ok: true })
      }

      if (req.method === 'GET' && pathname === `${BASE}/selfcheck`) {
        if (!readAllowed(req)) return send(res, 403, { ok: false, error: '看板只对本机或同源页面开放' })
        return send(res, 200, await dispatch.selfCheck())
      }

      /**
       * 已退休任务：只读诊断视图（plans/07 P0-5「退休可查」）。
       *
       * 与 GET /board 同档准入（`readAllowed`），不要求写头：它只读、不含正文、
       * 只回答「这条任务什么时候因为什么被移出账本」。退休本身**不是**写操作，
       * 不能被面板触发 —— 退休由 host 的封顶逻辑决定，面板只能看。
       *
       * 退休记录刻意**不**回落进 tasks 列表：那会让退休行为看起来像没发生，
       * 也会让「账本有上界」这个验收项（plans/07 §七 4）无法从快照上验证。
       */
      if (req.method === 'GET' && pathname === `${BASE}/retired`) {
        if (!readAllowed(req)) return send(res, 403, { ok: false, error: '看板只对本机或同源页面开放' })
        return send(res, 200, retiredSnapshot(dispatch))
      }

      if (req.method === 'POST' && pathname === `${BASE}/archive`) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        const result = await dispatch.archiveStale()
        return send(res, 200, { ok: true, ...result, counts: boardSnapshot(dispatch, await resolveMemory(dispatch)).counts })
      }

      if (req.method === 'POST' && pathname === `${BASE}/target`) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        let body
        try { body = await readJson(req) }
        catch (error) { return send(res, 400, { ok: false, error: String(error?.message ?? error) }) }
        const sessionId = String(body?.session_id ?? '').trim()
        if (!sessionId) return send(res, 400, { ok: false, error: '需要 session_id' })
        // 只允许给「真实存在的主会话」或「已登记的默认主会话」设目标。
        // 0.6.0 之前只校验非空，任意字符串（含 __proto__、不存在的会话）
        // 都会返回 200 并写进 targets，随后随 persist 落到 tasks.json。
        if (!isKnownSession(dispatch, sessionId)) {
          return send(res, 404, { ok: false, error: `没有会话 ${sessionId}` })
        }
        try {
          const target = await dispatch.setTarget(sessionId, body?.workspace)
          return send(res, 200, { ok: true, target: target ?? null })
        } catch (error) {
          return send(res, 409, { ok: false, error: String(error?.message ?? error) })
        }
      }

      if (req.method === 'POST' && (pathname === `${BASE}/cancel` || pathname === `${BASE}/retry`)) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        let body
        try { body = await readJson(req) }
        catch (error) { return send(res, 400, { ok: false, error: String(error?.message ?? error) }) }

        const task = dispatch.table.get(String(body?.task_id ?? ''))
        if (!task) return send(res, 404, { ok: false, error: `没有任务 ${body?.task_id ?? ''}` })

        try {
          if (pathname === `${BASE}/cancel`) await dispatch.cancel(task, '看板取消')
          else await dispatch.retry(task)
          return send(res, 200, { ok: true, task: boardTask(task) })
        } catch (error) {
          return send(res, 409, { ok: false, error: String(error?.message ?? error) })
        }
      }

      return send(res, 404, { ok: false, error: '未知的看板接口' })
    } catch (error) {
      ctx.logger?.warn?.('%s 看板接口出错: %s', LOG_PREFIX, String(error))
      return send(res, 500, { ok: false, error: '看板接口内部错误' })
    }
  }
}

/**
 * 注册看板路由；宿主没有 webServer（headless 形态）时安静跳过。
 * @returns {(() => void) | undefined} 注销函数
 */
export function registerBoardRoutes(ctx, dispatch) {
  const server = ctx.get('webServer')
  if (!server || typeof server.register !== 'function') {
    ctx.logger?.info?.('%s 没有 webServer，跳过任务看板路由', LOG_PREFIX)
    return undefined
  }
  return server.register({ kind: 'prefix', path: BASE, handler: createBoardHandler(ctx, dispatch) })
}
