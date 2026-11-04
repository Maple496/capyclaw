/** 线条能力：直线/虚线/折线连接（含端点箭头），坐标用画布绝对值，方向免算。 */
import { clamp, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

const POINT_STYLES = ['none', 'arrow', 'triangle', 'dot', 'square']

const pointOf = (v) => (v && v !== 'none' ? String(v) : '')

export const lineCapability = defineCapability({
  id: 'line',
  title: '线条',
  tags: ['write', 'layout'],
  requires: ['deck'],
  features: ['deck.line'],
  tools: [
    defineTool({
      name: 'ppt_line',
      description:
        '画一条线（直线 / 虚线 / 折线）。给起点终点画布坐标即可，包围盒自动计算；' +
        '端点箭头可选 arrow / triangle / dot / square；broken 给拐点画布坐标可画折线。',
      inputSchema: {
        type: 'object',
        properties: {
          slide: { type: 'integer', description: '0 起页号，默认 0' },
          x1: { type: 'number', description: '起点 x（画布坐标）' },
          y1: { type: 'number', description: '起点 y' },
          x2: { type: 'number', description: '终点 x' },
          y2: { type: 'number', description: '终点 y' },
          color: { type: 'string', description: '线色，默认 #5b9bd5' },
          style: { type: 'string', enum: ['solid', 'dashed'], description: '默认 solid' },
          width: { type: 'number', description: '线宽，默认 2' },
          start_point: { type: 'string', enum: POINT_STYLES, description: '起点箭头，默认 none' },
          end_point: { type: 'string', enum: POINT_STYLES, description: '终点箭头，默认 none' },
          broken: { type: 'array', items: { type: 'number' }, description: '折线拐点 [x, y]（画布坐标，产生 ┳ 型连接）' },
        },
        required: ['slide', 'x1', 'y1', 'x2', 'y2'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.2.0',
      handler: async (args, ctx) => {
        const i = clamp(Number(args.slide) | 0, 0, 999)
        const p = args || {}
        const element = {
          type: 'line',
          x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2,
          color: p.color || '#5b9bd5',
          style: p.style || 'solid',
          width: p.width != null ? p.width : 2,
          points: [pointOf(p.start_point), pointOf(p.end_point)],
          ...(Array.isArray(p.broken) && p.broken.length === 2 ? { broken: p.broken } : {}),
        }
        const r = await ctx.deck.write([{ op: 'add-element', slide: i, element }])
        return okText(r, `已在第 ${i} 页画线`)
      },
    }),
  ],
})
