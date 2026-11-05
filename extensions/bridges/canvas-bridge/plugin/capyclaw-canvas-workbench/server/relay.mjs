/**
 * Canvas 桥 relay 组合根：
 *   1) 桥端点（/api/desktop/works/canvas-bridge…）→ routes/bridge.mjs（编辑器权威）
 *   2) MCP Streamable HTTP（/mcp）→ kit createMcpHandler
 *   3) 编辑器静态页（/、/app.js、/canvas-full-app.js）→ routes/editor.mjs
 *   4) 导出（/api/export）→ routes/export.mjs
 *
 * 通用宿主（端口/锁/复用/健康/指标/静态/关闭）由 dsh-service-host 提供；
 * 本文件只保留 Canvas 专属装配。
 *
 * 也可脱离 dsh 独立运行：node server/relay.mjs [--port 39313] [--dir <hostDir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeStore } from './store.mjs'
import { createMcpHandler } from './mcp/handler.mjs'
import { serverInstructions } from './mcp/instructions.mjs'
import { CONTRACT_VERSION, PACKAGE_VERSION } from './contract.mjs'
import { BASE_PATH, DEFAULT_PORT } from './constants.mjs'
import { createAssetRoutes } from './routes/assets.mjs'
import { createFileAssetStore } from './shared/asset-service.mjs'
import { createEditorRoutes } from './routes/editor.mjs'
import { createMcpRoutes } from './routes/mcp.mjs'
import { createExportRoutes } from './routes/export.mjs'
import { createBridgeRoutes } from './routes/bridge.mjs'
import { createViewRoutes } from './routes/view.mjs'
import { createServiceApp } from './shared/service-host.mjs'
import { inspectContractSnapshots, describeMismatch } from './contract-snapshots.mjs'
import { getTuning } from './tuning.mjs'
import { createRuntimeStoreClient, loadRuntimeContext } from './infra/runtime/context.mjs'
import { WorkspaceBackend } from './infra/workspace/manager.mjs'
import { wordCountOf, memoByDoc } from '../core/doc.js'

export { DEFAULT_PORT, BASE_PATH }

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function startRelay({
  port = DEFAULT_PORT,
  hostDir = process.env.CANVAS_BRIDGE_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh-canvas-bridge'),
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
    console.error('[canvas-workbench] 契约快照不一致，工具调用将被拒绝:', describeMismatch(contractSnapshots))
  }
  const store = backend ? new BridgeStore({ backend }) : new BridgeStore(path.join(hostDir, 'state.json'))
  /* 独立运行（无 dsh）也要有对象仓库：图片落 hostDir/assets。 */
  if (!assetStore && !assetService) {
    try {
      assetStore = createFileAssetStore({ dir: path.join(hostDir, 'assets') })
    } catch { /* 对象仓库不可用不影响纯文本功能 */ }
  }

  const createApp = serviceHost?.createApp ? (options) => serviceHost.createApp(options) : createServiceApp
  /* health/metrics 可能被宿主周期抓取：words 按镜像引用 memo。 */
  const wordsOf = memoByDoc(wordCountOf)
  const app = createApp({
    id: 'canvas-workbench',
    title: 'Canvas Workbench',
    version: PACKAGE_VERSION,
    contractVersion: CONTRACT_VERSION,
    health: () => {
      const doc = store.get()
      const owner = doc.owner && doc.owner.id && (Date.now() / 1000 - (doc.owner.ts || 0) <= 10)
      return {
        bridge: 'canvas-workbench',
        editor: `http://127.0.0.1:${app.port}/`,
        editorConnected: !!owner,
        hasDoc: !!(doc.doc && Array.isArray(doc.doc.main) && doc.doc.main.length),
        words: wordsOf(doc.doc),
        seq: doc.seq | 0,
        appliedSeq: doc.applied_seq | 0,
        stateSeq: doc.state_seq | 0,
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
      const owner = doc.owner && doc.owner.id && (Date.now() / 1000 - (doc.owner.ts || 0) <= 10)
      return [
        ['canvas_workbench_words', wordsOf(doc.doc)],
        ['canvas_workbench_seq', doc.seq | 0],
        ['canvas_workbench_applied_seq', doc.applied_seq | 0],
        ['canvas_workbench_state_seq', doc.state_seq | 0],
        ['canvas_workbench_editor_connected', owner ? 1 : 0],
        ['canvas_workbench_shot_req', doc.shot_req | 0],
        ['canvas_workbench_memory_rss_bytes', process.memoryUsage().rss],
      ]
    },
  })

  let mcpHandler = null
  for (const route of createMcpRoutes({ getMcpHandler: () => mcpHandler })) app.use(route)
  if (assetService?.mount) assetService.mount(app, { store: assetStore, basePath: BASE_PATH })
  else if (assetStore) app.use(createAssetRoutes({ assetStore, basePath: BASE_PATH }))
  for (const route of createEditorRoutes({ editorDir, editorHost })) app.use(route)
  for (const route of createExportRoutes({ exportsDir: path.join(hostDir, 'exports'), basePath: BASE_PATH })) app.use(route)
  /* view 路由先于 bridge：轻量投影走自己的端点，不被桥主端点吞掉。 */
  for (const route of createViewRoutes({ store, basePath: BASE_PATH })) app.use(route)
  for (const route of createBridgeRoutes({ store })) app.use(route)

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
    /* bridge-client 在 import 时读 CANVAS_BRIDGE_URL，必须先设 env 再 import tools。 */
    process.env.CANVAS_BRIDGE_URL = `${info.url}${BASE_PATH}`

    let registry = null
    try {
      const tools = await import('./tools.mjs')
      /* 进程内直连：MCP 工具与 store 同进程时，镜像读/回执等待不再走回环 HTTP。 */
      tools.setLocalSession?.(store)
      registry = tools.createRegistry(tools.CAPABILITIES, { enabled: capabilities, toolHost })
    } catch (e) {
      console.error('[canvas-workbench] 工具未装载（构建产物缺失，先跑 scripts/build-plugin.mjs）:', e.message)
    }
    const TOOLS = registry?.TOOLS || []
    const TOOL_IMPL = registry?.TOOL_IMPL || {}
    const CAPABILITIES = registry?.CAPABILITIES || []
    mcpHandler = createMcpHandler({
      tools: TOOLS,
      callTool: (name, args) => {
        if (!contractSnapshots.ok && name !== 'canvas_capabilities') {
          throw new Error(
            `契约快照与运行时 major 不一致，已拒绝 ${name}：${describeMismatch(contractSnapshots)}。` +
            '请重装/升级 canvas 套件后重试。',
          )
        }
        const impl = TOOL_IMPL[name]
        if (!impl) throw new Error('未知工具: ' + name)
        return impl(args)
      },
      serverInfo: { name: 'canvas-workbench', version: PACKAGE_VERSION },
      instructions: serverInstructions(`http://127.0.0.1:${info.port}/`, { tools: TOOLS, capabilities: CAPABILITIES }),
      maxBodyBytes: Number(tuning.bodyLimitBytes) || 12 * 1024 * 1024,
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
      bridge: 'canvas-workbench', url, port, pid: process.pid, updated: new Date().toISOString(),
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
/* 主模块判定用 realpath：pnpm/junction 等符号链接安装态下 argv[1] 是链接路径，
 * import.meta.url 是真实路径，字符串直比会漏判（静默不启动）。 */
function isMainEntry() {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  }
}
if (isMainEntry()) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
  }
  /* 独立服务形态也要接上 runtime 的 workspace（有 runtime 上下文时）。 */
  const runtime = loadRuntimeContext()
  const workId = runtime?.workId || 'main'
  const client = runtime ? createRuntimeStoreClient(runtime, { workId }) : null
  const backend = client
    ? new WorkspaceBackend({
        client,
        workId,
        journalPath: runtime.paths?.logs ? path.join(runtime.paths.logs, 'canvas-journal.jsonl') : null,
      })
    : null
  const relay = await startRelay({
    port: Number(arg('--port', DEFAULT_PORT)) || DEFAULT_PORT,
    hostDir: arg('--dir', undefined) || runtime?.paths?.contentState || undefined,
    backend,
  })
  console.log('[canvas-workbench] 桥:', relay.url)
  console.log('[canvas-workbench] 编辑器:', relay.editorUrl, '(浏览器打开即用)')
  console.log('[canvas-workbench] MCP 端点:', relay.url.replace(BASE_PATH, '/mcp'))
}
