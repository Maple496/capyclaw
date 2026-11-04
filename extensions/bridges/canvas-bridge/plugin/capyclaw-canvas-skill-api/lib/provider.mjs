/** 通用 skill provider：从目录扫描 kebab-case SKILL.md，按需加载正文。 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RANK = 600

function parseSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!frontmatter?.[1]) throw new Error(`skill ${path} 缺少 YAML frontmatter`)
  const meta = {}
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match) meta[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim()
  }
  if (!meta.name || !meta.description) throw new Error(`skill ${path} 缺少 name/description`)
  if (!NAME_RE.test(meta.name)) throw new Error(`skill ${path} name 必须是 kebab-case`)
  return {
    name: meta.name,
    description: meta.description,
    whenToUse: meta.whenToUse || undefined,
    content: raw.slice(frontmatter[0].length).trim(),
  }
}

/**
 * @param {{
 *   assetRoot: string,
 *   skillDirs: string[],
 *   providerName?: string,
 *   contractRoot?: string,
 *   contractNote?: (version: string) => string
 * }} config
 */
export function createSkillProvider(config) {
  const assetRoot = config.assetRoot
  if (!assetRoot || !isAbsolute(assetRoot)) throw new Error('createSkillProvider: assetRoot 必须是绝对路径')
  let contract = null
  if (config.contractRoot) {
    try {
      contract = JSON.parse(readFileSync(join(config.contractRoot, config.contractFile || 'contract.json'), 'utf8'))
    } catch { /* 非技能包可以没有契约快照 */ }
  }
  const dirs = config.skillDirs || []
  if (!dirs.length) throw new Error('createSkillProvider: skillDirs 不能为空')
  const candidates = dirs.map((dir) => {
    const directory = join(assetRoot, dir)
    const locator = join(directory, 'SKILL.md')
    const parsed = parseSkill(readFileSync(locator, 'utf8'), locator)
    if (parsed.name !== dir) throw new Error(`skill ${locator} name 必须是 ${dir}`)
    return {
      name: parsed.name,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: config.providerName || 'dsh-plugin',
      source: 'bundled',
      rank: RANK,
      resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
      locator,
    }
  })
  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]))
  const noteFor = (name) => (contract && config.contractNote
    ? config.contractNote(contract.contractVersion, name)
    : '')

  return {
    name: config.providerName || 'dsh-plugin',
    list: () => Promise.resolve(candidates),
    async get(candidate, options = {}) {
      const hit = byName.get(candidate.name)
      if (!hit) throw new Error(`未知 skill ${candidate.name}`)
      const raw = await readFile(hit.locator, { encoding: 'utf8', signal: options.signal })
      const parsed = parseSkill(raw, hit.locator)
      const { rank: _rank, locator: _locator, ...summary } = hit
      const note = noteFor(candidate.name)
      return { ...summary, content: parsed.content + (note ? `\n\n---\n\n${note}` : '') }
    },
  }
}
