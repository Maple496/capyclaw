/** 读 deck 能力。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const deckCapability = defineCapability({
  id: 'deck',
  title: '读取演示文稿',
  tags: ['read'],
  requires: ['deck'],
  features: ['deck.read'],
  tools: [
    defineTool({
      name: 'ppt_get_deck',
      description: '读当前演示文稿：标题、每页背景/元素。需要精确定位（页号/元素 id）时调用；改背景/加页/改首个文本不要先读。',
      inputSchema: {
        type: 'object',
        properties: { detailed: { type: 'boolean', description: '元素几何/颜色等细节（缺省只给摘要）' } },
        additionalProperties: false,
      },
      kind: 'read',
      since: '1.0.0',
      handler: async ({ detailed }, ctx) => {
        const doc = await ctx.deck.read()
        return { text: ctx.deck.summarize(doc.deck, !!detailed) }
      },
    }),
  ],
})
