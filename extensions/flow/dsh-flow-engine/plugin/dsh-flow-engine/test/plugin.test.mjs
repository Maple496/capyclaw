import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startService } from '../server/relay.mjs'

async function rpc(url, body) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

test('dsh-flow-engine: healthz / metrics / MCP 契约', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-engine-test-'))
  const service = await startService({ port: 0, hostDir, worksStoreRoot: path.join(hostDir, 'dsh-store') })
  try {
    const health = await fetch(`${service.url}/healthz`).then((res) => res.json())
    assert.equal(health.ok, true)
    assert.equal(health.name, 'dsh-flow-engine')
    assert.equal(health.contractVersion, '1.0.0')

    const metrics = await fetch(`${service.url}/metrics`).then((res) => res.text())
    assert.match(metrics, /flow_engine_up 1/)

    const init = await rpc(service.url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    assert.equal(init.result.serverInfo.name, 'dsh-flow-engine')

    const list = await rpc(service.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.ok(list.result.tools.some((tool) => tool.name === 'flow_engine_capabilities'))

    const call = await rpc(service.url, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'flow_engine_capabilities', arguments: {} },
    })
    const payload = JSON.parse(call.result.content[0].text)
    assert.equal(payload.contractVersion, '1.0.0')
  } finally {
    await service.stop()
  }
})

test('dsh-flow-engine: 真实工作流端到端（fixtures + mock LLM）', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-engine-test-'))
  const service = await startService({ port: 0, hostDir, worksStoreRoot: path.join(hostDir, 'dsh-store') })
  try {
    const fixtures = await rpc(service.url, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'flow_engine_fixtures', arguments: {} },
    })
    const fx = JSON.parse(fixtures.result.content[0].text)
    assert.ok(fx.fixtures.length >= 13, '在役样本 ≥13')

    // W3746（llm 直答链）：input → llm → output
    const w3746 = fs.readFileSync(
      new URL('../server/py-executor/fixtures/W3746.json', import.meta.url), 'utf8')
    const dsl3746 = JSON.parse(w3746).dsl_raw
    const run = await rpc(service.url, {
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: {
        name: 'flow_engine_run',
        arguments: { workflow: dsl3746, input: '你好，介绍一下你自己' },
      },
    })
    const r1 = JSON.parse(run.result.content[0].text)
    assert.equal(r1.ok, true, `W3746 执行失败: ${JSON.stringify(r1)}`)
    assert.ok(String(r1.output).length > 0, '应有最终输出')

    // W3761（react deck_outline 链）：react → branch → template → output
    const w3761 = fs.readFileSync(
      new URL('../server/py-executor/fixtures/W3761.json', import.meta.url), 'utf8')
    const dsl3761 = JSON.parse(w3761).dsl_raw
    const run2 = await rpc(service.url, {
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: {
        name: 'flow_engine_run',
        arguments: { workflow: dsl3761, input: '生成一份关于深海探索的演示文稿' },
      },
    })
    const r2 = JSON.parse(run2.result.content[0].text)
    assert.equal(r2.ok, true, `W3761 执行失败: ${JSON.stringify(r2)}`)
    assert.match(String(r2.output), /ok/, 'branch ok 路径应产出回执')

    // 结构校验面：坏 DSL 点名错误
    const v = await rpc(service.url, {
      jsonrpc: '2.0', id: 13, method: 'tools/call',
      params: {
        name: 'flow_engine_validate',
        arguments: { workflow: JSON.stringify({ v: 3, nodes: [], edges: [] }) },
      },
    })
    const rv = JSON.parse(v.result.content[0].text)
    assert.equal(rv.ok, false)
    assert.ok(rv.errors.some((e) => /input_missing|empty/.test(e)))
  } finally {
    await service.stop()
  }
})

test('dsh-flow-engine: 工作流组件化（组件仓 + invoke + flow 组合节点）', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-comp-'))
  const service = await startService({ port: 0, hostDir, worksStoreRoot: path.join(hostDir, 'dsh-store') })
  try {
    // 组件仓已从 fixtures 播种
    const wl = await rpc(service.url, {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'flow_engine_workflows', arguments: {} },
    })
    const list = JSON.parse(wl.result.content[0].text)
    assert.ok(list.workflows.length >= 13, `组件仓应有 ≥13 个平台组件（实际 ${list.workflows.length}）`)
    const byId = Object.fromEntries(list.workflows.map((c) => [c.id, c]))
    assert.ok(byId['platform-w3230'], 'platform-w3230 应在仓')
    assert.equal(byId['platform-w3709'].requires.llm, true)
    assert.equal(byId['platform-w3709'].requires.platform_api, true, 'W3709 有 http 发布节点')

    // 按组件 id 直接调用
    const inv = await rpc(service.url, {
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: {
        name: 'flow_engine_invoke',
        arguments: { workflow_id: 'platform-w3746', input: '组件式调用' },
      },
    })
    const ir = JSON.parse(inv.result.content[0].text)
    assert.equal(ir.ok, true, `invoke 失败: ${JSON.stringify(ir)}`)

    // 组合：新工作流以 flow 节点引用已有组件（外层 → 子组件 → 外层）
    const composed = {
      v: 3, name: 'demo-compose', state: [],
      nodes: [
        { id: 'input', type: 'input' },
        { id: 'stage', type: 'flow', workflow_id: 'platform-w3746',
          input_template: '外层包装（主题：{{input}}）', output: 'stage_out' },
        { id: 'wrap', type: 'template', escape: 'raw',
          template: '{"composed": true, "stage_result": {{stage_out}}}',
          output: 'reply' },
        { id: 'output', type: 'output' },
      ],
      edges: [
        { from: 'input', to: 'stage' },
        { from: 'stage', to: 'wrap' },
        { from: 'wrap', to: 'output' },
      ],
    }
    const sv = await rpc(service.url, {
      jsonrpc: '2.0', id: 22, method: 'tools/call',
      params: { name: 'flow_engine_save_workflow',
        arguments: { id: 'demo-compose', name: '组合演示', dsl: JSON.stringify(composed),
          tags: ['demo'], description: 'flow 节点引用 platform-w3746' } },
    })
    const sr = JSON.parse(sv.result.content[0].text)
    assert.equal(sr.ok, true, `save_workflow 失败: ${JSON.stringify(sr)}`)
    assert.deepEqual(sr.component.requires.subflows, ['platform-w3746'],
      '依赖推导应识别 flow 节点的组件引用')

    const run = await rpc(service.url, {
      jsonrpc: '2.0', id: 23, method: 'tools/call',
      params: { name: 'flow_engine_run',
        arguments: { workflow: JSON.stringify(composed), input: '量子计算' } },
    })
    const rr = JSON.parse(run.result.content[0].text)
    assert.equal(rr.ok, true, `组合工作流执行失败: ${JSON.stringify(rr)}`)
    assert.match(String(rr.output), /"composed": true/, '外层模板应产出组合回执')
    assert.match(String(rr.output), /mock/, '子组件（platform-w3746→llm→mock）产物应回流外层')

    // 深度护栏：自引用组合应在深度 4 处判失败而非挂死
    const cyc = {
      v: 3, name: 'demo-cyclic', state: [],
      nodes: [
        { id: 'input', type: 'input' },
        { id: 'self', type: 'flow', workflow_id: 'demo-cyclic' },
        { id: 'output', type: 'output' },
      ],
      edges: [{ from: 'input', to: 'self' }, { from: 'self', to: 'output' }],
    }
    const cycRun = await rpc(service.url, {
      jsonrpc: '2.0', id: 24, method: 'tools/call',
      params: { name: 'flow_engine_save_workflow',
        arguments: { id: 'demo-cyclic', name: '自引用护栏演示', dsl: JSON.stringify(cyc) } },
    })
    const cr = JSON.parse(cycRun.result.content[0].text)
    assert.equal(cr.ok, true, '自引用组件应可入仓（护栏在执行期）')
    const cycExec = await rpc(service.url, {
      jsonrpc: '2.0', id: 25, method: 'tools/call',
      params: { name: 'flow_engine_invoke',
        arguments: { workflow_id: 'demo-cyclic', input: 'trigger' } },
    })
    const ce = JSON.parse(cycExec.result.content[0].text)
    assert.equal(ce.ok, true, '自引用应被深度护栏吸收为 fail 分支产物，而非挂死/500')
    assert.match(String(ce.output), /深度超限/, `应产出深度护栏错误: ${JSON.stringify(ce)}`)
  } finally {
    await service.stop()
  }
})

test('dsh-flow-engine: 作品导入（agent_proxy_json → 组件 → 调用）', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-import-'))
  const service = await startService({ port: 0, hostDir, worksStoreRoot: path.join(hostDir, 'dsh-store') })
  try {
    // 用 fixtures 里的 meta（= 平台 agent_proxy_json 原文）构造导入工件
    const fx = JSON.parse(fs.readFileSync(
      new URL('../server/py-executor/fixtures/W3761.json', import.meta.url), 'utf8'))
    const artifact = JSON.stringify(fx.meta) // 即 work_versions.agent_proxy_json

    const imp = await rpc(service.url, {
      jsonrpc: '2.0', id: 30, method: 'tools/call',
      params: { name: 'flow_engine_import_work',
        arguments: { work: artifact, id: 'imported-curator', note: 'WORKS-3761@4' } },
    })
    const ir = JSON.parse(imp.result.content[0].text)
    assert.equal(ir.ok, true, `导入失败: ${JSON.stringify(ir)}`)
    assert.equal(ir.component.id, 'imported-curator')
    assert.equal(ir.component.requires.llm, true)
    assert.ok(ir.warnings.some((w) => /装饰器/.test(w)), '应提示装饰器外壳未导入')

    // 导入即可调用
    const inv = await rpc(service.url, {
      jsonrpc: '2.0', id: 31, method: 'tools/call',
      params: { name: 'flow_engine_invoke',
        arguments: { workflow_id: 'imported-curator', input: '策展主题：城市夜经济' } },
    })
    const iv = JSON.parse(inv.result.content[0].text)
    assert.equal(iv.ok, true, `导入组件调用失败: ${JSON.stringify(iv)}`)
    assert.ok(String(iv.output).length > 0, '应有产物（mock 下走 fail 分支回执亦算产物）')

    // 坏工件应被点名拒绝
    const bad = await rpc(service.url, {
      jsonrpc: '2.0', id: 32, method: 'tools/call',
      params: { name: 'flow_engine_import_work',
        arguments: { work: JSON.stringify({ hello: 'world' }) } },
    })
    const br = JSON.parse(bad.result.content[0].text)
    assert.equal(br.ok, false, '非工作流工件应被拒绝')
    assert.equal(br.stage, 'parse', '拒绝应发生在解析阶段并返回结构化报告')
    assert.ok(String(br.error).length > 0)

    // 画布形 DSL（pyfunc 语义）：统一引擎画布内核可执行——导入应标注而非拒绝
    const canvas = {
      v: 3, name: 'canvas-demo', state: [],
      nodes: [{ id: 'a', type: 'pyfunc', code: 'def fn(state):\n    return 1', x: 1, y: 2 }],
      edges: [
        { from: '__canvas_in', to: 'a' },
        { from: 'a', to: '__canvas_out' },
      ],
      groups: [],
    }
    const cv = await rpc(service.url, {
      jsonrpc: '2.0', id: 33, method: 'tools/call',
      params: { name: 'flow_engine_import_work', arguments: { work: JSON.stringify(canvas) } },
    })
    const cvr = JSON.parse(cv.result.content[0].text)
    assert.equal(cvr.ok, true, `画布形导入失败: ${JSON.stringify(cvr)}`)
    assert.ok(cvr.warnings.some((w) => /画布形/.test(w)), '应标注画布方言')
    assert.ok(cvr.component.tags.includes('canvas'))
    const cvRun = await rpc(service.url, {
      jsonrpc: '2.0', id: 34, method: 'tools/call',
      params: { name: 'flow_engine_run',
        arguments: { workflow: JSON.stringify(canvas), input: 'x' } },
    })
    const cvrr = JSON.parse(cvRun.result.content[0].text)
    assert.equal(cvrr.ok, true, `画布执行失败: ${JSON.stringify(cvrr)}`)
    assert.equal(String(cvrr.output), '1', 'pyfunc 产出应经出口模板回流')
    assert.equal(cvrr.engine, 'canvas-superstep')
  } finally {
    await service.stop()
  }
})

test('dsh-flow-engine: 统一引擎画布内核（超步/when/reducer/fan/步数闸）', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-'))
  const service = await startService({ port: 0, hostDir, worksStoreRoot: path.join(hostDir, 'dsh-store') })
  const parse = (r) => JSON.parse(r.result.content[0].text)
  const run = async (id, workflow, input) => parse(await rpc(service.url, {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'flow_engine_run', arguments: { workflow, input } },
  }))
  try {
    // ① §16 规范样本（翻译三步链，ctx.llm 经 shim）
    const spec16 = {
      v: 3, name: '翻译三步链', state: [],
      nodes: [
        { id: 'outline', type: 'pyfunc', output: 'outline',
          code: 'async def fn(state, ctx):\n    out = await ctx.llm("列出这句外文翻译要点：" + state["question"], system="你是翻译规划师")\n    print("[要点]", out)\n    return out\n' },
        { id: 'draft', type: 'pyfunc', output: 'draft',
          code: 'async def fn(state, ctx):\n    d = await ctx.llm("按要点译成中文\\n要点：" + state["outline"], system="你是译者")\n    return d\n' },
        { id: 'polish', type: 'pyfunc',
          code: 'async def fn(state, ctx):\n    p = await ctx.llm("润色这段译文：" + state["draft"], system="你是编辑")\n    return p\n' },
      ],
      edges: [
        { from: '__canvas_in', to: 'outline' },
        { from: 'outline', to: 'draft' },
        { from: 'draft', to: 'polish' },
        { from: 'polish', to: '__canvas_out' },
      ],
    }
    const r1 = await run(50, JSON.stringify(spec16), 'hello world')
    assert.equal(r1.ok, true, `§16 样本失败: ${JSON.stringify(r1)}`)
    assert.ok(String(r1.output).length > 0)
    const fnTrace = r1.trace.filter((t) => !t.node.startsWith('__canvas_'))
    assert.equal(fnTrace.length, 3, '三个作者节点应有三条 trace（虚拟边界节点另计）')
    assert.ok(fnTrace.every((t) => t.status === 'ok'), '作者节点应全 ok')

    // ② 并行分支 + join（多源出口模板）
    const parallel = {
      v: 3, name: 'parallel-join', state: [],
      nodes: [
        { id: 'a', type: 'pyfunc', output: 'a', code: 'def fn(state):\n    return {"v": 1}\n' },
        { id: 'b', type: 'pyfunc', output: 'b', code: 'def fn(state):\n    return "B标记"\n' },
        { id: 'c', type: 'pyfunc', output: 'c', code: 'def fn(state):\n    return "C标记"\n' },
      ],
      edges: [
        { from: '__canvas_in', to: 'a' },
        { from: 'a', to: 'b' }, { from: 'a', to: 'c' },
        { from: 'b', to: '__canvas_out' }, { from: 'c', to: '__canvas_out' },
      ],
    }
    const r2 = await run(51, JSON.stringify(parallel), 'x')
    assert.equal(r2.ok, true, `并行 join 失败: ${JSON.stringify(r2)}`)
    assert.match(String(r2.output), /B标记/, '分支 b 产出应在 answer')
    assert.match(String(r2.output), /C标记/, '分支 c 产出应在 answer')

    // ③ when 守卫：命中路由 + 全不命中响亮报错
    const guard = (miss) => ({
      v: 3, name: 'when-guard', state: [],
      nodes: [
        { id: 't', type: 'pyfunc', output: 'cat',
          code: miss ? 'def fn(state):\n    return "other"\n' : 'def fn(state):\n    return "billing"\n' },
        { id: 'w1', type: 'pyfunc', output: 'reply', code: 'def fn(state):\n    return "计费分支"\n' },
        { id: 'w2', type: 'pyfunc', output: 'reply2', code: 'def fn(state):\n    return "销售分支"\n' },
      ],
      edges: [
        { from: '__canvas_in', to: 't' },
        { from: 't', to: 'w1', when: "cat == 'billing'" },
        { from: 't', to: 'w2', when: "cat == 'sales'" },
        { from: 'w1', to: '__canvas_out' },
        { from: 'w2', to: '__canvas_out' },
      ],
    })
    const r3 = await run(52, JSON.stringify(guard(false)), 'x')
    assert.equal(r3.ok, true)
    assert.match(String(r3.output), /计费分支/, 'when 命中 w1')
    const r3miss = await run(53, JSON.stringify(guard(true)), 'x')
    assert.equal(r3miss.ok, false, '全不命中应显式报错')
    assert.match(JSON.stringify(r3miss), /全部未命中/, '全不命中文案应点名')

    // ④ reducer append：并行分支写同键累加成 list
    const reducer = {
      v: 3, name: 'reducer-append',
      state: [{ key: 'votes', reducer: 'append' }],
      nodes: [
        { id: 'a', type: 'pyfunc', output: 'a', code: 'def fn(state):\n    return 1\n' },
        { id: 'b1', type: 'pyfunc', output: 'votes', code: 'def fn(state):\n    return "v1"\n' },
        { id: 'b2', type: 'pyfunc', output: 'votes', code: 'def fn(state):\n    return "v2"\n' },
        { id: 'j', type: 'pyfunc', output: 'reply',
          code: 'def fn(state):\n    return "合并:" + ",".join(state.get("votes") or [])\n' },
      ],
      edges: [
        { from: '__canvas_in', to: 'a' },
        { from: 'a', to: 'b1' }, { from: 'a', to: 'b2' },
        { from: 'b1', to: 'j' }, { from: 'b2', to: 'j' },
        { from: 'j', to: '__canvas_out' },
      ],
    }
    const r4 = await run(54, JSON.stringify(reducer), 'x')
    assert.equal(r4.ok, true, `reducer 失败: ${JSON.stringify(r4)}`)
    assert.match(String(r4.output), /合并:v1,v2/, 'append 应累加成 list')

    // ⑤ 回路：计数循环正常出口（n>=3 时走 z 支路） + 步数闸兜底
    const loop = (threshold) => ({
      v: 3, name: 'loop-limit', state: [],
      nodes: [
        { id: 'x', type: 'pyfunc', output: 'n',
          code: 'def fn(state):\n    return (state.get("n") or 0) + 1\n' },
        { id: 'y', type: 'pyfunc', output: 'tick', code: 'def fn(state):\n    return None\n' },
        { id: 'z', type: 'pyfunc', output: 'reply',
          code: 'def fn(state):\n    return "循环%d轮后完成" % (state.get("n") or 0)\n' },
      ],
      edges: [
        { from: '__canvas_in', to: 'x' },
        { from: 'x', to: 'y', when: `n < ${threshold}` },
        { from: 'y', to: 'x' },
        { from: 'x', to: 'z', when: `n >= ${threshold}` },
        { from: 'z', to: '__canvas_out' },
      ],
    })
    const r5ok = await run(55, JSON.stringify(loop(3)), 'x')
    assert.equal(r5ok.ok, true, `回路正常出口失败: ${JSON.stringify(r5ok)}`)
    assert.match(String(r5ok.output), /循环3轮后完成/, '守卫应随代际重评并正确收口')
    const r5 = await run(56, JSON.stringify(loop(100000)), 'x')
    assert.equal(r5.ok, false, '超限回路应被步数闸终止')
    assert.match(JSON.stringify(r5), /超过最大步数 50/, '步数闸文案应对齐规范')
  } finally {
    await service.stop()
  }
})

test('dsh-flow-engine: agent 节点接管（executor=dsh，循环在宿主）', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-agent-'))
  const service = await startService({ port: 0, hostDir, worksStoreRoot: path.join(hostDir, 'dsh-store') })
  try {
    // A) http 工具体：mock LLM 首轮回 tool_calls → 宿主分派 http POST → 终答
    const yamlA = [
      'version: "2.0"',
      'nodes:',
      '  - id: input',
      '    type: input',
      '  - id: agent',
      '    type: agent',
      '    executor: dsh',
      '    model: 1',
      '    system_prompt: "你是探测器，需要信息时调用工具。"',
      '    max_iterations: 4',
      '    tools:',
      '      - name: probe',
      '        description: 探测服务状态',
      '        http:',
      `          url: ${service.url}/api/flow/subflow`,
      '  - id: output',
      '    type: output',
      'edges:',
      '  - from: input',
      '    to: agent',
      '  - from: agent',
      '    to: output',
    ].join('\n')
    const runA = await rpc(service.url, {
      jsonrpc: '2.0', id: 40, method: 'tools/call',
      params: { name: 'flow_engine_run', arguments: { workflow: yamlA, input: '查一下服务状态' } },
    })
    const rA = JSON.parse(runA.result.content[0].text)
    assert.equal(rA.ok, true, `http 工具接管失败: ${JSON.stringify(rA)}`)
    assert.match(String(rA.output), /已根据工具结果/, '应走完 工具调用→观察→终答 全循环')

    // B) workflow 工具体（平台 W3711 双语助手接管）：translate 子 DAG 经宿主递归执行
    const fx = JSON.parse(fs.readFileSync(
      new URL('../server/py-executor/fixtures/W3711.json', import.meta.url), 'utf8'))
    const patched = fx.dsl_raw.replace('type: agent\n', 'type: agent\n    executor: dsh\n')
    assert.notEqual(patched, fx.dsl_raw, 'W3711 应含 agent 节点可打接管补丁')
    const runB = await rpc(service.url, {
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'flow_engine_run', arguments: { workflow: patched, input: '把"你好"翻译成英文' } },
    })
    const rB = JSON.parse(runB.result.content[0].text)
    assert.equal(rB.ok, true, `W3711 接管失败: ${JSON.stringify(rB)}`)
    assert.match(String(rB.output), /已根据工具结果/, 'workflow 工具体应经宿主递归执行后终答')

    const h = await fetch(`${service.url}/healthz`).then((r) => r.json())
    assert.ok(h.llm.requests >= 4, `接管路径 LLM 调用应 ≥4 次（实际 ${h.llm.requests}）`)
  } finally {
    await service.stop()
  }
})

test('dsh-flow-engine: 组件 → dsh 作品体系对齐（registry + works + CLI）', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-works-'))
  const worksStoreRoot = path.join(hostDir, 'dsh-store')
  let service = await startService({ port: 0, hostDir, worksStoreRoot })
  const wsRoot = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(wsRoot, '..', '..', '..', '..', '..', '..')
  try {
    // ① 播种即登记：registry.json 有平台组件条目，capabilities 索引在位
    const reg = JSON.parse(fs.readFileSync(path.join(worksStoreRoot, 'registry.json'), 'utf8'))
    const refs = reg.works.map((w) => w.ref)
    assert.ok(refs.includes('WORKS-local-flow-platform-w3230'), '平台组件应登记为作品')
    assert.ok(refs.every((r) => r.startsWith('WORKS-local-flow-')), 'ref 形应统一')
    assert.ok((reg.capabilities['flow.workflow'] || []).length >= 13, '能力索引应含全部组件')

    // ② works 目录产物：meta/content/.works 三件齐，content 携带 DSL
    const workDir = path.join(worksStoreRoot, 'works', 'WORKS-local-flow-platform-w3230')
    const meta = JSON.parse(fs.readFileSync(path.join(workDir, 'meta.json'), 'utf8'))
    const content = JSON.parse(fs.readFileSync(path.join(workDir, 'content.json'), 'utf8'))
    assert.equal(meta.view.kind, 'workflow')
    assert.equal(meta.capabilities[0], 'flow.workflow')
    assert.equal(content.kind, 'flow-workflow')
    assert.ok(String(content.dsl).includes('react'), '作品应自带执行体（DSL）')
    assert.ok(fs.existsSync(path.join(workDir, 'WORKS-local-flow-platform-w3230.works')))

    // ③ 新保存组件联动登记；移除联动注销
    const tiny = { v: 3, name: 'tiny', state: [], nodes: [
      { id: 'input', type: 'input' }, { id: 'o', type: 'output' },
    ], edges: [{ from: 'input', to: 'o' }] }
    const sv = await rpc(service.url, { jsonrpc: '2.0', id: 60, method: 'tools/call',
      params: { name: 'flow_engine_save_workflow',
        arguments: { id: 'works-demo', name: '作品对齐演示', dsl: JSON.stringify(tiny) } } })
    assert.equal(JSON.parse(sv.result.content[0].text).ok, true)
    const reg2 = JSON.parse(fs.readFileSync(path.join(worksStoreRoot, 'registry.json'), 'utf8'))
    assert.ok(reg2.works.some((w) => w.ref === 'WORKS-local-flow-works-demo'), '保存应联动登记')

    const rm = await rpc(service.url, { jsonrpc: '2.0', id: 61, method: 'tools/call',
      params: { name: 'flow_engine_remove_workflow', arguments: { id: 'works-demo' } } })
    assert.equal(JSON.parse(rm.result.content[0].text).ok, true)
    const reg3 = JSON.parse(fs.readFileSync(path.join(worksStoreRoot, 'registry.json'), 'utf8'))
    assert.ok(!reg3.works.some((w) => w.ref === 'WORKS-local-flow-works-demo'), '移除应联动注销')
    assert.ok(!fs.existsSync(path.join(worksStoreRoot, 'works', 'WORKS-local-flow-works-demo')))

    // ④ 真实 dsh-works CLI 端到端：同一 store 根下 list/search 应看到组件作品
    const cli = path.join(repoRoot, 'packages', 'dsh-suite-kit', 'bin', 'dsh-works.mjs')
    const out = execFileSync(process.execPath, [cli, 'search', 'deck_forge'], {
      env: { ...process.env, DSH_STORE_ROOT: worksStoreRoot },
      encoding: 'utf8', timeout: 30000,
    })
    assert.match(out, /WORKS-local-flow-platform-w3709/, 'dsh-works search 应能找到组件作品')
    assert.match(out, /workflow/, '类型应为 workflow')

    // ⑤ 幂等：重复启动不产生重复条目
    await service.stop()
    service = await startService({ port: 0, hostDir, worksStoreRoot })
    const reg4 = JSON.parse(fs.readFileSync(path.join(worksStoreRoot, 'registry.json'), 'utf8'))
    const uniq = new Set(reg4.works.map((w) => w.ref))
    assert.equal(uniq.size, reg4.works.length, '对账应幂等（无重复条目）')
  } finally {
    await service.stop()
  }
})

test('dsh-flow-engine: 反向闭环（.works → dsh-works install → 启动物化 → 可执行）', async () => {
  // 机器 A：造一个非 fixtures 的自定义组件并登记为作品
  const hostA = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sync-a-'))
  const storeA = path.join(hostA, 'dsh-store')
  const serviceA = await startService({ port: 0, hostDir: hostA, worksStoreRoot: storeA })
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', '..', '..')
  try {
    const doc = { v: 3, name: 'portable-demo', state: [], nodes: [
      { id: 'input', type: 'input' },
      { id: 'a', type: 'pyfunc', output: 'reply',
        code: 'def fn(state):\n    return "便携作品可达:%s" % state["question"]\n' },
      { id: 'output', type: 'output' },
    ], edges: [{ from: 'input', to: 'a' }, { from: 'a', to: 'output' }] }
    const sv = await rpc(serviceA.url, { jsonrpc: '2.0', id: 70, method: 'tools/call',
      params: { name: 'flow_engine_save_workflow',
        arguments: { id: 'portable-demo', name: '便携演示', dsl: JSON.stringify(doc) } } })
    assert.equal(JSON.parse(sv.result.content[0].text).ok, true)
    await serviceA.stop()

    // 机器 B：拿 .works 文件经真实 dsh-works CLI 安装（外来 ref 形）
    const hostB = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sync-b-'))
    const storeB = path.join(hostB, 'dsh-store')
    const worksFile = path.join(storeA, 'works', 'WORKS-local-flow-portable-demo',
      'WORKS-local-flow-portable-demo.works')
    assert.ok(fs.existsSync(worksFile), 'A 机应产出 .works 分发件')
    execFileSync(process.execPath,
      [path.join(repoRoot, 'packages', 'dsh-suite-kit', 'bin', 'dsh-works.mjs'), 'install', worksFile],
      { env: { ...process.env, DSH_STORE_ROOT: storeB }, encoding: 'utf8', timeout: 30000 })

    // B 机启动：外来作品应自动物化为组件并立即可执行
    const serviceB = await startService({ port: 0, hostDir: hostB, worksStoreRoot: storeB })
    try {
      const wl = await rpc(serviceB.url, { jsonrpc: '2.0', id: 71, method: 'tools/call',
        params: { name: 'flow_engine_workflows', arguments: {} } })
      const list = JSON.parse(wl.result.content[0].text)
      const demo = list.workflows.find((c) => c.id === 'portable-demo')
      assert.ok(demo, '外来作品应已物化为组件')
      assert.equal(demo.source.kind, 'work')

      const inv = await rpc(serviceB.url, { jsonrpc: '2.0', id: 72, method: 'tools/call',
        params: { name: 'flow_engine_invoke',
          arguments: { workflow_id: 'portable-demo', input: '跨机流转' } } })
      const r = JSON.parse(inv.result.content[0].text)
      assert.equal(r.ok, true, `物化组件应可执行: ${JSON.stringify(r)}`)
      assert.match(String(r.output), /便携作品可达:跨机流转/, 'pyfunc 产出应回流')

      // 既有组件不被外来物化覆盖（执行真源在组件仓）
      const cur = JSON.parse(fs.readFileSync(path.join(hostB, 'workflows',
        'platform-w3230.workflow.json'), 'utf8'))
      assert.ok(cur.dsl.includes('react'), 'fixture 组件应保持种子内容')
    } finally { await serviceB.stop() }
  } finally { await serviceA.stop() }
})
