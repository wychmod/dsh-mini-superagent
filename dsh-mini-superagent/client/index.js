/**
 * dsh-mini-superagent — Client 半边：常驻侧边栏图标 + 主面板「派发工作台」
 *
 * 形态：plain ModuleLoader 包，无构建、无编译、无 CDN；React 从 require('react') 拿。
 * 只做两件事：向 sidebar.panellist 注册一个图标，向 main 注册一个面板。
 * 面板的数据全部来自 Host 的同源 HTTP 路由 /dsh-mini-superagent/board，
 * 不走 Remote/RPC —— 一个只读看板不值得定义跨进程契约。
 *
 * 文案：当前为内置 zh（见下方 TEXT 对象），同时预留了 Client locale 接入：
 * 若运行时的 locale 服务可用，就注册词典并改用绑定后的 t()；不可用时静默退回内置中文，
 * 不会因为缺少 locale 而白屏或抛错。
 *
 * 约定：本文件不写全局样式表、不碰别家 DOM、不追加应用根节点；所有 CSS 都挂在
 * .dsh-sa 前缀下，随面板 <style> 元素一起卸载。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mini-superagent',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /**
     * 弹层要挂到 document.body（输入框在层叠上下文里，内联绝对定位会被裁）。
     * react-dom 是应用自带的同一份实例（已装插件如 dsh-free-search / better-sidebar 都这么用）；
     * 万一取不到，下拉退化为不可用，控件本身仍然渲染。
     */
    let createPortal = null
    try {
      const ReactDOM = require('react-dom')
      if (ReactDOM && typeof ReactDOM.createPortal === 'function') createPortal = ReactDOM.createPortal
    } catch (error) {
      createPortal = null
    }

    /* ───────────────────────── 常量 ───────────────────────── */

    /** 侧边栏图标 id，同时是主面板的 key —— 两者必须完全一致，点图标才会切到这个面板。 */
    const BOARD_ID = 'dsh-mini-superagent.board'
    /** Host 路由（src/board.js 里的 BASE，改一处要改两处）。 */
    const API = '/dsh-mini-superagent/board'
    /**
     * 准入头。Host 端要求写操作必须带它（见 src/constants.js 的 BOARD_HEADER），
     * 用来挡掉同源页面之外的脚本与简单 CSRF。读操作在回环 Host 下不需要，
     * 但统一带上没有副作用。
     */
    const BOARD_HEADER = 'x-dsh-mini-superagent'
    const AUTH_HEADERS = { [BOARD_HEADER]: '1' }
    /** 面板可见时的轮询间隔。 */
    const POLL_MS = 2000
    /** 「耗时」走表的间隔。 */
    const TICK_MS = 1000
    /**
     * 「计划已更新」徽标的展示窗口（PRD §11.3 建议 6 秒 = 3 个轮询周期；评审 Q7 拍板 6 秒）。
     *
     * 写成 `POLL_MS * 3` 而不是 `6000`：这个窗口的语义是「让用户看到 3 次轮询」，
     * 不是「刚好 6 秒」。将来把 `POLL_MS` 调快或调慢时，窗口必须跟着变——写成魔法
     * 数字的话，`POLL_MS` 一改，徽标就会变成「一闪而过」或「赖着不走」（PRD §11.8）。
     */
    const PLAN_NOTICE_MS = POLL_MS * 3
    /** Client locale 命名空间。 */
    const LOCALE_NS = 'dsh-mini-superagent.board'
    /**
     * 插件投递消息时写进 `source.kind` 的值（= 包名，见 `src/sessions.js` 的 `userMessage()`）。
     * 客户端只用它区分「这条用户行是派发报告还是人打的字」，不解释 source 的其它字段。
     */
    const RELAY_SOURCE_KIND = 'dsh-mini-superagent'

    /* ───────────────────────── 文案 ───────────────────────── */

    /** 内置中文文案（locale 不可用时的兜底，也是默认界面语言）。 */
    const TEXT = {
      title: '派发工作台',
      concurrency: '并发',
      queuedOne: '排队',
      total: '总计',
      failed: '失败',
      'filter.all': '全部',
      'filter.active': '进行中',
      'filter.attention': '需要处理',
      'status.queued': '排队中',
      'status.running': '运行中',
      'status.done': '已完成',
      'status.blocked': '已阻塞',
      'status.failed': '失败',
      'status.cancelled': '已取消',
      'status.ended': '已结束',
      'status.interrupted': '已中断',
      attemptPrefix: '第',
      attemptSuffix: '次',
      /*
       * 重试健康度（A6 / PRD §10.3）：`retry_health.attempts` 是「因瞬时故障续跑了几次」。
       *
       * 为什么不复用 `attemptPrefix/Suffix`：那个标签显示的是 `attempt`——**换过几次
       * worker 会话**（会话没了才 +1）。两个数字相等是巧合，不相等是常态；把
       * 「重试 2 次」写进 attempt 标签，等于让用户以为换过两次会话。
       * 同理也不与投递重试（报告没送到）共用文案。
       */
      retryTag: '重试 {n} 次',
      retrySinceHint: '自 {time} 起',
      reports: '报告',
      /*
       * 任务级计划（PRD-01 §4.3）。看板只显示「做了几步 / 共几步」与当前步骤一句，
       * 不搬完整步骤数组（那是 2 秒轮询的快照）；要看全部用 dispatch_inspect。
       * 三个键都要有 zh/en 两份，缺英文的会在英文界面下静默退回中文。
       */
      'plan.label': '计划',
      'plan.ratio': '计划 {done}/{total}',
      'plan.currentLabel': '当前步骤',
      'plan.tagHint': '计划 {done}/{total}',
      /*
       * 「计划已更新」（PRD-01 §6）：worker 第二次带**不同的**计划时亮一次短标记。
       *
       * 为什么只在行内亮、不进账本：这是给盯着看板的人一次「它改主意了」的提示，
       * 不是任务事实。写进账本会让每次 plan 变更多一条持久记录（还要落盘、还要
       * 在抽屉里占位），而重开页面时旧指纹会把它再放一遍——那是在重放历史。
       * 提示里点明「计划标签是当前快照」，因为标记消失后 2/5 仍然在那里，别让人以为丢了。
       */
      'plan.updatedTag': '计划已更新',
      'plan.updatedHint': '子会话刚提交了一份不同的计划（{done}/{total}）；这里显示的是当前快照，旧的计划不会留在看板上',
      /*
       * 批次依赖（PRD-02 §4.5）：任务行标签 / 抽屉 / 批次头三处共用这一组文案。
       *
       * - `dep.tag` = 「依赖 2」，`dep.waiting` = 「等 A」，`dep.failedTag` = 「前置失败」；
       * - 抽屉三条：`dep.tagHint` 的「前置：A、B」、`dep.waitingOn` 的「当前等待：
       *   A（运行中）」、`dep.notRun` 的「未执行原因：前置 A 失败」；
       * - `dep.batchHead` = 「3 个成员 · 1 个等待前置 · 1 个未执行」。
       *
       * 标题由客户端从同一份快照里按 id 查（`depTitles`），所以这里只需要占位符，
       * 不要把前置标题拼进看板 payload。英文必须与中文逐键成对（client-smoke 会数）。
       */
      'dep.tag': '依赖 {n}',
      'dep.waiting': '等 {title}',
      'dep.failedTag': '前置失败',
      'dep.tagHint': '前置：{list}',
      'dep.block': '前置与等待',
      'dep.label': '前置',
      'dep.join': '、',
      'dep.waitingLabel': '当前等待',
      'dep.waitingOn': '{title}（{reason}）',
      'dep.notRunLabel': '未执行原因',
      'dep.notRun': '前置 {title} 失败',
      'dep.notRunMissing': '前置 {title} 已不在账本',
      'dep.reason.running': '运行中',
      'dep.reason.failed': '失败',
      'dep.reason.missing': '缺失',
      'dep.none': '没有前置任务',
      'dep.batchHead': '{total} 个成员 · {waiting} 个等待前置 · {skipped} 个未执行',
      noReport: '尚无报告',
      waiting: '等待中',
      updatedAt: '更新于',
      empty: '还没有任务。让主会话用 dispatch_launch 派发一个。',
      emptyFiltered: '这个筛选下没有任务。',
      emptyArchivedHint: '还有 {n} 条历史已归档，可在「已归档」查看。',
      loading: '正在读取看板…',
      unreachable: '看板数据暂时取不到',
      stale: '展示的是上一次成功取到的数据',
      retry: '重试',
      cancel: '取消',
      cancelling: '取消中…',
      retryTask: '重试',
      retrying: '重试中…',
      actionFailed: '操作没有成功',
      badResponse: '看板响应格式不对',
      httpError: '请求失败',
      unknownError: '未知错误',
      noTitle: '（无标题）',
      dismiss: '关闭提示',
      'filter.archived': '已归档',
      archivedTag: '已归档',
      archivedHint: '该子会话已归档，不可直接打开；请在会话列表里取消归档后再查看',
      archiveErrorPrefix: '归档失败：',
      /*
       * 工具栏那颗按钮：文案要说清「归档的是**超时**的那些会话」，否则
       * 「立即归档」看起来像「把我现在看到的东西都归档掉」。
       * 悬浮提示里的时长来自快照的 `archive_after_hours`（真实配置），拿不到就用
       * 不带数字的 `archiveNowHintUnknown`——不许拼出「undefined 小时」。
       */
      archiveNow: '立即归档超时会话',
      archiveNowHint: '归档「已结算且超过 {hours} 小时（{days} 天）没有更新」的任务；归档后从「全部」移到「已归档」',
      archiveNowHintHours: '归档「已结算且超过 {hours} 小时没有更新」的任务；归档后从「全部」移到「已归档」',
      archiveNowHintUnknown: '归档长期未更新的已结算任务；归档后从「全部」移到「已归档」',
      archiveConfirm: '再次点击确认归档超时会话',
      archiveRunning: '归档中…',
      archiveDone: '归档巡检：扫描 {scanned}，归档 {archived}，失败 {failed}',
      archiveTask: '归档',
      archiving: '归档中…',
      archiveTaskConfirm: '再点一次确认归档',
      archiveTaskDone: '已归档（历史里仍可查到）',
      archiveTaskKept: '已归档，但子会话没归档成功：{reason}',
      /*
       * 续派（plans/08 阶段 1 · 模型 A）。四个键都要有：按钮、输入框占位、提交、
       * 以及一句必须写出来的**代价提示**——看板上「续派」不会产生新的一行，
       * 用户点完只看到原任务又变回运行中，如果没有这句话，会以为按钮坏了。
       */
      continueTask: '续派',
      continuePlaceholder: '补一句要求（不新建任务，追加给同一条子会话）',
      continueSubmit: '发过去',
      continueCancel: '算了',
      continueSending: '发送中…',
      continueHint: '续派不新建任务：要求追加给这条任务的子会话，列表里仍然只有这一行',
      workspaceAll: '全部工作区',
      workspaceFilter: '按工作区筛选',
      workspaceFallback: '跟随会话目录',
      groupTag: '批次',
      openFailed: '打不开子会话 {id}：{reason}',
      noWorkerSession: '这个任务没有可打开的子会话',
      noUiWorkspace: '会话导航服务不可用',
      clickHint: '点击打开子会话',
      backgroundTag: '后台收尾',
      backgroundHint: '回合已结束，但 shell job / subagent 还在跑；任务仍占着并发位，到上限会被终止',
      unreadTag: '待读',
      unreadHint: '追问已投递，但 worker 还没把它读进上下文',
      /*
       * 「待读」超时后宿主会把它降级成 `input_unknown_at`（见 src/board.js 的
       * `boardTask()`），界面上必须**换一个词**：继续写「待读」等于断言
       * 「它马上会读」，而那个状态永远不会结束，比不显示更误导人。
       */
      unknownReadTag: '未读未知',
      unknownReadHint: '追问投递后一直没被确认读到；现在不知道 worker 读没读它',
      /*
       * 归档 = 只读冻结。冻结与归档在今天的宿主里总是一起写（archiveStale()），
       * 归档行已经带「已归档」徽标，所以这个徽标只在「冻结但没归档」的行出现。
       */
      frozenTag: '已冻结',
      frozenHint: '只读冻结：这条不会再更新，续跑会失败',
      'sec.attention': '需要你处理',
      'sec.attentionEmpty': '没有需要你处理的任务',
      'sec.active': '在跑与排队',
      'sec.activeEmpty': '现在没有在跑或排队的任务',
      'sec.done': '最近完成',
      'sec.archived': '已归档',
      'sec.batch': '批次',
      'sec.single': '独立任务',
      'stat.done': '完成',
      'stat.doneHint': '已结算任务里 status=done 的数量',
      'stat.rate': '成功率',
      'stat.rateHint': '完成 ÷ 已结算；取消与中断也算进分母',
      'stat.average': '平均耗时',
      'stat.averageHint': '已结算任务耗时的中位数，用来判断「这一条算不算慢」',
      'stat.saved': '并行节省',
      'stat.savedHint': '粗算：各任务耗时之和 − 实际占用的墙钟时间（快照只含最近 200 条）',
      'stat.none': '—',
      /*
       * 窗口口径（plans/07 P0-1）。指标只统计窗口内的任务，但「口径」必须写在界面上：
       * 一个不说自己统计范围的百分比，会被当成「全部历史」读，而这正是 0.8.x 的缺陷。
       */
      'stat.windowLabel': '口径',
      'stat.windowDays': '最近 {days} 天',
      'stat.windowCount': '最近 {n} 条',
      'stat.windowUnknown': '窗口未知',
      'stat.windowAll': '全部已结算',
      'stat.windowHint': '指标只统计窗口内的已完成任务；归档与退休的任务不参与。窗口由宿主下发，取不到时退回全部已结算。',
      'filter.retired': '已退休',
      'sec.retired': '已退休',
      'retired.empty': '没有被退休的任务',
      'retired.unavailable': '宿主未提供退休记录',
      'retired.unavailableHint': '快照里没有 memory 块（宿主版本较旧或未启用记忆治理）；其余视图不受影响',
      'retired.ago': '退休于 {when}',
      'retired.reason': '原因',
      'retired.reason.cap-count': '条数上限',
      'retired.reason.cap-days': '超过保留期',
      'retired.reason.none': '未记录原因',
      'retired.dropped': '另有 {n} 条退休记录超出展示上限，未在此列出',
      'retired.copyHint': '复制这条任务的 task_id',
      'retired.action': '复制 id',
      'retired.copied': '已复制 {id}',
      'retired.copyFailed': '复制失败：{reason}（可手抄 {id}）',
      'retired.loadFailed': '退休记录暂时取不到：{reason}',
      'retired.notClickable': '退休记录不挂子会话，只能复制 id',
      reason: '原因',
      noReason: '没有给出原因，可以打开子会话看它停在哪',
      showAll: '显示全部',
      showLess: '收起',
      reportAgo: '报告',
      batchOf: '批次',
      justNow: '刚刚',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      daysAgo: '{n} 天前',
      targetPrefix: '派发',
      targetFollow: '跟随会话',
      targetMenuFollow: '跟随会话目录',
      targetLabel: '派发目标工作区',
      targetUnavailable: '看板服务不可用',
      targetLoading: '读取中…',
      targetMenuRefresh: '刷新列表',
      targetMenuEmpty: '没有可用的工作区',
      targetSetFailed: '设置派发目标失败：{reason}',
      targetPortalUnavailable: '弹层不可用',
      targetSection: '工作区',
      targetAuto: '自动选择',
      targetNone: '不派发',
      targetNoneHint: '本会话自己跑，不派发',
      targetForcedHint: '已开启必派发：除纯问答外，任务都派下去',
      targetFollowHint: '用这个会话自己的工作目录',
      targetAutoHint: '按关键词自动匹配一个工作区',
      targetAutoHit: '自动：{title}',
      targetAutoMiss: '自动：没有匹配的工作区',

      /* 轮次分隔线（conversation.chat.user.before）：只有插件回流的报告带这一枚标签。 */
      'divider.relay': '派发报告',

      /*
       * ── plans/09 P1：总览 / 效果 / 拆解 三个视图 ──
       *
       * 这里的每一条都必须在下面的 TEXT_EN 里有对应项：本文件的文案是 zh/en
       * **成对硬编码**的（没有构建期抽取），只写中文的那一条在英文界面下会静默
       * 退回中文。scripts/client-smoke.mjs 里有一条「每个新键出现两次」的断言在守这件事。
       */
      'view.tabs': '看板视图',
      'view.overview': '总览',
      'view.effect': '效果',
      'view.breakdown': '拆解',
      'view.switchHint': '总览回答「现在要我做什么」；效果回答「这段时间干得怎么样」；拆解回答「问题集中在哪个工作区、批次、主会话」',
      'win.label': '窗口',
      'win.24h': '24h',
      'win.days': '{days} 天',
      'win.all': '全部',
      'win.scopeNote24h': '只统计最近 24 小时的事实（在跑与排队的任务不受窗口影响，仍会显示）',
      'win.scopeNoteDays': '只统计最近 {days} 天的事实（在跑与排队的任务不受窗口影响，仍会显示）',
      'win.scopeNoteAll': '统计全部历史事实，不再限制时间窗',
      'win.fromMemory': '默认窗口沿用宿主下发的 memory.window，不是前端另设的默认值',
      'scope.title': '样本口径',
      'scope.entry': '样本口径 {window} · 查看效果',
      'scope.entryHint': '窗口只约束统计，不隐藏当前工作；点开进入「效果」视图',
      'scope.tail': '窗口内结算 n={settled} · 有效耗时 n={valid} · 排除归档 {archived} · 退休 {retired} · 时间未知 {missing}',
      'scope.lowBadge': '样本少',
      'scope.lowHint': '样本 n < 5：数值照常显示，但不能当成结论读',
      'scope.timeBasis': '时间基准：{basis}',
      'scope.basis.settledAt': '结算时刻 settledAt',
      'scope.basis.updatedAt-fallback': '最后更新（旧数据回退）',
      'scope.basis.mixed': '两种基准混用',
      'scope.basis.missing': '时间未知',
      'scope.basisHint': 'settledAt 只在任务进入终态时写一次；旧数据没有它才回退 updatedAt，而后者会被报告、追问、归档刷新——所以回退必须标出来',
      'scope.fallbackFrom': '窗口参数 {value} 无效，已退回宿主默认',
      'scope.truncated': '账本已到上限，结果可能低估',
      'scope.truncatedHint': '活表已达 ledgerMaxTasks、退休留痕有丢弃、或有跨度被夹紧；这个窗口的统计只能当下界读',
      'scope.source': '读了 {n} 条账本记录（含退休留痕，不受 200 条快照上限影响）',
      'scope.sourceHint': 'sourceTasks = 活表任务 + 退休留痕：它证明这些数字来自完整账本，而不是每 2 秒轮询的那份 200 条快照',
      'eff.result': '结果',
      'eff.speed': '速度',
      'eff.stable': '稳定',
      'eff.trend': '趋势',
      'eff.parallel': '并行',
      'eff.done': '完成量',
      'eff.doneHint': '窗口内 status=done 的已结算任务数，按结算时刻归属到窗口',
      'eff.rate': '完成率',
      'eff.rateHint': 'done ÷ (done + ended + failed + blocked + interrupted)；取消不进分母（取消率单列），免得用户主动收回拉低成功率',
      'eff.first': '一次完成率',
      'eff.firstHint': 'attempt=1 且 done ÷ attempt=1 的已结算任务；同样排除取消，衡量「不返工就做完」的比例',
      'eff.rework': '返工率',
      'eff.reworkHint': 'attempt>1 的任务 ÷ 窗口内派发的任务；按任务计数，不把每次 attempt 当成新任务重复计',
      'eff.throughput': '吞吐',
      'eff.throughputHint': 'done ÷ 窗口自然日数；不用「有任务的天数」做分母，避免低活跃期数字虚高',
      'eff.saved': '并行节省',
      'eff.savedHint': 'Σ占用时长 − 墙钟跨度，是粗算，不是工时结算',
      'eff.estimate': '估算',
      'eff.stableHint': '失败 / 阻塞 / 中断三项分开，不用「失败」一个词覆盖；分母是已结算（含取消）',
      'eff.cancelHint': '取消是用户主动收回：它不该进完成率分母，但必须单列，否则「完成数为啥少了」永远解释不清',
      'eff.perDay': '{value} / 天',
      'card.settled': '已结算 n={n}',
      'card.sample': 'n={n}',
      'card.denom': '÷ n={n}',
      'card.p50': 'P50',
      'card.p90': 'P90',
      'speed.queue': '队列等待',
      'speed.queueHint': 'startedAt − createdAt；没启动过的排队任务不进分布（当前排队另看总览）',
      'speed.occupied': '占用时长',
      'speed.occupiedHint': 'settledAt − startedAt，包含后台收尾；它不是「纯模型执行时长」',
      'speed.endToEnd': '端到端',
      'speed.endToEndHint': 'settledAt − createdAt，约等于队列等待 + 占用时长',
      'st.recovery': '重试后恢复',
      'st.recoveryHint': 'attempt>1 且 done ÷ attempt>1 的已结算任务；账本没有尝试历史，这是当前能给的近似值',
      'trend.day': '日期',
      'trend.created': '新派',
      'trend.done': '完成',
      'trend.problems': '失败·阻塞·中断',
      'trend.median': '耗时中位数',
      'trend.saved': '并行节省',
      'trend.chart': '图表',
      'trend.table': '表格',
      'trend.modeLabel': '趋势呈现方式',
      'trend.chartHint': '条形只是辅助：每个数值都以文字写在同一行，颜色之外还有文字',
      'trend.empty': '窗口内还没有按天可统计的事实',
      'trend.none': '无记录',
      'trend.noneHint': '这个日期在窗口内，但账本里没有任何事实；不要把它当成 0 读',
      'trend.detail': '当天明细：新派 {created} · 完成 {done} · 失败/阻塞/中断 {problems} · 耗时中位数 {median} · 并行节省 {saved}',
      'trend.onlyFacts': '只列窗口内真实有事实的日期；补齐的日期显示「无记录」，不当成 0',
      'par.occupied': '占用总和',
      'par.occupiedHint': 'Σ(settledAt − startedAt)，只含时间完整的已结算任务',
      'par.wall': '墙钟跨度',
      'par.wallHint': 'max(settledAt) − min(startedAt)；单条任务时它等于该任务的占用时长',
      'par.factor': '并行倍数',
      'par.factorHint': '占用总和 ÷ 墙钟跨度；跨度为 0 时显示 —（单条任务没有倍数可说）',
      'par.sample': '样本 n={n}',
      'par.reasons': '更粗的原因：{list}',
      'par.reason.sample-low': '样本少',
      'par.reason.updatedAt-fallback': '部分时间回退到 updatedAt',
      'par.reason.durations-clamped': '有时长被夹紧',
      'par.reason.ledger-truncated': '账本已到上限',
      'par.reason.missing-times': '有任务缺时间',
      'br.workspaces': '工作区',
      'br.batches': '批次',
      'br.sessions': '主会话',
      'br.distribution': '状态与退休原因',
      'br.dimTarget': '派发目标',
      'br.dimHost': '实际归属',
      'br.dimNote': '口径：{label}（{field}）',
      'br.dimTargetHint': '派发目标 workspace_id：用户把任务派向哪里；总览筛选沿用这个口径',
      'br.dimHostHint': '实际归属 host_workspace_id：子会话实际挂在哪个工作区，没指定目标时它就是当天的派发工作区',
      'br.col.name': '工作区',
      'br.col.batch': '批次',
      'br.col.session': '主会话',
      'br.col.running': '在跑',
      'br.col.queued': '排队',
      'br.col.done': '完成',
      'br.col.rate': '完成率',
      'br.col.median': 'P50 占用',
      'br.col.failed': '失败',
      'br.col.blocked': '阻塞',
      'br.col.saved': '并行节省',
      'br.col.last': '最后活动',
      'br.col.progress': '进度',
      'br.col.pending': '待处理',
      'br.col.wall': '批次墙钟',
      'br.col.dispatched': '派发',
      'br.col.failedCount': '失败数',
      'br.pendingHint': '待处理 = 失败 + 阻塞 + 中断，与总览「需要你处理」同一口径',
      'br.wallHint': '批次墙钟 = max(updatedAt) − min(createdAt)；成员全部结算后它停止增长',
      'br.lastHint': '取成员里最晚的活动时刻（结算 / 更新 / 创建）；账本没有批次级报告时刻',
      'br.rowHint': '点这一行把「{name}」设为过滤条件并回到总览',
      'br.empty': '这个窗口里还没有可拆解的数据',
      'br.emptyHint': '窗口内没有结算或当前任务；放宽窗口，或者先派发一个任务',
      'br.statusTitle': '状态分布',
      'br.statusHint': '横向条形；点一行把该状态设为过滤条件并回到总览',
      'br.retiredTitle': '退休原因分布',
      'br.retiredHint': '直接使用稳定代码分组，不拿错误文本猜类别',
      'br.retiredEmpty': '窗口内没有被退休的任务',
      'br.statusEmpty': '窗口内没有状态记录',
      'br.noName': '（无名称）',
      'drill.active': '已筛选 {label}',
      'drill.clear': '清除 ×',
      'drill.target': '工作区（派发目标）：{name}',
      'drill.host': '工作区（实际归属）：{name}',
      'drill.batch': '批次：{name}',
      'drill.parent': '主会话：{name}',
      'drill.status': '状态：{name}',
      'drill.onlyList': '批次 / 主会话 / 状态筛选只作用于总览列表；/board/stats 只接受 window、workspaceId、hostWorkspaceId，所以效果与拆解的数字仍是整个窗口的口径',
      'stats.loading': '正在聚合统计…',
      'stats.unavailable': '统计暂不可用',
      'stats.unavailableHint': '总览不受影响，仍按 /board 快照工作；效果与拆解需要 /board/stats',
      'stats.noSummary': '统计返回里没有可用的汇总（字段缺失或宿主版本较旧）',
      'stats.retry': '重试统计',
      'stats.back': '回到总览',
      'stats.meta': 'statsVersion {version} · 聚合于 {when} · {source}',
      'unit.ms': '毫秒',
      'unit.s': '秒',
      'unit.min': '分',
      'unit.hour': '时',

      /*
       * ── plans/09 P2：历史视图 + 任务详情抽屉 ──
       *
       * 这些键与上面的 P1 一样是 zh/en **成对硬编码**的：只写中文的那一条在英文
       * 界面下会静默退回中文，所以每一条都必须同时出现在 TEXT_EN 里
       * （scripts/client-smoke.mjs 的「TEXT 与 TEXT_EN 键集合完全一致」在守这件事）。
       */
      'view.history': '历史',
      'hist.sub.all': '全部',
      'hist.sub.archived': '已归档',
      'hist.sub.retired': '已退休',
      'hist.subLabel': '历史子视图',
      'hist.subHint': '「全部」是 /board 快照（活表 + 已归档）；退休留痕走独立只读路由，只在「已退休」里列出',
      'hist.search': '搜索',
      'hist.searchHint': '按 task_id、标题、worker_session_id、工作区搜索',
      'hist.clear': '清除筛选',
      'hist.status': '状态',
      'hist.statusAll': '全部状态',
      'hist.workspace': '工作区',
      'hist.time': '时间',
      'hist.timeHint': '时间按创建时刻过滤；退休留痕没有创建时刻，改用退休时刻',
      'hist.retried': '是否重试',
      'hist.background': '是否有后台',
      'hist.sort': '排序',
      'hist.sort.created': '创建时间',
      'hist.sort.settled': '结算时间',
      'hist.sort.elapsed': '耗时',
      'hist.col.task': '任务',
      'hist.col.status': '状态',
      'hist.col.workspace': '工作区',
      'hist.col.created': '创建',
      'hist.col.end': '结束',
      'hist.col.elapsed': '耗时',
      'hist.page': '第 {from}–{to} / 共 {n} 条',
      'hist.total': '筛选后 {n} / 共 {total} 条',
      'hist.prev': '上一页',
      'hist.next': '下一页',
      'hist.empty': '这个筛选下没有任务',
      'hist.cap': '快照只含最近 {shown} 条（共 {total} 条）；更早的记录请用 dispatch_list / dispatch_inspect',
      'hist.notOpenable': '退休留痕与已归档行没有可打开的子会话，只能复制 id 或看抽屉里的留痕',
      'hist.copied': '已复制 {id}',
      'hist.copyFailed': '复制失败：{reason}（可手抄 {id}）',
      'drawer.title': '任务详情',
      'drawer.close': '关闭',
      'drawer.lifecycle': '生命周期',
      'drawer.st.created': '创建',
      'drawer.st.started': '开始',
      'drawer.st.reported': '报告',
      'drawer.st.settled': '结算',
      'drawer.st.archived': '归档',
      'drawer.st.retired': '退休',
      'drawer.noTime': '没有记录',
      'drawer.scope': '简报与目录',
      'drawer.brief': '简报',
      'drawer.briefMissing': '快照只投影标题，完整简报请用 dispatch_inspect {id}',
      'drawer.cwd': '工作目录',
      'drawer.taskDir': '任务目录',
      'drawer.target': '目标工作区',
      'drawer.reports': '报告与最后输出',
      'drawer.reportCount': '报告数',
      'drawer.lastReport': '最后一次报告',
      'drawer.lastOutput': '最后输出',
      'drawer.fullTextHint': '完整报告正文、更早的报告与完整简报请用 dispatch_inspect {id}',
      'drawer.faults': '重试与错误',
      'drawer.attempt': '第几次',
      'drawer.retryAt': '重试时间',
      'drawer.error': '错误',
      'drawer.archiveError': '归档失败',
      'drawer.frozenAt': '冻结时刻',
      'drawer.delivery': '追问投递',
      'drawer.inputPending': '已投递，worker 未读',
      'drawer.inputRead': '已读',
      'drawer.inputNone': '没有追问',
      'drawer.background': '后台 job / subagent',
      'drawer.backgroundJobs': 'shell job',
      'drawer.backgroundSubagents': 'subagent',
      'drawer.backgroundSinceLabel': '起始时刻',
      'drawer.backgroundKilled': '后台已被终止',
      'drawer.backgroundNone': '没有后台 job / subagent',
      'drawer.backgroundState': '当前状态',
      'drawer.prepare': 'prepare 结果',
      'drawer.prepareAtNoWhen': '准备时刻',
      'drawer.prepareNone': '没有准备记录（未配置任务目录，或还没开始准备）',
      'drawer.openSession': '打开子会话',
      'drawer.noSessionHint': '这条记录没有可打开的子会话（已归档或已退休），只能复制 id 去 dispatch_inspect 查',
      'drawer.retiredNote': '该任务已退休：只保留留痕（何时、为什么、最后一条摘要），报告正文不可用',
      'drawer.summary': '最后一条摘要',
      /* ── 分析数据看板（与派发工作台平级，文案成对硬编码，见 scripts/client-smoke.mjs） ── */
      'an.surface': '看板',
      'an.surfaceTasks': '派发工作台',
      'an.surfaceAnalytics': '分析看板',
      'an.surfaceHint': '两块看板共用一个入口；派发工作台的字段、入口与所有操作保持不变',
      'an.title': '分析数据看板',
      'an.kpi': '核心指标',
      'an.kpiHint': '四张卡基于同一批筛选后的任务',
      'an.proxyNote': '代理口径（待业务确认）：负责人=主会话 · 逾期=时长阈值',
      'an.foot': '数字每 10 秒刷新；统计说明见 docs/board.md',
      'an.emptyRange': '连续 {n} 天无任务（空天补 0）',
      'an.emptyDay': '无任务（空天补 0）',
      'an.filters': '筛选条件',
      'an.window': '时间范围',
      'an.status': '状态',
      'an.owner': '负责人',
      'an.workspace': '工作区',
      'an.group': '批次',
      'an.overdueHours': '超时阈值',
      'an.all': '全部',
      'an.allStatus': '全部状态',
      'an.allOwner': '全部负责人',
      'an.allWorkspace': '全部工作区',
      'an.allGroup': '全部批次',
      'an.unknown': '未标注',
      'an.customDays': '自定义天数',
      'an.apply': '应用',
      'an.clear': '清除筛选',
      'an.refresh': '刷新',
      'an.updatedAt': '汇总于',
      'an.loading': '正在汇总分析数据…',
      'an.loadingHint': '读取完整账本，不使用派发工作台的 200 条快照',
      'an.unavailable': '分析数据暂时取不到',
      'an.degraded': '分析数据聚合失败，已降级返回',
      'an.stale': '展示的是上一次成功汇总的数据',
      'an.retry': '重试',
      'an.backTasks': '回到派发工作台',
      'an.empty': '这个筛选下没有任务',
      'an.emptyHint': '放宽时间范围或清除筛选条件后再看',
      'an.emptyTrend': '这个时间范围里没有趋势数据',
      'an.metric.total': '任务总量',
      'an.metric.totalHint': '筛选后账本里的任务条数（含已归档）',
      'an.metric.rate': '完成率',
      'an.metric.rateHint': 'done ÷ 可结算样本；取消与未结算不进分母',
      'an.metric.overdue': '超时代理',
      'an.metric.overdueHint': '创建后超过阈值仍未结算，或端到端耗时超过阈值的条数',
      'an.metric.active': '未结算',
      'an.metric.activeHint': 'running + queued，此刻还在账里流动的任务',
      'an.metric.none': '—',
      'an.rateSub': '{done} / {base} 条可结算样本',
      'an.overdueSub': '未结 {open} · 已结 {settled} · 未知 {unknown}',
      'an.activeSub': '已结算 {settled} · 已归档 {archived}',
      'an.totalSub': '账本 {source} 条 · 命中 {matched} 条',
      'an.sampleLow': '样本少（n<5）',
      'an.statusDist': '状态分布',
      'an.statusDistHint': '点某一行即可把「状态」筛选切到该状态',
      'an.trend': '趋势变化',
      'an.trendHint': '新建按创建日、完成/异常按结算日（UTC）；空天补 0',
      'an.chart': '图表',
      'an.table': '表格',
      'an.newCreated': '新建',
      'an.done': '完成',
      'an.problems': '异常',
      'an.compare': '较上一等长窗口',
      'an.compareNone': '「全部时间」没有上一窗口可比',
      'an.compareSample': '完成率 —（无可比样本）',
      'an.compareSampleHint': '任一窗口没有可结算样本时，不计算完成率差值',
      'an.overdueBlock': '逾期情况（代理指标）',
      'an.overdueBlockHint': '账本无 due_at / SLA：只统计超过阈值的时长，阈值由你设定（不是业务逾期）',
      'an.overdueOpen': '未结算超阈值',
      'an.overdueSettled': '已结算超阈值',
      'an.overdueUnknown': '时间未知',
      'an.overdueRate': '占比',
      /*
       * 口径表已从界面移除（用户原话：「没人看得懂」）：那张表写的是分子分母、
       * 字段名与待接入字段，属于给维护者的实现说明，界面上没有人会读。
       * 说明本身保留在 docs/board.md，只从 UI 撤掉，不删文档、不改统计。
       */
      'an.coverage': '样本口径',
      'an.coverageText': '账本 {source} 条 · 窗口内 {inWindow} 条 · 命中 {matched} 条 · 退休留痕 {retired} 条（不并入）',
      'an.warn.missingTimes': '有任务缺创建/结算时间，趋势可能低估',
      'an.warn.fallback': '部分旧数据用 updatedAt 近似结算时刻',
      'an.warn.clamped': '趋势范围超过 366 天，已裁剪到最近 366 天',
      'an.warn.truncated': '账本触顶或留痕被丢弃，结果为下界',
      'an.warn.invalidWindow': '时间范围参数无效，已退回默认窗口',
      'an.warn.invalidOverdueHours': '超时阈值无效，已退回 24 小时',
      'an.warn.ownerProxy': '账本没有人员字段，「负责人」按派发主会话代理（待业务确认）',
      'an.warn.dueAtProxy': '账本没有截止时间字段，「逾期」为时长代理指标（待业务确认）',
      'an.warn.degraded': '聚合失败，数字不可信',
      'an.hours': '{n} 小时',
      'an.days': '{n} 天',
      'an.windowPreset.24h': '24 小时',
      'an.windowPreset.7d': '7 天',
      'an.windowPreset.30d': '30 天',
      'an.windowPreset.all': '全部时间',
      'an.deltaCreated': '新建 {value}',
      'an.deltaDone': '完成 {value}',
      'an.deltaRate': '完成率 {value}',
      'an.trendTableHint': '表格是图表的等价物，可整块复制核对',
      'an.day': '日期',
    }

    /** 英文文案，仅用于 locale 服务接入；缺 key 时由 tr() 退回中文。 */
    const TEXT_EN = {
      title: 'Dispatch Workbench',
      concurrency: 'Running',
      queuedOne: 'Queued',
      total: 'Total',
      failed: 'Failed',
      'filter.all': 'All',
      'filter.active': 'Active',
      'filter.attention': 'Needs attention',
      'status.queued': 'Queued',
      'status.running': 'Running',
      'status.done': 'Done',
      'status.blocked': 'Blocked',
      'status.failed': 'Failed',
      'status.cancelled': 'Cancelled',
      'status.ended': 'Ended',
      'status.interrupted': 'Interrupted',
      attemptPrefix: 'attempt ',
      attemptSuffix: '',
      retryTag: 'retried {n}×',
      retrySinceHint: 'since {time}',
      reports: 'reports',
      /* 与上面 TEXT 的 plan.* 一一对应；缺一条英文界面就会退回中文。 */
      'plan.label': 'Plan',
      'plan.ratio': 'Plan {done}/{total}',
      'plan.currentLabel': 'Current step',
      'plan.tagHint': 'Plan {done}/{total}',
      'plan.updatedTag': 'Plan updated',
      'plan.updatedHint': 'The worker just submitted a different plan ({done}/{total}); this is the current snapshot, the old plan is not kept on the board',
      /* 与上面 TEXT 的 dep.* 一一对应；缺一条英文界面下会退回中文。 */
      'dep.tag': 'needs {n}',
      'dep.waiting': 'waiting for {title}',
      'dep.failedTag': 'upstream failed',
      'dep.tagHint': 'Depends on: {list}',
      'dep.block': 'Dependencies',
      'dep.label': 'Depends on',
      'dep.join': ', ',
      'dep.waitingLabel': 'Waiting on',
      'dep.waitingOn': '{title} ({reason})',
      'dep.notRunLabel': 'Not run because',
      'dep.notRun': 'upstream {title} failed',
      'dep.notRunMissing': 'upstream {title} is no longer in the ledger',
      'dep.reason.running': 'running',
      'dep.reason.failed': 'failed',
      'dep.reason.missing': 'missing',
      'dep.none': 'No dependencies',
      'dep.batchHead': '{total} members · {waiting} waiting on deps · {skipped} not run',
      noReport: 'no report yet',
      waiting: 'waiting',
      updatedAt: 'updated',
      empty: 'No tasks yet. Ask the main session to dispatch one with dispatch_launch.',
      emptyFiltered: 'No tasks in this filter.',
      emptyArchivedHint: '{n} older tasks are archived — switch to "Archived" to view them.',
      loading: 'Loading board…',
      unreachable: 'Board data is temporarily unavailable',
      stale: 'Showing the last successful snapshot',
      retry: 'Retry',
      cancel: 'Cancel',
      cancelling: 'Cancelling…',
      retryTask: 'Retry',
      retrying: 'Retrying…',
      actionFailed: 'Action failed',
      badResponse: 'Unexpected board response',
      httpError: 'Request failed',
      unknownError: 'Unknown error',
      noTitle: '(untitled)',
      dismiss: 'Dismiss',
      'filter.archived': 'Archived',
      archivedTag: 'Archived',
      archivedHint: 'That worker session is archived and cannot be opened; unarchive it in the session list first',
      archiveErrorPrefix: 'Archive failed: ',
      archiveNow: 'Archive stale sessions',
      archiveNowHint: 'Archives settled tasks with no update for over {hours} hours ({days} days); archived tasks move from "All" to "Archived"',
      archiveNowHintHours: 'Archives settled tasks with no update for over {hours} hours; archived tasks move from "All" to "Archived"',
      archiveNowHintUnknown: 'Archives settled tasks that have not been updated for a long time; archived tasks move from "All" to "Archived"',
      archiveConfirm: 'Click again to archive stale sessions',
      archiveRunning: 'Archiving…',
      archiveDone: 'Archive sweep: scanned {scanned}, archived {archived}, failed {failed}',
      archiveTask: 'Archive',
      archiving: 'Archiving…',
      archiveTaskConfirm: 'Click again to confirm',
      archiveTaskDone: 'Archived (still findable in history)',
      archiveTaskKept: 'Archived, but the worker session was not: {reason}',
      continueTask: 'Continue',
      continuePlaceholder: 'One more requirement (no new task; appended to the same worker session)',
      continueSubmit: 'Send',
      continueCancel: 'Cancel',
      continueSending: 'Sending…',
      continueHint: 'Continuing creates no new task: the requirement goes to this task’s worker session, so this is still the only row',
      workspaceAll: 'All workspaces',
      workspaceFilter: 'Filter by workspace',
      workspaceFallback: 'Follows session cwd',
      groupTag: 'batch',
      openFailed: 'Cannot open worker session {id}: {reason}',
      noWorkerSession: 'This task has no worker session to open',
      noUiWorkspace: 'session navigation is unavailable',
      clickHint: 'Open the worker session',
      backgroundTag: 'wrapping up',
      backgroundHint: 'The turn ended, but shell jobs or subagents still run; the task still holds a slot and is stopped at the limit',
      unreadTag: 'unread',
      unreadHint: 'The message was delivered but the worker has not taken it into context yet',
      unknownReadTag: 'read? unknown',
      unknownReadHint: 'The follow-up was delivered but never confirmed read; we no longer know whether the worker saw it',
      frozenTag: 'frozen',
      frozenHint: 'Frozen read-only: it will not change again, and a retry will fail',
      'sec.attention': 'Needs you',
      'sec.attentionEmpty': 'Nothing needs you right now',
      'sec.active': 'Running and queued',
      'sec.activeEmpty': 'Nothing is running or queued',
      'sec.done': 'Recently finished',
      'sec.archived': 'Archived',
      'sec.batch': 'Batch',
      'sec.single': 'Standalone',
      'stat.done': 'Done',
      'stat.doneHint': 'Settled tasks whose status is done',
      'stat.rate': 'Success',
      'stat.rateHint': 'Done ÷ settled; cancellations and interruptions count',
      'stat.average': 'Median time',
      'stat.averageHint': 'Median duration of settled tasks, the baseline for "is this one slow?"',
      'stat.saved': 'Saved by parallel',
      'stat.savedHint': 'Rough: sum of task durations minus the wall-clock span they actually took',
      'stat.none': '—',
      'stat.windowLabel': 'window',
      'stat.windowDays': 'last {days} days',
      'stat.windowCount': 'latest {n}',
      'stat.windowUnknown': 'window unknown',
      'stat.windowAll': 'all settled',
      'stat.windowHint': 'Metrics only count settled tasks inside the window; archived and retired tasks never vote. The host supplies the window; when it is unavailable the stats fall back to all settled tasks.',
      'filter.retired': 'Retired',
      'sec.retired': 'Retired',
      'retired.empty': 'No tasks have been retired',
      'retired.unavailable': 'This host does not report retired tasks',
      'retired.unavailableHint': 'The snapshot has no memory block (older host, or memory governance is off); other views are unaffected',
      'retired.ago': 'Retired {when}',
      'retired.reason': 'Reason',
      'retired.reason.cap-count': 'ledger cap',
      'retired.reason.cap-days': 'retention window',
      'retired.reason.none': 'no reason recorded',
      'retired.dropped': '{n} more retired records are beyond the display cap and are not listed here',
      'retired.copyHint': 'Copy this task id',
      'retired.action': 'Copy id',
      'retired.copied': 'Copied {id}',
      'retired.copyFailed': 'Copy failed: {reason} (task id is {id})',
      'retired.loadFailed': 'Retired records are temporarily unavailable: {reason}',
      'retired.notClickable': 'Retired records have no worker session; only the id can be copied',
      reason: 'Reason',
      noReason: 'No reason given; open the worker session to see where it stopped',
      showAll: 'Show all',
      showLess: 'Show less',
      reportAgo: 'report',
      batchOf: 'Batch',
      justNow: 'just now',
      minutesAgo: '{n} min ago',
      hoursAgo: '{n} h ago',
      daysAgo: '{n} d ago',
      targetPrefix: 'Dispatch',
      targetFollow: 'follow session',
      targetMenuFollow: 'Follow session cwd',
      targetLabel: 'Dispatch target workspace',
      targetUnavailable: 'Board service unavailable',
      targetLoading: 'Loading…',
      targetMenuRefresh: 'Refresh list',
      targetMenuEmpty: 'No workspaces available',
      targetSetFailed: 'Could not set the dispatch target: {reason}',
      targetPortalUnavailable: 'Menu unavailable',
      targetSection: 'Workspaces',
      targetAuto: 'Auto-select',
      targetNone: 'Do not dispatch',
      targetNoneHint: 'Run in this session',
      targetForcedHint: 'Dispatch mode: every task is delegated',
      targetFollowHint: "Use this session's own working directory",
      targetAutoHint: 'Pick a workspace from the typed keywords',
      targetAutoHit: 'Auto: {title}',
      targetAutoMiss: 'Auto: no workspace matches',
      'divider.relay': 'Dispatch report',

      /* plans/09 P1：与上面 TEXT 里新增的键一一对应（缺一条就会在英文界面退回中文）。 */
      'view.tabs': 'Board view',
      'view.overview': 'Overview',
      'view.effect': 'Performance',
      'view.breakdown': 'Breakdown',
      'view.switchHint': 'Overview answers "what needs me now"; Performance answers "how did this period go"; Breakdown answers "where are the problems concentrated".',
      'win.label': 'window',
      'win.24h': '24h',
      'win.days': '{days}d',
      'win.all': 'all',
      'win.scopeNote24h': 'Counting only facts from the last 24 hours (running and queued tasks ignore the window and still show)',
      'win.scopeNoteDays': 'Counting only facts from the last {days} days (running and queued tasks ignore the window and still show)',
      'win.scopeNoteAll': 'Counting every fact in the ledger, with no time limit',
      'win.fromMemory': 'The default window follows memory.window from the host; the client invents no default of its own',
      'scope.title': 'Sample scope',
      'scope.entry': 'Scope {window} · open performance',
      'scope.entryHint': 'The window only limits statistics; it never hides current work. Click to open the Performance view.',
      'scope.tail': 'settled in window n={settled} · valid durations n={valid} · archived excluded {archived} · retired {retired} · time unknown {missing}',
      'scope.lowBadge': 'low sample',
      'scope.lowHint': 'n < 5: the value still shows, but it is not a conclusion',
      'scope.timeBasis': 'time basis: {basis}',
      'scope.basis.settledAt': 'settledAt',
      'scope.basis.updatedAt-fallback': 'updatedAt fallback (old data)',
      'scope.basis.mixed': 'mixed bases',
      'scope.basis.missing': 'time unknown',
      'scope.basisHint': 'settledAt is written once when a task reaches a terminal state; only older records fall back to updatedAt, which reports, follow-ups and archiving keep refreshing — so the fallback must be labelled.',
      'scope.fallbackFrom': 'window parameter {value} was invalid; fell back to the host default',
      'scope.truncated': 'ledger is at its cap; results may be undercounted',
      'scope.truncatedHint': 'The live table hit ledgerMaxTasks, retired traces were dropped, or spans were clamped; treat this window as a lower bound.',
      'scope.source': 'read {n} ledger records (retired traces included, not limited by the 200-task snapshot)',
      'scope.sourceHint': 'sourceTasks = live-table tasks + retired traces: it proves these numbers come from the full ledger, not from the 200-task snapshot polled every 2 s',
      'eff.result': 'Outcome',
      'eff.speed': 'Speed',
      'eff.stable': 'Stability',
      'eff.trend': 'Trend',
      'eff.parallel': 'Parallel',
      'eff.done': 'Done',
      'eff.doneHint': 'Settled tasks with status=done inside the window, attributed by settlement time',
      'eff.rate': 'Completion',
      'eff.rateHint': 'done ÷ (done + ended + failed + blocked + interrupted); cancellations stay out of the denominator (their own rate is listed separately)',
      'eff.first': 'First-pass',
      'eff.firstHint': 'attempt=1 and done ÷ settled with attempt=1; cancellations excluded, measuring "finished without rework"',
      'eff.rework': 'Rework',
      'eff.reworkHint': 'tasks with attempt>1 ÷ tasks dispatched in the window; counted per task, not per attempt',
      'eff.throughput': 'Throughput',
      'eff.throughputHint': 'done ÷ calendar days in the window; not "days that had tasks", which inflates quiet periods',
      'eff.saved': 'Saved',
      'eff.savedHint': 'Σ occupied − wall span; a rough estimate, not time accounting',
      'eff.estimate': 'estimated',
      'eff.stableHint': 'Failed / blocked / interrupted are counted separately; one word "failure" would hide the rest. The denominator is settled (cancellations included).',
      'eff.cancelHint': 'Cancelling is the user taking work back: it must not lower the completion rate, but it must be visible on its own',
      'eff.perDay': '{value} / day',
      'card.settled': 'settled n={n}',
      'card.sample': 'n={n}',
      'card.denom': '÷ n={n}',
      'card.p50': 'P50',
      'card.p90': 'P90',
      'speed.queue': 'Queue wait',
      'speed.queueHint': 'startedAt − createdAt; queued tasks that never started are not a sample here (current queue depth lives on the overview)',
      'speed.occupied': 'Occupied',
      'speed.occupiedHint': 'settledAt − startedAt, including background wrap-up; this is not "pure model execution time"',
      'speed.endToEnd': 'End to end',
      'speed.endToEndHint': 'settledAt − createdAt, roughly queue wait + occupied',
      'st.recovery': 'Recovered after retry',
      'st.recoveryHint': 'attempt>1 and done ÷ settled with attempt>1; the ledger keeps no attempt history, so this is the best available approximation',
      'trend.day': 'Date',
      'trend.created': 'Dispatched',
      'trend.done': 'Done',
      'trend.problems': 'Failed·blocked·interrupted',
      'trend.median': 'Median duration',
      'trend.saved': 'Saved',
      'trend.chart': 'Chart',
      'trend.table': 'Table',
      'trend.modeLabel': 'How the trend is shown',
      'trend.chartHint': 'Bars are decoration only: every value is written as text on the same row, so colour is never the only channel',
      'trend.empty': 'No per-day facts inside this window yet',
      'trend.none': 'no record',
      'trend.noneHint': 'The day is inside the window but the ledger holds no fact for it; do not read it as zero',
      'trend.detail': 'Detail for {day}: dispatched {created} · done {done} · failed/blocked/interrupted {problems} · median duration {median} · saved {saved}',
      'trend.onlyFacts': 'Only days that really have facts are listed; padded days say "no record" instead of zero',
      'par.occupied': 'Occupied total',
      'par.occupiedHint': 'Σ(settledAt − startedAt) over settled tasks with complete times',
      'par.wall': 'Wall span',
      'par.wallHint': 'max(settledAt) − min(startedAt); with one task it equals that task\'s occupied time',
      'par.factor': 'Parallel factor',
      'par.factorHint': 'occupied total ÷ wall span; shown as — when the span is 0 (one task has no factor)',
      'par.sample': 'sample n={n}',
      'par.reasons': 'made rougher by: {list}',
      'par.reason.sample-low': 'small sample',
      'par.reason.updatedAt-fallback': 'some times fall back to updatedAt',
      'par.reason.durations-clamped': 'some durations were clamped',
      'par.reason.ledger-truncated': 'ledger is at its cap',
      'par.reason.missing-times': 'some tasks lack times',
      'br.workspaces': 'Workspaces',
      'br.batches': 'Batches',
      'br.sessions': 'Parent sessions',
      'br.distribution': 'Status and retirement reasons',
      'br.dimTarget': 'dispatch target',
      'br.dimHost': 'actual host',
      'br.dimNote': 'scope: {label} ({field})',
      'br.dimTargetHint': 'Dispatch target workspace_id: where the user sent the task; the overview filter keeps this dimension',
      'br.dimHostHint': 'Actual host workspace_id: the workspace the worker session really runs in',
      'br.col.name': 'Workspace',
      'br.col.batch': 'Batch',
      'br.col.session': 'Parent session',
      'br.col.running': 'Running',
      'br.col.queued': 'Queued',
      'br.col.done': 'Done',
      'br.col.rate': 'Rate',
      'br.col.median': 'P50 occupied',
      'br.col.failed': 'Failed',
      'br.col.blocked': 'Blocked',
      'br.col.saved': 'Saved',
      'br.col.last': 'Last activity',
      'br.col.progress': 'Progress',
      'br.col.pending': 'Pending',
      'br.col.wall': 'Batch wall',
      'br.col.dispatched': 'Dispatched',
      'br.col.failedCount': 'Failures',
      'br.pendingHint': 'Pending = failed + blocked + interrupted, the same set the overview calls "needs you"',
      'br.wallHint': 'Batch wall = max(updatedAt) − min(createdAt); it stops growing once every member has settled',
      'br.lastHint': 'The latest member activity (settled / updated / created); the ledger keeps no batch-level report time',
      'br.rowHint': 'Click this row to filter by "{name}" and return to the overview',
      'br.empty': 'Nothing to break down inside this window',
      'br.emptyHint': 'No settled or current tasks in the window; widen it, or dispatch a task first',
      'br.statusTitle': 'Status distribution',
      'br.statusHint': 'Horizontal bars; click a row to filter by that status and return to the overview',
      'br.retiredTitle': 'Retirement reasons',
      'br.retiredHint': 'Stable codes only; error text is never used to guess a category',
      'br.retiredEmpty': 'No task was retired inside this window',
      'br.statusEmpty': 'No status recorded inside this window',
      'br.noName': '(no name)',
      'drill.active': 'Filtered by {label}',
      'drill.clear': 'Clear ×',
      'drill.target': 'Workspace (dispatch target): {name}',
      'drill.host': 'Workspace (actual host): {name}',
      'drill.batch': 'Batch: {name}',
      'drill.parent': 'Parent session: {name}',
      'drill.status': 'Status: {name}',
      'drill.onlyList': 'Batch / parent-session / status filters narrow the overview list only; /board/stats accepts window, workspaceId and hostWorkspaceId, so the performance and breakdown numbers still cover the whole window',
      'stats.loading': 'Aggregating statistics…',
      'stats.unavailable': 'Statistics are temporarily unavailable',
      'stats.unavailableHint': 'The overview is unaffected and keeps working from the /board snapshot; performance and breakdown need /board/stats',
      'stats.noSummary': 'The statistics response carries no usable summary (missing fields, or an older host)',
      'stats.retry': 'Retry statistics',
      'stats.back': 'Back to overview',
      'stats.meta': 'statsVersion {version} · aggregated at {when} · {source}',
      'unit.ms': 'ms',
      'unit.s': 's',
      'unit.min': 'min',
      'unit.hour': 'h',

      /* plans/09 P2：历史视图 + 任务详情抽屉（与上面 TEXT 的 P2 段一一对应）。 */
      'view.history': 'History',
      'hist.sub.all': 'All',
      'hist.sub.archived': 'Archived',
      'hist.sub.retired': 'Retired',
      'hist.subLabel': 'History sub-view',
      'hist.subHint': '"All" is the /board snapshot (live table + archived); retired traces come from their own read-only route and are listed only under "Retired"',
      'hist.search': 'Search',
      'hist.searchHint': 'Search by task_id, title, worker_session_id or workspace',
      'hist.clear': 'Clear filters',
      'hist.status': 'Status',
      'hist.statusAll': 'All statuses',
      'hist.workspace': 'Workspace',
      'hist.time': 'Time',
      'hist.timeHint': 'Time filters by creation time; retired traces have no creation time, so their retirement time is used',
      'hist.retried': 'Retried only',
      'hist.background': 'With background only',
      'hist.sort': 'Sort',
      'hist.sort.created': 'Created',
      'hist.sort.settled': 'Settled',
      'hist.sort.elapsed': 'Duration',
      'hist.col.task': 'Task',
      'hist.col.status': 'Status',
      'hist.col.workspace': 'Workspace',
      'hist.col.created': 'Created',
      'hist.col.end': 'Ended',
      'hist.col.elapsed': 'Duration',
      'hist.page': 'Rows {from}–{to} of {n}',
      'hist.total': '{n} of {total} after filtering',
      'hist.prev': 'Previous',
      'hist.next': 'Next',
      'hist.empty': 'No tasks under these filters',
      'hist.cap': 'The snapshot holds only the latest {shown} rows ({total} total); use dispatch_list / dispatch_inspect for older ones',
      'hist.notOpenable': 'Retired traces and archived rows have no openable worker session; copy the id or read the drawer trace instead',
      'hist.copied': 'Copied {id}',
      'hist.copyFailed': 'Copy failed: {reason} (copy {id} by hand)',
      'drawer.title': 'Task detail',
      'drawer.close': 'Close',
      'drawer.lifecycle': 'Lifecycle',
      'drawer.st.created': 'Created',
      'drawer.st.started': 'Started',
      'drawer.st.reported': 'Reported',
      'drawer.st.settled': 'Settled',
      'drawer.st.archived': 'Archived',
      'drawer.st.retired': 'Retired',
      'drawer.noTime': 'not recorded',
      'drawer.scope': 'Brief and directories',
      'drawer.brief': 'Brief',
      'drawer.briefMissing': 'The snapshot projects only the title; use dispatch_inspect {id} for the full brief',
      'drawer.cwd': 'Working dir',
      'drawer.taskDir': 'Task dir',
      'drawer.target': 'Target workspace',
      'drawer.reports': 'Reports and last output',
      'drawer.reportCount': 'Reports',
      'drawer.lastReport': 'Last report',
      'drawer.lastOutput': 'Last output',
      'drawer.fullTextHint': 'Use dispatch_inspect {id} for full report bodies, earlier reports and the complete brief',
      'drawer.faults': 'Retries and errors',
      'drawer.attempt': 'Attempt',
      'drawer.retryAt': 'Retried at',
      'drawer.error': 'Error',
      'drawer.archiveError': 'Archive failed',
      'drawer.frozenAt': 'Frozen at',
      'drawer.delivery': 'Follow-up delivery',
      'drawer.inputPending': 'delivered, not read by the worker',
      'drawer.inputRead': 'read',
      'drawer.inputNone': 'no follow-up',
      'drawer.background': 'Background jobs / subagents',
      'drawer.backgroundJobs': 'shell jobs',
      'drawer.backgroundSubagents': 'subagents',
      'drawer.backgroundSinceLabel': 'Since',
      'drawer.backgroundKilled': 'The background was terminated',
      'drawer.backgroundNone': 'No background jobs or subagents',
      'drawer.backgroundState': 'State',
      'drawer.prepare': 'prepare result',
      'drawer.prepareAtNoWhen': 'Prepared at',
      'drawer.prepareNone': 'No prepare record (no task dir configured, or preparation never ran)',
      'drawer.openSession': 'Open worker session',
      'drawer.noSessionHint': 'This record has no openable worker session (archived or retired); copy the id and query it with dispatch_inspect',
      'drawer.retiredNote': 'This task was retired: only the trace remains (when, why, the last summary); report bodies are unavailable',
      'drawer.summary': 'Last summary',
      /* Analytics dashboard (zh/en keys must stay identical, see scripts/client-smoke.mjs). */
      'an.surface': 'Board',
      'an.surfaceTasks': 'Dispatch Workbench',
      'an.surfaceAnalytics': 'Analytics',
      'an.surfaceHint': 'Both boards share one entry point; the dispatch workbench keeps every field, entry and action',
      'an.title': 'Task analytics',
      'an.kpi': 'Key metrics',
      'an.kpiHint': 'All four cards use the same filtered task set',
      'an.proxyNote': 'Proxies (pending confirmation): owner = parent session · overtime = duration threshold',
      'an.foot': 'Refreshes every 10s; statistical notes live in docs/board.md',
      'an.emptyRange': '{n} days with no tasks (filled with 0)',
      'an.emptyDay': 'No tasks (filled with 0)',
      'an.filters': 'Filters',
      'an.window': 'Time range',
      'an.status': 'Status',
      'an.owner': 'Owner',
      'an.workspace': 'Workspace',
      'an.group': 'Batch',
      'an.overdueHours': 'Overdue threshold',
      'an.all': 'All',
      'an.allStatus': 'All statuses',
      'an.allOwner': 'All owners',
      'an.allWorkspace': 'All workspaces',
      'an.allGroup': 'All batches',
      'an.unknown': 'Not specified',
      'an.customDays': 'Custom days',
      'an.apply': 'Apply',
      'an.clear': 'Clear filters',
      'an.refresh': 'Refresh',
      'an.updatedAt': 'Aggregated at',
      'an.loading': 'Aggregating analytics…',
      'an.loadingHint': 'Reads the full ledger, not the 200-task board snapshot',
      'an.unavailable': 'Analytics data is temporarily unavailable',
      'an.degraded': 'Analytics aggregation failed; degraded response returned',
      'an.stale': 'Showing the last successful aggregation',
      'an.retry': 'Retry',
      'an.backTasks': 'Back to Dispatch Workbench',
      'an.empty': 'No tasks match these filters',
      'an.emptyHint': 'Widen the time range or clear the filters',
      'an.emptyTrend': 'No trend data in this time range',
      'an.metric.total': 'Total tasks',
      'an.metric.totalHint': 'Tasks in the filtered ledger (archived included)',
      'an.metric.rate': 'Completion rate',
      'an.metric.rateHint': 'done ÷ countable settled; cancelled and unsettled are excluded',
      'an.metric.overdue': 'Overtime proxy',
      'an.metric.overdueHint': 'Unsettled past the threshold since creation, or settled past the threshold end to end',
      'an.metric.active': 'Unsettled',
      'an.metric.activeHint': 'running + queued, tasks still moving through the ledger',
      'an.metric.none': '—',
      'an.rateSub': '{done} / {base} countable settled',
      'an.overdueSub': 'open {open} · settled {settled} · unknown {unknown}',
      'an.activeSub': 'settled {settled} · archived {archived}',
      'an.totalSub': 'ledger {source} · matched {matched}',
      'an.sampleLow': 'Low sample (n<5)',
      'an.statusDist': 'Status distribution',
      'an.statusDistHint': 'Click a row to apply that status as a filter',
      'an.trend': 'Trend',
      'an.trendHint': 'Created by creation day, done/problems by settlement day (UTC); empty days = 0',
      'an.chart': 'Chart',
      'an.table': 'Table',
      'an.newCreated': 'Created',
      'an.done': 'Done',
      'an.problems': 'Problems',
      'an.compare': 'vs previous equal window',
      'an.compareNone': 'No previous window exists for "all time"',
      'an.compareSample': 'Completion — (no comparable sample)',
      'an.compareSampleHint': 'Completion rate delta is skipped when either window has no countable sample',
      'an.overdueBlock': 'Overtime (proxy metric)',
      'an.overdueBlockHint': 'No due_at / SLA in the ledger: only duration past your threshold (not business overdue)',
      'an.overdueOpen': 'Unsettled past threshold',
      'an.overdueSettled': 'Settled past threshold',
      'an.overdueUnknown': 'Unknown time',
      'an.overdueRate': 'Share',
      /* 与中文侧同步：口径表已从界面移除，说明保留在 docs/board.md。 */
      'an.coverage': 'Sample coverage',
      'an.coverageText': 'ledger {source} · in window {inWindow} · matched {matched} · retired traces {retired} (excluded)',
      'an.warn.missingTimes': 'Some tasks lack creation/settlement times; the trend may be underestimated',
      'an.warn.fallback': 'Some older rows use updatedAt as an approximate settlement time',
      'an.warn.clamped': 'Trend range exceeds 366 days; clipped to the most recent 366 days',
      'an.warn.truncated': 'Ledger cap reached or retired traces dropped: these numbers are a lower bound',
      'an.warn.invalidWindow': 'Invalid time range; fell back to the default window',
      'an.warn.invalidOverdueHours': 'Invalid overdue threshold; fell back to 24 hours',
      'an.warn.ownerProxy': 'No person field in the ledger: "Owner" uses the parent session as a proxy (pending business confirmation)',
      'an.warn.dueAtProxy': 'No due-date field in the ledger: "Overtime" is a duration proxy (pending business confirmation)',
      'an.warn.degraded': 'Aggregation failed; numbers are not trustworthy',
      'an.hours': '{n} h',
      'an.days': '{n} days',
      'an.windowPreset.24h': '24 hours',
      'an.windowPreset.7d': '7 days',
      'an.windowPreset.30d': '30 days',
      'an.windowPreset.all': 'All time',
      'an.deltaCreated': 'created {value}',
      'an.deltaDone': 'done {value}',
      'an.deltaRate': 'completion {value}',
      'an.trendTableHint': 'The table is an exact copyable equivalent of the chart',
      'an.day': 'Day',
    }

    /** 当前翻译函数；attachLocale 成功后会替换成 locale 绑定的 t()。 */
    let tr = function (key) {
      return TEXT[key] !== undefined ? TEXT[key] : key
    }

    /**
     * 尝试接入 Client locale。成本必须低：服务不在、API 形状不同、注册抛错，
     * 都只是保持内置中文，不影响面板渲染。
     * @returns {boolean} 是否真的用上了 locale
     */
    function attachLocale(ctx) {
      let locale
      try {
        locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale
      } catch (error) {
        return false
      }
      if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return false
      try {
        const dispose = locale.register(LOCALE_NS, { zh: TEXT, en: TEXT_EN })
        if (typeof dispose === 'function') ctx.effect(() => dispose)
        const bound = locale.bind(LOCALE_NS)
        if (typeof bound !== 'function') return false
        tr = function (key) {
          const value = bound(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
          return TEXT[key] !== undefined ? TEXT[key] : key
        }
        return true
      } catch (error) {
        return false
      }
    }

    /* ───────────────────────── 状态外观 ───────────────────────── */

    /**
     * 每个状态两个通道：颜色 + 文字（见 TEXT['status.*']），不靠颜色单独表意。
     * token 自带明暗两套，写死颜色只在 token 缺失时兜底。
     */
    const STATUS_META = {
      queued: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', pulse: false },
      running: { color: 'var(--dsw-alias-state-business-primary, #3b82f6)', pulse: true },
      done: { color: 'var(--dsw-alias-state-success-primary, #16a34a)', pulse: false },
      blocked: { color: 'var(--dsw-alias-state-warn-primary, #d97706)', pulse: false },
      failed: { color: 'var(--dsw-alias-state-error-primary, #dc2626)', pulse: false },
      cancelled: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', pulse: false },
      ended: { color: 'var(--dsw-alias-label-secondary, #6b6b6b)', pulse: false },
      interrupted: { color: 'var(--dsw-alias-state-warn-primary, #d97706)', pulse: false },
    }
    const STATUS_FALLBACK = { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', pulse: false }

    /**
     * 一条已结算任务能做哪些操作。
     *
     * 从「返回单个 kind」改成「返回主操作 + 是否可归档」，因为**归档与重试不是
     * 互斥的**：一个被中断的任务，用户既要能重试，也要能「别再挡在我面前」。
     * 原来只返回一个 kind，等于逼着每条状态只能有一个按钮，而取消对终态又是
     * 硬拒绝（`dispatch.cancel()` 见到 `SETTLED` 直接抛）——于是
     * `interrupted/failed/blocked/ended` 这些行只剩「重试」，永远卡在
     * 「需要你处理」区，正是用户报的「只有重试会一直卡着」。
     *
     * 返回形状（两个字段都必给，调用方不用判 undefined）：
     * - `primary`：主按钮 kind（`'cancel'` / `'retry'` / `null`）。
     *   `null` 表示这一行没有主操作（例如已完成的、已取消的）。
     * - `archive`：是否给「归档」按钮。**覆盖全部终态**
     *   （`interrupted|failed|blocked|ended|done|cancelled`），这是用户明确要求的
     *   范围；`running|queued` 不给——归档会把还在写的会话冻成只读。
     *
     * 为什么不把 `interrupted` 改成 `cancelled` 来消掉这个按钮：plans/09 §四 A
     * 规定「取消不进完成率分母」。把中断改写成取消会同时污染取消率与完成率——
     * 两个指标都变成「谁点过按钮」的函数，而不是执行结果。
     */
    function actionOf(status) {
      /*
       * `continue`：能不能在这一行上「续派」（plans/08 阶段 1）。
       *
       * **只给已结算的行**（`done|blocked|failed|cancelled|ended|interrupted`），
       * 也就是 `!SETTLED` 的反面。为什么不是「所有行」：宿主侧的续派走
       * `POST /retry` + `message`，而它对未结算任务会回 409（不能把一条要求插进
       * 正在跑的回合）。按钮出现在一个必然失败的组合上，比不出现更糟——
       * 用户点一下只会拿到一句错误，还得自己猜为什么。
       *
       * 归档行仍然一个按钮都不给：`archived` 在 `TaskCard` 里已经短路成
       * `NO_ACTIONS`，见那里的注释（归档 = 只读冻结）。
       */
      if (status === 'running' || status === 'queued') return { primary: 'cancel', archive: false, continue: false }
      if (status === 'failed' || status === 'interrupted' || status === 'ended' || status === 'blocked') {
        return { primary: 'retry', archive: true, continue: true }
      }
      // done / cancelled 没有主操作，但仍然需要「归档」把它们从列表里收走。
      if (status === 'done' || status === 'cancelled') return { primary: null, archive: true, continue: true }
      return { primary: null, archive: false, continue: false }
    }

    /** 「这一行没有操作按钮」。单独提出来是为了让 `actionOf` 的返回形状只有一种。 */
    const NO_ACTIONS = { primary: null, archive: false, continue: false }

    /**
     * 五个过滤 chip 的定义。
     * 「全部」不含已归档：归档是历史，只在自己的 chip 里出现，否则列表会被历史淹没。
     *
     * 「已退休」排在「已归档」之后，且 `match` 恒为 false —— 退休记录不在 `tasks` 里
     * （它们在宿主账本的另一个 Map 里），靠这个可选链只决定 chip 是否出现，
     * 计数与列表都走 `/board/retired` 单独取数。把退休塞回 tasks 等于让「账本有上界」
     * 这件事在快照上不可验证（plans/07 §七 4）。
     */
    const FILTERS = [
      { id: 'all', labelKey: 'filter.all', match: function (task) { return !task.archived_at } },
      {
        id: 'active',
        labelKey: 'filter.active',
        match: function (task) {
          return !task.archived_at && (task.status === 'running' || task.status === 'queued')
        },
      },
      {
        id: 'attention',
        labelKey: 'filter.attention',
        match: function (task) {
          return !task.archived_at
            && (task.status === 'failed' || task.status === 'interrupted' || task.status === 'blocked')
        },
      },
      {
        id: 'archived',
        labelKey: 'filter.archived',
        match: function (task) { return Boolean(task.archived_at) },
      },
      {
        id: 'retired',
        labelKey: 'filter.retired',
        // 退休任务从不来自快照；这个 filter 只用于切换视图，不参与计数。
        match: function () { return false },
        // 标记给渲染层：这个 chip 的计数来自 memory 块，而不是过滤后的任务列表。
        remote: 'retired',
      },
    ]

    /* ───────────────────────── 小工具 ───────────────────────── */

    /** 数字兜底：不是有限数就用 fallback。 */
    function num(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /** 把毫秒格式化成紧凑的中文时长。 */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
      const seconds = Math.max(1, Math.round(ms / 1000))
      if (seconds < 60) return seconds + ' 秒'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + ' 分 ' + String(seconds % 60).padStart(2, '0') + ' 秒'
      const hours = Math.floor(minutes / 60)
      return hours + ' 时 ' + String(minutes % 60).padStart(2, '0') + ' 分'
    }

    /** 只取本地时间，日期对看板没有意义。 */
    function formatClock(stamp) {
      const date = new Date(stamp)
      if (Number.isNaN(date.getTime())) return ''
      try {
        return date.toLocaleTimeString('zh-CN', { hour12: false })
      } catch (error) {
        return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
      }
    }

    /**
     * 只到分钟的 HH:mm（A6 的「自 HH:mm 起」用）。
     *
     * 为什么不复用 `formatClock()`：它给的是带秒的本地时间串（「最后更新 23:57:01」），
     * 而「这轮重试从什么时候开始」秒没有意义，多两位只会让 title 更难扫。
     * 也不用 `toLocaleTimeString()` 再截断——那要看宿主的面板语言，截出来可能是
     * 「11:57」配 AM/PM；这里直接按本地时区补零，输出稳定可断言。
     */
    function formatClockShort(stamp) {
      const date = new Date(stamp)
      if (Number.isNaN(date.getTime())) return ''
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
    }

    /** 报告摘要的第一行（跳过空行）。 */
    function firstLine(text) {
      if (typeof text !== 'string') return ''
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim()
        if (line) return line
      }
      return ''
    }

    /** 耗时：running 在两次轮询之间自己走表，其余用服务端算好的值。 */
    function elapsedOf(task, now, fetchedAt) {
      if (task.status === 'queued') return tr('waiting')
      const base = num(task.elapsed_ms, 0)
      if (task.status === 'running' && fetchedAt > 0) {
        return formatDuration(base + Math.max(0, now - fetchedAt))
      }
      return base > 0 ? formatDuration(base) : ''
    }

    /** 把异常压成一句能显示的话。 */
    function describeError(error) {
      if (error && typeof error.message === 'string' && error.message) return error.message
      if (typeof error === 'string' && error) return error
      return tr('unknownError')
    }

    /** 模板占位替换：{name} -> vars.name。缺失的占位原样保留，方便发现漏配。 */
    function fill(template, vars) {
      if (typeof template !== 'string') return ''
      return template.replace(/\{(\w+)\}/g, function (match, key) {
        return vars && vars[key] !== undefined ? String(vars[key]) : match
      })
    }

    /** 日期只用于很久以前的归档时间。 */
    function formatDate(stamp) {
      const date = new Date(stamp)
      if (Number.isNaN(date.getTime())) return ''
      return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
    }

    /** 相对时间：归档是历史，读「多久之前」比读时间戳省事。 */
    function formatRelative(stamp, now) {
      const time = typeof stamp === 'number' ? stamp : Date.parse(String(stamp))
      if (!Number.isFinite(time)) return ''
      const delta = Math.max(0, (typeof now === 'number' ? now : Date.now()) - time)
      if (delta < 60000) return tr('justNow')
      const minutes = Math.floor(delta / 60000)
      if (minutes < 60) return fill(tr('minutesAgo'), { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return fill(tr('hoursAgo'), { n: hours })
      const days = Math.floor(hours / 24)
      if (days < 30) return fill(tr('daysAgo'), { n: days })
      return formatDate(stamp)
    }

    /** 任务派到哪个工作区；未指定时说明它跟随会话自己的工作目录。 */
    function workspaceTitleOf(task) {
      if (task && typeof task.workspace_title === 'string' && task.workspace_title) return task.workspace_title
      return tr('workspaceFallback')
    }

    /**
     * 同批次（group 非空）的任务聚到一起。
     * 以 group 在基序里第一次出现的位置为锚点，把同组任务整体挪过来：
     * 服务端给的 running→queued→其余（updated_at 倒序）基序保留不变，
     * 只是让同组行视觉相邻。无 group 的任务原地不动。
     */
    function clusterByGroup(tasks) {
      const seen = new Set()
      const out = []
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i]
        const group = task && typeof task.group === 'string' && task.group ? task.group : ''
        if (!group) {
          out.push(task)
          continue
        }
        if (seen.has(group)) continue
        seen.add(group)
        for (let j = 0; j < tasks.length; j += 1) {
          if (tasks[j] && tasks[j].group === group) out.push(tasks[j])
        }
      }
      return out
    }

    /* ───────────────── 面板的「效果」计算（纯函数，便于离线断言） ───────────────── */

    /** 已结算：不再占并发位、也不会再有报告。 */
    const SETTLED_STATUS = new Set(['done', 'blocked', 'failed', 'cancelled', 'ended', 'interrupted'])
    /** 需要人处理：失败、阻塞、被中断。 */
    const ATTENTION_STATUS = new Set(['failed', 'blocked', 'interrupted'])
    /** 处理优先级：失败最急，其次阻塞，最后中断（通常只是宿主重启过）。 */
    const ATTENTION_RANK = { failed: 0, blocked: 1, interrupted: 2 }

    /** 中位数；空数组返回 0。用中位数而不是平均，避免一个 40 分钟的任务把基线拉飞。 */
    function median(values) {
      const list = (values || [])
        .filter(function (value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 })
        .sort(function (a, b) { return a - b })
      if (!list.length) return 0
      const mid = Math.floor(list.length / 2)
      return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2)
    }

    /** 一条任务算不算「今天」做的（本地日历日）。 */
    function isToday(stamp, now) {
      const at = Date.parse(stamp || '')
      if (!Number.isFinite(at)) return false
      const a = new Date(at)
      const b = new Date(now)
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    }

    /**
     * 指标窗口（plans/07 P0-1「指标窗口化」）。
     *
     * 缺省是 `null` = 拿不到宿主下发的窗口，此时退回「全部已结算」并把口径写成
     * 「窗口未知」——**不假装窗口存在**，否则同一个 86% 会在两种口径之间悄悄漂移。
     */
    function pickWindow(memory) {
      const window = memory && typeof memory === 'object' ? memory.window : null
      if (!window || typeof window !== 'object') return null
      const days = num(window.days, 0)
      const tasks = num(window.tasks, 0)
      const since = typeof window.since === 'string' && Number.isFinite(Date.parse(window.since)) ? window.since : ''
      // since 可以由 days 推导；宿主只给 days 时本地算一遍，省得少一条时间界就整个降级。
      const sinceAt = since ? Date.parse(since) : (days > 0 ? Date.now() - days * 86400000 : NaN)
      if (!Number.isFinite(sinceAt) && !(tasks > 0)) return null
      return { days: days, tasks: tasks, sinceAt: sinceAt }
    }

    /**
     * 「立即归档超时会话」的悬浮提示。
     *
     * 时长来自快照的 `archive_after_hours`（宿主真实配置，见 `src/board.js`）。
     * 为什么不能写死 168：配置改成别的值、或把巡检关掉（0 = 不自动归档）之后，
     * 一句「超过 168 小时」就变成了假话，而用户正是拿这句话去理解那颗按钮做了什么。
     *
     * 三种取值对应三种说法：
     * - 有值且是整天 → 「超过 168 小时（7 天）」；
     * - 有值但不是整天 → 只说小时（取整成天会差出一截，宁可不给天数）；
     * - 0 / 缺失（旧宿主没这个字段）→ 不带数字的说法，**绝不**拼出 undefined。
     *
     * @param {number|undefined} hours 快照里的 `archive_after_hours`
     * @returns {string} 可直接放进 title / aria-label 的一句话
     */
    function archiveHintOf(hours) {
      const value = num(hours, 0)
      if (!(value > 0)) return tr('archiveNowHintUnknown')
      if (value % 24 === 0) return fill(tr('archiveNowHint'), { hours: value, days: value / 24 })
      return fill(tr('archiveNowHintHours'), { hours: value })
    }

    /**
     * 窗口口径的人话，例如「最近 7 天 / 最近 200 条」。
     *
     * 为什么要写出来：0.8.x 的成功率悄悄吃全历史，上个月失败的任务还在给今天的数字投票，
     * 而界面上只有一个裸百分比 —— 没人能看出它统计的是哪个范围（plans/07 §二 4）。
     * 现在口径随数字一起显示，窗口取不到时明说「窗口未知」。
     */
    function windowLabel(window) {
      if (!window) return tr('stat.windowUnknown') + ' · ' + tr('stat.windowAll')
      const parts = []
      if (window.days > 0) parts.push(fill(tr('stat.windowDays'), { days: window.days }))
      if (window.tasks > 0) parts.push(fill(tr('stat.windowCount'), { n: window.tasks }))
      return parts.length ? parts.join(' / ') : tr('stat.windowUnknown')
    }

    /**
     * 「派发带来了什么」的一组近似值。
     *
     * 并行节省的定义：窗口内已结算任务的耗时之和，减去它们实际占用的墙钟跨度
     * （最早开始 → 最近更新）。串行做这些活要花前者，实际只花了后者，差额就是省下来的。
     * 明确是粗算：快照只含最近 200 条。宁可标注「粗算」，也不编一个好看的数字。
     *
     * 窗口化（第三个参数，可选，不影响 scripts/board-preview.mjs 的旧调用）：
     * - 只统计 `updated_at >= window.sinceAt` 的任务，且最多取最近 `window.tasks` 条已结算任务
     *   （按 updated_at 倒序取前 N，也就是「最近 N 条」）；
     * - **归档任务彻底移出**：`archived_at` 非空的不进 rates / median / saved / settled。
     *   归档 = 只读历史，让它继续给当下指标投票，等于把「过期内容残留」从数据层搬到数字层；
     * - 墙钟跨度也在窗口内算（只用被选中的那批任务）。
     * 传 `null`/省略 = 窗口未知 → 全部已结算，行为与 0.8.x 一致。
     */
    function effectStats(tasks, now, window) {
      const list = Array.isArray(tasks) ? tasks.filter(function (task) { return task && typeof task === 'object' }) : []
      // 归档任务不参与任何派生指标。这一条与窗口无关，即使窗口未知也要生效。
      const live = list.filter(function (task) { return !task.archived_at })
      const settledAll = live.filter(function (task) { return SETTLED_STATUS.has(task.status) })

      let settled = settledAll
      if (window) {
        if (Number.isFinite(window.sinceAt)) {
          settled = settled.filter(function (task) {
            const at = Date.parse(task.updated_at || task.settled_at || '')
            // 没有可解析结算时间的任务无法证明它在窗口内，按「不在窗口内」处理：
            // 宁可少数一条，也不让一条来历不明的记录给当下的数字投票。
            return Number.isFinite(at) && at >= window.sinceAt
          })
        }
        if (window.tasks > 0 && settled.length > window.tasks) {
          settled = settled
            .slice()
            .sort(function (a, b) {
              return (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0)
            })
            .slice(0, window.tasks)
        }
      }

      // 「完成数」统计的是窗口内的 done；已结算分母与它同源，否则比值没有意义。
      const done = settled.filter(function (task) { return task.status === 'done' }).length
      const durations = settled.map(function (task) { return num(task.elapsed_ms, 0) }).filter(function (value) { return value > 0 })
      const sum = durations.reduce(function (a, b) { return a + b }, 0)
      // 墙钟跨度只看窗口内这批任务：拿窗口外的任务去撑大跨度，会把「节省」算成负值或 0。
      const starts = settled.map(function (task) { return Date.parse(task.started_at || task.created_at || '') })
        .filter(function (value) { return Number.isFinite(value) })
      const ends = settled.map(function (task) { return Date.parse(task.updated_at || '') })
        .filter(function (value) { return Number.isFinite(value) })
      const span = starts.length && ends.length ? Math.max(0, Math.max.apply(null, ends) - Math.min.apply(null, starts)) : 0
      const saved = span > 0 && sum > span ? sum - span : 0
      return {
        settled: settled.length,
        done: done,
        todayDone: settled.filter(function (task) { return task.status === 'done' && isToday(task.updated_at, now) }).length,
        rate: settled.length ? Math.round((done / settled.length) * 100) : null,
        average: median(durations),
        saved: saved,
        // 把口径带出去，渲染层直接用，不必再猜一次 window 是什么。
        window: window || null,
        windowLabel: windowLabel(window),
      }
    }

    /** 需要处理的排前面：先按急迫度，再按等得最久的靠前。 */
    function sortAttention(tasks) {
      return tasks.slice().sort(function (a, b) {
        const rank = (ATTENTION_RANK[a.status] ?? 9) - (ATTENTION_RANK[b.status] ?? 9)
        if (rank !== 0) return rank
        const at = Date.parse(a.updated_at || a.created_at || '') || 0
        const bt = Date.parse(b.updated_at || b.created_at || '') || 0
        return at - bt
      })
    }

    /** 活跃任务按批次分组：批次在前（按首次出现顺序），散任务在后。 */
    function groupActive(tasks) {
      const groups = new Map()
      const singles = []
      for (const task of tasks) {
        const group = task && typeof task.group === 'string' && task.group ? task.group : ''
        if (!group) { singles.push(task); continue }
        if (!groups.has(group)) groups.set(group, [])
        groups.get(group).push(task)
      }
      return { groups: [...groups.entries()].map(function ([name, members]) { return { name: name, members: members } }), singles: singles }
    }

    /** 一个批次在所有可见任务里的进度（含已结算的，才算得出 3/5）。 */
    function batchProgress(tasks, name) {
      const members = tasks.filter(function (task) { return task && task.group === name })
      const done = members.filter(function (task) { return SETTLED_STATUS.has(task.status) }).length
      return { done: done, total: members.length }
    }

    /**
     * 批次的依赖状态计数（PRD-02 §4.5）：批次头要写「3 个成员 · 1 个等待前置 ·
     * 1 个未执行」。
     *
     * 为什么扫**整份快照**而不是 `activeTasks`：批次成员的依赖信息分布在三种状态里
     * ——等着的（queued + blocked_by）、已经在跑的、被连带取消的（cancelled +
     * cancel_reason）。只扫活跃任务会把「未执行」漏掉，批次头于是永远显示 0 个未执行，
     * 而那正是用户最需要看到的一项。
     */
    function batchDependencyCounts(tasks, name) {
      let total = 0
      let waiting = 0
      let skipped = 0
      for (const task of tasks) {
        if (!task || task.group !== name) continue
        total += 1
        if (task.status === 'queued' && typeof task.blocked_by === 'string' && task.blocked_by) waiting += 1
        else if (task.cancel_reason === 'dependency_failed' || task.cancel_reason === 'dependency_missing') skipped += 1
      }
      return { total: total, waiting: waiting, skipped: skipped }
    }

    /* ───────────────────────── 已退休记录（只读视图） ───────────────────────── */

    /**
     * 退休原因的人话。
     *
     * 宿主给的是机器键（`cap-count` / `cap-days`），界面必须翻成人话：
     * 「它为什么消失的」是这个视图存在的唯一理由，显示一个 `cap-days` 等于没回答。
     * 认不出的键原样显示，宁可露出机器名，也不编一个「未知」把线索抹掉。
     */
    function retiredReasonText(reason) {
      const key = typeof reason === 'string' ? reason : ''
      if (!key) return tr('retired.reason.none')
      const known = { 'cap-count': 'retired.reason.cap-count', 'cap-days': 'retired.reason.cap-days' }
      return known[key] ? tr(known[key]) : key
    }

    /**
     * 复制文本。三条路子依次降级：异步剪贴板 → 老式 execCommand → 直接失败。
     * 失败不静默：退休记录没有子会话可打开，id 是唯一的线索，复制不到就得让人能看见 id 手抄。
     *
     * 剪贴板 Promise 必须**限时**：在没有用户手势授权、非安全上下文、或权限被拒的
     * 宿主里，`clipboard.writeText()` 的 Promise 可能永久 pending（实测 file:// 下
     * 就会挂住），此时 await 等于把「点了没反应」这个缺陷请回来。超时即走兜底。
     */
    const COPY_TIMEOUT_MS = 800

    /** 给可能永远不结算的 Promise 加一道时间闸；超时返回 false 而不是一直等。 */
    function withTimeout(promise, ms) {
      return new Promise(function (resolve) {
        let settled = false
        const timer = setTimeout(function () {
          if (settled) return
          settled = true
          resolve(false)
        }, ms)
        Promise.resolve(promise).then(function (value) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value === true ? true : Boolean(value))
        }, function () {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(false)
        })
      })
    }

    async function copyText(text) {
      const value = String(text == null ? '' : text)
      if (!value) return false
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          // 注意不要直接 await 原 Promise：它在某些宿主里永远不结算。
          if (await withTimeout(navigator.clipboard.writeText(value).then(function () { return true }), COPY_TIMEOUT_MS)) {
            return true
          }
        }
      } catch (error) { /* 权限/非安全上下文：继续走兜底 */ }
      try {
        if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return false
        const holder = document.createElement('textarea')
        holder.value = value
        holder.setAttribute('readonly', '')
        holder.style.position = 'fixed'
        holder.style.top = '-1000px'
        holder.style.opacity = '0'
        document.body.appendChild(holder)
        if (typeof holder.select === 'function') holder.select()
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') === true : false
        if (document.body.removeChild) document.body.removeChild(holder)
        return ok
      } catch (error) {
        return false
      }
    }

    /**
     * 一条退休记录：紧凑单行。
     *
     * 刻意不是 TaskCard：退休记录不可点开、没有操作按钮、也没有耗时/报告那些
     * 只对活跃任务有意义的字段。复用 TaskCard 会让人以为它还能被操作。
     */
    function RetiredRow(props) {
      const record = props.record || {}
      const meta = STATUS_META[record.status] || STATUS_FALLBACK
      const title = typeof record.title === 'string' && record.title ? record.title : tr('noTitle')
      const id = typeof record.task_id === 'string' ? record.task_id : ''
      const tip = [id, tr('retired.notClickable')].filter(Boolean).join('\n')
      return h(
        'div',
        {
          className: 'dsh-sa-row dsh-sa-row-dense dsh-sa-row-retired',
          role: 'listitem',
          'data-status': record.status || 'retired',
          'data-retired': 'true',
          title: tip,
        },
        h(
          'div',
          { className: 'dsh-sa-line' },
          h('span', {
            key: 'dot',
            className: 'dsh-sa-dot',
            style: { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' },
            'aria-hidden': 'true',
          }),
          h('span', { key: 'status', className: 'dsh-sa-state', style: { color: meta.color } }, tr('status.' + record.status)),
          h('span', { key: 'title', className: 'dsh-sa-title', title: tip }, title),
          h('span', { key: 'grow', className: 'dsh-sa-grow' }),
          h(
            'span',
            { key: 'retired-at', className: 'dsh-sa-meta' },
            fill(tr('retired.ago'), { when: formatRelative(record.retired_at, props.now) }),
          ),
          h(
            'span',
            { key: 'reason', className: 'dsh-sa-tag dsh-sa-tag-retired', title: typeof record.retired_reason === 'string' ? record.retired_reason : '' },
            retiredReasonText(record.retired_reason),
          ),
          h(
            'button',
            {
              key: 'copy',
              type: 'button',
              className: 'dsh-sa-btn',
              title: tr('retired.copyHint') + (id ? '：' + id : ''),
              onClick: function (event) {
                if (event && event.stopPropagation) event.stopPropagation()
                props.onCopy(record)
              },
            },
            tr('retired.action'),
          ),
        ),
      )
    }

    /* ───────────────────────── 网络 ───────────────────────── */
    /** 读整块看板；非 2xx 或形状不对都当失败，交给面板显示「暂时取不到」。 */
    async function readBoard(signal) {
      const response = await fetch(API, {
        method: 'GET',
        headers: { accept: 'application/json', ...AUTH_HEADERS },
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      })
      if (!response.ok) {
        const error = new Error(tr('httpError') + ' HTTP ' + response.status)
        error.status = response.status
        throw error
      }
      let data
      try {
        data = await response.json()
      } catch (error) {
        throw new Error(tr('badResponse'))
      }
      if (!data || !Array.isArray(data.tasks)) throw new Error(tr('badResponse'))
      return data
    }

    /**
     * 读已退休任务（只读）。与 readBoard 同一条降级路子：
     * 非 2xx / 形状不对都抛错，由面板显示「暂时取不到」，不让整块面板崩。
     *
     * 形状不对也当失败：如果这里静默返回空数组，「取不到」会显示成「没有被退休的任务」，
     * 那是在用空态掩盖故障 —— 而这个视图存在的意义恰恰是回答「任务去哪了」。
     */
    async function readRetired(signal) {
      const response = await fetch(API + '/retired', {
        method: 'GET',
        headers: { accept: 'application/json', ...AUTH_HEADERS },
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      })
      if (!response.ok) {
        const error = new Error(tr('httpError') + ' HTTP ' + response.status)
        error.status = response.status
        throw error
      }
      let data
      try {
        data = await response.json()
      } catch (error) {
        throw new Error(tr('badResponse'))
      }
      if (!data || !Array.isArray(data.entries)) throw new Error(tr('badResponse'))
      return data
    }

    /**
     * 写操作：POST 一个 JSON 体。Host 的错误体统一是 {ok:false,error:"中文原因"}，
     * 直接把 error 展示出来，不再翻译一遍。
     */
    async function postJson(path, body, signal) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...AUTH_HEADERS },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
        signal,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const reason = payload && typeof payload.error === 'string' && payload.error
          ? payload.error
          : tr('httpError') + ' HTTP ' + response.status
        const failure = new Error(reason)
        failure.status = response.status
        throw failure
      }
      return payload
    }

    /**
     * 读写 `/board/stats`（plans/09 §六.1）时要用的窗口键。
     *
     * 为什么把 `24h` 和 `all` 写成字面量、其余按天拼：Host 侧 `normalizeWindow()`
     * 的合法语法就是 `all` 或 `<n>h` / `<n>d`（见 src/stats.js 的 `WINDOW_RE`）。
     * 前端这里只是**拼查询参数**，不重新定义口径；真正的归一化仍在 Host 做，
     * 所以这里允许拼出 `30d` 这种「将来可能被 Host 夹紧」的值而不本地校验。
     */
    const WINDOW_ALL = 'all'
    /** 顶部窗口 chip 的固定顺序（24h 在前：运营最常看的是「今天」）。 */
    const WINDOW_PRESETS = [
      { id: '24h', labelKey: 'win.24h' },
      { id: '7d', labelKey: 'win.days', labelVars: { days: 7 } },
      { id: '30d', labelKey: 'win.days', labelVars: { days: 30 } },
      { id: WINDOW_ALL, labelKey: 'win.all' },
    ]

    /**
     * 把一个窗口 id 变成人话的「只统计最近 N 天」。
     *
     * plans/07 §九 要求「切换窗口时提示只统计最近 N 天」：数字口径一变而界面不说，
     * 同一个 86% 会在两个窗口之间悄悄漂移，读者却以为自己在看同一件事。
     * `all` 要说清「不再限制时间窗」，`24h` 说「最近 24 小时」——三句话各写各的，
     * 不能合并成一句「当前窗口」。
     */
    function windowScopeNote(windowId) {
      if (windowId === WINDOW_ALL) return tr('win.scopeNoteAll')
      if (windowId === '24h') return tr('win.scopeNote24h')
      const days = windowDaysOf(windowId)
      return days > 0 ? fill(tr('win.scopeNoteDays'), { days: days }) : tr('win.scopeNoteAll')
    }

    /** `7d` → 7；`24h` → 1；`all` → 0（0 表示「不按天」）。 */
    function windowDaysOf(windowId) {
      if (typeof windowId !== 'string') return 0
      const match = /^(\d+)([hd])$/i.exec(windowId.trim())
      if (!match) return 0
      const amount = Number(match[1])
      if (!Number.isFinite(amount) || amount <= 0) return 0
      return match[2].toLowerCase() === 'h' ? amount / 24 : amount
    }

    /** 窗口 chip 上显示的字（24h / 7 天 / 30 天 / 全部）。 */
    function windowChipLabel(preset) {
      return fill(tr(preset.labelKey), preset.labelVars || {})
    }

    /**
     * 拼 `/board/stats` 的查询串。
     *
     * 三个参数**各有各的来源**，不能合并：
     * - `window` 是用户选的（默认来自 memory.window，见 `defaultWindowKey()`）；
     * - `workspaceId` 是派发目标（总览的下拉也用它）；
     * - `hostWorkspaceId` 是实际归属（只有拆解页的「实际归属」口径会传）。
     * 同时给两个工作区参数就是交集，Host 那边也是这么判的（src/stats.js `matchesScope`）。
     */
    function statsQuery(scope) {
      const params = []
      const windowId = scope && typeof scope.window === 'string' && scope.window ? scope.window : ''
      if (windowId) params.push('window=' + encodeURIComponent(windowId))
      if (scope && scope.workspaceId) params.push('workspaceId=' + encodeURIComponent(scope.workspaceId))
      if (scope && scope.hostWorkspaceId) params.push('hostWorkspaceId=' + encodeURIComponent(scope.hostWorkspaceId))
      return params.length ? '?' + params.join('&') : ''
    }

    /**
     * 默认窗口：**沿用宿主下发的 `memory.window`**，不是前端另造一个。
     *
     * plans/09 §三.1 的原话是「默认沿用 memory.window，而不是前端另造一套默认」。
     * 两处各编一个默认值的后果是：同一个筛选条件下，总览与效果的分母不同，
     * 而用户以为自己只是换了个视图。
     *
     * 映射规则只有一条：能对上 24h / 7d / 30d 就用它，否则按天拼 `<n>d`
     * （Host 的 `WINDOW_RE` 接受任意正整数天）；连天数都拿不到才退回 7d，
     * 并且把「宿主没给」这件事留给样本口径行去说（`scope.fallbackFrom` 之外的降级）。
     */
    function defaultWindowKey(memory) {
      const window = pickWindow(memory)
      if (!window) return '7d'
      const days = num(window.days, 0)
      if (days > 0) {
        if (Math.abs(days - 1) < 0.01) return '24h'
        const rounded = Math.round(days)
        return (rounded > 0 ? rounded : 1) + 'd'
      }
      // 只有 since 没有 days：按 since 到现在的实际跨度折算，别装作「窗口未知」。
      const span = Number.isFinite(window.sinceAt) ? Date.now() - window.sinceAt : 0
      if (span > 0) {
        const derived = Math.max(1, Math.round(span / 86400000))
        return derived === 1 ? '24h' : derived + 'd'
      }
      return '7d'
    }

    /**
     * 读全量统计聚合（plans/09 §六.1）。
     *
     * 与 `readBoard` 的降级路子一致：非 2xx / 形状不对都抛错，由面板决定
     * 「统计暂不可用」——**绝不静默返回空结构**，否则 n=0 与 HTTP 404 会被
     * 画成同一个界面（§八.6「不能统一显示 0」）。
     *
     * 形状只校验最小的一条：`coverage` 是对象。`summary` 可能为 null（Host 降级），
     * 那由渲染层单独判——校验失败与「降级成功」是两件事。
     */
    async function readStats(query, signal) {
      const response = await fetch(API + '/stats' + (query || ''), {
        method: 'GET',
        headers: { accept: 'application/json', ...AUTH_HEADERS },
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      })
      if (!response.ok) {
        const error = new Error(tr('httpError') + ' HTTP ' + response.status)
        error.status = response.status
        throw error
      }
      let data
      try {
        data = await response.json()
      } catch (error) {
        throw new Error(tr('badResponse'))
      }
      if (!data || !data.coverage || typeof data.coverage !== 'object') throw new Error(tr('badResponse'))
      return data
    }

    /**
     * 分析看板的筛选条件 → 查询串。
     *
     * 只发**用户真的选过**的维度：`all` 与空值不进 URL，Host 侧 normalize 后的
     * `scope` 才能原样回显（否则「全部」会被记成一个具体筛选，口径行说不清）。
     */
    function analyticsQuery(filters) {
      const params = new URLSearchParams()
      params.set('window', filters.window || '7d')
      if (filters.status && filters.status !== 'all') params.set('status', filters.status)
      if (filters.owner && filters.owner !== 'all') params.set('owner', filters.owner)
      if (filters.workspaceId && filters.workspaceId !== 'all') params.set('workspaceId', filters.workspaceId)
      if (filters.group && filters.group !== 'all') params.set('group', filters.group)
      params.set('overdueHours', String(filters.overdueHours || 24))
      return '?' + params.toString()
    }

    /**
     * 读分析看板聚合。
     *
     * 与 `readStats` 一样不静默造空结构：HTTP 404 / 非法 JSON 抛错，
     * 「Host 明确降级（200 + degraded:true + summary:null）」是**合格响应**，
     * 由渲染层单独显示「聚合失败」，两者不能画成同一个界面。
     */
    async function readAnalytics(query, signal) {
      const response = await fetch(API + '/analytics' + (query || ''), {
        method: 'GET',
        headers: { accept: 'application/json', ...AUTH_HEADERS },
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      })
      if (!response.ok) {
        const error = new Error(tr('httpError') + ' HTTP ' + response.status)
        error.status = response.status
        throw error
      }
      let data
      try { data = await response.json() }
      catch (error) { throw new Error(tr('badResponse')) }
      if (!data || !data.coverage || typeof data.coverage !== 'object'
          || !data.trend || typeof data.trend !== 'object'
          || !data.facets || !Array.isArray(data.facets.statuses)) {
        throw new Error(tr('badResponse'))
      }
      return data
    }

    /**
     * 有效的比率 → 百分比文本；null / 非法值给 em dash。
     *
     * §三.4：`n=0` 显示 `—` 而不是 `0`。Host 已经把分母为 0 的比率算成 null，
     * 这里只负责**不再把 null 变回 0**。
     */
    function percentText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 10 + '%' : tr('stat.none')
    }

    /**
     * 计数文本：`0` 与「没有样本」是两件事（§八.6）。
     *
     * `samples` 为 0 时一律给 em dash：这时候的 0 不是「做了 0 个」，而是
     * 「这个窗口里没有可统计的事实」。
     */
    function countText(value, samples) {
      if (typeof samples === 'number' && Number.isFinite(samples) && samples <= 0) return tr('stat.none')
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : tr('stat.none')
    }

    /** 毫秒 → 可读时长；null / NaN 给 em dash（不显示「0 秒」，那会被读成「瞬间完成」）。 */
    function durationText(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return tr('stat.none')
      if (ms < 1000) return Math.round(ms) + ' ' + tr('unit.ms')
      return formatDuration(ms)
    }

    /** 倍数/比值：保留 2 位；null 给 em dash（单条任务没有倍数可说）。 */
    function factorText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) + '×' : tr('stat.none')
    }

    /**
     * 时间基准的人话。
     *
     * `updatedAt-fallback` 必须在界面上**看得见**（plans/09 §三.4、§八.6）：
     * 回退基准算出来的结算时刻会被后续报告/追问刷新，两个窗口看着同一份账本
     * 却得到不同的「完成时间」。认不出的基准原样显示，不编一个「未知」把线索抹掉。
     */
    function timeBasisText(basis) {
      if (!basis) return ''
      const known = {
        settledAt: 'scope.basis.settledAt',
        'updatedAt-fallback': 'scope.basis.updatedAt-fallback',
        mixed: 'scope.basis.mixed',
        missing: 'scope.basis.missing',
      }
      return known[basis] ? tr(known[basis]) : String(basis)
    }

    /**
     * 一条分组行点击后要写进哪里（plans/09 §五.3 下钻）。
     *
     * 返回 `null` 表示这行没有可筛的键（例如没有 id 的批次）。**不要**用
     * 「名字为空」当判据：批次名可能是空串，但主会话 id 绝不会。
     */
    function drillOf(kind, row) {
      if (!row || typeof row !== 'object') return null
      if (kind === 'workspace') {
        const id = typeof row.workspaceId === 'string' && row.workspaceId ? row.workspaceId : ''
        if (id) return { kind: 'workspaceId', value: id, name: row.title || id }
        const host = typeof row.hostWorkspaceId === 'string' && row.hostWorkspaceId ? row.hostWorkspaceId : ''
        if (host) return { kind: 'hostWorkspaceId', value: host, name: row.title || host }
        return null
      }
      if (kind === 'batch') {
        const name = typeof row.group === 'string' ? row.group : ''
        return name ? { kind: 'group', value: name, name: name } : null
      }
      if (kind === 'parent') {
        const id = typeof row.parentSessionId === 'string' ? row.parentSessionId : ''
        return id ? { kind: 'parentSessionId', value: id, name: id } : null
      }
      if (kind === 'status') {
        const status = typeof row.status === 'string' ? row.status : ''
        return status ? { kind: 'status', value: status, name: tr('status.' + status) } : null
      }
      return null
    }


    /** 快照缓存时长：@ 候选每敲一个字都会问一次，没必要每次拉全量任务。 */
    const SNAPSHOT_CACHE_MS = 10000
    /** 下拉宽度下限（跟模型选择器一档，宽度自适应但不撑满）。 */
    const MENU_MIN_WIDTH = 220
    /** 下拉宽度上限。 */
    const MENU_MAX_WIDTH = 340

    /** 最近一次看板快照（仅用于 @ 候选的短缓存）。 */
    let snapshotCache = { at: 0, data: null }
    /** 工作区 id → 标题，chip 的 codec.serialize 只能拿到 ref，用它还原人能读的名字。 */
    const workspaceTitles = new Map()

    /**
     * 读看板快照（输入框控件与 @ 候选共用）。
     * allowCache=true 时 10 秒内复用上一次结果；控件打开下拉时强制取新的 target。
     */
    async function readSnapshot(signal, allowCache) {
      const startedAt = Date.now()
      if (allowCache && snapshotCache.data && startedAt - snapshotCache.at < SNAPSHOT_CACHE_MS) {
        return snapshotCache.data
      }
      const response = await fetch(API, {
        method: 'GET',
        headers: { accept: 'application/json', ...AUTH_HEADERS },
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      })
      if (!response.ok) throw new Error(tr('httpError') + ' HTTP ' + response.status)
      let data
      try {
        data = await response.json()
      } catch (error) {
        throw new Error(tr('badResponse'))
      }
      if (!data || typeof data !== 'object') throw new Error(tr('badResponse'))
      snapshotCache = { at: startedAt, data }
      return data
    }

    /** 从快照里取某个会话当前的派发目标；没有就返回 null（= 跟随会话目录）。 */
    function pickTarget(data, sessionId) {
      if (!data || !data.targets || typeof data.targets !== 'object') return null
      const entry = data.targets[sessionId]
      if (!entry || typeof entry !== 'object') return null
      const id = typeof entry.workspace_id === 'string' ? entry.workspace_id : ''
      const title = typeof entry.title === 'string' ? entry.title : ''
      if (!id && !title) return null
      return { workspace_id: id, title: title || id, path: typeof entry.path === 'string' ? entry.path : '' }
    }

    /** 从快照里取工作区注册表。 */
    function pickWorkspaces(data) {
      if (!data || !Array.isArray(data.workspaces)) return []
      return data.workspaces.filter(function (item) {
        return item && typeof item === 'object' && typeof item.id === 'string' && item.id
      })
    }

    /** 设置/清除派发目标。workspace 传空串表示清除。 */
    async function setDispatchTarget(sessionId, workspace, signal) {
      const payload = await postJson('/target', {
        session_id: sessionId,
        workspace: workspace === undefined || workspace === null ? '' : String(workspace),
      }, signal)
      const next = payload && payload.target && typeof payload.target === 'object' ? payload.target : null
      return next
    }

    /**
     * 按关键词给工作区打分，用于 @ 菜单里的「自动选择」。
     *
     * 打分只看用户能看见的东西（标题、目录名、路径），不做语义猜测——
     * 猜错比不猜更烦人。返回按分数降序的候选，分数 0 的不要。
     */
    function rankWorkspaces(pool, query) {
      const needle = String(query || '').trim().toLowerCase()
      const words = needle.split(/[\s,，、]+/).filter(Boolean)
      const scored = []
      for (const item of pool) {
        const title = String(item.title || item.id || '')
        const path = String(item.path || '')
        const tail = path.split(/[\\/]/).filter(Boolean).pop() || ''
        const haystack = (title + '\n' + tail + '\n' + path).toLowerCase()
        let score = 0
        // 没有关键词时：全部同分，靠注册表顺序兜底（最近用过的通常在前）。
        if (!words.length) score = 1
        else {
          for (const word of words) {
            if (title.toLowerCase() === word) score += 100          // 标题完全相等
            else if (title.toLowerCase().includes(word)) score += 40 // 标题包含
            else if (tail.toLowerCase() === word) score += 30        // 目录名相等
            else if (tail.toLowerCase().includes(word)) score += 15  // 目录名包含
            else if (haystack.includes(word)) score += 5             // 路径里沾边
          }
        }
        if (score > 0) scored.push({ item, score, title })
      }
      scored.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score
        return a.title.localeCompare(b.title)
      })
      return scored
    }

    /** 目标变更广播：@ 选中之后，输入框里的控件也要跟着刷新，不能两个入口各说各话。 */
    const targetBus = {
      listeners: new Set(),
      emit() {
        for (const listener of this.listeners) {
          try { listener() } catch (error) { /* 单个监听器出错不影响其它 */ }
        }
      },
    }

    /* ───────────────────────── 样式 ───────────────────────── */

    /** 只在本面板挂载期间存在的样式；所有选择器都在 .dsh-sa 前缀下。 */
    const STYLE = `
.dsh-sa {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  font-size: var(--dsw-font-s-13, 13px);
  color: var(--dsw-alias-label-primary, inherit);
  background: transparent;
}
.dsh-sa-head {
  flex: none;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
}
.dsh-sa-metrics {
  display: flex;
  align-items: baseline;
  gap: 16px;
  flex-wrap: wrap;
}
.dsh-sa-metric {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
}
.dsh-sa-metric-label {
  color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9));
  font-size: var(--dsw-font-xxs-12, 12px);
}
.dsh-sa-metric-value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.dsh-sa-danger {
  color: var(--dsw-alias-state-error-primary, #dc2626);
  font-size: var(--dsw-font-xxs-12, 12px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dsh-sa-grow { flex: 1 1 auto; min-width: 0; }
.dsh-sa-chips {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.dsh-sa-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: var(--dsw-font-xxs-12, 12px);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.dsh-sa-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1));
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-sa-chip[aria-pressed="true"] {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  color: var(--dsw-alias-brand-primary, #4d6bfe);
  background: var(--dsw-alias-accent-soft, rgba(77,107,254,.12));
}
.dsh-sa-chip-count {
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.85));
  font-variant-numeric: tabular-nums;
}
.dsh-sa-chip[aria-pressed="true"] .dsh-sa-chip-count { color: inherit; opacity: .8; }
.dsh-sa-strip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  font-size: var(--dsw-font-xxs-12, 12px);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
}
.dsh-sa-strip-warn {
  color: var(--dsw-alias-state-warn-primary, #b45309);
  background: var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,.08));
}
.dsh-sa-strip-error {
  color: var(--dsw-alias-state-error-primary, #dc2626);
  background: rgba(220,38,38,.08);
}
.dsh-sa-strip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sa-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.dsh-sa-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
}
.dsh-sa-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.07)); }
.dsh-sa-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-sa-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.dsh-sa-dot-pulse { animation: dsh-sa-pulse 1.6s ease-in-out infinite; }
.dsh-sa-state {
  flex: none;
  font-size: var(--dsw-font-xxxs-11, 11px);
  font-weight: 600;
  letter-spacing: .02em;
}
.dsh-sa-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.dsh-sa-tag {
  flex: none;
  height: 16px;
  line-height: 16px;
  padding: 0 5px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: var(--dsw-font-xxxs-11, 11px);
}
.dsh-sa-meta {
  flex: none;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-size: var(--dsw-font-xxs-12, 12px);
  font-variant-numeric: tabular-nums;
}
.dsh-sa-elapsed { min-width: 62px; text-align: right; }
.dsh-sa-sub {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding-left: 15px;
  font-size: var(--dsw-font-xxs-12, 12px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-id {
  flex: none;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.8));
}
.dsh-sa-report {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsh-sa-errorline {
  min-width: 0;
  padding-left: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dsw-font-xxs-12, 12px);
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dsh-sa-btn {
  flex: none;
  height: 24px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: var(--dsw-font-xxs-12, 12px);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.dsh-sa-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1));
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-sa-btn:disabled { opacity: .55; cursor: default; }
.dsh-sa-btn-danger { color: var(--dsw-alias-state-error-primary, #dc2626); }
.dsh-sa-btn-danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(220,38,38,.12));
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dsh-sa-btn-primary { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-sa-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-accent, rgba(77,107,254,.12));
  color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.dsh-sa-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.dsh-sa-select {
  height: 26px;
  max-width: 240px;
  padding: 0 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: var(--dsw-font-xxs-12, 12px);
}
.dsh-sa-select:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
}
.dsh-sa-row-clickable { cursor: pointer; }
/* 归档行不可点：不给「能点」的悬停底色，也不吃键盘焦点（无 tabIndex）。 */
.dsh-sa-row-archived { opacity: .55; cursor: default; }
.dsh-sa-row-archived:hover { background: transparent; }
.dsh-sa-row:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: -2px;
}
.dsh-sa-workspace {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsh-sa-tag-group,
.dsh-sa-tag-archived {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
/* 后台收尾 / 待读：两个「状态之外还在发生的事」，用强调色但不抢状态点的注意力。 */
.dsh-sa-tag-bg {
  background: var(--dsw-alias-state-warn-surface, rgba(180,83,9,.12));
  color: var(--dsw-alias-state-warn-primary, #b45309);
}
.dsh-sa-tag-unread {
  background: var(--dsw-alias-state-info-surface, rgba(37,99,235,.12));
  color: var(--dsw-alias-state-info-primary, #2563eb);
}
/*
 * 「重试 N 次」（A6）：瞬时故障正在自动续跑。
 * 用警示色但它**不是错误**（任务还在 running，也还没放弃），所以不上红；
 * 与「后台收尾」同色系，但靠文字区分，不靠颜色独立表意。
 */
.dsh-sa-tag-retry {
  background: var(--dsw-alias-state-warn-surface, rgba(180,83,9,.12));
  color: var(--dsw-alias-state-warn-primary, #b45309);
}
/*
 * 「未读未知」：既不是「待读」（那是在等它读），也不是「已读」。
 * 用中性灰而不是信息蓝，因为这不是「正在发生的事」，而是「这件事失去观测」。
 */
.dsh-sa-tag-unknown {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-secondary, inherit);
  border: 1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.35));
}
/*
 * 「已冻结」：只读、续跑会失败。用警示色但不像错误那样刺眼——
 * 冻结是**正常生命周期**的一环（归档巡检的效果），不是故障。
 */
.dsh-sa-tag-frozen {
  background: var(--dsw-alias-state-warn-surface, rgba(180,83,9,.12));
  color: var(--dsw-alias-state-warn-primary, #b45309);
}
/*
 * 「计划已更新」：与「2/5」并排的一次性提示，所以比计划标签**弱一档**——
 * 它说的是「你刚才看到的数字变了」，不是一个新的状态。用信息蓝保持与计划标签
 * 同一色系（同一件事），但只加虚线边框，不加重底色：亮 2 秒就走，不该抢过步骤数。
 */
.dsh-sa-tag-plan-updated {
  background: var(--dsw-alias-state-info-surface, rgba(37,99,235,.08));
  color: var(--dsw-alias-state-info-primary, #2563eb);
  border: 1px dashed var(--dsw-alias-state-info-primary, #2563eb);
}
/*
 * 依赖标签（PRD-02 §4.5）：
 * - 「依赖 N」/「等 A」用信息蓝：等前置是**正常运行状态**，不是问题；
 * - 「前置失败」用警示色：那是这条任务不会再跑了的终局原因，需要人处理前置。
 * 颜色不是唯一通道——三种标签的文字本身已经把状态说清（§八.8）。
 */
.dsh-sa-tag-dep {
  background: var(--dsw-alias-state-info-surface, rgba(37,99,235,.12));
  color: var(--dsw-alias-state-info-primary, #2563eb);
}
.dsh-sa-tag-dep-failed {
  background: var(--dsw-alias-state-warn-surface, rgba(180,83,9,.12));
  color: var(--dsw-alias-state-warn-primary, #b45309);
}
/* ── 面板改版：效果数字、并发条、分节、批次、原因行 ── */
.dsh-sa-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 26px;
  padding: 10px 0 4px;
}
.dsh-sa-stat { display: flex; flex-direction: column; gap: 1px; min-width: 54px; }
.dsh-sa-stat-value {
  font-size: var(--dsw-font-md-17, 17px);
  font-weight: 500;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}
.dsh-sa-stat-label {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-conc { display: flex; flex-direction: column; gap: 5px; padding: 6px 0 2px; }
.dsh-sa-conc-meta {
  display: flex;
  gap: 14px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-warn { color: var(--dsw-alias-state-warn-primary, #b45309); }
.dsh-sa-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16));
  overflow: hidden;
}
.dsh-sa-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--dsw-alias-state-business-primary, #3b82f6);
  transition: width .3s ease;
}
.dsh-sa-bar-slow { background: var(--dsw-alias-state-warn-primary, #d97706); }
.dsh-sa-progress { margin: 2px 0 0 15px; }
.dsh-sa-sections { display: flex; flex-direction: column; gap: 16px; padding-bottom: 8px; }
.dsh-sa-sec { padding-top: 12px; }
.dsh-sa-sec-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; padding: 0 16px; }
.dsh-sa-sec-title { font-size: var(--dsw-font-sm-13, 13px); font-weight: 500; }
.dsh-sa-sec-count {
  min-width: 18px;
  padding: 0 5px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: var(--dsw-font-xxxs-11, 11px);
  font-variant-numeric: tabular-nums;
}
.dsh-sa-sec-hint {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-batch { display: flex; align-items: center; gap: 8px; margin: 10px 0 2px; padding: 0 16px; }
.dsh-sa-batch-name {
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-batch-count {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-secondary, inherit);
  font-variant-numeric: tabular-nums;
}
.dsh-sa-batch-bar { flex: 0 1 160px; }
.dsh-sa-subhead {
  margin: 12px 0 2px;
  padding: 0 16px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-reason {
  display: flex;
  gap: 6px;
  align-items: baseline;
  min-width: 0;
  font-size: var(--dsw-font-xs-12, 12px);
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dsh-sa-reason-label { flex: none; opacity: .78; }
.dsh-sa-reason-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sa-row-dense { padding: 7px 16px; gap: 2px; }
.dsh-sa-row-attention { box-shadow: inset 2px 0 0 var(--dsw-alias-state-error-primary, #dc2626); }
.dsh-sa-dense-meta {
  flex: none;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-btn-confirm { color: var(--dsw-alias-state-warn-primary, #b45309); }
/*
 * 续派的输入行（plans/08 阶段 1）。
 *
 * 为什么它长在**行下面**而不是弹一个对话框：续派是「在已有任务上补一句」，
 * 用户的判断依据就是这条任务本身（标题、状态、上一轮摘要）——把行藏到弹窗后面，
 * 等于让人凭记忆写要求。放在行内，上下文一直在视野里。
 *
 * 高度固定 26px 与按钮对齐；flex: 1 让它吃掉整行的宽度，短句一行写完。
 */
.dsh-sa-continue {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 16px 7px;
  flex-wrap: wrap;
}
.dsh-sa-continue-input {
  flex: 1 1 180px;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06));
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: var(--dsw-font-xxs-12, 12px);
}
.dsh-sa-continue-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
}
.dsh-sa-continue-hint {
  flex: 1 1 100%;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
/* 窗口口径：贴着效果数字右侧，弱化为说明文字，不抢数字的注意力。 */
.dsh-sa-stat-window {
  align-self: flex-end;
  padding-bottom: 2px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 窗口未知：用警示色标出来，因为此时的数字口径与 0.8.x 一样不可比。 */
.dsh-sa-stat-window-unknown { color: var(--dsw-alias-state-warn-primary, #b45309); }
/* 退休视图：已完成的历史，比已归档更弱一档（归档还能点开，退休连子会话都没有）。 */
.dsh-sa-row-retired { opacity: .7; }
.dsh-sa-tag-retired {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-strip-info {
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));
}
.dsh-sa-blank {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 56px 24px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-size: var(--dsw-font-s-13, 13px);
}
.dsh-sa-blank-title { color: var(--dsw-alias-label-secondary, inherit); font-weight: 600; }
.dsh-sa-blank code {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsh-sa-btn:focus-visible,
.dsh-sa-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
}
/*
 * ── plans/09 P1：视图切换 / 窗口选择 / 样本口径 / 效果卡 / 拆解表 / 趋势 ──
 *
 * 全部样式都挂在 .dsh-sa 前缀下、随面板 <style> 一起卸载（本文件顶部的约定）。
 * 这里**不用任何图表库**（plans/09 §九）：趋势与分布都是 div 条形 + 表格，
 * 颜色之外一律有文字，读屏与复制都不依赖像素。
 */
.dsh-sa-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.dsh-sa-tab {
  height: 26px;
  padding: 0 12px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: var(--dsw-font-xxs-12, 12px);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.dsh-sa-tab:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1));
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-sa-tab[aria-selected="true"] {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  color: var(--dsw-alias-brand-primary, #4d6bfe);
  background: var(--dsw-alias-accent-soft, rgba(77,107,254,.12));
  font-weight: 600;
}
.dsh-sa-tab:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
}
.dsh-sa-win {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.dsh-sa-win-label {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
/*
 * 窗口提示条：切窗口时必须说清「只统计最近 N 天」（plans/07 §九）。
 * 用 info 语气而不是警告：窗口变窄本身不是错误，但它改变分母，必须显眼。
 */
.dsh-sa-scopenote {
  flex: none;
  padding: 6px 16px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
}
/* 样本口径行：固定出现在效果与拆解视图顶部，n=0/样本少/时间回退都在这一行里说。 */
.dsh-sa-scope {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-variant-numeric: tabular-nums;
}
.dsh-sa-scope-title { font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
.dsh-sa-scope-warn { color: var(--dsw-alias-state-warn-primary, #b45309); }
.dsh-sa-scope-low {
  padding: 0 5px;
  border-radius: 7px;
  background: var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,.12));
  color: var(--dsw-alias-state-warn-primary, #b45309);
}
.dsh-sa-view { display: flex; flex-direction: column; gap: 2px; padding-bottom: 16px; }
.dsh-sa-cardgroup { padding-top: 10px; }
.dsh-sa-cardgroup-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 16px 6px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-cardgroup-title { font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
/*
 * 卡片行用 grid 的 auto-fit 而不是 flex-wrap。
 *
 * flex 的问题是「最后一行只剩一张卡时它会撑满整行」（4 张卡 → 3+1，那张卡宽得像
 * 一个区块标题）；auto-fit 让每行等宽、列数随容器走，小屏自动折成 2 列 / 1 列。
 * 卡片数量按组不同（结果 6、速度 3、稳定 5、并行 4），所以列数不能写死。
 *
 * minmax 下限定在 168px：这是让「结果」的 6 张卡在常规面板宽度下排成 3×2 的
 * 临界值——4 列时第一行 4 张、第二行 2 张会在右侧留一个空洞，看起来像少画了卡。
 */
.dsh-sa-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: 8px;
  padding: 0 16px;
}
.dsh-sa-card {
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.05));
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dsh-sa-card-label {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-card-value {
  font-size: var(--dsw-font-s-13, 13px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-sa-card-sub {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-variant-numeric: tabular-nums;
}
.dsh-sa-card-fail .dsh-sa-card-value { color: var(--dsw-alias-state-error-primary, #dc2626); }
.dsh-sa-card-warn .dsh-sa-card-value { color: var(--dsw-alias-state-warn-primary, #b45309); }
.dsh-sa-card-ok .dsh-sa-card-value { color: var(--dsw-alias-state-success-primary, #16a34a); }
/* 分布与趋势的横向条形：宽度是百分比，但同一行永远有文字，颜色不是唯一通道。 */
.dsh-sa-rows { display: flex; flex-direction: column; }
.dsh-sa-dist {
  display: grid;
  grid-template-columns: minmax(88px, 168px) 1fr auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 16px;
  border: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.1));
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--dsw-font-xxs-12, 12px);
  text-align: left;
  cursor: pointer;
}
.dsh-sa-dist:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.07)); }
.dsh-sa-dist:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: -2px;
}
.dsh-sa-dist-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sa-dist-track {
  height: 8px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
  overflow: hidden;
}
.dsh-sa-dist-fill { height: 100%; border-radius: 4px; background: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-sa-dist-fill-ok { background: var(--dsw-alias-state-success-primary, #16a34a); }
.dsh-sa-dist-fill-warn { background: var(--dsw-alias-state-warn-primary, #d97706); }
.dsh-sa-dist-fill-fail { background: var(--dsw-alias-state-error-primary, #dc2626); }
.dsh-sa-dist-value {
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, inherit);
  white-space: nowrap;
}
/* 拆解三表：小屏可折行（overflow-x 而不是硬裁），表头写明口径。 */
.dsh-sa-tablewrap { padding: 0 16px; overflow-x: auto; }
.dsh-sa-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--dsw-font-xxs-12, 12px);
  font-variant-numeric: tabular-nums;
}
.dsh-sa-table th,
.dsh-sa-table td {
  padding: 5px 8px;
  text-align: right;
  white-space: nowrap;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12));
}
.dsh-sa-table th {
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-size: var(--dsw-font-xxxs-11, 11px);
}
.dsh-sa-table th:first-child,
.dsh-sa-table td:first-child { text-align: left; white-space: normal; }
.dsh-sa-table tbody tr[data-drill] { cursor: pointer; }
.dsh-sa-table tbody tr[data-drill]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.07)); }
.dsh-sa-table tbody tr[data-drill]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: -2px;
}
.dsh-sa-table-name { overflow-wrap: anywhere; }
.dsh-sa-dim {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 16px 8px;
  flex-wrap: wrap;
}
.dsh-sa-dim-note {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
/* 下钻提示：筛选一旦生效必须一直可见，否则「这个数字为什么是 3」无处可查。 */
.dsh-sa-drill {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
  font-size: var(--dsw-font-xxs-12, 12px);
}
.dsh-sa-drill-label {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-accent-soft, rgba(77,107,254,.12));
  color: var(--dsw-alias-brand-primary, #4d6bfe);
}
/*
 * 趋势行：日期 / 条形 / 文字三段。
 *
 * 文字列必须能折行（white-space: normal）：这一行的文字就是「不靠颜色也能读数」
 * 的全部证据（plans/09 §五.2、§八.8），把它 ellipsis 掉等于只剩颜色在说话。
 * 之前写成 nowrap 时，长语言的读数（英文的 failed·blocked·interrupted）
 * 会被裁掉半截——那正是「图表有表格等价物」要避免的失真。
 */
.dsh-sa-trend {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 16px;
}
.dsh-sa-trend-row {
  display: grid;
  grid-template-columns: 84px minmax(64px, 1fr) minmax(0, 1.4fr);
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: var(--dsw-font-xxxs-11, 11px);
  font-variant-numeric: tabular-nums;
}
.dsh-sa-trend-day { color: var(--dsw-alias-label-secondary, inherit); white-space: nowrap; }
.dsh-sa-trend-bars { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-sa-trend-track {
  height: 5px;
  border-radius: 3px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
  overflow: hidden;
}
.dsh-sa-trend-fill { height: 100%; border-radius: 3px; }
.dsh-sa-trend-fill-done { background: var(--dsw-alias-state-success-primary, #16a34a); }
.dsh-sa-trend-fill-created { background: var(--dsw-alias-state-business-primary, #3b82f6); }
.dsh-sa-trend-fill-problems { background: var(--dsw-alias-state-error-primary, #dc2626); }
.dsh-sa-trend-text {
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.45;
}
.dsh-sa-toggle { display: inline-flex; gap: 4px; }

/*
 * ── plans/09 P2：历史视图 + 任务详情抽屉 ──
 *
 * 这里全部是「表格 + 抽屉」，没有任何图表库（§九）。两个刻意的取舍：
 * 1. 历史表第一列可以折行（white-space: normal）：标题 + 徽标 + task_id 挤在
 *    一个 nowrap 单元格里，中文标题会被裁成半截——那正是「可读」要避免的；
 * 2. 抽屉是**文档流里的一块**而不是 fixed 遮罩：面板本身在宿主的槽里滚动，
 *    fixed 定位会跑到视口外，也会盖住别家 DOM（本文件顶部的约定：不碰别家 DOM）。
 */
.dsh-sa-histbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
}
.dsh-sa-hist-field {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-hist-field-label { flex: none; }
.dsh-sa-hist-search { flex: 1 1 200px; min-width: 160px; }
.dsh-sa-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: var(--dsw-font-xxs-12, 12px);
}
.dsh-sa-input:focus-visible,
.dsh-sa-select:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
}
/* 历史表第一列（任务）允许折行，其余列保持 nowrap 的数字对齐。 */
.dsh-sa-hist-table { table-layout: auto; }
.dsh-sa-hist-table th:first-child,
.dsh-sa-hist-table td:first-child { white-space: normal; min-width: 150px; }
/*
 * 真机预览里这张表一度被裁掉最后一列：tablewrap 的 overflow-x 能滚，但**看不见的
 * 滚动**等于「这列不存在」（用户不会去猜右边还有东西）。所以窄列显式压窄，
 * 工作区列给一个上限并 ellipsis——它是最长又最不精确的那一列。
 */
.dsh-sa-hist-table th,
.dsh-sa-hist-table td { padding: 5px 6px; }
.dsh-sa-hist-ws { max-width: 96px; overflow: hidden; text-overflow: ellipsis; }
.dsh-sa-hist-status { white-space: nowrap; }
.dsh-sa-hist-end { white-space: nowrap; }
.dsh-sa-hist-tagkind {
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-size: var(--dsw-font-xxxs-11, 11px);
}
.dsh-sa-hist-title {
  display: block;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
  overflow-wrap: anywhere;
}
.dsh-sa-hist-row { cursor: pointer; }
.dsh-sa-hist-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.07)); }
.dsh-sa-hist-row:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: -2px;
}
/* 冻结行（归档 / 退休）：降透明度但仍可点开抽屉——抽屉是它们唯一的去处。 */
.dsh-sa-hist-row-frozen { opacity: .78; }
.dsh-sa-hist-row[data-selected="true"] {
  background: var(--dsw-alias-accent-soft, rgba(77,107,254,.12));
}
.dsh-sa-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
}
/* 抽屉：文档流里的一块，宽度随面板收窄。 */
.dsh-sa-drawer {
  margin: 10px 16px 16px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  overflow: hidden;
}
.dsh-sa-drawer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));
}
.dsh-sa-drawer-title { font-weight: 600; font-size: var(--dsw-font-xxs-12, 12px); }
.dsh-sa-drawer-title2 {
  padding: 0 0 6px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.dsh-sa-drawer-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px 12px;
}
.dsh-sa-drawer-block { padding-bottom: 8px; }
.dsh-sa-drawer-block-title {
  padding-bottom: 4px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsh-sa-kv {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 6px;
  padding: 2px 0;
  font-size: var(--dsw-font-xxs-12, 12px);
}
.dsh-sa-kv-label {
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  overflow-wrap: anywhere;
}
.dsh-sa-kv-value {
  color: var(--dsw-alias-label-primary, inherit);
  overflow-wrap: anywhere;
}
/* 生命周期六步：横排、可折行；缺的一步写「没有记录」并降透明度。 */
.dsh-sa-steps {
  display: flex;
  align-items: stretch;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  padding: 0 0 4px;
  list-style: none;
}
.dsh-sa-step {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 84px;
  padding: 5px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));
}
.dsh-sa-step-missing { opacity: .55; }
.dsh-sa-step-label {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-step-value { font-variant-numeric: tabular-nums; }
.dsh-sa-drawer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
}
@media (max-width: 640px) {
  .dsh-sa-kv { grid-template-columns: 1fr; gap: 1px; }
}
@media (max-width: 640px) {
  .dsh-sa-dist { grid-template-columns: 1fr; }
  .dsh-sa-trend-row { grid-template-columns: 1fr; gap: 2px; }
  .dsh-sa-cards { grid-template-columns: 1fr; }
}
@keyframes dsh-sa-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .4; transform: scale(.78); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-sa-dot-pulse { animation: none; }
}

/*
 * ── 分析数据看板（与派发工作台平级，二选一切换） ──
 *
 * 三条约束：
 * 1. 复用 .dsh-sa-card / .dsh-sa-dist / .dsh-sa-trend-* / .dsh-sa-table 等既有组件样式，
 *    新看板与派发工作台「看起来是同一个产品」，不另起一套配色与圆角；
 * 2. 所有新选择器仍挂在 .dsh-sa 前缀语义下，随面板 <style> 一起卸载；
 * 3. 折行按**容器宽度**而不是视口决定：侧边栏再窄也不会把内容挤成横向滚动。
 */
.dsh-sa-surfacebar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px 0;
}
.dsh-sa-surface-label {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-surface-tabs { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.dsh-sa-an {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
}
/* KPI 固定 2×2 / 4×1：min 230px 让 600px 宽的侧边栏排两列，不会 3+1 留空洞。 */
.dsh-sa-an-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 8px;
  padding: 0 16px;
}
.dsh-sa-an-kvs { padding: 0 16px 8px; }
.dsh-sa-an-bar {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 16px 8px;
}
.dsh-sa-an-title { font-size: var(--dsw-font-s-13, 13px); font-weight: 600; }
.dsh-sa-an-sub {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-variant-numeric: tabular-nums;
}
.dsh-sa-an-filters {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
}
.dsh-sa-an-field {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-an-field-label { flex: none; }
.dsh-sa-an-field .dsh-sa-select { max-width: 180px; }
.dsh-sa-an-field .dsh-sa-input { width: 64px; flex: none; }
/* 动作按钮永远靠右；窄容器里退回左对齐，不与筛选项抢同一行。 */
.dsh-sa-an-actions { display: inline-flex; gap: 6px; margin-left: auto; }
.dsh-sa-an-scope {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 6px 10px;
  flex-wrap: wrap;
  padding: 7px 16px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06));
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
  font-variant-numeric: tabular-nums;
}
.dsh-sa-an-scope-title { font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
.dsh-sa-an-scope-proxy {
  flex: 1 1 100%;
  color: var(--dsw-alias-state-warn-primary, #b45309);
  line-height: 1.5;
}
.dsh-sa-an-warn { color: var(--dsw-alias-state-warn-primary, #b45309); }
.dsh-sa-an-section { padding: 10px 0 4px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
.dsh-sa-an-section:first-child { border-top: 0; }
.dsh-sa-an-section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 16px 8px;
}
.dsh-sa-an-section-title { font-size: var(--dsw-font-xxs-12, 12px); font-weight: 600; }
.dsh-sa-an-section-hint {
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  overflow-wrap: anywhere;
}
.dsh-sa-an-big { font-size: 17px; line-height: 1.3; }
.dsh-sa-an-low {
  padding: 0 5px;
  border-radius: 7px;
  background: var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,.12));
  color: var(--dsw-alias-state-warn-primary, #b45309);
}
.dsh-sa-an-dist[aria-pressed="true"] { background: var(--dsw-alias-accent-soft, rgba(77,107,254,.1)); }
.dsh-sa-an-compare {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 2px 16px 8px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-secondary, inherit);
  font-variant-numeric: tabular-nums;
}
.dsh-sa-an-delta {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
}
.dsh-sa-an-delta-up { color: var(--dsw-alias-state-success-primary, #16a34a); }
.dsh-sa-an-delta-down { color: var(--dsw-alias-state-warn-primary, #b45309); }
/*
 * 连续空天合成一行：8 天里 6 天全 0 时，逐日画 6 条空条只会让趋势区看起来
 * 像坏了。图表是概览（合并空天），表格仍逐日给全，两者等价性由文字说明。
 */
.dsh-sa-an .dsh-sa-trend-quiet {
  grid-template-columns: 112px minmax(0, 1fr);
  padding: 2px 0;
  opacity: .6;
}
.dsh-sa-an .dsh-sa-trend-quiet .dsh-sa-trend-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 口径表样式随区块一起删掉：界面上已经没有那张给维护者看的表。 */
.dsh-sa-an-foot {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 16px 16px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-variant-numeric: tabular-nums;
}
@media (max-width: 640px) {
  .dsh-sa-an-field { flex: 1 1 100%; }
  .dsh-sa-an-field .dsh-sa-select { max-width: none; flex: 1 1 auto; }
  .dsh-sa-an-bar, .dsh-sa-an-filters, .dsh-sa-an-scope, .dsh-sa-an-foot { padding-left: 12px; padding-right: 12px; }
}
/*
 * 侧边栏面板窄 ≠ 视口窄：@media 在「宽显示器 + 400px 侧栏」下不会触发。
 * 用容器查询按**面板自身宽度**折行，才是这次「适配不同屏幕尺寸」真正生效的那条规则。
 */
@container (max-width: 520px) {
  .dsh-sa-an-field { flex: 1 1 100%; }
  .dsh-sa-an-field .dsh-sa-select { max-width: none; flex: 1 1 auto; }
  .dsh-sa-an-actions { margin-left: 0; }
  .dsh-sa-an-cards { grid-template-columns: 1fr; }
  .dsh-sa-an-cards, .dsh-sa-an-kvs, .dsh-sa-an-compare, .dsh-sa-an-foot { padding-left: 12px; padding-right: 12px; }
  /* 状态行在窄容器里仍保持一行：名称 / 条 / 数值三段收紧，不拆成三行。 */
  .dsh-sa-an .dsh-sa-dist { grid-template-columns: 72px minmax(48px, 1fr) auto; gap: 6px; padding: 5px 12px; }
  .dsh-sa-an .dsh-sa-trend { padding: 0 12px; }
  .dsh-sa-an .dsh-sa-trend-row { grid-template-columns: 1fr; gap: 2px; }
  .dsh-sa-an-bar, .dsh-sa-an-filters, .dsh-sa-an-scope { padding-left: 12px; padding-right: 12px; }
}
`

    /* ───────────────── 输入框「派发目标」控件 ───────────────── */

    /** 只在这个控件挂载期间存在的样式。 */
    const PICKER_STYLE = `
.dsh-sa-target {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 28px;
  max-width: min(260px, 45cqw);
  padding: 0 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: var(--dsw-font-xxs-12, 12px);
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.dsh-sa-target:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1));
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-sa-target:disabled { opacity: .6; cursor: default; }
.dsh-sa-target[aria-expanded="true"] {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-sa-target:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 1px;
}
.dsh-sa-target-icon {
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-target[data-targeted="true"] .dsh-sa-target-icon { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-sa-target-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-sa-target-caret {
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-menu {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  max-height: min(60vh, 420px);
  overflow: auto;
  padding: 6px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: var(--dsw-shadow-lv2, 0 10px 30px rgba(0,0,0,.18));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: var(--dsw-font-xxs-12, 12px);
}
.dsh-sa-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-sa-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.dsh-sa-menu-item:disabled { opacity: .55; cursor: default; }
.dsh-sa-menu-item:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: -2px;
}
.dsh-sa-menu-item[aria-checked="true"] { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-sa-menu-check {
  flex: none;
  width: 14px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-menu-item[aria-checked="true"] .dsh-sa-menu-check { color: inherit; }
.dsh-sa-menu-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-sa-menu-path {
  margin-left: auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
  font-size: var(--dsw-font-xxxs-11, 11px);
}
.dsh-sa-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--dsw-alias-border-l1, rgba(127,127,127,.22));
}
.dsh-sa-menu-note {
  padding: 6px 8px;
  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9));
}
.dsh-sa-menu-error {
  padding: 6px 8px;
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
`

    /** 触发器左侧的圆点：有目标实心，跟随会话时空心。 */
    function TargetDot(props) {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 12 12',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { flex: 'none', display: 'block' },
        },
        h('circle', {
          cx: 6,
          cy: 6,
          r: 3.4,
          fill: props.on ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          opacity: props.on ? 1 : 0.7,
        }),
      )
    }

    /** 下拉指示箭头。 */
    function TargetCaret() {
      return h(
        'svg',
        {
          width: 10,
          height: 10,
          viewBox: '0 0 12 12',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { flex: 'none', display: 'block', opacity: 0.7 },
        },
        h('path', { d: 'M2.5 4.5 6 8l3.5-3.5' }),
      )
    }

    /** 下拉里的一行。 */
    function TargetRow(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': props.checked === true,
          className: 'dsh-sa-menu-item',
          disabled: props.disabled === true,
          title: props.description ? props.label + '\n' + props.description : props.label,
          onClick: props.onPick,
        },
        h('span', { className: 'dsh-sa-menu-check', 'aria-hidden': 'true' }, props.checked ? '✓' : (props.icon || '')),
        h('span', { className: 'dsh-sa-menu-label' }, props.label),
        props.description ? h('span', { className: 'dsh-sa-menu-path' }, props.description) : null,
      )
    }

    /**
     * 「这次派发到哪个工作区」控件（conversation.input.left）。
     *
     * 语义提醒：它改的是派发目标，不是会话归属 —— DSH 里会话的工作区建完不可迁移，
     * 所以这个控件永远只影响下一次 dispatch_launch。
     *
     * 数据：挂载时取一次快照（拿当前 target 与 workspaces），每次打开下拉再取一次；
     * 不做轮询。取不到时控件禁用并显示「派发 → 跟随会话」。
     */
    function TargetPicker(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const portalReady = typeof createPortal === 'function'
      const [status, setStatus] = useState('loading')
      const [target, setTarget] = useState(null)
      const [workspaces, setWorkspaces] = useState([])
      const [open, setOpen] = useState(false)
      const [menuError, setMenuError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const [reloadKey, setReloadKey] = useState(0)

      const triggerRef = useRef(null)
      const menuRef = useRef(null)
      const inflight = useRef(null)
      if (inflight.current === null) inflight.current = new Set()

      /* 取当前目标与工作区；reloadKey 由打开下拉、刷新、@ 选中（targetBus）推进。 */
      useEffect(function () {
        if (!sessionId) return undefined
        let disposed = false
        const controller = new AbortController()
        inflight.current.add(controller)
        readSnapshot(controller.signal, false).then(function (data) {
          if (disposed || controller.signal.aborted) return
          setWorkspaces(pickWorkspaces(data))
          setTarget(pickTarget(data, sessionId))
          setStatus('ready')
        }).catch(function (error) {
          if (disposed || controller.signal.aborted || (error && error.name === 'AbortError')) return
          setStatus('error')
        }).finally(function () {
          inflight.current.delete(controller)
        })
        const bump = function () {
          if (!disposed) setReloadKey(function (value) { return value + 1 })
        }
        targetBus.listeners.add(bump)
        return function () {
          disposed = true
          controller.abort()
          targetBus.listeners.delete(bump)
        }
      }, [sessionId, reloadKey])

      /* 下拉的 document 监听：点外面关、Esc 关并回到触发器。 */
      useEffect(function () {
        if (!open) return undefined
        function onPointerDown(event) {
          const trigger = triggerRef.current
          const menu = menuRef.current
          const node = event.target
          if (trigger && trigger.contains(node)) return
          if (menu && menu.contains(node)) return
          setOpen(false)
        }
        function onKeyDown(event) {
          if (event.key !== 'Escape') return
          setOpen(false)
          const trigger = triggerRef.current
          if (trigger && typeof trigger.focus === 'function') trigger.focus()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        const cleanup = function () {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
        activePickerCleanup = cleanup
        return function () {
          cleanup()
          if (activePickerCleanup === cleanup) activePickerCleanup = null
        }
      }, [open])

      /* 定位：贴触发器、优先向上展开（输入框本来就在屏幕底部），左右夹在视口内。 */
      useEffect(function () {
        if (!open) return undefined
        function place() {
          const node = triggerRef.current
          if (!node || typeof window === 'undefined') return
          const rect = node.getBoundingClientRect()
          const width = Math.max(MENU_MIN_WIDTH, Math.min(Math.max(rect.width, MENU_MIN_WIDTH), MENU_MAX_WIDTH))
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
          const estimated = menuRef.current ? menuRef.current.offsetHeight : 280
          const above = rect.top > estimated + 12
          setAnchor({
            left: left,
            width: width,
            top: above ? null : rect.bottom + 6,
            bottom: above ? window.innerHeight - rect.top + 6 : null,
          })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return function () {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open, workspaces.length, menuError])

      /** 选中一项：立即 POST，成功后更新本地状态并关下拉；失败把 Host 的中文原因留在下拉里。 */
      async function choose(workspace) {
        if (!sessionId || saving) return
        setSaving(true)
        setMenuError(null)
        const controller = new AbortController()
        inflight.current.add(controller)
        try {
          const next = await setDispatchTarget(sessionId, workspace, controller.signal)
          setTarget(next)
          setStatus('ready')
          setOpen(false)
          targetBus.emit()
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setMenuError(fill(tr('targetSetFailed'), { reason: describeError(error) }))
        } finally {
          inflight.current.delete(controller)
          setSaving(false)
        }
      }

      /** 当前是不是「自动」模式（没有锁定具体工作区，每次派发按任务内容挑）。 */
      const isAuto = Boolean(target && target.auto)

      function toggle() {
        if (status === 'error' || !portalReady) return
        const next = !open
        setOpen(next)
        if (next) {
          setMenuError(null)
          setReloadKey(function (value) { return value + 1 })
        }
      }

      if (!sessionId) return null

      const unavailable = status === 'error'
      const disabled = unavailable || !portalReady
      const shown = target && target.title ? target.title : (target && target.workspace_id ? target.workspace_id : '')
      // 没有目标 = 不派发（默认）。文案与按钮保持同一套词，免得两个入口各说各话。
      const text = tr('targetPrefix') + ' → ' + (shown || tr('targetNone'))
      const triggerTitle = unavailable
        ? tr('targetUnavailable')
        : !portalReady
          ? tr('targetPortalUnavailable')
          : shown
            ? tr('targetForcedHint') + (target && target.path ? '\n' + target.path : '')
            : tr('targetNoneHint')

      const rows = []
      if (open) {
        // 「不派发」是默认项：会话自己干活，不创建子会话。
        rows.push(h(TargetRow, {
          key: 'none',
          checked: !target,
          label: tr('targetNone'),
          description: tr('targetNoneHint'),
          onPick: function () { void choose('') },
        }))
        // 「自动选择」：不锁定工作区，每次派发按任务内容挑。
        rows.push(h(TargetRow, {
          key: 'auto',
          checked: isAuto,
          label: tr('targetAuto'),
          description: tr('targetAutoHint'),
          icon: '✦',
          disabled: saving,
          onPick: function () { void choose('auto') },
        }))
        rows.push(h('div', { key: 'sep-1', className: 'dsh-sa-menu-sep', role: 'separator' }))
        if (status === 'loading') {
          rows.push(h('div', { key: 'loading', className: 'dsh-sa-menu-note' }, tr('targetLoading')))
        }
        for (const workspace of workspaces) {
          rows.push(h(TargetRow, {
            key: workspace.id,
            checked: Boolean(target && target.workspace_id === workspace.id),
            label: workspace.title || workspace.id,
            description: typeof workspace.path === 'string' ? workspace.path : '',
            disabled: saving,
            onPick: function () { void choose(workspace.id) },
          }))
        }
        if (status === 'ready' && workspaces.length === 0) {
          rows.push(h('div', { key: 'empty', className: 'dsh-sa-menu-note' }, tr('targetMenuEmpty')))
        }
        if (menuError) {
          rows.push(h('div', { key: 'error', className: 'dsh-sa-menu-error', role: 'alert' }, menuError))
        }
        rows.push(h('div', { key: 'sep-2', className: 'dsh-sa-menu-sep', role: 'separator' }))
        rows.push(h(TargetRow, {
          key: 'refresh',
          label: tr('targetMenuRefresh'),
          icon: '↻',
          disabled: saving,
          onPick: function () {
            setMenuError(null)
            setReloadKey(function (value) { return value + 1 })
          },
        }))
      }

      const menu = open
        ? h(
            'div',
            {
              ref: menuRef,
              className: 'dsh-sa-menu',
              role: 'menu',
              'aria-label': tr('targetLabel'),
              style: anchor
                ? {
                    left: anchor.left + 'px',
                    width: anchor.width + 'px',
                    top: anchor.top === null ? undefined : anchor.top + 'px',
                    bottom: anchor.bottom === null ? undefined : anchor.bottom + 'px',
                  }
                : { left: '-9999px', top: '0px' },
            },
            rows,
          )
        : null

      return h(
        React.Fragment,
        null,
        h('style', null, PICKER_STYLE),
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className: 'dsh-sa-target',
            'data-targeted': shown ? 'true' : 'false',
            disabled: disabled,
            title: triggerTitle,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-label': tr('targetLabel'),
            onClick: toggle,
          },
          h('span', { className: 'dsh-sa-target-icon' }, h(TargetDot, { on: Boolean(shown) })),
          h('span', { className: 'dsh-sa-target-text' }, text),
          h('span', { className: 'dsh-sa-target-caret' }, h(TargetCaret)),
        ),
        menu && createPortal ? createPortal(menu, document.body) : null,
      )
    }

    /* ───────────────── @ 工作区触发源（可选能力） ───────────────── */

    /**
     * 注册 @ 工作区触发源。选中即把该工作区设为这个会话的派发目标，同时按官方
     * insert 路线在草稿里插一个 chip（appearance 省略 → 用 @ 标记渲染，且不会踩
     * 草稿持久化只认 session/file/folder 的坑）。
     *
     * 契约核对自本机 dsh-client-ui-input-trigger/lib/client.js：
     *   registerSource(src) -> disposer，(trigger,name) 重复会 throw；
     *   candidates(session, {query, quoted, position, drilled, signal}) -> 行数组；
     *   行 = {name, label?, description?, icon?, section?, drill?, value}（icon 省略即不画图标）；
     *   onPick({candidate, session, position, via, action, span}) ->
     *     {insert:{source, ref, label, appearance?, clipboardText}} | {text, continue?} | 'handled'；
     *   codec.serialize(ref, signal) 给出模型可见文本；codec.clipboardText(ref) 可选。
     *
     * inputTriggers 用 ctx.get 做可选查询：动态 ctx 的 get 不要求 inject 声明，
     * 取不到返回 undefined，所以这条能力缺席时看板与控件都照常工作。
     * @returns {boolean} 是否真的注册上了
     */
    function registerWorkspaceTrigger(ctx) {
      let inputTriggers
      try {
        inputTriggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined
      } catch (error) {
        inputTriggers = undefined
      }
      if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return false

      const source = {
        trigger: '@',
        name: 'workspace',
        order: 40,
        showGroupTitle: false,
        async candidates(session, request) {
          const signal = request ? request.signal : undefined
          let data
          try {
            data = await readSnapshot(signal, true)
          } catch (error) {
            return []
          }
          if (signal && signal.aborted) return []
          const pool = pickWorkspaces(data)
          for (const item of pool) workspaceTitles.set(item.id, item.title || item.id)
          const needle = String(request && request.query ? request.query : '').trim()
          const lower = needle.toLowerCase()
          const rows = []

          // 「不派发」也是可 @ 的：手边正好在打字时，不必去点控件。
          // 只有关键词能匹配上「不派发/关/off」时才出现，免得平时占位。
          const noneHit = !lower || ['不派发', '不', 'none', 'off', '关'].some(word => word.startsWith(lower) || lower.startsWith(word))
          if (noneHit) {
            rows.push({
              name: tr('targetNone'),
              description: tr('targetNoneHint'),
              section: tr('targetNone'),
              value: 'none',
            })
          }

          // 顶部固定一条「自动选择」：按关键词打分挑最优，不用手动翻列表。
          // 没有匹配时也显示，点下去会提示没有可选项，而不是静默什么都不做。
          const ranked = rankWorkspaces(pool, needle)
          const best = ranked.length ? ranked[0] : null
          rows.push({
            name: best
              ? fill(tr('targetAutoHit'), { title: best.title })
              : (pool.length ? tr('targetAutoMiss') : tr('targetMenuEmpty')),
            description: tr('targetAutoHint'),
            section: tr('targetAuto'),
            value: best ? best.item.id : '',
            auto: true,
          })

          for (const item of pool) {
            const title = item.title || item.id
            const path = typeof item.path === 'string' ? item.path : ''
            if (lower) {
              const hay = (title + '\n' + path + '\n' + item.id).toLowerCase()
              if (!hay.includes(lower)) continue
            }
            rows.push({ name: title, description: path, section: tr('targetSection'), value: item.id })
          }
          return rows
        },
        onPick(pick) {
          const candidate = pick ? pick.candidate : null
          let id = candidate && typeof candidate.value === 'string' ? candidate.value : ''
          const auto = Boolean(candidate && candidate.auto)
          const query = pick && pick.query ? String(pick.query) : ''

          // 「不派发」：value 是 'none'，Host 侧按清除处理（回到默认模式）。
          if (id === 'none') {
            const sessionIdNone = pick && pick.session && typeof pick.session.sessionId === 'string'
              ? pick.session.sessionId
              : ''
            if (sessionIdNone) {
              void setDispatchTarget(sessionIdNone, '').then(function () { targetBus.emit() })
                .catch(function (error) {
                  console.warn('[dsh-mini-superagent] @ 不派发设置失败：', error && error.message ? error.message : error)
                })
            }
            return undefined
          }

          // 「自动选择」这一条：用输入过的关键词重新排一次，取第一名。
          if (auto && !id) {
            const pool = Array.from(workspaceTitles.keys()).map(function (key) {
              return { id: key, title: workspaceTitles.get(key) }
            })
            const ranked = rankWorkspaces(pool, query)
            if (ranked.length) id = ranked[0].item.id
          }
          if (!id) return undefined
          const title = auto && workspaceTitles.has(id)
            ? workspaceTitles.get(id)
            : (typeof candidate.name === 'string' && candidate.name ? candidate.name : id)
          const sessionId = pick && pick.session && typeof pick.session.sessionId === 'string'
            ? pick.session.sessionId
            : ''
          if (sessionId) {
            // 选中即设目标。菜单马上就关了，失败没有地方挂错误：记日志，并让控件下次取数时显示真实目标。
            void setDispatchTarget(sessionId, id).then(function () {
              targetBus.emit()
            }).catch(function (error) {
              console.warn('[dsh-mini-superagent] @ 工作区设置派发目标失败：', error && error.message ? error.message : error)
            })
          }
          return {
            insert: {
              source: 'workspace',
              ref: id,
              label: title,
              clipboardText: '@' + title,
            },
          }
        },
        codec: {
          clipboardText(ref) {
            return '@' + (workspaceTitles.get(ref) || ref)
          },
          serialize(ref) {
            const title = workspaceTitles.get(ref) || ref
            const escaped = String(title).replace(/"/g, '&quot;')
            return Promise.resolve('<workspace id="' + String(ref) + '" title="' + escaped + '"/>')
          },
        },
      }

      ctx.effect(function () {
        return inputTriggers.registerSource(source)
      }, 'dsh-mini-superagent: @ workspace source')
      return true
    }

    /* ───────────────────────── 侧边栏图标 ───────────────────────── */

    /**
     * 侧边栏图标。ownerProps: { size, active } —— active 时用品牌色高亮，
     * 其余情况跟随 currentColor（列表本身会处理未选中状态的灰度）。
     */
    function BoardIcon(props) {
      const hinted = num(props && props.size, 20)
      const size = hinted > 0 ? hinted : 20
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: {
            display: 'block',
            color: active ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'currentColor',
          },
        },
        h('rect', { key: 'frame', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }),
        h('path', { key: 'col-1', d: 'M7.9 8.2v4.6' }),
        h('path', { key: 'col-2', d: 'M12 8.2v7.4' }),
        h('path', { key: 'col-3', d: 'M16.1 8.2v2.9' }),
      )
    }

    /* ───────────────────────── 轮次分隔线 ───────────────────────── */

    /**
     * 会话流里的「轮次分隔线」。
     *
     * 挂 `conversation.chat.user.before`（chain，会话作用域）：宿主在每条用户消息气泡
     * **上方**留了这一个装饰槽，选择器返回非空就由我们接管那一格。
     *
     * 为什么需要：长会话里 assistant 的步骤、工具卡片、回流报告连成一片，滚动时找不到
     * 「这一轮是从哪句话开始的」。这里给每一轮画一条横线，作为可见的起点。
     *
     * 不猜业务语义：只看 `owner.kind`（宿主已经把 steering 行排除在外）和消息 `source.kind`
     * ——本插件自己投递的报告（`src/sessions.js` 里 `source.kind` = 包名）多一枚「派发报告」
     * 标签，其余用户输入一律是同样的一条线。`source` 的其它字段一概不读，也不依赖任何
     * 会话投影：拿不到就没有标签，绝不因此不画线。
     */
    const DIVIDER_SELECTED_USER = Object.freeze({ relay: false })
    const DIVIDER_SELECTED_RELAY = Object.freeze({ relay: true })

    /** chain 槽的选择器：只接用户行；返回值同时告诉组件「这一行是不是派发报告」。 */
    function selectTurnDivider(owner) {
      if (!owner || owner.kind !== 'user') return null
      const source = owner.source && typeof owner.source === 'object' ? owner.source : null
      return source && source.kind === RELAY_SOURCE_KIND ? DIVIDER_SELECTED_RELAY : DIVIDER_SELECTED_USER
    }

    /**
     * 分隔线样式。用的是宿主主题 token（`--dsw-alias-*`），明暗两套自动跟随；
     * 写死的颜色只作 token 缺失时的兜底。类名仍在 `dsh-sa-` 前缀下，
     * 随组件内的 <style> 一起卸载，不写全局样式表。
     */
    const DIVIDER_STYLE = `
.dsh-sa-divide {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 22px 4px 12px;
  pointer-events: none;
  user-select: none;
}
.dsh-sa-divide-line { flex: 1 1 auto; height: 1px; min-width: 12px; }
.dsh-sa-divide-line-lead {
  background: linear-gradient(to right, transparent, var(--dsw-alias-border-l2, rgba(127,127,127,.45)));
}
.dsh-sa-divide-line-trail {
  background: linear-gradient(to left, transparent, var(--dsw-alias-border-l2, rgba(127,127,127,.45)));
}
.dsh-sa-divide-mark {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 1.5px;
  transform: rotate(45deg);
  background: var(--dsw-alias-label-secondary, #6b6b6b);
  opacity: .45;
}
.dsh-sa-divide-relay .dsh-sa-divide-line-lead {
  background: linear-gradient(to right, transparent, var(--dsw-alias-brand-primary, #4d6bfe));
  opacity: .55;
}
.dsh-sa-divide-relay .dsh-sa-divide-line-trail {
  background: linear-gradient(to left, transparent, var(--dsw-alias-brand-primary, #4d6bfe));
  opacity: .55;
}
.dsh-sa-divide-tag {
  flex: 0 0 auto;
  padding: 2px 9px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  font-size: 11px;
  line-height: 1.4;
  letter-spacing: .04em;
  white-space: nowrap;
}
`

    /** 一条轮次分隔线。`matched` 由 `selectTurnDivider` 给出；缺失时按普通用户轮次画。 */
    function TurnDivider(props) {
      const relay = Boolean(props && props.matched && props.matched.relay)
      return h(
        'div',
        {
          className: relay ? 'dsh-sa-divide dsh-sa-divide-relay' : 'dsh-sa-divide',
          'aria-hidden': 'true',
          'data-divider': relay ? 'relay' : 'turn',
        },
        h('style', { key: 'style' }, DIVIDER_STYLE),
        h('span', { key: 'lead', className: 'dsh-sa-divide-line dsh-sa-divide-line-lead' }),
        relay
          ? h('span', { key: 'tag', className: 'dsh-sa-divide-tag' }, tr('divider.relay'))
          : h('span', { key: 'mark', className: 'dsh-sa-divide-mark' }),
        h('span', { key: 'trail', className: 'dsh-sa-divide-line dsh-sa-divide-line-trail' }),
      )
    }

    /* ───────────────────────── 主面板 ───────────────────────── */

    /** 顶部的一个指标。 */
    function Metric(props) {
      return h(
        'span',
        { className: 'dsh-sa-metric' },
        h('span', { className: 'dsh-sa-metric-label' }, props.label),
        h('span', { className: 'dsh-sa-metric-value' }, String(props.value)),
      )
    }

    /** 指标：值在上（大号等宽数字），标签在下；`hint` 挂在 title 上，不占视觉空间。 */
    function Stat(props) {
      return h(
        'span',
        { className: 'dsh-sa-stat', title: props.hint || undefined },
        h('span', { className: 'dsh-sa-stat-value' }, String(props.value)),
        h('span', { className: 'dsh-sa-stat-label' }, props.label),
      )
    }

    /** 分节：标题 + 计数 + 可选说明 + 右侧动作。空节由调用方决定渲染什么。 */
    function Section(props) {
      return h(
        'section',
        { className: 'dsh-sa-sec' },
        h(
          'div',
          { className: 'dsh-sa-sec-head' },
          h('span', { className: 'dsh-sa-sec-title' }, props.title),
          typeof props.count === 'number' ? h('span', { className: 'dsh-sa-sec-count' }, String(props.count)) : null,
          props.hint ? h('span', { className: 'dsh-sa-sec-hint' }, props.hint) : null,
          h('span', { key: 'grow', className: 'dsh-sa-grow' }),
          props.action || null,
        ),
        props.body || null,
      )
    }

    /** 并发条：把「在跑 / 上限」画成一条，比两个数字更快看出还有没有空位。 */
    function ConcurrencyBar(props) {
      const max = Math.max(1, num(props.max, 1))
      const running = Math.max(0, num(props.running, 0))
      const ratio = Math.min(1, running / max)
      return h(
        'div',
        { className: 'dsh-sa-conc' },
        h(
          'div',
          { className: 'dsh-sa-bar', role: 'img', 'aria-label': tr('concurrency') + ' ' + running + '/' + max },
          h('div', { className: 'dsh-sa-bar-fill', style: { width: Math.round(ratio * 100) + '%' } }),
        ),
        h(
          'div',
          { className: 'dsh-sa-conc-meta' },
          h('span', null, tr('concurrency') + ' ' + running + '/' + max),
          num(props.queued, 0) > 0 ? h('span', null, tr('queuedOne') + ' ' + num(props.queued, 0)) : null,
          num(props.background, 0) > 0
            ? h('span', { className: 'dsh-sa-warn' }, tr('backgroundTag') + ' ' + num(props.background, 0))
            : null,
        ),
      )
    }

    /** 批次头：一个 group 的进度条与计数（含已结算成员，否则永远显示 0/1）。 */
    function BatchHead(props) {
      const total = num(props.total, 0)
      const done = num(props.done, 0)
      const percent = total > 0 ? Math.round((done / total) * 100) : 0
      const members = num(props.members, total)
      const waiting = num(props.waiting, 0)
      const skipped = num(props.skipped, 0)
      return h(
        'div',
        { className: 'dsh-sa-batch' },
        h('span', { className: 'dsh-sa-tag dsh-sa-tag-group' }, tr('groupTag')),
        h('span', { className: 'dsh-sa-batch-name' }, String(props.name || '')),
        h('span', { className: 'dsh-sa-batch-count' }, done + '/' + total),
        /*
         * 依赖口径（PRD-02 §4.5）：只在真有等待/未执行时出现——一个「0 个等待前置
         * · 0 个未执行」的尾巴对用户没有信息量，还会把批次头撑成两行。
         */
        waiting + skipped > 0
          ? h(
              'span',
              { className: 'dsh-sa-meta', 'data-batch-dep': 'true' },
              fill(tr('dep.batchHead'), { total: members, waiting: waiting, skipped: skipped }),
            )
          : null,
        h(
          'div',
          { className: 'dsh-sa-bar dsh-sa-batch-bar', 'aria-hidden': 'true' },
          h('div', { className: 'dsh-sa-bar-fill', style: { width: percent + '%' } }),
        ),
      )
    }

    /**
     * 「重试 N 次」标签（A6 / PRD §10.3）：任务卡与历史行**共用一份**渲染。
     *
     * 宿主只在这一刻真在续跑时下发 `retry_health`，所以这里不判状态：结算后对象
     * 消失、标签自然消失，不会留下历史次数（`retryCounts` 是纯内存的）。
     *
     * 为什么不与 `attempt` 标签合流：`attempt` 是「换过几次 worker 会话」，
     * `retry_health.attempts` 是「同一会话里因瞬时故障续跑了几次」。两个数字相等
     * 是巧合，不相等是常态；合在一起会让「第 2 次」看起来像「重试了 2 次」。
     * 也不与投递重试（`report_delivery`，报告没送到）共用文案或并排展示。
     */
    function retryTagOf(row) {
      const health = row && row.retry_health && typeof row.retry_health === 'object' ? row.retry_health : null
      const retryAttempts = health ? num(health.attempts, 0) : 0
      if (retryAttempts <= 0) return null
      /*
       * 先在本地算好「几点起的」，再决定要不要给 title：没有起点时 `fill` 会拼出
       * 一个空的「自  起」，比没有提示更让人困惑。
       */
      const retrySinceAt = health && health.since ? formatClockShort(health.since) : ''
      const retryTagProps = {
        key: 'retry',
        className: 'dsh-sa-tag dsh-sa-tag-retry',
        // 观测口径：冒烟与排障直接读这个属性，不必按文字找。
        'data-retry-health': String(retryAttempts),
      }
      if (retrySinceAt) {
        const title = fill(tr('retrySinceHint'), { time: retrySinceAt })
        retryTagProps.title = title
        retryTagProps['aria-label'] = title
      }
      return h('span', retryTagProps, fill(tr('retryTag'), { n: retryAttempts }))
    }

    /**
     * 一条任务卡。
     *
     * 三种密度共用一个组件：
     * - 默认（在跑 / 排队 / 需要处理）：两行，可选的进度条或原因行；
     * - `dense=true`（最近完成 / 已归档）：单行，只留标题、状态、耗时与时间。
     *
     * 刻意保留 `dsh-sa-row` 这个类名与 `data-archived` / `data-status` 属性：
     * 离线冒烟脚本按它们找行、点行，不能因为换布局就改掉契约。
     */
    function TaskCard(props) {
      const task = props.task
      const dense = Boolean(props.dense)
      const archived = Boolean(task.archived_at)
      const meta = STATUS_META[task.status] || STATUS_FALLBACK
      const dotColor = archived ? 'var(--dsw-alias-label-tertiary, #8b8b8b)' : meta.color
      const pulse = archived ? false : meta.pulse
      const statusText = tr('status.' + task.status)
      const elapsed = elapsedOf(task, props.now, props.fetchedAt)
      /*
       * 归档行什么都不给：它已经在「已归档」里了，再给一个归档按钮没有意义，
       * 重试也不该出现在历史行上（那会让「冻结只读」看起来还能复活）。
       */
      const actions = archived ? NO_ACTIONS : actionOf(task.status)
      const kind = actions.primary
      const busyKind = props.busy[task.task_id]
      /*
       * 续派的两个状态由面板统一持有（与归档的 `archiveAsk` 同一套做法）：
       * `continueAsk` 是「哪一行正开着输入框」，`continueDraft` 是那一行的草稿。
       * `TaskCard` 是无 hook 的展示组件，自己存不了草稿——它每次渲染都会重建。
       */
      const continueOpen = !archived && Boolean(actions.continue)
        && props.continueAsk === task.task_id
      const continueText = continueOpen && typeof props.continueDraft === 'string' ? props.continueDraft : ''
      const continueBusy = busyKind === 'continue'
      const summary = task.last_report && typeof task.last_report.summary === 'string'
        ? task.last_report.summary
        : ''
      const reportLine = firstLine(summary) || tr('noReport')
      const attempt = num(task.attempt, 1)
      const reportCount = num(task.report_count, 0)
      /*
       * 计划标签（PRD-01 §4.3）。**只在 queued / running 且真有计划时出现**：
       * 终态优先于计划——任务 done 之后再挂一个「2/5」，用户会以为它没跑完。
       * 宿主 `boardTask()` 已经对已结算任务不下发 plan_*，这里再判一次状态是
       * 第二道闸：快照契约与界面契约任一被绕开时，仍不会画出自相矛盾的标签。
       *
       * 只在标签区显示、**不在元信息行重复**：元信息行已经有「报告 N」，
       * 两个数字并排会让人分不清哪个是报告数、哪个是步骤数。
       */
      const planTotal = num(task.plan_total, 0)
      const planDone = num(task.plan_done, 0)
      const planCurrent = typeof task.plan_current === 'string' ? task.plan_current : ''
      const planVisible = !archived
        && (task.status === 'queued' || task.status === 'running')
        && planTotal > 0
      const planHint = planCurrent
        ? fill(tr('plan.tagHint'), { done: planDone, total: planTotal }) + ' · ' + planCurrent
        : fill(tr('plan.tagHint'), { done: planDone, total: planTotal })
      /*
       * 「计划已更新」标记（PRD-01 §6）。指纹比较在 `BoardPanel` 里做（它是唯一
       * 能跨轮询记住「上一次看到的是什么」的地方），这一行只负责画。
       * 与计划标签同生命周期（`planVisible`）：计划标签都不显示了（任务结算 / 归档），
       * 再挂一个「刚更新过」只会让人以为还有下一步。
       */
      const planJustUpdated = planVisible && Boolean(props.planUpdated)
      const planUpdatedHint = fill(tr('plan.updatedHint'), { done: planDone, total: planTotal })
      /*
       * 依赖标签（PRD-02 §4.5）。三种形态互斥，按信息量从高到低只放一个：
       *
       *   前置失败（被连带取消）> 等 A（被挡）> 依赖 2（有依赖但此刻没被挡）
       *
       * 只放一个而不是并列：行内标签区已经有可能在放计划 / 后台 / 待读 / 冻结，
       * 再加两个会把标题挤到换行；完整前置列表在抽屉里（`dep.tagHint` 是它的 hover）。
       *
       * 标题从 `props.depTitles` 查（同一份快照里的 title），查不到就退回 id——
       * **不**在这一行里发一次 fetch：看板是 2 秒轮询的纯展示层，多一个请求源
       * 就多一处会和快照不同步的数字。
       */
      const deps = Array.isArray(task.depends_on) ? task.depends_on : []
      const depFailed = task.cancel_reason === 'dependency_failed' || task.cancel_reason === 'dependency_missing'
      // 「等 A」只在**还在排队**时成立：已结算的任务留着 blocked_by 只是留痕，
      // 再画一个「在等」会让用户以为它还会自己开始。
      const depWaitingId = task.status === 'queued' && typeof task.blocked_by === 'string' ? task.blocked_by : ''
      const depTitleOf = function (id) {
        const titles = props.depTitles || {}
        const raw = typeof titles[id] === 'string' && titles[id] ? titles[id] : id
        return raw.length > 12 ? raw.slice(0, 12) : raw
      }
      const depHint = deps.length
        ? fill(tr('dep.tagHint'), { list: deps.map(depTitleOf).join(tr('dep.join')) })
        : ''
      const depTag = depFailed
        ? h(
            'span',
            {
              key: 'dep-failed',
              className: 'dsh-sa-tag dsh-sa-tag-dep-failed',
              title: depHint || tr('dep.failedTag'),
              'data-dep': 'failed',
            },
            tr('dep.failedTag'),
          )
        : depWaitingId
          ? h(
              'span',
              {
                key: 'dep-waiting',
                className: 'dsh-sa-tag dsh-sa-tag-dep',
                title: depHint,
                'data-dep': 'waiting',
              },
              fill(tr('dep.waiting'), { title: depTitleOf(depWaitingId) }),
            )
          : deps.length && !archived
            ? h(
                'span',
                { key: 'dep', className: 'dsh-sa-tag dsh-sa-tag-dep', title: depHint, 'data-dep': deps.length },
                fill(tr('dep.tag'), { n: deps.length }),
              )
            : null
      const title = typeof task.title === 'string' && task.title ? task.title : tr('noTitle')
      const group = typeof task.group === 'string' ? task.group : ''
      const background = task.background && typeof task.background === 'object' ? task.background : null
      const unread = Boolean(task.input_pending_at) && !task.input_read_at
      /*
       * 「未读未知」：宿主侧 `sweepMemory()` 把超时的「待读」改写成
       * `inputUnknownAt`，`boardTask()` 再投影成 `input_unknown_at`。两者的语义
       * **不同**：pending = 确定还没读（还能等）；unknown = 已经不知道读没读。
       * 这里照抄宿主契约再判一次 `!input_read_at`：万一旧数据两个标记同时存在，
       * 读过之后一律不显示。
       */
      const unknownRead = Boolean(task.input_unknown_at) && !task.input_read_at
      const frozenAt = Boolean(task.frozen_at)
      /*
       * 「已冻结」：归档时 `archiveStale()` 同时写 `archivedAt` 与 `frozenAt`，
       * 所以**归档行一定有 frozen_at**。归档行已经有「已归档」徽标 + 整行淡出，
       * 再叠一个「已冻结」只是同一件事说两遍；因此可见徽标只在「冻结但没归档」
       * 的行出现（将来冻结独立于归档时，它依然是对的）。
       * 语义不丢：归档行的 hover 里仍然会写「只读冻结，续跑会失败」。
       */
      const frozen = frozenAt && !archived
      /*
       * 归档行**不可点**。根因不在这一行，而在宿主的导航策略：`uiWorkspace.openSession`
       * 会把主视图换成那个会话，而 ui-workspace 的 `watchNavigation` 里有一条
       * `clearArchivedCurrent()` —— 当前主视图落在 `archivedSessionIds` 里就直接
       * `clearMain()`，主区域随即被清空/补建成一个空白会话，看起来就是「点一下开了
       * 一个新会话」。DSH 自己的侧边栏对归档会话也只给「暂时无法查看，请取消归档后
       * 查看」而不打开，这里对齐同一口径：无点击、无键盘焦点、无手形光标。
       */
      const clickable = Boolean(task.worker_session_id) && !archived
      const reportAgo = task.last_report && task.last_report.at ? formatRelative(task.last_report.at, props.now) : ''

      // 「为什么停在这」直接摊在行里，不要求人点进子会话再自己找。
      const reason = !dense && props.variant === 'attention'
        ? (typeof task.error === 'string' && task.error ? task.error : (firstLine(summary) || tr('noReason')))
        : ''

      // 进度条只对在跑的任务有意义：拿它和「已结算任务的中位耗时」比。
      // 基线为 0（还没完成过任何任务）时不画，免得给出一个假的 0%。
      const baseline = num(props.baseline, 0)
      const percent = !archived && task.status === 'running' && baseline > 0
        ? Math.min(100, Math.round((num(task.elapsed_ms, 0) / baseline) * 100))
        : 0

      /*
       * 归档行的 tip 由 `archivedHint` 统一说明，这里只给**可点**的行追加点击提示：
       * `clickable` 已经排除归档，两者不会再同时出现（以前会），也就不会出现
       * 「悬停说可点、点下去开空白会话」这种自相矛盾的提示。
       */
      const tip = [
        task.task_id,
        task.cwd ? 'cwd: ' + task.cwd : '',
        task.task_dir ? 'dir: ' + task.task_dir : '',
        task.worker_session_id ? 'worker: ' + task.worker_session_id : '',
      ].filter(Boolean).join('\n') + (clickable ? '\n' + tr('clickHint') : '') + (archived ? '\n' + tr('archivedHint') : '')
        // 归档行不显示「已冻结」徽标（与「已归档」重复），但语义不能一起丢：
        // hover 里明确写「只读冻结、续跑会失败」，那是 frozen 想要的断言。
        + (frozenAt ? '\n' + tr('frozenHint') : '')

      /*
       * 行内交互控件的选择器（第二层闸）。
       *
       * 行本身整体可点，行里却可以长控件（按钮、输入框、链接）。凡 target 落在这些
       * 元素里的事件都不是「想打开这一行」；`data-no-row-click` 是给将来新加的自定义
       * 控件留的显式逃生标记，不必再回来改这份选择器。
       */
      const ROW_CONTROL_SELECTOR = 'input, textarea, button, select, a, [contenteditable], [data-no-row-click]'

      /**
       * target 是否落在行内控件里（第二层闸，防复发）。
       *
       * 为什么用 `closest()`：事件目标可能是控件内部的子节点（例如按钮里的 span），
       * 直接与元素比对会漏；`closest` 一次就能判断「这个目标在控件内部」。
       * `target === currentTarget` 必须放行——那是行自己（键盘 Tab 到行上 / 点行空白处），
       * 否则 `closest` 会顺着祖先找到 aria/tooltip 一类外层标记，把正常打开也挡了。
       */
      function insideRowControl(event) {
        const target = event && event.target
        if (!target || target === event.currentTarget) return false
        if (typeof target.closest !== 'function') return false
        return Boolean(target.closest(ROW_CONTROL_SELECTOR))
      }

      /**
       * 整行可点（行内控件除外）：打开这个任务的子会话。
       *
       * 第一层闸在控件自己身上（`stopRowBubble`），这里是第二层：键盘、脚本
       * `dispatchEvent`、将来忘了拦冒泡的新控件都可能绕过第一层，这一层才防复发。
       */
      function activate(event) {
        if (!clickable) return
        if (insideRowControl(event)) return
        if (event) {
          if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
          if (event.preventDefault) event.preventDefault()
        }
        props.handlers.open(task)
      }

      /**
       * 行内控件的冒泡闸门（第一层）。
       *
       * 续派输入行是行的子节点：在输入框上按下/点一下，click 会冒到行的 onClick，
       * 触发「打开子会话」——用户看到的就是「输入框刚展开，点进去页面就跳走了」。
       * 按钮各自的 onClick 已有 stopPropagation，输入框当时**只拦了 input/keydown，
       * 漏了 mousedown 与 click**，于是这个缺陷只在输入框上出现。
       *
       * **绝不调 preventDefault**：默认行为正是「聚焦 + 落光标」，拦掉就真打不了字了。
       */
      function stopRowBubble(event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      }

      /*
       * 无障碍状态：不可点的行不占 Tab 位，但仍然要让人（和读屏）知道「为什么点不了」。
       * `aria-disabled` + 行内文案是静态可读的；归档行已经有「已归档」徽标与相对时间，
       * 这里只补一句不可打开的原因，避免出现「有 worker_session_id 却点不动」的疑惑。
       */
      const archivedAria = archived ? tr('archivedHint') : undefined

      /*
       * 主操作（取消 / 重试）。渲染条件保持原样：只有 `kind` 存在才画。
       * 归档按钮是**独立**的第二个按钮，见下面的 `archiveAction`：两者可能同时出现
       * （例如 interrupted 既有「重试」也有「归档」），所以不能再用一个三元式
       * 决定「这一行有没有按钮」。
       */
      const action = kind
        ? h(
            'button',
            {
              key: 'action',
              type: 'button',
              className: 'dsh-sa-btn ' + (kind === 'cancel' ? 'dsh-sa-btn-danger' : 'dsh-sa-btn-primary'),
              disabled: Boolean(busyKind),
              title: kind === 'cancel' ? tr('cancel') : tr('retryTask'),
              onClick: function (event) {
                // 行本身可点，按钮必须吞掉冒泡，否则取消的同时还会去开子会话。
                if (event && event.stopPropagation) event.stopPropagation()
                props.handlers.act(kind, task)
              },
            },
            busyKind === 'cancel'
              ? tr('cancelling')
              : busyKind === 'retry'
                ? tr('retrying')
                : kind === 'cancel'
                  ? tr('cancel')
                  : tr('retryTask'),
          )
        : null

      /*
       * 归档按钮（plans/09 用户反馈：「已经中断的任务应该加取消或者归档按钮，
       * 要不然只有重试会一直卡着」）。
       *
       * 三个关键决定：
       * - **二次确认**：归档是写操作，会话会被冻成只读（`archivedSessionIds`），
       *   误触的代价是「一条任务从待办区消失」。第一次点击只进确认态，
       *   4 秒内没再点自动退回（`confirmArchive` 状态由面板统一管，与工具栏
       *   「立即归档超时会话」共用同一套 4 秒过期逻辑）。
       * - **走 `/archive-task` 而不是 `/archive`**：后者是**巡检**——不读 body、
       *   按保留期扫全表、回 `{scanned, archived, failed}`。拿它做单条归档会
       *   把别的超期任务一起扫走，而用户点的是「这一条」。
       * - **文案用 `archiveTaskConfirm` 而不是 `archiveConfirm`**：后者是工具栏
       *   「立即归档超时会话」巡检的确认词（「再次点击确认归档超时会话」），两条路
       *   文案要能分清到底在确认哪一件事。同一个 `archiveTask` 词干不能复用，
       *   否则读屏里也分不出来。
       */
      const archiving = busyKind === 'archive'
      // 确认态由面板统一持有（`archiveAsk` 是「哪一行在等确认」的 task_id），
      // 一行只认自己的 id，不会出现两行同时点亮。
      const archiveStage = props.archiveAsk && props.archiveAsk === task.task_id ? 1 : 0
      const archiveAction = actions.archive
        ? h(
            'button',
            {
              key: 'archive-action',
              type: 'button',
              className: 'dsh-sa-btn'
                + (archiveStage === 1 ? ' dsh-sa-btn-confirm' : ''),
              disabled: Boolean(busyKind),
              title: archiveStage === 1 ? tr('archiveTaskConfirm') : tr('archiveTask'),
              onClick: function (event) {
                if (event && event.stopPropagation) event.stopPropagation()
                props.handlers.act('archive', task)
              },
            },
            archiving ? tr('archiving') : archiveStage === 1 ? tr('archiveTaskConfirm') : tr('archiveTask'),
          )
        : null

      /*
       * 续派按钮 + 行内输入（plans/08 阶段 1）。
       *
       * **只出现在已结算行**（判据在 `actionOf` 里，`actions.continue`）。
       * 点一下展开输入框，填一句要求后按「发过去」——它走的是 `POST /retry` 带
       * `message`，宿主侧转发给 `dispatch.message()`，**不新建任务**。
       *
       * 为什么必须在行里写一句 `continueHint`：续派成功后看板上不会有新行，
       * 用户唯一能看到的变化是这条任务从「已完成」变回「运行中」。不解释这件事，
       * 按钮看起来就像「点了没反应」。
       */
      const continueAction = actions.continue
        ? h(
            'button',
            {
              key: 'continue-action',
              type: 'button',
              className: 'dsh-sa-btn',
              disabled: Boolean(busyKind),
              title: tr('continuePlaceholder'),
              'data-continue': task.task_id,
              onClick: function (event) {
                if (event && event.stopPropagation) event.stopPropagation()
                props.continueHandlers.toggle(task)
              },
            },
            continueBusy ? tr('continueSending') : tr('continueTask'),
          )
        : null

      /** 展开后的输入行：一个文本框 + 发送/取消。 */
      const continueRow = continueOpen
        ? h(
            'div',
            {
              key: 'continue-row',
              className: 'dsh-sa-continue',
              /*
               * 行可点，行内控件必须阻断冒泡，否则点输入框会跳走（第一层闸）。
               * 拦 mousedown 与 click：有的交互把「按下」当成行的激活时机，
               * 只拦 click 会漏掉。两者都**不** preventDefault——输入框要靠默认行为
               * 聚焦并落下光标。keydown 由输入框自己的 onKeyDown 拦（Enter/Esc 也在那边）。
               * `data-no-row-click` 供第二层闸（`insideRowControl`）识别这个容器。
               */
              'data-no-row-click': 'true',
              onMouseDown: stopRowBubble,
              onClick: stopRowBubble,
            },
            h('input', {
              key: 'input',
              type: 'text',
              className: 'dsh-sa-continue-input',
              placeholder: tr('continuePlaceholder'),
              value: continueText,
              disabled: continueBusy,
              'aria-label': tr('continuePlaceholder'),
              'data-continue-input': task.task_id,
              onInput: function (event) {
                if (event && event.stopPropagation) event.stopPropagation()
                props.continueHandlers.input(task, event && event.target ? event.target.value : '')
              },
              onKeyDown: function (event) {
                if (!event) return
                // Enter/Esc 也不能冒到行上：行的 onKeyDown 认 Enter 为「打开会话」。
                if (event.stopPropagation) event.stopPropagation()
                if (event.key === 'Enter') props.continueHandlers.submit(task)
                else if (event.key === 'Escape') props.continueHandlers.toggle(task)
              },
            }),
            h(
              'button',
              {
                key: 'send',
                type: 'button',
                className: 'dsh-sa-btn dsh-sa-btn-primary',
                disabled: continueBusy || !continueText.trim(),
                'data-continue-send': task.task_id,
                onClick: function (event) {
                  if (event && event.stopPropagation) event.stopPropagation()
                  props.continueHandlers.submit(task)
                },
              },
              continueBusy ? tr('continueSending') : tr('continueSubmit'),
            ),
            h(
              'button',
              {
                key: 'dismiss',
                type: 'button',
                className: 'dsh-sa-btn',
                disabled: continueBusy,
                'data-continue-cancel': task.task_id,
                onClick: function (event) {
                  if (event && event.stopPropagation) event.stopPropagation()
                  props.continueHandlers.toggle(task)
                },
              },
              tr('continueCancel'),
            ),
            h('span', { key: 'hint', className: 'dsh-sa-continue-hint' }, tr('continueHint')),
          )
        : null

      /*
       * 不再渲染「摘要已截断 / 详情已截断」标记。原因只有一句：快照本来就不带正文，
       * 点进去也看不到被裁掉的部分，这个标记**无法导向任何可读内容**，只会让人以为
       * 自己漏看了什么。后端仍投影 `has_truncated` / `truncated_fields`（其他消费者
       * 可能读得到），但界面不再展示；要确认被裁情况请用 `dispatch_inspect`。
       */
      const tags = [
        attempt > 1
          ? h('span', { key: 'attempt', className: 'dsh-sa-tag' }, tr('attemptPrefix') + attempt + tr('attemptSuffix'))
          : null,
        // 「重试 N 次」（A6）：宿主只在这一刻真在续跑时下发 `retry_health`。
        retryTagOf(task),
        planVisible
          ? h(
              'span',
              {
                key: 'plan',
                className: 'dsh-sa-tag dsh-sa-tag-plan',
                title: planHint,
                'aria-label': planHint,
                'data-plan': planDone + '/' + planTotal,
              },
              planDone + '/' + planTotal,
            )
          : null,
        planJustUpdated
          ? h(
              'span',
              {
                key: 'plan-updated',
                className: 'dsh-sa-tag dsh-sa-tag-plan-updated',
                title: planUpdatedHint,
                'aria-label': planUpdatedHint,
                // 观测口径：冒烟与排障直接读这个属性，不必按文字找。
                'data-plan-updated': planDone + '/' + planTotal,
              },
              tr('plan.updatedTag'),
            )
          : null,
        depTag,
        background
          ? h('span', { key: 'bg', className: 'dsh-sa-tag dsh-sa-tag-bg', title: tr('backgroundHint') }, tr('backgroundTag'))
          : null,
        unread
          ? h('span', { key: 'unread', className: 'dsh-sa-tag dsh-sa-tag-unread', title: tr('unreadHint') }, tr('unreadTag'))
          : null,
        /*
         * 「未读未知」与「待读」**互斥**：宿主侧已做互斥（unknown 出现时 pending
         * 一定缺席），这里再加一道，避免将来的数据把两个矛盾的状态同时画出来。
         */
        unknownRead && !unread
          ? h(
              'span',
              { key: 'unknown', className: 'dsh-sa-tag dsh-sa-tag-unknown', title: tr('unknownReadHint') },
              tr('unknownReadTag'),
            )
          : null,
        frozen
          ? h('span', { key: 'frozen', className: 'dsh-sa-tag dsh-sa-tag-frozen', title: tr('frozenHint') }, tr('frozenTag'))
          : null,
        archived
          ? h('span', { key: 'archived', className: 'dsh-sa-tag dsh-sa-tag-archived' }, tr('archivedTag'))
          : null,
        dense && group ? h('span', { key: 'group', className: 'dsh-sa-tag dsh-sa-tag-group' }, tr('groupTag')) : null,
      ]

      return h(
        'div',
        {
          className: 'dsh-sa-row'
            + (archived ? ' dsh-sa-row-archived' : '')
            + (dense ? ' dsh-sa-row-dense' : '')
            + (props.variant === 'attention' ? ' dsh-sa-row-attention' : '')
            + (clickable ? ' dsh-sa-row-clickable' : ''),
          role: 'listitem',
          'data-status': task.status,
          'data-variant': props.variant || 'active',
          'data-archived': archived ? 'true' : undefined,
          'data-clickable': clickable ? 'true' : undefined,
          title: tip,
          tabIndex: clickable ? 0 : undefined,
          'aria-disabled': clickable ? undefined : (archived ? true : undefined),
          'aria-description': archivedAria,
          onClick: clickable ? activate : undefined,
          onKeyDown: clickable ? activate : undefined,
        },
        h(
          'div',
          { className: 'dsh-sa-line' },
          h('span', {
            key: 'dot',
            className: 'dsh-sa-dot' + (pulse ? ' dsh-sa-dot-pulse' : ''),
            style: { color: dotColor },
            'aria-hidden': 'true',
          }),
          h('span', { key: 'status', className: 'dsh-sa-state', style: { color: dotColor } }, statusText),
          h('span', { key: 'title', className: 'dsh-sa-title', title: tip }, title),
          tags,
          h('span', { key: 'grow', className: 'dsh-sa-grow' }),
          archived
            ? h('span', { key: 'archived-at', className: 'dsh-sa-meta' }, formatRelative(task.archived_at, props.now))
            : null,
          elapsed ? h('span', { key: 'elapsed', className: 'dsh-sa-meta dsh-sa-elapsed' }, elapsed) : null,
          /*
           * 三个按钮的次序：主操作 → 续派 → 归档。
           * 续派排在归档前，因为两者的紧迫程度不同：续派是「还要它接着干」，
           * 归档是「收走」。把收走夹在中间会让最常用的动作落在最右边。
           */
          action,
          continueAction,
          archiveAction,
        ),
        continueRow,
        percent > 0
          ? h(
              'div',
              {
                key: 'progress',
                className: 'dsh-sa-bar dsh-sa-progress',
                title: formatDuration(num(task.elapsed_ms, 0)) + ' / ' + formatDuration(baseline),
                'aria-hidden': 'true',
              },
              h('div', {
                className: 'dsh-sa-bar-fill' + (num(task.elapsed_ms, 0) > baseline ? ' dsh-sa-bar-slow' : ''),
                style: { width: percent + '%' },
              }),
            )
          : null,
        reason
          ? h(
              'div',
              { key: 'reason', className: 'dsh-sa-reason', title: reason },
              h('span', { className: 'dsh-sa-reason-label' }, tr('reason')),
              h('span', { className: 'dsh-sa-reason-text' }, firstLine(reason)),
            )
          : null,
        dense
          ? [
              reportCount > 0
                ? h('span', { key: 'dense-count', className: 'dsh-sa-dense-meta' }, tr('reports') + ' ' + reportCount)
                : null,
            ]
          : h(
              'div',
              { key: 'sub', className: 'dsh-sa-sub' },
              h(
                'span',
                { key: 'workspace', className: 'dsh-sa-workspace', title: task.workspace_title || '' },
                workspaceTitleOf(task),
              ),
              h('code', { key: 'id', className: 'dsh-sa-id' }, task.task_id),
              reportCount > 0
                ? h('span', { key: 'count', className: 'dsh-sa-meta' }, tr('reports') + ' ' + reportCount)
                : null,
              h(
                'span',
                { key: 'report', className: 'dsh-sa-report', title: summary || reportLine },
                reportLine,
              ),
              reportAgo ? h('span', { key: 'report-at', className: 'dsh-sa-meta' }, reportAgo) : null,
            ),
        typeof task.error === 'string' && task.error && props.variant !== 'attention'
          ? h('div', { key: 'error', className: 'dsh-sa-errorline', title: task.error }, task.error)
          : null,
        typeof task.archive_error === 'string' && task.archive_error
          ? h(
              'div',
              { key: 'archive-error', className: 'dsh-sa-errorline', title: task.archive_error },
              tr('archiveErrorPrefix') + task.archive_error,
            )
          : null,
      )
    }

    /** 空/错/加载三种占位，统一用同一个容器，避免面板被打成白屏。 */
    function Blank(props) {
      return h(
        'div',
        { className: 'dsh-sa-blank' },
        h('div', { className: 'dsh-sa-blank-title' }, props.title),
        props.hint ? h('div', null, props.hint) : null,
        props.action || null,
      )
    }

    /* ───────────────── plans/09 P1：效果 / 拆解 的展示组件 ───────────────── */

    /**
     * 一张指标卡：标签 + 大号数值 + 可选的「分母 / 样本」小字。
     *
     * 第三行的存在是 plans/09 §八.1「每条比例都可追到分子分母」在界面上的落点：
     * 一个孤零零的 67% 不能被复核，`÷ n=3` 才能让人自己去数。
     * `tone` 只影响数值颜色，且**同一个数值永远有文字标签**，颜色不是唯一通道（§八.8）。
     */
    function EffectCard(props) {
      const tone = props.tone === 'fail' ? ' dsh-sa-card-fail'
        : props.tone === 'warn' ? ' dsh-sa-card-warn'
          : props.tone === 'ok' ? ' dsh-sa-card-ok' : ''
      return h(
        'div',
        { className: 'dsh-sa-card' + tone, 'data-card': props.id || undefined, title: props.hint || undefined },
        h('span', { className: 'dsh-sa-card-label' }, props.label),
        h('span', { className: 'dsh-sa-card-value' }, String(props.value)),
        props.sub ? h('span', { className: 'dsh-sa-card-sub' }, props.sub) : null,
      )
    }

    /** 一个卡片分组：标题 + 说明 + 卡片行。 */
    function CardGroup(props) {
      return h(
        'section',
        { className: 'dsh-sa-cardgroup', 'data-group': props.id || undefined },
        h(
          'div',
          { className: 'dsh-sa-cardgroup-head' },
          h('span', { className: 'dsh-sa-cardgroup-title' }, props.title),
          props.hint ? h('span', { className: 'dsh-sa-cardgroup-title' }, props.hint) : null,
        ),
        h('div', { className: 'dsh-sa-cards' }, props.children),
      )
    }

    /**
     * 样本口径行（plans/09 §三.4、§八.6）。
     *
     * 固定一句话把五件事说完：窗口内结算 / 有效耗时 / 排除归档 / 退休 / 时间未知。
     * 三个细节不能省：
     * - `n=0` 显示 `—`：0 会被读成「整整一个窗口什么都没做成」；
     * - `1≤n<5` 标「样本少」：数值照给，但不能当结论；
     * - `timeBasis` 是回退基准时必须可见：否则「完成时间」在两次轮询之间会变。
     */
    function ScopeLine(props) {
      const coverage = props.coverage && typeof props.coverage === 'object' ? props.coverage : null
      const settled = coverage ? num(coverage.settled, 0) : 0
      const valid = coverage ? num(coverage.validDurations, 0) : 0
      const archived = coverage ? num(coverage.excludedArchived, 0) : 0
      const retired = coverage ? num(coverage.excludedRetired, 0) : 0
      const missing = coverage ? num(coverage.missingTimes, 0) : 0
      const truncated = coverage && coverage.truncated ? coverage.truncated : null
      /*
       * 「样本少」的判据用 settled（结算样本），不是 validDurations：
       * 一条任务可以结算了但没有 startedAt，于是 settled=3 / valid=1。
       * 前者决定「比率可不可信」，后者决定「时长分布可不可信」，两个门槛各自成立。
       * 门槛 5 不在这里编：Host 用 `SAMPLE_LOW_BELOW` 判完，前端只在样本量上复述。
       */
      const low = settled > 0 && settled < 5
      const basis = coverage ? coverage.timeBasis : null
      const basisKey = basis ? String(basis) : ''
      /** 计数：n=0 时整行给 em dash，其余如实报数（0 是真的 0 就写 0）。 */
      const tail = coverage
        ? fill(tr('scope.tail'), {
            settled: settled > 0 ? String(settled) : tr('stat.none'),
            valid: valid > 0 ? String(valid) : tr('stat.none'),
            archived: String(archived),
            retired: String(retired),
            missing: String(missing),
          })
        : fill(tr('scope.tail'), {
            settled: tr('stat.none'), valid: tr('stat.none'), archived: tr('stat.none'),
            retired: tr('stat.none'), missing: tr('stat.none'),
          })
      const windowId = props.windowId || ''
      return h(
        'div',
        { className: 'dsh-sa-scope', role: 'status', 'aria-live': 'polite', 'data-scope': 'true' },
        h('span', { className: 'dsh-sa-scope-title' }, tr('scope.title')),
        h('span', { className: 'dsh-sa-scope-window', title: tr('win.fromMemory') }, scopeWindowText(windowId)),
        h('span', { className: 'dsh-sa-scope-counts' }, tail),
        low
          ? h('span', { className: 'dsh-sa-scope-low', title: tr('scope.lowHint') }, tr('scope.lowBadge'))
          : null,
        basisKey && basisKey !== 'settledAt'
          ? h('span', { className: 'dsh-sa-scope-warn', title: tr('scope.basisHint') },
              fill(tr('scope.timeBasis'), { basis: timeBasisText(basisKey) }))
          : null,
        coverage && coverage.fallbackFrom
          ? h('span', { className: 'dsh-sa-scope-warn' }, fill(tr('scope.fallbackFrom'), { value: String(coverage.fallbackFrom) }))
          : null,
        truncated
          ? h('span', { className: 'dsh-sa-scope-warn', title: tr('scope.truncatedHint') }, tr('scope.truncated'))
          : null,
        coverage && num(coverage.sourceTasks, 0) > 0
          ? h('span', { className: 'dsh-sa-scope-source', title: tr('scope.sourceHint') },
              fill(tr('scope.source'), { n: num(coverage.sourceTasks, 0) }))
          : null,
      )
    }

    /** 窗口键的人话：24h → 24 小时；7d → 7 天；all → 全部。 */
    function scopeWindowText(windowId) {
      if (!windowId || windowId === WINDOW_ALL) return tr('win.all')
      const match = /^(\d+)([hd])$/i.exec(String(windowId))
      if (!match) return String(windowId)
      const amount = Number(match[1])
      if (match[2].toLowerCase() === 'h') return amount + 'h'
      return fill(tr('win.days'), { days: amount })
    }

    /**
     * 横向条形列表（状态分布 / 退休原因共用）。
     *
     * plans/09 §五.3 明确「用横向条形列表，不用九色 donut」：donut 要么用颜色
     * 单独表意（§八.8 禁止），要么逼人围着圆环逐段比对角度。横向条形的同一行
     * 里就写着名字、数量和占比，读屏可读、可复制、可点。
     *
     * 每行是 `<button>`：键盘可达（§八.8），点一行把该键设为过滤条件（`onPick`）。
     * 没有 `onPick` 时退化成不可点的 div —— 例如退休原因没有可筛的任务键。
     */
    function DistRows(props) {
      const rows = Array.isArray(props.rows) ? props.rows : []
      if (!rows.length) return h('div', { className: 'dsh-sa-blank' }, props.empty || tr('stat.none'))
      const max = rows.reduce(function (peak, row) {
        return Math.max(peak, num(row.count, 0))
      }, 0)
      return h(
        'div',
        { className: 'dsh-sa-rows', role: 'list' },
        rows.map(function (row, index) {
          const count = num(row.count, 0)
          // 宽度按「占最大值」而不是「占总数」：小类目在按总数算时全是 1~2%，
          // 条形退化成一条细线，反而看不出相对大小。
          const width = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0
          const share = typeof row.share === 'number' && Number.isFinite(row.share) ? Math.round(row.share * 1000) / 10 + '%' : ''
          const label = props.labelOf ? props.labelOf(row, index) : String(row.name || row.key || '')
          const body = [
            h('span', { key: 'name', className: 'dsh-sa-dist-name' }, label),
            h(
              'span',
              { key: 'track', className: 'dsh-sa-dist-track', 'aria-hidden': 'true' },
              h('span', {
                className: 'dsh-sa-dist-fill' + (props.toneOf ? ' ' + props.toneOf(row) : ''),
                style: { width: width + '%', display: 'block' },
              }),
            ),
            h('span', { key: 'value', className: 'dsh-sa-dist-value' }, String(count) + (share ? ' · ' + share : '')),
          ]
          const pick = props.onPick
            ? function () { props.onPick(row) }
            : undefined
          if (!pick) {
            return h('div', { key: 'd' + index, className: 'dsh-sa-dist', role: 'listitem' }, body)
          }
          return h(
            'button',
            {
              key: 'd' + index,
              type: 'button',
              className: 'dsh-sa-dist',
              role: 'listitem',
              title: props.pickHint ? props.pickHint(label) : undefined,
              onClick: pick,
            },
            body,
          )
        }),
      )
    }

    /** 拆解表的一行：`cells` 里每一项已是文本；`onPick` 存在时整行可点、可键盘触发。 */
    function DrillRow(props) {
      const onPick = props.onPick
      const activate = onPick
        ? function (event) {
            if (event) {
              if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
              if (event.preventDefault) event.preventDefault()
            }
            onPick()
          }
        : undefined
      return h(
        'tr',
        {
          'data-drill': onPick ? 'true' : undefined,
          title: props.hint || undefined,
          tabIndex: onPick ? 0 : undefined,
          onClick: activate,
          onKeyDown: activate,
        },
        (props.cells || []).map(function (cell, index) {
          const isName = index === 0
          return h(
            isName ? 'th' : 'td',
            { key: 'c' + index, scope: isName ? 'row' : undefined, className: isName ? 'dsh-sa-table-name' : undefined },
            cell,
          )
        }),
      )
    }

    /** 表头一行。 */
    function DrillHead(props) {
      return h(
        'thead',
        null,
        h('tr', null, (props.columns || []).map(function (label, index) {
          return h('th', { key: 'h' + index, scope: 'col' }, label)
        })),
      )
    }

    /** 趋势区的「图表 / 表格」切换（plans/09 §五.2：图表必须有表格等价物）。 */
    function TrendToggle(props) {
      const mode = props.mode === 'table' ? 'table' : 'chart'
      return h(
        'span',
        { className: 'dsh-sa-toggle', role: 'group', 'aria-label': tr('trend.modeLabel') },
        ['chart', 'table'].map(function (id) {
          return h(
            'button',
            {
              key: id,
              type: 'button',
              className: 'dsh-sa-tab',
              'aria-pressed': mode === id,
              'aria-selected': mode === id,
              'data-trend-mode': id,
              onClick: function () { props.onChange(id) },
            },
            id === 'chart' ? tr('trend.chart') : tr('trend.table'),
          )
        }),
      )
    }

    /**
     * 趋势区：按天的新派 / 完成 / 失败·阻塞·中断 / 耗时中位数 / 并行节省。
     *
     * 两种形态共用**同一份数据**（Host 的 `daily`），切换只改呈现：
     * - `chart`：每天一行，两根细条形（完成/新派/问题各自一根，各自带文字）；
     * - `table`：真正的 `<table>`，可整块复制进表格软件核对。
     *
     * 「只列真实有事实的日期」是刻意的（plans/09 §五.2 与 §八.6）：
     * Host 的 `daily` 只为有事实的天产生行；前端补齐空天会把「这天没有任务」
     * 画成 0，而 0 是可被当成「数据丢失」或「确实零产出」两种读法的假事实。
     */
    function TrendBlock(props) {
      const days = Array.isArray(props.days) ? props.days : []
      if (!days.length) return h(Blank, { title: tr('trend.empty'), hint: tr('trend.onlyFacts') })
      const peak = days.reduce(function (top, day) {
        return Math.max(top, num(day.created, 0), num(day.done, 0), problemsOf(day))
      }, 0)
      if (props.mode === 'table') {
        return h(
          'div',
          { className: 'dsh-sa-tablewrap' },
          h(
            'table',
            { className: 'dsh-sa-table dsh-sa-trend-table' },
            h(DrillHead, {
              columns: [
                tr('trend.day'), tr('trend.created'), tr('trend.done'), tr('trend.problems'),
                tr('trend.median'), tr('trend.saved'),
              ],
            }),
            h('tbody', null, days.map(function (day, index) {
              return h(
                'tr',
                { key: day.day || 'day' + index },
                h('th', { scope: 'row', className: 'dsh-sa-table-name' }, String(day.day || '')),
                h('td', null, String(num(day.created, 0))),
                h('td', null, String(num(day.done, 0))),
                h('td', null, String(problemsOf(day))),
                h('td', null, day.medianDuration === null || day.medianDuration === undefined ? tr('stat.none') : durationText(day.medianDuration)),
                h('td', null, day.saved === null || day.saved === undefined ? tr('stat.none') : durationText(day.saved)),
              )
            })),
          ),
        )
      }
      return h(
        'div',
        { className: 'dsh-sa-trend', title: tr('trend.chartHint') },
        days.map(function (day, index) {
          const created = num(day.created, 0)
          const done = num(day.done, 0)
          const problems = problemsOf(day)
          const widthOf = function (value) { return peak > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / peak) * 100)) : 0 }
          return h(
            'div',
            {
              key: day.day || 'day' + index,
              className: 'dsh-sa-trend-row',
              // 每个点都能读到当天明细（plans/09 §五.2「不要求悬浮才能读数」）：
              // 文字部分就在同一行，title 只是额外补充。
              title: fill(tr('trend.detail'), {
                day: String(day.day || ''),
                created: created,
                done: done,
                problems: problems,
                median: day.medianDuration === null || day.medianDuration === undefined ? tr('stat.none') : durationText(day.medianDuration),
                saved: day.saved === null || day.saved === undefined ? tr('stat.none') : durationText(day.saved),
              }),
            },
            h('span', { className: 'dsh-sa-trend-day' }, String(day.day || '')),
            h(
              'span',
              { className: 'dsh-sa-trend-bars', 'aria-hidden': 'true' },
              h('span', { className: 'dsh-sa-trend-track' },
                h('span', { className: 'dsh-sa-trend-fill dsh-sa-trend-fill-created', style: { width: widthOf(created) + '%', display: 'block' } })),
              h('span', { className: 'dsh-sa-trend-track' },
                h('span', { className: 'dsh-sa-trend-fill dsh-sa-trend-fill-done', style: { width: widthOf(done) + '%', display: 'block' } })),
              h('span', { className: 'dsh-sa-trend-track' },
                h('span', { className: 'dsh-sa-trend-fill dsh-sa-trend-fill-problems', style: { width: widthOf(problems) + '%', display: 'block' } })),
            ),
            h(
              'span',
              { className: 'dsh-sa-trend-text' },
              tr('trend.created') + ' ' + created + ' · ' + tr('trend.done') + ' ' + done + ' · '
                + tr('trend.problems') + ' ' + problems + ' · '
                + tr('trend.median') + ' ' + (day.medianDuration === null || day.medianDuration === undefined ? tr('stat.none') : durationText(day.medianDuration)),
            ),
          )
        }),
      )
    }

    /** 一天的「失败·阻塞·中断」合计：三个状态始终分开计数，这里只是图上的一根条。 */
    function problemsOf(day) {
      return num(day && day.failed, 0) + num(day && day.blocked, 0) + num(day && day.interrupted, 0)
    }

    /**
     * 效果视图（plans/09 §五.2）。
     *
     * 布局顺序**固定**为 结果 → 速度 → 稳定 → 趋势 → 并行，不按数据多少重排：
     * 每次进来都是同一个顺序，人才知道「往下滚一格看速度」。
     *
     * 所有数字都来自 `/board/stats`（完整账本聚合），**不拿 200 条快照凑**：
     * 快照只服务总览列表；用截断的列表算比例，分母从一开始就是错的（§八.2）。
     */
    function EffectView(props) {
      const stats = props.stats
      const summary = stats && stats.summary && typeof stats.summary === 'object' ? stats.summary : null
      if (!summary) {
        // 降级：Host 明确说 summary=null（聚合失败时故意给 null 而不是空对象，
        // 免得被读成「全是 0」）。这里照抄那个判断，不给假数字。
        return h(Blank, {
          title: tr('stats.unavailable'),
          hint: tr('stats.noSummary'),
          action: h('button', { type: 'button', className: 'dsh-sa-btn', onClick: props.onRetry }, tr('stats.retry')),
        })
      }
      const outcome = summary.outcome && typeof summary.outcome === 'object' ? summary.outcome : {}
      const durations = summary.durations && typeof summary.durations === 'object' ? summary.durations : {}
      const parallel = summary.parallel && typeof summary.parallel === 'object' ? summary.parallel : {}
      const settled = num(outcome.settled, 0)
      const completionBase = num(outcome.completionBase, 0)
      const sampleLow = Boolean(settled > 0 && settled < 5)
      /**
       * 「分母 / 样本」这一行。
       *
       * 完成率的分母与「已结算」不是同一个数（取消不进分母），所以两个都写出来：
       * 只写一个会让另一个永远查不到（§八.1「所有比例可追到分子分母」）。
       */
      const denomSub = function (part, whole) {
        return fill(tr('card.denom'), { n: whole }) + (part !== undefined ? ' · ' + String(part) : '')
      }
      const sampleSub = function (count) {
        const base = fill(tr('card.sample'), { n: count })
        return sampleLow ? base + ' · ' + tr('scope.lowBadge') : base
      }

      const resultCards = [
        h(EffectCard, {
          key: 'done', id: 'done', label: tr('eff.done'), hint: tr('eff.doneHint'),
          value: countText(outcome.done, settled), tone: 'ok',
        }),
        h(EffectCard, {
          key: 'rate', id: 'rate', label: tr('eff.rate'), hint: tr('eff.rateHint'),
          value: percentText(outcome.completionRate),
          // 完成率的分母是 COMPLETION_BASE（不含取消），与「已结算」分开写。
          sub: fill(tr('card.denom'), { n: completionBase }),
        }),
        h(EffectCard, {
          key: 'first', id: 'first', label: tr('eff.first'), hint: tr('eff.firstHint'),
          value: percentText(outcome.firstPassRate),
          sub: fill(tr('card.denom'), { n: num(outcome.firstAttemptCount, 0) }),
        }),
        h(EffectCard, {
          key: 'rework', id: 'rework', label: tr('eff.rework'), hint: tr('eff.reworkHint'),
          value: percentText(outcome.reworkRate),
          sub: fill(tr('card.denom'), { n: num(outcome.dispatched, 0) }),
        }),
        h(EffectCard, {
          key: 'throughput', id: 'throughput', label: tr('eff.throughput'), hint: tr('eff.throughputHint'),
          value: typeof outcome.throughput?.perDay === 'number' && Number.isFinite(outcome.throughput.perDay)
            ? fill(tr('eff.perDay'), { value: Math.round(outcome.throughput.perDay * 100) / 100 })
            : tr('stat.none'),
          sub: outcome.throughput && outcome.throughput.days ? String(outcome.throughput.days) + ' d' : '',
        }),
        h(EffectCard, {
          key: 'saved', id: 'saved', label: tr('eff.saved'), hint: tr('eff.savedHint'),
          value: parallel.savedMs === null || parallel.savedMs === undefined ? tr('stat.none') : durationText(parallel.savedMs),
          sub: tr('eff.estimate') + ' · ' + fill(tr('par.sample'), { n: num(parallel.sample, 0) }),
        }),
      ]

      /**
       * 速度卡：三个分布各给 P50/P90。
       *
       * P50 看典型、P90 看长尾，**不给平均数**（plans/09 §四 B）：一个 40 分钟的
       * 任务能把平均拉到完全不像「这一条算不算慢」的基线。`card.p50` / `card.p90`
       * 是文字标签，不靠位置猜（§八.8 颜色/位置之外要有文字）。
       */
      const speedCard = function (id, label, hint, dist) {
        const p50 = dist && Number.isFinite(dist.p50) ? durationText(dist.p50) : tr('stat.none')
        const p90 = dist && Number.isFinite(dist.p90) ? durationText(dist.p90) : tr('stat.none')
        const count = num(dist && dist.count, 0)
        return h(EffectCard, {
          key: id,
          id: id,
          label: label,
          hint: hint,
          value: p50,
          sub: tr('card.p90') + ' ' + p90 + ' · ' + fill(tr('card.sample'), { n: count })
            + (dist && dist.sampleLow ? ' · ' + tr('scope.lowBadge') : ''),
        })
      }
      const speedCards = [
        speedCard('queueWait', tr('speed.queue'), tr('speed.queueHint'), durations.queueWait),
        speedCard('occupied', tr('speed.occupied'), tr('speed.occupiedHint'), durations.occupied),
        speedCard('endToEnd', tr('speed.endToEnd'), tr('speed.endToEndHint'), durations.endToEnd),
      ]

      /*
       * 稳定卡：失败 / 阻塞 / 中断 / 取消 / 重试后恢复。
       *
       * 前三项各自一个卡（plans/09 §四 A：「三项分开，不能用『失败』一个词覆盖」）；
       * 取消单列且分母是「全部已结算（含取消）」，与完成率的分母不同——
       * 共用分母等于把「用户改了主意」算成「任务没做成」。
       */
      const stableCards = [
        h(EffectCard, { key: 'failed', id: 'failed', label: tr('status.failed'), value: countText(outcome.failed, settled), sub: percentText(outcome.failureRate), tone: outcome.failed > 0 ? 'fail' : undefined }),
        h(EffectCard, { key: 'blocked', id: 'blocked', label: tr('status.blocked'), value: countText(outcome.blocked, settled), sub: percentText(outcome.blockRate), tone: outcome.blocked > 0 ? 'warn' : undefined }),
        h(EffectCard, { key: 'interrupted', id: 'interrupted', label: tr('status.interrupted'), value: countText(outcome.interrupted, settled), sub: percentText(outcome.interruptedRate), tone: outcome.interrupted > 0 ? 'warn' : undefined }),
        h(EffectCard, {
          key: 'cancelled', id: 'cancelled', label: tr('status.cancelled'), hint: tr('eff.cancelHint'),
          value: countText(outcome.cancelled, settled),
          // 取消率的分母是 settled（含取消本身），显式写出来免得被当成完成率的分母。
          sub: percentText(outcome.cancelRate) + ' · ' + fill(tr('card.denom'), { n: settled }),
        }),
        h(EffectCard, {
          key: 'recovery', id: 'recovery', label: tr('st.recovery'), hint: tr('st.recoveryHint'),
          value: percentText(outcome.recoveryRate),
          sub: fill(tr('card.denom'), { n: num(outcome.retriedCount, 0) }),
        }),
      ]

      /*
       * 并行区：占用总和 / 墙钟跨度 / 并行节省 / 并行倍数。
       *
       * 四个数一起给，是因为「节省」单独看没有意义：占用总和 4 小时、墙钟 2 小时
       * 才说明省了 2 小时；只给一个 2 小时读者无法复核。`estimated` 恒真，
       * 所以「估算」这个词是常驻标签而不是条件渲染——它不是工时结算。
       */
      const parallelCards = [
        h(EffectCard, { key: 'p-occupied', id: 'occupied-total', label: tr('par.occupied'), hint: tr('par.occupiedHint'), value: parallel.occupiedMs === null || parallel.occupiedMs === undefined ? tr('stat.none') : durationText(parallel.occupiedMs) }),
        h(EffectCard, { key: 'p-wall', id: 'wall', label: tr('par.wall'), hint: tr('par.wallHint'), value: parallel.wallMs === null || parallel.wallMs === undefined ? tr('stat.none') : durationText(parallel.wallMs) }),
        h(EffectCard, { key: 'p-saved', id: 'saved-total', label: tr('eff.saved'), hint: tr('eff.savedHint'), value: parallel.savedMs === null || parallel.savedMs === undefined ? tr('stat.none') : durationText(parallel.savedMs), sub: tr('eff.estimate') }),
        h(EffectCard, { key: 'p-factor', id: 'factor', label: tr('par.factor'), hint: tr('par.factorHint'), value: factorText(parallel.factor), sub: tr('eff.estimate') }),
      ]
      /*
       * 「为什么这个数字更粗」：Host 把原因放在 `parallel.reasons` 里（都是可核对的事实，
       * 不是形容词）。原样翻成一句人话，不合并成一个「不太准」的形容词。
       */
      const reasonList = Array.isArray(parallel.reasons) ? parallel.reasons : []
      const reasonsText = reasonList.length
        ? fill(tr('par.reasons'), {
            list: reasonList.map(function (reason) {
              const key = 'par.reason.' + reason
              const text = tr(key)
              // tr() 缺键时原样返回键名：这里把机器键露出来也好过编一个「未知」。
              return text === key ? String(reason) : text
            }).join(' · '),
          })
        : ''

      return h(
        'div',
        { className: 'dsh-sa-view', 'data-view': 'effect' },
        h(CardGroup, {
          id: 'result', title: tr('eff.result'), hint: sampleLow ? tr('scope.lowBadge') : '',
        }, resultCards),
        h(CardGroup, { id: 'speed', title: tr('eff.speed'), hint: '' }, speedCards),
        h(CardGroup, { id: 'stable', title: tr('eff.stable'), hint: tr('eff.stableHint') }, stableCards),
        h(
          'section',
          { className: 'dsh-sa-cardgroup', 'data-group': 'trend' },
          h(
            'div',
            { className: 'dsh-sa-cardgroup-head' },
            h('span', { className: 'dsh-sa-cardgroup-title' }, tr('eff.trend')),
            h('span', { className: 'dsh-sa-grow' }),
            h(TrendToggle, { mode: props.trendMode, onChange: props.onTrendMode }),
          ),
          h(TrendBlock, { days: stats && Array.isArray(stats.daily) ? stats.daily : [], mode: props.trendMode }),
        ),
        h(CardGroup, { id: 'parallel', title: tr('eff.parallel'), hint: tr('eff.estimate') }, parallelCards),
        reasonsText ? h('div', { className: 'dsh-sa-dim' }, h('span', { className: 'dsh-sa-dim-note' }, reasonsText)) : null,
      )
    }

    /**
     * 拆解视图（plans/09 §五.3）。
     *
     * 四张表/条：工作区（可切两个维度）、批次、主会话、状态与退休原因横向条形。
     * 表头必须写明当前口径：**派发目标 `workspace_id`** 与 **实际归属
     * `host_workspace_id`** 是两件事，混用会让「这个工作区为什么 0 完成」
     * 得到两种互相矛盾的答案（§三.3、§八.4）。
     */
    function BreakdownView(props) {
      const stats = props.stats
      const groups = stats && stats.groups && typeof stats.groups === 'object' ? stats.groups : null
      if (!groups) {
        return h(Blank, {
          title: tr('stats.unavailable'),
          hint: tr('stats.noSummary'),
          action: h('button', { type: 'button', className: 'dsh-sa-btn', onClick: props.onRetry }, tr('stats.retry')),
        })
      }
      const workspaces = groups.workspaces && typeof groups.workspaces === 'object' ? groups.workspaces : {}
      const dimension = workspaces.dimension && typeof workspaces.dimension === 'object' ? workspaces.dimension : null
      const rowsOf = function (kind) {
        if (kind === 'host') return Array.isArray(workspaces.byHost) ? workspaces.byHost : []
        return Array.isArray(workspaces.byTarget) ? workspaces.byTarget : []
      }
      const dim = props.dimension === 'host' ? 'host' : 'target'
      const wsRows = rowsOf(dim)
      const batches = Array.isArray(groups.batches) ? groups.batches : []
      const sessions = Array.isArray(groups.parentSessions) ? groups.parentSessions : []
      const statuses = Array.isArray(groups.statuses) ? groups.statuses : []
      const retired = Array.isArray(groups.retiredReasons) ? groups.retiredReasons : []
      /*
       * 口径文字**从 Host 给的字段名拼**（`workspace_id` / `host_workspace_id`），
       * 不在前端抄一份：字段改名时这里会跟着变，抄一份的结果是表头永远落后一拍。
       */
      const dimField = dimension
        ? (dim === 'host' ? dimension.host : dimension.target)
        : (dim === 'host' ? 'host_workspace_id' : 'workspace_id')
      const dimLabel = dim === 'host' ? tr('br.dimHost') : tr('br.dimTarget')

      /** 三张表共用的行：名字列 + 数字列，整行可点下钻。 */
      const table = function (key, columns, rows, build, kind) {
        if (!rows.length) {
          return h(Blank, { title: tr('br.empty'), hint: tr('br.emptyHint') })
        }
        return h(
          'div',
          { className: 'dsh-sa-tablewrap' },
          h(
            'table',
            { className: 'dsh-sa-table', 'data-table': key },
            h(DrillHead, { columns: columns }),
            h('tbody', null, rows.map(function (row, index) {
              const cells = build(row)
              const drill = drillOf(kind, row)
              return h(DrillRow, {
                key: (row.workspaceId || row.hostWorkspaceId || row.group || row.parentSessionId || 'r') + index,
                cells: cells,
                hint: drill ? fill(tr('br.rowHint'), { name: drill.name }) : undefined,
                onPick: drill && props.onDrill ? function () { props.onDrill(drill) } : undefined,
              })
            })),
          ),
        )
      }

      const rateCell = function (rate, denominator) {
        return percentText(rate) + (denominator !== undefined ? ' / n=' + denominator : '')
      }

      const workspaceTable = h(
        'section',
        { className: 'dsh-sa-cardgroup', 'data-group': 'workspaces' },
        h(
          'div',
          { className: 'dsh-sa-cardgroup-head' },
          h('span', { className: 'dsh-sa-cardgroup-title' }, tr('br.workspaces')),
          h('span', { className: 'dsh-sa-grow' }),
          h(
            'span',
            { className: 'dsh-sa-toggle', role: 'group', 'aria-label': tr('br.workspaces') },
            [
              { id: 'target', label: tr('br.dimTarget'), hint: tr('br.dimTargetHint') },
              { id: 'host', label: tr('br.dimHost'), hint: tr('br.dimHostHint') },
            ].map(function (item) {
              return h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'dsh-sa-tab',
                  'aria-pressed': dim === item.id,
                  'aria-selected': dim === item.id,
                  'data-dim': item.id,
                  title: item.hint,
                  onClick: function () { props.onDimension(item.id) },
                },
                item.label,
              )
            }),
          ),
        ),
        // 表头写明当前口径：两个工作区维度不混用（§三.3），这一行就是那条断言的界面证据。
        h('div', { className: 'dsh-sa-dim' },
          h('span', { className: 'dsh-sa-dim-note' }, fill(tr('br.dimNote'), { label: dimLabel, field: dimField }))),
        table(
          'workspaces',
          [
            tr('br.col.name'), tr('br.col.running'), tr('br.col.queued'), tr('br.col.done'),
            tr('br.col.rate'), tr('br.col.median'), tr('br.col.failed'), tr('br.col.blocked'),
            tr('br.col.saved'), tr('br.col.last'),
          ],
          wsRows,
          function (row) {
            return [
              row.title || row.workspaceId || row.hostWorkspaceId || tr('br.noName'),
              String(num(row.running, 0)),
              String(num(row.queued, 0)),
              countText(row.done, num(row.settled, 0)),
              rateCell(row.completionRate, num(row.settled, 0)),
              row.medianOccupiedMs === null || row.medianOccupiedMs === undefined ? tr('stat.none') : durationText(row.medianOccupiedMs),
              String(num(row.failed, 0)),
              String(num(row.blocked, 0)),
              row.savedMs === null || row.savedMs === undefined ? tr('stat.none') : durationText(row.savedMs),
              row.lastActivityAt ? formatRelative(row.lastActivityAt, props.now) : tr('stat.none'),
            ]
          },
          'workspace',
        ),
      )

      const batchTable = h(
        'section',
        { className: 'dsh-sa-cardgroup', 'data-group': 'batches' },
        h('div', { className: 'dsh-sa-cardgroup-head' },
          h('span', { className: 'dsh-sa-cardgroup-title' }, tr('br.batches')),
          h('span', { className: 'dsh-sa-cardgroup-title' }, tr('br.wallHint'))),
        table(
          'batches',
          [
            tr('br.col.batch'), tr('br.col.progress'), tr('br.col.running'), tr('br.col.pending'),
            tr('br.col.wall'), tr('br.col.saved'), tr('br.col.last'),
          ],
          batches,
          function (row) {
            const total = num(row.total, num(row.dispatched, 0))
            const done = num(row.done, 0)
            // 待处理 = 失败 + 阻塞 + 中断，与总览「需要你处理」同一口径（§八.1）。
            const pending = num(row.failed, 0) + num(row.blocked, 0) + num(row.interrupted, 0)
            return [
              row.group || tr('br.noName'),
              done + '/' + total,
              String(num(row.running, 0)),
              String(pending),
              row.wallClockMs === null || row.wallClockMs === undefined ? tr('stat.none') : durationText(row.wallClockMs),
              row.savedMs === null || row.savedMs === undefined ? tr('stat.none') : durationText(row.savedMs),
              row.lastActivityAt ? formatRelative(row.lastActivityAt, props.now) : tr('stat.none'),
            ]
          },
          'batch',
        ),
      )

      const sessionTable = h(
        'section',
        { className: 'dsh-sa-cardgroup', 'data-group': 'sessions' },
        h('div', { className: 'dsh-sa-cardgroup-head' },
          h('span', { className: 'dsh-sa-cardgroup-title' }, tr('br.sessions'))),
        table(
          'sessions',
          [
            tr('br.col.session'), tr('br.col.dispatched'), tr('br.col.running'), tr('br.col.done'),
            tr('br.col.rate'), tr('br.col.failedCount'), tr('br.col.last'),
          ],
          sessions,
          function (row) {
            return [
              row.parentSessionId || tr('br.noName'),
              String(num(row.dispatched, 0)),
              String(num(row.running, 0)),
              countText(row.done, num(row.settled, 0)),
              rateCell(row.completionRate, num(row.settled, 0)),
              String(num(row.failed, 0)),
              row.lastActivityAt ? formatRelative(row.lastActivityAt, props.now) : tr('stat.none'),
            ]
          },
          'parent',
        ),
      )

      /*
       * 状态与退休原因：横向条形列表，**不用九色 donut**（§五.3）。
       *
       * 状态条可点（下钻到该状态），退休原因条不可点：退休留痕没有可回查的任务行，
       * 点开只会得到一个空列表——那比不可点更糟。
       */
      const statusRows = statuses.map(function (row) {
        return { status: row.status, count: num(row.count, 0), share: row.share }
      })
      const retiredRows = retired.map(function (row) {
        return { reason: row.reason, count: num(row.count, 0) }
      })
      const distribution = h(
        'section',
        { className: 'dsh-sa-cardgroup', 'data-group': 'distribution' },
        h('div', { className: 'dsh-sa-cardgroup-head' },
          h('span', { className: 'dsh-sa-cardgroup-title' }, tr('br.distribution'))),
        h('div', { className: 'dsh-sa-subhead' }, tr('br.statusTitle')),
        h(DistRows, {
          rows: statusRows,
          empty: tr('br.statusEmpty'),
          labelOf: function (row) { return tr('status.' + row.status) },
          toneOf: function (row) {
            if (row.status === 'done') return 'dsh-sa-dist-fill-ok'
            if (row.status === 'failed') return 'dsh-sa-dist-fill-fail'
            if (row.status === 'blocked' || row.status === 'interrupted') return 'dsh-sa-dist-fill-warn'
            return ''
          },
          pickHint: function (label) { return fill(tr('br.rowHint'), { name: label }) },
          onPick: props.onDrill
            ? function (row) {
                const drill = drillOf('status', row)
                if (drill) props.onDrill(drill)
              }
            : undefined,
        }),
        h('div', { className: 'dsh-sa-subhead' }, tr('br.retiredTitle')),
        h('div', { className: 'dsh-sa-dim' }, h('span', { className: 'dsh-sa-dim-note' }, tr('br.retiredHint'))),
        h(DistRows, {
          rows: retiredRows,
          empty: tr('br.retiredEmpty'),
          labelOf: function (row) {
            const known = { 'cap-count': 'retired.reason.cap-count', 'cap-days': 'retired.reason.cap-days' }
            return known[row.reason] ? tr(known[row.reason]) : String(row.reason || tr('retired.reason.none'))
          },
        }),
      )

      const empty = !wsRows.length && !batches.length && !sessions.length && !statuses.length && !retiredRows.length
      return h(
        'div',
        { className: 'dsh-sa-view', 'data-view': 'breakdown' },
        empty ? h(Blank, { title: tr('br.empty'), hint: tr('br.emptyHint') }) : [
          workspaceTable, batchTable, sessionTable, distribution,
        ],
      )
    }

    /* ───────────────────── 历史视图与任务详情抽屉（plans/09 §五.4 · P2） ───────────────────── */

    /**
     * 一页多少条历史。
     *
     * §五.4 要求「表格替代无限长卡片列表，超过 50 条分页或分段加载」：50 条正好
     * 是「滚一屏能读完」与「翻页不频繁」的折中。/board 快照本身最多 200 条
     * （`MAX_TASKS`），所以最坏也就 4 页，不需要做虚拟滚动那一套。
     */
    const HISTORY_PAGE_SIZE = 50

    /** 历史子视图：全部 / 已归档 / 已退休（与 §五.4 的三个子视图逐字对应）。 */
    const HISTORY_TABS = [
      { id: 'all', labelKey: 'hist.sub.all' },
      { id: 'archived', labelKey: 'hist.sub.archived' },
      { id: 'retired', labelKey: 'hist.sub.retired' },
    ]

    /**
     * 历史排序键。
     *
     * 顺序就是 §五.4 写的「创建 / 结算 / 耗时 / 状态」；`status` 的标签复用状态筛选
     * 那一个键（同一个词，不新造文案），所以这里只列四个 id。
     */
    const HISTORY_SORTS = [
      { id: 'created', labelKey: 'hist.sort.created' },
      { id: 'settled', labelKey: 'hist.sort.settled' },
      { id: 'elapsed', labelKey: 'hist.sort.elapsed' },
      { id: 'status', labelKey: 'hist.status' },
    ]

    /** 解析快照里的 ISO 时间戳；解析不出来一律 NaN（=「没有记录」），绝不当成 0。 */
    function timeAt(stamp) {
      const at = typeof stamp === 'string' ? Date.parse(stamp) : NaN
      return Number.isFinite(at) ? at : NaN
    }

    /**
     * 把两种数据源归一成一行历史记录。
     *
     * 为什么要归一：活表与归档任务来自 `/board` 快照（`boardTask()` 的 snake_case
     * 投影），退休留痕来自 `/board/retired`（`retiredEntry()`）。两者字段不同，
     * 直接混进一个数组排序时，「退休行没有 created_at」会被 `|| 0` 变成
     * 「1970 年创建」，于是退休记录永远排在最后 —— 而用户刚想找的恰恰是它。
     *
     * 归一之后**缺字段仍然是 null**，由渲染层写「没有记录」，
     * 不用一个能参与比较的假时间去填空。
     */
    function historyRowOf(source, kind) {
      const record = source && typeof source === 'object' ? source : {}
      const retired = kind === 'retired'
      return {
        kind: retired ? 'retired' : 'task',
        task_id: typeof record.task_id === 'string' ? record.task_id : '',
        title: typeof record.title === 'string' ? record.title : '',
        status: typeof record.status === 'string' ? record.status : '',
        created_at: retired ? null : (record.created_at || null),
        started_at: retired ? null : (record.started_at || null),
        settled_at: retired ? null : (record.settled_at || null),
        time_basis: retired ? null : (record.time_basis || null),
        /*
         * 退休留痕没有结算时刻，它只有「被移出账本」的那一刻（§三.2 的 retiredAt）。
         * 这里另起字段而不是塞进 settled_at：把退休写成结算，等于断言它「做完了」。
         */
        retired_at: retired ? (record.retired_at || null) : null,
        retired_reason: retired ? (record.retired_reason || null) : null,
        archived_at: record.archived_at || null,
        frozen_at: record.frozen_at || null,
        elapsed_ms: retired ? null : num(record.elapsed_ms, null),
        attempt: num(record.attempt, 1),
        group: typeof record.group === 'string' ? record.group : '',
        workspace_id: record.workspace_id || null,
        workspace_title: record.workspace_title || null,
        host_workspace_id: record.host_workspace_id || null,
        host_workspace_title: record.host_workspace_title || null,
        worker_session_id: record.worker_session_id || null,
        report_count: num(record.report_count, 0),
        last_report: record.last_report && typeof record.last_report === 'object' ? record.last_report : null,
        last_text_preview: typeof record.last_text_preview === 'string' ? record.last_text_preview : '',
        background: record.background && typeof record.background === 'object' ? record.background : null,
        background_killed: record.background_killed || null,
        input_pending_at: record.input_pending_at || null,
        input_read_at: record.input_read_at || null,
        input_unknown_at: record.input_unknown_at || null,
        error: typeof record.error === 'string' ? record.error : '',
        archive_error: typeof record.archive_error === 'string' ? record.archive_error : '',
        cwd: typeof record.cwd === 'string' ? record.cwd : '',
        task_dir: typeof record.task_dir === 'string' ? record.task_dir : '',
        prepare_at: record.prepare_at || null,
        /*
         * 依赖（PRD-02 §4.5）：抽屉要说「前置：A、B」「当前等待：A（运行中）」
         * 「未执行原因：前置 A 失败」。这里是**白名单**归一，不补就会在抽屉里
         * 安静地少掉一整块——历史行是唯一能打开抽屉的地方。
         *
         * 退休留痕是薄记录（没有依赖边），一律给空值而不是去猜。
         */
        depends_on: retired ? [] : (Array.isArray(record.depends_on) ? record.depends_on : []),
        blocked_by: retired ? null : (typeof record.blocked_by === 'string' ? record.blocked_by : null),
        blocked_reason: retired ? null : (typeof record.blocked_reason === 'string' ? record.blocked_reason : null),
        cancel_reason: retired ? null : (typeof record.cancel_reason === 'string' ? record.cancel_reason : null),
        error_code: retired ? null : (typeof record.error_code === 'string' ? record.error_code : null),
        /*
         * 计划（PRD-01 §4.3 / A7 §11.3）：抽屉里也要能说「计划 2/5」与「计划已更新」。
         * 与依赖字段同一个理由——这里是**白名单**归一，不补的话计划块在抽屉里
         * 永远是空的（`planTotal = 0`），而历史是唯一能打开抽屉的地方。
         */
        plan_total: retired ? 0 : num(record.plan_total, 0),
        plan_done: retired ? 0 : num(record.plan_done, 0),
        plan_current: retired ? '' : (typeof record.plan_current === 'string' ? record.plan_current : ''),
        // 退休留痕只剩最后一条摘要：账本封顶的目的就是让写放大有上界。
        summary: retired && typeof record.summary === 'string' ? record.summary : '',
      }
    }

    /**
     * 这一行「结束」在哪一刻：已结算任务取 `settled_at`，退休留痕取 `retired_at`。
     *
     * 两个都解析不出来就返回 NaN —— 排序时排到末尾，而不是冒充
     * 「很久以前结束的」，那会让「最老的记录」这一列全是时间未知的行。
     */
    function historyEndAt(row) {
      const settled = timeAt(row && row.settled_at)
      if (Number.isFinite(settled)) return settled
      return timeAt(row && row.retired_at)
    }

    /**
     * 搜索：task_id、标题、worker_session_id、工作区（§五.4 列的四个字段）。
     *
     * 工作区**两个维度都算命中**：用户记得的是「派到 A」还是「实际挂在 B」，
     * 在搜索框里是同一个念头；只搜一个维度会让另一个维度上的记忆搜不到自己那行。
     * 大小写不敏感，空查询恒真（= 不筛）。
     */
    function historyMatches(row, query) {
      const needle = String(query == null ? '' : query).trim().toLowerCase()
      if (!needle) return true
      const haystack = [
        row.task_id, row.title, row.worker_session_id,
        row.workspace_id, row.workspace_title, row.host_workspace_id, row.host_workspace_title,
      ].filter(function (value) { return typeof value === 'string' && value })
        .join('\n')
        .toLowerCase()
      return haystack.indexOf(needle) >= 0
    }

    /**
     * 历史视图的筛选（与搜索取交集）。
     *
     * `since` 是一个**时刻**而不是窗口键：窗口键由调用方用既有的 `windowDaysOf()`
     * 换算，这里不重新定义「7 天」是多少毫秒。
     *
     * 退休留痕没有 createdAt，时间筛选改用 `retired_at`：否则「最近 7 天」里永远
     * 看不到它们，而刚被退休的那批正是用户最想问「它去哪了」的。
     * 两边时间都未知的行**不因为「不知道」被丢掉**——留在列表里让读者自己看到
     * 「没有记录」，比静默消失在筛选里诚实（§八.6）。
     */
    function filterHistoryRows(rows, filters) {
      const state = filters || {}
      const since = typeof state.since === 'number' && Number.isFinite(state.since) ? state.since : NaN
      return rows.filter(function (row) {
        if (state.status && row.status !== state.status) return false
        if (state.workspace && row.workspace_id !== state.workspace) return false
        if (state.retried && num(row.attempt, 1) <= 1) return false
        if (state.background && !row.background) return false
        if (Number.isFinite(since)) {
          const created = timeAt(row.created_at)
          const basis = Number.isFinite(created) ? created : timeAt(row.retired_at)
          if (Number.isFinite(basis) && basis < since) return false
        }
        return true
      })
    }

    /**
     * 排序。
     *
     * 四个键都**先比「有没有这个时间／数」**再比值：把缺字段当成 0 会让这些行
     * 固定钉在一端，看起来像「有一批 1970 年的任务」。NaN 一律排到末尾，
     * 同值时按 task_id 倒序，保证同一份快照每次渲染顺序一致（不然 2 秒轮询会
     * 让行在视觉上跳来跳去）。
     */
    function sortHistoryRows(rows, key) {
      const ordered = rows.slice()
      if (key === 'status') {
        // 状态序沿用 STATUS_META 的展示序（running → queued → …），不在这里再抄一份。
        const rank = Object.keys(STATUS_META)
        ordered.sort(function (a, b) {
          const left = rank.indexOf(a.status)
          const right = rank.indexOf(b.status)
          // 认不出的状态排最后，而不是当成第 0 个（那会让未知状态排最前）。
          return (left < 0 ? rank.length : left) - (right < 0 ? rank.length : right)
            || String(b.task_id).localeCompare(String(a.task_id))
        })
        return ordered
      }
      const valueOf = function (row) {
        if (key === 'settled') return historyEndAt(row)
        if (key === 'elapsed') return num(row.elapsed_ms, NaN)
        return timeAt(row.created_at)
      }
      ordered.sort(function (a, b) {
        const left = valueOf(a)
        const right = valueOf(b)
        const leftKnown = Number.isFinite(left)
        const rightKnown = Number.isFinite(right)
        if (leftKnown && rightKnown) return right - left
        if (leftKnown) return -1
        if (rightKnown) return 1
        return String(b.task_id).localeCompare(String(a.task_id))
      })
      return ordered
    }

    /** 「没有记录」的统一写法：`n=0` 与「字段不存在」都不能靠 em dash 偷偷混过去。 */
    function stampText(stamp, now) {
      const at = timeAt(stamp)
      if (!Number.isFinite(at)) return tr('drawer.noTime')
      return formatRelative(stamp, now)
    }

    /**
     * 历史表格里的一行。
     *
     * 行本身可点 = 打开**详情抽屉**（不是打开子会话）：本视图要回答的是
     * 「这条任务发生了什么」，跳走会打断比较。打开子会话的入口在抽屉里，
     * 且只在真的有活会话时出现（§五.4「退休行不假装能打开子会话」）。
     */
    function HistoryRow(props) {
      const row = props.row
      const statusMeta = STATUS_META[row.status] || STATUS_FALLBACK
      const archived = Boolean(row.archived_at)
      const retired = row.kind === 'retired'
      const tags = []
      if (retired) tags.push(h('span', { key: 'retired', className: 'dsh-sa-tag dsh-sa-tag-retired' }, tr('filter.retired')))
      if (archived) tags.push(h('span', { key: 'archived', className: 'dsh-sa-tag dsh-sa-tag-archived' }, tr('archivedTag')))
      if (row.group) tags.push(h('span', { key: 'group', className: 'dsh-sa-tag dsh-sa-tag-group' }, tr('groupTag')))
      if (num(row.attempt, 1) > 1) {
        tags.push(h('span', { key: 'attempt', className: 'dsh-sa-tag' }, tr('attemptPrefix') + num(row.attempt, 1) + tr('attemptSuffix')))
      }
      if (row.background) {
        tags.push(h('span', { key: 'bg', className: 'dsh-sa-tag dsh-sa-tag-bg', title: tr('backgroundHint') }, tr('backgroundTag')))
      }
      /*
       * 「待读」与「未读未知」互斥，判据照抄 TaskCard（宿主侧已互斥，这里再加一道）：
       * 两个矛盾状态同时画出来，比只画错一个更糟。
       */
      const unread = Boolean(row.input_pending_at) && !row.input_read_at && !row.input_unknown_at
      const unknownRead = Boolean(row.input_unknown_at) && !row.input_read_at
      if (unread) tags.push(h('span', { key: 'unread', className: 'dsh-sa-tag dsh-sa-tag-unread', title: tr('unreadHint') }, tr('unreadTag')))
      if (unknownRead) {
        tags.push(h('span', { key: 'unknown', className: 'dsh-sa-tag dsh-sa-tag-unknown', title: tr('unknownReadHint') }, tr('unknownReadTag')))
      }

      const activate = function (event) {
        if (event) {
          if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
          if (event.preventDefault) event.preventDefault()
        }
        props.onSelect(row)
      }

      /*
       * 「结束」一列而不是「结算 / 退休」两列。
       *
       * 一条记录只有一个结束方式：已结算任务结束于 `settled_at`，退休留痕结束于
       * `retired_at`，还没结束的行（running/queued）两个都是空。拆成两列会让每一行
       * 永远有一半是 `—`，而表格宽度在面板里很紧张（真机预览里第六列被裁掉过）。
       * 内含的**标签**区分来源（「结算」/「退休」），不靠位置猜（§八.8）。
       */
      const endCell = function (row) {
        if (row.kind === 'retired') {
          // 退休原因的完整人话放在格子的 title 上：面板宽度不够时，一列里塞
          // 「时间 + 原因」会把整张表挤到需要横向滚动，而 hover 随时能读到。
          return h('span', null, [
            h('span', { key: 'k', className: 'dsh-sa-hist-tagkind' }, tr('drawer.st.retired')),
            ' ' + stampText(row.retired_at, props.now),
          ])
        }
        if (row.settled_at) {
          return h('span', null, [
            h('span', { key: 'k', className: 'dsh-sa-hist-tagkind' }, tr('drawer.st.settled')),
            ' ' + stampText(row.settled_at, props.now),
          ])
        }
        // 还没结算：写「没有记录」，不拿创建时刻冒充结束时刻（§八.6 不装全量）。
        return tr('stat.none')
      }
      /** 「结束」那一格的 title：退休写原因、结算写时间基准，其余为空（不编提示）。 */
      const endTitle = function (row) {
        if (row.kind === 'retired') return retiredReasonText(row.retired_reason)
        if (row.settled_at && row.time_basis === 'updatedAt-fallback') return timeBasisText(row.time_basis)
        return undefined
      }

      const retiredText = retired
        ? fill(tr('retired.ago'), { when: stampText(row.retired_at, props.now) }) + ' · ' + retiredReasonText(row.retired_reason)
        : tr('stat.none')

      return h(
        'tr',
        {
          className: 'dsh-sa-hist-row' + (archived || retired ? ' dsh-sa-hist-row-frozen' : ''),
          'data-history-row': row.task_id,
          'data-kind': row.kind,
          'data-status': row.status,
          'data-selected': props.selected ? 'true' : undefined,
          'aria-selected': props.selected ? true : undefined,
          tabIndex: 0,
          title: tr('drawer.title') + '\n' + row.task_id,
          onClick: activate,
          onKeyDown: activate,
        },
        h(
          'th',
          { scope: 'row', className: 'dsh-sa-table-name' },
          h('span', { className: 'dsh-sa-hist-title' }, row.title || tr('noTitle')),
          tags,
          h('code', { className: 'dsh-sa-id' }, row.task_id),
          // 退休行唯一的操作是复制 id：它没有可打开的子会话（§五.4）。
          retired
            ? h('button', {
                type: 'button',
                className: 'dsh-sa-btn',
                'data-history-copy': row.task_id,
                title: tr('retired.copyHint') + '：' + row.task_id,
                onClick: function (event) {
                  if (event && event.stopPropagation) event.stopPropagation()
                  props.onCopy(row)
                },
              }, tr('retired.action'))
            : null,
        ),
        h(
          'td',
          { className: 'dsh-sa-hist-status' },
          h('span', { className: 'dsh-sa-dot', style: { color: archived || retired ? 'var(--dsw-alias-label-tertiary, #8b8b8b)' : statusMeta.color }, 'aria-hidden': 'true' }),
          ' ',
          tr('status.' + row.status),
        ),
        h('td', { className: 'dsh-sa-hist-ws', title: [row.workspace_title || '', row.host_workspace_title || row.host_workspace_id || ''].filter(Boolean).join('\n') },
          workspaceTitleOf(row)),
        h('td', null, stampText(row.created_at, props.now)),
        h('td', { className: 'dsh-sa-hist-end', title: endTitle(row) }, endCell(row)),
        h('td', null, row.elapsed_ms === null || row.elapsed_ms === undefined ? tr('stat.none') : durationText(row.elapsed_ms)),
      )
    }

    /**
     * 任务详情抽屉（plans/09 §五.4 的七块）。
     *
     * 数据全部来自**已经拿到的快照／留痕**，没有任何一次额外请求：
     * 抽屉要能在一帧内打开，而且浏览器半边拿不到 `dispatch_inspect` 工具。
     * 快照里没有的字段（完整简报、完整报告正文、更早的报告）在这里**明说**
     * 「请用 dispatch_inspect <id>」，绝不拿最后一条摘要冒充完整正文（§八.9）。
     */
    function TaskDrawer(props) {
      const row = props.row
      const now = props.now
      const retired = row.kind === 'retired'
      const archived = Boolean(row.archived_at)
      /** 一块详情：标题 + 若干 label/value 行。`data-drawer-block` 给断言用。 */
      const block = function (id, title, children) {
        return h(
          'section',
          { className: 'dsh-sa-drawer-block', 'data-drawer-block': id, key: id },
          h('div', { className: 'dsh-sa-drawer-block-title' }, title),
          children,
        )
      }
      const kv = function (key, label, value, hint) {
        return h(
          'div',
          { className: 'dsh-sa-kv', key: key, title: hint || undefined },
          h('span', { className: 'dsh-sa-kv-label' }, label),
          h('span', { className: 'dsh-sa-kv-value' }, value),
        )
      }
      /** 有值就显示值，没值显示「没有记录」——不是空白，也不是 em dash 一笔带过。 */
      const valueOr = function (value, fallback) {
        if (value === null || value === undefined || value === '') return fallback || tr('drawer.noTime')
        return String(value)
      }

      /*
       * 生命周期五步（§五.4「创建 → 开始 → 报告 → 结算 → 归档/退休」）。
       * 每一步单独渲染、缺的一步写「没有记录」：用户要能一眼看出「它根本没开始」，
       * 而不是在一行挤在一起的时间戳里自己推算。
       */
      const steps = [
        { id: 'created', label: tr('drawer.st.created'), at: row.created_at },
        { id: 'started', label: tr('drawer.st.started'), at: row.started_at },
        { id: 'reported', label: tr('drawer.st.reported'), at: row.last_report ? row.last_report.at : null },
        { id: 'settled', label: tr('drawer.st.settled'), at: row.settled_at },
        { id: 'archived', label: tr('drawer.st.archived'), at: row.archived_at || row.frozen_at },
        { id: 'retired', label: tr('drawer.st.retired'), at: row.retired_at },
      ]
      const lifecycle = h(
        'ol',
        { className: 'dsh-sa-steps' },
        steps.map(function (step) {
          const known = Number.isFinite(timeAt(step.at))
          return h(
            'li',
            {
              key: step.id,
              className: 'dsh-sa-step' + (known ? '' : ' dsh-sa-step-missing'),
              'data-step': step.id,
              'data-step-known': known ? 'true' : 'false',
            },
            h('span', { className: 'dsh-sa-step-label' }, step.label),
            h('span', { className: 'dsh-sa-step-value' }, known ? stampText(step.at, now) : tr('drawer.noTime')),
          )
        }),
      )

      const briefId = row.task_id
      const scopeBlock = block('scope', tr('drawer.scope'), [
        kv('brief', tr('drawer.brief'), fill(tr('drawer.briefMissing'), { id: briefId }), fill(tr('drawer.briefMissing'), { id: briefId })),
        kv('cwd', tr('drawer.cwd'), valueOr(row.cwd, tr('workspaceFallback'))),
        kv('dir', tr('drawer.taskDir'), valueOr(row.task_dir)),
        kv(
          'target',
          tr('drawer.target'),
          row.workspace_title || row.workspace_id || tr('workspaceFallback'),
          row.workspace_id || '',
        ),
        kv(
          'host',
          tr('br.dimHost'),
          row.host_workspace_title || row.host_workspace_id || tr('workspaceFallback'),
          row.host_workspace_id || '',
        ),
      ])

      /*
       * 依赖（PRD-02 §4.5）：抽屉是「它在等谁 / 为什么没跑」唯一能说清的地方。
       * 三行分别对应 PRD 的三条文案：
       *   「前置：A、B」            → 它声明了哪些前置；
       *   「当前等待：A（运行中）」   → 此刻卡在哪一条、对面是什么状态；
       *   「未执行原因：前置 A 失败」 → 被连带取消时的终局原因。
       *
       * 只在真有依赖信息时出现；没有依赖的任务不生成空块（与 frozen_at 等同风格）。
       * 标题从 `props.depTitles` 查（同一份快照），查不到退回 id——不编一个假名字。
       */
      const depTitleOf = function (id) {
        const titles = props.depTitles || {}
        const raw = typeof titles[id] === 'string' && titles[id] ? titles[id] : id
        return raw.length > 12 ? raw.slice(0, 12) : raw
      }
      const depList = Array.isArray(row.depends_on) ? row.depends_on : []
      const depBlockedBy = typeof row.blocked_by === 'string' ? row.blocked_by : ''
      const depFailed = row.cancel_reason === 'dependency_failed'
      const depMissing = row.cancel_reason === 'dependency_missing'
      const depLines = []
      if (depList.length) {
        depLines.push(kv('deps', tr('dep.label'), depList.map(depTitleOf).join(tr('dep.join'))))
      }
      if (depBlockedBy && row.status === 'queued') {
        // 「当前等待」只对**还在排队**的任务成立：已结算的任务留着 blocked_by 只是
        // 留痕（抽屉的「未执行原因」会用同一个 id），再写「在等」会自相矛盾。
        // 机器值（running/failed/missing）必须翻成人话：抽屉是给人看的。
        const reasonText = row.blocked_reason === 'failed'
          ? tr('dep.reason.failed')
          : row.blocked_reason === 'missing'
            ? tr('dep.reason.missing')
            : tr('dep.reason.running')
        depLines.push(kv(
          'waiting',
          tr('dep.waitingLabel'),
          fill(tr('dep.waitingOn'), { title: depTitleOf(depBlockedBy), reason: reasonText }),
        ))
      }
      if (depFailed || depMissing) {
        const failingDep = depBlockedBy || (depList.length ? depList[0] : '')
        depLines.push(kv(
          'not-run',
          tr('dep.notRunLabel'),
          failingDep
            ? fill(depMissing ? tr('dep.notRunMissing') : tr('dep.notRun'), { title: depTitleOf(failingDep) })
            : tr('dep.none'),
        ))
      }
      const dependencyBlock = depLines.length ? block('deps', tr('dep.block'), depLines) : null

      const lastReport = row.last_report
      const reportLines = []
      /*
       * 计划进度（PRD-01 §4.3）：抽屉里给「计划 2/5」与当前步骤文案。
       *
       * 与任务行同一条显示优先级：只在 queued / running 时出现。宿主快照对已结算
       * 任务本来就不下发 plan_*（见 `boardTask()`），这里判状态是为了让「终态优先」
       * 在界面上是**读得到的规则**，而不是依赖快照恰好没给字段。
       */
      const planTotal = num(row.plan_total, 0)
      const planDone = num(row.plan_done, 0)
      const planCurrent = typeof row.plan_current === 'string' ? row.plan_current : ''
      if ((row.status === 'queued' || row.status === 'running') && planTotal > 0) {
        reportLines.push(kv('plan', tr('plan.label'), fill(tr('plan.ratio'), { done: planDone, total: planTotal })))
        /*
         * 「计划已更新」在抽屉里单独占一行（PRD §11.3）：行徽标只在列表里看得到，
         * 而用户点开抽屉时视线已经离开列表——同一件事不再说一次，就等于没提示。
         * 只在任务行也显示计划时才可能出现（`planTotal > 0` 且未结算），与行内一致。
         */
        if (props.planUpdated) {
          reportLines.push(kv('plan-updated', tr('plan.label'), tr('plan.updatedTag')))
        }
        if (planCurrent) reportLines.push(kv('plan-current', tr('plan.currentLabel'), planCurrent))
      }
      reportLines.push(kv('count', tr('drawer.reportCount'), String(num(row.report_count, 0))))
      if (lastReport) {
        const bits = [lastReport.at ? stampText(lastReport.at, now) : tr('drawer.noTime')]
        if (lastReport.status) bits.push(tr('status.' + lastReport.status))
        if (lastReport.summary) bits.push(firstLine(lastReport.summary))
        reportLines.push(kv('last', tr('drawer.lastReport'), bits.filter(Boolean).join(' · '), lastReport.summary || ''))
      } else {
        reportLines.push(kv('last', tr('drawer.lastReport'), tr('drawer.noTime')))
      }
      const outputText = row.last_text_preview
        || (retired && row.summary ? row.summary : '')
      reportLines.push(kv(
        'output',
        tr('drawer.lastOutput'),
        outputText ? firstLine(outputText) : tr('drawer.noTime'),
        outputText,
      ))
      const reportsBlock = block('reports', tr('drawer.reports'), reportLines)

      const faultLines = [
        kv('attempt', tr('drawer.attempt'), String(num(row.attempt, 1))),
        kv('retry', tr('drawer.retryAt'), row.last_report && row.last_report.status === 'retried' ? stampText(row.last_report.at, now) : tr('drawer.noTime')),
        kv('error', tr('drawer.error'), valueOr(row.error, tr('stat.none'))),
        kv('archiveError', tr('drawer.archiveError'), valueOr(row.archive_error, tr('stat.none'))),
        kv('frozen', tr('drawer.frozenAt'), row.frozen_at ? stampText(row.frozen_at, now) : tr('drawer.noTime')),
      ]
      const faultsBlock = block('faults', tr('drawer.faults'), faultLines)

      let deliveryText = tr('drawer.inputNone')
      if (row.input_read_at) deliveryText = tr('drawer.inputRead') + ' · ' + stampText(row.input_read_at, now)
      else if (row.input_pending_at) deliveryText = tr('drawer.inputPending') + ' · ' + stampText(row.input_pending_at, now)
      else if (row.input_unknown_at) deliveryText = tr('unknownReadTag') + ' · ' + stampText(row.input_unknown_at, now)
      const deliveryBlock = block('delivery', tr('drawer.delivery'), [
        kv('delivery', tr('drawer.delivery'), deliveryText, tr('unreadHint')),
      ])

      const backgroundLines = []
      if (row.background) {
        /*
         * 三行都写「数量」与「起点」这一个事实，标签不复述块标题：
         * 块标题已经写了「后台 job / subagent」，行标签再写一遍就是同一句话说两次。
         */
        backgroundLines.push(kv('jobs', tr('drawer.backgroundJobs'), String(num(row.background.jobs, 0))))
        backgroundLines.push(kv('subagents', tr('drawer.backgroundSubagents'), String(num(row.background.subagents, 0))))
        backgroundLines.push(kv(
          'since',
          tr('drawer.backgroundSinceLabel'),
          row.background.since ? stampText(row.background.since, now) : tr('drawer.noTime'),
        ))
      } else {
        backgroundLines.push(kv('none', tr('drawer.backgroundState'), tr('drawer.backgroundNone')))
      }
      if (row.background_killed) {
        backgroundLines.push(kv('killed', tr('drawer.backgroundKilled'), stampText(row.background_killed, now)))
      }
      const backgroundBlock = block('background', tr('drawer.background'), backgroundLines)

      const prepareBlock = block('prepare', tr('drawer.prepare'), [
        kv(
          'prepareAt',
          tr('drawer.prepareAtNoWhen'),
          row.prepare_at ? stampText(row.prepare_at, now) : tr('drawer.prepareNone'),
        ),
        kv('prepareDir', tr('drawer.taskDir'), valueOr(row.task_dir)),
      ])

      /*
       * 打开子会话：只有「有 worker_session_id、没归档、不是退休留痕」时才给按钮。
       * 三个条件缺一不可——归档会话会被宿主清成空白主视图（见 TaskCard 那段注释），
       * 退休留痕则连会话都不在了。其余情况只给复制 id，并说明为什么。
       */
      const canOpen = Boolean(row.worker_session_id) && !archived && !retired
      const footer = h(
        'div',
        { className: 'dsh-sa-drawer-foot' },
        canOpen
          ? h('button', {
              type: 'button',
              className: 'dsh-sa-btn dsh-sa-btn-primary',
              'data-drawer-open': row.task_id,
              onClick: function () { props.onOpen(row) },
            }, tr('drawer.openSession'))
          : h('button', {
              type: 'button',
              className: 'dsh-sa-btn',
              'data-drawer-copy': row.task_id,
              onClick: function () { props.onCopy(row) },
            }, tr('retired.action')),
        canOpen ? null : h('span', { className: 'dsh-sa-dim-note' }, tr('drawer.noSessionHint')),
        retired ? h('span', { className: 'dsh-sa-dim-note', 'data-drawer-retired-note': 'true' }, tr('drawer.retiredNote')) : null,
      )

      return h(
        'aside',
        {
          className: 'dsh-sa-drawer',
          role: 'complementary',
          'aria-label': tr('drawer.title'),
          'data-drawer': row.task_id,
          'data-drawer-kind': row.kind,
        },
        h(
          'div',
          { className: 'dsh-sa-drawer-head' },
          h('span', { className: 'dsh-sa-drawer-title' }, tr('drawer.title')),
          h('code', { className: 'dsh-sa-id' }, row.task_id),
          h('span', { className: 'dsh-sa-grow' }),
          h('button', {
            type: 'button',
            className: 'dsh-sa-btn',
            'data-drawer-close': 'true',
            onClick: function () { props.onClose() },
          }, tr('drawer.close')),
        ),
        h('div', { className: 'dsh-sa-drawer-body' }, [
          h('div', { className: 'dsh-sa-drawer-title2' }, row.title || tr('noTitle')),
          block('lifecycle', tr('drawer.lifecycle'), lifecycle),
          scopeBlock,
          dependencyBlock,
          reportsBlock,
          faultsBlock,
          deliveryBlock,
          backgroundBlock,
          prepareBlock,
          h('div', { className: 'dsh-sa-dim' },
            h('span', { className: 'dsh-sa-dim-note' }, fill(tr('drawer.fullTextHint'), { id: row.task_id }))),
          footer,
        ]),
      )
    }

    /**
     * 历史视图（plans/09 §五.4）。
     *
     * 布局固定为 **子视图 → 搜索与筛选 → 排序 → 表格 → 分页**，不按数据多少重排：
     * 每次进来都是同一个顺序，用户才知道往下滚能看到什么。
     *
     * 数据来源是 `/board` 快照（活表 + 已归档）与 `/board/retired`（退休留痕），
     * **不依赖 `/board/stats`**：统计挂了历史照样能用（§八.10 的降级要求）。
     */
    function HistoryView(props) {
      const rows = Array.isArray(props.rows) ? props.rows : []
      const total = num(props.total, 0)
      const page = num(props.page, 0)
      const pages = Math.max(1, num(props.pages, 1))
      const from = total > 0 ? page * HISTORY_PAGE_SIZE + 1 : 0
      const to = Math.min(total, (page + 1) * HISTORY_PAGE_SIZE)

      const subTabs = h(
        'div',
        { className: 'dsh-sa-tabs', role: 'tablist', 'aria-label': tr('hist.subLabel') },
        HISTORY_TABS.map(function (item) {
          return h('button', {
            key: item.id,
            type: 'button',
            role: 'tab',
            className: 'dsh-sa-tab',
            'aria-selected': props.sub === item.id,
            'data-hist-sub': item.id,
            title: tr('hist.subHint'),
            onClick: function () { props.onSub(item.id) },
          }, tr(item.labelKey))
        }),
      )

      const select = function (key, label, value, onChange, options, title) {
        return h(
          'label',
          { className: 'dsh-sa-hist-field', key: key, title: title || label },
          h('span', { className: 'dsh-sa-hist-field-label' }, label),
          h(
            'select',
            {
              className: 'dsh-sa-select',
              'data-hist-field': key,
              value: value,
              onChange: function (event) {
                onChange(event && event.target ? event.target.value : '')
              },
            },
            options,
          ),
        )
      }

      const statusOptions = [h('option', { key: '__all', value: '' }, tr('hist.statusAll'))]
        // 状态选项直接来自 STATUS_META 的键：那是客户端唯一一份状态表，
        // 不在这里抄第三份（抄的那份迟早与状态点/文案不同步）。
        .concat(Object.keys(STATUS_META).map(function (status) {
          return h('option', { key: status, value: status }, tr('status.' + status))
        }))

      const workspaceOptions = [h('option', { key: '__all', value: '' }, tr('workspaceAll'))]
        .concat((Array.isArray(props.workspaces) ? props.workspaces : []).map(function (item) {
          return h('option', { key: item.id, value: item.id }, item.title || item.id)
        }))

      const timeOptions = WINDOW_PRESETS.map(function (preset) {
        return h('option', { key: preset.id, value: preset.id }, windowChipLabel(preset))
      })

      const sortOptions = HISTORY_SORTS.map(function (item) {
        return h('option', { key: item.id, value: item.id }, tr(item.labelKey))
      })

      const toggle = function (key, label, pressed, onToggle, hint) {
        return h(
          'button',
          {
            key: key,
            type: 'button',
            className: 'dsh-sa-chip',
            'aria-pressed': pressed,
            'data-hist-toggle': key,
            title: hint || label,
            onClick: function () { onToggle(!pressed) },
          },
          label,
        )
      }

      const bar = h(
        'div',
        { className: 'dsh-sa-histbar' },
        h(
          'label',
          { className: 'dsh-sa-hist-field dsh-sa-hist-search', title: tr('hist.searchHint') },
          h('span', { className: 'dsh-sa-hist-field-label' }, tr('hist.search')),
          h('input', {
            type: 'search',
            className: 'dsh-sa-input',
            'data-hist-search': 'true',
            placeholder: tr('hist.searchHint'),
            value: props.query,
            onChange: function (event) {
              props.onQuery(event && event.target ? event.target.value : '')
            },
          }),
        ),
        select('status', tr('hist.status'), props.status, props.onStatus, statusOptions),
        select('workspace', tr('hist.workspace'), props.workspaceId, props.onWorkspace, workspaceOptions),
        select('time', tr('hist.time'), props.timeKey, props.onTime, timeOptions, tr('hist.timeHint')),
        select('sort', tr('hist.sort'), props.sort, props.onSort, sortOptions),
        toggle('retried', tr('hist.retried'), props.retried, props.onRetried),
        toggle('background', tr('hist.background'), props.background, props.onBackground),
        h('span', { className: 'dsh-sa-grow' }),
        h('button', {
          type: 'button',
          className: 'dsh-sa-btn',
          'data-hist-clear': 'true',
          onClick: function () { props.onClear() },
        }, tr('hist.clear')),
      )

      const notes = []
      if (props.truncated) {
        notes.push(h(
          'div',
          { key: 'cap', className: 'dsh-sa-strip dsh-sa-strip-warn', role: 'status', 'aria-live': 'polite' },
          h('span', { className: 'dsh-sa-strip-text', title: fill(tr('hist.cap'), { shown: num(props.truncated.shown, 0), total: num(props.truncated.total, 0) }) },
            fill(tr('hist.cap'), { shown: num(props.truncated.shown, 0), total: num(props.truncated.total, 0) })),
        ))
      }
      if (props.dropped > 0) {
        notes.push(h(
          'div',
          { key: 'dropped', className: 'dsh-sa-strip dsh-sa-strip-warn', role: 'status', 'aria-live': 'polite' },
          h('span', { className: 'dsh-sa-strip-text' }, fill(tr('retired.dropped'), { n: props.dropped })),
        ))
      }

      const table = rows.length
        ? h(
            'div',
            { className: 'dsh-sa-tablewrap' },
            h(
              'table',
              { className: 'dsh-sa-table dsh-sa-hist-table', 'data-table': 'history' },
              h(DrillHead, {
                columns: [
                  tr('hist.col.task'), tr('hist.col.status'), tr('hist.col.workspace'), tr('hist.col.created'),
                  tr('hist.col.end'), tr('hist.col.elapsed'),
                ],
              }),
              h('tbody', null, rows.map(function (row) {
                return h(HistoryRow, {
                  key: row.kind + ':' + row.task_id,
                  row: row,
                  now: props.now,
                  selected: Boolean(props.selected) && props.selected.task_id === row.task_id && props.selected.kind === row.kind,
                  onSelect: props.onSelect,
                  onCopy: props.onCopy,
                })
              })),
            ),
          )
        : h(Blank, { title: tr('hist.empty'), hint: props.emptyHint || tr('hist.subHint') })

      const pager = h(
        'div',
        { className: 'dsh-sa-pager' },
        h('span', { className: 'dsh-sa-meta', 'data-hist-range': 'true' },
          fill(tr('hist.page'), { from: from, to: to, n: total })),
        h('span', { className: 'dsh-sa-grow' }),
        h('span', { className: 'dsh-sa-meta' }, fill(tr('hist.total'), { n: total, total: num(props.rawTotal, total) })),
        h('button', {
          type: 'button',
          className: 'dsh-sa-btn',
          'data-hist-page': 'prev',
          disabled: page <= 0,
          onClick: function () { props.onPage(Math.max(0, page - 1)) },
        }, tr('hist.prev')),
        h('button', {
          type: 'button',
          className: 'dsh-sa-btn',
          'data-hist-page': 'next',
          disabled: page >= pages - 1,
          onClick: function () { props.onPage(Math.min(pages - 1, page + 1)) },
        }, tr('hist.next')),
      )

      return h(
        'div',
        { className: 'dsh-sa-view dsh-sa-hist', 'data-view': 'history', 'data-hist-view': props.sub },
        subTabs,
        bar,
        h('div', { className: 'dsh-sa-dim' }, h('span', { className: 'dsh-sa-dim-note' }, tr('hist.notOpenable'))),
        notes,
        table,
        pager,
        props.drawerRow
          ? h(TaskDrawer, {
              row: props.drawerRow,
              now: props.now,
              // 依赖短名表（PRD-02 §4.5）：抽屉里的「前置：A、B」按 id 查标题。
              depTitles: props.depTitles,
              // 「计划已更新」在抽屉里也要说一次（PRD §11.3：抽屉打开时同样显示）。
              planUpdated: Boolean(props.drawerPlanUpdated),
              onClose: props.onCloseDrawer,
              onCopy: props.onCopy,
              onOpen: props.onOpen,
            })
          : null,
      )
    }

    /* ───────────── 分析数据看板（与派发工作台平级的一块独立视图） ─────────────
     *
     * 架构上刻意让 **BoardPanel 持有全部 state / effect，AnalyticsView 是无 hook 的
     * 纯展示组件**：派发工作台是注册在 main 槽的根组件，它的 hook 顺序与既有离线
     * 冒烟（scripts/client-smoke.mjs 的迷你 React）一一对应；把状态放进嵌套组件，
     * 真机能跑，但离线断言就再也验证了「切筛选 → 数字跟着变」这件事。
     *
     * 数据只来自 GET /board/analytics（完整账本）。派发工作台的 /board 快照、
     * 五个 chip、行内操作、历史抽屉一行都没被复用或改写。
     */

    const AN_ALL = 'all'
    const AN_UNKNOWN = '__unknown__'
    const AN_POLL_MS = 10000
    const AN_WINDOWS = [
      { id: '24h', labelKey: 'an.windowPreset.24h' },
      { id: '7d', labelKey: 'an.windowPreset.7d' },
      { id: '30d', labelKey: 'an.windowPreset.30d' },
      { id: 'all', labelKey: 'an.windowPreset.all' },
    ]
    const AN_OVERDUE_HOURS = [8, 24, 72, 168]
    const AN_STATUS_TONE = {
      done: 'ok', ended: 'ok', failed: 'fail', blocked: 'warn', interrupted: 'warn',
    }
    const AN_WARNING_KEY = {
      'missing-times': 'an.warn.missingTimes',
      'updatedAt-fallback': 'an.warn.fallback',
      'trend-clamped': 'an.warn.clamped',
      'ledger-truncated': 'an.warn.truncated',
      'invalid-window': 'an.warn.invalidWindow',
      'invalid-overdue-hours': 'an.warn.invalidOverdueHours',
      degraded: 'an.warn.degraded',
    }

    /** 数字：非法值给 em dash，不把「算不出来」画成 0。 */
    function anNum(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : tr('an.metric.none')
    }

    function anPct(value) { return percentText(value) }

    function anSigned(value, suffix) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return tr('an.metric.none')
      const rounded = Math.round(value * 10) / 10
      return (rounded > 0 ? '+' : '') + rounded + (suffix || '')
    }

    function anStatusLabel(status) {
      const key = 'status.' + status
      const label = tr(key)
      return label === key ? String(status) : label
    }

    function anWindowLabel(key) {
      const preset = AN_WINDOWS.find(item => item.id === key)
      if (preset) return tr(preset.labelKey)
      const match = /^(\d+)([hd])$/.exec(String(key ?? ''))
      if (!match) return String(key ?? tr('an.metric.none'))
      return match[2] === 'h' ? fill(tr('an.hours'), { n: match[1] }) : fill(tr('an.days'), { n: match[1] })
    }

    /** 按 range 补齐空天（Host 只给有事实的天）；空天是明确的 0，不是数据丢失。 */
    function anDayRows(range, days) {
      const source = Array.isArray(days) ? days : []
      if (!range || !range.from || !range.to) return source.slice()
      const byDay = new Map(source.map(row => [row.day, row]))
      const from = Date.parse(range.from + 'T00:00:00.000Z')
      const to = Date.parse(range.to + 'T00:00:00.000Z')
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return source.slice()
      const out = []
      for (let at = from; at <= to && out.length < 366; at += 86400000) {
        const day = new Date(at).toISOString().slice(0, 10)
        out.push(byDay.get(day) || {
          day, created: 0, done: 0, failed: 0, blocked: 0, interrupted: 0, cancelled: 0, ended: 0, settled: 0,
        })
      }
      return out
    }

    function anOption(value, label) {
      return h('option', { key: String(value), value: String(value) }, label)
    }

    function anFacetLabel(item, fallback) {
      if (!item) return fallback
      if (item.id === AN_UNKNOWN) return tr('an.unknown')
      return item.title || String(item.id)
    }

    /** 一张 KPI 卡：标签（hover 给口径）、大数字、分子分母/样本说明。 */
    function AnMetric(props) {
      return h(
        'div',
        {
          className: 'dsh-sa-card' + (props.tone ? ' dsh-sa-card-' + props.tone : ''),
          'data-an-metric': props.id,
        },
        h('span', { className: 'dsh-sa-card-label', title: props.hint }, props.label),
        h('span', { className: 'dsh-sa-card-value dsh-sa-an-big' }, props.value),
        h('span', { className: 'dsh-sa-card-sub' }, props.sub || ''),
        props.low ? h('span', { className: 'dsh-sa-card-sub dsh-sa-an-low' }, tr('an.sampleLow')) : null,
      )
    }

    function AnSection(props) {
      return h(
        'div',
        { className: 'dsh-sa-an-section', 'data-an-section': props.id },
        h(
          'div',
          { className: 'dsh-sa-an-section-head' },
          h('span', { className: 'dsh-sa-an-section-title' }, props.title),
          props.action || null,
          h('span', { className: 'dsh-sa-an-section-hint' }, props.hint || ''),
        ),
        props.children || null,
      )
    }

    /** 趋势区：图表 / 表格等价双形态，颜色之外一定有文字。 */
    function AnTrend(props) {
      const rows = anDayRows(props.range, props.days)
      const mode = props.mode === 'table' ? 'table' : 'chart'
      const toggle = h(
        'span',
        { className: 'dsh-sa-toggle', role: 'group', 'aria-label': tr('trend.modeLabel') },
        ['chart', 'table'].map(function (id) {
          return h('button', {
            key: id,
            type: 'button',
            className: 'dsh-sa-tab',
            'aria-selected': mode === id,
            'data-an-trend-mode': id,
            onClick: function () { props.onMode(id) },
          }, id === 'chart' ? tr('an.chart') : tr('an.table'))
        }),
      )
      let body
      if (!rows.length) {
        body = h(Blank, { title: tr('an.emptyTrend') })
      } else if (mode === 'table') {
        body = h(
          'div',
          { className: 'dsh-sa-tablewrap' },
          h('table', { className: 'dsh-sa-table', 'data-table': 'analytics-trend' },
            h('thead', null, h('tr', null,
              h('th', { scope: 'col' }, tr('an.day')),
              h('th', { scope: 'col' }, tr('an.newCreated')),
              h('th', { scope: 'col' }, tr('an.done')),
              h('th', { scope: 'col' }, 'failed'),
              h('th', { scope: 'col' }, 'blocked'),
              h('th', { scope: 'col' }, 'interrupted'),
              h('th', { scope: 'col' }, 'cancelled'),
            )),
            h('tbody', null, rows.map(function (row) {
              return h('tr', { key: row.day },
                h('th', { scope: 'row', className: 'dsh-sa-table-name' }, String(row.day)),
                h('td', null, anNum(row.created)), h('td', null, anNum(row.done)),
                h('td', null, anNum(row.failed)), h('td', null, anNum(row.blocked)),
                h('td', null, anNum(row.interrupted)), h('td', null, anNum(row.cancelled)),
              )
            })),
          ),
          h('div', { className: 'dsh-sa-an-foot' }, tr('an.trendTableHint')),
        )
      } else {
        /** 把连续的空天并成一行；表格形态仍逐日给全，图表只做概览。 */
        const groups = []
        for (const row of rows) {
          const problems = num(row.failed, 0) + num(row.blocked, 0) + num(row.interrupted, 0)
          /**
           * 「空天」的判据必须与**表格列同源**。
           *
           * 原来只看 created / done / problems，于是「跨天取消」的那天
           * （created=0、done=0、problems=0、cancelled=1）被判成「空天补 0」，
           * 而同一份数据的表格里那一行明明写着 cancelled=1——同一件事，
           * 图表与表格给了两个答案（实测跨天取消那天被标「空天补 0」，
           * 同列表格却显示 cancelled=1）。
           *
           * 取消与结束（ended）同样是「那天发生过的事」，不能让那一天变成空天。
           */
          const closed = num(row.cancelled, 0) + num(row.ended, 0)
          const empty = num(row.created, 0) === 0 && num(row.done, 0) === 0
            && problems === 0 && closed === 0
          const last = groups[groups.length - 1]
          if (empty && last && last.empty) {
            last.to = row.day
            last.count += 1
          } else {
            groups.push({ empty, from: row.day, to: row.day, count: 1, row: row, problems: problems })
          }
        }
        body = h('div', { className: 'dsh-sa-trend' }, groups.map(function (group) {
          if (group.empty) {
            const short = function (day) { return String(day).slice(5) }
            return h(
              'div',
              {
                className: 'dsh-sa-trend-row dsh-sa-trend-quiet',
                key: 'empty-' + group.from,
                'data-an-day': group.from,
                'data-an-empty-range': String(group.count),
              },
              h('span', { className: 'dsh-sa-trend-day' },
                group.count > 1 ? short(group.from) + '–' + short(group.to) : short(group.from)),
              h('span', { className: 'dsh-sa-trend-text' }, group.count > 1
                ? fill(tr('an.emptyRange'), { n: group.count })
                : tr('an.emptyDay')),
            )
          }
          const row = group.row
          const problems = group.problems
          const max = Math.max(1, num(row.created, 0), num(row.done, 0), problems)
          const width = function (value) { return Math.max(0, Math.min(100, Math.round(num(value, 0) / max * 100))) + '%' }
          return h(
            'div',
            { className: 'dsh-sa-trend-row', key: row.day, 'data-an-day': row.day },
            h('span', { className: 'dsh-sa-trend-day' }, String(row.day).slice(5)),
            h('span', { className: 'dsh-sa-trend-bars' },
              h('span', { className: 'dsh-sa-trend-track' }, h('span', {
                className: 'dsh-sa-trend-fill dsh-sa-trend-fill-created', style: { width: width(row.created), display: 'block' },
              })),
              h('span', { className: 'dsh-sa-trend-track' }, h('span', {
                className: 'dsh-sa-trend-fill dsh-sa-trend-fill-done', style: { width: width(row.done), display: 'block' },
              })),
              problems > 0 ? h('span', { className: 'dsh-sa-trend-track' }, h('span', {
                className: 'dsh-sa-trend-fill dsh-sa-trend-fill-problems', style: { width: width(problems), display: 'block' },
              })) : null,
            ),
            h('span', { className: 'dsh-sa-trend-text' },
              tr('an.newCreated') + ' ' + anNum(row.created) + ' · '
              + tr('an.done') + ' ' + anNum(row.done) + ' · '
              + tr('an.problems') + ' ' + anNum(problems)),
          )
        }))
      }
      return h('div', null, toggle, body)
    }

    /**
     * 分析看板主体。所有状态由 BoardPanel 传入，本组件无 hook、无网络、无副作用。
     */
    function AnalyticsView(props) {
      const filters = props.filters || {}
      const state = props.state || { status: 'idle', data: null, error: '' }
      const payload = state.data
      const degraded = Boolean(payload) && (payload.degraded === true || payload.ok === false)
      const summary = payload && !degraded && payload.summary && typeof payload.summary === 'object'
        ? payload.summary : null
      const coverage = payload && payload.coverage && typeof payload.coverage === 'object' ? payload.coverage : null
      const facets = payload && payload.facets ? payload.facets : {}
      const trend = payload && payload.trend ? payload.trend : { days: [], range: null, compare: null }
      const errorText = state.status === 'fail'
        ? (state.error || tr('an.unavailable'))
        : (degraded ? (payload.reason || tr('an.degraded')) : '')

      /** 一个带「全部」选项的下拉；当前值不在候选里时也补一行，避免空白选中态。 */
      const selectOf = function (field, labelKey, allLabelKey, items, labelOf) {
        const list = Array.isArray(items) ? items : []
        const current = filters[field] || AN_ALL
        const options = [anOption(AN_ALL, tr(allLabelKey))]
        for (const item of list) options.push(anOption(item.id, labelOf(item)))
        if (current !== AN_ALL && !list.some(item => String(item.id) === String(current))) {
          options.push(anOption(current, current))
        }
        return h(
          'label',
          { className: 'dsh-sa-an-field' },
          h('span', { className: 'dsh-sa-an-field-label' }, tr(labelKey)),
          h('select', {
            className: 'dsh-sa-select',
            value: current,
            'aria-label': tr(labelKey),
            'data-an-select': field,
            onChange: function (event) { props.onFilter(field, event.target.value) },
          }, options),
        )
      }

      const windowChips = h(
        'span',
        { className: 'dsh-sa-an-field', role: 'group', 'aria-label': tr('an.window') },
        h('span', { className: 'dsh-sa-an-field-label' }, tr('an.window')),
        AN_WINDOWS.map(function (preset) {
          return h('button', {
            key: preset.id,
            type: 'button',
            className: 'dsh-sa-chip',
            'aria-pressed': filters.window === preset.id,
            'data-an-window': preset.id,
            onClick: function () { props.onFilter('window', preset.id) },
          }, tr(preset.labelKey))
        }),
      )

      const customDays = h(
        'span',
        { className: 'dsh-sa-an-field' },
        h('span', { className: 'dsh-sa-an-field-label' }, tr('an.customDays')),
        h('input', {
          type: 'number', min: '1', max: '365', className: 'dsh-sa-input',
          value: props.customDays || '', 'aria-label': tr('an.customDays'), 'data-an-custom-days': 'true',
          onChange: function (event) { props.onCustomDays(event.target.value) },
        }),
        h('button', {
          type: 'button', className: 'dsh-sa-btn', 'data-an-apply': 'true',
          onClick: props.onApplyCustomDays,
        }, tr('an.apply')),
      )

      const filterBar = h(
        'div',
        { className: 'dsh-sa-an-filters', role: 'group', 'aria-label': tr('an.filters') },
        windowChips,
        customDays,
        selectOf('status', 'an.status', 'an.allStatus', facets.statuses, function (item) {
          return anStatusLabel(item.id) + ' (' + anNum(item.count) + ')'
        }),
        selectOf('owner', 'an.owner', 'an.allOwner', facets.owners, function (item) {
          return anFacetLabel(item, String(item.id)) + ' (' + anNum(item.count) + ')'
        }),
        selectOf('workspaceId', 'an.workspace', 'an.allWorkspace', facets.workspaces, function (item) {
          return anFacetLabel(item, String(item.id)) + ' (' + anNum(item.count) + ')'
        }),
        selectOf('group', 'an.group', 'an.allGroup', facets.groups, function (item) {
          return String(item.id) + ' (' + anNum(item.count) + ')'
        }),
        h(
          'label',
          { className: 'dsh-sa-an-field' },
          h('span', { className: 'dsh-sa-an-field-label' }, tr('an.overdueHours')),
          h('select', {
            className: 'dsh-sa-select', value: String(filters.overdueHours || 24),
            'aria-label': tr('an.overdueHours'), 'data-an-select': 'overdueHours',
            onChange: function (event) { props.onFilter('overdueHours', Number(event.target.value)) },
          }, AN_OVERDUE_HOURS.map(function (hours) {
            return anOption(hours, fill(tr('an.hours'), { n: hours }))
          })),
        ),
        h('span', { className: 'dsh-sa-an-actions' },
          h('button', { type: 'button', className: 'dsh-sa-btn', 'data-an-clear': 'true', onClick: props.onClear }, tr('an.clear')),
          h('button', { type: 'button', className: 'dsh-sa-btn', 'data-an-refresh': 'true', onClick: props.onRefresh }, tr('an.refresh')),
        ),
      )

      const warnings = Array.isArray(payload && payload.warnings) ? payload.warnings : []
      const scopeLine = summary ? h(
        'div',
        { className: 'dsh-sa-an-scope', 'data-an-scope': 'true' },
        h('span', { className: 'dsh-sa-an-scope-title' }, tr('an.coverage')),
        h('span', null, fill(tr('an.coverageText'), {
          source: anNum(coverage && coverage.sourceTasks),
          inWindow: anNum(coverage && coverage.inWindow),
          matched: anNum(coverage && coverage.matched),
          retired: anNum(coverage && coverage.retiredTraces),
        })),
        h('span', null, tr('an.window') + ' ' + anWindowLabel(payload.scope && payload.scope.window && payload.scope.window.key)),
        h('span', { className: 'dsh-sa-an-scope-proxy' }, tr('an.proxyNote')),
        warnings.filter(function (code) { return AN_WARNING_KEY[code] }).map(function (code) {
          return h('span', { key: code, className: 'dsh-sa-an-warn' }, tr(AN_WARNING_KEY[code]))
        }),
      ) : null

      const strips = []
      if (state.status === 'fail' && summary) {
        strips.push(h('div', {
          key: 'an-stale', className: 'dsh-sa-strip dsh-sa-strip-warn', role: 'status', 'aria-live': 'polite',
        }, h('span', { className: 'dsh-sa-strip-text' }, tr('an.stale') + ' · ' + errorText)))
      }

      const backBtn = h('button', {
        type: 'button', className: 'dsh-sa-btn', 'data-an-back': 'true', onClick: props.onSwitch,
      }, tr('an.backTasks'))
      const retryBtn = h('button', {
        type: 'button', className: 'dsh-sa-btn', 'data-an-retry': 'true', onClick: props.onRefresh,
      }, tr('an.retry'))
      const clearBtn = h('button', {
        type: 'button', className: 'dsh-sa-btn', 'data-an-clear': 'true', onClick: props.onClear,
      }, tr('an.clear'))

      let content
      if (!payload && state.status !== 'fail') {
        content = h(Blank, {
          title: tr('an.loading'), hint: tr('an.loadingHint'),
        })
        content = h('div', { 'data-an-loading': 'true' }, content)
      } else if (!summary) {
        content = h('div', { 'data-an-error': 'true' }, h(Blank, {
          title: degraded ? tr('an.degraded') : tr('an.unavailable'),
          hint: errorText,
          action: h('span', null, retryBtn, ' ', backBtn),
        }))
      } else if (summary.total === 0) {
        content = h('div', { 'data-an-empty': 'true' }, h(Blank, {
          title: tr('an.empty'), hint: tr('an.emptyHint'), action: clearBtn,
        }))
      } else {
        const completion = summary.completion || {}
        const overdue = summary.overdue || {}
        const cards = h('div', { className: 'dsh-sa-an-cards' },
          h(AnMetric, {
            id: 'total', label: tr('an.metric.total'), hint: tr('an.metric.totalHint'),
            value: anNum(summary.total),
            sub: fill(tr('an.totalSub'), { source: anNum(coverage && coverage.sourceTasks), matched: anNum(coverage && coverage.matched) }),
          }),
          h(AnMetric, {
            id: 'rate', label: tr('an.metric.rate'), hint: tr('an.metric.rateHint'),
            value: anPct(completion.rate),
            sub: fill(tr('an.rateSub'), { done: anNum(completion.done), base: anNum(completion.base) }),
            low: Boolean(completion.sampleLow),
            tone: completion.rate !== null && completion.rate !== undefined ? 'ok' : '',
          }),
          h(AnMetric, {
            id: 'overdue', label: tr('an.metric.overdue'), hint: tr('an.metric.overdueHint'),
            value: anNum(overdue.total),
            sub: fill(tr('an.overdueSub'), {
              open: anNum(overdue.open), settled: anNum(overdue.settled), unknown: anNum(overdue.unknown),
            }),
            tone: num(overdue.total, 0) > 0 ? 'warn' : '',
          }),
          h(AnMetric, {
            id: 'active', label: tr('an.metric.active'), hint: tr('an.metric.activeHint'),
            value: anNum(summary.active),
            sub: fill(tr('an.activeSub'), { settled: anNum(summary.settled), archived: anNum(summary.archived) }),
          }),
        )

        const compare = trend.compare
        let compareLine = null
        if (compare && compare.available) {
          const delta = function (labelKey, value, suffix) {
            const tone = typeof value === 'number' && Number.isFinite(value)
              ? (value > 0 ? ' dsh-sa-an-delta-up' : value < 0 ? ' dsh-sa-an-delta-down' : '')
              : ''
            return h('span', { className: 'dsh-sa-an-delta' + tone },
              fill(tr(labelKey), { value: anSigned(value, suffix) }))
          }
          compareLine = h('div', { className: 'dsh-sa-an-compare', 'data-an-compare': 'true' },
            h('span', null, tr('an.compare')),
            delta('an.deltaCreated', compare.createdDelta, ''),
            delta('an.deltaDone', compare.doneDelta, ''),
            compare.rateDelta === null || compare.rateDelta === undefined
              ? h('span', { className: 'dsh-sa-an-section-hint', title: tr('an.compareSampleHint') }, tr('an.compareSample'))
              : delta('an.deltaRate', compare.rateDelta * 100, 'pp'),
          )
        } else {
          compareLine = h('div', { className: 'dsh-sa-an-compare' }, tr('an.compareNone'))
        }

        const trendBlock = h(AnSection, {
          id: 'trend', title: tr('an.trend'), hint: tr('an.trendHint'),
        }, compareLine, h(AnTrend, {
          days: trend.days, range: trend.range, mode: props.trendMode, onMode: props.onTrendMode,
        }))

        const distribution = Array.isArray(summary.distribution) ? summary.distribution : []
        const statusBlock = h(AnSection, {
          id: 'status', title: tr('an.statusDist'), hint: tr('an.statusDistHint'),
        }, h('div', { className: 'dsh-sa-rows' }, distribution.map(function (row) {
          const tone = AN_STATUS_TONE[row.status]
          return h('button', {
            key: row.status,
            type: 'button',
            className: 'dsh-sa-dist dsh-sa-an-dist',
            'aria-pressed': filters.status === row.status,
            'data-an-status': row.status,
            title: tr('an.statusDistHint'),
            onClick: function () { props.onFilter('status', filters.status === row.status ? AN_ALL : row.status) },
          },
            h('span', { className: 'dsh-sa-dist-name' }, anStatusLabel(row.status)),
            h('span', { className: 'dsh-sa-dist-track' }, h('span', {
              className: 'dsh-sa-dist-fill' + (tone ? ' dsh-sa-dist-fill-' + tone : ''),
              style: { width: Math.max(0, Math.min(100, Math.round(num(row.share, 0) * 100))) + '%', display: 'block' },
            })),
            h('span', { className: 'dsh-sa-dist-value' }, anNum(row.count) + ' · ' + anPct(row.share)),
          )
        })))

        const kv = function (label, value) {
          return h('div', { className: 'dsh-sa-kv' },
            h('span', { className: 'dsh-sa-kv-label' }, label),
            h('span', { className: 'dsh-sa-kv-value' }, value))
        }
        const overdueBlock = h(AnSection, {
          id: 'overdue', title: tr('an.overdueBlock'), hint: tr('an.overdueBlockHint'),
        }, h('div', { className: 'dsh-sa-an-kvs' },
          kv(tr('an.overdueOpen'), anNum(overdue.open)),
          kv(tr('an.overdueSettled'), anNum(overdue.settled)),
          kv(tr('an.overdueUnknown'), anNum(overdue.unknown)),
          kv(tr('an.overdueRate'), anPct(overdue.rate)),
          kv(tr('an.overdueHours'), fill(tr('an.hours'), { n: anNum(overdue.thresholdHours) })),
        ))

        content = h('div', { 'data-an-content': 'true' },
          h(AnSection, { id: 'kpi', title: tr('an.kpi'), hint: tr('an.kpiHint') }, cards),
          trendBlock, statusBlock, overdueBlock)
      }

      return h(
        'div',
        { className: 'dsh-sa-an dsh-sa-view', 'data-view': 'analytics', 'data-an-view': 'true', role: 'region', 'aria-label': tr('an.title') },
        h('div', { className: 'dsh-sa-an-bar' },
          h('span', { className: 'dsh-sa-an-title' }, tr('an.title')),
          h('span', { className: 'dsh-sa-an-sub' },
            (payload && payload.generatedAt ? tr('an.updatedAt') + ' ' + formatClock(Date.parse(payload.generatedAt)) : '')),
        ),
        filterBar,
        scopeLine,
        strips.length ? strips : null,
        content,
        h('div', { className: 'dsh-sa-an-foot' }, tr('an.foot')),
      )
    }

    function BoardPanel() {
      const [snapshot, setSnapshot] = useState(null)
      const [fetchedAt, setFetchedAt] = useState(0)
      const [failure, setFailure] = useState(null)
      /** 顶部提示条：{ tone: 'error'|'warn'|'info', text }，可关闭。 */
      const [notice, setNotice] = useState(null)
      const [filter, setFilter] = useState('all')
      /** 「最近完成」默认只露 5 条，展开看全部。 */
      const [showDone, setShowDone] = useState(false)
      /** 工作区筛选；'' 表示全部工作区。与状态 chip 是「与」关系。 */
      const [workspace, setWorkspace] = useState('')
      const [busy, setBusy] = useState({})
      const [generation, setGeneration] = useState(0)
      const [now, setNow] = useState(function () { return Date.now() })
      /** 立即归档超时会话的两步确认：0 空闲，1 等待确认。 */
      const [archiveStage, setArchiveStage] = useState(0)
      const [archiving, setArchiving] = useState(false)
      /**
       * 「计划已更新」（PRD-01 §6 / PRD §11.3）：worker 提交**不同的**计划时，这一行亮一次短徽标。
       *
       * 两张表，都**不入账本**（PRD 明确要求：这是看板的瞬时提示，不是任务事实）：
       * - `lastPlan`：task_id → 上一轮看到的计划三元组 `{total, done, current}`。
       *   放 ref 而不是 state：它只用来做前后比较，改它不该触发渲染；
       * - `planNotice`：task_id → 「这一轮该亮的时刻」（毫秒戳）。放 state 才会驱动渲染。
       *
       * 为什么存时刻而不是存「亮/不亮」：徽标要活满 `PLAN_NOTICE_MS`（6 秒 = 3 个轮询
       * 周期），「还亮不亮」是**时刻差**判断。只存布尔的话，下一轮轮询一到就只能先清、
       * 再看变没变——徽标的寿命会被绑成「一轮轮询」（2 秒），而不是 PRD 要的 6 秒。
       *
       * 为什么 `TaskCard` 自己不能做这件事：它是无 hook 的展示组件，每 2 秒轮询都
       * 重建一次，没有任何地方能记住「上一次的计划长什么样」。
       */
      const lastPlan = useRef(new Map())
      /**
       * 上一轮取数失败过 → 恢复后的第一轮**只重建基线**（PRD §11.5）。
       *
       * 失败期间手里拿的是旧快照，跨过这段空档再比，等于拿「几分钟前的计划」对
       * 「现在的计划」直接下结论；PRD 要求这条缝里的第一轮不下提示，只把基线换新。
       * 放 ref：它只影响下一次比较，不该触发渲染。
       */
      const planBaselineDirty = useRef(false)
      const [planNotice, setPlanNotice] = useState({})
      /**
       * 行内归档的两步确认：存的是「正在等确认的 task_id」。
       *
       * 与工具栏的 `archiveStage` 分开：工具栏确认的是**巡检**（`/archive`，
       * 会扫全表），行内确认的是**单条**（`/archive-task`）。共用一个状态槽会
       * 让「刚点了工具栏确认」把某一行也点亮成确认态，反过来也一样。
       * 4 秒过期由下面那条 effect 统一处理。
       */
      const [archiveAsk, setArchiveAsk] = useState('')
      /*
       * 续派的行内状态（plans/08 阶段 1），与 `archiveAsk` 同构：
       * `continueAsk` 是「哪一行开着输入框」（task_id），`continueDraft` 是那一行的草稿。
       *
       * 为什么不把草稿存在 `TaskCard` 里：它是无 hook 的展示组件（每 2 秒轮询都会
       * 重建一次），存在组件内部的草稿会在第一次轮询后消失——用户写了一半的话
       * 被系统吞掉，比写错更让人不敢用。
       */
      const [continueAsk, setContinueAsk] = useState('')
      const [continueDraft, setContinueDraft] = useState('')
      /**
       * 退休视图的数据：{ state: 'idle'|'loading'|'ok'|'fail', data, error }。
       * 与快照分开持有：它只在选中「已退休」时才取，取失败也只影响这一个视图。
       */
      const [retired, setRetired] = useState({ state: 'idle', data: null, error: '' })
      /**
       * 当前视图：总览 / 效果 / 拆解 / 历史（plans/09 §二）。
       *
       * 默认 `overview` 而不是「上次看的视图」：总览是操作首页，一进来就该看到
       * 「现在要我做什么」。记住上次视图会让一个停在「拆解」的看板在下次打开时
       * 把需要处理的任务藏起来。
       */
      const [view, setView] = useState('overview')
      /*
       * ── plans/09 P2：历史视图的视图内状态 ──
       *
       * 全部与 `view` 分开持有：历史是「停下来查证据」的视图，它的搜索词与分页
       * 不该跟着 2 秒轮询被重置。`histPage` 在筛选条件变化时要归零（否则会停在
       * 一个已经不存在的页码上看到空表），归零由下面那处 setter 统一做。
       */
      const [histSub, setHistSub] = useState('all')
      const [histQuery, setHistQuery] = useState('')
      const [histStatus, setHistStatus] = useState('')
      const [histWorkspace, setHistWorkspace] = useState('')
      const [histTime, setHistTime] = useState('all')
      const [histSort, setHistSort] = useState('created')
      const [histRetried, setHistRetried] = useState(false)
      const [histBackground, setHistBackground] = useState(false)
      const [histPage, setHistPage] = useState(0)
      /**
       * 抽屉里那一行：`{ kind, task_id }` 只记身份，不存整行快照。
       *
       * 存整行的话，2 秒轮询把任务从 running 变成 done 之后，抽屉仍然显示旧的
       * 状态与旧的生命周期——「详情」与账本不一致，正是 §八.9 要防的事。
       * 每次渲染按身份去当前数据里重新找一遍，找不到（退休记录被清理）就自动关闭。
       */
      const [drawerKey, setDrawerKey] = useState(null)
      /**
       * 窗口键。`null` 表示「还没定」——真正的默认值要等快照里的 memory.window 到手
       * 才能确定（plans/09 §三.1：默认沿用 memory.window，不是前端另造默认）。
       *
       * 「用户点过 chip 之后就不再被 memory 覆盖」这条规则由 `windowKey` 本身承担：
       * 它一旦非空，`effectiveWindow` 就不再回落到 `defaultWindowKey(memory)`。
       * 所以不需要第二个「用户点过没有」的标记——原来那个 `windowPicked` 只写不读，
       * 是一段会误导人的死代码（看代码的人会以为它在参与什么判断）。
       */
      const [windowKey, setWindowKey] = useState(null)
      /**
       * 顶层面板的镜像（'tasks' | 'analytics'），给**写在前面的** 2 秒轮询用。
       *
       * 为什么需要它：轮询的 effect 写在 `surface` state **之前**，而 hook 的调用
       * 序号不能动（离线冒烟的迷你 React 按序号复用 store，把新 hook 插在中间会让
       * 视图、筛选、抽屉的旧状态整体错位）。把 `surface` 镜像一份到 ref 里，
       * effect 读 ref 就既拿到了最新值，又不用挪动任何 hook 的位置。
       */
      const surfaceRef = useRef('tasks')
      /** 拆解页的工作区维度：'target'（派发目标）或 'host'（实际归属）。 */
      const [dimension, setDimension] = useState('target')
      /** 趋势区形态：'chart' | 'table'（plans/09 §五.2 图表/表格双形态）。 */
      const [trendMode, setTrendMode] = useState('chart')
      /**
       * 下钻筛选：`{ kind, value, name }`，kind ∈ workspaceId | hostWorkspaceId |
       * group | parentSessionId | status。**与顶部 `workspace` 下拉是同一件事的两种入口**：
       * 点工作区行时两者一起写，否则会出现「下拉说我筛了 A、提示条说我筛了 B」。
       */
      const [drill, setDrill] = useState(null)
      /**
       * `/board/stats` 的数据：`{ state: 'idle'|'loading'|'ok'|'fail', data, error }`。
       *
       * 与快照**分开持有**（plans/09 §八.10）：stats 挂了必须让总览照常工作。
       * `state==='fail'` 只影响效果/拆解两个视图，绝不白屏。
       */
      const [statsState, setStatsState] = useState({ state: 'idle', data: null, error: '' })

      /** 面板内所有写操作的 AbortController，卸载时统一中止。 */
      const inFlight = useRef(null)
      if (inFlight.current === null) inFlight.current = new Set()

      const refresh = useCallback(function () {
        setGeneration(function (value) { return value + 1 })
      }, [])

      /* 轮询：2s 一次，页面不可见时暂停，卸载时停表并中止在途请求。 */
      useEffect(function () {
        let disposed = false
        let timer = null
        let controller = null

        function arm() {
          if (disposed) return
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          timer = setTimeout(function () {
            timer = null
            load()
          }, POLL_MS)
        }

        async function load() {
          if (disposed) return
          /**
           * 分析看板可见时，**这一轮什么都不做**。
           *
           * 原来这里不看面板：切到分析看板之后，任务快照仍然每 2 秒落一次状态，
           * 于是整个分析视图每 2 秒重建一次（而分析看板自己的轮询是 10 秒）——
           * 两套轮询互相踩，用户盯着分析数字时整个视图在背后反复重绘。
           *
           * 只停「落状态」是不够的：状态不更新的话，切回派发工作台时看到的会一直
           * 是切换前那张快照。所以这里整轮停掉（连取数也不做——没人看的数据
           * 不必去拉），由切换动作把轮询叫醒（见 `SurfaceBar` 的 onClick）。
           */
          if (surfaceRef.current === 'analytics') {
            arm()
            return
          }
          if (controller) controller.abort()
          const current = new AbortController()
          controller = current
          try {
            const data = await readBoard(current.signal)
            if (disposed || current.signal.aborted) return
            // 取数期间用户切到了分析看板：这一份结果**不落状态**。
            // 否则「切过去的那一刻」仍会有一次 setSnapshot 把分析视图重建一遍，
            // 而这一份数据此刻没有人在看（切回派发工作台时会立刻重取）。
            if (surfaceRef.current === 'analytics') return
            setSnapshot(data)
            setFetchedAt(Date.now())
            // 顺带推进 now：没有 running 任务时走表不开，归档行的相对时间靠每次取数刷新。
            setNow(Date.now())
            setFailure(null)
          } catch (error) {
            if (disposed || current.signal.aborted || (error && error.name === 'AbortError')) return
            setFailure(describeError(error))
          } finally {
            if (controller === current) controller = null
            arm()
          }
        }

        function onVisibility() {
          if (typeof document === 'undefined') return
          if (document.visibilityState === 'visible') {
            if (timer) {
              clearTimeout(timer)
              timer = null
            }
            load()
            return
          }
          // 隐藏：停表并中止在途请求，回来后立刻重取一次。
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          if (controller) controller.abort()
        }

        /** 供插件级 ctx.effect 复用的清理。 */
        function cleanup() {
          disposed = true
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          if (controller) controller.abort()
          controller = null
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
          if (activePanelCleanup === cleanup) activePanelCleanup = null
        }

        activePanelCleanup = cleanup
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        load()

        return function () {
          cleanup()
          const controllers = inFlight.current
          if (controllers) {
            controllers.forEach(function (item) { item.abort() })
            controllers.clear()
          }
        }
      }, [generation])

      /* 只在有 running 任务时才走表，静止的看板不做无谓重渲染。 */
      const hasRunning = useMemo(function () {
        if (!snapshot || !Array.isArray(snapshot.tasks)) return false
        return snapshot.tasks.some(function (task) { return task && task.status === 'running' })
      }, [snapshot])

      /**
       * 选中「已退休」时才去取退休记录。
       *
       * 与 2 秒轮询解耦：退休记录一旦生成就不再变化（它描述的是"已经消失"这件事），
       * 跟着快照每 2 秒拉一次纯属浪费，也会让视图在手滑时闪。
       * 依赖 generation：用户点重试 / 归档后再进来能拿到新数据。
       *
       * plans/09 P2：历史视图的「已退休」子视图**复用同一份数据**（`retired`），
       * 不另开一条取数路径与一份缓存——两条路径迟早对同一条留痕给出不同的
       * 「退休时刻」，而那张表格的存在意义就是「时间能对上」。
       */
      const retiredNeeded = filter === 'retired' || (view === 'history' && histSub === 'retired')
      useEffect(function () {
        if (!retiredNeeded) return undefined
        let disposed = false
        const controller = new AbortController()
        setRetired(function (current) {
          // 已经有数据时保留旧数据，只把状态切成 loading，避免列表闪成空白。
          return { state: 'loading', data: current.data, error: '' }
        })
        readRetired(controller.signal)
          .then(function (payload) {
            if (disposed || controller.signal.aborted) return
            setRetired({ state: 'ok', data: payload, error: '' })
          })
          .catch(function (error) {
            if (disposed || controller.signal.aborted || (error && error.name === 'AbortError')) return
            setRetired({ state: 'fail', data: null, error: describeError(error) })
          })
        return function () {
          disposed = true
          controller.abort()
        }
      }, [retiredNeeded, generation])

      useEffect(function () {
        if (!hasRunning) return undefined
        setNow(Date.now())
        const id = setInterval(function () { setNow(Date.now()) }, TICK_MS)
        return function () { clearInterval(id) }
      }, [hasRunning])

      /* 两步确认：进入确认态后 4 秒没搭理就退回，免得误触常驻。 */
      useEffect(function () {
        if (archiveStage !== 1) return undefined
        const id = setTimeout(function () { setArchiveStage(0) }, 4000)
        return function () { clearTimeout(id) }
      }, [archiveStage])

      /* 行内归档同样 4 秒过期：与工具栏确认态同一条规则，手感一致。 */
      useEffect(function () {
        if (!archiveAsk) return undefined
        const id = setTimeout(function () { setArchiveAsk('') }, 4000)
        return function () { clearTimeout(id) }
      }, [archiveAsk])

      /** 带中止控制的 POST，控制器统一登记，卸载时一并 abort。 */
      const post = useCallback(function (path, body) {
        const controller = new AbortController()
        if (inFlight.current) inFlight.current.add(controller)
        return postJson(path, body, controller.signal).finally(function () {
          if (inFlight.current) inFlight.current.delete(controller)
        })
      }, [])

      /* 写操作：取消 / 重试 / 单条归档 / 续派。成功后立刻重新取一次快照。 */
      const act = useCallback(function (kind, task) {
        if (!task || !task.task_id) return
        if (busy[task.task_id]) return
        /*
         * 归档走**两步确认**，而且这一步不占用 `busy`：
         * 第一次点击只是把这一行点进确认态（不产生请求），4 秒内再点才真发。
         * 把它塞进 `busy` 会让按钮在还没发请求时就变成「归档中…」并禁用，
         * 用户既看不到确认提示，也点不了第二次——等于确认态永远走不完。
         */
        if (kind === 'archive') {
          if (archiveAsk !== task.task_id) {
            setArchiveAsk(task.task_id)
            return
          }
          setArchiveAsk('')
        }
        setBusy(function (value) {
          const next = Object.assign({}, value)
          next[task.task_id] = kind
          return next
        })
        /*
         * 路由分发：归档是**独立路由**，不能塞进下面这个三元式。
         * `/archive` 是巡检（不读 body、扫全表），拿它做单条归档会连带扫走
         * 别的超期任务；`/archive-task` 才认 `task_id`。
         */
        const path = kind === 'archive'
          ? '/archive-task'
          : kind === 'cancel' ? '/cancel' : '/retry'
        post(path, { task_id: task.task_id })
          .then(function (result) {
            if (kind === 'archive') {
              /*
               * 决策 B 的界面口径：宿主可能「归档成功但子会话没归档成功」
               * （会话随重启消失、或启动就失败）。这时任务确实已经离开待办区，
               * 所以不是错误提示，而是**警告**：明说归档了、也明说原因。
               * 不能只说「已归档」——那是在替宿主把失败藏起来。
               */
              const reason = result && typeof result.reason === 'string' ? result.reason : ''
              setNotice(reason
                ? { tone: 'warn', text: fill(tr('archiveTaskKept'), { reason: reason }) }
                : { tone: 'info', text: tr('archiveTaskDone') })
            } else {
              setNotice(null)
            }
            refresh()
          })
          .catch(function (error) {
            if (error && error.name === 'AbortError') return
            setNotice({ tone: 'error', text: tr('actionFailed') + '：' + describeError(error) })
          })
          .finally(function () {
            setBusy(function (value) {
              if (!(task.task_id in value)) return value
              const next = Object.assign({}, value)
              delete next[task.task_id]
              return next
            })
          })
      }, [archiveAsk, busy, post, refresh])

      /*
       * 续派（plans/08 阶段 1）：展开/收起输入框。
       *
       * 打开第二行时把第一行收起来，并且**清掉草稿**：草稿是「针对某一条任务的一句话」，
       * 换一条行还留着它，很容易把给 A 的要求发给 B——这种错误的后果不是提示条，
       * 而是一条真实的任务被塞进无关的上下文。
       */
      const continueToggle = useCallback(function (task) {
        if (!task || !task.task_id) return
        if (busy[task.task_id]) return
        // 先算再写：两个 setter 各自只做纯赋值。**不要**在一个 setter 的更新函数里
        // 调另一个 setter——React 要求更新函数是纯函数，嵌套写状态在并发渲染下
        // 可能被重放/丢弃，草稿与「哪一行打开」就会不一致。
        const same = continueAsk === task.task_id
        setContinueDraft('')
        setContinueAsk(same ? '' : task.task_id)
      }, [busy, continueAsk])

      /** 输入框每次变化都回写面板（`TaskCard` 是无 hook 的展示组件，自己存不了草稿）。 */
      const continueInput = useCallback(function (task, value) {
        if (!task || !task.task_id) return
        // 输入框只在「这一行就是打开的那一行」时才渲染，所以这里不需要再比对
        // `continueAsk`——比对也不会更安全（那是渲染期的事实，不是写入期的判据）。
        setContinueDraft(String(value ?? ''))
      }, [])

      /**
       * 提交续派：`POST /retry` + `message`。
       *
       * 为什么复用 `/retry` 而不是新路由：宿主侧就是这样设计的（见 `src/board.js`
       * 里 `/retry` 分支的注释）——「往这条任务的子会话投一条消息」是同一条通道，
       * 重试只是用了它的一种默认文本。多一条路由等于多一套准入与错误码。
       *
       * 成功后：清掉草稿、收起输入框、刷新快照。**不**弹成功提示条：
       * 任务状态已经从「已完成」变回「运行中」，那本身就是结果；再叠一条提示
       * 只是噪音。失败则必须弹（用户写的那句话还在框里，不能悄悄吞掉）。
       */
      const continueSubmit = useCallback(function (task) {
        if (!task || !task.task_id) return
        const text = String(continueAsk === task.task_id ? continueDraft : '').trim()
        if (!text) return
        if (busy[task.task_id]) return
        setBusy(function (value) {
          const next = Object.assign({}, value)
          next[task.task_id] = 'continue'
          return next
        })
        post('/retry', { task_id: task.task_id, message: text })
          .then(function () {
            setContinueAsk('')
            setContinueDraft('')
            setNotice(null)
            refresh()
          })
          .catch(function (error) {
            if (error && error.name === 'AbortError') return
            setNotice({ tone: 'error', text: tr('actionFailed') + '：' + describeError(error) })
          })
          .finally(function () {
            setBusy(function (value) {
              if (!(task.task_id in value)) return value
              const next = Object.assign({}, value)
              delete next[task.task_id]
              return next
            })
          })
      }, [busy, continueAsk, continueDraft, post, refresh])

      /**
       * 点行打开子会话。openSession 可能抛 not-listed（子会话已不在会话目录里），
       * 这里一律接住并提示，不白屏、不静默。
       *
       * 归档任务**一律不调 openSession**：宿主 `uiWorkspace.openSession()` 只换主视图，
       * 而 ui-workspace 的 `watchNavigation()` 里 `clearArchivedCurrent()` 一旦发现
       * 主视图的会话在 `archivedSessionIds` 中就 `clearMain()`，主区域随后被补建成
       * 空白会话 —— 用户看到的就是「点归档任务 → 打开了一个新会话」。DSH 侧边栏对
       * 归档会话同样只提示「暂时无法查看，请取消归档后查看」而不打开，这里保持一致。
       *
       * 这道闸是**第二道**：第一道在 TaskCard（归档行不可点、不占 Tab 位）。
       * 两点都做，是因为键盘、脚本或将来新增的调用方都可能绕过渲染层的判断。
       */
      const openWorker = useCallback(async function (task) {
        const target = task && typeof task.worker_session_id === 'string' ? task.worker_session_id : ''
        // 先判归档：归档会话既不该换主视图，也不该被当成「没有子会话」去报错。
        if (task && task.archived_at) {
          setNotice({ tone: 'warn', text: tr('archivedHint') })
          return
        }
        if (!target) {
          setNotice({ tone: 'error', text: tr('noWorkerSession') })
          return
        }
        let ui = null
        try {
          ui = appContext && typeof appContext.get === 'function'
            ? appContext.get('uiWorkspace')
            : appContext && appContext.uiWorkspace
        } catch (error) {
          ui = null
        }
        if (!ui || typeof ui.openSession !== 'function') {
          setNotice({ tone: 'error', text: fill(tr('openFailed'), { id: target, reason: tr('noUiWorkspace') }) })
          return
        }
        try {
          await ui.openSession(target)
          // 打开成功就把上一条失败提示清掉；能走到这里的行一定不是归档行。
          setNotice(null)
        } catch (error) {
          setNotice({ tone: 'error', text: fill(tr('openFailed'), { id: target, reason: describeError(error) }) })
        }
      }, [])

      /* 立即归档超时会话：会真的归档会话，不是预览，所以走两步确认。 */
      const runArchive = useCallback(async function () {
        if (archiving) return
        setArchiveStage(0)
        setArchiving(true)
        try {
          const result = await post('/archive', {})
          const scanned = num(result && result.scanned, 0)
          const archivedCount = num(result && result.archived, 0)
          const failedCount = num(result && result.failed, 0)
          setNotice({
            tone: failedCount > 0 ? 'warn' : 'info',
            text: fill(tr('archiveDone'), { scanned: scanned, archived: archivedCount, failed: failedCount }),
          })
          if (result && result.counts) {
            // 先用返回的 counts 立刻更新顶部数字，再整块重取一次。
            setSnapshot(function (current) {
              if (!current) return current
              return Object.assign({}, current, {
                counts: Object.assign({}, current.counts, result.counts),
              })
            })
          }
          refresh()
        } catch (error) {
          if (error && error.name === 'AbortError') return
          setNotice({ tone: 'error', text: tr('actionFailed') + '：' + describeError(error) })
        } finally {
          setArchiving(false)
        }
      }, [archiving, post, refresh])

      const handlers = useMemo(function () {
        return { act: act, open: openWorker }
      }, [act, openWorker])

      /**
       * 续派的三个口子**单独一组**，不塞进 `handlers`。
       *
       * `handlers` 的形状 `{act, open}` 是既有契约（离线冒烟里有一条断言直接比对
       * 键集合）。往它里面加键，会让那条断言从「守住形状」变成「追着实现改」——
       * 而形状本身仍有价值：`act` 与 `open` 是**每一行都有**的两个动作，
       * 续派只有已结算行才有，混在一起会让「这一行有什么动作」更难看清。
       */
      const continueHandlers = useMemo(function () {
        return {
          toggle: continueToggle,
          input: continueInput,
          submit: continueSubmit,
        }
      }, [continueToggle, continueInput, continueSubmit])

      /**
       * 复制退休记录的 task_id。
       *
       * 为什么不给退休行做「点开子会话」：子会话已经归档/可能已不在会话目录里，
       * 点开会得到一句必然失败的提示。这里的真实用途是「拿 id 去 dispatch_inspect
       * 或仓库里追问」，所以只提供 id，复制结果用现有的 notice 条回话。
       */
      const copyRetiredId = useCallback(function (record) {
        const id = record && typeof record.task_id === 'string' ? record.task_id : ''
        if (!id) {
          setNotice({ tone: 'error', text: tr('retired.copyFailed').replace('{reason}', tr('unknownError')).replace('{id}', '?') })
          return
        }
        void copyText(id).then(function (ok) {
          if (ok) {
            setNotice({ tone: 'info', text: fill(tr('retired.copied'), { id: id }) })
            return
          }
          setNotice({
            tone: 'warn',
            text: fill(tr('retired.copyFailed'), { reason: tr('retired.notClickable'), id: id }),
          })
        })
      }, [])

      const data = snapshot && Array.isArray(snapshot.tasks) ? snapshot : null
      const allTasks = data ? data.tasks.filter(function (task) { return task && typeof task === 'object' }) : []
      /**
       * 依赖链的短名表（PRD-02 §4.5）：看板快照只给前置 id，任务行与抽屉要说
       * 「等 A」/「前置 A 失败」。在这里拍平成 id → 标题一层映射传下去。
       *
       * 用整份快照（`allTasks`）而不是筛选后的 `scopedTasks`：抽屉可能指向一条
       * 被筛选掉的任务，它的前置仍然要能读出名字；而再发一次请求拿标题，会让
       * 同一屏出现两份可能不同步的数据。
       */
      const depTitles = {}
      for (const task of allTasks) {
        if (task && typeof task.task_id === 'string' && task.task_id) depTitles[task.task_id] = task.title
      }
      const counts = data && data.counts ? data.counts : {}
      /*
       * 「计划已更新」的判定（PRD-01 §6 / PRD §11.3–11.5）。
       *
       * 每次拿到**新**快照比较一次三元组（`总步数` / `已完成` / `当前步骤`）：
       * - 只跟踪 `queued` / `running` 且真有计划的：终态不再计划，「已更新」对一条做完
       *   的任务没有意义；结算/归档的行也顺手从两张表里清掉（不清会随轮询一直累积）；
       * - **第一次见到某条任务只记录、不点亮**：那只是「我第一次看到它的计划」，
       *   不是「它改了计划」。页面刷新后同样走这条路，所以刷新不补提示；
       * - 三元组**任一**变化就点亮一次（一条任务只产出一个徽标，不会变成三条）；
       * - 三元组没变但窗口没走完 → 把原来的时刻原样留下来（这才是 6 秒而不是 2 秒）。
       *
       * 为什么窗口不另起定时器：看板每 2 秒本来就重渲染一次，蹭这趟车不需要额外
       * timer（面板卸载 / 切视图时也没有待清理的东西），而且它天然与「新快照到了」
       * 对齐——不会出现「徽标还在，但计划已经又变了一次」。
       */
      useEffect(function () {
        if (!data) return
        /*
         * stale 快照：**不比较、不提示**，只记一笔「恢复后先重建基线」。
         *
         * 取数失败时轮询只写 `failure`、不落新快照，此刻手里的 `data` 是上一次成功的
         * 旧数据。拿这份旧数据再和 `lastPlan` 比一次，等于「自己和自己比」——只要将来
         * 有人让失败路径回填一次快照（比如失败时也 setSnapshot(next)），这里就会凭空
         * 亮出「计划已更新」，而计划其实一个字都没改（PRD §11.5 明确要求跳过）。
         * 跳过时也**不动** `lastPlan`：失败期间基线保持上一次成功时的值，恢复后由
         * `planBaselineDirty` 决定「只重建、不提示」。
         */
        if (failure) {
          planBaselineDirty.current = true
          return
        }
        const now = Date.now()
        // 刚经历过失败：这一轮只重建基线（PRD §11.5「恢复后第一轮只重建基线」）。
        const rebuild = planBaselineDirty.current
        planBaselineDirty.current = false
        const seen = new Map()
        const changed = []
        for (const task of allTasks) {
          if (!task || typeof task.task_id !== 'string' || !task.task_id) continue
          if (task.status !== 'queued' && task.status !== 'running') continue
          const total = num(task.plan_total, 0)
          if (total <= 0) continue
          const triple = {
            total: total,
            done: num(task.plan_done, 0),
            current: typeof task.plan_current === 'string' ? task.plan_current : '',
          }
          seen.set(task.task_id, triple)
          const previous = rebuild ? undefined : lastPlan.current.get(task.task_id)
          if (!previous) continue
          if (previous.total !== triple.total || previous.done !== triple.done || previous.current !== triple.current) {
            changed.push(task.task_id)
          }
        }
        lastPlan.current = seen
        /*
         * 时刻表去重：只有「键集合与每个时刻都没变」时才返回原对象。
         * 返回新对象会让每 2 秒的轮询都多一次渲染，而绝大多数轮次什么都没变。
         */
        setPlanNotice(function (current) {
          const next = {}
          for (const id of seen.keys()) {
            if (changed.indexOf(id) !== -1) {
              next[id] = now
              continue
            }
            const stamp = current[id]
            if (typeof stamp === 'number' && now - stamp < PLAN_NOTICE_MS) next[id] = stamp
          }
          const keys = Object.keys(next)
          const same = keys.length === Object.keys(current).length
            && keys.every(function (id) { return current[id] === next[id] })
          return same ? current : next
        })
      }, [data, failure])

      /**
       * 这一行的「计划已更新」是否还在展示窗口内（`PLAN_NOTICE_MS`）。
       *
       * 渲染期再判一次时刻，而不是只靠上面那次清理：清理只在「新快照到了」时才跑，
       * 万一某一轮轮询晚到，清理会跟着晚。渲染期判断让「6 秒」成为**读得到的上界**，
       * 不依赖轮询准点。
       */
      const planNoticeLive = function (id) {
        const stamp = planNotice[id]
        return typeof stamp === 'number' && Date.now() - stamp < PLAN_NOTICE_MS
      }

      /*
       * 工具栏那颗「立即归档超时会话」的悬浮提示。
       * 时长取快照的 `archive_after_hours`（宿主真实配置）；旧宿主没这个字段时是 0，
       * 退化成不带数字的说法（见 `archiveHintOf`）。
       */
      const archiveHint = archiveHintOf(data ? data.archive_after_hours : 0)

      const concurrency = data && data.concurrency ? data.concurrency : {}
      const workspaces = data && Array.isArray(data.workspaces)
        ? data.workspaces.filter(function (item) { return item && typeof item.id === 'string' })
        : []

      const runningNow = num(concurrency.running, num(counts.running, 0))
      const maxWorkers = num(concurrency.max, 0)
      const queuedNow = num(counts.queued, 0)
      // 总计不含已归档：归档只在它自己的 chip 里计数，否则「全部」和总计对不上。
      const archivedNow = num(counts.archived, allTasks.filter(function (task) { return Boolean(task.archived_at) }).length)
      const totalNow = Math.max(0, num(counts.total, allTasks.length) - archivedNow)
      const failedNow = num(counts.failed, 0)

      // 工作区筛选与状态 chip 取交集；之后的「效果」数字也只看这个范围。
      // 下钻（`drill`）按下钻类型追加条件：工作区行 → workspace_id/host_workspace_id，
      // 批次行 → group，主会话行 → parent_session_id，状态条 → status。
      // 总览的「已筛选 ×」提示条就是在复述这一份判据，所以它必须只有一处。
      const scopedTasks = allTasks.filter(function (task) {
        if (workspace && task.workspace_id !== workspace) return false
        if (!drill) return true
        if (drill.kind === 'workspaceId') return task.workspace_id === drill.value
        if (drill.kind === 'hostWorkspaceId') return task.host_workspace_id === drill.value
        if (drill.kind === 'group') return task.group === drill.value
        if (drill.kind === 'parentSessionId') return task.parent_session_id === drill.value
        if (drill.kind === 'status') return task.status === drill.value
        return true
      })
      const currentFilter = FILTERS.filter(function (item) { return item.id === filter })[0] || FILTERS[0]

      // 记忆治理：窗口口径与退休数都来自快照的 memory 块（plans/07 P0-1 / P0-5）。
      // memory 为 null = 宿主没提供（旧版 / headless / 实现未落地），一律降级不报错。
      const memory = data && data.memory && typeof data.memory === 'object' ? data.memory : null
      const window = pickWindow(memory)
      const retiredDropped = memory && memory.ledger && Number.isFinite(memory.ledger.retiredDropped)
        ? Math.max(0, memory.ledger.retiredDropped)
        : 0
      /*
       * 窗口键的落定时机（plans/09 §三.1 默认沿用 memory.window）：
       * - 用户点过 chip（`windowKey` 非空）→ 一直用用户选的，**不再**被 memory 覆盖；
       * - 没点过 → 跟随 memory.window 算出来的键；memory 还没到手就退回 '7d'。
       * 这段是渲染期派生而不是 effect：effect 里 setState 会多一次提交，
       * 而「窗口」必须在**这一帧**就确定，否则首帧会按 7d 取一次 stats 再按 30d 重取。
       */
      const effectiveWindow = windowKey || defaultWindowKey(memory)

      /**
       * 取 `/board/stats`（plans/09 P1）。
       *
       * 为什么这个 effect 放在派生值之后：请求要带的是**已经落定的窗口**
       * （`effectiveWindow`），它要等快照里的 memory 到手才算得出来。放在其他
       * effect 旁边就得把「memory → 窗口」这段派生再抄一遍，抄的那份迟早与
       * 渲染用的这份不一致——那正是「同一个数字在两个视图里不一样」的来源。
       * hook 的顺序仍然无条件且固定（它在渲染体的同一位置），不违反 hook 规则。
       *
       * 三条设计决定：
       * 1. **只在效果/拆解视图才取**：总览不需要全量聚合，跟着 2 秒轮询拉它纯属浪费，
       *    而且 stats 挂了也不该影响总览（§八.10）。
       * 2. **依赖窗口 / 维度 / 下钻 / 工作区**：换任何一个都必须重取，否则新视图会拿
       *    旧窗口的数字算比例——那正是「同一个 86% 悄悄漂移」。
       * 3. **失败只记在 statsState 里**，不 setNotice、不自动重试：宿主进程还跑着旧
       *    代码时 `/board/stats` 会稳定 404，每 2 秒弹一次错误条等于把看板变成一条
       *    消不掉的报错。用户点「重试统计」才重取（`generation` 一变就重来）。
       */
      useEffect(function () {
        if (view !== 'effect' && view !== 'breakdown') return undefined
        let disposed = false
        const controller = new AbortController()
        // 保留旧数据只切 loading：视图不会闪成空白，滚动位置也不会跳。
        setStatsState(function (current) {
          return { state: 'loading', data: current.data, error: '' }
        })
        const scope = { window: effectiveWindow }
        /*
         * 工作区参数只传一个维度：
         * - 下钻到「实际归属」→ hostWorkspaceId（那是这条管线唯一能算的口径）；
         * - 下钻到「派发目标」或总览下拉 → workspaceId。
         * 两个都传等于取交集，会让「实际归属」下钻后一条都不剩。
         */
        if (drill && drill.kind === 'hostWorkspaceId') scope.hostWorkspaceId = drill.value
        else if (drill && drill.kind === 'workspaceId') scope.workspaceId = drill.value
        else if (workspace) scope.workspaceId = workspace
        readStats(statsQuery(scope), controller.signal)
          .then(function (payload) {
            if (disposed || controller.signal.aborted) return
            setStatsState({ state: 'ok', data: payload, error: '' })
          })
          .catch(function (error) {
            if (disposed || controller.signal.aborted || (error && error.name === 'AbortError')) return
            setStatsState({ state: 'fail', data: null, error: describeError(error) })
          })
        return function () {
          disposed = true
          controller.abort()
        }
      }, [view, effectiveWindow, dimension, drill, workspace, generation])


      const live = scopedTasks.filter(function (task) { return !task.archived_at })
      const stats = effectStats(live, now, window)
      const backgroundNow = live.filter(function (task) { return Boolean(task.background) }).length

      // 三段：需要人处理 / 在跑与排队 / 最近完成。归档只在它自己的视图里出现。
      const attention = sortAttention(live.filter(function (task) { return ATTENTION_STATUS.has(task.status) }))
      const activeTasks = live.filter(function (task) {
        return task.status === 'running' || task.status === 'queued'
      })
      const finished = live
        .filter(function (task) {
          return !ATTENTION_STATUS.has(task.status) && task.status !== 'running' && task.status !== 'queued'
        })
        .sort(function (a, b) {
          return (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0)
        })
      const activeGroups = groupActive(clusterByGroup(activeTasks))
      const shownFinished = showDone ? finished : finished.slice(0, 5)
      const archivedTasks = scopedTasks.filter(function (task) { return Boolean(task.archived_at) })

      /*
       * ── plans/09 P2：历史视图的行集合 ──
       *
       * 数据来源**刻意不用 `scopedTasks`**：后者已经被总览的状态 chip、工作区
       * 下拉与下钻筛过。历史视图有自己的四组筛选，复用那份的数据会让「我在效果页
       * 下钻到 ws-2 再切历史」时看不到 ws-1 的记录，而历史的意义恰恰是全量可查。
       * 这里只吃两样东西：`/board` 快照（活表 + 已归档）与 `/board/retired`。
       *
       * 三个子视图的边界（§五.4）：
       * - `all`     = 快照的全部任务（含已归档）；退休留痕**不在**快照里，
       *               所以它出现在 `retired` 而不是 `all`——否则同一份账本会在
       *               两个子视图里给出两个总数；
       * - `archived`= 只有 `archived_at` 非空的行；
       * - `retired` = 只有 `/board/retired` 的留痕。
       */
      const historyTaskRows = allTasks.map(function (task) { return historyRowOf(task, 'task') })
      const historyRetiredRows = retired.data && Array.isArray(retired.data.entries)
        ? retired.data.entries
          .filter(function (entry) { return entry && typeof entry === 'object' })
          .map(function (entry) { return historyRowOf(entry, 'retired') })
        : []
      const historySourceRows = histSub === 'retired'
        ? historyRetiredRows
        : histSub === 'archived'
          ? historyTaskRows.filter(function (row) { return Boolean(row.archived_at) })
          : historyTaskRows
      /**
       * 时间筛选复用**既有的窗口换算**（`windowDaysOf()`），不在这里另写一份
       * 「7 天 = 多少毫秒」：两个地方各算一遍，就会在某个时区/边界上差一小时，
       * 而历史视图里差一小时意味着「少了一条记录」。
       */
      const histDays = windowDaysOf(histTime)
      const histSince = histDays > 0 ? now - histDays * 86400000 : NaN
      const historyFiltered = filterHistoryRows(historySourceRows, {
        status: histStatus,
        workspace: histWorkspace,
        since: histSince,
        retried: histRetried,
        background: histBackground,
      }).filter(function (row) { return historyMatches(row, histQuery) })
      const historySorted = sortHistoryRows(historyFiltered, histSort)
      const historyPages = Math.max(1, Math.ceil(historySorted.length / HISTORY_PAGE_SIZE))
      // 页码夹紧：换了筛选条件之后旧页码可能越界，这里按当前页数夹一次，
      // 不依赖「每个 setter 都记得重置页码」这种约定（漏一个就是一张空表）。
      const historyPage = Math.min(histPage, historyPages - 1)
      const historyPageRows = historySorted.slice(
        historyPage * HISTORY_PAGE_SIZE,
        (historyPage + 1) * HISTORY_PAGE_SIZE,
      )
      /** 抽屉按身份重找一遍当前行；找不到就是 null（数据已经没了，抽屉自动收起）。 */
      const drawerRow = drawerKey
        ? historyTaskRows.concat(historyRetiredRows).filter(function (row) {
            return row.task_id === drawerKey.task_id && row.kind === drawerKey.kind
          })[0] || null
        : null

      /**
       * 把历史视图的筛选改一次，并顺手把页码归零。
       *
       * 为什么统一走这个 setter：散在每个 onChange 里写 `setHistPage(0)` 总会漏一个，
       * 漏掉的那个表现是「筛选后停在空页」——看起来像筛选没生效。
       *
       * @param {Function} setter 对应的筛选 setter
       * @param {*} value 新值
       */
      const histChange = function (setter, value) {
        setter(value)
        setHistPage(0)
        // 换筛选时抽屉可能指向一条已经不在列表里的记录；留着它会让「表里没有、
        // 下面却挂着一张详情」变成自相矛盾。这里只关抽屉，不动用户的搜索词。
        setDrawerKey(null)
      }
      const histClear = function () {
        setHistQuery('')
        setHistStatus('')
        setHistWorkspace('')
        setHistTime('all')
        setHistSort('created')
        setHistRetried(false)
        setHistBackground(false)
        setHistPage(0)
      }

      const card = function (task, variant, dense) {
        return h(TaskCard, {
          key: task.task_id || 'row-' + variant,
          task: task,
          variant: variant,
          dense: dense,
          baseline: stats.average,
          now: now,
          fetchedAt: fetchedAt,
          busy: busy,
          /*
           * 行内归档的「哪一行在等确认」。只传这一个字符串而不是一个查询函数：
           * `TaskCard` 是无 hook 的展示组件，传函数会让每次渲染都多一次调用，
           * 也让离线冒烟里「props 就是数据」这条断言变难写。
           */
          archiveAsk: archiveAsk,
          // 续派：哪一行开着输入框 + 那一行的草稿 + 三个口子（见 `continueAsk` 的注释）。
          continueAsk: continueAsk,
          continueDraft: continueDraft,
          continueHandlers: continueHandlers,
          // 依赖短名表（PRD-02 §4.5）：行标签要说「等 A」「前置 A 失败」。
          depTitles: depTitles,
          /*
           * 「计划已更新」：这一行的三元组刚和上一轮不同，且还在 `PLAN_NOTICE_MS` 窗口内
           * （见上面的 effect）。传布尔而不是从表里现查：`TaskCard` 是纯展示组件，
           * 行只关心自己亮不亮。
           */
          planUpdated: planNoticeLive(task.task_id),
          handlers: handlers,
        })
      }

      /** 在跑与排队：批次的成员聚在一起，批次头给出 3/5 这样的进度。 */
      const activeList = function () {
        const rows = []
        for (const group of activeGroups.groups) {
          const progress = batchProgress(live, group.name)
          const depCounts = batchDependencyCounts(allTasks, group.name)
          rows.push(h(BatchHead, {
            key: 'batch-' + group.name,
            name: group.name,
            done: progress.done,
            total: progress.total,
            // 「3 个成员 · 1 个等待前置 · 1 个未执行」里的三个数字（PRD-02 §4.5）。
            members: depCounts.total,
            waiting: depCounts.waiting,
            skipped: depCounts.skipped,
          }))
          for (const task of group.members) rows.push(card(task, 'active', false))
        }
        if (activeGroups.singles.length) {
          if (activeGroups.groups.length) {
            rows.push(h('div', { key: 'single-head', className: 'dsh-sa-subhead' }, tr('sec.single')))
          }
          for (const task of activeGroups.singles) rows.push(card(task, 'active', false))
        }
        return rows
      }

      /*
       * 总览的三个新信号（plans/09 §五.1）——只许加这三个，不许推翻 06 的三段结构：
       *   健康角标 / 当前排队最久 / 样本口径入口。
       */
      const queueOldest = live
        .filter(function (task) { return task.status === 'queued' })
        .map(function (task) { return Date.parse(task.created_at || '') || 0 })
        .filter(function (at) { return at > 0 })
        .sort(function (a, b) { return a - b })[0] || 0
      /**
       * 健康角标的三类信号，全部能从**快照**直接算出来：
       * - 待读超时：`input_pending_at` 已经等了超过 10 分钟（worker 还没读进去）；
       * - 后台收尾超时：`background.since` 超过 30 分钟（回合早结束了，job 还挂着）；
       * - 归档失败：`archive_error` 非空（归档巡检失败，session 目录里留下了东西）。
       * 「报告未送达」只有 stats 里有（快照不投影 delivery），所以它只在这两个
       * 分析视图里出现——不在总览里编一个快照算不出来的数（§八.6）。
       */
      const UNREAD_STALE_MS = 10 * 60 * 1000
      const BACKGROUND_STALE_MS = 30 * 60 * 1000
      const healthUnread = live.filter(function (task) {
        if (!task.input_pending_at || task.input_read_at) return false
        const at = Date.parse(task.input_pending_at)
        return Number.isFinite(at) && now - at > UNREAD_STALE_MS
      }).length
      const healthBackground = live.filter(function (task) {
        if (!task.background || typeof task.background !== 'object') return false
        const at = Date.parse(task.background.since || '')
        return Number.isFinite(at) && now - at > BACKGROUND_STALE_MS
      }).length
      const healthArchiveError = live.filter(function (task) { return Boolean(task.archive_error) }).length
      const healthTotal = healthUnread + healthBackground + healthArchiveError

      /*
       * 分析视图可用性（plans/09 §八.10）。
       *
       * stats 请求失败（宿主进程还跑着旧代码、`/board/stats` 404）或宿主明确降级
       * （`degraded:true`，聚合抛过异常）时，分析视图**降级回总览**而不是白屏：
       * 用户点「效果」得到的仍然是一个能用的看板 + 一条说明原因的提示条。
       * 这里不是「把错误藏起来」——提示条会一直挂着，直到 stats 恢复。
       */
      /*
       * ───── 顶层看板切换：派发工作台 / 分析看板（二选一） ─────
       *
       * 这一组 hook 全部加在 BoardPanel 的**末尾**（既有 20 多个 hook 之后）：
       * 离线冒烟的迷你 React 按调用序号复用 store，把新 hook 插在中间会让
       * 视图、筛选、抽屉等旧状态整体错位。放在末尾，旧 hook 的序号一个不动。
       *
       * 状态与取数刻意留在根组件：AnalyticsView 是纯展示组件。真机里两者都能跑，
       * 但只有这样才能在离线冒烟里断言「切筛选 → 请求 → 数字跟着变」。
       */
      const [surface, setSurface] = useState('tasks')
      /**
       * 把当前面板镜像进 ref（给前面的 2 秒轮询读）。
       *
       * 直接在渲染期赋值而不是放进 effect：effect 要等这一帧提交完才跑，
       * 那一帧里轮询读到的还是旧面板；渲染期赋值让「这一帧的面板」立刻可见。
       * 这里写的是同一个对象（ref 在多次渲染间不变），不会有并发写的问题。
       */
      surfaceRef.current = surface
      const [anFilters, setAnFilters] = useState({
        window: '7d', status: 'all', owner: 'all', workspaceId: 'all', group: 'all', overdueHours: 24,
      })
      const [anCustomDays, setAnCustomDays] = useState('')
      const [anTrendMode, setAnTrendMode] = useState('chart')
      /** { status: 'idle'|'loading'|'ok'|'fail', data, error }；失败时保留上一次的 data。 */
      const [anState, setAnState] = useState({ status: 'idle', data: null, error: '' })
      const [anGeneration, setAnGeneration] = useState(0)
      const anQuery = analyticsQuery(anFilters)
      const anActive = surface !== 'tasks'

      /* 分析数据只在分析视图可见时取；失败/降级不影响派发工作台的 2 秒轮询。 */
      useEffect(function () {
        if (!anActive) return undefined
        let disposed = false
        let controller = null
        let timer = null

        function arm() {
          if (disposed || timer) return
          if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
          timer = setTimeout(function () { timer = null; void load() }, AN_POLL_MS)
        }

        async function load() {
          if (disposed) return
          if (controller) controller.abort()
          const current = new AbortController()
          controller = current
          // 只切 loading，不清旧数据：筛选时不会闪成空白。
          setAnState(function (previous) { return { status: 'loading', data: previous.data, error: '' } })
          try {
            const data = await readAnalytics(anQuery, current.signal)
            if (disposed || current.signal.aborted) return
            setAnState({ status: 'ok', data: data, error: '' })
          } catch (error) {
            if (disposed || current.signal.aborted || (error && error.name === 'AbortError')) return
            setAnState(function (previous) {
              return { status: 'fail', data: previous.data, error: describeError(error) }
            })
          } finally {
            if (controller === current) controller = null
            arm()
          }
        }

        function onVisibility() {
          if (typeof document === 'undefined') return
          if (timer) { clearTimeout(timer); timer = null }
          if (document.visibilityState !== 'visible') {
            if (controller) controller.abort()
            return
          }
          void load()
        }

        function cleanup() {
          disposed = true
          if (timer) { clearTimeout(timer); timer = null }
          if (controller) controller.abort()
          controller = null
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }

        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        void load()
        return cleanup
      }, [anActive, anQuery, anGeneration])

      const anSetFilter = function (field, value) {
        setAnFilters(function (current) {
          const next = Object.assign({}, current)
          next[field] = value
          return next
        })
      }
      const anClear = function () {
        setAnFilters({ window: '7d', status: 'all', owner: 'all', workspaceId: 'all', group: 'all', overdueHours: 24 })
        setAnCustomDays('')
      }
      const anRefresh = function () { setAnGeneration(function (value) { return value + 1 }) }
      const anApplyCustomDays = function () {
        const raw = Number(anCustomDays)
        if (!Number.isFinite(raw) || raw < 1) return
        const days = Math.min(365, Math.floor(raw))
        setAnFilters(function (current) { return Object.assign({}, current, { window: days + 'd' }) })
      }
      const analyticsView = h(AnalyticsView, {
        filters: anFilters,
        state: anState,
        trendMode: anTrendMode,
        customDays: anCustomDays,
        onFilter: anSetFilter,
        onCustomDays: setAnCustomDays,
        onApplyCustomDays: anApplyCustomDays,
        onClear: anClear,
        onRefresh: anRefresh,
        onTrendMode: setAnTrendMode,
        onSwitch: function () { setSurface('tasks') },
      })

      const surfaceBar = h(
        'div',
        { className: 'dsh-sa-surfacebar' },
        h('span', { className: 'dsh-sa-surface-label' }, tr('an.surface')),
        h(
          'div',
          { className: 'dsh-sa-surface-tabs', role: 'tablist', 'aria-label': tr('an.surface') },
          [
            { id: 'tasks', labelKey: 'an.surfaceTasks' },
            { id: 'analytics', labelKey: 'an.surfaceAnalytics' },
          ].map(function (item) {
            return h('button', {
              key: item.id,
              type: 'button',
              role: 'tab',
              className: 'dsh-sa-tab',
              'aria-selected': surface === item.id,
              'data-surface-tab': item.id,
              title: tr('an.surfaceHint'),
              onClick: function () {
                setSurface(item.id)
                // 切回派发工作台：把 2 秒轮询立刻叫醒。
                // 分析看板可见期间那条轮询是停着的（见它的 load()），所以这里
                // 必须显式重启一次，否则回来看到的是切换前那张旧快照。
                if (item.id === 'tasks') refresh()
              },
            }, tr(item.labelKey))
          }),
        ),
      )

      const statsPayload = statsState.data
      const statsUsable = Boolean(statsPayload) && statsPayload.degraded !== true
      /**
       * **当前展示中**的那份 payload 用的窗口键。
       *
       * 为什么口径行不能跟着「即将生效的选择」走：切窗口 / 下钻时新请求还没回来，
       * 面板上显示的仍是**旧 payload** 的数字，而窗口提示已经换成了新窗口——
       * 于是界面上是「新标签 + 旧数字」，两件事说的不是同一批数据
       * （实测切窗口时口径行用新窗口、数字还是旧的）。
       *
       * 所以口径一律跟着 payload 走：Host 在 `scope.window.key` 里回显了
       * 这份数字**实际**用的窗口，那就是唯一可信的标签来源。
       * 还没有 payload 时（第一次取数）退回当前选择——那时面板上也没有旧数字。
       */
      const statsWindowKey = statsPayload && statsPayload.scope && statsPayload.scope.window
        ? String(statsPayload.scope.window.key || '')
        : ''
      const statsProblem = statsState.state === 'fail'
        ? statsState.error || tr('stats.unavailable')
        : (statsPayload && statsPayload.degraded === true ? (statsPayload.reason || tr('stats.unavailable')) : '')

      const viewTabs = h(
        'div',
        { className: 'dsh-sa-tabs', role: 'tablist', 'aria-label': tr('view.tabs') },
        [
          { id: 'overview', labelKey: 'view.overview' },
          { id: 'effect', labelKey: 'view.effect' },
          { id: 'breakdown', labelKey: 'view.breakdown' },
          // plans/09 P2：第四个视图。顺序固定为 总览 / 效果 / 拆解 / 历史——
          // 「现在 → 评价 → 定位 → 证据」是一条从行动到溯源的路径，不按使用频率排。
          { id: 'history', labelKey: 'view.history' },
        ].map(function (item) {
          return h(
            'button',
            {
              key: item.id,
              type: 'button',
              role: 'tab',
              className: 'dsh-sa-tab',
              'aria-selected': view === item.id,
              'data-view-tab': item.id,
              title: tr('view.switchHint'),
              onClick: function () { setView(item.id) },
            },
            tr(item.labelKey),
          )
        }),
      )

      /*
       * 窗口选择器只出现在效果/拆解两个视图里。
       *
       * 为什么不放总览：总览的四个数字按 `memory.window` 算（plans/07 P0-1 的口径），
       * 而 stats 的窗口是**另一个**数（用户可选 24h/7d/30d/all）。两个窗口共存于
       * 首屏会让「最近 7 天」这句话指代不明——同一个页面上出现两个 7 天，口径就废了。
       * 总览只保留「样本口径入口」，点进去才换窗口（§五.1「点击效果带进入效果视图」）。
       */
      const windowBar = h(
        'div',
        { className: 'dsh-sa-win', role: 'group', 'aria-label': tr('win.label') },
        h('span', { className: 'dsh-sa-win-label' }, tr('win.label')),
        WINDOW_PRESETS.map(function (preset) {
          return h(
            'button',
            {
              key: preset.id,
              type: 'button',
              className: 'dsh-sa-chip',
              'aria-pressed': effectiveWindow === preset.id,
              'data-window': preset.id,
              title: tr('win.fromMemory'),
              onClick: function () {
                // 选定即生效：`windowKey` 一旦非空，`effectiveWindow` 就不再回落到
                // memory 的默认值——「用户选过就不再被 memory 覆盖」由它自己承担。
                setWindowKey(preset.id)
              },
            },
            windowChipLabel(preset),
          )
        }),
      )

      /*
       * 下钻提示条：筛选一旦生效就必须一直可见，否则「这个数字为什么是 3」无处可查。
       * 「清除」写两个状态：`drill` 与顶部 `workspace` 下拉——点工作区行时两者一起写，
       * 只清一个会留下一个看不见的筛选条件（下拉说全部、提示条说已筛选）。
       */
      const drillLabel = drill
        ? fill(
            drill.kind === 'workspaceId' ? tr('drill.target')
              : drill.kind === 'hostWorkspaceId' ? tr('drill.host')
                : drill.kind === 'group' ? tr('drill.batch')
                  : drill.kind === 'parentSessionId' ? tr('drill.parent')
                    : tr('drill.status'),
            { name: drill.name },
          )
        : ''
      const drillBar = drill
        ? h(
            'div',
            { className: 'dsh-sa-drill', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'dsh-sa-drill-label' }, fill(tr('drill.active'), { label: drillLabel })),
            h('button', {
              type: 'button',
              className: 'dsh-sa-btn',
              onClick: function () {
                setDrill(null)
                setWorkspace('')
                setView('overview')
              },
            }, tr('drill.clear')),
            // 批次/主会话/状态只能筛总览列表：/board/stats 只认 window 与两个工作区参数。
            // 不说清这一点，用户会以为效果卡也跟着变成 3 条了。
            drill.kind === 'workspaceId' || drill.kind === 'hostWorkspaceId'
              ? null
              : h('span', { className: 'dsh-sa-dim-note' }, tr('drill.onlyList')),
          )
        : null

      /**
       * 统计视图顶部的窗口提示（plans/07 §九：切窗口必须说「只统计最近 N 天」）。
       *
       * 窗口取自**当前展示的 payload**（`statsWindowKey`），不是当前选择：
       * 新请求在途时面板上还是旧数字，标签必须跟着旧数字走。
       */
      const windowNote = h(
        'div',
        { className: 'dsh-sa-scopenote', 'data-scope-note': statsWindowKey || effectiveWindow },
        windowScopeNote(statsWindowKey || effectiveWindow),
      )

      const header = h(
        'div',
        { className: 'dsh-sa-head' },
        h(
          'div',
          { className: 'dsh-sa-metrics' },
          h(Metric, { key: 'c', label: tr('concurrency'), value: runningNow + '/' + maxWorkers }),
          h(Metric, { key: 'q', label: tr('queuedOne'), value: queuedNow }),
          h(Metric, { key: 't', label: tr('total'), value: totalNow }),
          /*
           * 健康角标：三个信号加起来一个数，hover 说明分别是几条。
           * 只在 >0 时出现——「健康 0」是个没有信息量的角标，会长期占着首屏。
           */
          healthTotal > 0
            ? h('span', {
                key: 'health',
                className: 'dsh-sa-danger',
                'data-health': 'true',
                title: tr('unreadTag') + ' ' + healthUnread + ' · '
                  + tr('backgroundTag') + ' ' + healthBackground + ' · '
                  + tr('archiveErrorPrefix') + healthArchiveError,
              }, tr('filter.attention') + ' ' + healthTotal)
            : null,
          /*
           * 当前排队最久：比「排队 n」更能说明是否饿死——n 大可能是刚排进来，
           * 一条等了 40 分钟才是真的卡住了。没有排队任务时不显示。
           */
          queueOldest > 0 && queuedNow > 0
            ? h('span', {
                key: 'oldest',
                className: 'dsh-sa-meta',
                'data-oldest': 'true',
              }, formatDuration(Math.max(0, now - queueOldest)))
            : null,
          failedNow > 0
            ? h('span', { key: 'f', className: 'dsh-sa-danger' }, tr('failed') + ' ' + failedNow)
            : null,
          h('span', { key: 'grow', className: 'dsh-sa-grow' }),
          fetchedAt > 0 ? h('span', { key: 'time', className: 'dsh-sa-meta' }, tr('updatedAt') + ' ' + formatClock(fetchedAt)) : null,
        ),
        // 「派发到底带来了什么」：完成数、成功率、中位耗时、并行节省。
        // 都是快照里的近似值，hover 有定义，避免被当成账目。
        h(
          'div',
          { className: 'dsh-sa-stats' },
          h(Stat, { key: 'done', label: tr('stat.done'), value: stats.done, hint: tr('stat.doneHint') }),
          h(Stat, { key: 'rate', label: tr('stat.rate'), value: stats.rate === null ? tr('stat.none') : stats.rate + '%', hint: tr('stat.rateHint') }),
          h(Stat, { key: 'avg', label: tr('stat.average'), value: stats.average > 0 ? formatDuration(stats.average) : tr('stat.none'), hint: tr('stat.averageHint') }),
          h(Stat, {
            key: 'saved',
            label: tr('stat.saved'),
            value: stats.saved > 0 ? formatDuration(stats.saved) : tr('stat.none'),
            hint: tr('stat.savedHint'),
          }),
          // 口径必须跟着数字一起出现：一个不说范围的百分比会被当成「全部历史」读，
          // 而那正是 0.8.x 让上个月的失败任务给今天投票的原因（plans/07 §二 4）。
          h(
            'span',
            {
              key: 'window',
              className: 'dsh-sa-stat-window' + (window ? '' : ' dsh-sa-stat-window-unknown'),
              title: tr('stat.windowHint'),
            },
            tr('stat.windowLabel') + ' ' + stats.windowLabel,
          ),
          /*
           * 样本口径入口（plans/09 §五.1 的第三个信号）：不在首屏继续加卡片，
           * 只留一个「进去看口径」的带子。它同时是效果视图的入口。
           */
          h(
            'button',
            {
              key: 'scope-entry',
              type: 'button',
              className: 'dsh-sa-chip',
              'data-scope-entry': 'true',
              title: tr('scope.entryHint'),
              onClick: function () { setView('effect') },
            },
            fill(tr('scope.entry'), { window: scopeWindowText(effectiveWindow) }),
          ),
        ),
        h(ConcurrencyBar, { running: runningNow, max: maxWorkers, queued: queuedNow, background: backgroundNow }),
        viewTabs,
        /*
         * 窗口条与窗口提示只属于效果/拆解两个**统计**视图。
         *
         * 历史视图有它自己的「时间」筛选（`histTime`），再同时摆一条窗口 chip
         * 会让同一个页面上出现两个「最近 7 天」，而它们约束的是两件不同的事
         * （一个约束 stats 的分母，一个约束列表行）。§二 的顶部窗口定义的是
         * 「统计口径」，所以历史视图不显示它。
         */
        view === 'overview' || view === 'history' ? null : h('div', { className: 'dsh-sa-tabs' }, windowBar),
        view === 'overview' || view === 'history' ? null : windowNote,
        drillBar,
        // 状态 chip 与工作区下拉是**总览列表**的工具，分析视图里不该出现：
        // 在效果页点一个「已归档 chip」只会让人以为统计被筛了，其实没有（§八.7）。
        view === 'overview' ? h(
          'div',
          { className: 'dsh-sa-chips', role: 'group', 'aria-label': tr('title') },
          FILTERS.map(function (item) {
            // 退休 chip 的计数来自 memory 块（它不在这份任务列表里）；
            // 宿主不给 memory 时显示「—」而不是 0 —— 0 会被读成「确实一条都没有」。
            const count = item.remote === 'retired'
              ? (memory ? String(num(counts.retired, 0)) : '—')
              : String(scopedTasks.filter(item.match).length)
            return h(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'dsh-sa-chip',
                'aria-pressed': filter === item.id,
                onClick: function () { setFilter(item.id) },
              },
              tr(item.labelKey),
              h('span', { className: 'dsh-sa-chip-count' }, count),
            )
          }),
        ) : null,
        view === 'overview' ? h(
          'div',
          { className: 'dsh-sa-toolbar' },
          h(
            'select',
            {
              className: 'dsh-sa-select',
              'aria-label': tr('workspaceFilter'),
              title: tr('workspaceFilter'),
              value: workspace,
              onChange: function (event) {
                setWorkspace(event && event.target ? event.target.value || '' : '')
              },
            },
            h('option', { key: 'all', value: '' }, tr('workspaceAll')),
            workspaces.map(function (item) {
              return h('option', { key: item.id, value: item.id }, item.title || item.id)
            }),
          ),
          h('span', { key: 'grow', className: 'dsh-sa-grow' }),
          h(
            'button',
            {
              key: 'archive',
              type: 'button',
              className: 'dsh-sa-btn' + (archiveStage === 1 ? ' dsh-sa-btn-confirm' : ''),
              disabled: archiving,
              /*
               * hover 里放「归档的是什么、多久算超时」这份**说明**，不放按钮自己的名字：
               * 名字已经在按钮上（`archiveNow` / `archiveConfirm`），悬停时更该看到的是
               * 「点下去会发生什么、影响哪些任务」。`aria-label` 放当前动作名，
               * 读屏用户听到的是「立即归档超时会话」而不是一整句说明。
               */
              title: archiveHint,
              'aria-label': archiving
                ? tr('archiveRunning')
                : archiveStage === 1 ? tr('archiveConfirm') : tr('archiveNow'),
              onClick: function () {
                if (archiving) return
                if (archiveStage === 0) {
                  setArchiveStage(1)
                  return
                }
                void runArchive()
              },
            },
            archiving ? tr('archiveRunning') : archiveStage === 1 ? tr('archiveConfirm') : tr('archiveNow'),
          ),
        ) : null,
      )

      const strips = []
      if (failure) {
        strips.push(
          h(
            'div',
            { key: 'failure', className: 'dsh-sa-strip dsh-sa-strip-warn', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'dsh-sa-strip-text', title: failure },
              tr('unreachable') + '：' + failure + (data ? '（' + tr('stale') + '）' : '')),
            h('button', {
              type: 'button',
              className: 'dsh-sa-btn',
              onClick: refresh,
            }, tr('retry')),
          ),
        )
      }
      if (notice) {
        strips.push(
          h(
            'div',
            {
              key: 'notice',
              className: 'dsh-sa-strip dsh-sa-strip-' + (notice.tone || 'info'),
              role: notice.tone === 'error' ? 'alert' : 'status',
              'aria-live': 'polite',
            },
            h('span', { className: 'dsh-sa-strip-text', title: notice.text }, notice.text),
            h('button', {
              type: 'button',
              className: 'dsh-sa-btn',
              title: tr('dismiss'),
              onClick: function () { setNotice(null) },
            }, tr('dismiss')),
          ),
        )
      }
      /*
       * 退休记录自己也到了展示上限时，明说少给了多少。
       * 与 truncated 的理由相同：面板上「退休 1000 / 列表 200」看起来像数据丢了，
       * 而这里偏偏是「已经承认丢过一次数据」的视图，更不能安静截断。
       */
      /*
       * 退休记录溢出提示只在**总览的退休 chip** 里出现在顶部提示条；
       * 历史视图在表格上方自己有一条（`HistoryView` 的 `dropped` 参数），
       * 两处都挂就是同一个数字在页面上说两遍。
       */
      const retiredOverflow = filter === 'retired' && view === 'overview'
        ? num(retired.data && retired.data.dropped, 0) || retiredDropped
        : 0
      if (retiredOverflow > 0) {
        strips.push(
          h(
            'div',
            { key: 'retired-dropped', className: 'dsh-sa-strip dsh-sa-strip-warn', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'dsh-sa-strip-text', title: fill(tr('retired.dropped'), { n: retiredOverflow }) },
              fill(tr('retired.dropped'), { n: retiredOverflow })),
          ),
        )
      }

      let body
      /*
       * 分派顺序刻意是 **快照可用性 → 历史 → 分析视图 → 退休/归档/三段**：
       *
       * - 快照都拿不到时，分析视图也没有存在的意义（stats 更可能一起挂），先给
       *   「看板数据暂时取不到」；
       * - **历史放在分析视图之前**：它只依赖 `/board` 快照与 `/board/retired`，
       *   完全不碰 `/board/stats`。stats 挂了历史照样要能用（§八.10 的降级要求，
       *   而历史是「查证据」的地方，恰恰最不该跟着统计一起失效）；
       * - 分析视图放在退休视图**之前**：退休 chip 是总览里的东西，用户在效果页
       *   不该被它劫持；分析视图的口径由它自己的窗口/下钻决定（§三.1）。
       */
      if (!data && !failure) {
        body = h(Blank, { title: tr('loading') })
      } else if (!data && failure) {
        body = h(Blank, {
          title: tr('unreachable'),
          hint: failure,
          action: h('button', { type: 'button', className: 'dsh-sa-btn', onClick: refresh }, tr('retry')),
        })
      } else if (view === 'history') {
        /*
         * 退休子视图的四条状态，逐条分开（照抄「已退休」视图的判据）：
         * - `memory` 缺失 → 宿主没提供退休留痕这块能力，不是「没有退休记录」；
         * - 取数失败      → 暂时取不到 + 重试，沿用现有 unreachable 模式；
         * - 还在加载      → 加载态；
         * - 正常          → 交给 HistoryView（它自己处理空表）。
         * 「全部 / 已归档」两个子视图不看 `retired` 的状态：它们的数据在快照里，
         * 不能因为另一个子视图的请求失败就连带失效。
         */
        const retiredBroken = histSub === 'retired'
          ? (!memory
              ? { title: tr('retired.unavailable'), hint: tr('retired.unavailableHint') }
              : retired.state === 'fail'
                ? { title: tr('retired.loadFailed').replace('{reason}', retired.error || tr('unknownError')) }
                : (retired.state === 'loading' && !retired.data)
                  ? { title: tr('loading') }
                  : null)
          : null
        if (retiredBroken) {
          body = h(Blank, {
            title: retiredBroken.title,
            hint: retiredBroken.hint,
            action: retired.state === 'fail'
              ? h('button', { type: 'button', className: 'dsh-sa-btn', onClick: refresh }, tr('retry'))
              : null,
          })
        } else {
          body = h(HistoryView, {
            sub: histSub,
            rows: historyPageRows,
            total: historySorted.length,
            rawTotal: historySourceRows.length,
            page: historyPage,
            pages: historyPages,
            query: histQuery,
            status: histStatus,
            workspaceId: histWorkspace,
            timeKey: histTime,
            sort: histSort,
            retried: histRetried,
            background: histBackground,
            workspaces: workspaces,
            now: now,
            truncated: data ? data.truncated : null,
            dropped: histSub === 'retired' ? num(retired.data && retired.data.dropped, 0) : 0,
            emptyHint: tr('hist.subHint'),
            selected: drawerRow ? { kind: drawerRow.kind, task_id: drawerRow.task_id } : null,
            drawerRow: drawerRow,
            // 抽屉里的「计划已更新」（PRD §11.3）：与列表行同一个窗口判断。
            drawerPlanUpdated: drawerRow ? planNoticeLive(drawerRow.task_id) : false,
            depTitles: depTitles,
            onSub: function (next) {
              setHistSub(next)
              setHistPage(0)
              setDrawerKey(null)
            },
            onQuery: function (value) { histChange(setHistQuery, value) },
            onStatus: function (value) { histChange(setHistStatus, value) },
            onWorkspace: function (value) { histChange(setHistWorkspace, value) },
            onTime: function (value) { histChange(setHistTime, value) },
            onSort: function (value) { histChange(setHistSort, value) },
            onRetried: function (value) { histChange(setHistRetried, value) },
            onBackground: function (value) { histChange(setHistBackground, value) },
            onPage: function (value) { setHistPage(Math.max(0, num(value, 0))) },
            onClear: histClear,
            onSelect: function (row) { setDrawerKey({ kind: row.kind, task_id: row.task_id }) },
            onCloseDrawer: function () { setDrawerKey(null) },
            onCopy: copyRetiredId,
            onOpen: openWorker,
          })
        }
      } else if (view === 'effect' || view === 'breakdown') {
        /*
         * 分析视图的四条状态，逐条分开（§八.10「不白屏、不报错循环」）：
         * 1. stats 还没有数据（首次取数 / 正在取）→ 加载态；
         * 2. stats 取不到（404 / 网络错误 / 宿主降级）→ **降级回总览** + 原因 + 重试；
         * 3. 拿到了但 summary 缺失 → 由视图自己说「没有可用汇总」；
         * 4. 正常 → 渲染。
         *
         * 第 2 条刻意回总览而不是留在空白页：一个打不开的效果页等于把整个看板
         * 变白，而任务列表其实好好的。回到总览，用户至少还能干活。
         */
        if (!statsPayload && statsState.state !== 'fail') {
          body = h(Blank, { title: tr('stats.loading') })
        } else if (!statsUsable) {
          body = h(Blank, {
            title: tr('stats.unavailable'),
            hint: statsProblem + ' · ' + tr('stats.unavailableHint'),
            action: h('div', null,
              h('button', { type: 'button', className: 'dsh-sa-btn', onClick: refresh }, tr('stats.retry')),
              ' ',
              h('button', {
                type: 'button',
                className: 'dsh-sa-btn',
                onClick: function () { setView('overview') },
              }, tr('stats.back'))),
          })
        } else if (view === 'effect') {
          body = h(EffectView, {
            stats: statsPayload,
            trendMode: trendMode,
            onTrendMode: setTrendMode,
            onRetry: refresh,
          })
        } else {
          body = h(BreakdownView, {
            stats: statsPayload,
            dimension: dimension,
            now: now,
            onDimension: setDimension,
            onRetry: refresh,
            onDrill: function (pick) {
              /*
               * 下钻 = 把这一行的键设为过滤条件并回到总览（§五.3）。
               *
               * 工作区行要**同时**写顶部 `workspace` 下拉：两个控件表达同一个筛选，
               * 只写一个会出现「下拉显示全部，列表却只剩 3 条」。其余三类（批次 /
               * 主会话 / 状态）没有对应的下拉控件，只写 `drill`。
               */
              if (pick.kind === 'workspaceId' || pick.kind === 'hostWorkspaceId') {
                setWorkspace(pick.kind === 'workspaceId' ? pick.value : '')
              }
              setDrill(pick)
              setView('overview')
            },
          })
        }
      } else if (filter === 'retired') {
        /*
         * 退休视图先于「还没有任务」的空态判断：账本封顶之后，一个跑很久的实例
         * 完全可能活跃任务为 0、退休记录却有一堆。把它落到「还没有任务」的空态上
         * 等于告诉用户「一切正常」，而实际发生的是「东西被搬走了」。
         *
         * 三种降级各有各的话，绝不混成一句：
         * - memory 为 null  → 宿主未提供（旧版/headless），不是「没有退休记录」；
         * - 加载失败        → 暂时取不到 + 重试，沿用现有 unreachable 模式；
         * - 真的空          → 「没有被退休的任务」。
         */
        const memoryMissing = !memory
        if (memoryMissing) {
          body = h(Blank, { title: tr('retired.unavailable'), hint: tr('retired.unavailableHint') })
        } else if (retired.state === 'fail') {
          body = h(Blank, {
            title: tr('retired.loadFailed').replace('{reason}', retired.error || tr('unknownError')),
            action: h('button', { type: 'button', className: 'dsh-sa-btn', onClick: refresh }, tr('retry')),
          })
        } else if (retired.state === 'loading' && !retired.data) {
          body = h(Blank, { title: tr('loading') })
        } else if (retired.data && Array.isArray(retired.data.entries) && retired.data.entries.length) {
          const entries = retired.data.entries.filter(function (entry) { return entry && typeof entry === 'object' })
          body = h(Section, {
            title: tr('sec.retired'),
            count: num(retired.data.count, entries.length),
            body: h('div', { role: 'list', 'aria-label': tr('sec.retired') }, entries.map(function (entry, index) {
              return h(RetiredRow, {
                key: entry.task_id || 'retired-' + index,
                record: entry,
                now: now,
                onCopy: copyRetiredId,
              })
            })),
          })
        } else {
          body = h(Blank, { title: tr('retired.empty') })
        }
      } else if (allTasks.length === 0) {
        body = h(Blank, {
          title: tr('empty'),
          hint: h('code', null, 'dispatch_launch'),
        })
      } else if (filter === 'archived') {
        body = archivedTasks.length
          ? h(Section, {
              title: tr('sec.archived'),
              count: archivedTasks.length,
              body: h('div', { role: 'list', 'aria-label': tr('sec.archived') }, archivedTasks.map(function (task) {
                return card(task, 'archived', true)
              })),
            })
          : h(Blank, { title: tr('emptyFiltered') })
      } else if (filter === 'attention') {
        body = attention.length
          ? h(Section, {
              title: tr('sec.attention'),
              count: attention.length,
              body: h('div', { role: 'list', 'aria-label': tr('sec.attention') }, attention.map(function (task) {
                return card(task, 'attention', false)
              })),
            })
          : h(Blank, { title: tr('sec.attentionEmpty') })
      } else if (filter === 'active') {
        body = activeTasks.length
          ? h(Section, {
              title: tr('sec.active'),
              count: activeTasks.length,
              body: h('div', { role: 'list', 'aria-label': tr('sec.active') }, activeList()),
            })
          : h(Blank, { title: tr('sec.activeEmpty') })
      } else {
        // 总览：需要你处理 → 在跑与排队 → 最近完成。
        const parts = []
        if (attention.length) {
          parts.push(h(Section, {
            key: 'attention',
            title: tr('sec.attention'),
            count: attention.length,
            body: h('div', { role: 'list', 'aria-label': tr('sec.attention') }, attention.map(function (task) {
              return card(task, 'attention', false)
            })),
          }))
        }
        if (activeTasks.length) {
          parts.push(h(Section, {
            key: 'active',
            title: tr('sec.active'),
            count: activeTasks.length,
            body: h('div', { role: 'list', 'aria-label': tr('sec.active') }, activeList()),
          }))
        }
        if (finished.length) {
          parts.push(h(Section, {
            key: 'done',
            title: tr('sec.done'),
            count: finished.length,
            action: finished.length > 5
              ? h('button', {
                  type: 'button',
                  className: 'dsh-sa-btn',
                  onClick: function () { setShowDone(function (value) { return !value }) },
                }, showDone ? tr('showLess') : tr('showAll') + ' ' + finished.length)
              : null,
            body: h('div', { role: 'list', 'aria-label': tr('sec.done') }, shownFinished.map(function (task) {
              return card(task, 'done', true)
            })),
          }))
        }
        /*
         * 空总览必须区分「真的没有任务」和「任务都在归档区」。
         *
         * 后一种情况用户会以为数据丢了（保留期从 24h 提到 168h 就是为了少撞上它），
         * 所以把 `counts.archived` 直接说出来——不新增接口，N 来自快照已有字段。
         */
        body = parts.length
          ? h('div', { className: 'dsh-sa-sections' }, parts)
          : h(Blank, {
              title: tr('emptyFiltered'),
              hint: archivedNow > 0
                ? fill(tr('emptyArchivedHint'), { n: archivedNow })
                : null,
            })
      }

      /*
       * 样本口径行固定出现在效果/拆解视图内容之前（plans/09 §三.4「每个视图固定显示」）。
       *
       * 位置在内容**上方**而不是页脚：它解释的是「下面这些数字的分母是什么」，
       * 放到最后等于让人先读结论再读前提。stats 不可用时这一行也没有意义
       * （coverage 全是 0/—，只会制造「真的没有任务」的错觉），所以只在可用时出现。
       *
       * 历史视图不挂这一行：它的样本量已经在分页条上写清楚了（「筛选后 n / 共 m 条」），
       * 而 coverage 描述的是 stats 的口径，和历史列表的行数不是同一个分母——
       * 把两个数并排放在一起，只会让人以为其中一个算错了。
       */
      if ((view === 'effect' || view === 'breakdown') && statsUsable) {
        body = h(
          'div',
          null,
          h(ScopeLine, {
            coverage: statsPayload.coverage,
            // 窗口标签跟着这份 payload 走（新请求在途时，面板上的数字还是旧的）。
            windowId: statsWindowKey || effectiveWindow,
          }),
          body,
        )
      }

      /*
       * 二选一的装配点。派发工作台模式下 `header / strips / body` 三段的**顺序、
       * 内容与 props 完全保持原样**，只在前面多一条顶层切换条；因此五个 chip、
       * 工作区下拉、批次聚合、行内取消/重试/归档/续派/跳会话、历史抽屉都不受影响。
       * 切到分析看板时派发工作台不渲染，但 2 秒快照轮询照常，切回来立刻是最新数据。
       */
      return h(
        'div',
        { className: 'dsh-sa', role: 'region', 'aria-label': tr('title'), 'data-surface': surface },
        h('style', null, STYLE),
        surfaceBar,
        surface === 'analytics'
          ? h('div', { className: 'dsh-sa-body' }, analyticsView)
          : [
            header,
            strips.length ? strips : null,
            h('div', { className: 'dsh-sa-body' }, body),
          ],
      )
    }

    /** 当前挂载中的面板清理函数；插件卸载时由 ctx.effect 兜底调用。 */
    let activePanelCleanup = null

    /** 输入框控件挂载期间挂上去的 document 监听清理；插件卸载时兜底调用。 */
    let activePickerCleanup = null

    /** 插件 Context；面板用它取 uiWorkspace 打开子会话（取不到时降级为提示，不抛错）。 */
    let appContext = null

    /* ───────────────────────── 插件入口 ───────────────────────── */

    const name = 'dsh-mini-superagent'
    const inject = ['slots']

    function apply(ctx) {
      // 面板点行要打开子会话，这里留一份 Context 供渲染期读取。
      appContext = ctx

      // 可选：接上 Client locale。失败只是保持内置中文。
      attachLocale(ctx)

      // 插件卸载（含 HMR 换包）时，面板即使还没来得及卸载也要停表、中止请求。
      ctx.effect(function () {
        return function () {
          if (typeof activePanelCleanup === 'function') {
            try { activePanelCleanup() } catch (error) { /* 清理失败不阻塞卸载 */ }
            activePanelCleanup = null
          }
        }
      }, 'dsh-mini-superagent: task board cleanup')

      // 侧边栏图标：id 就是下面主面板的 key。
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: BOARD_ID,
          order: 60,
          label: '派发工作台',
        }, BoardIcon)
      })

      // 主面板：点了侧边栏图标就切到这里。
      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: BOARD_ID,
        }, BoardPanel)
      })

      // 输入框工具行左侧的「派发目标工作区」控件（会话作用域，sessionId 由槽注入）。
      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-mini-superagent/target',
          order: 60,
          label: '派发目标',
        }, TargetPicker)
      })

      /*
       * 轮次分隔线：宿主在每条用户消息上方留的装饰槽（chain，会话作用域）。
       * 它只是装饰，注册失败不该把看板与输入框控件一起拖下水，所以单独 try/catch。
       */
      try {
        ctx.slots.inject('conversation.chat.user.before', function () {
          return ctx.slots.register({
            name: 'conversation.chat.user.before',
            select: selectTurnDivider,
          }, TurnDivider)
        })
      } catch (error) {
        ctx.logger?.warn?.('%s 轮次分隔线注册失败: %s', 'dsh-mini-superagent:', String(error))
      }

      // @ 工作区：可选能力。inputTriggers 不在（或没有 registerSource）就安静跳过。
      try {
        registerWorkspaceTrigger(ctx)
      } catch (error) {
        ctx.logger?.warn?.('%s @ 工作区触发源注册失败: %s', 'dsh-mini-superagent:', String(error))
      }

      // 插件卸载（含 HMR 换包）时兜底：输入框控件即使没走 React 卸载，也要摘掉 document 监听。
      ctx.effect(function () {
        return function () {
          if (typeof activePickerCleanup === 'function') {
            try { activePickerCleanup() } catch (error) { /* 清理失败不阻塞卸载 */ }
            activePickerCleanup = null
          }
        }
      }, 'dsh-mini-superagent: target picker cleanup')

      // 自报存活：客户端加载失败时页面上什么都看不到，这条记录是唯一能区分
      // 「模块没进图 / 进了图但 apply 抛错 / apply 跑完了」的证据。
      // 它只证明 apply 跑到了这里，不证明槽一定渲染成功——渲染要看面板本身。
      try {
        if (typeof fetch === 'function') {
          void fetch('/dsh-mini-superagent/board/client-ready', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
            body: JSON.stringify({
              ok: true,
              registered: [
                'sidebar.panellist',
                'main',
                'conversation.input.left',
                'conversation.chat.user.before',
                '@workspace',
              ],
            }),
          }).catch(function () { /* 宿主不在线时忽略 */ })
        }
      } catch (error) { /* 自报失败不影响功能 */ }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
