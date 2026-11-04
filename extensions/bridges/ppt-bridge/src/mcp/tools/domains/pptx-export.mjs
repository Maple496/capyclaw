/**
 * deck → PPTX 导出（Node 侧，pptxgenjs）。
 *
 * 只处理 PPTist deck 模型里可稳定映射的元素：文字 / 形状 / 图片 / 线条 /
 * 表格 / 图表 / 背景 / 备注。SVG 自定义路径用矩形近似，LaTeX/音视频跳过，
 * 所有近似与跳过项都记入 stats.warnings，由工具返回给调用方。
 *
 * 浏览器端不要 import 本文件：pptxgenjs 和 node:fetch 只用于 MCP 侧。
 */

/* 延迟加载：pptxgenjs 缺失时只让导出工具失败，不拖垮整个工具注册表。 */
let pptxgenPromise = null
async function loadPptxGen() {
  if (!pptxgenPromise) {
    pptxgenPromise = import('pptxgenjs').then((mod) => mod.default || mod).catch((error) => {
      pptxgenPromise = null
      throw new Error('PPTX 导出依赖 pptxgenjs 未安装：请在 workbench 包目录执行 npm install pptxgenjs（原始错误：' + String(error?.message || error) + '）')
    })
  }
  return pptxgenPromise
}

const DEFAULT_VIEWPORT_SIZE = 1000
const DEFAULT_VIEWPORT_RATIO = 0.5625
const DEFAULT_FONT = 'Microsoft YaHei'

const NAMED_COLORS = new Map(Object.entries({
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080',
  orange: '#ffa500', purple: '#800080', transparent: '#ffffff',
}))

const DASH = {
  solid: 'solid',
  dashed: 'dash',
  dotted: 'sysDot',
}

function parseColor(input) {
  const raw = String(input == null ? '' : input).trim().toLowerCase()
  if (!raw) return { hex: '#000000', alpha: 1 }
  if (raw === 'transparent') return { hex: '#ffffff', alpha: 0 }
  if (NAMED_COLORS.has(raw)) return { hex: NAMED_COLORS.get(raw), alpha: 1 }

  const rgba = raw.match(/^rgba?\(([^)]+)\)$/)
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => part.trim())
    const channel = (value) => {
      const number = parseFloat(value)
      return Number.isFinite(number) ? Math.max(0, Math.min(255, Math.round(number))) : 0
    }
    const r = channel(parts[0])
    const g = channel(parts[1])
    const b = channel(parts[2])
    const alpha = parts[3] == null ? 1 : Math.max(0, Math.min(1, parseFloat(parts[3])))
    return { hex: `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`, alpha: Number.isFinite(alpha) ? alpha : 1 }
  }

  const hex = raw.match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    let value = hex[1]
    if (value.length === 3 || value.length === 4) {
      value = value.split('').map((char) => char + char).join('')
    }
    if (value.length === 6) return { hex: `#${value}`, alpha: 1 }
    if (value.length === 8) {
      const alpha = parseInt(value.slice(6, 8), 16) / 255
      return { hex: `#${value.slice(0, 6)}`, alpha: Number.isFinite(alpha) ? alpha : 1 }
    }
  }

  return { hex: '#000000', alpha: 1 }
}

function transparency(color) {
  const { alpha } = parseColor(color)
  return Math.round((1 - alpha) * 100)
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function plainText(html) {
  return decodeEntities(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function styleOf(styleAttr) {
  const out = {}
  for (const item of String(styleAttr || '').split(';')) {
    const match = item.match(/^\s*([^:]+)\s*:\s*(.+?)\s*$/)
    if (match) out[match[1].trim().toLowerCase()] = match[2].trim()
  }
  return out
}

function pxToPt(value, ratioPx2Pt, fallback) {
  const number = parseFloat(String(value || '').replace(/px$/i, ''))
  if (!Number.isFinite(number)) return fallback
  return number / ratioPx2Pt
}

function htmlToTextProps(html, { ratioPx2Pt, defaultFont, defaultColor, defaultSize }) {
  const source = String(html || '')
  if (!source.trim()) return { props: [{ text: '', options: {} }] }

  const runs = []
  const stack = [{}]
  const listStack = []
  let bullet = null

  const currentStyle = () => stack[stack.length - 1] || {}
  const pushBreak = () => {
    if (!runs.length) return
    const last = runs[runs.length - 1]
    last.options = { ...(last.options || {}), breakLine: true }
  }
  const makeOptions = (style) => {
    const options = {}
    if (style['font-size']) options.fontSize = pxToPt(style['font-size'], ratioPx2Pt, defaultSize)
    if (style.color) options.color = parseColor(style.color).hex
    if (style['background-color']) options.highlight = parseColor(style['background-color']).hex
    if (style['font-family']) options.fontFace = String(style['font-family']).replace(/["']/g, '').split(',')[0].trim()
    if (style['font-weight']) options.bold = /bold|[6-9]00/.test(style['font-weight'])
    if (style['font-style'] === 'italic') options.italic = true
    if (style['text-decoration'] || style['text-decoration-line']) {
      const decoration = String(style['text-decoration'] || style['text-decoration-line'])
      if (decoration.includes('underline')) options.underline = { color: options.color || defaultColor, style: 'sng' }
      if (decoration.includes('line-through')) options.strike = 'sngStrike'
    }
    if (style['text-align']) options.align = style['text-align']
    if (style['vertical-align'] === 'super') options.superscript = true
    if (style['vertical-align'] === 'sub') options.subscript = true
    if (style.href) options.hyperlink = { url: style.href }
    return options
  }

  const tokenRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)([^>]*?)\/?>|([^<]+)/g
  let match
  while ((match = tokenRe.exec(source))) {
    const [token, tagNameRaw, attrsRaw, textRaw] = match
    if (textRaw !== undefined) {
      const text = decodeEntities(textRaw).replace(/\n+/g, ' ')
      if (!text) continue
      const style = currentStyle()
      const options = makeOptions(style)
      if (bullet) {
        options.bullet = bullet === 'ol' ? { type: 'number' } : { indent: (options.fontSize || defaultSize) * 1.1 }
        bullet = null
      }
      runs.push({ text, options })
      continue
    }
    if (!tagNameRaw) continue

    const tagName = tagNameRaw.toLowerCase()
    const isClose = token.startsWith('</')
    if (isClose) {
      if (['p', 'div', 'li'].includes(tagName)) pushBreak()
      if (tagName === 'ul' || tagName === 'ol') listStack.pop()
      if (stack.length > 1) stack.pop()
      continue
    }

    if (tagName === 'br') {
      runs.push({ text: '', options: { breakLine: true } })
      continue
    }
    if (['p', 'div', 'li'].includes(tagName) && runs.length) pushBreak()
    if (tagName === 'ul' || tagName === 'ol') listStack.push(tagName)
    if (tagName === 'li') bullet = listStack[listStack.length - 1] || 'ul'

    const attrs = String(attrsRaw || '')
    const style = { ...currentStyle() }
    const styleMatch = attrs.match(/\bstyle\s*=\s*"([^"]*)"/i) || attrs.match(/\bstyle\s*=\s*'([^']*)'/i)
    if (styleMatch) Object.assign(style, styleOf(styleMatch[1]))
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i)
    if (hrefMatch) style.href = hrefMatch[1]

    if (tagName === 'strong' || tagName === 'b') style['font-weight'] = 'bold'
    if (tagName === 'em' || tagName === 'i') style['font-style'] = 'italic'
    if (tagName === 'u') style['text-decoration'] = 'underline'
    if (tagName === 's' || tagName === 'strike' || tagName === 'del') style['text-decoration'] = 'line-through'
    if (tagName === 'sup') style['vertical-align'] = 'super'
    if (tagName === 'sub') style['vertical-align'] = 'sub'

    if (!['br', 'img', 'hr'].includes(tagName)) stack.push(style)
  }

  if (!runs.length) {
    return { props: [{ text: plainText(source), options: { fontFace: defaultFont, fontSize: defaultSize, color: defaultColor } }] }
  }
  const last = runs[runs.length - 1]
  if (last.options) delete last.options.breakLine
  for (const run of runs) {
    run.options = { fontFace: defaultFont, fontSize: defaultSize, color: defaultColor, ...(run.options || {}) }
  }
  return { props: runs }
}

function shapeTypeOf(pptx, element) {
  const name = String(element.shapType || element.shapeType || '').toLowerCase()
  if (name.includes('roundrect') || name.includes('round_rect')) return pptx.ShapeType.roundRect
  if (name.includes('ellipse') || name.includes('oval') || name.includes('circle')) return pptx.ShapeType.ellipse
  if (name.includes('triangle')) return pptx.ShapeType.triangle
  if (name.includes('diamond')) return pptx.ShapeType.diamond
  if (name.includes('hexagon')) return pptx.ShapeType.hexagon
  if (name.includes('star')) return pptx.ShapeType.star5
  return pptx.ShapeType.rect
}

function fillProps(value) {
  if (value && typeof value === 'object') {
    const colors = Array.isArray(value.colors) ? value.colors : []
    const first = colors[0] && (colors[0].color || colors[0])
    if (first) return { color: parseColor(first).hex, transparency: transparency(first) }
    if (value.type === 'solid' && value.value) return { color: parseColor(value.value).hex, transparency: transparency(value.value) }
    return undefined
  }
  if (typeof value === 'string' && value) {
    return { color: parseColor(value).hex, transparency: transparency(value) }
  }
  return undefined
}

function lineProps(outline, ratioPx2Pt) {
  if (!outline) return undefined
  return {
    color: parseColor(outline.color || '#000000').hex,
    width: Math.max(0.25, pxToPt(outline.width || 1, ratioPx2Pt, 1)),
    dashType: DASH[outline.style] || 'solid',
    transparency: transparency(outline.color || '#000000'),
  }
}

async function loadImage(src, assetBase) {
  const value = String(src || '').trim()
  if (!value) throw new Error('图片地址为空')
  if (value.startsWith('data:')) return { data: value }

  let url = value
  if (value.startsWith('/') && assetBase) {
    url = new URL(value.replace(/^\/+/, ''), assetBase.replace(/\/?$/, '/')).href
  }
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`)
    const type = response.headers.get('content-type') || 'image/png'
    const buffer = Buffer.from(await response.arrayBuffer())
    return { data: `data:${type};base64,${buffer.toString('base64')}` }
  }
  if (value.startsWith('file://')) return { path: decodeURIComponent(new URL(value).pathname) }
  return { path: value }
}

function cellOptions(cell, ratioPx2Pt) {
  const style = cell && typeof cell === 'object' && cell.style ? cell.style : {}
  const options = { valign: 'middle' }
  if (style.bold != null) options.bold = !!style.bold
  if (style.italic != null) options.italic = !!style.italic
  if (style.color) options.color = parseColor(style.color).hex
  if (style.backcolor) options.fill = { color: parseColor(style.backcolor).hex }
  if (style.align) options.align = style.align
  if (style.fontsize != null) options.fontSize = pxToPt(style.fontsize, ratioPx2Pt, 10)
  if (style.fontname) options.fontFace = style.fontname
  return options
}

function chartSpec(pptx, element) {
  const type = String(element.chartType || 'column')
  const data = element.data || {}
  const labels = Array.isArray(data.labels) ? data.labels.map(String) : []
  const series = Array.isArray(data.series) ? data.series : []
  const legends = Array.isArray(data.legends) ? data.legends.map(String) : series.map((_, i) => `系列${i + 1}`)
  if (!labels.length || !series.length) return null

  const seriesRows = series.map((values, index) => ({
    name: legends[index] || `系列${index + 1}`,
    labels,
    values: values.map(Number),
  }))

  let chartType = pptx.ChartType.bar
  let barDir = 'col'
  if (type === 'bar') { chartType = pptx.ChartType.bar; barDir = 'bar' }
  else if (type === 'line') chartType = pptx.ChartType.line
  else if (type === 'area') chartType = pptx.ChartType.area
  else if (type === 'pie') chartType = pptx.ChartType.pie
  else if (type === 'ring') chartType = pptx.ChartType.doughnut
  else if (type === 'radar') chartType = pptx.ChartType.radar
  else if (type === 'scatter') chartType = pptx.ChartType.scatter
  else if (type !== 'column') return null

  const colors = Array.isArray(element.themeColors) && element.themeColors.length
    ? element.themeColors.map((color) => parseColor(color).hex)
    : ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47']

  return {
    type: chartType,
    data: seriesRows,
    options: {
      barDir,
      showLegend: seriesRows.length > 1,
      legendPos: 'b',
      showTitle: false,
      showValue: false,
      showPercent: type === 'pie' || type === 'ring',
      chartColors: colors,
      catAxisLabelFontSize: 10,
      valAxisLabelFontSize: 10,
    },
  }
}

/**
 * 把 deck 渲染成 PPTX Buffer。
 * @param {object} deck PPTist deck
 * @param {{ assetBase?: string, includeNotes?: boolean }} options
 * @returns {Promise<{ buffer: Buffer, stats: object }>}
 */
export async function renderDeckToPptx(deck, options = {}) {
  const slides = Array.isArray(deck?.slides) ? deck.slides : []
  if (!slides.length) throw new Error('deck 没有幻灯片，无法导出 PPTX')

  const pptxgen = await loadPptxGen()
  const viewportSize = Number(deck.viewportSize) || DEFAULT_VIEWPORT_SIZE
  const viewportRatio = Number(deck.viewportRatio) || DEFAULT_VIEWPORT_RATIO
  const ratioPx2Inch = 96 * (viewportSize / 960)
  const ratioPx2Pt = (96 / 72) * (viewportSize / 960)
  const toIn = (value) => (Number(value) || 0) / ratioPx2Inch
  const toPt = (value) => (Number(value) || 0) / ratioPx2Pt

  const pptx = new pptxgen()
  if (viewportRatio === 0.625) pptx.layout = 'LAYOUT_16x10'
  else if (viewportRatio === 0.75) pptx.layout = 'LAYOUT_4x3'
  else {
    pptx.defineLayout({
      name: 'PPTIST_CUSTOM_LAYOUT',
      width: viewportSize / ratioPx2Inch,
      height: viewportSize * viewportRatio / ratioPx2Inch,
    })
    pptx.layout = 'PPTIST_CUSTOM_LAYOUT'
  }

  const stats = {
    slides: slides.length,
    elements: 0,
    rendered: 0,
    skipped: 0,
    approximated: 0,
    unsupportedTypes: {},
    warnings: [],
  }
  const warn = (message) => {
    if (stats.warnings.length < 40) stats.warnings.push(message)
  }

  for (const [slideIndex, sourceSlide] of slides.entries()) {
    const slide = pptx.addSlide()
    const background = sourceSlide.background
    if (background) {
      if (background.type === 'solid' && background.color) {
        const color = parseColor(background.color)
        slide.background = { color: color.hex, transparency: Math.round((1 - color.alpha) * 100) }
      } else if (background.type === 'image' && background.image?.src) {
        try {
          const source = await loadImage(background.image.src, options.assetBase)
          slide.background = source.data ? { data: source.data } : { path: source.path }
        } catch (error) {
          warn(`第 ${slideIndex + 1} 页背景图加载失败：${String(error.message || error)}`)
        }
      } else if (background.type === 'gradient' && background.gradient) {
        const first = background.gradient.colors?.[0]?.color
        if (first) {
          const color = parseColor(first)
          slide.background = { color: color.hex, transparency: Math.round((1 - color.alpha) * 100) }
        }
        stats.approximated++
        warn(`第 ${slideIndex + 1} 页渐变背景以首个色标近似`)
      }
    }

    const elements = Array.isArray(sourceSlide.elements) ? sourceSlide.elements : []
    stats.elements += elements.length

    for (const element of elements) {
      try {
        if (element.type === 'text') {
          const { props } = htmlToTextProps(element.content, {
            ratioPx2Pt,
            defaultFont: element.defaultFontName || deck.theme?.fontName || DEFAULT_FONT,
            defaultColor: element.defaultColor || deck.theme?.fontColor || '#000000',
            defaultSize: 18,
          })
          const inset = Array.isArray(element.inset) ? element.inset : [10, 10, 10, 10]
          const textOptions = {
            x: toIn(element.left),
            y: toIn(element.top),
            w: toIn(element.width),
            h: toIn(element.height),
            valign: element.vAlign || 'top',
            margin: inset.map((value) => toPt(value)),
            lineSpacingMultiple: element.lineHeight ? element.lineHeight / 1.25 : 1.2,
            fit: element.fixedHeight ? 'none' : 'resize',
          }
          if (element.rotate) textOptions.rotate = element.rotate
          if (element.wordSpace) textOptions.charSpacing = toPt(element.wordSpace)
          if (element.opacity != null) textOptions.transparency = Math.round((1 - Number(element.opacity)) * 100)
          const fill = fillProps(element.fill)
          if (fill) textOptions.fill = fill
          const line = lineProps(element.outline, ratioPx2Pt)
          if (line) textOptions.line = line
          slide.addText(props, textOptions)
          stats.rendered++
        } else if (element.type === 'shape') {
          const shapeOptions = {
            x: toIn(element.left),
            y: toIn(element.top),
            w: toIn(element.width),
            h: toIn(element.height),
          }
          const fill = fillProps(element.fill)
          if (fill) shapeOptions.fill = fill
          const line = lineProps(element.outline, ratioPx2Pt)
          if (line) shapeOptions.line = line
          if (element.rotate) shapeOptions.rotate = element.rotate
          if (element.opacity != null) shapeOptions.transparency = Math.round((1 - Number(element.opacity)) * 100)
          slide.addShape(shapeTypeOf(pptx, element), shapeOptions)
          if (element.content && plainText(element.content)) {
            const { props } = htmlToTextProps(element.content, {
              ratioPx2Pt,
              defaultFont: element.defaultFontName || deck.theme?.fontName || DEFAULT_FONT,
              defaultColor: element.defaultColor || deck.theme?.fontColor || '#000000',
              defaultSize: 16,
            })
            slide.addText(props, {
              x: toIn(element.left),
              y: toIn(element.top),
              w: toIn(element.width),
              h: toIn(element.height),
              valign: element.vAlign || 'middle',
              margin: [toPt(8), toPt(8), toPt(8), toPt(8)],
              fit: 'resize',
            })
          }
          if (element.path && /[CQA]/i.test(String(element.path))) {
            stats.approximated++
            warn(`第 ${slideIndex + 1} 页形状 ${element.id || ''} 的自定义路径以矩形近似`)
          }
          stats.rendered++
        } else if (element.type === 'image') {
          const source = await loadImage(element.src, options.assetBase)
          const imageOptions = {
            x: toIn(element.left),
            y: toIn(element.top),
            w: toIn(element.width),
            h: toIn(element.height),
            ...source,
          }
          if (element.rotate) imageOptions.rotate = element.rotate
          if (element.flipH) imageOptions.flipH = true
          if (element.flipV) imageOptions.flipV = true
          slide.addImage(imageOptions)
          stats.rendered++
        } else if (element.type === 'line') {
          const start = Array.isArray(element.start) ? element.start : [0, 0]
          const end = Array.isArray(element.end) ? element.end : [element.width || 0, element.height || 0]
          /* 线条元素里 element.width 是描边宽度（PPTist SVG 的 stroke-width），
           * 包围盒要从 start/end 算，不能拿 element.width 当盒宽。 */
          const lineOptions = {
            x: toIn(element.left),
            y: toIn(element.top),
            w: Math.max(0.01, toIn(Math.abs(end[0] - start[0]))),
            h: Math.max(0.01, toIn(Math.abs(end[1] - start[1]))),
            flipV: end[1] < start[1],
            line: {
              color: parseColor(element.color || '#000000').hex,
              width: Math.max(0.25, toPt(element.width || 1)),
              dashType: DASH[element.style] || 'solid',
            },
          }
          slide.addShape(pptx.ShapeType.line, lineOptions)
          if (element.broken || element.curve || element.cubic || (Array.isArray(element.points) && element.points.length > 2)) {
            stats.approximated++
            warn(`第 ${slideIndex + 1} 页折线/曲线 ${element.id || ''} 以直线近似`)
          }
          stats.rendered++
        } else if (element.type === 'table') {
          const rows = (element.data || []).map((row) => row.map((cell) => ({
            text: cell && typeof cell === 'object' ? String(cell.text ?? '') : String(cell ?? ''),
            options: cellOptions(cell, ratioPx2Pt),
          })))
          if (!rows.length) { stats.skipped++; continue }
          const colWidths = Array.isArray(element.colWidths) && element.colWidths.length
            ? element.colWidths.map((width) => toIn(Number(width) * (element.width || 0)))
            : undefined
          const rowHeights = Array.isArray(element.rowHeights) && element.rowHeights.length
            ? element.rowHeights.map((height) => toIn(height))
            : undefined
          const tableOptions = {
            x: toIn(element.left),
            y: toIn(element.top),
            w: toIn(element.width),
            h: toIn(element.height),
            border: {
              type: 'solid',
              pt: Math.max(0.25, toPt(element.outline?.width || 1)),
              color: parseColor(element.outline?.color || '#d9d9d9').hex,
            },
            autoPage: false,
          }
          if (colWidths) tableOptions.colW = colWidths
          if (rowHeights) tableOptions.rowH = rowHeights
          slide.addTable(rows, tableOptions)
          stats.rendered++
        } else if (element.type === 'chart') {
          const spec = chartSpec(pptx, element)
          if (!spec) {
            stats.skipped++
            warn(`第 ${slideIndex + 1} 页图表 ${element.chartType || 'unknown'} 暂不支持导出`)
            continue
          }
          slide.addChart(spec.type, spec.data, {
            x: toIn(element.left),
            y: toIn(element.top),
            w: toIn(element.width),
            h: toIn(element.height),
            ...spec.options,
          })
          stats.rendered++
        } else {
          stats.skipped++
          stats.unsupportedTypes[element.type] = (stats.unsupportedTypes[element.type] || 0) + 1
          warn(`第 ${slideIndex + 1} 页包含暂不支持的 ${element.type} 元素`)
        }
      } catch (error) {
        stats.skipped++
        warn(`第 ${slideIndex + 1} 页元素 ${element.id || element.type} 导出失败：${String(error.message || error)}`)
      }
    }

    if (options.includeNotes !== false && sourceSlide.remark) {
      const notes = plainText(sourceSlide.remark)
      if (notes) slide.addNotes(notes)
    }
  }

  const buffer = await pptx.write({ outputType: 'nodebuffer' })
  return { buffer, stats }
}

export function safeFileName(value, fallback = 'presentation') {
  const name = String(value || fallback).replace(/[\\/:*?"<>|]/g, '_').trim()
  return name || fallback
}
