/**
 * 宿主插件测试：cordis apply() 装配、scrapling 服务能力、工作台生命周期。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST_URL = pathToFileURL(path.resolve('lib/host.mjs')).href

function mockCtx({ serviceBroker } = {}) {
  const provided = {}
  const events = {}
  return {
    provided,
    events,
    serviceBroker,
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

test('apply()：注册本地 API，通过 broker 投递独立工作台服务', async () => {
  const host = await importHost()
  const started = []
  const stopped = []
  const ctx = mockCtx({
    serviceBroker: {
      async start(spec) {
        started.push(spec)
        return { id: spec.id, url: 'http://127.0.0.1:39640', state: 'running' }
      },
      async stop(id) { stopped.push(id); return { id, stopped: true } },
    },
  })
  const dispose = await host.apply(ctx, { port: 39640, workbench: true })

  assert.ok(ctx.provided.scrapling, '应注册 scrapling API')
  const service = ctx.provided.scrapling
  assert.equal(typeof service.fetch, 'function')
  assert.equal(typeof service.parse, 'function')
  assert.equal(typeof service.fetchWithBrowser, 'function')
  assert.ok(service.crawler, '应暴露 crawler 流水线')
  assert.equal(started.length, 1)
  assert.equal(started[0].id, 'scrapling-workbench')
  assert.equal(started[0].cmd[0], process.execPath)
  assert.equal(started[0].ports.main, 39640)
  assert.equal(started[0].healthPath, '/healthz')
  assert.equal(started[0].keepAlive, true)

  await assert.rejects(() => service.fetchWithBrowser('https://example.com'), (error) => error.code === 'NOT_IMPLEMENTED')
  const doc = service.parse('<ul><li class="x">一</li><li>二</li></ul>')
  assert.deepEqual(doc.css('li::text'), ['一', '二'])
  assert.deepEqual(doc.css('li.x::text'), ['一'])

  assert.equal(typeof ctx.events['webserver/index-inject'], 'function')
  const table = []
  ctx.events['webserver/index-inject'](table)
  assert.equal(table[0].name, '__DSH_SCRAPLING__')
  assert.equal(table[0].value.url, 'http://127.0.0.1:39640/')

  const demoServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><title>局部页</title><p class="g">你好 DSH</p></html>')
  })
  await new Promise((resolve) => demoServer.listen(0, '127.0.0.1', resolve))
  try {
    const result = await service.fetch(`http://127.0.0.1:${demoServer.address().port}/`)
    assert.equal(result.status, 200)
    assert.ok(result.html.includes('你好 DSH'))
    const doc2 = service.parse(result.html)
    assert.deepEqual(doc2.css('title::text'), ['局部页'])
    assert.deepEqual(doc2.css('.g::text'), ['你好 DSH'])
  } finally {
    demoServer.close()
    await dispose()
  }
  assert.deepEqual(stopped, ['scrapling-workbench'])
})

test('apply()：workbench=false 时只注册本地 API，不投递 broker 服务', async () => {
  const host = await importHost()
  let starts = 0
  const ctx = mockCtx({ serviceBroker: { async start() { starts++; return {} }, async stop() {} } })
  const dispose = await host.apply(ctx, { workbench: false })
  try {
    assert.ok(ctx.provided.scrapling)
    assert.equal(starts, 0)
    assert.equal(typeof ctx.events['webserver/index-inject'], 'undefined')
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
  const dispose = await host.apply(ctx, { workbench: false })
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
