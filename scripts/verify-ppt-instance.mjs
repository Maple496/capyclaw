#!/usr/bin/env node
/**
 * PPT 实例一致性校验：侧边栏展示的编辑器必须与 DSH mcp-ppt 编辑的是同一个 workbench。
 *
 * 用法：
 *   node scripts/verify-ppt-instance.mjs
 *   node scripts/verify-ppt-instance.mjs --mcp http://127.0.0.1:39311/mcp --sidebar http://127.0.0.1:39311/
 *
 * 判定：两个 URL 的 /healthz 必须都返回 bridge=ppt-workbench，且 pid/port 一致。
 * 不一致 → 退出码 1（可接入启动前检查/CI）。
 */
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const mcpUrl = arg('mcp', 'http://127.0.0.1:39311/mcp')
const sidebarUrl = arg('sidebar', 'http://127.0.0.1:39311/')

function healthUrl(url) {
  return String(url).replace(/\/mcp\/?$/, '').replace(/\/+$/, '') + '/healthz'
}

async function probe(url) {
  const target = healthUrl(url)
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { ok: false, target, error: `HTTP ${res.status}` }
    const body = await res.json()
    return { ok: body?.bridge === 'ppt-workbench', target, body }
  } catch (error) {
    return { ok: false, target, error: String(error?.message || error) }
  }
}

const [mcp, sidebar] = await Promise.all([probe(mcpUrl), probe(sidebarUrl)])
const rows = [
  ['mcp-ppt 目标', mcp.target, mcp.ok ? `pid=${mcp.body.pid} port=${mcp.body.port} slides=${mcp.body.slides}` : `失败：${mcp.error || '非 ppt-workbench'}`],
  ['侧边栏目标', sidebar.target, sidebar.ok ? `pid=${sidebar.body.pid} port=${sidebar.body.port} slides=${sidebar.body.slides}` : `失败：${sidebar.error || '非 ppt-workbench'}`],
]
for (const [label, target, detail] of rows) console.log(`${label.padEnd(12)} ${target}  ${detail}`)

const same = mcp.ok && sidebar.ok
  && mcp.body.pid === sidebar.body.pid
  && mcp.body.port === sidebar.body.port
if (!same) {
  console.error('\n✗ 实例不一致：侧边栏显示的不是 DSH 正在编辑的 workbench（或目标不可达）。')
  process.exit(1)
}
console.log(`\n✓ 同一实例：pid=${mcp.body.pid} port=${mcp.body.port} slides=${mcp.body.slides} seq=${mcp.body.seq}`)
