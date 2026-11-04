/**
 * 契约快照校验：workbench 与同目录 skill 包的 contract/ppt-contract.json
 * major 不一致时，MCP 工具调用被拒绝（ppt_capabilities 除外，便于诊断）。
 *
 * 开发态（plugin/）和发布态（components/）里 skill 包都是 workbench 的兄弟目录，
 * 因此无需配置文件；只装 workbench 时 checked=0，不拦截。
 */
import fs from 'node:fs'
import path from 'node:path'

const SKILL_PREFIX = 'dsh-ppt-skill-'

function majorOf(version) {
  return String(version || '').split('.')[0]
}

export function inspectContractSnapshots(packageDir, contractVersion, { prefix = SKILL_PREFIX } = {}) {
  const expectedMajor = majorOf(contractVersion)
  const report = { expected: contractVersion || '', checked: 0, ok: true, mismatched: [] }
  const parent = path.dirname(packageDir)

  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return report
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue
    const dir = path.join(parent, entry.name)
    try {
      /* junction/软链接也要跟随；Dirent.isDirectory() 对链接为 false。 */
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }

    report.checked++
    const file = path.join(dir, 'contract', 'ppt-contract.json')
    let snapshot = null
    try {
      snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      report.mismatched.push({ package: entry.name, expected: contractVersion, actual: null })
      continue
    }
    const actualMajor = majorOf(snapshot.contractVersion)
    if (actualMajor !== expectedMajor) {
      report.mismatched.push({ package: entry.name, expected: contractVersion, actual: snapshot.contractVersion || null })
    }
  }

  report.ok = report.mismatched.length === 0
  return report
}

export function describeMismatch(report) {
  return report.mismatched
    .map((item) => `${item.package}(snapshot=${item.actual || 'missing'}, runtime=${item.expected})`)
    .join('；')
}
