import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commands, parseWorkRef, parseArgs } from '../bin/dsh-works.mjs'
import { assertIndexShape, extractWorksFiles, pickWorksEntry } from '../lib/works-source.mjs'
import { writeZipFromDir } from '@capyclaw/plugin-kit/packaging/zip'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function smokeWorks(name) {
  return `%%%WORKS-META%%%
{
  "name": "${name}",
  "brief": "works 分发闭环冒烟",
  "tags": "e2e,distribution",
  "view": { "kind": "deployment" },
  "schema_version": "1.0.0"
}

%%%WORKS-CODE%%%
{
  "deployment": { "type": "domain", "source": "does-not-matter-for-install", "autoStart": true },
  "runtime": { "driver": "node", "workId": "main" }
}
`
}

/** 搭一个静态分发源：<root>/index.json + <root>/zips/<name>.zip（内含 .works）。 */
function makeSource(root, name, version = '1.0.0', latest = true) {
  const stage = path.join(root, `stage-${name}`)
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, `${name}.works`), smokeWorks(name))
  const zipsDir = path.join(root, 'zips')
  fs.mkdirSync(zipsDir, { recursive: true })
  const zipFile = path.join(zipsDir, `${name}-${version}.zip`)
  writeZipFromDir(stage, zipFile)
  const bytes = fs.readFileSync(zipFile)
  const index = {
    schema: 1,
    channel: 'stable',
    generatedAt: new Date().toISOString(),
    plugins: [
      {
        name,
        version,
        title: name,
        file: path.relative(root, zipFile).replace(/\\/g, '/'),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        latest,
      },
    ],
  }
  const indexFile = path.join(root, 'index.json')
  // 多条目场景：追加进已有索引
  if (fs.existsSync(indexFile)) {
    const existing = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    existing.plugins = existing.plugins.filter((item) => item.name !== name)
    existing.plugins.push(index.plugins[0])
    fs.writeFileSync(indexFile, JSON.stringify(existing, null, 2))
  } else {
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2))
  }
  return { indexFile, zipFile, bytes }
}

test('parseWorkRef 接受 local/src/数字三种引用', () => {
  assert.equal(parseWorkRef('WORKS-local-1730000000000'), 'WORKS-local-1730000000000')
  assert.equal(parseWorkRef('WORKS-src-deploy-smoke'), 'WORKS-src-deploy-smoke')
  assert.equal(parseWorkRef('12345'), 'WORKS-12345')
  assert.throws(() => parseWorkRef('not-a-ref'), /无效的作品引用/)
})

test('parseArgs 解析旗标与位置参数', () => {
  const { flags, positional } = parseArgs(['deploy-smoke', '--from', './x/index.json', '--auto-install'])
  assert.deepEqual(positional, ['deploy-smoke'])
  assert.equal(flags.from, './x/index.json')
  assert.equal(flags['auto-install'], true)
})

test('works-source：索引形状/条目选择/zip 提取', () => {
  assert.throws(() => assertIndexShape({ schema: 2 }, 'x'), /形状不合法/)
  const index = { schema: 1, plugins: [{ name: 'a', version: '1.0.0' }, { name: 'a', version: '2.0.0', latest: true }] }
  assert.equal(pickWorksEntry(index, 'a').version, '2.0.0')
  assert.equal(pickWorksEntry(index, 'a', '1.0.0').version, '1.0.0')
  assert.throws(() => pickWorksEntry(index, 'b'), /源里没有作品: b/)
  assert.throws(() => pickWorksEntry(index, 'a', '9.9.9'), /源里没有 a@9\.9\.9/)

  const zipBytes = fs.readFileSync(path.join(HERE, '..', 'package.json')) // 非 zip，仅测形状错误的抛错路径
  assert.throws(() => extractWorksFiles(zipBytes, 'fake'), /不是有效的 ZIP/)
})

test('install：本地 .works 文件安装进注册表', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'works-local-'))
  const savedStore = process.env.DSH_STORE_ROOT
  process.env.DSH_STORE_ROOT = path.join(root, 'store')
  try {
    const worksFile = path.join(root, 'my.works')
    fs.writeFileSync(worksFile, smokeWorks('local-smoke'))
    await commands.install(worksFile)
    const registry = JSON.parse(fs.readFileSync(path.join(process.env.DSH_STORE_ROOT, 'works-registry.json'), 'utf8'))
    const entry = registry.works.find((item) => item.title === 'local-smoke')
    assert.ok(entry, '注册表应有 local-smoke')
    assert.match(entry.ref, /^WORKS-local-\d+$/)
    assert.equal(entry.source, 'local')
  } finally {
    if (savedStore === undefined) delete process.env.DSH_STORE_ROOT
    else process.env.DSH_STORE_ROOT = savedStore
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install：--from 静态源 → sha256 校验 → 解包 .works → 注册表', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'works-src-'))
  const savedStore = process.env.DSH_STORE_ROOT
  process.env.DSH_STORE_ROOT = path.join(root, 'store')
  try {
    const { indexFile } = makeSource(root, 'deploy-smoke')
    await commands.install('deploy-smoke', { from: indexFile })

    const registryFile = path.join(process.env.DSH_STORE_ROOT, 'works-registry.json')
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    const entry = registry.works.find((item) => item.ref === 'WORKS-src-deploy-smoke')
    assert.ok(entry, '注册表应有 WORKS-src-deploy-smoke')
    assert.equal(entry.version, '1.0.0')
    assert.equal(entry.source, indexFile)
    assert.ok(entry.capabilities.length === 0)

    const workDir = path.join(process.env.DSH_STORE_ROOT, 'works', 'WORKS-src-deploy-smoke')
    assert.ok(fs.existsSync(path.join(workDir, 'meta.json')))
    assert.ok(fs.existsSync(path.join(workDir, 'deploy-smoke.works')), '原始 .works 应随包落盘（保留 zip 内原始文件名）')
    assert.ok(fs.existsSync(path.join(workDir, 'installed')))
  } finally {
    if (savedStore === undefined) delete process.env.DSH_STORE_ROOT
    else process.env.DSH_STORE_ROOT = savedStore
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install：DSH_WORKS_SOURCE 环境变量作为缺省源；sha256 不匹配被拒', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'works-env-'))
  const savedStore = process.env.DSH_STORE_ROOT
  const savedSource = process.env.DSH_WORKS_SOURCE
  process.env.DSH_STORE_ROOT = path.join(root, 'store')
  try {
    const { indexFile, bytes } = makeSource(root, 'env-smoke')
    process.env.DSH_WORKS_SOURCE = indexFile
    await commands.install('env-smoke')
    const registry = JSON.parse(fs.readFileSync(path.join(process.env.DSH_STORE_ROOT, 'works-registry.json'), 'utf8'))
    assert.ok(registry.works.some((item) => item.ref === 'WORKS-src-env-smoke'))

    // sha256 负路径：条目指向被篡改的副本
    const { fetchEntryBytes } = await import('../lib/works-source.mjs')
    const tampered = Buffer.from(bytes)
    tampered[0] = tampered[0] ^ 0xff
    const tamperedZip = path.join(root, 'zips', 'tampered.zip')
    fs.writeFileSync(tamperedZip, tampered)
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    const badEntry = { ...index.plugins[0], file: 'zips/tampered.zip' }
    await assert.rejects(() => fetchEntryBytes(indexFile, badEntry), /sha256 校验失败/)
  } finally {
    if (savedStore === undefined) delete process.env.DSH_STORE_ROOT
    else process.env.DSH_STORE_ROOT = savedStore
    if (savedSource === undefined) delete process.env.DSH_WORKS_SOURCE
    else process.env.DSH_WORKS_SOURCE = savedSource
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install：无源时的名称引用报可读错误', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'works-nosrc-'))
  const savedStore = process.env.DSH_STORE_ROOT
  const savedSource = process.env.DSH_WORKS_SOURCE
  process.env.DSH_STORE_ROOT = path.join(root, 'store')
  delete process.env.DSH_WORKS_SOURCE
  try {
    await assert.rejects(() => commands.install('ghost-work'), /--from.*DSH_WORKS_SOURCE/)
  } finally {
    if (savedStore === undefined) delete process.env.DSH_STORE_ROOT
    else process.env.DSH_STORE_ROOT = savedStore
    if (savedSource === undefined) delete process.env.DSH_WORKS_SOURCE
    else process.env.DSH_WORKS_SOURCE = savedSource
    fs.rmSync(root, { recursive: true, force: true })
  }
})
