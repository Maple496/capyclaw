/** 标签页能力：列出 / 新建 / 切换 / 关闭（稳定 id：T1、T2…）。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { runTool } from '../kernel/output.mjs'

export const tabsCapability = defineCapability({
  id: 'tabs',
  title: '标签页管理',
  tags: ['core'],
  requires: ['engine'],
  features: ['browser.tabs'],
  tools: [
    defineTool({
      name: 'browser_tabs',
      description: '标签页四合一：action=list 列出（含稳定 id 与当前地址）；new 打开新标签页（可带 url）；select 切换活动标签页；close 关闭。后续动作默认作用于活动标签页，也可用 tab 参数显式指定。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: '动作（默认 list）' },
          url: { type: 'string', maxLength: 2048, description: 'new 动作要打开的网址' },
          tab: { type: 'string', maxLength: 16, description: 'select/close 的目标标签页 id' },
        },
        additionalProperties: false,
      },
      kind: 'control',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.tabsAction({ action: args.action, url: args.url, tab: args.tab })
        if (args.action === 'new') return `已打开新标签页 ${out.tab}（${out.url || 'about:blank'}）\n\n${out.snapshot.text}`
        if (args.action === 'select') return `已切换到标签页 ${out.tab}\n\n${out.snapshot.text}`
        if (args.action === 'close') return `已关闭标签页 ${out.closed}，剩余 ${out.tabs.length} 个`
        return JSON.stringify(out, null, 2)
      }),
    }),
  ],
})
