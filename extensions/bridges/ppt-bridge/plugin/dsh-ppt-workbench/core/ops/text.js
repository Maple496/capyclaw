/** 文本 op：按页/元素改文本，文字槽位填充。 */
import { patchElement, textHolder } from '../text.js'

const idx = (c) => (c.id != null ? c.id : c.index)
const clone = (P, i) => JSON.parse(JSON.stringify(P.getSlides()[i]))

export const textOps = {
  'set-text': {
    run(P, c) {
      const i = idx(c)
      const s = clone(P, i)
      const el = s.elements.find(e => (c.elementId && e.id === c.elementId) ||
        (!c.elementId && e.type === 'text'))
        || (!c.elementId && s.elements.find(e => textHolder(e)))
      if (!el) throw new Error('set-text 未命中: ' + (c.elementId || '首个文本'))
      patchElement(el, c)
      P.updateSlide(i, s)
    },
  },

  'fill-slot': {
    run(P, c) {
      const i = Number(c.slide) | 0
      const s = clone(P, i)
      const texts = (s.elements || []).filter(e => textHolder(e))
      const el = texts[Number(c.slot) | 0]
      if (!el) throw new Error('文本槽位不存在: ' + c.slot)
      patchElement(el, {
        text: c.text, html: c.html,
        fontSize: c.fontSize, color: c.color, bold: c.bold, align: c.align,
      })
      P.updateSlide(i, s)
    },
  },
}
