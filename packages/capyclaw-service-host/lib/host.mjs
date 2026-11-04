/**
 * dsh-service-host 宿主插件：向同进程插件提供 ctx.serviceHost。
 *
 * 功能插件：
 *   export const inject = ['serviceHost']
 *   const app = ctx.serviceHost.createApp({ id: 'my-plugin', ... })
 *   app.use(myRoutes)
 *   await app.listen({ port, hostDir })
 */
import { createServiceHost } from '../src/index.mjs'

export const name = 'service-host'

export function apply(ctx, config = {}) {
  const service = createServiceHost(config)
  const dispose = ctx.provide('serviceHost', service)
  console.log('[service-host] ready')
  return () => { if (typeof dispose === 'function') dispose() }
}
