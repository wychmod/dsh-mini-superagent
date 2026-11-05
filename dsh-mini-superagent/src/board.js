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
import { LOG_PREFIX, VERSION } from './constants.js'

/** 路由前缀；客户端 client/index.js 里有一份同样的常量，改一处要改两处。 */
const BASE = '/dsh-mini-superagent/board'

/** 单次响应最多带多少条任务。 */
const MAX_TASKS = 200

/** 快照里 worker 最后输出的预览长度。 */
const PREVIEW_CHARS = 500

/** 排序权重：进行中的排最前，其余按更新时间倒序。 */
const WEIGHT = { running: 0, queued: 1 }

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
    elapsed_ms: Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0,
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
    // 工作区列表给看板做「按工作区分组 / 切工作区」用；注册表不可用时为空数组。
    workspaces: (dispatch.workspaces?.list?.() ?? []).map(item => ({ id: item.id, title: item.title, path: item.path })),
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

/** 读请求体并解析 JSON；超限或非法直接拒绝。 */
function readJson(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * 写操作的同源校验：浏览器带了 Origin 就必须和宿主同源。
 * 这不是完整的鉴权（同源页面本来就有权限），只是挡掉跨站伪造的 POST。
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 本机回环地址的 Host 名。 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 读操作的准入：本机回环放行；非回环要求「同源页面」。
 *
 * 为什么不一放了之：DSH 自己的页面路由要求鉴权，而插件注册的具名路由排在
 * 鉴权前面。若看板接口对所有来源开放，把 Web 暴露到局域网时，任何人都能读到
 * 任务标题、工作目录和报告摘要。远程浏览器访问同源页面仍然可用，远程 curl 不可用。
 */
function readAllowed(req) {
  const host = String(req.headers.host ?? '')
  const hostname = host.replace(/:\d+$/, '')
  if (LOOPBACK.has(hostname)) return true
  const origin = req.headers.origin
  if (!origin) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
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

      if (req.method === 'POST' && pathname === `${BASE}/archive`) {
        if (!sameOrigin(req)) return send(res, 403, { ok: false, error: '跨站请求被拒绝' })
        const result = await dispatch.archiveStale()
        return send(res, 200, { ok: true, ...result, counts: boardSnapshot(dispatch).counts })
      }

      if (req.method === 'POST' && (pathname === `${BASE}/cancel` || pathname === `${BASE}/retry`)) {
        if (!sameOrigin(req)) return send(res, 403, { ok: false, error: '跨站请求被拒绝' })
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
