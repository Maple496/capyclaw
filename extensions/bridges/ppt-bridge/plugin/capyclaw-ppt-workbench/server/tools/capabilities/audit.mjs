/** 确定性 deck 审计能力。 */
import { auditDeck } from '../../../core/audit.js'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const auditCapability = defineCapability({
  id: 'audit',
  title: '确定性审计',
  tags: ['read', 'quality'],
  requires: ['deck'],
  features: ['deck.audit'],
  tools: [
    defineTool({
      name: 'ppt_audit',
      description: '确定性审计当前 deck：文字越界/溢出/重叠、同文案重复、文字隐形/被遮挡、有效背景对比度、重复版式、配色漂移、重复图片、页面密度。返回 pass/blocking；交付前或截图前调用，pass=false 不得说审计通过。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'read',
      since: '2.1.0',
      handler: async (args, ctx) => {
        const doc = await ctx.deck.read()
        return { text: JSON.stringify(auditDeck(doc.deck), null, 2) }
      },
    }),
  ],
})
