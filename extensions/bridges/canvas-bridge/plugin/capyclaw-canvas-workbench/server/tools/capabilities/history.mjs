/** 撤销/重做能力。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText } from '../../bridge-client.mjs'

export const historyCapability = defineCapability({
  id: 'history',
  title: '撤销重做',
  tags: ['control'],
  requires: ['editor'],
  features: ['doc.undo'],
  tools: [
    defineTool({
      name: 'canvas_history',
      description: '撤销/重做（编辑器 undo 栈；一次 setValue 是一条记录）。',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['undo', 'redo'] } },
        required: ['action'],
        additionalProperties: false,
      },
      kind: 'control',
      since: '1.0.0',
      handler: async ({ action }, ctx) => {
        await ctx.editor.require()
        const r = await ctx.doc.write([{ cmd: String(action), args: [] }], action === 'undo' ? '撤销' : '重做')
        return okText(r, action === 'undo' ? '已撤销' : '已重做')
      },
    }),
  ],
})
