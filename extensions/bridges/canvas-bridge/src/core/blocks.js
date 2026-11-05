/**
 * Canvas 块级写作模型：把「块」编译成 canvas-editor 的元素流。
 *
 * 内核事实（自 runtime/canvas-full-app.js 反推 + scripts/discover-api.mjs 探测，勿凭印象改）：
 *   - 文档 = {header?, main: Element[], footer?}（load() 三形兼容）
 *   - 行模型：换行只由 value 内的 '\n' 字符决定；title 元素自带起行，
 *     其余文本元素需以 '\n' 开头才另起一行（首行前导 '\n' 由内核归一化剥离）。
 *     仅靠元素边界（不带 '\n'）会被渲染成与上一行连排。
 *   - 标题 = {type:'title', level:'first'..'sixth', value:'', valueList:[…]}；
 *     load() 展平后给 valueList 元素挂 titleId/level，目录（getCatalog）由此构建。
 *     内核默认字号 first..sixth = 26/24/22/20/18/16，自动加粗。
 *   - 表格 = {type:'table', value:' ', colgroup:[{width}], trList:[
 *              {height, minHeight, tdList:[{colspan,rowspan,value:[...]}]}]}
 *   - 图片 = {type:'image', value:dataURL, width, height}
 *   - 纯文本样式 = 元素上的 bold/italic/underline/color/size/font/highlight
 *
 * 本文件是工具层的单一真源（必须自包含：插件包目录镜像拷贝后 ../../lib 路径不存在）。
 * lib/canvas-model.mjs（standalone 兼容）从这里再导出。
 */
export const PAPER = {
  A4: { width: 794, height: 1123 },
  A3: { width: 1123, height: 1587 },
  A5: { width: 559, height: 794 },
  B4: { width: 1001, height: 1417 },
  B5: { width: 709, height: 1001 },
  Letter: { width: 816, height: 1056 },
  Legal: { width: 816, height: 1344 },
}

/** heading 级别（1-6）→ 内核 title level 名（目录/样式语义由此承载）。 */
const TITLE_LEVELS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']

/** 单块 → 元素数组（每块一行：title 自带起行；文本行以 '\n' 开头） */
export function blockElements(block) {
  if (!block || typeof block !== 'object') return []
  const type = String(block.type || 'paragraph')
  const text = String(block.text ?? block.content ?? '')

  if (type === 'heading') {
    const level = Math.min(6, Math.max(1, Number(block.level) || 1))
    /* valueList 内不放 size/bold：交给内核按 level 应用默认字号并加粗，
     * 与用户手工插入的标题完全同形（目录、样式面板互相通用）。 */
    return [{ type: 'title', level: TITLE_LEVELS[level - 1], value: '', valueList: [{ value: text }] }]
  }
  if (type === 'bullet') {
    return [{ value: '\n• ' + text }]
  }
  if (type === 'number') {
    const n = Number(block.index) || 1
    return [{ value: `\n${n}. ` + text }]
  }
  if (type === 'quote') {
    return [{ value: '\n' + text, italic: true, color: '#666666' }]
  }
  if (type === 'code') {
    return [{ value: '\n' + text, font: 'Menlo, Consolas, monospace', size: 12, highlight: '#f2f3f5' }]
  }
  if (type === 'divider') {
    return [{ value: '\n────────────────────────────' }]
  }
  if (type === 'pageBreak') {
    return [{ type: 'pageBreak', value: '' }]
  }
  return [{ value: '\n' + text }]
}

/** 块数组 → 完整文档体（header/main/footer 必须是数组——内核 draw.setValue
 *  对三段分别做归一化，传 {height,elementList} 对象会抛 unshift 错误） */
export function documentOf(blocks) {
  return { header: [], main: blocksToElements(blocks), footer: [] }
}

/** 块数组 → 扁平元素流（block 级样式 + 行内样式；title 块样式落在 valueList 内元素上） */
export function blocksToElements(blocks) {
  const out = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const els = blockElements(b)
    const style = b && b.style && typeof b.style === 'object' ? b.style : null
    if (style) {
      for (const el of els) {
        const targets = Array.isArray(el.valueList) && el.valueList.length ? el.valueList : [el]
        for (const t of targets) {
          for (const k of ['bold', 'italic', 'underline', 'strikeout', 'color', 'size', 'font', 'highlight']) {
            if (style[k] !== undefined) t[k] = style[k]
          }
        }
      }
    }
    out.push(...els)
  }
  return out
}

/** 表格元素（含表头底色） */
export function tableElement(headers, rows, opts = {}) {
  const head = Array.isArray(headers) ? headers.map(String) : []
  const body = (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r : [r]).map(String))
  const cols = Math.max(head.length, ...body.map((r) => r.length), 1)
  const contentWidth = opts.content_width || opts.contentWidth || 554
  const headerBg = opts.header_background || opts.headerBackground || '#eef1f5'

  /* 列宽按内容比例分配（等宽会让「状态」「通过」这种短列留白过多、
   * 长列被迫折行）。CJK 记 2 份、ASCII 记 1 份，夹在 [60, 55%] 之间。 */
  const weight = (v) => {
    let w = 0
    for (const ch of String(v ?? '')) w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1
    return w
  }
  const colWeights = Array.from({ length: cols }, (_, c) => {
    const cells = [head[c], ...body.map((r) => r[c])]
    return Math.max(4, ...cells.map(weight))
  })
  const totalW = colWeights.reduce((a, b) => a + b, 0) || cols
  let widths = colWeights.map((w) => Math.min(
    Math.floor(contentWidth * 0.55),
    Math.max(60, Math.floor(contentWidth * w / totalW)),
  ))
  /* 取整余量补给最宽列，避免右边界空一截 */
  const diff = contentWidth - widths.reduce((a, b) => a + b, 0)
  if (diff !== 0) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest] = Math.max(60, widths[widest] + diff)
  }

  const mkRow = (cells, bg) => ({
    height: 36,
    minHeight: 36,
    tdList: cells.map((text) => ({
      colspan: 1,
      rowspan: 1,
      value: [{ value: String(text) }, { value: '\n' }],
      verticalAlign: 'middle',
      ...(bg ? { backgroundColor: bg } : {}),
    })),
  })

  const trList = []
  if (head.length) trList.push(mkRow(head, headerBg))
  for (const r of body) trList.push(mkRow(r))
  if (!trList.length) trList.push(mkRow([''], null))

  return {
    type: 'table',
    value: ' ',
    colgroup: widths.map((w) => ({ width: w })),
    trList,
  }
}

/** 图片元素（src 需 dataURL / URL / /assets 引用） */
export function imageElement(src, width, height, caption) {
  const el = {
    type: 'image',
    value: String(src),
    width: Number(width) || 480,
    height: Number(height) || 270,
  }
  if (caption) el.imgCaption = String(caption)
  return el
}

/** 深拷贝后按 element.value 做纯文本替换（保留样式与结构） */
export function replaceInDoc(doc, find, replace, all = true) {
  let count = 0
  const needle = String(find)
  const repl = String(replace)
  if (!needle) return { doc, count }

  const walk = (list) => {
    if (!Array.isArray(list)) return
    for (const el of list) {
      if (el && typeof el.value === 'string' && el.value.includes(needle)) {
        if (all) {
          count += el.value.split(needle).length - 1
          el.value = el.value.split(needle).join(repl)
        } else if (count === 0) {
          el.value = el.value.replace(needle, repl)
          count = 1
        }
      }
      if (el && el.valueList) walk(el.valueList)
      if (el && el.trList) {
        for (const tr of el.trList) {
          for (const td of tr.tdList || []) walk(td.value)
        }
      }
    }
  }
  const copy = JSON.parse(JSON.stringify(doc || {}))
  walk(copy.main)
  walk(Array.isArray(copy.header) ? copy.header : copy.header && copy.header.elementList)
  walk(Array.isArray(copy.footer) ? copy.footer : copy.footer && copy.footer.elementList)
  return { doc: copy, count }
}

/** 空文档（清空/初始态）。 */
export const EMPTY_DOC = () => ({ header: [], main: [], footer: [] })

/** 判断文档是否为空（三段都无有效内容）。 */
export function isEmptyDoc(doc) {
  if (!doc || typeof doc !== 'object') return true
  const len = (zone) => Array.isArray(zone) ? zone.length
    : (zone && Array.isArray(zone.elementList) ? zone.elementList.length : 0)
  return len(doc.header) === 0 && len(doc.main) === 0 && len(doc.footer) === 0
}
