/** 页面 op：背景、增删改移复制、选中。 */
import { contrast } from '../text.js'

const idx = (c) => (c.id != null ? c.id : c.index)
const clone = (P, i) => JSON.parse(JSON.stringify(P.getSlides()[i]))

export const slideOps = {
  'set-background': {
    run(P, c) {
      const idxs = Array.isArray(c.indices) ? c.indices : null
      const n = P.getSlides().length
      for (let i = 0; i < n; i++) {
        if (idxs && idxs.indexOf(i) < 0) continue
        const s = clone(P, i)
        s.background = { type: 'solid', color: String(c.color || '#ffffff') }
        if (c.contrast) contrast(s, String(c.color || '#ffffff'))
        P.updateSlide(i, s)
      }
    },
  },

  'add-slide': {
    run(P, c) { P.addSlide(c.slide || {}, c.index) },
  },

  'update-slide': {
    run(P, c) {
      if (!P.updateSlide(idx(c), c.slide)) throw new Error('update-slide 未命中')
    },
  },

  'remove-slide': {
    run(P, c) {
      if (!P.removeSlide(idx(c))) throw new Error('remove-slide 未命中')
    },
  },

  'move-slide': {
    run(P, c) {
      if (!P.moveSlide(c.from, c.to)) throw new Error('move-slide 越界')
    },
  },

  'duplicate-slide': {
    run(P, c) {
      if (!P.duplicateSlide(idx(c))) throw new Error('duplicate-slide 未命中')
    },
  },

  select: {
    mutates: false,
    view: true,
    run(P, c) {
      if (!P.selectSlide(idx(c))) throw new Error('select 未命中')
    },
  },

  'set-notes': {
    run(P, c) {
      const i = Number(c.slide != null ? c.slide : idx(c))
      const s = clone(P, i)
      s.notes = String(c.notes == null ? '' : c.notes)
      P.updateSlide(i, s)
    },
  },
}
