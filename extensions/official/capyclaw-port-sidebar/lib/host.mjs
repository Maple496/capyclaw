/**
 * dsh-port-sidebar 宿主半（Cordis 入口）。
 *
 * 不启动任何 HTTP 服务。唯一的职责：向 web 页面的开机注入表
 * （webserver/index-inject 事件）推送一行 global 数据
 * `__DSH_PORT_SIDEBAR__ = { url, restoreOnBoot }`，浏览器半据此
 * 在右侧边栏为每个会话确保存在指向该端口的 Browser tab。
 *
 * 端口注入方式（优先级从高到低）：
 *   1. config.url / 环境变量 DSH_PORT_SIDEBAR_URL（完整地址）
 *   2. config.service → 中间件 discovery（services.json）里该服务的实时 url
 *      （服务解耦标准：端口事实归 discovery，不写死）
 *   3. config.port / 环境变量 DSH_PORT_SIDEBAR_PORT（拼 http://127.0.0.1:<port>/）
 *   4. cordis.patch.yml 里的默认 config
 */
import { resolveTarget } from './url.mjs'

export const name = '@capyclaw/port-sidebar'

/** 注入到页面的全局变量名（client/client.js 读取同名全局）。 */
export const BOOT_GLOBAL = '__DSH_PORT_SIDEBAR__'

/** 目标健康探测：requireBridge 指定时，目标必须是该 bridge（防止显示错实例）。 */
const HEALTH_TIMEOUT_MS = 2500

async function probeOnce(url, expected) {
  const healthUrl = String(url).replace(/\/+$/, '') + '/healthz'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const res = await fetch(healthUrl, { signal: controller.signal })
    if (!res.ok) return false
    const body = await res.json()
    return !!body && body.bridge === expected
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/* 启动期 workbench 可能比 web 注入晚就绪：有限重试（~4s）后仍不就绪才拒绝注入。 */
async function probeBridge(url, expected, attempts = 7, delayMs = 600) {
  if (!expected) return true
  for (let i = 0; i < attempts; i++) {
    if (await probeOnce(url, expected)) return true
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return false
}

export async function apply(ctx, config = {}) {
  const target = resolveTarget(config)
  if (target === undefined) {
    console.warn('[dsh-port-sidebar] 启动时未能解析目标端口地址，本次注入不生效')
    return async () => {}
  }
  if (config.requireBridge) {
    const ok = await probeBridge(target.url, String(config.requireBridge))
    if (!ok) {
      console.error(`[dsh-port-sidebar] 目标 ${target.url} 不是 ${config.requireBridge}；拒绝注入（避免侧边栏显示错误实例）`)
      return async () => {}
    }
  }
  // 每次收集注入行都会重新 emit（读实时配置，无注册过期问题）。
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: BOOT_GLOBAL, value: target })
  })
  console.log(`[dsh-port-sidebar] 侧边栏目标: ${target.url}（bridge=${config.requireBridge || 'any'}，restoreOnBoot: ${target.restoreOnBoot}）`)
  return async () => {}
}
