/**
 * 快速测试：检查 canvas-full 实际暴露的 API
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

// 劫持 onload 并 mount
await page.evaluate(async () => {
  window.onload = function() {}
  await window.CanvasApp.mount('#canvas', { width: 794, height: 1123 })
})

// 查看所有可用方法
const apis = await page.evaluate(() => {
  const methods = Object.keys(window.CanvasApp).filter(k => typeof window.CanvasApp[k] === 'function')
  return methods
})

console.log('CanvasApp 可用方法：')
console.log(apis.join(', '))

// 测试 load
await page.evaluate(() => {
  window.CanvasApp.load({
    header: [],
    main: [{ value: 'Hello Canvas!' }],
    footer: []
  })
})

// 测试 dump
const doc = await page.evaluate(() => window.CanvasApp.dump())
console.log('\ndump 返回：', JSON.stringify(doc).slice(0, 200))

// 测试 getText
const text = await page.evaluate(() => window.CanvasApp.getText())
console.log('\ngetText 返回：', typeof text, JSON.stringify(text).slice(0, 200))

await browser.close()
