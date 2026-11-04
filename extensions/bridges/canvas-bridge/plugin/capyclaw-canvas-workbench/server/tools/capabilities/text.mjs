/** 文本查找替换能力：全文替换保样式；搜索带上下文。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText } from '../../bridge-client.mjs'
import { replaceInDoc } from '../../../core/blocks.js'
import { readMirror, writeMirror } from '../domains/mirror.mjs'

export const textCapability = defineCapability({
  id: 'text',
  title: '查找替换',
  description: '纯文本层操作：保留样式与结构的全文替换、搜索定位。',
  tags: ['content'],
  requires: ['doc', 'editor'],
  features: ['text.replace', 'text.search'],
  tools: [
    defineTool({
      name: 'canvas_replace_text',
      description: '全文替换（默认全部）：保留元素样式与表格结构；返回替换次数。',
      inputSchema: {
        type: 'object',
        properties: {
          find: { type: 'string', description: '查找文本' },
          replace: { type: 'string', description: '替换文本' },
          all: { type: 'boolean', description: '替换全部（默认 true；false 只替换第一处）' },
          title: { type: 'string' },
        },
        required: ['find', 'replace'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const doc = await readMirror(ctx)
        const { doc: next, count } = replaceInDoc(doc, args.find, args.replace, args.all !== false)
        if (!count) return { text: `未找到：${args.find}` }
        const r = await writeMirror(ctx, next, args.title || `替换 ${args.find} → ${args.replace}`)
        return okText(r, `已替换 ${count} 处`)
      },
    }),
    defineTool({
      name: 'canvas_search',
      description: '搜索文本：返回命中区域/位置与上下文片段（只读，不改稿）。',
      inputSchema: {
        type: 'object',
        properties: {
          find: { type: 'string', description: '查找文本' },
          limit: { type: 'number', description: '最多返回条数（默认 50）' },
        },
        required: ['find'],
        additionalProperties: false,
      },
      kind: 'read',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const doc = await readMirror(ctx)
        const hits = ctx.doc.findInDoc(doc, args.find, Math.min(200, Math.max(1, Number(args.limit) || 50)))
        if (!hits.length) return { text: `未找到：${args.find}` }
        const lines = hits.map((h) => `- ${h.zone}[${h.index}] …${h.context}…`)
        return { text: `命中 ${hits.length} 处：\n${lines.join('\n')}` }
      },
    }),
  ],
})
