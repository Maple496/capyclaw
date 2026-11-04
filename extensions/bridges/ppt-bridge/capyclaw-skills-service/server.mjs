#!/usr/bin/env node
/**
 * capyclaw-skills-service：独立技能服务（服务解耦标准形态）。
 *
 * 职责：把原「ctx.skills 进程内注册表」的技能内容（SKILL.md）搬出 dsh
 * 进程，作为独立端口服务对外提供：
 *   GET /healthz        { ok, service, pid, port, providers, skills }
 *   GET /skills         全量技能清单（汇总各 provider）
 *   GET /skills/:name   单技能正文（原 provider.get 形状）
 *
 * dsh 侧经 dsh-service-broker 的 skills 瘦客户端（ctx.skills）访问本服务。
 * 技能数据源 = 各 capyclaw-ppt-skill-* 插件目录（不搬内容，按目录聚合）。
 *
 * 由 dsh-service-broker 按清单拉起：
 *   { "id": "dsh-skills",
 *     "cmd": ["node", "<本目录>/server.mjs", "--port", "${PORT}"],
 *     "ports": { "main": 39321 },
 *     "url": "http://127.0.0.1:${PORT}" }
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PORT = 39321

function arg(name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

function loopback(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.setTimeout(1200, () => { req.destroy(new Error('timeout')) })
    req.once('error', reject)
    req.end()
  })
}

/** 收集技能 provider：目录列表，每个须含 lib/index.mjs（导出 createProvider）。 */
async function loadProviders(dirs) {
  const providers = []
  const seen = new Set()
  for (const dir of dirs) {
    const key = path.resolve(dir).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const entry = path.join(dir, 'lib', 'index.mjs')
    if (!fs.existsSync(entry)) continue
    try {
      const mod = await import(pathToFileURL(entry).href)
      if (typeof mod.createProvider !== 'function') continue
      const provider = mod.createProvider({})
      const skills = await provider.list()
      providers.push({ dir, provider, skills })
      console.log(`[dsh-skills] provider ${path.basename(dir)}: ${skills.map((s) => s.name).join(', ') || '(空)'}`)
    } catch (err) {
      console.warn(`[dsh-skills] 跳过 ${path.basename(dir)}: ${err.message}`)
    }
  }
  return providers
}

/** 候选技能目录：四种布局都要覆盖。
 *  dev 树：../plugin/capyclaw-ppt-skill-*。
 *  npm 扁平安装：node_modules/@capyclaw/ppt-skill-*——父目录本身就是 @capyclaw
 *    作用域目录，ppt-skill-* 是它的直接子项。
 *  pnpm 提升可见时：<profile>/node_modules/@capyclaw/ppt-skill-*（同上）。
 *  pnpm 严格布局：本包真实路径在 <profile>/node_modules/.pnpm/<pkg>/node_modules/@capyclaw/skills-service，
 *    上溯 4 级是 .pnpm；技能包以虚拟目录 @capyclaw+ppt-skill-<x>@<ver> 平铺在 .pnpm 下，
 *    每个虚拟目录的真实树在其 node_modules/@capyclaw/ 里。 */
function defaultProviderDirs() {
  const roots = [
    path.resolve(HERE, '..', 'plugin'),
    path.resolve(HERE, '..'),
    path.resolve(HERE, '..', '..'),
    path.resolve(HERE, '..', '..', 'node_modules'),
    path.resolve(HERE, '..', 'node_modules'),
    path.resolve(HERE, 'node_modules'),
    path.resolve(HERE, '..', '..', '..', '..'),
  ]
  const seen = new Set()
  const dirs = []
  const add = (dir) => {
    const key = path.resolve(dir)
    if (!seen.has(key)) { seen.add(key); dirs.push(key) }
  }
  for (const root of roots) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // dev 目录名 capyclaw-ppt-skill-* 与安装态 @capyclaw/ppt-skill-* 都认（后者在作用域目录下出现）
      if (e.name.startsWith('capyclaw-ppt-skill-') || (root.endsWith('@capyclaw') && e.name.startsWith('ppt-skill-'))) {
        add(path.join(root, e.name))
      } else if (e.name === '@capyclaw') {
        // 作用域目录：扫一层，收 ppt-skill-*
        let scoped = []
        try { scoped = fs.readdirSync(path.join(root, e.name), { withFileTypes: true }) } catch { continue }
        for (const s of scoped) {
          if (s.isDirectory() && s.name.startsWith('ppt-skill-')) add(path.join(root, e.name, s.name))
        }
      } else if (e.name.startsWith('@capyclaw+ppt-skill-') && e.name.includes('@', '@capyclaw+ppt-skill-'.length)) {
        // pnpm 虚拟目录：@capyclaw+ppt-skill-<x>@<version> → 真实树在 <dir>/node_modules/@capyclaw/<x>
        const base = e.name.slice('@capyclaw+'.length).split('@')[0]
        const real = path.join(root, e.name, 'node_modules', '@capyclaw', base)
        if (fs.existsSync(path.join(real, 'package.json'))) add(real)
      }
    }
  }
  return dirs
}

async function main() {
  const port = Number(arg('--port', process.env.PORT || DEFAULT_PORT)) || DEFAULT_PORT
  const providersArg = arg('--providers', '')
  const dirs = providersArg
    ? providersArg.split(path.delimiter === ';' ? ';' : ',').map((s) => s.trim()).filter(Boolean)
    : defaultProviderDirs()

  // 复用优先：端口上已是本服务（healthz 自报 dsh-skills）→ 直接退出 0，
  // 让中间件按「已有健康实例」收编，不双开。
  try {
    const probe = await loopback('GET', `http://127.0.0.1:${port}/healthz`)
    if (probe.status === 200 && probe.text.includes('"dsh-skills"')) {
      console.log(`[dsh-skills] 端口 ${port} 已有本服务实例，复用退出`)
      process.exit(0)
    }
  } catch { /* 没有实例，正常监听 */ }

  const providers = await loadProviders(dirs)
  const byName = new Map()
  for (const { provider, skills } of providers) {
    for (const skill of skills) byName.set(skill.name, { provider, skill })
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/healthz') {
        return send(200, {
          ok: true,
          service: 'dsh-skills',
          pid: process.pid,
          port: server.address()?.port || port,
          providers: providers.length,
          skills: byName.size,
          uptimeSec: Math.round(process.uptime()),
        })
      }
      if (url.pathname === '/skills' && req.method === 'GET') {
        return send(200, { ok: true, skills: [...byName.values()].map(({ skill }) => skill) })
      }
      const hit = /^\/skills\/([^/]+)$/.exec(url.pathname)
      if (hit && req.method === 'GET') {
        const entry = byName.get(decodeURIComponent(hit[1]))
        if (!entry) return send(404, { ok: false, error: `未知 skill ${decodeURIComponent(hit[1])}` })
        return send(200, await entry.provider.get({ name: entry.skill.name }))
      }
      send(404, { ok: false, error: `未知端点 ${req.method} ${url.pathname}` })
    } catch (err) {
      send(500, { ok: false, error: err.message })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const actual = server.address().port
  console.log(`[dsh-skills] 就绪 http://127.0.0.1:${actual}/skills（${providers.length} 个 provider，${byName.size} 个技能）`)

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    console.log('[dsh-skills] 停机中…')
    await new Promise((r) => {
      try { server.closeAll(); server.close(() => r()) } catch { r() }
    })
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[dsh-skills] 启动失败:', err.message)
  process.exit(1)
})
