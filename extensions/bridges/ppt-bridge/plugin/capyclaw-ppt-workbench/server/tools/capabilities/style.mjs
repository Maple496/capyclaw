/** 样式能力：背景色、文字颜色、字体名、主题色。 */
import { resolveColor } from '../domains/color.mjs'
import { clamp, normalizeSlides, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const styleCapability = defineCapability({
  id: 'style',
  title: '主题与背景',
  tags: ['write', 'style'],
  requires: ['deck'],
  features: ['deck.write'],
  tools: [
    defineTool({
      name: 'ppt_style',
      description: '整体样式：背景色（可指定页），文字颜色，字体名，主题色数组。浅底会自动配深字、深底配白字。',
      inputSchema: {
        type: 'object',
        properties: {
          background: { type: 'string', description: '背景色（CSS 或中文色名）' },
          slides: { type: 'array', items: { type: 'integer' }, description: '只改这些页的背景；缺省全部' },
          contrast: { type: 'boolean', description: '自动对比度，缺省 true' },
          text_color: { type: 'string', description: '全局正文颜色' },
          font_name: { type: 'string' },
          theme_colors: { type: 'array', items: { type: 'string' }, description: '主题色数组' },
        },
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async ({ background, slides, contrast, text_color, font_name, theme_colors }, ctx) => {
        const ops = []
        if (background) {
          const cmd = { op: 'set-background', color: resolveColor(background), contrast: contrast !== false }
          const targets = normalizeSlides(slides)
          if (targets) cmd.indices = targets
          ops.push(cmd)
        }
        const theme = {}
        if (text_color) theme.fontColor = resolveColor(text_color)
        if (font_name) theme.fontName = String(font_name)
        if (Array.isArray(theme_colors) && theme_colors.length) theme.themeColors = theme_colors.map(resolveColor)
        if (Object.keys(theme).length) ops.push({ op: 'theme', theme })
        const r = await ctx.deck.write(ops)
        return okText(r, '样式已更新')
      },
    }),
  ],
})
