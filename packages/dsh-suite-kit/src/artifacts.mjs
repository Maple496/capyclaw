/**
 * 公共插件版本化 artifact store。
 *
 * 目录：
 *   <root>/index.json
 *   <root>/<safeName>/<version>/package/...
 *
 * 版本化安装：installSuites({ packageSpecs: ['dsh-state-service@0.1.1'] })
 * 回滚：installSuites({ rollbackTo: '<profile>/dsh-composition.lock.json.bak-...' })
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function defaultArtifactRoot() {
  return process.env.DSH_ARTIFACT_STORE || path.join(os.homedir(), '.dsh-store', 'artifacts')
}

function safeName(name) {
  return String(name).replace(/[@/\\]/g, '__')
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function walk(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else out.push(path.relative(base, full).split('\\').join('/'))
  }
  return out.sort()
}

function treeHash(dir) {
  const hash = crypto.createHash('sha256')
  for (const rel of walk(dir)) {
    hash.update(rel)
    hash.update(fs.readFileSync(path.join(dir, rel)))
  }
  return hash.digest('hex')
}

function copyPackageDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const rel of walk(src)) {
    if (rel === 'node_modules' || rel.startsWith('node_modules/')) continue
    if (rel === '.git' || rel.startsWith('.git/')) continue
    if (rel === 'test' || rel.startsWith('test/')) continue
    if (rel === 'coverage' || rel.startsWith('coverage/')) continue
    const to = path.join(dest, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(src, rel), to)
  }
}

export function artifactIndexPath(root = defaultArtifactRoot()) {
  return path.join(root, 'index.json')
}

export function readArtifactIndex(root = defaultArtifactRoot()) {
  return readJsonSafe(artifactIndexPath(root)) || { version: 1, packages: {} }
}

function writeArtifactIndex(root, index) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(artifactIndexPath(root), JSON.stringify(index, null, 2) + '\n')
}

/**
 * 打包一个包目录到 artifact store。
 * @param {string} packageDir
 * @param {{ root?: string, force?: boolean }} options
 */
export function packPackage(packageDir, { root = defaultArtifactRoot(), force = false } = {}) {
  const manifest = readJsonSafe(path.join(packageDir, 'package.json'))
  if (!manifest?.name || !manifest?.version) throw new Error(`artifact pack: ${packageDir} 缺少 package.json name/version`)
  const dest = path.join(root, safeName(manifest.name), manifest.version, 'package')
  if (fs.existsSync(dest) && !force) throw new Error(`artifact 已存在: ${manifest.name}@${manifest.version}（加 --force 覆盖）`)
  fs.rmSync(dest, { recursive: true, force: true })
  copyPackageDir(packageDir, dest)
  const meta = {
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.dsh?.apiVersion || null,
    dependencies: manifest.dependencies || {},
    dir: dest,
    sha256: treeHash(dest),
    packedAt: new Date().toISOString(),
  }
  const index = readArtifactIndex(root)
  index.packages[manifest.name] ||= {}
  index.packages[manifest.name][manifest.version] = meta
  writeArtifactIndex(root, index)
  return meta
}

/**
 * @param {string} spec name 或 name@version
 * @param {{ root?: string }} options
 */
export function resolvePackageSpec(spec, { root = defaultArtifactRoot() } = {}) {
  if (!spec || typeof spec !== 'string') throw new Error('artifact resolve: spec 必填')
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  const version = at > 0 ? spec.slice(at + 1) : ''
  const index = readArtifactIndex(root)
  const versions = index.packages[name]
  if (!versions) throw new Error(`artifact 不存在: ${name}（root=${root}）`)
  if (version) {
    const hit = versions[version]
    if (!hit) throw new Error(`artifact 版本不存在: ${spec}；可用: ${Object.keys(versions).sort().join(', ')}`)
    return hit
  }
  const latest = Object.keys(versions).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
  return versions[latest]
}

export function listArtifacts({ root = defaultArtifactRoot() } = {}) {
  const index = readArtifactIndex(root)
  return Object.entries(index.packages).flatMap(([name, versions]) =>
    Object.values(versions).map((meta) => ({ name, version: meta.version, apiVersion: meta.apiVersion, sha256: meta.sha256, dir: meta.dir })))
}

export function recordFromLock(lock, { root = defaultArtifactRoot() } = {}) {
  if (!lock?.packages) throw new Error('artifact recordFromLock: lock 缺 packages')
  return Object.entries(lock.packages).map(([name, meta]) => resolvePackageSpec(`${name}@${meta.version}`, { root }))
}
