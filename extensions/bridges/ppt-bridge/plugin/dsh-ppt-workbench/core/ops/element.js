/** 元素 op：加/改/删元素。图片预压缩由编辑器通过 ctx.media.prepareImage 注入。 */
import { makeElement, patchElement } from '../text.js'

function clone(P, i) {
  const slide = P.getSlides()[i]
  if (!slide) {
    const total = P.getSlides().length
    throw new Error(`页号越界：第 ${i} 页不存在（共 ${total} 页）`)
  }
  return JSON.parse(JSON.stringify(slide))
}

export const elementOps = {
  'add-element': {
    async run(P, c, ctx) {
      const i = Number(c.slide != null ? c.slide : 0)
      const s = clone(P, i)
      const el = makeElement(c.element || {})
      /* 完全在画布外的元素自动放回画布内（2026-10-22：曾有图片被放到
         x=1080 / 画布宽 1000，工具报成功但用户看不到） */
      if ((el.left != null && el.left >= 1000) || (el.top != null && el.top >= 563) ||
          (el.left != null && el.width != null && el.left + el.width <= 0)) {
        el.left = Math.max(0, Math.round((1000 - (el.width || 400)) / 2))
        el.top = Math.max(0, Math.round((562.5 - (el.height || 300)) / 2))
      }
      if (el.type === 'image' && ctx.media && typeof ctx.media.prepareImage === 'function') {
        await ctx.media.prepareImage(el)
      }
      s.elements.push(el)
      P.updateSlide(i, s)
    },
  },

  'set-element': {
    run(P, c) {
      const i = Number(c.slide != null ? c.slide : c.id)
      const s = clone(P, i)
      const el = s.elements.find(e => e.id === c.elementId)
      if (!el) throw new Error('set-element 未命中: ' + c.elementId)
      patchElement(el, c.props || {})
      P.updateSlide(i, s)
    },
  },

  'remove-element': {
    run(P, c) {
      const i = Number(c.slide != null ? c.slide : 0)
      const s = clone(P, i)
      const n = s.elements.length
      s.elements = s.elements.filter(e => e.id !== c.elementId)
      if (s.elements.length === n) throw new Error('remove-element 未命中: ' + c.elementId)
      P.updateSlide(i, s)
    },
  },
}
