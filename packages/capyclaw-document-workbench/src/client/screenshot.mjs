/** 通用截图渲染：把编辑器页面渲染成一张 contact sheet。 browser-safe only. */

export async function composeContactSheet({
  renderSlides,
  slideCount = 0,
  columns = 2,
  width,
  aspectRatio = 9 / 16,
  gap = 8,
  background = '#222',
  quality = 0.7,
  format = 'jpeg',
  renderQuality,
  timeoutMs,
  loadImage = defaultLoadImage,
  createCanvas = defaultCreateCanvas,
} = {}) {
  if (typeof renderSlides !== 'function') throw new Error('composeContactSheet 需要 renderSlides')
  const total = Number(slideCount) || 0
  const large = total > 8
  const tileWidth = width ?? (large ? 320 : 480)
  const encodeQuality = renderQuality ?? (large ? 0.4 : 0.6)
  const timeout = timeoutMs ?? Math.max(30000, total * 800)
  const urls = await Promise.race([
    renderSlides({ width: tileWidth, format, quality: encodeQuality }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('renderSlides 超时')), timeout)),
  ])
  if (!urls || urls.length === 0) throw new Error('renderSlides 返回空数组')
  const images = await Promise.all(urls.map((url, index) => loadImage(url, index)))
  const live = images.filter(Boolean)
  if (live.length === 0) throw new Error('所有页面图片加载失败')
  return composeTiles(live, {
    cols: columns,
    width: tileWidth,
    height: Math.round(tileWidth * aspectRatio),
    gap,
    background,
    quality,
    createCanvas,
  })
}

export const loadImage = defaultLoadImage

export async function defaultLoadImage(url, index) {
  if (!url || typeof Image === 'undefined') return null
  try {
    return await new Promise((resolve) => {
      const image = new Image()
      const timer = setTimeout(() => {
        image.src = ''
        resolve(null)
      }, 3000)
      image.onload = () => {
        clearTimeout(timer)
        resolve(image)
      }
      image.onerror = () => {
        clearTimeout(timer)
        console.warn(`[screenshot] 页面 ${index + 1} 图片加载失败`)
        resolve(null)
      }
      image.src = url
    })
  } catch (error) {
    console.warn(`[screenshot] 页面 ${index + 1} 异常:`, error.message)
    return null
  }
}

export function composeTiles(images, {
  cols = 2,
  width,
  height,
  gap = 8,
  background = '#222',
  quality = 0.7,
  createCanvas = defaultCreateCanvas,
} = {}) {
  const rows = Math.max(1, Math.ceil(images.length / cols))
  const canvas = createCanvas()
  canvas.width = cols * width + (cols + 1) * gap
  canvas.height = rows * height + (rows + 1) * gap
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  images.forEach((image, index) => {
    const x = gap + (index % cols) * (width + gap)
    const y = gap + Math.floor(index / cols) * (height + gap)
    ctx.drawImage(image, x, y, width, height)
  })
  return canvas.toDataURL('image/jpeg', quality)
}

function defaultCreateCanvas() {
  if (typeof document === 'undefined') throw new Error('缺少 createCanvas')
  return document.createElement('canvas')
}
