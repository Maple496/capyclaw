/**
 * plugin-release 自测（node:test，无外部依赖）。
 *
 * 覆盖：发布闸拒收、zip 内容自足、索引生成、版本收敛、整源打包。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildIndex, compareVersions, discoverPlugins, packSource, pickEntry,
  readIndex, releasePlugin, resolvePluginDir, REPO_ROOT,
} from '../lib/index.mjs'
import { listZipEntries } from '@capyclaw/plugin-kit/packaging/zip'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-'))
}

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
}

/** 造一个最小可发布插件（规范验证器 + 发布闸都能过）。 */
function makePlugin(root, overrides = {}) {
  const dir = path.join(root, 'extensions/official', overrides.name || 'dsh-probe')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'index.mjs'), 'export const name = "probe"\n')
  fs.writeFileSync(path.join(dir, 'test', 'plugin.test.mjs'), 'console.log("ok")\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# probe\n\n这是一个用于发布自测的最小插件，README 足够长以满足验证器要求。\n')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: probe\n      name: probe\n')
  const pkg = {
    name: 'dsh-probe',
    version: '1.0.0',
    description: 'probe',
    type: 'module',
    main: './lib/index.mjs',
    exports: { '.': './lib/index.mjs', './package.json': './package.json' },
    dependencies: { '@capyclaw/plugin-kit': '^0.2.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, category: 'ui', platform: 'web' },
    meta: { title: 'Probe', description: 'probe plugin' },
    files: ['lib/', 'test/', 'cordis.patch.yml', 'README.md'],
    scripts: { test: 'node test/plugin.test.mjs' },
    private: true,
    engines: { dsh: '^0.2.0-rc.2' },
  }
  writeJson(path.join(dir, 'package.json'), { ...pkg, ...overrides.pkg })
  return dir
}

test('resolvePluginDir：名字与路径两种形态都能解析', () => {
  assert.equal(path.basename(resolvePluginDir('@capyclaw/port-sidebar')), 'capyclaw-port-sidebar')
  assert.equal(path.basename(resolvePluginDir('port-sidebar')), 'capyclaw-port-sidebar')
  assert.equal(
    resolvePluginDir('extensions/official/capyclaw-port-sidebar'),
    path.join(REPO_ROOT, 'extensions', 'official', 'capyclaw-port-sidebar'))
  assert.throws(() => resolvePluginDir('dsh-does-not-exist'), /找不到插件/)
})

test('discoverPlugins：扫到官方插件且不重复', () => {
  const names = discoverPlugins().map((dir) => path.basename(dir))
  assert.ok(names.includes('capyclaw-port-sidebar'))
  assert.equal(new Set(names).size, names.length)
})

test('releasePlugin：产出 zip，内含 package.json / patch / 内置依赖', async () => {
  const out = tmpDir()
  const result = await releasePlugin('@capyclaw/port-sidebar', { out })
  assert.ok(fs.existsSync(result.outFile))
  const entries = listZipEntries(result.outFile)
  assert.ok(entries.includes('package.json'))
  assert.ok(entries.includes('cordis.patch.yml'))
  assert.ok(entries.includes('lib/host.mjs'))
  // dsh-plugin-kit 是 workspace 包：必须随包内置，独立目录才能解析
  assert.ok(entries.some((e) => e.startsWith('node_modules/dsh-plugin-kit/package.json')))
  assert.deepEqual(result.vendored, ['@capyclaw/plugin-kit'])
})

test('releasePlugin：缺 engines.dsh 被发布闸拒收', async () => {
  const root = tmpDir()
  makePlugin(root, { pkg: { engines: undefined } })
  await assert.rejects(
    () => releasePlugin('dsh-probe', { out: tmpDir(), root, vendor: false }),
    /engines\.dsh/)
})

test('releasePlugin：dependencies 里带 link: 被发布闸拒收', async () => {
  const root = tmpDir()
  makePlugin(root, { pkg: { dependencies: { '@capyclaw/plugin-kit': '^0.2.0', 'ghost': 'link:../ghost' } } })
  await assert.rejects(
    () => releasePlugin('dsh-probe', { out: tmpDir(), root, vendor: false }),
    /源码树本地路径/)
})

test('releasePlugin：patch 指向的文件不存在被发布闸拒收', async () => {
  const root = tmpDir()
  const dir = makePlugin(root)
  fs.rmSync(path.join(dir, 'cordis.patch.yml'))
  await assert.rejects(
    () => releasePlugin('dsh-probe', { out: tmpDir(), root, vendor: false }),
    /指向的文件不存在/)
})

test('buildIndex + readIndex + pickEntry：索引自证、最新版标记', async () => {
  const out = tmpDir()
  const released = await releasePlugin('@capyclaw/port-sidebar', { out })
  const index = buildIndex(out)
  assert.equal(index.schema, 1)
  assert.equal(index.plugins.length, 1)
  assert.equal(index.plugins[0].name, '@capyclaw/port-sidebar')
  assert.equal(index.plugins[0].latest, true)
  assert.match(index.plugins[0].sha256, /^[0-9a-f]{64}$/)
  assert.equal(pickEntry(index, '@capyclaw/port-sidebar').version, released.pkg.version)
  assert.throws(() => pickEntry(index, 'dsh-nope'), /源里没有插件/)

  const reread = readIndex(out)
  assert.deepEqual(reread.plugins.map((p) => p.name), index.plugins.map((p) => p.name))
})

test('compareVersions：语义序 + 预发布低于正式', () => {
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0)
  assert.ok(compareVersions('1.10.0', '1.2.0') > 0)
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0)
  assert.ok(compareVersions('1.0.0-rc.2', '1.0.0') < 0)
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.2') > 0)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})

test('packSource：整源打成单一 zip，含 index.json 与插件包', async () => {
  const out = tmpDir()
  await releasePlugin('@capyclaw/port-sidebar', { out })
  buildIndex(out)
  const result = packSource(out, { outFile: path.join(tmpDir(), 'src.zip') })
  assert.ok(fs.existsSync(result.outFile))
  const entries = listZipEntries(result.outFile)
  assert.ok(entries.includes('index.json'))
  assert.ok(entries.some((e) => e.includes('port-sidebar')))
})
