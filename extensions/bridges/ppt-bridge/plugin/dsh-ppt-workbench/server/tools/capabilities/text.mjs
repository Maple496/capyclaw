/** 文本能力：按页/元素改文本，文字槽位填充。 */
import { clamp, normalizeSlides, okText } from '../domains/tooling.mjs'
import { normalizeTextStyle } from '../domains/text-style.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const textCapability = defineCapability({
  id: 'text',
  title: '文字与槽位',
  tags: ['write', 'content'],
  requires: ['deck'],
  features: ['deck.write'],
  tools: [
    defineTool({
      name: 'ppt_text',
      description: '改文字：某页或某几页（缺省全部页）的首个文本，或指定 element_id 的文本；可同时改字号/颜色/加粗/对齐。首个文本优先取 text 元素，纯图形文字页回退到带文字的 shape。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 2000 },
          slide: { type: 'integer', description: '0 起页号' },
          slides: { type: 'array', maxItems: 100, items: { type: 'integer' }, description: '0 起页号数组（缺省=全部）' },
          element_id: { type: 'string', description: '元素 id（缺省=首个文本）' },
          font_size: { type: 'integer' },
          color: { type: 'string', description: 'CSS 颜色或中文色名' },
          bold: { type: 'boolean' },
          align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        },
        required: ['text'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async ({ text, slide, slides, element_id, ...style }, ctx) => {
        const base = { text: String(text ?? '') }
        if (element_id) base.elementId = String(element_id)
        Object.assign(base, normalizeTextStyle(style))
        const targets = normalizeSlides(slides)
          || (slide !== undefined && slide !== null ? [clamp(Number(slide) | 0, 0, 999)] : null)
        if (targets) {
          const r = await ctx.deck.write(targets.map(i => Object.assign({ op: 'set-text', id: i }, base)))
          return okText(r, `已改 ${targets.length} 页文本`)
        }
        const doc = await ctx.deck.read()
        const n = doc.deck && Array.isArray(doc.deck.slides) ? doc.deck.slides.length : 0
        if (!n) throw new Error('桥上没有 deck')
        const r = await ctx.deck.write(Array.from({ length: n }, (_, i) => Object.assign({ op: 'set-text', id: i }, base)))
        return okText(r, `已改全部 ${n} 页文本`)
      },
    }),
    defineTool({
      name: 'ppt_fill',
      description: '填充文字槽位：把某页的第 slot 个文字载体（0 起，含带文字的 shape）改成 text，可带字号/颜色/加粗/对齐。保留原版式。',
      inputSchema: {
        type: 'object',
        properties: {
          slide: { type: 'integer', description: '0 起页号' },
          slot: { type: 'integer', description: '该页第几个文字载体（0 起，含图形内文字）' },
          text: { type: 'string' },
          font_size: { type: 'integer' },
          color: { type: 'string' },
          bold: { type: 'boolean' },
          align: { type: 'string' },
        },
        required: ['slide', 'slot', 'text'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async ({ slide, slot, text, ...style }, ctx) => {
        const cmd = {
          op: 'fill-slot',
          slide: clamp(Number(slide) | 0, 0, 999),
          slot: clamp(Number(slot) | 0, 0, 99),
          text: String(text ?? ''),
          ...normalizeTextStyle(style),
        }
        const r = await ctx.deck.write([cmd])
        return okText(r, `已填第 ${slide} 页槽位 ${slot}`)
      },
    }),
  ],
})
