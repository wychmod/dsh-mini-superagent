/**
 * 连跑全量 `node --test`，统计失败次数（flake 验收用）。
 * 用法：node scripts/stress-flake.mjs [次数]
 */
import { spawnSync } from 'node:child_process'

const runs = Number(process.argv[2]) || 30
let failed = 0
const failures = []

for (let i = 1; i <= runs; i++) {
  const r = spawnSync(process.execPath, ['--test'], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const pass = /^ℹ pass (\d+)$/m.exec(out)?.[1] ?? '?'
  const fail = /^ℹ fail (\d+)$/m.exec(out)?.[1] ?? '?'
  const ok = r.status === 0 && fail === '0'
  if (!ok) {
    failed += 1
    failures.push({ run: i, status: r.status, pass, fail, tail: out.split('\n').slice(-30).join('\n') })
  }
  process.stdout.write(`${ok ? '✔' : '✖'} run ${i}/${runs}  pass=${pass} fail=${fail}\n`)
}

console.log(`\n=== ${runs} 次中失败 ${failed} 次（成功 ${runs - failed}/${runs}）===`)
if (failed) {
  for (const f of failures) {
    console.log(`\n--- 失败 run #${f.run} (exit ${f.status}, pass=${f.pass}, fail=${f.fail}) ---`)
    console.log(f.tail)
  }
  process.exitCode = 1
}
