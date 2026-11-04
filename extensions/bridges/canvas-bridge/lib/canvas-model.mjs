/**
 * Canvas 文档模型：把「块」编译成 canvas-editor 的元素流。
 *
 * 内核事实（自 canvas-full-app.js 反推，勿凭印象改）：
 *   - 文档 = {header?, main: Element[], footer?}（load() 三形兼容）
 *   - 段落 = 文本元素 + {value:'\n'}
 *   - 表格 = {type:'table', value:' ', colgroup:[{width}], trList:[
 *              {height, minHeight, tdList:[{colspan,rowspan,value:[...]}]}]}
 *   - 图片 = {type:'image', value:dataURL, width, height}
 *   - 纯文本样式 = 元素上的 bold/italic/underline/color/size/font/highlight
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

const HEADING_SIZE = { 1: 28, 2: 22, 3: 18, 4: 16 }

/** 单块 → 元素数组 */
export function blockElements(block) {
  if (!block || typeof block !== 'object') return []
  const type = String(block.type || 'paragraph')
  const text = String(block.text ?? block.content ?? '')

  if (type === 'heading') {
    const level = Math.min(4, Math.max(1, Number(block.level) || 1))
    return [
      { value: text, size: HEADING_SIZE[level], bold: true },
      { value: '\n' },
    ]
  }
  if (type === 'bullet') {
    return [{ value: '• ' + text }, { value: '\n' }]
  }
  if (type === 'number') {
    const n = Number(block.index) || 1
    return [{ value: `${n}. ` + text }, { value: '\n' }]
  }
  if (type === 'quote') {
    return [{ value: text, italic: true, color: '#666666' }, { value: '\n' }]
  }
  if (type === 'code') {
    return [{ value: text, font: 'Menlo, Consolas, monospace', size: 12, highlight: '#f2f3f5' },
      { value: '\n' }]
  }
  if (type === 'divider') {
    return [{ value: '────────────────────────────' }, { value: '\n' }]
  }
  if (type === 'pageBreak') {
    return [{ type: 'pageBreak', value: '' }]
  }
  return [{ value: text }, { value: '\n' }]
}

/** 块数组 → 完整文档体（header/main/footer 必须是数组——内核 draw.setValue
 *  对三段分别做 Wr() 归一化，传 {height,elementList} 对象会抛 unshift 错误） */
export function documentOf(blocks) {
  return { header: [], main: blocksToElements(blocks), footer: [] }
}

/** 块数组 → 扁平元素流（block 级样式 + 行内样式） */
export function blocksToElements(blocks) {
  const out = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const els = blockElements(b)
    const style = b && b.style && typeof b.style === 'object' ? b.style : null
    if (style) {
      for (const el of els) {
        if (el.value === '\n') continue
        for (const k of ['bold', 'italic', 'underline', 'strikeout', 'color', 'size', 'font', 'highlight']) {
          if (style[k] !== undefined) el[k] = style[k]
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
  const contentWidth = opts.contentWidth || 554
  const headerBg = opts.header_background || '#eef1f5'

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

/** 图片元素（src 需 dataURL；外链图片由调用方先转 dataURL） */
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
