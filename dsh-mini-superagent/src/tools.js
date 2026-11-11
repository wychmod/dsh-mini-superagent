/**
 * 10 个工具的模型可见定义（数量以 `TOOL_NAMES` 为准，由一致性测试钉住）。
 *
 * 注册在插件根 context，因此对所有 Session 可见；权限不靠注册作用域，
 * 而靠“调用者是不是已登记的 worker Session”在 execute 里判定：
 * 主会话可以派发，worker 只能 dispatch_report。
 */
import { DEFAULTS, ERROR_CODES, SETTLED, VERSION, codeOf, fail, newTaskId } from './constants.js'

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
 * 依赖（PRD-02 §4.1）的工具描述——**必须原样出现**在 launch / launch_many 的描述里。
 *
 * 为什么抽成一份：两个工具共用同一条契约，而它最容易误解的点恰好是「依赖什么时候
 * 生效」——很多人会以为「派发时就等」或「依赖失败会自动改派」。两段描述各写一份，
 * 迟早只改一处，于是同一件事在两个工具里说法不同。
 */
const DEPENDS_ON_NOTE = '\n\n**依赖（depends_on / depends_on_index）**：依赖在**任务开始前**判定，不是派发时判定。'
  + '被依赖的任务没结算，这条任务会一直排队，不占 worker 并发位。'
  + '前置失败/取消时，这条任务会被取消并标注原因，不会自动改派。'

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

/** 参数「算不算真的传了」：空串/纯空白与未传等价（与 dispatch 内部口径一致）。 */
const hasValue = value => value !== undefined && value !== null && String(value).trim() !== ''

/** 全部工具名，供文档与测试引用。 */
export const TOOL_NAMES = [
  'dispatch_launch',
  'dispatch_launch_many',
  'dispatch_workspaces',
  'dispatch_candidates',
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
    if (!agent) throw fail('FORBIDDEN', '该工具只能在某个会话（Agent）中调用')
    return agent
  }
  /** 取本人派发的任务，顺带挡住跨会话访问。 */
  const ownTask = (agent, id) => {
    const task = dispatch.table.get(id)
    if (!task) throw fail('NOT_FOUND', `没有任务 ${id}`)
    if (task.parentSessionId !== agent.id) throw fail('FORBIDDEN', `任务 ${id} 不属于本会话`)
    return task
  }
  /**
   * 取本人派发的任务，**退休的也能查到**（P0-5）。
   *
   * 退休不等于不存在：它是「记录下来、移出活表、原因可查」。把两者混成
   * 一句「没有任务」等于静默丢历史，而这正是治理要避免的事。
   * 归属校验在两种形态下都要做：退休记录同样带 `parentSessionId`。
   */
  const ownResolved = (agent, id) => {
    const found = dispatch.resolveTask(id)
    if (!found) throw fail('NOT_FOUND', `没有任务 ${id}`)
    if (found.parentSessionId !== agent.id) throw fail('FORBIDDEN', `任务 ${id} 不属于本会话`)
    return found
  }

  return [
    {
      name: 'dispatch_launch',
      description: '把一个任务派发给新的后台子会话执行，立即返回、不等待结果。子会话在自己的 Session 里独立工作，'
        + '完成或被阻塞时会用 dispatch_report 汇报，报告会作为消息回流到本会话（本会话空闲时会被唤醒）。'
        + '并发位满时任务进入 queued，有空位自动开始。适合可以并行、彼此独立的工作。'
        + '**派发即移交**：返回之后，该任务的任何执行环节（读代码、搜索、跑脚本、开浏览器、查网络、验数据）'
        + '都不再由本会话进行；派完之后默认动作是结束本轮，不要去重做一遍，也不要原地等结果。'
        + '\n\n**续派（continue_task_id）**：想在**同一个任务**上补一句要求时传它——那一刻本工具不新建任务，'
        + '而是把 title/brief 当作「这次的要求」追加给该任务的子会话（等价于 dispatch_message），'
        + '任务重新变为 running。三个代价必须知道：'
        + '①**没有独立的任务记录**（列表/看板里仍只有原来那一条，看起来像它又跑了一轮）；'
        + '②**没有独立的报告链**（这次的汇报会记进原任务，与上一轮的结论混在一起）；'
        + '③**没有独立的看板行**，「这次要求」与「上次要求」混在同一任务里，事后无法分开审计。'
        + '要保留任务粒度就**别传**它，直接新派一个任务。'
        + '四条硬校验（任一不满足即报错并说明原因，不会静默降级成新派发）：'
        + '目标任务存在且未退休；属于本会话；其子会话是本插件建的（`dispatch-*`）；'
        + '工作区/cwd 与目标任务一致（**续派没有自己的 workspace 参数，一律沿用目标任务的工作区**）；'
        + '且当前没有别的活跃任务（running/queued）。'
        + '\n\n**复用会话（handoff_from）**：想在**新建一个任务**的同时沿用某个已结算任务的子会话时传它。'
        + '它与 continue_task_id 的区别必须先分清：**continue_task_id = 同一个任务追加要求**（没有独立记录）；'
        + '**handoff_from = 新建一个任务**，但 `workerSessionId` 指向来源任务的子会话（有独立的记录、报告链、看板行，上下文接着走）。'
        + '两条硬规则：**复用沿用原模型与 preset**（会话创建时已定死，填不同的值会报错）；'
        + '**不能跨工作区/目录**（来源任务在哪个目录，新任务就只能在那个目录）。'
        + '四条校验：来源任务存在且**已结算**（还在 running/queued 会被拒：一个会话同一时刻只能跑一个回合）、'
        + '未退休未归档、属于本会话、子会话是本插件建的且 cwd 一致。'
        + '两者同时传会直接报错（只能二选一），只选一个。配置 allowSessionReuse=false 时本参数会降级为普通新派，并在返回值 note 里说明原因。'
        + '\n\n**no_reuse（逃生门）**：设为 true = **强制新开会话**。优先级链是 '
        + '`no_reuse: true` > `handoff_from` > 都不传；`no_reuse: true` 与 `handoff_from` 同传**不报错**，'
        + '按 no_reuse 处理并在 note 里说明「已忽略 handoff_from」——调用方说「我不要接」时不该被参数组合挡住。'
        + '\n\n**handoff_reason（审计）**：调用方对自己「为什么接上一轮」的一句话解释，例如「压缩的是上一轮刚生成的调研文档」。'
        + '只写入账本用于审计与事后解释（≤200 字，超长截断），**不参与任何判定或打分**；'
        + '插件里没有相似度、权重或阈值判断，自动续接与否由你自己判断后显式调用本参数。'
        + DEPENDS_ON_NOTE,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务短标题（不超过 120 字），用于列表与子会话标题。传了 continue_task_id 时它表示「这次要做什么」的一句话小标题。' },
          brief: { type: 'string', description: '完整任务简报：目标、约束、验收标准、相关文件路径、已知事实。子会话看不到本会话的历史，必须自包含。传了 continue_task_id 时它就是追加给子会话的新要求正文。' },
          cwd: { type: 'string', description: '可选。子会话工作目录的绝对路径。**优先级高于输入框里记住的派发目标**：只给 cwd（比如会话目标是「自动」）时，这一轮就按 cwd 干活，不再自动挑工作区、也不落【派发】日期目录——显式参数永远压过记住的设置。与 workspace 同时给时 workspace 胜（会话归到那个工作区），但 cwd 仍是子会话真实的工作目录（会切过去）。省略则用 workspace 的路径，再省略则继承本会话的工作目录。传了 continue_task_id 时**只能给同一个目录**，否则报错（续派沿用目标任务的工作区）。' },
          workspace: { type: 'string', description: '可选。派发到哪个工作区：工作区 id、绝对路径、或工作区标题都可以。子会话会在这个目录里干活；省略则沿用本会话的工作目录（或输入框里记住的目标）。**同名工作区有多个时不会猜**：会报错并列出候选的路径，改用 id 或绝对路径重试。先用 dispatch_workspaces 看有哪些。传了 continue_task_id 时**只能给同一个工作区**，否则报错。' },
          create_workspace: { type: 'boolean', description: '可选，默认 true。workspace 解析不到时是否自动新建：给的是绝对路径就在该路径建，给的是名字就在工作区根下建。注意：名字有歧义（多个工作区同名）时**不论这个开关是什么都不会新建**，那样只会造出重复目录。' },
          model: { type: 'string', description: '可选。子会话使用的模型：`model` 或 `provider/model`；省略则用部署默认。宿主不支持切换模型时这次派发会失败并说明原因（不会静默改用默认模型）。传了 continue_task_id 时该参数被忽略——续派沿用原模型；传了 handoff_from 时该参数必须与来源任务一致（会话创建时模型已定死）。' },
          agent_preset: { type: 'string', description: '可选。子会话使用的 agent preset id；省略则用部署默认 preset。' },
          permission_preset: { type: 'string', description: '可选。子会话的权限预设（如 danger-full-access）；省略则继承插件配置或 DSH 默认。' },
          continue_task_id: { type: 'string', description: '可选。续派：把这个任务 id 的**已有**子会话接着用，只追加一条新要求（**不新建任务**，没有独立记录）。与 handoff_from 只能二选一。不给 = 新派一个任务（默认行为，与旧版完全一致）。详见工具描述里的三个代价与四条校验。' },
          handoff_from: { type: 'string', description: '可选。复用会话：**新建一个任务**（有独立的任务记录、报告链与看板行），但沿用这个任务 id 的子会话，上下文接着走。与 continue_task_id 只能二选一（那个是同一任务追加要求）。来源任务必须已结算、未退休未归档、属于本会话，且本次的 workspace/cwd 必须与来源一致；模型与 preset 继承来源、不能改。配置 allowSessionReuse=false 时降级为普通新派并在 note 里说明。' },
          no_reuse: { type: 'boolean', description: '可选。设为 true = **强制新开会话**：即使同时传了 handoff_from 也不复用，优先级是 no_reuse > handoff_from > 都不传。两者同传不报错，按 no_reuse 处理并在 note 里说明「已忽略 handoff_from」。' },
          handoff_reason: { type: 'string', description: '可选。调用方（大模型）对自己「为什么接上一轮」的一句话解释，例如「压缩的是上一轮刚生成的调研文档」。只写入账本用于审计与事后解释（≤200 字，超长截断），**不参与任何判定或打分**。' },
          /**
           * 依赖（PRD-02 §4.1）。不写 `maxItems`：宿主若按 schema 直接拒收，调用方
           * 拿到的是参数错误、看不到「最多 8 个」的中文说明；上限在 dispatch 侧校验并
           * 报 `BAD_ARGS`，那里能说清「为什么超限不截断」。
           */
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: '可选。前置任务 id 数组，最多'
              + `${DEFAULTS.maxDependsOn} 个；去重、去空，id 必须存在于活任务表或退休留痕，不能指向自己。`
              + '依赖在任务开始前判定：前置没结算就排队等待（不占并发位）；前置失败/取消时本任务会被连带取消'
              + '并写 cancel_reason（dependency_failed / dependency_missing）。',
          },
        },
        required: ['title', 'brief'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const resumed = hasValue(args.continue_task_id)
        const handed = hasValue(args.handoff_from)
        // 两个参数在语义上是互斥的：一个是「同一个任务追加要求」，一个是「新建任务但复用会话」。
        // 同时传时**必须报错**而不是按某个优先级猜——猜错的那一次会静默改变任务粒度，
        // 而用户事后只能从「怎么少/多了一条任务」去反推。
        if (resumed && handed) {
          throw fail(
            'BAD_ARGS',
            'continue_task_id 与 handoff_from 只能二选一：'
            + 'continue_task_id = 在**同一个任务**上追加要求（没有独立记录）；'
            + 'handoff_from = **新建一个任务**但沿用来源任务的子会话（有独立记录，上下文接着走）',
          )
        }
        /**
         * 依赖只能挂在新任务上：续派不新建任务，`depends_on` 无处安放。
         *
         * 为什么报错而不是静默忽略：调用方显式要求「这次要等 A」，结果根本没等，
         * 是比报错贵得多的失败——任务会在 A 还没做完时插进一条正在跑的会话里
         * （续派要求没有别的活跃任务，等于把顺序彻底打乱），而且事后没人能看出
         * 这次调用带了依赖。
         */
        if (resumed && Array.isArray(args.depends_on) && args.depends_on.some(item => hasValue(item))) {
          throw fail(
            'BAD_ARGS',
            'continue_task_id 不新建任务，不能同时声明 depends_on：'
            + '要等前置做完再续派，请等它结算后再调用；要新建一条带依赖的任务，去掉 continue_task_id',
          )
        }
        // 续派/复用都转发已经在 `launch()` 里做（那里是唯一的派发入口，两个工具都过它）。
        // 这里只负责把 snake_case 的参数名翻成内部字段名——把「参数名 → 内部名」的
        // 映射留在工具边界，`dispatch.js` 就只认一套拼写。
        const task = await dispatch.launch(agent, {
          title: args.title,
          brief: args.brief,
          cwd: args.cwd,
          workspace: args.workspace,
          createWorkspace: args.create_workspace,
          model: args.model,
          agentPreset: args.agent_preset,
          permissionPreset: args.permission_preset,
          continueTaskId: resumed ? args.continue_task_id : undefined,
          handoffFrom: handed ? args.handoff_from : undefined,
          // 审计字段：只落库，不参与 launch 的任何分支判断。
          handoffReason: args.handoff_reason,
          // 逃生门：true 时 launch 会跳过复用（即使同时给了 handoff_from）。
          noReuse: args.no_reuse === true,
          // 依赖（PRD-02 §4.1）：原始值交给 `launch()` 校验并归一（形状/去重/限 8/
          // 查存在性/查环），工具层**不在这里过滤**——静默丢掉一个形状不对的
          // depends_on，会让调用方以为依赖生效了。undefined/null 由 launch 当成「没传」。
          dependsOn: args.depends_on,
        })
        // 续派的返回值 note 必须**换一句话**：说「已入队」会让人以为多了一条任务，
        // 而它的语义恰恰是「没有新任务，只有一条新要求进了旧的那个」。
        // 复用反过来：它**确实**多了一条任务，要强调「独立记录 + 上下文接着走」。
        const reuseNotice = handed ? dispatch.reuseNotice?.(task) : undefined
        const reused = handed && !reuseNotice && task.parentTaskId === String(args.handoff_from).trim()
        return {
          task: dispatch.card(task),
          // 解析后的依赖（PRD-02 §4.1）：去重、去空、保持声明顺序。没有依赖时是空数组，
          // 调用方不必判属性存在。
          depends_on: Array.isArray(task.dependsOn) ? task.dependsOn : [],
          ...(resumed ? { continued: true } : {}),
          ...(reused ? { handoff: true, reused_session: task.workerSessionId } : {}),
          ...(reuseNotice ? { reuse_degraded: true } : {}),
          ...(args.no_reuse === true ? { forced_new_session: true } : {}),
          note: resumed
            ? '已续派：没有新建任务，这条要求追加给了原任务的子会话，它处理完会再次汇报。'
            : handed
              ? (reuseNotice
                ?? '已新建任务并沿用来源任务的子会话（上下文接着走，模型/工作区不变）；'
                  + '这是独立的一条任务，有独立的记录与报告链。接下来默认结束本轮，报告会自己回来。')
              : '已入队/启动；接下来默认结束本轮，不要在本轮等它完成，报告会自己回来。',
        }
      },
    },
    {
      name: 'dispatch_launch_many',
      description: '一次派发多个任务（批量版 dispatch_launch）。默认并行：每个任务各自一个子会话，立即入队、'
        + '不会阻塞；完成的报告会陆续回流。需要先后顺序时，在 item 里用 depends_on / depends_on_index 声明「我等谁」，'
        + '被等的任务结算后才启动。适合“把这 5 个模块分别重构”这类可并行工作，'
        + '也适合「先改接口 → 再补实现 → 最后跑测试」这种有前后关系的活。'
        + '**派发即移交**：返回之后这些任务的活就都是子会话的，本会话不要去重做，也不要原地等结果；'
        + '接下来默认结束本轮。'
        + DEPENDS_ON_NOTE,
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
                // 语义与 dispatch_launch 同一套（显式参数压过记住的设置），这里只留简版，
                // 详细规则见上面 dispatch_launch 的参数描述。
                cwd: { type: 'string', description: '可选。子会话工作目录的绝对路径，优先级高于记住的派发目标。' },
                workspace: { type: 'string' },
                create_workspace: { type: 'boolean' },
                model: { type: 'string' },
                agent_preset: { type: 'string' },
                permission_preset: { type: 'string' },
                depends_on: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '可选。前置任务 id 数组（最多'
                    + `${DEFAULTS.maxDependsOn} 个）：可引用本批前面已成功启动的任务，也可引用历史任务。`
                    + '批内关系更推荐 depends_on_index（不用先知道 id）。',
                },
                depends_on_index: {
                  type: 'array',
                  items: { type: 'integer', minimum: 0 },
                  description: '可选。批内下标（0 起），只能指向本批中**排在自己前面**的 item；'
                    + '服务端在第 i 个 launch 成功后替换成真实 task id。指向自己或后面的项会报错。'
                    + '与 depends_on 同时给时合并去重。',
                },
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
        /**
         * 批内下标 → 真实任务 id（PRD-02 §4.1）。
         *
         * 数组**按 item 位置对齐**：第 i 项成功写入 task id，失败写入 undefined。
         * 因为下标只能指向自己前面的 item，循环到第 i 项时长度必然恰好是 i，
         * 所以 `index >= launchedIds.length` 就是「越界 或 指向自己/后面」的统一判据。
         */
        const launchedIds = []
        for (let position = 0; position < args.tasks.length; position += 1) {
          const item = args.tasks[position]
          try {
            // 形状在这里先挡一次：`depends_on_index` 派生出的真实 id 要拼进来，
            // 若 depends_on 不是数组，拼出来的东西形状是错的，报错信息也指不清是哪一项。
            if (item.depends_on !== undefined && item.depends_on !== null && !Array.isArray(item.depends_on)) {
              throw fail('BAD_ARGS', `第 ${position + 1} 项的 depends_on 必须是任务 id 数组`)
            }
            const fromIndex = []
            if (Array.isArray(item.depends_on_index)) {
              for (const rawIndex of item.depends_on_index) {
                const index = Number(rawIndex)
                // 校验必须在 launch 之前（PRD-02 §6）：否则会先登记一条错依赖的任务，
                // 再在解析时把它改掉或取消，调用方拿到的是一个半成品。
                if (!Number.isInteger(index) || index < 0 || index >= position) {
                  throw fail(
                    'BAD_ARGS',
                    `第 ${position + 1} 项的 depends_on_index 里有「${String(rawIndex)}」：`
                    + `只能指向本批中排在自己前面的 item（0 起；当前项是第 ${position + 1} 项）。`
                    + '批内下标不能指向自己，也不能指向后面的项',
                  )
                }
                const ref = launchedIds[index]
                // 被引用的那一项自己启动失败了：这里解析不到 id，按 UNKNOWN_DEPENDENCY
                // 处理（PRD-02 §6 最后一行），不影响其他独立任务。
                if (!ref) {
                  throw fail(
                    'UNKNOWN_DEPENDENCY',
                    `第 ${position + 1} 项引用的第 ${index + 1} 项没有成功启动，解析不到任务 id：`
                    + '去掉这条依赖，或让那一项先成功',
                  )
                }
                fromIndex.push(ref)
              }
            }
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
              // `depends_on` 的形状校验留给 `launch()`；这里只把派生出的真实 id 接上。
              // 与 depends_on_index 同时给时合并，去重由 launch 统一做。
              dependsOn: fromIndex.length
                ? [...(Array.isArray(item.depends_on) ? item.depends_on : []), ...fromIndex]
                : item.depends_on,
            })
            launchedIds.push(task.id)
            results.push({
              task_id: task.id,
              title: task.title,
              status: task.status,
              depends_on: Array.isArray(task.dependsOn) ? task.dependsOn : [],
            })
          } catch (error) {
            // 失败位要占住：后面的 item 若用 depends_on_index 指向它，必须解析失败
            // 而不是错位（少 push 一次会让所有下标整体前移一格，依赖会指到别人身上）。
            launchedIds.push(undefined)
            results.push({
              title: item.title,
              error: String(error),
              // 明确错误码（PRD-02 §6）：BAD_ARGS / UNKNOWN_DEPENDENCY / DEPENDENCY_CYCLE…
              // 调用方按码分流，不必解析中文。
              code: codeOf(error, ERROR_CODES.INTERNAL),
            })
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
      name: 'dispatch_candidates',
      description: '列出本会话派出的、**已结算且仍在时间窗内**的任务作为「接续候选」，并附上判断所需的素材：标题、简报、'
        + '最后一条报告的摘要、结束状态与时刻、线程 id、是否已有人接过它、子会话现在忙不忙。'
        + '**本工具只提供候选与素材，是否接续由调用方判断**：这里没有分数、没有排序推荐、也不会自动绑定；'
        + '判断「这两条是不是同一件事」是语义判断，只能由你来做。默认按会话当前的工作区/目录圈定同域'
        + '（跨目录复用会被 dispatch_launch 拒绝——那会让 A 的代码被 B 改掉）；`all_workspaces: true` 时只供浏览。'
        + '拿不准就**倾向新开会话**：错接的代价（旧结论、旧模型、旧权限一起带进新任务）远大于漏接。'
        + '要接就显式调用 dispatch_launch({ handoff_from, handoff_reason })。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 10, description: '返回候选条数上限，默认 5。' },
          days: { type: 'integer', minimum: 1, maximum: 30, description: '只看最近 N 天**结算**的任务，默认 7。' },
          cwd: { type: 'string', description: '可选。按目录圈定「同域」；省略则用会话当前派发目标的路径，再省略用会话当前目录。比较不区分 Windows 大小写与斜杠。' },
          workspace: { type: 'string', description: '可选。按工作区（id / 绝对路径 / 标题）圈定；与 cwd 同时给时**两个都要满足**。' },
          all_workspaces: { type: 'boolean', description: '可选，默认 false。true 时不按工作区/目录过滤（返回 scope.same_domain=false），只用于「跨目录看一眼」；跨目录的候选不能当复用来源。' },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        return dispatch.candidates(agent, {
          limit: args.limit,
          days: args.days,
          cwd: args.cwd,
          workspace: args.workspace,
          allWorkspaces: args.all_workspaces,
        })
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
      description: '查看一个任务的详情：状态、简报、最近几次报告、worker 最后一段输出。要判断“它到底做到哪了”时用它。'
        + '已退休（记录移出活表）的任务仍可用它查到——返回 `retired: true` 与退休时刻/原因，但没有正文。',
      parameters: {
        type: 'object',
        properties: { task_id: TaskRefSchema },
        required: ['task_id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const agent = requireCaller(exec)
        const found = ownResolved(agent, args.task_id)
        if (dispatch.isRetired(found)) {
          // 形状刻意与活任务同构（`{task: {...}}`）：调用方不必为「退休」
          // 学一套新字段，只看 `retired` 这个布尔。正文不可用要写在 note 里，
          // 否则「recent_reports 缺失」会被误读成「它没报告过」。
          return {
            task: dispatch.detail(dispatch.retiredCard(found)),
            retired: true,
            note: '该任务已退休：只保留留痕（何时、为什么、最后一条摘要），报告正文不可用。',
          }
        }
        return { task: dispatch.detail(found) }
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
      description: '阻塞等待若干个任务结算，最多 timeout_ms 毫秒。**默认不要调用它**：报告会自己作为消息回流，'
        + '派发之后的默认动作是结束本轮（结束本轮 ≠ 没回答——你这一轮末尾说的话就是回答，报告随后自动回来并唤醒本会话）。'
        + '唯一允许调用的情形：用户在**同一条消息里**明确要求「等结果再继续」，且不拿到结果就无法产出他要的东西。'
        + '除此之外一律结束本轮，不要用本工具代替结束本轮，也不要连续多次调用（实测有人这样累计原地阻塞约 33 分钟、零产出）。'
        + '它不是 sleep：超时后任务可能仍在 running，再等一次只是再阻塞一次。'
        + '等一个**被前置挡住的排队任务**时，它会一直等到该任务被启动并结算、或被连带取消；'
        + '不会返回「还在等前置」这种中间态（PRD-02 §6）。',
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
        + '主会话会收到这条报告并据此继续。主会话不要调用本工具。'
        + '**说人话**：用 headline 写一句给用户看的结论（默认不要省略）——'
        + '`summary` 是技术摘要，用户不一定读；主会话会优先转述 headline。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['done', 'blocked', 'failed', 'progress'], description: '报告类型。' },
          headline: {
            type: 'string',
            description: '可选但**强烈建议**：一句话给用户看的结论，≤40 字。不含任务 id、不含英文状态词'
              + '（done/failed/blocked）、不重复任务名（外层「任务」行已经标了是哪条）。'
              + '写「登录超时修好了，补了 3 个回归测试」这种，不要写「已完成开发工作」。'
              + '省略时系统会用「标题 + 状态」生成兜底句——兜底句只说得出成没成，说不出做成了什么。',
          },
          summary: { type: 'string', description: '3-6 行技术摘要：做了什么、结果如何、需要主会话做什么（如有）。' },
          detail: { type: 'string', description: '可选的长详情：改动清单、验证命令与输出、遗留问题。只进账本与 dispatch_inspect，不随报告回流。' },
          /**
           * 任务级计划（PRD-01 §4.1）。**整版替换**而不是增量：worker 不需要维护
           * step id，改计划时把当前那版完整给一遍即可。
           *
           * 上限写进 description、**不写 `maxItems` / `maxLength`**：宿主若按 schema
           * 直接拒收，worker 拿到的是参数错误、看不到 `plan_truncated`，于是超长计划
           * 会变成「汇报失败」而不是「计划被截了一下」。截断在 dispatch 侧做（见
           * `normalizePlan`），返回值负责把「截过」这件事说清楚。
           *
           * 结构上只声明 `{text, status}`：字符串简写由 dispatch 侧容错接受，
           * 不在模型可见契约里鼓励——计划只需要一种形状。
           */
          plan: {
            type: 'array',
            description: '可选：任务计划，数组顺序即执行顺序；每次传都是整版替换，最多'
              + `${DEFAULTS.maxPlanSteps} 步、每步 ${DEFAULTS.maxPlanStepChars} 字，超出截断并返回 plan_truncated。`
              + '任务超过 3 个步骤时建议在首条 progress 报告里给，之后每完成一步更新一次。'
              + '步骤文案写「做什么」，不写「正在做」。',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: `步骤文案（最多 ${DEFAULTS.maxPlanStepChars} 字），空文案会被丢弃。` },
                status: {
                  type: 'string',
                  enum: ['pending', 'doing', 'done'],
                  description: '缺省按 pending；doing 只用于看板显示「当前步骤」。',
                },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
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
          throw fail(
            'BAD_ARGS',
            `dispatch_report 的 status 必须是 ${[...REPORT_STATUSES].join(' / ')} 之一，收到的是「${status || '(空)'}」`,
          )
        }
        return dispatch.report(requireCaller(exec), { ...args, status })
      },
    },
  ]
}

/**
 * 工具边界统一贴错误码：内部抛出的中文 Error 保留原文给人/模型读，
 * 另外附带一个来自 `ERROR_CODES` 闭集的 `code`，让看板与排障脚本能按类统计。
 * 已有合法 code 的不覆盖（例如 `fail()` 生成的精细分类）。
 */
function withErrorCode(name, execute) {
  return async (args, exec) => {
    try {
      return await execute(args, exec)
    } catch (error) {
      if (error && typeof error === 'object') {
        error.code = codeOf(error, ERROR_CODES.INTERNAL)
        if (!error.tool) error.tool = name
      }
      throw error
    }
  }
}

/** 注册全部工具；返回 disposer 数组（Cordis 也会在插件卸载时自动回收）。 */
export function registerTools(ctx, dispatch) {
  const disposers = []
  for (const definition of toolDefinitions(dispatch)) {
    disposers.push(ctx.tools.register({
      ...definition,
      output,
      execute: withErrorCode(definition.name, definition.execute),
    }))
  }
  return disposers
}
