/** 页面管理能力。 */
import { simpleSlide } from '../domains/slide.mjs'
import { okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const slideCapability = defineCapability({
  id: 'slide',
  title: '页面管理',
  tags: ['write', 'structure'],
  requires: ['deck'],
  features: ['deck.write'],
  tools: [
    defineTool({
      name: 'ppt_slide',
      description: '页管理：add（标题+要点）/remove/move/duplicate/select。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove', 'move', 'duplicate', 'select'] },
          index: { type: 'integer', description: '目标页号（0 起）；add 时为插入位置，缺省末尾' },
          to: { type: 'integer', description: 'move 的目标位置' },
          title: { type: 'string', maxLength: 40, description: 'add 的标题' },
          bullets: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 80 } },
          background: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async ({ action, index, to, title, bullets, background }, ctx) => {
        const slideCount = async () => {
          const doc = await ctx.deck.read()
          return doc.deck && Array.isArray(doc.deck.slides) ? doc.deck.slides.length : 0
        }
        const requirePage = (value, label = 'index') => {
          const n = Number(value)
          if (!Number.isInteger(n) || n < 0) throw new Error(`ppt_slide ${action} 需要 ${label}（0 起整数）`)
          return n
        }
        if (action === 'add') {
          const count = await slideCount()
          let at = index != null ? Math.min(requirePage(index), count) : count
          const r = await ctx.deck.write([{ op: 'add-slide', slide: simpleSlide(title || '新一页', bullets, background), index: at }])
          return okText(r, `已加一页「${title || '新一页'}」`)
        }
        if (action === 'remove') {
          const count = await slideCount()
          const i = requirePage(index)
          if (i >= count) throw new Error(`页号越界：${i}（共 ${count} 页）`)
          const r = await ctx.deck.write([{ op: 'remove-slide', id: i }])
          return okText(r, `已删除第 ${i} 页`)
        }
        if (action === 'move') {
          const count = await slideCount()
          const from = requirePage(index)
          const target = requirePage(to, 'to')
          if (from >= count) throw new Error(`页号越界：${from}（共 ${count} 页）`)
          if (target >= count) throw new Error(`目标页号越界：${target}（共 ${count} 页）`)
          const r = await ctx.deck.write([{ op: 'move-slide', from, to: target }])
          return okText(r, `已移动第 ${from} 页到 ${target}`)
        }
        if (action === 'duplicate') {
          const count = await slideCount()
          const i = requirePage(index)
          if (i >= count) throw new Error(`页号越界：${i}（共 ${count} 页）`)
          const r = await ctx.deck.write([{ op: 'duplicate-slide', id: i }])
          return okText(r, `已复制第 ${i} 页`)
        }
        if (action === 'select') {
          const count = await slideCount()
          const i = requirePage(index)
          if (i >= count) throw new Error(`页号越界：${i}（共 ${count} 页）`)
          const r = await ctx.deck.write([{ op: 'select', id: i }])
          return okText(r, `已选中第 ${i} 页`)
        }
        throw new Error('未知 action: ' + action)
      },
    }),
  ],
})
