/** 表格能力：把二维数据直接变成 PPTist 原生表格，支持表头样式与单元格精修。 */
import { clamp, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const tableCapability = defineCapability({
  id: 'table',
  title: '表格',
  tags: ['write', 'data'],
  requires: ['deck'],
  features: ['deck.table'],
  tools: [
    defineTool({
      name: 'ppt_table',
      description:
        '插入或整体更新表格（PPTist 原生表格）。rows 为二维数组，字符串/数字直接作单元格；' +
        'header: true 时首行渲染为加粗底色表头。带 element_id 时整体替换该表格数据。',
      inputSchema: {
        type: 'object',
        properties: {
          slide: { type: 'integer', description: '0 起页号，默认 0' },
          rows: {
            type: 'array',
            description: '二维数组，如 [["区域","目标"],["华东",70],["华南",66]]；单元格也可用对象 {text, bold, color, backcolor, align, fontsize}',
            items: { type: 'array' },
          },
          header: { type: 'boolean', description: '首行作为表头（加粗 + 主题色浅底）' },
          theme_color: { type: 'string', description: '表格主题色（表头底色由此淡化生成），默认 #5b9bd5' },
          element_id: { type: 'string', description: '更新模式：整体替换该表格的数据/列宽' },
          col_widths: { type: 'array', items: { type: 'number' }, description: '列宽比例或像素（自动归一）' },
          cell_min_height: { type: 'number', description: '单元格最小高度，默认 36' },
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['slide', 'rows'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.2.0',
      handler: async (args, ctx) => {
        const i = clamp(Number(args.slide) | 0, 0, 999)
        const p = args || {}
        if (p.element_id) {
          const props = {}
          if (p.rows != null) {
            // 整体替换：重建 data，保留原主题色
            const element = { rows: p.rows, header: Boolean(p.header), themeColor: p.theme_color }
            const r0 = await ctx.deck.write([{ op: 'remove-element', slide: i, elementId: String(p.element_id) }])
            if (!r0.ok) return { text: `替换失败：${r0.error}` }
            const r = await ctx.deck.write([{ op: 'add-table', slide: i, element }])
            return okText(r, `已重建表格 ${p.element_id}`)
          }
          if (p.theme_color) props.themeColor = p.theme_color
          if (p.header != null) props.rowHeader = Boolean(p.header)
          if (Array.isArray(p.col_widths)) props.colWidths = p.col_widths
          for (const k of ['left', 'top', 'width', 'height']) {
            if (p[k] != null) props[k] = p[k]
          }
          const r = await ctx.deck.write([{ op: 'update-table', slide: i, elementId: String(p.element_id), props }])
          return okText(r, `已更新表格 ${p.element_id}`)
        }
        const element = {
          rows: p.rows,
          header: Boolean(p.header),
          ...(p.theme_color ? { themeColor: p.theme_color } : {}),
          ...(Array.isArray(p.col_widths) ? { colWidths: p.col_widths } : {}),
          ...(p.cell_min_height != null ? { cellMinHeight: p.cell_min_height } : {}),
        }
        for (const k of ['left', 'top', 'width', 'height']) {
          if (p[k] != null) element[k] = p[k]
        }
        const r = await ctx.deck.write([{ op: 'add-table', slide: i, element }])
        return okText(r, `已在第 ${i} 页插入表格（${p.rows.length} 行）`)
      },
    }),

    defineTool({
      name: 'ppt_table_cells',
      description:
        '精修已有表格的单元格：改文字 / 加粗 / 颜色 / 底色 / 对齐 / 字号，也可换表格主题色。' +
        '行号列号从 0 起，元素 id 可用 ppt_get_deck 查询。',
      inputSchema: {
        type: 'object',
        properties: {
          slide: { type: 'integer', description: '0 起页号，默认 0' },
          element_id: { type: 'string', description: '表格元素 id' },
          cells: {
            type: 'array',
            description: '单元格补丁列表',
            items: {
              type: 'object',
              properties: {
                row: { type: 'integer', description: '0 起行号' },
                col: { type: 'integer', description: '0 起列号' },
                text: { type: 'string' },
                bold: { type: 'boolean' },
                color: { type: 'string', description: '文字颜色' },
                backcolor: { type: 'string', description: '单元格底色' },
                align: { type: 'string', enum: ['left', 'center', 'right'] },
                fontsize: { type: 'number' },
              },
              required: ['row', 'col'],
              additionalProperties: false,
            },
          },
          theme_color: { type: 'string', description: '顺带更换表格主题色' },
        },
        required: ['slide', 'element_id', 'cells'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.2.0',
      handler: async ({ slide, element_id, cells, theme_color }, ctx) => {
        const i = clamp(Number(slide) | 0, 0, 999)
        const r = await ctx.deck.write([{
          op: 'set-table-cells',
          slide: i,
          elementId: String(element_id),
          cells,
          ...(theme_color ? { themeColor: theme_color } : {}),
        }])
        return okText(r, `已更新表格 ${element_id} 的 ${Array.isArray(cells) ? cells.length : 0} 个单元格`)
      },
    }),
  ],
})
