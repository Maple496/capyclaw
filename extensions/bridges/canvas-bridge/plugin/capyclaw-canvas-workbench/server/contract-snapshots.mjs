/**
 * 契约快照校验：workbench 与同目录 skill 包的 contract/canvas-contract.json
 * major 不一致时，MCP 工具调用被拒绝（canvas_capabilities 除外，便于诊断）。
 *
 * 开发态（plugin/）和发布态里 skill 包都是 workbench 的兄弟目录。
 * 机制与 ppt-bridge 的 contract-snapshots 相同，只换前缀与契约文件名。
 */
import fs from 'node:fs'
import path from 'node:path'

const SKILL_PREFIX = 'dsh-canvas-skill-'
const SCOPED_SKILL_PREFIX = 'canvas-skill-'
const CONTRACT_FILE = 'canvas-contract.json'
const SCOPE_DIR = '@capyclaw'

function majorOf(version) {
  return String(version || '').split('.')[0]
}

export function inspectContractSnapshots(packageDir, contractVersion) {
  const expectedMajor = majorOf(contractVersion)
  const report = { expected: contractVersion || '', checked: 0, ok: true, mismatched: [] }
  const parent = path.dirname(packageDir)

  const candidates = []
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return report
  }
  const inScope = path.basename(parent) === SCOPE_DIR
  for (const entry of entries) {
    if (entry.name.startsWith(SKILL_PREFIX)) {
      candidates.push({ name: entry.name, dir: path.join(parent, entry.name) })
    } else if (inScope && entry.name.startsWith(SCOPED_SKILL_PREFIX)) {
      candidates.push({ name: entry.name, dir: path.join(parent, entry.name) })
    } else if (entry.name === SCOPE_DIR) {
      let scoped
      try {
        scoped = fs.readdirSync(path.join(parent, entry.name), { withFileTypes: true })
      } catch { continue }
      for (const s of scoped) {
        if (s.name.startsWith(SCOPED_SKILL_PREFIX)) {
          candidates.push({ name: `${SCOPE_DIR}/${s.name}`, dir: path.join(parent, entry.name, s.name) })
        }
      }
    }
  }

  for (const { name, dir } of candidates) {
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }

    report.checked++
    const file = path.join(dir, 'contract', CONTRACT_FILE)
    let snapshot = null
    try {
      snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      report.mismatched.push({ package: name, expected: contractVersion, actual: null })
      continue
    }
    const actualMajor = majorOf(snapshot.contractVersion)
    if (actualMajor !== expectedMajor) {
      report.mismatched.push({ package: name, expected: contractVersion, actual: snapshot.contractVersion || null })
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
