/** dsh-catalog：把 Workspace catalog 暴露成 ctx.catalog 服务。 */
import { WorkspaceManager } from '../../dsh-runtime-kit/src/workspace/manager.mjs'
import { runtimeContextFromConfig } from '../../dsh-plugin-kit/src/runtime/context.mjs'

export const name = 'workspace-catalog'

export function apply(ctx, config = {}) {
  const runtime = runtimeContextFromConfig(config || {})
  const storeRoot = config.storeRoot || runtime?.store?.root || process.env.DSH_STORE_ROOT || ''
  if (!storeRoot) throw new Error('dsh-catalog: 缺少 storeRoot')
  const manager = new WorkspaceManager({ storeRoot })
  const service = {
    api: {
      name: 'catalog',
      version: '1.0.0',
      capabilities: ['list', 'refresh', 'show', 'remove'],
    },
    storeRoot,
    list: (runtimeId = '') => manager.listWorks({ runtimeId }),
    refresh: (runtimeId = '') => manager.refreshCatalog({ runtimeId }),
    show(runtimeId, workId) {
      const manifest = manager.readManifest(runtimeId, workId)
      if (!manifest) throw new Error(`work 不存在: ${runtimeId}/${workId}`)
      return manifest
    },
    removeWork(runtimeId, workId) {
      manager.removeWork(runtimeId, workId)
      return { runtimeId, workId, removed: true }
    },
  }
  const dispose = ctx.provide('catalog', service)
  console.log(`[catalog] store=${storeRoot}`)
  return () => { if (typeof dispose === 'function') dispose() }
}
