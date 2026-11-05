/**
 * @capyclaw/publisher 服务组合根。
 *
 * 宿主（端口/锁/复用/健康/指标/关闭）由 @capyclaw/service-host 提供；
 * 工具面（能力 DSL/注册表/校验/契约/MCP）由 @capyclaw/tool-host 提供；
 * 本文件只保留业务装配。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServiceApp, send } from '@capyclaw/service-host/src'
import {
  tools, contractVersion, capabilities, buildInstructions, createMcp,
} from './tools.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PORT = 39700
const SERVICE_NAME = 'capyclaw-publisher'
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))

export async function startService(options = {}) {
  const packageDir = options.packageDir || path.resolve(HERE, '..')

  const app = createServiceApp({
    id: SERVICE_NAME,
    title: PKG.meta?.title || PKG.name,
    version: PKG.version,
    contractVersion,
    slug: 'publisher',
    health: () => ({
      tools: tools.length,
    }),
  })

  const instructions = buildInstructions({
    title: PKG.meta?.title || PKG.name,
    intro: '本服务提供 publisher_* 工具，在 dsh 内发布 capyclaw 插件工程的可发布集。',
    startup: [
      '先调用 `publisher_capabilities` 确认 contractVersion 为 1.x。',
      '先 `publisher_whoami` 确认 npm 凭据可用，再 `publisher_preview` 预演。',
      '`publisher_execute` 需要显式 confirm: true，发布不可撤销。',
    ],
    capabilities: capabilities().capabilities,
    rules: ['工具返回已含逐包回执；改完一句话回复，不要重复验证。'],
  })
  const mcp = createMcp({ name: SERVICE_NAME, version: PKG.version }, instructions)
  app.use((req, res, u) => {
    if (u.pathname !== '/mcp') return false
    return mcp(req, res).then(() => true)
  })

  app.get('/api/info', (req, res) => {
    send(req, res, 200, {
      ok: true,
      name: SERVICE_NAME,
      version: PKG.version,
      contractVersion,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    })
  })

  const info = await app.listen({
    port: Number(options.port ?? DEFAULT_PORT),
    hostDir: options.hostDir,
    strictPort: options.strictPort,
    lockFile: options.lockFile,
    allowReuse: options.allowReuse !== false,
  })
  return { ...info, stop: () => info.stop() }
}
