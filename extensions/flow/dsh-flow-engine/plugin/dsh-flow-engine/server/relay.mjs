/**
 * dsh-flow-engine 服务组合根。
 *
 * 宿主（端口/锁/复用/健康/指标/静态/关闭）由 dsh-service-host 提供；
 * 工具面（能力 DSL/注册表/校验/契约/MCP）由 dsh-tool-host 提供；
 * 本文件只保留业务装配。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServiceApp, send } from './shared/service-host.mjs'
import { createEditorHost } from './shared/editor-host.mjs'
import { startPyWorker } from './pyworker.mjs'
import { createLlmShim } from './llmshim.mjs'
import { createWorkflowStore } from './workflows.mjs'
import { registerWork, unregisterWork, reconcileWorks, listWorkflowWorks, defaultStoreRoot, workRefFor } from './worksreg.mjs'
import { bindRuntime, runtimeHealth, flowRun, subflowExec, agentExec, pyWorkerLogs } from './impl.mjs'
import {
  tools, callTool, contractVersion, capabilities, buildInstructions, createMcp,
} from './tools.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PORT = 39600
const SERVICE_NAME = 'dsh-flow-engine'
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))

const EDITOR_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
}

export async function startService(options = {}) {
  const packageDir = options.packageDir || path.resolve(HERE, '..')
  const editorDir = path.join(packageDir, 'editor')
  const hasEditor = fs.existsSync(path.join(editorDir, 'index.html'))

  const app = createServiceApp({
    id: SERVICE_NAME,
    title: PKG.meta?.title || PKG.name,
    version: PKG.version,
    contractVersion,
    slug: 'flow-engine',
    health: () => ({
      editor: hasEditor ? `http://127.0.0.1:${app.port}/` : '',
      tools: tools.length,
      ...runtimeHealth(),
    }),
  })

  // 1) Python 执行器 worker（上游 port-8301/app 快照）+ LLM shim + 组件仓装配
  const log = (line) => console.log(`[dsh-flow-engine] ${line}`)
  const hostDir = options.hostDir || process.env.DSH_FLOW_ENGINE_HOME
    || path.join(process.env.DSH_STORE_ROOT || path.join(os.homedir(), '.dsh-store'), 'flow-engine')
  // 作品注册表根：随 dsh-works 约定（DSH_STORE_ROOT / ~/.dsh-store）；
  // 测试经 options.worksStoreRoot 指到临时目录，避免污染真实 registry
  const worksStoreRoot = options.worksStoreRoot || defaultStoreRoot()
  const store = createWorkflowStore({
    dir: options.workflowsDir || path.join(hostDir, 'workflows'),
    log,
    onSave: (comp) => { registerWork(comp, { storeRoot: worksStoreRoot }) },
    onRemove: (id) => { unregisterWork(id, { storeRoot: worksStoreRoot }) },
  })
  const seed = store.seedFromFixtures(path.join(HERE, 'py-executor', 'fixtures'))
  if (seed.seeded.length) log(`组件仓播种: +${seed.seeded.length} 个平台组件（跳过已存在 ${seed.skipped}）`)
  // 组件 ↔ 作品对账（双向）：
  // 正向：仓内组件 → 作品登记（dsh-works CLI 可见）
  const reconciled = reconcileWorks(store.allWithDsl(), { storeRoot: worksStoreRoot })
  log(`作品对账: ${reconciled.count} 个组件 → ${worksStoreRoot}（ref 形 WORKS-local-flow-<id>）`)
  // 反向：作品注册表里的 workflow 作品（含 dsh-works install 装入的外来作品）
  // → 缺失的物化为组件。已存在的不动（执行真源在组件仓；刷新走显式 import_work）。
  let materialized = 0
  let foreignSkipped = 0
  for (const work of listWorkflowWorks({ storeRoot: worksStoreRoot })) {
    const r = store.materialize(work)
    if (r.skipped) foreignSkipped += 1
    else materialized += 1
  }
  if (materialized || foreignSkipped) {
    log(`作品物化: +${materialized} 个来自作品注册表（跳过已存在 ${foreignSkipped}）`)
  }

  // DEEPSEEK_BASE_URL 语义陷阱：同名 env 被 dsh 核心插件按 Anthropic Messages 语义消费
  // （正确值带 /anthropic 后缀），而本服务走 OpenAI 兼容协议（拼 /chat/completions）。
  // 回退引用它时必须剥掉 /anthropic 后缀，否则两端永远有一端打错端点（404）。
  const openAiBase = (value) => String(value || '').replace(/\/anthropic\/?$/, '')
  const llmBaseUrl = options.llmBaseUrl || process.env.DSH_FLOW_LLM_BASE_URL
    || openAiBase(process.env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com'

  const shim = createLlmShim({
    mode: options.llmMode || process.env.DSH_FLOW_LLM_MODE,
    // 平台编号模型（model: 1）→ 真实模型名的回退链：row 配置 → 专用 env → harness 标准 env → 内置缺省
    baseUrl: llmBaseUrl,
    apiKey: options.llmApiKey || process.env.DSH_FLOW_LLM_API_KEY
      || process.env.DEEPSEEK_API_KEY,
    modelMap: options.llmModelMap || process.env.DSH_FLOW_MODEL_MAP,
    defaultModel: options.llmDefaultModel || process.env.DSH_FLOW_LLM_DEFAULT_MODEL
      || 'deepseek-chat',
    completeFn: options.completeFn, // dsh 模式：host.mjs 从 ctx.llm 注入
  })
  const pyWorker = await startPyWorker({ log, env: options.pyEnv })
  bindRuntime({ pyWorker, shim, workflowStore: store })

  // 2) LLM shim：执行器的 llm_router_url 指向本服务，/v1/llm/complete 在此承接
  app.use((req, res, u) => shim.handler(req, res, u))

  // 3) 执行器代理面（诊断/直连用；MCP 工具走 impl.mjs 同一实现）
  app.get('/api/flow/health', (req, res) =>
    fetch(`${pyWorker.url}/v1/health`).then((r) => r.json())
      .then((j) => send(req, res, 200, j))
      .catch((e) => send(req, res, 502, { ok: false, error: String(e.message || e) })))
  app.get('/api/flow/logs', (req, res) => send(req, res, 200, { logs: pyWorkerLogs() }))
  app.get('/api/flow/execute', (req, res) => send(req, res, 405, { detail: 'POST only' }))
  app.use((req, res, u) => {
    if (u.pathname !== '/api/flow/execute') return false
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const r = await flowRun(body)
        send(req, res, 200, r)
      } catch (e) {
        send(req, res, 400, { ok: false, error: String(e.message || e) })
      }
    })
    return true
  })
  // flow 组合节点回调面：执行器按 workflow_id 回调，此处解析组件仓并递归执行
  app.use((req, res, u) => {
    if (u.pathname !== '/api/flow/subflow') return false
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const r = await subflowExec(body)
        send(req, res, r.status, r.data)
      } catch (e) {
        send(req, res, 500, { ok: false, error: String(e.message || e) })
      }
    })
    return true
  })
  // agent 节点接管回调面（executor: dsh）：循环策略在 Node，沙箱回调执行器
  app.use((req, res, u) => {
    if (u.pathname !== '/api/flow/agent') return false
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const r = await agentExec(body)
        send(req, res, 200, r)
      } catch (e) {
        send(req, res, 500, { ok: false, error: String(e.message || e) })
      }
    })
    return true
  })

  const instructions = buildInstructions({
    title: PKG.meta?.title || PKG.name,
    intro: `本服务提供 flow_engine_* 工具。`,
    startup: [`先调用 \`flow_engine_capabilities\` 确认 contractVersion 为 1.x。`],
    capabilities: capabilities().capabilities,
    rules: ['工具返回已含回执；改完一句话回复，不要重复验证。'],
  })
  const mcp = createMcp({ name: SERVICE_NAME, version: PKG.version }, instructions)
  app.use((req, res, u) => {
    if (u.pathname !== '/mcp') return false
    return mcp(req, res).then(() => true)
  })

  app.get('/api/info', (req, res) => {
    send(req, res, 200, {
      ok: true,
      name: SERVICE_NAME,
      version: PKG.version,
      contractVersion,
      editor: hasEditor,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    })
  })

  if (hasEditor) {
    const editor = createEditorHost({ id: SERVICE_NAME, dir: editorDir, files: EDITOR_FILES })
    for (const route of editor.routes()) app.use(route)
  }

  const info = await app.listen({
    port: Number(options.port ?? DEFAULT_PORT),
    hostDir: options.hostDir,
    strictPort: options.strictPort,
    lockFile: options.lockFile,
    allowReuse: options.allowReuse !== false,
    scanLimit: options.scanLimit ?? 50, // 防御性显式值（快照内 tuning 已含 portScanLimit，此处仅兜底）
  })
  // listen 后回填真实端口：执行器的 llm_router_url 指向本服务 shim
  bindRuntime({ pyWorker, shim, baseUrl: info.url })
  return {
    ...info,
    editorUrl: `${info.url}/`,
    executorUrl: pyWorker.url,
    stop: async () => {
      await pyWorker.stop()
      await info.stop()
    },
  }
}
