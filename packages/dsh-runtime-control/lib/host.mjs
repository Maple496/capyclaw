/**
 * dsh-runtime-control：控制面插件。
 *
 * 提供 ctx.runtimeControl 服务，并可选启动一个 loopback HTTP 控制端点，
 * 用于管理 worker runtime。它自己不应作为 worker runtime 被管理。
 */
import http from 'node:http'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { readBody, send } from '../../dsh-plugin-kit/src/service/http.mjs'
import {
  createRuntime, defaultRuntimeStoreRoot, doctorRuntime, gcRuntimes,
  listRuntimes, readRuntime, removeRuntime, runtimePublicInfo,
  startRuntime, stopRuntime,
} from '../../dsh-suite-kit/src/runtime.mjs'
import {
  parseWorksContent, parseWorksFile, validateWorksDeployment, validateWorksFormat,
} from '../../dsh-suite-kit/lib/works-parser.mjs'
import { runtimeContextFromConfig } from '../../dsh-plugin-kit/src/runtime/context.mjs'

export const name = 'runtime-control'

/* HTTP 传输复用 dsh-plugin-kit 基础设施：readBody（上限/BAD_JSON/断连兜底）、
 * send（安全响应头 + HEAD + 死 socket 防护）——不再手写。 */
const jsonBody = (req) => readBody(req, 1024 * 1024)

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** .works → domain 输入：解析 + 双层校验（META 格式 / CODE 部署语义）→
 *  把 deployment.source 解析为绝对路径交给 createRuntime（runtime/workId 覆盖项透传）。 */
function worksToDomainInput({ worksFile, worksInput } = {}) {
  let meta, code, baseDir
  if (worksFile) {
    const abs = resolve(worksFile)
    if (!existsSync(abs)) throw httpError(400, `.works 文件不存在: ${abs}`)
    ;({ meta, code } = parseWorksFile(abs))
    baseDir = dirname(abs)
  } else if (typeof worksInput === 'string' && worksInput) {
    ;({ meta, code } = parseWorksContent(worksInput))
    baseDir = process.cwd()
  } else {
    throw httpError(400, 'create 需要 domainInput、worksFile 或 worksInput 之一')
  }
  if (meta.view?.kind !== 'deployment') {
    throw httpError(400, `作品类型错误: 期望 'deployment'，实际 '${meta.view?.kind}'`)
  }
  const format = validateWorksFormat(meta, code)
  if (!format.valid) throw httpError(400, `.works 格式校验失败:\n- ${format.errors.join('\n- ')}`)
  const deep = validateWorksDeployment(code)
  if (!deep.valid) throw httpError(400, `.works 部署语义校验失败:\n- ${deep.errors.join('\n- ')}`)
  const source = resolve(baseDir, code.deployment.source)
  if (!existsSync(source)) throw httpError(400, `deployment.source 不存在: ${source}`)
  return { domainInput: source, workId: code.runtime?.workId, model: code.runtime?.model }
}

export function apply(ctx, config = {}) {
  const storeRoot = config.storeRoot || defaultRuntimeStoreRoot()
  const ownRuntime = runtimeContextFromConfig(config || {})
  const port = Number(config.port) || ownRuntime?.ports?.content || 0

  const publicRuntime = (runtime) => runtimePublicInfo(runtime)
  const service = {
    api: {
      name: 'runtimeControl',
      version: '1.0.0',
      capabilities: ['create', 'start', 'stop', 'doctor', 'remove', 'gc'],
    },
    storeRoot,
    list: () => listRuntimes(storeRoot).map(publicRuntime),
    show: (runtimeId) => publicRuntime(readRuntime(storeRoot, runtimeId)),
    async create(options = {}) {
      let domainInput = options.domainInput || options.domain
      let extra = {}
      if (!domainInput && (options.worksFile || options.worksInput)) {
        // .works 线：解析+校验后转成 domain 输入（与 dsh-deploy 同一必填口径）
        const converted = worksToDomainInput(options)
        domainInput = converted.domainInput
        if (converted.workId !== undefined) extra.workId = converted.workId
        if (converted.model !== undefined) extra.model = converted.model
      }
      const runtime = await createRuntime({
        ...options,
        ...extra,
        domainInput,
        storeRoot,
      })
      return publicRuntime(runtime)
    },
    async start(runtimeId, options = {}) {
      const result = await startRuntime({ ...options, storeRoot, runtimeId })
      return { ...publicRuntime(result.runtime), ready: result.ready, alreadyRunning: result.alreadyRunning }
    },
    async stop(runtimeId) {
      const runtime = await stopRuntime({ storeRoot, runtimeId })
      return publicRuntime(runtime)
    },
    async doctor(runtimeId) {
      return doctorRuntime({ storeRoot, runtimeId })
    },
    async remove(runtimeId, options = {}) {
      return removeRuntime({ storeRoot, runtimeId, ...options })
    },
    async gc(options = {}) {
      return gcRuntimes({ storeRoot, ...options })
    },
  }

  let server = null
  if (port > 0) {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      try {
        if (url.pathname === '/healthz') {
          return send(req, res, 200, { ok: true, service: 'runtime-control', pid: process.pid, storeRoot })
        }
        if (url.pathname === '/control/list' && req.method === 'GET') {
          return send(req, res, 200, { ok: true, runtimes: service.list() })
        }
        if (url.pathname === '/control/services' && req.method === 'GET') {
          const has = (name) => { try { return !!ctx.get?.(name) } catch { return false } }
          return send(req, res, 200, {
            ok: true,
            runtimeControl: true,
            catalog: has('catalog'),
            installer: has('installer'),
          })
        }
        if (url.pathname === '/control/show' && req.method === 'GET') {
          return send(req, res, 200, { ok: true, runtime: service.show(url.searchParams.get('runtimeId')) })
        }
        if (url.pathname === '/control/doctor' && req.method === 'GET') {
          return send(req, res, 200, await service.doctor(url.searchParams.get('runtimeId')))
        }
        if (url.pathname === '/control/resolve' && req.method === 'GET') {
          const installer = ctx.get?.('installer')
          const domain = url.searchParams.get('domain')
          if (!installer?.resolve || !domain) return send(req, res, 400, { ok: false, error: 'domain required or installer unavailable' })
          return send(req, res, 200, { ok: true, resolved: installer.resolve(domain) })
        }
        if (url.pathname === '/control/catalog' && req.method === 'GET') {
          const catalog = ctx.get?.('catalog')
          if (!catalog?.refresh) return send(req, res, 503, { ok: false, error: 'catalog service unavailable' })
          return send(req, res, 200, { ok: true, works: catalog.refresh(url.searchParams.get('runtimeId') || '') })
        }
        if (req.method === 'POST') {
          const body = await jsonBody(req)
          if (url.pathname === '/control/create') return send(req, res, 200, { ok: true, runtime: await service.create(body) })
          if (url.pathname === '/control/start') return send(req, res, 200, { ok: true, runtime: await service.start(body.runtimeId, body.options || {}) })
          if (url.pathname === '/control/stop') return send(req, res, 200, { ok: true, runtime: await service.stop(body.runtimeId) })
          if (url.pathname === '/control/remove') return send(req, res, 200, { ok: true, ...(await service.remove(body.runtimeId, body.options || {})) })
          if (url.pathname === '/control/gc') return send(req, res, 200, { ok: true, ...(await service.gc(body)) })
        }
        return send(req, res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        const status = Number(error.status) || 500
        return send(req, res, status, { ok: false, error: String(error.message || error) })
      }
    })
    server.listen(port, '127.0.0.1', () => {
      console.log(`[runtime-control] http://127.0.0.1:${port}/ store=${storeRoot}`)
    })
  }

  const dispose = ctx.provide('runtimeControl', service)
  return () => {
    if (typeof dispose === 'function') dispose()
    if (server) server.close()
  }
}
