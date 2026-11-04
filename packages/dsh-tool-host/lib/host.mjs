/**
 * dsh-tool-host 插件：向同进程插件提供 ctx.toolHost。
 */
import { createToolHost } from '../src/index.mjs'

export const name = 'tool-host'

export function apply(ctx, config = {}) {
  const service = createToolHost(config)
  const dispose = ctx.provide('toolHost', service)
  console.log('[tool-host] ready')
  return () => { if (typeof dispose === 'function') dispose() }
}
