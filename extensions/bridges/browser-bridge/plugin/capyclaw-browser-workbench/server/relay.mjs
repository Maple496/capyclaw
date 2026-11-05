/**
 * Browser 桥 relay 组合根：
 *   1) MCP Streamable HTTP（/mcp）→ tool-host createMcpHandler
 *   2) 工作台静态页（/、/app.js、/style.css）与内置演示页（/demo/form.html）
 *   3) 工作台 API（/api/status|screenshot|snapshot|navigate|tabs|control）
 *
 * 通用宿主（端口/锁/复用/健康/指标/静态/关闭）由 dsh-service-host 提供；
 * 浏览器引擎（Playwright，懒启动、登录态持久化）由 src/mcp/engine.mjs 提供，
 * 生命周期归本进程：relay.stop() 会先关浏览器再关 HTTP。
 *
 * 也可脱离 dsh 独立运行：node server/relay.mjs [--port 39315] [--dir <hostDir>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserEngine, resolveEngineConfig } from './engine.mjs'
import { createMcpHandler } from './mcp/handler.mjs'
import { serverInstructions } from './mcp/instructions.mjs'
import { CONTRACT_VERSION, PACKAGE_VERSION } from './contract.mjs'
import { DEFAULT_PORT } from './constants.mjs'
import { createMcpRoutes } from './routes/mcp.mjs'
import { createWorkbenchRoutes } from './routes/workbench.mjs'
import { createApiRoutes } from './routes/api.mjs'
import { createAssetRoutes, createFileAssetStore } from './shared/asset-service.mjs'
import { createServiceApp } from './shared/service-host.mjs'
import { inspectContractSnapshots, describeMismatch } from './contract-snapshots.mjs'
import { assertServiceApi } from './shared/kit/service/api.mjs'

export { DEFAULT_PORT }

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function startRelay({
  port = DEFAULT_PORT,
  hostDir = process.env.BROWSER_BRIDGE_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh-browser-bridge'),
  packageDir = PKG_ROOT,
  lockFile,
  strictPort = false,
  allowReuse = true,
  assetStore = null,
  assetService = null,
  capabilities = null,
  engineConfig = null,
  engine = null,
  serviceHost = null,
  toolHost = null,
} = {}) {
  const contractSnapshots = inspectContractSnapshots(packageDir, CONTRACT_VERSION)
  if (!contractSnapshots.ok) {
    console.error('[browser-workbench] 契约快照不一致，工具调用将被拒绝:', describeMismatch(contractSnapshots))
  }
  const eng = engine || await createBrowserEngine({ hostDir, config: resolveEngineConfig(process.env, engineConfig) })
  /* 独立运行（无 dsh）也要有对象仓库：截图等二进制落 hostDir/assets。 */
  if (!assetStore && !assetService) {
    try {
      assetStore = createFileAssetStore({ dir: path.join(hostDir, 'assets') })
    } catch { /* 对象仓库不可用不影响核心浏览功能 */ }
  }

  const createApp = serviceHost?.createApp ? (options) => serviceHost.createApp(options) : createServiceApp
  const app = createApp({
    id: 'browser-workbench',
    title: 'Browser Workbench',
    version: PACKAGE_VERSION,
    contractVersion: CONTRACT_VERSION,
    health: () => {
      const status = eng.status()
      return {
        bridge: 'browser-workbench',
        workbench: `http://127.0.0.1:${app.port}/`,
        engine: {
          running: status.running,
          launching: status.launching,
          headless: status.headless,
          channel: status.channel,
          tabs: status.tabs.length,
        },
        capabilities: {
          engine: 'playwright',
          headless: status.headless,
          evaluate: status.evaluateEnabled,
          persistentProfile: true,
        },
        actions: status.counters.actions,
        errors: status.counters.errors,
        contractsOk: contractSnapshots.ok,
        contractsChecked: contractSnapshots.checked,
        injected: {
          serviceHost: !!serviceHost,
          toolHost: !!toolHost,
          assets: !!assetStore,
        },
      }
    },
    metrics: () => {
      const status = eng.status()
      return [
        ['browser_workbench_engine_running', status.running ? 1 : 0],
        ['browser_workbench_tabs', status.tabs.length],
        ['browser_workbench_actions_total', status.counters.actions],
        ['browser_workbench_errors_total', status.counters.errors],
        ['browser_workbench_snapshots_total', status.counters.snapshots],
        ['browser_workbench_memory_rss_bytes', process.memoryUsage().rss],
      ]
    },
  })

  let mcpHandler = null
  for (const route of createMcpRoutes({ getMcpHandler: () => mcpHandler })) app.use(route)
  if (assetService?.mount) assetService.mount(app, { store: assetStore })
  else if (assetStore) app.use(createAssetRoutes({ assetStore }))
  for (const route of createWorkbenchRoutes({ packageDir })) app.use(route)
  for (const route of createApiRoutes({ engine: eng })) app.use(route)

  const info = await app.listen({
    port,
    hostDir,
    lockFile: lockFile || path.join(hostDir, '.relay-instance.lock'),
    strictPort,
    allowReuse,
    discoveryFile: '',
  })

  if (info.reused) {
    return { url: `${info.url}/`, workbenchUrl: `${info.url}/`, port: info.port, reused: true, stop: async () => {} }
  }

  try {
    let registry = null
    try {
      const tools = await import('./tools.mjs')
      tools.setEngine(eng)
      registry = tools.createRegistry(tools.CAPABILITIES, {
        enabled: capabilities,
        toolHost,
        serverBaseUrl: `http://127.0.0.1:${info.port}/`,
      })
    } catch (e) {
      console.error('[browser-workbench] 工具未装载（构建产物缺失，先跑 scripts/build-plugin.mjs）:', e.message)
    }
    const TOOLS = registry?.TOOLS || []
    const TOOL_IMPL = registry?.TOOL_IMPL || {}
    const CAPABILITIES = registry?.CAPABILITIES || []
    mcpHandler = createMcpHandler({
      tools: TOOLS,
      callTool: (name, args) => {
        if (!contractSnapshots.ok && name !== 'browser_capabilities') {
          throw new Error(
            `契约快照与运行时 major 不一致，已拒绝 ${name}：${describeMismatch(contractSnapshots)}。` +
            '请重装/升级 browser 套件后重试。',
          )
        }
        const impl = TOOL_IMPL[name]
        if (!impl) throw new Error('未知工具: ' + name)
        return impl(args)
      },
      serverInfo: { name: 'browser-workbench', version: PACKAGE_VERSION },
      instructions: serverInstructions(`http://127.0.0.1:${info.port}/`, { tools: TOOLS, capabilities: CAPABILITIES }),
    })

    writeDiscovery(hostDir, `${info.url}/`, info.port)
    return {
      url: `${info.url}/`,
      workbenchUrl: `${info.url}/`,
      mcpUrl: `${info.url}/mcp`,
      port: info.port,
      engine: eng,
      reused: false,
      stop: async () => {
        try { await eng.close() } catch { /* 浏览器已退出时忽略 */ }
        removeDiscovery(hostDir)
        await info.stop()
      },
    }
  } catch (error) {
    /* 启动失败不能留下僵尸端口/锁/发现文件；浏览器也要一并回收。 */
    try { await eng.close() } catch { /* 忽略 */ }
    try { removeDiscovery(hostDir) } catch { /* 忽略 */ }
    try { await info.stop() } catch { /* 忽略 */ }
    throw error
  }
}

function writeDiscovery(hostDir, url, port) {
  try {
    fs.mkdirSync(hostDir, { recursive: true })
    fs.writeFileSync(path.join(hostDir, 'bridge.json'), JSON.stringify({
      bridge: 'browser-workbench', url, port, pid: process.pid, updated: new Date().toISOString(),
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
  const relay = await startRelay({
    port: Number(arg('--port', DEFAULT_PORT)) || DEFAULT_PORT,
    hostDir: arg('--dir', undefined) || undefined,
  })
  console.log('[browser-workbench] 工作台:', relay.workbenchUrl, '(浏览器打开即用)')
  console.log('[browser-workbench] MCP 端点:', relay.mcpUrl)
  console.log('[browser-workbench] 引擎: Playwright', relay.engine.config.headless ? '（无头）' : '（有头可见，首次导航时启动）')
}
