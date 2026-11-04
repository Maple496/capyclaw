/**
 * dsh-state-service 评估器：真实 FileStateBackend——journal 追加/轮转、
 * 尾读、原子 state 写、checkpoint、崩溃后重载恢复。
 */
import fs from 'node:fs'
import path from 'node:path'
import { importPkg, tempDir, rmRf, percentile, round2 } from '../util.mjs'

const { FileStateBackend, PersistentStore } = await importPkg('dsh-state-service', 'src/index.mjs')

function bench(journalMaxBytes, tailLimit) {
  const dir = tempDir('evo-ss-')
  try {
    const file = path.join(dir, 'state.json')
    const backend = new FileStateBackend(file, { initialDoc: { seq: 0 }, journalMaxBytes })
    const store = new PersistentStore({ backend, initialDoc: { seq: 0 } })
    const payload = 'y'.repeat(3600)

    /* 预热 30 次 */
    for (let i = 0; i < 30; i++) {
      backend.appendJournal({ type: 'warm', seq: -1 - i, payload })
    }
    const started = performance.now()
    for (let i = 0; i < 400; i++) {
      store.journal({ type: 'push', seq: i, payload })
    }
    const appendMs = performance.now() - started

    /* 原子 state 写 */
    const writeStarted = performance.now()
    for (let i = 0; i < 150; i++) {
      backend.writeState({ seq: i, title: 'bench', payload })
    }
    const stateWriteMs = performance.now() - writeStarted

    let journalBytes = 0
    for (const name of ['journal.jsonl', 'journal.jsonl.1']) {
      try { journalBytes += fs.statSync(path.join(dir, name)).size } catch { /* 无文件 */ }
    }
    const rotated = fs.existsSync(path.join(dir, 'journal.jsonl.1'))

    const tailSamples = []
    for (let i = 0; i < 200; i++) {
      const t = performance.now()
      backend.journalTail(tailLimit)
      tailSamples.push(performance.now() - t)
    }
    const tail = backend.journalTail(tailLimit)
    const tailOk = tail.length > 0 && tail.length <= tailLimit

    /* checkpoint */
    backend.writeCheckpoint('cp-1', { seq: 399, title: 'bench' })
    const cpOk = backend.readCheckpoint('cp-1').seq === 399

    /* 崩溃恢复：重开 backend，state 与 journal 尾都必须可读。 */
    const reloaded = new FileStateBackend(file, { initialDoc: { seq: 0 }, journalMaxBytes })
    const state = reloaded.readState()
    const reloadedTail = reloaded.journalTail(tailLimit)
    const recoveryOk = state && Number.isInteger(state.seq) && reloadedTail.length > 0

    return {
      appendOpsPerSec: round2(400 / (appendMs / 1000)),
      stateWriteMs: round2(stateWriteMs),
      journalBytes,
      tailP95Ms: round2(percentile(tailSamples, 95)),
      stability: { rotated, tailOk, cpOk, recoveryOk, tailLen: tail.length },
    }
  } finally {
    rmRf(dir)
  }
}

export async function evaluateStateService(genome, tuningPatch) {
  const result = bench(tuningPatch.journalMaxBytes, tuningPatch.journalTailLimit)
  const { rotated, tailOk, cpOk, recoveryOk } = result.stability
  const stabilityFailures = (tailOk ? 0 : 1) + (cpOk ? 0 : 1) + (recoveryOk ? 0 : 1)
    + (rotated || tuningPatch.journalMaxBytes >= 400 * 3900 ? 0 : 1)

  return {
    ok: stabilityFailures === 0,
    objectives: {
      appendOpsPerSec: -result.appendOpsPerSec,
      stateWriteMs: result.stateWriteMs,
      tailP95Ms: result.tailP95Ms,
      journalBytes: result.journalBytes,
      recoveryFailures: stabilityFailures,
    },
    meta: { ...result.stability, appendOpsPerSec: result.appendOpsPerSec },
  }
}
