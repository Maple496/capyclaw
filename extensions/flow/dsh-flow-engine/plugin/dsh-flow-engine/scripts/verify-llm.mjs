/** 真实 LLM 验收（opt-in：需 DSH_FLOW_LLM_API_KEY）
 *  跑两条在役工作流：W3746（llm 直答链）+ W3761（react 大纲链，含反思审查门）
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { startService } from '../server/relay.mjs'
import { callTool } from '../server/tools.mjs'

if (!process.env.DSH_FLOW_LLM_API_KEY) {
  console.error('未设置 DSH_FLOW_LLM_API_KEY —— 本脚本是真实 LLM 验收，按需 opt-in')
  process.exit(1)
}
const load = (id) => JSON.parse(
  fs.readFileSync(new URL(`../server/py-executor/fixtures/${id}.json`, import.meta.url), 'utf8'))
const parse = (r) => JSON.parse(r.content[0].text)

const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-llm-'))
const service = await startService({
  port: 0, hostDir,
  llmMode: 'openai',
  llmBaseUrl: process.env.DSH_FLOW_LLM_BASE_URL || 'https://api.deepseek.com',
  llmApiKey: process.env.DSH_FLOW_LLM_API_KEY,
  llmModelMap: process.env.DSH_FLOW_MODEL_MAP || '1=deepseek-chat',
})
try {
  const t0 = Date.now()
  const r1 = parse(await callTool('flow_engine_run', {
    workflow: load('W3746').dsl_raw,
    input: '用一句话解释什么是工作流引擎',
  }))
  console.log(`\n=== W3746 llm 直答链（${Date.now() - t0}ms）===`)
  console.log('ok:', r1.ok, '\noutput:', String(r1.output).slice(0, 300))

  const t1 = Date.now()
  const r2 = parse(await callTool('flow_engine_run', {
    workflow: load('W3761').dsl_raw,
    input: '为「城市夜经济」做一页幻灯片修订建议',
  }))
  console.log(`\n=== W3761 react 大纲链（${Date.now() - t1}ms）===`)
  console.log('ok:', r2.ok)
  const out2 = String(r2.output)
  try {
    const j = JSON.parse(out2)
    console.log('branch 路径:', j.ok === true ? 'ok（反思门通过）' : `fail（${j.note || ''}）`)
    if (j.ok === true && j.data) console.log('react 产物:', JSON.stringify(j.data).slice(0, 400))
  } catch { console.log('output:', out2.slice(0, 300)) }

  const h = await fetch(`${service.url}/healthz`).then(r => r.json())
  console.log('\nllm stats:', JSON.stringify(h.llm))
} finally { await service.stop() }
process.exit(0)
