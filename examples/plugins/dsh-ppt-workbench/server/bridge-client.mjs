/** 桥 HTTP 客户端（MCP 侧）：独立连接 + 指令推送/回执 + deck 摘要。 */
import nodeHttp from 'node:http'

export const BASE = (process.env.PPT_BRIDGE_URL || 'http://127.0.0.1:3311/api/desktop/works/ppt-bridge').replace(/\/+$/, '')

export const getDeck = () => http('GET', BASE)
export const post = (path, body) => http('POST', BASE + path, body)

/** 轻量读取（2026-10-22）：轮询只取状态，不拉 deck / 截图 base64。
 *  旧实现每次 push 回执轮询都拉完整文档（含上一张截图 2-4MB），
 *  一次工具调用最多轮询 120 次 ≈ 数百 MB 本地传输 + JSON 解析。 */
export const getStatus = () => http('GET', BASE + '/status')
export const getDeckOnly = async () => {
  let d = await http('GET', BASE + '/deck')
  /* 新编辑器先回执后镜像：等镜像追上本次指令（旧编辑器 state_seq=0，直接返回） */
  const deadline = Date.now() + 2000
  while (d.state_seq > 0 && d.state_seq < (d.applied_seq || 0) && Date.now() < deadline) {
    await sleep(100)
    d = await http('GET', BASE + '/deck')
  }
  return d
}
export const getShot = () => http('GET', BASE + '/shot')

/** 本机回环请求：每条独立连接（agent:false）。
 *  2026-10-21 实测坑：fetch 连接池会在网关重启后复用僵尸 keep-alive
 *  连接，服务端把它当坏请求回 501。 */
function http(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = body ? JSON.stringify(body) : ''
    const headers = payload
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {}
    const req = nodeHttp.request({
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname + u.search, method, headers, agent: false,
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`bridge ${method} ${url} -> HTTP ${res.statusCode} ${data.slice(0, 160)}`))
        }
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('bridge 返回非 JSON: ' + data.slice(0, 160))) }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** 编辑器必须已接管（owner 租约有效）才允许推送。
 *  2026-10-22：此前无窗口/租约过期时仍盲等 12~30s，实测造成 20 次
 *  25~40s 的工具超时。现在最多等 graceMs 让新窗口完成 claim，随后立即失败。 */
export async function requireEditor(graceMs = 2500) {
  const deadline = Date.now() + graceMs
  let st = await getStatus()
  while (true) {
    if (st.owner && Number(st.owner.age || 0) <= 15) return st
    if (Date.now() >= deadline) {
      throw new Error('编辑器未接管：请确认右侧「Keynote 一体工作台」窗口已打开（或点重连）')
    }
    await sleep(200)
    st = await getStatus()
  }
}

export async function push(cmds, title) {
  if (!Array.isArray(cmds) || !cmds.length) throw new Error('没有可执行的指令')
  await requireEditor()
  const doc = await post('', { cmds, title: title || '' })
  const seq = doc.seq
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const cur = await getStatus()
    if (cur.applied_seq >= seq) {
      return { seq, applied: cur.applied, error: cur.error || '', ok: !cur.error }
    }
    await sleep(100)
  }
  return { seq, applied: 0, error: '等待编辑器应用超时（工作台是否打开？）', ok: false }
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
      if (e.type === 'text') {
        const t = String(e.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        const geom = detailed ? ` (${Math.round(e.left)},${Math.round(e.top)} ${Math.round(e.width)}x${Math.round(e.height)}${e.color ? ' ' + e.color : ''})` : ''
        lines.push(`  - 文本#${e.id}${geom}：${t.slice(0, 80)}`)
      } else {
        const geom = detailed ? ` (${Math.round(e.left)},${Math.round(e.top)} ${Math.round(e.width)}x${Math.round(e.height)}) fill=${e.fill || ''}` : ''
        lines.push(`  - ${e.type}#${e.id}${geom}`)
      }
    })
  })
  return lines.join('\n')
}
