#!/usr/bin/env node
/**
 * 对**正在运行的** DSH 拉一遍 dsh-mini-superagent 的 HTTP 接口，验证宿主侧契约。
 *
 * 用法：
 *   node scripts/http-smoke.mjs                       # 默认 http://127.0.0.1:11586
 *   node scripts/http-smoke.mjs http://127.0.0.1:3080  # 指定别的宿主
 *
 * 只做读操作 + 一个可逆的写操作（设目标再清掉）。不派发任务、不归档、不取消任何东西。
 * 退出码 0 = 全过；1 = 有断言失败。
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:11586').replace(/\/+$/, '')
const API = `${BASE}/dsh-mini-superagent/board`

let passed = 0
const failures = []

function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function getJson(path) {
  const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

async function postJson(path, payload) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

console.log(`目标宿主: ${BASE}\n`)

// 1. 自检
console.log('自检')
const self = await getJson('/selfcheck')
check('GET /selfcheck 返回 200', self.status === 200, `实际 ${self.status}`)
if (self.status === 200) {
  const s = self.body
  check('版本号非空', typeof s.version === 'string' && s.version.length > 0, String(s.version))
  check('webServer 可用', s.host?.webServer === true)
  check('workspaceRegistry 可用', s.host?.workspaceRegistry === true)
  check('默认工作区已注册', !!s.workspaces?.default?.id, s.workspaces?.default?.title)
  check('默认主会话存在', s.lead?.exists === true, s.lead?.sessionId)
  // 客户端模块是否进了 Web 启动图：false 时面板/控件不会出现，需要重启宿主。
  console.log(`    client.inGraph = ${s.client?.inGraph}`)
  console.log(`    client.ready   = ${s.client?.ready ? JSON.stringify(s.client.ready) : '（页面还没自报）'}`)
  if (s.client?.inGraph === false) {
    console.log('    ⚠ 客户端模块还不在 Web 启动图里：面板与输入框控件不会出现，需要重启 DSH 宿主。')
    console.log(`      对照探针: ${JSON.stringify(s.client?.probes ?? {})}`)
  } else if (s.client?.ready?.ok === false) {
    console.log(`    ⚠ 客户端 apply 报错了: ${s.client.ready.error ?? '（无原因）'}`)
  } else if (!s.client?.ready) {
    console.log('    ⚠ 模块已进图但页面还没自报：刷新一次页面后应出现 client.ready。')
  } else {
    const registered = s.client.ready.registered ?? []
    console.log(`    注册项: ${registered.join(' / ') || '（未报告）'}`)
  }
}

// 2. 看板快照
console.log('\n看板快照')
const board = await getJson('')
check('GET /board 返回 200', board.status === 200, `实际 ${board.status}`)
const snapshot = board.body
if (board.status === 200) {
  check('concurrency 有 running/queued/max', typeof snapshot.concurrency?.running === 'number'
    && typeof snapshot.concurrency?.queued === 'number' && typeof snapshot.concurrency?.max === 'number')
  check('counts.archived 是数字', typeof snapshot.counts?.archived === 'number')
  check('workspaces 是数组', Array.isArray(snapshot.workspaces))
  check('targets 是对象', snapshot.targets !== null && typeof snapshot.targets === 'object')
  check('tasks 是数组', Array.isArray(snapshot.tasks))
  check('running 不超过 max', snapshot.concurrency.running <= snapshot.concurrency.max,
    `${snapshot.concurrency.running} > ${snapshot.concurrency.max}`)
  check('每张任务卡都带 status 与 worker_session_id',
    snapshot.tasks.every(task => typeof task.status === 'string' && typeof task.worker_session_id === 'string'))
  check('归档任务都带 archived_at',
    snapshot.tasks.filter(task => task.archived_at).length === snapshot.counts.archived,
    `标了 ${snapshot.tasks.filter(task => task.archived_at).length} / counts ${snapshot.counts.archived}`)
}

// 3. 派发目标：设置 → 读回 → 清除（可逆）
console.log('\n派发目标（可逆写）')
const workspace = snapshot?.workspaces?.[0]
const sessionId = 'smoke-session-does-not-need-to-exist'
if (workspace) {
  const set = await postJson('/target', { session_id: sessionId, workspace: workspace.id })
  check('POST /target 设置返回 200', set.status === 200, `实际 ${set.status}`)
  check('返回的目标与所选工作区一致', set.body?.target?.workspace_id === workspace.id)
  const afterSet = await getJson('')
  check('快照里能看到这个目标', afterSet.body?.targets?.[sessionId]?.workspace_id === workspace.id)

  const clear = await postJson('/target', { session_id: sessionId, workspace: '' })
  check('POST /target 清除返回 200', clear.status === 200, `实际 ${clear.status}`)
  check('清除后 target 为 null', clear.body?.target === null)
  const afterClear = await getJson('')
  check('快照里目标已消失', afterClear.body?.targets?.[sessionId] === undefined)

  const bad = await postJson('/target', { session_id: sessionId, workspace: '__definitely_not_a_workspace__' })
  check('解析不到的工作区返回 409', bad.status === 409, `实际 ${bad.status}`)
  check('409 带中文原因', typeof bad.body?.error === 'string' && bad.body.error.includes('找不到工作区'))
} else {
  console.log('  - 跳过：快照里没有工作区')
}

// 4. 错误路径
console.log('\n错误路径')
const missing = await postJson('/cancel', { task_id: 't-does-not-exist' })
check('取消不存在的任务返回 404', missing.status === 404, `实际 ${missing.status}`)
const noSession = await postJson('/target', { workspace: 'x' })
check('缺 session_id 返回 400', noSession.status === 400, `实际 ${noSession.status}`)
const unknown = await getJson('/nope')
check('未知子路径返回 404', unknown.status === 404, `实际 ${unknown.status}`)

// 5. 汇总
console.log('')
if (failures.length) {
  console.error(`失败 ${failures.length} 项，通过 ${passed} 项：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`全部通过：${passed} 项检查`)
if (self.status === 200 && self.body?.client?.inGraph === false) {
  console.log('注意：上面全部通过只代表宿主侧没问题；客户端面板仍需重启宿主后才会出现。')
}
