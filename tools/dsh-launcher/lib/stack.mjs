/**
 * dsh-stack.json → dshd 配置。
 *
 * stack 是唯一编辑入口；profile package.json 与 stack-services.json 是生成物。
 * domain 型不编译 profile/services，交给 dsh-suite-kit runtime。
 */
import path from 'node:path'

import {
  applyStack,
  compileStack,
  loadStack,
  planStack,
  resolveStackPaths,
  summarizePlan,
} from 'dsh-stack-kit'
import { builtinDefaults, portOf } from './config.mjs'

export { applyStack, compileStack, loadStack, planStack, summarizePlan }

function domainPortPref(value) {
  return value === undefined || value === null || value === 'auto' ? 0 : value
}

function domainConfigFromPaths(stack, paths, defaults) {
  const raw = stack.ports || {}
  const domain = {
    source: paths.domainSource,
    runtimeId: paths.runtimeId,
    storeRoot: paths.storeRoot,
    profile: stack.profile || stack.domain?.profile || '',
    name: stack.domain?.name || stack.name,
    recreate: !!stack.domain?.recreate,
    requires: stack.domain?.requires,
    scope: stack.domain?.scope,
    model: stack.domain?.model,
    workspaceController: stack.domain?.workspaceController,
    env: { ...(stack.domain?.env || {}), ...(stack.env || {}) },
  }
  return {
    ...defaults,
    kind: 'domain',
    name: stack.name || defaults.name,
    harnessDir: stack.harnessDir ? path.resolve(stack.dir, stack.harnessDir) : defaults.harnessDir,
    brokerDir: stack.brokerDir ? path.resolve(stack.dir, stack.brokerDir) : defaults.brokerDir,
    stateDir: paths.stateDir,
    storeRoot: paths.storeRoot,
    runtimeId: paths.runtimeId,
    domainSource: paths.domainSource,
    profile: domain.profile,
    workspace: '',
    manifest: '',
    dshHome: '',
    ports: {
      harness: domainPortPref(raw.proxy),
      dsh: domainPortPref(raw.upstream),
      content: domainPortPref(raw.content),
      broker: domainPortPref(raw.broker),
      services: Object.fromEntries(Object.entries(raw.services || {}).map(([id, value]) => [id, domainPortPref(value)])),
    },
    domain,
    env: domain.env,
    open: !!stack.open,
    _stack: stack,
    _stackPath: stack.path,
    _configFile: stack.path,
  }
}

export function toLauncherConfig(stack, compiled = compileStack(stack)) {
  if (!compiled.valid) {
    const error = new Error(`stack 校验失败:\n- ${compiled.errors.join('\n- ')}`)
    error.code = 'STACK_INVALID'
    error.errors = compiled.errors
    throw error
  }
  const defaults = builtinDefaults()
  if (compiled.kind === 'domain') {
    return {
      ...domainConfigFromPaths(stack, compiled.paths, defaults),
      _compiled: compiled,
    }
  }
  return {
    ...defaults,
    kind: 'profile',
    name: stack.name || defaults.name,
    harnessDir: stack.harnessDir ? path.resolve(stack.dir, stack.harnessDir) : defaults.harnessDir,
    brokerDir: stack.brokerDir ? path.resolve(stack.dir, stack.brokerDir) : defaults.brokerDir,
    stateDir: compiled.paths.stateDir,
    profile: stack.profile,
    workspace: compiled.paths.workspace,
    manifest: compiled.manifest.file,
    dshHome: compiled.paths.home,
    dshProxyPort: portOf(stack.ports?.proxy ?? 'auto'),
    dshUpPort: portOf(stack.ports?.upstream ?? 'auto'),
    brokerPort: portOf(stack.ports?.broker ?? 'auto'),
    open: !!stack.open,
    env: stack.env || {},
    _stack: stack,
    _compiled: compiled,
    _stackPath: stack.path,
    _configFile: stack.path,
  }
}

export function loadStackConfig(stackPath) {
  return toLauncherConfig(loadStack(stackPath))
}

/**
 * 生命周期命令（stop/status/doctor/logs）用：只依赖 stateDir 里的 runtime，
 * 不解析 domain.source（domain 目录被删/搬走也必须能停机）。
 */
export function loadDomainLifecycleConfig(stackPath) {
  const stack = loadStack(stackPath)
  const paths = resolveStackPaths(stack)
  const cfg = domainConfigFromPaths(stack, paths, builtinDefaults())
  cfg._compiled = {
    kind: 'domain',
    valid: true,
    errors: [],
    warnings: [],
    stack,
    paths,
    domain: cfg.domain,
    profile: null,
    services: [],
    manifest: null,
  }
  return cfg
}
