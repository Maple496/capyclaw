/**
 * 单 skill 包测试：每个 skill 是独立 provider 包，不启动 DSH，
 * 只验证目录、frontmatter、按需加载和契约提示。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lintSkills } from '../scripts/lint-skills.mjs'
import { TOOLS } from '../src/mcp/tools.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PLUGIN = join(ROOT, 'plugin')
const SKILLS = join(ROOT, 'src', 'skills')
const WORKBENCH_CONTRACT = JSON.parse(readFileSync(
  join(PLUGIN, 'dsh-ppt-workbench', 'contract', 'ppt-contract.json'), 'utf8'))

const PACKAGES = [
  { pkg: 'dsh-ppt-skill-ppt', skill: 'ppt', slug: 'ppt' },
  { pkg: 'dsh-ppt-skill-narrative', skill: 'pptmaster-narrative', slug: 'narrative' },
  { pkg: 'dsh-ppt-skill-design', skill: 'pptmaster-design', slug: 'design' },
  { pkg: 'dsh-ppt-skill-api', skill: 'pptist-api', slug: 'api' },
  { pkg: 'dsh-ppt-skill-authoring', skill: 'pptist-authoring', slug: 'authoring' },
  { pkg: 'dsh-ppt-skill-editing', skill: 'pptist-editing', slug: 'editing' },
  { pkg: 'dsh-ppt-skill-visual-check', skill: 'pptist-visual-check', slug: 'visual-check' },
  { pkg: 'dsh-ppt-skill-research', skill: 'pptist-research', slug: 'research' },
]

test('8 个 skill 源存在且 frontmatter 完整', () => {
  for (const { skill } of PACKAGES) {
    const file = join(SKILLS, skill, 'SKILL.md')
    assert.ok(existsSync(file), `缺少 ${skill}/SKILL.md`)
    const raw = readFileSync(file, 'utf8')
    assert.match(raw, /^---\r?\n/u)
    assert.match(raw, new RegExp(`name:\\s*${skill}`))
    assert.match(raw, /description:\s*\S+/u)
    assert.match(raw, /whenToUse:\s*\S+/u)
  }
})

test('8 个单 skill 包结构完整', () => {
  for (const { pkg, skill } of PACKAGES) {
    const dir = join(PLUGIN, pkg)
    for (const file of ['package.json', 'cordis.patch.yml', 'lib/index.mjs', 'lib/provider.mjs',
      `skills/${skill}/SKILL.md`, 'contract/ppt-contract.json']) {
      assert.ok(existsSync(join(dir, file)), `${pkg} 缺少 ${file}`)
    }
  }
})

test('每个 provider 只列一个 skill，并按类型附带契约提示', async () => {
  for (const { pkg, skill, slug } of PACKAGES) {
    const mod = await import(pathToFileURL(join(PLUGIN, pkg, 'lib', 'index.mjs')).href)
    const provider = mod.createProvider()
    const list = await provider.list()
    assert.equal(list.length, 1, `${pkg} 应只列一个 skill`)
    assert.equal(list[0].name, skill)
    assert.equal(list[0].provider, `dsh-ppt-${slug}`)
    assert.equal(list[0].rank, 600)
    assert.equal(list[0].source, 'bundled')

    const body = await provider.get(list[0], {})
    assert.ok(body.content.length > 100)
    assert.ok(!body.content.startsWith('---'))
    if (skill.startsWith('pptmaster-')) {
      assert.ok(!body.content.includes('ppt_capabilities'), `${skill} 不应注入工具契约`)
    } else {
      assert.match(body.content, new RegExp(`PPTist Workbench ${WORKBENCH_CONTRACT.contractVersion.replace(/\./g, '\\.')}`))
      assert.match(body.content, /ppt_capabilities/)
    }
  }
})

test('8 个 skill 包契约快照与 workbench 一致', () => {
  assert.equal(WORKBENCH_CONTRACT.toolCount, TOOLS.length)
  for (const { pkg } of PACKAGES) {
    const contract = JSON.parse(readFileSync(join(PLUGIN, pkg, 'contract', 'ppt-contract.json'), 'utf8'))
    assert.deepEqual(contract, WORKBENCH_CONTRACT, `${pkg} 契约快照不一致`)
  }
})

test('skill lint：工具名、路由、frontmatter 全部对账', () => {
  const result = lintSkills()
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(result.skills, 8)
  assert.equal(result.tools, TOOLS.length)
})

test('每个包 apply 只注册一个 provider 工厂', async () => {
  for (const { pkg, skill, slug } of PACKAGES) {
    const mod = await import(pathToFileURL(join(PLUGIN, pkg, 'lib', 'index.mjs')).href)
    const providers = []
    const ctx = { skills: { registerProvider: (factory) => providers.push(factory) } }
    mod.apply(ctx)
    assert.equal(providers.length, 1)
    const provider = providers[0]()
    assert.equal(provider.name, `dsh-ppt-${slug}`)
    assert.deepEqual((await provider.list()).map((item) => item.name), [skill])
  }
})
