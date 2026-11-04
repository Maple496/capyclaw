/** 撤销/重做能力。 */
import { okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const historyCapability = defineCapability({
  id: 'history',
  title: '撤销重做',
  tags: ['control'],
  requires: ['deck'],
  features: ['deck.undo'],
  tools: [
    defineTool({
      name: 'ppt_history',
      description: '撤销/重做。',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['undo', 'redo'] } },
        required: ['action'],
        additionalProperties: false,
      },
      kind: 'control',
      since: '1.0.0',
      handler: async ({ action }, ctx) => {
        const r = await ctx.deck.write([{ op: String(action) }])
        return okText(r, action === 'undo' ? '已撤销' : '已重做')
      },
    }),
  ],
})
