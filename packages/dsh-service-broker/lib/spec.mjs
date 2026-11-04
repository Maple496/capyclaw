/**
 * 服务 spec 校验：service.schema.json 的代码面。
 *
 * stack-services.json（dsh-stack-kit 编译）与 service-manifest.json
 * （dsh-suite-kit 物化）共用这一份 spec；本模块是装载期与跨包测试
 * 共同调用的唯一校验器（结构级——语义由 engine/discovery 在运行期裁决）。
 */
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function checkPortValue(value, label, errors) {
  if (value === undefined) return
  if (value === 'auto') return
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    errors.push(`${label} 必须是 1-65535 整数或 "auto"`)
  }
}

/** 校验单个服务 spec；返回错误数组（空 = 通过）。 */
export function validateServiceSpec(service, at = 'service') {
  const errors = []
  if (!service || typeof service !== 'object' || Array.isArray(service)) {
    return [`${at} 必须是对象`]
  }
  if (typeof service.id !== 'string' || !ID_RE.test(service.id)) {
    errors.push(`${at}.id 必须是非空的服务标识（字母数字开头，可含 . _ -）`)
  }
  if (!Array.isArray(service.cmd) || service.cmd.length === 0 || service.cmd.some((item) => typeof item !== 'string')) {
    errors.push(`${at}.cmd 必须是非空 string[]（完整命令行）`)
  }
  if (service.ports !== undefined) {
    if (typeof service.ports !== 'object' || service.ports === null || Array.isArray(service.ports)) {
      errors.push(`${at}.ports 必须是对象（main 或具名端口）`)
    } else {
      for (const [name, value] of Object.entries(service.ports)) {
        checkPortValue(value, `${at}.ports.${name}`, errors)
      }
    }
  }
  if (service.env !== undefined && (typeof service.env !== 'object' || service.env === null
    || Array.isArray(service.env) || Object.values(service.env).some((value) => typeof value !== 'string'))) {
    errors.push(`${at}.env 必须是 string -> string 对象`)
  }
  if (service.keepAlive !== undefined && typeof service.keepAlive !== 'boolean') {
    errors.push(`${at}.keepAlive 必须是 boolean`)
  }
  if (service.healthPath !== undefined && typeof service.healthPath !== 'string') {
    errors.push(`${at}.healthPath 必须是 string`)
  }
  if (service.url !== undefined && typeof service.url !== 'string') errors.push(`${at}.url 必须是 string`)
  if (service.cwd !== undefined && typeof service.cwd !== 'string') errors.push(`${at}.cwd 必须是 string`)
  if (service.logFile !== undefined && typeof service.logFile !== 'string') errors.push(`${at}.logFile 必须是 string`)
  if (service.requires !== undefined && (!Array.isArray(service.requires)
    || service.requires.some((item) => typeof item !== 'string'))) {
    errors.push(`${at}.requires 必须是 string[]`)
  }
  if (service.portFrom !== undefined && !['content', 'urlPort'].includes(service.portFrom)) {
    errors.push(`${at}.portFrom 只允许 content | urlPort`)
  }
  if (service.dirFrom !== undefined && service.dirFrom !== 'contentState') {
    errors.push(`${at}.dirFrom 只允许 contentState`)
  }
  return errors
}

/** 校验整份清单（services 数组 + 同清单 id 唯一）；返回错误数组（空 = 通过）。 */
export function validateServiceManifest(services, label = 'manifest') {
  if (!Array.isArray(services)) return [`${label}: services 必须是数组`]
  const errors = []
  const seen = new Set()
  services.forEach((service, index) => {
    errors.push(...validateServiceSpec(service, `${label}[${index}]`))
    if (service && typeof service === 'object' && typeof service.id === 'string') {
      if (seen.has(service.id)) errors.push(`${label}: 重复的服务 id ${service.id}`)
      seen.add(service.id)
    }
  })
  return errors
}
