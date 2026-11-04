/**
 * scripts/discover-api.mjs
 *
 * 能力发掘：在真实浏览器里挂载 canvas 编辑器内核，
 * dump CanvasApp.help() / describe() 的完整命令面，
 * 输出到 stdout（JSON），供工具面设计对账。
 *
 * 用法：node scripts/discover-api.mjs [--out contract/canvas-api.json]
 */
import { chromium } from 'playwright'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNTIME = process.env.CANVAS_RUNTIME || join(__dirname, '../runtime/canvas-full-app.js')
const outIdx = process.argv.indexOf('--out')
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 794, height: 1123 } })
const runtime = await readFile(RUNTIME, 'utf-8')
await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head>'
  + '<body><div id="canvas" style="width:794px;min-height:1123px"></div></body></html>')
await page.addScriptTag({ content: runtime })
await page.waitForFunction(() => typeof window.CanvasApp !== 'undefined', { timeout: 10000 })
await page.evaluate(async () => {
  const orig = window.onload
  window.onload = function () {}
  try {
    await window.CanvasApp.mount('#canvas', { width: 794, height: 1123, mode: 'edit', pageMode: 'paging' })
  } finally { window.onload = orig }
})

const report = await page.evaluate(async () => {
  const app = window.CanvasApp
  const safe = async (fn) => { try { return await fn() } catch (e) { return { error: String(e && e.message || e) } } }
  const help = await safe(() => app.help())
  const describe = await safe(() => app.describe())
  const catalog = await safe(() => app.getCatalog())
  // 静态面：own function 名
  const staticApi = Object.keys(app).filter((k) => typeof app[k] === 'function')
  const propsApi = Object.keys(app).filter((k) => typeof app[k] !== 'function')
  return { version: app.version, staticApi, propsApi, help, describe, catalog }
})

/* 命令名探测：exec 是透传，用无参调用区分「未注册」vs「参数错误」。
 * 候选来自 bundle 静态提取（executeXxx / insertXxx / deleteXxx 等）。 */
const CANDIDATES = [...new Set([
  'getValue', 'setValue', 'setHTML', 'insertElementList', 'insertTable', 'insertTableTopRow',
  'insertTableBottomRow', 'insertTableLeftCol', 'insertTableRightCol', 'deleteTableRow',
  'deleteTableCol', 'mergeTableCell', 'splitHorizontalTableCell', 'splitVerticalTableCell',
  'tableTdVerticalAlign', 'tableTdBorderType', 'tableTdBackgroundColor', 'tableTdSlashType',
  'tableBorderType', 'tableBorderColor', 'tableSelectAll', 'tableAutoFitToPage',
  'tableAutoFitToContent', 'image', 'hyperlink', 'separator', 'pageBreak', 'list',
  'bold', 'italic', 'underline', 'strikeout', 'subscript', 'superscript', 'title', 'size',
  'sizeAdd', 'sizeMinus', 'color', 'highlight', 'font', 'rowFlex', 'rowMargin',
  'align', 'insertTitle', 'updateElementById', 'deleteElement', 'search', 'replace',
  'replaceRange', 'searchNavigateNext', 'searchNavigatePre', 'selectAll', 'setRange',
  'getRange', 'removeRange', 'undo', 'redo', 'print', 'pageMode', 'pageScale', 'mode',
  'paperSize', 'paperDirection', 'setPaperMargin', 'setColumns', 'setZone', 'setGroup',
  'locationCatalog', 'locationControl', 'locationArea', 'locationGroup', 'insertControl',
  'setControlValue', 'setControlExtension', 'setControlHighlight', 'setControlProperties',
  'removeControl', 'jumpControl', 'insertArea', 'setAreaValue', 'setAreaProperties',
  'setAreaBadge', 'setMainBadge', 'setLocale', 'setPageScale', 'pageScaleAdd',
  'pageScaleMinus', 'pageScaleRecovery', 'toggleRuler', 'toggleTrace', 'insertImage',
  'insertImageBase64', 'replaceImageElement', 'setImageCrop', 'setImageCaption',
  'saveAsImageElement', 'setSpellcheckRangeList', 'setPositionContext', 'painter',
  'copy', 'paste', 'cut', 'translate', 'wordTool', 'validate', 'updateOptions',
  'insertBreak', 'insertControl', 'format', 'moveCursor', 'getSelection', 'setSelection',
  'insertText', 'insertTextBlock', 'getGroupIds', 'forceRender', 'getImageCache',
])]
const probe = await page.evaluate(async (names) => {
  const app = window.CanvasApp
  const withTimeout = (p, ms) => Promise.race([
    Promise.resolve(p).then((r) => ({ done: true, r })),
    new Promise((resolve) => setTimeout(() => resolve({ done: false }), ms)),
  ])
  const out = {}
  for (const name of names) {
    try {
      const t = await withTimeout(app.exec(name), 1500)
      out[name] = t.done
        ? { ok: true, returns: t.r === undefined ? null : String(t.r).slice(0, 120) }
        : { ok: true, timeout: true }
    } catch (e) {
      out[name] = { ok: false, error: String(e && e.message || e).slice(0, 160) }
    }
  }
  return out
}, CANDIDATES)
report.execProbe = probe
const known = Object.entries(probe).filter(([, v]) => v.ok || !/unknown|not a function|未知|不支持/i.test(v.error)).map(([k]) => k)
report.registeredCommands = known.sort()

await browser.close()

const text = JSON.stringify(report, null, 2)
if (OUT) {
  mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, text + '\n')
  console.log(`[discover] 写入 ${OUT}（${text.length} 字节）`)
} else {
  console.log(text)
}
