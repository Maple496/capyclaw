/**
 * 内核端口：能力模块唯一允许接触的 I/O 面。
 * 每个端口对应一类职责，能力按 requires 声明，registry 负责注入。
 */
import {
  baseUrl, get, getDocOnly, getShot, getStatus, getView, post, push, putAsset, requireEditor, waitForShot,
} from '../../bridge-client.mjs'
import { summarize, textOf, outlineOf, wordCountOf, findInDoc } from '../../../core/doc.js'

export function createKernelPorts() {
  return {
    doc: {
      read: getDocOnly,
      view: getView,
      write: push,
      summarize,
      textOf,
      outlineOf,
      wordCountOf,
      findInDoc,
    },
    status: {
      get: getStatus,
      baseUrl,
    },
    editor: {
      require: requireEditor,
      getShot,
      waitForShot,
      requestShot: () => post('/shot-request', {}),
    },
    assets: {
      put: putAsset,
    },
    task: {
      status: () => get('/task/status'),
      list: () => get('/task/checkpoints'),
      checkpoint: (name, meta) => post('/task/checkpoint', { name, meta: meta || {} }),
      read: (name) => get('/task/checkpoint?name=' + encodeURIComponent(name)),
    },
  }
}

export const KERNEL_PORT_NAMES = Object.freeze(['doc', 'status', 'editor', 'assets', 'task', 'contract'])
