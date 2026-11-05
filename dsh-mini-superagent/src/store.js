/**
 * 任务表落盘：一个 JSON 文件，没有数据库、没有迁移框架。
 * 读失败（除文件不存在）不阻止插件启动，只记日志——任务表是辅助信息，
 * 丢了不影响子会话本身（会话内容由 DSH 自己持久化）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 文件结构版本；读取时不强校验，只用于人工排查。 */
const FILE_VERSION = 2

/** 读回任务数组；文件不存在返回空数组。 */
export async function readTaskFile(file) {
  let raw
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return Array.isArray(raw?.tasks) ? raw.tasks : []
}

/** 写任务数组（覆盖写）。 */
export async function writeTaskFile(file, tasks, savedAt) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: FILE_VERSION, savedAt, tasks }, null, 2), 'utf8')
}
