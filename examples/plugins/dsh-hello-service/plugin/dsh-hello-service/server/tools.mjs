/**
 * MCP 工具面：能力声明 → 注册表 → 工具清单。
 *
 * 新增工具：在 impl.mjs 写实现，这里 defineTool 声明 schema，并加入能力。
 */
import {
  defineTool, defineCapability, createRegistry, createMcpHandler,
  createCapabilityReport, buildInstructions,
} from './shared/tool-host.mjs'
import { echo, capabilities as capabilitiesImpl } from './impl.mjs'

export const contractVersion = '1.0.0'

const echoTool = defineTool({
  name: 'hello_service_echo',
  description: '回显输入文本，用于验证服务连通性。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', maxLength: 2000, description: '要回显的文本' },
    },
    required: ['text'],
  },
  handler: (args) => ({ content: [{ type: 'text', text: echo(args) }] }),
})

const capabilitiesTool = defineTool({
  name: 'hello_service_capabilities',
  description: '返回契约版本、工具清单和能力说明。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  kind: 'read',
  handler: () => ({ content: [{ type: 'text', text: JSON.stringify(capabilitiesImpl(), null, 2) }] }),
})

const capability = defineCapability({
  id: 'hello-service',
  title: 'Hello Service',
  description: 'Hello Service DSH 插件',
  tags: ['service'],
  tools: [echoTool, capabilitiesTool],
})

export const registry = createRegistry([capability], {
  report: ({ editorUrl = '', runtime = {}, ...rest }) => createCapabilityReport({
    ...rest,
    contractVersion,
    packageVersion: '1.0.0',
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
