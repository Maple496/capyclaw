/**
 * 颜色域：中文色名、颜色解析、亮度与对比色。
 *
 * 这是整个仓库唯一的颜色实现；core/text、core/quick、core/audit 与
 * MCP 的 domains/color 都从这里取，避免多份色表/亮度公式漂移。
 */

export const COLORS = {
  蓝: '#5b9bd5', 蓝色: '#5b9bd5', 天蓝: '#87ceeb', 淡蓝: '#add8e6', 浅蓝: '#b3e5fc', 深蓝: '#1e3a8a',
  白: '#ffffff', 白色: '#ffffff', 黑: '#000000', 黑色: '#000000',
  灰: '#cccccc', 灰色: '#cccccc', 深灰: '#333333', 浅灰: '#f2f2f2',
  黄: '#ffe066', 淡黄: '#fffacd', 浅黄: '#fffacd', 米色: '#f5f5dc',
  红: '#d14424', 红色: '#d14424', 绿: '#2e7d32', 绿色: '#2e7d32',
  紫: '#7e57c2', 紫色: '#7e57c2', 橙: '#f0a030', 橙色: '#f0a030',
  粉: '#ffc0cb', 粉色: '#ffc0cb', 青: '#20b2aa', 青色: '#20b2aa',
  棕: '#8d6e63', 棕色: '#8d6e63',
}

/** 中文色名 / CSS 颜色 → hex；最长匹配，同长度取更早出现。 */
export function resolveColor(v) {
  const s = String(v || '').trim()
  if (COLORS[s]) return COLORS[s]
  let best = null
  for (const k of Object.keys(COLORS)) {
    const idx = s.indexOf(k)
    if (idx < 0) continue
    if (!best || k.length > best.k.length || (k.length === best.k.length && idx < best.idx)) {
      best = { k, idx }
    }
  }
  return best ? COLORS[best.k] : s
}

/** #rgb / #rrggbb / rgb() / rgba() → [r,g,b]；非法返回 null。 */
export function parseColor(v) {
  const s = String(v || '').trim()
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s)
  if (m) return [+m[1], +m[2], +m[3]]
  return null
}

/** 0-255 加权亮度（WCAG 系数）。 */
export function luminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

/** WCAG 相对亮度（sRGB → 线性）。 */
function relativeChannel(c) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function relativeLuminanceRgb(rgb) {
  return 0.2126 * relativeChannel(rgb[0]) + 0.7152 * relativeChannel(rgb[1]) + 0.0722 * relativeChannel(rgb[2])
}

/** 两色 WCAG 对比度（1–21，审计用）。 */
export function contrastRatio(a, b) {
  const l1 = relativeLuminanceRgb(a)
  const l2 = relativeLuminanceRgb(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

/** 背景相对亮度（0-1）；无法解析时按白色处理。 */
export function relativeLuminance(bg) {
  const rgb = parseColor(bg)
  return rgb ? luminance(rgb) / 255 : 1
}

/** 浅底深字 / 深底白字。 */
export function contrastColor(bg) {
  return relativeLuminance(bg) > 0.62 ? '#1f2d3d' : '#ffffff'
}
