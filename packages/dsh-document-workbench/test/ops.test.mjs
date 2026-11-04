import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpDispatcher, createOpRegistry, defineOp } from '../src/ops/index.mjs'

test('ops：defineOp 与 registry 元数据', () => {
  const op = defineOp({ name: 'inc', run: (target) => { target.value += 1 } })
  assert.equal(op.mutates, true)
  assert.equal(op.view, false)

  const registry = createOpRegistry({
    modules: {
      counter: {
        inc: { run: (target) => { target.value += 1 } },
        select: { mutates: false, view: true, run: () => {} },
      },
    },
  })
  assert.deepEqual(registry.names, ['inc', 'select'])
  assert.deepEqual(registry.viewNames, ['select'])
  assert.equal(registry.isViewOp('select'), true)
  assert.equal(registry.isViewOp({ op: 'inc' }), false)
})

test('ops：mutates 才 snapshot，未知指令报错', async () => {
  const calls = []
  const registry = createOpRegistry({
    ops: {
      inc: { run: (target) => { target.value += 1 } },
      select: { mutates: false, view: true, run: () => {} },
    },
    snapshot: (target) => calls.push(target.value),
  })
  const target = { value: 0 }
  await registry.apply(target, { op: 'inc' })
  assert.deepEqual(calls, [0])
  await registry.apply(target, { op: 'select' })
  assert.deepEqual(calls, [0])
  await assert.rejects(() => registry.apply(target, { op: 'nope' }), /未知指令/)
})

test('ops：createOpDispatcher 兼容旧调用', async () => {
  const applyOp = createOpDispatcher({ inc: { run: (target) => { target.value += 1 } } })
  const target = { value: 0 }
  await applyOp(target, { op: 'inc' })
  assert.equal(target.value, 1)
})
