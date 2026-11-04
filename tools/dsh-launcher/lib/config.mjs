/**
 * 配置装载：`--config <file>` > 工具目录 `dshd.config.json` > 内置样例缺省。
 *
 * 全部路径解析为绝对路径；相对路径相对「配置文件所在目录」。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHarnessDir } from 'dsh-harness-paths'

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG_FILE = path.join(PKG_DIR, 'dshd.config.json')

const REPO_ROOT = path.resolve(PKG_DIR, '..', '..')

// resolveHarnessDir 由 dsh-harness-paths 提供（唯一实现；此前三处副本已实际漂移）。
export { resolveHarnessDir }

/**
 * 内置缺省（仓库内布局；dshHome 必须由配置给出——那是插件/profile 的家）。
 *
 * dsh 宿主不在本仓库内。harnessDir 解析顺序：
 *   1. stack / 配置文件里的 harnessDir
 *   2. 环境变量 DSH_HARNESS_DIR
 *   3. 兄弟目录 ../dsh-runtime/apps/harness/deepseek-harness（文档化布局）
 * 都缺失时会在启动前明确报错，而不是悄悄指向一个不存在的目录。
 */
export function builtinDefaults() {
  return {
    name: 'dsh',
    harnessDir: resolveHarnessDir(),
    brokerDir: path.join(REPO_ROOT, 'packages', 'dsh-service-broker'),
    stateDir: path.join(PKG_DIR, '.dshd'),
    profile: 'web',
    workspace: '',
    manifest: '',
    dshHome: '',
    dshProxyPort: 'auto',
    dshUpPort: 'auto',
    brokerPort: 'auto',
    open: false,
  }
}

function absOf(base, value) {
  const str = String(value || '').trim()
  if (!str) return ''
  return path.isAbsolute(str) ? path.normalize(str) : path.resolve(base, str)
}

export function portOf(value) {
  if (value === undefined || value === null || value === '' || value === 'auto') return 'auto'
  const num = Number(value)
  if (!Number.isInteger(num) || num <= 0 || num > 65535) {
    throw new Error(`端口非法: ${JSON.stringify(value)}（正整数或 "auto"）`)
  }
  return num
}

export async function loadConfig(configPath) {
  const file = configPath ? path.resolve(configPath) : DEFAULT_CONFIG_FILE
  const base = path.dirname(file)
  const merged = builtinDefaults()
  if (existsSync(file)) {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    for (const key of ['name', 'profile', 'harnessDir', 'brokerDir', 'stateDir',
      'workspace', 'manifest', 'dshHome']) {
      if (raw[key] !== undefined) merged[key] = String(raw[key])
    }
    for (const key of ['dshProxyPort', 'dshUpPort', 'brokerPort']) {
      if (raw[key] !== undefined) merged[key] = raw[key]
    }
    if (raw.open !== undefined) merged.open = !!raw.open
  } else if (configPath) {
    throw new Error(`配置文件不存在: ${file}`)
  }
  merged._configFile = file
  merged.harnessDir = absOf(base, merged.harnessDir)
  merged.brokerDir = absOf(base, merged.brokerDir)
  merged.stateDir = absOf(base, merged.stateDir)
  merged.workspace = absOf(base, merged.workspace)
  merged.manifest = absOf(base, merged.manifest)
  merged.dshHome = absOf(base, merged.dshHome)
  merged.dshProxyPort = portOf(merged.dshProxyPort)
  merged.dshUpPort = portOf(merged.dshUpPort)
  merged.brokerPort = portOf(merged.brokerPort)
  return merged
}

/** 启动前置校验：缺什么当场报，不等到 spawn 才炸。 */
export function assertConfig(cfg) {
  const missing = []
  if (!cfg.dshHome) missing.push('dshHome（DSH_HOME：profile/插件所在家）')
  if (!cfg.manifest) missing.push('manifest（开机清单，broker 格式 {services:[…]}）')
  if (!cfg.harnessDir) {
    missing.push(
      'harnessDir（dsh 宿主目录；本仓库不再内置。'
      + '请设置环境变量 DSH_HARNESS_DIR，或在 stack/配置里写 harnessDir）',
    )
  } else if (!existsSync(cfg.harnessDir)) {
    missing.push(`harnessDir 不存在: ${cfg.harnessDir}`)
  }
  if (!existsSync(cfg.brokerDir)) missing.push(`brokerDir 不存在: ${cfg.brokerDir}`)
  if (missing.length) {
    throw new Error(`配置不完整（${cfg._configFile}）:\n  - ${missing.join('\n  - ')}`)
  }
  const proxy = path.join(cfg.harnessDir, 'auth-proxy.mjs')
  if (!existsSync(proxy)) throw new Error(`找不到 auth-proxy: ${proxy}`)
  if (!existsSync(path.join(cfg.brokerDir, 'server.mjs'))) {
    throw new Error(`找不到 broker 入口: ${path.join(cfg.brokerDir, 'server.mjs')}`)
  }
  if (!existsSync(cfg.manifest)) throw new Error(`开机清单不存在: ${cfg.manifest}`)
  return cfg
}
