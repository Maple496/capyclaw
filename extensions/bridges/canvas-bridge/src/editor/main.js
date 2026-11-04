/**
 * Canvas 编辑器入口：装载内核 → 挂载 → 镜像恢复 → claim → 长轮询。
 * 内核（CanvasApp）来自同目录 canvas-full-app.js（<script> 先行加载）。
 */
import { createEditorSession } from './session.js'
import { createTransport } from './transport.js'
import { createUi } from './ui.js'

const API_BASE = '/api/desktop/works/canvas-bridge'
const $ = (sel) => document.querySelector(sel)

const transport = createTransport(API_BASE)
const ui = createUi()
const session = createEditorSession({
  api: transport.api,
  ui,
  clientId: 'cw_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
})

const Studio = {
  async bootEditor() {
    const box = $('[data-editor]')
    window.__BOOT = { steps: [], at: Date.now() }
    const trace = (step) => {
      window.__BOOT.steps.push(step)
      try { console.info('[canvas-wb] ' + step) } catch { /* ignore */ }
    }
    try {
      if (typeof window.CanvasApp === 'undefined') throw new Error('canvas-full-app.js 未加载')
      trace('mount:start')
      /* 内核约定：window.onload 是引导函数（在注入的宿主 HTML 里查询
       * .editor 并 new 实例 → window.editor）。mount 内部会调用它，所以
       * 只需保证它是函数；切勿提前手动调用——宿主 HTML 由 mount 注入。 */
      if (typeof window.onload !== 'function') window.onload = function () {}
      await window.CanvasApp.mount(box, { width: 794, height: 1123, mode: 'edit', pageMode: 'paging' })
      trace('mount:done')
      /* 先镜像再 claim：owner 出现时页面已能处理指令队列 */
      await session.restore()
      trace('restore:done')
      await session.ensureLinked()
      trace('link:done')
      await session.activate()
      trace('activate:done')
      const veil = $('[data-veil]')
      if (veil) { veil.style.opacity = '0'; setTimeout(() => veil.remove(), 260) }
      trace('claimLoop:start')
      session.claimLoop()
      trace('boot:done')
    } catch (e) {
      trace('error:' + String((e && e.message) || e))
      const note = $('[data-editor-note]')
      if (note) note.innerHTML = '编辑器装载失败：' + esc(String((e && e.message) || e))
        + '<br><button data-act="retry" style="margin-top:8px">重试</button>'
    }
  },
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/* ---- 接线 ---- */
window.addEventListener('pagehide', session.release)
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]')
  if (!t) return
  const act = t.dataset.act
  const app = window.CanvasApp
  if (act === 'retry') { location.reload(); return }
  if (!app || !app.isMounted || !app.isMounted()) { session.note('编辑器未就绪'); return }
  if (act === 'print') app.print()
  if (act === 'undo') app.undo()
  if (act === 'redo') app.redo()
  if (act === 'continuous' || act === 'paging') app.setPageMode(act)
})

/* 调试句柄：诊断工作循环（不暴露敏感信息） */
window.__CANVAS_DEBUG = { session, Studio }

Studio.bootEditor()
