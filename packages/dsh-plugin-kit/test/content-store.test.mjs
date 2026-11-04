import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BlobStore, WorkspaceManager, WorkspaceClient, WorkspaceBackend,
} from '../src/index.mjs'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-kit-content-'))
  const manager = new WorkspaceManager({ storeRoot: root }).init()
  const a = manager.namespaces.create('rt-a', { ttlSec: 0 })
  const b = manager.namespaces.create('rt-b', { ttlSec: 0 })
  return { root, manager, a, b }
}

test('BlobStore：纯内容寻址，不认识文件名/作品', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-kit-blob-'))
  const store = new BlobStore({ root }).init()
  const one = store.put('hello')
  const two = store.put(Buffer.from('hello'))
  assert.equal(one.hash, two.hash)
  assert.equal(store.get(one.hash).toString(), 'hello')
  assert.equal(store.list().length, 1)
  assert.equal(fs.existsSync(join(root, 'objects', one.hash.slice(0, 2), one.hash)), true)
  assert.equal(store.gc(new Set()).removed, 1)
  assert.equal(store.list().length, 0)
})

test('Workspace：文件关系、归属、CAS、catalog 由中间层管理', () => {
  const { root, manager, a, b } = setup()
  const ca = new WorkspaceClient({ manager, runtimeId: 'rt-a', token: a.token })
  const cb = new WorkspaceClient({ manager, runtimeId: 'rt-b', token: b.token })

  const first = ca.putJson('main', 'deck/state.json', { title: 'A', slides: [1] })
  assert.equal(first.version, 1)
  ca.putJson('main', 'notes/readme.txt', 'hello')
  assert.equal(ca.list('main').length, 2)
  assert.deepEqual(ca.getJson('main', 'deck/state.json'), { title: 'A', slides: [1] })

  // 同 runtime 的另一个 client（多个会话）共享同一个 work
  const sameRuntime = new WorkspaceClient({ manager, runtimeId: 'rt-a', token: a.token })
  assert.deepEqual(sameRuntime.getJson('main', 'deck/state.json'), { title: 'A', slides: [1] })

  // 不同 runtime 的 token 不能访问
  assert.throws(() => new WorkspaceClient({ manager, runtimeId: 'rt-b', token: a.token }), /权限/)
  assert.throws(() => cb.getJson('main', 'deck/state.json'), /不存在/)

  // 同一版本只能提交一次
  ca.putJson('main', 'deck/state.json', { title: 'A2' }, { expectedVersion: 2 })
  assert.throws(
    () => ca.putJson('main', 'deck/state.json', { title: 'A3' }, { expectedVersion: 2 }),
    /版本冲突/,
  )
  assert.equal(ca.getJson('main', 'deck/state.json').title, 'A2')

  const catalog = manager.listWorks()
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].runtimeId, 'rt-a')
  assert.equal(catalog[0].files, 2)
  assert.equal(manager.referencedHashes().size, 2)
  assert.equal(manager.gc({ minAgeMs: 0 }).removed, 1)
  assert.ok(fs.existsSync(join(root, 'workspaces', 'rt-a', 'main', 'manifest.json')))
})


test('Workspace declaration：中间层声明决定这个 work 能改哪些文件', () => {
  const { manager, a } = setup()
  const client = new WorkspaceClient({ manager, runtimeId: 'rt-a', token: a.token })
  manager.declareWork('rt-a', 'main', { files: ['deck/**'], allowNew: false })
  client.putJson('main', 'deck/a.json', { ok: true })
  assert.throws(() => client.putJson('main', 'secret.json', { ok: false }), /声明范围/)
  const manifest = manager.readManifest('rt-a', 'main')
  assert.deepEqual(manifest.declaration.files, ['deck/**'])
  assert.equal(manifest.declaration.allowNew, false)
  assert.ok(manifest.files['deck/a.json'])
  assert.equal(manifest.files['secret.json'], undefined)
})

test('WorkspaceBackend：journal 超阈值轮转到 .1，tail 跨文件读取', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-kit-journal-'))
  const manager = new WorkspaceManager({ storeRoot: root, journalMaxBytes: 64 * 1024 }).init()
  const ns = manager.namespaces.create('rt-journal', { ttlSec: 0 })
  const client = new WorkspaceClient({ manager, runtimeId: 'rt-journal', token: ns.token })
  manager.declareWork('rt-journal', 'main', { files: ['journal.jsonl'], allowNew: false })
  const backend = new WorkspaceBackend({ client, workId: 'main' })
  for (let i = 0; i < 100; i++) {
    backend.appendJournal({ type: 'push', seq: i, payload: 'x'.repeat(1024) })
  }
  assert.ok(client.list('main').some((item) => item.key === 'journal.jsonl.1'))
  const tail = backend.journalTail(3)
  assert.equal(tail.at(-1).seq, 99)
})

test('WorkspaceBackend：state/journal/checkpoint 全部映射到对象仓库', () => {
  const { manager, a } = setup()
  const client = new WorkspaceClient({ manager, runtimeId: 'rt-a', token: a.token })
  manager.declareWork('rt-a', 'main', { files: ['state.json', 'journal.jsonl', 'checkpoints/**'], allowNew: false })
  const backend = new WorkspaceBackend({ client, workId: 'main' })
  backend.writeState({ seq: 2, deck: { slides: [] } })
  backend.appendJournal({ type: 'push', seq: 2 })
  backend.writeCheckpoint('cp1', { name: 'cp1', seq: 2, deck: { title: 'x', slides: [] }, createdAt: new Date().toISOString(), meta: { goal: 'test' } })

  const reloaded = new WorkspaceBackend({ client, workId: 'main' })
  assert.equal(reloaded.readState().seq, 2)
  assert.equal(reloaded.journalTail(5).at(-1).type, 'checkpoint')
  assert.equal(reloaded.listCheckpoints()[0].name, 'cp1')
  assert.equal(reloaded.readCheckpoint('cp1').deck.title, 'x')
  assert.ok(client.list('main').some((item) => item.key === 'state.json'))
  assert.ok(client.list('main').some((item) => item.key === 'checkpoints/cp1.json'))
})
