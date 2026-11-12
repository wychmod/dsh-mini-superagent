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
 * **例外是版本不兼容（A4）**：账本声明的 `version` 比插件新（或比可读下限旧）时
 * 不降级、不空表继续，而是抛 `LEDGER_TOO_NEW` / `LEDGER_TOO_OLD` 让插件加载失败。
 * 理由见 `assertReadableVersion()` 上方：读不懂的文件继续跑，下一次写盘就会把它
 * 覆盖成插件自以为的形状，用户升级后账本已经没了——那是不可逆的数据损失，
 * 比「插件起不来、只能看启动日志」严重得多。
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

import { FILE_VERSION, OLDEST_FILE_VERSION } from './constants.js'

/** 空状态。 */
export const EMPTY_STATE = { tasks: [], targets: {}, retired: [] }

/**
 * 账本版本不兼容时的 `error.code`。
 *
 * 它们是启动期错误，**不属于** `constants.ERROR_CODES` 的 `dispatch/*` 闭集：
 * 那张表是工具返回值与看板 HTTP 响应的机器可读标识，而这两个错误发生时插件
 * 根本不会加载，`selfCheck()` 与看板都不可用——唯一出口是启动日志。
 * 塞进闭集会误导消费方以为「工具失败后可以拿 code 去分流重试」。
 */
export const LEDGER_VERSION_CODES = Object.freeze({
  TOO_NEW: 'LEDGER_TOO_NEW',
  TOO_OLD: 'LEDGER_TOO_OLD',
})

const LEDGER_VERSION_CODE_SET = new Set(Object.values(LEDGER_VERSION_CODES))

/** 这个错误是不是「账本版本不兼容」——`restore()` 据此决定是否 fail-closed。 */
export function isLedgerVersionError(error) {
  return LEDGER_VERSION_CODE_SET.has(error?.code)
}

/** 生成一个带稳定 `code` 的账本版本错误（`code` 不经过 `ERROR_CODES` 闭集）。 */
function ledgerVersionError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 校验账本声明的结构版本，不合法就抛错（fail-closed 的判定点）。
 *
 * 为什么 fail-closed 而不是「只读降级」：本文件的写盘是**整文件原子替换**，
 * 不存在「只改我认识的字段」这种写法。如果读回一个未来版本的账本后照常启动，
 * 任务表在内存里是「按旧格式理解的样子」，下一次 `persist()` 就会用这个空心
 * 状态覆盖原文件——用户为了用新插件装的版本降级回来一看，账本已经被写没了。
 * 拒绝加载的代价是「插件工具消失 + 一行日志」，覆盖账本的代价是不可逆的数据损失。
 *
 * 顺序契约（PRD §8.8 风险）：这个函数必须在**主文件解析成功后立刻**调用，
 * 早于任何 `.bak` 回退。否则「主文件 v99 + 备份 v4」会被备份救回来，等于白拦。
 *
 * @param {unknown} raw 解析后的账本原文
 * @returns {{missingVersion?: true}} 缺失 `version` 时给出提示标记，其余合法
 */
function assertReadableVersion(raw) {
  const version = raw?.version
  // 缺失 `version` 是**极旧账本**，不是版本冲突：现有 `normalize()` 的
  // 「缺字段按空读」能完整覆盖它的形状。这里不阻断启动，只让 `restore()`
  // 在 `restoreError` 留一条 warn，用户排查时知道读的是旧格式。
  if (version === undefined || version === null) return { missingVersion: true }
  // 非整数（典型是手改成字符串 "4"）不能静默当 4：无法确认它是「当前版本的手误」
  // 还是「某个未来格式真的长这样」。按 too-new 处理，宁可拒绝加载也不覆盖。
  if (!Number.isInteger(version)) {
    throw ledgerVersionError(LEDGER_VERSION_CODES.TOO_NEW,
      `账本的 version 字段不是整数（读到 ${JSON.stringify(version)}），无法确认是否为当前插件支持的 ${FILE_VERSION}；请升级插件，或改用新的 state 目录。插件已按 fail-closed 拒绝加载，selfCheck 不会执行，只能查看启动日志。`)
  }
  if (version > FILE_VERSION) {
    throw ledgerVersionError(LEDGER_VERSION_CODES.TOO_NEW,
      `账本版本 ${version} 高于当前插件支持的 ${FILE_VERSION}；请升级插件，或改用新的 state 目录。插件已按 fail-closed 拒绝加载，selfCheck 不会执行，只能查看启动日志。`)
  }
  if (version < OLDEST_FILE_VERSION) {
    throw ledgerVersionError(LEDGER_VERSION_CODES.TOO_OLD,
      `账本版本 ${version} 低于当前插件可读的最旧版本 ${OLDEST_FILE_VERSION}；请改用新的 state 目录（旧账本先用仍兼容它的旧版插件导出）。插件已按 fail-closed 拒绝加载，selfCheck 不会执行，只能查看启动日志。`)
  }
  return {}
}

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

/** 把版本判定结果并进读回结果（`missingVersion` 只存在于内存，不落盘）。 */
function withVersionNote(state, verdict) {
  return verdict.missingVersion ? { ...state, missingVersion: true } : state
}

/**
 * 读 `.bak` 并做同样的版本判定；不存在或损坏返回 `undefined`。
 *
 * 回退成功后同样要判版本：备份里也可能是一份「未来版本」的账本，静默读进来
 * 仍会在下一次写盘把它覆盖。
 */
async function readBackup(file) {
  let raw
  try {
    raw = JSON.parse(await readFile(`${file}${BAK}`, 'utf8'))
  } catch {
    return undefined
  }
  const verdict = assertReadableVersion(raw)
  return withVersionNote({ ...normalize(raw), recovered: 'bak' }, verdict)
}

/**
 * 读回状态；文件不存在返回空状态。
 *
 * 版本规则（A4）：
 * - 主文件解析成功 → **立刻**判版本，早于任何 `.bak` 回退。这是 §8.8 点名的
 *   风险点：若先回退再判，「主文件 v99 + 备份 v4」会被备份救活，等于白拦。
 * - 主文件不存在 / 解析失败 → 维持原有 `.bak` 回退顺序；回退成功后同样判版本。
 *
 * 版本不兼容时抛 `LEDGER_TOO_NEW` / `LEDGER_TOO_OLD`，由 `restore()` 重抛，
 * 让 `apply()` 失败、插件不加载。**这条错不会被 `.bak` 吞掉**——主文件读不懂
 * 就是读不懂，不能拿备份假装没事。
 *
 * @returns {Promise<{tasks: object[], targets: object, retired: object[], recovered?: 'bak', missingVersion?: true}>}
 */
export async function readState(file) {
  let raw
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // 主文件不存在：看看是不是有备份（上一次 rename 之后被删了的情况）
      return (await readBackup(file)) ?? { ...EMPTY_STATE }
    }
    // 主文件存在但解析失败：尝试备份；只有回退也失败才抛主文件错误。
    // 版本判断不改变这条顺序（解析失败的主文件没有可判的版本）。
    const recovered = await readBackup(file)
    if (recovered) return recovered
    // 两个都不可用：把主文件的错误抛出去，它是更有诊断价值的那个
    throw error
  }

  // 主文件解析成功：先判版本，再归一字段。必须在这里、不能挪到回退之后。
  const verdict = assertReadableVersion(raw)
  return withVersionNote(normalize(raw), verdict)
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
