/* MCP stdio 入口：换行分隔 JSON-RPC（tools/list, tools/call）。 */
import process from 'node:process'
import { TOOLS, TOOL_IMPL } from './tools.mjs'
import { validateToolArguments } from './validate.mjs'

/* ---- MCP stdio：换行分隔 JSON-RPC ---- */
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    handle(msg).catch((e) => fail(msg.id ?? null, -32603, String((e && e.message) || e)))
  }
})

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'ppt-bridge', version: '2.0.0' },
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments || {}
    const impl = TOOL_IMPL[name]
    if (!impl) return fail(id, -32602, `未知工具: ${name}`)
    const tool = TOOLS.find((item) => item.name === name)
    const check = validateToolArguments(tool, args)
    if (!check.ok) {
      return reply(id, {
        content: [{ type: 'text', text: '参数不合法：' + check.errors.join('；') }],
        isError: true,
      })
    }
    try {
      const out = await impl(args)
      if (out && out.content) return reply(id, { content: out.content })
      return reply(id, { content: [{ type: 'text', text: out.text || 'ok' }] })
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: '工具失败：' + String((e && e.message) || e) }], isError: true })
    }
  }
  if (id !== undefined) fail(id, -32601, `未知方法: ${method}`)
}

process.stdin.resume()
