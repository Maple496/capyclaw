/**
 * 契约快照校验：workbench 与同目录 skill 包的 contract/ppt-contract.json
 * major 不一致时，MCP 工具调用被拒绝（ppt_capabilities 除外，便于诊断）。
 *
 * 开发态（plugin/）和发布态（components/）里 skill 包都是 workbench 的兄弟目录，
 * 因此无需配置文件；只装 workbench 时 checked=0，不拦截。
 * skill 包的磁盘目录名是 capyclaw-ppt-skill-*（dev 树）；npm 安装态 workbench 的
 * 父目录就是 node_modules/@capyclaw 作用域目录，skill 包以 ppt-skill-* 直接
 * 兄弟的形式出现——两种形态都扫。
 */
import fs from 'node:fs'
import path from 'node:path'

const SKILL_PREFIX = 'capyclaw-ppt-skill-'
const SCOPED_SKILL_PREFIX = 'ppt-skill-'
const SCOPE_DIR = '@capyclaw'

function majorOf(version) {
  return String(version || '').split('.')[0]
}

export function inspectContractSnapshots(packageDir, contractVersion, { prefix = SKILL_PREFIX } = {}) {
  const expectedMajor = majorOf(contractVersion)
  const report = { expected: contractVersion || '', checked: 0, ok: true, mismatched: [] }
  const parent = path.dirname(packageDir)

  /* 候选目录：dev 树 capyclaw-ppt-skill-*（旧磁盘名）；npm 扁平安装 ppt-skill-*
   * （父目录即 @capyclaw 作用域）；嵌套 @capyclaw/ 下的 ppt-skill-*。 */
  const candidates = []
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return report
  }
  const inScope = path.basename(parent) === SCOPE_DIR
  for (const entry of entries) {
    if (entry.name.startsWith(prefix)) {
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
