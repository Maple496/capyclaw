import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { startService } from '../server/relay.mjs'
import { callTool } from '../server/tools.mjs'

const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-run-'))
const service = await startService({ port: 0, hostDir })
try {
  const load = (id) => JSON.parse(
    fs.readFileSync(new URL(`../server/py-executor/fixtures/${id}.json`, import.meta.url), 'utf8'))

  // W3709 deck_forge：react(大纲) → branch → template → http(发布) —— 无平台时应走 fail 分支
  const w = load('W3709')
  const r = await callTool('flow_engine_run', { workflow: w.dsl_raw, input: '做一份量子计算入门演示文稿' })
  const out = JSON.parse(r.content[0].text)
  console.log('W3709 →', JSON.stringify(out).slice(0, 400))

  // 大图 W3749（30 节点 game_forge）校验面
  const v = await callTool('flow_engine_validate', { workflow: load('W3749').dsl_raw })
  const vr = JSON.parse(v.content[0].text)
  console.log('W3749 validate →', JSON.stringify(vr).slice(0, 300))

  const h = await fetch(`${service.url}/healthz`).then(r => r.json())
  console.log('llm stats:', JSON.stringify(h.llm))
} finally { await service.stop() }
process.exit(0)
