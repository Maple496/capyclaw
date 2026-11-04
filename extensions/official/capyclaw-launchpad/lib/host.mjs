/**
 * DSH 进程内唯一职责：启动时做一次只读清单体检。
 *
 * 不监听端口、不写文件、不 spawn、不提供进程内服务对象。
 * 完整 API/启停能力在独立服务 server.mjs（由 broker 拉起）。
 */
import { scanAndAnalyze } from './index.mjs'
import { loadDiscovery, probeHealth, resolveDiscoveryPath } from './status.mjs'

export const name = '@capyclaw/launchpad'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从 config/env/discovery 解析 launchpad 管理界面的 URL；服务未就绪返回 ''。 */
async function resolveLaunchpadUrl(config = {}) {
  const explicit = config.url || process.env.DSH_LAUNCHPAD_URL
  if (explicit) {
    const url = String(explicit)
    return url.endsWith('/') ? url : `${url}/`
  }
  const serviceId = config.service || 'launchpad'
  const resolved = resolveDiscoveryPath({ dshHome: config.dshHome })
  const discovery = await loadDiscovery(resolved.file)
  const row = discovery.data?.services?.[serviceId]
  if (!row || row.state !== 'running' || typeof row.url !== 'string' || !row.url) return ''
  const url = row.url.endsWith('/') ? row.url : `${row.url}/`
  for (let i = 0; i < 3; i += 1) {
    const health = await probeHealth(url, '/healthz', 1500)
    if (health.ok) return url
    if (i < 2) await sleep(300)
  }
  return ''
}

export async function apply(ctx, config = {}) {
  const startedAt = Date.now()
  try {
    const { inventory } = await scanAndAnalyze({
      roots: config.roots,
      dshHome: config.dshHome,
      includeProfiles: config.includeProfiles !== false,
    })
    const { errors, warnings, manifests: manifestCount, services: serviceCount } = inventory.summary
    const line = `[dsh-launchpad] 启动清单体检：${errors} errors / ${warnings} warnings`
      + `（${manifestCount} 份清单，${serviceCount} 条服务，${Date.now() - startedAt}ms）`
    if (errors > 0) console.error(line)
    else console.log(line)

    const top = inventory.issues.filter((issue) => issue.severity === 'error').slice(0, 5)
    for (const issue of top) {
      console.error(`[dsh-launchpad] ✗ [${issue.code}] ${issue.message}`)
    }
    if (errors > 5) console.error(`[dsh-launchpad] … 还有 ${errors - 5} 个 error，运行 launchpad scan 查看`)

    if (config.strict && errors > 0) {
      const error = new Error(`启动清单有 ${errors} 个 error（dsh-launchpad strict 模式）`)
      error.code = 'LAUNCHPAD_STRICT'
      throw error
    }
  } catch (error) {
    console.error(`[dsh-launchpad] 启动体检失败: ${error.message}`)
    if (config.strict) throw error
  }

  // 纯 UI 注入：把管理界面 URL 推给页面；不监听端口、不拉服务。
  if (ctx && typeof ctx.on === 'function' && config.ui !== false) {
    try {
      const url = await resolveLaunchpadUrl(config)
      if (url) {
        ctx.on('webserver/index-inject', (table) => {
          table.push({ kind: 'global', name: '__DSH_LAUNCHPAD__', value: { url } })
        })
        console.log(`[dsh-launchpad] 管理界面已注入: ${url}`)
      } else {
        console.warn('[dsh-launchpad] 未找到运行中的 launchpad 服务，跳过管理界面注入')
      }
    } catch (error) {
      console.warn(`[dsh-launchpad] 管理界面注入失败: ${error.message}`)
    }
  }
  return async () => {}
}
