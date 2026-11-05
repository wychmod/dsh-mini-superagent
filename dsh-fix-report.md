# DSH 环境修复报告

执行时间：2026-11-05 01:21–01:42 (Asia/Shanghai)
前置检查：`dsh-session-failures.md`（4 个会话，9 次 isError + 11 次非零退出）

## 一、可修复性判定

| 问题 | 原失败数 | 可否修复 | 处理 |
|---|---|---|---|
| Electron 运行时缺失，`dsh_browser_*` 全不可用 | 2 | **可修复** | ✅ 已修复并验证 |
| pwsh 在 `workspace-write` 下 `0xC0000142` | 11 | 现场无法复现，已排除环境缺陷 | ✅ 已验证当前正常 |
| GitHub API 403 | 2 | **设计如此**，需换通道 | ✅ 已验证 `gh` 通道 |
| glob 路径不存在 / skill 名不存在 | 3 | 调用参数笔误 | 无需修复 |

## 二、Electron 缺失 —— 已修复

### 根因

`~/.dsh/profiles/desktop/node_modules/electron/` 只有 npm 包的 JS 桩
（`install.js`、`index.js`、`checksums.json`），**没有 `dist/` 目录和 `path.txt`**，
即安装时 `install.js` 的二进制下载步骤从未执行成功。

`dsh-builtin-browser` 的 `resolveElectronPath()` 依次探测：
`ELECTRON_PATH` → 插件自带 electron 包 → DSH 安装锚点 → 进程自身 → 进程祖先。
前几级全部落空，于是抛出：

```
browser provider(s) electron are registered but report themselves unavailable
```

这个设计是有意为之（包内注释记录了 issue #41）：下载不在 `postinstall` 做，
因为 pnpm 默认拦截构建脚本，且下载失败会让整个插件安装失败。所以它**按需下载**，
而这台机器上恰好从未触发过。

### 修复动作

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\electron\install.js"
```

走 npmmirror 镜像（直连 GitHub Releases 在此网络下很慢）。
安装的是包声明的 **Electron 44.10.1**。

### 验证结果

```
dist/version          = 44.10.1
dist/electron.exe     = 245,785,600 bytes
dist 文件数            = 73
path.txt              = electron.exe
resolveElectronPath() = C:\Users\...\node_modules\electron\dist\electron.exe
electron.exe --version (去掉 ELECTRON_RUN_AS_NODE) = v44.10.1
```

工具级实测（此前 2 次均失败）：

```
dsh_browser_open  https://example.com                        → ✅ Example Domain
dsh_browser_open  https://github.com/wychmod/sableos/pull/11 → ✅ PR #11 标题正确
```

> 注：`ELECTRON_RUN_AS_NODE=1` 由 DSH 注入自身子进程，用于以 Node 模式运行辅助进程，
> 不影响浏览器宿主（实测浏览器正常拉起）。

## 三、pwsh `0xC0000142` —— 当前环境正常，非配置缺陷

### 机制（源码定位）

DSH 的 Windows 沙箱是 `@deepseek-ai/dsh-sandbox-windows-acl`：
用 `CreateRestrictedToken` 造 WRITE_RESTRICTED 令牌 + 降为 Low 完整性，
经 runner 子进程启动命令。其 README 明确记录了两个 `0xC0000142` 来源：

1. **缺保活组** —— 限制列表若不含 logon SID + Everyone，早期 DLL 初始化即 `0xC0000142`。
   当前实现两种模式都已包含该保活组。
2. **控制台隔离** —— 以 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 创建的子进程
   在 DLL 初始化期间死于 `STATUS_DLL_INIT_FAILED`。
   `dsh-win32-process` 的 README 确认它**只设 `STARTF_USESHOWWINDOW` + `SW_HIDE`，
   不添加**这两个标志。

### 实测（用该包自己的 `AclSandbox` 公开 API 跑真实受限路径）

```
workspace = D:\idea\sableos
模式 workspace-write，succeed：
  pwsh  Write-Output SANDBOX-OK → EXIT 0，输出 "SANDBOX-OK / 014-lesson30-dynamic-agent"
  cmd   echo CMD-OK             → EXIT 0
  模式 read-only               → EXIT 0
  git status 受限运行           → EXIT 0，正确返回分支
  受限写工作区文件              → EXIT 0（写、读、删均成功）

workspace = 本 default-workspace：
  pwsh 受限 → EXIT 0，PSVersion 5.1.19041.2364
```

对照原会话：11 次失败全部集中在 **2026-10-31 11:25:19–11:29:46** 这 4 分半内，
连 `echo test`、`cd`、`whoami` 都失败；11:32:33 用户授权 `danger-full-access` 后
**同一秒恢复**。失败发生在会话第 1–3 步，属于启动期故障。

### 结论

沙箱实现与当前系统状态下工作正常，**没有可改的配置**。
当时的 `0xC0000142` 是瞬时环境故障，最可能的诱因是当时有第三方安全软件
（本机装有火绒 HipsDaemon）在窗口期内干预进程创建——
已排除的项：无 `AppInit_DLLs`、无 `AppCertDlls`、powershell.exe 无 IFEO 劫持。

若再次出现，最快的绕过方式是**将会话切到「完全权限」(full access)**，
或重开会话（沙箱提供方每次重新初始化）。

## 四、GitHub API 403 —— 设计如此，改用 gh 通道

### 根因

`dsh-web-fetch-http` 的 README 写明：*"the harness can fetch public HTTP(S) pages …
without sending credentials"*，即 **`web_fetch` 在架构上不携带任何凭据**。
匿名访问 `api.github.com` 命中 IP 级限流（155.117.84.63，60 次/小时）即 403。

这不是缺陷，是刻意的安全边界（防止凭据外泄到任意 URL），不应该也不会去改。

### 正确通道

本机 **GitHub CLI 已登录**（账号 `wychmod`，token scope 含 `repo`）：

```
gh api repos/wychmod/sableos/pulls/11/reviews   → 200，0 条
gh pr view 11 --repo wychmod/sableos --json …   → MERGED / feat: 第26节 Web Service…
认证后限流：4996 / 5000（匿名仅 60/小时且已耗尽）
```

以后在 DSH 里读 GitHub 数据应走 `gh`（经 pwsh 调用），或 `read_page` 抓网页，
不要用 `web_fetch` 打 `api.github.com`。

## 五、未修复项（非缺陷）

| 项 | 说明 |
|---|---|
| `glob` 2 次路径不存在 | 其中 `D:\Users\…\AppData\Roaming\…` 是盘符笔误（应为 `C:`） |
| `skill "sableos-lesson-dev"` | 该 skill 在 `D:\idea\sableos\.claude\skills` 下，未注册进 DSH 会话 |

这两类属于调用时的参数错误，无法通过改环境消除。

## 六、结论

**真正修好的：Electron 运行时**，内置浏览器从完全不可用变为可用（已实测两个站点）。

**确认无需修复的：**
- pwsh 沙箱 —— 当前实现正确，实测受限模式下 pwsh/cmd/git/写入全部正常；当年的崩溃是瞬时故障
- GitHub 403 —— `web_fetch` 匿名是设计边界，正确通道是 `gh`

**建议：** 若再遇到 pwsh 全命令 `0xC0000142`，直接切 full access 继续，不要反复重试试探。
