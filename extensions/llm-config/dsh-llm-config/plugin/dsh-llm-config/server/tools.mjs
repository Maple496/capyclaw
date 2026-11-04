/**
 * MCP 工具面：能力声明 → 注册表 → 工具清单。
 *
 * 新增工具：在 impl.mjs 写实现，这里 defineTool 声明 schema，并加入能力。
 */
import {
  defineTool, defineCapability, createRegistry, createMcpHandler,
  createCapabilityReport, buildInstructions,
} from './shared/tool-host.mjs'
import {
  echo,
  capabilities as capabilitiesImpl,
  addLlmConfig,
  getLlmConfig,
  listLlmConfigs,
  deleteLlmConfig,
  testLlmConnection,
} from './impl.mjs'

export const contractVersion = '1.0.0'

const echoTool = defineTool({
  name: 'llm_config_echo',
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
  name: 'llm_config_capabilities',
  description: '返回契约版本、工具清单和能力说明。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  kind: 'read',
  handler: () => ({ content: [{ type: 'text', text: JSON.stringify(capabilitiesImpl(), null, 2) }] }),
})

const addLlmConfigTool = defineTool({
  name: 'llm_config_add',
  description: '添加或更新 LLM 配置，包括模型名称、URL、API Key 等信息。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '配置 ID，不提供则自动生成' },
      name: { type: 'string', description: '配置显示名称' },
      provider: { type: 'string', description: '提供商（openai/azure/anthropic/deepseek 等）' },
      model: { type: 'string', description: '模型名称（如 gpt-4, claude-3-opus 等）' },
      url: { type: 'string', description: 'API 端点 URL' },
      apiKey: { type: 'string', description: 'API Key' },
      options: { type: 'object', description: '其他选项（如 temperature、max_tokens 等）' },
    },
    required: ['model', 'url', 'apiKey'],
  },
  handler: (args) => ({ content: [{ type: 'text', text: JSON.stringify(addLlmConfig(args), null, 2) }] }),
})

const getLlmConfigTool = defineTool({
  name: 'llm_config_get',
  description: '获取指定 ID 的 LLM 配置详情。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '配置 ID' },
    },
    required: ['id'],
  },
  kind: 'read',
  handler: (args) => ({ content: [{ type: 'text', text: JSON.stringify(getLlmConfig(args), null, 2) }] }),
})

const listLlmConfigsTool = defineTool({
  name: 'llm_config_list',
  description: '列出所有已保存的 LLM 配置。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      includeApiKey: { type: 'boolean', description: '是否包含 API Key（默认不包含）' },
    },
  },
  kind: 'read',
  handler: (args) => ({ content: [{ type: 'text', text: JSON.stringify(listLlmConfigs(args), null, 2) }] }),
})

const deleteLlmConfigTool = defineTool({
  name: 'llm_config_delete',
  description: '删除指定 ID 的 LLM 配置。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '要删除的配置 ID' },
    },
    required: ['id'],
  },
  handler: (args) => ({ content: [{ type: 'text', text: JSON.stringify(deleteLlmConfig(args), null, 2) }] }),
})

const testLlmConnectionTool = defineTool({
  name: 'llm_config_test',
  description: '测试指定 ID 的 LLM 配置连接性。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '要测试的配置 ID' },
    },
    required: ['id'],
  },
  kind: 'read',
  handler: async (args) => ({ 
    content: [{ type: 'text', text: JSON.stringify(await testLlmConnection(args), null, 2) }] 
  }),
})

const capability = defineCapability({
  id: 'llm-config',
  title: 'LLM Config Manager',
  description: 'LLM 配置管理器，用于存储和管理大模型的连接配置',
  tags: ['service', 'llm', 'config'],
  tools: [
    echoTool,
    capabilitiesTool,
    addLlmConfigTool,
    getLlmConfigTool,
    listLlmConfigsTool,
    deleteLlmConfigTool,
    testLlmConnectionTool,
  ],
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
