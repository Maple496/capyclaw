/**
 * PPT 编辑器会话适配：通用租约/心跳/长轮询/镜像/截图在
 * @capyclaw/document-workbench/client，本文件只提供 PPTist adapter 与快捷命令。
 */
import { createEditorClient } from '@capyclaw/document-workbench/client'
import { parseQuick } from '../core/quick.js'

const API_BASE = '/api/desktop/works/ppt-bridge'

export function createEditorSession({
  api,
  applyOp,
  opsContext,
  ui,
  renderSheet,
  clientId,
  getPptApp = () => window.PptApp,
  apiBase = API_BASE,
}) {
  const adapter = {
    isMounted() {
      const P = getPptApp()
      return !!(P && P.isMounted && P.isMounted())
    },
    meta() {
      return {
        app: 'pptist-editor',
        capabilities: ['import-pptx', 'save-pptx'],
      }
    },
    async load(deck) {
      await getPptApp().load(deck)
    },
    dump() {
      return getPptApp().dump()
    },
    async apply(commands) {
      const P = getPptApp()
      for (const command of commands || []) await applyOp(P, command, opsContext)
      return (commands || []).length
    },
    async applyUi(commands) {
      const P = getPptApp()
      for (const command of commands || []) await applyOp(P, command, opsContext)
      return (commands || []).length
    },
    onChange(handler) {
      const P = getPptApp()
      if (!P || typeof P.on !== 'function') return null
      P.on('change', handler)
      return () => {
        try { P.off?.('change', handler) } catch { /* ignore */ }
      }
    },
    renderScreenshot() {
      return renderSheet(getPptApp())
    },
  }

  const client = createEditorClient({
    api,
    apiBase,
    clientId,
    adapter,
    authority: 'server',
    documentKey: 'deck',
    documentPath: '/deck',
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    heartbeatWorkerUrl: './heartbeat-worker.js',
    singletonKey: 'ppt-workbench-singleton',
    onStatus: ui.badge,
    onNote: ui.note,
  })

  async function quick(text) {
    const cmds = parseQuick(text)
    if (!cmds) {
      client.note('快捷栏只认：背景<颜色> / 第N页标题改成X / 加一页 X —— 其它请在 dsh 会话里说')
      return
    }
    try {
      await client.applyLocal(cmds)
      client.note('已执行（本地直改）')
    } catch (error) {
      client.note('快捷执行失败：' + String((error && error.message) || error))
    }
  }

  return { ...client, quick }
}
