/** 整体换色能力：新编辑器单条 recolor，旧编辑器回退为批量队列。 */
import { resolveColor } from '../domains/color.mjs'
import { expandRecolorOps, resolveForeground } from '../domains/recolor.mjs'
import { normalizeSlides, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const recolorCapability = defineCapability({
  id: 'recolor',
  title: '整体换色',
  tags: ['recipe', 'style'],
  requires: ['deck'],
  features: ['deck.recolor'],
  tools: [
    defineTool({
      name: 'ppt_recolor',
      description: '一键整体换色（一次调用完成）：背景 + 全部文字对比色 + 装饰形状（线条/圆点/色条）统一色。改整体背景/配色时优先用它，禁止逐页 ppt_element 改色。',
      inputSchema: {
        type: 'object',
        properties: {
          background: { type: 'string', description: '新背景色（CSS 颜色或中文色名）' },
          text: { type: 'string', description: '文字颜色；缺省按背景自动对比（浅底深字/深底白字）' },
          shapes: { type: 'string', description: '装饰形状填充色；缺省跟随文字色（传 null 表示不改装饰）' },
          slides: { type: 'array', items: { type: 'integer' }, description: '只改这些页；缺省全部' },
        },
        required: ['background'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async ({ background, text, shapes, slides }, ctx) => {
        const bg = resolveColor(background)
        const textColor = text ? resolveColor(text) : ''
        const shapeColor = shapes === undefined ? undefined : (shapes === null ? null : resolveColor(shapes))
        const targets = normalizeSlides(slides)

        // 1) 新编辑器：单条 recolor 指令（背景+文字+装饰一次完成）
        const cmd = { op: 'recolor', background: bg }
        if (textColor) cmd.text = textColor
        if (shapeColor !== undefined) cmd.shapes = shapeColor
        if (targets) cmd.indices = targets
        const r = await ctx.deck.write([cmd])
        if (r.ok) return okText(r, '整体配色已更新')
        if (!/未知指令/.test(String(r.error || ''))) return okText(r, '整体配色失败')

        // 2) 旧编辑器兼容：展开为 set-background + set-element 批量队列
        const fg = resolveForeground(bg, textColor)
        const sf = shapeColor === undefined ? fg : shapeColor
        const doc = await ctx.deck.read()
        const ops = expandRecolorOps(doc.deck, { bg, fg, sf, targets })
        let applied = 0
        for (let i = 0; i < ops.length; i += 90) {
          const rr = await ctx.deck.write(ops.slice(i, i + 90))
          if (!rr.ok) return okText(rr, '整体配色失败（兼容模式）')
          applied += rr.applied
        }
        return { text: `整体配色已更新（兼容模式，${applied} 条）` }
      },
    }),
  ],
})
