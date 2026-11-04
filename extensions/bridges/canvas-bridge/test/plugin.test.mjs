/** 插件包结构：六个包的 manifest/入口/契约/技能对账。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = join(fileURLToPath(import.meta.url), '..')
const PLUGIN = join(HERE, '..', 'plugin')

const WORKBENCH = join(PLUGIN, 'capyclaw-canvas-workbench')
const SUITE = join(PLUGIN, 'capyclaw-canvas-suite')
const SKILLS = ['capyclaw-canvas-skill-canvas', 'capyclaw-canvas-skill-api', 'capyclaw-canvas-skill-authoring', 'capyclaw-canvas-skill-editing']

test('workbench 包：manifest + dsh 声明 + main 入口', () => {
  const pkg = JSON.parse(readFileSync(join(WORKBENCH, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@capyclaw/canvas-workbench')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(WORKBENCH, pkg.main)))
  assert.ok(existsSync(join(WORKBENCH, 'cordis.patch.yml')))
})

test('workbench 关键文件齐全（server/editor/core/contract/shared）', () => {
  const required = [
    'server/relay.mjs', 'server/constants.mjs', 'server/store.mjs',
    'server/routes/bridge.mjs', 'server/routes/editor.mjs', 'server/routes/mcp.mjs', 'server/routes/assets.mjs', 'server/routes/export.mjs',
    'server/mcp/handler.mjs', 'server/mcp/instructions.mjs',
    'server/tools/index.mjs', 'server/tools/capabilities/index.mjs',
    'server/shared/SHARED_MANIFEST.json',
    'core/blocks.js', 'core/doc.js', 'core/commands.js', 'core/audit.js', 'core/html.js',
    'editor/index.html', 'editor/app.js', 'editor/canvas-full-app.js', 'editor/heartbeat-worker.js',
    'contract/canvas-contract.json', 'capabilities.json',
  ]
  for (const file of required) {
    assert.ok(existsSync(join(WORKBENCH, file)), `缺少 ${file}`)
  }
})

test('relay 静态文件映射与磁盘一致', async () => {
  const { EDITOR_FILES } = await import(pathToFileURL(join(WORKBENCH, 'server', 'constants.mjs')).href)
  for (const [route, [file]] of Object.entries(EDITOR_FILES)) {
    assert.ok(existsSync(join(WORKBENCH, 'editor', file)), `EDITOR_FILES 引用的 ${file} 不存在`)
    assert.notEqual(route, '')
  }
  assert.ok(EDITOR_FILES['/canvas-full-app.js'])
})

test('workbench 依赖声明公共基建', () => {
  const pkg = JSON.parse(readFileSync(join(WORKBENCH, 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies['@capyclaw/plugin-kit'], '复用 plugin-kit')
  assert.ok(pkg.dependencies['@capyclaw/document-workbench'], '复用 document-workbench')
})

test('4 个 skill 包：结构一致 + 契约快照同步', () => {
  const contract = readFileSync(join(WORKBENCH, 'contract', 'canvas-contract.json'), 'utf8')
  const names = ['canvas', 'canvasist-api', 'canvasist-authoring', 'canvasist-editing']
  SKILLS.forEach((dir, i) => {
    const root = join(PLUGIN, dir)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.dsh.category, 'skills')
    assert.ok(existsSync(join(root, pkg.main)))
    assert.ok(existsSync(join(root, `skills/${names[i]}/SKILL.md`)), `${dir} 缺 SKILL.md`)
    assert.equal(readFileSync(join(root, 'contract', 'canvas-contract.json'), 'utf8'), contract, `${dir} 契约快照漂移`)
  })
})

test('canvasist-api 技能带生成的工具契约参考', () => {
  const ref = join(PLUGIN, 'capyclaw-canvas-skill-api', 'skills', 'canvasist-api', 'references', 'tool-contract.md')
  assert.ok(existsSync(ref))
  const md = readFileSync(ref, 'utf8')
  assert.ok(md.includes('canvas_write_document'))
  assert.ok(md.includes('contractVersion'))
})

test('suite 包：dsh-suite.json + 组合锁 + patch + 依赖完备', () => {
  const pkg = JSON.parse(readFileSync(join(SUITE, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@capyclaw/canvas-suite')
  assert.equal(pkg.dsh.suite, './dsh-suite.json')
  for (const dep of ['@capyclaw/canvas-workbench', ...SKILLS.map((d) => JSON.parse(readFileSync(join(PLUGIN, d, 'package.json'), 'utf8')).name)]) {
    assert.ok(pkg.dependencies[dep], `suite 缺依赖 ${dep}`)
  }
  const suite = JSON.parse(readFileSync(join(SUITE, 'dsh-suite.json'), 'utf8'))
  assert.equal(suite.rows.filter((r) => r.id === 'mcp-canvas').length, 1)
  assert.equal(suite.rows.filter((r) => r.name.includes('canvas-skill-')).length, 4)
  assert.ok(suite.checks.some((c) => c.id === 'canvas-health'))
  assert.ok(existsSync(join(SUITE, 'composition.lock.json')))
  assert.ok(existsSync(join(SUITE, 'cordis.patch.yml')))
  const lock = JSON.parse(readFileSync(join(SUITE, 'composition.lock.json'), 'utf8'))
  assert.ok(lock.packages['@capyclaw/canvas-workbench'])
})

test('contract 目录：契约快照 + 能力发掘产物', () => {
  assert.ok(existsSync(join(HERE, '..', 'contract', 'canvas-contract.json')))
  const api = JSON.parse(readFileSync(join(HERE, '..', 'contract', 'canvas-api.json'), 'utf8'))
  assert.ok(api.registeredCommands.length >= 90)
  assert.ok(api.help.includes('exec(name, ...args)'))
})

test('技能源与包内技能同步（构建镜像）', () => {
  SKILLS.forEach((dir, i) => {
    const src = readFileSync(join(HERE, '..', 'src', 'skills', ['canvas', 'canvasist-api', 'canvasist-authoring', 'canvasist-editing'][i], 'SKILL.md'), 'utf8')
    const built = readFileSync(join(PLUGIN, dir, 'skills', ['canvas', 'canvasist-api', 'canvasist-authoring', 'canvasist-editing'][i], 'SKILL.md'), 'utf8')
    assert.equal(src, built, `${dir} 技能源与包内不同步`)
  })
})
