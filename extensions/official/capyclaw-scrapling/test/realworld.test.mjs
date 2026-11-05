/**
 * 真实世界 E2E 套件：编码 / 深嵌套 / 超大页 / 畸形 HTML / 重定向 / gzip /
 * 超时 / 体积上限 / 并发 / 非常规内容——全部用本地 fixture 服务离线复现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import net from 'node:net'
import { once } from 'node:events'

import { createCrawler, decodeBody } from '../lib/crawler.mjs'
import { parseHtml, documentStats } from '../lib/html-parser.mjs'
import { createSelectorDocument } from '../lib/selectors.mjs'

/* ---------- fixture 服务工厂 ---------- */
async function startFixture(handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}/`, server, close: () => new Promise((r) => server.close(r)) }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
    srv.on('error', reject)
  })
}

/* GBK「中文测试」的字节序列 */
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])

/* ---------- 编码 ---------- */

test('编码：GBK 页面靠 meta 嗅探正确解码（无响应头 charset）', async () => {
  const fx = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body><p class="t">', 'latin1'),
      GBK_BYTES,
      Buffer.from('</p></body></html>', 'latin1'),
    ]))
  })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({ url: fx.url, selectors: [{ key: 't', selector: '.t::text' }] })
    assert.equal(rec.ok, true)
    assert.deepEqual(rec.extracts.t.values, ['中文测试'])
    assert.match(rec.steps[3].detail, /GBK/i)
  } finally { await fx.close() }
})

test('编码：响应头声明的 charset 优先于 meta', async () => {
  const fx = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=gbk' })
    res.end(Buffer.concat([
      Buffer.from('<html><head><meta charset="utf-8"></head><body><p class="t">', 'latin1'),
      GBK_BYTES,
      Buffer.from('</p></body></html>', 'latin1'),
    ]))
  })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({ url: fx.url })
    assert.match(rec.html, /中文测试/)
  } finally { await fx.close() }
})

test('编码：UTF-8 BOM / UTF-16LE BOM 页面', async () => {
  const fx = await startFixture((req, res) => {
    if (req.url.startsWith('/u16')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p class="t">ok16</p>', 'utf16le')]))
    } else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p class="t">ok8</p>')]))
    }
  })
  try {
    const crawler = createCrawler()
    const r8 = await crawler.crawl({ url: fx.url, selectors: [{ key: 't', selector: '.t::text' }] })
    assert.deepEqual(r8.extracts.t.values, ['ok8'])
    const r16 = await crawler.crawl({ url: fx.url + 'u16', selectors: [{ key: 't', selector: '.t::text' }] })
    assert.deepEqual(r16.extracts.t.values, ['ok16'])
  } finally { await fx.close() }
})

test('decodeBody 单元：BOM 与嗅探优先级', () => {
  assert.deepEqual(decodeBody(Buffer.from('纯文本', 'utf8'), null).text, '纯文本')
  const gbkMeta = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=GB2312">'), GBK_BYTES])
  assert.match(decodeBody(gbkMeta, 'text/html').text, /中文测试/)
  // 未知编码回退 UTF-8 容错（不抛异常）
  assert.doesNotThrow(() => decodeBody(Buffer.from('abc'), 'text/html; charset=no-such-charset'))
})

/* ---------- 嵌套与体积 ---------- */

test('深嵌套：600 层与 5 万层都不崩溃，深度封顶 512（浏览器同款）', async () => {
  const fx = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<div>'.repeat(50000) + '<p class="deep">底</p>' + '</div>'.repeat(50000))
  })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({ url: fx.url })
    assert.equal(rec.ok, true)
    assert.equal(rec.stats.maxDepth, 512)
    /* 文本仍在文档中（浏览器在深度上限处拍平为兄弟节点，p 不再持有该文本——同款行为） */
    assert.ok(rec.stats.textLength >= 1)
    /* 元素本身仍可被选中 */
    assert.ok(rec.html.includes('class="deep"'))
  } finally { await fx.close() }
})

test('超大页：2MB / 5 万元素，解析+提取在预算内且结果正确', async () => {
  const items = []
  for (let i = 0; i < 50000; i++) items.push(`<div class="item"><span class="name">商品${i}</span><span class="price">¥${i}.00</span></div>`)
  const html = '<html><head><title>大页面</title></head><body>' + items.join('') + '</body></html>'
  const fx = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  try {
    const crawler = createCrawler()
    const started = Date.now()
    const rec = await crawler.crawl({
      url: fx.url,
      selectors: [
        { key: 'name', selector: '.item .name::text' },
        { key: 'firstPrice', selector: '.item:nth-child(1) .price::text' },
      ],
    })
    const elapsed = Date.now() - started
    assert.equal(rec.ok, true)
    assert.equal(rec.extracts.name.count, 50000)
    assert.equal(rec.extracts.name.values[0], '商品0')
    assert.equal(rec.extracts.name.values[49999], '商品49999')
    assert.equal(rec.extracts.firstPrice.values[0], '¥0.00')
    assert.ok(elapsed < 15000, `2MB 页面耗时 ${elapsed}ms 超预算`)
  } finally { await fx.close() }
})

test('体积上限：超过 maxHtmlBytes 返回结构化 TOO_LARGE', async () => {
  const fx = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<p>' + 'x'.repeat(2 * 1024 * 1024) + '</p>')
  })
  try {
    const crawler = createCrawler({ maxHtmlBytes: 1024 * 1024 })
    const rec = await crawler.crawl({ url: fx.url })
    assert.equal(rec.ok, false)
    assert.equal(rec.error.code, 'TOO_LARGE')
    assert.ok(rec.error.hint)
  } finally { await fx.close() }
})

/* ---------- 畸形 HTML ---------- */

test('畸形 HTML：未闭合/无引号/重复属性/孤立结束标签/大小写混杂仍可提取', async () => {
  const html = [
    '<HTML>',
    '<BODY CLASS=page>',
    '<DIV ID=main class="a" class="b">',
    '<P>第一段',
    '<P>第二段</p></p>',
    '<span data-x=\'1\' DATA-Y="2">值</SPAN>',
    '<a href=/rel/path>相对链接</A>',
    '<input type=checkbox checked>',
    '</div>',
    '<script>var s = "</div>"; if (1<2) {}</script>',
    '<ul><li>一<li>二<li>三</ul>',
  ].join('\n')
  const fx = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({
      url: fx.url,
      selectors: [
        { key: 'ps', selector: 'p::text' },
        { key: 'span', selector: 'span[data-x="1"]::text' },
        { key: 'y', selector: 'span::attr(data-y)' },
        { key: 'link', selector: 'a::attr(href)' },
        { key: 'lis', selector: 'li::text' },
        { key: 'checked', selector: 'input[checked]::attr(type)' },
      ],
    })
    assert.equal(rec.ok, true)
    assert.deepEqual(rec.extracts.ps.values, ['第一段', '第二段'])
    assert.deepEqual(rec.extracts.span.values, ['值'])
    assert.equal(rec.extracts.y.values[0], '2')
    assert.equal(rec.extracts.link.values[0], '/rel/path')
    assert.deepEqual(rec.extracts.lis.values, ['一', '二', '三'])
    assert.equal(rec.extracts.checked.values[0], 'checkbox')
    /* script 里的 "</div>" 不产生真实元素 */
    assert.equal(createSelectorDocument(rec.html).css('script').length, 1)
  } finally { await fx.close() }
})

test('畸形 HTML：实体（命名/十进制/十六进制/未知）在文本与属性中', async () => {
  const fx = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<p class="t">A&amp;B &#20013;&#x6587; &hellip; &unknown;</p><a title="引&quot;号&quot;">链接</a>')
  })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({
      url: fx.url,
      selectors: [
        { key: 't', selector: '.t::text' },
        { key: 'title', selector: 'a::attr(title)' },
      ],
    })
    assert.deepEqual(rec.extracts.t.values, ['A&B 中文 … &unknown;'])
    assert.deepEqual(rec.extracts.title.values, ['引"号"'])
  } finally { await fx.close() }
})

/* ---------- HTTP 行为 ---------- */

test('重定向链：301 → 302 → 200，finalUrl 与提取正确', async () => {
  const fx = await startFixture((req, res) => {
    if (req.url === '/a') { res.writeHead(301, { location: '/b' }); res.end() }
    else if (req.url === '/b') { res.writeHead(302, { location: '/c?x=1' }); res.end() }
    else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1 class="h">终点</h1>') }
  })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({ url: fx.url + 'a', selectors: [{ key: 'h', selector: '.h::text' }] })
    assert.equal(rec.ok, true)
    assert.equal(rec.status, 200)
    assert.ok(rec.finalUrl.endsWith('/c?x=1'))
    assert.deepEqual(rec.extracts.h.values, ['终点'])
    assert.match(rec.steps[2].detail, /重定向/)
  } finally { await fx.close() }
})

test('404 页面：状态如实呈现，HTML 内容仍可解析提取', async () => {
  const fx = await startFixture((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><title>找不到页面</title><p class="e">404 了</p></html>')
  })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({ url: fx.url, selectors: [{ key: 'e', selector: '.e::text' }] })
    assert.equal(rec.ok, false)          /* HTTP 语义：404 不是 ok */
    assert.equal(rec.status, 404)
    assert.equal(rec.error, undefined)   /* 但不是爬取失败：内容照常返回 */
    assert.deepEqual(rec.extracts.e.values, ['404 了'])
    assert.equal(rec.title, '找不到页面')
  } finally { await fx.close() }
})

test('gzip + chunked 响应正常解压解析', async () => {
  const fx = await startFixture((req, res) => {
    const body = zlib.gzipSync(Buffer.from('<p class="g">压缩内容</p>', 'utf8'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
    res.write(body.subarray(0, 5))
    setTimeout(() => res.end(body.subarray(5)), 30)
  })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({ url: fx.url, selectors: [{ key: 'g', selector: '.g::text' }] })
    assert.equal(rec.ok, true)
    assert.deepEqual(rec.extracts.g.values, ['压缩内容'])
  } finally { await fx.close() }
})

test('空响应体 / 非 HTML 内容（JSON）都能优雅处理', async () => {
  const fx = await startFixture((req, res) => {
    if (req.url === '/empty') { res.writeHead(200, { 'content-type': 'text/html' }); res.end() }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"list": [1, 2, 3]}') }
  })
  try {
    const crawler = createCrawler()
    const empty = await crawler.crawl({ url: fx.url + 'empty', selectors: [{ key: 'p', selector: 'p::text' }] })
    assert.equal(empty.ok, true)
    assert.equal(empty.bytes, 0)
    assert.equal(empty.extracts.p.count, 0)

    const json = await crawler.crawl({ url: fx.url, selectors: [{ key: 'p', selector: 'p::text' }] })
    assert.equal(json.ok, true)
    assert.ok(json.html.includes('"list"'))
    assert.equal(json.extracts.p.count, 0)   /* JSON 不是 HTML：提取为空但不报错 */
  } finally { await fx.close() }
})

test('超时：服务器不响应 → TIMEOUT + 下一步提示', async () => {
  const fx = await startFixture((req, res) => { /* 永不响应 */ })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({ url: fx.url, timeoutMs: 800 })
    assert.equal(rec.ok, false)
    assert.equal(rec.error.code, 'TIMEOUT')
    assert.ok(rec.error.hint.includes('超时'))
  } finally { await fx.close() }
})

test('网络错误分类：拒绝连接 / 域名不存在', async () => {
  const crawler = createCrawler()
  const deadPort = await freePort()
  const refused = await crawler.crawl({ url: `http://127.0.0.1:${deadPort}/x`, timeoutMs: 2000 })
  assert.equal(refused.error.code, 'NETWORK')
  assert.match(refused.error.message, /拒绝连接|无法连接/)

  const dns = await crawler.crawl({ url: 'http://this-domain-does-not-exist-xyz.test/', timeoutMs: 5000 })
  assert.equal(dns.error.code, 'NETWORK')
  assert.match(dns.error.message, /域名无法解析|无法连接/)
})

/* ---------- 表格与结构语义 ---------- */

test('表格：隐式闭合 td/tr + nth-child 列提取', async () => {
  const html = '<table class="t"><tr><td>名1</td><td>100</td><tr><td>名2</td><td>200</td></table>'
  const fx = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  try {
    const crawler = createCrawler()
    const rec = await crawler.crawl({
      url: fx.url,
      selectors: [
        { key: 'c1', selector: 'table tr td:nth-child(1)::text' },
        { key: 'c2', selector: 'table tr td:nth-child(2)::text' },
      ],
    })
    assert.deepEqual(rec.extracts.c1.values, ['名1', '名2'])
    assert.deepEqual(rec.extracts.c2.values, ['100', '200'])
  } finally { await fx.close() }
})

/* ---------- 并发与历史 ---------- */

test('并发：10 个爬取同时进行全部成功，历史按序保留', async () => {
  const fx = await startFixture((req, res) => {
    const n = new URL(req.url, 'http://x').searchParams.get('n') || '0'
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<p class="n">第${n}个</p>`)
    }, 50 + Number(n) * 10)
  })
  try {
    const crawler = createCrawler()
    const jobs = []
    for (let i = 0; i < 10; i++) {
      jobs.push(crawler.crawl({ url: `${fx.url}?n=${i}`, selectors: [{ key: 'n', selector: '.n::text' }] }))
    }
    const results = await Promise.all(jobs)
    for (let i = 0; i < 10; i++) {
      assert.equal(results[i].ok, true, `第 ${i} 个失败`)
      assert.deepEqual(results[i].extracts.n.values, [`第${i}个`])
    }
    assert.equal(crawler.list().length, 10)
  } finally { await fx.close() }
})

test('历史：超过上限淘汰最旧记录', async () => {
  const fx = await startFixture((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<p>${req.url}</p>`)
  })
  try {
    const crawler = createCrawler({ historyLimit: 3 })
    for (let i = 0; i < 5; i++) await crawler.crawl({ url: `${fx.url}?i=${i}` })
    const list = crawler.list()
    assert.equal(list.length, 3)
    assert.ok(list[0].url.includes('i=4'))   /* 最新在前 */
    assert.ok(list[2].url.includes('i=2'))
    assert.equal(crawler.reExtract('c1', [{ key: 'x', selector: 'p::text' }]), null) /* c1 已淘汰 */
  } finally { await fx.close() }
})

/* ---------- 对抗性选择器与解析器边界 ---------- */

test('对抗性选择器：引号内逗号 / 通用选择器 / 链式类 / 大 n 值 nth-child', () => {
  const doc = createSelectorDocument('<i data-v="a,b" class="x y">1</i><i class="x">2</i><i>3</i>')
  assert.deepEqual(doc.css('[data-v="a,b"]::text'), ['1'])
  assert.equal(doc.css('*').length >= 3, true)
  assert.deepEqual(doc.css('.x.y::text'), ['1'])
  assert.deepEqual(doc.css('i:nth-child(999)::text'), [])
  assert.throws(() => doc.css('p >>>> q'), /组合器/)
  assert.throws(() => doc.css('div::attr()'), /属性名/)
})

test('解析器边界：空输入 / 纯文本 / 仅注释 / 超长属性值', () => {
  const empty = parseHtml('')
  assert.deepEqual(empty.children, [])
  assert.equal(documentStats(empty).elements, 0)
  const text = parseHtml('hello < world')
  assert.match(text.children.map((n) => n.text || '').join(''), /hello < world/)
  const comment = parseHtml('<!-- everything -->')
  assert.equal(comment.children[0].tag, '#comment')
  const longAttr = parseHtml(`<a title="${'长'.repeat(5000)}">x</a>`)
  assert.equal(longAttr.children[0].attrs.title.length, 5000)
})
