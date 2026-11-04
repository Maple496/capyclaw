/**
 * 文档 op 注册与分发：把「查表 + snapshot 策略 + 未知指令」收敛到一处。
 * op 实现按域放在调用方，注册表只提供统一元数据与分发。
 */

export function defineOp({ name, run, apply, mutates = true, view = false, description = '' } = {}) {
  if (!name || typeof name !== 'string') throw new Error('defineOp 需要 name')
  const fn = run || apply
  if (typeof fn !== 'function') throw new Error(`op "${name}" 需要 run 函数`)
  return {
    name,
    run: fn,
    mutates: mutates !== false,
    view: view === true,
    description,
  }
}

function normalizeDefinition(name, raw) {
  if (!raw || typeof raw !== 'object') throw new Error(`op "${name}" 定义不合法`)
  const fn = raw.run || raw.apply
  if (typeof fn !== 'function') throw new Error(`op "${name}" 需要 run 函数`)
  return {
    ...raw,
    name,
    run: fn,
    mutates: raw.mutates !== false,
    view: raw.view === true,
    description: raw.description || '',
  }
}

/** 把 { domain: { opName: definition } } 摊平成一张 op 表。 */
export function mergeOpModules(modules = {}) {
  const out = {}
  for (const table of Object.values(modules)) {
    Object.assign(out, table)
  }
  return out
}

export function createOpRegistry({
  ops = {},
  modules = null,
  snapshot = null,
  assertReady = null,
  unknownMessage = null,
} = {}) {
  const source = modules ? mergeOpModules(modules) : ops
  const definitions = {}
  for (const [name, raw] of Object.entries(source)) {
    if (Object.hasOwn(definitions, name)) throw new Error(`重复的 op: ${name}`)
    definitions[name] = normalizeDefinition(name, raw)
  }
  const names = Object.keys(definitions)
  const viewNames = names.filter((name) => definitions[name].view)

  async function apply(target, cmd, ctx = {}) {
    if (assertReady) assertReady(target)
    else if (target && typeof target.isMounted === 'function' && !target.isMounted()) {
      throw new Error('编辑器未就绪')
    }
    const name = cmd && cmd.op
    const def = definitions[name]
    if (!def) {
      const detail = unknownMessage
        ? unknownMessage(name)
        : '未知指令: ' + String(name || JSON.stringify(cmd).slice(0, 40))
      throw new Error(detail)
    }
    if (def.mutates && snapshot) snapshot(target)
    return def.run(target, cmd || {}, ctx)
  }

  function isViewOp(cmdOrName) {
    const name = typeof cmdOrName === 'string' ? cmdOrName : cmdOrName && cmdOrName.op
    return !!(name && definitions[name] && definitions[name].view)
  }

  return {
    definitions,
    names,
    viewNames,
    has: (name) => Object.hasOwn(definitions, name),
    isViewOp,
    apply,
  }
}

/** 兼容旧调用：用 definitions 建一个 applyOp。 */
export function createOpDispatcher(definitions, options = {}) {
  return createOpRegistry({ ops: definitions, ...options }).apply
}
