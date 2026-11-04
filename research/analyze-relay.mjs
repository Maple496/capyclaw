/** 一次性分析：ppt-bridge relay 重验证结果对比。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const r = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extensions/bridges/ppt-bridge/bench/results/evolution-relay.json'), 'utf8'))
console.log('=== relay baseline(founder=当前固化调优) ===')
console.log('genome:', JSON.stringify(r.baseline.genome))
console.log('objectives:', JSON.stringify(r.baseline.objectives))
console.log('=== balanced ===')
console.log('genome:', JSON.stringify(r.balanced?.genome))
console.log('objectives:', JSON.stringify(r.balanced?.objectives))
console.log('=== Pareto 前沿 ===')
const rows = r.pareto.map((p) => ({
  poll: p.genome.watchPollMs,
  lat: p.objectives.watchLatencyMs,
  wake: p.objectives.watchWakeupsPerSec,
  push: p.objectives.pushP95Ms,
  stab: p.objectives.stabilityFailures,
  ok: p.ok,
}))
rows.sort((a, b) => a.poll - b.poll)
for (const row of rows) {
  console.log(`poll=${String(row.poll).padStart(3)} lat=${String(row.lat).padStart(7)} wake/s=${String(row.wake).padStart(3)} pushP95=${row.push} stab=${row.stab} ok=${row.ok}`)
}
console.log('founder(75ms) 在前沿上:', rows.some((row) => row.poll === 75))
process.exit(0)
