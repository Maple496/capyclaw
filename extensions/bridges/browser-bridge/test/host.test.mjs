/**
 * lib/host.mjs 兼容入口单测：mock ctx 下 apply() 真实拉起 relay、disposer 干净关停。
 * （与 e2e L3 的 hostTemplateSmoke 同口径，但走包内 node --test。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKBENCH = path.resolve(HERE, '..', 'plugin', 'capyclaw-browser-workbench')

function randomPort() {
  return 20000 + Math.floor(Math.random() * 18000)
}

async function waitHealthz(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return await r.json()
    } catch { /* 未就绪 */ }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('healthz 等待超时')
}

test('host.apply(mockCtx) 拉起 relay；disposer 停止', async () => {
  const host = await import(pathToFileURL(path.join(WORKBENCH, 'lib', 'host.mjs')).href)
  const port = randomPort()
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-host-test-'))
  const dispose = await host.apply({ get: () => null }, { port, hostDir })
  try {
    const h = await waitHealthz(port)
    assert.equal(h.ok, true)
    assert.equal(h.name, 'browser-workbench')
    assert.equal(h.capabilities.engine, 'playwright')
  } finally {
    await dispose()
    fs.rmSync(hostDir, { recursive: true, force: true })
  }
  const gone = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) }).then(() => false, () => true)
  assert.equal(gone, true, 'disposer 后端口应释放')
})
