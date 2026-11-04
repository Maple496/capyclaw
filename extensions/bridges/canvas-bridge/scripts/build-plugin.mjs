/**
 * 构建：源码 + 资产 → plugin/ 下的 6 个可安装包。
 *
 *   plugin/capyclaw-canvas-workbench/    运行时（relay + editor + canvas_* MCP 工具）
 *   plugin/dsh-canvas-skill-NAME/        4 个单 skill provider 包
 *   plugin/capyclaw-canvas-suite/        组合入口（workbench + 4 个 skill 包）
 *
 * 用法：node scripts/build-plugin.mjs [--check]
 *
 * 产物分四类：
 *   1. 拷贝（单一真源在 src/）：server/{tools,bridge-client,contract,tuning}.mjs
 *   2. 打包（esbuild）：editor/app.js ← src/editor/main.js
 *   3. 资产：editor/canvas-full-app.js ← runtime/ 内核 bundle
 *   4. 契约快照：contract/canvas-contract.json → 六个包
 *
 * 包内手写文件（lib/host.mjs、server/{relay,store,contract-snapshots}.mjs、
 * server/routes/*、editor/index.html、cordis.patch.yml、skills 源）不在拷贝范围。
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { syncSharedDir } from '../../../../scripts/lib/shared-sync.mjs'
import { loadSuiteManifest } from 'dsh-suite-kit'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PLUGIN_ROOT = join(ROOT, 'plugin')
/* 仓库布局：extensions/bridges/canvas-bridge → 仓库根多三层。 */
const KIT_ROOT = join(ROOT, '..', '..', '..', 'packages', 'dsh-plugin-kit')
const WORKBENCH = join(PLUGIN_ROOT, 'capyclaw-canvas-workbench')
const SUITE_PKG = join(PLUGIN_ROOT, 'capyclaw-canvas-suite')
/* skill 包：npm 发布名 @capyclaw/canvas-skill-*（与 dsh-suite.json rows 一致），
 * 磁盘目录名 dsh-canvas-skill-*。 */
const SKILL_PACKAGES = [
  { slug: 'canvas', skill: 'canvas', name: '@capyclaw/canvas-skill-canvas', dir: 'dsh-canvas-skill-canvas', version: '0.2.0', title: 'Canvas 路由', description: 'Canvas 总入口：按意图路由到成稿、执行、API 手册技能。' },
  { slug: 'api', skill: 'canvasist-api', name: '@capyclaw/canvas-skill-api', dir: 'dsh-canvas-skill-api', version: '0.2.0', title: 'Canvas 工具手册', description: 'canvas_* 工具契约、参数、命令白名单、撤销与页面命令。' },
  { slug: 'authoring', skill: 'canvasist-authoring', name: '@capyclaw/canvas-skill-authoring', dir: 'dsh-canvas-skill-authoring', version: '0.2.0', title: 'Canvas 成稿', description: '结构设计 → 块级写作 → 一次成稿 → 精修。' },
  { slug: 'editing', skill: 'canvasist-editing', name: '@capyclaw/canvas-skill-editing', dir: 'dsh-canvas-skill-editing', version: '0.2.0', title: 'Canvas 纯执行', description: '指哪打哪的修改执行器：每步落盘、不审美、不审计、不回头验证。' },
]
const ASSET = resolve(process.env.CANVAS_ASSET || join(ROOT, 'runtime', 'canvas-full-app.js'))
const CHECK_ONLY = process.argv.includes('--check')

const COPIES = [
  ['src/mcp/tools.mjs', 'server/tools.mjs'],
  ['src/mcp/bridge-client.mjs', 'server/bridge-client.mjs'],
  ['src/mcp/contract.mjs', 'server/contract.mjs'],
  ['src/mcp/tuning.mjs', 'server/tuning.mjs'],
]

function fail(msg) {
  if (CHECK_ONLY) throw new Error('[check] ' + msg)
  throw new Error(msg)
}

function writeChecked(file, content, label) {
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (prev === content) {
    console.log(`· ${label} 已是最新`)
    return
  }
  if (CHECK_ONLY) throw new Error(`[check] ${label} 不是最新，请运行 node scripts/build-plugin.mjs`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  console.log(`✓ ${label}`)
}

function copyChecked(src, dst, label) {
  if (!existsSync(src)) fail('缺少 kit 源文件: ' + src)
  writeChecked(dst, readFileSync(src, 'utf8'), label)
}

/** 拍平到 infra 根的 kit 文件：'../tuning.mjs' 需改写为 './tuning.mjs'。 */
function copyFlattened(src, dst, label) {
  if (!existsSync(src)) fail('缺少 kit 源文件: ' + src)
  const content = readFileSync(src, 'utf8').replaceAll("'../tuning.mjs'", "'./tuning.mjs'")
  writeChecked(dst, content, label)
}

function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push(relative(base, full).split('\\').join('/'))
  }
  return out.sort()
}

function syncDir(src, dst, label, ignore = []) {
  if (!existsSync(src)) fail('缺少目录: ' + src)
  const filtered = (files) => files.filter((file) => !ignore.includes(file))
  if (!CHECK_ONLY) {
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(dst, { recursive: true })
    cpSync(src, dst, { recursive: true })
    console.log(`✓ 拷贝 ${label}/（${listFiles(src).length} 个文件）`)
    return
  }
  const want = filtered(listFiles(src))
  const have = filtered(existsSync(dst) ? listFiles(dst) : [])
  if (want.join('\n') !== have.join('\n')) {
    throw new Error(`[check] ${label}/ 文件集不是最新，请运行 node scripts/build-plugin.mjs`)
  }
  for (const rel of want) {
    if (readFileSync(join(src, rel), 'utf8') !== readFileSync(join(dst, rel), 'utf8')) {
      throw new Error(`[check] ${label}/${rel} 不是最新，请运行 node scripts/build-plugin.mjs`)
    }
  }
  console.log(`· ${label}/ 已是最新`)
}

const skillPkgDir = (entry) => join(PLUGIN_ROOT, entry.dir)

function skillProviderIndex(entry) {
  return [
    `/** ${entry.name}（目录 ${entry.dir}）：单 skill provider。 */`,
    `import { fileURLToPath } from 'node:url'`,
    `import { createSkillProvider } from './provider.mjs'`,
    '',
    `export const name = 'canvas-skill-${entry.slug}'`,
    `export const inject = ['skills']`,
    `const SKILL = ${JSON.stringify(entry.skill)}`,
    '',
    'function defaultProvider(config = {}) {',
    '  return createSkillProvider({',
    "    assetRoot: config.assetRoot ?? fileURLToPath(new URL('../skills/', import.meta.url)),",
    "    contractRoot: config.contractRoot ?? fileURLToPath(new URL('../contract/', import.meta.url)),",
    "    contractFile: 'canvas-contract.json',",
    `    providerName: ${JSON.stringify('dsh-canvas-' + entry.slug)},`,
    '    skillDirs: [SKILL],',
    "    contractNote: (version, skillName) => (skillName === 'canvas'",
    "      ? ''",
    "      : '契约：Canvas Workbench ' + version + '。动作前先调用 canvas_capabilities；工具缺失或 major 不一致时停止，并提示用户安装/升级 @capyclaw/canvas-suite。'),",
    '  })',
    '}',
    '',
    'export function createProvider(config = {}) { return defaultProvider(config) }',
    'export function apply(ctx, config = {}) { ctx.skills.registerProvider(() => defaultProvider(config)) }',
    '',
  ].join('\n')
}

function syncSkillPackage(entry) {
  const pkgDir = skillPkgDir(entry)
  const pkgJson = JSON.stringify({
    name: entry.name,
    version: entry.version,
    description: `Canvas skill：${entry.description}`,
    type: 'module',
    main: './lib/index.mjs',
    exports: { '.': './lib/index.mjs', './package.json': './package.json' },
    engines: { node: '>=18', dsh: '^0.2.0-rc.2' },
    publishConfig: { access: 'public' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, category: 'skills', platform: 'both' },
    meta: { title: `Canvas Skill · ${entry.title}`, description: entry.description },
    files: ['lib/', 'skills/', 'contract/', 'cordis.patch.yml', 'README.md'],
    license: 'MIT',
    dependencies: { '@capyclaw/plugin-kit': '^0.2.0' },
  }, null, 2) + '\n'
  writeChecked(join(pkgDir, 'package.json'), pkgJson, `${entry.dir}/package.json`)
  writeChecked(join(pkgDir, 'cordis.patch.yml'), [
    `# ${entry.name}（目录 ${entry.dir}） bundle patch：只注册 ${entry.skill} 一个 skill provider。`,
    '- insert:',
    `    - id: canvas-skill-${entry.slug}`,
    `      name: ${entry.name}`,
    '',
  ].join('\n'), `${entry.dir}/cordis.patch.yml`)
  writeChecked(join(pkgDir, 'lib', 'index.mjs'), skillProviderIndex(entry), `${entry.dir}/lib/index.mjs`)
  copyChecked(join(KIT_ROOT, 'src', 'skills', 'provider.mjs'), join(pkgDir, 'lib', 'provider.mjs'), `${entry.dir}/lib/provider.mjs`)
  syncDir(join(ROOT, 'src', 'skills', entry.skill), join(pkgDir, 'skills', entry.skill), `${entry.dir}/skills/${entry.skill}`, ['references/tool-contract.md'])
  writeChecked(join(pkgDir, 'README.md'), `# ${entry.name}\n\nCanvas skill 单包：\`${entry.skill}\`。只注册一个 skill provider，不启动服务。\n`, `${entry.dir}/README.md`)
}

function toolContractMarkdown(contract) {
  const lines = [
    `# Canvas Workbench 工具契约`,
    '',
    `- contractVersion: \`${contract.contractVersion}\``,
    `- packageVersion: \`${contract.packageVersion}\``,
    `- toolCount: ${contract.toolCount}`,
    `- features: ${contract.features.map((f) => `\`${f}\``).join(', ')}`,
    '',
    '## 能力',
    '',
    ...contract.capabilities.map((cap) => `- \`${cap.id}\`（${cap.title}）：${cap.tools.map((name) => `\`${name}\``).join(', ')}`),
    '',
    '> 本文件由 scripts/build-plugin.mjs 生成，禁止手改。',
    '',
  ]
  for (const tool of contract.tools) {
    lines.push(`## \`${tool.name}\``, '', `- kind: \`${tool.kind}\``, `- since: \`${tool.since}\``, `- capability: \`${tool.capability || '-'}\``, '', tool.description || '', '')
    if (tool.inputSchema) {
      lines.push('```json', JSON.stringify(tool.inputSchema, null, 2), '```', '')
    }
  }
  return lines.join('\n')
}

/* 0. 公共插件快照（必须在 import tools.mjs 之前生成） */
syncSharedDir(join(ROOT, 'src', 'mcp', 'shared'), { force: !CHECK_ONLY, check: CHECK_ONLY })
syncSharedDir(join(WORKBENCH, 'server', 'shared'), { force: !CHECK_ONLY, check: CHECK_ONLY })

/* 1. 生成工具契约快照（唯一真源：capabilities → registry → tools.mjs） */
const toolModule = await import(pathToFileURL(join(ROOT, 'src', 'mcp', 'tools.mjs')).href)
const { TOOLS, TOOL_META, FEATURES, CAPABILITIES } = toolModule
const { CONTRACT_VERSION, PACKAGE_VERSION } = await import(pathToFileURL(join(ROOT, 'src', 'mcp', 'contract.mjs')).href)

const toolNames = TOOLS.map((tool) => tool.name).sort()
const metaNames = Object.keys(TOOL_META).sort()
if (toolNames.join('\n') !== metaNames.join('\n')) {
  throw new Error('registry 的 TOOL_META 与 TOOLS 不一致：\n' +
    `tools: ${toolNames.join(', ')}\nmeta:  ${metaNames.join(', ')}`)
}
const contract = {
  contractVersion: CONTRACT_VERSION,
  packageVersion: PACKAGE_VERSION,
  toolCount: TOOLS.length,
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    kind: TOOL_META[tool.name].kind,
    since: TOOL_META[tool.name].since,
    capability: TOOL_META[tool.name].capability,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
  features: FEATURES,
  capabilities: CAPABILITIES,
}
const contractJson = JSON.stringify(contract, null, 2) + '\n'
const contractTargets = [
  [join(ROOT, 'contract'), 'contract/canvas-contract.json'],
  [join(WORKBENCH, 'contract'), 'capyclaw-canvas-workbench/contract/canvas-contract.json'],
  [join(SUITE_PKG, 'contract'), 'capyclaw-canvas-suite/contract/canvas-contract.json'],
]
for (const entry of SKILL_PACKAGES) {
  contractTargets.push([join(skillPkgDir(entry), 'contract'), `${entry.dir}/contract/canvas-contract.json`])
}
for (const [dir, label] of contractTargets) {
  writeChecked(join(dir, 'canvas-contract.json'), contractJson, label)
}

/* 1.5 生成 capabilities.json 元数据（用于组件库） */
{
  const capabilitiesMetadata = {
    version: 1,
    source: 'server/tools/capabilities',
    capabilities: CAPABILITIES.map((cap) => ({
      id: cap.id,
      version: PACKAGE_VERSION,
      title: cap.title,
      description: cap.description || '',
      tags: cap.tags || [],
      keywords: [],
      entry: {
        module: `./capabilities/${cap.id}.mjs`,
        export: `${cap.id}Capability`,
      },
      provides: {
        tools: cap.tools.map((t) => t.name),
        features: cap.features || [],
      },
      requires: cap.requires || [],
      dependsOn: cap.dependsOn || [],
    })),
  }
  writeChecked(join(WORKBENCH, 'capabilities.json'), JSON.stringify(capabilitiesMetadata, null, 2) + '\n', 'capyclaw-canvas-workbench/capabilities.json')
}

/* 2. MCP 四件套 + core 拷贝 */
for (const [src, dst] of COPIES) {
  const from = join(ROOT, src), to = join(WORKBENCH, dst)
  if (!existsSync(from)) fail('缺少源: ' + from)
  if (existsSync(to) && readFileSync(to, 'utf8') === readFileSync(from, 'utf8')) {
    console.log(`· ${dst} 已是最新`)
    continue
  }
  if (CHECK_ONLY) throw new Error(`[check] ${dst} 不是最新，请运行 node scripts/build-plugin.mjs`)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
  console.log('✓ 拷贝', dst)
}
syncDir(join(ROOT, 'src', 'mcp', 'tools'), join(WORKBENCH, 'server', 'tools'), 'server/tools')
syncDir(join(ROOT, 'src', 'core'), join(WORKBENCH, 'core'), 'core')
copyFlattened(join(KIT_ROOT, 'src', 'service', 'http.mjs'), join(WORKBENCH, 'server', 'infra', 'http.mjs'), 'server/infra/http.mjs')
copyChecked(join(KIT_ROOT, 'src', 'tuning.mjs'), join(WORKBENCH, 'server', 'infra', 'tuning.mjs'), 'server/infra/tuning.mjs')
copyChecked(join(KIT_ROOT, 'src', 'util', 'fs-lock.mjs'), join(WORKBENCH, 'server', 'infra', 'util', 'fs-lock.mjs'), 'server/infra/util/fs-lock.mjs')
copyChecked(join(KIT_ROOT, 'src', 'store', 'blob-store.mjs'), join(WORKBENCH, 'server', 'infra', 'store', 'blob-store.mjs'), 'server/infra/store/blob-store.mjs')
copyChecked(join(KIT_ROOT, 'src', 'workspace', 'manager.mjs'), join(WORKBENCH, 'server', 'infra', 'workspace', 'manager.mjs'), 'server/infra/workspace/manager.mjs')
copyChecked(join(KIT_ROOT, 'src', 'runtime', 'context.mjs'), join(WORKBENCH, 'server', 'infra', 'runtime', 'context.mjs'), 'server/infra/runtime/context.mjs')
copyChecked(join(KIT_ROOT, 'src', 'editor', 'heartbeat-worker.js'), join(WORKBENCH, 'editor', 'heartbeat-worker.js'), 'editor/heartbeat-worker.js')

/* 3. 编辑器打包 */
{
  const out = await build({
    entryPoints: [join(ROOT, 'src', 'editor', 'main.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    charset: 'utf8',
  })
  const js = out.outputFiles[0].text
  writeChecked(join(WORKBENCH, 'editor', 'app.js'), js,
    'editor/app.js（' + Math.round(js.length / 1024) + 'KB）')
}

/* 4. canvas 内核资产（纯运行时） */
{
  if (!existsSync(ASSET)) fail('缺少 canvas 内核资产: ' + ASSET)
  const src = readFileSync(ASSET, 'utf8')
  writeChecked(join(WORKBENCH, 'editor', 'canvas-full-app.js'), src,
    'editor/canvas-full-app.js（' + Math.round(src.length / 1024) + 'KB）')
}

/* 5. 技能源 → 4 个单 skill 包 + 生成工具契约参考 */
for (const entry of SKILL_PACKAGES) {
  syncSkillPackage(entry)
  if (entry.skill === 'canvasist-api') {
    writeChecked(
      join(skillPkgDir(entry), 'skills', entry.skill, 'references', 'tool-contract.md'),
      toolContractMarkdown(contract),
      `${entry.dir}/skills/${entry.skill}/references/tool-contract.md`,
    )
  }
}
{
  const { lintSkills } = await import(pathToFileURL(join(ROOT, 'scripts', 'lint-skills.mjs')).href)
  const lint = lintSkills()
  if (!lint.ok) fail('skill lint 未通过:\n' + lint.errors.join('\n'))
  for (const warning of lint.warnings) console.log(`! ${warning}`)
}

/* 6. 组合锁：记录 suite 实际解析到的包版本与关键 manifest hash。 */
{
  const suiteManifest = loadSuiteManifest(SUITE_PKG).manifest
  const packages = {}
  for (const [name, entry] of Object.entries(suiteManifest.packages || {})) {
    if (!entry.path) continue
    const dir = resolve(SUITE_PKG, entry.path)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const suiteFile = join(dir, 'dsh-suite.json')
    const extra = existsSync(suiteFile) ? readFileSync(suiteFile, 'utf8') : ''
    packages[name] = {
      version: pkg.version,
      apiVersion: pkg.dsh?.apiVersion || null,
      path: entry.path,
      sha256: createHash('sha256').update(readFileSync(join(dir, 'package.json'), 'utf8') + extra).digest('hex'),
    }
  }
  const lock = {
    suite: suiteManifest.name,
    suiteVersion: suiteManifest.version,
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
  }
  writeChecked(join(SUITE_PKG, 'composition.lock.json'), JSON.stringify(lock, null, 2) + '\n', 'capyclaw-canvas-suite/composition.lock.json')
}

/* 7. suite patch 生成（须先于 sanity：首跑时 cordis.patch.yml 由这里产出） */
{
  const suiteKit = await import('dsh-suite-kit')
  const loadedSuite = suiteKit.loadSuiteManifest(SUITE_PKG)
  const suiteValidation = suiteKit.validateSuiteManifest(loadedSuite.manifest)
  if (!suiteValidation.ok) fail('dsh-suite.json 校验失败:\n' + suiteValidation.errors.join('\n'))
  const composedSuite = suiteKit.composeSuites([loadedSuite])
  if (!composedSuite.ok) fail('dsh-suite.json 组合失败:\n' + composedSuite.errors.join('\n'))
  const expectedSuitePatch = suiteKit.renderCordisPatch(composedSuite.rows)
  writeChecked(join(SUITE_PKG, 'cordis.patch.yml'), expectedSuitePatch, 'capyclaw-canvas-suite/cordis.patch.yml（由 manifest 生成）')
}

/* 8. 所有包的完整性 sanity */
const required = [
  [WORKBENCH, ['package.json', 'cordis.patch.yml', 'lib/host.mjs',
    'server/relay.mjs', 'server/constants.mjs', 'server/tuning.mjs', 'server/store.mjs',
    'server/contract.mjs', 'server/contract-snapshots.mjs', 'server/http-utils.mjs',
    'server/infra/http.mjs', 'server/infra/tuning.mjs', 'server/infra/util/fs-lock.mjs', 'server/infra/store/blob-store.mjs', 'server/infra/workspace/manager.mjs', 'server/infra/runtime/context.mjs',
    'server/shared/service-host.mjs', 'server/shared/tool-host.mjs', 'server/shared/state-service.mjs', 'server/shared/asset-service.mjs', 'server/shared/editor-host.mjs', 'server/shared/SHARED_MANIFEST.json',
    'server/routes/assets.mjs', 'server/routes/bridge.mjs', 'server/routes/editor.mjs', 'server/routes/mcp.mjs', 'server/routes/export.mjs', 'server/routes/view.mjs',
    'server/store/index.mjs', 'server/store/doc.mjs', 'server/store/sanitize.mjs', 'server/store/backends/file-backend.mjs',
    'server/mcp/handler.mjs', 'server/mcp/instructions.mjs',
    'server/tools/index.mjs', 'server/tools/kernel/define.mjs', 'server/tools/kernel/registry.mjs', 'server/tools/kernel/ports.mjs', 'server/tools/capabilities/index.mjs', 'server/tools/domains/mirror.mjs',
    'core/blocks.js', 'core/doc.js', 'core/commands.js', 'core/audit.js', 'core/html.js',
    'editor/index.html', 'contract/canvas-contract.json']],
  [SUITE_PKG, ['package.json', 'dsh-suite.json', 'composition.lock.json', 'cordis.patch.yml', 'lib/index.mjs', 'contract/canvas-contract.json']],
]
for (const [dir, files] of required) {
  for (const file of files) {
    if (!existsSync(join(dir, file))) fail(`${relative(PLUGIN_ROOT, dir)} 缺少文件: ${file}`)
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (!manifest.dsh?.bundle?.patch) fail(`${relative(PLUGIN_ROOT, dir)} 缺 dsh.bundle.patch`)
  if (!existsSync(join(dir, manifest.main))) fail(`${relative(PLUGIN_ROOT, dir)} 的 main 不存在: ${manifest.main}`)
}
for (const entry of SKILL_PACKAGES) {
  const dir = skillPkgDir(entry)
  for (const file of ['package.json', 'cordis.patch.yml', 'lib/index.mjs', 'lib/provider.mjs', `skills/${entry.skill}/SKILL.md`, 'contract/canvas-contract.json']) {
    if (!existsSync(join(dir, file))) fail(`${entry.dir} 缺少文件: ${file}`)
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (manifest.name !== entry.name) fail(`${entry.dir} 的 package.json name=${manifest.name} 与预期 ${entry.name} 不一致`)
  if (manifest.version !== entry.version) fail(`${entry.dir} 的 package.json version=${manifest.version} 与预期 ${entry.version} 不一致`)
  if (!manifest.dsh?.bundle?.patch) fail(`${entry.dir} 缺 dsh.bundle.patch`)
  if (!existsSync(join(dir, manifest.main))) fail(`${entry.dir} 的 main 不存在: ${manifest.main}`)
}
const workbenchManifest = JSON.parse(readFileSync(join(WORKBENCH, 'package.json'), 'utf8'))
if (workbenchManifest.version !== PACKAGE_VERSION) {
  fail(`contract.mjs 的 PACKAGE_VERSION=${PACKAGE_VERSION} 与 workbench package.json=${workbenchManifest.version} 不一致`)
}
const suiteManifest = JSON.parse(readFileSync(join(SUITE_PKG, 'package.json'), 'utf8'))
for (const dep of ['@capyclaw/canvas-workbench', ...SKILL_PACKAGES.map((entry) => entry.name)]) {
  if (!suiteManifest.dependencies?.[dep]) fail(`@capyclaw/canvas-suite 缺少依赖: ${dep}`)
}
if (suiteManifest.dsh?.suite !== './dsh-suite.json') fail('@capyclaw/canvas-suite 未声明 dsh.suite')

console.log(CHECK_ONLY
  ? '✓ 所有包全部最新（check 通过）'
  : `✓ 构建完成：${TOOLS.length} 个工具 / ${SKILL_PACKAGES.length + 2} 个包 → ${PLUGIN_ROOT}`)
