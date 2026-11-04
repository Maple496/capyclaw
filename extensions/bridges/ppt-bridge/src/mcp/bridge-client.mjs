/** 桥 HTTP 客户端（MCP 侧）：keep-alive 连接复用 + 指令推送/回执 + deck 摘要。 */
import nodeHttp from 'node:http'
import { textHolder, htmlOf } from '../core/text.js'
import { getTuning } from './tuning.mjs'

export const BASE = (process.env.PPT_BRIDGE_URL || 'http://127.0.0.1:3311/api/desktop/works/ppt-bridge').replace(/\/+$/, '')

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/* keep-alive 连接池：同 host 复用 TCP，省去每次 handshake；
 * server 关闭时 agent 自动重连，不会积压僵尸连接。 */
const keepAliveAgent = new nodeHttp.Agent({ keepAlive: true, maxSockets: 8 })

export const getDeck = () => http('GET', BASE)
export const get = (path) => http('GET', BASE + path)
export const post = (path, body, options) => http('POST', BASE + path, body, options)

/** 轻量读取（2026-10-22）：轮询只取状态，不拉 deck / 截图 base64。
 *  旧实现每次 push 回执轮询都拉完整文档（含上一张截图 2-4MB），
 *  一次工具调用最多轮询 120 次 ≈ 数百 MB 本地传输 + JSON 解析。 */
export const getStatus = () => http('GET', BASE + '/status', undefined, { timeoutMs: 5000 })
export const getDeckOnly = async () => {
  let d = await http('GET', BASE + '/deck', undefined, { timeoutMs: 15000 })
  /* 新编辑器先回执后镜像：等镜像追上本次指令（旧编辑器 state_seq=0，直接返回） */
  const deadline = Date.now() + 2000
  while (d.state_seq > 0 && d.state_seq < (d.applied_seq || 0) && Date.now() < deadline) {
    await sleep(getTuning().statusPollMs || 100)
    d = await http('GET', BASE + '/deck', undefined, { timeoutMs: 15000 })
  }
  return d
}
export const getShot = () => http('GET', BASE + '/shot', undefined, { timeoutMs: 30000 })

/** 把图片写入 relay 的对象仓库，返回 /assets/<sha256> 引用。 */
export const putAsset = (bytes, contentType = 'application/octet-stream') =>
  post('/assets', { data: Buffer.from(bytes).toString('base64'), contentType }, { timeoutMs: 30000 })

/** 上传待导入的 PPTX（原始字节，不走 base64），返回临时下载地址。 */
export const uploadImport = (bytes, name = 'import.pptx', sourcePath = '') =>
  http('POST', BASE + '/import-file', undefined, {
    body: Buffer.from(bytes),
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'x-file-name': encodeURIComponent(String(name || 'import.pptx')),
      ...(sourcePath ? { 'x-source-path': encodeURIComponent(String(sourcePath)) } : {}),
    },
    timeoutMs: 120000,
  })

/** 读取编辑器回传的导入结果；done=false 表示仍在处理。 */
export const getImportResult = (req) => get('/import-result?req=' + encodeURIComponent(String(req || '')))

/** 本机回环请求：每条独立连接（agent:false）。
 *  2026-10-21 实测坑：fetch 连接池会在网关重启后复用僵尸 keep-alive
 *  连接，服务端把它当坏请求回 501。
 *  2026-10-31：补 connect/response 超时与响应体上限；桥挂起时不再永久卡住工具。 */
function http(method, url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const raw = Buffer.isBuffer(options.body) ? options.body : null
    const payload = raw || (body ? Buffer.from(JSON.stringify(body)) : null)
    const headers = { ...(options.headers || {}) }
    if (payload) {
      if (!raw && !headers['content-type']) headers['content-type'] = 'application/json'
      headers['content-length'] = payload.length
    }
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || Number(getTuning().httpRequestTimeoutMs) || 15000)
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const req = nodeHttp.request({
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname + u.search, method, headers, agent: keepAliveAgent,
    }, (res) => {
      let data = ''
      let size = 0
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        size += Buffer.byteLength(chunk)
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`bridge 响应超过 ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB 上限`))
          return
        }
        data += chunk
      })
      res.on('error', (error) => finish(reject, error))
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return finish(reject, new Error(`bridge ${method} ${url} -> HTTP ${res.statusCode} ${data.slice(0, 160)}`))
        }
        try { finish(resolve, JSON.parse(data)) }
        catch { finish(reject, new Error('bridge 返回非 JSON: ' + data.slice(0, 160))) }
      })
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`bridge ${method} ${url} 超时（${timeoutMs}ms）`))
    })
    req.on('error', (error) => finish(reject, error))
    if (payload) req.write(payload)
    req.end()
  })
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** 编辑器连接必须活跃（lease 有效）才允许推送。
 *  2026-10-22：此前无窗口/租约过期时仍盲等 12~30s，实测造成 20 次
 *  25~40s 的工具超时。现在最多等 graceMs 让新窗口完成 claim，随后立即失败。
 *  2026-10-30：错误信息只说"下一步做什么"，不暴露内部租约概念。 */
export async function requireEditor(graceMs = 4000) {
  const deadline = Date.now() + graceMs
  let st = await getStatus()
  while (true) {
    if (st.owner && Number(st.owner.age || 0) <= 10) return st
    if (Date.now() >= deadline) {
      throw new Error('PPT 编辑器窗口尚未连接：请打开右侧「浏览器」面板访问 http://127.0.0.1:39311 ，页面加载完成后会自动连接，无需其他操作')
    }
    await sleep(getTuning().statusPollMs || 200)
    st = await getStatus()
  }
}

export async function push(cmds, title) {
  if (!Array.isArray(cmds)) throw new Error('没有可执行的指令')
  if (!cmds.length && !title) throw new Error('没有可执行的指令')
  /* 解耦批：写操作在服务端执行，不依赖编辑器页面在线 */
  const doc = await post('', { cmds, title: title || '' }, { timeoutMs: 30000 })
  const seq = doc.seq
  const tuning = getTuning()
  /* 批次越大，服务端执行时间越长；固定 12s 会把合法的 100 条批次误判为超时。 */
  const baseDeadline = Number(tuning.pushBaseDeadlineMs) || 12000
  const perOp = Number(tuning.pushPerOpMs) || 0
  const deadline = Date.now() + Math.min(baseDeadline + cmds.length * perOp, 110000)
  while (Date.now() < deadline) {
    const cur = await getStatus()
    if (cur.applied_seq >= seq) {
      return { seq, applied: cur.applied, error: cur.error || '', ok: !cur.error }
    }
    await sleep(tuning.statusPollMs || 100)
  }
  return { seq, applied: 0, error: '等待编辑器应用超时（右侧面板是否已打开？）', ok: false }
}

export const okText = (r, msg) => ({
  text: r.ok ? `${msg}（seq ${r.seq}，${r.applied} 条）` : `应用失败：${r.error}`,
})

/** 紧凑 deck 摘要；detailed 时附元素几何/颜色。 */
export function summarize(deck, detailed) {
  if (!deck || !Array.isArray(deck.slides)) return '（桥上没有 deck：右侧编辑器未就绪）'
  const lines = [`标题：${deck.title || '未命名'}`, `共 ${deck.slides.length} 页`]
  deck.slides.forEach((s, i) => {
    const bg = s.background ? (s.background.type === 'solid' ? s.background.color : s.background.type) : '默认'
    lines.push(`[${i}] id=${s.id || '-'} 背景=${bg}`)
    ;(s.elements || []).forEach(e => {
      const holder = textHolder(e)
      if (holder) {
        const t = String(htmlOf(e) || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        const geom = detailed ? ` (${Math.round(e.left)},${Math.round(e.top)} ${Math.round(e.width)}x${Math.round(e.height)}${e.color ? ' ' + e.color : ''})` : ''
        const label = e.type === 'text' ? '文本' : '形状文本'
        const fill = detailed && e.type === 'shape' ? ` fill=${e.fill || ''}` : ''
        lines.push(`  - ${label}#${e.id}${geom}${fill}：${t.slice(0, 80)}`)
      } else {
        const geom = detailed ? ` (${Math.round(e.left)},${Math.round(e.top)} ${Math.round(e.width)}x${Math.round(e.height)}) fill=${e.fill || ''}` : ''
        lines.push(`  - ${e.type}#${e.id}${geom}`)
      }
    })
  })
  return lines.join('\n')
}
