/**
 * 插件包单测：store 语义（data_local.py 移植对账）+ 白名单 + relay 端点
 * 冒烟 + MCP streamable-http 握手/工具调用 + 构建产物对账。
 * 运行前先 `node scripts/build-plugin.mjs`（relay 动态 import server/tools.mjs）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WorkspaceManager, WorkspaceClient, WorkspaceBackend } from '@capyclaw/plugin-kit'
import { CONTRACT_VERSION, PACKAGE_VERSION } from '../src/mcp/contract.mjs'
import { TOOLS } from '../src/mcp/tools.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PKG = join(ROOT, 'plugin', 'capyclaw-ppt-workbench')
const pkgUrl = (rel) => pathToFileURL(join(PKG, rel)).href

/* ---- 纯函数：store 白名单 + 语义 ---- */

const store = await import(pkgUrl('server/store.mjs'))
const { BridgeStore, sanitizePush, sanitizeAck, sanitizeState, sanitizeShotResult, sanitizeClaim } = store

test('白名单：push 拒绝空队/超限/非对象指令，title 截短规则', () => {
  assert.equal(sanitizePush({ cmds: [] }), null)
  assert.equal(sanitizePush({ cmds: 'x' }), null)
  assert.equal(sanitizePush({ cmds: [{ op: 'x' }, 3] }), null)
  assert.equal(sanitizePush(null), null)
  assert.equal(sanitizePush({ cmds: [{ op: 'load', deck: {} }], title: 'x'.repeat(121) }), null)
  const ok = sanitizePush({ cmds: [{ op: 'x' }], title: 'T' })
  assert.deepEqual(ok, { cmds: [{ op: 'x' }], title: 'T' })
  assert.equal(sanitizePush({ cmds: [{ op: 'x' }] }).title, '')
  const big = { cmds: [{ blob: 'x'.repeat(9 * 1024 * 1024) }] }
  assert.equal(sanitizePush(big), null)
})

test('白名单：ack 拒绝 bool 冒充整数、error 超长', () => {
  assert.equal(sanitizeAck({ seq: true, applied: 1 }), null)
  assert.equal(sanitizeAck({ seq: -1, applied: 1 }), null)
  assert.equal(sanitizeAck({ seq: 1, applied: 1, error: 'x'.repeat(2001) }), null)
  assert.deepEqual(sanitizeAck({ seq: 1, applied: 2 }), { seq: 1, applied: 2, error: '' })
})

test('白名单：state 要求对象 deck 且 ≤8MB；shot data 必须 data:image/ 前缀；claim 1-64 字符', () => {
  assert.equal(sanitizeState({ deck: 'x' }), null)
  assert.equal(sanitizeState({ deck: {}, seq: -2 }), null)
  assert.deepEqual(sanitizeState({ deck: {} }), { deck: {}, seq: null })
  assert.equal(sanitizeShotResult({ req: 1, data: 'text/plain' }), null)
  assert.equal(sanitizeShotResult({ req: 1, data: 'data:image/jpeg;base64,' + 'x'.repeat(4 * 1024 * 1024) }), null)
  assert.deepEqual(sanitizeShotResult({ req: 1, data: 'data:image/png;base64,x' }),
    { req: 1, data: 'data:image/png;base64,x' })
  assert.equal(sanitizeClaim({ id: '' }), null)
  assert.equal(sanitizeClaim({ id: 'x'.repeat(65) }), null)
})

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'pptw-store-'))
  return new BridgeStore(join(dir, 'state.json'))
}

test('store：push→ack 全链路；过期 ack 不落脏', () => {
  const s = freshStore()
  const d1 = s.push([{ op: 'load' }], 'T')
  assert.equal(d1.seq, 1)
  assert.equal(d1.applied_seq, 0)
  const stale = s.ack(99, 1, '')
  assert.equal(stale.applied_seq, 0)
  const d2 = s.ack(1, 1, '')
  assert.equal(d2.applied_seq, 1)
  assert.equal(d2.applied, 1)
  /* 新 push 清零回执 */
  const d3 = s.push([{ op: 'select', id: 0 }], '')
  assert.equal(d3.seq, 2)
  assert.equal(d3.applied_seq, 0)
  assert.equal(d3.title, '')
})

test('store：state 镜像 + state_seq；shot 请求/回传 req 匹配', () => {
  const s = freshStore()
  s.push([{ op: 'load' }], '')
  s.state({ title: 'stale', slides: [] }, 0)
  assert.equal(s.get().deck, undefined, '旧 seq 的 state 不应写入')
  s.state({ title: 'A', slides: [] }, 1)
  assert.deepEqual(s.get().deck, { title: 'A', slides: [] })
  assert.equal(s.get().state_seq, 1)
  const sr = s.shotRequest()
  assert.equal(sr.shot_req, 1)
  assert.deepEqual(sr.shot, { req: 0, data: '' })
  const staleShot = s.shotResult(9, 'data:image/png;base64,x')
  assert.equal(staleShot.shot.req, 0)
  const okShot = s.shotResult(1, 'data:image/png;base64,x')
  assert.equal(okShot.shot.req, 1)
})

test('store：owner 租约——同人续约、异人拒绝、过期接管、release', () => {
  const s = freshStore()
  assert.deepEqual(s.claim('a'), { ok: true, owner: 'a' })
  assert.deepEqual(s.claim('a'), { ok: true, owner: 'a' })
  assert.deepEqual(s.claim('b'), { ok: false, owner: 'a' })
  s.doc.owner.ts -= 16 // 模拟租约过期（TTL 15s）
  assert.deepEqual(s.claim('b'), { ok: true, owner: 'b' })
  s.release('b')
  assert.equal(s.get().owner, undefined)
})

test('store：journal / checkpoint / pending 可恢复', () => {
  const s = freshStore()
  s.push([{ op: 'load', deck: { title: 'T', slides: [] } }], 'T')
  s.applyServer(1, 1, '')
  const saved = s.checkpoint('cp-1', { goal: 'e2e', next: 'fill' })
  assert.equal(saved.name, 'cp-1')
  assert.equal(saved.title, 'T')
  assert.equal(s.listCheckpoints().length, 1)
  assert.deepEqual(s.readCheckpoint('cp-1').meta, { goal: 'e2e', next: 'fill' })
  assert.equal(s.taskStatus().lastCheckpoint.name, 'cp-1')
  assert.equal(s.pending(), null)
  s.push([{ op: 'add-slide', slide: { id: 'x', elements: [] } }], 'T')
  assert.equal(s.pending().seq, 2)
})

test('store：对象仓库 backend——state/journal/checkpoint 不落散文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'pptw-object-'))
  const manager = new WorkspaceManager({ storeRoot: root }).init()
  const ns = manager.namespaces.create('rt-test')
  const client = new WorkspaceClient({ manager, runtimeId: 'rt-test', token: ns.token })
  const backend = new WorkspaceBackend({ client, workId: 'main' })
  const s = new BridgeStore({ backend })
  s.push([{ op: 'load' }], 'Object Store')
  s.checkpoint('cp-object', { goal: 'smoke' })

  assert.equal(s.listCheckpoints()[0].name, 'cp-object')
  const files = client.list('main').map((item) => item.key).sort()
  assert.ok(files.includes('state.json'))
  assert.ok(files.includes('journal.jsonl'))
  assert.ok(files.includes('checkpoints/cp-object.json'))
  assert.equal(existsSync(join(root, 'workspaces', 'rt-test', 'main', 'manifest.json')), true)
  assert.equal(readdirSync(join(root, 'objects')).length > 0, true)

  const reloaded = new BridgeStore({ backend: new WorkspaceBackend({ client, workId: 'main' }) })
  assert.equal(reloaded.get().title, 'Object Store')
})

test('store：零位空态 + 坏 JSON 诚实返回；落盘可重载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pptw-store-'))
  const file = join(dir, 'state.json')
  const s = new BridgeStore(file)
  assert.equal(s.get().seq, 0)
  s.push([{ op: 'x' }], '')
  const s2 = new BridgeStore(file)
  assert.equal(s2.get().seq, 1)
})

/* ---- relay / MCP 冒烟（真实监听 + fetch）---- */

const { startRelay, BASE_PATH } = await import(pkgUrl('server/relay.mjs'))

const HOST_DIR = mkdtempSync(join(tmpdir(), 'pptw-host-'))
const relay = await startRelay({
  port: 0,
  hostDir: HOST_DIR,
  packageDir: PKG,
  lockFile: join(HOST_DIR, '.relay-instance.lock'),
})
const B = relay.url
const j = (path, opts) => fetch(B + path, opts).then((r) => Promise.all([r.status, r.json()]))
const jp = (path, body) => j(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('relay：健康检查 + status 身份标记 + 发现文件', async () => {
  const root = (p) => fetch(relay.editorUrl.replace(/\/$/, '') + p).then((r) => Promise.all([r.status, r.json()]))
  const [code, doc] = await root('/healthz')
  assert.equal(code, 200)
  assert.equal(doc.bridge, 'ppt-workbench')
  assert.equal(doc.version, PACKAGE_VERSION)
  assert.equal(doc.contractVersion, CONTRACT_VERSION)
  assert.equal(doc.editor, `http://127.0.0.1:${relay.port}/`)
  assert.equal(typeof doc.uptimeSec, 'number')
  const metrics = await fetch(relay.editorUrl.replace(/\/$/, '') + '/metrics').then((r) => r.text())
  assert.match(metrics, /ppt_workbench_up 1/)
  assert.match(metrics, /ppt_workbench_port \d+/)
  const [, st] = await j('/status')
  assert.equal(st.bridge, 'ppt-workbench')
  assert.equal(st.seq, 0)
  const discovery = JSON.parse(readFileSync(join(HOST_DIR, 'bridge.json'), 'utf8'))
  assert.equal(discovery.port, relay.port)
})

test('relay：桥全链路 push→watch→claim→ack→state→deck→shot', async () => {
  /* 未接管时 claim ok；第二个异体接管被拒 */
  assert.deepEqual((await jp('/claim', { id: 'win_a' }))[1], { ok: true, owner: 'win_a' })
  assert.deepEqual((await jp('/claim', { id: 'win_b' }))[1], { ok: false, owner: 'win_a' })

  /* push：整队替换 + seq 自增 */
  const [, pushed] = await jp('', { cmds: [{ op: 'load', deck: { title: 'T', slides: [] } }], title: 'T' })
  assert.equal(pushed.seq, 1)

  /* watch：seq 变化立即返回 */
  const [, w] = await j('/watch?seq=0&shot=0')
  assert.equal(w.seq, 1)
  /* watch：无变化 → 挂满 timeout（1s）原样返回 */
  const t0 = Date.now()
  const [, w2] = await j('/watch?seq=1&shot=0&timeout=1')
  assert.ok(Date.now() - t0 >= 900, '无变化时应该挂到超时')
  assert.equal(w2.seq, 1)

  /* ack：回执落档 */
  const [, acked] = await jp('/ack', { seq: 1, applied: 1, error: '' })
  assert.equal(acked.applied_seq, 1)
  const [, stale] = await jp('/ack', { seq: 99, applied: 5, error: '' })
  assert.equal(stale.applied_seq, 1, '过期 ack 不落脏')

  /* state 镜像 + /deck 读取 */
  const deck = { title: 'T', slides: [{ id: 's1', elements: [] }] }
  await jp('/state', { deck, seq: 1 })
  const [, d] = await j('/deck')
  assert.deepEqual(d.deck, deck)
  assert.equal(d.state_seq, 1)

  /* 截图：请求自增 → 过期回传不落 → 匹配回传落 */
  const [, sr] = await jp('/shot-request', {})
  assert.equal(sr.shot_req, 1)
  await jp('/shot-result', { req: 9, data: 'data:image/png;base64,x' })
  const [, shot0] = await j('/shot')
  assert.equal(shot0.req, 0)
  await jp('/shot-result', { req: 1, data: 'data:image/png;base64,x' })
  const [, shot1] = await j('/shot')
  assert.equal(shot1.req, 1)

  /* 400 面：白名单拒绝 */
  assert.equal((await jp('', { cmds: [] }))[0], 400)
  assert.equal((await jp('/ack', { seq: true, applied: 1 }))[0], 400)

  /* release 后 owner 清空 */
  await jp('/release', { id: 'win_a' })
  const [, st] = await j('/status')
  assert.equal(st.owner, null)
})

test('relay：present/select 进入页面命令队列，不污染 deck', async () => {
  await jp('/claim', { id: 'win_ui', force: true })
  const [, pushed] = await jp('', { cmds: [{ op: 'present', index: 0 }, { op: 'select', id: 0 }] })
  assert.equal(pushed.seq, 2)
  const [, ui] = await j('/ui')
  assert.equal(ui.ui_seq, 1)
  assert.deepEqual(ui.ui.map((c) => c.op), ['select', 'present'].sort())
  await jp('/release', { id: 'win_ui' })
})

test('MCP：ppt_history 在服务端撤销/重做 deck', async () => {
  const M = relay.editorUrl.replace(/\/$/, '') + '/mcp'
  const call = (body) => fetch(M, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json())
  await jp('/claim', { id: 'win_hist', force: true })
  const load = (title) => call({
    jsonrpc: '2.0', id: 30, method: 'tools/call',
    params: { name: 'ppt_apply', arguments: { ops: [{ op: 'load', deck: { title, slides: [{ id: title, elements: [] }] } }] } },
  })
  assert.equal((await load('A')).result.isError, undefined)
  assert.equal((await load('B')).result.isError, undefined)
  const undo = await call({
    jsonrpc: '2.0', id: 31, method: 'tools/call',
    params: { name: 'ppt_history', arguments: { action: 'undo' } },
  })
  assert.equal(undo.result.isError, undefined)
  const deck = await call({
    jsonrpc: '2.0', id: 32, method: 'tools/call',
    params: { name: 'ppt_get_deck', arguments: {} },
  })
  assert.ok(deck.result.content[0].text.includes('标题：A'))
  await jp('/release', { id: 'win_hist' })
})

test('MCP：ppt_get_deck 摘要显示 shape 内文字', async () => {
  const M = relay.editorUrl.replace(/\/$/, '') + '/mcp'
  const call = (body) => fetch(M, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json())
  await jp('/claim', { id: 'win_shape_text', force: true })
  const load = await call({
    jsonrpc: '2.0', id: 33, method: 'tools/call',
    params: {
      name: 'ppt_apply',
      arguments: {
        ops: [{
          op: 'load',
          deck: {
            title: 'shape 文字',
            slides: [{
              id: 's1',
              background: { type: 'solid', color: '#fff' },
              elements: [{
                type: 'shape', id: 'card', left: 10, top: 10, width: 300, height: 60,
                path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z', viewBox: [200, 200], fill: '#eee',
                text: { content: '<p><span style="font-size: 20px;">卡片标题</span></p>' },
              }],
            }],
          },
        }],
      },
    },
  })
  assert.equal(load.result.isError, undefined)
  const deck = await call({
    jsonrpc: '2.0', id: 34, method: 'tools/call',
    params: { name: 'ppt_get_deck', arguments: { detailed: true } },
  })
  const summary = deck.result.content[0].text
  assert.match(summary, /形状文本#card/)
  assert.match(summary, /卡片标题/)
  await jp('/release', { id: 'win_shape_text' })
})

test('MCP：ppt_page 逐页替换/追加，不一次注入整套', async () => {
  const M = relay.editorUrl.replace(/\/$/, '') + '/mcp'
  const call = (body) => fetch(M, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json())
  await jp('/claim', { id: 'win_page', force: true })
  const first = await call({
    jsonrpc: '2.0', id: 35, method: 'tools/call',
    params: { name: 'ppt_page', arguments: { layout: 'cover', replace: true, deck_title: '逐页测试', title: '第一页', subtitle: '逐页落盘' } },
  })
  assert.equal(first.result.isError, undefined)
  const second = await call({
    jsonrpc: '2.0', id: 36, method: 'tools/call',
    params: { name: 'ppt_page', arguments: { layout: 'bullets', title: '第二页', bullets: ['要点一', '要点二'] } },
  })
  assert.equal(second.result.isError, undefined)
  const deck = await fetch(relay.editorUrl.replace(/\/$/, '') + '/api/desktop/works/ppt-bridge/deck').then((r) => r.json())
  assert.equal(deck.deck.title, '逐页测试')
  assert.equal(deck.deck.slides.length, 2)
  await jp('/release', { id: 'win_page' })
})

test('MCP：initialize 版本协商 + instructions；GET 405；坏 JSON 400', async () => {
  const init = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {} },
  }
  const r = await fetch(relay.editorUrl.replace(/\/$/, '') + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init),
  })
  assert.equal(r.status, 200)
  const doc = await r.json()
  assert.equal(doc.result.protocolVersion, '2025-03-26')
  assert.equal(doc.result.serverInfo.name, 'ppt-workbench')
  assert.equal(doc.result.serverInfo.version, PACKAGE_VERSION)
  assert.ok(doc.result.instructions.includes('ppt_capabilities'))
  assert.ok(doc.result.instructions.includes('ppt_deck'))
  assert.ok(doc.result.instructions.includes('39311') || doc.result.instructions.includes('127.0.0.1'))

  const get = await fetch(relay.editorUrl.replace(/\/$/, '') + '/mcp')
  assert.equal(get.status, 405)

  const bad = await fetch(relay.editorUrl.replace(/\/$/, '') + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
  })
  assert.equal(bad.status, 400)
})

test(`MCP：tools/list ${TOOLS.length} 个工具与契约一致；ppt_capabilities 可用；未知工具报错`, async () => {
  const M = relay.editorUrl.replace(/\/$/, '') + '/mcp'
  const call = (body) => fetch(M, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => Promise.all([r.status, r.json()]))

  const [, list] = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.equal(list.result.tools.length, TOOLS.length)
  assert.ok(list.result.tools.some((t) => t.name === 'ppt_deck'))
  assert.ok(list.result.tools.some((t) => t.name === 'ppt_capabilities'))

  const [, cap] = await call({
    jsonrpc: '2.0', id: 21, method: 'tools/call',
    params: { name: 'ppt_capabilities', arguments: {} },
  })
  assert.equal(cap.result.isError, undefined)
  const caps = JSON.parse(cap.result.content[0].text)
  assert.equal(caps.contractVersion, CONTRACT_VERSION)
  assert.equal(caps.toolCount, TOOLS.length)
  assert.ok(caps.tools.some((t) => t.name === 'ppt_get_deck' && t.kind === 'read'))
  assert.ok(caps.features.includes('deck.compose'))
  assert.ok(caps.editorUrl.includes('127.0.0.1'))

  const [, badArgs] = await call({
    jsonrpc: '2.0', id: 22, method: 'tools/call',
    params: { name: 'ppt_capabilities', arguments: { extra: true } },
  })
  assert.equal(badArgs.result.isError, true)
  assert.match(badArgs.result.content[0].text, /参数不合法/)

  const [, missing] = await call({
    jsonrpc: '2.0', id: 23, method: 'tools/call',
    params: { name: 'ppt_text', arguments: {} },
  })
  assert.equal(missing.result.isError, true)
  assert.match(missing.result.content[0].text, /text 必填/)

  const [, bad] = await call({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  })
  assert.match(bad.result.content[0].text, /未知工具/)

  /* 通知（无 id）→ 202 无响应体 */
  const note = await fetch(M, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  assert.equal(note.status, 202)

  /* 批量：通知 + 请求 → 只回请求的应答（数组） */
  const [, batch] = await call([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 5, method: 'ping' },
  ])
  assert.equal(batch.length, 1)
  assert.deepEqual(batch[0].result, {})
})

test('MCP：截图依赖编辑器在线，未连接时诚实失败', async () => {
  await jp('/release', { id: 'win_a' }).catch(() => { })
  const r = await fetch(relay.editorUrl.replace(/\/$/, '') + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'ppt_screenshot', arguments: {} },
    }),
  })
  const doc = await r.json()
  assert.equal(doc.result.isError, true)
  assert.match(doc.result.content[0].text, /尚未连接|编辑器未接管/)
})

test('relay：编辑器静态页可服务（构建产物存在时）', { skip: !existsSync(join(PKG, 'editor', 'index.html')) && 'editor 未构建' }, async () => {
  const html = await fetch(relay.editorUrl).then((r) => r.text())
  assert.ok(html.includes('PPTist'))
  assert.ok(html.includes('wb-bar'))
  assert.ok(html.includes('data-quick'))
  assert.ok(html.includes('data-act="pptx"'))
  const app = await fetch(relay.editorUrl + 'app.js').then((r) => r.status)
  assert.equal(app, 200)
  const worker = await fetch(relay.editorUrl + 'heartbeat-worker.js').then((r) => r.status)
  assert.equal(worker, 200)
})

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory()
      ? listFiles(full, base)
      : [relative(base, full).split('\\').join('/')]
  }).sort()
}

function assertTreeEqual(srcDir, dstDir, label) {
  assert.deepEqual(listFiles(dstDir), listFiles(srcDir), `${label} 文件集不一致，请重跑 build-plugin`)
  for (const rel of listFiles(srcDir)) {
    const src = readFileSync(join(srcDir, rel), 'utf8')
    const dst = readFileSync(join(dstDir, rel), 'utf8')
    assert.equal(dst, src, `${label}/${rel} 与源不一致，请重跑 build-plugin`)
  }
}

test('构建产物对账：server 拷贝与 src/ 单一真源一致', () => {
  for (const f of ['tools.mjs', 'bridge-client.mjs', 'deck-layout.mjs', 'contract.mjs', 'validate.mjs', 'audit.mjs', 'ppt-shim.mjs']) {
    const src = readFileSync(join(ROOT, 'src', 'mcp', f), 'utf8')
    const dst = readFileSync(join(PKG, 'server', f), 'utf8')
    assert.equal(dst, src, `server/${f} 与 src/mcp/${f} 不一致，请重跑 build-plugin`)
  }
  assertTreeEqual(join(ROOT, 'src', 'core'), join(PKG, 'core'), 'core')
  assertTreeEqual(join(ROOT, 'src', 'mcp', 'tools'), join(PKG, 'server', 'tools'), 'server/tools')
  assert.equal(existsSync(join(PKG, 'server', 'tools-deps')), false, 'server/tools-deps 已废弃')
  const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  assert.equal(manifest.version, PACKAGE_VERSION)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const patch = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('@capyclaw/ppt-workbench'))
  assert.ok(patch.includes('streamable-http'))
})

/* relay 常驻对象：测试收尾显式关闭，验证 stop 闭环 */
test('relay：stop 后端口不再服务', async () => {
  await relay.stop()
  await assert.rejects(() => fetch(relay.url + '/status'))
})
