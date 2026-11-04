/** BridgeStore：编辑器权威会话流转（内存 backend 直测）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBackend } from '@capyclaw/document-workbench/testing'
import { BridgeStore } from '../plugin/capyclaw-canvas-workbench/server/store.mjs'

function newStore() {
  const backend = createMemoryBackend({})
  const store = new BridgeStore({ backend })
  return { store, backend }
}

test('初始态：空信封，doc 键未定义', () => {
  const { store } = newStore()
  const doc = store.get()
  assert.equal(doc.seq, 0)
  assert.equal(doc.applied_seq, 0)
  assert.equal(doc.doc, undefined)
})

test('编辑器权威：push 入队不应用，ack 后清队', async () => {
  const { store } = newStore()
  const pushed = await store.enqueue(() => store.push([{ cmd: 'undo' }], 't'))
  assert.equal(pushed.seq, 1)
  assert.equal(store.get().applied_seq, 0)
  assert.deepEqual(store.get().cmds, [{ cmd: 'undo' }])

  await store.enqueue(() => store.ack(1, 1, ''))
  assert.equal(store.get().applied_seq, 1)
  assert.equal(store.get().applied, 1)
  assert.equal(store.get().error, '')
})

test('ack 报错落在 error 字段', async () => {
  const { store } = newStore()
  await store.enqueue(() => store.push([{ cmd: 'bold' }], ''))
  await store.enqueue(() => store.ack(1, 0, '未知命令'))
  assert.equal(store.get().error, '未知命令')
})

test('state 镜像写入 doc 键并推进 state_seq', async () => {
  const { store } = newStore()
  const value = { header: [], main: [{ value: 'hi' }, { value: '\n' }], footer: [] }
  await store.enqueue(() => store.state(value, 0))
  const doc = store.get()
  assert.deepEqual(doc.doc, value)
  assert.equal(doc.state_seq, 0)
  assert.ok(doc.state_seq >= 0)
})

test('owner 租约：claim/release/status', () => {
  const { store } = newStore()
  const first = store.claim('tab-a', true)
  assert.equal(first.ok, true)
  const second = store.claim('tab-b', false)
  assert.equal(second.ok, false)
  const forced = store.claim('tab-b', true)
  assert.equal(forced.ok, true)
  assert.equal(store.release('tab-b').ok, true)
})

test('checkpoint 存取（载荷为 doc）', async () => {
  const { store } = newStore()
  const value = { header: [], main: [{ value: 'x' }], footer: [] }
  await store.enqueue(() => store.state(value, 1))
  const payload = await store.enqueue(() => store.checkpoint('m1', { words: 1 }))
  assert.ok(payload)
  assert.deepEqual(store.readCheckpoint('m1').doc, value)
  assert.ok(store.listCheckpoints().some((c) => c.name === 'm1'))
})

test('summary 投影带 words/elements', async () => {
  const { store } = newStore()
  await store.enqueue(() => store.state({ header: [], main: [{ value: '你好世界' }], footer: [] }, 0))
  const summary = store.summary(store.get())
  assert.equal(summary.words, 4)
  assert.ok(summary.elements >= 1)
})
