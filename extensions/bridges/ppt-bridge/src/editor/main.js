/**
 * 独立编辑器入口：只做启动/UI 接线。
 * 运行时装载在 runtime.js，租约/轮询/镜像在 session.js。
 */
import { applyOp } from '../core/ops.js'
import { shrinkImage } from '../core/ops/browser.js'
import { createEditorSession } from './session.js'
import { createRuntime } from './runtime.js'
import { createTransport } from './transport.js'
import { renderSheet } from './screenshot.js'
import { createUi } from './ui.js'

const API_BASE = '/api/desktop/works/ppt-bridge'
const OPS_CTX = { apiBase: API_BASE, media: { prepareImage: shrinkImage } }
const $ = (sel) => document.querySelector(sel)

const transport = createTransport(API_BASE)
const ui = createUi()
const runtime = createRuntime()
const session = createEditorSession({
  api: transport.api,
  applyOp,
  opsContext: OPS_CTX,
  ui,
  renderSheet,
  clientId: 'wb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
})

const Studio = {
  async bootEditor() {
    const box = $('[data-editor]')
    try {
      await runtime.ensureRuntime()
      /* 先挂载/镜像，再 claim：owner 出现时页面已经能处理 ui 队列。
       * 反过来的顺序会让“新开页面 + 立刻 push import op”存在竞态：
       * restore() 把 lastUiSeq 记成已包含该 op，导致 op 永远不被执行。 */
      await window.PptApp.mount(box)
      runtime.wrapAssetExport()
      await session.restore()
      await session.ensureLinked()
      await session.activate()
      const veil = $('[data-veil]')
      if (veil) { veil.style.opacity = '0'; setTimeout(() => veil.remove(), 260) }
      session.claimLoop()
    } catch (e) {
      const note = $('[data-editor-note]')
      if (note) note.innerHTML = '编辑器装载失败：' + esc(String((e && e.message) || e)) +
        '<br><button data-act="retry" style="margin-top:8px">重试</button>'
    }
  },

  note: session.note,
  badge: session.badge,
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/* ---- 接线 ---- */
window.addEventListener('pagehide', session.release)
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]')
  if (!t) return
  const P = window.PptApp
  const need = () => {
    if (!P || !P.isMounted()) { session.note('编辑器未就绪'); return null }
    return P
  }
  const act = t.dataset.act
  if (act === 'retry') { location.reload(); return }
  if (act === 'pptx') {
    const a = need()
    if (a) {
      fetch(API_BASE + '/save-pptx', { method: 'POST' })
        .then(async (response) => {
          const body = await response.json().catch(() => ({}))
          if (response.ok && body.ok) {
            session.note('已保存回 ' + body.path + (body.backup ? '（备份 ' + body.backup + '）' : ''))
          } else {
            session.note('保存失败：' + (body.error || ('HTTP ' + response.status)))
          }
        })
        .catch((error) => session.note('保存失败：' + String((error && error.message) || error)))
    }
  }
  if (act === 'json') { const a = need(); if (a) a.saveJSON() }
  if (act === 'present') { const a = need(); if (a) a.present(0) }
  if (act === 'exit-present') { const a = need(); if (a) a.exitPresent() }
  if (act === 'quick') {
    const q = $('[data-quick]')
    if (q && q.value.trim()) session.quick(q.value.trim())
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  const q = e.target.closest && e.target.closest('[data-quick]')
  if (q && q.value.trim()) { e.preventDefault(); session.quick(q.value.trim()) }
})

/* 调试句柄：诊断工作循环（生产可保留，不暴露敏感信息） */
window.__PPT_DEBUG = {
  get state() {
    const { shotCache, ...rest } = session.state
    return { ...rest, shotCache: shotCache ? '[cached]' : null, heartbeatWorker: !!session.state.heartbeatWorker }
  },
  Studio,
  session,
}

Studio.bootEditor()
