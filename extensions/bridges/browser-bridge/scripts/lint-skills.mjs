#!/usr/bin/env node
/**
 * 技能 lint：frontmatter、正文长度、工具名与契约交叉校验。
 * 公共核在 scripts/lib/lint-skills-core.mjs；本文件只保留 Browser 侧规则。
 *
 * 用法：node scripts/lint-skills.mjs [--check]
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSkillLinter } from '../../../../scripts/lib/lint-skills-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const coreLint = createSkillLinter({
  toolPrefix: 'browser',
  skillPrefix: 'browser',
  contractFile: 'browser-contract.json',
  checkSkill({ dir, toolTokens, warnings }) {
    if (dir === 'browser' && toolTokens.length > 3) {
      warnings.push('browser: 路由技能引用了较多具体工具，注意只保留探测/读取类')
    }
  },
  afterAll({ names, errors }) {
    for (const required of ['browser', 'browser-api', 'browser-ops']) {
      if (!names.has(required)) errors.push(`缺少核心技能: ${required}`)
    }
  },
})

export function lintSkills({ skillsRoot = join(ROOT, 'src', 'skills'), contractPath = join(ROOT, 'contract', 'browser-contract.json') } = {}) {
  return coreLint({ skillsRoot, contractPath })
}

/* CLI 直跑（build-plugin 与 npm run lint:skills 都会 import 上面的函数）。 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lint = lintSkills()
  for (const warning of lint.warnings) console.error('! ' + warning)
  if (!lint.ok) {
    for (const error of lint.errors) console.error('✗ ' + error)
    process.exit(1)
  }
  console.log('✓ 技能 lint 通过')
}
