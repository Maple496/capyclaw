/**
 * standalone/headless-canvas-v2.mjs
 * 
 * 复用 ZCode 浏览器（通过 node_repl MCP）：不需要下载 Chromium，
 * 直接用 browser-use 已经配置好的 Playwright 环境。
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CANVAS_RUNTIME_PATH = join(__dirname, '../../../backend/system_works/assets/canvas-full-app.js')

let runtimeCode = null
let seqCounter = 0

/** 延迟加载运行时代码 */
async function ensureRuntime() {
  if (!runtimeCode) {
    runtimeCode = await readFile(CANVAS_RUNTIME_PATH, 'utf-8')
  }
  return runtimeCode
}

/**
 * 执行 JS 代码（通过 ZCode 的 node_repl，它有浏览器访问权限）
 * 
 * 注意：这需要在 ZCode agent 环境下运行，不能独立运行。
 * 为了独立运行，我们需要切换回原来的 Playwright 方案。
 */
export async function execInBrowser(code) {
  // 这个方案行不通：node_repl 只能在 ZCode agent 内调用，
  // 独立 MCP 服务器无法访问。
  throw new Error('此方案需要 ZCode agent 环境，独立服务器不适用')
}

// ... 其余 API 同 v1
