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

    /* ───────────────────────── 网络 ───────────────────────── */

    /** 读整块看板；非 2xx 或形状不对都当失败，交给面板显示「暂时取不到」。 */
    async function readBoard(signal) {
      const response = await fetch(API, {
        method: 'GET',
        headers: { accept: 'application/json' },
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
        headers: { 'content-type': 'application/json', accept: 'application/json' },
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
        headers: { accept: 'application/json' },
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
      const text = tr('targetPrefix') + ' → ' + (shown || tr('targetFollow'))
      const triggerTitle = unavailable
        ? tr('targetUnavailable')
        : !portalReady
          ? tr('targetPortalUnavailable')
          : (shown || tr('targetFollow')) + (target && target.path ? '\n' + target.path : '')

      const rows = []
      if (open) {
        rows.push(h(TargetRow, {
          key: 'follow',
          checked: !target,
          label: tr('targetMenuFollow'),
          onPick: function () { void choose('') },
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
          const needle = String(request && request.query ? request.query : '').trim().toLowerCase()
          const rows = []
          for (const item of pool) {
            const title = item.title || item.id
            const path = typeof item.path === 'string' ? item.path : ''
            if (needle) {
              const hay = (title + '\n' + path + '\n' + item.id).toLowerCase()
              if (!hay.includes(needle)) continue
            }
            rows.push({ name: title, description: path, section: tr('targetSection'), value: item.id })
          }
          return rows
        },
        onPick(pick) {
          const candidate = pick ? pick.candidate : null
          const id = candidate && typeof candidate.value === 'string' ? candidate.value : ''
          if (!id) return undefined
          const title = typeof candidate.name === 'string' && candidate.name ? candidate.name : id
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

    /** 一条任务。props.handlers 由面板传下来，避免每行都闭包一份。 */
    function TaskRow(props) {
      const task = props.task
      const archived = Boolean(task.archived_at)
      const meta = STATUS_META[task.status] || STATUS_FALLBACK
      // 归档行是只读历史：整体降透明度、状态点转灰、不给取消/重试按钮。
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
      const clickable = Boolean(task.worker_session_id)
      const tip = [
        task.task_id,
        task.cwd ? 'cwd: ' + task.cwd : '',
        task.worker_session_id ? 'worker: ' + task.worker_session_id : '',
      ].filter(Boolean).join('\n') + (clickable ? '\n' + tr('clickHint') : '')

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

      return h(
        'div',
        {
          className: 'dsh-sa-row'
            + (archived ? ' dsh-sa-row-archived' : '')
            + (clickable ? ' dsh-sa-row-clickable' : ''),
          role: 'listitem',
          'data-status': task.status,
          'data-archived': archived ? 'true' : undefined,
          title: archived ? tip + '\n' + tr('archivedHint') : tip,
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
          attempt > 1
            ? h(
                'span',
                { key: 'attempt', className: 'dsh-sa-tag' },
                tr('attemptPrefix') + attempt + tr('attemptSuffix'),
              )
            : null,
          h('span', { key: 'grow', className: 'dsh-sa-grow' }),
          group ? h('span', { key: 'group', className: 'dsh-sa-tag dsh-sa-tag-group' }, tr('groupTag')) : null,
          archived
            ? h(
                'span',
                { key: 'archived', className: 'dsh-sa-tag dsh-sa-tag-archived' },
                tr('archivedTag'),
              )
            : null,
          archived
            ? h(
                'span',
                { key: 'archived-at', className: 'dsh-sa-meta' },
                formatRelative(task.archived_at, props.now),
              )
            : null,
          elapsed ? h('span', { key: 'elapsed', className: 'dsh-sa-meta dsh-sa-elapsed' }, elapsed) : null,
          action,
        ),
        h(
          'div',
          { className: 'dsh-sa-sub' },
          h(
            'span',
            { key: 'workspace', className: 'dsh-sa-workspace', title: task.workspace_title || '' },
            workspaceTitleOf(task),
          ),
          h('code', { key: 'id', className: 'dsh-sa-id' }, task.task_id),
          reportCount > 0
            ? h('span', { key: 'count', className: 'dsh-sa-meta' }, tr('reports') + ' ' + reportCount)
            : null,
          h('span', { key: 'report', className: 'dsh-sa-report', title: summary || reportLine }, reportLine),
        ),
        typeof task.error === 'string' && task.error
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

      // 工作区筛选与状态 chip 取交集；同 group 的行再聚到一起。
      const scopedTasks = workspace
        ? allTasks.filter(function (task) { return task.workspace_id === workspace })
        : allTasks
      const currentFilter = FILTERS.filter(function (item) { return item.id === filter })[0] || FILTERS[0]
      const visibleTasks = clusterByGroup(scopedTasks.filter(currentFilter.match))

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
      } else if (visibleTasks.length === 0) {
        body = h(Blank, { title: tr('emptyFiltered') })
      } else {
        body = h(
          'div',
          { role: 'list', 'aria-label': tr('title') },
          visibleTasks.map(function (task, index) {
            return h(TaskRow, {
              key: task.task_id || 'row-' + index,
              task: task,
              now: now,
              fetchedAt: fetchedAt,
              busy: busy,
              handlers: handlers,
            })
          }),
        )
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
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
