/**
 * L1 静态清单层（离线，秒级）：结构校验、套件/领域清单、组合预览、registry 与
 * dist 索引对齐、launchpad 扫描、28 包名按名解析。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROOT, Recorder, run, tempDir } from './harness.mjs'

const SUITE_KIT = path.join(ROOT, 'packages/capyclaw-suite-kit/bin/dsh-suite.mjs')
const SUITES = [
  ['ppt', path.join(ROOT, 'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-suite')],
  ['canvas', path.join(ROOT, 'extensions/bridges/canvas-bridge/plugin/capyclaw-canvas-suite')],
]

export async function runLayer() {
  const rec = new Recorder('L1 静态清单层')
  const { resolvePluginDir } = await import(pathToFileURL(path.join(ROOT, 'tools/capyclaw-plugin-release/lib/index.mjs')).href)

  rec.section('插件结构校验')
  rec.check('validate-all（全部插件规范校验）', run('node', ['scripts/validate-all-plugins.mjs']).status === 0)

  rec.section('套件清单（validate + compose 路径可解析）')
  for (const [name, suiteDir] of SUITES) {
    const v = run('node', [SUITE_KIT, 'validate', suiteDir])
    rec.check(`${name} suite:validate`, v.status === 0, v.stderr || v.stdout)
    const out = tempDir(`l1-compose-${name}`)
    const c = run('node', [SUITE_KIT, 'compose', suiteDir, '--out', out])
    let composed = null
    try { composed = JSON.parse(fs.readFileSync(path.join(out, 'suite-compose.json'), 'utf8')) } catch { /* 下方报 */ }
    rec.check(`${name} suite:compose 产出 suite-compose.json`, c.status === 0 && !!composed, c.stderr)
    /* manifest 的 packages[].path 是相对套件目录的包路径 */
    const manifest = JSON.parse(fs.readFileSync(path.join(suiteDir, 'dsh-suite.json'), 'utf8'))
    const paths = Object.values(manifest.packages || {}).map((e) => e.path).filter(Boolean)
    const broken = paths.filter((rel) => !fs.existsSync(path.resolve(suiteDir, rel)))
    rec.check(`${name} manifest 包路径全部可解析（${paths.length} 个）`, broken.length === 0, broken.join(', '))
    if (composed) {
      const rows = (composed.rows || []).filter((r) => !r.disabled && r.name?.startsWith('@capyclaw/'))
      const brokenRows = rows.filter((r) => { try { resolvePluginDir(r.name); return false } catch { return true } })
      rec.check(`${name} compose 本仓 row 按名可解析（${rows.length} 个）`, brokenRows.length === 0,
        brokenRows.map((r) => r.name).join(', '))
    }
    fs.rmSync(out, { recursive: true, force: true })
  }

  rec.section('领域包（canvas domains）')
  const domainDir = path.join(ROOT, 'extensions/bridges/canvas-bridge/domains/canvas')
  for (const sub of ['validate', 'resolve', 'registry']) {
    const r = run('node', [path.join(ROOT, 'packages/capyclaw-suite-kit/bin/dsh-domain.mjs'), sub, domainDir])
    rec.check(`dsh-domain ${sub} canvas`, r.status === 0, r.stderr)
  }
  const domainRegistry = run('node', [path.join(ROOT, 'packages/capyclaw-suite-kit/bin/dsh-domain.mjs'), 'registry', domainDir])
  if (domainRegistry.status === 0) {
    const raw = domainRegistry.stdout
    const start = raw.indexOf('{')
    const services = start >= 0 ? JSON.parse(raw.slice(start)) : {}
    const cmds = []
    for (const cap of Object.values(services.capabilities || {})) {
      for (const s of cap.services || []) cmds.push((s.cmd || []).join(' '))
    }
    const nested = cmds.filter((c) => /capyclaw-(canvas|ppt)-workbench.*node_modules.*(canvas|ppt)-workbench/.test(c)
      || /skills-service.*node_modules.*skills-service/.test(c))
    rec.check('activation registry 服务 cmd 无双重嵌套', nested.length === 0, nested.join(' | '))
  }

  rec.section('漂移与一致性')
  rec.check('check-suite-drift（ppt 套件元数据）', run('node', ['scripts/check-suite-drift.mjs']).status === 0)
  const checkReg = run('node', ['scripts/gen-registry.mjs', '--check'])
  rec.check('check-registry（registry 与仓库一致）', checkReg.status === 0, checkReg.stderr)

  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'capyclaw-registry.json'), 'utf8'))
  const indexPath = path.join(ROOT, 'dist/index.json')
  if (fs.existsSync(indexPath)) {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    const regNames = new Set(registry.plugins.map((p) => p.name))
    const idxNames = new Set(index.plugins.map((p) => p.name))
    const missingInIndex = [...regNames].filter((n) => !idxNames.has(n))
    rec.check(`dist/index.json 覆盖全部 registry 包（${regNames.size} 个，缺 ${missingInIndex.length}）`,
      missingInIndex.length === 0, missingInIndex.join(', ') + '（若刚构建过 dist 不应缺失；否则先跑 npm run release）')
  } else {
    rec.skip('dist/index.json 对齐', 'dist 产物不存在（先跑 npm run release）')
  }

  rec.section('launchpad 只读扫描')
  const scan = run('node', [path.join(ROOT, 'extensions/official/capyclaw-launchpad/bin/launchpad.mjs'), 'scan'])
  rec.check('launchpad scan', scan.status === 0, scan.stderr)
  const validateLp = run('node', [path.join(ROOT, 'extensions/official/capyclaw-launchpad/bin/launchpad.mjs'), 'validate', '--fail-on', 'error'])
  rec.check('launchpad validate（无 error 级问题）', validateLp.status === 0, validateLp.stderr || validateLp.stdout)

  rec.section('按名解析（Part A 回归）')
  let resolved = 0
  const failed = []
  for (const p of registry.plugins) {
    try { resolvePluginDir(p.name); resolved++ } catch { failed.push(p.name) }
  }
  rec.check(`28 个包名 resolvePluginDir 全命中（实际 ${registry.plugins.length} 个）`, failed.length === 0, failed.join(', '))

  return rec.summary()
}
