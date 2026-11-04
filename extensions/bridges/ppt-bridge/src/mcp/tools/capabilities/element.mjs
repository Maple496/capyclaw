/** 元素能力：加/改/删元素；图片插入委托给 media.insertImage。 */
import { resolveColor } from '../domains/color.mjs'
import { clamp, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const elementCapability = defineCapability({
  id: 'element',
  title: '元素编辑',
  tags: ['write', 'layout'],
  requires: ['deck', 'media'],
  dependsOn: ['image'],
  features: ['deck.write'],
  tools: [
    defineTool({
      name: 'ppt_element',
      description: '元素级编辑：add 加文本/形状/图片，update 改位置/尺寸/旋转/填充/文字样式，remove 删除。插入图片走 ppt_image 的同一实现。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'remove'] },
          slide: { type: 'integer', description: '0 起页号' },
          element_id: { type: 'string' },
          element: {
            type: 'object',
            description: "add 用：{type:'text'|'shape'|'image', text?/content?, src?(image), fill?, left?, top?, width?, height?, fontSize?, color?}",
          },
          props: {
            type: 'object',
            description: 'update 用：{left?,top?,width?,height?,rotate?,opacity?,fill?,src?,text?,fontSize?,color?,bold?,align?}',
          },
        },
        required: ['action', 'slide'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async ({ action, slide, element_id, element, props }, ctx) => {
        const i = clamp(Number(slide) | 0, 0, 999)
        if (action === 'add') {
          const el = element || {}
          if (el.type === 'image') {
            if (!ctx.media) throw new Error('插入图片需要启用 image 能力')
            return ctx.media.insertImage({ slide: i, ...el })
          }
          const r = await ctx.deck.write([{ op: 'add-element', slide: i, element: el }])
          return okText(r, `已在第 ${i} 页加元素`)
        }
        if (!element_id) throw new Error('update/remove 需要 element_id')
        if (action === 'remove') {
          const r = await ctx.deck.write([{ op: 'remove-element', slide: i, elementId: String(element_id) }])
          return okText(r, `已删除元素 ${element_id}`)
        }
        if (action === 'update') {
          const cleaned = {}
          const p = props || {}
          ;['left', 'top', 'width', 'height', 'rotate', 'opacity', 'fill', 'src', 'text', 'html', 'fontSize', 'color', 'bold', 'align', 'defaultColor'].forEach(k => {
            if (p[k] != null) cleaned[k] = p[k]
          })
          if (cleaned.color) cleaned.color = resolveColor(cleaned.color)
          const r = await ctx.deck.write([{ op: 'set-element', slide: i, elementId: String(element_id), props: cleaned }])
          return okText(r, `已更新元素 ${element_id}`)
        }
        throw new Error('未知 action: ' + action)
      },
    }),
  ],
})
