#!/usr/bin/env node
/**
 * 生成 `dsh-mini-superagent/preview/board-preview.html`：把真实的面板组件内联进一个独立页面，
 * 配一份覆盖各种状态的假数据，用来在宿主之外目视版式。
 *
 * 为什么是「生成」而不是手写：面板只有装进 DSH 才跑得起来，而预览页要能双击打开；
 * 内联能避免相对路径在不同托管方式（file://、静态目录、插件预览面板）下失效，
 * 但内联的副本会随 `client/index.js` 变旧——所以源是模板 + 这个脚本，产物不进代码评审重点。
 *
 * 用法：
 *   node scripts/board-preview.mjs
 *
 * 依赖：只需 Node 内置模块；页面里的 React 来自 cdn.jsdelivr.net。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', 'dsh-mini-superagent')
const TEMPLATE = resolve(ROOT, 'preview', 'board-preview.template.html')
const CLIENT = resolve(ROOT, 'client', 'index.js')
const OUTPUT = resolve(ROOT, 'preview', 'board-preview.html')

const template = readFileSync(TEMPLATE, 'utf8')
const client = readFileSync(CLIENT, 'utf8')

if (!template.includes('<!--CLIENT_SOURCE-->')) {
  console.error('模板里找不到 <!--CLIENT_SOURCE--> 占位符')
  process.exit(1)
}
if (client.includes('</script')) {
  // 内联进 <script> 时会被提前闭合，属于必须拦下的情况。
  console.error('client/index.js 里出现了 </script，无法安全内联')
  process.exit(1)
}

const banner = '<!-- 由 scripts/board-preview.mjs 生成，不要直接改这个文件；改 preview/board-preview.template.html 或 client/index.js 后重新生成。 -->\n'
const inlined = template.replace('<!--CLIENT_SOURCE-->', `<script>\n${client}\n</script>`)
// 注释放在 DOCTYPE 之后：放在前面虽然也合法，但会让某些老浏览器进怪异模式。
const html = inlined.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n' + banner.trim())
writeFileSync(OUTPUT, html)
console.log(`已生成 ${OUTPUT}`)
console.log(`  模板 ${template.split('\n').length} 行 + 客户端 ${client.split('\n').length} 行`)
