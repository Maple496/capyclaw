import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  IMAGE_MAX_BYTES, ImageFetchError, blockHost, blockedHost, clearBlockedHosts,
  describeImageFailure, downloadImage, probeImage,
} from '../src/mcp/tools/domains/remote-image.mjs'

/* 用本机 server 造各种失败，避免测试依赖外网和第三方图床。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function startServer(routes) {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url.split('?')[0]]
    if (!handler) { res.writeHead(404); res.end('nope'); return }
    handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

const serveImage = (req, res) => {
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) })
  res.end(PNG)
}
const serve403 = (req, res) => {
  res.writeHead(403, { 'content-type': 'text/html' })
  res.end('<html>denied</html>')
}
const serveHtml = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<html>not an image</html>')
}
const serveHuge = (req, res) => {
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(IMAGE_MAX_BYTES + 1) })
  res.end(PNG)
}

test('downloadImage：成功返回字节，并带浏览器 UA', async () => {
  clearBlockedHosts()
  let seenUa = ''
  const { base, close } = await startServer({
    '/ok.png': (req, res) => { seenUa = String(req.headers['user-agent'] || ''); serveImage(req, res) },
  })
  try {
    const out = await downloadImage(`${base}/ok.png`)
    assert.equal(out.buf.length, PNG.length)
    assert.equal(out.contentType, 'image/png')
    assert.match(seenUa, /Mozilla\/5\.0/)
  } finally { await close() }
})

test('downloadImage：403 判为永久失败，连续两次才熔断整个主机', async () => {
  clearBlockedHosts()
  const { base, close } = await startServer({ '/forbidden.png': serve403, '/ok.png': serveImage })
  try {
    const url = `${base}/forbidden.png`
    const host = new URL(url).hostname
    await assert.rejects(downloadImage(url), (error) => {
      assert.equal(error.code, 'HTTP_403')
      assert.equal(error.permanent, true)
      assert.match(error.message, /防盗链/)
      return true
    })
    assert.equal(blockedHost(host), null, '单条 403 不足以拉黑整个域名')
    await assert.rejects(downloadImage(url), (error) => error.code === 'HTTP_403')
    assert.ok(blockedHost(host), '同域名连续失败后进入熔断表')
    /* 熔断后同主机再取直接短路，不再发请求 */
    await assert.rejects(downloadImage(`${base}/ok.png`), (error) => error.code === 'HOST_BLOCKED')
  } finally { await close(); clearBlockedHosts() }
})

test('downloadImage：非图片 content-type 直接拒绝', async () => {
  clearBlockedHosts()
  const { base, close } = await startServer({ '/page': serveHtml })
  try {
    await assert.rejects(downloadImage(`${base}/page`), (error) => {
      assert.equal(error.code, 'NOT_IMAGE')
      assert.equal(error.permanent, true)
      return true
    })
  } finally { await close(); clearBlockedHosts() }
})

test('downloadImage：声明体积超限时不下载正文', async () => {
  clearBlockedHosts()
  const { base, close } = await startServer({ '/huge.png': serveHuge })
  try {
    await assert.rejects(downloadImage(`${base}/huge.png`), (error) => {
      assert.equal(error.code, 'TOO_LARGE')
      return true
    })
  } finally { await close(); clearBlockedHosts() }
})

test('probeImage：好图 ok，403 标永久失败，超时不算永久', async () => {
  clearBlockedHosts()
  const { base, close } = await startServer({
    '/ok.png': serveImage,
    '/forbidden.png': serve403,
    '/slow.png': (req, res) => { setTimeout(() => serveImage(req, res), 1200) },
  })
  try {
    const ok = await probeImage(`${base}/ok.png`)
    assert.equal(ok.ok, true)
    assert.equal(ok.size, PNG.length)

    const forbidden = await probeImage(`${base}/forbidden.png`)
    assert.equal(forbidden.ok, false)
    assert.equal(forbidden.code, 'HTTP_403')
    assert.equal(forbidden.permanent, true)

    const slow = await probeImage(`${base}/slow.png`, { timeoutMs: 150 })
    assert.equal(slow.ok, false)
    assert.equal(slow.permanent, false, '预检超时不能当死链丢弃')
  } finally { await close(); clearBlockedHosts() }
})

test('describeImageFailure：永久失败明确要求换域名', () => {
  const url = 'https://example.invalid/a.jpg'
  const error = new ImageFetchError('HTTP_403', 'HTTP 403：该站拒绝程序直连（防盗链）', {
    host: 'example.invalid', status: 403, permanent: true,
  })
  const text = describeImageFailure(error, url)
  assert.match(text, /\[HTTP_403\]/)
  assert.match(text, /不要重试同一链接或同一域名/)
  assert.match(text, /example\.invalid|url=/)
})
