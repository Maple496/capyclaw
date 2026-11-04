import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  isBrokerManifestShape,
  isDiscoveryShape,
  maskEnv,
  normalizeServiceSpec,
  parseDomain,
  parseLauncher,
  parseProfile,
  parseSpecPorts,
  parseWorks,
  parseWorksContent,
} from '../lib/parse.mjs'
import { FIXTURE } from './helpers.mjs'

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(FIXTURE, rel), 'utf8'))
}

function readText(rel) {
  return readFileSync(path.join(FIXTURE, rel), 'utf8')
}

test('normalizeServiceSpec 展开 PACKAGE_DIR、保留 PORT、脱敏 env', () => {
  const base = path.join(FIXTURE, 'tools', 'launcher')
  const result = normalizeServiceSpec({
    id: 'svc',
    cmd: ['node', '${PACKAGE_DIR}/server.mjs', '--port', '${PORT}'],
    env: { API_KEY: 's3cr3t', PLAIN: 'value' },
    ports: { main: 'auto' },
    url: 'http://127.0.0.1:${PORT}',
    requires: ['dep'],
  }, base)

  assert.equal(result.errors.length, 0)
  assert.equal(result.actionSpec.cmd[1], path.join(base, 'server.mjs'))
  assert.equal(result.actionSpec.cmd[3], '${PORT}')
  assert.equal(result.actionSpec.ports.main, 'auto')
  assert.equal(result.actionSpec.env.API_KEY, 's3cr3t')
  assert.equal(result.spec.env.API_KEY, '***')
  assert.equal(result.spec.env.PLAIN, 'value')
  assert.equal(result.spec.url, 'http://127.0.0.1:${PORT}')
  assert.equal(result.specHash.length, 12)
  assert.deepEqual(result.fixedPorts, [])
})

test('parseSpecPorts 接受固定端口与 auto，拒绝非法值', () => {
  const result = parseSpecPorts({ main: 41001, extra: 'auto', bad: 'x' })
  assert.equal(result.ports.main, 41001)
  assert.equal(result.ports.extra, 'auto')
  assert.equal(result.fixed.length, 1)
  assert.equal(result.issues.filter((issue) => issue.severity === 'error').length, 1)
  assert.equal(parseSpecPorts(null).ports.main, 'auto')
})

test('maskEnv 只脱敏看起来像密钥的键', () => {
  assert.deepEqual(maskEnv({
    API_KEY: 'x',
    TOKEN: 'y',
    PASSWORD: 'z',
    PLAIN: 'v',
    PLACEHOLDER: '${PLACEHOLDER}',
  }), {
    API_KEY: '***',
    TOKEN: '***',
    PASSWORD: '***',
    PLAIN: 'v',
    PLACEHOLDER: '${PLACEHOLDER}',
  })
})

test('parseWorksContent/parseWorks 解析部署清单并检查 source', () => {
  const file = path.join(FIXTURE, 'deployments', 'basic.works')
  const text = readText('deployments/basic.works')
  const parsed = parseWorksContent(text)
  assert.equal(parsed.meta.name, 'Demo Deployment')
  assert.equal(parsed.code.deployment.type, 'domain')

  const record = parseWorks(text, file, { id: 'works-test' })
  assert.equal(record.valid, true)
  assert.equal(record.works.deployment.sourceExists, true)
  assert.ok(record.works.deployment.domainPath.endsWith(path.join('domains', 'demo', 'dsh-domain.json')))
  assert.ok(record.works.declaredPorts.some((item) => item.name === 'content' && item.port === 41001))
})

test('parseWorks 对不存在的 source 报错', () => {
  const file = path.join(FIXTURE, 'deployments', 'broken.works')
  const record = parseWorks(readText('deployments/broken.works'), file, { id: 'works-broken' })
  assert.equal(record.valid, false)
  assert.ok(record.issues.some((issue) => issue.code === 'works-source-missing'))
})

test('parseDomain 审计组件行覆盖与 preferred 端口', () => {
  const file = path.join(FIXTURE, 'domains', 'demo', 'dsh-domain.json')
  const record = parseDomain(readJson('domains/demo/dsh-domain.json'), file, { id: 'domain-test' })
  assert.equal(record.valid, false)
  assert.ok(record.domain.declaredRows.includes('demo-host'))
  assert.ok(record.domain.declaredRows.includes('demo-extra'))
  assert.ok(record.domain.declaredRows.includes('demo-pkg-row'))
  assert.ok(record.domain.missingRows.some((item) => item.id === 'missing-row'))
  assert.ok(record.issues.some((issue) => issue.code === 'domain-row-missing'))
  assert.ok(record.domain.declaredPorts.some((item) => item.name === 'content' && item.port === 41001))
})

test('parseLauncher 解析相对路径与 state.json', () => {
  const file = path.join(FIXTURE, 'config', 'dshd.config.json')
  const record = parseLauncher(readJson('config/dshd.config.json'), file, { id: 'launcher-test' })
  assert.equal(record.valid, true)
  assert.equal(record.launcher.resolved.manifest, path.join(FIXTURE, 'tools', 'launcher', 'local-services.json'))
  assert.equal(record.launcher.resolved.dshHome, path.join(FIXTURE, 'config', 'home'))
  assert.equal(record.launcher.state.broker.port, 39610)
  assert.equal(record.launcher.discoveryFile, path.join(FIXTURE, 'config', 'state', 'services.json'))
})

test('parseProfile 读取 bundles/suites', () => {
  const file = path.join(FIXTURE, 'config', 'home', 'profiles', 'web', 'package.json')
  const record = parseProfile(readJson('config/home/profiles/web/package.json'), file, { id: 'profile-test' })
  assert.equal(record.valid, true)
  assert.equal(record.profile.name, 'web')
  assert.deepEqual(record.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-demo', 'dsh-missing'])
  assert.deepEqual(record.profile.suites, ['dsh-demo-suite'])
})

test('形状识别：discovery 不是 broker 清单', () => {
  const discovery = readJson('config/state/services.json')
  const broker = readJson('tools/launcher/local-services.json')
  assert.equal(isDiscoveryShape(discovery), true)
  assert.equal(isBrokerManifestShape(discovery, 'services.json'), false)
  assert.equal(isBrokerManifestShape(broker, 'local-services.json'), true)
})
