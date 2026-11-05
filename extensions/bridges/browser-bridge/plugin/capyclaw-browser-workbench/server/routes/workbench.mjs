/** 工作台静态页与内置演示页（白名单路由，杜绝路径穿越）。 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { DEMO_FILES, WORKBENCH_FILES } from '../constants.mjs'

export function createWorkbenchRoutes({ packageDir }) {
  const uiDir = path.join(packageDir, 'ui')
  const demoDir = path.join(packageDir, 'demo')
  return [
    async (req, res, u) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false
      const ui = WORKBENCH_FILES[u.pathname]
      const demo = DEMO_FILES[u.pathname]
      if (!ui && !demo) return false
      const file = ui ? path.join(uiDir, ui[0]) : path.join(demoDir, demo[0])
      const mime = (ui || demo)[1]
      try {
        const content = await readFile(file)
        res.writeHead(200, {
          'content-type': mime,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(req.method === 'HEAD' ? undefined : content)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Not found')
      }
      return true
    },
  ]
}
