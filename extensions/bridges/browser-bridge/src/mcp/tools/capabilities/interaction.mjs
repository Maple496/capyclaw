/** 交互能力：点击 / 填写 / 按键 / 下拉选择 / 滚动（动作后自动返回新快照）。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { runTool } from '../kernel/output.mjs'

const TAB_PROP = { type: 'string', maxLength: 16, description: '目标标签页 id（缺省=当前活动标签页）' }

export const interactionCapability = defineCapability({
  id: 'interaction',
  title: '页面交互',
  tags: ['core'],
  requires: ['engine'],
  features: ['browser.interaction'],
  tools: [
    defineTool({
      name: 'browser_click',
      description: '点击元素。ref 来自最近一次 browser_navigate/browser_snapshot 的快照；元素已变化时报 STALE_SNAPSHOT，重新快照后用新 ref。动作成功后返回新快照。',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string', maxLength: 16, description: '快照里的元素引用，如 e5' }, tab: TAB_PROP },
        required: ['ref'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.click({ ref: args.ref, tab: args.tab })
        return `已点击 ${out.clicked}（标签页 ${out.tab}）\n\n${out.snapshot.text}`
      }),
    }),
    defineTool({
      name: 'browser_fill',
      description: '在输入框/文本域填写文字（整体替换，兼容 React/Vue 受控输入）。submit=true 时填写后按回车提交。密码框会被快照掩码显示，但填写不受影响。',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', maxLength: 16, description: '目标输入框的 ref' },
          text: { type: 'string', maxLength: 10000, description: '要填入的文字（空字符串=清空）' },
          submit: { type: 'boolean', description: '填写后按 Enter 提交（默认 false）' },
          tab: TAB_PROP,
        },
        required: ['ref', 'text'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.fill({ ref: args.ref, text: args.text, submit: args.submit, tab: args.tab })
        return `已填写 ${out.filled}${out.submit ? ' 并回车提交' : ''}（标签页 ${out.tab}）\n\n${out.snapshot.text}`
      }),
    }),
    defineTool({
      name: 'browser_press',
      description: '按键。给 ref 时在指定元素上按（如输入框内 Enter），不给 ref 时对当前页面按（如 Tab / Escape / Control+a）。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', maxLength: 40, description: '键名：Enter / Tab / Escape / ArrowDown / Control+a 等（Playwright 键名）' },
          ref: { type: 'string', maxLength: 16, description: '目标元素 ref（缺省=页面级按键）' },
          tab: TAB_PROP,
        },
        required: ['key'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.press({ key: args.key, ref: args.ref, tab: args.tab })
        return `已按键 ${out.key}（标签页 ${out.tab}）\n\n${out.snapshot.text}`
      }),
    }),
    defineTool({
      name: 'browser_select',
      description: '选择下拉框（select）的选项。value 先按 <option value> 匹配，失败自动按选项文本匹配。',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', maxLength: 16, description: '目标下拉框的 ref' },
          value: { type: 'string', maxLength: 300, description: '选项的 value 或可见文本' },
          tab: TAB_PROP,
        },
        required: ['ref', 'value'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.select({ ref: args.ref, value: args.value, tab: args.tab })
        return `已选择 ${out.selected}（标签页 ${out.tab}）\n\n${out.snapshot.text}`
      }),
    }),
    defineTool({
      name: 'browser_scroll',
      description: '滚动当前页面（默认向下 600px）。懒加载页面翻内容用它。',
      inputSchema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: '方向（默认 down）' },
          amount: { type: 'number', description: '像素数（默认 600）' },
          tab: TAB_PROP,
        },
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => runTool(async () => {
        const out = await ctx.engine.scroll({ direction: args.direction, amount: args.amount, tab: args.tab })
        return `已滚动 ${out.scrolled}（标签页 ${out.tab}）\n\n${out.snapshot.text}`
      }),
    }),
  ],
})
