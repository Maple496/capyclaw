#!/usr/bin/env node
/**
 * 把 @capyclaw/plugin-kit 源码快照到插件包的 server/infra/。
 *
 * 用法：
 *   node packages/@capyclaw/plugin-kit/bin/sync.mjs --out <plugin>/server/infra
 *   node packages/@capyclaw/plugin-kit/bin/sync.mjs --out <plugin>/server/infra --force
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KIT_ROOT = path.resolve(HERE, '..')
const KIT_SRC = path.join(KIT_ROOT, 'src')

function parseArgs(argv) {
  const options = { out: '', force: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out' || arg === '-o') options.out = argv[++i]
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--force' || arg === '-f') options.force = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数: ${arg}`)
  }
  return options
}

function listFiles(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'))
  }
  return out.sort()
}

function hashFiles(root, files) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update(fs.readFileSync(path.join(root, file)))
  }
  return hash.digest('hex')
}

export function syncKit({ outDir, force = false } = {}) {
  if (!outDir) throw new Error('syncKit: outDir 必填')
  const target = path.resolve(outDir)
  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target)
    if (!force && entries.length > 0 && !entries.includes('INFRA_MANIFEST.json')) {
      throw new Error(`目标目录非空且不是 kit 快照: ${target}（使用 --force 覆盖）`)
    }
    fs.rmSync(target, { recursive: true, force: true })
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'package.json'), 'utf8'))
  const files = listFiles(KIT_SRC)
  fs.mkdirSync(target, { recursive: true })
  for (const file of files) {
    const dest = path.join(target, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(KIT_SRC, file), dest)
  }

  const manifest = {
    name: pkg.name,
    version: pkg.version,
    source: 'packages/@capyclaw/plugin-kit/src',
    syncedAt: new Date().toISOString(),
    hash: hashFiles(KIT_SRC, files),
    files,
  }
  fs.writeFileSync(path.join(target, 'INFRA_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { target, manifest }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  }
  if (options.help || !options.out) {
    console.log('用法: node packages/@capyclaw/plugin-kit/bin/sync.mjs --out <plugin>/server/infra [--force]')
    process.exit(options.help ? 0 : 1)
  }
  try {
    const result = syncKit({ outDir: options.out, force: options.force })
    console.log(`✓ kit ${result.manifest.version} 已同步到 ${result.target}（${result.manifest.files.length} 个文件）`)
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
