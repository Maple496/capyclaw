/** 图表能力：把数据直接变成 PPTist 原生图表（echarts 渲染，不再手绘形状拼图）。 */
import { CHART_TYPES } from '../../../core/chart.js'
import { clamp, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

const chartDataDesc =
  '数据，支持多种格式：{labels:[...], series:[[...]]} / {labels:[...], values:[...]} 单系列 / ' +
  '{headers:[...], rows:[[...]]} 表格式（首列类目，其余列系列） / {items:[[name,value]...]} 饼图式'

export const chartCapability = defineCapability({
  id: 'chart',
  title: '图表',
  tags: ['write', 'data'],
  requires: ['deck'],
  features: ['deck.chart'],
  tools: [
    defineTool({
      name: 'ppt_chart',
      description:
        '插入或更新图表（PPTist 原生 echarts 图表）。给定数据即可生成柱/条/折线/面积/饼/环/雷达/散点图，' +
        '支持多种数据格式（labels+series、表格 rows、键值对 items）。带 element_id 时为更新已有图表。',
      inputSchema: {
        type: 'object',
        properties: {
          slide: { type: 'integer', description: '0 起页号，默认 0' },
          chart_type: { type: 'string', enum: CHART_TYPES, description: '图表类型，新增必填' },
          data: { type: 'object', description: chartDataDesc },
          element_id: { type: 'string', description: '更新模式：要更新的图表元素 id' },
          options: {
            type: 'object',
            description: '渲染选项 {lineSmooth?:折线平滑, stack?:堆叠}',
            properties: {
              lineSmooth: { type: 'boolean' },
              stack: { type: 'boolean' },
            },
            additionalProperties: false,
          },
          colors: { type: 'array', items: { type: 'string' }, description: '系列配色（缺省用幻灯片主题色）' },
          text_color: { type: 'string', description: '图表文字颜色' },
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['slide'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.2.0',
      handler: async (args, ctx) => {
        const i = clamp(Number(args.slide) | 0, 0, 999)
        const p = args || {}
        if (p.element_id) {
          const props = {}
          if (p.chart_type) props.chartType = p.chart_type
          if (p.data != null) props.data = p.data
          if (p.options != null) props.options = p.options
          if (Array.isArray(p.colors)) props.colors = p.colors
          if (p.text_color) props.textColor = p.text_color
          for (const k of ['left', 'top', 'width', 'height']) {
            if (p[k] != null) props[k] = p[k]
          }
          const r = await ctx.deck.write([{ op: 'update-chart', slide: i, elementId: String(p.element_id), props }])
          return okText(r, `已更新图表 ${p.element_id}`)
        }
        if (!p.chart_type) throw new Error('新增图表需要 chart_type（' + CHART_TYPES.join('/') + '）')
        if (p.data == null) throw new Error('新增图表需要 data（' + chartDataDesc + '）')
        const element = {
          chartType: p.chart_type,
          data: p.data,
          ...(p.options != null ? { options: p.options } : {}),
          ...(Array.isArray(p.colors) ? { colors: p.colors } : {}),
          ...(p.text_color ? { textColor: p.text_color } : {}),
        }
        for (const k of ['left', 'top', 'width', 'height']) {
          if (p[k] != null) element[k] = p[k]
        }
        const r = await ctx.deck.write([{ op: 'add-chart', slide: i, element }])
        return okText(r, `已在第 ${i} 页插入 ${p.chart_type} 图表`)
      },
    }),
  ],
})
