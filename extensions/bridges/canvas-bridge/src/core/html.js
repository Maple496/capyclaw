/**
 * doc → 结构化 HTML：导出用（纯函数）。
 * heading/paragraph/list/table/image 都有对应标签；行内样式映射到 span style。
 */
import { walkElements } from './doc.js'

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inlineStyle(el) {
  const css = []
  if (el.bold) css.push('font-weight:700')
  if (el.italic) css.push('font-style:italic')
  if (el.underline) css.push('text-decoration:underline')
  if (el.strikeout) css.push('text-decoration:line-through')
  if (el.color) css.push(`color:${el.color}`)
  if (el.highlight) css.push(`background:${el.highlight}`)
  if (el.size) css.push(`font-size:${el.size}px`)
  if (el.font) css.push(`font-family:${el.font}`)
  return css.join(';')
}

function textHtml(el) {
  if (el.value === '\n') return ''
  const style = inlineStyle(el)
  const body = esc(el.value).replace(/\n/g, '<br>')
  return style ? `<span style="${esc(style)}">${body}</span>` : body
}

function tableHtml(el) {
  const cols = (el.colgroup || []).map((c) => `<col style="width:${c.width || 100}px">`).join('')
  const rows = (el.trList || []).map((tr) => {
    const cells = (tr.tdList || []).map((td) => {
      const inner = (td.value || []).map(textHtml).join('') || '&nbsp;'
      const style = td.backgroundColor ? ` style="background:${esc(td.backgroundColor)}"` : ''
      return `<td colspan="${td.colspan || 1}" rowspan="${td.rowspan || 1}"${style}>${inner}</td>`
    }).join('')
    return `<tr>${cells}</tr>`
  }).join('')
  return `<table><colgroup>${cols}</colgroup>${rows}</table>`
}

/** 内核 title level 名 → h 标签级别。 */
const TITLE_TAG_OF = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 }

/** doc → 完整 HTML 文档。 */
export function docToHtml(doc, title = 'Canvas 文档') {
  const body = []
  let para = []
  const flush = () => {
    if (para.length) {
      const text = para.join('')
      if (text.trim()) {
        const first = para[0] || ''
        const size = Number((first.match(/font-size:(\d+)px/) || [])[1]) || 0
        const bold = first.includes('font-weight:700')
        const tag = size >= 28 || (bold && size >= 24) ? 'h1' : size >= 22 || (bold && size >= 18) ? 'h2' : size >= 18 ? 'h3' : 'p'
        body.push(`<${tag}>${text}</${tag}>`)
      }
      para = []
    }
  }
  const topLevel = Array.isArray(doc && doc.main) ? doc.main : []
  for (let i = 0; i < topLevel.length; i++) {
    const el = topLevel[i]
    if (el && el.type === 'title') {
      /* 真标题：按 level 出 h1-h6（与目录/编辑器样式同源） */
      flush()
      const h = TITLE_TAG_OF[el.level] || 1
      const inner = (el.valueList || []).map(textHtml).join('')
      if (inner.trim()) body.push(`<h${h}>${inner}</h${h}>`)
      continue
    }
    for (const nested of walkElements([el])) {
      emitElement(nested)
    }
  }
  function emitElement(el) {
    if (!el) return
    if (el.type === 'title') return /* 嵌套 title 由顶层分支处理 */
    if (el.type === 'table') { flush(); body.push(tableHtml(el)); return }
    if (el.type === 'image') {
      flush()
      const src = typeof el.value === 'string' ? el.value : ''
      body.push(`<figure><img src="${esc(src)}" style="width:${el.width || 480}px" alt="">`
        + (el.imgCaption ? `<figcaption>${esc(el.imgCaption)}</figcaption>` : '') + '</figure>')
      return
    }
    if (el.type === 'pageBreak') { flush(); body.push('<hr style="page-break-after:always;border:0">'); return }
    if (el.type === 'hyperlink') {
      const url = el.value && el.value.url ? el.value.url : '#'
      const label = el.value && typeof el.value.text === 'string' ? el.value.text : url
      para.push(`<a href="${esc(url)}">${esc(label)}</a>`)
      return
    }
    if (el.type === 'separator') { flush(); body.push('<hr>'); return }
    if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'select' || el.type === 'date' || el.type === 'text') {
      /* 控件值投影成文本 */
      if (el.value && typeof el.value === 'object' && el.value.value !== undefined) para.push(esc(el.value.value))
      return
    }
    if (typeof el.value === 'string') {
      if (el.value === '\n') { flush(); return }
      para.push(textHtml(el))
    }
  }
  flush()
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body { max-width: 800px; margin: 40px auto; padding: 0 20px; font: 15px/1.8 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2937; }
h1, h2, h3, h4, h5, h6 { line-height: 1.4; margin: 1.6em 0 .6em; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
td { border: 1px solid #d1d5db; padding: 6px 10px; vertical-align: middle; }
figure { margin: 1em 0; } figcaption { color: #6b7280; font-size: 13px; text-align: center; }
a { color: #2563eb; }
@media print { body { margin: 0; max-width: none; } }
</style></head><body>
${body.join('\n')}
</body></html>`
}
