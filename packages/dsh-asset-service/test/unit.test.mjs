import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAssetRoutes, createFileAssetStore, createWorkspaceAssetStore, createAssetHost } from '../src/index.mjs'

test('asset-service: API contract', () => {
  const host = createAssetHost()
  assert.equal(host.api.name, 'assets')
  assert.equal(host.api.version, '1.0.0')
  assert.ok(host.api.capabilities.includes('sha256'))
})

import { createServiceApp } from '../../dsh-service-host/src/index.mjs'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-assets-'))
}

test('asset-service: file store put/get dedupes by sha256', async () => {
  const store = createFileAssetStore({ dir: tempDir() })
  const one = await store.put(Buffer.from('hello'), 'text/plain')
  const two = await store.put(Buffer.from('hello'), 'text/plain')
  assert.equal(one.id, two.id)
  assert.equal(one.url, `/assets/${one.id}`)
  const got = store.get(one.id)
  assert.equal(got.data.toString(), 'hello')
  assert.equal(got.contentType, 'text/plain')
  assert.equal(store.get('missing'), null)
})

test('asset-service: workspace store uses scoped client', async () => {
  const objects = new Map()
  const storeClient = {
    put(workId, key, data, opts) { objects.set(`${workId}/${key}`, { data, opts }) },
    get(workId, key) { return objects.get(`${workId}/${key}`)?.data || null },
    list(workId) {
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(`${workId}/`))
        .map(([k, v]) => ({ key: k.slice(workId.length + 1), contentType: v.opts?.contentType }))
    },
  }
  const store = createWorkspaceAssetStore({ storeClient, workId: 'main' })
  const asset = await store.put(Buffer.from('img'), 'image/png')
  assert.equal(store.get(asset.id).contentType, 'image/png')
  assert.equal(store.has(asset.id), true)
})

test('asset-service: HTTP routes upload and serve', async () => {
  const store = createFileAssetStore({ dir: tempDir() })
  const app = createServiceApp({ id: 'asset-test' })
  app.use(createAssetRoutes({ assetStore: store }))
  const info = await app.listen({ port: 0 })
  try {
    const base64 = Buffer.from('png-bytes').toString('base64')
    const upload = await fetch(`${info.url}/assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: base64, contentType: 'image/png' }),
    })
    const body = await upload.json()
    assert.equal(body.ok, true)
    assert.match(body.url, /^\/assets\/[a-f0-9]{64}$/)

    const res = await fetch(`${info.url}${body.url}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal(await res.text(), 'png-bytes')

    const head = await fetch(`${info.url}${body.url}`, { method: 'HEAD' })
    assert.equal(head.status, 200)

    const missing = await fetch(`${info.url}/assets/nope`)
    assert.equal(missing.status, 404)
  } finally {
    await app.close()
  }
})
