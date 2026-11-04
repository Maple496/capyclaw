/** 兼容层：长轮询的通用实现位于 dsh-document-workbench/session。 */
import { watchSession } from 'dsh-document-workbench/session'
import { getTuning } from '../tuning.mjs'

export function watchDoc(store, seq0, shot0, ui0, timeoutS, aborted) {
  const tuning = getTuning()
  return watchSession(store, {
    seq: seq0,
    shot: shot0,
    ui: ui0,
    timeoutS,
    isAborted: aborted,
    pollMs: tuning.watchPollMs,
    timeoutSec: tuning.watchTimeoutSec,
    maxTimeoutSec: tuning.watchTimeoutMaxSec,
  })
}
