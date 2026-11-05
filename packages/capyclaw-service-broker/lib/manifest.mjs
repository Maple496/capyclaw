/**
 * 清单加载（host.mjs 与 server.mjs 共用）。
 *
 * - manifest 路径为相对路径时，相对 **broker 包目录**解析；
 * - 清单里的 `${PACKAGE_DIR}` 展开为 **清单文件所在目录**——套件捆绑布局
 *   （zip 产物 / 源内 plugin 目录）下即套件根（services.json 与 node_modules/*
 *   同层），同一份清单在 dev 树与安装态都能解析出正确绝对路径；
 * - dsh 原生安装（pnpm hoisted / npm 提升）会把套件依赖提升到 profile 根
 *   node_modules，套件目录内没有 node_modules/<pkg>：展开后的脚本路径不存在
 *   时，沿清单目录向上逐级定位提升后的真实位置（resolveHoistedScriptPath），
 *   捆绑布局（路径本就存在）行为不变。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateServiceManifest } from './spec.mjs'

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function resolveManifestPath(manifestPath) {
  if (!manifestPath) return path.join(PKG_DIR, 'services.json')
  return path.isAbsolute(manifestPath) ? manifestPath : path.resolve(PKG_DIR, manifestPath)
}

export function loadManifest(manifestPath) {
  const file = resolveManifestPath(manifestPath)
  if (!existsSync(file)) return []
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const services = Array.isArray(raw) ? raw : raw.services
  if (!Array.isArray(services)) throw new Error(`manifest 格式非法（缺 services 数组）: ${file}`)
  const specErrors = validateServiceManifest(services, file)
  if (specErrors.length) throw new Error(`manifest 服务 spec 非法:\n- ${specErrors.join('\n- ')}`)
  const base = path.dirname(file)
  return services.map((service) => expandPackageDir(service, base))
}

/**
 * 提升布局回退：`${PACKAGE_DIR}/node_modules/<pkg>/…` 展开后不存在时，沿 base
 * 向上逐级找 node_modules/<pkg>/…（npm/pnpm 提升后的落点）。找不到时原样返回，
 * 由引擎按既有行为报错，不在此处吞掉。
 */
function resolveHoistedScriptPath(expanded, base) {
  if (existsSync(expanded)) return expanded
  const norm = String(expanded).replace(/\\/g, '/')
  const marker = '/node_modules/'
  /* 取最内层 node_modules 段：展开路径可能同时含 profile 根与套件内嵌两级 */
  const idx = norm.lastIndexOf(marker)
  if (idx < 0) return expanded
  const rest = norm.slice(idx + marker.length).split('/')
  let dir = path.resolve(base)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...rest)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return expanded
    dir = parent
  }
}

function expandPackageDir(service, base) {
  const out = { ...service, env: { ...service.env } }
  if (Array.isArray(out.cmd)) {
    out.cmd = out.cmd.map((a) => {
      const str = String(a)
      if (!str.includes('${PACKAGE_DIR}')) return str
      return resolveHoistedScriptPath(str.replaceAll('${PACKAGE_DIR}', base), base)
    })
  }
  for (const key of ['url', 'cwd', 'logFile']) {
    if (typeof out[key] === 'string') out[key] = String(out[key]).replaceAll('${PACKAGE_DIR}', base)
  }
  return out
}
