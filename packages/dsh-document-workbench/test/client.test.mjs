import test from 'node:test'
import assert from 'node:assert/strict'
import { createEditorClient } from '../src/client/index.mjs'
import { createFakeEditorAdapter } from '../src/testing/index.mjs'

function makeApi(initial) {
  const calls = []
  let doc = structuredClone(initial)
  const api = async (path, init) => {
    calls.push({ path, init })
    if (path === '') return structuredClone(doc)
    if (path.startsWith('/watch')) return structuredClone(doc)
    if (path === '/status') return { shot_req: doc.shot_req || 0, shot: doc.shot || { req: 0 } }
    if (path === '/document') return { document: structuredClone(doc.document), state_seq: doc.seq }
    if (path === '/ui') return { ui_seq: doc.ui_seq || 0, ui: doc.ui || [] }
    if (path === '/claim') return { ok: true, owner: 'test' }
    if (path === '/ack') return {}
    if (path === '/state') return {}
    if (path === '/shot-result') return {}
    return {}
  }
  return { api, calls, get doc() { return doc }, set doc(value) { doc = value } }
}

function makeClient(api, adapter, options = {}) {
  return createEditorClient({
    api,
    clientId: 'client-1',
    adapter,
    documentKey: 'document',
    documentPath: '/document',
    storage: null,
    workerFactory: () => null,
    ...options,
  })
}

test('client：restore 加载文档并记录 seq/ui_seq', async () => {
  const api = makeApi({ seq: 3, ui_seq: 2, document: { value: 5 }, shot_req: 0 })
  const adapter = createFakeEditorAdapter()
  const client = makeClient(api.api, adapter)
  await client.restore()
  assert.equal(adapter.document.value, 5)
  assert.equal(client.state.lastSeq, 3)
  assert.equal(client.state.lastUiSeq, 2)
})

test('client：server authority 在 seq 变化时拉镜像', async () => {
  const api = makeApi({ seq: 1, document: { value: 1 }, shot_req: 0 })
  const adapter = createFakeEditorAdapter()
  const client = makeClient(api.api, adapter)
  client.state.active = true
  client.state.lastSeq = 0
  api.doc = { seq: 1, document: { value: 9 }, shot_req: 0 }
  await client.pumpOnce()
  assert.equal(adapter.document.value, 9)
  assert.equal(client.state.lastSeq, 1)
})

test('client：editor authority 应用命令并回执', async () => {
  const api = makeApi({ seq: 1, cmds: [{ op: 'inc' }], document: { value: 0 }, shot_req: 0 })
  const adapter = createFakeEditorAdapter({
    document: { value: 0 },
    applyCommand: (doc) => ({ value: doc.value + 1 }),
  })
  const client = makeClient(api.api, adapter, { authority: 'editor' })
  client.state.active = true
  await client.pumpOnce()
  assert.equal(adapter.document.value, 1)
  const ack = api.calls.find((call) => call.path === '/ack')
  assert.ok(ack)
  assert.equal(JSON.parse(ack.init.body).applied, 1)
})

test('client：pushState 把 dump 作为 /state 的 document 发送', async () => {
  const api = makeApi({ seq: 1, document: { value: 0 }, shot_req: 0 })
  const adapter = createFakeEditorAdapter({ document: { value: 4 } })
  const client = makeClient(api.api, adapter)
  client.state.active = true
  client.state.lastSeq = 1
  await client.pushState()
  const state = api.calls.find((call) => call.path === '/state')
  assert.ok(state)
  assert.equal(JSON.parse(state.init.body).document.value, 4)
})

test('client：截图请求回传 renderScreenshot 的结果', async () => {
  const api = makeApi({ seq: 0, document: {}, shot_req: 1, shot: { req: 0 } })
  const adapter = createFakeEditorAdapter({
    document: {},
    renderScreenshot: async () => 'data:image/png;base64,c2hvdA==',
  })
  const client = makeClient(api.api, adapter)
  await client.shoot(1)
  const result = api.calls.find((call) => call.path === '/shot-result')
  assert.ok(result)
  assert.equal(JSON.parse(result.init.body).data, 'data:image/png;base64,c2hvdA==')
})
