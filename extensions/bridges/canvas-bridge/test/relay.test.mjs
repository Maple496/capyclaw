/**
 * relay 集成：真实 HTTP 服务 + 假编辑器（node fetch 实现 watch/ack/state），
 * 不依赖浏览器。MCP 工具 → relay → 假编辑器应用 → 回执 → 工具返回 全链路。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryBackend } from '@capyclaw/document-workbench/testing'
import { setTimeout as sleep } from 'node:timers/promises'

const { startRelay } = await import('../plugin/capyclaw-canvas-workbench/server/relay.mjs')

let relay = null
let base = ''
let bridge = ''
let hostDir = ''
const fakeDoc = { header: [], main: [], footer: [] }
let stopped = false

/** 假编辑器：长轮询 watch → 应用 cmds → ack → 推镜像。 */
async function fakeEditor(clientId) {
  let lastSeq = 0
  while (!stopped) {
    try {
      const res = await fetch(`${bridge}/watch?seq=${lastSeq}&shot=0&ui=0&timeout=2`)
      const doc = await res.json()
      if ((doc.seq | 0) !== lastSeq) {
        lastSeq = doc.seq | 0
        for (const c of doc.cmds || []) {
          if (c.cmd === 'setValue') {
            fakeDoc.main = c.args[0].main
            fakeDoc.header = c.args[0].header
            fakeDoc.footer = c.args[0].footer
          } else if (c.cmd === 'appendElementList') {
            fakeDoc.main = fakeDoc.main.concat(c.args[0])
          } else if (c.cmd === 'undo' || c.cmd === 'redo') {
            /* 假编辑器无历史栈，接受即可 */
          }
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
    } catch { /* relay 关闭后的尾轮 */ }
  }
}

async function mcp(name, args = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message)
  const text = (json.result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  if (json.result.isError) throw new Error(text)
  return text
}

test.before(async () => {
  /* 独立临时 hostDir：并行测试文件不抢默认 ~/.dsh-canvas-bridge 的实例锁。 */
  hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-relay-'))
  relay = await startRelay({
    port: 0,
    hostDir,
    backend: createMemoryBackend({}),
    allowReuse: false,
    strictPort: true,
  })
  base = `http://127.0.0.1:${relay.port}`
  bridge = `${base}/api/desktop/works/canvas-bridge`
  const claim = await fetch(`${bridge}/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fake-editor', force: true, meta: { app: 'fake' } }),
  }).then((r) => r.json())
  assert.equal(claim.ok, true)
  fakeEditor('fake-editor')
})

test.after(async () => {
  stopped = true
  if (relay) await relay.stop()
  if (hostDir) fs.rmSync(hostDir, { recursive: true, force: true })
})

test('healthz：契约快照一致 + 基本字段', async () => {
  const health = await fetch(`${base}/healthz`).then((r) => r.json())
  assert.equal(health.ok, true)
  assert.equal(health.bridge, 'canvas-workbench')
  assert.equal(health.contractsOk, true)
  assert.ok(health.contractsChecked >= 4)
})

test('MCP tools/list 暴露 22 个 canvas_* 工具', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then((r) => r.json())
  assert.equal(res.result.tools.length, 22)
  assert.ok(res.result.tools.every((t) => t.name.startsWith('canvas_')))
})

test('写→假编辑器应用→回执→读取 全链路', async () => {
  const out = await mcp('canvas_write_document', {
    blocks: [
      { type: 'heading', level: 1, text: '集成测试' },
      { type: 'paragraph', text: 'relay 无浏览器链路。' },
    ],
  })
  assert.match(out, /已写入/)

  const text = await mcp('canvas_read', { mode: 'text' })
  assert.match(text, /集成测试/)

  const summary = await mcp('canvas_read', { mode: 'summary' })
  assert.match(summary, /字数 \d+/)

  const outline = await mcp('canvas_read', { mode: 'outline' })
  assert.match(outline, /集成测试/)
})

test('append / replace / style / search 走镜像变换', async () => {
  await mcp('canvas_append_blocks', { blocks: [{ type: 'bullet', text: '追加项 alpha' }] })
  const replaced = await mcp('canvas_replace_text', { find: 'alpha', replace: 'beta' })
  assert.match(replaced, /已替换 1 处/)
  const styled = await mcp('canvas_style', { find: 'beta', style: { bold: true } })
  assert.match(styled, /已给 1 处文本套样式/)
  const found = await mcp('canvas_search', { find: 'beta' })
  assert.match(found, /命中 1 处/)
  const none = await mcp('canvas_search', { find: '不存在的内容' })
  assert.match(none, /未找到/)
})

test('表格插入与结构操作', async () => {
  const out = await mcp('canvas_insert_table', { headers: ['A', 'B'], rows: [['1', '2']] })
  assert.match(out, /已插入表格/)
  const cell = await mcp('canvas_table', { action: 'setCell', table: 0, row: 0, col: 0, text: 'A1', backgroundColor: '#eee' })
  assert.match(cell, /setCell/)
  const row = await mcp('canvas_table', { action: 'insertRow', table: 0, row: 1 })
  assert.match(row, /insertRow/)
  const del = await mcp('canvas_table', { action: 'deleteCol', table: 0, col: 1 })
  assert.match(del, /deleteCol/)
  const docText = await mcp('canvas_read', { mode: 'doc' })
  assert.match(docText, /A1/)
})

test('canvas_exec 白名单拒绝未知命令', async () => {
  await assert.rejects(
    () => mcp('canvas_exec', { cmds: [{ cmd: 'definitely-not-a-command' }] }),
    /未知命令/,
  )
  const ok = await mcp('canvas_exec', { cmds: [{ cmd: 'undo' }] })
  assert.match(ok, /已执行 1 条命令/)
})

test('审计 + 检查点 + 导出', async () => {
  const audit = await mcp('canvas_audit')
  assert.match(audit, /审计结果/)
  const saved = await mcp('canvas_checkpoint', { action: 'save', name: 'it' })
  assert.match(saved, /已存检查点 it/)
  const exported = await mcp('canvas_export', { name: 'it-doc' })
  assert.match(exported, /已导出 HTML/)
  const download = await fetch(`${base}/exports/it-doc.html`)
  assert.equal(download.status, 200)
  const html = await download.text()
  assert.ok(html.includes('集成测试'))
})

test('bridge 协议端点：status/doc/ui/task', async () => {
  const status = await fetch(`${bridge}/status`).then((r) => r.json())
  assert.ok(status.words > 0)
  assert.equal(status.has_doc, true)
  assert.ok(status.owner)
  const doc = await fetch(`${bridge}/doc`).then((r) => r.json())
  assert.ok(Array.isArray(doc.doc.main))
  const task = await fetch(`${bridge}/task/status`).then((r) => r.json())
  assert.ok(task)
  const cps = await fetch(`${bridge}/task/checkpoints`).then((r) => r.json())
  assert.ok(cps.checkpoints.some((c) => c.name === 'it'))
  const fourOhFour = await fetch(`${bridge}/nope`)
  assert.equal(fourOhFour.status, 404)
})

test('非法推送被 400 拒绝', async () => {
  const bad = await fetch(`${bridge}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmds: 'not-array' }),
  })
  assert.equal(bad.status, 400)
})
