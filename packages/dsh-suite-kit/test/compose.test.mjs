import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeSuites, loadSuiteManifest, renderCordisPatch } from '../src/index.mjs'

function suite(name, manifest) {
  const dir = mkdtempSync(join(tmpdir(), `suite-${name}-`))
  writeFileSync(join(dir, 'dsh-suite.json'), JSON.stringify({ name, ...manifest }))
  return loadSuiteManifest(dir)
}

test('两个 suite 合并：不同 row 共存，同 row 去重', () => {
  const a = suite('suite-a', {
    version: '1.0.0',
    packages: { 'pkg-a': { role: 'runtime', version: '^1.0.0', provides: { ports: [4001], tools: ['a_*'] } } },
    rows: [{ id: 'host-a', name: 'pkg-a' }],
  })
  const b = suite('suite-b', {
    version: '1.0.0',
    packages: { 'pkg-b': { role: 'skills', version: '^1.0.0', provides: { skills: ['b'] } } },
    rows: [{ id: 'host-a', name: 'pkg-a' }, { id: 'host-b', name: 'pkg-b' }],
  })
  const result = composeSuites([a, b])
  assert.equal(result.ok, true)
  assert.equal(result.rows.length, 2)
  assert.deepEqual(result.rows.map((r) => r.id).sort(), ['host-a', 'host-b'])
})

test('同一个 row id 不同定义报冲突', () => {
  const a = suite('suite-a', {
    version: '1.0.0', packages: { 'pkg-a': { role: 'runtime', version: '^1.0.0' } },
    rows: [{ id: 'host', name: 'pkg-a' }],
  })
  const b = suite('suite-b', {
    version: '1.0.0', packages: { 'pkg-b': { role: 'runtime', version: '^1.0.0' } },
    rows: [{ id: 'host', name: 'pkg-b' }],
  })
  const result = composeSuites([a, b])
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('row host 冲突')))
})

test('端口冲突报错', () => {
  const a = suite('suite-a', {
    version: '1.0.0', packages: { 'pkg-a': { role: 'runtime', version: '^1.0.0', provides: { ports: [39311] } } },
    rows: [{ id: 'a', name: 'pkg-a' }],
  })
  const b = suite('suite-b', {
    version: '1.0.0', packages: { 'pkg-b': { role: 'bridge', version: '^1.0.0', provides: { ports: [39311] } } },
    rows: [{ id: 'b', name: 'pkg-b' }],
  })
  const result = composeSuites([a, b])
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('端口 39311 冲突')))
})

test('能力图：provider/consumer 解析成功', () => {
  const a = suite('suite-runtime', {
    version: '1.0.0',
    packages: { runtime: { role: 'runtime', version: '^1.0.0', provides: { capabilities: { 'ppt.runtime': '1.0.0' } } } },
    rows: [{ id: 'runtime-row', name: 'runtime' }],
  })
  const b = suite('suite-skills', {
    version: '1.0.0',
    packages: { skills: { role: 'skills', version: '^1.0.0', requires: { capabilities: { 'ppt.runtime': '^1.0.0' } }, provides: { capabilities: { 'ppt.workflows': '1.0.0' } } } },
    rows: [{ id: 'skills-row', name: 'skills' }],
  })
  const result = composeSuites([a, b])
  assert.equal(result.ok, true)
  assert.ok(result.capabilities.some((c) => c.capability === 'ppt.runtime' && c.package === 'runtime'))
})

test('能力图：缺少 provider 报错', () => {
  const a = suite('suite-skills', {
    version: '1.0.0',
    packages: { skills: { role: 'skills', version: '^1.0.0', requires: { capabilities: { 'ppt.runtime': '^1.0.0' } } } },
    rows: [{ id: 'skills-row', name: 'skills' }],
  })
  const result = composeSuites([a])
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('需要能力 ppt.runtime')))
})

test('renderCordisPatch 生成可读 YAML', () => {
  const yaml = renderCordisPatch([
    { id: 'host', name: 'pkg' },
    { id: 'mcp', name: '@scope/client', config: { serverName: 'x', url: 'http://127.0.0.1:1/mcp' } },
  ])
  assert.match(yaml, /^- insert:/m)
  assert.match(yaml, /- id: host/m)
  assert.match(yaml, /config: \{"serverName":"x"/)
})
