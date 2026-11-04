/**
 * dsh-service-broker：中间件插件（cordis 入口）。
 *
 * 这是 dsh 进程内**唯一**允许存在的插件角色——它不承载任何业务，
 * 只做三件事：
 *   1. 按清单（config.manifest 指向 services.json）把各服务作为独立进程拉起；
 *   2. 向同进程提供 ctx.serviceBroker（list/start/stop/apply 控制面）；
 *   3. 可选：config.skills.url 指向技能服务时，提供 ctx.skills 瘦客户端
 *      （数据来自 HTTP，技能内容不再进程内注册）。
 *
 * 生命周期：keepAlive 服务（默认）不随插件卸载停止——服务独立于 dsh；
 * config.stopOnUnload === true 时才随卸载全停。
 */
import { ServiceEngine } from './engine.mjs'
import { createControlServer } from './control.mjs'
import { createSkillsClient } from './skills-client.mjs'
import { loadManifest } from './manifest.mjs'

export const name = 'service-broker'

export function apply(ctx, config = {}) {
  const engine = new ServiceEngine({
    discoveryPath: config.discoveryPath,
    logDir: config.logDir,
    log: (msg) => console.log(`[service-broker] ${msg}`),
    defaultWaitMs: Number(config.waitMs) || 20000,
  })

  const api = {
    api: { name: 'serviceBroker', version: '1.0.0', capabilities: ['apply', 'start', 'stop', 'list', 'doctor'] },
    engine,
    discoveryPath: engine.discoveryPath,
    list: () => engine.list(),
    start: (spec, options) => engine.apply([{ op: 'up', service: spec }], options),
    stop: (id) => engine.stop(id),
    apply: (commands, options) => engine.apply(commands, options),
    doctor: (id) => engine.doctor(id),
  }
  const disposeService = ctx.provide('serviceBroker', api)

  // 技能瘦客户端：ctx.skills 形状与原进程内注册表一致（list/get），
  // 数据源改为 HTTP 技能服务——技能内容不再进 dsh 进程。
  let disposeSkills = null
  if (config.skills?.url) {
    const client = createSkillsClient(config.skills.url)
    disposeSkills = ctx.provide('skills', client)
    console.log(`[service-broker] skills ← ${config.skills.url}`)
  }

  // 开机清单：有清单就按 up 命令投递给自己（幂等，复用优先）
  void (async () => {
    let services = []
    try { services = loadManifest(config.manifest) } catch (err) {
      console.warn(`[service-broker] 清单加载失败: ${err.message}`)
      return
    }
    if (!services.length) {
      console.log('[service-broker] 无开机清单，待命（服务可经控制端点/ctx.serviceBroker 投递）')
      return
    }
    try {
      const result = await engine.apply(services.map((service) => ({ op: 'up', service })))
      for (const err of result.errors) console.warn(`[service-broker] ✗ ${err.id}: ${err.error}`)
      console.log(`[service-broker] 开机清单完成：${result.services.length} 个服务就绪`)
    } catch (err) {
      console.warn(`[service-broker] 开机清单投递失败: ${err.message}`)
    }
  })()

  // 可选控制端点（embedded 一般不需要；外部投递走 standalone 形态）
  let controlServer = null
  if (Number(config.controlPort) > 0) {
    controlServer = createControlServer(engine, {
      token: process.env.DSH_BROKER_TOKEN,
      manifestPath: config.manifest,
    })
    controlServer.listen(Number(config.controlPort), '127.0.0.1', () => {
      console.log(`[service-broker] 控制端点 http://127.0.0.1:${config.controlPort}/control/*`)
    })
  }

  engine.startGuard({
    intervalMs: Number(config.guardIntervalMs) || 5000,
    maxConsecutive: Number(config.guardMaxConsecutive) || 3,
  })

  return async () => {
    if (controlServer) await new Promise((resolve) => controlServer.close(resolve))
    if (typeof disposeService === 'function') await disposeService()
    if (typeof disposeSkills === 'function') await disposeSkills()
    await engine.shutdown({ stopAll: config.stopOnUnload === true })
  }
}
