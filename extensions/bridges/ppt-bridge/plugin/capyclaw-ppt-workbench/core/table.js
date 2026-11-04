/**
 * 表格元素纯函数：数据归一化 + 元素构建（零 DOM，node:test 直测）。
 *
 * PPTist table 元素结构（编辑器原生渲染）：
 *   { type:'table', data:[[cell...]], colWidths:[比例...], rowHeights?, cellMinHeight,
 *     theme:{ color, rowHeader, rowFooter, colHeader, colFooter },
 *     outline:{ style, width, color } }
 * cell = { id, colspan, rowspan, text, style?{ bold, color, backcolor, align, fontsize } }
 *
 * buildTableData 支持直接丢二维数组（字符串/数字/对象混合）。
 */

import { parseColor } from './color.js'

/** 表格缺省主题色（与编辑器模板主题色同族）。 */
export const DEFAULT_TABLE_COLOR = '#5b9bd5'

const isNum = (v) => typeof v === 'number' && isFinite(v)

/** 生成 cell id。 */
const cellId = (r, c) => `c${r + 1}_${c + 1}`

/**
 * 颜色加白（tint）：把主题色向白色混合，用于表头底色。
 * @param {string} color 任意可解析颜色
 * @param {number} ratio 0~1，越大越浅
 */
export function tint(color, ratio = 0.85) {
  const rgb = parseColor(String(color || DEFAULT_TABLE_COLOR))
  if (!rgb) return '#f2f6fc'
  const mix = (ch) => Math.round(ch + (255 - ch) * ratio)
  const to2 = (n) => n.toString(16).padStart(2, '0')
  return `#${to2(mix(rgb[0]))}${to2(mix(rgb[1]))}${to2(mix(rgb[2]))}`
}

/** 单元格样式白名单。 */
const CELL_STYLE_KEYS = ['bold', 'italic', 'underline', 'strikethrough', 'color', 'backcolor', 'align', 'fontsize', 'fontname']

/** 归一化单元格：字符串/数字 → 纯文本 cell；对象 → 文本 + 样式白名单。 */
export function normalizeCell(input, r, c) {
  const base = { id: input && input.id ? String(input.id) : cellId(r, c), colspan: 1, rowspan: 1, text: '' }
  if (input == null) return base
  if (typeof input === 'string' || isNum(input)) {
    base.text = String(input)
    return base
  }
  if (typeof input !== 'object') throw new Error(`表格单元格格式错误（第 ${r + 1} 行第 ${c + 1} 列）`)
  base.text = String(input.text != null ? input.text : '')
  if (Number(input.colspan) > 1) base.colspan = Math.floor(Number(input.colspan))
  if (Number(input.rowspan) > 1) base.rowspan = Math.floor(Number(input.rowspan))
  const style = {}
  for (const k of CELL_STYLE_KEYS) {
    if (input[k] != null) style[k] = input[k]
  }
  if (Object.keys(style).length) base.style = style
  return base
}

/**
 * 构建表格 data。
 * @param {Array<Array>} rows 二维数组（必填）
 * @param {object} opts { header?: boolean 首行表头, themeColor?: string }
 */
export function buildTableData(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('表格数据 rows 不能为空')
  if (!Array.isArray(rows[0]) || rows[0].length === 0) throw new Error('表格 rows 必须是二维数组')

  const width = rows[0].length
  const themeColor = opts.themeColor ? String(opts.themeColor) : DEFAULT_TABLE_COLOR
  const header = Boolean(opts.header)

  return rows.map((row, r) => {
    if (!Array.isArray(row) || row.length !== width) {
      throw new Error(`表格第 ${r + 1} 行列数(${Array.isArray(row) ? row.length : 0})与首行(${width})不一致`)
    }
    return row.map((input, c) => {
      const cell = normalizeCell(input, r, c)
      if (opts.header && r === 0) {
        cell.style = {
          bold: true,
          backcolor: tint(themeColor, 0.88),
          ...(cell.style && typeof cell.style === 'object' ? cell.style : {}),
        }
      }
      return cell
    })
  })
}

/**
 * 归一化列宽：比例（和≈1）直通；像素值（和>1.5）自动归一为比例。
 */
export function normalizeColWidths(colWidths, cols) {
  if (!Array.isArray(colWidths) || colWidths.length === 0) {
    return Array.from({ length: cols }, () => 1 / cols)
  }
  if (colWidths.length !== cols) {
    throw new Error(`colWidths 长度(${colWidths.length})与列数(${cols})不一致`)
  }
  const nums = colWidths.map(Number)
  if (nums.some((n) => !isFinite(n) || n <= 0)) throw new Error('colWidths 必须是正数')
  const sum = nums.reduce((a, b) => a + b, 0)
  if (sum <= 1.5) {
    // 已是比例：按总和归一兜底
    return nums.map((n) => n / sum)
  }
  return nums.map((n) => n / sum)
}

/**
 * 构建表格元素。
 * @param {object} e { rows, header?, themeColor?, left/top/width/height?, colWidths?, cellMinHeight?, outline? }
 */
export function makeTableElement(e) {
  if (!e || typeof e !== 'object') throw new Error('表格元素必须是对象')
  const rows = e.rows
  const header = Boolean(e.header)
  const data = buildTableData(rows, { header, themeColor: e.themeColor })

  const cols = data[0].length
  const nRows = data.length
  const themeColor = e.themeColor ? String(e.themeColor) : DEFAULT_TABLE_COLOR
  const cellMinHeight = Number(e.cellMinHeight != null ? e.cellMinHeight : 36)
  const width = Number(e.width != null ? e.width : 640)
  const height = Number(e.height != null ? e.height : nRows * cellMinHeight)

  const el = {
    type: 'table',
    id: e.id || `table_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    left: Number(e.left != null ? e.left : Math.round((1000 - width) / 2)),
    top: Number(e.top != null ? e.top : 110),
    width,
    height,
    rotate: Number(e.rotate || 0),
    outline: e.outline && typeof e.outline === 'object'
      ? {
          style: String(e.outline.style || 'solid'),
          width: Number(e.outline.width != null ? e.outline.width : 1),
          color: String(e.outline.color || '#d9d9d9'),
        }
      : { style: 'solid', width: 1, color: '#d9d9d9' },
    theme: {
      color: themeColor,
      rowHeader: header,
      rowFooter: false,
      colHeader: Boolean(e.colHeader),
      colFooter: false,
    },
    colWidths: normalizeColWidths(e.colWidths, cols),
    cellMinHeight,
    data,
  }
  if (Array.isArray(e.rowHeights) && e.rowHeights.length === nRows) {
    el.rowHeights = e.rowHeights.map(Number)
  }
  return el
}

/**
 * 归一化单元格补丁（set-table-cells 用）：
 * [{row, col, text?, bold?, color?, backcolor?, align?, fontsize?}]
 */
export function normalizeCellPatches(cells) {
  if (!Array.isArray(cells) || cells.length === 0) throw new Error('cells 不能为空')
  return cells.map((c, i) => {
    if (!c || typeof c !== 'object' || !isNum(Number(c.row)) || !isNum(Number(c.col))) {
      throw new Error(`cells[${i}] 需要 row / col`)
    }
    const patch = { row: Math.floor(Number(c.row)), col: Math.floor(Number(c.col)) }
    if (c.text != null) patch.text = String(c.text)
    const style = {}
    for (const k of CELL_STYLE_KEYS) {
      if (c[k] != null) style[k] = c[k]
    }
    if (Object.keys(style).length) patch.style = style
    return patch
  })
}
