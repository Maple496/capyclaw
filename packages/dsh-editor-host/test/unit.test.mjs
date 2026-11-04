import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEditorHost, createEditorHostService } from '../src/index.mjs'

test('editor-host: API contract', () => {
  const host = createEditorHostService()
  assert.equal(host.api.name, 'editorHost')
  assert.equal(host.api.version, '1.0.0')
  assert.ok(host.api.capabilities.includes('lease'))
})

import { createServiceApp } from '../../dsh-service-host/src/index.mjs'

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-editor-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<div id="app">editor</div>')
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("editor")')
  return dir
}

test('editor-host: static files and lease endpoints', async () => {
  const dir = tempDir()
  const editor = createEditorHost({ id: 'demo-editor', dir, basePath: '/editor' })
  const app = createServiceApp({ id: 'editor-test' })
  for (const route of editor.routes()) app.use(route)
  const info = await app.listen({ port: 0 })
  try {
    const page = await (await fetch(`${info.url}/editor/`)).text()
    assert.match(page, /editor/)
    const js = await (await fetch(`${info.url}/editor/app.js`)).text()
    assert.match(js, /console\.log/)

    const claim = await fetch(`${info.url}/editor/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tab-1' }),
    })
    assert.equal(claim.status, 200)
    assert.equal((await claim.json()).ok, true)
    assert.equal(editor.status().connected, true)

    const status = await (await fetch(`${info.url}/editor/status`)).json()
    assert.equal(status.connected, true)
    assert.equal(status.lease.owner, 'tab-1')

    const second = await fetch(`${info.url}/editor/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tab-2' }),
    })
    assert.equal(second.status, 409)

    const force = await fetch(`${info.url}/editor/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tab-2', force: true }),
    })
    assert.equal(force.status, 200)
    assert.equal(editor.status().lease.owner, 'tab-2')

    await fetch(`${info.url}/editor/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'tab-2' }),
    })
    assert.equal(editor.status().connected, false)
  } finally {
    await app.close()
  }
})

test('editor-host: path traversal rejected', async () => {
  const dir = tempDir()
  const editor = createEditorHost({ id: 'demo-editor', dir })
  const app = createServiceApp({ id: 'editor-test' })
  for (const route of editor.routes()) app.use(route)
  const info = await app.listen({ port: 0 })
  try {
    const res = await fetch(`${info.url}/..%2F..%2Fpackage.json`)
    assert.equal(res.status, 404)
  } finally {
    await app.close()
  }
})
