/** dsh-asset-service 插件：向同进程插件提供 ctx.assets。 */
import { createAssetHost } from '../src/index.mjs'

export const name = 'asset-service'

export function apply(ctx, config = {}) {
  const service = createAssetHost(config)
  const dispose = ctx.provide('assets', service)
  console.log('[asset-service] ready')
  return () => { if (typeof dispose === 'function') dispose() }
}
