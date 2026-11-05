/** 公共服务 API 契约：插件之间只通过这份描述判断兼容性。 */

/**
 * @param {string} name 服务名（ctx.<name>）
 * @param {string} version API 版本（semver；major 变化 = 不兼容）
 * @param {string[]} capabilities 能力标签
 */
export function createServiceApi(name, version = '1.0.0', capabilities = []) {
  if (!name) throw new Error('createServiceApi 需要 name')
  return Object.freeze({
    name,
    version,
    capabilities: Object.freeze([...capabilities]),
  })
}

/**
 * 断言一个已注入的服务对象满足消费者要求。
 * 缺失服务或 major 不一致时抛出明确错误，避免“看起来能跑”的静默不兼容。
 * @param {object} service
 * @param {{ name: string, major?: number|string, version?: string }} expected
 */
export function assertServiceApi(service, expected = {}) {
  const name = expected.name
  if (!name) throw new Error('assertServiceApi 需要 expected.name')
  const major = String(expected.major ?? String(expected.version || '1').split('.')[0])
  if (!service) throw new Error(`缺少公共服务: ctx.${name}`)
  const api = service.api
  if (!api || typeof api !== 'object') {
    throw new Error(`服务 ctx.${name} 没有声明 api 契约；请升级提供方插件`)
  }
  if (api.name !== name) {
    throw new Error(`服务 ctx.${name} 的 api.name=${api.name}，与消费者期望的 ${name} 不一致`)
  }
  const gotMajor = String(api.version || '').split('.')[0]
  if (gotMajor !== major) {
    throw new Error(`服务 ctx.${name} API major=${gotMajor}，消费者要求 major=${major}（提供方版本 ${api.version}）`)
  }
  return api
}

export function serviceApiSummary(service) {
  const api = service?.api
  return api ? { name: api.name, version: api.version, capabilities: [...(api.capabilities || [])] } : null
}
