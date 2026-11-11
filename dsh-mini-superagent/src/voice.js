/**
 * 文案层：把「机器写的事实」变成「人读的一句话」。
 *
 * 为什么要有这个文件，而不是继续在 `dispatch.js` 里拼字符串：
 * 报告文本是**主会话唯一的输入**，主会话很难把一段机器日志转述得自然。
 * 所以报告本身得先可读（plans/10 §四）。这些是纯函数——输入是任务与报告条目，
 * 输出是字符串，不碰 ctx、不碰定时器、不写盘。放在独立文件里的直接收益是
 * **可以单测**：文案契约（plans/10 §七.1）能自动检查，而不是靠人读。
 *
 * 三条硬规则（改动前先读）：
 * 1. **任务 id 只能出现在末尾「细节」行**——正文里出现 id，用户就得自己去对账；
 * 2. **不出现 `done` / `failed` / `blocked` 这类内部词**——状态词只走
 *    `STATUS_VOICE` 的中文说法（tests/voice-contract.test.js 会扫）；
 * 3. **失败与阻塞必须带行动指向**（「需要你…」）——只报状态等于没说清楚下一步。
 */
import {
  CANCEL_REASONS, HEADLINE_MAX, LABEL, REPORT_SECTIONS, REPORT_VIEW, STATUS_VOICE,
} from './constants.js'
import { clip, oneLine } from './tasks.js'

/**
 * 标题里要剥掉的东西（plans/10 §三「任务短标签怎么起」第 2 条）。
 *
 * 顺序有意义：
 * 1. markdown 强调符 `**` 先剥——否则后面的正则要为一堆 `**07-P0**` 变体各写一条；
 * 2. 批次前缀 `批次 3：` / `[批次]`——那是调用方的组织方式，不是任务本身；
 * 3. 版本号式编号 `07-P0`、`10-P1`、`P0`、`v1.2`、`#12`、`(3)`——内部编号，
 *    用户认标题不认编号；
 * 4. 括号补充（中英文）——通常是「（不要动 prompt.js）」这类约束，属于简报。
 */
const TITLE_NOISE = [
  /\*\*/g,
  /^\s*批\s*次?\s*[#＃]?\s*\d+\s*[：:·、.\-–—]\s*/,
  /^\s*[\[【(（]\s*批\s*次\s*[\]】)）]\s*[：:]?\s*/,
  /\b[A-Za-z]{0,4}\d{1,3}-P\d{1,2}\b/g,      // 07-P0 / 10-P1 / P10-P0
  /\bP\d{1,2}\b/g,                            // P0 / P1
  /\bv\d{1,3}(?:\.\d{1,3})*\b/gi,             // v1 / v0.8.0
  /[#＃]\d{1,4}\b/g,                          // #12
  /\bNo\.?\s*\d{1,4}\b/gi,                    // No.3
  /[\[【(（][^\[\]【】()（）]{0,30}[\]】)）]/g,  // （补充）/ [备注]
]

/**
 * 标签收尾要剪掉的虚词。
 *
 * 「任务」「这条」「分支」是调用方随手加的后缀；留着会让两个本来不同的标题
 * 在剥掉编号后**看起来一样**（`07-P0 任务` / `10-P0 任务` → 都成 `任务`），
 * 而短标签的全部价值就是区分。
 */
const TRAILING_FILLER = /(?:的|了)?(?:\s*(?:任务|这条|那条|分支|部分|相关|工作))*\s*$/

/** 标签开头要剪掉的连接词（剥完括号常留下「的」「：」）。 */
const LEADING_NOISE = /^[\s的:：·、.\-–—]+/

/** 中文/西文混排时，按「读起来的一个字」计数：CJK 记 1，西文单词记 1。 */
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/
/** 「一个词」的边界：字母数字连续段算一个单位（`webhook` 是 1 个字，不是 7 个）。 */
const WORD = /[A-Za-z0-9]+/

/**
 * 估算标签长度（以「读起来几个字」为单位）。
 *
 * 为什么不用 `String.length`：`CI 缓存迁移` 是 8 个 UTF-16 码元，但人读是 6 个字；
 * 而 `登录超时修复` 是 12 码元、人读也是 6 个字。用码元数会让英文标签被**过度**
 * 截短（`CI cache migration` 25 码元直接砍成半截），用「字」数才对得上直觉。
 *
 * @param {string} text
 * @returns {number}
 */
export function labelLength(text) {
  const value = String(text ?? '')
  if (!value) return 0
  let count = 0
  let index = 0
  while (index < value.length) {
    const ch = value[index]
    if (CJK.test(ch)) { count += 1; index += 1; continue }
    // 西文/数字按「一个词一个字」数，与人的读法一致：`webhook` 是 1 个字。
    if (WORD.test(ch)) {
      count += 1
      index += value.slice(index).match(WORD)?.[0]?.length ?? 1
      continue
    }
    index += 1
  }
  return count
}

/**
 * 按「读起来几个字」截断，且落到自然边界（词与词之间）。
 *
 * 为什么宁可截短也不硬切：硬切会把 `webhook` 切成 `webh`，那比截短更难认。
 * 极短预算（< 4 字）时才退回硬切——那时没有更小的语义单位可用。
 *
 * @param {string} text
 * @param {number} limit 以「字」为单位
 * @returns {string}
 */
export function sliceLabel(text, limit) {
  const value = String(text ?? '').trim()
  const cap = Math.max(1, Math.floor(Number(limit) || 0))
  if (labelLength(value) <= cap) return value
  let out = ''
  let index = 0
  while (index < value.length) {
    const ch = value[index]
    let piece = ch
    if (!CJK.test(ch) && WORD.test(ch)) {
      // 西文词整体作为一个单位：半截的 `webh` 比截短更难认。
      piece = value.slice(index).match(WORD)?.[0] ?? ch
    }
    if (labelLength(out + piece) > cap) break
    out += piece
    index += piece.length
  }
  // 一个词都放不下（预算比单个词还小）：只能硬切。
  return out.trim() || value.slice(0, cap)
}

/**
 * 从任务标题造一个**短标签**（plans/10 §三「任务短标签怎么起」）。
 *
 * 规则：
 * - 剥掉版本号/编号/括号补充/批次前缀，取 6–12 个字；
 * - 剥完太短（< 2 字，通常是标题只有编号）就退回原标题——**绝不退回 id**；
 * - 同比区分交给 `taskLabel()`，那里能看到同名任务。
 *
 * @param {string} title
 * @param {{ max?: number }} [options]
 * @returns {string}
 */
export function shortLabel(title, options = {}) {
  const max = Math.max(LABEL.MIN, Number(options.max) || LABEL.MAX)
  const raw = oneLine(String(title ?? ''), 200)
  if (!raw) return '未命名任务'
  let value = raw
  for (const pattern of TITLE_NOISE) value = value.replace(pattern, ' ')
  value = value.replace(/\s+/g, ' ').trim()
  value = value.replace(LEADING_NOISE, '').replace(TRAILING_FILLER, '').trim()
  value = value.replace(LEADING_NOISE, '').trim()
  // 剥完只剩标点、或短到认不出来：宁可保留原标题，也不要给用户一个「。」。
  if (labelLength(value) < 2) value = raw
  return sliceLabel(value, max)
}

/**
 * 造一条任务的**稳定短标签**，同名时补范围（plans/10 §三第 3 条）。
 *
 * 为什么要 `peers` 而不是只在文本里加前缀：同名任务必须能在**同一次回复里**
 * 被区分开，而回复是主会话按报告文本拼出来的。所以区分必须在报告生成时完成：
 * 同一批次/同一会话里标题重复的，每个都补上工作区（没有工作区就补 id 后 6 位，
 * 那是唯一不可能重复的东西，且它比完整 id 短得多）。
 *
 * 边界：
 * - **只在真的撞名时**才补——所有标签都加后缀，等于把区分成本摊给所有任务；
 * - 补完仍超 `LABEL.LINE_MAX` 时先缩标签本体，后缀优先保住；
 * - 后缀全部相同（同一 workspace 下的同名任务）时，再补 id 尾段。
 *
 * @param {object} task 任务
 * @param {object[]} [peers] 同一范围内可能撞名的其它任务
 * @returns {string}
 */
export function taskLabel(task, peers = []) {
  const base = shortLabel(task?.title)
  const title = task?.title
  const others = (Array.isArray(peers) ? peers : [])
    .filter(item => item && item.id !== task?.id && item.title === title)
  if (!others.length) return base

  // 后缀优先用工作区标题（用户认得目录名），没有工作区才退到 id 尾段。
  // 用「词」为单位截断而不是按码元：`dsh-mini-superagent` 被切成
  // `dsh-mini-sup` 比不补后缀还难认。
  const suffixOf = item => sliceLabel(
    String(item?.workspaceTitle ?? item?.workspace ?? '').trim()
      || (item?.id ? String(item.id).replace(/^t-/, '') : ''),
    LABEL.MAX,
  )
  let suffix = suffixOf(task)
  // 后缀本身也可能撞（同一工作区里的同名任务）：那只能靠 id 尾段兜底。
  if (others.some(item => suffixOf(item) === suffix)) {
    suffix = String(task?.id ?? '').replace(/^t-/, '').slice(-6)
  }
  if (!suffix) return base

  const tail = `·${suffix}`
  const room = LABEL.LINE_MAX - labelLength(tail)
  return `${sliceLabel(base, Math.max(2, room))}${tail}`
}

/**
 * 批次短标签：把成员标题的公共前缀 + 条数说成一句人话（plans/10 §四.3）。
 *
 * 「重构这批 4 条」这种说法来自调用方当时怎么叫它，但我们拿不到调用方的原话，
 * 只能从成员标题里找**最长公共词前缀**。找不到就退回「这批 N 条」——
 * 退回也远比一个 `g-7f21` 有用。
 *
 * @param {string[]} titles 成员标题
 * @returns {string}
 */
export function batchLabel(titles) {
  const labels = (Array.isArray(titles) ? titles : []).map(item => shortLabel(item)).filter(Boolean)
  const total = labels.length
  if (!total) return '这批任务'
  if (total === 1) return `${labels[0]}（单条）`

  // 为什么不是「全体最长公共前缀」：计划书的例子是「重构 auth / 重构 billing /
  // 重构 notify / 补集成测试」→「重构这批 4 条」。全体公共前缀是空串，因为
  // 第四条一眼看不出是同一批。真正的信号是**多数派**，所以先按前两个字分组，
  // 取最大的那组再算组内最长公共前缀。
  const groups = new Map()
  for (const label of labels) {
    const key = [...label].slice(0, 2).join('')
    groups.set(key, [...(groups.get(key) ?? []), label])
  }
  let best = []
  for (const group of groups.values()) if (group.length > best.length) best = group
  // 只有 1 条能归到一组时，「这批」本身没有共同主题，退回条数。
  if (best.length < 2) return `这批 ${total} 条`

  let prefix = best[0]
  for (const label of best.slice(1)) {
    let index = 0
    while (index < prefix.length && index < label.length && prefix[index] === label[index]) index += 1
    prefix = prefix.slice(0, index)
    if (!prefix) break
  }
  prefix = prefix.replace(/[\s:：·、.,\-–—]+$/, '').trim()
  // 公共前缀太短（1 个字）时不算「这批在做什么」，宁可退回条数。
  // 批次 id 在这里**不**参与：`g-t-m0abc-1` 这种内部编号对用户毫无信息量，
  // 计划书 §四.3 明确要求「不要只写 group id」。
  if (labelLength(prefix) < 2) return `这批 ${total} 条`
  return `${prefix}这批 ${total} 条`
}

/**
 * 报告的一句话结论（`headline`）的兜底句（plans/10 §四.1）。
 *
 * 「缺 headline 时用『标题 + 状态』生成兜底句，不能空着」——但规则里同时写着
 * headline **不重复任务名**（任务名由外层「任务」行负责）。两条要求并不冲突：
 * 兜底句只在**没有 headline 时**才拼标题，因为那时没有任何别的「一句话结论」
 * 可用，而空着比重复更糟。有 headline 时标题完全不出现在这里。
 *
 * @param {object} task
 * @param {{ status?: string, summary?: string }} entry
 * @returns {string}
 */
export function fallbackHeadline(task, entry) {
  const status = String(entry?.status ?? '')
  const voice = STATUS_VOICE[status] ?? STATUS_VOICE.unknown
  const label = shortLabel(task?.title)
  // 兜底句 = **标题 + 状态**（plans/10 §四.1 的原话），缺 headline 时不能空着。
  //
  // 为什么不用摘要首句当兜底：那会让【结果】与【说明】两行一模一样
  //（`【结果】压测跑完了，P99 从 480ms 降到 210ms` + `【说明】压测跑完了，…`）。
  // 重复一行不会让人更清楚，只会让人开始跳读。摘要首句留在【说明】里，
  // 【结果】只负责「这是哪条 + 成没成」——分工清楚，两行都不浪费。
  //
  // 「headline 不重复任务名」那条约束针对 worker **自己写**的结论：外层
  // 【任务】行已经说了是哪条，结论里再写一遍就是浪费预算。兜底句没有别的
  // 信息来源，标题是它唯一能说清的「这是哪条 + 成没成」，所以这里必须带。
  return `${label}${voice}`
}

/**
 * 一次报告要**回流给主会话**的那份文本（plans/10 §四.2 的四段式）。
 *
 * ```text
 * 【任务】auth 令牌刷新
 * 【结果】登录超时修好了，补了 3 个回归测试
 * 【说明】替换了 refresh 调用点 6 处；新增 3 条用例；测试全绿。
 * 【需要你】无
 * 【细节】dispatch_inspect t-1a9f-1
 * ```
 *
 * 规则与理由：
 * - **第一行必须是任务短标签**：主会话要能一眼认领「这是哪条」，而 id 帮不上；
 * - `【需要你】` 只在 blocked / 失败 / 中断 / 有决策时出现——成功的任务天天喊
 *   「需要你」会让这四个字贬值，真需要人时反而被略过；
 * - 任务 id **只**出现在末尾「细节」行；
 * - 摘要作为**投影**压缩（`REPORT_VIEW.SUMMARY`），账本里仍是全文：
 *   压缩只作用于「给模型看的那份」，`dispatch_inspect` 读到的不受影响。
 *
 * @param {object} task
 * @param {{status?: string, headline?: string, summary?: string, detail?: string}} entry
 * @param {{ peers?: object[] }} [options]
 * @returns {string}
 */
export function reportText(task, entry, options = {}) {
  const label = taskLabel(task, options.peers ?? [])
  // 有 worker 写的 headline 就用它，没有才走「标题 + 状态」兜底（不能空着）。
  const headline = String(entry?.headline ?? '').trim() || fallbackHeadline(task, entry)
  const result = sliceLabel(headline, HEADLINE_MAX)
  const summary = clip(String(entry?.summary ?? '').trim(), REPORT_VIEW.SUMMARY)
  const lines = [
    `${REPORT_SECTIONS.TASK}${sliceLabel(label, LABEL.LINE_MAX)}`,
    `${REPORT_SECTIONS.RESULT}${result}`,
  ]
  // 摘要里的换行压成空格：四段式是「一段一行」，多行摘要会把四段撑成十几段。
  if (summary) lines.push(`${REPORT_SECTIONS.NOTE}${summary.replace(/\s*\n+\s*/g, ' ')}`)
  const need = needText(task, entry)
  if (need) lines.push(`${REPORT_SECTIONS.NEED}${need}`)
  lines.push(`${REPORT_SECTIONS.DETAIL}dispatch_inspect ${task?.id ?? ''}`)
  return lines.join('\n')
}

/**
 * 「需要你」那一段的内容；不需要时返回空串。
 *
 * 判据只看两件事：状态是否「没成」，以及有没有人明确要求行动。**不**根据
 * 摘要里出没出现「需要」两个字猜——那是关键词启发式，猜错时会在成功报告上
 * 喊「需要你」，比不喊更糟。
 *
 * @param {object} task
 * @param {{status?: string, summary?: string, need?: string}} entry
 * @returns {string}
 */
export function needText(task, entry) {
  const explicit = String(entry?.need ?? '').trim()
  if (explicit) return oneLine(explicit, 200)
  const status = String(entry?.status ?? '')
  // 这三句刻意**不复述原因**：原因已经在【说明】里，重复一遍只会稀释「要你做什么」。
  // 计划书 §四.3 的例子也是这个分工——原因在分组行，行动在【需要你】行。
  if (status === 'blocked') return '定个方向：是补上缺的东西继续，还是换做法？'
  if (status === 'failed') return '定一下：重试、换做法，还是先放着？'
  if (status === 'interrupted') return '要不要重试？'
  return ''
}

/**
 * 启动失败 / 续跑失败时的一句话（plans/10 §四.4）。
 *
 * 形状固定为 `<任务短标签>：没能开始——<原因>`：先说哪条，再说卡在哪。
 * 旧文案是 `[dispatch] 任务 <id> · <标题> 启动失败：<error>`，三样东西都在，
 * 但用户要先跳过 id、再把「启动失败」翻译成「它没开始」。
 *
 * @param {object} task
 * @param {{ peers?: object[] }} [options]
 * @returns {string}
 */
export function failureText(task, options = {}) {
  const label = taskLabel(task, options.peers ?? [])
  const reason = oneLine(String(task?.error ?? '').trim(), REPORT_VIEW.REASON) || '原因不明'
  return `${label}：没能开始——${reason}。要我重试吗？`
}

/**
 * 回合结束但 worker 没给结论时的那句话（plans/10 §四.4）。
 *
 * 「跑完无输出」必须说成「它跑完了，但没给结论」，**不要**写「本轮没有输出」
 * 这种机器句：前者告诉用户「可以去问，它手里有东西」，后者只说明程序跑完了。
 *
 * @param {object} task
 * @param {{ peers?: object[], body?: string, note?: string }} [options]
 * @returns {string}
 */
export function idleText(task, options = {}) {
  const label = taskLabel(task, options.peers ?? [])
  const body = clip(oneLine(String(options.body ?? '').trim(), 400), REPORT_VIEW.REASON)
  const lines = [`${label}：它跑完了，但没给结论——要我追问一句吗？`]
  if (body && body !== '（worker 本轮没有输出文本）') lines.push(`${REPORT_SECTIONS.NOTE}${body}`)
  if (options.note) lines.push(`${REPORT_SECTIONS.NOTE}${oneLine(options.note, 200)}`)
  lines.push(`${REPORT_SECTIONS.DETAIL}dispatch_inspect ${task?.id ?? ''}`)
  return lines.join('\n')
}

/**
 * 一批任务全部结束时的汇总（plans/10 §四.3）。
 *
 * ```text
 * 【批次】重构这批 4 条
 * 4 条成了 3 条，1 条卡住。
 * · 成了：登录超时、接口重试、日志清理
 * · 卡住：补集成测试（连不上压测环境）
 * 【需要你】把测试改成打本地 mock，还是你去开一下环境？
 * ```
 *
 * 规则：
 * - 先给比例，再给分组，不逐条复述成功项；
 * - **没成的必须逐条点名到具体任务**（带短标签），不能只写「1 条失败」；
 * - 失败必须带原因与「需要你做什么」；
 * - **「未执行」与「没成」分开**（PRD-02 §8）：前置失败导致的后继取消不是它
 *   自己失败，混进「没成」会让用户去查一个根本没错的任务；这类只写「未执行」
 *   并说明「等前置结算后再派一次」；
 * - 超过 5 条时只列「成了几条 / 没成的哪条」，成功项不再逐个列。
 *
 * @param {object[]} members 这一批的成员任务
 * @param {{ group?: string, limit?: number }} [options]
 * @returns {string}
 */
export function batchText(members, options = {}) {
  const list = (Array.isArray(members) ? members : []).filter(Boolean)
  const total = list.length
  const titles = list.map(item => item.title)
  const label = batchLabel(titles)
  const okStatuses = new Set(['done'])
  const ok = list.filter(item => okStatuses.has(item.status))
  const bad = list.filter(item => !okStatuses.has(item.status))
  /**
   * 「未执行」= 被依赖连带取消（`cancelReason` 是 PRD-02 的两个稳定机器值）。
   *
   * 必须与「人取消」分开：前者是**前置的错**，它自己的活根本没开始；后者是用户
   * 收回。把两者混成一个「已取消」会让用户少一次「B 为什么没跑」的解释，
   * 而这正是 PRD-02 §8 要求同步改文案的原因。
   */
  const dependencyCancelled = item => item.status === 'cancelled'
    && (item.cancelReason === CANCEL_REASONS.DEPENDENCY_FAILED
      || item.cancelReason === CANCEL_REASONS.DEPENDENCY_MISSING)
  const notRun = bad.filter(dependencyCancelled)
  // 取消是用户自己收回的，不算「没成」——把它混进去会让汇总读起来像失败。
  const cancelled = bad.filter(item => item.status === 'cancelled' && !dependencyCancelled(item))
  const failed = bad.filter(item => item.status !== 'cancelled')

  const lines = [`${REPORT_SECTIONS.BATCH}${label}`]
  const parts = [`${total} 条成了 ${ok.length} 条`]
  if (failed.length) parts.push(`${failed.length} 条没成`)
  if (notRun.length) parts.push(`${notRun.length} 条未执行`)
  if (cancelled.length) parts.push(`${cancelled.length} 条已取消`)
  lines.push(`${parts.join('，')}。`)

  const limit = Math.max(1, Number(options.limit) || 5)
  // 短标签要按批内同名来区分：同名任务在这一屏里最容易认错。
  const labelOf = item => taskLabel(item, list)
  if (ok.length) {
    const shown = limit >= 5 || ok.length <= limit ? ok : ok.slice(0, limit)
    const names = shown.map(labelOf).filter(Boolean).join('、')
    const more = ok.length > shown.length ? ` 等 ${ok.length} 条` : ''
    lines.push(`· 成了：${names}${more}`)
  }
  if (failed.length) {
    const names = failed.map(item => {
      const reason = oneLine(String(item.error ?? item.reports?.at(-1)?.summary ?? item.lastText ?? '').trim(), 100)
      return reason ? `${labelOf(item)}（${reason}）` : labelOf(item)
    })
    lines.push(`· 没成：${names.join('、')}`)
  }
  if (notRun.length) {
    // 「未执行」逐条点名并带**前置**的原因：用户要能直接去处理前置，而不是猜
    // 「这条为什么没跑」。两种原因分开说——「前置没成」和「前置已不在账本」需要
    // 完全不同的处置（前者等它结算/修好，后者得重新派前置）。
    const names = notRun.map(item => {
      const why = item.cancelReason === CANCEL_REASONS.DEPENDENCY_MISSING ? '前置已不在' : '前置没成'
      return `${labelOf(item)}（${why}）`
    })
    lines.push(`· 未执行：${names.join('、')}`)
  }
  if (cancelled.length) lines.push(`· 已取消：${cancelled.map(labelOf).join('、')}`)

  // 「需要你」只在有没成 / 未执行的任务时出现：批次全绿时喊一句「无」纯属噪音。
  if (failed.length) {
    lines.push(`${REPORT_SECTIONS.NEED}${failed.length} 条没成，看看要重试、换做法，还是先放着？`)
  } else if (notRun.length) {
    lines.push(`${REPORT_SECTIONS.NEED}${notRun.length} 条因前置没成没有执行：把前置处理掉后重新派发它们即可。`)
  }
  if (options.group) lines.push(`${REPORT_SECTIONS.DETAIL}dispatch_inspect 按任务查（批次 ${options.group}）`)
  return lines.join('\n')
}

/**
 * 一条报告在**账本里**的条目里，给人看的结论字段。
 *
 * 兜底逻辑放在这里而不是放在 `report()` 里，是为了让「入库」与「投影」各自
 * 只做一件事：入库永久保留调用方给的 `headline`（有就存，没有就是没有），
 * 投影时再补兜底句。这样 `dispatch_inspect` 能区分「worker 没写结论」与
 * 「系统替他编了一句」——后者不该被误认为是 worker 的原话。
 *
 * @param {object} task
 * @param {{status?: string, headline?: string, summary?: string}} entry
 * @returns {string}
 */
export function headlineOf(task, entry) {
  const explicit = oneLine(String(entry?.headline ?? '').trim(), HEADLINE_MAX)
  return explicit || fallbackHeadline(task, entry)
}

/**
 * 文案契约的自检：给出一份「这一行有没有违反风格规则」的判定。
 *
 * 供测试与 `selfCheck()` 复用——两处各写一份判据，就会出现「自检说没问题、
 * 测试说有问题」的分裂，而那正是文案契约最想避免的事。
 *
 * @param {string} text 已经生成好的报告文本
 * @returns {string[]} 违规项（空数组 = 通过）
 */
export function voiceViolations(text) {
  const value = String(text ?? '')
  const problems = []
  if (!value.startsWith(REPORT_SECTIONS.TASK) && !value.startsWith(REPORT_SECTIONS.BATCH)) {
    problems.push(`首行必须以「${REPORT_SECTIONS.TASK}」或「${REPORT_SECTIONS.BATCH}」开头`)
  }
  const firstLine = value.split('\n')[0] ?? ''
  if (/\bt-[a-z0-9]{2,}-/.test(firstLine)) problems.push('首行出现了任务 id')
  if (/\b(?:done|failed|blocked|ended|interrupted|cancelled)\b/.test(firstLine)) {
    problems.push('首行出现了英文状态词')
  }
  if (labelLength(firstLine) > LABEL.LINE_MAX) {
    problems.push(`首行超过 ${LABEL.LINE_MAX} 字（实际 ${labelLength(firstLine)}）`)
  }
  const need = value.split('\n').find(line => line.startsWith(REPORT_SECTIONS.NEED))
  const hasNeed = !!need && need.slice(REPORT_SECTIONS.NEED.length).trim() !== ''
  // 「有行动指向」的判据：出现「需要/要你/要不要/重试/定个」这类指向动作的词。
  if (hasNeed && !/需要|要你|要不要|重试|定个|选一个/.test(need)) {
    problems.push('「需要你」行没有行动指向')
  }
  return problems
}
