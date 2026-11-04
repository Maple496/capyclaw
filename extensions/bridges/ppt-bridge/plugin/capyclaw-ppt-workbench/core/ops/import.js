/**
 * 浏览器专用 view op：把上传的 PPTX 交给编辑器内置的 PPTist 导入器。
 *
 * 为什么不在服务端解析：PPTist 的 importPPTXFile 依赖 DOM / FileReader /
 * 字体与图片上下文，直接复用才能在“打开已有 pptx”时拿到和 UI 导入一致的
 * 还原度。服务端只负责把文件传到 relay，由编辑器页面执行本 op。
 *
 * 协议：
 *   { op: 'import-pptx', req, id, url, name, resultUrl? }
 *   - url：relay 上的待导入文件地址（同源相对路径即可）
 *   - resultUrl：导入完成后回传结果的地址
 */

export const importOps = {
  'import-pptx': {
    mutates: false,
    view: true,
    description: '导入 PPTX（仅编辑器页面执行）',
    async run(P, c, ctx = {}) {
      if (!P || typeof P.importFile !== 'function') {
        throw new Error('当前编辑器不支持 PPTX 导入：PptApp.importFile 不可用')
      }

      const req = String(c.req || '')
      const apiBase = String(ctx.apiBase || '').replace(/\/+$/, '')
      const resultUrl = String(c.resultUrl || (apiBase ? `${apiBase}/import-result` : '/api/desktop/works/ppt-bridge/import-result'))
      const doFetch = ctx.fetch || (typeof fetch === 'function' ? fetch : null)

      const notify = async (body) => {
        if (!doFetch) return
        try {
          await doFetch(resultUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ req, id: String(c.id || ''), ...body }),
          })
        } catch { /* 结果回传失败由 MCP 侧超时兜底 */ }
      }

      try {
        if (!doFetch) throw new Error('当前环境不支持 fetch，无法读取待导入文件')
        const base = ctx.baseUrl || (typeof location !== 'undefined' ? location.href : 'http://127.0.0.1/')
        const sourceUrl = new URL(String(c.url || ''), base).href
        const response = await doFetch(sourceUrl)
        if (!response || !response.ok) {
          throw new Error(`读取待导入文件失败：HTTP ${response ? response.status : 'no response'}`)
        }

        const blob = await response.blob()
        const FileCtor = ctx.File || (typeof File !== 'undefined' ? File : null)
        if (!FileCtor) throw new Error('当前环境不支持 File 构造器，无法导入 PPTX')

        const name = String(c.name || 'import.pptx')
        const file = new FileCtor([blob], name, {
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        })

        /* PPTist 的 importPPTXFile 默认是“追加/空 deck 才替换”。工具语义是
         * “打开 pptx”，所以 replace 模式先记住旧页，导入后把它们删掉；
         * append 模式保留旧页（多文件拼接场景）。 */
        const mode = c.mode === 'append' ? 'append' : 'replace'
        const beforeSlides = typeof P.getSlides === 'function' ? (P.getSlides() || []) : []
        const previousIds = mode === 'replace'
          ? beforeSlides.map((slide) => slide.id).filter(Boolean)
          : []

        const imported = await P.importFile(file)
        for (const id of previousIds) {
          try { P.removeSlide(id) } catch { /* 单页 deck 不允许删空；忽略 */ }
        }

        const finalCount = typeof P.getSlides === 'function' ? (P.getSlides() || []).length : imported?.slideCount
        const rawCount = Number(imported?.slideCount || 0)
        const contributed = mode === 'append'
          ? Math.max(0, Number(finalCount || 0) - beforeSlides.length)
          : Number(finalCount || rawCount || 0)
        const summary = {
          ...(imported && typeof imported === 'object' ? imported : {}),
          slideCount: Number(finalCount || rawCount || 0),
          import: {
            mode,
            before: beforeSlides.length,
            imported: contributed,
            final: Number(finalCount || 0),
          },
        }
        await notify({ ok: true, summary })
        return summary
      } catch (error) {
        await notify({ ok: false, error: String((error && error.message) || error) })
        throw error
      }
    },
  },
}
