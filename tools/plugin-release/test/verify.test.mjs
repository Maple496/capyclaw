/**
 * 源校验器负向测试：每条标准条款都要有"坏源被拒"的证明。
 *
 * 正向（好源通过）覆盖在 release.test.mjs；本文件专打不规范源。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { verifySource } from '../lib/verify.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-src-'))
}

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
}

/** 极小合法 zip 写入器（store 模式，够测试用）。 */
function writeZip(file, entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([...locals, centralBuf, eocd]))
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pkgJson(over = {}) {
  return JSON.stringify({
    name: 'dsh-probe',
    version: '1.0.0',
    type: 'module',
    main: './lib/index.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    engines: { dsh: '^0.2.0-rc.2' },
    ...over,
  })
}

function goodZip(file, over = {}) {
  writeZip(file, {
    'package.json': pkgJson(over),
    'lib/index.mjs': 'export const name = "probe"\n',
    'cordis.patch.yml': '- insert:\n    - id: probe\n      name: probe\n',
  })
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function makeSource(overrides = {}) {
  const dir = tmp()
  const zipRel = overrides.file || 'plugins/dsh-probe-1.0.0.zip'
  const zipAbs = path.join(dir, ...zipRel.split('/'))
  const realSha = goodZip(zipAbs, overrides.pkg || {})
  const sha = overrides.sha || realSha
  const entry = {
    name: 'dsh-probe',
    version: '1.0.0',
    file: zipRel,
    sha256: sha,
    dsh: '^0.2.0-rc.2',
    bundle: true,
    latest: true,
    title: 'Probe',
    ...overrides.entry,
  }
  const top = { channel: 'stable', plugins: overrides.plugins ?? [entry] }
  if (overrides.schema !== null) top.schema = overrides.schema ?? 1
  writeJson(path.join(dir, 'index.json'), top)
  return { dir, zipAbs, sha, entry }
}

async function failsWith(source, pattern) {
  const report = await verifySource(source)
  assert.equal(report.ok, false, `应校验失败，实际通过：${JSON.stringify(report.warnings)}`)
  const all = report.errors.join('\n')
  assert.match(all, pattern, `错误信息不匹配：\n${all}`)
  return report
}

test('好源通过校验（基线）', async () => {
  const { dir } = makeSource()
  const report = await verifySource(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(report.plugins.length, 1)
  assert.equal(report.channel, 'stable')
})

test('schema 不是 1 → 拒收', async () => {
  const { dir } = makeSource({ schema: 2 })
  await failsWith(dir, /schema 必须是 1/)
})

test('schema 缺失 → 拒收', async () => {
  const { dir } = makeSource({ schema: null })
  await failsWith(dir, /schema 必须是 1/)
})

test('index.json 不存在 → 拒收', async () => {
  const dir = tmp()
  await failsWith(dir, /读不到 index\.json/)
})

test('index.json 不是 JSON → 拒收', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'index.json'), '{ not json')
  await failsWith(dir, /读不到 index\.json/)
})

test('plugins 为空数组 → 拒收', async () => {
  const { dir } = makeSource({ plugins: [] })
  await failsWith(dir, /plugins 为空/)
})

test('sha256 不匹配 → 拒收', async () => {
  const { dir } = makeSource({ sha: 'a'.repeat(64) })
  await failsWith(dir, /sha256 不匹配/)
})

test('sha256 格式不合法 → 拒收', async () => {
  const { dir } = makeSource({ entry: { sha256: 'ABC123' } })
  await failsWith(dir, /sha256 缺失或不合法|sha256 缺失或不是 64 位/)
})

test('包名与索引不一致 → 拒收', async () => {
  const dir = tmp()
  const zipRel = 'plugins/dsh-probe-1.0.0.zip'
  const sha = goodZip(path.join(dir, ...zipRel.split('/')), { name: 'dsh-other' })
  writeJson(path.join(dir, 'index.json'), {
    schema: 1,
    plugins: [{ name: 'dsh-probe', version: '1.0.0', file: zipRel,
      sha256: sha, dsh: '^0.2.0-rc.2', bundle: true, latest: true }],
  })
  await failsWith(dir, /包内 name "dsh-other" 与索引不一致/)
})

test('版本与索引不一致 → 拒收', async () => {
  const dir = tmp()
  const zipRel = 'plugins/dsh-probe-1.0.0.zip'
  const sha = goodZip(path.join(dir, ...zipRel.split('/')), { version: '9.9.9' })
  writeJson(path.join(dir, 'index.json'), {
    schema: 1,
    plugins: [{ name: 'dsh-probe', version: '1.0.0', file: zipRel,
      sha256: sha, dsh: '^0.2.0-rc.2', bundle: true, latest: true }],
  })
  await failsWith(dir, /包内 version "9\.9\.9" 与索引不一致/)
})

test('缺 dsh.bundle.patch → 拒收（装了也不会加载）', async () => {
  const dir = tmp()
  const zipRel = 'plugins/dsh-probe-1.0.0.zip'
  const zipAbs = path.join(dir, ...zipRel.split('/'))
  const sha = goodZip(zipAbs, { dsh: {} })
  writeJson(path.join(dir, 'index.json'), {
    schema: 1,
    plugins: [{ name: 'dsh-probe', version: '1.0.0', file: zipRel,
      sha256: sha, dsh: '^0.2.0-rc.2', bundle: true, latest: true }],
  })
  await failsWith(dir, /缺 dsh\.bundle\.patch/)
})

test('patch 文件不在包里 → 拒收', async () => {
  const dir = tmp()
  const zipRel = 'plugins/dsh-probe-1.0.0.zip'
  const zipAbs = path.join(dir, ...zipRel.split('/'))
  writeZip(zipAbs, { 'package.json': pkgJson() })   // 缺 cordis.patch.yml
  const sha = crypto.createHash('sha256').update(fs.readFileSync(zipAbs)).digest('hex')
  writeJson(path.join(dir, 'index.json'), {
    schema: 1,
    plugins: [{ name: 'dsh-probe', version: '1.0.0', file: zipRel,
      sha256: sha, dsh: '^0.2.0-rc.2', bundle: true, latest: true }],
  })
  await failsWith(dir, /dsh\.bundle\.patch 指向的文件不在包里/)
})

test('缺 engines.dsh → 拒收', async () => {
  const dir = tmp()
  const zipRel = 'plugins/dsh-probe-1.0.0.zip'
  const sha = goodZip(path.join(dir, ...zipRel.split('/')), { engines: {} })
  writeJson(path.join(dir, 'index.json'), {
    schema: 1,
    plugins: [{ name: 'dsh-probe', version: '1.0.0', file: zipRel,
      sha256: sha, dsh: '^0.2.0-rc.2', bundle: true, latest: true }],
  })
  await failsWith(dir, /包内缺 engines\.dsh/)
})

test('依赖里有 link: → 拒收', async () => {
  const { dir } = makeSource({
    pkg: { dependencies: { 'dsh-plugin-kit': '^0.2.0', ghost: 'link:../ghost' } },
  })
  await failsWith(dir, /源码树本地路径/)
})

test('main 指向不存在的文件 → 拒收', async () => {
  const { dir } = makeSource({ pkg: { main: './lib/nope.mjs' } })
  await failsWith(dir, /main 指向的文件不在包里/)
})

test('file 路径上跳 → 拒收', async () => {
  const { dir } = makeSource()
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
  index.plugins[0].file = '../outside.zip'
  writeJson(path.join(dir, 'index.json'), index)
  await failsWith(dir, /file 必须是相对源根的安全路径/)
})

test('file 绝对路径 → 拒收', async () => {
  const { dir } = makeSource()
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
  index.plugins[0].file = 'C:/Windows/system32/x.zip'
  writeJson(path.join(dir, 'index.json'), index)
  await failsWith(dir, /file 必须是相对源根的安全路径/)
})

test('name 不是 dsh-* → 拒收', async () => {
  const { dir } = makeSource({ entry: { name: 'not-a-plugin' } })
  await failsWith(dir, /name 不合法/)
})

test('version 不是严格 semver → 拒收', async () => {
  const { dir } = makeSource({ entry: { version: 'v1' } })
  await failsWith(dir, /version 不是严格 semver/)
})

test('bundle 不是布尔 → 拒收', async () => {
  const { dir } = makeSource({ entry: { bundle: 'yes' } })
  await failsWith(dir, /bundle 必须是布尔/)
})

test('dsh 范围为空 → 拒收', async () => {
  const { dir } = makeSource({ entry: { dsh: '' } })
  await failsWith(dir, /dsh 必须是非空的/)
})

test('重复 name@version → 拒收', async () => {
  const { dir, entry } = makeSource()
  writeJson(path.join(dir, 'index.json'), {
    schema: 1, channel: 'stable', plugins: [entry, { ...entry }],
  })
  await failsWith(dir, /重复的 name@version/)
})

test('包文件不存在 → 拒收', async () => {
  const { dir } = makeSource()
  fs.rmSync(path.join(dir, 'plugins', 'dsh-probe-1.0.0.zip'))
  await failsWith(dir, /包读不到/)
})

test('ZIP 不安全路径（.. 上跳）→ 拒收', async () => {
  const dir = tmp()
  const zipRel = 'plugins/dsh-probe-1.0.0.zip'
  const zipAbs = path.join(dir, ...zipRel.split('/'))
  writeZip(zipAbs, {
    'package.json': pkgJson(),
    'cordis.patch.yml': '- insert:\n',
    '../../evil.txt': 'pwned',
  })
  const sha = crypto.createHash('sha256').update(fs.readFileSync(zipAbs)).digest('hex')
  writeJson(path.join(dir, 'index.json'), {
    schema: 1,
    plugins: [{ name: 'dsh-probe', version: '1.0.0', file: zipRel,
      sha256: sha, dsh: '^0.2.0-rc.2', bundle: true, latest: true }],
  })
  await failsWith(dir, /ZIP 内含不安全路径/)
})

test('HTTP 形态：源可读则通过，404 则拒收', async () => {
  const http = await import('node:http')
  const { dir } = makeSource()
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').replace(/^\//, ''))
    const file = path.join(dir, ...rel.split('/'))
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end('nope'); return }
    res.end(fs.readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const ok = await verifySource(`http://127.0.0.1:${port}`)
    assert.equal(ok.ok, true, ok.errors.join('\n'))
    const bad = await verifySource(`http://127.0.0.1:${port}/nope`)
    assert.equal(bad.ok, false)
    assert.match(bad.errors.join('\n'), /读不到 index\.json|HTTP 404/)
  } finally {
    server.close()
  }
})

test('多版本：同源共存 + 一个 latest，校验通过', async () => {
  const dir = tmp()
  const entries = []
  for (const [version, latest] of [['1.0.0', false], ['1.1.0', true]]) {
    const zipRel = `plugins/dsh-probe-${version}.zip`
    const zipAbs = path.join(dir, ...zipRel.split('/'))
    const sha = goodZip(zipAbs, { version })
    entries.push({ name: 'dsh-probe', version, file: zipRel, sha256: sha,
      dsh: '^0.2.0-rc.2', bundle: true, latest })
  }
  writeJson(path.join(dir, 'index.json'), { schema: 1, channel: 'stable', plugins: entries })
  const report = await verifySource(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(report.plugins.length, 2)
})

test('多版本都标 latest → 警告但不失败', async () => {
  const dir = tmp()
  const entries = []
  for (const version of ['1.0.0', '1.1.0']) {
    const zipRel = `plugins/dsh-probe-${version}.zip`
    const zipAbs = path.join(dir, ...zipRel.split('/'))
    entries.push({ name: 'dsh-probe', version, file: zipRel,
      sha256: goodZip(zipAbs, { version }), dsh: '^0.2.0-rc.2',
      bundle: true, latest: true })
  }
  writeJson(path.join(dir, 'index.json'), { schema: 1, plugins: entries })
  const report = await verifySource(dir)
  assert.equal(report.ok, true)
  assert.ok(report.warnings.some((w) => /同时标 latest/.test(w)))
})

test('单条坏数据不废整源（坏条目跳过、好条目仍在）', async () => {
  const { dir, entry } = makeSource()
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
  index.plugins.unshift({ name: 'broken', file: 1 })
  writeJson(path.join(dir, 'index.json'), index)
  const report = await verifySource(dir)
  assert.equal(report.ok, false)
  assert.ok(report.plugins.some((p) => p.name === 'dsh-probe' && p.ok === true))
  assert.ok(report.plugins.some((p) => p.ok === false))
})
