#!/usr/bin/env node
/**
 * PPTX 导入/导出真实端到端测试。
 *
 * 链路：
 *   ppt_deck（服务端造稿）→ ppt_export_pptx（Node 生成 .pptx）
 *   → 启动 headless Edge 打开 relay 编辑器（真实 PPTist PptApp）
 *   → ppt_import_pptx（上传 → view op → PptApp.importFile → 结果回传）
 *   → /deck 镜像复查 → 再导一次做往返计数。
 *
 * 用法：
 *   node scripts/e2e-pptx.mjs [--port 39411] [--pptx <真实样本.pptx>] [--keep]
 *
 * 依赖：本机 Microsoft Edge（可用 EDGE_PATH 覆盖）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORKBENCH = path.join(ROOT, 'plugin', 'dsh-ppt-workbench')
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const KEEP = args.includes('--keep')
const PORT = Number(arg('--port', 39411))
const SAMPLE = arg('--pptx', './sample.pptx')
const BASE = `http://127.0.0.1:${PORT}/api/desktop/works/ppt-bridge`
const MCP = `http://127.0.0.1:${PORT}/mcp`

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await predicate()) return true } catch { /* retry */ }
    await sleep(intervalMs)
  }
  return false
}

async function callTool(name, arguments_ = {}) {
  const response = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } }),
  })
  return response.json()
}
const textOf = (doc) => doc?.result?.content?.[0]?.text || ''
const isError = (doc) => doc?.result?.isError === true
const jsonOf = (doc) => { try { return JSON.parse(textOf(doc)) } catch { return null } }

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate))
}

async function killTree(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('exit', () => resolve())
      killer.on('error', () => resolve())
    })
  } else {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
}

async function cdpTargets(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
  return response.json()
}

async function openPage(cdpPort, url) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!response.ok) throw new Error(`CDP 新建页面失败：HTTP ${response.status}`)
  return response.json()
}

function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 0
  const events = []
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (event) => reject(new Error('CDP WebSocket 连接失败: ' + String(event?.message || event)))
  })
  ws.onmessage = (event) => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)))
      else resolve(message.result)
      return
    }
    if (message.method) events.push(message)
  }
  return {
    ws,
    events,
    ready,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { try { ws.close() } catch { /* ignore */ } },
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || '页面脚本执行失败')
  }
  return result.result?.value
}

let relay = null
let edge = null
let cdp = null
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-e2e-'))
const hostDir = path.join(tempRoot, 'host')
const profileDir = path.join(tempRoot, 'edge-profile')
const exportDir = path.join(tempRoot, 'exports')
fs.mkdirSync(hostDir, { recursive: true })
fs.mkdirSync(profileDir, { recursive: true })
fs.mkdirSync(exportDir, { recursive: true })

try {
  /* 1. 启动 relay */
  relay = spawn(process.execPath, ['server/relay.mjs', '--port', String(PORT), '--dir', hostDir], {
    cwd: WORKBENCH,
    env: { ...process.env, PPT_BRIDGE_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let relayLog = ''
  relay.stdout.on('data', (chunk) => { relayLog += chunk })
  relay.stderr.on('data', (chunk) => { relayLog += chunk })
  const relayUp = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/healthz`)
    return response.ok
  }, 20_000)
  if (!relayUp) throw new Error('relay 未启动：\n' + relayLog.slice(-2000))
  record('relay 启动', true, `port=${PORT}`)

  /* 2. headless Edge 打开编辑器页 */
  const edgePath = findEdge()
  if (!edgePath) throw new Error('未找到 Microsoft Edge；设置 EDGE_PATH 后重试')
  const cdpPort = PORT + 1000
  edge = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let edgeLog = ''
  edge.stderr.on('data', (chunk) => { edgeLog += chunk })

  const cdpUp = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
    return response.ok
  }, 20_000)
  if (!cdpUp) throw new Error('Edge CDP 未就绪：\n' + edgeLog.slice(-2000))

  const page = await openPage(cdpPort, `http://127.0.0.1:${PORT}/`)
  cdp = createCdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  record('Edge 打开编辑器', true)

  const mounted = await waitFor(async () => {
    return evaluate(cdp, '!!(window.PptApp && typeof PptApp.isMounted === "function" && PptApp.isMounted())')
  }, 90_000, 500)
  if (!mounted) {
    const errors = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown')
      .map((event) => event.params?.exceptionDetails?.text || 'exception')
    throw new Error('PptApp 未挂载（headless Edge）。页面异常：' + errors.slice(0, 5).join(' | '))
  }
  record('PptApp 挂载', true)

  const claimed = await waitFor(async () => {
    const status = await fetch(BASE + '/status').then((response) => response.json())
    return !!status.owner && Number(status.owner.age || 0) <= 10
  }, 20_000)
  record('编辑器 claim', claimed)
  if (!claimed) throw new Error('编辑器未 claim 租约')

  /* 3. 工具面 */
  const capsDoc = await callTool('ppt_capabilities')
  const caps = jsonOf(capsDoc) || {}
  record('ppt_capabilities', !isError(capsDoc) && caps.toolCount >= 27,
    `contract=${caps.contractVersion} tools=${caps.toolCount} editor=${caps.editorConnected}`)
  record('import 工具存在', (caps.tools || []).some((tool) => tool.name === 'ppt_import_pptx'))
  record('export 工具存在', (caps.tools || []).some((tool) => tool.name === 'ppt_export_pptx'))

  /* 4. 造稿（3 页） */
  const made = await callTool('ppt_deck', {
    title: 'E2E PPTX 往返',
    preset: 'clean',
    slides: [
      { layout: 'cover', title: 'E2E PPTX 往返', subtitle: 'import/export' },
      { layout: 'bullets', title: '测试页', bullets: ['导入', '导出', '回读'] },
      { layout: 'end', title: '谢谢' },
    ],
  })
  record('ppt_deck 造稿', !isError(made), textOf(made).slice(0, 80))

  /* 5. 导出 */
  const exported = await callTool('ppt_export_pptx', {
    path: exportDir,
    file_name: 'e2e-roundtrip',
  })
  const exportedData = jsonOf(exported) || {}
  record('ppt_export_pptx', !isError(exported) && exportedData.ok === true,
    `${exportedData.path || ''} ${exportedData.bytes || 0}B`)
  let exportedFile = exportedData.path
  if (!exportedFile || !fs.existsSync(exportedFile)) throw new Error('导出文件不存在：' + exportedFile)
  const exportedBytes = fs.readFileSync(exportedFile)
  record('导出文件是 OOXML ZIP', exportedBytes.subarray(0, 2).toString() === 'PK')
  const zip = await JSZip.loadAsync(exportedBytes)
  const slideEntries = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  record('导出包含 3 页', slideEntries.length === 3, slideEntries.join(','))

  /* 6. 导入导出的文件（往返） */
  const imported = await callTool('ppt_import_pptx', { path: exportedFile, wait_ms: 180_000 })
  const importedData = jsonOf(imported) || {}
  record('ppt_import_pptx（往返）', !isError(imported) && importedData.ok === true,
    `slides=${importedData.slideCount} title=${importedData.title || ''} warnings=${(importedData.warnings || []).length}`)

  const mirror = await fetch(BASE + '/deck').then((response) => response.json())
  record('deck 镜像已更新',
    Array.isArray(mirror?.deck?.slides) && mirror.deck.slides.length === 3,
    `slides=${mirror?.deck?.slides?.length}`)

  const reread = await callTool('ppt_get_deck', { detailed: true })
  record('ppt_get_deck 可读', !isError(reread) && textOf(reread).includes('E2E PPTX 往返'),
    textOf(reread).slice(0, 80))

  /* 7. 可选：真实 PPTX 样本 */
  if (SAMPLE && fs.existsSync(SAMPLE)) {
    const sample = await callTool('ppt_import_pptx', { path: SAMPLE, wait_ms: 180_000 })
    const sampleData = jsonOf(sample) || {}
    record('真实样本导入', !isError(sample) && sampleData.ok === true && Number(sampleData.slideCount) > 0,
      `${path.basename(SAMPLE)} slides=${sampleData.slideCount}`)
  } else {
    record('真实样本导入', true, '跳过（样本不存在）')
  }

  /* 8. 导入前的 snapshot 应让 ppt_history undo 回到导入前（3 页） */
  const undone = await callTool('ppt_history', { action: 'undo' })
  const restored = await waitFor(async () => {
    const current = await fetch(BASE + '/deck').then((response) => response.json())
    return current?.deck?.slides?.length === 3
  }, 10_000)
  record('导入后 undo 回到导入前', !isError(undone) && restored,
    `slides=${restored ? 3 : '未回到 3'}`)

  /* 9. 导出撤销后的 deck，再次确认 3 页 */
  const exportedAgain = await callTool('ppt_export_pptx', { path: exportDir, file_name: 'e2e-after-import' })
  const againData = jsonOf(exportedAgain) || {}
  record('导入后再导出', !isError(exportedAgain) && againData.ok === true && againData.slides === 3,
    `slides=${againData.slides} skipped=${againData.stats?.skipped || 0}`)
} catch (error) {
  record('E2E 异常', false, String(error?.message || error))
} finally {
  cdp?.close()
  if (!KEEP) {
    await killTree(edge)
    await killTree(relay)
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  } else {
    console.log(`· 保留现场：relay=${BASE} profile=${profileDir}`)
  }
  const passed = results.filter((result) => result.ok).length
  console.log(`\n${passed}/${results.length} 通过`)
  process.exit(results.every((result) => result.ok) ? 0 : 1)
}
