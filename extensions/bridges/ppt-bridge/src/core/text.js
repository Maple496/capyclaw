/**
 * PPT Bridge 中间件 —— 纯文本/样式工具（DOM-free，可在 node:test 直接测）。
 * 2026-10-22 结构批：从 keystudio.works 抽取，行为保持不变。
 * 2026-10-30 解耦批：颜色解析/对比色收敛到 core/color.js。
 */
import { parseColor, contrastColor } from './color.js'
import { makeChartElement } from './chart.js'
import { makeTableElement } from './table.js'
import { makeFormulaElement } from './formula.js'

export { parseColor } from './color.js'

export const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const fontSizeOf = (html) => {
  const m = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(String(html || ''))
  return m ? Number(m[1]) : 0
}

/** 文本载体：text 元素本身，或带 text.content 的 shape（卡片标题）。 */
export function textHolder(el) {
  if (!el) return null
  if (el.type === 'text') return el
  if (el.type === 'shape' && el.text && typeof el.text.content === 'string') return el.text
  return null
}

export const htmlOf = (el) => {
  const h = textHolder(el)
  return h ? String(h.content || '') : ''
}

/**
 * 保留完整标签树（含 span 的 font-size/颜色/背景），只替换文本节点。
 * 原字号住在 <span style="font-size:54px"> 里；DOM 版依赖 DOMParser，
 * 这里用正则遍历文本节点实现同样语义，便于单测。
 */
export function setPlainText(current, text) {
  const src = String(current || '')
  const body = escapeHtml(text == null ? '' : text)
  let first = true
  const out = src.replace(/>([^<>]*)</g, (m, txt) => {
    if (!String(txt).trim()) return m
    if (first) { first = false; return '>' + body + '<' }
    return '><'
  })
  if (first) return '<p>' + body + '</p>'
  return out
}

/** 文本样式改写：缺省保留原文（去标签取纯文本），样式从 props 合并。 */
export function textHtml(current, props, st) {
  let inner = props.html
  if (inner == null) {
    if (props.text != null) inner = escapeHtml(String(props.text))
    else inner = String(current || '').replace(/<p[^>]*>/i, '').replace(/<\/p>\s*$/i, '')
  }
  let body = inner
  if (st && st.bold) body = '<strong>' + body + '</strong>'
  const size = st && st.fontSize != null ? Number(st.fontSize) : 28
  let style = 'font-size: ' + size + 'px;'
  if (st && st.color) style += ' color: ' + String(st.color) + ';'
  if (st && st.align) style += ' text-align: ' + String(st.align) + ';'
  return '<p style="' + style + '">' + body + '</p>'
}

/** 元素属性补丁：几何 / 填充 / 文本样式（content 重写保留正文）。 */
export function patchElement(el, props) {
  ;['left', 'top', 'width', 'height', 'rotate', 'opacity'].forEach(k => {
    if (props[k] != null && isFinite(Number(props[k]))) el[k] = Number(props[k])
  })
  if (props.fill != null) el.fill = String(props.fill)
  if (el.type === 'image') {
    if (props.src != null) el.src = String(props.src)
    if (props.clip != null) el.clip = props.clip
    return
  }
  /* 公式元素：path/latex/viewBox 由渲染器产出，样式走 stroke。 */
  if (el.type === 'latex') {
    if (props.path != null) el.path = String(props.path)
    if (props.latex != null) el.latex = String(props.latex)
    if (Array.isArray(props.viewBox) && props.viewBox.length === 2 &&
        props.viewBox.every(n => isFinite(Number(n)) && Number(n) > 0)) {
      el.viewBox = [Number(props.viewBox[0]), Number(props.viewBox[1])]
    }
    if (props.color != null) el.color = String(props.color)
    if (props.strokeWidth != null && isFinite(Number(props.strokeWidth))) {
      el.strokeWidth = Number(props.strokeWidth)
    }
    return
  }
  const holder = textHolder(el)
  if (!holder) return
  /* 只改颜色：直接替换 inline color，保留字号/加粗（否则 textHtml 会回落到 28px） */
  if (props.color != null && props.text == null && props.html == null &&
      props.fontSize == null && props.bold == null && props.align == null) {
    holder.content = String(holder.content || '').replace(/color:\s*[^;"']+/g, 'color: ' + String(props.color))
    if (el.type === 'text') el.defaultColor = String(props.color)
    return
  }
  if (props.defaultColor != null && el.type === 'text') el.defaultColor = String(props.defaultColor)
  const hasText = props.text != null || props.html != null
  const hasStyle = props.fontSize != null || props.color != null ||
    props.bold != null || props.align != null
  if (hasText && !hasStyle) {
    /* 槽位填充：只换文字，保留原字号/颜色/加粗（版式不破） */
    holder.content = setPlainText(holder.content, props.text)
  }
  else if (hasText || hasStyle) {
    holder.content = textHtml(holder.content, props, hasStyle ? props : null)
  }
}

export function makeElement(e) {
  const type = String(e.type || 'text')
  if (type !== 'text' && type !== 'shape' && type !== 'image' &&
      type !== 'chart' && type !== 'table' && type !== 'line' && type !== 'latex') {
    throw new Error('不支持的 element.type: ' + type +
      '（只支持 text / shape / image / chart / table / line / latex）')
  }
  /* 线条：start/end 用画布绝对坐标表达，落库转为元素相对坐标；
     PPTist line 元素不存包围盒宽高——width 字段是线宽。 */
  if (type === 'line') {
    const sx = e.start ? Number(e.start[0]) : Number(e.x1 != null ? e.x1 : 0)
    const sy = e.start ? Number(e.start[1]) : Number(e.y1 != null ? e.y1 : 0)
    const ex = e.end ? Number(e.end[0]) : Number(e.x2 != null ? e.x2 : 200)
    const ey = e.end ? Number(e.end[1]) : Number(e.y2 != null ? e.y2 : 0)
    if (![sx, sy, ex, ey].every(isFinite)) throw new Error('line 需要 start/end（画布坐标）或 x1/y1/x2/y2')
    const left = Math.min(sx, ex)
    const top = Math.min(sy, ey)
    const pointOf = (v) => (v && v !== 'none' ? String(v) : '')
    const el = {
      id: e.id || ('line_' + Date.now() + '_' + Math.floor(Math.random() * 1000)),
      type,
      left,
      top,
      start: [sx - left, sy - top],
      end: [ex - left, ey - top],
      points: Array.isArray(e.points)
        ? e.points.map(String)
        : [pointOf(e.start_point), pointOf(e.end_point)],
      color: e.color || '#5b9bd5',
      style: String(e.style || 'solid'),
      width: Number(e.width || e.lineWidth || 2),
    }
    if (Array.isArray(e.broken) && e.broken.length === 2) {
      el.broken = [Number(e.broken[0]) - left, Number(e.broken[1]) - top]
    }
    return el
  }
  /* 图表 / 表格 / 公式：委托给各自的构建器（数据归一化 + 校验）。 */
  if (type === 'chart') return makeChartElement(e)
  if (type === 'table') return makeTableElement(e)
  if (type === 'latex') return makeFormulaElement(e)
  const id = e.id || ('el_' + Date.now() + '_' + Math.floor(Math.random() * 1000))
  const base = {
    id, type,
    left: Number(e.left != null ? e.left : 60), top: Number(e.top != null ? e.top : 120),
    width: Number(e.width != null ? e.width : 400), height: Number(e.height != null ? e.height : 60),
    rotate: Number(e.rotate || 0), fixedRatio: false,
  }
  if (type === 'shape') {
    return Object.assign(base, {
      path: e.path || 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
      viewBox: e.viewBox || [200, 200],
      fill: e.fill || 'rgb(209, 68, 36)',
    })
  }
  if (type === 'image') {
    const src = String(e.src || '')
    if (!src) throw new Error('image 元素需要 src（请用 ppt_image，支持 attachment_id）')
    if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('file:')) {
      throw new Error('本机路径不能直接插入图片；请用 ppt_image（会自动转 data URL）')
    }
    return Object.assign(base, {
      src,
      clip: e.clip || null,
      ...(e.opacity != null ? { opacity: Number(e.opacity) } : {}),
    })
  }
  return Object.assign(base, {
    content: e.content || textHtml('', { text: e.text || '' },
      { fontSize: e.fontSize || 28, color: e.color || '#333333' }),
    defaultColor: e.color || '#333333', defaultFontName: '',
  })
}

/** 背景明暗 → 文本自动对比度：浅底深字 / 深底白字。 */
export function contrast(slide, bg) {
  if (!parseColor(bg)) return
  const fg = contrastColor(bg)
  ;(slide.elements || []).forEach(el => {
    if (el.type !== 'text') return
    el.defaultColor = fg
    if (typeof el.content === 'string') {
      el.content = el.content.replace(/color:\s*[^;"']+/g, 'color: ' + fg)
    }
  })
}
