/**
 * 宿主插件测试：cordis apply() 装配、scrapling 服务能力、工作台生命周期。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST_URL = pathToFileURL(path.resolve('lib/host.mjs')).href

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function mockCtx() {
  const provided = {}
  const events = {}
  return {
    provided,
    events,
    logger: {
      info() {}, warn() {}, error() {},
    },
    provide(name, service) {
      provided[name] = service
      return () => delete provided[name]
    },
    on(event, handler) {
      events[event] = handler
    },
    get: () => null,
  }
}

async function importHost() {
  return import(HOST_URL)
}

test('apply()：注册 scrapling 服务 + 拉起工作台 + disposer 干净关闭', async () => {
  const host = await importHost()
  const ctx = mockCtx()
  const port = await freePort()
  const dispose = await host.apply(ctx, { port, workbench: true })

  try {
    /* 服务注册齐全 */
    assert.ok(ctx.provided.scrapling, '应注册 scrapling 服务')
    const service = ctx.provided.scrapling
    assert.equal(typeof service.fetch, 'function')
    assert.equal(typeof service.parse, 'function')
    assert.equal(typeof service.fetchWithBrowser, 'function')
    assert.ok(service.crawler, '应暴露 crawler 流水线')

    /* 浏览器模式：诚实抛 NOT_IMPLEMENTED */
    await assert.rejects(() => service.fetchWithBrowser('https://example.com'), (error) => error.code === 'NOT_IMPLEMENTED')

    /* parse()：CSS 选择器真实可用 */
    const doc = service.parse('<ul><li class="x">一</li><li>二</li></ul>')
    assert.deepEqual(doc.css('li::text'), ['一', '二'])
    assert.deepEqual(doc.css('li.x::text'), ['一'])

    /* 工作台已监听 */
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json())
    assert.equal(health.ok, true)
    assert.equal(health.name, 'scrapling-workbench')

    /* boot 全局注入事件已挂（浏览器半用） */
    assert.equal(typeof ctx.events['webserver/index-inject'], 'function')
    const table = []
    ctx.events['webserver/index-inject'](table)
    assert.equal(table[0].name, '__DSH_SCRAPLING__')
    assert.ok(table[0].value.url.includes(`127.0.0.1:${port}`))

    /* fetch()：真实 HTTP 抓取（对本插件 demo 页） */
    const pkgDir = path.resolve('.')
    const demoServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><title>局部页</title><p class="g">你好 DSH</p></html>')
    })
    await new Promise((resolve) => demoServer.listen(0, '127.0.0.1', resolve))
    try {
      const localUrl = `http://127.0.0.1:${demoServer.address().port}/`
      const result = await service.fetch(localUrl)
      assert.equal(result.status, 200)
      assert.ok(result.html.includes('你好 DSH'))
      /* fetch 抓回来的内容可以直接喂给 parse() */
      const doc2 = service.parse(result.html)
      assert.deepEqual(doc2.css('title::text'), ['局部页'])
      assert.deepEqual(doc2.css('.g::text'), ['你好 DSH'])
    } finally {
      demoServer.close()
    }
  } finally {
    await dispose()
  }

  /* 关闭后端口释放 */
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`))
})

test('apply()：workbench=false 时只注册服务、不开端口', async () => {
  const host = await importHost()
  const ctx = mockCtx()
  const port = await freePort()
  const dispose = await host.apply(ctx, { port, workbench: false })
  try {
    assert.ok(ctx.provided.scrapling)
    assert.equal(typeof ctx.events['webserver/index-inject'], 'undefined')
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/healthz`))
  } finally {
    await dispose()
  }
})

test('apply()：enabled=false 时不注册任何东西', async () => {
  const host = await importHost()
  const ctx = mockCtx()
  const dispose = await host.apply(ctx, { enabled: false })
  try {
    assert.equal(ctx.provided.scrapling, undefined)
  } finally {
    await dispose?.()
  }
})

test('fetch()：错误带结构化 code 与 hint', async () => {
  const host = await importHost()
  const ctx = mockCtx()
  const port = await freePort()
  const dispose = await host.apply(ctx, { port, workbench: false })
  try {
    await assert.rejects(
      () => ctx.provided.scrapling.fetch('http://127.0.0.1:1/nowhere', { timeoutMs: 1000 }),
      (error) => error.code === 'NETWORK' && typeof error.hint === 'string',
    )
    await assert.rejects(
      () => ctx.provided.scrapling.fetch('ftp://example.com/x'),
      (error) => error.code === 'URL_INVALID',
    )
  } finally {
    await dispose()
  }
})
