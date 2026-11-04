/** 文档读写能力：一次成稿 / 续写 / 分层读取 / 清空。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText } from '../../bridge-client.mjs'
import { documentOf, blocksToElements, EMPTY_DOC } from '../../../core/blocks.js'
import { readMirror, writeMirror, normalizeZones } from '../domains/mirror.mjs'

const BLOCK_ITEM = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['heading', 'paragraph', 'bullet', 'number', 'quote', 'code', 'divider', 'pageBreak'], description: '块类型' },
    text: { type: 'string', description: '块文本' },
    level: { type: 'number', description: 'heading 级别 1-4' },
    index: { type: 'number', description: 'number 块序号' },
    style: { type: 'object', description: '行内样式（bold/italic/color/size/font/highlight/underline）' },
  },
  required: ['type'],
}

export const docCapability = defineCapability({
  id: 'doc',
  title: '文档读写',
  description: '块级写作模型：heading/paragraph/bullet/number/quote/code/divider → 元素流。',
  tags: ['content'],
  requires: ['doc', 'editor'],
  features: ['doc.read', 'doc.write'],
  tools: [
    defineTool({
      name: 'canvas_read',
      description: '读取文档：summary（摘要+大纲+预览，默认）/ text（纯文本）/ outline（标题大纲）/ doc（完整元素流）。',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['summary', 'text', 'outline', 'doc'], description: '读取模式' },
        },
        additionalProperties: false,
      },
      kind: 'read',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const mode = args.mode || 'summary'
        const doc = await readMirror(ctx)
        if (mode === 'text') {
          const words = ctx.doc.wordCountOf(doc)
          return { text: `${ctx.doc.textOf(doc)}\n\n[字数 ${words}]` }
        }
        if (mode === 'outline') {
          const outline = ctx.doc.outlineOf(doc)
          if (!outline.length) return { text: '（没有可识别的标题）' }
          return { text: outline.map((h) => `${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} p${h.page} ${h.text}`).join('\n') }
        }
        if (mode === 'doc') {
          return { text: JSON.stringify(doc, null, 2) }
        }
        return { text: ctx.doc.summarize(doc) }
      },
    }),
    defineTool({
      name: 'canvas_write_document',
      description: '一次成稿：用块数组整篇替换文档（避免几十次增量往返）。已有内容会被覆盖。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '批次说明（进 undo 历史）' },
          blocks: { type: 'array', items: BLOCK_ITEM },
        },
        required: ['blocks'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const els = blocksToElements(args.blocks || [])
        if (!els.length) throw new Error('blocks 为空：没有可写入的内容')
        const r = await writeMirror(ctx, documentOf(args.blocks || []), args.title || '写入文档')
        return okText(r, `已写入 ${els.length} 个元素`)
      },
    }),
    defineTool({
      name: 'canvas_append_blocks',
      description: '末尾续写：把块数组追加到正文末尾（不改已有内容）。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          blocks: { type: 'array', items: BLOCK_ITEM },
        },
        required: ['blocks'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const els = blocksToElements(args.blocks || [])
        if (!els.length) throw new Error('blocks 为空：没有可追加的内容')
        const doc = normalizeZones(await readMirror(ctx))
        doc.main = doc.main.concat(els)
        const r = await writeMirror(ctx, doc, args.title || '追加内容')
        return okText(r, `已追加 ${els.length} 个元素`)
      },
    }),
    defineTool({
      name: 'canvas_clear',
      description: '清空文档（三段全空；undo 可撤销）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'write',
      since: '1.0.0',
      handler: async (_args, ctx) => {
        const r = await writeMirror(ctx, EMPTY_DOC(), '清空文档')
        return okText(r, '已清空')
      },
    }),
  ],
})
