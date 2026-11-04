import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor, installSuites, packPackage, renderCordisPatch, stripPatchRows } from '../src/index.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'suite-profile-'))
  const dshHome = join(root, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'test-profile',
    private: true,
    dependencies: { 'legacy-plugin': 'link:../legacy-plugin' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'legacy-plugin'] } },
  }, null, 2))

  const pluginDir = join(root, 'fake-plugin')
  mkdirSync(pluginDir)
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: 'fake-plugin',
    version: '1.2.0',
    dsh: { apiVersion: '1.0.0' },
  }))
  writeFileSync(join(pluginDir, 'index.mjs'), 'export function apply() {}\n')

  const suiteDir = join(root, 'fake-suite')
  mkdirSync(suiteDir)
  writeFileSync(join(suiteDir, 'package.json'), JSON.stringify({
    name: 'fake-suite', version: '1.0.0', type: 'module', main: './index.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' }, suite: './dsh-suite.json' },
  }))
  writeFileSync(join(suiteDir, 'index.mjs'), 'export function apply() {}\n')
  writeFileSync(join(suiteDir, 'cordis.patch.yml'), renderCordisPatch([{ id: 'fake-host', name: 'fake-plugin' }]))
  writeFileSync(join(suiteDir, 'dsh-suite.json'), JSON.stringify({
    name: 'fake-suite',
    version: '1.0.0',
    packages: {
      'fake-plugin': { role: 'runtime', version: '^1.2.0', path: '../fake-plugin' },
    },
    rows: [{ id: 'fake-host', name: 'fake-plugin' }],
    checks: [],
  }))

  return { root, dshHome, profileDir, suiteDir, pluginDir }
}

test('installSuites：写 profile、只把 suite 放进 bundles、建 junction', () => {
  const f = fixture()
  const plan = installSuites({
    suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, runPnpm: false,
    removeDependencies: ['legacy-plugin'],
  })
  assert.equal(plan.suites[0], 'fake-suite')
  const manifest = JSON.parse(fs.readFileSync(join(f.profileDir, 'package.json'), 'utf8'))
  assert.ok(manifest.dependencies['fake-suite'].startsWith('link:'))
  assert.equal(manifest.dependencies['legacy-plugin'], undefined)
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'fake-suite'])
  assert.deepEqual(manifest.dshSuiteKit.managedPackages, ['fake-plugin'])
  assert.ok(fs.existsSync(join(f.profileDir, 'node_modules', 'fake-suite')))
  assert.ok(fs.existsSync(join(f.profileDir, 'node_modules', 'fake-plugin')))
})

test('installSuites：写入 profile 级组合锁并可对比', () => {
  const f = fixture()
  const first = installSuites({ suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, runPnpm: false })
  assert.deepEqual(first.lockChanges, [])
  const lockFile = join(f.profileDir, 'dsh-composition.lock.json')
  assert.ok(fs.existsSync(lockFile))
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  assert.equal(lock.version, 1)
  assert.equal(lock.profile, 'web')
  assert.equal(lock.suites[0].name, 'fake-suite')
  assert.equal(lock.packages['fake-plugin'].version, '1.2.0')
  assert.equal(lock.packages['fake-plugin'].apiVersion, '1.0.0')

  const second = installSuites({ suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, runPnpm: false })
  assert.deepEqual(second.lockChanges, [])

  const stale = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  stale.packages['fake-plugin'].version = '0.9.0'
  stale.packages['fake-plugin'].apiVersion = '2.0.0'
  fs.writeFileSync(lockFile, JSON.stringify(stale, null, 2))
  const third = installSuites({ suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, runPnpm: false })
  assert.ok(third.lockChanges.some((change) => change.type === 'updated' && change.name === 'fake-plugin'))
  assert.ok(third.lockChanges.some((change) => change.type === 'api-major' && change.name === 'fake-plugin'))
  assert.ok(third.warnings.some((warning) => warning.includes('API major')))
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).packages['fake-plugin'].version, '1.2.0')
})

test('installSuites：校验 suite 自带 composition.lock', () => {
  const f = fixture()
  writeFileSync(join(f.suiteDir, 'composition.lock.json'), JSON.stringify({
    suite: 'fake-suite',
    suiteVersion: '9.9.9',
    packages: { 'fake-plugin': { version: '1.2.0', apiVersion: '1.0.0' } },
  }, null, 2))
  const plan = installSuites({ suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, runPnpm: false })
  assert.ok(plan.warnings.some((warning) => warning.includes('manifest 1.0.0')))
})

test('installSuites：dry-run 不写组合锁', () => {
  const f = fixture()
  installSuites({ suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, dryRun: true, runPnpm: false })
  assert.equal(fs.existsSync(join(f.profileDir, 'dsh-composition.lock.json')), false)
})

test('installSuites：dry-run 不写文件', () => {
  const f = fixture()
  const before = fs.readFileSync(join(f.profileDir, 'package.json'), 'utf8')
  installSuites({ suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, dryRun: true, runPnpm: false })
  assert.equal(fs.readFileSync(join(f.profileDir, 'package.json'), 'utf8'), before)
  assert.equal(fs.existsSync(join(f.profileDir, 'node_modules')), false)
})

test('installSuites：packageSpecs 覆盖版本，rollbackTo 按锁回滚', () => {
  const f = fixture()
  const artifactRoot = mkdtempSync(join(tmpdir(), 'suite-artifacts-'))

  const v13 = join(f.root, 'fake-plugin-1.3.0')
  fs.cpSync(f.pluginDir, v13, { recursive: true })
  const pkg13 = JSON.parse(fs.readFileSync(join(v13, 'package.json'), 'utf8'))
  pkg13.version = '1.3.0'
  fs.writeFileSync(join(v13, 'package.json'), JSON.stringify(pkg13, null, 2))
  packPackage(v13, { root: artifactRoot })

  const plan = installSuites({
    suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, runPnpm: false,
    packageSpecs: ['fake-plugin@1.3.0'], artifactRoot,
  })
  assert.equal(plan.overrides[0].version, '1.3.0')
  assert.match(fs.realpathSync(join(f.profileDir, 'node_modules', 'fake-plugin')), /1\.3\.0/)
  assert.equal(JSON.parse(fs.readFileSync(join(f.profileDir, 'dsh-composition.lock.json'), 'utf8')).packages['fake-plugin'].version, '1.3.0')

  packPackage(f.pluginDir, { root: artifactRoot, force: true })
  const targetLock = join(f.root, 'rollback.lock.json')
  fs.writeFileSync(targetLock, JSON.stringify({
    version: 1, profile: 'web', suites: [],
    packages: { 'fake-plugin': { version: '1.2.0' } },
  }, null, 2))
  const rolled = installSuites({
    suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, runPnpm: false,
    rollbackTo: targetLock, artifactRoot,
  })
  assert.equal(rolled.rollbackTo, targetLock)
  assert.equal(rolled.overrides[0].version, '1.2.0')
  assert.match(fs.realpathSync(join(f.profileDir, 'node_modules', 'fake-plugin')), /1\.2\.0/)
  assert.equal(JSON.parse(fs.readFileSync(join(f.profileDir, 'dsh-composition.lock.json'), 'utf8')).packages['fake-plugin'].version, '1.2.0')
})

test('stripPatchRows：移除旧 insert 块和顶层 id 块，保留其他行', () => {
  const input = [
    '# header',
    '- insert:',
    '    - id: old-host',
    '      name: old-plugin',
    '    - id: mcp-old',
    '      name: "@scope/mcp"',
    '      config: {"x":1}',
    '- id: keep-me',
    '  name: keep-plugin',
    '- id: old-row',
    '  name: old-plugin',
  ].join('\n')
  const output = stripPatchRows(input, ['old-host', 'mcp-old', 'old-row'])
  assert.ok(!output.includes('old-host'))
  assert.ok(!output.includes('mcp-old'))
  assert.ok(!output.includes('old-row'))
  assert.ok(output.includes('keep-me'))
  assert.ok(output.includes('# header'))
})

test('doctor：无 checks 且包存在时通过', async () => {
  const f = fixture()
  installSuites({ suiteInputs: [f.suiteDir], profile: 'web', dshHome: f.dshHome, runPnpm: false })
  const report = await doctor({ profile: 'web', dshHome: f.dshHome })
  assert.equal(report.ok, true)
  assert.deepEqual(report.errors, [])
})
