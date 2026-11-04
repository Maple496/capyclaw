import test from 'node:test'
import assert from 'node:assert/strict'
import { search, findById, findByIds, filterByKind, listTools, stats } from '../src/catalog.mjs'

const LIB = {
  generatedAt: '2026-11-02T00:00:00.000Z',
  components: [
    { id: 'cap-a', name: 'cap-a', kind: 'capability', title: '能力A', description: '运行时能力', tags: ['read'], provides: { capabilities: { 'a.runtime': '1.0.0' } } },
    { id: 'pkg-core', name: 'pkg-core', kind: 'plugin', title: '核心插件', description: '核心 echo 工具', tags: ['core'], provides: { tools: ['core_echo'], services: ['core-service'] }, ports: [39500] },
    { id: 'pkg-extra', name: 'pkg-extra', kind: 'plugin', title: '扩展插件', description: '依赖核心的扩展', tags: ['extra'], dependsOn: ['pkg-core'], provides: { tools: ['extra_hi'] } },
  ],
}

test('search：文本/kind/tags/provides/limit 各维度过滤', () => {
  assert.equal(search('echo', LIB).length, 1)
  assert.equal(search('核心', LIB)[0].id, 'pkg-core')
  assert.deepEqual(search(null, LIB, { kind: 'plugin' }).map((c) => c.id), ['pkg-core', 'pkg-extra'])
  assert.deepEqual(search(null, LIB, { tags: 'read' }).map((c) => c.id), ['cap-a'])
  assert.equal(search(null, LIB, { provides: { tools: 'extra_hi' } }).length, 1)
  assert.equal(search(null, LIB, { limit: 1 }).length, 1)
  assert.deepEqual(search('zzz-none', LIB), [])
  assert.deepEqual(search('anything', null), [])
})

test('findById / findByIds：命中与缺失', () => {
  assert.equal(findById('pkg-core', LIB).name, 'pkg-core')
  assert.equal(findById('ghost', LIB), null)
  assert.deepEqual(findByIds(['cap-a', 'pkg-core'], LIB).length, 2)
  assert.deepEqual(findByIds(['ghost'], LIB), [])
})

test('filterByKind / listTools / stats', () => {
  assert.deepEqual(filterByKind('plugin', LIB).length, 2)
  assert.ok(listTools(LIB).includes('core_echo'))
  const s = stats(LIB)
  assert.equal(s.total, 3)
})
