import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installDomain, resolveDomain, stageDomain, validateDomainManifest } from '../src/index.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'suite-domain-'))
  const pluginDir = join(root, 'plugin')
  mkdirSync(pluginDir)
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }))
  writeFileSync(join(pluginDir, 'index.mjs'), 'export function apply() {}\n')

  const suiteDir = join(root, 'demo-suite')
  mkdirSync(suiteDir)
  writeFileSync(join(suiteDir, 'package.json'), JSON.stringify({
    name: 'demo-suite', version: '1.0.0', type: 'module', main: './index.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' }, suite: './dsh-suite.json' },
  }))
  writeFileSync(join(suiteDir, 'index.mjs'), 'export function apply() {}\n')
  writeFileSync(join(suiteDir, 'cordis.patch.yml'), '- insert:\n    - id: demo-host\n      name: "demo-plugin"\n')
  writeFileSync(join(suiteDir, 'dsh-suite.json'), JSON.stringify({
    name: 'demo-suite', version: '1.0.0',
    packages: {
      'demo-plugin': {
        role: 'runtime', version: '^1.0.0', path: '../plugin',
        provides: { capabilities: { 'demo.runtime': '1.0.0' } },
      },
    },
    rows: [{ id: 'demo-host', name: 'demo-plugin' }],
    checks: [],
  }))

  const domainDir = join(root, 'demo-domain')
  mkdirSync(domainDir)
  writeFileSync(join(domainDir, 'dsh-domain.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', title: 'Demo',
    baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    components: ['../demo-suite'],
    profile: { name: 'domain-demo', port: 3099 },
  }))
  return { root, pluginDir, suiteDir, domainDir }
}

test('domain：校验、解析、能力图', () => {
  const f = fixture()
  const loaded = JSON.parse(fs.readFileSync(join(f.domainDir, 'dsh-domain.json'), 'utf8'))
  assert.equal(validateDomainManifest(loaded).ok, true)
  const resolved = resolveDomain(f.domainDir)
  assert.equal(resolved.suites.length, 1)
  assert.equal(resolved.composed.capabilities[0].capability, 'demo.runtime')
})

test('domain：install 生成专用 profile，只列 base/web-app/suite', () => {
  const f = fixture()
  const dshHome = join(f.root, '.dsh')
  const plan = installDomain({ domainInput: f.domainDir, dshHome, runPnpm: false })
  assert.equal(plan.profile, 'domain-demo')
  const profile = JSON.parse(fs.readFileSync(join(dshHome, 'profiles', 'domain-demo', 'package.json'), 'utf8'))
  assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'demo-suite'])
  assert.equal(profile.dshDomain.name, 'demo')
})

test('domain：rowOverrides 覆盖组合行并写入 profile patch', () => {
  const f = fixture()
  const domainFile = join(f.domainDir, 'dsh-domain.json')
  const domain = JSON.parse(fs.readFileSync(domainFile, 'utf8'))
  domain.rowOverrides = { 'demo-host': { config: { port: 3999 } } }
  writeFileSync(domainFile, JSON.stringify(domain))
  const resolved = resolveDomain(f.domainDir)
  assert.deepEqual(resolved.composed.rows.find((row) => row.id === 'demo-host').config, { port: 3999 })
  const dshHome = join(f.root, '.dsh-override')
  installDomain({ domainInput: f.domainDir, dshHome, runPnpm: false })
  const patch = fs.readFileSync(join(dshHome, 'profiles', 'domain-demo', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /config: \{"port":3999\}/)
})

test('domain：stage 只复制选中组件', () => {
  const f = fixture()
  const out = join(f.root, 'pack')
  const result = stageDomain({ domainInput: f.domainDir, outDir: out })
  assert.ok(fs.existsSync(join(out, 'components', 'demo-suite', 'dsh-suite.json')))
  assert.ok(fs.existsSync(join(out, 'components', 'demo-plugin', 'package.json')))
  assert.ok(fs.existsSync(join(out, 'domain.json')))
  assert.equal(result.components.length, 2)
})
