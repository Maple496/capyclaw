/**
 * 清单加载（host.mjs 与 server.mjs 共用）。
 *
 * - manifest 路径为相对路径时，相对 **broker 包目录**解析；
 * - 清单里的 `${PACKAGE_DIR}` 展开为 **清单文件所在目录**——套件捆绑布局
 *   下即套件根（services.json 与 node_modules/* 同层），同一份清单在
 *   dev 树与安装态都能解析出正确绝对路径。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  const base = path.dirname(file)
  return services.map((service) => expandPackageDir(service, base))
}

function expandPackageDir(service, base) {
  const out = { ...service, env: { ...service.env } }
  if (Array.isArray(out.cmd)) out.cmd = out.cmd.map((a) => String(a).replaceAll('${PACKAGE_DIR}', base))
  for (const key of ['url', 'cwd', 'logFile']) {
    if (typeof out[key] === 'string') out[key] = out[key].replaceAll('${PACKAGE_DIR}', base)
  }
  return out
}
