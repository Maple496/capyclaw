/**
 * 构建：源码 + 资产 → plugin/ 下的 10 个可安装包。
 *
 *   plugin/capyclaw-ppt-workbench/   运行时（relay + editor + MCP 工具）
 *   plugin/capyclaw-ppt-skill-NAME/       8 个单 skill provider 包
 *   plugin/capyclaw-ppt-suite/       组合入口（workbench + 8 个 skill 包）
 *
 * 用法：node scripts/build-plugin.mjs [--check]
 *
 * 产物分四类：
 *   1. 拷贝（单一真源在 src/）：server/{tools,bridge-client,deck-layout,contract}.mjs
 *   2. 打包（esbuild）：editor/app.js ← src/editor/main.js
 *   3. 资产：editor/ppt-full-app.js ← PPTist bundle
 *   4. 契约快照：contract/ppt-contract.json → 十个包
 *
 * 包内手写文件（lib/host.mjs、server/{relay,store,mcp-http}.mjs、
 * editor/index.html、cordis.patch.yml、skills 源）不在拷贝范围。
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { syncSharedDir } from '../../../../scripts/lib/shared-sync.mjs'
import { checkSuiteDrift } from '../../../../scripts/check-suite-drift.mjs'
import { loadSuiteManifest } from '@capyclaw/suite-kit'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PLUGIN_ROOT = join(ROOT, 'plugin')
/* 仓库已迁到 extensions/bridges/ppt-bridge：比旧布局多一层。 */
const KIT_ROOT = join(ROOT, '..', '..', '..', 'packages', 'capyclaw-plugin-kit')
const WORKBENCH = join(PLUGIN_ROOT, 'capyclaw-ppt-workbench')
const SUITE_PKG = join(PLUGIN_ROOT, 'capyclaw-ppt-suite')
/* skill 包：npm 发布名是 @capyclaw/ppt-skill-*（与 dsh-suite.json rows 一致），
 * 磁盘目录名 = 包名去 scope（capyclaw-ppt-skill-*，与 skills-service 的 dev 扫描一致）。
 * version：narrative 的 2.2.1 已被 npm 占用，跳到 2.2.2；其余首发补丁版 2.2.1。 */
const SKILL_PACKAGES = [
  { slug: 'ppt', skill: 'ppt', name: '@capyclaw/ppt-skill-ppt', dir: 'capyclaw-ppt-skill-ppt', version: '2.2.1', title: 'PPT 路由', description: 'PPT 总入口：按意图路由到执行、成稿、审美、审计、研究技能。' },
  { slug: 'narrative', skill: 'pptmaster-narrative', name: '@capyclaw/ppt-skill-narrative', dir: 'capyclaw-ppt-skill-narrative', version: '2.2.2', title: 'PPT 叙事', description: 'SCQA、金字塔、一页一观点、deck_brief。' },
  { slug: 'design', skill: 'pptmaster-design', name: '@capyclaw/ppt-skill-design', dir: 'capyclaw-ppt-skill-design', version: '2.2.1', title: 'PPT 审美', description: 'design token、版式、反 AI slop；只做视觉决策。' },
  { slug: 'api', skill: 'pptist-api', name: '@capyclaw/ppt-skill-api', dir: 'capyclaw-ppt-skill-api', version: '2.2.1', title: 'PPT 工具手册', description: 'PPTist 工具契约、参数、状态、撤销。' },
  { slug: 'authoring', skill: 'pptist-authoring', name: '@capyclaw/ppt-skill-authoring', dir: 'capyclaw-ppt-skill-authoring', version: '2.2.1', title: 'PPT 成稿', description: 'deck_brief → clean 简洁版式成稿。' },
  { slug: 'editing', skill: 'pptist-editing', name: '@capyclaw/ppt-skill-editing', dir: 'capyclaw-ppt-skill-editing', version: '2.2.1', title: 'PPT 纯执行', description: '指哪打哪的修改执行器：每步落盘、不审美、不审计、不回头验证。' },
  { slug: 'visual-check', skill: 'pptist-visual-check', name: '@capyclaw/ppt-skill-visual-check', dir: 'capyclaw-ppt-skill-visual-check', version: '2.2.1', title: 'PPT 审计', description: '只读审计与按需截图，报告 pass/blocking；不改稿。' },
  { slug: 'research', skill: 'pptist-research', name: '@capyclaw/ppt-skill-research', dir: 'capyclaw-ppt-skill-research', version: '2.2.1', title: 'PPT 研究', description: '外部资料、数据、配图研究，产出分析卡。' },
]
const ASSET = resolve(process.env.PPT_ASSET || join(ROOT, 'assets', 'ppt-full-app.js'))
const CHECK_ONLY = process.argv.includes('--check')

const COPIES = [
  ['src/mcp/tools.mjs', 'server/tools.mjs'],
  ['src/mcp/bridge-client.mjs', 'server/bridge-client.mjs'],
  ['src/mcp/deck-layout.mjs', 'server/deck-layout.mjs'],
  ['src/mcp/contract.mjs', 'server/contract.mjs'],
  ['src/mcp/validate.mjs', 'server/validate.mjs'],
  ['src/mcp/audit.mjs', 'server/audit.mjs'],
  ['src/mcp/ppt-shim.mjs', 'server/ppt-shim.mjs'],
  ['src/mcp/tuning.mjs', 'server/tuning.mjs'],
  ['src/editor/heartbeat-worker.js', 'editor/heartbeat-worker.js'],
]

/* 公共插件源码快照：与 @capyclaw/plugin-kit 的 server/infra 同一机制。
 * 功能插件只 import shared/*，不再手写宿主/工具/状态/资产/编辑器。 */

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

/** 拍平到 infra 根的 kit 文件：'../tuning.mjs' 需改写为 './tuning.mjs'，
 * 否则会解析到 server/tuning.mjs（relay 调优，键不同）造成静默错配。 */
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
    `export const name = 'ppt-skill-${entry.slug}'`,
    `export const inject = ['skills']`,
    `const SKILL = ${JSON.stringify(entry.skill)}`,
    '',
    'function defaultProvider(config = {}) {',
    '  return createSkillProvider({',
    "    assetRoot: config.assetRoot ?? fileURLToPath(new URL('../skills/', import.meta.url)),",
    "    contractRoot: config.contractRoot ?? fileURLToPath(new URL('../contract/', import.meta.url)),",
    "    contractFile: 'ppt-contract.json',",
    `    providerName: ${JSON.stringify('dsh-ppt-' + entry.slug)},`,
    '    skillDirs: [SKILL],',
    "    contractNote: (version, skillName) => (String(skillName || '').startsWith('pptmaster-')",
    "      ? ''",
    "      : '契约：PPTist Workbench ' + version + '。动作前先调用 ppt_capabilities；工具缺失或 major 不一致时停止，并提示用户安装/升级 @capyclaw/ppt-suite。'),",
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
    description: `PPT skill：${entry.description}`,
    type: 'module',
    main: './lib/index.mjs',
    exports: { '.': './lib/index.mjs', './package.json': './package.json' },
    engines: { node: '>=18', dsh: '^0.2.0-rc.2' },
    publishConfig: { access: 'public' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, category: 'skills', platform: 'both' },
    meta: { title: `PPT Skill · ${entry.title}`, description: entry.description },
    files: ['lib/', 'skills/', 'contract/', 'cordis.patch.yml', 'README.md'],
    license: 'MIT',
    dependencies: { '@capyclaw/plugin-kit': '^0.2.0' },
  }, null, 2) + '\n'
  writeChecked(join(pkgDir, 'package.json'), pkgJson, `${entry.dir}/package.json`)
  writeChecked(join(pkgDir, 'cordis.patch.yml'), [
    `# ${entry.name}（目录 ${entry.dir}） bundle patch：只注册 ${entry.skill} 一个 skill provider。`,
    '- insert:',
    `    - id: ppt-skill-${entry.slug}`,
    `      name: ${entry.name}`,
    '',
  ].join('\n'), `${entry.dir}/cordis.patch.yml`)
  writeChecked(join(pkgDir, 'lib', 'index.mjs'), skillProviderIndex(entry), `${entry.dir}/lib/index.mjs`)
  copyChecked(join(KIT_ROOT, 'src', 'skills', 'provider.mjs'), join(pkgDir, 'lib', 'provider.mjs'), `${entry.dir}/lib/provider.mjs`)
  syncDir(join(ROOT, 'src', 'skills', entry.skill), join(pkgDir, 'skills', entry.skill), `${entry.dir}/skills/${entry.skill}`, ['references/tool-contract.md'])
  writeChecked(join(pkgDir, 'README.md'), `# ${entry.name}\n\nPPT skill 单包：\`${entry.skill}\`。只注册一个 skill provider，不启动服务。\n`, `${entry.dir}/README.md`)
}

function toolContractMarkdown(contract) {
  const lines = [
    `# PPTist Workbench 工具契约`,
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
{
  const drift = checkSuiteDrift({ quiet: true })
  if (!drift.ok) fail('suite 元数据漂移:\n- ' + drift.issues.join('\n- '))
}
syncSharedDir(join(ROOT, 'src', 'mcp', 'shared'), { force: !CHECK_ONLY, check: CHECK_ONLY })
syncSharedDir(join(WORKBENCH, 'server', 'shared'), { force: !CHECK_ONLY, check: CHECK_ONLY })

/* 1. 生成工具契约快照（唯一真源：capabilities → registry → tools.mjs） */
const toolModule = await import(pathToFileURL(join(ROOT, 'src', 'mcp', 'tools.mjs')).href)
const { TOOLS, TOOL_META, FEATURES, CAPABILITY_LIST } = toolModule
const {
  CONTRACT_VERSION, PACKAGE_VERSION,
} = await import(pathToFileURL(join(ROOT, 'src', 'mcp', 'contract.mjs')).href)

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
  capabilities: CAPABILITY_LIST,
}
const contractJson = JSON.stringify(contract, null, 2) + '\n'
const contractTargets = [
  [join(ROOT, 'contract'), 'contract/ppt-contract.json'],
  [join(WORKBENCH, 'contract'), 'capyclaw-ppt-workbench/contract/ppt-contract.json'],
  [join(SUITE_PKG, 'contract'), 'capyclaw-ppt-suite/contract/ppt-contract.json'],
]
for (const entry of SKILL_PACKAGES) {
  contractTargets.push([join(skillPkgDir(entry), 'contract'), `${entry.dir}/contract/ppt-contract.json`])
}
for (const [dir, label] of contractTargets) {
  writeChecked(join(dir, 'ppt-contract.json'), contractJson, label)
}

/* 1.5 生成 capabilities.json 元数据（用于 dsh-assembly-kit 组件库） */
{
  const capabilitiesModule = await import(pathToFileURL(join(ROOT, 'src', 'mcp', 'tools', 'capabilities', 'index.mjs')).href)
  const CAPABILITIES = capabilitiesModule.CAPABILITIES
  
  const capabilitiesMetadata = {
    version: 1,
    source: 'server/tools/capabilities',
    capabilities: CAPABILITIES.map(cap => ({
      id: cap.id,
      version: PACKAGE_VERSION,
      title: cap.title || cap.id,
      description: cap.description || '',
      tags: cap.tags || [],
      keywords: [],
      entry: {
        module: `./capabilities/${cap.id}.mjs`,
        export: `${cap.id}Capability`
      },
      provides: {
        tools: cap.tools.map(t => t.name),
        features: cap.features || []
      },
      requires: cap.requires || [],
      dependsOn: cap.dependsOn || []
    }))
  }
  
  const capabilitiesJson = JSON.stringify(capabilitiesMetadata, null, 2) + '\n'
  writeChecked(join(WORKBENCH, 'capabilities.json'), capabilitiesJson, 'capyclaw-ppt-workbench/capabilities.json')
}

/* 3. MCP 三件套 + contract 拷贝 */
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
/* 旧布局（core 拷到 server/tools-deps）已废弃；保留目录会让两套实现并存。 */
if (CHECK_ONLY) {
  if (existsSync(join(WORKBENCH, 'server', 'tools-deps'))) {
    throw new Error('[check] server/tools-deps 已废弃，请运行 node scripts/build-plugin.mjs 清理')
  }
} else {
  rmSync(join(WORKBENCH, 'server', 'tools-deps'), { recursive: true, force: true })
}
copyFlattened(join(KIT_ROOT, 'src', 'service', 'http.mjs'), join(WORKBENCH, 'server', 'infra', 'http.mjs'), 'server/infra/http.mjs')
copyChecked(join(KIT_ROOT, 'src', 'tuning.mjs'), join(WORKBENCH, 'server', 'infra', 'tuning.mjs'), 'server/infra/tuning.mjs')
copyChecked(join(KIT_ROOT, 'src', 'util', 'fs-lock.mjs'), join(WORKBENCH, 'server', 'infra', 'util', 'fs-lock.mjs'), 'server/infra/util/fs-lock.mjs')
copyChecked(join(KIT_ROOT, 'src', 'store', 'blob-store.mjs'), join(WORKBENCH, 'server', 'infra', 'store', 'blob-store.mjs'), 'server/infra/store/blob-store.mjs')
copyChecked(join(KIT_ROOT, 'src', 'workspace', 'manager.mjs'), join(WORKBENCH, 'server', 'infra', 'workspace', 'manager.mjs'), 'server/infra/workspace/manager.mjs')
copyChecked(join(KIT_ROOT, 'src', 'runtime', 'context.mjs'), join(WORKBENCH, 'server', 'infra', 'runtime', 'context.mjs'), 'server/infra/runtime/context.mjs')

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

/* 4. PPTist 资产（纯运行时） */
{
  if (!existsSync(ASSET)) fail('缺少 PPTist 资产: ' + ASSET)
  const src = readFileSync(ASSET, 'utf8')
  writeChecked(join(WORKBENCH, 'editor', 'ppt-full-app.js'), src,
    'editor/ppt-full-app.js（' + Math.round(src.length / 1024) + 'KB）')
}

/* 5. 技能源 → 8 个单 skill 包 + 生成工具契约参考 */
for (const entry of SKILL_PACKAGES) {
  syncSkillPackage(entry)
  if (entry.skill === 'ppt' || entry.skill === 'pptist-api') {
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

/* 2.5 组合锁：记录 suite 实际解析到的包版本与关键 manifest hash。 */
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
  writeChecked(join(SUITE_PKG, 'composition.lock.json'), JSON.stringify(lock, null, 2) + '\n', 'capyclaw-ppt-suite/composition.lock.json')
}

/* 6. 所有包的完整性 sanity */
const required = [
  [WORKBENCH, ['package.json', 'cordis.patch.yml', 'lib/host.mjs',
    'server/relay.mjs', 'server/constants.mjs', 'server/tuning.mjs', 'server/store.mjs', 'server/mcp-http.mjs', 'server/http-utils.mjs', 'server/contract.mjs',
    'server/validate.mjs', 'server/audit.mjs', 'server/ppt-shim.mjs', 'server/infra/http.mjs', 'server/infra/tuning.mjs', 'server/infra/util/fs-lock.mjs', 'server/infra/store/blob-store.mjs', 'server/infra/workspace/manager.mjs', 'server/infra/runtime/context.mjs',
    'server/shared/service-host.mjs', 'server/shared/tool-host.mjs', 'server/shared/state-service.mjs', 'server/shared/asset-service.mjs', 'server/shared/editor-host.mjs', 'server/shared/SHARED_MANIFEST.json',
    'server/routes/assets.mjs', 'server/routes/bridge.mjs', 'server/routes/editor.mjs', 'server/routes/mcp.mjs',
    'server/runtime/recovery.mjs', 'server/runtime/watch.mjs',
    'server/store/index.mjs', 'server/store/doc.mjs', 'server/store/sanitize.mjs', 'server/store/lease.mjs', 'server/store/checkpoints.mjs', 'server/store/journal.mjs', 'server/store/backends/file-backend.mjs',
    'server/mcp/handler.mjs', 'server/mcp/dispatch.mjs', 'server/mcp/instructions.mjs',
    'server/tools/index.mjs', 'server/tools/kernel/define.mjs', 'server/tools/kernel/registry.mjs', 'server/tools/kernel/ports.mjs', 'server/tools/capabilities/index.mjs', 'server/tools/domains/index.mjs',
    'core/ops.js', 'core/ops/index.js', 'core/color.js', 'core/text.js', 'core/audit.js', 'core/deck-layout.js',
    'editor/index.html', 'contract/ppt-contract.json']],
  [SUITE_PKG, ['package.json', 'dsh-suite.json', 'composition.lock.json', 'cordis.patch.yml', 'lib/index.mjs', 'contract/ppt-contract.json']],
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
  for (const file of ['package.json', 'cordis.patch.yml', 'lib/index.mjs', 'lib/provider.mjs', `skills/${entry.skill}/SKILL.md`, 'contract/ppt-contract.json']) {
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
/* suite 的 dependencies 引用 npm 发布名（@capyclaw/*），skill 本地目录名仍是 dsh-ppt-* */
for (const dep of ['@capyclaw/ppt-workbench', ...SKILL_PACKAGES.map((entry) => entry.name)]) {
  if (!suiteManifest.dependencies?.[dep]) fail(`@capyclaw/ppt-suite 缺少依赖: ${dep}`)
}
if (suiteManifest.dsh?.suite !== './dsh-suite.json') fail('@capyclaw/ppt-suite 未声明 dsh.suite')
const suiteKit = await import('@capyclaw/suite-kit')
const loadedSuite = suiteKit.loadSuiteManifest(SUITE_PKG)
const suiteValidation = suiteKit.validateSuiteManifest(loadedSuite.manifest)
if (!suiteValidation.ok) fail('dsh-suite.json 校验失败:\n' + suiteValidation.errors.join('\n'))
const composedSuite = suiteKit.composeSuites([loadedSuite])
if (!composedSuite.ok) fail('dsh-suite.json 组合失败:\n' + composedSuite.errors.join('\n'))
const expectedSuitePatch = suiteKit.renderCordisPatch(composedSuite.rows)
writeChecked(join(SUITE_PKG, 'cordis.patch.yml'), expectedSuitePatch, 'capyclaw-ppt-suite/cordis.patch.yml（由 manifest 生成）')

console.log(CHECK_ONLY
  ? '✓ 所有包全部最新（check 通过）'
  : `✓ 构建完成：${TOOLS.length} 个工具 / ${SKILL_PACKAGES.length + 2} 个包 → ${PLUGIN_ROOT}`)
