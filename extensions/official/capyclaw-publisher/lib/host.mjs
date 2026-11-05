/**
 * @capyclaw/publisher 宿主插件（Cordis 入口）。
 *
 * 服务宿主、工具面全部来自公共插件；本文件只负责生命周期装配。
 * 发布动作发生在独立服务进程里（spawnSync npm），不阻塞 Cordis 事件循环。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startService } from '../server/relay.mjs'

export const name = '@capyclaw/publisher'

export async function apply(ctx, config = {}) {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const service = await startService({
    packageDir,
    port: Number(config.port) || 39700,
    hostDir: config.hostDir || process.env.DSH_PUBLISHER_HOME,
    strictPort: config.strictPort,
    lockFile: config.lockFile,
  })
  console.log(`[@capyclaw/publisher] ${service.reused ? '复用' : '启动'}服务: ${service.url}`)
  return async () => {
    await service.stop()
    console.log('[@capyclaw/publisher] 服务已停止')
  }
}
