#!/usr/bin/env node
/**
 * MCP stdio 传输（可选）：给只支持 stdio 的 MCP 客户端用。
 * 与 relay 共用同一套 tools 实现；行分隔 JSON-RPC（MCP stdio 规范）。
 */
import readline from 'node:readline'
import { createMcpHandler } from './mcp-http.mjs'

const handle = createMcpHandler()
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

let chain = Promise.resolve()
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  chain = chain.then(async () => {
    let msg
    try {
      msg = JSON.parse(s)
    } catch {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n')
      return
    }
    try {
      const out = await handle(msg)
      if (out) process.stdout.write(JSON.stringify(out) + '\n')
    } catch (e) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg && msg.id,
        error: { code: -32603, message: (e && e.message) || String(e) },
      }) + '\n')
    }
  })
})
rl.on('close', () => { chain.finally(() => process.exit(0)) })
