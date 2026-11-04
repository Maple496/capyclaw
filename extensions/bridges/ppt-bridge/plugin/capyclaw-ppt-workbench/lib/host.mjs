/**
 * @capyclaw/ppt-workbench 宿主插件（cordis 入口，loader 经包名加载本模块）。
 *
 * 服务解耦标准：relay 是独立端口服务（server/relay.mjs 即 standalone 入口），
 * 由 dsh-service-broker 按清单以独立进程拉起；本模块只在被 insert 时
 * 以同样装配拉起 relay 并返回 disposer（兼容入口，生产路径走 broker）。
 */
/**
 * capyclaw-ppt-workbench 宿主插件（cordis 入口，loader 经包名加载本模块）。
 *
 * apply 里进程内拉起桥 relay（桥端点 + /mcp + 编辑器静态页），返回
 * disposer——插件停用时关闭 relay（官方 remote-access 等同款生命周期）。
 * 零 @deepseek-ai 依赖：只用 node 内置模块，最小化跨版本耦合。
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeContextFromConfig, createRuntimeStoreClient } from '../server/infra/runtime/context.mjs'
import { WorkspaceBackend } from '../server/infra/workspace/manager.mjs'
import { createWorkspaceAssetStore } from '../server/shared/asset-service.mjs'
import { assertServiceApi } from '../server/shared/kit/service/api.mjs'

export const name = 'ppt-workbench-host'

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
  const runtime = runtimeContextFromConfig(config || {})
  const workId = (config && config.workId) || runtime?.workId || 'main'
  /* 如果同进程挂载了 workspace-service，优先使用它提供的 scoped client；
   * 没有时保留 runtime context fallback，保证独立运行。 */
  const workspaceService = safeGet(ctx, 'workspace')
  const storeClient = workspaceService?.getWork
    ? workspaceService.getWork(workId)
    : (runtime ? createRuntimeStoreClient(runtime, { workId }) : null)
  const journalPath = runtime ? path.join(runtime.paths.logs, 'ppt-journal.jsonl') : null
  const backend = storeClient ? new WorkspaceBackend({ client: storeClient, workId, journalPath }) : null
  const hostDir = (config && config.hostDir)
    || runtime?.paths?.contentState
    || process.env.PPT_BRIDGE_HOME
    || path.join(os.homedir(), '.dsh-ppt-bridge')
  /* 公共插件 API 契约：存在则校验 major，避免静默不兼容。 */
  const serviceHost = requireApi(safeGet(ctx, 'serviceHost'), 'serviceHost')
  const toolHost = requireApi(safeGet(ctx, 'toolHost'), 'toolHost')
  const editorHost = requireApi(safeGet(ctx, 'editorHost'), 'editorHost')
  /* 图片等二进制资源只进对象仓库；deck 里只保存 /assets/<sha256> 引用。 */
  const assetService = requireApi(safeGet(ctx, 'assets'), 'assets')
  const assetStore = storeClient
    ? (assetService?.createStore
        ? assetService.createStore({ storeClient, workId })
        : createWorkspaceAssetStore({ storeClient, workId }))
    : (assetService?.createFileStore
        ? assetService.createFileStore({ dir: path.join(hostDir, 'assets') })
        : null)
  const port = (config && Number(config.port))
    || runtime?.ports?.content
    || DEFAULT_PORT
  const relay = await startRelay({
    packageDir,
    port,
    hostDir,
    strictPort: config?.strictPort != null ? !!config.strictPort : !!runtime,
    allowReuse: config?.allowReuse != null ? !!config.allowReuse : !runtime,
    lockFile: (config && config.lockFile) || path.join(hostDir, '.relay-instance.lock'),
    backend,
    assetStore,
    assetService,
    workId,
    capabilities: config?.capabilities || null,
    serviceHost,
    toolHost,
    editorHost,
  })
  const line = relay.reused
    ? `[ppt-workbench] 复用已运行的桥: ${relay.url}`
    : `[ppt-workbench] 桥已就绪: ${relay.url}`
  console.log(line)
  console.log(`[ppt-workbench] 编辑器: ${relay.editorUrl} （浏览器打开即用）`)
  if (runtime) console.log(`[ppt-workbench] runtime=${runtime.runtimeId} work=${workId} namespace=${runtime.store?.namespace || ''}`)
  if (relay.reused) console.log('[ppt-workbench] 注意：实际端口可能不是配置端口，/mcp 以当前 runtime 的 profile 注入为准')
  return async () => {
    await relay.stop()
    console.log('[ppt-workbench] 桥已停止')
  }
}
