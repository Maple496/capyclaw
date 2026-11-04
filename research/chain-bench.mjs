#!/usr/bin/env node
/**
 * 链路热点基准：测量插件交付链（打包/分发/校验/审计）的 CPU/IO 热点。
 * 用法：node evolution/chain-bench.mjs [--rounds 20] [--json out.json]
 *
 * 输出 ops/s（越大越好）与 ms/op；用于：
 *   1) 定位结构优化目标；
 *   2) 优化前后 A/B 对比（同一台机器、同一轮次）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { stagePlugin, validateManifests } from '../plugin-development/lib/pack.mjs'
import { writeZipFromDir, readZipEntryBuffer, listZipEntryNames } from '../packages/dsh-plugin-kit/src/zip.mjs'
import { loadSuiteManifest } from '../packages/dsh-suite-kit/src/manifest.mjs'
import { resolveDomain } from '../packages/dsh-suite-kit/src/domain.mjs'
import { auditRowCoverage, clearPatchCache } from '../packages/dsh-suite-kit/lib/row-audit.mjs'
import { extractWorksFiles, loadSourceIndex } from '../packages/dsh-suite-kit/lib/works-source.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PPT_DOMAIN = path.join(REPO, 'extensions', 'bridges', 'ppt-bridge', 'domains', 'ppt')
const PPT_SUITE = path.join(REPO, 'extensions', 'bridges', 'ppt-bridge', 'plugin', 'dsh-ppt-suite')

const roundsArg = process.argv.indexOf('--rounds')
const ROUNDS = roundsArg >= 0 ? Number(process.argv[roundsArg + 1]) || 20 : 20

function timeIt(fn, rounds = ROUNDS) {
  // 预热（排除 JIT）
  for (let i = 0; i < Math.min(3, rounds); i++) fn()
  const started = performance.now()
  for (let i = 0; i < rounds; i++) fn()
  const elapsed = performance.now() - started
  return { msPerOp: elapsed / rounds, opsPerSec: 1000 / (elapsed / rounds) }
}

function fixturePlugin(root) {
  const dir = path.join(root, 'plugin')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'bench-fixture', version: '1.0.0', main: './lib/host.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['lib/', 'server/', 'cordis.patch.yml'],
  }))
  fs.writeFileSync(path.join(dir, 'lib', 'host.mjs'), 'export function apply() {}\n')
  fs.writeFileSync(path.join(dir, 'server', 'impl.mjs'), 'export const x = 1\n')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert: []\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# bench\n')
  return dir
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-bench-'))
const workFile = path.join(root, 'sample.works')
fs.writeFileSync(workFile, `%%%WORKS-META%%%
{ "name": "bench-work", "brief": "b", "view": { "kind": "deployment" }, "schema_version": "1.0.0" }

%%%WORKS-CODE%%%
{ "deployment": { "type": "domain", "source": "/tmp/x" } }
`)
const stage = path.join(root, 'stage')
fs.mkdirSync(stage, { recursive: true })
fs.writeFileSync(path.join(stage, 'bench-work.works'), fs.readFileSync(workFile))
const zipFile = path.join(root, 'bench.zip')
writeZipFromDir(stage, zipFile)
const zipBytes = fs.readFileSync(zipFile)
const pluginDir = fixturePlugin(root)
const shaPayload = crypto.randomBytes(100 * 1024)

const results = []

function bench(name, fn) {
  const r = timeIt(fn)
  results.push({ name, ...r })
  console.log(`${name.padEnd(34)} ${r.msPerOp.toFixed(3).padStart(9)} ms/op  ${Math.round(r.opsPerSec).toString().padStart(8)} ops/s`)
}

console.log(`\n=== 链路热点基准（rounds=${ROUNDS}）===`)
bench('pack.stagePlugin（fixture）', () => stagePlugin({ srcDir: pluginDir, destDir: path.join(root, '.stage-bench') }))
bench('pack.validateManifests（fixture）', () => validateManifests(pluginDir, JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))))
bench('zip.write（1 条目）', () => writeZipFromDir(stage, zipFile))
bench('zip.read entry（Buffer）', () => readZipEntryBuffer(zipBytes, 'bench-work.works'))
bench('zip.list（Buffer）', () => listZipEntryNames(zipBytes))
bench('sha256（100KB）', () => crypto.createHash('sha256').update(shaPayload).digest('hex'))
bench('works-source.extract.works', () => extractWorksFiles(zipBytes))
bench('works-source.loadIndex（本地 json）', () => loadSourceIndex(path.join(REPO, 'dist', 'index.json')))
bench('manifest.loadSuite（PPT suite）', () => loadSuiteManifest(PPT_SUITE))
bench('domain.resolve（PPT domain）', () => resolveDomain(PPT_DOMAIN))
bench('row-audit.cold（清缓存每次重读）', () => { clearPatchCache(); auditRowCoverage(PPT_DOMAIN) })
bench('row-audit.hot（重复调用走缓存）', () => auditRowCoverage(PPT_DOMAIN))

console.log('\n=== 汇总（按 ms/op 降序）===')
for (const item of [...results].sort((a, b) => b.msPerOp - a.msPerOp)) {
  console.log(`${item.name.padEnd(34)} ${item.msPerOp.toFixed(3)} ms/op`)
}

const jsonIndex = process.argv.indexOf('--json')
if (jsonIndex >= 0) {
  const out = process.argv[jsonIndex + 1]
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), rounds: ROUNDS, results }, null, 2))
  console.log(`\n已写入 ${out}`)
}

fs.rmSync(root, { recursive: true, force: true })
