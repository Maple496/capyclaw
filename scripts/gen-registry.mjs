#!/usr/bin/env node
/**
 * 从各插件的 package.json 生成 capyclaw-registry.json，消除手写漂移。
 *
 * 用法：
 *   node scripts/gen-registry.mjs           # 写回 capyclaw-registry.json
 *   node scripts/gen-registry.mjs --check    # 只比对，不一致则 exit 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverPlugins } from '../tools/capyclaw-plugin-release/lib/index.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'capyclaw-registry.json')
const checkOnly = process.argv.includes('--check')

const CATEGORY_MAP = {
  tool: 'tools',
  ui: 'ui',
  service: 'services',
  bridge: 'bridges',
  suite: 'suites',
  skills: 'skills',
}

function entryOf(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  return {
    id: pkg.name.split('/').pop(),
    name: pkg.name,
    version: pkg.version,
    title: pkg.meta?.title || pkg.name,
    description: pkg.meta?.description || pkg.description || '',
    category: pkg.dsh?.category || '',
    platform: pkg.dsh?.platform || '',
    dsh: pkg.engines?.dsh || '',
    license: pkg.license || '',
    path: path.relative(ROOT, dir).split(path.sep).join('/'),
    directory: path.relative(ROOT, dir).split(path.sep).join('/'),
    bundle: Boolean(pkg.dsh?.bundle),
    client: Boolean(pkg.dsh?.client),
    suite: Boolean(pkg.dsh?.suite),
  }
}

const plugins = discoverPlugins().map(entryOf).sort((a, b) => a.name.localeCompare(b.name))

const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}
const next = {
  ...existing,
  generatedAt: new Date().toISOString(),
  generatedBy: 'scripts/gen-registry.mjs',
  categories: existing.categories || {},
  plugins,
}

// categories 按插件分类重算（保留已有分类名）
const categories = {}
for (const plugin of plugins) {
  const key = CATEGORY_MAP[plugin.category] || 'other'
  categories[key] = (categories[key] || 0) + 1
}
next.categories = categories

const text = `${JSON.stringify(next, null, 2)}\n`
const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''

if (checkOnly) {
  // 忽略 generatedAt（每次生成都变），只比对实质内容
  const strip = (obj) => {
    const { generatedAt: _ignored, ...rest } = obj
    return JSON.stringify(rest)
  }
  const prevObj = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null
  const same = prevObj && strip(prevObj) === strip(next)
  if (!same) {
    console.error('capyclaw-registry.json 与 package.json 不一致，请运行 npm run gen-registry')
    process.exitCode = 1
  } else {
    console.log('capyclaw-registry.json 一致')
  }
} else {
  fs.writeFileSync(OUT, text, 'utf8')
  console.log(`已生成 capyclaw-registry.json（${plugins.length} 个可发布插件）`)
}
