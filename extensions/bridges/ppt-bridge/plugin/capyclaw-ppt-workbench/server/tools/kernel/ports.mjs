/**
 * 内核端口：能力模块唯一允许接触的 I/O 面。
 * 每个端口对应一类职责，能力按 requires 声明，registry 负责注入。
 */
import {
  BASE, get, getDeckOnly, getImportResult, getShot, getStatus, post, push, putAsset,
  requireEditor, summarize, uploadImport,
} from '../../bridge-client.mjs'

export function createKernelPorts() {
  return {
    deck: {
      read: getDeckOnly,
      write: push,
      summarize,
    },
    status: {
      get: getStatus,
      baseUrl: BASE,
    },
    editor: {
      require: requireEditor,
      getShot,
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
    importer: {
      upload: uploadImport,
      result: getImportResult,
    },
  }
}

export const KERNEL_PORT_NAMES = Object.freeze(['deck', 'status', 'editor', 'assets', 'task', 'importer', 'contract'])
