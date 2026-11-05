/** 导航能力：打开网址并返回首屏快照。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { runTool } from '../kernel/output.mjs'

export const navigationCapability = defineCapability({
  id: 'navigation',
  title: '导航',
  tags: ['core'],
  requires: ['engine'],
  features: ['browser.navigation'],
  tools: [
    defineTool({
      name: 'browser_navigate',
      description: '打开网址（仅 http/https；URL 内嵌用户名密码会被拒绝）。首次调用会自动拉起浏览器（默认有头可见，登录态持久化）。返回新页面的元素快照，后续动作直接引用其中的 ref。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', maxLength: 2048, description: '目标网址，如 https://example.com/' },
          tab: { type: 'string', maxLength: 16, description: '在指定标签页打开（缺省=当前活动标签页；浏览器未启动时自动新建）' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.navigate({ url: args.url, tab: args.tab })
        return `已打开 ${out.url} — ${out.title || '(无标题)'}（标签页 ${out.tab}）\n\n${out.snapshot.text}`
      }),
    }),
  ],
})
