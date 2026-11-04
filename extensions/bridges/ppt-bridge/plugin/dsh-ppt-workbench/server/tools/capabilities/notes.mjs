/** 备注能力：演讲者备注（编辑器备注面板直接显示）。 */
import { clamp, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const notesCapability = defineCapability({
  id: 'notes',
  title: '演讲备注',
  tags: ['write', 'content'],
  requires: ['deck'],
  features: ['deck.notes'],
  tools: [
    defineTool({
      name: 'ppt_notes',
      description: '设置指定页的演讲者备注（显示在编辑器备注面板，导出 PPTX 一并保留）。传空字符串清空。',
      inputSchema: {
        type: 'object',
        properties: {
          slide: { type: 'integer', description: '0 起页号' },
          notes: { type: 'string', maxLength: 2000, description: '备注内容；空字符串清空' },
        },
        required: ['slide', 'notes'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.2.0',
      handler: async ({ slide, notes }, ctx) => {
        const i = clamp(Number(slide) | 0, 0, 999)
        const r = await ctx.deck.write([{ op: 'set-notes', slide: i, notes: String(notes || '') }])
        return okText(r, notes ? `已设置第 ${i} 页备注` : `已清空第 ${i} 页备注`)
      },
    }),
  ],
})
