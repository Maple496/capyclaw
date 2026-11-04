/**
 * 文档投影：从镜像 doc（元素流）派生 Agent 需要的读取形态。
 * 全部纯函数，node:test 直测；不碰 DOM、不碰 CanvasApp。
 */
import { PAPER } from './blocks.js'

/** 归一化区域：三形兼容（数组 / {elementList} / undefined）。 */
function zoneOf(zone) {
  if (Array.isArray(zone)) return zone
  if (zone && Array.isArray(zone.elementList)) return zone.elementList
  return []
}

/** 递归收集元素（含表格单元格 / 分组 / 控件值）。 */
export function* walkElements(elements) {
  for (const el of Array.isArray(elements) ? elements : []) {
    if (!el || typeof el !== 'object') continue
    yield el
    if (Array.isArray(el.valueList)) yield* walkElements(el.valueList)
    if (el.trList) {
      for (const tr of el.trList) {
        for (const td of (tr && tr.tdList) || []) yield* walkElements(td.value)
      }
    }
  }
}

const ZONES = ['header', 'main', 'footer']

/** 非文本类型：value 是占位符（表格 ' '、图片 dataURL…），不进纯文本投影。 */
const NON_TEXT_TYPES = new Set(['table', 'image', 'pageBreak', 'separator'])

/** 文档 → 纯文本（保留换行语义：'\n' 元素即换行）。 */
export function textOf(doc) {
  if (!doc || typeof doc !== 'object') return ''
  const parts = []
  for (const zone of ZONES) {
    const text = zoneOf(doc[zone])
      .map((el) => (el && typeof el.value === 'string' && el.value !== '\n'
        && !NON_TEXT_TYPES.has(el.type) ? el.value : ''))
      .join('')
    if (text) parts.push(text)
  }
  return parts.filter(Boolean).join('\n')
}

/** 字数（CJK 每字 1，ASCII 词 1——与编辑器 getWordCount 口径接近即可）。 */
export function wordCountOf(doc) {
  const text = textOf(doc)
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) || []).length
  const ascii = (text.match(/[a-zA-Z0-9]+/g) || []).length
  return cjk + ascii
}

/** 从元素流推大纲：大字号/加粗的非空行视为标题，仿编辑器 getCatalog 的层级。 */
export function outlineOf(doc) {
  const out = []
  let index = 0
  let page = 1
  for (const el of walkElements(zoneOf(doc && doc.main))) {
    if (el.type === 'pageBreak') { page += 1; continue }
    const value = typeof el.value === 'string' ? el.value.trim() : ''
    if (!value || value === '\n') continue
    const size = Number(el.size) || 16
    const bold = !!el.bold || size >= 28
    if (!bold && size < 18) continue
    const level = size >= 28 ? 1 : size >= 22 ? 2 : 3
    out.push({ id: el.id || null, index: index++, level, page, text: value.slice(0, 60) })
  }
  return out
}

/** 元素统计（summary 用）。 */
export function elementStats(doc) {
  const stats = { text: 0, table: 0, image: 0, hyperlink: 0, control: 0, checkbox: 0, radio: 0, separator: 0, pageBreak: 0, other: 0 }
  for (const el of walkElements(zoneOf(doc && doc.main))) {
    if (el.type && stats[el.type] !== undefined) stats[el.type] += 1
    else if (el.type) stats.other += 1
    else if (typeof el.value === 'string' && el.value !== '\n') stats.text += 1
  }
  return stats
}

/** 纸张尺寸信息（从 options 或默认 A4）。 */
export function paperOf(options) {
  const opts = options || {}
  const key = String(opts.paperSize || 'A4')
  const size = PAPER[key] || PAPER.A4
  const landscape = String(opts.paperDirection || 'vertical') === 'horizontal'
  return {
    name: key,
    width: landscape ? size.height : size.width,
    height: landscape ? size.width : size.height,
    direction: landscape ? 'horizontal' : 'vertical',
    margins: Array.isArray(opts.paperMargin) && opts.paperMargin.length === 4
      ? opts.paperMargin : [100, 100, 100, 100],
  }
}

/** 紧凑摘要：Agent 的默认「看」。 */
export function summarize(doc, options) {
  if (!doc || typeof doc !== 'object') return '（桥上没有文档：右侧编辑器未就绪）'
  const text = textOf(doc)
  const stats = elementStats(doc)
  const outline = outlineOf(doc)
  const lines = [
    `字数 ${wordCountOf(doc)}，段落文本 ${stats.text} 处，表格 ${stats.table}，图片 ${stats.image}`,
  ]
  if (outline.length) {
    lines.push('大纲：')
    for (const h of outline.slice(0, 40)) {
      lines.push(`  ${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}`)
    }
    if (outline.length > 40) lines.push(`  …（共 ${outline.length} 条）`)
  }
  lines.push('预览：' + (text.slice(0, 200) || '（空）') + (text.length > 200 ? '…' : ''))
  return lines.join('\n')
}

/** 在文档中查找文本，返回命中（区域/元素索引/上下文）。 */
export function findInDoc(doc, needle, limit = 50) {
  const hits = []
  const key = String(needle || '')
  if (!key) return hits
  for (const zone of ZONES) {
    const elements = zoneOf(doc[zone])
    elements.forEach((el, i) => {
      if (el && typeof el.value === 'string' && el.value.includes(key)) {
        const at = el.value.indexOf(key)
        hits.push({
          zone, index: i,
          context: el.value.slice(Math.max(0, at - 12), at + key.length + 12),
        })
        if (hits.length >= limit) return
      }
    })
    if (hits.length >= limit) break
  }
  return hits
}
