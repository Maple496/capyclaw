#!/usr/bin/env node
/**
 * 技能 lint：frontmatter、正文长度、工具名与契约交叉校验。
 * 公共核在 scripts/lib/lint-skills-core.mjs；本文件只保留 PPT 侧路由规则。
 *
 * 用法：node scripts/lint-skills.mjs [--check]
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSkillLinter } from '../../../../scripts/lib/lint-skills-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const coreLint = createSkillLinter({
  toolPrefix: 'ppt',
  skillPrefix: 'pptist',
  contractFile: 'ppt-contract.json',
  collectStats: true,
  checkSkill({ dir, body, toolTokens, errors, warnings }) {
    if (dir.startsWith('pptmaster-') && toolTokens.length) {
      errors.push(`${dir}: pptmaster 技能不得引用具体 ppt_* 工具，应交给 pptist-api`)
    }
    if (dir === 'pptist-api' && /SCQA|金字塔|一页一观点|反 AI slop/.test(body)) {
      errors.push('pptist-api: 混入了叙事/设计规则，应交给 pptmaster-*')
    }
    for (const stale of ['slideIndex', 'themeColors=', 'ppt_style(op']) {
      if (body.includes(stale)) warnings.push(`${dir}: 可能过时的写法 "${stale}"`)
    }
  },
  afterAll({ names, errors, skillsRoot }) {
    const router = readFileSync(join(skillsRoot, 'ppt', 'SKILL.md'), 'utf8')
    for (const name of names) {
      if (name !== 'ppt' && !router.includes(name)) errors.push(`ppt 路由没有提到子技能 ${name}`)
    }
  },
})

export function lintSkills({ skillsRoot = join(ROOT, 'src', 'skills'), contractPath = join(ROOT, 'contract', 'ppt-contract.json') } = {}) {
  return coreLint({ skillsRoot, contractPath })
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
