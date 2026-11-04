#!/usr/bin/env node
/**
 * 全模块基线基准。
 *
 * 每个模块给出一组真实可复现的数字（吞吐/延迟/内存），作为
 * docs/MODULE_EVALUATION.md 中「是否需要性能优化」的依据。
 *
 * 用法：node bench/module-baseline.mjs [--out bench/results/module-baseline.json]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORKSPACE = path.resolve(ROOT, '..', '..')
const PKG = path.join(ROOT, 'plugin', 'capyclaw-ppt-workbench')
const SUITE = path.join(ROOT, 'plugin', 'capyclaw-ppt-suite')
const pkgUrl = (rel) => pathToFileURL(path.join(PKG, rel)).href

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] * 100) / 100
}

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10
}

async function benchServiceHost() {
  const { createServiceApp } = await import('@capyclaw/service-host/src')
  const app = createServiceApp({ id: 'bench-host', health: () => ({ ok: true }) })
  const info = await app.listen({ port: 0, allowReuse: false })
  const latencies = []
  for (let i = 0; i < 300; i++) {
    const started = performance.now()
    const res = await fetch(`${info.url}/healthz`)
    await res.text()
    latencies.push(performance.now() - started)
  }
  const started = performance.now()
  await Promise.all(Array.from({ length: 100 }, () => fetch(`${info.url}/healthz`).then((r) => r.text())))
  const concurrentMs = performance.now() - started
  await app.close()
  return {
    requests: 300,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    rps: Math.round(300 / (latencies.reduce((a, b) => a + b, 0) / 1000)),
    concurrent100Ms: Math.round(concurrentMs),
  }
}

async function benchToolHost() {
  const { createRegistry } = await import(pkgUrl('server/tools.mjs'))
  const { validateToolArguments } = await import('@capyclaw/plugin-kit/tools/validate')
  const started = performance.now()
  const registry = createRegistry((await import(pkgUrl('server/tools.mjs'))).CAPABILITIES, {})
  const startupMs = performance.now() - started
  const tool = registry.TOOLS.find((item) => item.name === 'ppt_capabilities')
  const args = {}
  const iter = 10000
  const validateStart = performance.now()
  for (let i = 0; i < iter; i++) validateToolArguments(tool, args)
  const validateMs = performance.now() - validateStart
  const callStart = performance.now()
  for (let i = 0; i < 500; i++) await registry.TOOL_IMPL.ppt_capabilities({})
  const callMs = performance.now() - callStart
  return {
    registryStartupMs: Math.round(startupMs * 10) / 10,
    toolCount: registry.TOOLS.length,
    validateOpsPerSec: Math.round(iter / (validateMs / 1000)),
    capabilityCallsPerSec: Math.round(500 / (callMs / 1000)),
  }
}

async function benchStateService() {
  const { FileStateBackend } = await import('dsh-state-service/src')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-state-'))
  try {
    const backend = new FileStateBackend(path.join(dir, 'state.json'), { initialDoc: { seq: 0 } })
    const iter = 500
    const started = performance.now()
    for (let i = 0; i < iter; i++) backend.writeState({ seq: i, deck: { slides: [] } })
    const writeMs = performance.now() - started
    const readStart = performance.now()
    for (let i = 0; i < iter; i++) backend.readState()
    const readMs = performance.now() - readStart
    return {
      writeOpsPerSec: Math.round(iter / (writeMs / 1000)),
      readOpsPerSec: Math.round(iter / (readMs / 1000)),
      stateBytes: fs.statSync(path.join(dir, 'state.json')).size,
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function benchAssetService() {
  const { createFileAssetStore } = await import('@capyclaw/asset-service/src')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-asset-'))
  try {
    const store = createFileAssetStore({ dir })
    const payload = Buffer.alloc(256 * 1024, 7)
    const iter = 120
    const started = performance.now()
    let last = null
    for (let i = 0; i < iter; i++) {
      last = await store.put(Buffer.concat([payload, Buffer.from([i % 256])]), 'image/png')
    }
    const writeMs = performance.now() - started
    const readStart = performance.now()
    for (let i = 0; i < iter; i++) store.get(last.id)
    const readMs = performance.now() - readStart
    return {
      writeMbPerSec: Math.round((iter * payload.length / 1024 / 1024) / (writeMs / 1000) * 10) / 10,
      readMbPerSec: Math.round((iter * payload.length / 1024 / 1024) / (readMs / 1000) * 10) / 10,
      writeMs: Math.round(writeMs),
      readMs: Math.round(readMs),
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function benchEditorHost() {
  const { createServiceApp } = await import('@capyclaw/service-host/src')
  const { createEditorHost } = await import('@capyclaw/editor-host/src')
  const { EDITOR_FILES } = await import(pkgUrl('server/constants.mjs'))
  const host = createEditorHost({ id: 'bench-editor', dir: path.join(PKG, 'editor'), files: EDITOR_FILES })
  const app = createServiceApp({ id: 'bench-editor-host' })
  app.use(host.staticRoutes)
  const info = await app.listen({ port: 0, allowReuse: false })
  try {
    const latencies = []
    for (let i = 0; i < 200; i++) {
      const started = performance.now()
      const res = await fetch(`${info.url}/app.js`)
      await res.text()
      latencies.push(performance.now() - started)
    }
    return {
      appJsP50Ms: percentile(latencies, 50),
      appJsP95Ms: percentile(latencies, 95),
      appJsRps: Math.round(200 / (latencies.reduce((a, b) => a + b, 0) / 1000)),
    }
  } finally {
    await app.close()
  }
}

async function benchWorkbench() {
  const { evaluateRelay } = await import('./evolution/evaluators.mjs')
  const { relayGenome, relayTuning } = await import('./evolution/genomes.mjs')
  const founder = Object.fromEntries(relayGenome.map((gene) => [gene.name, gene.founder]))
  const result = await evaluateRelay(founder, relayTuning(founder))
  return result.objectives
}

async function benchSkills() {
  const { createProvider } = await import(pathToFileURL(path.join(ROOT, 'plugin/dsh-ppt-skills/lib/index.mjs')).href)
  const provider = createProvider()
  const candidates = await provider.list()
  const listStart = performance.now()
  for (let i = 0; i < 1000; i++) await provider.list()
  const listMs = performance.now() - listStart
  const getStart = performance.now()
  for (let i = 0; i < 200; i++) await provider.get(candidates[i % candidates.length], {})
  const getMs = performance.now() - getStart
  return {
    skills: candidates.length,
    listOpsPerSec: Math.round(1000 / (listMs / 1000)),
    getOpsPerSec: Math.round(200 / (getMs / 1000)),
    avgSkillBytes: Math.round(candidates.reduce((sum, item) => sum + (item.description?.length || 0), 0) / candidates.length),
  }
}

async function benchSuite() {
  const { loadSuiteManifest, validateSuiteManifest, composeSuites } = await import('dsh-suite-kit')
  const iter = 100
  const started = performance.now()
  let loaded = null
  for (let i = 0; i < iter; i++) loaded = loadSuiteManifest(SUITE)
  const loadMs = performance.now() - started
  const validateStart = performance.now()
  for (let i = 0; i < iter; i++) validateSuiteManifest(loaded.manifest, { baseDir: loaded.dir })
  const validateMs = performance.now() - validateStart
  const composeStart = performance.now()
  for (let i = 0; i < 50; i++) composeSuites([loaded])
  const composeMs = performance.now() - composeStart
  return {
    packages: Object.keys(loaded.manifest.packages).length,
    rows: loaded.manifest.rows.length,
    loadOpsPerSec: Math.round(iter / (loadMs / 1000)),
    validateOpsPerSec: Math.round(iter / (validateMs / 1000)),
    composeOpsPerSec: Math.round(50 / (composeMs / 1000)),
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  rssMbBefore: rssMb(),
  modules: {},
}

const suite = [
  ['@capyclaw/service-host', benchServiceHost],
  ['@capyclaw/tool-host', benchToolHost],
  ['dsh-state-service', benchStateService],
  ['@capyclaw/asset-service', benchAssetService],
  ['@capyclaw/editor-host', benchEditorHost],
  ['capyclaw-ppt-workbench', benchWorkbench],
  ['dsh-ppt-skills', benchSkills],
  ['capyclaw-ppt-suite', benchSuite],
]

for (const [name, fn] of suite) {
  const started = performance.now()
  try {
    const metrics = await fn()
    out.modules[name] = { ok: true, metrics, elapsedMs: Math.round(performance.now() - started) }
    console.log(`✓ ${name}: ${JSON.stringify(metrics)}`)
  } catch (error) {
    out.modules[name] = { ok: false, error: String(error && error.message || error), elapsedMs: Math.round(performance.now() - started) }
    console.log(`✗ ${name}: ${error && error.message || error}`)
  }
}
out.rssMbAfter = rssMb()

const target = path.resolve(ROOT, arg('out', 'bench/results/module-baseline.json'))
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n')
console.log(`\n→ ${target}`)
