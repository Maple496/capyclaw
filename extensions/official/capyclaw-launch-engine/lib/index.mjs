/**
 * dsh-launch-engine 宿主：按需激活引擎（组合根）。
 *
 * 「容器注入」的落地形态：本插件不 new 任何服务对象，它把「插件定义」
 * 注入运行中的 Cordis 树——bundle/entry 开关全部转发 @capyclaw/plugin-sync
 * （其内部再转发 dsh 原生 pluginManager），服务进程全部转发 serviceBroker；
 * 装配由 Cordis DI 完成。激活证据只认 pluginManager.listPlugins() 的
 * `enabled && fiberPhase === 'active'`。
 *
 * 边界（阶段一）：
 *   - 只管「已安装包」的按需激活/停用；缺包安装（installer）与
 *     配置行注入（stack-kit patch-block）是阶段二
 *   - 不碰进程生命周期（起停 dsh/broker 是 dshd 的事，见 tools/dsh-launcher）
 *
 * 配置（resolveConfig：ctx config → 环境变量 → 默认值）：
 *   registryKind      注册表源类型        DSH_LE_REGISTRY       inline
 *                     （inline | local | profile | http；domain 型 profile 推荐
 *                      profile——注册表由 suite-kit 从 dsh-suite.json 自动生成）
 *   registryPath      local/profile 源文件路径  DSH_LE_PATH     （空＝按源类型推导）
 *   registryUrl       HTTP 源地址（预留）  DSH_LE_URL            （空）
 *   enableHttp        是否挂 HTTP 路由    DSH_LE_HTTP           true
 *   engineToken       写操作 token        DSH_LE_TOKEN          （空＝只校验回环）
 *   verifyTimeoutMs   每波验证超时        DSH_LE_VERIFY_TIMEOUT 60000
 *   pollMs            验证轮询间隔        DSH_LE_POLL_MS        500
 *   capabilities      inline 注册表对象（结构化，不走 env；建议由
 *                     stack.plugins.configs 注入，不写死在 patch 里）
 */
import { existsSync } from 'node:fs'
import { resolveConfig } from '@capyclaw/plugin-kit/config'

import { createProfileRegistry, createRegistry, RegistryError } from './registry.mjs'
import { planActivation, planDeactivation } from './planner.mjs'
import { executePlan } from './executor.mjs'

export const name = '@capyclaw/launch-engine'
export const inject = ['pluginManager', 'webServer', 'pluginSync']

const ROUTE_CAPABILITIES = '/__launch_engine__/capabilities'
const ROUTE_STATUS = '/__launch_engine__/status'
const ROUTE_RESOLVE = '/__launch_engine__/resolve'
const ROUTE_ACTIVATE = '/__launch_engine__/activate'
const ROUTE_DEACTIVATE = '/__launch_engine__/deactivate'

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
    envPrefix: 'DSH_LE',
    defaults: {
      registryKind: 'inline', registryPath: '', registryUrl: '',
      enableHttp: true, engineToken: '', verifyTimeoutMs: 60000, pollMs: 500,
    },
    fields: {
      registryKind: { env: 'REGISTRY' },
      registryPath: { env: 'PATH' },
      registryUrl: { env: 'URL' },
      enableHttp: { env: 'HTTP', type: 'boolean' },
      engineToken: { env: 'TOKEN' },
      verifyTimeoutMs: { env: 'VERIFY_TIMEOUT', type: 'number' },
      pollMs: { env: 'POLL_MS', type: 'number' },
    },
  })
  for (const issue of issues) ctx.logger?.warn?.(`[launch-engine] 配置: ${issue}`)

  let registry
  if (cfg.registryKind === 'profile') {
    /* suite 域注册表：suite-kit 安装期生成的 <profile>/launch-engine.registry.json。
     * 缺席时诚实告警并回退 inline（stack 型 profile 没有这份文件），不让宿主起不来。 */
    const profileRegistry = createProfileRegistry({ file: cfg.registryPath || undefined })
    if (existsSync(profileRegistry.file)) {
      registry = profileRegistry
    } else {
      ctx.logger?.warn?.(`[launch-engine] profile 注册表不存在: ${profileRegistry.file}（回退 inline；stack 型 profile 请显式用 inline/local 源）`)
      registry = createRegistry({ kind: 'inline', capabilities: config.capabilities })
    }
  } else {
    registry = createRegistry({
      kind: cfg.registryKind,
      file: cfg.registryPath,
      url: cfg.registryUrl,
      capabilities: config.capabilities,
    })
  }

  // 热路径局部变量（仓库性能约定：不反复读 ctx.x）
  const pluginSync = ctx.pluginSync
  const manager = ctx.pluginManager
  const getBroker = () => {
    try { return ctx.serviceBroker || null } catch { return null }
  }

  async function resolve(name) {
    const reg = await registry.describe()
    return planActivation(reg, String(name))
  }

  async function activate(name, { verify = true, force = false, timeoutMs, pollMs } = {}) {
    const reg = await registry.describe()
    const plan = planActivation(reg, String(name))
    return executePlan({ plan, pluginSync, getBroker, manager }, {
      verify, force,
      verifyTimeoutMs: timeoutMs ?? cfg.verifyTimeoutMs,
      pollMs: pollMs ?? cfg.pollMs,
    })
  }

  async function deactivate(name, { verify = true, force = false, timeoutMs, pollMs } = {}) {
    const reg = await registry.describe()
    const plan = planDeactivation(reg, String(name))
    return executePlan({ plan, pluginSync, getBroker, manager }, {
      verify, force,
      verifyTimeoutMs: timeoutMs ?? cfg.verifyTimeoutMs,
      pollMs: pollMs ?? cfg.pollMs,
    })
  }

  /** 只读快照：逐 capability 比对注册表声明 × 实际状态。 */
  async function status() {
    const reg = await registry.describe()
    const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()])
    const bundleState = new Map(bundles.map((b) => [b.name, b]))
    const entryState = new Map(plugins.map((p) => [p.entryId, p]))
    const capabilities = []
    for (const spec of Object.values(reg.capabilities)) {
      const bundleRows = spec.bundles.map((b) => {
        const actual = bundleState.get(b.name)
        return {
          name: b.name, desired: b.enabled,
          installed: Boolean(actual?.installed ?? actual),
          enabled: actual ? actual.enabled === true : null,
        }
      })
      const entryRows = spec.entries.map((e) => {
        const actual = entryState.get(e.entryId)
        return {
          entryId: e.entryId, desired: e.enabled,
          enabled: actual ? actual.enabled === true : null,
          fiberPhase: actual?.fiberPhase ?? null,
          active: actual?.enabled === true && actual?.fiberPhase === 'active',
        }
      })
      capabilities.push({
        name: spec.name,
        title: spec.title,
        requires: spec.requires,
        bundles: bundleRows,
        entries: entryRows,
        services: spec.services.map((s) => ({ id: s.id })),
        satisfied: bundleRows.every((b) => b.enabled === b.desired) && entryRows.every((e) => e.active === e.desired),
      })
    }
    return capabilities
  }

  /** 服务面：其他插件可以直接 inject: ['launchEngine'] 使用。 */
  const service = {
    registryId: registry.id,
    capabilities: async () => {
      const reg = await registry.describe()
      return Object.values(reg.capabilities).map((spec) => ({
        name: spec.name, title: spec.title, requires: spec.requires,
        bundles: spec.bundles.length, entries: spec.entries.length, services: spec.services.length,
      }))
    },
    resolve,
    activate,
    deactivate,
    status,
  }
  ctx.provide('launchEngine', service)

  if (!cfg.enableHttp) {
    ctx.logger?.info?.('[launch-engine] 已按配置关闭 HTTP 路由')
    return
  }

  const guard = (req) => {
    if (!isLoopback(req)) return '仅允许回环访问'
    if (cfg.engineToken) {
      const header = req.headers['x-launch-token']
      if (header !== cfg.engineToken) return '缺少或错误的 x-launch-token'
    }
    return null
  }

  const run = async (res, fn) => {
    try {
      sendJson(res, 200, { ok: true, ...(await fn()) })
    } catch (error) {
      if (error instanceof RegistryError) {
        sendJson(res, error.code === 'UNKNOWN_CAPABILITY' ? 404 : 400, { ok: false, error: { code: error.code, message: error.message } })
      } else {
        sendJson(res, 500, { ok: false, error: { code: error.code || 'ERROR', message: error.message } })
      }
    }
  }

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_CAPABILITIES,
      handler: async (req, res) => {
        const denied = guard(req)
        if (denied) return sendJson(res, 403, { ok: false, error: denied })
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只用 GET' })
        await run(res, async () => ({ registry: registry.id, capabilities: await service.capabilities() }))
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_STATUS,
      handler: async (req, res) => {
        const denied = guard(req)
        if (denied) return sendJson(res, 403, { ok: false, error: denied })
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只用 GET' })
        await run(res, async () => ({ capabilities: await status() }))
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_RESOLVE,
      handler: async (req, res) => {
        const denied = guard(req)
        if (denied) return sendJson(res, 403, { ok: false, error: denied })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只用 POST' })
        try {
          const body = await readJsonBody(req)
          if (!body?.capability) throw new RegistryError('缺少 capability 字段', 'INVALID_REQUEST')
          await run(res, async () => ({ plan: await resolve(body.capability) }))
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: error.code || 'BAD_REQUEST', message: error.message } })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_ACTIVATE,
      handler: async (req, res) => {
        const denied = guard(req)
        if (denied) return sendJson(res, 403, { ok: false, error: denied })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只用 POST' })
        try {
          const body = await readJsonBody(req)
          if (!body?.capability) throw new RegistryError('缺少 capability 字段', 'INVALID_REQUEST')
          await run(res, async () => ({
            result: await activate(body.capability, {
              verify: body.verify !== false,
              force: body.force === true,
              timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
            }),
          }))
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: error.code || 'BAD_REQUEST', message: error.message } })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_DEACTIVATE,
      handler: async (req, res) => {
        const denied = guard(req)
        if (denied) return sendJson(res, 403, { ok: false, error: denied })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只用 POST' })
        try {
          const body = await readJsonBody(req)
          if (!body?.capability) throw new RegistryError('缺少 capability 字段', 'INVALID_REQUEST')
          await run(res, async () => ({
            result: await deactivate(body.capability, {
              verify: body.verify !== false,
              force: body.force === true,
              timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
            }),
          }))
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: error.code || 'BAD_REQUEST', message: error.message } })
        }
      },
    }),
  ]

  ctx.logger?.info?.(
    `[launch-engine] 就绪：registry=${registry.id} capabilities=${ROUTE_CAPABILITIES} status=${ROUTE_STATUS} resolve=${ROUTE_RESOLVE} activate=${ROUTE_ACTIVATE} deactivate=${ROUTE_DEACTIVATE}`,
  )

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 已移除 */ }
    }
  }
}

export { RegistryError }
