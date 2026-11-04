import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FileStateBackend, PersistentStore, createFileBackend, replayPending, checkpointName, createStateHost,
} from '../src/index.mjs'

test('state-service: API contract', () => {
  const host = createStateHost()
  assert.equal(host.api.name, 'state')
  assert.equal(host.api.version, '1.0.0')
  assert.ok(host.api.capabilities.includes('recovery'))
})


function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-'))
  return path.join(dir, 'state.json')
}

test('state-service: file backend state / journal / checkpoint', () => {
  const file = tempFile()
  const backend = new FileStateBackend(file, { initialDoc: { seq: 0, title: 'untitled' } })
  assert.equal(backend.readState(), null)
  backend.writeState({ seq: 2, title: 'deck' })
  assert.deepEqual(backend.readState(), { seq: 2, title: 'deck' })

  backend.appendJournal({ type: 'push', seq: 2 })
  backend.appendJournal({ type: 'applied', seq: 2 })
  const tail = backend.journalTail(5)
  assert.equal(tail.length, 2)
  assert.equal(tail[0].type, 'push')

  backend.writeCheckpoint('v1', { name: 'v1', seq: 2, title: 'deck', slides: 3, createdAt: 'now' })
  assert.equal(backend.readCheckpoint('v1').slides, 3)
  assert.equal(backend.listCheckpoints()[0].name, 'v1')
  assert.throws(() => checkpointName('../x'), /checkpoint/)
})

test('state-service: PersistentStore wraps backend', () => {
  const file = tempFile()
  const store = new PersistentStore({ backend: createFileBackend(file), initialDoc: { seq: 0 } })
  assert.deepEqual(store.get(), { seq: 0 })
  store.doc.seq = 1
  store.save()
  assert.equal(new FileStateBackend(file).readState().seq, 1)
  store.journal({ type: 'tick' })
  assert.equal(store.journalTail()[0].type, 'tick')
  const cp = store.checkpoint('a', { seq: 1, title: 't', slides: 1 }, { note: 'x' })
  assert.equal(cp.name, 'a')
  assert.equal(store.listCheckpoints().length, 1)
})

test('state-service: replayPending applies pending batch and acks', async () => {
  const applied = []
  const store = {
    pending: () => ({ seq: 7, cmds: [{ op: 'a' }, { op: 'b' }] }),
    applyServer: (seq, count, error) => {
      store.acked = { seq, count, error }
    },
  }
  const result = await replayPending({
    store,
    pending: () => store.pending(),
    apply: (cmd) => { applied.push(cmd.op) },
  })
  assert.deepEqual(applied, ['a', 'b'])
  assert.deepEqual(result, { seq: 7, recovered: 2, error: '' })
  assert.deepEqual(store.acked, { seq: 7, count: 2, error: '' })
})

test('state-service: replayPending stops on error', async () => {
  const store = {
    pending: () => ({ seq: 8, cmds: [{ op: 'a' }, { op: 'b' }] }),
    applyServer: (seq, count, error) => { store.acked = { seq, count, error } },
  }
  const result = await replayPending({
    store,
    pending: () => store.pending(),
    apply: (cmd) => {
      if (cmd.op === 'b') throw new Error('boom')
    },
  })
  assert.equal(result.recovered, 1)
  assert.equal(result.error, 'boom')
  assert.equal(store.acked.error, 'boom')
})
