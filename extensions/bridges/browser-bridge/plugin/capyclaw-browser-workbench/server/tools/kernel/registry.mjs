/**
 * 能力注册表：通用实现来自 dsh-tool-host；本文件只注入 Browser 的内核端口与契约报告。
 */
import { createRegistry as createBaseRegistry } from '../../shared/tool-host.mjs'
import { createKernelPorts, KERNEL_PORT_NAMES } from './ports.mjs'
import { capabilityReport } from '../../contract.mjs'

export function createRegistry(capabilities, options = {}) {
  const { toolHost = null, serverBaseUrl = '', ...rest } = options
  const factory = toolHost?.createRegistry || createBaseRegistry
  return factory(capabilities, {
    ports: createKernelPorts({ serverBaseUrl }),
    reserved: KERNEL_PORT_NAMES,
    report: ({ editorUrl = '', runtime = {}, ...args }) => capabilityReport(args, editorUrl, runtime),
    ...rest,
  })
}
