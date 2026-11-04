/**
 * 桥 relay 组合根：
 *   1) 桥端点（/api/desktop/works/ppt-bridge…）→ routes/bridge.mjs
 *   2) MCP Streamable HTTP（/mcp）→ mcp/handler.mjs
 *   3) 编辑器静态页（/、/app.js、/ppt-full-app.js）→ routes/editor.mjs
 *
 * 通用宿主（端口/锁/复用/健康/指标/静态/关闭）由 dsh-service-host 提供；
 * 本文件只保留 PPT 专属装配。
 *
 * 也可脱离 dsh 独立运行：node server/relay.mjs [--port 39311] [--dir <hostDir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeStore } from './store.mjs'
import { createMcpHandler, serverInstructions } from './mcp-http.mjs'
import { applyOp } from '../core/ops.js'
import { createJsonPptApp } from './ppt-shim.mjs'
import { CONTRACT_VERSION, PACKAGE_VERSION } from './contract.mjs'
import { BASE_PATH, DEFAULT_PORT } from './constants.mjs'
import { createAssetRoutes } from './routes/assets.mjs'
import { createFileAssetStore } from './shared/asset-service.mjs'
import { createEditorRoutes } from './routes/editor.mjs'
import { createMcpRoutes } from './routes/mcp.mjs'
import { createImportRoutes } from './routes/import.mjs'
import { createBridgeRoutes } from './routes/bridge.mjs'
import { replayPending } from './runtime/recovery.mjs'
import { createServiceApp } from './shared/service-host.mjs'
import { inspectContractSnapshots, describeMismatch } from './contract-snapshots.mjs'
import { getTuning } from './tuning.mjs'
import { createRuntimeStoreClient, loadRuntimeContext } from './infra/runtime/context.mjs'
import { WorkspaceBackend } from './infra/workspace/manager.mjs'

export { DEFAULT_PORT, BASE_PATH }

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function startRelay({
  port = DEFAULT_PORT,
  hostDir = process.env.PPT_BRIDGE_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh-ppt-bridge'),
  packageDir = PKG_ROOT,
  scanLimit = 50,
  lockFile,
  strictPort = false,
  allowReuse = true,
  backend = null,
  assetStore = null,
  assetService = null,
  capabilities = null,
  serviceHost = null,
  toolHost = null,
  editorHost = null,
} = {}) {
  const editorDir = path.join(packageDir, 'editor')
  const contractSnapshots = inspectContractSnapshots(packageDir, CONTRACT_VERSION)
  if (!contractSnapshots.ok) {
    console.error('[ppt-workbench] 契约快照不一致，工具调用将被拒绝:', describeMismatch(contractSnapshots))
  }
  const store = backend ? new BridgeStore({ backend }) : new BridgeStore(path.join(hostDir, 'state.json'))
  /* 独立运行（无 dsh）也要有对象仓库：图片落 hostDir/assets，
   * 否则 /assets 上传 404，ppt_images / ppt_image 的入库分支不可用。 */
  if (!assetStore && !assetService) {
    try {
      assetStore = createFileAssetStore({ dir: path.join(hostDir, 'assets') })
    } catch { /* 对象仓库不可用不影响纯 deck 功能 */ }
  }
  if (assetStore) process.env.PPT_ASSET_STORE = '1'

  const createApp = serviceHost?.createApp ? (options) => serviceHost.createApp(options) : createServiceApp
  const app = createApp({
    id: 'ppt-workbench',
    title: 'PPT Workbench',
    version: PACKAGE_VERSION,
    contractVersion: CONTRACT_VERSION,
    health: () => {
      const doc = store.get()
      const owner = doc.owner && doc.owner.id && (Date.now() / 1000 - (doc.owner.ts || 0) <= 10)
      return {
        bridge: 'ppt-workbench',
        editor: `http://127.0.0.1:${app.port}/`,
        editorConnected: !!owner,
        hasDeck: !!(doc.deck && Array.isArray(doc.deck.slides) && doc.deck.slides.length),
        slides: doc.deck && Array.isArray(doc.deck.slides) ? doc.deck.slides.length : 0,
        seq: doc.seq | 0,
        appliedSeq: doc.applied_seq | 0,
        stateSeq: doc.state_seq | 0,
        uiSeq: doc.ui_seq | 0,
        lastError: doc.error || '',
        contractsOk: contractSnapshots.ok,
        contractsChecked: contractSnapshots.checked,
        injected: {
          serviceHost: !!serviceHost,
          toolHost: !!toolHost,
          editorHost: !!editorHost,
          assets: !!assetStore,
        },
      }
    },
    metrics: () => {
      const doc = store.get()
      const slides = doc.deck && Array.isArray(doc.deck.slides) ? doc.deck.slides.length : 0
      const owner = doc.owner && doc.owner.id && (Date.now() / 1000 - (doc.owner.ts || 0) <= 10)
      return [
        ['ppt_workbench_slides', slides],
        ['ppt_workbench_seq', doc.seq | 0],
        ['ppt_workbench_applied_seq', doc.applied_seq | 0],
        ['ppt_workbench_state_seq', doc.state_seq | 0],
        ['ppt_workbench_editor_connected', owner ? 1 : 0],
        ['ppt_workbench_shot_req', doc.shot_req | 0],
        ['ppt_workbench_memory_rss_bytes', process.memoryUsage().rss],
      ]
    },
  })

  const jsonP = createJsonPptApp(store)
  let mcpHandler = null
  for (const route of createMcpRoutes({ getMcpHandler: () => mcpHandler })) app.use(route)
  if (assetService?.mount) assetService.mount(app, { store: assetStore, basePath: BASE_PATH })
  else app.use(createAssetRoutes({ assetStore, basePath: BASE_PATH }))
  for (const route of createEditorRoutes({ editorDir, editorHost })) app.use(route)
  /* 必须先于 bridge 路由：bridge 的主端点会把任意 POST 当 JSON 读取，
   * 原始 pptx 字节不能被它先消费。 */
  app.use(createImportRoutes({ basePath: BASE_PATH, importDir: path.join(hostDir, 'imports'), store }))
  for (const route of createBridgeRoutes({ store, jsonP, applyOp })) app.use(route)

  const tuning = getTuning()
  const info = await app.listen({
    port,
    hostDir,
    scanLimit,
    lockFile: lockFile || path.join(hostDir, '.relay-instance.lock'),
    strictPort,
    allowReuse,
    discoveryFile: '',
    requestTimeoutMs: Number(tuning.httpRequestTimeoutMs) || 30000,
    headersTimeoutMs: Number(tuning.httpHeadersTimeoutMs) || 10000,
    keepAliveTimeoutMs: Number(tuning.httpKeepAliveTimeoutMs) || 5000,
  })

  if (info.reused) {
    return { url: `${info.url}${BASE_PATH}`, editorUrl: `${info.url}/`, port: info.port, reused: true, stop: async () => {} }
  }

  try {
    /* bridge-client 在 import 时读 PPT_BRIDGE_URL，必须先设 env 再 import tools。 */
    process.env.PPT_BRIDGE_URL = `${info.url}${BASE_PATH}`

    /* 崩溃恢复：state.json 里 seq > applied_seq 说明上一批指令未完整落盘。
     * 用 store 的串行队列占住写锁，恢复完成前的 push 会排队而不是交叉执行。 */
    await store.enqueue(() => replayPending({ store, jsonP, applyOp }))

    let registry = null
    try {
      const tools = await import('./tools.mjs')
      registry = tools.createRegistry(tools.CAPABILITIES, { enabled: capabilities, toolHost })
    } catch (e) {
      console.error('[ppt-workbench] 工具未装载（构建产物缺失，先跑 scripts/build-plugin.mjs）:', e.message)
    }
    const TOOLS = registry?.TOOLS || []
    const TOOL_IMPL = registry?.TOOL_IMPL || {}
    const CAPABILITIES = registry?.CAPABILITIES || []
    mcpHandler = createMcpHandler({
      tools: TOOLS,
      callTool: (name, args) => {
        if (!contractSnapshots.ok && name !== 'ppt_capabilities') {
          throw new Error(
            `契约快照与运行时 major 不一致，已拒绝 ${name}：${describeMismatch(contractSnapshots)}。` +
            '请重装/升级 dsh-ppt-suite 后重试。',
          )
        }
        const impl = TOOL_IMPL[name]
        if (!impl) throw new Error('未知工具: ' + name)
        return impl(args)
      },
      serverInfo: { name: 'ppt-workbench', version: PACKAGE_VERSION },
      instructions: serverInstructions(`http://127.0.0.1:${info.port}/`, { tools: TOOLS, capabilities: CAPABILITIES }),
      maxBodyBytes: Number(tuning.bodyLimitBytes) || 10 * 1024 * 1024,
      maxBatch: Number(tuning.mcpBatchLimit) || 100,
    })

    writeDiscovery(hostDir, `${info.url}${BASE_PATH}`, info.port)
    return {
      url: `${info.url}${BASE_PATH}`,
      editorUrl: `${info.url}/`,
      port: info.port,
      reused: false,
      stop: async () => {
        removeDiscovery(hostDir)
        await info.stop()
      },
    }
  } catch (error) {
    /* 启动失败不能留下僵尸端口/锁/发现文件。 */
    try { removeDiscovery(hostDir) } catch { /* 忽略 */ }
    try { await info.stop() } catch { /* 忽略 */ }
    throw error
  }
}

function writeDiscovery(hostDir, url, port) {
  try {
    fs.mkdirSync(hostDir, { recursive: true })
    fs.writeFileSync(path.join(hostDir, 'bridge.json'), JSON.stringify({
      bridge: 'ppt-workbench', url, port, pid: process.pid, updated: new Date().toISOString(),
    }, null, 2))
  } catch { /* 发现文件写失败不影响服务 */ }
}

function removeDiscovery(hostDir) {
  const file = path.join(hostDir, 'bridge.json')
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.pid === process.pid) fs.rmSync(file, { force: true })
  } catch { /* 不存在或不是本进程写的 */ }
}

/* ---- 独立运行入口（无 dsh 也可手动拉起，供调试/演示）---- */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
  }
  /* 独立服务形态也要接上 runtime 的 workspace：broker 拉起时继承了
   * DSH_RUNTIME_FILE / DSH_STORE_*，relay 据此使用当前 runtime 的 store，
   * 而不是退化成全局 ~/.dsh-ppt-bridge 文件库。 */
  const runtime = loadRuntimeContext()
  const workId = runtime?.workId || 'main'
  const client = runtime ? createRuntimeStoreClient(runtime, { workId }) : null
  const backend = client
    ? new WorkspaceBackend({
        client,
        workId,
        journalPath: runtime.paths?.logs ? path.join(runtime.paths.logs, 'ppt-journal.jsonl') : null,
      })
    : null
  const relay = await startRelay({
    port: Number(arg('--port', DEFAULT_PORT)) || DEFAULT_PORT,
    hostDir: arg('--dir', undefined) || runtime?.paths?.contentState || undefined,
    backend,
  })
  console.log('[ppt-workbench] 桥:', relay.url)
  console.log('[ppt-workbench] 编辑器:', relay.editorUrl, '(浏览器打开即用)')
  console.log('[ppt-workbench] MCP 端点:', relay.url.replace(BASE_PATH, '/mcp'))
}