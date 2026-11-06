/**
 * 构建：源码 + 资产 → plugin/ 下的 10 个可安装包。
 *
 *   plugin/capyclaw-ppt-workbench/   运行时（relay + editor + MCP 工具）
 *   plugin/capyclaw-ppt-skill-NAME/       8 个单 skill provider 包
 *   plugin/capyclaw-ppt-suite/       组合入口（workbench + 8 个 skill 包）
 *
 * 用法：node scripts/build-plugin.mjs [--check]
 *
 * 流水线实现在 scripts/lib/bridge-build.mjs 的 runBridgeBuild（三 bridge 共用）；
 * 本文件只保留 PPT 侧的差异声明：SKILL_PACKAGES 表、COPIES 表、拼接的基建文件
 * （kitInfra）、契约与资产路径、sanity 清单。
 *
 * 包内手写文件（server/{relay,store,mcp-http}.mjs、editor/index.html、
 * skills 源）不在拷贝范围；lib/host.mjs 由公共模板生成。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runBridgeBuild } from '../../../../scripts/lib/bridge-build.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const WORKBENCH = resolve(ROOT, 'plugin', 'capyclaw-ppt-workbench')
const SUITE_PKG = resolve(ROOT, 'plugin', 'capyclaw-ppt-suite')
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
const ASSET = resolve(process.env.PPT_ASSET || resolve(ROOT, 'assets', 'ppt-full-app.js'))
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
  /* PPT 侧 heartbeat 从本 bridge 的 src 拷（与 canvas 从 kit 拷不同源）。 */
  ['src/editor/heartbeat-worker.js', 'editor/heartbeat-worker.js'],
]

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

await runBridgeBuild({
  root: ROOT,
  checkOnly: CHECK_ONLY,
  config: {
    ns: 'ppt',
    nsLabel: 'PPT',
    contractFile: 'ppt-contract.json',
    contractTitle: 'PPTist Workbench',
    contractCapabilitiesSource: 'registry',
    providerPrefix: 'dsh-ppt',
    noteSkipExpr: "String(skillName || '').startsWith('pptmaster-')",
    noteExpr: "'契约：PPTist Workbench ' + version + '。动作前先调用 ppt_capabilities；工具缺失或 major 不一致时停止，并提示用户安装/升级 @capyclaw/ppt-suite。'",
    workbenchDir: 'capyclaw-ppt-workbench',
    suiteDir: 'capyclaw-ppt-suite',
    host: {
      pkgName: '@capyclaw/ppt-workbench',
      ns: 'ppt',
      journalFile: 'ppt-journal.jsonl',
      envHome: 'PPT_BRIDGE_HOME',
      homeDefault: '.dsh-ppt-bridge',
    },
    skillPackages: SKILL_PACKAGES,
    copies: COPIES,
    kitInfra: ['http', 'tuning', 'fsLock', 'blobStore', 'workspace', 'runtimeContext'],
    syncCoreDir: true,
    legacyDirs: ['server/tools-deps'],
    editor: {
      assetPath: ASSET,
      dest: 'editor/ppt-full-app.js',
      missingLabel: '缺少 PPTist 资产',
    },
    toolContractSkills: ['ppt', 'pptist-api'],
    required,
  },
})
