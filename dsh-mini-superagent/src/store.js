/**
 * 状态落盘：一个 JSON 文件，没有数据库、没有迁移框架。
 *
 * 内容是 `{ version, savedAt, tasks, targets }`：
 * - `tasks`   任务表（报告、状态、归档标记）
 * - `targets` 每个主会话的派发目标工作区（输入框选择器写入）
 *
 * 读失败（除文件不存在）不阻止插件启动，只记日志——任务表是辅助信息，
 * 丢了不影响子会话本身（会话内容由 DSH 自己持久化）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 文件结构版本；读取时不强校验，只用于人工排查。 */
const FILE_VERSION = 3

/** 空状态。 */
export const EMPTY_STATE = { tasks: [], targets: {} }

/** 读回状态；文件不存在返回空状态。 */
export async function readState(file) {
  let raw
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...EMPTY_STATE }
    throw error
  }
  return {
    tasks: Array.isArray(raw?.tasks) ? raw.tasks : [],
    targets: raw?.targets && typeof raw.targets === 'object' && !Array.isArray(raw.targets) ? raw.targets : {},
  }
}

/** 写状态（覆盖写）。 */
export async function writeState(file, { tasks, targets }, savedAt) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: FILE_VERSION, savedAt, tasks, targets }, null, 2), 'utf8')
}
