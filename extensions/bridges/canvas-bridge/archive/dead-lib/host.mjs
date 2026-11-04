/**
 * capyclaw-canvas-workbench 宿主插件（cordis 入口）。
 *
 * apply 里进程内拉起 MCP relay（/mcp），返回 disposer——插件停用时关闭。
 * 零 @deepseek-ai 依赖：只用 node 内置模块。
 *
 * 注意：工具真正操作的是「桌面网关 + canvas.works 窗口」。若桌面没开，
 * 工具调用会返回「桌面网关未启动」的明确错误，不会静默。
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'canvas-workbench-host'

export async function apply(ctx, config) {
  const { startRelay, DEFAULT_PORT } = await import('../server/relay.mjs')
  const relay = await startRelay({
    port: (config && Number(config.port)) || DEFAULT_PORT,
  })
  console.log(`[canvas-workbench] MCP 已就绪: ${relay.url}/mcp`)
  return async () => {
    await relay.close()
    console.log('[canvas-workbench] MCP relay 已停止')
  }
}
