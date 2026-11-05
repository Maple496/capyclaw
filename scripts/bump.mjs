#!/usr/bin/env node
/**
 * 统一版本 bump 工具（取代 bump-patch.mjs / sync-suite-versions.mjs 两个
 * 硬编码清单脚本——它们的映射表每次发布都要手改，正是同版本冲突反复出现的根源）。
 *
 * 两个动作对应真实发布节奏：
 *   1. bump：提升本地版本号——package.json、bridge build 脚本的 SKILL_PACKAGES
 *      表行、workbench 的 src/mcp/contract.mjs PACKAGE_VERSION、suite 的
 *      dsh-suite.json 顶层 version。**不动任何引用**：suite 引用跟踪的是 npm
 *      已发布版本（如本地 2.2.4 而引用 ^2.2.3），何时收口由发布者决定。
 *   2. sync-refs：把所有 dsh-suite.json / services.json 里对本仓包的 ^ 引用
 *      重写为 ^本地当前版本（发布完成、准备发 suite 时的收口动作）。
 *      名字→版本映射从磁盘实时发现，无硬编码。
 *
 * 用法：
 *   node scripts/bump.mjs <pkg> <patch|minor|major> [--write]   # 单包（npm 名或目录名）
 *   node scripts/bump.mjs --all <patch|minor|major> [--write]   # 全部可发布包
 *   node scripts/bump.mjs <pkg> --set 1.2.3 [--write]           # 显式设版本
 *   node scripts/bump.mjs --sync-refs [--write]
 *
 * 默认 dry-run（只打印计划）；--write 才落盘。
 * bump 落盘后记得：npm run build（重生成 lock/契约快照）→ npm run gen-registry。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROOT, allPublishableDirs, pkgOf } from './lib/publish-set.mjs'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const SYNC_REFS = args.includes('--sync-refs')
const positional = args.filter((a) => !a.startsWith('--'))
const ALL = positional[0] === '--all' || args.includes('--all')

const usage = () => {
  console.log('用法见文件头注释。示例：\n  node scripts/bump.mjs @capyclaw/ppt-skill-narrative patch --write\n  node scripts/bump.mjs --all patch --write\n  node scripts/bump.mjs --sync-refs --write')
  process.exitCode = 1
}

/** 读文本保持原始字节；写文本统一 LF（仓库 .gitattributes 已锁 eol=lf）。 */
const readText = (file) => fs.readFileSync(file, 'utf8')
const writeText = (file, text) => fs.writeFileSync(file, text.replaceAll('\r\n', '\n'))
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

function nextVersion(current, level, explicit) {
  if (explicit) return explicit
  const parts = String(current).split('.').map(Number)
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`无法解析版本号 ${current}（只支持 X.Y.Z）`)
  }
  if (level === 'major') { parts[0] += 1; parts[1] = 0; parts[2] = 0 }
  else if (level === 'minor') { parts[1] += 1; parts[2] = 0 }
  else if (level === 'patch') { parts[2] += 1 }
  else throw new Error(`未知级别 ${level}（patch|minor|major）`)
  return parts.join('.')
}

/** 收集一个包 bump 到 next 时需要落盘的所有编辑（不写文件）。 */
function planBump(dir, next) {
  const pkg = pkgOf(dir)
  const edits = []

  /* 1. package.json */
  edits.push({
    file: path.join(dir, 'package.json'),
    apply() {
      const json = JSON.parse(readText(this.file))
      json.version = next
      writeText(this.file, JSON.stringify(json, null, 2) + '\n')
    },
    note: `version ${pkg.version} -> ${next}`,
  })

  const bridge = /bridges[\\/]([a-z]+)-bridge/.exec(dir)?.[1]

  /* 2. skill 包：build-plugin.mjs 的 SKILL_PACKAGES 表行 */
  if (/-skill-/.test(pkg.name) && bridge) {
    const buildScript = path.join(ROOT, 'extensions', 'bridges', `${bridge}-bridge`, 'scripts', 'build-plugin.mjs')
    edits.push({
      file: buildScript,
      apply() {
        const lines = readText(this.file).split('\n')
        const row = lines.findIndex((l) => l.includes(`name: '${pkg.name}'`) && l.includes("version: '"))
        if (row < 0) throw new Error(`${rel(buildScript)} 中未找到 ${pkg.name} 的表行`)
        lines[row] = lines[row].replace(/(version: ')[^']+(')/, `$1${next}$2`)
        writeText(this.file, lines.join('\n'))
      },
      note: `SKILL_PACKAGES 表行 ${pkg.version} -> ${next}`,
    })
  }

  /* 3. workbench：contract.mjs 的 PACKAGE_VERSION（<bridge>/src/mcp/contract.mjs） */
  if (pkg.name === `@capyclaw/${bridge}-workbench`) {
    const contractFile = path.resolve(path.join(path.dirname(dir), '..', 'src', 'mcp', 'contract.mjs'))
    if (fs.existsSync(contractFile)) {
      edits.push({
        file: contractFile,
        apply() {
          writeText(this.file, readText(this.file).replace(
            /(export const PACKAGE_VERSION = ')[^']+(')/, `$1${next}$2`))
        },
        note: `PACKAGE_VERSION ${pkg.version} -> ${next}`,
      })
    }
  }

  /* 4. suite：dsh-suite.json 顶层 version（与 package.json 保持镜像） */
  const suiteManifest = path.join(dir, 'dsh-suite.json')
  if (pkg.dsh?.suite && fs.existsSync(suiteManifest)) {
    edits.push({
      file: suiteManifest,
      apply() {
        const json = JSON.parse(readText(this.file))
        json.version = next
        writeText(this.file, JSON.stringify(json, null, 2) + '\n')
      },
      note: `dsh-suite.json version -> ${next}`,
    })
  }

  return edits
}

/** sync-refs：重写所有 dsh-suite.json / services.json 中对本仓包的 ^ 引用。 */
function planSyncRefs() {
  const versions = new Map() // npm 名 / 目录名 -> 本地当前版本
  for (const dir of allPublishableDirs()) {
    const pkg = pkgOf(dir)
    versions.set(pkg.name, pkg.version)
    versions.set(pkg.name.split('/').pop(), pkg.version)
  }
  const manifests = []
  const walk = (base) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'archive'].includes(entry.name)) continue
      const full = path.join(base, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'dsh-suite.json' || entry.name === 'services.json') manifests.push(full)
      /* 注意：不能跳过 plugin/ ——三个 suite 的 dsh-suite.json（引用的主要消费方）就在其中 */
    }
  }
  for (const base of ['packages', 'extensions', 'tools']) walk(path.join(ROOT, base))

  const edits = []
  for (const file of manifests) {
    const raw = readText(file)
    const json = JSON.parse(raw)
    const changes = []
    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      for (const [key, val] of Object.entries(node)) {
        if (val && typeof val === 'object' && typeof val.version === 'string' && versions.has(key)) {
          const want = '^' + versions.get(key)
          if (val.version !== want) {
            changes.push(`${key} ${val.version} -> ${want}`)
            val.version = want
          }
        }
        visit(val)
      }
    }
    visit(json)
    if (!changes.length) continue
    edits.push({
      file,
      note: changes.join(', '),
      apply: () => writeText(file, JSON.stringify(json, null, 2) + '\n'),
    })
  }
  return edits
}

async function main() {
  if (SYNC_REFS) {
    const edits = planSyncRefs()
    if (!edits.length) { console.log('· 所有引用已跟踪本地版本，无需更新'); return }
    console.log(`sync-refs 计划（${edits.length} 个文件${WRITE ? '' : '，dry-run'}）：`)
    for (const edit of edits) {
      console.log(`  ${rel(edit.file)}: ${edit.note}`)
      if (WRITE) edit.apply()
    }
    if (WRITE) console.log('\n已落盘。记得 npm run build（lock 会随之更新）。')
    return
  }

  const levelOrSet = args.find((a) => a === 'patch' || a === 'minor' || a === 'major')
  const setIdx = args.indexOf('--set')
  const explicit = setIdx >= 0 ? args[setIdx + 1] : null
  if (!explicit && !levelOrSet) return usage()

  let targets
  if (ALL) targets = allPublishableDirs()
  else {
    const { packageDirIndex } = await import('./lib/publish-set.mjs')
    const idx = packageDirIndex()
    const dir = idx.get(positional[0])
    if (!dir) { console.error(`未找到包 ${positional[0]}（可用 npm 名或目录名）`); process.exitCode = 1; return }
    targets = [dir]
  }

  const allEdits = []
  for (const dir of targets) {
    const pkg = pkgOf(dir)
    const next = nextVersion(pkg.version, levelOrSet, explicit)
    if (next === pkg.version) { console.log(`· ${pkg.name} 已是 ${next}，跳过`); continue }
    const edits = planBump(dir, next)
    console.log(`${pkg.name} ${pkg.version} -> ${next}${WRITE ? '' : '（dry-run）'}`)
    for (const edit of edits) {
      console.log(`  ${rel(edit.file)}: ${edit.note}`)
      if (WRITE) edit.apply()
    }
    allEdits.push(...edits)
  }
  if (WRITE && allEdits.length) {
    console.log(`\n已落盘 ${allEdits.length} 处。下一步：npm run build（重生成 lock/契约）→ npm run gen-registry。`)
  }
}

main().catch((error) => {
  console.error('bump 异常:', error.message)
  process.exitCode = 1
})
