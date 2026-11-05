/**
 * @capyclaw/browser-workbench 宿主插件（cordis 入口，loader 经包名加载本模块）。
 *
 * 服务解耦标准：relay 是独立端口服务（server/relay.mjs 即 standalone 入口），
 * 由 dsh-service-broker 按套件 services.json 以独立进程拉起；本模块只在被
 * insert 时以同样装配拉起 relay 并返回 disposer（兼容入口，生产路径走 broker）。
 * 零 @deepseek-ai 依赖：只用 node 内置模块，最小化跨版本耦合。
 *
 * 与 ppt/canvas 的公共 host 模板不同，本文件为手写精简版：浏览器工作台没有
 * 文档 store/journal/workspace 依赖，装配面只有公共服务契约 + 引擎透传配置。
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertServiceApi } from '../server/shared/kit/service/api.mjs'

export const name = 'browser-workbench-host'

function safeGet(ctx, serviceName) {
  try { return ctx?.get ? ctx.get(serviceName) : null } catch { return null }
}

function requireApi(service, name) {
  if (service) assertServiceApi(service, { name, major: 1 })
  return service
}

export async function apply(ctx, config) {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { startRelay, DEFAULT_PORT } = await import('../server/relay.mjs')
  const hostDir = (config && config.hostDir)
    || process.env.BROWSER_BRIDGE_HOME
    || path.join(os.homedir(), '.dsh-browser-bridge')
  /* 公共插件 API 契约：存在则校验 major，避免静默不兼容。 */
  const serviceHost = requireApi(safeGet(ctx, 'serviceHost'), 'serviceHost')
  const toolHost = requireApi(safeGet(ctx, 'toolHost'), 'toolHost')
  const assetService = requireApi(safeGet(ctx, 'assets'), 'assets')
  let assetStore = null
  if (assetService?.createFileStore) {
    assetStore = assetService.createFileStore({ dir: path.join(hostDir, 'assets') })
  }
  /* cordis 配置透传引擎项（headless / allowEvaluate / channel / 超时…），
   * 环境变量（DSH_BROWSER_*）与默认值由 relay 内 resolveEngineConfig 兜底。 */
  const engineConfig = (config && config.engine) || null
  const port = (config && Number(config.port)) || DEFAULT_PORT
  const relay = await startRelay({
    packageDir,
    port,
    hostDir,
    strictPort: config?.strictPort != null ? !!config.strictPort : false,
    allowReuse: config?.allowReuse != null ? !!config.allowReuse : true,
    assetStore,
    assetService,
    engineConfig,
    serviceHost,
    toolHost,
  })
  const line = relay.reused
    ? '[browser-workbench] 复用已运行的桥: ' + relay.url
    : '[browser-workbench] 桥已就绪: ' + relay.url
  console.log(line)
  console.log(`[browser-workbench] 工作台: ${relay.workbenchUrl}（浏览器打开即用）`)
  if (relay.reused) console.log('[browser-workbench] 注意：实际端口可能不是配置端口，/mcp 以当前 runtime 的 profile 注入为准')
  return async () => {
    await relay.stop()
    console.log('[browser-workbench] 桥已停止')
  }
}
