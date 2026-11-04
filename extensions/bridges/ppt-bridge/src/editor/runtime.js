/**
 * PPTist 运行时适配：装载 bundle、导出时把 /assets 引用还原为 data URL。
 * 只碰 window/document/Blob/FileReader，不关心桥协议与会话状态。
 */
const ASSET_RE = /^\/assets\/[a-f0-9]{64}$/i

async function assetToDataUrl(src) {
  if (typeof src !== 'string' || !ASSET_RE.test(src)) return src
  const res = await fetch(src, { cache: 'force-cache' })
  if (!res.ok) throw new Error('导出时读取图片对象失败: ' + src + ' HTTP ' + res.status)
  const buf = await res.arrayBuffer()
  const blob = new Blob([buf], { type: res.headers.get('content-type') || 'image/png' })
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('图片编码失败'))
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
    reader.readAsDataURL(blob)
  })
  return 'data:' + (blob.type || 'image/png') + ';base64,' + base64
}

/** 编辑态只存 /assets/<sha256>；导出前再把引用编码成 data URL。 */
export async function materializeDeckAssets(deck) {
  if (!deck || !Array.isArray(deck.slides)) return deck
  const copy = JSON.parse(JSON.stringify(deck))
  let changed = false
  const resolve = async (holder) => {
    if (!holder || typeof holder !== 'object' || !ASSET_RE.test(String(holder.src || ''))) return
    holder.src = await assetToDataUrl(holder.src)
    changed = true
  }
  for (const slide of copy.slides) {
    if (slide.background && slide.background.type === 'image') await resolve(slide.background.image || {})
    for (const element of slide.elements || []) {
      if (element && element.type === 'image') await resolve(element)
    }
  }
  return changed ? copy : deck
}

export function createRuntime({ getPptApp = () => window.PptApp } = {}) {
  async function ensureRuntime() {
    if (window.PptApp) return
    if (window.Ppt && window.Ppt.pending) { await window.Ppt.pending; return }
    const hadWork = 'Work' in window
    const host = hadWork ? window.Work : undefined
    Object.defineProperty(window, 'Work', { value: { register() { } }, configurable: true })
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = './ppt-full-app.js'
        s.onload = resolve
        s.onerror = () => reject(new Error('运行时资产加载失败（relay 的 editor/ 产物缺失？）'))
        document.head.appendChild(s)
      })
    } finally {
      if (hadWork) Object.defineProperty(window, 'Work', { value: host, configurable: true })
      else delete window.Work
    }
    if (!window.PptApp) throw new Error('window.PptApp 未就绪')
  }

  function wrapAssetExport() {
    const P = getPptApp()
    if (!P || typeof P.exportPPTX !== 'function' || P.__pptAssetExportWrapped) return
    const original = P.exportPPTX.bind(P)
    P.exportPPTX = async (...args) => {
      const before = P.dump()
      const materialized = await materializeDeckAssets(before)
      if (materialized === before) return original(...args)
      await P.load(materialized, { resetHistory: false })
      try {
        return await original(...args)
      } finally {
        await P.load(before, { resetHistory: false })
      }
    }
    P.__pptAssetExportWrapped = true
  }

  return { ensureRuntime, wrapAssetExport }
}
