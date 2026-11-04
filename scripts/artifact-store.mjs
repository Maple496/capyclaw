#!/usr/bin/env node
/**
 * 本地公共插件 artifact store CLI。
 *
 *   node scripts/artifact-store.mjs pack --all
 *   node scripts/artifact-store.mjs pack packages/dsh-state-service
 *   node scripts/artifact-store.mjs list
 *   node scripts/artifact-store.mjs resolve dsh-state-service@0.1.0
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultArtifactRoot, listArtifacts, packPackage, resolvePackageSpec,
} from '../packages/dsh-suite-kit/src/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const command = args[0]
const rootAt = args.indexOf('--root')
const root = rootAt >= 0 ? path.resolve(args[rootAt + 1]) : defaultArtifactRoot()
const force = args.includes('--force')
const all = args.includes('--all')

const PUBLIC_DIRS = [
  'packages/dsh-plugin-kit',
  'packages/dsh-runtime-kit',
  'packages/dsh-service-host',
  'packages/dsh-tool-host',
  'packages/dsh-state-service',
  'packages/dsh-asset-service',
  'packages/dsh-editor-host',
  'packages/dsh-mcp-gateway',
  'bridges/ppt-bridge/plugin/dsh-ppt-workbench',
  'bridges/ppt-bridge/plugin/dsh-ppt-skills',
]

function packOne(dir) {
  const meta = packPackage(dir, { root, force })
  console.log(`✓ ${meta.name}@${meta.version}  ${meta.sha256.slice(0, 12)}…`)
}

if (command === 'pack') {
  const dirs = all ? PUBLIC_DIRS.map((dir) => path.join(ROOT, dir)) : args.slice(1).filter((item) => !item.startsWith('--') && path.resolve(item) !== root)
  if (!dirs.length) {
    console.error('用法: node scripts/artifact-store.mjs pack --all | pack <package-dir...> [--root <dir>] [--force]')
    process.exit(1)
  }
  for (const dir of dirs) packOne(path.resolve(dir))
} else if (command === 'list') {
  const rows = listArtifacts({ root })
  if (!rows.length) console.log(`(empty: ${root})`)
  for (const row of rows) console.log(`${row.name}@${row.version}  api=${row.apiVersion || '-'}  ${row.sha256.slice(0, 12)}…`)
} else if (command === 'resolve') {
  const spec = args[1]
  if (!spec) {
    console.error('用法: node scripts/artifact-store.mjs resolve <name@version>')
    process.exit(1)
  }
  console.log(JSON.stringify(resolvePackageSpec(spec, { root }), null, 2))
} else {
  console.error('用法: node scripts/artifact-store.mjs <pack|list|resolve> ...')
  process.exit(1)
}
