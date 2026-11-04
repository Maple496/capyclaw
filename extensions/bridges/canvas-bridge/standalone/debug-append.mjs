/**
 * 测试 exec 和追加内容
 */
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CANVAS_RUNTIME = process.env.CANVAS_RUNTIME || join(__dirname, '../runtime/canvas-full-app.js')

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

const runtime = await readFile(CANVAS_RUNTIME, 'utf-8')
await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"></head>
<body><div id="canvas"></div></body></html>`)

await page.waitForLoadState('domcontentloaded')
await page.addScriptTag({ content: runtime })
await page.waitForFunction(() => typeof window.CanvasApp !== 'undefined', { timeout: 5000 })

await page.evaluate(async () => {
  window.onload = function() {}
  await window.CanvasApp.mount('#canvas', { width: 794, height: 1123 })
})

// 测试 1：load 后追加
await page.evaluate(() => {
  window.CanvasApp.load({
    header: [],
    main: [{ value: '初始内容\n' }],
    footer: []
  })
})

console.log('=== 测试 exec 追加 ===')
try {
  await page.evaluate(() => {
    window.CanvasApp.exec({
      type: 'INSERT',
      payload: [{ value: '通过 exec 追加\n' }]
    })
  })
  const text1 = await page.evaluate(() => window.CanvasApp.getText())
  console.log('exec INSERT 后：', text1.main)
} catch (e) {
  console.log('exec INSERT 失败：', e.message)
}

// 测试 2：直接修改 dump 再 load
console.log('\n=== 测试追加到 dump ===')
await page.evaluate(() => {
  const doc = window.CanvasApp.dump().data
  doc.main.push({ value: '追加到 dump\n' })
  window.CanvasApp.load(doc)
})
const text2 = await page.evaluate(() => window.CanvasApp.getText())
console.log('追加到 dump 后：', text2.main)

await browser.close()
