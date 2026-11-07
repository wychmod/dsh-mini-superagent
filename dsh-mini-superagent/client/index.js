/**
 * dsh-mini-superagent — Client 半边：常驻侧边栏图标 + 主面板「任务看板」
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
    /** Client locale 命名空间。 */
    const LOCALE_NS = 'dsh-mini-superagent.board'

    /* ───────────────────────── 文案 ───────────────────────── */

    /** 内置中文文案（locale 不可用时的兜底，也是默认界面语言）。 */
    const TEXT = {
      title: '任务看板',
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
      reports: '报告',
      noReport: '尚无报告',
      waiting: '等待中',
      updatedAt: '更新于',
      empty: '还没有任务。让主会话用 dispatch_launch 派发一个。',
      emptyFiltered: '这个筛选下没有任务。',
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
      archivedHint: '该子会话已归档，可能已不在会话列表里',
      archiveErrorPrefix: '归档失败：',
      archiveNow: '立即归档',
      archiveConfirm: '确认归档',
      archiveRunning: '归档中…',
      archiveDone: '归档巡检：扫描 {scanned}，归档 {archived}，失败 {failed}',
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
    }

    /** 英文文案，仅用于 locale 服务接入；缺 key 时由 tr() 退回中文。 */
    const TEXT_EN = {
      title: 'Task Board',
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
      reports: 'reports',
      noReport: 'no report yet',
      waiting: 'waiting',
      updatedAt: 'updated',
      empty: 'No tasks yet. Ask the main session to dispatch one with dispatch_launch.',
      emptyFiltered: 'No tasks in this filter.',
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
      archivedHint: 'That worker session was archived and may no longer be listed',
      archiveErrorPrefix: 'Archive failed: ',
      archiveNow: 'Archive now',
      archiveConfirm: 'Confirm archive',
      archiveRunning: 'Archiving…',
      archiveDone: 'Archive sweep: scanned {scanned}, archived {archived}, failed {failed}',
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

    /** 可操作的任务给出按钮：进行中→取消；需要处理/已结束→重试。 */
    function actionOf(status) {
      if (status === 'running' || status === 'queued') return 'cancel'
      if (status === 'failed' || status === 'interrupted' || status === 'ended' || status === 'blocked') return 'retry'
      return null
    }

    /**
     * 四个过滤 chip 的定义。
     * 「全部」不含已归档：归档是历史，只在自己的 chip 里出现，否则列表会被历史淹没。
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
     * 「派发带来了什么」的一组近似值。
     *
     * 并行节省的定义：所有已结算任务的耗时之和，减去它们实际占用的墙钟跨度
     * （最早开始 → 最近更新）。串行做这些活要花前者，实际只花了后者，差额就是省下来的。
     * 明确是粗算：快照只含最近 200 条，跨天的任务也会算进来。宁可标注「粗算」，也不编一个好看的数字。
     */
    function effectStats(tasks, now) {
      const list = Array.isArray(tasks) ? tasks.filter(function (task) { return task && typeof task === 'object' }) : []
      const settled = list.filter(function (task) { return SETTLED_STATUS.has(task.status) })
      const done = settled.filter(function (task) { return task.status === 'done' }).length
      const durations = settled.map(function (task) { return num(task.elapsed_ms, 0) }).filter(function (value) { return value > 0 })
      const sum = durations.reduce(function (a, b) { return a + b }, 0)
      const starts = list.map(function (task) { return Date.parse(task.started_at || task.created_at || '') })
        .filter(function (value) { return Number.isFinite(value) })
      const ends = list.map(function (task) { return Date.parse(task.updated_at || '') })
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

    /* ───────────────── 派发目标：与输入框控件、@ 候选共用的数据层 ───────────────── */

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
.dsh-sa-row:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: -2px;
}
.dsh-sa-row-archived { opacity: .55; }
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
@keyframes dsh-sa-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .4; transform: scale(.78); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-sa-dot-pulse { animation: none; }
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
      return h(
        'div',
        { className: 'dsh-sa-batch' },
        h('span', { className: 'dsh-sa-tag dsh-sa-tag-group' }, tr('groupTag')),
        h('span', { className: 'dsh-sa-batch-name' }, String(props.name || '')),
        h('span', { className: 'dsh-sa-batch-count' }, done + '/' + total),
        h(
          'div',
          { className: 'dsh-sa-bar dsh-sa-batch-bar', 'aria-hidden': 'true' },
          h('div', { className: 'dsh-sa-bar-fill', style: { width: percent + '%' } }),
        ),
      )
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
      const kind = archived ? null : actionOf(task.status)
      const busyKind = props.busy[task.task_id]
      const summary = task.last_report && typeof task.last_report.summary === 'string'
        ? task.last_report.summary
        : ''
      const reportLine = firstLine(summary) || tr('noReport')
      const attempt = num(task.attempt, 1)
      const reportCount = num(task.report_count, 0)
      const title = typeof task.title === 'string' && task.title ? task.title : tr('noTitle')
      const group = typeof task.group === 'string' ? task.group : ''
      const background = task.background && typeof task.background === 'object' ? task.background : null
      const unread = Boolean(task.input_pending_at) && !task.input_read_at
      const clickable = Boolean(task.worker_session_id)
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

      const tip = [
        task.task_id,
        task.cwd ? 'cwd: ' + task.cwd : '',
        task.task_dir ? 'dir: ' + task.task_dir : '',
        task.worker_session_id ? 'worker: ' + task.worker_session_id : '',
      ].filter(Boolean).join('\n') + (clickable ? '\n' + tr('clickHint') : '') + (archived ? '\n' + tr('archivedHint') : '')

      /** 整行可点（按钮除外）：打开这个任务的子会话。 */
      function activate(event) {
        if (!clickable) return
        if (event) {
          if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
          if (event.preventDefault) event.preventDefault()
        }
        props.handlers.open(task)
      }

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

      const tags = [
        attempt > 1
          ? h('span', { key: 'attempt', className: 'dsh-sa-tag' }, tr('attemptPrefix') + attempt + tr('attemptSuffix'))
          : null,
        background
          ? h('span', { key: 'bg', className: 'dsh-sa-tag dsh-sa-tag-bg', title: tr('backgroundHint') }, tr('backgroundTag'))
          : null,
        unread
          ? h('span', { key: 'unread', className: 'dsh-sa-tag dsh-sa-tag-unread', title: tr('unreadHint') }, tr('unreadTag'))
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
          title: tip,
          tabIndex: clickable ? 0 : undefined,
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
          action,
        ),
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
          ? (reportCount > 0
              ? h('span', { key: 'dense-count', className: 'dsh-sa-dense-meta' }, tr('reports') + ' ' + reportCount)
              : null)
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
      /** 立即归档的两步确认：0 空闲，1 等待确认。 */
      const [archiveStage, setArchiveStage] = useState(0)
      const [archiving, setArchiving] = useState(false)

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
          if (controller) controller.abort()
          const current = new AbortController()
          controller = current
          try {
            const data = await readBoard(current.signal)
            if (disposed || current.signal.aborted) return
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

      /** 带中止控制的 POST，控制器统一登记，卸载时一并 abort。 */
      const post = useCallback(function (path, body) {
        const controller = new AbortController()
        if (inFlight.current) inFlight.current.add(controller)
        return postJson(path, body, controller.signal).finally(function () {
          if (inFlight.current) inFlight.current.delete(controller)
        })
      }, [])

      /* 写操作：取消 / 重试。成功后立刻重新取一次快照。 */
      const act = useCallback(function (kind, task) {
        if (!task || !task.task_id) return
        if (busy[task.task_id]) return
        setBusy(function (value) {
          const next = Object.assign({}, value)
          next[task.task_id] = kind
          return next
        })
        post(kind === 'cancel' ? '/cancel' : '/retry', { task_id: task.task_id })
          .then(function () {
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
      }, [busy, post, refresh])

      /**
       * 点行打开子会话。openSession 可能抛 not-listed（子会话已不在会话目录里），
       * 这里一律接住并提示，不白屏、不静默。已归档的先提醒一句，但仍然尝试打开。
       */
      const openWorker = useCallback(async function (task) {
        const target = task && typeof task.worker_session_id === 'string' ? task.worker_session_id : ''
        if (task && task.archived_at) setNotice({ tone: 'warn', text: tr('archivedHint') })
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
          // 打开成功就把上一条失败提示清掉；归档行保留那句「可能已不在会话列表」的提醒。
          if (!(task && task.archived_at)) setNotice(null)
        } catch (error) {
          setNotice({ tone: 'error', text: fill(tr('openFailed'), { id: target, reason: describeError(error) }) })
        }
      }, [])

      /* 立即归档：会真的归档会话，不是预览，所以走两步确认。 */
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

      const data = snapshot && Array.isArray(snapshot.tasks) ? snapshot : null
      const allTasks = data ? data.tasks.filter(function (task) { return task && typeof task === 'object' }) : []
      const counts = data && data.counts ? data.counts : {}
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
      const scopedTasks = workspace
        ? allTasks.filter(function (task) { return task.workspace_id === workspace })
        : allTasks
      const currentFilter = FILTERS.filter(function (item) { return item.id === filter })[0] || FILTERS[0]

      const live = scopedTasks.filter(function (task) { return !task.archived_at })
      const stats = effectStats(live, now)
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
          handlers: handlers,
        })
      }

      /** 在跑与排队：批次的成员聚在一起，批次头给出 3/5 这样的进度。 */
      const activeList = function () {
        const rows = []
        for (const group of activeGroups.groups) {
          const progress = batchProgress(live, group.name)
          rows.push(h(BatchHead, { key: 'batch-' + group.name, name: group.name, done: progress.done, total: progress.total }))
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

      const header = h(
        'div',
        { className: 'dsh-sa-head' },
        h(
          'div',
          { className: 'dsh-sa-metrics' },
          h(Metric, { key: 'c', label: tr('concurrency'), value: runningNow + '/' + maxWorkers }),
          h(Metric, { key: 'q', label: tr('queuedOne'), value: queuedNow }),
          h(Metric, { key: 't', label: tr('total'), value: totalNow }),
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
        ),
        h(ConcurrencyBar, { running: runningNow, max: maxWorkers, queued: queuedNow, background: backgroundNow }),
        h(
          'div',
          { className: 'dsh-sa-chips', role: 'group', 'aria-label': tr('title') },
          FILTERS.map(function (item) {
            const count = scopedTasks.filter(item.match).length
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
              h('span', { className: 'dsh-sa-chip-count' }, String(count)),
            )
          }),
        ),
        h(
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
              title: archiveStage === 1 ? tr('archiveConfirm') : tr('archiveNow'),
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
        ),
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

      let body
      if (!data && !failure) {
        body = h(Blank, { title: tr('loading') })
      } else if (!data && failure) {
        body = h(Blank, {
          title: tr('unreachable'),
          hint: failure,
          action: h('button', { type: 'button', className: 'dsh-sa-btn', onClick: refresh }, tr('retry')),
        })
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
        body = parts.length ? h('div', { className: 'dsh-sa-sections' }, parts) : h(Blank, { title: tr('emptyFiltered') })
      }

      return h(
        'div',
        { className: 'dsh-sa', role: 'region', 'aria-label': tr('title') },
        h('style', null, STYLE),
        header,
        strips.length ? strips : null,
        h('div', { className: 'dsh-sa-body' }, body),
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
          label: '任务看板',
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
              registered: ['sidebar.panellist', 'main', 'conversation.input.left', '@workspace'],
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
