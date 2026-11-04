/** 整体换色 op：背景 + 全部文字对比色 + 装饰形状，一次完成。 */
import { textHolder } from '../text.js'
import { contrastColor } from '../color.js'

const clone = (P, i) => JSON.parse(JSON.stringify(P.getSlides()[i]))

export const recolorOps = {
  recolor: {
    run(P, c) {
      const bg = String(c.background || '#ffffff')
      const fg = c.text ? String(c.text) : contrastColor(bg)
      const shapeFill = c.shapes === null ? null
        : String(c.shapes != null && c.shapes !== true ? c.shapes : fg)
      const n = P.getSlides().length
      for (let i = 0; i < n; i++) {
        if (Array.isArray(c.indices) && c.indices.indexOf(i) < 0) continue
        const s = clone(P, i)
        s.background = { type: 'solid', color: bg }
        ;(s.elements || []).forEach(el => {
          const holder = textHolder(el)
          if (holder) {
            el.defaultColor = fg
            if (typeof holder.content === 'string') {
              holder.content = holder.content.replace(/color:\s*[^;"']+/g, 'color: ' + fg)
            }
          }
          if (el.type !== 'text' && shapeFill && el.fill != null) el.fill = shapeFill
        })
        P.updateSlide(i, s)
      }
    },
  },
}
