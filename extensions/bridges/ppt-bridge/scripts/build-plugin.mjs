/**
 * 构建：源码 + 资产 → plugin/ 下的 10 个可安装包。
 *
 *   plugin/capyclaw-ppt-workbench/   运行时（relay + editor + MCP 工具）
 *   plugin/capyclaw-ppt-skill-NAME/       8 个单 skill provider 包
 *   plugin/capyclaw-ppt-suite/       组合入口（workbench + 8 个 skill 包）
 *
 * 用法：node scripts/build-plugin.mjs [--check]
 *
 * 受检写文件原语、skill 包生成、组合锁、suite patch、host 模板等公共流程
 * 在 scripts/lib/bridge-build.mjs（与 canvas-bridge 共用）；本文件只保留
 * PPT 侧的差异配置：SKILL_PACKAGES 表、COPIES 表、契约与资产路径。
 *
 * 包内手写文件（server/{relay,store,mcp-http}.mjs、editor/index.html、
 * skills 源）不在拷贝范围；lib/host.mjs 由公共模板生成。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { syncSharedDir } from '../../../../scripts/lib/shared-sync.mjs'
import { checkSuiteDrift } from '../../../../scripts/check-suite-drift.mjs'
import {
  createCheckedFs, syncSkillPackage, renderToolContractMarkdown,
  copyMcpEntries, buildEditorApp, writeRuntimeAsset, writeCompositionLock,
  generateSuitePatch, verifyRequiredFiles, verifySkillPackages, renderWorkbenchHost, skillPkgDir,
} from '../../../../scripts/lib/bridge-build.mjs'
import { loadSuiteManifest } from '@capyclaw/suite-kit'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const PLUGIN_ROOT = join(ROOT, 'plugin')
const KIT_ROOT = join(ROOT, '..', '..', '..', 'packages', 'capyclaw-plugin-kit')
const WORKBENCH = join(PLUGIN_ROOT, 'capyclaw-ppt-workbench')
const SUITE_PKG = join(PLUGIN_ROOT, 'capyclaw-ppt-suite')
/* skill 包：npm 发布名是 @capyclaw/ppt-skill-*（与 dsh-suite.json rows 一致），
 * 磁盘目录名 = 包名去 scope（capyclaw-ppt-skill-*，与 skills-service 的 dev 扫描一致）。
 * version：同版本内容变化必须 bump（npm 禁止同版本重发，drift 闸在 publish dry-run 拦截）；
 * narrative 的 2.2.1/2.2.2/2.2.3 均已被 npm 占用，当前 2.2.4。 */
const SKILL_PACKAGES = [
  { slug: 'ppt', skill: 'ppt', name: '@capyclaw/ppt-skill-ppt', dir: 'capyclaw-ppt-skill-ppt', version: '2.2.3', title: 'PPT 路由', description: 'PPT 总入口：按意图路由到执行、成稿、审美、审计、研究技能。' },
  { slug: 'narrative', skill: 'pptmaster-narrative', name: '@capyclaw/ppt-skill-narrative', dir: 'capyclaw-ppt-skill-narrative', version: '2.2.4', title: 'PPT 叙事', description: 'SCQA、金字塔、一页一观点、deck_brief。' },
  { slug: 'design', skill: 'pptmaster-design', name: '@capyclaw/ppt-skill-design', dir: 'capyclaw-ppt-skill-design', version: '2.2.3', title: 'PPT 审美', description: 'design token、版式、反 AI slop；只做视觉决策。' },
  { slug: 'api', skill: 'pptist-api', name: '@capyclaw/ppt-skill-api', dir: 'capyclaw-ppt-skill-api', version: '2.2.3', title: 'PPT 工具手册', description: 'PPTist 工具契约、参数、状态、撤销。' },
  { slug: 'authoring', skill: 'pptist-authoring', name: '@capyclaw/ppt-skill-authoring', dir: 'capyclaw-ppt-skill-authoring', version: '2.2.3', title: 'PPT 成稿', description: 'deck_brief → clean 简洁版式成稿。' },
  { slug: 'editing', skill: 'pptist-editing', name: '@capyclaw/ppt-skill-editing', dir: 'capyclaw-ppt-skill-editing', version: '2.2.3', title: 'PPT 纯执行', description: '指哪打哪的修改执行器：每步落盘、不审美、不审计、不回头验证。' },
  { slug: 'visual-check', skill: 'pptist-visual-check', name: '@capyclaw/ppt-skill-visual-check', dir: 'capyclaw-ppt-skill-visual-check', version: '2.2.3', title: 'PPT 审计', description: '只读审计与按需截图，报告 pass/blocking；不改稿。' },
  { slug: 'research', skill: 'pptist-research', name: '@capyclaw/ppt-skill-research', dir: 'capyclaw-ppt-skill-research', version: '2.2.4', title: 'PPT 研究', description: '外部资料、数据、配图研究，产出分析卡。' },
]
const ASSET = resolve(process.env.PPT_ASSET || join(ROOT, 'assets', 'ppt-full-app.js'))
const CHECK_ONLY = process.argv.includes('--check')
const ctx = createCheckedFs(CHECK_ONLY)

/* PPT 侧差异配置（公共库的参数化点） */
const SKILL_CFG = {
  ns: 'ppt',
  nsLabel: 'PPT',
  contractFile: 'ppt-contract.json',
  providerPrefix: 'dsh-ppt',
  noteSkipExpr: "String(skillName || '').startsWith('pptmaster-')",
  noteExpr: "'契约：PPTist Workbench ' + version + '。动作前先调用 ppt_capabilities；工具缺失或 major 不一致时停止，并提示用户安装/升级 @capyclaw/ppt-suite。'",
}
const HOST_CFG = {
  pkgName: '@capyclaw/ppt-workbench',
  ns: 'ppt',
  journalFile: 'ppt-journal.jsonl',
  envHome: 'PPT_BRIDGE_HOME',
  homeDefault: '.dsh-ppt-bridge',
}

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

/* 0. 公共插件快照（必须在 import tools.mjs 之前生成） */
{
  const drift = checkSuiteDrift({ quiet: true })
  if (!drift.ok) ctx.fail('suite 元数据漂移:\n- ' + drift.issues.join('\n- '))
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
  contractTargets.push([join(skillPkgDir(PLUGIN_ROOT, entry), 'contract'), `${entry.dir}/contract/ppt-contract.json`])
}
for (const [dir, label] of contractTargets) {
  ctx.writeChecked(join(dir, 'ppt-contract.json'), contractJson, label)
}

/* 1.5 生成 capabilities.json 元数据（用于组件库） */
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
  ctx.writeChecked(join(WORKBENCH, 'capabilities.json'), capabilitiesJson, 'capyclaw-ppt-workbench/capabilities.json')
}

/* 2. host.mjs 由公共模板生成（两 bridge 统一口径） */
ctx.writeChecked(join(WORKBENCH, 'lib', 'host.mjs'), renderWorkbenchHost(HOST_CFG), 'capyclaw-ppt-workbench/lib/host.mjs')

/* 3. MCP 拷贝 + core 镜像 + infra kit 文件 */
copyMcpEntries(COPIES, { root: ROOT, workbench: WORKBENCH, ctx })
ctx.syncDir(join(ROOT, 'src', 'mcp', 'tools'), join(WORKBENCH, 'server', 'tools'), 'server/tools')
ctx.syncDir(join(ROOT, 'src', 'core'), join(WORKBENCH, 'core'), 'core')
/* 旧布局（core 拷到 server/tools-deps）已废弃；保留目录会让两套实现并存。 */
if (CHECK_ONLY) {
  if (existsSync(join(WORKBENCH, 'server', 'tools-deps'))) {
    throw new Error('[check] server/tools-deps 已废弃，请运行 node scripts/build-plugin.mjs 清理')
  }
} else {
  rmSync(join(WORKBENCH, 'server', 'tools-deps'), { recursive: true, force: true })
}
ctx.copyFlattened(join(KIT_ROOT, 'src', 'service', 'http.mjs'), join(WORKBENCH, 'server', 'infra', 'http.mjs'), 'server/infra/http.mjs')
ctx.copyChecked(join(KIT_ROOT, 'src', 'tuning.mjs'), join(WORKBENCH, 'server', 'infra', 'tuning.mjs'), 'server/infra/tuning.mjs')
ctx.copyChecked(join(KIT_ROOT, 'src', 'util', 'fs-lock.mjs'), join(WORKBENCH, 'server', 'infra', 'util', 'fs-lock.mjs'), 'server/infra/util/fs-lock.mjs')
ctx.copyChecked(join(KIT_ROOT, 'src', 'store', 'blob-store.mjs'), join(WORKBENCH, 'server', 'infra', 'store', 'blob-store.mjs'), 'server/infra/store/blob-store.mjs')
ctx.copyChecked(join(KIT_ROOT, 'src', 'workspace', 'manager.mjs'), join(WORKBENCH, 'server', 'infra', 'workspace', 'manager.mjs'), 'server/infra/workspace/manager.mjs')
ctx.copyChecked(join(KIT_ROOT, 'src', 'runtime', 'context.mjs'), join(WORKBENCH, 'server', 'infra', 'runtime', 'context.mjs'), 'server/infra/runtime/context.mjs')

/* 4. 编辑器打包 + PPTist 资产（纯运行时） */
await buildEditorApp({ root: ROOT, workbench: WORKBENCH, ctx, esbuild: { build } })
writeRuntimeAsset({
  asset: ASSET,
  dest: join(WORKBENCH, 'editor', 'ppt-full-app.js'),
  ctx,
  missingLabel: '缺少 PPTist 资产',
  writeLabel: 'editor/ppt-full-app.js',
})

/* 5. 技能源 → 8 个单 skill 包 + 生成工具契约参考 */
for (const entry of SKILL_PACKAGES) {
  syncSkillPackage(entry, { ctx, pluginRoot: PLUGIN_ROOT, kitRoot: KIT_ROOT, root: ROOT, cfg: SKILL_CFG })
  if (entry.skill === 'ppt' || entry.skill === 'pptist-api') {
    ctx.writeChecked(
      join(skillPkgDir(PLUGIN_ROOT, entry), 'skills', entry.skill, 'references', 'tool-contract.md'),
      renderToolContractMarkdown(contract, 'PPTist Workbench'),
      `${entry.dir}/skills/${entry.skill}/references/tool-contract.md`,
    )
  }
}
{
  const { lintSkills } = await import(pathToFileURL(join(ROOT, 'scripts', 'lint-skills.mjs')).href)
  const lint = lintSkills()
  if (!lint.ok) ctx.fail('skill lint 未通过:\n' + lint.errors.join('\n'))
  for (const warning of lint.warnings) console.log(`! ${warning}`)
}

/* 6. 组合锁 + suite patch 生成（patch 须先于 sanity：首跑时由这里产出） */
writeCompositionLock({ suitePkg: SUITE_PKG, ctx })
await generateSuitePatch({ suitePkg: SUITE_PKG, ctx })

/* 7. 所有包的完整性 sanity */
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
verifyRequiredFiles(required, { pluginRoot: PLUGIN_ROOT, ctx })
verifySkillPackages(SKILL_PACKAGES, { pluginRoot: PLUGIN_ROOT, ctx, contractFile: 'ppt-contract.json' })
const workbenchManifest = JSON.parse(readFileSync(join(WORKBENCH, 'package.json'), 'utf8'))
if (workbenchManifest.version !== PACKAGE_VERSION) {
  ctx.fail(`contract.mjs 的 PACKAGE_VERSION=${PACKAGE_VERSION} 与 workbench package.json=${workbenchManifest.version} 不一致`)
}
const suiteManifest = JSON.parse(readFileSync(join(SUITE_PKG, 'package.json'), 'utf8'))
/* suite 的 dependencies 引用 npm 发布名（@capyclaw/*） */
for (const dep of ['@capyclaw/ppt-workbench', ...SKILL_PACKAGES.map((entry) => entry.name)]) {
  if (!suiteManifest.dependencies?.[dep]) ctx.fail(`@capyclaw/ppt-suite 缺少依赖: ${dep}`)
}
if (suiteManifest.dsh?.suite !== './dsh-suite.json') ctx.fail('@capyclaw/ppt-suite 未声明 dsh.suite')
loadSuiteManifest(SUITE_PKG) // 走一遍加载路径（校验/组合/渲染已在 generateSuitePatch 完成）

console.log(CHECK_ONLY
  ? '✓ 所有包全部最新（check 通过）'
  : `✓ 构建完成：${TOOLS.length} 个工具 / ${SKILL_PACKAGES.length + 2} 个包 → ${PLUGIN_ROOT}`)
