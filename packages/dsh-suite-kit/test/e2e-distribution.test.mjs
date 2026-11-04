/**
 * 分发链路 E2E（此前仅单测覆盖的路径升级为端到端）：
 *   E1 HTTP 分发源：本地 HTTP 服务提供 index.json+zip → dsh-works install --from URL
 *   E2 HTTP 源篡改：served zip 被改 → sha256 拒绝
 *   E3 注册表收养：旧混 schema registry.json → works 被迁出、租约文件逐字不动
 *   E4 auto-install 旗标：check --auto-install --from 真正补装依赖（修复后的回归守卫）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { commands } from '../bin/dsh-works.mjs'
import { writeZipFromDir } from '../../dsh-plugin-kit/src/zip.mjs'

function worksContent(name, requires = null) {
  const meta = {
    name,
    brief: `${name} e2e`,
    tags: 'e2e,http',
    view: { kind: 'deployment' },
    schema_version: '1.0.0',
    ...(requires ? { requires } : {}),
  }
  return `%%%WORKS-META%%%
${JSON.stringify(meta, null, 2)}

%%%WORKS-CODE%%%
{ "deployment": { "type": "domain", "source": "/tmp/placeholder" } }
`
}

/** 建 zip + 返回 { bytes, sha256, size }。 */
function buildWorkZip(root, name) {
  const stage = path.join(root, `stage-${name}`)
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, `${name}.works`), worksContent(name))
  const zip = path.join(root, `${name}.zip`)
  writeZipFromDir(stage, zip)
  const bytes = fs.readFileSync(zip)
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

function indexEntry(name, artifact) {
  return {
    name,
    version: '1.0.0',
    title: name,
    file: `zips/${name}.zip`,
    sha256: artifact.sha256,
    size: artifact.size,
    latest: true,
  }
}

function startServer(root, plugins) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ schema: 1, channel: 'stable', plugins }))
      return
    }
    const match = url.pathname.match(/^\/zips\/(.+\.zip)$/)
    if (match) {
      const file = path.join(root, 'zips', match[1])
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': 'application/zip' })
        res.end(fs.readFileSync(file))
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function storeSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dist-'))
  const savedStore = process.env.DSH_STORE_ROOT
  const savedSource = process.env.DSH_WORKS_SOURCE
  process.env.DSH_STORE_ROOT = path.join(root, 'store')
  delete process.env.DSH_WORKS_SOURCE
  const restore = () => {
    if (savedStore === undefined) delete process.env.DSH_STORE_ROOT
    else process.env.DSH_STORE_ROOT = savedStore
    if (savedSource === undefined) delete process.env.DSH_WORKS_SOURCE
    else process.env.DSH_WORKS_SOURCE = savedSource
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { root, restore }
}

test('E1 HTTP 分发源：URL 索引 + URL zip → sha256 校验 → 安装落库', async () => {
  const { root, restore } = storeSetup()
  let ctx = null
  try {
    const artifact = buildWorkZip(root, 'http-work')
    fs.mkdirSync(path.join(root, 'zips'), { recursive: true })
    fs.copyFileSync(path.join(root, 'http-work.zip'), path.join(root, 'zips', 'http-work.zip'))
    ctx = await startServer(root, [indexEntry('http-work', artifact)])
    const indexUrl = `http://127.0.0.1:${ctx.port}/index.json`

    await commands.install('http-work', { from: indexUrl })

    const registry = JSON.parse(fs.readFileSync(path.join(process.env.DSH_STORE_ROOT, 'works-registry.json'), 'utf8'))
    const entry = registry.works.find((w) => w.ref === 'WORKS-src-http-work')
    assert.ok(entry, 'HTTP 源安装后注册表应有作品')
    assert.equal(entry.source, indexUrl, '来源应记录为 URL')
  } finally {
    if (ctx) ctx.server.close()
    restore()
  }
})

test('E2 HTTP 源篡改：served zip 被改 → sha256 拒绝且不写注册表', async () => {
  const { root, restore } = storeSetup()
  let ctx = null
  try {
    const artifact = buildWorkZip(root, 'tampered-work')
    fs.mkdirSync(path.join(root, 'zips'), { recursive: true })
    const tampered = Buffer.from(artifact.bytes)
    tampered[0] ^= 0xff
    fs.writeFileSync(path.join(root, 'zips', 'tampered-work.zip'), tampered)
    ctx = await startServer(root, [indexEntry('tampered-work', artifact)])

    await assert.rejects(
      () => commands.install('tampered-work', { from: `http://127.0.0.1:${ctx.port}/index.json` }),
      /sha256 校验失败/,
    )
    const registryFile = path.join(process.env.DSH_STORE_ROOT, 'works-registry.json')
    if (fs.existsSync(registryFile)) {
      const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
      assert.ok(!registry.works.some((w) => w.ref.includes('tampered')), '拒绝后不得落库')
    }
  } finally {
    if (ctx) ctx.server.close()
    restore()
  }
})

test('E3 注册表收养：旧混 schema registry.json → works 迁出、租约文件逐字不动', async () => {
  const { root, restore } = storeSetup()
  try {
    const store = process.env.DSH_STORE_ROOT
    fs.mkdirSync(store, { recursive: true })
    const legacyData = {
      schemaVersion: 1,
      ports: { 3081: 'rt-x' },
      runtimes: [{ id: 'rt-x' }],
      works: [{ ref: 'WORKS-42', title: 'legacy-work', installed: true }],
      capabilities: {},
    }
    const legacyFile = path.join(store, 'registry.json')
    fs.writeFileSync(legacyFile, JSON.stringify(legacyData, null, 2))
    const before = fs.readFileSync(legacyFile, 'utf8')

    await commands.list()

    const worksRegistry = path.join(store, 'works-registry.json')
    assert.ok(fs.existsSync(worksRegistry), '应生成 works-registry.json')
    const adopted = JSON.parse(fs.readFileSync(worksRegistry, 'utf8'))
    assert.ok(adopted.works.some((w) => w.title === 'legacy-work'), '旧 works 应被收养')
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), before, '租约 registry.json 必须逐字不动')
  } finally {
    restore()
  }
})

test('E4 auto-install 旗标：check --auto-install --from 真正补装依赖', async () => {
  const { root, restore } = storeSetup()
  try {
    const dep = buildWorkZip(root, 'dep-b')
    const app = buildWorkZip(root, 'app-a')
    fs.mkdirSync(path.join(root, 'zips'), { recursive: true })
    fs.copyFileSync(path.join(root, 'dep-b.zip'), path.join(root, 'zips', 'dep-b.zip'))
    fs.copyFileSync(path.join(root, 'app-a.zip'), path.join(root, 'zips', 'app-a.zip'))
    const indexFile = path.join(root, 'index.json')
    fs.writeFileSync(indexFile, JSON.stringify({
      schema: 1,
      plugins: [indexEntry('dep-b', dep), indexEntry('app-a', app)],
    }, null, 2))

    // app-a 依赖 WORKS-src-dep-b；先只装 app（本地文件形态）
    const appWorks = path.join(root, 'app-a.works')
    fs.writeFileSync(appWorks, worksContent('app-a', { components: ['WORKS-src-dep-b'] }))
    await commands.install(appWorks)
    const registry = JSON.parse(fs.readFileSync(path.join(process.env.DSH_STORE_ROOT, 'works-registry.json'), 'utf8'))
    const appRef = registry.works.find((w) => w.title === 'app-a').ref

    // check：缺依赖 → 抛错
    await assert.rejects(() => commands.check(appRef), /缺少 1 个依赖/)

    // check --auto-install --from：经分发源补装 dep-b
    await commands.check(appRef, { 'auto-install': true, from: indexFile })
    const after = JSON.parse(fs.readFileSync(path.join(process.env.DSH_STORE_ROOT, 'works-registry.json'), 'utf8'))
    assert.ok(after.works.some((w) => w.ref === 'WORKS-src-dep-b'), 'auto-install 应补装依赖')
  } finally {
    restore()
  }
})
