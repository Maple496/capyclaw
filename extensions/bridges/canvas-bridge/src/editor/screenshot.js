/**
 * 截图：把编辑器区域内的 <canvas> 逐页拼接成一张 JPEG dataURL。
 * canvas-editor 逐页一个 canvas 元素；空页/隐藏页跳过。
 * 上限：最多 12 页，总高超过 16000px 时按比例缩到 16000。
 */
const MAX_PAGES = 12
const MAX_HEIGHT = 16000

export function renderSheet(getRoot = () => document) {
  const root = getRoot()
  if (!root) return ''
  const canvases = [...root.querySelectorAll('canvas')].filter((c) => c.width > 0 && c.height > 0)
  if (!canvases.length) return ''
  const pages = canvases.slice(0, MAX_PAGES)
  const width = Math.max(...pages.map((c) => c.width))
  let height = pages.reduce((n, c) => n + c.height, 0)
  let scale = 1
  if (height > MAX_HEIGHT) { scale = MAX_HEIGHT / height; height = MAX_HEIGHT }
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.floor(width * scale))
  out.height = Math.max(1, Math.floor(height))
  const g = out.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, out.width, out.height)
  let y = 0
  for (const c of pages) {
    g.drawImage(c, 0, Math.floor(y), Math.floor(c.width * scale), Math.floor(c.height * scale))
    y += c.height * scale
  }
  return out.toDataURL('image/jpeg', 0.85)
}
