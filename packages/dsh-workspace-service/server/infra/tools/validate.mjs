/**
 * 轻量 JSON Schema 参数校验（覆盖本工具面用到的子集）。
 * MCP server 不会替我们执行 inputSchema，必须在调用实现前自己挡住坏参数。
 */

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  null: (v) => v === null,
}

function validateValue(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return
  if (schema.anyOf) {
    const matched = schema.anyOf.some((item) => {
      const local = []
      validateValue(item, value, path, local)
      return local.length === 0
    })
    if (!matched) errors.push(`${path} 不符合 anyOf`)
    return
  }
  if (schema.type && TYPE_CHECKS[schema.type] && !TYPE_CHECKS[schema.type](value)) {
    errors.push(`${path} 应为 ${schema.type}`)
    return
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} 必须是 ${schema.enum.join(' / ')}`)
  }
  if (schema.maxLength != null && typeof value === 'string' && value.length > schema.maxLength) {
    errors.push(`${path} 超过最大长度 ${schema.maxLength}`)
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${path} 最多 ${schema.maxItems} 项`)
    }
    if (schema.items) value.forEach((item, i) => validateValue(schema.items, item, `${path}[${i}]`, errors))
  }
  if (schema.type === 'object' && TYPE_CHECKS.object(value)) {
    const props = schema.properties || {}
    if (schema.required) {
      for (const key of schema.required) {
        if (value[key] === undefined || value[key] === null) errors.push(`${path}.${key} 必填`)
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!props[key]) errors.push(`${path}.${key} 不是允许的参数`)
      }
    }
    for (const [key, child] of Object.entries(props)) {
      if (value[key] === undefined) continue
      validateValue(child, value[key], `${path}.${key}`, errors)
    }
  }
}

/**
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateToolArguments(tool, args) {
  const errors = []
  if (!tool || !tool.inputSchema) {
    if (args != null && (typeof args !== 'object' || Array.isArray(args))) errors.push('arguments 必须是 object')
    return { ok: errors.length === 0, errors }
  }
  if (args == null) args = {}
  validateValue(tool.inputSchema, args, 'arguments', errors)
  return { ok: errors.length === 0, errors }
}
