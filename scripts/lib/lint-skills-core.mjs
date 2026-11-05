/**
 * 技能 lint 公共核：frontmatter、正文长度、工具名/技能名/契约交叉校验。
 * ppt-bridge 与 canvas-bridge 的 lint-skills.mjs 在此之上只保留各自的路由规则。
 *
 * 用法（bridge 侧）：
 *   const { lintSkills } = createSkillLinter({ toolPrefix: 'ppt', ... })
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/**
 * @param {object} cfg
 *   toolPrefix   'ppt' | 'canvas'（工具名前缀 → 工具契约对账）
 *   skillPrefix  'pptist' | 'canvasist'（技能名前缀 → 技能目录对账）
 *   contractFile 'ppt-contract.json' | 'canvas-contract.json'
 *   checkSkill   可选：逐技能钩子（bridge 路由规则），入参
 *                { dir, body, toolTokens, errors, warnings, names, dirs, skillsRoot }
 *   afterAll     可选：全量钩子，入参 { dirs, names, errors, warnings, skillsRoot, tools }
 *   collectStats 可选：true 时结果附 skills/tools 计数（ppt CLI 摘要用）
 */
export function createSkillLinter(cfg) {
  const toolRe = new RegExp(`\\b${cfg.toolPrefix}_[a-z][a-z0-9_]*\\b`, 'g')
  const skillRe = new RegExp(`\\b${cfg.skillPrefix}-[a-z0-9-]+\\b`, 'g')

  return function lintSkills({ skillsRoot, contractPath } = {}) {
    const errors = []
    const warnings = []
    if (!skillsRoot || !contractPath) {
      throw new Error('lintSkills 需要 skillsRoot 与 contractPath（bridge 侧用各自默认值传入）')
    }
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

      const toolTokens = [...body.matchAll(toolRe)].map((match) => match[0])
      for (const token of toolTokens) {
        if (!tools.has(token)) errors.push(`${dir}: 引用了不存在的工具 ${token}`)
      }
      if (cfg.checkSkill) {
        cfg.checkSkill({ dir, body, toolTokens, errors, warnings, names, dirs, skillsRoot })
      }
      for (const match of body.matchAll(skillRe)) {
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

    if (cfg.afterAll) cfg.afterAll({ dirs, names, errors, warnings, skillsRoot, tools })

    const result = { ok: errors.length === 0, errors, warnings }
    if (cfg.collectStats) {
      result.skills = dirs.length
      result.tools = tools.size
    }
    return result
  }
}
