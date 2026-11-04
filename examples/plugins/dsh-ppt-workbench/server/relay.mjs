/**
 * 桥 relay：单进程承载三件事——
 *   1) 桥端点（与桌面网关同路径契约：/api/desktop/works/ppt-bridge…）
 *   2) MCP Streamable HTTP 端点（/mcp，工具实现复用 src/mcp/tools.mjs）
 *   3) 编辑器静态页（/、/app.js、/ppt-full-app.js）
 *
 * 端口策略：首选 39311；被占时先探测对方身份——是本桥（旧 relay 还活着）
 * 就直接复用并上报 reused；否则向后扫描最多 50 个端口。实际地址写入
 * hostDir/bridge.json。MCP 的 URL 是 patch 里的静态常量，所以 39311 被
 * 外部应用抢占时 mcp 工具会连接失败（工具结果里会提示），属可接受降级。
 *
 * 也可脱离 dsh 独立运行：node server/relay.mjs [--port 39311] [--dir <hostDir>]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BridgeStore,
  sanitizePush, sanitizeAck, sanitizeState, sanitizeShotResult, sanitizeClaim,
} from './store.mjs'
import { createMcpHandler, serverInstructions } from './mcp-http.mjs'
import { acquireLock, writeLock } from './single-instance.mjs'

export const DEFAULT_PORT = 39311
export const BASE_PATH = '/api/desktop/works/ppt-bridge'
const EDITOR_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ppt-full-app.js': ['ppt-full-app.js', 'text/javascript; charset=utf-8'],
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function send(req, res, code, obj) {
  const body = obj === undefined ? '' : JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

function loopback(method, url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      timeout: timeoutMs, agent: false,
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, text: data }))
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
    req.end()
  })
}

export async function startRelay({
  port = DEFAULT_PORT,
  hostDir = process.env.PPT_BRIDGE_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh-ppt-bridge'),
  packageDir = PKG_ROOT,
  scanLimit = 50,
} = {}) {
  /* ---- 单实例检查：确保同一时间只有一个 relay 运行 ---- */
  if (!acquireLock()) {
    throw new Error('ppt-bridge relay 已有另一个实例在运行');
  }

  const editorDir = path.join(packageDir, 'editor')
  const store = new BridgeStore(path.join(hostDir, 'state.json'))
  let actualPort = 0
  let server = null

  /* ---- 复用探测：39311 上若已是本桥，直接复用 ---- */
  if (port !== 0) {
    try {
      const probe = await loopback('GET', `http://127.0.0.1:${port}${BASE_PATH}/status`)
      if (probe.status === 200 && probe.text.includes('"bridge":"ppt-workbench"')) {
        const url = `http://127.0.0.1:${port}${BASE_PATH}`
        writeDiscovery(hostDir, url, 0)
        return { url, editorUrl: `http://127.0.0.1:${port}/`, port, reused: true, stop: async () => {} }
      }
    } catch (e) { /* 没有活的 relay，正常走监听 */ }
  }

  /* ---- 端口扫描 + 监听 ---- */
  for (let attempt = 0; attempt <= scanLimit; attempt++) {
    const tryPort = port === 0 ? 0 : port + attempt
    try {
      server = await listen(tryPort)
      actualPort = server.address().port
      break
    } catch (e) {
      if (port === 0 || attempt === scanLimit) throw e
    }
  }

  /* ---- 写入单实例锁文件（包含端口信息）---- */
  writeLock(actualPort);

  /* ---- MCP：工具实现来自 src/mcp/tools.mjs（构建期拷贝到本目录）。
   * bridge-client 在 import 时读 PPT_BRIDGE_URL，必须先设 env 再 import。 */
  process.env.PPT_BRIDGE_URL = `http://127.0.0.1:${actualPort}${BASE_PATH}`
  let TOOLS = []
  let TOOL_IMPL = {}
  try {
    const tools = await import('./tools.mjs')
    TOOLS = tools.TOOLS
    TOOL_IMPL = tools.TOOL_IMPL
  } catch (e) {
    console.error('[ppt-workbench] 工具未装载（构建产物缺失，先跑 scripts/build-plugin.mjs）:', e.message)
  }
  const mcpHandler = createMcpHandler({
    tools: TOOLS,
    callTool: (name, args) => {
      const impl = TOOL_IMPL[name]
      if (!impl) throw new Error('未知工具: ' + name)
      return impl(args)
    },
    serverInfo: { name: 'ppt-workbench', version: '1.0.0' },
    instructions: serverInstructions(`http://127.0.0.1:${actualPort}/`),
  })

  /* ---- 桥长轮询（桌面 watch 的移植：单进程内 50ms 复核；aborted 由
   * 各请求自备，避免并发 watch 互相误清）---- */
  function watchDoc(seq0, shot0, timeoutS, aborted) {
    const timeout = Math.min(Math.max(Number(timeoutS) || 20, 1), 30)
    return new Promise((resolve) => {
      const deadline = Date.now() + timeout * 1000
      const tick = () => {
        if (aborted()) return
        const doc = store.get()
        if ((doc.seq | 0) !== seq0 || (doc.shot_req | 0) !== shot0 || Date.now() > deadline) {
          return resolve(doc)
        }
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  server.on('request', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const p = u.pathname
    try {
      /* ---- MCP ---- */
      if (p === '/mcp') return await mcpHandler(req, res)

      /* ---- 静态编辑器 ---- */
      if (EDITOR_FILES[p]) {
        const [name, type] = EDITOR_FILES[p]
        const file = path.join(editorDir, name)
        try {
          const data = fs.readFileSync(file)
          res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-cache' })
          return res.end(req.method === 'HEAD' ? undefined : data)
        } catch (e) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('编辑器产物缺失，请先运行: node scripts/build-plugin.mjs')
        }
      }

      /* ---- 桥端点（主端点 + 子路径，轻量读取同块分派避免被前缀拦截）---- */
      if (p === BASE_PATH || p.startsWith(BASE_PATH + '/')) {
        const sub = p.slice(BASE_PATH.length)
        if (sub === '' || sub === '/') {
          if (req.method === 'POST') {
            const body = await readBody(req)
            const doc = sanitizePush(body)
            if (!doc) return send(req, res, 400, { error: 'ppt-bridge 数据不合法' })
            return send(req, res, 200, store.push(doc.cmds, doc.title))
          }
          return send(req, res, 200, store.get())
        }
        if (sub === '/watch' && (req.method === 'GET' || req.method === 'HEAD')) {
          let aborted = false
          req.on('close', () => { aborted = true })
          const doc = await watchDoc(intQ(u, 'seq'), intQ(u, 'shot'), u.searchParams.get('timeout'), () => aborted)
          if (aborted || res.writableEnded || res.destroyed) return
          return send(req, res, 200, doc)
        }
        /* 轻量读取：status（~200B，MCP 轮询用）/ deck / shot（截图就绪后一次取回） */
        if ((sub === '/status' || sub === '/deck' || sub === '/shot')
          && (req.method === 'GET' || req.method === 'HEAD')) {
          const doc = store.get()
          if (sub === '/status') {
            const owner = doc.owner
            return send(req, res, 200, {
              seq: doc.seq | 0, applied_seq: doc.applied_seq | 0, applied: doc.applied | 0,
              error: doc.error || '', shot_req: doc.shot_req | 0,
              shot: { req: (doc.shot && doc.shot.req) || 0 },
              state_seq: doc.state_seq | 0,
              owner: owner && owner.id
                ? { id: owner.id, age: Math.round((Date.now() / 1000 - owner.ts) * 100) / 100 }
                : null,
              has_deck: !!(doc.deck && doc.deck.slides && doc.deck.slides.length),
              updated: doc.updated || 0,
              bridge: 'ppt-workbench',
            })
          }
          if (sub === '/deck') {
            return send(req, res, 200, {
              deck: doc.deck || {}, state_seq: doc.state_seq | 0, applied_seq: doc.applied_seq | 0,
            })
          }
          return send(req, res, 200, {
            req: (doc.shot && doc.shot.req) || 0, data: (doc.shot && doc.shot.data) || '',
          })
        }
        if (req.method !== 'POST') return send(req, res, 404, { error: 'not found' })
        const body = await readBody(req).catch(() => null)
        if (sub === '/claim') {
          const d = sanitizeClaim(body)
          if (!d) return send(req, res, 400, { error: 'ppt-bridge 所有权声明不合法' })
          return send(req, res, 200, store.claim(d.id))
        }
        if (sub === '/release') {
          const d = sanitizeClaim(body)
          if (!d) return send(req, res, 400, { error: 'ppt-bridge 所有权声明不合法' })
          return send(req, res, 200, store.release(d.id))
        }
        if (sub === '/ack') {
          const d = sanitizeAck(body)
          if (!d) return send(req, res, 400, { error: 'ppt-bridge 回执不合法' })
          return send(req, res, 200, store.ack(d.seq, d.applied, d.error))
        }
        if (sub === '/state') {
          const d = sanitizeState(body)
          if (!d) return send(req, res, 400, { error: 'ppt-bridge 状态不合法' })
          return send(req, res, 200, store.state(d.deck, d.seq))
        }
        if (sub === '/shot-request') return send(req, res, 200, store.shotRequest())
        if (sub === '/shot-result') {
          const d = sanitizeShotResult(body)
          if (!d) return send(req, res, 400, { error: 'ppt-bridge 截图回传不合法' })
          return send(req, res, 200, store.shotResult(d.req, d.data))
        }
        return send(req, res, 404, { error: 'not found' })
      }

      /* ---- 健康 ---- */
      if (p === '/healthz') {
        return send(req, res, 200, {
          ok: true, bridge: 'ppt-workbench', pid: process.pid, port: actualPort,
          editor: `http://127.0.0.1:${actualPort}/`,
        })
      }

      send(req, res, 404, { error: 'not found' })
    } catch (e) {
      if (!res.headersSent) send(req, res, 500, { error: String((e && e.message) || e) })
      else res.destroy()
    }
  })

  const url = `http://127.0.0.1:${actualPort}${BASE_PATH}`
  writeDiscovery(hostDir, url, actualPort)
  return {
    url,
    editorUrl: `http://127.0.0.1:${actualPort}/`,
    port: actualPort,
    reused: false,
    stop: () => new Promise((r) => server.close(() => r())),
  }
}

function intQ(u, name) {
  const n = parseInt(u.searchParams.get(name) || '0', 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer()
    s.on('error', reject)
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

function writeDiscovery(hostDir, url, port) {
  try {
    fs.mkdirSync(hostDir, { recursive: true })
    fs.writeFileSync(path.join(hostDir, 'bridge.json'), JSON.stringify({
      bridge: 'ppt-workbench', url, port, pid: process.pid, updated: new Date().toISOString(),
    }, null, 2))
  } catch (e) { /* 发现文件写失败不影响服务 */ }
}

/* ---- 独立运行入口（无 dsh 也可手动拉起，供调试/演示）---- */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
  }
  const relay = await startRelay({ port: Number(arg('--port', DEFAULT_PORT)) || DEFAULT_PORT })
  console.log('[ppt-workbench] 桥:', relay.url)
  console.log('[ppt-workbench] 编辑器:', relay.editorUrl, '(浏览器打开即用)')
  console.log('[ppt-workbench] MCP 端点:', relay.url.replace(BASE_PATH, '/mcp'))
}
