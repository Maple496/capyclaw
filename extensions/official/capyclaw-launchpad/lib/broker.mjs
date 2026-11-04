/**
 * broker 控制端点客户端。
 *
 * 只发结构化命令（up/stop），不 spawn、不 kill——真正拉起/回收进程的是
 * dsh-service-broker（服务解耦标准：清单只产生命令，中间件执行）。
 */

import { maskEnv } from './parse.mjs'

const DEFAULT_TIMEOUT_MS = 8000

function normalizeUrl(raw) {
  if (!raw) return ''
  let value = String(raw).trim()
  if (!value) return ''
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  return value.replace(/\/+$/, '')
}

/** 优先级：--broker-url > LAUNCHPAD_BROKER_URL > DSH_BROKER_URL > launcher state > DSH_BROKER_PORT。 */
export function resolveBrokerUrl(options = {}) {
  const env = options.env || process.env
  let value = options.flag || env.LAUNCHPAD_BROKER_URL || env.DSH_BROKER_URL || ''
  if (!value) {
    for (const launcher of options.launchers || []) {
      const state = launcher?.launcher?.state
      if (state?.broker?.url) {
        value = state.broker.url
        break
      }
    }
  }
  if (!value && env.DSH_BROKER_PORT) value = `http://127.0.0.1:${env.DSH_BROKER_PORT}`
  return normalizeUrl(value)
}

export function resolveBrokerToken(options = {}) {
  const env = options.env || process.env
  return options.flag || env.LAUNCHPAD_BROKER_TOKEN || env.DSH_BROKER_TOKEN || ''
}

function errorText(data) {
  if (!data) return ''
  if (typeof data.error === 'string') return data.error
  if (data.error && typeof data.error.message === 'string') return data.error.message
  if (typeof data.message === 'string') return data.message
  return ''
}

/**
 * 调用 broker 控制端点。
 * 207（partial success）不抛错：返回 body 让上层如实展示哪些失败。
 */
export async function brokerRequest(options = {}) {
  const url = normalizeUrl(options.url)
  if (!url) {
    const error = new Error('未找到 broker 控制端点（设置 --broker-url / DSH_BROKER_URL，或先运行 dshd）')
    error.code = 'BROKER_URL_MISSING'
    throw error
  }
  const method = options.method || 'GET'
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token) headers['x-broker-token'] = options.token

  let res
  try {
    res = await fetch(url + options.path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error(`broker 请求超时（${timeoutMs}ms）: ${method} ${options.path}`)
      timeout.code = 'BROKER_TIMEOUT'
      throw timeout
    }
    const wrapped = new Error(`broker 不可达: ${url}: ${error.message}`)
    wrapped.code = 'BROKER_UNREACHABLE'
    throw wrapped
  } finally {
    clearTimeout(timer)
  }

  let text = ''
  try { text = await res.text() } catch { text = '' }
  let data = {}
  if (text) {
    try { data = JSON.parse(text) } catch { data = { raw: text } }
  }

  if (res.status === 207) {
    return { ...data, ok: false, httpStatus: 207 }
  }
  if (!res.ok) {
    const detail = errorText(data)
    const error = new Error(`broker ${method} ${options.path} → ${res.status}${detail ? `: ${detail}` : ''}`)
    error.code = 'BROKER_HTTP_ERROR'
    error.status = res.status
    error.body = data
    throw error
  }
  return { ...data, httpStatus: res.status }
}

export async function brokerList(options = {}) {
  const data = await brokerRequest({ ...options, path: '/control/list' })
  let services = data.services
  if (!Array.isArray(services)) {
    if (services && typeof services === 'object') services = Object.values(services)
    else services = []
  }
  return { ...data, services }
}

export async function brokerApply(options = {}) {
  const body = { commands: options.commands || [] }
  if (options.waitMs != null) body.waitMs = options.waitMs
  return brokerRequest({ ...options, path: '/control/apply', method: 'POST', body })
}

export async function brokerStart(options = {}) {
  const body = options.service ? { service: options.service } : { id: options.id }
  if (options.waitMs != null) body.waitMs = options.waitMs
  return brokerRequest({ ...options, path: '/control/start', method: 'POST', body })
}

export async function brokerStop(options = {}) {
  return brokerRequest({ ...options, path: '/control/stop', method: 'POST', body: { id: options.id } })
}

export async function brokerDoctor(options = {}) {
  const query = options.id ? `?id=${encodeURIComponent(options.id)}` : ''
  return brokerRequest({ ...options, path: `/control/doctor${query}` })
}

/** 取服务的可执行 spec（PACKAGE_DIR 已展开，PORT 占位符原样留给 broker）。 */
export function actionSpecOf(service) {
  const spec = service?._actionSpec
  if (!spec) {
    const error = new Error(`服务 ${service?.serviceId || '?'} 缺少可执行 spec（可能来自脱敏后的 JSON）`)
    error.code = 'ACTION_SPEC_MISSING'
    throw error
  }
  return spec
}

export function toUpCommand(service) {
  const spec = actionSpecOf(service)
  const out = { op: 'up', service: spec }
  return out
}

/** 回显/日志用的命令副本：env 脱敏，真实请求仍用 toUpCommand 的原 spec。 */
export function maskUpCommand(command) {
  if (!command?.service) return command
  return {
    ...command,
    service: { ...command.service, env: maskEnv(command.service.env) },
  }
}

export function maskCommands(commands) {
  return (commands || []).map(maskUpCommand)
}

export function buildApplyCommands(manifest) {
  if (manifest?.type !== 'broker') {
    const error = new Error(`只有 broker 清单能 apply（当前: ${manifest?.type || '?'}）`)
    error.code = 'NOT_BROKER_MANIFEST'
    throw error
  }
  return (manifest.services || []).map((service) => toUpCommand(service))
}
