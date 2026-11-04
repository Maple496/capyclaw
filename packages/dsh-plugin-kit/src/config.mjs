/**
 * 插件配置解析（统一入口）。
 *
 * 目的：让插件不把端口/URL/路径写死在代码或 cordis.patch.yml 里，
 * 而是遵循一条可预测的优先级链：
 *
 *   ctx config（由 stack / profile patch 注入的运行时配置）
 *     → 环境变量（逐字段，如 DSH_LAUNCHPAD_PORT）
 *       → defaults（安全默认值）
 *
 * 所有取值都带上来源，便于 doctor / 日志说明「这个值是哪来的」。
 *
 * 用法：
 *   import { resolveConfig } from '@capyclaw/plugin-kit/config'
 *
 *   export function apply(ctx, config = {}) {
 *     const cfg = resolveConfig(config, {
 *       envPrefix: 'DSH_PPT',
 *       defaults: { port: 39311, host: '127.0.0.1' },
 *       fields: {
 *         port: { env: 'PORT', type: 'port' },
 *         host: { env: 'HOST' },
 *         backendUrl: { env: 'BACKEND_URL', type: 'url' },
 *       },
 *     })
 *     cfg.value.port        // 解析后的值
 *     cfg.source.port       // 'config' | 'env:DSH_PPT_PORT' | 'default'
 *   }
 */

const TYPE_CHECKS = {
  port(value) {
    const n = Number(value)
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
  },
  number(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  },
  boolean(value) {
    if (typeof value === 'boolean') return value
    const s = String(value).trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(s)) return true
    if (['0', 'false', 'no', 'off'].includes(s)) return false
    return null
  },
  url(value) {
    const s = String(value).trim()
    try {
      const u = new URL(s)
      return u.protocol === 'http:' || u.protocol === 'https:' ? s : null
    } catch {
      return null
    }
  },
  string(value) {
    const s = String(value)
    return s.length ? s : null
  },
}

function coerce(raw, type) {
  if (raw === undefined || raw === null || raw === '') return { ok: false }
  const check = TYPE_CHECKS[type] || TYPE_CHECKS.string
  const value = check(raw)
  return value === null ? { ok: false } : { ok: true, value }
}

/**
 * @param {object} config  dsh 传给 apply() 的 config（来自 cordis.patch.yml / stack configs）
 * @param {object} options
 * @param {string} [options.envPrefix]  环境变量前缀，如 'DSH_PPT'
 * @param {object} [options.defaults]   默认值表
 * @param {object} [options.fields]     { 字段名: { env?: string, type?: 'port'|'number'|'boolean'|'url'|'string' } }
 * @param {(msg:string)=>void} [options.onInvalid]  无效值回调（默认收集到 issues）
 * @returns {{ value: object, source: object, issues: string[] }}
 */
export function resolveConfig(config = {}, options = {}) {
  const { envPrefix = '', defaults = {}, fields = {}, env = process.env } = options
  const value = {}
  const source = {}
  const issues = []

  const keys = new Set([...Object.keys(defaults), ...Object.keys(fields)])

  for (const key of keys) {
    const field = fields[key] || {}
    const type = field.type || inferType(defaults[key])
    const envName = field.env
      ? (envPrefix ? `${envPrefix}_${field.env}` : field.env)
      : (envPrefix ? `${envPrefix}_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}` : '')

    // 1) ctx config
    const fromConfig = coerce(config?.[key], type)
    if (fromConfig.ok) {
      value[key] = fromConfig.value
      source[key] = 'config'
      continue
    }
    if (config?.[key] !== undefined && config?.[key] !== null && config?.[key] !== '') {
      issues.push(`${key}: config 值无效（期望 ${type}）: ${JSON.stringify(config[key])}，已降级到下一来源`)
    }

    // 2) 环境变量
    if (envName && env?.[envName] !== undefined) {
      const fromEnv = coerce(env[envName], type)
      if (fromEnv.ok) {
        value[key] = fromEnv.value
        source[key] = `env:${envName}`
        continue
      }
      issues.push(`${key}: 环境变量 ${envName} 值无效（期望 ${type}）: ${JSON.stringify(env[envName])}，已降级到默认值`)
    }

    // 3) 默认值
    if (defaults[key] !== undefined) {
      value[key] = defaults[key]
      source[key] = 'default'
      continue
    }

    // 无默认值且没解析到 → 不写入，交给调用方判断是否必填
    source[key] = 'unset'
  }

  return { value, source, issues }
}

function inferType(sample) {
  if (typeof sample === 'boolean') return 'boolean'
  if (typeof sample === 'number') return 'number'
  if (typeof sample === 'string' && /^https?:\/\//.test(sample)) return 'url'
  return 'string'
}

/** 便于在 apply() 里打一条可读的配置来源日志。 */
export function describeConfig({ value, source }) {
  return Object.entries(value)
    .map(([k, v]) => `${k}=${JSON.stringify(v)} (${source[k] || 'unknown'})`)
    .join(', ')
}
