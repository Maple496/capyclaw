/** 静态编辑器路由统一来自 dsh-editor-host 公共插件。 */
import { createEditorHost as createSharedEditorHost } from '../shared/editor-host.mjs'
import { EDITOR_FILES } from '../constants.mjs'

export function createEditorRoutes({ editorDir, editorHost = null }) {
  const factory = editorHost?.createEditorHost || createSharedEditorHost
  const host = factory({ id: 'canvas-editor', dir: editorDir, files: EDITOR_FILES })
  return [host.staticRoutes]
}
