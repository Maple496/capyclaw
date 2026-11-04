import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSuiteManifest, validateSuiteManifest } from '../src/index.mjs'

const base = {
  name: 'demo-suite',
  version: '1.0.0',
  packages: {
    'demo-plugin': { role: 'runtime', version: '^1.0.0', path: '../demo-plugin', provides: { ports: [39311] } },
  },
  rows: [{ id: 'demo-host', name: 'demo-plugin' }],
}

test('合法 manifest 通过', () => {
  const result = validateSuiteManifest(base)
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('name/version/rows 非法时报错', () => {
  const result = validateSuiteManifest({
    name: 'Bad_Name', version: 'x', packages: {}, rows: [{ id: 'bad id' }],
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('name')))
  assert.ok(result.errors.some((e) => e.includes('version')))
  assert.ok(result.errors.some((e) => e.includes('packages')))
})

test('重复 row id / 端口范围非法时报错', () => {
  const result = validateSuiteManifest({
    ...base,
    packages: { 'demo-plugin': { role: 'runtime', version: '^1.0.0', provides: { ports: [70000] } } },
    rows: [{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }],
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('row.id 重复')))
  assert.ok(result.errors.some((e) => e.includes('ports')))
})

test('从目录读取 dsh-suite.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-manifest-'))
  writeFileSync(join(dir, 'dsh-suite.json'), JSON.stringify(base))
  const loaded = loadSuiteManifest(dir)
  assert.equal(loaded.manifest.name, 'demo-suite')
  assert.equal(loaded.dir, dir)
})

test('components：展开子 suite 的 packages/rows，并先排组件行', () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-components-'))
  const child = join(root, 'child')
  mkdirSync(child)
  writeFileSync(join(child, 'dsh-suite.json'), JSON.stringify({
    name: 'child-suite',
    version: '1.0.0',
    packages: { 'child-plugin': { role: 'provider', version: '^1.0.0', path: '.' } },
    rows: [{ id: 'child-host', name: 'child-plugin' }],
  }))
  writeFileSync(join(root, 'dsh-suite.json'), JSON.stringify({
    name: 'parent-suite',
    version: '1.0.0',
    components: ['./child'],
    packages: { 'parent-plugin': { role: 'runtime', version: '^1.0.0', path: '.' } },
    rows: [{ id: 'parent-host', name: 'parent-plugin' }],
  }))
  const loaded = loadSuiteManifest(root)
  assert.equal(loaded.manifest.packages['child-plugin'].path, 'child')
  assert.deepEqual(loaded.manifest.rows.map((row) => row.id), ['child-host', 'parent-host'])
  const validation = validateSuiteManifest(loaded.manifest)
  assert.equal(validation.ok, true, validation.errors.join('\n'))
})
