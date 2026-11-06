/**
 * 构建：源码 + 资产 → plugin/ 下的 5 个可安装包。
 *
 *   plugin/capyclaw-browser-workbench/   运行时（relay + 工作台 + browser_* MCP 工具）
 *   plugin/capyclaw-browser-skill-NAME/  3 个单 skill provider 包
 *   plugin/capyclaw-browser-suite/       组合入口（workbench + 3 个 skill 包）
 *
 * 用法：node scripts/build-plugin.mjs [--check]
 *
 * 流水线实现在 scripts/lib/bridge-build.mjs 的 runBridgeBuild（三 bridge 共用）；
 * 本文件只保留 Browser 侧差异配置。Browser 无编辑器打包，lib/host.mjs 为手写精简版，
 * 不走 workbench host 模板。
 *
 * 包内手写文件（server/{relay,contract-snapshots}.mjs、server/routes/*、
 * server/mcp/*、lib/host.mjs、ui/、demo/、skills 源）不在拷贝范围。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runBridgeBuild } from '../../../../scripts/lib/bridge-build.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const WORKBENCH = resolve(ROOT, 'plugin', 'capyclaw-browser-workbench')
const SUITE_PKG = resolve(ROOT, 'plugin', 'capyclaw-browser-suite')
const CHECK_ONLY = process.argv.includes('--check')

/* skill 包：npm 发布名 @capyclaw/browser-skill-*（与 dsh-suite.json rows 一致），
 * 磁盘目录名 = 包名去 scope（capyclaw-browser-skill-*）。 */
const SKILL_PACKAGES = [
  { slug: 'browser', skill: 'browser', name: '@capyclaw/browser-skill-browser', dir: 'capyclaw-browser-skill-browser', version: '0.1.0', title: '浏览器路由', description: '浏览器操控总入口：按意图路由到实操、API 手册技能。' },
  { slug: 'api', skill: 'browser-api', name: '@capyclaw/browser-skill-api', dir: 'capyclaw-browser-skill-api', version: '0.1.0', title: '浏览器工具手册', description: 'browser_* 工具契约、ref 快照语义、登录态与安全边界。' },
  { slug: 'ops', skill: 'browser-ops', name: '@capyclaw/browser-skill-ops', dir: 'capyclaw-browser-skill-ops', version: '0.1.0', title: '网活实操', description: '快照→ref→动作→验证的互联网任务工作流。' },
]

const COPIES = [
  ['src/mcp/tools.mjs', 'server/tools.mjs'],
  ['src/mcp/engine.mjs', 'server/engine.mjs'],
  ['src/mcp/contract.mjs', 'server/contract.mjs'],
]

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

await runBridgeBuild({
  root: ROOT,
  checkOnly: CHECK_ONLY,
  config: {
    ns: 'browser',
    nsLabel: 'Browser',
    contractFile: 'browser-contract.json',
    contractTitle: 'Browser Workbench',
    contractCapabilitiesSource: 'raw',
    providerPrefix: 'dsh-browser',
    noteSkipExpr: "skillName === 'browser'",
    noteExpr: "'契约：Browser Workbench ' + version + '。动作前先调用 browser_capabilities；工具缺失或 major 不一致时停止，并提示用户安装/升级 @capyclaw/browser-suite。'",
    workbenchDir: 'capyclaw-browser-workbench',
    suiteDir: 'capyclaw-browser-suite',
    host: null,
    skillPackages: SKILL_PACKAGES,
    copies: COPIES,
    kitInfra: ['http', 'tuning'],
    toolContractSkills: ['browser-api'],
    required,
  },
})
