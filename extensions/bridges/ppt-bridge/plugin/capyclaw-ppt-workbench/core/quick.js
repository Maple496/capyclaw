/**
 * 本地快捷指令（不经模型，<100ms）：中文颜色名 / 第N页改字 / 加一页。
 * 纯函数，返回底层 op 数组；解析失败返回 null。
 */
import { escapeHtml } from './text.js'
import { COLORS } from './color.js'

export { COLORS, resolveColor } from './color.js'

export function simpleSlide(title) {
  const ts = Date.now()
  return {
    id: 'quick_' + ts,
    background: { type: 'solid', color: '#ffffff' },
    elements: [{
      type: 'text', id: 'quick_t_' + ts,
      left: 60, top: 50, width: 880, height: 76,
      content: '<p style="font-size: 34px;"><strong>' + escapeHtml(title) + '</strong></p>',
      defaultColor: '#333333', defaultFontName: '', fixedRatio: false, rotate: 0,
    }],
  }
}

export function parseQuick(text) {
  const t = String(text || '').trim()
  if (!t) return null
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const pageMatch = /第\s*([0-9]+|[一二三四五六七八九十])\s*页/.exec(t)
  const page = pageMatch ? (cn[pageMatch[1]] || parseInt(pageMatch[1], 10)) - 1 : null
  const setText = /第\s*(?:[0-9]+|[一二三四五六七八九十])\s*页.*?(?:标题|文字|文本|内容).*?(?:改成|换成|改为|设为)\s*(.+)$/.exec(t)
  if (setText) return [{ op: 'set-text', id: page, text: setText[1].trim() }]
  const add = /(?:加|新增|添加)一页\s*(.*)$/.exec(t)
  if (add) return [{ op: 'add-slide', slide: simpleSlide(add[1].trim() || '新一页') }]
  if (/背景/.test(t)) {
    let hex = null
    let best = null
    for (const k of Object.keys(COLORS)) {
      const idx = t.indexOf(k)
      if (idx < 0) continue
      if (!best || k.length > best.k.length || (k.length === best.k.length && idx < best.idx)) best = { k, idx }
    }
    if (best) hex = COLORS[best.k]
    const hexMatch = /#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(t)
    if (hexMatch) hex = hexMatch[0]
    if (hex) {
      const cmd = { op: 'set-background', color: hex, contrast: true }
      if (page != null) cmd.indices = [page]
      return [cmd]
    }
  }
  return null
}
