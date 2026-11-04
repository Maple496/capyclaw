/** 表格编辑能力：镜像层结构操作（改单元格/行列增删/合并），不依赖编辑器光标。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText } from '../../bridge-client.mjs'
import { readMirror, writeMirror, normalizeZones } from '../domains/mirror.mjs'

/** 找第 index 个表格元素（正文顺序）。 */
function findTables(doc) {
  const tables = []
  const main = Array.isArray(doc.main) ? doc.main : []
  main.forEach((el, i) => { if (el && el.type === 'table' && Array.isArray(el.trList)) tables.push({ el, index: i }) })
  return tables
}

function cellOf(table, row, col) {
  const tr = table.trList[row]
  if (!tr) throw new Error(`行 ${row} 不存在（共 ${table.trList.length} 行）`)
  /* 跨列偏移：按 colspan 展开后的逻辑列号 */
  let logical = 0
  for (const td of tr.tdList || []) {
    if (logical <= col && col < logical + (td.colspan || 1)) return td
    logical += td.colspan || 1
  }
  throw new Error(`列 ${col} 不存在`)
}

function setCellText(td, text) {
  td.value = [{ value: String(text) }, { value: '\n' }]
}

export const tableCapability = defineCapability({
  id: 'table',
  title: '表格编辑',
  description: '镜像层表格结构操作：单元格文本/样式、行列增删、合并拆分；确定性结果，无需编辑器选区。',
  tags: ['content'],
  requires: ['doc', 'editor'],
  features: ['table.edit'],
  tools: [
    defineTool({
      name: 'canvas_table',
      description: '表格结构操作（table: 第几个表格，从 0 起）。setCell 改单元格文本/背景；insertRow/deleteRow/insertCol/deleteCol 增删行列；merge 合并区域单元格。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['setCell', 'insertRow', 'deleteRow', 'insertCol', 'deleteCol', 'merge'], description: '操作' },
          table: { type: 'number', description: '表格序号（默认 0）' },
          row: { type: 'number', description: '行号（setCell/insertRow 在该行上方插入/deleteRow 删该行）' },
          col: { type: 'number', description: '列号（insertCol 在该列左侧插入/deleteCol 删该列）' },
          text: { type: 'string', description: 'setCell：单元格文本' },
          backgroundColor: { type: 'string', description: 'setCell：单元格背景色（可选）' },
          toRow: { type: 'number', description: 'merge：结束行' },
          toCol: { type: 'number', description: 'merge：结束列' },
          title: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const doc = normalizeZones(await readMirror(ctx))
        const tables = findTables(doc)
        if (!tables.length) throw new Error('文档里没有表格：先用 canvas_insert_table 插入')
        const t = Math.max(0, Math.min(tables.length - 1, Number(args.table) || 0))
        const table = tables[t].el
        const cols = (table.trList[0] && table.trList[0].tdList || []).reduce((n, td) => n + (td.colspan || 1), 0)

        const mkCell = () => ({ colspan: 1, rowspan: 1, value: [{ value: '' }, { value: '\n' }], verticalAlign: 'middle' })

        if (args.action === 'setCell') {
          const td = cellOf(table, Number(args.row), Number(args.col))
          if (args.text !== undefined) setCellText(td, args.text)
          if (args.backgroundColor) td.backgroundColor = String(args.backgroundColor)
        } else if (args.action === 'insertRow') {
          const at = Math.max(0, Math.min(table.trList.length, Number(args.row) || 0))
          table.trList.splice(at, 0, { height: 36, minHeight: 36, tdList: Array.from({ length: cols }, mkCell) })
        } else if (args.action === 'deleteRow') {
          const at = Number(args.row)
          if (!(at >= 0 && at < table.trList.length)) throw new Error(`行 ${at} 不存在`)
          table.trList.splice(at, 1)
        } else if (args.action === 'insertCol') {
          const at = Math.max(0, Math.min(cols, Number(args.col) || 0))
          for (const tr of table.trList) {
            let logical = 0
            let inserted = false
            const next = []
            for (const td of tr.tdList || []) {
              if (!inserted && logical === at) { next.push(mkCell()); inserted = true }
              next.push(td)
              logical += td.colspan || 1
            }
            if (!inserted) next.push(mkCell())
            tr.tdList = next
          }
          const width = table.colgroup && table.colgroup.length
            ? Math.max(60, Math.floor(table.colgroup.reduce((n, c) => n + (c.width || 100), 0) / (table.colgroup.length + 1)))
            : 100
          table.colgroup = table.colgroup || []
          table.colgroup.splice(Math.min(at, table.colgroup.length), 0, { width })
        } else if (args.action === 'deleteCol') {
          const at = Number(args.col)
          if (!(at >= 0 && at < cols)) throw new Error(`列 ${at} 不存在`)
          for (const tr of table.trList) {
            let logical = 0
            tr.tdList = (tr.tdList || []).filter((td) => {
              const start = logical
              logical += td.colspan || 1
              return !(at >= start && at < logical)
            })
          }
          if (table.colgroup) table.colgroup.splice(Math.min(at, table.colgroup.length - 1), 1)
        } else if (args.action === 'merge') {
          const r1 = Number(args.row)
          const c1 = Number(args.col)
          const r2 = args.toRow === undefined ? r1 : Number(args.toRow)
          const c2 = args.toCol === undefined ? c1 : Number(args.toCol)
          if (!(r2 >= r1 && c2 >= c1)) throw new Error('merge 需要 toRow/toCol 不小于 row/col')
          const first = cellOf(table, r1, c1)
          const texts = []
          for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
              if (r === r1 && c === c1) continue
              try {
                const td = cellOf(table, r, c)
                texts.push(...(td.value || []).filter((e) => typeof e.value === 'string' && e.value !== '\n'))
                td.value = []
                td.rowspan = 1
                td.colspan = 1
                td._merged = true
              } catch { /* 越界忽略 */ }
            }
          }
          first.rowspan = r2 - r1 + 1
          first.colspan = c2 - c1 + 1
          if (texts.length) first.value = [...texts, { value: '\n' }]
          /* 清理被吞单元格：canvas-editor 用 rowspan/colspan + 后续单元格缺席表达合并 */
          for (const tr of table.trList) {
            tr.tdList = (tr.tdList || []).filter((td) => !td._merged)
          }
        }

        const r = await writeMirror(ctx, doc, args.title || `表格 ${args.action}`)
        return okText(r, `表格#${t} 已${args.action}`)
      },
    }),
  ],
})
