import test from 'node:test'
import assert from 'node:assert/strict'

import {
  actionSpecOf,
  brokerApply,
  brokerList,
  brokerRequest,
  brokerStop,
  buildApplyCommands,
  resolveBrokerToken,
  resolveBrokerUrl,
  toUpCommand,
} from '../lib/broker.mjs'
import { startMockBroker } from './helpers.mjs'

function serviceWithSpec(serviceId, spec) {
  const service = { serviceId, type: 'broker' }
  Object.defineProperty(service, '_actionSpec', { value: spec, enumerable: false })
  return service
}

test('resolveBrokerUrl 优先级与协议补全', () => {
  assert.equal(resolveBrokerUrl({
    flag: 'http://flag:1',
    env: { DSH_BROKER_URL: 'http://env:2', DSH_BROKER_PORT: '39610' },
    launchers: [{ launcher: { state: { broker: { url: 'http://state:3' } } } }],
  }), 'http://flag:1')

  assert.equal(resolveBrokerUrl({
    env: { DSH_BROKER_URL: 'http://env:2' },
    launchers: [],
  }), 'http://env:2')

  assert.equal(resolveBrokerUrl({
    env: {},
    launchers: [{ launcher: { state: { broker: { url: 'http://127.0.0.1:39610/' } } } }],
  }), 'http://127.0.0.1:39610')

  assert.equal(resolveBrokerUrl({ env: { DSH_BROKER_PORT: '39610' }, launchers: [] }), 'http://127.0.0.1:39610')
  assert.equal(resolveBrokerUrl({ flag: '127.0.0.1:39700', env: {}, launchers: [] }), 'http://127.0.0.1:39700')
  assert.equal(resolveBrokerUrl({ env: {}, launchers: [] }), '')
})

test('resolveBrokerToken 优先级', () => {
  assert.equal(resolveBrokerToken({ flag: 'flag', env: { DSH_BROKER_TOKEN: 'env' } }), 'flag')
  assert.equal(resolveBrokerToken({ env: { DSH_BROKER_TOKEN: 'env' } }), 'env')
  assert.equal(resolveBrokerToken({ env: {} }), '')
})

test('brokerList 规范化 services 数组', async () => {
  const broker = await startMockBroker()
  try {
    const result = await brokerList({ url: broker.url, timeoutMs: 2000 })
    assert.equal(result.ok, true)
    assert.equal(result.services[0].id, 'alpha')
  } finally {
    await broker.close()
  }
})

test('brokerApply 发送 commands 与 token', async () => {
  const broker = await startMockBroker()
  try {
    const result = await brokerApply({
      url: broker.url,
      token: 'secret-token',
      commands: [{ op: 'up', service: { id: 'x', cmd: ['node', 'a.mjs'] } }],
    })
    assert.equal(result.ok, true)
    const request = broker.requests.find((item) => item.url === '/control/apply')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers['x-broker-token'], 'secret-token')
    assert.equal(request.body.commands[0].service.id, 'x')
  } finally {
    await broker.close()
  }
})

test('brokerStop 发送 id', async () => {
  const broker = await startMockBroker()
  try {
    const result = await brokerStop({ url: broker.url, id: 'x' })
    assert.equal(result.ok, true)
    const request = broker.requests.find((item) => item.url === '/control/stop')
    assert.equal(request.body.id, 'x')
  } finally {
    await broker.close()
  }
})

test('207 不抛错，返回 ok:false', async () => {
  const broker = await startMockBroker({ status207ForApply: true })
  try {
    const result = await brokerApply({
      url: broker.url,
      commands: [{ op: 'up', service: { id: 'x', cmd: ['node', 'a.mjs'] } }],
    })
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 207)
  } finally {
    await broker.close()
  }
})

test('非 2xx 抛 BROKER_HTTP_ERROR', async () => {
  const broker = await startMockBroker({ failAll: true })
  try {
    await assert.rejects(
      () => brokerList({ url: broker.url }),
      (error) => error.code === 'BROKER_HTTP_ERROR' && error.status === 500,
    )
  } finally {
    await broker.close()
  }
})

test('缺少 broker url 抛 BROKER_URL_MISSING', async () => {
  await assert.rejects(
    () => brokerRequest({ url: '', path: '/control/list' }),
    (error) => error.code === 'BROKER_URL_MISSING',
  )
})

test('toUpCommand/buildApplyCommands 使用未脱敏的 _actionSpec', () => {
  const spec = {
    id: 'x',
    cmd: ['node', 'C:/a.mjs', '--port', '${PORT}'],
    env: { API_KEY: 's3cr3t' },
    ports: { main: 'auto' },
    healthPath: '/healthz',
    keepAlive: true,
  }
  const service = serviceWithSpec('x', spec)
  assert.deepEqual(toUpCommand(service), { op: 'up', service: spec })
  assert.deepEqual(buildApplyCommands({ type: 'broker', services: [service] }), [{ op: 'up', service: spec }])
  assert.equal(actionSpecOf(service), spec)
  assert.throws(() => actionSpecOf({ serviceId: 'no-spec' }), (error) => error.code === 'ACTION_SPEC_MISSING')
})
