/**
 * 构建：源码 + 资产 → plugin/ 下的 6 个可安装包。
 *
 *   plugin/capyclaw-canvas-workbench/   运行时（relay + editor + canvas_* MCP 工具）
 *   plugin/capyclaw-canvas-skill-NAME/      4 个单 skill provider 包
 *   plugin/capyclaw-canvas-suite/          组合入口（workbench + 4 个 skill 包）
 *
 * 用法：node scripts/build-plugin.mjs [--check]
 *
 * 流水线实现在 scripts/lib/bridge-build.mjs 的 runBridgeBuild（三 bridge 共用）；
 * 本文件只保留 Canvas 侧差异配置。
 *
 * 包内手写文件（server/{relay,store,contract-snapshots}.mjs、server/routes/*、
 * editor/index.html、skills 源）不在拷贝范围；lib/host.mjs 由公共模板生成。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runBridgeBuild } from '../../../../scripts/lib/bridge-build.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const WORKBENCH = resolve(ROOT, 'plugin', 'capyclaw-canvas-workbench')
const SUITE_PKG = resolve(ROOT, 'plugin', 'capyclaw-canvas-suite')
const ASSET = resolve(process.env.CANVAS_ASSET || resolve(ROOT, 'runtime', 'canvas-full-app.js'))
const CHECK_ONLY = process.argv.includes('--check')

/* skill 包：npm 发布名 @capyclaw/canvas-skill-*（与 dsh-suite.json rows 一致），
 * 磁盘目录名 = 包名去 scope（capyclaw-canvas-skill-*）。 */
const SKILL_PACKAGES = [
  { slug: 'canvas', skill: 'canvas', name: '@capyclaw/canvas-skill-canvas', dir: 'capyclaw-canvas-skill-canvas', version: '0.2.0', title: 'Canvas 路由', description: 'Canvas 总入口：按意图路由到成稿、执行、API 手册技能。' },
  { slug: 'api', skill: 'canvasist-api', name: '@capyclaw/canvas-skill-api', dir: 'capyclaw-canvas-skill-api', version: '0.2.0', title: 'Canvas 工具手册', description: 'canvas_* 工具契约、参数、命令白名单、撤销与页面命令。' },
  { slug: 'authoring', skill: 'canvasist-authoring', name: '@capyclaw/canvas-skill-authoring', dir: 'capyclaw-canvas-skill-authoring', version: '0.2.0', title: 'Canvas 成稿', description: '结构设计 → 块级写作 → 一次成稿 → 精修。' },
  { slug: 'editing', skill: 'canvasist-editing', name: '@capyclaw/canvas-skill-editing', dir: 'capyclaw-canvas-skill-editing', version: '0.2.0', title: 'Canvas 纯执行', description: '指哪打哪的修改执行器：每步落盘、不审美、不审计、不回头验证。' },
]

const COPIES = [
  ['src/mcp/tools.mjs', 'server/tools.mjs'],
  ['src/mcp/bridge-client.mjs', 'server/bridge-client.mjs'],
  ['src/mcp/contract.mjs', 'server/contract.mjs'],
  ['src/mcp/tuning.mjs', 'server/tuning.mjs'],
]

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

await runBridgeBuild({
  root: ROOT,
  checkOnly: CHECK_ONLY,
  config: {
    ns: 'canvas',
    nsLabel: 'Canvas',
    contractFile: 'canvas-contract.json',
    contractTitle: 'Canvas Workbench',
    contractCapabilitiesSource: 'raw',
    providerPrefix: 'dsh-canvas',
    noteSkipExpr: "skillName === 'canvas'",
    noteExpr: "'契约：Canvas Workbench ' + version + '。动作前先调用 canvas_capabilities；工具缺失或 major 不一致时停止，并提示用户安装/升级 @capyclaw/canvas-suite。'",
    workbenchDir: 'capyclaw-canvas-workbench',
    suiteDir: 'capyclaw-canvas-suite',
    host: {
      pkgName: '@capyclaw/canvas-workbench',
      ns: 'canvas',
      journalFile: 'canvas-journal.jsonl',
      envHome: 'CANVAS_BRIDGE_HOME',
      homeDefault: '.dsh-canvas-bridge',
    },
    skillPackages: SKILL_PACKAGES,
    copies: COPIES,
    kitInfra: ['http', 'tuning', 'fsLock', 'blobStore', 'workspace', 'runtimeContext', 'heartbeatWorker'],
    syncCoreDir: true,
    editor: {
      assetPath: ASSET,
      dest: 'editor/canvas-full-app.js',
      missingLabel: '缺少 canvas 内核资产',
    },
    toolContractSkills: ['canvasist-api'],
    required,
  },
})
