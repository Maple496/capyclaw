import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncKit } from '../bin/sync.mjs'

test('syncKit 写入源码快照和 manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-kit-sync-'))
  const out = path.join(dir, 'server', 'infra')
  const result = syncKit({ outDir: out })
  assert.equal(result.manifest.name, '@capyclaw/plugin-kit')
  assert.ok(result.manifest.files.includes('service/mcp-http.mjs'))
  assert.ok(result.manifest.files.includes('service/http.mjs'))
  assert.ok(fs.existsSync(path.join(out, 'service', 'mcp-http.mjs')))
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'INFRA_MANIFEST.json'), 'utf8'))
  assert.equal(manifest.version, result.manifest.version)
  assert.match(manifest.hash, /^[a-f0-9]{64}$/)
})

test('syncKit 拒绝覆盖非 kit 目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-kit-sync-'))
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x')
  assert.throws(() => syncKit({ outDir: dir }), /非空且不是 kit 快照/)
  const result = syncKit({ outDir: dir, force: true })
  assert.ok(result.manifest.files.length > 0)
})
