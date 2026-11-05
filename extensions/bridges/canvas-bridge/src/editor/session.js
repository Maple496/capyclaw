/**
 * Canvas 编辑器会话适配：通用租约/心跳/长轮询/镜像/截图在
 * @capyclaw/document-workbench/client，本文件只提供 CanvasApp adapter。
 *
 * authority: 'editor' —— Canvas 是编辑器权威：服务端只排队，
 * 页面把 {cmd,args} 逐条交给 CanvasApp（exec 透传 / 桥层合成命令拦截）。
 */
import { createEditorClient } from '@capyclaw/document-workbench/client'
import { renderSheet } from './screenshot.js'

const API_BASE = '/api/desktop/works/canvas-bridge'

/** 桥层合成命令：不透传 exec，在 adapter 里解释。 */
const BRIDGE_HANDLERS = {
  setValue(app, args) { app.load(args[0]) },
  clear(app) { app.load({ header: [], main: [], footer: [] }) },
  appendElementList(app, args) {
    const doc = app.dump().data
    doc.main = (doc.main || []).concat(args[0] || [])
    app.load(doc)
  },
}

export function createEditorSession({
  api,
  ui,
  clientId,
  getApp = () => window.CanvasApp,
  apiBase = API_BASE,
  editorRoot = () => document,
}) {
  const adapter = {
    isMounted() {
      const app = getApp()
      return !!(app && app.isMounted && app.isMounted())
    },
    meta() {
      return { app: 'canvas-editor', capabilities: ['block-write', 'exec-commands', 'table', 'image'] }
    },
    async load(doc) {
      await getApp().load(doc)
    },
    dump() {
      return getApp().dump().data
    },
    async apply(commands) {
      const app = getApp()
      let applied = 0
      for (const command of commands || []) {
        const { cmd, args = [] } = command
        const bridge = BRIDGE_HANDLERS[cmd]
        if (bridge) {
          bridge(app, args)
        } else {
          await app.exec(cmd, ...args)
        }
        applied += 1
      }
      return applied
    },
    async applyUi(commands) {
      return adapter.apply(commands)
    },
    onChange(handler) {
      const app = getApp()
      if (!app || typeof app.on !== 'function') return null
      const offs = []
      /* 通道一：门面 'change' —— load()/exec() 等 API 路径会触发 */
      app.on('change', handler)
      offs.push(() => {
        try { app.off?.('change', handler) } catch { /* ignore */ }
      })
      /* 通道二：内核 eventBus 'contentChange' —— 用户在页面里手工键入/编辑
       * 不经过门面命令拦截器，只发内核事件；不订阅则用户编辑永远不回推镜像。 */
      const hookKernel = () => {
        const bus = (typeof window !== 'undefined' && window.editor && window.editor.eventBus) || null
        if (!bus || typeof bus.on !== 'function') return false
        bus.on('contentChange', handler)
        offs.push(() => {
          try { bus.off?.('contentChange', handler) } catch { /* ignore */ }
        })
        return true
      }
      if (!hookKernel()) {
        /* mount 未完成时 window.editor 尚不存在：ready 后补挂 */
        const onReady = () => { hookKernel() }
        app.on('ready', onReady)
        offs.push(() => {
          try { app.off?.('ready', onReady) } catch { /* ignore */ }
        })
      }
      return () => {
        for (const off of offs) {
          try { off() } catch { /* ignore */ }
        }
      }
    },
    renderScreenshot() {
      return renderSheet(editorRoot)
    },
  }

  const client = createEditorClient({
    api,
    apiBase,
    clientId,
    adapter,
    authority: 'editor',
    documentKey: 'doc',
    documentPath: '/doc',
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    heartbeatWorkerUrl: './heartbeat-worker.js',
    singletonKey: 'canvas-workbench-singleton',
    onStatus: ui.badge,
    onNote: ui.note,
  })

  return client
}
