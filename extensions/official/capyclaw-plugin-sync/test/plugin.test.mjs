import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { normalizeManifest, summarizeManifest, ManifestError } from '../lib/manifest.mjs'
import { createSource, createLocalSource } from '../lib/sources/index.mjs'
import { diffManifest, changesOf } from '../lib/diff.mjs'
import { buildReport } from '../lib/report.mjs'
import { applyChanges, validateChanges } from '../lib/apply.mjs'

// ---------- manifest ----------

test('manifest：归一化默认值与去空白', () => {
  const manifest = normalizeManifest({
    plugins: [{ name: '  @a/b  ', version: ' 1.0.0 ' }, { name: '@c/d', enabled: false }],
    entries: [{ entryId: ' include:x ', enabled: false }],
  })
  assert.equal(manifest.version, 1)
  assert.deepEqual(manifest.plugins, [
    { name: '@a/b', enabled: true, version: '1.0.0' },
    { name: '@c/d', enabled: false },
  ])
  assert.deepEqual(manifest.entries, [{ entryId: 'include:x', enabled: false }])
  assert.deepEqual(summarizeManifest(manifest).plugins, ['@a/b@1.0.0', '@c/d (off)'])
})

test('manifest：重复包名 / 版本不符 / 非对象都报错', () => {
  assert.throws(() => normalizeManifest({ plugins: [{ name: '@a/b' }, { name: '@a/b' }] }), ManifestError)
  assert.throws(() => normalizeManifest({ version: 2 }), /不支持的清单版本/)
  assert.throws(() => normalizeManifest([]), /必须是对象/)
  assert.throws(() => normalizeManifest({ plugins: [{ name: '' }] }), /非空字符串/)
})

// ---------- sources ----------

test('local 源：读文件并校验', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-src-'))
  const file = path.join(dir, 'manifest.json')
  await writeFile(file, JSON.stringify({ version: 1, plugins: [{ name: '@a/b' }] }))
  const source = createLocalSource({ file })
  assert.equal(source.id, 'local')
  const manifest = await source.describe()
  assert.equal(manifest.plugins[0].name, '@a/b')
})

test('local 源：文件不存在 / JSON 坏都给出明确错误', async () => {
  const source = createLocalSource({ file: path.join(os.tmpdir(), 'definitely-missing-xyz.json') })
  await assert.rejects(() => source.describe(), /清单文件不存在/)
})

test('http 源：本轮显式 NOT_IMPLEMENTED，不假装成功', async () => {
  const source = createSource({ kind: 'http', url: 'https://example.com/manifest.json' })
  await assert.rejects(() => source.describe(), (error) => error.code === 'NOT_IMPLEMENTED')
})

test('source 工厂：未知类型报错', () => {
  assert.throws(() => createSource({ kind: 'ftp' }), /未知的清单源类型/)
})

// ---------- diff ----------

test('diff：bundle 与 entry 两级差异分别列出', () => {
  const diff = diffManifest({
    desired: normalizeManifest({
      plugins: [{ name: '@a/b', enabled: true }, { name: '@c/d', enabled: false }],
      entries: [{ entryId: 'include:x', enabled: false }],
    }),
    bundles: [
      { name: '@a/b', enabled: false, version: '1.0.0' },
      { name: '@c/d', enabled: true, version: '1.0.0' },
    ],
    plugins: [{ entryId: 'include:x', moduleName: '@a/b', enabled: true }],
  })
  assert.deepEqual(diff.bundles.map((c) => `${c.name}:${c.enabled}`), ['@a/b:true', '@c/d:false'])
  assert.deepEqual(diff.entries.map((c) => `${c.entryId}:${c.enabled}`), ['include:x:false'])
  assert.equal(diff.changed, true)
  assert.deepEqual(changesOf(diff), [
    { op: 'bundle', name: '@a/b', enabled: true },
    { op: 'bundle', name: '@c/d', enabled: false },
    { op: 'entry', entryId: 'include:x', enabled: false },
  ])
})

test('diff：缺失 / 只读 / 版本差异不静默', () => {
  const diff = diffManifest({
    desired: normalizeManifest({
      plugins: [{ name: '@missing/one', version: '2.0.0' }, { name: '@a/b', version: '2.0.0' }],
      entries: [{ entryId: 'include:protected' }],
    }),
    bundles: [{ name: '@a/b', enabled: true, version: '1.0.0' }],
    plugins: [{ entryId: 'include:protected', moduleName: 'x', enabled: true, readOnlyReason: 'management-required' }],
  })
  assert.equal(diff.missing.length, 1)
  assert.match(diff.missing[0].reason, /没有这个包/)
  assert.equal(diff.readonly.length, 1)
  assert.equal(diff.readonly[0].reason, 'management-required')
  assert.deepEqual(diff.versions, [
    { name: '@a/b', desired: '2.0.0', installed: '1.0.0', kind: 'installed-vs-desired' },
  ])
  assert.equal(diff.bundles.length, 0, '已一致时不产生开关变更')
})

test('diff：bundle 带 error 时进 missing（不当作正常）', () => {
  const diff = diffManifest({
    desired: normalizeManifest({ plugins: [{ name: '@a/b' }] }),
    bundles: [{ name: '@a/b', enabled: true, error: 'patch 缺失' }],
    plugins: [],
  })
  assert.equal(diff.missing.length, 1)
  assert.match(diff.missing[0].reason, /加载出错/)
})

// ---------- report ----------

test('report：结构完整，未注入 versionProbe 时 remote 为 null', async () => {
  const report = await buildReport({
    source: { id: 'local', file: '/x/manifest.json' },
    desired: normalizeManifest({ plugins: [{ name: '@a/b' }] }),
    actual: {
      bundles: [{ name: '@a/b', version: '1.0.0', enabled: true, installed: true, rows: [{ entryId: 'include:x' }] }],
      plugins: [{ entryId: 'include:x', moduleName: '@a/b', enabled: true, fiberPhase: 'active' }],
    },
  })
  assert.equal(report.source.id, 'local')
  assert.equal(report.actual.bundles[0].name, '@a/b')
  assert.equal(report.actual.entries[0].fiberPhase, 'active')
  assert.equal(report.diff.changed, false)
  assert.equal(report.versions.remote, null)
  assert.ok(report.generatedAt)
})

test('report：注入 versionProbe 时给出远端版本（探针抛错也记录）', async () => {
  const report = await buildReport({
    source: { id: 'local' },
    desired: normalizeManifest({ plugins: [{ name: '@a/b' }] }),
    actual: { bundles: [{ name: '@a/b', version: '1.0.0', enabled: true }], plugins: [] },
    versionProbe: async ({ name }) => {
      if (name === '@a/b') return { latest: '1.2.0' }
      throw new Error('boom')
    },
  })
  assert.deepEqual(report.versions.remote, [{ name: '@a/b', installed: '1.0.0', latest: '1.2.0', error: undefined }])
})

// ---------- apply ----------

function fakeManager(overrides = {}) {
  const calls = []
  return {
    calls,
    async setBundleEnabled(name, enabled) {
      calls.push(['bundle', name, enabled])
      return { application: 'applied', changed: true, ...(overrides.bundle || {}) }
    },
    async setPluginEnabled(id, enabled) {
      calls.push(['entry', id, enabled])
      return { application: 'applied', changed: true, ...(overrides.entry || {}) }
    },
  }
}

test('apply：把变更映射到 dsh 原生调用并透传 application', async () => {
  const manager = fakeManager()
  const result = await applyChanges({
    manager,
    changes: [
      { op: 'bundle', name: '@a/b', enabled: false },
      { op: 'entry', entryId: 'include:x', enabled: true },
    ],
  })
  assert.deepEqual(manager.calls, [['bundle', '@a/b', false], ['entry', 'include:x', true]])
  assert.equal(result.ok, true)
  assert.equal(result.applied, 2)
})

test('apply：restart-required / overridden 不算成功', async () => {
  const manager = fakeManager({ bundle: { application: 'restart-required' }, entry: { application: 'overridden' } })
  const result = await applyChanges({
    manager,
    changes: [
      { op: 'bundle', name: '@a/b', enabled: false },
      { op: 'entry', entryId: 'include:x', enabled: false },
    ],
  })
  assert.equal(result.ok, false)
  assert.equal(result.pending, 2)
  assert.equal(result.failed, 0)
  assert.deepEqual(result.results.map((r) => r.application), ['restart-required', 'overridden'])
})

test('apply：抛错被收集，不中断后续（除非 stopOnFailure）', async () => {
  const manager = {
    async setBundleEnabled() { throw Object.assign(new Error('no such bundle'), { code: 'unknown-plugin' }) },
    async setPluginEnabled() { return { application: 'applied', changed: true } },
  }
  const result = await applyChanges({
    manager,
    changes: [
      { op: 'bundle', name: '@nope/x', enabled: false },
      { op: 'entry', entryId: 'include:y', enabled: true },
    ],
  })
  assert.equal(result.results.length, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.results[0].error.code, 'unknown-plugin')
  assert.equal(result.results[1].ok, true)
})

test('apply：变更形状非法时直接报错', () => {
  assert.throws(() => validateChanges([{ op: 'nope', enabled: true }]), /op 必须是/)
  assert.throws(() => validateChanges([{ op: 'bundle', enabled: true }]), /缺少 name/)
  assert.throws(() => validateChanges([{ op: 'entry', enabled: true }]), /缺少 entryId/)
  assert.throws(() => validateChanges([{ op: 'bundle', name: 'x', enabled: 'yes' }]), /必须是布尔值/)
})
