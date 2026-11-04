import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PKG = join(ROOT, 'plugin', 'dsh-ppt-workbench')
const { startRelay } = await import(pathToFileURL(join(PKG, 'server', 'relay.mjs')).href)

test('启动恢复：未完成批次会重放并落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pptw-recover-'))
  const state = {
    seq: 1,
    cmds: [{ op: 'load', deck: { title: 'Recovered', slides: [{ id: 's1', elements: [] }] } }],
    title: 'Recovered',
    applied_seq: 0,
    applied: 0,
    error: '',
    updated: 0,
    shot_req: 0,
    shot: { req: 0, data: '' },
    ui_seq: 0,
    ui: [],
    deck: { title: 'Old', slides: [] },
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  const relay = await startRelay({ port: 0, hostDir: dir, packageDir: PKG, lockFile: join(dir, '.lock') })
  const deck = await fetch(relay.url + '/deck').then((r) => r.json())
  assert.equal(deck.deck.title, 'Recovered')
  const health = await fetch(relay.editorUrl.replace(/\/$/, '') + '/healthz').then((r) => r.json())
  assert.equal(health.appliedSeq, 1)
  await relay.stop()
})
