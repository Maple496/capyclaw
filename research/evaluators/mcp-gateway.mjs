/**
 * dsh-mcp-gateway 评估器：真实起 3 个上游 MCP server——
 * 两个健康（含一个 5s 慢工具）、一个黑洞（接受连接但不响应），
 * 测 refresh 聚合、快工具透传 p95、慢工具必须完成、黑洞必须按 timeout 中止。
 */
import path from 'node:path'
import {
  importPkg, tempDir, rmRf, percentile, round2, sleep,
} from '../util.mjs'

const { createMcpGateway } = await importPkg('dsh-mcp-gateway', 'src/index.mjs')
const { createMcpHandler } = await importPkg('dsh-plugin-kit', 'src/service/mcp-http.mjs')
const { listen } = await importPkg('dsh-plugin-kit', 'src/service/http.mjs')

const SLOW_MS = 5000

function tool(name, impl) {
  return {
    name,
    description: `bench ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    kind: 'read',
    impl,
  }
}

/** 起一个上游 MCP server（plugin-kit 最小实现），返回 { url, close }。 */
async function startUpstream(tools) {
  const handler = createMcpHandler({
    tools,
    callTool: async (name, args) => {
      const found = tools.find((item) => item.name === name)
      /* impl 可能是同步或异步：必须 await，否则慢工具会把 Promise 字符串化。 */
      return { content: [{ type: 'text', text: String(found ? await found.impl(args) : 'ok') }] }
    },
    serverInfo: { name: 'bench-upstream', version: '0.1.0' },
  })
  const server = await listen(0, { handler })
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    /* 挂死工具的 socket 永远不会自然结束：必须强制断开，否则 close 回调永不触发。 */
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    }),
  }
}

async function rpc(url, method, params, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 1e9, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (process.env.EVO_DEBUG_RPC) console.log(`[rpc] ${method} status=${res.status} body=${text.slice(0, 140)}`)
  let json = null
  try { json = JSON.parse(text) } catch { throw new Error(`非 JSON 响应(${res.status}): ${text.slice(0, 80)}`) }
  if (json.error) throw new Error(json.error.message || 'rpc error')
  const result = json.result
  /* MCP 工具级错误走 isError 结果而非 jsonrpc error：中止/未知工具都必须视为失败。 */
  if (result && result.isError) throw new Error(String(result.content?.[0]?.text || 'tool error'))
  return result
}

export async function evaluateMcpGateway(genome, tuningPatch) {
  const timeoutMs = tuningPatch.timeoutMs
  const hostDir = tempDir('evo-mg-')
  const closes = []
  try {
    const fast = await startUpstream([
      tool('fast_a', () => 'a'),
      tool('fast_b', () => 'b'),
    ])
    closes.push(fast.close)
    const slow = await startUpstream([
      tool('slow_work', async () => { await sleep(SLOW_MS); return 'done' }),
    ])
    closes.push(slow.close)

    /* 挂死工具：tools/list 正常暴露，但 tools/call 永不响应 →
       网关必须在 timeoutMs 处中止，否则客户端无限挂起。 */
    const hung = await startUpstream([
      tool('hung_tool', () => new Promise(() => { /* 永不 resolve */ })),
    ])
    closes.push(hung.close)

    const gateway = createMcpGateway({
      id: 'evo-gateway',
      servers: [
        { name: 'fast', url: fast.url },
        { name: 'slow', url: slow.url },
        { name: 'hung', url: hung.url },
      ],
      timeoutMs,
    })

    const refreshStarted = performance.now()
    const info = await gateway.start({ port: 0, hostDir, lockFile: path.join(hostDir, 'g.lock') })
    const refreshMs = performance.now() - refreshStarted
    const mcpUrl = `${info.url}/mcp`

    let stabilityFailures = 0
    /* refresh 必须在 timeout + 余量内完成（黑洞 abort，健康上游照常聚合） */
    if (refreshMs > timeoutMs * 3 + 5000) stabilityFailures++

    /* 快工具透传 p95 */
    const fastSamples = []
    for (let i = 0; i < 40; i++) {
      const t = performance.now()
      await rpc(mcpUrl, 'tools/call', { name: 'fast_a', arguments: {} }, timeoutMs + 5000)
      fastSamples.push(performance.now() - t)
    }
    const fastP95 = percentile(fastSamples, 95)

    /* 慢工具：timeout 必须覆盖 5s 工具，否则该功能对客户端不可用 */
    let slowOk = false
    let slowMs = 0
    const slowStarted = performance.now()
    try {
      await rpc(mcpUrl, 'tools/call', { name: 'slow_work', arguments: {} }, timeoutMs + 5000)
      slowMs = performance.now() - slowStarted
      slowOk = slowMs >= SLOW_MS * 0.9
    } catch {
      slowMs = performance.now() - slowStarted
      slowOk = false
    }
    if (!slowOk) stabilityFailures++

    /* 黑洞工具调用：必须在 timeout + 余量内中止报错，不能无限挂起 */
    let hungAbortMs = 0
    let hungAborted = false
    const hungStarted = performance.now()
    try {
      await rpc(mcpUrl, 'tools/call', { name: 'hung_tool', arguments: {} }, timeoutMs + 10000)
      hungAbortMs = performance.now() - hungStarted
    } catch {
      hungAbortMs = performance.now() - hungStarted
      hungAborted = true
    }
    if (!hungAborted || hungAbortMs > timeoutMs + 3000) stabilityFailures++

    return {
      ok: stabilityFailures === 0,
      objectives: {
        fastCallP95Ms: round2(fastP95),
        listRefreshMs: round2(refreshMs),
        hungAbortMs: round2(hungAbortMs),
        stabilityFailures,
      },
      meta: {
        refreshMs: round2(refreshMs), slowOk, slowMs: round2(slowMs),
        hungAborted, hungAbortMs: round2(hungAbortMs), timeoutMs,
      },
    }
  } finally {
    for (const close of closes) await close().catch(() => {})
    rmRf(hostDir)
  }
}
