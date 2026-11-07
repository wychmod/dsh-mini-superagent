/**
 * 每任务目录 + prepare 命令（对齐上游 `executionRoot/<name-id>` 与 prepare 命令）。
 *
 * 关键取舍：目录**已存在就跳过**（不重复 worktree）、失败**不自动重试**
 * （目录可能已被写了一半，重试会把它当成「已准备好」）。
 */
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Dispatch } from '../src/dispatch.js'
import { prepareEnv, runPrepare, taskDirectory } from '../src/prepare.js'

const exists = async path => access(path).then(() => true, () => false)

function makeHost() {
  const agents = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    get: () => undefined, on: () => () => {}, effect: fn => fn,
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    sessionController: {
      async create() {}, async rename() {},
      async resolveAgent(id) { return agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'not-found' } } },
      async prompt() {},
    },
  }
  return { ctx, agents }
}

async function withDispatch(config, fn) {
  const host = makeHost()
  const dir = await mkdtemp(join(tmpdir(), 'mas-prep-'))
  const d = new Dispatch(host.ctx, {
    stateDir: dir, provisionDefaultWorkspace: false, archiveSweepMinutes: 0, archiveAfterHours: 0,
    ...config,
  })
  d.workspaces = {
    list: () => [], resolve: async () => undefined,
    resolveOrCreate: async () => ({ workspace: undefined, created: false }),
    dayWorkspace: async () => undefined, defaultWorkspace: async () => undefined,
    archiveSession: async () => ({ ok: true }),
    get root() { return dir },
  }
  d.sessions = {
    cwdFor: () => dir, hint: () => {}, dispose: () => {},
    restrictTools: () => () => {}, forgetRestrict: () => {}, holds: () => false,
    async createWorker(sessionId) {
      const agent = {
        id: sessionId, status: 'idle',
        session: { snapshotEvents: () => [] },
        ctx: { systemPrompt: { section: () => () => {} } },
        steer() {}, followup() {}, inject() {}, cancel() {},
      }
      host.agents.set(sessionId, agent)
      return { agent, sessionId }
    },
    dirs: [],
    async enterDirectory(_agent, directory) { this.dirs.push(directory) },
    async deliver() { return { delivered: 'inbox', woke: false } },
  }
  try {
    await fn({ d, host, dir })
  } finally {
    await d.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

const workerTask = (extra = {}) => ({
  id: 't-prep', title: '隔离目录', brief: 'b', parentSessionId: 'lead',
  workerSessionId: 'dispatch-t-prep', status: 'running', reports: [], cwd: 'D:\\repo',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...extra,
})

// ---------------------------------------------------------------- 纯函数

test('taskDirectory：空根不启用，有根时带标题与 id 后缀', () => {
  assert.equal(taskDirectory('', '修复登录', 't-m0abc-1'), undefined)
  const dir = taskDirectory('/tmp/worktrees', '修复登录/超时', 't-m0abc-1')
  assert.match(dir, /修复登录-超时/)   // 路径分隔符被 safeDirName 换掉
  assert.match(dir, /0abc-1$/)          // 取 id 去掉前缀后的后 6 位
  assert.equal(taskDirectory('/tmp/w', '同名', 't-a'), taskDirectory('/tmp/w', '同名', 't-a'))
  assert.notEqual(taskDirectory('/tmp/w', '同名', 't-aaaa-1'), taskDirectory('/tmp/w', '同名', 't-bbbb-1'))
})

test('prepareEnv 给出目录、任务与原始 cwd', () => {
  const env = prepareEnv({ id: 't-1', title: '标题', workspaceTitle: '项目', cwd: 'D:\\repo' }, '/tmp/x/标题-1')
  assert.deepEqual(env, {
    DSH_DISPATCH_DIR: '/tmp/x/标题-1',
    DSH_DISPATCH_TASK: 't-1',
    DSH_DISPATCH_TITLE: '标题',
    DSH_DISPATCH_WORKSPACE: '项目',
    DSH_DISPATCH_CWD: 'D:\\repo',
  })
})

test('runPrepare：目录已存在就不跑命令（不重复 worktree）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mas-prep-exists-'))
  let calls = 0
  const result = await runPrepare({
    dir: join(dir, 'task-1'),
    command: 'git worktree add',
    exec: async () => { calls += 1; return {} },
  })
  // 目录不存在 → 第一次会跑；再造一个已存在的目录验证跳过
  await mkdir(join(dir, 'task-2'), { recursive: true })
  const second = await runPrepare({
    dir: join(dir, 'task-2'),
    command: 'git worktree add',
    exec: async () => { calls += 1; return {} },
  })
  await rm(dir, { recursive: true, force: true })

  assert.equal(result.ran, true)
  assert.equal(second.ran, false)
  assert.equal(calls, 1, '已存在的目录不能再跑一次 prepare')
})

test('runPrepare：命令在父目录执行，环境变量带目标目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mas-prep-run-'))
  const target = join(root, '任务-abc')
  let seen
  const result = await runPrepare({
    dir: target,
    command: 'git worktree add "$DSH_DISPATCH_DIR"',
    env: { DSH_DISPATCH_DIR: target, DSH_DISPATCH_TASK: 't-1' },
    exec: async (cmd, options) => { seen = { cmd, options }; return { stdout: 'ok\n', stderr: '' } },
  })
  await rm(root, { recursive: true, force: true })

  assert.equal(result.ran, true)
  assert.equal(result.output, 'ok')
  assert.equal(seen.options.cwd, root, '命令必须在父目录执行，目标目录由环境变量给出')
  assert.equal(seen.options.env.DSH_DISPATCH_DIR, target)
  assert.ok(seen.options.timeout > 0)
})

test('runPrepare：没有命令就只建目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mas-prep-mkdir-'))
  const target = join(root, 'only-mkdir')
  const result = await runPrepare({ dir: target })
  const made = await exists(target)
  await rm(root, { recursive: true, force: true })

  assert.equal(result.ran, true)
  assert.equal(made, true)
})

test('runPrepare：命令失败时抛出带输出的错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mas-prep-fail-'))
  await assert.rejects(
    () => runPrepare({
      dir: join(root, 'x'),
      command: 'false',
      exec: async () => { throw Object.assign(new Error('exit 1'), { stderr: 'fatal: already exists' }) },
    }),
    error => error.prepareFailed === true && /already exists/.test(error.message),
  )
  await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 与 start() 的集成

test('配了 taskDirRoot：建目录并把 worker 切进去', async () => {
  await withDispatch({ taskDirRoot: '__ROOT__/tasks' }, async ({ d, dir }) => {
    d.config.taskDirRoot = join(dir, 'tasks')
    // 让会话先落在当天的【派发】工作区，再看它是否被切到任务目录。
    d.workspaces.dayWorkspace = async () => ({ id: 'w-day', path: join(dir, '派发'), title: '【派发】' })
    const task = workerTask()
    d.table.add(task)

    await d.start(task)

    assert.equal(task.taskDir, join(dir, 'tasks', '隔离目录-prep'))
    assert.equal(task.cwd, task.taskDir, '任务 cwd 应当指向自己的目录')
    assert.equal(await exists(task.taskDir), true, '目录必须真的建出来')
    assert.equal(task.hostWorkspaceId, 'w-day', '会话仍挂在【派发】工作区（侧边栏干净）')
    assert.deepEqual(d.sessions.dirs, [task.taskDir], '会话要切到任务目录里干活')
    assert.equal(task.status, 'running')
  })
})

test('prepare 失败：任务 failed 且不建子会话', async () => {
  await withDispatch({ prepareTimeoutMs: 5000 }, async ({ d, dir, host }) => {
    d.config.taskDirRoot = join(dir, 'tasks')
    d.config.prepareCommand = 'node -e "process.exit(3)"'
    let created = 0
    d.sessions.createWorker = async () => { created += 1; throw new Error('不该建会话') }
    const delivered = []
    d.sessions.deliver = async (_s, _r, text) => { delivered.push(text); return { delivered: 'inbox', woke: false } }
    host.agents.set('lead', { id: 'lead', status: 'running' })
    const task = workerTask()
    d.table.add(task)

    await d.start(task)

    assert.equal(task.status, 'failed')
    assert.match(task.error, /prepare 命令失败/)
    assert.equal(created, 0, 'prepare 失败时不应该留下一个孤儿会话')
    assert.equal(delivered.length, 1, '失败原因要回报主会话')
  })
})

test('没配 taskDirRoot：行为和以前一样，不动 cwd', async () => {
  await withDispatch({}, async ({ d }) => {
    const task = workerTask()
    d.table.add(task)

    await d.start(task)

    assert.equal(task.taskDir, undefined)
    assert.equal(task.cwd, 'D:\\repo')
    assert.deepEqual(d.sessions.dirs, [])
  })
})
