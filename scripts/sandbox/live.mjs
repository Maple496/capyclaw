/**
 * 沙箱实测：对「npm 渠道安装形态」的 workbench 包做服务级验证。
 * canvas 走真浏览器全链路（编辑器权威架构要求页面 claim），ppt 做对称冒烟。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { ROOT, randomPort, startService, waitFor, getJson, mcpCaller, mcpText, tempDir } from '../e2e/harness.mjs'

const require2 = createRequire(path.join(ROOT, 'extensions', 'bridges', 'canvas-bridge', 'package.json'))

/** 通用断言记录。 */
function tally(rec) {
  return (label, cond, detail = '') => rec.check(label, cond, detail)
}

/** playwright chromium（来自 canvas-bridge workspace；缺浏览器时给指引）。 */
async function launchBrowser() {
  const { chromium } = require2('playwright')
  return chromium.launch({ headless: true })
}

/** canvas 全链路：relay → 真浏览器页面 claim → 22 工具核心链路 → 导出/历史。 */
export async function canvasLive(rec, { wbDir }) {
  const check = tally(rec)
  const port = randomPort()
  const state = tempDir('sandbox-canvas')
  const relay = path.join(wbDir, 'server', 'relay.mjs')
  const svc = await startService(process.execPath, [relay, '--port', String(port), '--dir', state], {
    logFile: path.join(state, 'relay.log'), timeoutMs: 30000,
    readyFn: async () => (await getJson(`http://127.0.0.1:${port}/healthz`, 3000).catch(() => null))?.ok === true || null,
  })
  let browser = null
  try {
    const h = await getJson(`http://127.0.0.1:${port}/healthz`)
    check('canvas relay /healthz + contractsOk', h.ok === true && h.contractsOk === true)

    browser = await launchBrowser()
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.CanvasApp && window.CanvasApp.isMounted(), { timeout: 20000 })
    await page.waitForFunction(async (base) => {
      const r = await fetch(`${base}/status`).then((x) => x.json()).catch(() => null)
      return !!(r && r.owner && r.owner.age <= 10)
    }, `http://127.0.0.1:${port}`, { timeout: 20000 })
    check('canvas 编辑器页面挂载并 claim（无页面错误）', pageErrors.length === 0, pageErrors.join(' | '))

    const rpc = mcpCaller(port)
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} })
    check('canvas /mcp initialize', init?.result?.serverInfo?.name === 'canvas-workbench', JSON.stringify(init?.result?.serverInfo || init).slice(0, 100))
    const listed = await rpc('tools/list')
    check('canvas tools/list = 22', (listed?.result?.tools || []).length === 22)

    const call = async (name, a = {}) => JSON.parse(mcpText(await rpc('tools/call', { name, arguments: a })))
    const write = mcpText(await rpc('tools/call', {
      name: 'canvas_write_document',
      arguments: {
        title: '沙箱验收',
        blocks: [
          { type: 'heading', level: 1, text: 'Canvas npm 安装形态验收' },
          { type: 'paragraph', text: '本链路验证 dsh 用户从 npm 渠道拿到的包可用。' },
          { type: 'bullet', text: 'npm 渠道安装（registry 或 tarball）' },
          { type: 'quote', text: '编辑器权威，每步落盘。' },
        ],
      },
    }))
    check('canvas_write_document 一次成稿', /已写入/.test(write), write.trim())

    const table = mcpText(await rpc('tools/call', { name: 'canvas_insert_table', arguments: { headers: ['环节', '状态'], rows: [['安装', '通过'], ['工具链', '通过']] } }))
    check('canvas_insert_table', /已插入表格/.test(table), table.trim())

    const styled = mcpText(await rpc('tools/call', { name: 'canvas_style', arguments: { find: '编辑器权威', style: { bold: true } } }))
    check('canvas_style 定位套样式', /已给 1 处文本套样式/.test(styled), styled.trim())

    const outline = mcpText(await rpc('tools/call', { name: 'canvas_read', arguments: { mode: 'outline' } }))
    check('canvas_read outline（标题树）', outline.includes('Canvas npm 安装形态验收'))

    const undo = mcpText(await rpc('tools/call', { name: 'canvas_history', arguments: { action: 'undo' } }))
    check('canvas_history undo', /undo|撤销/.test(undo), undo.trim())

    const ex = mcpText(await rpc('tools/call', { name: 'canvas_export', arguments: { name: 'sandbox-verify' } }))
    const htmlFiles = fs.readdirSync(state, { recursive: true }).filter((f) => String(f).endsWith('.html'))
    let htmlOk = false
    for (const f of htmlFiles) {
      if (fs.readFileSync(path.join(state, String(f)), 'utf8').includes('Canvas npm 安装形态验收')) { htmlOk = true; break }
    }
    check('canvas_export 产物含标题 HTML', htmlOk, ex.trim().slice(0, 120))

    await browser.close(); browser = null
    const h2 = await getJson(`http://127.0.0.1:${port}/healthz`)
    check('浏览器关闭后 relay 仍健康', h2?.ok === true)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await svc.stop()
    fs.rmSync(state, { recursive: true, force: true })
  }
}

/** ppt 对称冒烟：relay + MCP 握手 + 工具面 + 编辑器静态页。 */
export async function pptLive(rec, { wbDir }) {
  const check = tally(rec)
  const port = randomPort()
  const state = tempDir('sandbox-ppt')
  const relay = path.join(wbDir, 'server', 'relay.mjs')
  const svc = await startService(process.execPath, [relay, '--port', String(port), '--dir', state], {
    logFile: path.join(state, 'relay.log'), timeoutMs: 30000,
    readyFn: async () => (await getJson(`http://127.0.0.1:${port}/healthz`, 3000).catch(() => null))?.ok === true || null,
  })
  try {
    const h = await getJson(`http://127.0.0.1:${port}/healthz`)
    check('ppt relay /healthz + contractsOk', h.ok === true && h.contractsOk === true)
    const rpc = mcpCaller(port)
    const listed = await rpc('tools/list')
    check('ppt tools/list = 27', (listed?.result?.tools || []).length === 27)
    const cap = JSON.parse(mcpText(await rpc('tools/call', { name: 'ppt_capabilities', arguments: {} })))
    check('ppt_capabilities', typeof cap.contractVersion === 'string' && cap.toolCount === 27)
    for (const f of ['/index.html', '/app.js']) {
      const r = await fetch(`http://127.0.0.1:${port}${f}`, { signal: AbortSignal.timeout(8000) })
      check(`ppt 编辑器静态 ${f}`, r.status === 200)
    }
  } finally {
    await svc.stop()
    fs.rmSync(state, { recursive: true, force: true })
  }
}
