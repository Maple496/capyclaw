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

export function lintSkills({ skillsRoot = join(ROOT, 'src', 'skills'), contractPath = join(ROOT, 'contract', 'ppt-contract.json') } = {}) {
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

    const toolTokens = [...body.matchAll(/\bppt_[a-z][a-z0-9_]*\b/g)].map((match) => match[0])
    for (const token of toolTokens) {
      if (!tools.has(token)) errors.push(`${dir}: 引用了不存在的工具 ${token}`)
    }
    if (dir.startsWith('pptmaster-') && toolTokens.length) {
      errors.push(`${dir}: pptmaster 技能不得引用具体 ppt_* 工具，应交给 pptist-api`)
    }
    if (dir === 'pptist-api' && /SCQA|金字塔|一页一观点|反 AI slop/.test(body)) {
      errors.push('pptist-api: 混入了叙事/设计规则，应交给 pptmaster-*')
    }
    for (const match of body.matchAll(/\bpptist-[a-z0-9-]+\b/g)) {
      if (!names.has(match[0])) errors.push(`${dir}: 引用了不存在的技能 ${match[0]}`)
    }
    /* references 引用必须能解析：本技能/任一技能目录，或构建期生成的 tool-contract.md */
    for (const match of body.matchAll(/references\/([A-Za-z0-9._-]+\.md)/g)) {
      const ref = match[1]
      if (ref === 'tool-contract.md') continue
      const found = dirs.some((skill) => existsSync(join(skillsRoot, skill, 'references', ref)))
      if (!found) errors.push(`${dir}: 引用了不存在的参考文件 references/${ref}`)
    }
    for (const stale of ['slideIndex', 'themeColors=', 'ppt_style(op']) {
      if (body.includes(stale)) warnings.push(`${dir}: 可能过时的写法 "${stale}"`)
    }
  }

  const router = readFileSync(join(skillsRoot, 'ppt', 'SKILL.md'), 'utf8')
  for (const name of names) {
    if (name !== 'ppt' && !router.includes(name)) errors.push(`ppt 路由没有提到子技能 ${name}`)
  }

  return { ok: errors.length === 0, errors, warnings, skills: dirs.length, tools: tools.size }
}

const cli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (cli) {
  const result = lintSkills()
  for (const warning of result.warnings) console.log(`! ${warning}`)
  for (const error of result.errors) console.log(`✗ ${error}`)
  console.log(result.ok
    ? `✓ skill lint 通过（${result.skills} 个技能，${result.tools} 个工具）`
    : '✗ skill lint 未通过')
  process.exit(result.ok ? 0 : 1)
}
