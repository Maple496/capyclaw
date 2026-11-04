/**
 * dsh-launchpad 公共 API：CLI 与 HTTP 服务共用同一套纯函数。
 */
import { scan } from './scan.mjs'
import { analyze, resolveManifestRef, resolveServiceRef } from './analyze.mjs'
import { buildStatus } from './status.mjs'
import {
  brokerApply,
  brokerStop,
  buildApplyCommands,
  maskCommands,
  maskUpCommand,
  resolveBrokerToken,
  resolveBrokerUrl,
  toUpCommand,
} from './broker.mjs'

export * from './parse.mjs'
export * from './scan.mjs'
export * from './analyze.mjs'
export * from './status.mjs'
export * from './broker.mjs'

export async function scanAndAnalyze(options = {}) {
  const scanResult = await scan(options)
  return { scan: scanResult, inventory: analyze(scanResult) }
}

export function resolveBrokerContext(inventory, options = {}) {
  return {
    url: resolveBrokerUrl({
      flag: options.brokerUrl,
      env: options.env,
      launchers: inventory?.launchers || [],
    }),
    token: resolveBrokerToken({
      flag: options.brokerToken,
      env: options.env,
    }),
  }
}

function actionError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

export async function startService(inventory, options = {}) {
  const { service, matches } = resolveServiceRef(inventory, options.serviceId, options.manifestRef)
  const command = toUpCommand(service)
  const broker = options.broker || resolveBrokerContext(inventory, options)
  const response = {
    ok: true,
    service: {
      serviceId: service.serviceId,
      manifestId: service.manifestId,
      manifestRelativePath: service.manifestRelativePath,
      specHash: service.specHash,
    },
    matched: matches.length,
    command: maskUpCommand(command),
    brokerUrl: broker.url,
    broker: null,
  }
  if (options.dryRun) return { ...response, dryRun: true }
  if (!broker.url) {
    throw actionError('未找到 broker 控制端点；设置 --broker-url / DSH_BROKER_URL，或先运行 dshd', 'BROKER_URL_MISSING')
  }
  response.broker = await brokerApply({
    url: broker.url,
    token: broker.token,
    commands: [command],
    waitMs: options.waitMs,
    timeoutMs: options.timeoutMs,
  })
  response.ok = response.broker.ok !== false
  return response
}

export async function stopService(inventory, options = {}) {
  const { service, matches } = resolveServiceRef(inventory, options.serviceId, options.manifestRef)
  if (service.serviceId === 'launchpad' && !options.allowSelfStop) {
    throw actionError('拒绝停止 launchpad 自身（会中断当前 API）；确需停止请加 --allow-self-stop', 'SELF_STOP_REFUSED')
  }
  const broker = options.broker || resolveBrokerContext(inventory, options)
  const response = {
    ok: true,
    service: {
      serviceId: service.serviceId,
      manifestId: service.manifestId,
      manifestRelativePath: service.manifestRelativePath,
    },
    matched: matches.length,
    brokerUrl: broker.url,
    broker: null,
  }
  if (options.dryRun) return { ...response, dryRun: true, request: { id: service.serviceId } }
  if (!broker.url) {
    throw actionError('未找到 broker 控制端点；设置 --broker-url / DSH_BROKER_URL，或先运行 dshd', 'BROKER_URL_MISSING')
  }
  response.broker = await brokerStop({
    url: broker.url,
    token: broker.token,
    id: service.serviceId,
    timeoutMs: options.timeoutMs,
  })
  response.ok = response.broker.ok !== false
  return response
}

export async function applyManifest(inventory, options = {}) {
  const manifest = resolveManifestRef(inventory, options.manifestRef)
  const commands = buildApplyCommands(manifest)
  const broker = options.broker || resolveBrokerContext(inventory, options)
  const response = {
    ok: true,
    manifest: {
      id: manifest.id,
      type: manifest.type,
      relativePath: manifest.relativePath,
      services: manifest.services.length,
    },
    commands: maskCommands(commands),
    brokerUrl: broker.url,
    broker: null,
  }
  if (options.dryRun) return { ...response, dryRun: true }
  if (!broker.url) {
    throw actionError('未找到 broker 控制端点；设置 --broker-url / DSH_BROKER_URL，或先运行 dshd', 'BROKER_URL_MISSING')
  }
  response.broker = await brokerApply({
    url: broker.url,
    token: broker.token,
    commands,
    waitMs: options.waitMs,
    timeoutMs: options.timeoutMs,
  })
  response.ok = response.broker.ok !== false
  return response
}

export { buildStatus, scan, analyze, resolveManifestRef, resolveServiceRef }
