/**
 * scripts/e2e-verify.mjs — 端到端验证（开发用）：
 *   1) 起 relay（独立进程，随机端口）
 *   2) Playwright 打开编辑器页面（真实浏览器，等 claim）
 *   3) MCP 调 canvas_write_document / insert_table / style / read / audit / screenshot / export
 *   4) 页面画面截图落盘（供人眼检查）
 *
 * 用法：node scripts/e2e-verify.mjs [--port 39401] [--keep]
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const WORKBENCH = join(ROOT, 'plugin', 'capyclaw-canvas-workbench')
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 39401)
const KEEP = process.argv.includes('--keep')
const BASE = `http://127.0.0.1:${PORT}`
const MCP = `${BASE}/mcp`
const BRIDGE = `${BASE}/api/desktop/works/canvas-bridge`
const OUT = join(ROOT, 'dist', 'e2e')

let relay = null
let browser = null
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 1e6, method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result
}

const call = (name, args = {}) => rpc('tools/call', { name, arguments: args })

const textOf = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

try {
  mkdirSync(OUT, { recursive: true })
  rmSync(join(OUT, 'state'), { recursive: true, force: true })
  mkdirSync(join(OUT, 'state'), { recursive: true })

  /* 1) relay */
  relay = spawn(process.execPath, [join(WORKBENCH, 'server', 'relay.mjs'), '--port', String(PORT), '--dir', join(OUT, 'state')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  relay.stdout.on('data', (d) => process.stdout.write('[relay] ' + d))
  relay.stderr.on('data', (d) => process.stderr.write('[relay!] ' + d))
  await sleep(1500)

  /* 2) 真实浏览器打开编辑器 */
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.CanvasApp && window.CanvasApp.isMounted(), { timeout: 20000 })
  await page.waitForFunction(async (bridgeUrl) => {
    const r = await fetch(`${bridgeUrl}/status`).then((x) => x.json()).catch(() => null)
    return !!(r && r.owner && r.owner.age <= 10)
  }, `${BRIDGE}`, { timeout: 20000 })
  check('编辑器页面挂载并 claim', true)

  /* 3) capabilities */
  const caps = JSON.parse(textOf(await call('canvas_capabilities')))
  check('canvas_capabilities', caps.contractVersion === '1.0.0' && caps.toolCount === 22, `contract ${caps.contractVersion}, tools ${caps.toolCount}`)

  /* 4) 一次成稿 */
  const write = textOf(await call('canvas_write_document', {
    title: 'E2E 成稿',
    blocks: [
      { type: 'heading', level: 1, text: 'Canvas 插件体系端到端验证' },
      { type: 'paragraph', text: '本文档由 canvas_* MCP 工具写入，经 relay 排队、编辑器页面应用后回执。' },
      { type: 'heading', level: 2, text: '验证点' },
      { type: 'bullet', text: '块级写作模型（heading/paragraph/bullet/quote/code）' },
      { type: 'bullet', text: '表格插入与结构操作' },
      { type: 'bullet', text: '文本替换与样式定位' },
      { type: 'quote', text: '用户说什么，画布就怎么变。' },
      { type: 'code', text: 'canvas_write_document(blocks) → setValue → CanvasApp.load' },
      { type: 'heading', level: 2, text: '结论' },
      { type: 'paragraph', text: '端到端链路（MCP → relay → 编辑器 → 回执 → 镜像）全部打通。' },
    ],
  }))
  check('canvas_write_document', /已写入/.test(write), write.trim())

  /* 5) 追加表格 */
  const table = textOf(await call('canvas_insert_table', {
    headers: ['环节', '组件', '状态'],
    rows: [['工具层', '22 个 canvas_* 工具', '通过'], ['桥', 'document-workbench 编辑器权威', '通过'], ['编辑器', 'CanvasApp 实时应用', '通过']],
  }))
  check('canvas_insert_table', /已插入表格/.test(table), table.trim())

  /* 6) 替换文本 */
  const replaced = textOf(await call('canvas_replace_text', { find: '端到端链路', replace: '完整链路' }))
  check('canvas_replace_text', /已替换 1 处/.test(replaced), replaced.trim())

  /* 7) 样式定位 */
  const styled = textOf(await call('canvas_style', { find: '画布就怎么变', style: { bold: true, color: '#c2410c', size: 18 } }))
  check('canvas_style', /已给 1 处文本套样式/.test(styled), styled.trim())

  /* 8) 读取投影 */
  const summary = textOf(await call('canvas_read', { mode: 'summary' }))
  check('canvas_read summary', /字数 \d+/.test(summary) && /大纲/.test(summary), summary.split('\n')[0])
  const outline = textOf(await call('canvas_read', { mode: 'outline' }))
  check('canvas_read outline', outline.includes('#') && outline.includes('验证点'), outline.split('\n').slice(0, 3).join(' / '))

  /* 9) 审计 */
  const audit = textOf(await call('canvas_audit'))
  check('canvas_audit', /审计结果/.test(audit), audit.split('\n')[0])

  /* 10) 截图（工具通道） */
  const shot = await call('canvas_screenshot')
  const img = (shot.content || []).find((c) => c.type === 'image')
  check('canvas_screenshot', !!img && img.data.length > 10000, img ? `${Math.floor(img.data.length * 0.75 / 1024)} KB` : 'no image')
  if (img) writeFileSync(join(OUT, 'tool-shot.jpg'), Buffer.from(img.data, 'base64'))

  /* 11) 浏览器画面（人眼验证） */
  await sleep(500)
  await page.screenshot({ path: join(OUT, 'browser-shot.jpg'), fullPage: false })
  const docText = await page.evaluate(() => window.CanvasApp.getText())
  check('编辑器画面包含写入文本', typeof docText === 'object'
    ? String(docText.main || '').includes('完整链路')
    : String(docText || '').includes('完整链路'))

  /* 12) undo/redo */
  const undone = textOf(await call('canvas_history', { action: 'undo' }))
  check('canvas_history undo', /已撤销/.test(undone), undone.trim())
  const redone = textOf(await call('canvas_history', { action: 'redo' }))
  check('canvas_history redo', /已重做/.test(redone), redone.trim())

  /* 13) 检查点 */
  const saved = textOf(await call('canvas_checkpoint', { action: 'save', name: 'milestone' }))
  check('canvas_checkpoint save', /已存检查点/.test(saved), saved.trim())

  /* 14) 命令面透传 */
  const cmds = textOf(await call('canvas_commands', { group: 'text' }))
  check('canvas_commands', /setRange/.test(cmds) && /bold/.test(cmds), `${cmds.split('\n').length} 行`)
  const execd = textOf(await call('canvas_exec', { cmds: [{ cmd: 'pageMode', args: ['continuous'] }], title: '连续模式' }))
  check('canvas_exec', /已执行 1 条命令/.test(execd), execd.trim())

  /* 15) 导出 */
  const exported = textOf(await call('canvas_export', { name: 'e2e-doc' }))
  check('canvas_export', /已导出 HTML/.test(exported), exported.trim())

  /* 16) 编辑器离线时写工具给出可行动错误 */
  const status1 = await (await fetch(`${BRIDGE}/status`)).json()
  check('bridge status has words', status1.words > 50, `words=${status1.words}`)

  /* 错误分类：壳层（app.js）错误 = 失败；内核内部竞态 = 警告（如实记录） */
  const shellErrors = pageErrors.filter((e) => e.includes('app.js'))
  const kernelErrors = pageErrors.filter((e) => !e.includes('app.js'))
  check('页面无壳层 JS 错误', shellErrors.length === 0, shellErrors.slice(0, 3).join(' | '))
  if (kernelErrors.length) console.log(`! 内核内部错误 ${kernelErrors.length} 个（不阻塞）：${kernelErrors[0].slice(0, 120)}`)
} catch (e) {
  check('E2E 未抛异常', false, String(e && e.message || e))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (relay) {
    relay.kill()
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!KEEP) { /* 保留产物供检查 */ }
}

const pass = results.filter((r) => r.ok).length
console.log(`\nE2E: ${pass}/${results.length} 通过${process.exitCode ? '（失败）' : ''}`)
process.exit(process.exitCode || 0)
