import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emit, verify } from '../src/index.mjs'

const LIB = {
  generatedAt: '2026-11-02T00:00:00.000Z',
  components: [
    { id: 'cap-a', name: 'cap-a', kind: 'capability', title: '能力A', description: '', tags: [], version: '1.0.0', source: { package: './cap-a' }, provides: { capabilities: { 'a.runtime': '1.0.0' } } },
    { id: 'pkg-core', name: 'pkg-core', kind: 'plugin', title: 'Core', description: '', version: '1.0.0', source: { package: './pkg-core' }, provides: { tools: ['core_echo'] } },
  ],
}

const RESOLVED = {
  ok: true,
  components: LIB.components,
  selected: ['cap-a', 'pkg-core'],
  expanded: ['cap-a', 'pkg-core'],
  conflicts: [],
  errors: [],
  warnings: [],
}

test('emit registry：生成 manifest + loader 并通过 verify', async () => {
  const outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emit-reg-')), 'out')
  const result = await emit(RESOLVED, { target: 'registry' }, { outDir })
  assert.equal(result.target, 'registry')
  assert.ok(fs.existsSync(result.files.manifest))
  assert.ok(fs.existsSync(result.files.loader))
  const manifest = JSON.parse(fs.readFileSync(result.files.manifest, 'utf8'))
  assert.ok(Object.keys(manifest).length > 0)
  await verify(outDir, 'registry')
})

test('emit bundle：生成 dsh-suite.json + cordis.patch.yml 并通过 verify', async () => {
  const outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emit-bun-')), 'out')
  const result = await emit(RESOLVED, { target: 'bundle', name: 'assembled-product', version: '1.0.0' }, { outDir })
  assert.equal(result.target, 'bundle')
  const suiteFile = path.join(outDir, 'dsh-suite.json')
  const patchFile = path.join(outDir, 'cordis.patch.yml')
  assert.ok(fs.existsSync(suiteFile), '应有 dsh-suite.json')
  assert.ok(fs.existsSync(patchFile), '应有 cordis.patch.yml')
  const suiteManifest = JSON.parse(fs.readFileSync(suiteFile, 'utf8'))
  assert.equal(suiteManifest.name, 'assembled-product-suite', 'suite 名默认加 -suite 后缀')
  await verify(outDir, 'bundle')
})

test('emit/verify：缺 target 与未知 target 报错', async () => {
  await assert.rejects(() => emit(RESOLVED, {}, { outDir: 'x' }), /需要指定 target/)
  await assert.rejects(() => emit(RESOLVED, { target: 'nope' }, { outDir: 'x' }), /未知的 target/)
  await assert.rejects(() => verify('x', undefined), /需要指定 target/)
})
