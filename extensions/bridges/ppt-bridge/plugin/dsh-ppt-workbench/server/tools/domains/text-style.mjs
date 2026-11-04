/** 文本样式参数归一化：ppt_text / ppt_fill / ppt_element 共用。 */
import { resolveColor } from './color.mjs'

export function normalizeTextStyle({ font_size, color, bold, align } = {}) {
  const out = {}
  if (font_size != null) out.fontSize = Math.min(200, Math.max(8, Number(font_size) | 0))
  if (color) out.color = resolveColor(color)
  if (bold != null) out.bold = !!bold
  if (align) out.align = align
  return out
}
