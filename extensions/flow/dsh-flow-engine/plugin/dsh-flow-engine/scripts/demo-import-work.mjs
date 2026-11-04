/** 演示：平台作品文件 → flow_engine_import_work → 组件 → invoke */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { startService } from '../server/relay.mjs'
import { callTool } from '../server/tools.mjs'

const artifactPath = process.argv[2]
const artifact = fs.readFileSync(artifactPath, 'utf8')

const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-demo-'))
const service = await startService({ port: 0, hostDir })
try {
  const parse = (r) => JSON.parse(r.content[0].text)

  const imp = parse(await callTool('flow_engine_import_work', {
    work: artifact, note: 'WORKS-3761@4 agent_proxy_json',
  }))
  console.log('① 导入:', JSON.stringify({ ok: imp.ok, id: imp.id, requires: imp.component?.requires, warnings: imp.warnings, validate_ok: imp.validate?.ok }))

  const wf = parse(await callTool('flow_engine_workflows', {}))
  console.log('② 组件仓:', wf.workflows.length, '个组件，含', wf.workflows.filter(c => c.id === imp.id).map(c => `${c.id}@v${c.version}`)[0])

  const inv = parse(await callTool('flow_engine_invoke', {
    workflow_id: imp.id, input: '为「城市夜经济」生成幻灯片修订建议',
  }))
  console.log('③ 调用:', JSON.stringify({ ok: inv.ok, workflow: inv.workflow_name, output: String(inv.output).slice(0, 120) }))
} finally { await service.stop() }
process.exit(0)
