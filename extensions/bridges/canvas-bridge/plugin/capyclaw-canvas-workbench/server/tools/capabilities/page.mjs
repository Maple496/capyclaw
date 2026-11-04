/** 页面设置能力：纸张/方向/边距（exec 透传到编辑器内核）。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText } from '../../bridge-client.mjs'

export const pageCapability = defineCapability({
  id: 'page',
  title: '页面设置',
  description: '纸张大小/方向/页边距/分栏：透传 CanvasApp 的 paperSize/paperDirection/setPaperMargin/setColumns 命令。',
  tags: ['layout'],
  requires: ['editor'],
  features: ['page.setup'],
  tools: [
    defineTool({
      name: 'canvas_page_setup',
      description: '页面设置：size（A4/A3/A5/B4/B5/Letter/Legal）、direction（vertical/horizontal）、margins([上,右,下,左])、columns（分栏数）。只传要改的字段。',
      inputSchema: {
        type: 'object',
        properties: {
          size: { type: 'string', enum: ['A4', 'A3', 'A5', 'B4', 'B5', 'Letter', 'Legal'], description: '纸张大小' },
          direction: { type: 'string', enum: ['vertical', 'horizontal'], description: '纸张方向' },
          margins: { type: 'array', items: { type: 'number' }, description: '页边距 [上,右,下,左]（pt）' },
          columns: { type: 'number', description: '分栏数（1-4）' },
          column_gap: { type: 'number', description: '栏间距（默认 16）' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const cmds = []
        if (args.size) cmds.push({ cmd: 'paperSize', args: [args.size] })
        if (args.direction) cmds.push({ cmd: 'paperDirection', args: [args.direction] })
        if (Array.isArray(args.margins) && args.margins.length === 4) {
          cmds.push({ cmd: 'setPaperMargin', args: [args.margins.map(Number)] })
        }
        if (args.columns) {
          const count = Math.max(1, Math.min(4, Number(args.columns) | 0))
          cmds.push({ cmd: 'setColumns', args: [[{ count, gap: Number(args.column_gap) || 16 }]] })
        }
        if (!cmds.length) throw new Error('至少提供 size/direction/margins/columns 之一')
        await ctx.editor.require()
        const r = await ctx.doc.write(cmds, args.title || '页面设置')
        return okText(r, '已应用页面设置')
      },
    }),
  ],
})
