#!/usr/bin/env node
/**
 * 技能 lint：frontmatter、正文长度、工具名与契约交叉校验。
 *
 * 用法：node scripts/lint-skills.mjs [--check]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function frontmatter(raw, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!match) return { error: `${file}: 缺少 frontmatter` }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const hit = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (hit) meta[hit[1]] = hit[2].replace(/^['"]|['"]$/g, '').trim()
  }
  return { meta, body: raw.slice(match[0].length).trim() }
}

export function lintSkills({ skillsRoot = join(ROOT, 'src', 'skills'), contractPath = join(ROOT, 'contract', 'canvas-contract.json') } = {}) {
  const errors = []
  const warnings = []
  if (!existsSync(skillsRoot)) return { ok: false, errors: [`技能目录不存在: ${skillsRoot}`], warnings }
  if (!existsSync(contractPath)) return { ok: false, errors: [`契约快照不存在: ${contractPath}`], warnings }

  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  const tools = new Set((contract.tools || []).map((tool) => tool.name))
  const dirs = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const names = new Set(dirs)

  for (const dir of dirs) {
    const file = join(skillsRoot, dir, 'SKILL.md')
    if (!existsSync(file)) {
      errors.push(`${dir}: 缺少 SKILL.md`)
      continue
    }
    const parsed = frontmatter(readFileSync(file, 'utf8'), file)
    if (parsed.error) {
      errors.push(parsed.error)
      continue
    }
    const { meta, body } = parsed
    if (meta.name !== dir) errors.push(`${dir}: frontmatter.name 必须是 ${dir}`)
    if (!meta.description || meta.description.length > 500) errors.push(`${dir}: description 缺失或超过 500 字`)
    if (!meta.whenToUse) errors.push(`${dir}: 缺少 whenToUse`)
    if (body.length < 120) warnings.push(`${dir}: 正文偏短（${body.length} 字），确认不是空壳`)

    const toolTokens = [...body.matchAll(/\bcanvas_[a-z][a-z0-9_]*\b/g)].map((match) => match[0])
    for (const token of toolTokens) {
      if (!tools.has(token)) errors.push(`${dir}: 引用了不存在的工具 ${token}`)
    }
    if (dir === 'canvas' && toolTokens.length > 3) {
      warnings.push('canvas: 路由技能引用了较多具体工具，注意只保留探测/读取类')
    }
    for (const match of body.matchAll(/\bcanvasist-[a-z0-9-]+\b/g)) {
      if (!names.has(match[0])) errors.push(`${dir}: 引用了不存在的技能 ${match[0]}`)
    }
    /* references 引用必须能解析：本技能/任一技能目录，或构建期生成的 tool-contract.md */
    for (const match of body.matchAll(/references\/([A-Za-z0-9._-]+\.md)/g)) {
      const ref = match[1]
      if (ref === 'tool-contract.md') continue
      const found = dirs.some((skill) => existsSync(join(skillsRoot, skill, 'references', ref)))
      if (!found) errors.push(`${dir}: 引用了不存在的参考文件 references/${ref}`)
    }
  }

  for (const required of ['canvas', 'canvasist-api', 'canvasist-authoring', 'canvasist-editing']) {
    if (!names.has(required)) errors.push(`缺少核心技能: ${required}`)
  }

  return { ok: errors.length === 0, errors, warnings }
}

/* CLI 直跑（build-plugin 与 npm run lint:skills 都会 import 上面的函数）。 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lint = lintSkills()
  for (const warning of lint.warnings) console.error('! ' + warning)
  if (!lint.ok) {
    for (const error of lint.errors) console.error('✗ ' + error)
    process.exit(1)
  }
  console.log(`✓ 技能 lint 通过（${readdirSync(join(ROOT, 'src', 'skills')).length} 个技能）`)
}
