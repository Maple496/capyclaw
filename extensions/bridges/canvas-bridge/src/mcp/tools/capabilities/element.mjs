/** 元素插入能力：表格 / 图片 / 分隔线 / 分页符 / 列表（零读直推）+ 按 id 更新（镜像）。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText } from '../../bridge-client.mjs'
import { tableElement, imageElement } from '../../../core/blocks.js'
import { readMirror, writeMirror, normalizeZones } from '../domains/mirror.mjs'

/** 直推追加：一条 appendElementList 指令，不读镜像（延迟与文档大小无关）。 */
async function appendElements(ctx, els, title) {
  await ctx.editor.require()
  return ctx.doc.write([{ cmd: 'appendElementList', args: [els] }], title)
}

/** 结构元素通用前后缀：空行 + 元素 + 换行。 */
const wrap = (el) => [{ value: '' }, el, { value: '\n' }]

export const elementCapability = defineCapability({
  id: 'element',
  title: '元素插入',
  description: '向正文末尾插入结构化元素：表格（自动列宽）、图片（dataURL/URL/assets 引用）、分隔线、分页符、列表、按 id 更新。',
  tags: ['content'],
  requires: ['doc', 'editor'],
  features: ['element.insert'],
  tools: [
    defineTool({
      name: 'canvas_insert_table',
      description: '插入表格：headers + rows，列宽按内容自适应，表头默认底色。零读直推，追加到正文末尾。',
      inputSchema: {
        type: 'object',
        properties: {
          headers: { type: 'array', items: { type: 'string' }, description: '表头（空数组则无表头行）' },
          rows: { type: 'array', items: { type: 'array', items: {} }, description: '数据行（每行单元格可为字符串/数字）' },
          header_background: { type: 'string', description: '表头底色（默认 #eef1f5）' },
          content_width: { type: 'number', description: '内容区宽度（默认 554）' },
          title: { type: 'string' },
        },
        required: ['rows'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const el = tableElement(args.headers || [], args.rows || [], args)
        const r = await appendElements(ctx, wrap(el), args.title || '插入表格')
        return okText(r, `已插入表格（${(args.rows || []).length} 行 × ${el.colgroup.length} 列）`)
      },
    }),
    defineTool({
      name: 'canvas_insert_image',
      description: '插入图片：src 接受 dataURL / http(s) URL / relay /assets 引用；零读直推，追加到正文末尾。',
      inputSchema: {
        type: 'object',
        properties: {
          src: { type: 'string', description: 'dataURL 或 URL（推荐 dataURL 或 /assets 引用）' },
          width: { type: 'number', description: '显示宽（默认 480）' },
          height: { type: 'number', description: '显示高（默认 270）' },
          caption: { type: 'string', description: '题注' },
          title: { type: 'string' },
        },
        required: ['src'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        if (!/^(data:image\/|https?:\/\/|\/assets\/)/.test(String(args.src))) {
          throw new Error('src 必须是 dataURL、http(s) URL 或 /assets 引用')
        }
        const el = imageElement(args.src, args.width, args.height, args.caption)
        const r = await appendElements(ctx, wrap(el), args.title || '插入图片')
        return okText(r, '已插入图片')
      },
    }),
    defineTool({
      name: 'canvas_element',
      description: '结构元素与更新：separator（分割线）/ pageBreak（分页符）/ list（列表项）零读直推；updateById（按 id 改元素属性）走镜像。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['separator', 'pageBreak', 'list', 'updateById'], description: '操作' },
          items: { type: 'array', items: { type: 'string' }, description: 'list：多级列表项（"1. x" / "- x" 前缀识别）' },
          id: { type: 'string', description: 'updateById：元素 id' },
          properties: { type: 'object', description: 'updateById：要覆盖的元素属性' },
          title: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const action = args.action
        if (action === 'separator') {
          const r = await appendElements(ctx, wrap({ value: '────────────────────────────' }), args.title || '分割线')
          return okText(r, '已完成 separator')
        }
        if (action === 'pageBreak') {
          const r = await appendElements(ctx, [{ type: 'pageBreak', value: '' }], args.title || '分页符')
          return okText(r, '已完成 pageBreak')
        }
        if (action === 'list') {
          const items = (args.items || []).map(String)
          if (!items.length) throw new Error('list 需要 items')
          const els = []
          items.forEach((item) => {
            const m = item.match(/^(\d+)[.、)]\s*(.*)$/)
            els.push({ value: m ? `${m[1]}. ${m[2]}` : `• ${item.replace(/^[-•]\s*/, '')}` })
            els.push({ value: '\n' })
          })
          const r = await appendElements(ctx, els, args.title || '列表')
          return okText(r, '已完成 list')
        }
        if (action === 'updateById') {
          if (!args.id) throw new Error('updateById 需要 id')
          const doc = normalizeZones(await readMirror(ctx))
          let touched = 0
          const walk = (list) => {
            for (const el of list) {
              if (el && el.id === args.id) {
                Object.assign(el, args.properties || {})
                touched += 1
              }
              if (el && Array.isArray(el.valueList)) walk(el.valueList)
              if (el && el.trList) for (const tr of el.trList) for (const td of (tr && tr.tdList) || []) walk(td.value)
            }
          }
          walk(doc.main)
          if (!touched) throw new Error(`没有 id=${args.id} 的元素`)
          const r = await writeMirror(ctx, doc, args.title || `更新 ${args.id}`)
          return okText(r, `已更新 ${touched} 处`)
        }
        throw new Error(`未知 action：${action}`)
      },
    }),
  ],
})
