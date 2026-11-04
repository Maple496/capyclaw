/** dsh-state-service 插件：向同进程插件提供 ctx.state。 */
import { createStateHost } from '../src/index.mjs'

export const name = 'state-service'

export function apply(ctx, config = {}) {
  const service = createStateHost(config)
  const dispose = ctx.provide('state', service)
  console.log('[state-service] ready')
  return () => { if (typeof dispose === 'function') dispose() }
}
