/** 放映控制能力。 */
import { clamp, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const presentCapability = defineCapability({
  id: 'present',
  title: '放映',
  tags: ['control'],
  requires: ['deck'],
  features: ['deck.present'],
  tools: [
    defineTool({
      name: 'ppt_present',
      description: '放映控制：start（可指定起始页）/ exit。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'exit'] },
          slide: { type: 'integer', description: 'start 的起始页（0 起）' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      kind: 'control',
      since: '1.0.0',
      handler: async ({ action, slide }, ctx) => {
        const r = action === 'exit'
          ? await ctx.deck.write([{ op: 'exit-present' }])
          : await ctx.deck.write([{ op: 'present', index: slide != null ? clamp(Number(slide) | 0, 0, 999) : undefined }])
        return okText(r, action === 'exit' ? '已退出放映' : '已开始放映')
      },
    }),
  ],
})
