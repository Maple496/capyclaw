/**
 * 轻量 JSON Schema 参数校验（覆盖本工具面用到的子集）。
 * MCP server 不会替我们执行 inputSchema，必须在调用实现前自己挡住坏参数。
 *
 * 编译缓存：schema 对象通常随工具定义长期存在，按 schema 对象（WeakMap）编译成
 * 闭包树，重复调用不再逐层遍历 schema/创建临时数组。语义与解释执行逐行等价
 * （anyOf / type / enum / maxLength / array / object 的顺序与错误文案不变）。
 * 基准：50 元素数组参数校验从 ~0.029ms 降到 ~0.01ms（evolution/hotpath-bench.mjs H11）。
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

/** schema 对象 → 编译后的校验闭包。 */
const compiledCache = new WeakMap()

/**
 * 把 schema 编译成 `(value, path, errors) => void` 闭包树。
 * 纯结构性编译，不依赖运行时数据；同一 schema 对象只编译一次。
 */
function compileSchema(schema) {
  if (!schema || typeof schema !== 'object') return () => {}

  /* anyOf：与解释版一致——任一支路无错误即通过，且通过后不再执行其余规则。 */
  if (schema.anyOf) {
    const branches = schema.anyOf.map(compileSchema)
    return (value, path, errors) => {
      const matched = branches.some((branch) => {
        const local = []
        branch(value, path, local)
        return local.length === 0
      })
      if (!matched) errors.push(`${path} 不符合 anyOf`)
    }
  }

  const typeCheck = schema.type ? TYPE_CHECKS[schema.type] : null
  const enumValues = schema.enum ? schema.enum : null
  const maxLength = schema.maxLength != null ? schema.maxLength : null
  const maxItems = schema.type === 'array' && schema.maxItems != null ? schema.maxItems : null
  const validateItem = schema.type === 'array' && schema.items ? compileSchema(schema.items) : null
  const properties = schema.type === 'object' ? (schema.properties || {}) : null
  const propValidators = properties
    ? Object.entries(properties).map(([key, child]) => [key, compileSchema(child)])
    : null
  const required = properties && Array.isArray(schema.required) ? schema.required : null
  const noAdditional = properties && schema.additionalProperties === false

  return (value, path, errors) => {
    /* 类型不符：解释版立即返回，不再做深层校验（保持该短路语义）。 */
    if (typeCheck && !typeCheck(value)) {
      errors.push(`${path} 应为 ${schema.type}`)
      return
    }
    if (enumValues && !enumValues.includes(value)) {
      errors.push(`${path} 必须是 ${enumValues.join(' / ')}`)
    }
    if (maxLength != null && typeof value === 'string' && value.length > maxLength) {
      errors.push(`${path} 超过最大长度 ${maxLength}`)
    }
    if (maxItems != null && Array.isArray(value) && value.length > maxItems) {
      errors.push(`${path} 最多 ${maxItems} 项`)
    }
    if (validateItem && Array.isArray(value)) {
      value.forEach((item, i) => validateItem(item, `${path}[${i}]`, errors))
    }
    if (properties && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (required) {
        for (const key of required) {
          if (value[key] === undefined || value[key] === null) errors.push(`${path}.${key} 必填`)
        }
      }
      if (noAdditional) {
        for (const key of Object.keys(value)) {
          if (!properties[key]) errors.push(`${path}.${key} 不是允许的参数`)
        }
      }
      for (const [key, validateChild] of propValidators) {
        if (value[key] === undefined) continue
        validateChild(value[key], `${path}.${key}`, errors)
      }
    }
  }
}

/** 取（或编译）schema 的校验闭包。 */
function validatorOf(schema) {
  if (!schema || typeof schema !== 'object') return compileSchema(schema)
  const cached = compiledCache.get(schema)
  if (cached) return cached
  const compiled = compileSchema(schema)
  compiledCache.set(schema, compiled)
  return compiled
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
  validatorOf(tool.inputSchema)(args, 'arguments', errors)
  return { ok: errors.length === 0, errors }
}
