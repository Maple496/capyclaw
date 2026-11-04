#!/usr/bin/env node
/**
 * 公共插件源码同步：把 @capyclaw/service-host / tool-host / state-service /
 * asset-service / editor-host 及其依赖的 @capyclaw/plugin-kit 片段同步到
 * 目标插件的 server/shared/。
 *
 * 用法：
 *   node scripts/sync-shared.mjs --out <plugin>/server/shared --force
 *   node scripts/sync-shared.mjs --out <plugin>/server/shared --check
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** [快照文件名, packages/ 下的源目录名]。目录名 = 包名去 scope（capyclaw-<base>）。 */
export const PUBLIC_SHARED = [
  ['service-host', 'capyclaw-service-host'],
  ['tool-host', 'capyclaw-tool-host'],
  ['state-service', 'capyclaw-state-service'],
  ['asset-service', 'capyclaw-asset-service'],
  ['editor-host', 'capyclaw-editor-host'],
]

export const SHARED_KIT_FILES = [
  'tuning.mjs',
  'service/api.mjs',
  'service/http.mjs',
  'service/mcp-http.mjs',
  'tools/validate.mjs',
  'editor/lease.mjs',
  'util/fs-lock.mjs',
]

/* 公共插件自带的包根级调优文件（src/tuning.mjs → shared 根），供其 src/index.mjs 的
 * `./tuning.mjs` 相对引用解析。kit 文件的 '../tuning.mjs' 解析到 kit/tuning.mjs，互不冲突。 */
export const PUBLIC_PKG_ROOT_FILES = [
  ['capyclaw-service-host', 'tuning.mjs'],
]

/* 快照原样保留源码里的 `@capyclaw/plugin-kit/...` 包名导入：快照落在 workbench 包内，
 * 由 workbench 的 node_modules 解析（workbench 依赖 plugin-kit）。历史上有过把包名导入
 * 改写成 ./kit/ 相对路径的重写规则，自源码统一走包名导入后即为空操作，已删除。 */
export function rewriteSharedImports(text) {
  return String(text)
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/**
 * @param {string} outDir 目标 server/shared 目录
 * @param {{ force?: boolean, check?: boolean, root?: string }} options
 * @returns {{ files: string[], changed: string[] }}
 */
export function syncSharedDir(outDir, { force = false, check = false, root = ROOT } = {}) {
  const files = []
  const changed = []
  const write = (rel, content) => {
    const dest = path.join(outDir, rel)
    const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null
    if (prev === content) return
    changed.push(rel)
    if (check) return
    if (prev !== null && !force) {
      throw new Error(`目标已存在且内容不同: ${dest}（加 --force 覆盖）`)
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
  }

  for (const [short, pkg] of PUBLIC_SHARED) {
    const src = path.join(root, 'packages', pkg, 'src', 'index.mjs')
    if (!fs.existsSync(src)) throw new Error(`缺少公共插件源码: ${src}`)
    write(`${short}.mjs`, rewriteSharedImports(fs.readFileSync(src, 'utf8')))
  }
  for (const rel of SHARED_KIT_FILES) {
    const src = path.join(root, 'packages', 'capyclaw-plugin-kit', 'src', rel)
    if (!fs.existsSync(src)) throw new Error(`缺少 kit 源码: ${src}`)
    write(path.join('kit', rel), fs.readFileSync(src, 'utf8'))
  }
  for (const [pkg, rel] of PUBLIC_PKG_ROOT_FILES) {
    const src = path.join(root, 'packages', pkg, 'src', rel)
    if (!fs.existsSync(src)) throw new Error(`缺少公共插件根文件: ${src}`)
    write(rel, fs.readFileSync(src, 'utf8'))
  }

  const manifest = {
    version: '0.1.0',
    packages: Object.fromEntries(PUBLIC_SHARED.map(([short, pkg]) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packages', pkg, 'package.json'), 'utf8'))
      const text = fs.readFileSync(path.join(root, 'packages', pkg, 'src', 'index.mjs'), 'utf8')
      return [short, {
        package: manifest.name,
        version: manifest.version,
        apiVersion: manifest.dsh?.apiVersion || '1.0.0',
        sha256: sha256(rewriteSharedImports(text)),
      }]
    })),
    kit: Object.fromEntries(SHARED_KIT_FILES.map((rel) => {
      const text = fs.readFileSync(path.join(root, 'packages', 'capyclaw-plugin-kit', 'src', rel), 'utf8')
      return [rel, sha256(text)]
    })),
    pkgRoot: Object.fromEntries(PUBLIC_PKG_ROOT_FILES.map(([pkg, rel]) => {
      const text = fs.readFileSync(path.join(root, 'packages', pkg, 'src', rel), 'utf8')
      return [`${pkg}/${rel}`, sha256(text)]
    })),
  }
  write('SHARED_MANIFEST.json', JSON.stringify(manifest, null, 2) + '\n')

  if (check && changed.length) {
    throw new Error(`server/shared 不是最新，请运行 node scripts/sync-shared.mjs --out ${outDir} --force\n` + changed.join('\n'))
  }
  for (const [short] of PUBLIC_SHARED) files.push(`${short}.mjs`)
  for (const rel of SHARED_KIT_FILES) files.push(path.join('kit', rel))
  for (const [, rel] of PUBLIC_PKG_ROOT_FILES) files.push(rel)
  return { files, changed }
}

/* CLI */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const arg = (name, fallback = '') => {
    const index = args.indexOf(name)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const out = arg('--out')
  if (!out) {
    console.error('用法: node scripts/sync-shared.mjs --out <plugin>/server/shared [--force|--check]')
    process.exit(1)
  }
  try {
    const result = syncSharedDir(path.resolve(out), {
      force: args.includes('--force'),
      check: args.includes('--check'),
    })
    console.log(`✓ server/shared 已同步（${result.files.length} 个文件${result.changed.length ? `，更新 ${result.changed.length} 个` : '，无变化'}）`)
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  }
}
