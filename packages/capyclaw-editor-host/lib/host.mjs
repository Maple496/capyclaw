/** dsh-editor-host 插件：向同进程插件提供 ctx.editorHost。 */
import { createEditorHostService } from '../src/index.mjs'

export const name = 'editor-host'

export function apply(ctx, config = {}) {
  const service = createEditorHostService(config)
  const dispose = ctx.provide('editorHost', service)
  console.log('[editor-host] ready')
  return () => { if (typeof dispose === 'function') dispose() }
}
