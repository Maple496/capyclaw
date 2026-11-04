/** 底层指令逃生口：一次提交任意 op 数组。 */
import { okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const applyCapability = defineCapability({
  id: 'apply',
  title: '底层指令',
  tags: ['advanced'],
  requires: ['deck'],
  features: ['deck.write'],
  tools: [
    defineTool({
      name: 'ppt_apply',
      description: '通用逃生口：一次提交任意底层指令数组（load / update-slide / add-element / set-background / theme / …），复杂组合动作用。',
      inputSchema: {
        type: 'object',
        properties: {
          ops: { type: 'array', maxItems: 100, items: { type: 'object' }, description: '底层 op 数组（≤100）' },
          title: { type: 'string', maxLength: 120, description: 'deck 标题（可选）' },
        },
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async ({ ops, title }, ctx) => {
        const list = Array.isArray(ops) ? ops : []
        if (!list.length && !title) throw new Error('ops 为空且未提供 title：请提供操作或标题')
        const r = await ctx.deck.write(list, title)
        return okText(r, list.length ? `已应用 ${list.length} 条指令` : '已更新标题')
      },
    }),
  ],
})
