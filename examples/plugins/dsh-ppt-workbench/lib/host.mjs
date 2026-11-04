/**
 * dsh-ppt-workbench 宿主插件（cordis 入口，loader 经包名加载本模块）。
 *
 * apply 里进程内拉起桥 relay（桥端点 + /mcp + 编辑器静态页），返回
 * disposer——插件停用时关闭 relay（官方 remote-access 等同款生命周期）。
 * 零 @deepseek-ai 依赖：只用 node 内置模块，最小化跨版本耦合。
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ppt-workbench-host'

export async function apply(ctx, config) {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { startRelay, DEFAULT_PORT } = await import('../server/relay.mjs')
  const relay = await startRelay({
    packageDir,
    port: (config && Number(config.port)) || DEFAULT_PORT,
    hostDir: (config && config.hostDir)
      || process.env.PPT_BRIDGE_HOME
      || path.join(os.homedir(), '.dsh-ppt-bridge'),
  })
  const line = relay.reused
    ? `[ppt-workbench] 复用已运行的桥: ${relay.url}`
    : `[ppt-workbench] 桥已就绪: ${relay.url}`
  console.log(line)
  console.log(`[ppt-workbench] 编辑器: ${relay.editorUrl} （浏览器打开即用）`)
  if (relay.reused) console.log('[ppt-workbench] 注意：实际端口可能不是 39311，/mcp 以 patch 静态 URL 为准')
  return async () => {
    await relay.stop()
    console.log('[ppt-workbench] 桥已停止')
  }
}
