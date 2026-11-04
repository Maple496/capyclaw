/** 换色规划：新编辑器走单条 recolor；旧编辑器回退为批量 set-background + set-element。 */
import { contrastColor } from './color.mjs'

export const resolveForeground = (bg, text) => text || contrastColor(bg)

/** 纯函数：把一次整体换色展开为 set-background + set-element 队列。
 *  每批 ≤90 条由调用方分组推送（包络上限 100）。 */
export function expandRecolorOps(deck, { bg, fg, sf, targets }) {
  const ops = []
  const list = (deck && deck.slides) || []
  list.forEach((s, i) => {
    if (targets && targets.indexOf(i) < 0) return
    ops.push({ op: 'set-background', color: bg, indices: [i], contrast: true })
    ;(s.elements || []).forEach(el => {
      if (el.type === 'text') return
      const props = {}
      if (sf && el.fill != null) props.fill = sf
      if (el.text && typeof el.text.content === 'string') props.color = fg
      if (Object.keys(props).length) {
        ops.push({ op: 'set-element', slide: i, elementId: el.id, props })
      }
    })
  })
  return ops
}
