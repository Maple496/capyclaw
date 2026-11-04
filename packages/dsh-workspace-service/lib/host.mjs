/**
 * dsh-workspace-service：把 Workspace 中间层挂成 DSH 进程内服务。
 *
 * 功能插件不需要知道对象仓库、manifest、token、runtime 路径：
 *   export const inject = ['workspace']
 *   const work = ctx.workspace.getWork('main')
 *   work.putJson('main', 'state.json', data)
 *
 * 它只提供当前 runtime 的 scoped client，不暴露跨 runtime 的通用读写能力。
 */
import { runtimeContextFromConfig, createRuntimeStoreClient } from '../server/infra/runtime/context.mjs'
import { WorkspaceManager, WorkspaceClient, WorkspaceBackend } from '../server/infra/workspace/manager.mjs'

export const name = 'workspace-service'

export function apply(ctx, config = {}) {
  const runtime = runtimeContextFromConfig(config || {})
  if (!runtime) throw new Error('workspace-service: 缺少 runtime 上下文（DSH_RUNTIME_FILE / DSH_STORE_*）')

  const manager = new WorkspaceManager({ storeRoot: runtime.store.root })
  const defaultWorkId = config.workId || runtime.workId || 'main'
  const token = runtime.store.token
  const runtimeId = runtime.store.namespace || runtime.runtimeId

  const getWork = (workId = defaultWorkId) => new WorkspaceClient({
    manager,
    runtimeId,
    token,
    workId,
  })

  const service = {
    api: {
      name: 'workspace',
      version: '1.0.0',
      capabilities: ['work', 'backend', 'catalog'],
    },
    runtime,
    manager,
    runtimeId,
    workId: defaultWorkId,
    getWork,
    getBackend(workId = defaultWorkId, journalPath = null) {
      return new WorkspaceBackend({ client: getWork(workId), workId, journalPath })
    },
    read(workId, key) {
      return getWork(workId).get(workId || defaultWorkId, key)
    },
    write(workId, key, data, options = {}) {
      return getWork(workId).put(workId || defaultWorkId, key, data, options)
    },
    putJson(workId, key, value, options = {}) {
      return getWork(workId).putJson(workId || defaultWorkId, key, value, options)
    },
    getJson(workId, key, fallback = undefined) {
      return getWork(workId).getJson(workId || defaultWorkId, key, fallback)
    },
    checkpoint(workId, name, meta = {}) {
      return getWork(workId).putJson(workId || defaultWorkId, `checkpoints/${name}.json`, {
        name,
        meta,
        createdAt: new Date().toISOString(),
      })
    },
    listWorks() {
      return manager.listWorks({ runtimeId })
    },
    refreshCatalog() {
      return manager.refreshCatalog({ runtimeId })
    },
  }

  const dispose = ctx.provide('workspace', service)
  console.log(`[workspace-service] runtime=${runtime.runtimeId} namespace=${runtimeId} work=${defaultWorkId}`)
  return () => {
    if (typeof dispose === 'function') dispose()
  }
}
