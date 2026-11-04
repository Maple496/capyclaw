/** 形状能力：内置形状库一键插入（矩形/圆/三角/星形/箭头/气泡…），也接受自定义 path。 */
import { SHAPE_KEYS, getShape } from '../../../core/shape-library.js'
import { clamp, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const shapeCapability = defineCapability({
  id: 'shape',
  title: '形状库',
  tags: ['write', 'layout'],
  requires: ['deck'],
  features: ['deck.shape'],
  tools: [
    defineTool({
      name: 'ppt_shape',
      description:
        '插入形状。shape 从内置库选（' + SHAPE_KEYS.join(' / ') + '），' +
        '也可传自定义 SVG path + viewBox。装饰、流程节点、强调块都走这里。',
      inputSchema: {
        type: 'object',
        properties: {
          slide: { type: 'integer', description: '0 起页号，默认 0' },
          shape: { type: 'string', description: '内置形状 key，如 circle / arrow-right / star-5 / round-rect' },
          path: { type: 'string', description: '自定义 SVG path（与 shape 二选一，优先生效）' },
          viewBox: { type: 'array', items: { type: 'number' }, description: '自定义 path 的 viewBox [w, h]，默认 [200, 200]' },
          fill: { type: 'string', description: '填充色，默认 #5b9bd5' },
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number', description: '默认 200' },
          height: { type: 'number', description: '默认 200' },
          rotate: { type: 'number' },
        },
        required: ['slide'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.2.0',
      handler: async (args, ctx) => {
        const i = clamp(Number(args.slide) | 0, 0, 999)
        const p = args || {}
        let path = p.path
        let viewBox = Array.isArray(p.viewBox) && p.viewBox.length === 2 ? p.viewBox : [200, 200]
        if (!path) {
          if (!p.shape) throw new Error('需要 shape（内置形状 key）或 path（自定义 SVG）')
          const s = getShape(p.shape)
          path = s.path
          viewBox = s.viewBox
        }
        const element = {
          type: 'shape',
          path,
          viewBox,
          fill: p.fill || '#5b9bd5',
          left: p.left != null ? p.left : 60,
          top: p.top != null ? p.top : 120,
          width: p.width != null ? p.width : 200,
          height: p.height != null ? p.height : 200,
          ...(p.rotate != null ? { rotate: p.rotate } : {}),
        }
        const r = await ctx.deck.write([{ op: 'add-element', slide: i, element }])
        return okText(r, `已在第 ${i} 页插入形状${p.shape ? ' ' + p.shape : ''}`)
      },
    }),
  ],
})
