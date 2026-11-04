import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DocumentSession, createSessionSanitizers, createSessionState, pendingOf, watchSession,
} from '../src/session/index.mjs'
import { createMemoryBackend } from '../src/testing/index.mjs'

function makeSession(initial = { doc: { value: 0 } }) {
  return new DocumentSession({
    backend: createMemoryBackend(),
    initialDoc: initial,
    documentKey: 'doc',
    summary: (doc) => ({ value: doc.doc?.value }),
  })
}

test('session：push / applyServer / state 使用标准信封且忽略过期回执', () => {
  const session = makeSession()
  session.push([{ op: 'inc' }], 'demo')
  assert.equal(session.get().seq, 1)
  assert.equal(pendingOf(session.get()).seq, 1)

  session.applyServer(0, 1, '')
  assert.equal(session.get().applied_seq, 0, '过期回执不生效')

  session.applyServer(1, 1, '')
  assert.equal(session.get().applied_seq, 1)
  assert.equal(session.get().cmds.length, 0)

  session.state({ value: 9 }, 1)
  assert.equal(session.get().doc.value, 9)
  assert.equal(session.get().state_seq, 1)

  session.state({ value: 3 }, 0)
  assert.equal(session.get().doc.value, 9, '旧镜像不覆盖新文档')
})

test('session：runBatch 串行执行、view 命令交给 UI、错误停止并回执', async () => {
  const session = makeSession()
  const applied = []
  const result = await session.runBatch({
    cmds: [{ op: 'inc' }, { op: 'select' }, { op: 'inc' }],
    title: 'batch',
    apply: async (cmd) => {
      applied.push(cmd.op)
      session.get().doc.value += 1
    },
    isViewOp: (cmd) => cmd.op === 'select',
  })
  assert.deepEqual(applied, ['inc', 'inc'])
  assert.equal(result.doc.value, 2)
  assert.equal(result.applied, 3)
  assert.equal(result.ui_seq, 1)
  assert.equal(result.ui[0].op, 'select')

  const failed = await session.runBatch({
    cmds: [{ op: 'inc' }, { op: 'boom' }, { op: 'inc' }],
    title: 'fail',
    apply: async (cmd) => {
      if (cmd.op === 'boom') throw new Error('boom')
      session.get().doc.value += 1
    },
  })
  assert.equal(failed.applied, 1)
  assert.match(failed.error, /boom/)
})

test('session：checkpoint / taskStatus / recover', async () => {
  const session = makeSession()
  session.push([{ op: 'inc' }], 'cp')
  const checkpoint = session.checkpoint('cp-1', { goal: 'test' })
  assert.equal(checkpoint.name, 'cp-1')
  assert.equal(checkpoint.value, 0)
  assert.equal(session.listCheckpoints().length, 1)
  assert.equal(session.readCheckpoint('cp-1').doc.value, 0)

  const recovered = await session.recover({ apply: async () => { session.get().doc.value += 1 } })
  assert.equal(recovered.recovered, 1)
  assert.equal(session.get().applied_seq, 1)
  assert.equal(session.taskStatus().pending, false)
})

test('session：owner 租约同人续约、异人拒绝、过期接管', () => {
  const session = makeSession()
  assert.deepEqual(session.claim('a'), { ok: true, owner: 'a' })
  assert.deepEqual(session.claim('a'), { ok: true, owner: 'a' })
  assert.deepEqual(session.claim('b'), { ok: false, owner: 'a' })
  session.get().owner.ts -= 20
  assert.deepEqual(session.claim('b'), { ok: true, owner: 'b' })
  assert.equal(session.release('b').ok, true)
  assert.equal(session.get().owner, undefined)
})

test('session：无 meta 的旧页面不能用 force 抢走已上报能力的页面', () => {
  const session = makeSession()
  assert.deepEqual(session.claim('new', true, { capabilities: ['import-pptx'] }), { ok: true, owner: 'new' })
  assert.deepEqual(session.claim('old', true), { ok: false, owner: 'new' })
  assert.deepEqual(session.get().owner.meta, { capabilities: ['import-pptx'] })
  assert.equal(session.get().owner.id, 'new')
  /* 同人心跳只发 {id} 时，能力 meta 必须保留。 */
  assert.deepEqual(session.claim('new'), { ok: true, owner: 'new' })
  assert.deepEqual(session.get().owner.meta, { capabilities: ['import-pptx'] })
  /* 有能力的新页面仍可正常接管（例如用户主动刷新/新开页面）。 */
  assert.deepEqual(session.claim('new2', true, { capabilities: ['import-pptx'] }), { ok: true, owner: 'new2' })
})

test('session：watch 在 seq 变化时返回，超时返回当前文档，abort 返回 null', async () => {
  const session = makeSession()
  const changed = watchSession(session, { seq: 0, timeoutS: 1, pollMs: 10 })
  setTimeout(() => session.push([], 'title'), 20)
  const doc = await changed
  assert.equal(doc.seq, 1)

  const timed = await watchSession(session, { seq: 1, timeoutS: 0.05, pollMs: 10 })
  assert.equal(timed.seq, 1)

  const aborted = await watchSession(session, { seq: 1, timeoutS: 1, pollMs: 10, isAborted: () => true })
  assert.equal(aborted, null)
})

test('session：sanitizer 校验通用信封', () => {
  const { sanitizePush, sanitizeAck, sanitizeState, sanitizeShotResult, sanitizeClaim } =
    createSessionSanitizers({ documentKey: 'deck', maxTitle: 5 })
  assert.deepEqual(sanitizePush({ cmds: [{ op: 'x' }], title: 'ok' }), { cmds: [{ op: 'x' }], title: 'ok' })
  assert.equal(sanitizePush({ cmds: [], title: '' }), null)
  assert.equal(sanitizePush({ cmds: [], title: 'toolong' }), null)
  assert.deepEqual(sanitizeAck({ seq: 1, applied: 1 }), { seq: 1, applied: 1, error: '' })
  assert.deepEqual(sanitizeAck({ seq: 1, applied: 1, error: '' }), { seq: 1, applied: 1, error: '' })
  assert.equal(sanitizeState({ document: {} }), null)
  assert.deepEqual(sanitizeState({ deck: {}, seq: 1 }), { value: {}, seq: 1 })
  assert.deepEqual(sanitizeShotResult({ req: 1, data: 'data:image/png;base64,x' }), { req: 1, data: 'data:image/png;base64,x' })
  assert.deepEqual(sanitizeClaim({ id: 'a', force: true }), { id: 'a', force: true })
  assert.equal(sanitizeClaim({ id: '' }), null)
})

test('session：createSessionState 保留领域字段并补默认信封', () => {
  const doc = createSessionState({ deck: { slides: [] }, cmds: [{ op: 'x' }] })
  assert.equal(doc.seq, 0)
  assert.equal(doc.cmds.length, 1)
  assert.deepEqual(doc.shot, { req: 0, data: '' })
})
