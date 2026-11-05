/**
 * 轻量视图路由：summary / text / outline 在 relay 侧从镜像直接投影，
 * 只回传小结果——读路径不拉全量镜像（大文档 + 内嵌图片时相差数量级）。
 * 投影按镜像引用 memo：编辑器 /state 每次整体替换引用，引用不变即复用。
 */
import { send } from '../http-utils.mjs'
import { summarize, textOf, outlineOf, wordCountOf, memoByDoc } from '../../core/doc.js'

export function createViewRoutes({ store, basePath }) {
  const project = memoByDoc((doc) => ({
    text: { text: textOf(doc), words: wordCountOf(doc) },
    outline: outlineOf(doc),
    summary: { summary: summarize(doc), words: wordCountOf(doc) },
  }))
  return [
    async (req, res, u) => {
      if (u.pathname !== `${basePath}/view` && u.pathname !== '/api/view') return false
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(req, res, 405, { error: 'method not allowed' })
        return true
      }
      const mode = u.searchParams.get('mode') || 'summary'
      const session = store.get()
      if (mode !== 'text' && mode !== 'outline' && mode !== 'summary') {
        send(req, res, 400, { error: `未知 mode：${mode}` })
        return true
      }
      const p = project(session.doc || { header: [], main: [], footer: [] })
      let body
      if (mode === 'text') body = { mode, text: p.text.text, words: p.text.words }
      else if (mode === 'outline') body = { mode, outline: p.outline }
      else body = { mode, summary: p.summary.summary, words: p.summary.words }
      body.seq = session.seq | 0
      body.state_seq = session.state_seq | 0
      send(req, res, 200, body)
    },
  ]
}
