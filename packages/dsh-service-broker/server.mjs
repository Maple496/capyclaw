#!/usr/bin/env node
/**
 * dsh-service-broker standalone 入口：中间件以独立端口服务运行。
 *
 * 这是桌面/外部场景的主形态：启动清单（作品/后端）不直接拉服务，
 * 而是把结构化命令 POST 到这里的 /control/apply，由中间件统一执行。
 *
 * 用法：
 *   node server.mjs [--port 39610] [--manifest services.json]
 *                   [--discovery ~/.dsh/services.json] [--stop-on-exit]
 *
 * 环境变量：DSH_BROKER_TOKEN（设置后 /control/* 需带 x-broker-token）。
 */
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { receiptDir } from './lib/recovery.mjs'
import { fileURLToPath } from 'node:url'
import { ServiceEngine } from './lib/engine.mjs'
import { createControlServer } from './lib/control.mjs'
import { loadManifest } from './lib/manifest.mjs'

function arg(name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const port = Number(arg('--port', process.env.DSH_BROKER_PORT || 39610))
const manifestPath = arg('--manifest', undefined)
const discoveryPath = arg('--discovery', undefined)
const stopOnExit = process.argv.includes('--stop-on-exit')

const engine = new ServiceEngine({
  discoveryPath,
  log: (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`),
})

// Existence distinguishes a broker with receipt support from a legacy broker.
mkdirSync(receiptDir(engine.discoveryPath), { recursive: true })

// 开机清单：幂等（复用优先），失败不阻断中间件自身启动
try {
  const services = loadManifest(manifestPath)
  if (services.length) {
    const result = await engine.apply(services.map((service) => ({ op: 'up', service })))
    for (const err of result.errors) console.warn(`✗ ${err.id}: ${err.error}`)
    console.log(`开机清单完成：${result.services.length} 个服务就绪`)
  } else {
    console.log('开机清单为空，待命（等待 /control/apply 投递）')
  }
} catch (err) {
  console.warn(`开机清单失败: ${err.message}`)
}

engine.startGuard()
const server = createControlServer(engine, { token: process.env.DSH_BROKER_TOKEN, manifestPath })
server.listen(port, '127.0.0.1', () => {
  console.log(`dsh-service-broker 就绪: http://127.0.0.1:${port}/control/*`)
  console.log(`discovery: ${engine.discoveryPath}`)
})

let exiting = false
async function shutdown() {
  if (exiting) return
  exiting = true
  console.log('中间件停机…')
  await new Promise((resolve) => server.close(resolve))
  await engine.shutdown({ stopAll: stopOnExit })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('break', shutdown)
