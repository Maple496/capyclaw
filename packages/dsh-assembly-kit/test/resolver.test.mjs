import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, topologicalSort } from '../src/resolver.mjs'

const LIB = {
  generatedAt: '2026-11-02T00:00:00.000Z',
  components: [
    { id: 'pkg-core', name: 'pkg-core', kind: 'plugin', title: 'Core', description: '', provides: { tools: ['core_echo'], services: ['core-service'] }, ports: [39500] },
    { id: 'pkg-extra', name: 'pkg-extra', kind: 'plugin', title: 'Extra', description: '', dependsOn: ['pkg-core'], provides: { tools: ['extra_hi'] } },
    { id: 'pkg-conflict', name: 'pkg-conflict', kind: 'plugin', title: 'Conflict', description: '', provides: { tools: ['core_echo'] } },
  ],
}

test('resolve：dependsOn 依赖闭包自动展开', () => {
  const result = resolve({ select: { packages: ['pkg-extra'] } }, LIB)
  assert.equal(result.ok, true)
  assert.ok(result.expanded.includes('pkg-core'), '应自动带上 pkg-core')
  assert.equal(result.components.length, 2)
})

test('resolve：工具冲突被检出且 ok=false，strict 抛错', () => {
  const result = resolve({ select: { packages: ['pkg-core', 'pkg-conflict'] } }, LIB)
  assert.equal(result.ok, false)
  assert.ok(result.conflicts.some((c) => c.type === 'tool' && c.tool === 'core_echo'))
  assert.throws(() => resolve({ select: { packages: ['pkg-core', 'pkg-conflict'] } }, LIB, { strict: true }), /依赖解析失败/)
})

test('resolve：参数缺失抛错', () => {
  assert.throws(() => resolve(null, LIB), /需要 productManifest 和 library/)
})

test('topologicalSort：被依赖者排在前面', () => {
  const sorted = topologicalSort([
    { id: 'pkg-extra', dependsOn: ['pkg-core'] },
    { id: 'pkg-core' },
  ])
  assert.deepEqual(sorted.map((c) => c.id), ['pkg-core', 'pkg-extra'])
})
