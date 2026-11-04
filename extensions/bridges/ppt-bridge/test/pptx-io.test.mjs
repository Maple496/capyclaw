import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { applyOp, VIEW_OP_NAMES } from '../src/core/ops.js'
import { buildDeck } from '../src/core/deck-layout.js'
import { renderDeckToPptx } from '../src/mcp/tools/domains/pptx-export.mjs'
import { exportCapability } from '../src/mcp/tools/capabilities/export.mjs'
import { importCapability } from '../src/mcp/tools/capabilities/import.mjs'

const sampleDeck = () => buildDeck({
  title: 'PPTX IO 测试',
  preset: 'clean',
  slides: [
    { layout: 'cover', title: 'PPTX IO 测试', subtitle: '端到端' },
    { layout: 'bullets', title: '要点', bullets: ['第一点', '第二点'] },
    { layout: 'end', title: '谢谢' },
  ],
})

test('import-pptx 是编辑器 view op（服务端不执行）', () => {
  assert.ok(VIEW_OP_NAMES.includes('import-pptx'))
})

test('import-pptx op：取回文件 → P.importFile → 回传成功结果', async () => {
  const calls = []
  const resultPosts = []
  const blob = new Blob([Buffer.from('PK\u0003\u0004fake')])
  const ctx = {
    apiBase: '/api/desktop/works/ppt-bridge',
    baseUrl: 'http://127.0.0.1:39311/',
    File: class FakeFile {
      constructor(parts, name, options) {
        this.parts = parts
        this.name = name
        this.type = options?.type
      }
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      if (init?.method === 'POST') {
        resultPosts.push(JSON.parse(init.body))
        return { ok: true, status: 200 }
      }
      return { ok: true, status: 200, blob: async () => blob }
    },
  }
  let importedFile = null
  const P = {
    isMounted: () => true,
    async importFile(file) {
      importedFile = file
      return { title: '导入结果', slideCount: 2, mounted: true }
    },
  }
  const summary = await applyOp(P, {
    op: 'import-pptx',
    req: 'req-1',
    id: 'abc',
    url: '/api/desktop/works/ppt-bridge/import-file/abc',
    name: 'demo.pptx',
  }, ctx)

  assert.equal(summary.title, '导入结果')
  assert.equal(importedFile?.name, 'demo.pptx')
  assert.match(importedFile?.type || '', /presentationml\.presentation/)
  assert.equal(calls[0].url, 'http://127.0.0.1:39311/api/desktop/works/ppt-bridge/import-file/abc')
  assert.equal(resultPosts[0].req, 'req-1')
  assert.equal(resultPosts[0].id, 'abc')
  assert.equal(resultPosts[0].ok, true)
  assert.deepEqual(resultPosts[0].summary.import, { mode: 'replace', before: 0, imported: 2, final: 2 })
})

test('import-pptx op：replace 模式删除导入前的旧页（不把旧 deck 拼进来）', async () => {
  const removed = []
  let slides = [{ id: 'old-1' }, { id: 'old-2' }]
  const ctx = {
    File: class FakeFile {},
    fetch: async (url, init) => {
      if (init?.method === 'POST') return { ok: true }
      return { ok: true, blob: async () => new Blob(['x']) }
    },
  }
  const P = {
    isMounted: () => true,
    getSlides: () => slides,
    removeSlide(id) {
      removed.push(id)
      slides = slides.filter((slide) => slide.id !== id)
      return true
    },
    async importFile() {
      slides = [...slides, { id: 'new-1' }, { id: 'new-2' }, { id: 'new-3' }]
      return { title: '新文件', slideCount: 3, mounted: true }
    },
  }
  const summary = await applyOp(P, {
    op: 'import-pptx', req: 'req-replace', url: '/x', name: 'x.pptx', mode: 'replace',
  }, ctx)
  assert.deepEqual(removed, ['old-1', 'old-2'])
  assert.equal(slides.length, 3)
  assert.deepEqual(summary.import, { mode: 'replace', before: 2, imported: 3, final: 3 })
})

test('import-pptx op：append 模式保留旧页', async () => {
  let slides = [{ id: 'old-1' }]
  const ctx = {
    File: class FakeFile {},
    fetch: async (url, init) => {
      if (init?.method === 'POST') return { ok: true }
      return { ok: true, blob: async () => new Blob(['x']) }
    },
  }
  const P = {
    isMounted: () => true,
    getSlides: () => slides,
    removeSlide() { throw new Error('append 不应调用 removeSlide') },
    async importFile() {
      slides = [...slides, { id: 'new-1' }]
      return { title: '新文件', slideCount: 1, mounted: true }
    },
  }
  const summary = await applyOp(P, {
    op: 'import-pptx', req: 'req-append', url: '/x', name: 'x.pptx', mode: 'append',
  }, ctx)
  assert.equal(slides.length, 2)
  assert.deepEqual(summary.import, { mode: 'append', before: 1, imported: 1, final: 2 })
})

test('import-pptx op：失败时回传错误并抛出', async () => {
  const posts = []
  const ctx = {
    File: class FakeFile {},
    fetch: async (url, init) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return { ok: true } }
      return { ok: true, blob: async () => new Blob(['x']) }
    },
  }
  const P = {
    isMounted: () => true,
    async importFile() { throw new Error('解析失败') },
  }
  await assert.rejects(
    () => applyOp(P, { op: 'import-pptx', req: 'req-2', url: '/x', name: 'x.pptx' }, ctx),
    /解析失败/,
  )
  assert.equal(posts[0].ok, false)
  assert.match(posts[0].error, /解析失败/)
})

test('pptx 导出：生成可解压的 PPTX，包含全部页与文字', async () => {
  const deck = sampleDeck()
  const { buffer, stats } = await renderDeckToPptx(deck, {})
  assert.ok(buffer.length > 10_000)
  assert.equal(buffer.subarray(0, 2).toString(), 'PK')
  assert.equal(stats.slides, 3)
  assert.equal(stats.skipped, 0)

  const zip = await JSZip.loadAsync(buffer)
  assert.ok(zip.file('ppt/presentation.xml'))
  for (let index = 1; index <= 3; index++) {
    assert.ok(zip.file(`ppt/slides/slide${index}.xml`), `缺少 slide${index}.xml`)
  }
  const slide1 = await zip.file('ppt/slides/slide1.xml').async('string')
  assert.match(slide1, /PPTX IO 测试/)
})

test('ppt_export_pptx 能力：写文件并返回绝对路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-export-test-'))
  const deck = sampleDeck()
  const ctx = {
    deck: { read: async () => ({ deck }) },
    status: { baseUrl: 'http://127.0.0.1:39311/api/desktop/works/ppt-bridge' },
  }
  const tool = exportCapability.tools.find((item) => item.name === 'ppt_export_pptx')
  const result = await tool.handler({ path: dir, file_name: 'unit' }, ctx)
  const payload = JSON.parse(result.text)
  assert.equal(payload.ok, true)
  assert.ok(payload.path.startsWith(dir))
  assert.ok(fs.statSync(payload.path).size > 10_000)
  assert.equal(payload.slides, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ppt_export_pptx：覆盖原文件需 overwrite，且默认生成 .bak 备份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-overwrite-test-'))
  const target = path.join(dir, 'deck.pptx')
  fs.writeFileSync(target, Buffer.from('old-content'))
  const deck = sampleDeck()
  const ctx = {
    deck: { read: async () => ({ deck }) },
    status: { baseUrl: 'http://127.0.0.1:39311/api/desktop/works/ppt-bridge' },
  }
  const tool = exportCapability.tools.find((item) => item.name === 'ppt_export_pptx')
  await assert.rejects(() => tool.handler({ path: target }, ctx), /overwrite:true/)
  const result = await tool.handler({ path: target, overwrite: true }, ctx)
  const payload = JSON.parse(result.text)
  assert.equal(payload.ok, true)
  assert.equal(payload.path, target)
  assert.ok(payload.backup && fs.existsSync(payload.backup))
  assert.equal(fs.readFileSync(payload.backup, 'utf8'), 'old-content')
  assert.ok(fs.statSync(target).size > 10_000)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ppt_import_pptx 能力：读取本地文件 → 投递 view op → 等待结果 → 返回摘要', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-import-test-'))
  const deck = sampleDeck()
  const { buffer } = await renderDeckToPptx(deck, {})
  const file = path.join(dir, 'roundtrip.pptx')
  fs.writeFileSync(file, buffer)

  const pushed = []
  let uploaded = null
  const ctx = {
    editor: { require: async () => {} },
    importer: {
      upload: async (bytes, name) => {
        uploaded = { bytes: bytes.length, name }
        return { ok: true, id: 'imp1', name, url: '/api/desktop/works/ppt-bridge/import-file/imp1', bytes: bytes.length }
      },
      result: async () => ({
        done: true,
        ok: true,
        summary: { title: '导入后的 deck', slideCount: 3, mounted: true, slides: [{}, {}, {}] },
      }),
    },
    deck: {
      write: async (ops) => { pushed.push(...ops); return { ok: true, seq: 1, applied: 1, error: '' } },
      read: async () => ({ deck: { ...deck, title: '导入后的 deck' } }),
    },
  }
  const tool = importCapability.tools.find((item) => item.name === 'ppt_import_pptx')
  const result = await tool.handler({ path: file, wait_ms: 5000 }, ctx)
  const payload = JSON.parse(result.text)

  assert.equal(uploaded.name, 'roundtrip.pptx')
  assert.equal(pushed[0].op, 'snapshot')
  const importOp = pushed.find((op) => op.op === 'import-pptx')
  assert.ok(importOp, '缺少 import-pptx op')
  assert.equal(importOp.name, 'roundtrip.pptx')
  assert.equal(importOp.url, '/api/desktop/works/ppt-bridge/import-file/imp1')
  assert.equal(importOp.mode, 'replace')
  assert.equal(payload.ok, true)
  assert.equal(payload.slideCount, 3)
  assert.deepEqual(payload.warnings, [])
  fs.rmSync(dir, { recursive: true, force: true })
})
