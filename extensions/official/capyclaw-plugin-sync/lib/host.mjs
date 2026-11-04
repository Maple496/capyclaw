/**
 * 插件宿主半：把「清单 ↔ 实际」的比对与开关做成 dsh 内的服务 + HTTP 面。
 *
 * 边界：
 *   - 只管**当前 profile** 的插件集合（bundle / entry 两级开关）
 *   - 不碰 broker 服务、不启动/停止 dsh 进程（那是 dshd 的事）
 *   - 不自己实现开关，全部转发给 dsh 原生 pluginManager
 *
 * 配置（resolveConfig：ctx config → 环境变量 → 默认值）：
 *   sourceKind   清单源类型          DSH_SYNC_SOURCE      local（默认）
 *   sourcePath   本地清单路径        DSH_SYNC_PATH        （空）
 *   sourceUrl    HTTP 清单地址       DSH_SYNC_URL         （空，预留）
 *   enableHttp   是否挂 HTTP 路由     DSH_SYNC_HTTP        true
 *   syncToken    写操作的 token      DSH_SYNC_TOKEN       （空＝只校验回环）
 */
import { resolveConfig } from '@capyclaw/plugin-kit/config'

import { createSource } from './sources/index.mjs'
import { readActual, buildReport } from './report.mjs'
import { applyChanges } from './apply.mjs'
import { summarizeManifest } from './manifest.mjs'

export const name = '@capyclaw/plugin-sync'
export const inject = ['pluginManager', 'pluginInventory', 'webServer']

const ROUTE_REPORT = '/__plugin_sync__/report'
const ROUTE_APPLY = '/__plugin_sync__/apply'

function isLoopback(req) {
  const address = req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  })
  res.end(body)
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`请求体过大（>${limit} 字节）`)
    chunks.push(chunk)
  }
  if (!size) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx, config = {}) {
  const { value: cfg, issues } = resolveConfig(config, {
    envPrefix: 'DSH_SYNC',
    defaults: { sourceKind: 'local', sourcePath: '', sourceUrl: '', enableHttp: true, syncToken: '' },
    fields: {
      sourceKind: { env: 'SOURCE' },
      sourcePath: { env: 'PATH' },
      sourceUrl: { env: 'URL' },
      enableHttp: { env: 'HTTP', type: 'boolean' },
      syncToken: { env: 'TOKEN' },
    },
  })
  for (const issue of issues) ctx.logger?.warn?.(`[plugin-sync] 配置: ${issue}`)

  const source = createSource({ kind: cfg.sourceKind, file: cfg.sourcePath, url: cfg.sourceUrl })

  async function report({ versionProbe } = {}) {
    const desired = await source.describe()
    const actual = await readActual({ manager: ctx.pluginManager })
    return buildReport({ source, desired, actual, versionProbe })
  }

  async function applyChangesFromManifest({ changes, stopOnFailure = false } = {}) {
    return applyChanges({ changes, manager: ctx.pluginManager, stopOnFailure })
  }

  /** 服务：别的插件（含将来的 launchpad UI）可以直接 inject: ['pluginSync'] 使用。 */
  ctx.provide('pluginSync', {
    sourceId: source.id,
    summary: async () => summarizeManifest(await source.describe()),
    report,
    apply: applyChangesFromManifest,
  })

  if (!cfg.enableHttp) {
    ctx.logger?.info?.('[plugin-sync] 已按配置关闭 HTTP 路由')
    return
  }

  const guard = (req) => {
    if (!isLoopback(req)) return '仅允许回环访问'
    if (cfg.syncToken) {
      const header = req.headers['x-sync-token']
      if (header !== cfg.syncToken) return '缺少或错误的 x-sync-token'
    }
    return null
  }

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_REPORT,
      handler: async (req, res) => {
        const denied = guard(req)
        if (denied) return sendJson(res, 403, { ok: false, error: denied })
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只用 GET' })
        try {
          sendJson(res, 200, { ok: true, report: await report() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: { code: error.code || 'ERROR', message: error.message } })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_APPLY,
      handler: async (req, res) => {
        const denied = guard(req)
        if (denied) return sendJson(res, 403, { ok: false, error: denied })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只用 POST' })
        try {
          const body = await readJsonBody(req)
          const result = await applyChangesFromManifest({
            changes: body?.changes,
            stopOnFailure: body?.stopOnFailure === true,
          })
          sendJson(res, result.ok ? 200 : 409, result)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: error.code || 'ERROR', message: error.message } })
        }
      },
    }),
  ]

  ctx.logger?.info?.(
    `[plugin-sync] 就绪：source=${source.id} report=${ROUTE_REPORT} apply=${ROUTE_APPLY}`,
  )

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 已移除 */ }
    }
  }
}
