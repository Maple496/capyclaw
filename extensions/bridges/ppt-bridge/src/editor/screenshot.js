/** 截图渲染：PPTist 只注入 renderSlides，contact sheet 合成由通用框架提供。 */
import { composeContactSheet } from 'dsh-document-workbench/screenshot'

export async function renderSheet(PptApp) {
  if (!PptApp || !PptApp.renderSlides) throw new Error('PptApp 未就绪')
  const total = typeof PptApp.getSlides === 'function' ? PptApp.getSlides().length : 0
  return composeContactSheet({
    renderSlides: (options) => PptApp.renderSlides(options),
    slideCount: total,
    columns: 2,
    gap: 8,
    aspectRatio: 9 / 16,
  })
}

export { composeTiles, loadImage } from 'dsh-document-workbench/screenshot'
