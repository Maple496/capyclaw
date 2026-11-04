import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { analyze } from '../lib/analyze.mjs'
import { scan } from '../lib/scan.mjs'
import {
  buildDoctor,
  buildStatus,
  loadDiscovery,
  pidAlive,
  probeHealth,
  resolveDiscoveryPath,
} from '../lib/status.mjs'
import {
  FIXTURE,
  FIXTURE_DISCOVERY,
  FIXTURE_DSH_HOME,
  startMockBroker,
  startMockHealth,
} from './helpers.mjs'

async function load() {
  const result = await scan({
    roots: [FIXTURE],
    dshHome: FIXTURE_DSH_HOME,
    cwd: FIXTURE,
  })
  return analyze(result)
}

test('pidAlive 识别当前进程与无效 pid', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive(-1), false)
  assert.equal(pidAlive(999999), false)
})

test('resolveDiscoveryPath 优先级：flag > env > launcher > dshHome', () => {
  const flag = resolveDiscoveryPath({ flag: FIXTURE_DISCOVERY, env: { DSH_DISCOVERY_FILE: 'x' } })
  assert.equal(flag.source, 'flag')
  assert.equal(flag.file, FIXTURE_DISCOVERY)
  assert.equal(flag.exists, true)

  const env = resolveDiscoveryPath({
    env: { DSH_DISCOVERY_FILE: FIXTURE_DISCOVERY },
    launchers: [],
    dshHome: FIXTURE_DSH_HOME,
  })
  assert.equal(env.source, 'env:DSH_DISCOVERY_FILE')
  assert.equal(env.file, FIXTURE_DISCOVERY)

  const launcher = resolveDiscoveryPath({
    env: {},
    launchers: [{ launcher: { resolved: { stateDir: path.join(FIXTURE, 'config', 'state') } } }],
    dshHome: FIXTURE_DSH_HOME,
  })
  assert.equal(launcher.source, 'launcher-state-dir')
  assert.equal(launcher.file, FIXTURE_DISCOVERY)

  const dshHome = resolveDiscoveryPath({ env: {}, launchers: [], dshHome: FIXTURE_DSH_HOME })
  assert.ok(dshHome.candidates.some((candidate) => candidate.source === 'dsh-home'))
})

test('loadDiscovery 对缺失/损坏/合法文件诚实降级', async () => {
  const missing = await loadDiscovery(path.join(FIXTURE, 'nope.json'))
  assert.equal(missing.exists, false)
  assert.equal(missing.data, null)

  const ok = await loadDiscovery(FIXTURE_DISCOVERY)
  assert.equal(ok.exists, true)
  assert.equal(ok.error, null)
  assert.ok(ok.data.services.alpha)
})

test('probeHealth 返回状态与 body', async () => {
  const health = await startMockHealth({ body: { ok: true, service: 'mock', pid: process.pid } })
  try {
    const ok = await probeHealth(health.url, '/healthz', 800)
    assert.equal(ok.ok, true)
    assert.equal(ok.body.ok, true)
  } finally {
    await health.close()
  }

  const bad = await startMockHealth({ status: 500, body: { ok: false } })
  try {
    const result = await probeHealth(bad.url, '/healthz', 800)
    assert.equal(result.ok, false)
    assert.equal(result.status, 500)
  } finally {
    await bad.close()
  }
})

test('buildStatus 合并 discovery/launcher/broker', async () => {
  const inventory = await load()
  const broker = await startMockBroker()
  try {
    const status = await buildStatus(inventory, {
      discovery: FIXTURE_DISCOVERY,
      brokerUrl: broker.url,
      env: {},
    })
    assert.equal(status.services.length, 7)
    const alpha = status.services.find((service) => service.serviceId === 'alpha')
    const beta = status.services.find((service) => service.serviceId === 'beta')
    const launchpad = status.services.find((service) => service.serviceId === 'launchpad')
    const gamma = status.services.find((service) => service.serviceId === 'gamma')
    assert.equal(alpha.state, 'stale')
    assert.equal(beta.state, 'stopped')
    assert.equal(launchpad.state, 'error')
    assert.equal(gamma.state, 'unknown')
    assert.equal(status.discovery.source, 'flag')
    assert.equal(status.broker.reachable, true)
    assert.equal(status.launchers[0].runtime.broker.pidAlive, false)
    assert.equal(status.summary.stale, 3)
    assert.equal(status.summary.error, 1)
  } finally {
    await broker.close()
  }
})

test('buildDoctor 区分 required 失败与启停可用性', async () => {
  const inventory = await load()
  const broker = await startMockBroker()
  try {
    const doctor = await buildDoctor(inventory, {
      discovery: FIXTURE_DISCOVERY,
      brokerUrl: broker.url,
      env: {},
    })
    assert.equal(doctor.ok, false)
    assert.equal(doctor.actionsAvailable, true)
    const required = doctor.checks.filter((check) => check.required)
    assert.ok(required.some((check) => check.name === '清单错误' && !check.ok))
    assert.ok(doctor.checks.some((check) => check.name === 'discovery' && check.ok))
  } finally {
    await broker.close()
  }
})
