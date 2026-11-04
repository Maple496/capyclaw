/** 表格 op：加表格 / 更新表格样式 / 精修单元格。数据归一化在 core/table.js。 */
import { makeTableElement, normalizeCellPatches, DEFAULT_TABLE_COLOR } from '../table.js'

function clone(P, i) {
  const slide = P.getSlides()[i]
  if (!slide) {
    const total = P.getSlides().length
    throw new Error(`页号越界：第 ${i} 页不存在（共 ${total} 页）`)
  }
  return JSON.parse(JSON.stringify(slide))
}

export const tableOps = {
  'add-table': {
    run(P, c) {
      const i = Number(c.slide != null ? c.slide : 0)
      const s = clone(P, i)
      const el = makeTableElement(c.element || {})
      s.elements.push(el)
      P.updateSlide(i, s)
      return el.id
    },
  },

  'update-table': {
    run(P, c) {
      const i = Number(c.slide != null ? c.slide : 0)
      const s = clone(P, i)
      const el = s.elements.find(e => e.id === c.elementId)
      if (!el) throw new Error('update-table 未命中: ' + c.elementId)
      if (el.type !== 'table') throw new Error(`元素 ${c.elementId} 不是表格（type=${el.type}）`)
      const p = c.props || {}
      if (p.themeColor != null) el.theme = { ...el.theme, color: String(p.themeColor) }
      if (p.rowHeader != null) el.theme.rowHeader = Boolean(p.rowHeader)
      if (p.colHeader != null) el.theme.colHeader = Boolean(p.colHeader)
      if (p.outline && typeof p.outline === 'object') {
        el.outline = {
          style: String(p.outline.style || el.outline.style || 'solid'),
          width: Number(p.outline.width != null ? p.outline.width : el.outline.width),
          color: String(p.outline.color || el.outline.color || '#d9d9d9'),
        }
      }
      if (Array.isArray(p.colWidths)) {
        const sum = p.colWidths.reduce((a, b) => a + Number(b || 0), 0)
        if (!isFinite(sum) || sum <= 0) throw new Error('colWidths 无效')
        el.colWidths = p.colWidths.map((n) => Number(n) / sum)
      }
      if (Array.isArray(p.rowHeights)) {
        if (p.rowHeights.length !== el.data.length) throw new Error('rowHeights 长度与行数不一致')
        el.rowHeights = p.rowHeights.map(Number)
      }
      if (p.cellMinHeight != null) el.cellMinHeight = Number(p.cellMinHeight)
      for (const k of ['left', 'top', 'width', 'height', 'rotate']) {
        if (p[k] != null && isFinite(Number(p[k]))) el[k] = Number(p[k])
      }
      P.updateSlide(i, s)
    },
  },

  'set-table-cells': {
    run(P, c) {
      const i = Number(c.slide != null ? c.slide : 0)
      const s = clone(P, i)
      const el = s.elements.find(e => e.id === c.elementId)
      if (!el) throw new Error('set-table-cells 未命中: ' + c.elementId)
      if (el.type !== 'table') throw new Error(`元素 ${c.elementId} 不是表格（type=${el.type}）`)
      const patches = normalizeCellPatches(c.cells || [])
      for (const p of patches) {
        const row = el.data[p.row]
        if (!row) throw new Error(`行越界：第 ${p.row} 行不存在（共 ${el.data.length} 行）`)
        const cell = row[p.col]
        if (!cell) throw new Error(`列越界：第 ${p.col} 列不存在（共 ${row.length} 列）`)
        if (p.text != null) cell.text = p.text
        if (p.style) {
          cell.style = { ...(cell.style || {}), ...p.style }
          if (Object.keys(cell.style).length === 0) delete cell.style
        }
      }
      if (c.themeColor != null && c.themeColor !== '') {
        el.theme = { ...el.theme, color: String(c.themeColor || DEFAULT_TABLE_COLOR) }
      }
      P.updateSlide(i, s)
    },
  },
}
