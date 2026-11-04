/** 导出能力：镜像 → 结构化 HTML（存 relay 导出目录）。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { docToHtml } from '../../../core/html.js'
import { readMirror } from '../domains/mirror.mjs'

export const exportCapability = defineCapability({
  id: 'export',
  title: '导出',
  description: '把当前文档导出为结构化 HTML（标题/段落/表格/图片），写入 relay 导出目录并返回下载地址。',
  tags: ['export'],
  requires: ['doc'],
  features: ['export.html'],
  tools: [
    defineTool({
      name: 'canvas_export',
      description: '导出 HTML：name 为文件名（默认 export）。返回文件路径与下载 URL。浏览器打开 URL 可另存/打印成 PDF。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '文件名（不含扩展名，默认 export）' },
          title: { type: 'string', description: 'HTML 标题（默认取文档首个标题）' },
        },
        additionalProperties: false,
      },
      kind: 'read',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const doc = await readMirror(ctx)
        const outline = ctx.doc.outlineOf(doc)
        const htmlTitle = args.title || (outline[0] && outline[0].text) || 'Canvas 文档'
        const html = docToHtml(doc, htmlTitle)
        const name = String(args.name || 'export').replace(/[^\w\u4e00-\u9fff.-]+/g, '_').replace(/\.(html?|pdf)$/i, '') || 'export'
        const result = await postExport(name, html)
        return { text: `已导出 HTML：${result.path}\n下载：${result.url}` }
      },
    }),
  ],
})

/** POST /export 到 relay（relay 写 exports/<name>.html）。 */
async function postExport(name, html) {
  const { post } = await import('../../bridge-client.mjs')
  return post('/export', { name, html }, { timeoutMs: 30000 })
}
