# deepseek-harness 插件工作区

这个仓库只做一件事：维护 DeepSeek Harness（DSH）的**任务派发**插件 `dsh-mini-superagent`。
主会话把任务派给独立的后台子会话，子会话完成后把报告投回主会话；没有监听器、没有工单系统、没有数据库、没有构建步骤。
0.3.0 起附带一个常驻侧边栏的任务看板（Host HTTP + 浏览器面板）。

## 仓库内容

| 路径 | 内容 |
| --- | --- |
| [`dsh-mini-superagent/`](dsh-mini-superagent/) | 插件包本体（0.3.0）：`src/` 源码、`client/` 浏览器面板、`test/`、`locale/`、bundle patch、文档 |
| [`notes/`](notes/) | 本机 DSH 环境的排查记录（会话失败检查、环境修复），不是插件文档 |
| [`plans/`](plans/) | 产品规划与可行性调研：[00-vision](plans/00-vision.md) 是五条需求的判定与分期，01/02 是输入框与侧边栏的逐条取证 |
| `reference/` | DSH 官方 `dsh-superagent-prototype` 的本地克隆，只作架构参考。目录内容被 `.gitignore` 排除，只提交了 [`reference/README.md`](reference/README.md) 作指针（记录上游地址、参考时的提交 `8c32a9d`，以及取回与移除方法） |
| `.editorconfig` / `.gitattributes` / `.gitignore` | 编码、行尾（LF）与忽略规则 |

插件的历史版本 `dsh-dispatch`（0.1.0，单文件 853 行）已移除，差异见 [`dsh-mini-superagent/CHANGELOG.md`](dsh-mini-superagent/CHANGELOG.md)。

## 快速安装

插件是纯 ESM，零运行时依赖，不需要构建。

把下面这句交给 DSH 里的任意会话：

> 用 plugin_manager 的 install_bundle，把 `<本仓库路径>/dsh-mini-superagent` 安装成 bundle，装完确认 8 个 `dispatch_*` 工具已注册。

或者直接调用：

```text
plugin_manager(action="install_bundle", target="<本仓库路径>/dsh-mini-superagent")
```

装完验证：

```text
dispatch_list()
→ {"version":"0.3.0","total":0,"running":0,"max_workers":6,"tasks":[]}
```

**装完/升级后刷新一次 GUI 页面**，侧边栏才会出现「任务看板」图标。要求与详细步骤见 [`dsh-mini-superagent/README.md`](dsh-mini-superagent/README.md)。

## 插件速览

- 8 个工具：`dispatch_launch` / `dispatch_launch_many` / `dispatch_list` / `dispatch_inspect` / `dispatch_message` /
  `dispatch_cancel` / `dispatch_wait` / `dispatch_report`。
- 派发立即返回；报告作为插件来源的消息回流，主会话空闲时被唤醒。
- 全局并发上限 `maxWorkers=6`，超出的任务排队，有空位自动开始。
- 任务表落盘 JSON，重启后恢复历史；未结算任务标 `interrupted`，不假装还活着。
- 任务看板：侧边栏「任务看板」面板，看并发/排队/耗时/报告摘要，按同源 HTTP 取数，可直接取消与重试。

## 文档

| 文件 | 内容 |
| --- | --- |
| [`dsh-mini-superagent/README.md`](dsh-mini-superagent/README.md) | 安装、8 个工具、典型用法、状态流转、配置、限制、验证记录 |
| [`dsh-mini-superagent/docs/tools.md`](dsh-mini-superagent/docs/tools.md) | 工具参数、返回、错误、何时用/何时别用 |
| [`dsh-mini-superagent/docs/architecture.md`](dsh-mini-superagent/docs/architecture.md) | 模块职责、数据流、设计取舍与依据 |
| [`dsh-mini-superagent/docs/troubleshooting.md`](dsh-mini-superagent/docs/troubleshooting.md) | 排障表、日志前缀、恢复动作 |
| [`dsh-mini-superagent/docs/board.md`](dsh-mini-superagent/docs/board.md) | 任务看板：入口、面板结构、HTTP 接口、重试语义、鉴权 |
| [`dsh-mini-superagent/docs/api-contracts.md`](dsh-mini-superagent/docs/api-contracts.md) | DSH 主机 API 契约取证：消息构造、Agent、事件、会话控制器、工具作用域 |
| [`dsh-mini-superagent/CHANGELOG.md`](dsh-mini-superagent/CHANGELOG.md) | 0.1.0（原名 dsh-dispatch）、0.2.0、0.3.0 |

## 开发

```bash
# 单元测试（Node 内置 test runner，无依赖）
cd dsh-mini-superagent
npm test

# 语法检查
node --check dsh-mini-superagent/src/index.js
```

约定：

- 纯 ESM，不引入运行时依赖，不加构建步骤。
- 字符串标识（名字/版本/日志前缀/来源 kind/提示段名/状态目录）只在 `src/constants.js` 定义。
- 宿主 API 的调用集中在 `src/sessions.js`，DSH 升级时优先改这一个文件。
- 文档里的链接一律用仓库相对路径。

## License

MIT，见 [`dsh-mini-superagent/LICENSE`](dsh-mini-superagent/LICENSE)。
