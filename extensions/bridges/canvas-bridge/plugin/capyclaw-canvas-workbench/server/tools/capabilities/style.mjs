/** 样式能力：按文本定位套行内样式（镜像层，不依赖编辑器选区）。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText } from '../../bridge-client.mjs'
import { readMirror, writeMirror } from '../domains/mirror.mjs'

const STYLE_KEYS = ['bold', 'italic', 'underline', 'strikeout', 'color', 'size', 'font', 'highlight']

export const styleCapability = defineCapability({
  id: 'style',
  title: '行内样式',
  description: '对包含指定文本的元素套行内样式：加粗/斜体/下划线/删除线/颜色/字号/字体/高亮。定位方式是文本匹配，不需要编辑器选区。',
  tags: ['style'],
  requires: ['doc', 'editor'],
  features: ['style.inline'],
  tools: [
    defineTool({
      name: 'canvas_style',
      description: '给包含指定文本的元素套样式：find 定位（必填），style 指定要改的属性。可精确匹配（exact）或多处全改（默认）。',
      inputSchema: {
        type: 'object',
        properties: {
          find: { type: 'string', description: '定位文本（元素 value 包含即命中）' },
          exact: { type: 'boolean', description: '默认 false 包含即命中；true 时元素文本需完全相等' },
          style: {
            type: 'object',
            description: '样式属性：bold/italic/underline/strikeout(boolean)、color/highlight/font(string)、size(number)',
            properties: {
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              underline: { type: 'boolean' },
              strikeout: { type: 'boolean' },
              color: { type: 'string' },
              highlight: { type: 'string' },
              font: { type: 'string' },
              size: { type: 'number' },
            },
            additionalProperties: false,
          },
          title: { type: 'string' },
        },
        required: ['find', 'style'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const style = args.style || {}
        const keys = Object.keys(style).filter((k) => STYLE_KEYS.includes(k))
        if (!keys.length) throw new Error(`style 至少包含一项：${STYLE_KEYS.join('/')}`)
        const doc = await readMirror(ctx)
        const needle = String(args.find)
        if (!needle) throw new Error('find 不能为空')
        let touched = 0
        const walk = (list) => {
          for (const el of list) {
            if (el && typeof el.value === 'string' && el.value !== '\n') {
              const hit = args.exact ? el.value === needle : el.value.includes(needle)
              if (hit) {
                for (const k of keys) el[k] = style[k]
                touched += 1
              }
            }
            if (el && Array.isArray(el.valueList)) walk(el.valueList)
            if (el && el.trList) for (const tr of el.trList) for (const td of (tr && tr.tdList) || []) walk(td.value)
          }
        }
        walk(Array.isArray(doc.main) ? doc.main : [])
        if (!touched) return { text: `未找到包含「${needle}」的文本元素` }
        const r = await writeMirror(ctx, doc, args.title || `样式 ${keys.join('/')}`)
        return okText(r, `已给 ${touched} 处文本套样式`)
      },
    }),
  ],
})
