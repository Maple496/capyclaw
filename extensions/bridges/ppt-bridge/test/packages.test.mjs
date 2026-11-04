/**
 * 三包结构测试：版本对齐、依赖方向、bundle patch、契约快照一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT_VERSION, PACKAGE_VERSION } from '../src/mcp/contract.mjs'
import { TOOLS } from '../src/mcp/tools.mjs'
import { createRequire } from 'node:module'
const semver = createRequire(import.meta.url)('semver')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PLUGIN = join(ROOT, 'plugin')
const WORKBENCH = join(PLUGIN, 'capyclaw-ppt-workbench')
const SUITE = join(PLUGIN, 'capyclaw-ppt-suite')
/* 本地目录名 dsh-ppt-* → npm 发布名 @capyclaw/ppt-* */
const npmNameOf = (pkg) => '@capyclaw/' + pkg.replace(/^dsh-ppt-/, 'ppt-')
const SKILL_PACKAGES = [
  'dsh-ppt-skill-ppt',
  'dsh-ppt-skill-narrative',
  'dsh-ppt-skill-design',
  'dsh-ppt-skill-api',
  'dsh-ppt-skill-authoring',
  'dsh-ppt-skill-editing',
  'dsh-ppt-skill-visual-check',
  'dsh-ppt-skill-research',
]
const SKILL_OF = {
  'dsh-ppt-skill-ppt': 'ppt',
  'dsh-ppt-skill-narrative': 'pptmaster-narrative',
  'dsh-ppt-skill-design': 'pptmaster-design',
  'dsh-ppt-skill-api': 'pptist-api',
  'dsh-ppt-skill-authoring': 'pptist-authoring',
  'dsh-ppt-skill-editing': 'pptist-editing',
  'dsh-ppt-skill-visual-check': 'pptist-visual-check',
  'dsh-ppt-skill-research': 'pptist-research',
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const workbench = readJson(join(WORKBENCH, 'package.json'))
const suite = readJson(join(SUITE, 'package.json'))

test('workbench 版本与 contract 对齐，skill 包保持 2.2.0', () => {
  assert.equal(workbench.version, PACKAGE_VERSION)
  for (const pkg of SKILL_PACKAGES) {
    assert.equal(readJson(join(PLUGIN, pkg, 'package.json')).version, '2.2.0')
  }
  assert.equal(suite.version, readJson(join(SUITE, 'dsh-suite.json')).version)
})

test(`workbench：${TOOLS.length} 个工具契约 + 运行时文件完整`, () => {
  assert.equal(workbench.main, './lib/host.mjs')
  assert.equal(workbench.dsh.bundle.patch, './cordis.patch.yml')
  for (const file of ['lib/host.mjs', 'server/relay.mjs', 'server/mcp-http.mjs',
    'server/contract.mjs', 'editor/index.html', 'contract/ppt-contract.json']) {
    assert.ok(existsSync(join(WORKBENCH, file)), `workbench 缺少 ${file}`)
  }
  const contract = readJson(join(WORKBENCH, 'contract', 'ppt-contract.json'))
  assert.equal(contract.toolCount, TOOLS.length)
  assert.equal(contract.contractVersion, CONTRACT_VERSION)
  assert.equal(contract.packageVersion, workbench.version)
})

test('skills：8 个单包，每个 provider 入口 + skill + 契约快照', () => {
  for (const pkg of SKILL_PACKAGES) {
    const manifest = readJson(join(PLUGIN, pkg, 'package.json'))
    assert.equal(manifest.main, './lib/index.mjs')
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.ok(existsSync(join(PLUGIN, pkg, 'lib', 'index.mjs')), `${pkg} 缺少 lib/index.mjs`)
    assert.ok(existsSync(join(PLUGIN, pkg, 'contract', 'ppt-contract.json')), `${pkg} 缺少契约快照`)
    assert.ok(existsSync(join(PLUGIN, pkg, 'skills', SKILL_OF[pkg], 'SKILL.md')), `${pkg} 缺少 skill 文件`)
  }
})

test('suite：依赖 4 个公共插件 + workbench + 8 个 skill 包，patch 组合全部 row', () => {
  assert.equal(suite.main, './lib/index.mjs')
  assert.equal(suite.dsh.bundle.patch, './cordis.patch.yml')
  for (const name of ['@capyclaw/service-host', '@capyclaw/tool-host', '@capyclaw/asset-service', '@capyclaw/editor-host']) {
    assert.equal(suite.dependencies[name], '^0.1.0', `suite 缺少公共插件依赖 ${name}`)
  }
  /* suite 依赖范围须覆盖当前 workbench 版本（如 ^2.4.0 覆盖 2.4.1） */
  assert.ok(
    semver.satisfies(PACKAGE_VERSION, suite.dependencies[npmNameOf('dsh-ppt-workbench')]),
    `suite 的 ${npmNameOf('dsh-ppt-workbench')} 范围 ${suite.dependencies[npmNameOf('dsh-ppt-workbench')]} 不覆盖 ${PACKAGE_VERSION}`,
  )
  for (const pkg of SKILL_PACKAGES) assert.equal(suite.dependencies[npmNameOf(pkg)], '^2.2.0', `suite 缺少 ${npmNameOf(pkg)}`)
  const patch = readFileSync(join(SUITE, 'cordis.patch.yml'), 'utf8')
  /* relay 由 service-broker 独立进程拉起；patch 里只有 MCP 接入行和 skill 包。 */
  for (const token of [
    'dsh-service-host', 'dsh-tool-host', 'dsh-asset-service', 'dsh-editor-host',
    ...SKILL_PACKAGES, 'mcp-ppt', 'streamable-http',
  ]) {
    assert.ok(patch.includes(token), `suite patch 缺少 ${token}`)
  }
  assert.ok(!patch.includes('dsh-state-service'), 'suite patch 不应再安装 dsh-state-service')
})

test('composition.lock 记录解析后的包版本与 API 版本', () => {
  const lock = readJson(join(SUITE, 'composition.lock.json'))
  assert.equal(lock.suite, 'capyclaw-ppt-suite')
  assert.equal(lock.suiteVersion, suite.version)
  for (const name of ['dsh-plugin-kit', 'dsh-service-host', 'dsh-tool-host', 'dsh-asset-service', 'dsh-editor-host', 'dsh-ppt-workbench', ...SKILL_PACKAGES]) {
    assert.ok(lock.packages[name], `lock 缺少 ${name}`)
  }
  for (const name of ['dsh-service-host', 'dsh-tool-host', 'dsh-asset-service', 'dsh-editor-host']) {
    assert.equal(lock.packages[name].apiVersion, '1.0.0')
  }
  assert.ok(!lock.packages['dsh-state-service'], 'lock 不应再记录 dsh-state-service')
})

test('契约快照全部一致', () => {
  const a = readJson(join(WORKBENCH, 'contract', 'ppt-contract.json'))
  const c = readJson(join(SUITE, 'contract', 'ppt-contract.json'))
  assert.deepEqual(a, c)
  for (const pkg of SKILL_PACKAGES) {
    assert.deepEqual(readJson(join(PLUGIN, pkg, 'contract', 'ppt-contract.json')), a, `${pkg} 契约快照不一致`)
  }
})
