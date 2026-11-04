#!/usr/bin/env node
/**
 * “打开方式”启动器：把本机 .pptx 投给正在运行的 PPTist 工作台。
 *
 * 流程：
 *   1. 探测 relay（默认 39311）；没跑就从 workbench 包拉起；
 *   2. 打开编辑器页面（默认新开一个带 cache-busting 参数的标签页）；
 *   3. 等编辑器 claim；
 *   4. 调 relay 的 MCP `ppt_import_pptx({ path, mode })`；
 *   5. 记录源路径到 <dataDir>/last-open.json，供“保存回原文件”使用。
 *
 * 用法：
 *   node scripts/pptx-open.mjs --file "C:/path/a.pptx"
 *   node scripts/pptx-open.mjs --file a.pptx            # 默认复用已就绪的编辑器页
 *   node scripts/pptx-open.mjs --file a.pptx --new      # 强制新开一个编辑器页
 *   node scripts/pptx-open.mjs --file a.pptx --dry-run
 *   环境变量：PPT_RELAY_URL / PPT_WORKBENCH_DIR / PPT_BRIDGE_HOME
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

function readConfig() {
  const candidates = [
    process.env.PPT_OPEN_CONFIG,
    path.join(HERE, 'config.json'),
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      if (file && fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      }
    } catch { /* 配置损坏时退回默认值 */ }
  }
  return {}
}

const config = readConfig()
const args = process.argv.slice(2)
const hasFlag = (name) => args.includes('--' + name)
const argValue = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const RELAY = String(process.env.PPT_RELAY_URL || config.relayUrl || 'http://127.0.0.1:39311').replace(/\/+$/, '')
const BASE = `${RELAY}/api/desktop/works/ppt-bridge`
const WORKBENCH = path.resolve(process.env.PPT_WORKBENCH_DIR || config.workbenchDir || path.join(REPO_ROOT, 'plugin', 'capyclaw-ppt-workbench'))
const DATA_DIR = path.resolve(process.env.PPT_BRIDGE_HOME || config.dataDir || path.join(WORKBENCH, 'data'))
const PORT = Number(new URL(RELAY).port || 39311)
const LOG = path.join(DATA_DIR, 'open-pptx.log')

const fileArg = argValue('file', args.find((arg) => !arg.startsWith('--')))
const mode = argValue('mode', 'replace') === 'append' ? 'append' : 'replace'
/* 默认复用“已连接且支持 import-pptx”的页面；--new 强制新开，
 * --reuse 保留为兼容旧用法（等价于默认行为）。 */
const forceNew = hasFlag('new')
const dryRun = hasFlag('dry-run')
const waitMs = Math.max(5000, Math.min(Number(argValue('wait', '180000')) || 180000, 300000))
const editorWaitMs = Math.max(5000, Math.min(Number(argValue('editor-wait', '90000')) || 90000, 180000))

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LOG, line + '\n')
  } catch { /* 日志失败不阻塞打开 */ }
  if (process.stderr.isTTY) console.error(line)
}

function showError(message) {
  if (process.platform !== 'win32') return
  const safe = String(message).replace(/'/g, "''").slice(0, 800)
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${safe}', 'DSH PPT 打开失败')`,
    ], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch { /* 没有 UI 时只写日志 */ }
}

function fail(message) {
  log('ERROR ' + message)
  showError(message)
  process.exit(1)
}

async function fetchJson(url, init = {}, timeoutMs = 5000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

async function health() {
  try {
    return await fetchJson(`${RELAY}/healthz`, {}, 2000)
  } catch {
    return null
  }
}

async function ensureRelay() {
  let current = await health()
  if (current) {
    if (current.bridge !== 'ppt-workbench') fail(`端口 ${PORT} 被其他服务占用（${current.bridge || current.service || 'unknown'}）`)
    if (Number(current.version?.split('.')[0]) < 2 || Number(current.version?.split('.')[1]) < 4) {
      fail(`relay 版本过旧（${current.version}），请先重启/部署 2.4.0 后再用“打开方式”`)
    }
    log(`relay 已运行 version=${current.version} slides=${current.slides}`)
    return current
  }

  if (!fs.existsSync(path.join(WORKBENCH, 'server', 'relay.mjs'))) {
    fail(`找不到 workbench：${WORKBENCH}`)
  }
  log(`relay 未运行，启动 ${WORKBENCH} --dir ${DATA_DIR}`)
  const child = spawn(process.execPath, ['server/relay.mjs', '--port', String(PORT), '--dir', DATA_DIR], {
    cwd: WORKBENCH,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PPT_BRIDGE_URL: BASE },
  })
  child.unref()

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await sleep(500)
    current = await health()
    if (current) {
      log(`relay 启动完成 version=${current.version}`)
      return current
    }
  }
  fail('relay 启动超时，请检查 workbench 日志')
}

async function ownerInfo() {
  try {
    const status = await fetchJson(`${BASE}/status`, {}, 3000)
    const owner = status.owner
    if (!owner || Number(owner.age || 0) > 10) return { id: '', capabilities: [] }
    const capabilities = Array.isArray(owner.meta?.capabilities) ? owner.meta.capabilities.map(String) : []
    return { id: String(owner.id || ''), capabilities }
  } catch {
    return { id: '', capabilities: [] }
  }
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()
    return
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function ensureEditor() {
  const before = await ownerInfo()
  if (!forceNew && before.id && before.capabilities.includes('import-pptx')) {
    log('复用已连接且支持 import-pptx 的编辑器页面 ' + before.id)
    return
  }
  if (before.id && !before.capabilities.includes('import-pptx')) {
    log('已连接页面上报的能力不含 import-pptx（可能是旧页面），打开新页面')
  }

  /* 新开一个带 cache-busting 参数的页面：确保拿到当前版本的 app.js。 */
  const url = `${RELAY}/open.html?v=${Date.now()}`
  log('打开编辑器页面 ' + url)
  openBrowser(url)

  const deadline = Date.now() + editorWaitMs
  while (Date.now() < deadline) {
    await sleep(500)
    const current = await ownerInfo()
    if (current.id && current.id !== before.id && current.capabilities.includes('import-pptx')) {
      /* bootEditor 先 restore 再 claim；owner 出现后再留一点时间让
       * activate/pump 起来，同时让旧页面的 debounce state push 先落地。 */
      await sleep(2000)
      log('新编辑器页面已连接 ' + current.id)
      return
    }
  }
  fail(`编辑器在 ${Math.round(editorWaitMs / 1000)}s 内未就绪：请手动打开 ${RELAY}/ 并刷新到最新版本`)
}

async function callTool(name, toolArgs) {
  const response = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: toolArgs },
    }),
    signal: AbortSignal.timeout(waitMs + 30_000),
  })
  const text = await response.text()
  let doc
  try { doc = JSON.parse(text) } catch { throw new Error('relay 返回非 JSON：' + text.slice(0, 200)) }
  if (doc?.result?.isError) {
    throw new Error(doc.result.content?.[0]?.text || '工具调用失败')
  }
  return doc?.result?.content?.[0]?.text || ''
}

async function main() {
  if (!fileArg) fail('用法：pptx-open.mjs --file <path.pptx> 或把 .pptx 拖到启动器上')
  const source = path.resolve(fileArg)
  if (!fs.existsSync(source)) fail('文件不存在：' + source)
  if (!/\.pptx$/i.test(source)) fail('只支持 .pptx（OOXML）文件：' + source)

  if (dryRun) {
    console.log(JSON.stringify({ source, relay: RELAY, workbench: WORKBENCH, dataDir: DATA_DIR, mode, forceNew }, null, 2))
    return
  }

  await ensureRelay()
  await ensureEditor()

  log(`导入 ${source}（${mode}）`)
  const text = await callTool('ppt_import_pptx', {
    path: source,
    mode,
    wait_ms: waitMs,
  })
  let result = null
  try { result = JSON.parse(text) } catch { /* 非 JSON 结果保留原文 */ }
  if (!result?.ok) fail('导入失败：' + text)

  const record = {
    path: source,
    title: result.title || '',
    slides: result.slideCount || 0,
    mode,
    openedAt: new Date().toISOString(),
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, 'last-open.json'), JSON.stringify(record, null, 2) + '\n')
  } catch { /* 记录失败不影响打开 */ }

  log(`导入成功：${record.title} / ${record.slides} 页`)
  console.log(JSON.stringify(record, null, 2))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => fail(String(error?.message || error)))
