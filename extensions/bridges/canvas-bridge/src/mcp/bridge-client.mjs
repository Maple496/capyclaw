/**
 * 桥 HTTP 客户端（MCP 侧）：keep-alive 连接复用 + 指令推送/回执 + doc 摘要。
 * Canvas 是编辑器权威（authority:'editor'）：push 只入队，编辑器应用后 ack。
 */
import nodeHttp from 'node:http'
import { summarize } from '../core/doc.js'
import { getTuning } from './tuning.mjs'

const DEFAULT_BASE = 'http://127.0.0.1:39313/api/desktop/works/canvas-bridge'

/** 桥地址在调用时解析（不是 import 时）：同一进程里 relay 可换址（测试），
 *  relay 启动后回填 CANVAS_BRIDGE_URL。 */
export const baseUrl = () => String(process.env.CANVAS_BRIDGE_URL || DEFAULT_BASE).replace(/\/+$/, '')

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const keepAliveAgent = new nodeHttp.Agent({ keepAlive: true, maxSockets: 8 })

export const getDoc = () => http('GET', baseUrl())
export const get = (path) => http('GET', baseUrl() + path)
export const post = (path, body, options) => http('POST', baseUrl() + path, body, options)

/** 轻量状态：轮询只取状态，不拉 doc / 截图 base64。 */
export const getStatus = () => http('GET', baseUrl() + '/status', undefined, { timeoutMs: 5000 })

/** 轻量视图：summary/text/outline 在 relay 侧投影，读路径不拉全量镜像。
 *  视图自带 seq/state_seq：镜像落后于最新批次时（编辑器先回执后推镜像），
 *  用廉价的 /view 重试等它追上——不会整份拉镜像。 */
export async function getView(mode) {
  const deadline = Date.now() + 2000
  for (;;) {
    const view = await http('GET', baseUrl() + `/view?mode=${encodeURIComponent(mode)}`, undefined, { timeoutMs: 15000 })
    if (!(view.state_seq > 0 && view.state_seq < (view.seq | 0)) || Date.now() >= deadline) return view
    await sleep(getTuning().statusPollMs || 50)
  }
}

/** 读文档镜像（含 state_seq/applied_seq）。
 *  编辑器先回执后镜像：先用廉价的 /status 等镜像追上，再拉一次全量 /doc——
 *  避免大镜像被反复整份传输（旧实现每 100ms 拉 /doc 一次）。 */
export async function getDocOnly() {
  const deadline = Date.now() + 2000
  for (;;) {
    const st = await getStatus()
    if (!(st.state_seq > 0 && st.state_seq < (st.applied_seq || 0)) || Date.now() >= deadline) break
    await sleep(getTuning().statusPollMs || 50)
  }
  return http('GET', baseUrl() + '/doc', undefined, { timeoutMs: 15000 })
}

export const getShot = () => http('GET', baseUrl() + '/shot', undefined, { timeoutMs: 30000 })

/** 把图片写入 relay 的对象仓库，返回 /assets/<sha256> 引用。 */
export const putAsset = (bytes, contentType = 'application/octet-stream') =>
  post('/assets', { data: Buffer.from(bytes).toString('base64'), contentType }, { timeoutMs: 30000 })

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
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15000)
    let settled = false
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value) } }
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 编辑器连接必须活跃（owner 租约有效）才允许推送：
 * Canvas 是编辑器权威，没有页面就没有执行者。 */
export async function requireEditor(graceMs = 4000) {
  let editorUrl = 'http://127.0.0.1:39313/'
  try { editorUrl = new URL(baseUrl()).origin + '/' } catch { /* 非法地址时保留默认 */ }
  const deadline = Date.now() + graceMs
  let st = await getStatus()
  for (;;) {
    if (st.owner && Number(st.owner.age || 0) <= 10) return st
    if (Date.now() >= deadline) {
      throw new Error(`Canvas 编辑器页面尚未连接：请打开 ${editorUrl} ，页面加载完成后会自动连接，无需其他操作`)
    }
    await sleep(200)
    st = await getStatus()
  }
}

/** 进程内写互斥：编辑器权威下 cmds 队列会被下一次 push 覆盖，
 *  并发 push 会丢批次（批次 N 未回执时 N+1 到达，编辑器只看到 N+1）。
 *  所有工具同进程走这里 → 推 N+1 前必等 N 回执，彻底关闭竞态窗口。 */
let writeChain = Promise.resolve()

/** 推送指令并等编辑器应用（编辑器权威：push 入队 → 页面应用 → ack）。
 *  等待节奏来自 tuning（statusPollMs / pushBaseDeadlineMs / pushPerOpMs）。 */
export function push(cmds, title) {
  const attempt = () => pushOnce(cmds, title)
  const next = writeChain.then(attempt, attempt)
  writeChain = next.catch(() => { /* 失败不阻塞后续批次 */ })
  return next
}

async function pushOnce(cmds, title) {
  if (!Array.isArray(cmds)) throw new Error('没有可执行的指令')
  if (!cmds.length && !title) throw new Error('没有可执行的指令')
  const doc = await post('', { cmds, title: title || '' }, { timeoutMs: 30000 })
  const seq = doc.seq
  const tuning = getTuning()
  const baseDeadline = Number(tuning.pushBaseDeadlineMs) || 12000
  const perOp = Number(tuning.pushPerOpMs) || 0
  const deadline = Date.now() + Math.min(baseDeadline + cmds.length * perOp, 110000)
  while (Date.now() < deadline) {
    const cur = await getStatus()
    if (cur.applied_seq >= seq) {
      return { seq, applied: cur.applied, error: cur.error || '', ok: !cur.error }
    }
    await sleep(tuning.statusPollMs || 50)
  }
  return { seq, applied: 0, error: '等待编辑器应用超时（编辑器页面是否已打开？）', ok: false }
}

export const okText = (r, msg) => ({
  text: r.ok ? `${msg}（seq ${r.seq}，${r.applied} 条）` : `应用失败：${r.error}`,
})

/** doc 摘要（模型可读）。 */
export { summarize }
