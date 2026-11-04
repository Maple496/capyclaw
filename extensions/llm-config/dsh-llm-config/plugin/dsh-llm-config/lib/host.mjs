/**
 * LLM Config Manager 宿主插件（Cordis 入口）。
 *
 * 服务宿主、工具面、状态、资产、编辑器全部来自公共插件；
 * 本文件只负责生命周期装配。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startService } from '../server/relay.mjs'

export const name = 'dsh-llm-config-host'

export async function apply(ctx, config = {}) {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const service = await startService({
    packageDir,
    port: Number(config.port) || 39600,
    hostDir: config.hostDir || process.env.DSH_LLM_CONFIG_HOME,
    strictPort: config.strictPort,
    lockFile: config.lockFile,
  })
  console.log(`[dsh-llm-config] ${service.reused ? '复用' : '启动'}服务: ${service.url}`)
  return async () => {
    await service.stop()
    console.log('[dsh-llm-config] 服务已停止')
  }
}
