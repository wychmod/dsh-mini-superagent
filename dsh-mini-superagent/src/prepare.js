/**
 * 每任务一个目录 + 一次性 prepare 命令（典型用法：`git worktree add`）。
 *
 * 对照上游 `dsh-superagent` 的 `executionRoot/<name-id>` 与 prepare 命令：
 * - 目录只在**不存在**时准备一次；存在就当成已经准备好，不重复跑命令
 *   （否则第二次派发会在一个已有 checkout 上再 worktree 一次，直接失败）。
 * - 命令的 cwd 是**父目录**，通过环境变量拿到目标目录，这样 `git worktree add "$DSH_DISPATCH_DIR"`
 *   这种写法成立。
 * - 超时即失败（上游 10 分钟）：挂在凭据提示上的命令会一直占着并发位。
 * - 失败**不自动重试**：目录可能已经被命令写了一半，重试会把它当成「已准备好」。
 *   这条与上游 `PrepareFailed` 的取舍一致。
 */
import { exec as execCallback } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { safeDirName } from './workspaces.js'

const execAsync = promisify(execCallback)

/**
 * 任务目录：`<taskDirRoot>/<标题派生的安全名>-<任务 id 后 6 位>`。
 * 带 id 后缀是为了让同名任务不撞目录（同名任务完全可能被派两次）。
 *
 * @param {string} root 配置的根目录；空字符串表示不启用
 * @param {string} title 任务标题
 * @param {string} taskId 任务 id（形如 `t-m0abc-1`）
 * @returns {string | undefined}
 */
export function taskDirectory(root, title, taskId) {
  const base = String(root ?? '').trim()
  if (!base) return undefined
  const suffix = String(taskId ?? '').replace(/^t-/, '').slice(-6) || 'task'
  return join(base, `${safeDirName(title)}-${suffix}`)
}

/** 目录是否已存在（存在即视为「已准备好」）。 */
export async function directoryExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * prepare 命令与环境变量：变量名照上游的 `DSH_SUPERAGENT_*` 改成 `DSH_DISPATCH_*`，
 * 语义一样——目录、任务 id、标题、派发目标工作区、原始 cwd。
 */
export function prepareEnv(task, dir) {
  return {
    DSH_DISPATCH_DIR: dir,
    DSH_DISPATCH_TASK: String(task.id ?? ''),
    DSH_DISPATCH_TITLE: String(task.title ?? ''),
    DSH_DISPATCH_WORKSPACE: String(task.workspaceTitle ?? ''),
    DSH_DISPATCH_CWD: String(task.cwd ?? ''),
  }
}

/**
 * 准备任务目录：目录不存在就先跑一次命令（没有命令就只 `mkdir`）。
 *
 * `exec` 可注入，单测不需要真的起 shell。
 *
 * @param {{ dir: string, command?: string, timeoutMs?: number, env?: object,
 *           exec?: (cmd: string, options: object) => Promise<{stdout?: string, stderr?: string}> }} options
 * @returns {Promise<{ ran: boolean, dir: string, output?: string }>}
 */
export async function runPrepare({ dir, command, timeoutMs = 600_000, env = {}, exec = execAsync }) {
  const parent = dirname(dir)
  await mkdir(parent, { recursive: true })
  if (await directoryExists(dir)) return { ran: false, dir }

  const cmd = String(command ?? '').trim()
  if (!cmd) {
    await mkdir(dir, { recursive: true })
    return { ran: true, dir }
  }

  try {
    const result = await exec(cmd, {
      cwd: parent,
      env: { ...process.env, ...env },
      timeout: Math.max(1000, Number(timeoutMs) || 600_000),
      maxBuffer: 1024 * 1024,
    })
    const output = `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim()
    await mkdir(dir, { recursive: true })
    return { ran: true, dir, ...(output ? { output } : {}) }
  } catch (error) {
    const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim()
    const detail = output || String(error?.message ?? error)
    throw Object.assign(new Error(`prepare 命令失败：${detail}`), { prepareFailed: true, output: detail })
  }
}
