/**
 * 构建：源码 + 资产 → plugin/ 下的 5 个可安装包。
 *
 *   plugin/capyclaw-browser-workbench/    运行时（relay + 工作台 + browser_* MCP 工具）
 *   plugin/capyclaw-browser-skill-NAME/        3 个单 skill provider 包
 *   plugin/capyclaw-browser-suite/        组合入口（workbench + 3 个 skill 包）
 *
 * 用法：node scripts/build-plugin.mjs [--check]
 *
 * 受检写文件原语、skill 包生成、组合锁、suite patch 等公共流程
 * 在 scripts/lib/bridge-build.mjs（与 ppt/canvas bridge 共用）；本文件只保留
 * Browser 侧的差异配置：SKILL_PACKAGES 表、COPIES 表、契约路径。与 canvas 的
 * 差异：无编辑器打包（工作台 UI 无构建）、host.mjs 为手写精简版（无文档
 * store/journal，不走 renderWorkbenchHost 模板）。
 *
 * 包内手写文件（server/{relay,contract-snapshots}.mjs、server/routes/*、
 * server/mcp/*、lib/host.mjs、ui/、demo/、skills 源）不在拷贝范围。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { syncSharedDir } from '../../../../scripts/lib/shared-sync.mjs'
import { checkSuiteDrift } from '../../../../scripts/check-suite-drift.mjs'
import {
  createCheckedFs, syncSkillPackage, renderToolContractMarkdown,
  copyMcpEntries, writeCompositionLock,
  generateSuitePatch, verifyRequiredFiles, verifySkillPackages, skillPkgDir,
} from '../../../../scripts/lib/bridge-build.mjs'
import { loadSuiteManifest } from '@capyclaw/suite-kit'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const PLUGIN_ROOT = join(ROOT, 'plugin')
const KIT_ROOT = join(ROOT, '..', '..', '..', 'packages', 'capyclaw-plugin-kit')
const WORKBENCH = join(PLUGIN_ROOT, 'capyclaw-browser-workbench')
const SUITE_PKG = join(PLUGIN_ROOT, 'capyclaw-browser-suite')
/* skill 包：npm 发布名 @capyclaw/browser-skill-*（与 dsh-suite.json rows 一致），
 * 磁盘目录名 = 包名去 scope（capyclaw-browser-skill-*）。 */
const SKILL_PACKAGES = [
  { slug: 'browser', skill: 'browser', name: '@capyclaw/browser-skill-browser', dir: 'capyclaw-browser-skill-browser', version: '0.1.0', title: '浏览器路由', description: '浏览器操控总入口：按意图路由到实操、API 手册技能。' },
  { slug: 'api', skill: 'browser-api', name: '@capyclaw/browser-skill-api', dir: 'capyclaw-browser-skill-api', version: '0.1.0', title: '浏览器工具手册', description: 'browser_* 工具契约、ref 快照语义、登录态与安全边界。' },
  { slug: 'ops', skill: 'browser-ops', name: '@capyclaw/browser-skill-ops', dir: 'capyclaw-browser-skill-ops', version: '0.1.0', title: '网活实操', description: '快照→ref→动作→验证的互联网任务工作流。' },
]
const CHECK_ONLY = process.argv.includes('--check')
const ctx = createCheckedFs(CHECK_ONLY)

/* Browser 侧差异配置（公共库的参数化点） */
const SKILL_CFG = {
  ns: 'browser',
  nsLabel: 'Browser',
  contractFile: 'browser-contract.json',
  providerPrefix: 'dsh-browser',
  noteSkipExpr: "skillName === 'browser'",
  noteExpr: "'契约：Browser Workbench ' + version + '。动作前先调用 browser_capabilities；工具缺失或 major 不一致时停止，并提示用户安装/升级 @capyclaw/browser-suite。'",
}

const COPIES = [
  ['src/mcp/tools.mjs', 'server/tools.mjs'],
  ['src/mcp/engine.mjs', 'server/engine.mjs'],
  ['src/mcp/contract.mjs', 'server/contract.mjs'],
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
  [join(ROOT, 'contract'), 'contract/browser-contract.json'],
  [join(WORKBENCH, 'contract'), 'capyclaw-browser-workbench/contract/browser-contract.json'],
  [join(SUITE_PKG, 'contract'), 'capyclaw-browser-suite/contract/browser-contract.json'],
]
for (const entry of SKILL_PACKAGES) {
  contractTargets.push([join(skillPkgDir(PLUGIN_ROOT, entry), 'contract'), `${entry.dir}/contract/browser-contract.json`])
}
for (const [dir, label] of contractTargets) {
  ctx.writeChecked(join(dir, 'browser-contract.json'), contractJson, label)
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
  ctx.writeChecked(join(WORKBENCH, 'capabilities.json'), JSON.stringify(capabilitiesMetadata, null, 2) + '\n', 'capyclaw-browser-workbench/capabilities.json')
}

/* 2. MCP 源拷贝进 workbench（lib/host.mjs、relay、routes、ui、demo 为手写文件） */
copyMcpEntries(COPIES, { root: ROOT, workbench: WORKBENCH, ctx })
ctx.syncDir(join(ROOT, 'src', 'mcp', 'tools'), join(WORKBENCH, 'server', 'tools'), 'server/tools')
ctx.copyFlattened(join(KIT_ROOT, 'src', 'service', 'http.mjs'), join(WORKBENCH, 'server', 'infra', 'http.mjs'), 'server/infra/http.mjs')
ctx.copyChecked(join(KIT_ROOT, 'src', 'tuning.mjs'), join(WORKBENCH, 'server', 'infra', 'tuning.mjs'), 'server/infra/tuning.mjs')

/* 3. 技能源 → 3 个单 skill 包 + 生成工具契约参考 */
for (const entry of SKILL_PACKAGES) {
  syncSkillPackage(entry, { ctx, pluginRoot: PLUGIN_ROOT, kitRoot: KIT_ROOT, root: ROOT, cfg: SKILL_CFG })
  if (entry.skill === 'browser-api') {
    ctx.writeChecked(
      join(skillPkgDir(PLUGIN_ROOT, entry), 'skills', entry.skill, 'references', 'tool-contract.md'),
      renderToolContractMarkdown(contract, 'Browser Workbench'),
      `${entry.dir}/skills/${entry.skill}/references/tool-contract.md`,
    )
  }
}
{
  const { lintSkills } = await import(pathToFileURL(join(ROOT, 'scripts', 'lint-skills.mjs')).href)
  const lint = lintSkills()
  if (!lint.ok) ctx.fail('skill lint 未通过:\n' + lint.errors.join('\n- '))
  for (const warning of lint.warnings) console.log(`! ${warning}`)
}

/* 4. 组合锁 + suite patch 生成（patch 须先于 sanity：首跑时由这里产出） */
writeCompositionLock({ suitePkg: SUITE_PKG, ctx })
await generateSuitePatch({ suitePkg: SUITE_PKG, ctx })

/* 5. 所有包的完整性 sanity */
const required = [
  [WORKBENCH, ['package.json', 'cordis.patch.yml', 'README.md', 'capabilities.json',
    'lib/host.mjs',
    'server/relay.mjs', 'server/constants.mjs', 'server/engine.mjs', 'server/tools.mjs',
    'server/contract.mjs', 'server/contract-snapshots.mjs', 'server/http-utils.mjs',
    'server/infra/http.mjs', 'server/infra/tuning.mjs',
    'server/shared/service-host.mjs', 'server/shared/tool-host.mjs', 'server/shared/state-service.mjs', 'server/shared/asset-service.mjs', 'server/shared/editor-host.mjs', 'server/shared/SHARED_MANIFEST.json',
    'server/routes/mcp.mjs', 'server/routes/assets.mjs', 'server/routes/workbench.mjs', 'server/routes/api.mjs',
    'server/mcp/handler.mjs', 'server/mcp/instructions.mjs',
    'server/tools/index.mjs', 'server/tools/kernel/define.mjs', 'server/tools/kernel/registry.mjs', 'server/tools/kernel/ports.mjs', 'server/tools/kernel/output.mjs', 'server/tools/capabilities/index.mjs',
    'ui/index.html', 'ui/app.js', 'ui/style.css',
    'demo/form.html', 'contract/browser-contract.json']],
  [SUITE_PKG, ['package.json', 'README.md', 'dsh-suite.json', 'services.json', 'composition.lock.json', 'cordis.patch.yml', 'lib/index.mjs', 'contract/browser-contract.json']],
]
verifyRequiredFiles(required, { pluginRoot: PLUGIN_ROOT, ctx })
verifySkillPackages(SKILL_PACKAGES, { pluginRoot: PLUGIN_ROOT, ctx, contractFile: 'browser-contract.json' })
const workbenchManifest = JSON.parse(readFileSync(join(WORKBENCH, 'package.json'), 'utf8'))
if (workbenchManifest.version !== PACKAGE_VERSION) {
  ctx.fail(`contract.mjs 的 PACKAGE_VERSION=${PACKAGE_VERSION} 与 workbench package.json=${workbenchManifest.version} 不一致`)
}
const suiteManifest = JSON.parse(readFileSync(join(SUITE_PKG, 'package.json'), 'utf8'))
/* suite 的 dependencies 引用 npm 发布名（@capyclaw/*） */
for (const dep of ['@capyclaw/browser-workbench', ...SKILL_PACKAGES.map((entry) => entry.name)]) {
  if (!suiteManifest.dependencies?.[dep]) ctx.fail(`@capyclaw/browser-suite 缺少依赖: ${dep}`)
}
if (suiteManifest.dsh?.suite !== './dsh-suite.json') ctx.fail('@capyclaw/browser-suite 未声明 dsh.suite')
loadSuiteManifest(SUITE_PKG) // 走一遍加载路径（校验/组合/渲染已在 generateSuitePatch 完成）

console.log(CHECK_ONLY
  ? '✓ 所有包全部最新（check 通过）'
  : `✓ 构建完成：${TOOLS.length} 个工具 / ${SKILL_PACKAGES.length + 2} 个包 → ${PLUGIN_ROOT}`)
