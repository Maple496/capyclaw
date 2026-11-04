/** validateToolArguments 语义等价性（编译缓存版 vs 解释版行为）：边界逐条断言。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateToolArguments } from '../src/tools/validate.mjs'

const schema = {
  type: 'object',
  required: ['slideIndex'],
  additionalProperties: false,
  properties: {
    slideIndex: { type: 'integer' },
    title: { type: 'string', maxLength: 5 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', maxItems: 2, items: { type: 'string' } },
    either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    nested: { type: 'object', properties: { x: { type: 'number' } } },
  },
}
const tool = { name: 't', inputSchema: schema }

test('合法参数通过；同一 schema 重复调用结果一致（编译缓存不改变语义）', () => {
  const args = { slideIndex: 1, title: 'abc', tags: ['x'], either: 3, nested: { x: 1 } }
  for (let i = 0; i < 3; i++) {
    const r = validateToolArguments(tool, args)
    assert.equal(r.ok, true, r.errors.join())
  }
})

test('必填 / 类型 / 枚举 / 长度 / 数组上限 / 额外字段：错误逐条命中', () => {
  const r = validateToolArguments(tool, { title: 'toolong!!', mode: 'c', tags: ['a', 'b', 'c'], extra: 1 })
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('arguments.slideIndex 必填'))
  assert.ok(r.errors.includes('arguments.title 超过最大长度 5'))
  assert.ok(r.errors.includes('arguments.mode 必须是 a / b'))
  assert.ok(r.errors.includes('arguments.tags 最多 2 项'))
  assert.ok(r.errors.includes('arguments.extra 不是允许的参数'))
})

test('类型不符短路：不再产出深层错误（与解释版一致）', () => {
  const r = validateToolArguments(tool, { slideIndex: 'not-int', nested: 'not-object' })
  assert.deepEqual(r.errors, ['arguments.slideIndex 应为 integer', 'arguments.nested 应为 object'])
})

test('数组元素类型逐项校验；anyOf 两个支路都失败时报错', () => {
  const r = validateToolArguments(tool, { slideIndex: 0, tags: ['ok', 2], either: true })
  assert.ok(r.errors.includes('arguments.tags[1] 应为 string'))
  assert.ok(r.errors.includes('arguments.either 不符合 anyOf'))
})

test('无 inputSchema 的工具：只校验 arguments 是 object', () => {
  assert.equal(validateToolArguments({}, null).ok, true)
  assert.equal(validateToolArguments({}, []).ok, false)
  assert.equal(validateToolArguments(null, { a: 1 }).ok, true)
})
