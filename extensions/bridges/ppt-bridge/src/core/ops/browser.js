/**
 * 浏览器专用 op 适配器：大图压缩。
 *
 * 不进入 core/ops 的分发器；编辑器把 `shrinkImage` 作为
 * `ctx.media.prepareImage` 注入。Node 侧（relay/stdio）不 import 本文件。
 */
export async function shrinkImage(el) {
  if (typeof document === 'undefined') return el
  const src = String(el.src || '')
  if (!/^data:image\//i.test(src) || src.length < 250000) return el
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = reject
      im.src = src
    })
    const maxW = 1600
    const scale = Math.min(1, maxW / (img.width || maxW))
    if (scale >= 1 && src.length < 900000) return el
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round((img.width || maxW) * scale))
    cv.height = Math.max(1, Math.round((img.height || maxW) * scale))
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
    el.src = cv.toDataURL('image/jpeg', 0.85)
  } catch (e) { /* 压缩失败保留原图 */ }
  return el
}
