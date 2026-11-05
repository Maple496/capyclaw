/**
 * MCP 工具面：能力声明 → 注册表 → 工具清单。
 *
 * 发布业务在 impl.mjs；这里只做 schema/分派。
 * publisher_execute 是不可撤销动作：schema 强制 confirm: true。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineTool, defineCapability, createRegistry, createMcpHandler,
  createCapabilityReport, buildInstructions,
} from '@capyclaw/tool-host/src'
import { npmWhoami, runPublish, capabilities as capabilitiesImpl } from './impl.mjs'

export const contractVersion = '1.0.0'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })

const rootSchema = {
  type: 'string',
  maxLength: 500,
  description: '插件工程工作区路径（要发布的仓库 checkout）。缺省用 DSH_PUBLISHER_ROOT。',
}

const whoamiTool = defineTool({
  name: 'publisher_whoami',
  description: 'npm 凭据预检：宿主环境是否已登录（npm whoami / NODE_AUTH_TOKEN）。发布前先调用。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  kind: 'read',
  handler: () => text(npmWhoami()),
})

const previewTool = defineTool({
  name: 'publisher_preview',
  description: '发布预演（dry-run）：发现集 → 发布闸/pack 闸 → 已发布与同版本漂移 → 依赖顺序闸，返回逐包结果与汇总。不真发布。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      root: rootSchema,
      only: { type: 'string', maxLength: 100, description: '只处理这个包名（@capyclaw/xxx）' },
      skipTests: { type: 'boolean', description: '跳过各包 npm test（默认不跳，与原流水线一致）' },
    },
  },
  kind: 'read',
  handler: (args) => runPublish({ ...args, dryRun: true }).then(text),
})

const executeTool = defineTool({
  name: 'publisher_execute',
  description: '真发布到 npm（不可撤销）。必须显式传 confirm: true。流程与 preview 相同，过闸后逐包 npm publish 并做发布后 shasum 复核。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      root: rootSchema,
      only: { type: 'string', maxLength: 100, description: '只发布这个包名（@capyclaw/xxx）' },
      tag: { type: 'string', maxLength: 20, description: 'dist-tag（默认 latest）' },
      skipTests: { type: 'boolean', description: '跳过各包 npm test' },
      confirm: { type: 'boolean', description: '必须为 true 才执行' },
    },
    required: ['confirm'],
  },
  kind: 'control',
  handler: (args) => {
    if (args.confirm !== true) {
      return text({ ok: false, error: '发布是不可撤销动作：需要显式传 confirm: true（建议先跑 publisher_preview 核对批次）' })
    }
    return runPublish({ ...args, dryRun: false }).then(text)
  },
})

const capabilitiesTool = defineTool({
  name: 'publisher_capabilities',
  description: '返回契约版本、工具清单和能力说明。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  kind: 'read',
  handler: () => text({ ...capabilitiesImpl(), name: PKG.name, version: PKG.version }),
})

const capability = defineCapability({
  id: 'publisher',
  title: 'npm 发布器',
  description: '在 dsh 内发布 capyclaw 插件工程：预演（闸门/顺序/漂移）与真发布（需显式 confirm）。',
  tags: ['tool'],
  tools: [whoamiTool, previewTool, executeTool, capabilitiesTool],
})

export const registry = createRegistry([capability], {
  report: ({ editorUrl = '', runtime = {}, ...rest }) => createCapabilityReport({
    ...rest,
    contractVersion,
    packageVersion: PKG.version,
    editorUrl,
    runtime,
  }),
})

export const tools = registry.TOOLS
export const callTool = (name, args) => registry.TOOL_IMPL[name]?.(args)
export function capabilities() { return registry.ctx.contract.report() }

export function createMcp(serverInfo, instructions) {
  return createMcpHandler({ registry, serverInfo, instructions })
}

export { buildInstructions }
