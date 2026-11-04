/** 进化评估器共享工具：真实 IO / 真实 HTTP，不用模型估算。 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
export const PKG = (name) => path.join(ROOT, 'packages', name)

export function pkgUrl(name, rel) {
  return pathToFileURL(path.join(PKG(name), rel)).href
}

export async function importPkg(name, rel) {
  return import(pkgUrl(name, rel))
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function rmRf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

export function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[index] * 100) / 100
}

export function median(values) {
  return percentile(values, 50)
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 5000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, bytes: Buffer.byteLength(text) }
}

/** 找一个当前可绑定的空闲端口（探测后立即释放）。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 占住一个端口（保持监听），返回关闭函数。
 * 关闭是 fire-and-forget：探测中止后会有永不结束的半开 socket，
 * 等待 close 回调会把评估器挂死，所以只触发不等待。 */
export function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(() => {
      try {
        server.closeAllConnections?.()
        server.close(() => {})
      } catch { /* 已关闭 */ }
      return Promise.resolve()
    }))
  })
}

export function round2(value) {
  return Math.round(Number(value) * 100) / 100
}

/** keep-alive GET：http.get 不解析 options.url 字段，必须显式拆 host/port/path。 */
export function httpGet(urlString, agent) {
  const target = new URL(urlString)
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      agent,
    }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
  })
}
