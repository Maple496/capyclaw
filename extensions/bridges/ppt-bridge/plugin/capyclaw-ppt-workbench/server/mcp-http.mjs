/** 兼容入口：MCP HTTP 协议壳与 instructions 已拆到 server/mcp/*。 */
export { createMcpHandler } from './mcp/handler.mjs'
export { serverInstructions } from './mcp/instructions.mjs'
