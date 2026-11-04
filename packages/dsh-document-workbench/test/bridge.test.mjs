import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createDocumentBridge } from '../src/bridge/index.mjs'
import { DocumentSession } from '../src/session/index.mjs'
import { createMemoryBackend } from '../src/testing/index.mjs'

async function startBridge() {
  const session = new DocumentSession({
    backend: createMemoryBackend(),
    initialDoc: { document: { value: 0 } },
    documentKey: 'document',
    summary: (doc) => ({ value: doc.document?.value, title: 'demo' }),
  })
  const bridge = createDocumentBridge({
    session,
    documentKey: 'document',
    documentPath: '/document',
    bridgeName: 'test-bridge',
    apply: (cmd) => {
      if (cmd.op !== 'inc') throw new Error('unknown op')
      session.getDocument().value += Number(cmd.by) || 1
    },
    projectStatus: (doc) => ({ kind: 'test', value: doc.document?.value }),
  })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    for (const route of bridge.routes) {
      if (await route(req, res, url)) return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { session, bridge, server, base }
}

async function json(base, path, init) {
  const response = await fetch(base + path, init)
  return { status: response.status, body: await response.json() }
}

function post(base, path, body) {
  return json(base, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('bridge：push/read/status/document/task/watch/claim/state/shot', async () => {
  const { session, server, base } = await startBridge()
  try {
    const pushed = await post(base, '/', { cmds: [{ op: 'inc', by: 2 }], title: 'demo' })
    assert.equal(pushed.status, 200)
    assert.equal(pushed.body.seq, 1)
    assert.equal(pushed.body.applied_seq, 1)
    assert.equal(pushed.body.document.value, 2)

    const read = await json(base, '/')
    assert.equal(read.body.document.value, 2)

    const status = await json(base, '/status')
    assert.equal(status.body.seq, 1)
    assert.equal(status.body.kind, 'test')
    assert.equal(status.body.value, 2)

    const document = await json(base, '/document')
    assert.equal(document.body.document.value, 2)
    assert.equal(document.body.state_seq, 1)

    const task = await json(base, '/task/status')
    assert.equal(task.body.pending, false)
    assert.equal(task.body.value, 2)

    const checkpoint = await post(base, '/task/checkpoint', { name: 'cp-1', meta: { x: 1 } })
    assert.equal(checkpoint.status, 200)
    assert.equal(checkpoint.body.name, 'cp-1')
    const checkpoints = await json(base, '/task/checkpoints')
    assert.equal(checkpoints.body.checkpoints.length, 1)

    const watch = await json(base, '/watch?seq=0&shot=0&ui=0&timeout=1')
    assert.equal(watch.body.seq, 1)

    const claim = await post(base, '/claim', { id: 'win-a' })
    assert.deepEqual(claim.body, { ok: true, owner: 'win-a' })
    const statusAfter = await json(base, '/status')
    assert.equal(statusAfter.body.owner.id, 'win-a')

    const state = await post(base, '/state', { document: { value: 7 }, seq: 1 })
    assert.equal(state.body.document.value, 7)
    assert.equal(state.body.state_seq, 1)

    const shotRequest = await post(base, '/shot-request', {})
    assert.equal(shotRequest.body.shot_req, 1)
    const shotResult = await post(base, '/shot-result', { req: 1, data: 'data:image/png;base64,x' })
    assert.equal(shotResult.body.shot.req, 1)
    const shot = await json(base, '/shot')
    assert.equal(shot.body.req, 1)

    assert.equal(session.get().seq, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('bridge：非法请求返回 400，未知路径 404', async () => {
  const { server, base } = await startBridge()
  try {
    const bad = await post(base, '/', { cmds: 'nope' })
    assert.equal(bad.status, 400)
    const unknown = await json(base, '/nope')
    assert.equal(unknown.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('bridge：editor authority 只 push，客户端 ack 后落回执', async () => {
  const session = new DocumentSession({
    backend: createMemoryBackend(),
    initialDoc: { document: { value: 0 } },
    documentKey: 'document',
  })
  const bridge = createDocumentBridge({
    session,
    documentKey: 'document',
    documentPath: '/document',
    authority: 'editor',
  })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    for (const route of bridge.routes) {
      if (await route(req, res, url)) return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const pushed = await post(base, '/', { cmds: [{ op: 'inc' }], title: 'editor' })
    assert.equal(pushed.body.seq, 1)
    assert.equal(pushed.body.applied_seq, 0)
    assert.equal(pushed.body.cmds.length, 1)
    const acked = await post(base, '/ack', { seq: 1, applied: 1, error: '' })
    assert.equal(acked.body.applied_seq, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
