/**
 * 状态落盘：一个 JSON 文件，没有数据库、没有迁移框架。
 *
 * 内容是 `{ version, savedAt, tasks, targets, retired }`：
 * - `tasks`   任务表（报告、状态、归档标记）。任务对象**原样序列化**，所以
 *             阶段 0/2 新增的可选字段（`threadId` / `parentTaskId`）不需要
 *             迁移框架：新版本写、新版本读；老文件缺这些键时由 `restore()`
 *             按「独立任务 / 派生线程」归一，不报错。
 * - `targets` 每个主会话的派发目标工作区（输入框选择器写入）
 * - `retired` 已退休任务的薄留痕（P0-5）：`retiredAt` / `retiredReason` 等，
 *             **不带 reports**。它必须落盘，否则重启后「任务去哪了」无从回答，
 *             而「可查的丢弃」正是退休能成立的前提。
 *
 * 读失败（除文件不存在）不阻止插件启动，只记日志——但绝不能因此说
 * 「任务表是辅助信息、丢了不影响」。任务表是**派发事实的唯一权威**
 * （docs/architecture.md §26）：状态、归属、报告、投递成败、归档退休都只在
 * 这里。它的缺失必须被说出来——`readState()` 在主文件与 `.bak` 都坏时抛错，
 * `restore()` 记 `restoreError` 并 warn。会话内容由 DSH 持久化是另一份事实，
 * 不能拿来替账本免责。
 *
 * ## 为什么写得这么绕
 *
 * 0.6.0 之前这里是裸 `writeFile` 覆盖写。进程在写入中途崩溃（或断电、或
 * 被 kill）会留下半截 JSON，`readState` 直接抛错，`restore` 只 warn 然后
 * 以空表启动——全部历史任务丢失，而用户无法区分「第一次装」和
 * 「数据被我写坏了」。实测：把一个有效文件截断 10 字节后读回，
 * 抛 `Unterminated string in JSON`。
 *
 * 现在的做法是标准的原子替换：
 *   1. 写 `<file>.tmp`
 *   2. fsync 落盘（保证数据真的到了磁盘，不只是页缓存）
 *   3. rename 覆盖目标（同一文件系统上 rename 是原子的：
 *      要么看到旧文件，要么看到完整的新文件，不会有第三种状态）
 *   4. 失败时清理 tmp，并把上一份有效内容留在 `<file>.bak`
 *
 * 读的时候若主文件损坏，自动回退到 `.bak`，并在结果里标明走了回退，
 * 让调用方能提示用户。
 */
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 文件结构版本；读取时不强校验，只用于人工排查。
 *
 * 4（本版）：新增 `retired` 数组。旧文件（3 及更早）没有这个键，
 * `normalize()` 按空数组读——**不迁移、不报错**，因为退休留痕丢了只影响
 * 「它为什么消失」这一条可查性，不该让升级后的插件起不来。
 */
const FILE_VERSION = 4

/** 空状态。 */
export const EMPTY_STATE = { tasks: [], targets: {}, retired: [] }

/** 备份文件后缀。 */
const BAK = '.bak'
/** 临时文件后缀。 */
const TMP = '.tmp'

/** 把原始 JSON 解析成状态形状。 */
function normalize(raw) {
  return {
    tasks: Array.isArray(raw?.tasks) ? raw.tasks : [],
    targets: raw?.targets && typeof raw.targets === 'object' && !Array.isArray(raw.targets) ? raw.targets : {},
    // 旧文件没有 retired：空数组即可。只保留对象条目——数组里混进字符串
    // 会让 `Map` 构造与 `oneLine(record.summary)` 在下面各处炸掉。
    retired: Array.isArray(raw?.retired)
      ? raw.retired.filter(item => item && typeof item === 'object')
      : [],
  }
}

/**
 * 读回状态；文件不存在返回空状态。
 *
 * 主文件损坏时回退到 `.bak`。两者都坏就抛错，让调用方明确知道
 * 「数据没了」，而不是拿空表继续跑。
 *
 * @returns {Promise<{tasks: object[], targets: object, recovered?: 'bak'}>}
 */
export async function readState(file) {
  let primaryError
  try {
    return normalize(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // 主文件不存在：看看是不是有备份（上一次 rename 之后被删了的情况）
      try {
        const recovered = normalize(JSON.parse(await readFile(`${file}${BAK}`, 'utf8')))
        return { ...recovered, recovered: 'bak' }
      } catch {
        return { ...EMPTY_STATE }
      }
    }
    primaryError = error
  }

  // 主文件存在但解析失败：尝试备份
  try {
    const recovered = normalize(JSON.parse(await readFile(`${file}${BAK}`, 'utf8')))
    return { ...recovered, recovered: 'bak' }
  } catch {
    // 两个都不可用：把主文件的错误抛出去，它是更有诊断价值的那个
    throw primaryError
  }
}

/**
 * 写状态（原子替换）。
 *
 * @param {string} file 目标文件
 * @param {{tasks: object[], targets: object, retired?: object[]}} state
 * @param {string} savedAt ISO 时间戳
 */
export async function writeState(file, { tasks, targets, retired }, savedAt) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}${TMP}`
  // retired 缺省写空数组而不是 undefined：显式键让「读的人知道这是新格式」，
  // 而且 JSON.stringify 会直接丢掉 undefined 键，落盘文件里就再也看不到它。
  const payload = JSON.stringify({
    version: FILE_VERSION,
    savedAt,
    tasks,
    targets,
    retired: Array.isArray(retired) ? retired : [],
  }, null, 2)

  try {
    // 1) 先写临时文件并 fsync，确保内容真的落盘
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    // 2) 把当前有效文件留一份备份（失败不阻塞主流程：备份是加分项）
    try { await copyFile(file, `${file}${BAK}`) } catch { /* 首次写入没有旧文件 */ }

    // 3) 原子替换
    await rename(tmp, file)
  } catch (error) {
    // 清理临时文件，避免残留
    try { await rm(tmp, { force: true }) } catch { /* 清理失败不掩盖原始错误 */ }
    throw error
  }
}
