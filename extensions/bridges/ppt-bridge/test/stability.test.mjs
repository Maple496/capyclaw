/**
 * 稳定性回归：并发、损坏恢复、协议边界、suite/skill 约束。
 * 这些用例对应 2026-10-31 的 P0/P1 加固项，防止回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WORKSPACE = path.resolve(ROOT, '..', '..', '..')
const PKG = path.join(ROOT, 'plugin', 'dsh-ppt-workbench')
const pkgUrl = (rel) => pathToFileURL(path.join(PKG, rel)).href
const pkgFile = (rel) => pathToFileURL(path.join(WORKSPACE, 'packages', rel)).href

const { createServiceApp } = await import(pkgFile('dsh-service-host/src/index.mjs'))
const { createAssetRoutes, createFileAssetStore } = await import(pkgFile('dsh-asset-service/src/index.mjs'))
const { FileStateBackend } = await import(pkgFile('dsh-state-service/src/index.mjs'))
const { stripPatchRows } = await import(pkgFile('dsh-suite-kit/src/profile.mjs'))
const { loadSuiteManifest, validateSuiteManifest } = await import(pkgFile('dsh-suite-kit/src/manifest.mjs'))
const { majorCompatible } = await import(pkgFile('dsh-suite-kit/src/compose.mjs'))
const { BridgeStore } = await import(pkgUrl('server/store.mjs'))
const { watchDoc } = await import(pkgUrl('server/runtime/watch.mjs'))
const { createJsonPptApp } = await import(pkgUrl('server/ppt-shim.mjs'))
const { startRelay } = await import(pkgUrl('server/relay.mjs'))

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('service-host：畸形请求行不再打崩进程，后续请求仍可用', async () => {
  const app = createServiceApp({ id: 'stability-host' })
  const info = await app.listen({ port: 0, allowReuse: false })
  try {
    await new Promise((resolve) => {
      const socket = net.connect(info.port, '127.0.0.1', () => {
        socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n')
      })
      socket.setTimeout(1500)
      socket.on('data', () => { })
      socket.on('close', resolve)
      socket.on('timeout', () => { socket.destroy(); resolve() })
    })
    const health = await fetch(`${info.url}/healthz`)
    assert.equal(health.status, 200)
  } finally {
    await app.close()
  }
})

test('service-host：超大 body 返回 413 而不是连接重置', async () => {
  const app = createServiceApp({ id: 'stability-body' })
  const { readBody } = await import(pkgFile('dsh-plugin-kit/src/service/http.mjs'))
  app.post('/echo', async (req, res) => {
    const body = await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ bytes: JSON.stringify(body).length }))
  })
  const info = await app.listen({ port: 0, allowReuse: false })
  try {
    const res = await fetch(`${info.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(11 * 1024 * 1024) }),
    })
    assert.equal(res.status, 413)
    await res.text()
  } finally {
    await app.close()
  }
})

test('service-host：跨源写请求返回 403，loopback 来源放行', async () => {
  const app = createServiceApp({ id: 'stability-origin' })
  app.post('/echo', async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const info = await app.listen({ port: 0, allowReuse: false })
  try {
    const evil = await fetch(`${info.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    })
    assert.equal(evil.status, 403)
    const local = await fetch(`${info.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${info.port}` },
      body: '{}',
    })
    assert.equal(local.status, 200)
  } finally {
    await app.close()
  }
})

test('service-host：同 hostDir 并发启动只允许一个实例', async () => {
  const dir = tempDir('stability-lock-')
  const lockFile = path.join(dir, 'service.lock')
  const a = createServiceApp({ id: 'lock-a' })
  const b = createServiceApp({ id: 'lock-b' })
  const results = await Promise.allSettled([
    a.listen({ port: 0, hostDir: dir, lockFile, allowReuse: false }),
    b.listen({ port: 0, hostDir: dir, lockFile, allowReuse: false }),
  ])
  try {
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
    assert.equal(results.filter((item) => item.status === 'rejected').length, 1)
  } finally {
    await Promise.allSettled([a.close(), b.close()])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('资产：basePath 下可上传，根路径/前缀路径都可读，HTML 不以 text/html 回显', async () => {
  const dir = tempDir('stability-assets-')
  const store = createFileAssetStore({ dir })
  const app = createServiceApp({ id: 'asset-stability' })
  app.use(createAssetRoutes({ assetStore: store, basePath: '/api/ppt' }))
  const info = await app.listen({ port: 0, allowReuse: false })
  try {
    const payload = Buffer.from('<script>alert(1)</script>')
    const upload = await fetch(`${info.url}/api/ppt/assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: payload.toString('base64'), contentType: 'text/html' }),
    })
    const body = await upload.json()
    assert.equal(upload.status, 200)
    assert.match(body.url, /^\/assets\/[a-f0-9]{64}$/)
    for (const url of [`${info.url}${body.url}`, `${info.url}/api/ppt${body.url}`]) {
      const res = await fetch(url)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
    }
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('store：state 损坏时隔离并从最新 checkpoint 恢复', () => {
  const dir = tempDir('stability-store-')
  try {
    const file = path.join(dir, 'state.json')
    const s = new BridgeStore(file)
    s.push([{ op: 'load', deck: { title: '恢复', slides: [{ id: 's1', elements: [] }] } }], '恢复')
    s.get().deck = { title: '恢复', slides: [{ id: 's1', elements: [] }] }
    s.applyServer(1, 1, '')
    s.checkpoint('cp-recover', { reason: 'test' })
    fs.writeFileSync(file, '{broken json')
    const recovered = new BridgeStore(file)
    assert.equal(recovered.get().deck.title, '恢复')
    assert.equal(recovered.get().deck.slides.length, 1)
    assert.ok(fs.readdirSync(dir).some((name) => name.includes('state.json.corrupt-')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('state-service：坏 JSON 返回 null 并记录 STATE_CORRUPT，不静默覆盖', () => {
  const dir = tempDir('stability-state-')
  try {
    const file = path.join(dir, 'state.json')
    fs.writeFileSync(file, '{oops')
    const backend = new FileStateBackend(file, { initialDoc: { seq: 0 } })
    assert.equal(backend.readState(), null)
    assert.equal(backend.lastStateError.code, 'STATE_CORRUPT')
    assert.ok(!fs.existsSync(file))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('watch：客户端中止后 Promise 必须 settle（null）', async () => {
  const store = new BridgeStore(path.join(tempDir('stability-watch-'), 'state.json'))
  const started = Date.now()
  const result = await watchDoc(store, 0, 0, 0, 30, () => true)
  assert.equal(result, null)
  assert.ok(Date.now() - started < 500)
})

test('relay：并发 push 串行执行，最终 deck 一致且 seq 正确', async () => {
  const dir = tempDir('stability-push-')
  const relay = await startRelay({
    port: 0, hostDir: dir, packageDir: PKG,
    lockFile: path.join(dir, 'relay.lock'), allowReuse: false,
  })
  try {
    const posts = Array.from({ length: 8 }, (_, i) => fetch(relay.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cmds: [{
          op: 'load',
          deck: { title: `T${i}`, slides: Array.from({ length: 12 }, (_, j) => ({ id: `s${i}-${j}`, elements: [] })) },
        }],
        title: `T${i}`,
      }),
    }).then((res) => res.status))
    const statuses = await Promise.all(posts)
    assert.deepEqual(statuses, Array(8).fill(200))
    const deck = await (await fetch(`${relay.url}/deck`)).json()
    assert.equal(deck.deck.slides.length, 12)
    const status = await (await fetch(`${relay.url}/status`)).json()
    assert.equal(status.seq, 8)
  } finally {
    await relay.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('relay：工具配置失败时清理端口/锁/发现文件，不留僵尸实例', async () => {
  const dir = tempDir('stability-relay-fail-')
  const lockFile = path.join(dir, 'relay.lock')
  try {
    await assert.rejects(() => startRelay({
      port: 0, hostDir: dir, packageDir: PKG, lockFile,
      allowReuse: false, capabilities: ['nope'],
    }))
    assert.equal(fs.existsSync(lockFile), false)
    assert.equal(fs.existsSync(path.join(dir, 'bridge.json')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ppt-shim：load 恢复 theme/viewport，不丢 checkpoint 画布设置', async () => {
  const store = new BridgeStore(path.join(tempDir('stability-shim-'), 'state.json'))
  const app = createJsonPptApp(store)
  app.load({
    title: '主题',
    slides: [{ id: 's1', elements: [] }],
    theme: { fontColor: '#ff0000' },
    viewportSize: 1280,
    viewportRatio: 0.75,
  })
  assert.equal(store.get().deck.theme.fontColor, '#ff0000')
  assert.equal(store.get().deck.viewportSize, 1280)
  assert.equal(store.get().deck.viewportRatio, 0.75)
})

test('suite：stripPatchRows 只删指定 entry，保留同 insert 块其它行', () => {
  const input = [
    '- insert:',
    '    - id: old-host',
    '      name: old',
    '    - id: keep-host',
    '      name: keep',
    '- id: tail',
    '  name: tail',
  ].join('\n')
  const output = stripPatchRows(input, ['old-host'])
  assert.ok(!output.includes('old-host'))
  assert.ok(output.includes('keep-host'))
  assert.ok(output.includes('tail'))
})

test('suite：junction 安装时 components 按真实目录展开', () => {
  const root = tempDir('stability-suite-')
  try {
    const child = path.join(root, 'child')
    fs.mkdirSync(child)
    fs.writeFileSync(path.join(child, 'dsh-suite.json'), JSON.stringify({
      name: 'child-suite', version: '1.0.0',
      packages: { 'child-plugin': { role: 'provider', version: '^1.0.0', path: '.' } },
      rows: [{ id: 'child-host', name: 'child-plugin' }],
    }))
    fs.writeFileSync(path.join(root, 'dsh-suite.json'), JSON.stringify({
      name: 'parent-suite', version: '1.0.0',
      components: ['./child'],
      packages: { 'parent-plugin': { role: 'runtime', version: '^1.0.0', path: '.' } },
      rows: [{ id: 'parent-host', name: 'parent-plugin' }],
    }))
    const link = path.join(root, 'junction-suite')
    fs.symlinkSync(root, link, 'junction')
    const loaded = loadSuiteManifest(link)
    assert.equal(loaded.manifest.packages['child-plugin'].path, 'child')
    assert.deepEqual(loaded.manifest.rows.map((row) => row.id), ['child-host', 'parent-host'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('suite：非法 semver range 与缺失包路径被拒绝', () => {
  const dir = tempDir('stability-suite-validate-')
  try {
    const manifest = {
      name: 'bad-suite', version: '1.0.0',
      packages: { 'bad-pkg': { role: 'runtime', version: 'banana', path: './missing' } },
      rows: [{ id: 'bad-host', name: 'bad-pkg' }],
    }
    const result = validateSuiteManifest(manifest, { baseDir: dir })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((item) => item.includes('semver range')))
    assert.ok(result.errors.some((item) => item.includes('package.json')))
    assert.equal(majorCompatible('^2.2.0', '2.0.0'), false)
    assert.equal(majorCompatible('^2.2.0', '2.3.0'), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
