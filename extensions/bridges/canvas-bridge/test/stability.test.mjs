/**
 * 稳定性回归：并发、协议边界、滥用载荷、编辑器离线语义、/view 投影。
 * 对应实时性优化批（零读直推 / 轻量视图 / tuning 轮询），防止回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createMemoryBackend } from 'dsh-document-workbench/testing'
import { setTimeout as sleep } from 'node:timers/promises'

const { startRelay } = await import('../plugin/capyclaw-canvas-workbench/server/relay.mjs')

async function withRelay(fn, { editor = true } = {}) {
  const relay = await startRelay({
    port: 0, hostDir: undefined, backend: createMemoryBackend({}),
    allowReuse: false, strictPort: true,
  })
  const base = `http://127.0.0.1:${relay.port}`
  const bridge = `${base}/api/desktop/works/canvas-bridge`
  /* 同文件并发多个 relay：进程内工具按 CANVAS_BRIDGE_URL 找桥（调用时解析），
   *  进入本用例前指到自己的桥，结束恢复。 */
  const prevEnv = process.env.CANVAS_BRIDGE_URL
  process.env.CANVAS_BRIDGE_URL = bridge
  let stopped = false
  let fakeDoc = { header: [], main: [], footer: [] }
  const pump = (async () => {
    if (!editor) return
    const claim = await fetch(`${bridge}/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'stab-editor', force: true }),
    }).then((r) => r.json())
    assert.equal(claim.ok, true)
    let lastSeq = 0
    while (!stopped) {
      try {
        const doc = await fetch(`${bridge}/watch?seq=${lastSeq}&shot=0&ui=0&timeout=2`).then((r) => r.json())
        if ((doc.seq | 0) !== lastSeq) {
          lastSeq = doc.seq | 0
          for (const c of doc.cmds || []) {
            if (c.cmd === 'setValue') fakeDoc = c.args[0]
            else if (c.cmd === 'appendElementList') fakeDoc.main = fakeDoc.main.concat(c.args[0])
          }
          await fetch(`${bridge}/ack`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seq: lastSeq, applied: (doc.cmds || []).length, error: '' }),
          })
          await fetch(`${bridge}/state`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ doc: fakeDoc, seq: lastSeq }),
          })
        }
      } catch { /* 关闭后的尾轮 */ }
    }
  })()
  try {
    await fn({ relay, base, bridge })
  } finally {
    stopped = true
    await pump
    if (prevEnv === undefined) delete process.env.CANVAS_BRIDGE_URL
    else process.env.CANVAS_BRIDGE_URL = prevEnv
    await relay.stop()
  }
}

async function mcp(base, method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return res.json()
}
const callRaw = (base, name, args = {}) => mcp(base, 'tools/call', { name, arguments: args })
const textOf = (r) => (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

test('畸形请求行不打崩 relay，后续请求仍可用', await ((async () => {
  const fn = async ({ base }) => {
    const u = new URL(base)
    await new Promise((resolve) => {
      const socket = net.connect(Number(u.port), '127.0.0.1', () => {
        socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n')
      })
      socket.setTimeout(1500)
      socket.on('data', () => { })
      socket.on('close', resolve)
      socket.on('timeout', () => { socket.destroy(); resolve() })
    })
    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)
  }
  return () => withRelay(fn)
})()))

test('超大 body 返回 413（不是连接重置）', await ((async () => {
  const fn = async ({ bridge }) => {
    const res = await fetch(bridge, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmds: [{ cmd: 'undo' }], blob: 'x'.repeat(13 * 1024 * 1024) }),
    })
    assert.equal(res.status, 413)
    await res.text()
  }
  return () => withRelay(fn)
})()))

test('单批超过 100 条指令被拒（bridge 层）', await ((async () => {
  const fn = async ({ bridge }) => {
    const cmds = Array.from({ length: 101 }, () => ({ cmd: 'undo' }))
    const res = await fetch(bridge, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmds }),
    })
    assert.equal(res.status, 400)
  }
  return () => withRelay(fn)
})()))

test('canvas_exec 超批量被工具层拒绝（带可读错误）', await ((async () => {
  const fn = async ({ base }) => {
    const cmds = Array.from({ length: 101 }, () => ({ cmd: 'undo' }))
    const r = await callRaw(base, 'canvas_exec', { cmds })
    assert.equal(r.result?.isError, true)
    assert.match(textOf(r), /最多/)
  }
  return () => withRelay(fn)
})()))

test('未知工具 / 未知命令的错误可读', await ((async () => {
  const fn = async ({ base }) => {
    const unknownTool = await callRaw(base, 'canvas_nope')
    assert.equal(unknownTool.result?.isError, true)
    assert.match(textOf(unknownTool), /未知工具/)
    const bad = await callRaw(base, 'canvas_exec', { cmds: [{ cmd: 'nope' }] })
    assert.equal(bad.result?.isError, true)
    assert.match(textOf(bad), /未知命令/)
  }
  return () => withRelay(fn)
})()))

test('编辑器离线：写工具给出可行动错误（不盲等）', await ((async () => {
  const fn = async ({ base }) => {
    const r = await callRaw(base, 'canvas_append_blocks', { blocks: [{ type: 'paragraph', text: 'x' }] })
    assert.equal(r.result?.isError, true)
    assert.match(textOf(r), /编辑器页面尚未连接/)
    assert.match(textOf(r), /http:\/\/127\.0\.0\.1:\d+/)
  }
  return () => withRelay(fn, { editor: false })
})()))

test('view 端点：三种投影 + 未知 mode 400 + 与镜像一致', await ((async () => {
  const fn = async ({ base, bridge }) => {
    const w = await callRaw(base, 'canvas_write_document', {
      blocks: [
        { type: 'heading', level: 1, text: '稳定性' },
        { type: 'paragraph', text: '正文内容 here' },
      ],
    })
    assert.match(textOf(w), /已写入/)
    await sleep(300)
    const summary = await fetch(`${bridge}/view?mode=summary`).then((r) => r.json())
    assert.match(summary.summary, /字数 \d+/)
    assert.ok(summary.words > 0)
    const text = await fetch(`${bridge}/view?mode=text`).then((r) => r.json())
    assert.match(text.text, /稳定性/)
    assert.match(text.text, /正文内容 here/)
    const outline = await fetch(`${bridge}/view?mode=outline`).then((r) => r.json())
    assert.ok(outline.outline.some((h) => h.text.includes('稳定性')))
    const bad = await fetch(`${bridge}/view?mode=nope`)
    assert.equal(bad.status, 400)
  }
  return () => withRelay(fn)
})()))

test('并发混合负载：10 写 + 20 读交错，全部成功且镜像追上', await ((async () => {
  const fn = async ({ base, bridge }) => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      callRaw(base, 'canvas_append_blocks', { blocks: [{ type: 'paragraph', text: `并发稳定 ${i}` }] }))
    const reads = Array.from({ length: 20 }, (_, i) =>
      i % 2 ? fetch(`${bridge}/view?mode=summary`).then((r) => r.status)
        : fetch(`${bridge}/status`).then((r) => r.status))
    const results = await Promise.allSettled([...writes, ...reads])
    const failed = results.filter((r) => r.status === 'rejected' || r.value?.result?.isError)
    assert.equal(failed.length, 0, `失败 ${failed.length} 个`)
    const doc = await fetch(`${bridge}/doc`).then((r) => r.json())
    assert.ok(doc.state_seq >= doc.applied_seq || doc.state_seq > 0)
    const text = await fetch(`${bridge}/view?mode=text`).then((r) => r.json())
    for (let i = 0; i < 10; i++) assert.match(text.text, new RegExp(`并发稳定 ${i}`))
  }
  return () => withRelay(fn)
})()))

test('写后立即读视图不读陈旧镜像（getView 新鲜度）', await ((async () => {
  const fn = async ({ base }) => {
    for (let i = 0; i < 5; i++) {
      const w = await callRaw(base, 'canvas_append_blocks', { blocks: [{ type: 'paragraph', text: `新鲜度 ${i}` }] })
      assert.match(textOf(w), /已追加/)
      const r = await callRaw(base, 'canvas_read', { mode: 'text' })
      assert.match(textOf(r), new RegExp(`新鲜度 ${i}`))
    }
  }
  return () => withRelay(fn)
})()))
