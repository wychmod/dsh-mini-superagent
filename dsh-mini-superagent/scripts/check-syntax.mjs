#!/usr/bin/env node
/**
 * 统一语法闸门：递归收集 `src`、`client` 下的 `.js` 与 `scripts` 下的 `.mjs`，
 * 逐个跑 `node --check`；有文件解析不了就打印「路径 + 原始错误」并以退出码 1 结束。
 *
 * 为什么不用 shell 通配（比如在 npm scripts 里直接写跨目录的通配符）：
 * 1. **跨平台不一致**：globstar 是 bash 的 opt-in 特性，PowerShell 的 `*` 不跨目录，
 *    Windows 上 npm 借用的 sh 也未必展开 globstar。某个平台不展开时，通配符会原样传给
 *    `node --check`，它去找一个文件名里真的带星号的文件并报错——检查看起来跑了，
 *    实际一个文件都没查，闸门形同虚设。
 * 2. **一次只收一个文件**：只有逐个 spawn 才能在失败时准确指出是哪个文件，
 *    并把 Node 打印的原始错误（行号、行内容、`^` 指示）完整带出来。
 * 3. **零依赖**：`fs.readdir` 递归是 Node 内置能力，不需要 glob 包。
 *    本包「零运行时依赖」是硬底线，开发脚本也不开这个口子。
 *
 * 路径约定：脚本自己定位包目录，**不依赖当前工作目录**。
 * 从仓库根跑、从包目录跑、从 CI 的 working-directory 跑，扫到的文件集合必须一致。
 *
 * 用法：node scripts/check-syntax.mjs
 * 退出码：0 = 全部文件语法通过；1 = 至少一个文件语法错误（全部列完再退出，不提前中断）。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 包目录：本脚本在 <包>/scripts/ 下。 */
const PROJECT_ROOT = resolve(HERE, '..')
/** 仓库根：包目录的上一级；仓库根的 scripts/ 放离线冒烟与预览脚本。 */
const REPO_ROOT = resolve(PROJECT_ROOT, '..')

const TARGETS = [
  { dir: join(PROJECT_ROOT, 'src'), ext: '.js' },
  { dir: join(PROJECT_ROOT, 'client'), ext: '.js' },
  { dir: join(PROJECT_ROOT, 'scripts'), ext: '.mjs' },
  // 仓库根 scripts/：client-smoke.mjs（离线渲染冒烟）就在这里，它正是被 `npm run check`
  // 串起来的那一条，语法也该纳入闸门。本包被单独取出时这个目录不存在，下面的 ENOENT 会跳过。
  { dir: join(REPO_ROOT, 'scripts'), ext: '.mjs' },
]

// 不递归的目录：依赖、版本库元数据、编辑器/预览缓存。里面不是本仓库的源码。
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', '.preview'])

/**
 * 递归把一个目录下的目标后缀文件收进 `out`。
 * 跳过符号链接：可能是环，也可能指到仓库外，两种都不该被这个闸门管。
 */
function collect(dir, ext, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // 目录不存在 = 这一项目标在当前布局下不适用，跳过而不是失败。
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(full, ext, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith(ext)) continue
    out.add(full)
  }
}

/** 把多行文本缩进，让被包夹在报错里时仍然可读。 */
function indent(text) {
  return text
    .split(/\r?\n/)
    .map(line => `    ${line}`)
    .join('\n')
}

const files = new Set()
const seenDirs = new Set()
for (const { dir, ext } of TARGETS) {
  // 同一目录可能被两个目标同时指向（包目录就是仓库根时），只扫一次。
  if (seenDirs.has(dir)) continue
  seenDirs.add(dir)
  collect(dir, ext, files)
}

// 排序固定输出顺序：本地与 CI 的日志能直接对比，失败清单也稳定。
const list = [...files].sort()

if (list.length === 0) {
  // 一个文件都没扫到，说明布局变了或路径写错了。此时退出 0 会制造「检查通过」的假象；
  // 闸门空转比闸门报错危险，所以按失败处理。
  console.error('✗ 语法检查没有找到任何目标文件，检查路径可能已经失效')
  process.exit(1)
}

let failed = 0
for (const file of list) {
  // 相对仓库根的路径，统一用正斜杠：Windows 与 Linux 的日志长一样，贴到 PR 里不用换。
  const rel = relative(REPO_ROOT, file).split('\\').join('/')
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    // 不拉起控制台窗口（Windows 上批量 spawn 时尤其明显）。
    windowsHide: true,
  })
  if (result.error) {
    failed += 1
    console.error(`✗ ${rel}`)
    console.error(indent(`无法启动 node --check：${result.error.message}`))
    continue
  }
  if (result.status === 0) continue
  failed += 1
  console.error(`✗ ${rel}`)
  console.error(indent((`${result.stderr ?? ''}${result.stdout ?? ''}`.trim()) || `node --check 退出码 ${result.status}`))
}

if (failed > 0) {
  console.error(`\n✗ 语法检查失败：${failed}/${list.length} 个文件`)
  process.exitCode = 1
} else {
  console.log(`✓ 语法检查通过：${list.length} 个文件`)
}
