/**
 * 8 个工具的模型可见定义。
 *
 * 注册在插件根 context，因此对所有 Session 可见；权限不靠注册作用域，
 * 而靠“调用者是不是已登记的 worker Session”在 execute 里判定：
 * 主会话可以派发，worker 只能 dispatch_report。
 */
import { SETTLED, VERSION, newTaskId } from './constants.js'

/** 工具返回值的渲染：JSON 文本。 */
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** 任务 id 参数的统一描述。 */
const TaskRefSchema = {
  type: 'string',
  description: '任务 ID，例如 t-m0abc-1；也可以用 dispatch_list 查。',
}

/**
 * `dispatch_report` 接受的报告状态（与 schema 里的 enum 同一份事实）。
 *
 * 为什么在工具边界再校验一次、而不复用 constants.js 的 TERMINAL_REPORT：
 * 两者职责不同——TERMINAL_REPORT 是「哪些报告会结束任务」，只有 4 个里的 3 个
 * 终态外加 cancelled；而这里要判的是「这个 status 是不是我们认识的词」，
 * 必须包含不结算任务、但完全合法的 `progress`。
 *
 * 为什么非校验不可：宿主不保证按 schema 的 enum 拦住模型，一旦传进 `finished`
 * 这类未知值，dispatch.report 既不结算也不报错，任务就永远停在 running
 * 白占一个并发位，而且没有任何提示。所以在入口就把脏值挡住。
 */
const REPORT_STATUSES = new Set(['done', 'blocked', 'failed', 'progress'])

/** 全部工具名，供文档与测试引用。 */
export const TOOL_NAMES = [
  'dispatch_launch',
  'dispatch_launch_many',
  'dispatch_workspaces',
  'dispatch_list',
  'dispatch_inspect',
  'dispatch_message',
  'dispatch_cancel',
  'dispatch_wait',
  'dispatch_report',
]

/**
 * 构造工具定义。
 * @param {import('./dispatch.js').Dispatch} dispatch
 */
export function toolDefinitions(dispatch) {
  /** 取调用者；工具必须在某个会话里被调用。 */
  const requireCaller = exec => {
    const agent = exec?.agent
    if (!agent) throw new Error('该工具只能在某个会话（Agent）中调用')
    return agent
  }
  /** 取本人派发的任务，顺带挡住跨会话访问。 */
  const ownTask = (agent, id) => {
    const task = dispatch.table.get(id)
    if (!task) throw new Error(`没有任务 ${id}`)
    if (task.parentSessionId !== agent.id) throw new Error(`任务 ${id} 不属于本会话`)
    return task
  }

  return [
    {
      name: 'dispatch_launch',
      description: '把一个任务派发给新的后台子会话执行，立即返回、不等待结果。子会话在自己的 Session 里独立工作，'
        + '完成或被阻塞时会用 dispatch_report 汇报，报告会作为消息回流到本会话（本会话空闲时会被唤醒）。'
        + '并发位满时任务进入 queued，有空位自动开始。适合可以并行、彼此独立的工作。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务短标题（不超过 120 字），用于列表与子会话标题。' },
          brief: { type: 'string', description: '完整任务简报：目标、约束、验收标准、相关文件路径、已知事实。子会话看不到本会话的历史，必须自包含。' },
          cwd: { type: 'string', description: '可选。子会话工作目录的绝对路径；省略则用 workspace 的路径，再省略则继承本会话的工作目录。' },
          workspace: { type: 'string', description: '可选。派发到哪个工作区：工作区 id、绝对路径、或工作区标题都可以。子会话会在这个目录里干活；省略则沿用本会话的工作目录。先用 dispatch_workspaces 看有哪些。' },
          create_workspace: { type: 'boolean', description: '可选，默认 true。workspace 解析不到时是否自动新建：给的是绝对路径就在该路径建，给的是名字就在工作区根下建。' },
          model: { type: 'string', description: '可选。子会话使用的模型：`model` 或 `provider/model`；省略则用部署默认。宿主不支持切换模型时这次派发会失败并说明原因（不会静默改用默认模型）。' },
          agent_preset: { type: 'string', description: '可选。子会话使用的 agent preset id；省略则用部署默认 preset。' },
          permission_preset: { type: 'string', description: '可选。子会话的权限预设（如 danger-full-access）；省略则继承插件配置或 DSH 默认。' },
        },
        required: ['title', 'brief'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const task = await dispatch.launch(agent, {
          title: args.title,
          brief: args.brief,
          cwd: args.cwd,
          workspace: args.workspace,
          createWorkspace: args.create_workspace,
          model: args.model,
          agentPreset: args.agent_preset,
          permissionPreset: args.permission_preset,
        })
        return { task: dispatch.card(task), note: '已入队/启动；不要在本轮等待它完成，报告会自己回来。' }
      },
    },
    {
      name: 'dispatch_launch_many',
      description: '一次派发多个互相独立的任务（批量版 dispatch_launch）。每个任务各自一个子会话，全部立即入队，'
        + '不会阻塞；完成的报告会陆续回流。适合“把这 5 个模块分别重构”这类可并行工作。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                brief: { type: 'string' },
                cwd: { type: 'string' },
                workspace: { type: 'string' },
                create_workspace: { type: 'boolean' },
                model: { type: 'string' },
                agent_preset: { type: 'string' },
                permission_preset: { type: 'string' },
              },
              required: ['title', 'brief'],
              additionalProperties: false,
            },
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        // 同一批任务共用一个 group：全部结算后由插件发一条汇总，而不是 N 条流水。
        const group = `g-${newTaskId()}`
        const results = []
        for (const item of args.tasks) {
          try {
            const task = await dispatch.launch(agent, {
              title: item.title,
              brief: item.brief,
              cwd: item.cwd,
              workspace: item.workspace,
              createWorkspace: item.create_workspace,
              model: item.model,
              agentPreset: item.agent_preset,
              permissionPreset: item.permission_preset,
              group,
            })
            results.push({ task_id: task.id, title: task.title, status: task.status })
          } catch (error) {
            results.push({ title: item.title, error: String(error) })
          }
        }
        return { group, launched: results, note: '全部结算后会收到一条批次汇总。' }
      },
    },
    {
      name: 'dispatch_workspaces',
      description: '列出可用的工作区（DSH workspace），供 dispatch_launch 的 workspace 参数使用。'
        + '每个工作区给出 id、标题、路径与会话数；派发时用 id 或标题都行。'
        + '任务明显属于一个新项目、而列表里没有合适的工作区时，可以直接用绝对路径派发（会自动登记）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const items = dispatch.workspaces.list().map(item => ({
          workspace_id: item.id,
          title: item.title,
          path: item.path,
          sessions: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
        }))
        return {
          root: dispatch.workspaces.root,
          worker_workspace: dispatch.config.workerWorkspace,
          archive_after_hours: dispatch.config.archiveAfterHours,
          count: items.length,
          workspaces: items,
        }
      },
    },
    {
      name: 'dispatch_list',
      description: '列出本会话派出的任务及其状态（running/queued/done/blocked/ended/failed/cancelled/interrupted），最新在前。'
        + '派发后想确认进度先看这里，再看 dispatch_inspect。',
      parameters: {
        type: 'object',
        properties: {
          all: { type: 'boolean', description: 'true 时包含已结算的任务（默认包含）；false 只看未结算的。' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数上限，默认 20。' },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const mine = dispatch.table.ofSession(agent.id)
        const all = args.all !== false
        const limit = args.limit ?? 20
        const tasks = (all ? mine : mine.filter(task => !SETTLED.has(task.status))).slice(0, limit)
        return {
          version: VERSION,
          total: mine.length,
          running: dispatch.table.runningCount(),
          max_workers: dispatch.table.maxWorkers,
          tasks: tasks.map(task => dispatch.card(task)),
        }
      },
    },
    {
      name: 'dispatch_inspect',
      description: '查看一个任务的详情：状态、简报、最近几次报告、worker 最后一段输出。要判断“它到底做到哪了”时用它。',
      parameters: {
        type: 'object',
        properties: { task_id: TaskRefSchema },
        required: ['task_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        return { task: dispatch.detail(ownTask(agent, args.task_id)) }
      },
    },
    {
      name: 'dispatch_message',
      description: '给某个任务的子会话追加一条消息：补充信息、修正方向、回答它的问题，或让它接着做下一步。'
        + 'mode=queue 排到下一轮（子会话空闲时会唤醒它），mode=steer 并入当前回合的下一步。任务会重新变为 running。',
      parameters: {
        type: 'object',
        properties: {
          task_id: TaskRefSchema,
          message: { type: 'string', description: '要投递给子会话的完整文本，自包含，不要依赖本会话上下文。' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: '默认 queue。' },
        },
        required: ['task_id', 'message'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const task = ownTask(agent, args.task_id)
        await dispatch.message(task, String(args.message), args.mode ?? 'queue')
        return { task: dispatch.card(task), note: '消息已投递；子会话处理完会再次汇报。' }
      },
    },
    {
      name: 'dispatch_cancel',
      description: '取消一个任务：结束子会话当前回合并释放并发位。已经产生的工作不会回滚，需要时自己检查工作目录。',
      parameters: {
        type: 'object',
        properties: {
          task_id: TaskRefSchema,
          reason: { type: 'string', description: '可选，取消原因，会记录在任务上。' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const task = ownTask(agent, args.task_id)
        await dispatch.cancel(task, args.reason)
        return { task: dispatch.card(task) }
      },
    },
    {
      name: 'dispatch_wait',
      description: '阻塞等待若干个任务结算，最多 timeout_ms 毫秒。只在“没有这些结果就无法继续下一步”时使用；'
        + '能先做别的就不要等——报告本来就会自己回流。',
      parameters: {
        type: 'object',
        properties: {
          task_ids: { type: 'array', items: { type: 'string' }, description: '省略表示等待本会话全部未结算任务。' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, description: '默认 60000。' },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const mine = dispatch.table.ofSession(agent.id)
        // 显式指定 id 时必须走 ownTask 的归属校验：否则会话 A 传会话 B 的
        // task_id 就能读到对方任务的标题/状态/摘要（0.7.0 之前实测可复现）。
        // 这里不做「过滤掉不可见任务」的静默处理——那会让调用方以为等到了
        // 一个根本没等的任务；混入别人的任务就直接报错。
        const targets = args.task_ids?.length
          ? args.task_ids.map(id => ownTask(agent, id))
          : mine.filter(task => !SETTLED.has(task.status))
        if (!targets.length) return { waited: false, tasks: mine.slice(0, 10).map(task => dispatch.card(task)) }
        await dispatch.table.waitFor(targets, args.timeout_ms ?? 60_000)
        return { waited: true, tasks: targets.map(task => dispatch.card(task)) }
      },
    },
    {
      name: 'dispatch_report',
      description: '（仅被派发的 worker 使用）向派发你的主会话汇报：done 完成、blocked 被阻塞、failed 失败、progress 阶段性进展。'
        + '主会话会收到这条报告并据此继续。主会话不要调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['done', 'blocked', 'failed', 'progress'], description: '报告类型。' },
          summary: { type: 'string', description: '3-6 行摘要：做了什么、结果如何、需要主会话做什么（如有）。' },
          detail: { type: 'string', description: '可选的长详情：改动清单、验证命令与输出、遗留问题。' },
        },
        required: ['status', 'summary'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        // 在工具边界把未知 status 挡住：dispatch.js 只对终态报告结算，
        // 未知词既不结算也不报错，任务会永远停在 running 占着并发位。
        // 报错时列出允许值，让模型能自己改对后重试。
        const status = String(args?.status ?? '')
        if (!REPORT_STATUSES.has(status)) {
          throw new Error(
            `dispatch_report 的 status 必须是 ${[...REPORT_STATUSES].join(' / ')} 之一，收到的是「${status || '(空)'}」`,
          )
        }
        return dispatch.report(requireCaller(exec), { ...args, status })
      },
    },
  ]
}

/** 注册全部工具；返回 disposer 数组（Cordis 也会在插件卸载时自动回收）。 */
export function registerTools(ctx, dispatch) {
  const disposers = []
  for (const definition of toolDefinitions(dispatch)) {
    disposers.push(ctx.tools.register({ ...definition, output }))
  }
  return disposers
}
