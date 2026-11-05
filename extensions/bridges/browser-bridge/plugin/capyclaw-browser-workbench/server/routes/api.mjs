/**
 * 工作台 API（/api/*）：可视化工作台的数据面。
 *
 * 与 MCP 工具同一引擎实例（动作互斥共用），但只暴露观察与轻控制：
 * 状态/实时画面/快照/标签页切换/导航/关闭。这里不做参数级校验的重活，
 * 引擎自己会拒绝坏输入并给结构化错误。
 */
import { readBody, send } from '../http-utils.mjs'

function sendEngineError(req, res, error) {
  const status = error?.code === 'ENGINE_LAUNCH_FAILED' ? 503 : 400
  send(req, res, status, {
    ok: false,
    error: { code: error?.code || 'INTERNAL', message: error?.message || String(error), hint: error?.hint || '' },
  })
}

export function createApiRoutes({ engine }) {
  return [
    /* GET /api/status —— 引擎状态 + 最近动作（工作台轮询数据源）。 */
    async (req, res, u) => {
      if (u.pathname !== '/api/status' || req.method !== 'GET') return false
      try {
        send(req, res, 200, { ok: true, status: engine.status(), actions: engine.actionLog().slice(0, 20) })
      } catch (error) {
        sendEngineError(req, res, error)
      }
      return true
    },

    /* GET /api/screenshot —— 当前活动标签页实时画面（PNG，不落盘）。 */
    async (req, res, u) => {
      if (u.pathname !== '/api/screenshot' || req.method !== 'GET') return false
      if (!engine.status().running) {
        send(req, res, 503, {
          ok: false,
          error: { code: 'ENGINE_NOT_RUNNING', message: '浏览器未启动', hint: 'POST /api/navigate 打开一个网址后会自动启动。' },
        })
        return true
      }
      try {
        const png = await engine.screenshotBuffer({})
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : png)
      } catch (error) {
        sendEngineError(req, res, error)
      }
      return true
    },

    /* GET /api/snapshot —— 当前页面元素快照（与 browser_snapshot 同源）。 */
    async (req, res, u) => {
      if (u.pathname !== '/api/snapshot' || req.method !== 'GET') return false
      try {
        const out = await engine.snapshot({})
        send(req, res, 200, { ok: true, ...out })
      } catch (error) {
        sendEngineError(req, res, error)
      }
      return true
    },

    /* POST /api/navigate { url } —— 工作台便捷导航（拉起浏览器）。 */
    async (req, res, u) => {
      if (u.pathname !== '/api/navigate' || req.method !== 'POST') return false
      try {
        const body = await readBody(req, 64 * 1024)
        const out = await engine.navigate({ url: String(body.url || '') })
        send(req, res, 200, { ok: true, tab: out.tab, url: out.url, title: out.title })
      } catch (error) {
        sendEngineError(req, res, error)
      }
      return true
    },

    /* POST /api/tabs { action, tab?, url? } —— 标签页切换/新建/关闭/列出。 */
    async (req, res, u) => {
      if (u.pathname !== '/api/tabs' || req.method !== 'POST') return false
      try {
        const body = await readBody(req, 64 * 1024)
        const out = await engine.tabsAction({ action: body.action || 'list', tab: body.tab, url: body.url })
        send(req, res, 200, { ok: true, ...out })
      } catch (error) {
        sendEngineError(req, res, error)
      }
      return true
    },

    /* POST /api/control { action: 'close' } —— 关闭浏览器（登录态持久化）。 */
    async (req, res, u) => {
      if (u.pathname !== '/api/control' || req.method !== 'POST') return false
      try {
        const body = await readBody(req, 64 * 1024)
        if (body.action !== 'close') {
          send(req, res, 400, { ok: false, error: { code: 'ARG_INVALID', message: `不支持 ${body.action}`, hint: '可用：close' } })
          return true
        }
        const out = await engine.close()
        send(req, res, 200, { ok: true, ...out })
      } catch (error) {
        sendEngineError(req, res, error)
      }
      return true
    },

    /* 未知 /api/* —— 列出可用接口。 */
    async (req, res, u) => {
      if (!u.pathname.startsWith('/api/')) return false
      send(req, res, 404, {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `未知接口 ${u.pathname}`,
          hint: '可用：GET /api/status、GET /api/screenshot、GET /api/snapshot、POST /api/navigate、POST /api/tabs、POST /api/control',
        },
      })
      return true
    },
  ]
}
