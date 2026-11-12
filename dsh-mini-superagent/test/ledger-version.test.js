/**
 * A4：账本 `version` 读取校验（fail-closed）的回归测试。
 *
 * 钉的是 `store.readState()` 的版本判定与 `Dispatch.restore()` 的重抛：
 * - 过新 / 过旧 → 拒绝读取，**原文件内容与 mtime 都不能变**（fail-closed 的核心是
 *   「不覆盖」，不是「报个错然后照常空表启动」）；
 * - 缺失 `version` → 按旧格式正常读，只在 `restoreError` 留一条 warn；
 * - 主文件 v99 + `.bak` v4 → 以主文件为准拒绝，**不回退**（PRD §8.5 / §8.8 的
 *   风险点：版本判断若放到回退之后，这条用例会从「拒绝」变成「从备份恢复」）。
 *
 * 全部用临时目录里的真实文件，直接走 `readState` / `Dispatch.restore`，
 * 不 mock store —— 这条需求的关键就是「真实文件没被写坏」。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FILE_VERSION, OLDEST_FILE_VERSION } from '../src/constants.js'
import { Dispatch } from '../src/dispatch.js'
import { readState, writeState } from '../src/store.js'

/** 在独立的临时目录里跑一个用例；无论成败都清理。 */
async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mas-ledger-version-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 造一份账本原文。`versionFn` 单独给是为了能写 `undefined`（JSON.stringify 会
 * 直接丢掉这个键，正好模拟「极旧文件里没有 version」）。
 */
function ledger(version, tasks = [{ id: 't-keep', title: '旧任务' }]) {
  const payload = {
    savedAt: '2026-01-01T00:00:00.000Z',
    tasks,
    targets: {},
    retired: [],
  }
  if (version !== undefined) payload.version = version
  return JSON.stringify(payload, null, 2)
}

/** 最小宿主：只提供 restore 会碰到的 logger 与空服务表。 */
function makeHost() {
  const warns = []
  const ctx = {
    logger: { warn: (...args) => warns.push(args.map(String).join(' ')), info() {}, error() {} },
    get: () => undefined,
    on: () => () => {},
    effect: fn => fn,
    agents: { get: () => undefined, list: () => [] },
    sessionController: {},
  }
  return { ctx, warns }
}

function makeDispatch(dir) {
  const host = makeHost()
  const d = new Dispatch(host.ctx, {
    stateDir: dir,
    provisionDefaultWorkspace: false,
    archiveSweepMinutes: 0,
    archiveAfterHours: 0,
  })
  return { d, host }
}

// ---------------------------------------------------------------- 过新

test('A4 version 99：抛 LEDGER_TOO_NEW，原文件内容与 mtime 都不变', async () => withDir(async dir => {
  const file = join(dir, 'tasks.json')
  await writeFile(file, ledger(99), 'utf8')
  const beforeStat = await stat(file)
  const beforeText = await readFile(file, 'utf8')

  await assert.rejects(() => readState(file), error => {
    assert.equal(error.code, 'LEDGER_TOO_NEW', '过新的账本必须给出稳定的 error.code')
    assert.match(error.message, /账本版本 99 高于当前插件支持的 4/, '文案要直接说清版本关系')
    assert.match(error.message, /请升级插件，或改用新的 state 目录/, '文案要给下一步操作')
    assert.match(error.message, /selfCheck 不会执行/, 'fail-closed 后自检不可用，必须在文案里说明')
    return true
  })

  assert.equal(await readFile(file, 'utf8'), beforeText,
    'fail-closed 的核心：拒绝读取时绝不能改写账本')
  const afterStat = await stat(file)
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs,
    '连 mtime 都不能变——读写计时器/备份复制的副作用都要排除')
}))

// ---------------------------------------------------------------- 过旧

test('A4 version 2：抛 LEDGER_TOO_OLD，且不改写原文件', async () => withDir(async dir => {
  const file = join(dir, 'tasks.json')
  await writeFile(file, ledger(2), 'utf8')
  const beforeText = await readFile(file, 'utf8')

  await assert.rejects(() => readState(file), error => {
    assert.equal(error.code, 'LEDGER_TOO_OLD')
    assert.match(error.message, /账本版本 2 低于当前插件可读的最旧版本 3/)
    assert.match(error.message, /请改用新的 state 目录/)
    return true
  })

  assert.equal(await readFile(file, 'utf8'), beforeText, '过旧账本同样不能被动过')
}))

// ---------------------------------------------------------------- 可读区间

test('A4 version 4 / 3：正常读回任务', async () => withDir(async dir => {
  assert.equal(FILE_VERSION, 4, '当前写出版本')
  assert.equal(OLDEST_FILE_VERSION, 3, 'PRD §15 拍板 Q3：可读下限取 3')

  for (const version of [FILE_VERSION, OLDEST_FILE_VERSION]) {
    const file = join(dir, `tasks-${version}.json`)
    await writeFile(file, ledger(version), 'utf8')
    const state = await readState(file)
    assert.equal(state.tasks[0]?.id, 't-keep', `version ${version} 必须能正常读回任务`)
    assert.equal(state.missingVersion, undefined, `version ${version} 不是「缺 version」`)
    assert.equal(state.recovered, undefined, '主文件有效时不该走备份')
  }
}))

// ---------------------------------------------------------------- 缺 version

test('A4 无 version：正常启动，restoreError 留一条 warn', async () => withDir(async dir => {
  const file = join(dir, 'tasks.json')
  await writeFile(file, ledger(undefined), 'utf8')

  const state = await readState(file)
  assert.equal(state.missingVersion, true, '缺失 version 要能被调用方看见（用于留痕，不阻断）')
  assert.equal(state.tasks[0]?.id, 't-keep')

  const { d } = makeDispatch(dir)
  await d.restore()
  assert.match(String(d.restoreError), /账本缺少 version，按旧格式读取/,
    'restoreError 要留一条 warn，用户排查时知道读的是旧格式')
  assert.equal(d.restoreError.includes('LEDGER_TOO'), false, '缺 version 不是版本冲突，不能报成拒绝')
}))

// ---------------------------------------------------------------- 备份路径

test('A4 主文件损坏 + .bak 为 v4：仍能从 .bak 恢复', async () => withDir(async dir => {
  const file = join(dir, 'tasks.json')
  // 第一次写 t-old（无备份），第二次写 t-new 时把第一份留成 .bak。
  await writeState(file, { tasks: [{ id: 't-old' }], targets: {} }, '2026-01-01T00:00:00.000Z')
  await writeState(file, { tasks: [{ id: 't-new' }], targets: {} }, '2026-01-02T00:00:00.000Z')
  // 截断主文件，模拟写到一半被 kill。
  await writeFile(file, '{"broken":', 'utf8')

  const state = await readState(file)
  assert.equal(state.recovered, 'bak', '主文件坏了才允许回退')
  assert.equal(state.tasks[0]?.id, 't-old', '备份里的 v4 账本要能正常读回')
}))

// ---------------------------------------------------------------- 最关键：先判主文件

test('A4 主文件 v99 + .bak v4：拒绝启动，不回退到 .bak', async () => withDir(async dir => {
  const file = join(dir, 'tasks.json')
  await writeFile(file, ledger(99), 'utf8')
  await writeFile(`${file}.bak`, ledger(FILE_VERSION, [{ id: 't-from-bak' }]), 'utf8')

  await assert.rejects(() => readState(file), error => {
    assert.equal(error.code, 'LEDGER_TOO_NEW',
      '主文件是未来版本时，能读的 .bak 也不能把它救回来——否则版本判断等于白做（PRD §8.5）')
    return true
  })

  // 明确断言「没有走备份」：返回里不该有 recovered，且备份内容也不能被「救」出来。
  const bakText = await readFile(`${file}.bak`, 'utf8')
  assert.match(bakText, /t-from-bak/, '备份文件本身保持原样')
}))

// ---------------------------------------------------------------- 非法版本

test('A4 version 是字符串 "4"：明确报错，不静默当 4', async () => withDir(async dir => {
  const file = join(dir, 'tasks.json')
  await writeFile(file, ledger('4'), 'utf8')

  await assert.rejects(() => readState(file), error => {
    assert.equal(error.code, 'LEDGER_TOO_NEW', '无法确认版本时按「过新」fail-closed')
    assert.match(error.message, /version 字段不是整数/)
    assert.match(error.message, /读到 "4"/, '文案要回显实际读到的值，便于排障')
    return true
  })
}))

// ---------------------------------------------------------------- 启动路径

test('A4 restore() 对版本不兼容的账本重新抛出，插件不加载（fail-closed）', async () => withDir(async dir => {
  const file = join(dir, 'tasks.json')
  await writeFile(file, ledger(99), 'utf8')
  const beforeText = await readFile(file, 'utf8')
  const { d, host } = makeDispatch(dir)

  await assert.rejects(() => d.restore(), error => {
    assert.equal(error.code, 'LEDGER_TOO_NEW', 'restore 不能吞掉版本错误——吞掉就等于允许 apply() 继续加载')
    return true
  })

  assert.ok(host.warns.some(line => line.includes('账本版本 99 高于当前插件支持的 4')),
    '插件未加载时 selfCheck 不可用，启动日志是唯一出口，必须留下可检索的一行')
  assert.equal(await readFile(file, 'utf8'), beforeText, 'restore 失败路径也不能写盘覆盖账本')
}))
