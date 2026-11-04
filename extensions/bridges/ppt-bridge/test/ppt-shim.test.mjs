import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../plugin/capyclaw-ppt-workbench/server/store.mjs'
import { createJsonPptApp } from '../src/mcp/ppt-shim.mjs'
import { applyOp } from '../src/core/ops.js'

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'pptw-shim-'))
  return { store: new BridgeStore(join(dir, 'state.json')) }
}

test('shim：load + undo + redo 恢复 deck', async () => {
  const { store } = fresh()
  const P = createJsonPptApp(store)
  const a = { title: 'A', slides: [{ id: 'a', elements: [] }] }
  const b = { title: 'B', slides: [{ id: 'b', elements: [] }] }
  await applyOp(P, { op: 'load', deck: a })
  await applyOp(P, { op: 'load', deck: b })
  assert.equal(store.doc.deck.title, 'B')
  assert.equal(P.undo(), true)
  assert.equal(store.doc.deck.title, 'A')
  assert.equal(P.redo(), true)
  assert.equal(store.doc.deck.title, 'B')
})

test('shim：历史最多 50 步，空历史 undo 返回 false', () => {
  const { store } = fresh()
  const P = createJsonPptApp(store)
  assert.equal(P.undo(), false)
  assert.equal(P.redo(), false)
  for (let i = 0; i < 60; i++) {
    P.snapshot()
    P.load({ title: `T${i}`, slides: [{ id: `${i}`, elements: [] }] })
  }
  let count = 0
  while (P.undo()) count++
  assert.ok(count <= 50)
})

test('shim：set-background 修改后 undo 回到旧背景', async () => {
  const { store } = fresh()
  const P = createJsonPptApp(store)
  await applyOp(P, { op: 'load', deck: { title: 'T', slides: [{ id: 's', background: { type: 'solid', color: '#fff' }, elements: [] }] } })
  await applyOp(P, { op: 'set-background', color: '#000000' })
  assert.equal(store.doc.deck.slides[0].background.color, '#000000')
  assert.equal(P.undo(), true)
  assert.equal(store.doc.deck.slides[0].background.color, '#fff')
})
