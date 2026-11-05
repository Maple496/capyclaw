/** 截图能力：PNG 落盘并返回绝对路径。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { runTool } from '../kernel/output.mjs'

export const screenshotCapability = defineCapability({
  id: 'screenshot',
  title: '页面截图',
  tags: ['verify'],
  requires: ['engine', 'server'],
  features: ['browser.screenshot'],
  tools: [
    defineTool({
      name: 'browser_screenshot',
      description: '当前页面截图（PNG 保存到本机，返回绝对路径）。默认视口截图；fullPage=true 截整页。工作台地址可实时观察页面。',
      inputSchema: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: '是否截取整页（默认 false）' },
          tab: { type: 'string', maxLength: 16, description: '目标标签页 id（缺省=当前活动标签页）' },
        },
        additionalProperties: false,
      },
      kind: 'read',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.screenshot({ fullPage: args.fullPage, tab: args.tab })
        let workbench = ''
        try { workbench = ctx.server.url() } catch { /* 未注入则省略 */ }
        return `截图已保存: ${out.path}（${out.bytes} 字节）${workbench ? `\n工作台实时画面: ${workbench}` : ''}`
      }),
    }),
  ],
})
