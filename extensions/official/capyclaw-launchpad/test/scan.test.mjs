import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { scan } from '../lib/scan.mjs'
import { FIXTURE, FIXTURE_DSH_HOME, HERE } from './helpers.mjs'

async function fixtureScan(extra = {}) {
  return scan({
    roots: [FIXTURE],
    dshHome: FIXTURE_DSH_HOME,
    cwd: FIXTURE,
    ...extra,
  })
}

test('扫描识别四类清单并排除 node_modules/archives', async () => {
  const result = await fixtureScan()
  const types = result.manifests.map((manifest) => manifest.type)
  assert.equal(result.manifests.length, 8)
  assert.equal(types.filter((type) => type === 'broker').length, 3)
  assert.equal(types.filter((type) => type === 'works').length, 2)
  assert.equal(types.filter((type) => type === 'domain').length, 1)
  assert.equal(types.filter((type) => type === 'launcher').length, 1)
  assert.equal(types.filter((type) => type === 'profile').length, 1)
  assert.ok(result.filesScanned >= 9)
  assert.ok(!result.manifests.some((manifest) => manifest.path.includes('node_modules')))
  assert.ok(!result.manifests.some((manifest) => manifest.path.includes('archives')))
})

test('discovery 文件不会被误判成 broker 清单', async () => {
  const result = await fixtureScan()
  const discovery = path.join(FIXTURE, 'config', 'state', 'services.json')
  assert.ok(!result.manifests.some((manifest) => manifest.path === discovery))
  assert.ok(result.skipped.some((item) => item.reason === 'not-a-launch-manifest'))
})

test('清单 id 在重复扫描间稳定', async () => {
  const first = await fixtureScan()
  const second = await fixtureScan()
  const ids = (result) => result.manifests.map((manifest) => manifest.id).sort()
  assert.deepEqual(ids(first), ids(second))
})

test('maxDepth 生效', async () => {
  const result = await fixtureScan({ maxDepth: 1 })
  assert.equal(result.manifests.filter((manifest) => manifest.type === 'broker').length, 0)
  assert.ok(result.skipped.some((item) => item.reason === 'max-depth'))
})

test('fixtures 目录默认排除，显式 root 仍可扫描', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launchpad-fixtures-'))
  try {
    await mkdir(path.join(dir, 'fixtures'), { recursive: true })
    await writeFile(path.join(dir, 'fixtures', 'services.json'), JSON.stringify({
      services: [{ id: 'hidden', cmd: ['node', 'x.mjs'] }],
    }))
    await mkdir(path.join(dir, 'tools'), { recursive: true })
    await writeFile(path.join(dir, 'tools', 'services.json'), JSON.stringify({
      services: [{ id: 'visible', cmd: ['node', 'x.mjs'] }],
    }))
    const result = await scan({
      roots: [dir],
      dshHome: path.join(dir, 'home'),
      includeProfiles: false,
      cwd: dir,
    })
    assert.equal(result.manifests.length, 1)
    assert.equal(result.manifests[0].relativePath, 'tools/services.json')

    const explicit = await scan({
      roots: [path.join(dir, 'fixtures')],
      dshHome: path.join(dir, 'home'),
      includeProfiles: false,
      cwd: dir,
    })
    assert.equal(explicit.manifests.length, 1)
    assert.ok(explicit.manifests[0].relativePath.includes('fixtures/services.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('坏 JSON 按文件名推断类型并保留错误记录', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launchpad-badjson-'))
  try {
    await writeFile(path.join(dir, 'bad.config.json'), '{ broken')
    await writeFile(path.join(dir, 'bad.deploy.json'), '{ broken')
    await writeFile(path.join(dir, 'bad.services.json'), '{ broken')
    const result = await scan({
      roots: [dir],
      dshHome: path.join(dir, 'home'),
      includeProfiles: false,
      cwd: dir,
    })
    const byName = new Map(result.manifests.map((manifest) => [path.basename(manifest.path), manifest]))
    assert.equal(byName.get('bad.config.json').type, 'launcher')
    assert.equal(byName.get('bad.deploy.json').type, 'works')
    assert.equal(byName.get('bad.services.json').type, 'broker')
    for (const manifest of byName.values()) {
      assert.equal(manifest.valid, false)
      assert.ok(manifest.errors[0].includes('JSON 解析失败'))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('*.example.json 默认不作为生产清单', async () => {
  const pluginDir = path.join(HERE, '..')
  const result = await scan({
    roots: [pluginDir],
    dshHome: path.join(pluginDir, 'no-home'),
    includeProfiles: false,
    cwd: pluginDir,
  })
  assert.ok(!result.manifests.some((manifest) => manifest.path.endsWith('services.example.json')))
})

test('扫描根不存在会报 scan-root-missing', async () => {
  const result = await scan({
    roots: [`${FIXTURE}/does-not-exist`],
    dshHome: FIXTURE_DSH_HOME,
    cwd: FIXTURE,
    includeProfiles: false,
  })
  assert.equal(result.manifests.length, 0)
  assert.ok(result.errors.some((error) => error.code === 'scan-root-missing'))
})
