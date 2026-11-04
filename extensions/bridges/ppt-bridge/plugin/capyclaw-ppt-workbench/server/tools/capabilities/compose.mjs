/** 成稿编排能力：内置版式成稿（组合 core 引擎与 deck 端口）。 */
import { buildDeck, buildSlide, PRESETS } from '../../../core/deck-layout.js'
import { okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const composeCapability = defineCapability({
  id: 'compose',
  title: '成稿编排',
  tags: ['recipe', 'layout'],
  requires: ['deck'],
  features: ['deck.compose'],
  tools: [
    defineTool({
      name: 'ppt_deck',
      description: '从大纲一次成稿：按版式（cover/section/bullets/two/stat/quote/end）+ 设计预设（clean/business/warm/tech）生成整套专业排版 deck，替换当前内容。默认简洁成稿首选（preset: clean）。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 40 },
          preset: { type: 'string', enum: ['clean', 'business', 'warm', 'tech'] },
          slides: {
            type: 'array',
            maxItems: 30,
            items: {
              type: 'object',
              properties: {
                layout: { type: 'string', enum: ['cover', 'section', 'bullets', 'two', 'stat', 'quote', 'end'] },
                title: { type: 'string', maxLength: 40 },
                subtitle: { type: 'string', maxLength: 80 },
                kicker: { type: 'string', maxLength: 40 },
                index: { type: 'integer' },
                bullets: { type: 'array', maxItems: 8 },
                left: { type: 'object' }, right: { type: 'object' },
                stats: { type: 'array', maxItems: 4 },
                quote: { type: 'string', maxLength: 300 }, author: { type: 'string', maxLength: 60 },
                note: { type: 'string', maxLength: 300 }, foot: { type: 'string', maxLength: 100 },
              },
              required: ['layout'],
            },
          },
        },
        required: ['slides'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async ({ title, preset, slides }, ctx) => {
        const deck = buildDeck({ title, preset, slides })
        const r = await ctx.deck.write([{ op: 'load', deck }])
        return okText(r, `已生成 ${deck.slides.length} 页「${deck.title}」（预设 ${preset || 'clean'}）`)
      },
    }),
    defineTool({
      name: 'ppt_page',
      description: '逐页成稿：一次只追加/替换当前一页（同一套 clean 版式），适合长 deck 分批落盘；首屏用 replace:true，后续逐页追加。',
      inputSchema: {
        type: 'object',
        properties: {
          layout: { type: 'string', enum: ['cover', 'section', 'bullets', 'two', 'stat', 'quote', 'end'] },
          preset: { type: 'string', enum: ['clean', 'business', 'warm', 'tech'] },
          deck_title: { type: 'string', maxLength: 40 },
          position: { type: 'integer', description: '插入位置（0 起，缺省末尾）' },
          replace: { type: 'boolean', description: 'true 时用这一页替换整个 deck（首屏用）' },
          title: { type: 'string', maxLength: 40 },
          subtitle: { type: 'string', maxLength: 80 },
          kicker: { type: 'string', maxLength: 40 },
          section_index: { type: 'integer', description: 'section 版式的章节序号' },
          bullets: { type: 'array', maxItems: 8 },
          left: { type: 'object' }, right: { type: 'object' },
          stats: { type: 'array', maxItems: 4 },
          quote: { type: 'string', maxLength: 300 }, author: { type: 'string', maxLength: 60 },
          note: { type: 'string', maxLength: 300 }, foot: { type: 'string', maxLength: 100 },
        },
        required: ['layout'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.3.0',
      handler: async ({ layout, preset, deck_title, position, replace, section_index, ...page }, ctx) => {
        const spec = { layout, ...page }
        if (section_index != null) spec.index = section_index
        const presetName = PRESETS[preset] ? preset : 'clean'
        const P = PRESETS[presetName]
        const slide = buildSlide(P, spec, 0)
        const theme = { themeColors: [P.accent, P.accent2, P.fg], fontColor: P.fg, backgroundColor: P.bg }
        if (replace) {
          const r = await ctx.deck.write([{ op: 'load', deck: { title: deck_title || page.title || '演示文稿', slides: [slide], theme } }])
          return okText(r, `已用 1 页替换 deck「${deck_title || page.title || '演示文稿'}」`)
        }
        const cmd = { op: 'add-slide', slide }
        if (position != null) cmd.index = Number(position) | 0
        const r = await ctx.deck.write([cmd])
        return okText(r, `已追加 1 页「${page.title || layout}」`)
      },
    }),
  ],
})
