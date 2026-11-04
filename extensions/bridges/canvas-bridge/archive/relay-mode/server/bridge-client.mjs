/** Canvas 桥 HTTP 客户端（MCP 侧）：独立连接 + 指令推送/回执 + 分层读取。 */
import nodeHttp from 'node:http'

export const BASE = (process.env.CANVAS_BRIDGE_URL
  || 'http://127.0.0.1:3310/api/desktop/works/canvas-bridge').replace(/\/+$/, '')

export const get = (path = '') => http('GET', BASE + path)
export const post = (path, body) => http('POST', BASE + path, body)
export const push = (cmds, title) => post('', { cmds, title })
export const status = () => get('/status')
export const docView = () => get('/doc')
export const textView = () => get('/text')
export const summary = () => get('/summary')
export const shot = () => get('/shot')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等编辑器把本次 seq 应用完（applied_seq 追上）且推完镜像（state_seq 追上）。*/
export async function waitApplied(seq, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  let st = await status()
  while (Date.now() < deadline) {
    const appliedOk = Number(st.applied_seq || 0) >= Number(seq)
    const stateOk = Number(st.state_seq || 0) >= Number(seq)
    if ((appliedOk && stateOk) || st.error) return st
    await sleep(120)
    st = await status()
  }
  return st
}

/** 等截图回传（req 匹配且 data 非空）。 */
export async function waitShot(req, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await shot()
    if (Number(s.req || 0) === Number(req) && s.data) return s
    await sleep(150)
  }
  return { req, data: '' }
}

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
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(
            `canvas-bridge ${method} ${url} -> HTTP ${res.statusCode} ${data.slice(0, 200)}`
            + (res.statusCode === 404 ? '（桌面网关未启动或版本过旧？）' : '')))
        }
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('canvas-bridge 返回非 JSON: ' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}
