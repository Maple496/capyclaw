/**
 * PPTX 导入中转路由。
 *
 * 浏览器端导入需要 File 对象，而 MCP 工具在 Node 进程里拿到的是路径/字节。
 * 这里负责：
 *   POST <base>/import-file       原始字节上传 → 临时文件 + 同源下载地址
 *   GET  <base>/import-file/:id   编辑器页面取回原始字节
 *   POST <base>/import-result     编辑器回传导入结果
 *   GET  <base>/import-result?req= MCP 工具轮询结果
 *
 * 文件与结果都是短生命周期：结果回传后删除临时文件，结果按 TTL 清理。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readBody, send } from '../infra/http.mjs'
import { renderDeckToPptx } from '../tools/domains/pptx-export.mjs'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024
const MAX_RESULT_BYTES = 2 * 1024 * 1024
const RESULT_TTL_MS = 10 * 60 * 1000
const FILE_TTL_MS = 60 * 60 * 1000
const ID_RE = /^[a-f0-9]{16,64}$/

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        const error = new Error('pptx 文件超过大小上限')
        error.code = 'BODY_TOO_LARGE'
        fail(error)
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', fail)
    req.on('close', () => {
      if (!req.readableEnded) fail(new Error('客户端在上传完成前断开'))
    })
  })
}

function safeName(value) {
  let name = String(value || 'import.pptx')
  try { name = decodeURIComponent(name) } catch { /* 保留原值 */ }
  name = path.basename(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
  return name.toLowerCase().endsWith('.pptx') ? name : `${name || 'import'}.pptx`
}

function jsonResult(body) {
  return {
    done: true,
    ok: !!body.ok,
    error: body.error ? String(body.error).slice(0, 2000) : '',
    summary: body.summary && typeof body.summary === 'object' ? body.summary : null,
    ts: Date.now(),
  }
}

export function createImportRoutes({ basePath, importDir, store }) {
  const prefix = String(basePath || '').replace(/\/+$/, '')
  if (!importDir) throw new Error('createImportRoutes 需要 importDir')
  fs.mkdirSync(importDir, { recursive: true })
  const sourceRecord = path.join(importDir, 'last-open.json')

  /* 启动时清掉上一个进程遗留的临时文件（失败不影响服务启动）。 */
  try {
    const now = Date.now()
    for (const entry of fs.readdirSync(importDir)) {
      if (!entry.endsWith('.pptx')) continue
      const file = path.join(importDir, entry)
      try {
        if (now - fs.statSync(file).mtimeMs > FILE_TTL_MS) fs.rmSync(file, { force: true })
      } catch { /* 单个文件清理失败忽略 */ }
    }
  } catch { /* 目录不可读忽略 */ }

  const results = new Map()
  let saving = false
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, value] of results) {
      if (now - value.ts > RESULT_TTL_MS) results.delete(key)
    }
  }, 60_000)
  timer.unref?.()

  return async function importRoutes(req, res, u) {
    const pathname = u.pathname
    if (prefix && pathname !== prefix && !pathname.startsWith(prefix + '/')) return false
    const sub = prefix ? pathname.slice(prefix.length) : pathname

    /* 原始字节上传 */
    if (sub === '/import-file' && req.method === 'POST') {
      let body
      try {
        body = await readRawBody(req, MAX_UPLOAD_BYTES)
      } catch (error) {
        const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
        send(req, res, status, { error: String(error.message || error) })
        return true
      }
      if (!body.length) {
        send(req, res, 400, { error: '上传内容为空' })
        return true
      }
      /* ZIP 魔数：pptx 必须是 OOXML 包，提前拦住误传的图片/JSON。 */
      if (body[0] !== 0x50 || body[1] !== 0x4b) {
        send(req, res, 400, { error: '不是有效的 PPTX 文件（缺少 ZIP/OOXML 头）' })
        return true
      }
      const id = crypto.randomBytes(12).toString('hex')
      const name = safeName(req.headers['x-file-name'])
      const file = path.join(importDir, `${id}.pptx`)
      try {
        await fs.promises.writeFile(file, body)
      } catch (error) {
        send(req, res, 500, { error: '写入临时文件失败：' + String(error.message || error) })
        return true
      }
      /* 记录源文件路径：编辑器“保存回原文件”按钮据此写回。 */
      const sourceHeader = req.headers['x-source-path']
      if (sourceHeader) {
        try {
          const sourcePath = decodeURIComponent(String(sourceHeader))
          if (sourcePath) {
            fs.writeFileSync(sourceRecord, JSON.stringify({ path: sourcePath, name, ts: Date.now() }))
          }
        } catch { /* 源路径只影响保存按钮，不阻塞导入 */ }
      }
      send(req, res, 200, {
        ok: true,
        id,
        name,
        bytes: body.length,
        url: `${prefix}/import-file/${id}`,
      })
      return true
    }

    /* 编辑器取回原始字节 */
    if (sub.startsWith('/import-file/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const id = sub.slice('/import-file/'.length)
      if (!ID_RE.test(id)) {
        send(req, res, 404, { error: '导入文件不存在' })
        return true
      }
      const file = path.join(importDir, `${id}.pptx`)
      let data
      try {
        data = fs.readFileSync(file)
      } catch {
        send(req, res, 404, { error: '导入文件不存在或已清理' })
        return true
      }
      res.writeHead(200, {
        'content-type': PPTX_MIME,
        'content-length': data.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(req.method === 'HEAD' ? undefined : data)
      return true
    }

    /* 编辑器回传导入结果 */
    if (sub === '/import-result' && req.method === 'POST') {
      let body
      try {
        body = await readBody(req, MAX_RESULT_BYTES)
      } catch (error) {
        send(req, res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: String(error.message || error) })
        return true
      }
      if (!body || typeof body.req !== 'string' || !body.req) {
        send(req, res, 400, { error: '缺少 import req' })
        return true
      }
      results.set(body.req, jsonResult(body))
      if (body.id && ID_RE.test(String(body.id))) {
        try { fs.rmSync(path.join(importDir, `${body.id}.pptx`), { force: true }) } catch { /* 忽略 */ }
      }
      send(req, res, 200, { ok: true })
      return true
    }

    /* MCP 工具轮询结果 */
    if (sub === '/import-result' && (req.method === 'GET' || req.method === 'HEAD')) {
      const reqId = u.searchParams.get('req') || ''
      const result = reqId ? results.get(reqId) : null
      send(req, res, 200, result || { done: false })
      return true
    }

    /* 编辑器“保存回原文件”：把当前 deck 导出到导入时记录的源路径，先备份。 */
    if (sub === '/save-pptx' && req.method === 'POST') {
      if (!store) {
        send(req, res, 503, { error: 'store 未就绪' })
        return true
      }
      if (saving) {
        send(req, res, 409, { error: '已有保存任务在进行中' })
        return true
      }
      let record = null
      try { record = JSON.parse(fs.readFileSync(sourceRecord, 'utf8')) } catch { /* 没有记录 */ }
      const target = String(record?.path || '')
      if (!target || !/\.pptx$/i.test(target)) {
        send(req, res, 409, { error: '当前 deck 不是从本机 .pptx 打开的；请让 agent 用 ppt_export_pptx 另存' })
        return true
      }
      const deck = store.get().deck
      if (!deck || !Array.isArray(deck.slides) || !deck.slides.length) {
        send(req, res, 409, { error: '当前 deck 没有幻灯片' })
        return true
      }

      saving = true
      try {
        const host = req.headers.host || `127.0.0.1:39311`
        const { buffer, stats } = await renderDeckToPptx(deck, {
          assetBase: `http://${host}${prefix}`,
          includeNotes: true,
        })
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
        const backup = target.replace(/\.pptx$/i, `.bak-${stamp}.pptx`)
        if (fs.existsSync(target)) fs.copyFileSync(target, backup)
        fs.writeFileSync(target, buffer)
        send(req, res, 200, { ok: true, path: target, backup, bytes: buffer.length, stats })
      } catch (error) {
        send(req, res, 500, { error: '保存回原文件失败（可能被 PowerPoint 占用）：' + String(error.message || error) })
      } finally {
        saving = false
      }
      return true
    }

    return false
  }
}
