/** 导出路由：工具层生成的 HTML 写到 hostDir/exports/，回传路径与下载 URL；
 * GET /exports/<name>.html 提供下载。 */
import { readBody, send } from '../http-utils.mjs'
import fs from 'node:fs'
import path from 'node:path'

const MAX_HTML = 12 * 1024 * 1024

export function createExportRoutes({ exportsDir, baseUrl = '', basePath = '' }) {
  const exportEndpoints = new Set([`${basePath}/export`, '/api/export', '/export'].filter(Boolean))
  const serve = async (req, res, u) => {
    /* POST …/export：写入导出文件 */
    if (exportEndpoints.has(u.pathname)) {
      if (req.method !== 'POST') {
        send(req, res, 405, { error: 'method not allowed' })
        return true
      }
      try {
        const body = await readBody(req, MAX_HTML)
        const name = String(body.name || 'export').replace(/[^\w\u4e00-\u9fff.-]+/g, '_').replace(/\.(html?|pdf)$/i, '') || 'export'
        const html = String(body.html || '')
        if (!html) {
          send(req, res, 400, { error: '缺少 html' })
          return true
        }
        fs.mkdirSync(exportsDir, { recursive: true })
        const file = path.join(exportsDir, `${name}.html`)
        fs.writeFileSync(file, html, 'utf8')
        send(req, res, 200, {
          ok: true,
          path: file,
          url: `${baseUrl}/exports/${encodeURIComponent(name)}.html`,
          bytes: Buffer.byteLength(html),
        })
      } catch (error) {
        send(req, res, error && error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: String(error.message || error) })
      }
      return true
    }

    /* GET /exports/<name>.html：下载导出产物 */
    if (u.pathname.startsWith('/exports/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const name = decodeURIComponent(u.pathname.slice('/exports/'.length)).replace(/[\\/]+/g, '')
      const file = path.join(exportsDir, name)
      try {
        if (!fs.statSync(file).isFile()) throw new Error('not a file')
        const html = fs.readFileSync(file, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
        })
        res.end(req.method === 'HEAD' ? undefined : html)
      } catch {
        send(req, res, 404, { error: 'not found' })
      }
      return true
    }
    return false
  }
  return [serve]
}
