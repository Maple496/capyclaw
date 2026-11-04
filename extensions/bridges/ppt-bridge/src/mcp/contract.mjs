/**
 * MCP 工具契约的唯一真源（版本 + 报告格式）。
 *
 * 工具/能力清单由 capabilities → registry 派生；报告结构来自 dsh-tool-host。
 * 新增能力只改 capabilities/index.mjs。
 */
import { createCapabilityReport } from './shared/tool-host.mjs'

/** 工具契约版本：工具名、参数、返回结构发生不兼容变化时升 major。 */
export const CONTRACT_VERSION = '2.4.0'

/** 工作台包版本。 */
export const PACKAGE_VERSION = '2.4.3'

/** 生成模型可读的能力报告。 */
export function capabilityReport(args, editorUrl = '', runtime = {}) {
  return createCapabilityReport({
    ...args,
    contractVersion: CONTRACT_VERSION,
    packageVersion: PACKAGE_VERSION,
    editorUrl,
    runtime,
  })
}
