import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/host.mjs'
import { WorkspaceManager, WorkspaceClient } from '../../dsh-runtime-kit/src/index.mjs'

test('catalog：refreshes and lists works from shared store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-catalog-'))
  const manager = new WorkspaceManager({ storeRoot: root }).init()
  const ns = manager.namespaces.create('rt-cat')
  const client = new WorkspaceClient({ manager, runtimeId: 'rt-cat', token: ns.token })
  client.putJson('main', 'state.json', { ok: true })
  let service
  const dispose = apply({ provide(name, value) { service = value; return () => {} } }, { storeRoot: root })
  assert.ok(service)
  const works = service.refresh()
  assert.equal(works.length, 1)
  assert.equal(works[0].runtimeId, 'rt-cat')
  assert.equal(service.list()[0].workId, 'main')
  dispose()
  fs.rmSync(root, { recursive: true, force: true })
})
