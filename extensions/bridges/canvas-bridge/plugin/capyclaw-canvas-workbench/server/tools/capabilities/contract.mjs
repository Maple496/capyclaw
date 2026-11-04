/** 契约探测能力：版本、工具清单、能力清单与运行时状态。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const contractCapability = defineCapability({
  id: 'contract',
  title: '契约探测',
  tags: ['meta'],
  requires: ['status', 'contract'],
  features: ['canvas.contract'],
  tools: [
    defineTool({
      name: 'canvas_capabilities',
      description: '返回工作台契约版本、工具清单、能力清单与编辑器地址。skill 加载后先调用一次；工具缺失或 major 版本不一致时停止并提示升级。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'read',
      since: '1.0.0',
      handler: async (_args, ctx) => {
        let editorUrl = ''
        try { editorUrl = new URL(ctx.status.baseUrl()).origin + '/' } catch { /* 保持空字符串 */ }
        let runtime = { editorConnected: false, hasDoc: false, words: 0, seq: 0 }
        try {
          const status = await ctx.status.get()
          runtime = {
            editorConnected: !!status.owner,
            hasDoc: !!status.has_doc,
            words: Number(status.words || 0),
            seq: Number(status.seq || 0),
          }
        } catch { /* relay 不可用时仍返回静态契约 */ }
        return { text: JSON.stringify(ctx.contract.report(editorUrl, runtime), null, 2) }
      },
    }),
  ],
})
