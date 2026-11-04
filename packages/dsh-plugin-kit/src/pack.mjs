/** 插件打包：按 package.json files 收集文件、自检（含 manifest 语义校验）、写 ZIP。 */
import fs from 'node:fs'
import path from 'node:path'
import { writeZipFromDir, listZipEntries } from './zip.mjs'

/**
 * suite/domain manifest 的语义校验器由外部注入。
 *
 * 为什么不在本模块静态 import：`@capyclaw/plugin-kit` 是**可独立发布**的插件 SDK，
 * 而语义校验规则住在 `dsh-suite-kit`（编排层）。硬 import 会让本包在 npm 上
 * 必须连带发布 suite-kit，并把它内部的相对路径问题一起暴露给消费者。
 *
 * 用法（打包工具侧）：
 *   import { setManifestValidators } from '@capyclaw/plugin-kit/packaging/pack'
 *   setManifestValidators({ validateSuiteManifest, validateDomainManifest })
 * 未注入时只做结构校验，并在 warnings 里明确说明语义校验被跳过。
 */
let injectedValidators = null

export function setManifestValidators(validators) {
  injectedValidators = validators && typeof validators === 'object' ? validators : null
}

export function getManifestValidators() {
  return injectedValidators
}

const ALWAYS_INCLUDE = ['package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md']
const DEFAULT_EXCLUDES = ['node_modules', '.git', '.DS_Store', 'dist', 'build', 'coverage', '.temp-pack']

function normalize(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function globToRegExp(glob) {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') out += '[^/]'
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

function matches(rel, pattern) {
  const p = normalize(pattern)
  if (!p.includes('*') && !p.includes('?')) return rel === p || rel.startsWith(p + '/')
  return globToRegExp(p).test(rel)
}

function exists(dir, rel) {
  return fs.existsSync(path.join(dir, rel))
}

function walk(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'))
  }
  return out.sort()
}

function expandEntry(srcDir, entry) {
  const rel = normalize(entry)
  if (rel.includes('*') || rel.includes('?')) {
    return walk(srcDir).filter((file) => matches(file, rel))
  }
  if (!exists(srcDir, rel)) return []
  const full = path.join(srcDir, rel)
  if (fs.statSync(full).isDirectory()) return walk(full).map((file) => `${rel}/${file}`)
  return [rel]
}

export function collectPluginFiles(srcDir, pkg) {
  const includes = []
  const excludes = [...DEFAULT_EXCLUDES, ...(pkg.files || []).filter((item) => String(item).startsWith('!')).map((item) => normalize(String(item).slice(1)))]
  const declared = (pkg.files || []).filter((item) => !String(item).startsWith('!')).map(String)

  for (const item of ALWAYS_INCLUDE) if (exists(srcDir, item) && !includes.includes(item)) includes.push(item)
  if (!declared.length) {
    for (const item of fs.readdirSync(srcDir)) {
      const rel = normalize(item)
      if (excludes.some((ex) => matches(rel, ex))) continue
      if (includes.includes(rel)) continue
      includes.push(rel)
    }
  } else {
    for (const item of declared) {
      const expanded = expandEntry(srcDir, item)
      if (!expanded.length) throw new Error(`package.json files 条目不存在: ${item}`)
      for (const file of expanded) if (!includes.includes(file)) includes.push(file)
    }
  }

  const files = includes
    .filter((rel) => !excludes.some((ex) => matches(rel, ex)))
    .sort()
  if (!files.includes('package.json')) throw new Error('打包结果缺少 package.json')
  return files
}

function copyFile(srcDir, destDir, rel) {
  const src = path.join(srcDir, rel)
  const dest = path.join(destDir, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

export function validateStaged(stagedDir, pkg) {
  const errors = []
  if (!fs.existsSync(path.join(stagedDir, 'package.json'))) errors.push('缺少 package.json')
  if (pkg.main && !fs.existsSync(path.join(stagedDir, pkg.main))) errors.push(`缺少入口文件: ${pkg.main}`)
  const patch = pkg.dsh?.bundle?.patch
  if (!patch) errors.push('缺少 dsh.bundle.patch 配置')
  else if (!fs.existsSync(path.join(stagedDir, patch))) errors.push(`缺少 cordis patch: ${patch}`)
  if (pkg.dsh?.suite && !fs.existsSync(path.join(stagedDir, pkg.dsh.suite))) {
    errors.push(`缺少 suite manifest: ${pkg.dsh.suite}`)
  }
  if (errors.length) throw new Error(`打包自检失败:\n- ${errors.join('\n- ')}`)
  return true
}

/** manifest 语义校验：若已注入 dsh-suite-kit 的校验器则用同一套规则（与安装侧一致），
 *  否则只做结构校验并在 warnings 里说明。返回 { errors, warnings }；不传 baseDir——
 *  ZIP 内引用的兄弟包路径在包外，存在性检查留给安装侧。 */
export function validateManifests(stagedDir, pkg) {
  const errors = []
  const warnings = []
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(stagedDir, rel), 'utf8'))
  const suiteRel = pkg.dsh?.suite
  if (suiteRel) {
    if (!injectedValidators?.validateSuiteManifest) {
      warnings.push(`未注入 suite 语义校验器，已跳过 ${suiteRel} 的语义检查（仅校验存在性）`)
    } else {
      try {
        const result = injectedValidators.validateSuiteManifest(readJson(suiteRel))
        errors.push(...result.errors)
        warnings.push(...result.warnings)
      } catch (error) {
        errors.push(`suite manifest 解析失败 (${suiteRel}): ${error.message}`)
      }
    }
  }
  const domainRel = pkg.dsh?.domain || (fs.existsSync(path.join(stagedDir, 'dsh-domain.json')) ? 'dsh-domain.json' : null)
  if (domainRel) {
    if (!injectedValidators?.validateDomainManifest) {
      warnings.push(`未注入 domain 语义校验器，已跳过 ${domainRel} 的语义检查（仅校验存在性）`)
    } else {
      try {
        const result = injectedValidators.validateDomainManifest(readJson(domainRel))
        errors.push(...result.errors)
        warnings.push(...result.warnings)
      } catch (error) {
        errors.push(`domain manifest 解析失败 (${domainRel}): ${error.message}`)
      }
    }
  }
  return { errors, warnings }
}

/**
 * 把插件复制到 staging 目录。
 * @param {{srcDir:string,destDir:string}} options
 */
export function stagePlugin({ srcDir, destDir }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'))
  const files = collectPluginFiles(srcDir, pkg)
  fs.rmSync(destDir, { recursive: true, force: true })
  for (const file of files) copyFile(srcDir, destDir, file)
  validateStaged(destDir, pkg)
  const { errors, warnings } = validateManifests(destDir, pkg)
  if (errors.length) throw new Error(`打包自检失败（manifest 语义校验）:\n- ${errors.join('\n- ')}`)
  return { pkg, files, warnings }
}

/** 生成插件 ZIP，返回输出路径和条目。 */
export function packPlugin({ srcDir, outDir, name }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'))
  const safeName = String(name || pkg.name).replace(/^@/, '').replace(/[\\/]/g, '-')
  const outFile = path.join(outDir, `${safeName}-v${pkg.version}.zip`)
  const staging = path.join(outDir, `.stage-${safeName}-${process.pid}`)
  try {
    const staged = stagePlugin({ srcDir, destDir: staging })
    writeZipFromDir(staging, outFile)
    return { outFile, files: staged.files, entries: listZipEntries(outFile), pkg: staged.pkg, warnings: staged.warnings }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
