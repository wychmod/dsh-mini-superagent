/**
 * 任务看板的 Host 半边：一个只读快照 + 两个写操作，走普通 HTTP 路由。
 *
 * 为什么不用 Remote/RPC：看板是同源页面里的普通 fetch，走 HTTP 最直接，
 * 也不需要为一个只读面板去定义一套跨进程契约。
 *
 * 路由（prefix 注册，挂在 /dsh-mini-superagent/board 下）：
 *   GET  /dsh-mini-superagent/board           -> BoardSnapshot
 *   POST /dsh-mini-superagent/board/cancel    {"task_id"} -> {ok, task}
 *   POST /dsh-mini-superagent/board/retry     {"task_id"} -> {ok, task}
 */
import { BOARD_ALLOWED_HOSTS, BOARD_HEADER, LOG_PREFIX, SETTLED, VERSION } from './constants.js'

/** 路由前缀；客户端 client/index.js 里有一份同样的常量，改一处要改两处。 */
const BASE = '/dsh-mini-superagent/board'

/** 单次响应最多带多少条任务。 */
const MAX_TASKS = 200

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
  const last = Array.isArray(task.reports) && task.reports.length ? task.reports.at(-1) : undefined
  const started = task.startedAt ? Date.parse(task.startedAt) : NaN
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
    archived_at: task.archivedAt ?? null,
    ...(task.group ? { group: task.group } : {}),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    turn_started_at: task.turnStartedAt,
    elapsed_ms: elapsedOf(task, started),
    report_count: Array.isArray(task.reports) ? task.reports.length : 0,
    last_report: last ? { at: last.at, status: last.status, summary: last.summary } : null,
    last_text_preview: typeof task.lastText === 'string' ? task.lastText.slice(0, PREVIEW_CHARS) : '',
    ...(task.error ? { error: String(task.error) } : {}),
    ...(task.archiveError ? { archive_error: String(task.archiveError) } : {}),
  }
}

/** 整块看板的数据。 */
export function boardSnapshot(dispatch) {
  const all = [...dispatch.table.tasks.values()]
  const counts = { total: all.length, running: 0, queued: 0, done: 0, blocked: 0, failed: 0, cancelled: 0, ended: 0, interrupted: 0, archived: 0 }
  for (const task of all) {
    if (task.status in counts) counts[task.status] += 1
    if (task.archivedAt) counts.archived += 1
  }
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
        return send(res, 200, boardSnapshot(dispatch))
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

      if (req.method === 'POST' && pathname === `${BASE}/archive`) {
        if (!writeAllowed(req)) return send(res, 403, { ok: false, error: '看板写操作需要同源页面或带 `x-dsh-mini-superagent` 头的本机调用' })
        const result = await dispatch.archiveStale()
        return send(res, 200, { ok: true, ...result, counts: boardSnapshot(dispatch).counts })
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
