/** 公式能力：TeX 数学公式 → PPTist 原生 latex 元素（hfmath stroke 渲染，与编辑器描边渲染同款）。 */
import { renderFormula } from '../../../core/formula.js'
import { clamp, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const formulaCapability = defineCapability({
  id: 'formula',
  title: '数学公式',
  tags: ['write', 'content'],
  requires: ['deck'],
  features: ['deck.formula'],
  tools: [
    defineTool({
      name: 'ppt_formula',
      description:
        '插入或更新数学公式（TeX 语法，PPTist 原生 latex 元素，手写风描边渲染）。' +
        '支持分式 \\frac{}{}、上下标 ^ _、根号 \\sqrt、求和积分 \\sum \\int、希腊字母、矩阵等；' +
        '渲染由内置 hfmath 引擎完成。带 element_id 时为更新（重新渲染并替换）。',
      inputSchema: {
        type: 'object',
        properties: {
          slide: { type: 'integer', description: '0 起页号，默认 0' },
          latex: { type: 'string', description: 'TeX 公式，如 E=mc^2 / \\frac{a}{b} / \\int_0^1 x^2 dx' },
          element_id: { type: 'string', description: '更新模式：要更新的公式元素 id' },
          color: { type: 'string', description: '笔画颜色，默认 #333333' },
          stroke_width: { type: 'number', description: '笔画宽度，默认 2' },
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number', description: '默认按渲染原始尺寸' },
          height: { type: 'number', description: '默认按渲染原始尺寸（fixedRatio 锁比例）' },
        },
        required: ['slide', 'latex'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.2.0',
      handler: async (args, ctx) => {
        const i = clamp(Number(args.slide) | 0, 0, 999)
        const p = args || {}
        if (p.element_id) {
          /* 更新：重新渲染新公式，替换 path/viewBox/latex（几何/颜色按参数顺带改）。 */
          const rendered = renderFormula(p.latex)
          const props = {
            latex: p.latex,
            path: rendered.path,
            viewBox: rendered.viewBox,
          }
          if (p.width != null) props.width = p.width
          if (p.height != null) props.height = p.height
          if (p.color) props.color = p.color
          if (p.stroke_width != null) props.strokeWidth = p.stroke_width
          for (const k of ['left', 'top']) {
            if (p[k] != null) props[k] = p[k]
          }
          const r = await ctx.deck.write([{ op: 'set-element', slide: i, elementId: String(p.element_id), props }])
          return okText(r, `已更新公式 ${p.element_id}`)
        }
        const element = {
          type: 'latex',
          latex: p.latex,
          ...(p.color ? { color: p.color } : {}),
          ...(p.stroke_width != null ? { strokeWidth: p.stroke_width } : {}),
        }
        for (const k of ['left', 'top', 'width', 'height']) {
          if (p[k] != null) element[k] = p[k]
        }
        const r = await ctx.deck.write([{ op: 'add-element', slide: i, element }])
        return okText(r, `已在第 ${i} 页插入公式`)
      },
    }),
  ],
})
