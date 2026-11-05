/** 会话能力：状态 / 等待 / 历史 / 关闭浏览器。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { runTool } from '../kernel/output.mjs'

const TAB_PROP = { type: 'string', maxLength: 16, description: '目标标签页 id（缺省=当前活动标签页）' }

export const sessionCapability = defineCapability({
  id: 'session',
  title: '会话管理',
  tags: ['core'],
  requires: ['engine'],
  features: ['browser.session'],
  tools: [
    defineTool({
      name: 'browser_status',
      description: '引擎状态：是否运行、有头/无头、标签页清单（id+地址）、累计动作数、最近动作日志。不确定浏览器是否还活着时先看它。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'read',
      since: '1.0.0',
      handler: async (_args, ctx) => runTool(() => {
        const status = ctx.engine.status()
        return JSON.stringify({ ...status, recentActions: ctx.engine.actionLog().slice(0, 8) }, null, 2)
      }),
    }),
    defineTool({
      name: 'browser_wait',
      description: '等待：ms=毫秒；selector=等元素出现（如 .result）；都不给=等页面 load 完成。动作后页面还在加载/渲染时用它。',
      inputSchema: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: '等待毫秒数（上限 30000）' },
          selector: { type: 'string', maxLength: 300, description: '等待出现的 CSS 选择器' },
          tab: TAB_PROP,
        },
        additionalProperties: false,
      },
      kind: 'control',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.wait({ ms: args.ms, selector: args.selector, tab: args.tab })
        return `已等待完成（标签页 ${out.tab}）`
      }),
    }),
    defineTool({
      name: 'browser_history',
      description: '浏览历史：back 后退 / forward 前进 / reload 重载。返回操作后的新快照。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['back', 'forward', 'reload'], description: '动作（默认 back）' },
          tab: TAB_PROP,
        },
        additionalProperties: false,
      },
      kind: 'control',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.history({ action: args.action, tab: args.tab })
        const label = args.action === 'reload' ? '已重载' : args.action === 'forward' ? '已前进到' : '已后退到'
        return `${label} ${out.url}（标签页 ${out.tab}）\n\n${out.snapshot.text}`
      }),
    }),
    defineTool({
      name: 'browser_close',
      description: '关闭浏览器（所有标签页）。登录态与 profile 持久化，下次 navigate 自动重启浏览器并保留登录。任务结束或页面卡死时用它重置。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'control',
      since: '1.0.0',
      handler: async (_args, ctx) => runTool(async () => {
        const out = await ctx.engine.close()
        return out.closed ? '浏览器已关闭（登录态已持久化，下次 navigate 自动重启）' : '浏览器本就未在运行'
      }),
    }),
  ],
})
