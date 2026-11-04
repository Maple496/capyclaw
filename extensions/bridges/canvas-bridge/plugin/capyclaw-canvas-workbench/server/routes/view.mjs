/**
 * 轻量视图路由：summary / text / outline 在 relay 侧从镜像直接投影，
 * 只回传小结果——读路径不拉全量镜像（大文档 + 内嵌图片时相差数量级）。
 */
import { send } from '../http-utils.mjs'
import { summarize, textOf, outlineOf, wordCountOf } from '../../core/doc.js'

export function createViewRoutes({ store, basePath }) {
  return [
    async (req, res, u) => {
      if (u.pathname !== `${basePath}/view` && u.pathname !== '/api/view') return false
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(req, res, 405, { error: 'method not allowed' })
        return true
      }
      const mode = u.searchParams.get('mode') || 'summary'
      const doc = store.get().doc || { header: [], main: [], footer: [] }
      let body
      if (mode === 'text') {
        body = { mode, text: textOf(doc), words: wordCountOf(doc) }
      } else if (mode === 'outline') {
        body = { mode, outline: outlineOf(doc) }
      } else if (mode === 'summary') {
        body = { mode, summary: summarize(doc), words: wordCountOf(doc) }
      } else {
        send(req, res, 400, { error: `未知 mode：${mode}` })
        return true
      }
      body.seq = store.get().seq | 0
      body.state_seq = store.get().state_seq | 0
      send(req, res, 200, body)
      return true
    },
  ]
}
