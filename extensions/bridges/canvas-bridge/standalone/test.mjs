/**
 * standalone/test.mjs
 * 
 * 独立服务器快速验证：启动 → 调用工具 → 截图 → 关闭
 */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const server = spawn('node', ['standalone/server.mjs', '--http', '39314'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
})

server.stdout.on('data', (d) => process.stdout.write('[server] ' + d))
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d))

// 等服务器启动
await new Promise((r) => setTimeout(r, 3000))

const MCP = 'http://127.0.0.1:39314/mcp'
let id = 1

async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

async function call(name, args) {
  const res = await rpc('tools/call', { name, arguments: args })
  if (res.isError) {
    const text = res.content.find((c) => c.type === 'text')?.text || 'unknown error'
    throw new Error(text)
  }
  return res
}

console.log('=== 初始化 ===')
const init = await rpc('initialize', {})
console.log('serverInfo:', init.serverInfo)

console.log('\n=== 工具列表 ===')
const tools = await rpc('tools/list', {})
console.log('工具数量:', tools.tools.length)
console.log('工具名:', tools.tools.map((t) => t.name).join(', '))

console.log('\n=== 生成文档 ===')
const w = await call('canvas_write_document', {
  blocks: [
    { type: 'heading', level: 1, text: 'Canvas 独立服务验证' },
    { type: 'paragraph', text: '这份文档由独立 MCP 服务器 + Headless 浏览器生成。' },
    { type: 'heading', level: 2, text: '技术栈' },
    { type: 'bullet', text: 'Playwright Chromium Headless' },
    { type: 'bullet', text: 'canvas-editor 完整内核' },
    { type: 'bullet', text: 'MCP JSON-RPC 协议' },
  ],
})
console.log(w.content[0].text)

console.log('\n=== 插入表格 ===')
const t = await call('canvas_insert_table', {
  headers: ['组件', '状态'],
  rows: [
    ['Headless 浏览器', '运行中'],
    ['canvas-editor', '已加载'],
    ['MCP 服务器', '监听 39314'],
  ],
})
console.log(t.content[0].text)

console.log('\n=== 读取文档 ===')
const r = await call('canvas_read', { mode: 'text' })
const text = r.content[0].text
console.log('文本前 120 字:', text.slice(0, 120))

console.log('\n=== 截图 ===')
const s = await call('canvas_screenshot', {})
const img = s.content.find((c) => c.type === 'image')
if (img) {
  const buf = Buffer.from(img.data, 'base64')
  await writeFile('standalone/test-screenshot.jpg', buf)
  console.log('已保存截图:', buf.length, 'bytes')
} else {
  console.log('✗ 未返回图片')
}

console.log('\n=== 清理 ===')
server.kill('SIGINT')
await new Promise((r) => setTimeout(r, 2000))
console.log('✓ 测试完成')
process.exit(0)
