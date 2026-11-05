/**
 * 脚本执行能力：默认关闭（安全默认），如实返回 NOT_IMPLEMENTED。
 *
 * 与 scrapling 的诚实边界同一口径：不伪造结果、返回结构化错误与开启方法。
 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { runTool } from '../kernel/output.mjs'

export const evaluateCapability = defineCapability({
  id: 'evaluate',
  title: '页面脚本',
  tags: ['advanced'],
  requires: ['engine'],
  features: ['browser.evaluate'],
  tools: [
    defineTool({
      name: 'browser_evaluate',
      description: '在页面里执行 JS 表达式并返回结果。默认关闭（安全默认）；关闭时返回 NOT_IMPLEMENTED 与开启方法。优先用快照+ref 完成任务，本工具留给快照覆盖不了的场景。',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', maxLength: 20000, description: 'JS 表达式（如 document.title）' },
          tab: { type: 'string', maxLength: 16, description: '目标标签页 id（缺省=当前活动标签页）' },
        },
        required: ['script'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.evaluate({ script: args.script, tab: args.tab })
        return JSON.stringify({ tab: out.tab, result: out.result }, null, 2)
      }),
    }),
  ],
})
