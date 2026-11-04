/**
 * MCP 工具面：能力声明 → 注册表 → 工具清单。
 *
 * 工具 = 对内嵌执行器（上游 port-8301 语义）的最小操作面：
 * validate（结构校验）/ run（执行固定工作流）/ fixtures（在役样本清单）。
 */
import {
  defineTool, defineCapability, createRegistry, createMcpHandler,
  createCapabilityReport, buildInstructions,
} from './shared/tool-host.mjs'
import {
  flowValidate, flowRun, flowFixtures,
  workflows, invokeWorkflow, saveWorkflow, removeWorkflow, nodeCatalog, importWork,
} from './impl.mjs'

const removeWorkflowTool = defineTool({
  name: 'flow_engine_remove_workflow',
  description: '从组件仓移除一个工作流组件（联动移除 dsh-works 作品登记）。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '组件 id' },
    },
    required: ['id'],
  },
  handler: (args) => ({ content: [{ type: 'text', text: JSON.stringify(removeWorkflow(args), null, 2) }] }),
})

export const contractVersion = '1.0.0'

const runTool = defineTool({
  name: 'flow_engine_run',
  description: '执行一个固定工作流（v3 JSON 画布形或 YAML pipeline 形 DSL）。'
    + '确定性编排：input/llm/react/branch/template/http 等声明式节点按图行走，'
    + 'LLM 调用走本服务内置路由（mock 或 OpenAI 兼容转发）。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      workflow: {
        type: ['string', 'object'],
        description: 'DSL 文本（JSON 或 YAML），或 {dsl: 文本} 对象',
      },
      input: { type: 'string', maxLength: 8000, description: '本轮用户输入（注入 input 节点）' },
      user_id: { type: 'number', description: '可选，席位账号 ID（缺省 0）' },
      requester_id: { type: 'number', description: '可选，请求者 ID' },
      platform_api_url: { type: 'string', description: '可选，平台回环 API 基址（http 节点用）' },
      platform_api_token: { type: 'string', description: '可选，席位凭证（http 节点用）' },
    },
    required: ['workflow', 'input'],
  },
  handler: async (args) => {
    const r = await flowRun(args)
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
  },
})

const validateTool = defineTool({
  name: 'flow_engine_validate',
  description: '校验工作流 DSL 结构（解析/节点/边/入口出口检查），不执行不触 LLM。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      workflow: { type: ['string', 'object'], description: 'DSL 文本（JSON 或 YAML），或 {dsl: 文本} 对象' },
    },
    required: ['workflow'],
  },
  kind: 'read',
  handler: async (args) => {
    const r = await flowValidate(args)
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
  },
})

const fixturesTool = defineTool({
  name: 'flow_engine_fixtures',
  description: '列出内置的真实在役工作流样本（来自平台 work_versions 快照），可作为 workflow 入参直接执行。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  kind: 'read',
  handler: () => ({ content: [{ type: 'text', text: JSON.stringify(flowFixtures(), null, 2) }] }),
})

const workflowsTool = defineTool({
  name: 'flow_engine_workflows',
  description: '列出工作流组件仓：每个组件的 id/契约/依赖（llm、platform_api、subflows）与版本。组件可用 flow_engine_invoke 直接调用，或被 flow 节点按 workflow_id 引用组合。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  kind: 'read',
  handler: () => ({ content: [{ type: 'text', text: JSON.stringify(workflows(), null, 2) }] }),
})

const invokeTool = defineTool({
  name: 'flow_engine_invoke',
  description: '按 id 调用组件仓里的一个工作流（确定性编排技能）。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      workflow_id: { type: 'string', description: '组件 id（见 flow_engine_workflows）' },
      input: { type: 'string', maxLength: 8000, description: '本轮输入（组件 input 节点接收）' },
      user_id: { type: 'number' },
      requester_id: { type: 'number' },
      platform_api_url: { type: 'string', description: '可选，平台回环 API 基址（requires.platform_api 组件才需要）' },
      platform_api_token: { type: 'string' },
    },
    required: ['workflow_id', 'input'],
  },
  handler: async (args) => {
    const r = await invokeWorkflow(args)
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
  },
})

const saveWorkflowTool = defineTool({
  name: 'flow_engine_save_workflow',
  description: '把一个工作流 DSL 保存为组件（先过结构校验，再入仓；入仓后可被 invoke 调用或被其他工作流 flow 节点引用）。组合新流程的标准出口。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,47}$', description: '组件 id（小写 slug）' },
      name: { type: 'string', maxLength: 60 },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      description: { type: 'string', maxLength: 300 },
      dsl: { type: 'string', description: '工作流 DSL 文本（v3 JSON 或 YAML pipeline）' },
      note: { type: 'string', maxLength: 200, description: '来源备注' },
    },
    required: ['id', 'dsl'],
  },
  handler: async (args) => {
    const r = await saveWorkflow(args)
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
  },
})

const nodeCatalogTool = defineTool({
  name: 'flow_engine_node_catalog',
  description: '节点词汇目录：18 种节点类型 + flow 组合节点的用途/参数/注意事项与组合模式。拼装新工作流前先读本目录。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  kind: 'read',
  handler: () => ({ content: [{ type: 'text', text: JSON.stringify(nodeCatalog(), null, 2) }] }),
})

const importWorkTool = defineTool({
  name: 'flow_engine_import_work',
  description: '导入一个工作流作品为组件（平台 agent_proxy_json / .works 文件 / DSL 文本皆可）。校验通过后入仓，立即可被 invoke 调用或被 flow 节点引用。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      work: { type: ['string', 'object'], description: '作品工件：DSL 文本 / agent_proxy_json 对象或文本 / .works 文件全文 / {nodes,edges} v3 文档' },
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,47}$', description: '可选组件 id（缺省由作品名 slug 化）' },
      name: { type: 'string', maxLength: 60 },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      description: { type: 'string', maxLength: 300 },
      note: { type: 'string', maxLength: 200, description: '来源备注（如 WORKS-XXXX@N）' },
    },
    required: ['work'],
  },
  handler: async (args) => {
    const r = await importWork(args)
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
  },
})

const capabilitiesTool = defineTool({
  name: 'flow_engine_capabilities',
  description: '返回契约版本、工具清单和能力说明。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  kind: 'read',
  handler: () => ({ content: [{ type: 'text', text: JSON.stringify(capabilities(), null, 2) }] }),
})

const capability = defineCapability({
  id: 'flow-engine',
  title: 'dsh-flow-engine',
  description: '固定工作流执行引擎（组件化）：执行/校验/组合平台 DSL 工作流。工作流 = 组件仓内一等组件，可被 invoke 调用、被 flow 节点引用组合、由 agent 拼装入仓。',
  tags: ['service', 'workflow', 'composition'],
  tools: [runTool, validateTool, workflowsTool, invokeTool, saveWorkflowTool, removeWorkflowTool, importWorkTool, nodeCatalogTool, fixturesTool, capabilitiesTool],
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
