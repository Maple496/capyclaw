/** 观察能力：无障碍风格的元素快照（ref 引用的唯一来源）。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { runTool } from '../kernel/output.mjs'

export const snapshotCapability = defineCapability({
  id: 'snapshot',
  title: '页面快照',
  tags: ['core'],
  requires: ['engine'],
  features: ['browser.snapshot'],
  tools: [
    defineTool({
      name: 'browser_snapshot',
      description: '观察当前页面：返回可交互元素（链接/按钮/输入框/下拉…）与结构节点（标题/图片）的缩进文本树，每个元素带 ref=eN。click/fill/select 等动作只用 ref 定位；页面变化后 ref 会过期（报 STALE_SNAPSHOT），重新快照即可。',
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'string', maxLength: 16, description: '目标标签页 id（缺省=当前活动标签页）' },
        },
        additionalProperties: false,
      },
      kind: 'read',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.snapshot({ tab: args.tab })
        return `# ${out.title || '(无标题)'}\n${out.url}（标签页 ${out.tab}，${out.elements} 个元素${out.truncated ? '，已截断' : ''}）\n\n${out.text}`
      }),
    }),
  ],
})
