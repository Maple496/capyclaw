/**
 * canvas-workbench 宿主插件（cordis 入口，loader 经包名加载本模块）。
 *
 * 服务解耦标准：relay 是独立端口服务（server/relay.mjs 即 standalone 入口），
 * 由 dsh-service-broker 按清单以独立进程拉起；本模块只在被 insert 时
 * 以同样装配拉起 relay 并返回 disposer。
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeContextFromConfig, createRuntimeStoreClient } from '../server/infra/runtime/context.mjs'
import { WorkspaceBackend } from '../server/infra/workspace/manager.mjs'
import { createWorkspaceAssetStore } from '../server/shared/asset-service.mjs'
import { assertServiceApi } from '../server/shared/kit/service/api.mjs'

export const name = 'canvas-workbench-host'

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
  const workspaceService = safeGet(ctx, 'workspace')
  const storeClient = workspaceService?.getWork
    ? workspaceService.getWork(workId)
    : (runtime ? createRuntimeStoreClient(runtime, { workId }) : null)
  const journalPath = runtime ? path.join(runtime.paths.logs, 'canvas-journal.jsonl') : null
  const backend = storeClient ? new WorkspaceBackend({ client: storeClient, workId, journalPath }) : null
  const hostDir = (config && config.hostDir)
    || runtime?.paths?.contentState
    || process.env.CANVAS_BRIDGE_HOME
    || path.join(os.homedir(), '.dsh-canvas-bridge')
  /* 公共插件 API 契约：存在则校验 major，避免静默不兼容。 */
  const serviceHost = requireApi(safeGet(ctx, 'serviceHost'), 'serviceHost')
  const toolHost = requireApi(safeGet(ctx, 'toolHost'), 'toolHost')
  const editorHost = requireApi(safeGet(ctx, 'editorHost'), 'editorHost')
  /* 图片等二进制资源只进对象仓库。 */
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
    ? `[canvas-workbench] 复用已运行的桥: ${relay.url}`
    : `[canvas-workbench] 桥已就绪: ${relay.url}`
  console.log(line)
  console.log(`[canvas-workbench] 编辑器: ${relay.editorUrl} （浏览器打开即用）`)
  if (runtime) console.log(`[canvas-workbench] runtime=${runtime.runtimeId} work=${workId} namespace=${runtime.store?.namespace || ''}`)
  return async () => {
    await relay.stop()
    console.log('[canvas-workbench] 桥已停止')
  }
}
