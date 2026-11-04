/**
 * standalone/headless-canvas.mjs
 * 
 * Headless 编辑器封装：拉起 Playwright + 注入 canvas-editor，提供与桥相同的操作接口。
 * 替代原来的 bridge-client，但 API 兼容，让 tools.mjs 零改动复用。
 */
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
/* 运行时 bundle：CANVAS_RUNTIME 环境变量可覆盖；默认本仓 runtime/ 自带副本 */
const CANVAS_RUNTIME = process.env.CANVAS_RUNTIME || join(__dirname, '../runtime/canvas-full-app.js')

let browser = null
let page = null
let editorReady = false
let seqCounter = 0
let doc = { header: [], main: [], footer: [] }

/** 启动 Headless 浏览器并注入编辑器 */
export async function start() {
  if (browser) return
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 794, height: 1123 } })  // A4 纸
  
  // 注入 canvas-editor 运行时
  const runtime = await readFile(CANVAS_RUNTIME, 'utf-8')
  await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 20px; }
#canvas { width: 794px; min-height: 1123px; }
</style>
</head><body><div id="canvas"></div></body></html>`)
  
  // 等待 DOM 就绪
  await page.waitForLoadState('domcontentloaded')
  
  await page.addScriptTag({ content: runtime })
  
  // 等待脚本执行
  await page.waitForFunction(() => typeof window.CanvasApp !== 'undefined', { timeout: 5000 })
  
  // 初始化编辑器：劫持 onload 检查逻辑
  await page.evaluate(async () => {
    // 临时设置 onload 让 mount 通过检查
    const originalOnload = window.onload
    window.onload = function() {}
    
    try {
      await window.CanvasApp.mount('#canvas', {
        width: 794,
        height: 1123,
        mode: 'edit',
        pageMode: 'paging',
      })
    } finally {
      // 恢复原值
      window.onload = originalOnload
    }
    
    window.editorState = { seq: 0, doc: { header: [], main: [], footer: [] } }
  })
  
  editorReady = true
  console.log('[headless-canvas] 编辑器已就绪')
}

/** 执行命令（与桥接口兼容：cmds 数组 + title） */
export async function exec(cmds, title = '') {
  if (!editorReady) throw new Error('编辑器未初始化')
  seqCounter++
  const seq = seqCounter
  
  await page.evaluate(({ cmds, seq }) => {
    for (const c of cmds) {
      const { cmd, args } = c
      if (cmd === 'setValue') {
        // 整篇替换
        window.CanvasApp.load(args[0])
      } else if (cmd === 'appendElementList' || cmd === 'insertElementList') {
        // 追加/插入：dump → 修改 → load
        const doc = window.CanvasApp.dump().data
        doc.main = doc.main.concat(args[0])
        window.CanvasApp.load(doc)
      } else if (cmd === 'replaceText') {
        // 全文替换：dump → 遍历替换 → load
        const doc = window.CanvasApp.dump().data
        const find = args[0]
        const replace = args[1]
        const replaceInElements = (els) => {
          for (const el of els) {
            if (el.value && typeof el.value === 'string') {
              el.value = el.value.replace(new RegExp(find, 'g'), replace)
            }
          }
        }
        replaceInElements(doc.header)
        replaceInElements(doc.main)
        replaceInElements(doc.footer)
        window.CanvasApp.load(doc)
      } else if (cmd === 'pageSetup') {
        const opts = args[0]
        if (opts.mode) window.CanvasApp.setPageMode?.(opts.mode === 'paging' ? 'paging' : 'continuous')
        // 其他页面设置暂不支持（需要查 API）
      } else if (cmd === 'undo') {
        window.CanvasApp.undo?.()
      } else if (cmd === 'redo') {
        window.CanvasApp.redo?.()
      }
    }
    window.editorState.seq = seq
    window.editorState.doc = window.CanvasApp.dump?.()?.data || {}
  }, { cmds, seq })
  
  return { seq, applied: cmds.length }
}

/** 获取文档状态（与桥接口兼容） */
export async function getDoc() {
  if (!editorReady) return { header: [], main: [], footer: [] }
  return await page.evaluate(() => {
    const d = window.CanvasApp.dump?.()?.data
    return d || { header: [], main: [], footer: [] }
  })
}

/** 获取纯文本（与桥接口兼容） */
export async function getText() {
  if (!editorReady) return ''
  return await page.evaluate(() => {
    const t = window.CanvasApp.getText?.()
    // canvas-full 的 getText 返回对象 {header, main, footer}
    if (typeof t === 'object' && t !== null) {
      return [t.header || '', t.main || '', t.footer || ''].filter(x => x).join('\n')
    }
    return String(t || '')
  })
}

/** 获取字数 */
export async function getWordCount() {
  if (!editorReady) return 0
  return await page.evaluate(async () => {
    const wc = await window.CanvasApp.getWordCount?.()
    return typeof wc === 'number' ? wc : 0
  })
}

/** 截图（返回 base64 dataURL） */
export async function screenshot() {
  if (!editorReady) throw new Error('编辑器未初始化')
  const buf = await page.screenshot({ type: 'jpeg', quality: 85 })
  return 'data:image/jpeg;base64,' + buf.toString('base64')
}

/** 导出 PDF */
export async function exportPdf() {
  if (!editorReady) throw new Error('编辑器未初始化')
  return await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
  })
}

/** 关闭浏览器 */
export async function close() {
  if (browser) {
    await browser.close()
    browser = null
    page = null
    editorReady = false
  }
}

/** 健康检查 */
export async function status() {
  return {
    ready: editorReady,
    seq: seqCounter,
    word_count: await getWordCount(),
  }
}
