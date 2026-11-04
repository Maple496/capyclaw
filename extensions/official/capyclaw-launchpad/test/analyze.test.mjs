import test from 'node:test'
import assert from 'node:assert/strict'

import { analyze, resolveManifestRef, resolveServiceRef } from '../lib/analyze.mjs'
import { scan } from '../lib/scan.mjs'
import { FIXTURE, FIXTURE_DSH_HOME } from './helpers.mjs'

async function load() {
  const result = await scan({
    roots: [FIXTURE],
    dshHome: FIXTURE_DSH_HOME,
    cwd: FIXTURE,
  })
  return analyze(result)
}

test('汇总四类清单、服务数与 error/warning', async () => {
  const inventory = await load()
  assert.equal(inventory.manifests.length, 8)
  assert.equal(inventory.services.length, 7)
  assert.equal(inventory.summary.brokerManifests, 3)
  assert.equal(inventory.summary.deployments, 2)
  assert.equal(inventory.summary.domains, 1)
  assert.equal(inventory.summary.launchers, 1)
  assert.equal(inventory.summary.profiles, 1)
  assert.equal(inventory.summary.errors, 7)
  assert.equal(inventory.summary.warnings, 3)
})

test('冲突/失效路径/行覆盖/依赖/缺 bundle 都被识别', async () => {
  const inventory = await load()
  const codes = new Set(inventory.issues.map((issue) => issue.code))
  for (const code of [
    'broker-duplicate-id',
    'broker-duplicate-port',
    'works-source-missing',
    'domain-row-missing',
    'broker-missing-command-path',
    'broker-dangling-requires',
    'cross-manifest-id-conflict',
    'cross-manifest-port-conflict',
    'profile-bundle-missing',
  ]) {
    assert.ok(codes.has(code), `缺少 issue: ${code}`)
  }
  const duplicate = inventory.issues.find((issue) => issue.code === 'cross-manifest-id-conflict')
  assert.ok(duplicate.manifests.length >= 3)
  assert.equal(duplicate.serviceId, 'alpha')
  // `--dir <path>` 是运行时目录，不应被当成缺失命令路径
  assert.ok(!inventory.issues.some((issue) => issue.code === 'broker-missing-command-path'
    && issue.serviceId === 'dirsvc'))
})

test('works 链接到 domain，launcher 链接到 active manifest', async () => {
  const inventory = await load()
  const works = inventory.deployments.find((manifest) => manifest.title === 'Demo Deployment')
  assert.ok(works.works.deployment.domainId)
  assert.ok(works.works.deployment.domainRelativePath.endsWith('domains/demo/dsh-domain.json'))
  const launcher = inventory.launchers[0]
  assert.ok(launcher.launcher.activeManifestId)
  assert.ok(launcher.launcher.activeManifestRelativePath.endsWith('tools/launcher/local-services.json'))
})

test('resolveManifestRef 支持路径/basename，歧义时报 AMBIGUOUS', async () => {
  const inventory = await load()
  assert.equal(resolveManifestRef(inventory, 'local-services.json').type, 'broker')
  assert.equal(resolveManifestRef(inventory, 'tools\\launcher\\local-services.json').type, 'broker')
  assert.equal(resolveManifestRef(inventory, 'basic.works').type, 'works')
  assert.equal(resolveManifestRef(inventory, 'dsh-domain.json').type, 'domain')
  assert.equal(resolveManifestRef(inventory, 'dshd.config.json').type, 'launcher')
  assert.equal(resolveManifestRef(inventory, 'package.json').type, 'profile')
  assert.throws(() => resolveManifestRef(inventory, 'services.json'), (error) => error.code === 'AMBIGUOUS')
  assert.throws(() => resolveManifestRef(inventory, 'nope.json'), (error) => error.code === 'NOT_FOUND')
})

test('resolveServiceRef 对同名不同 spec 要求 --manifest', async () => {
  const inventory = await load()
  assert.throws(() => resolveServiceRef(inventory, 'alpha'), (error) => error.code === 'AMBIGUOUS')
  const local = resolveServiceRef(inventory, 'alpha', 'local-services.json')
  assert.equal(local.service.serviceId, 'alpha')
  assert.ok(local.service.manifestRelativePath.endsWith('tools/launcher/local-services.json'))
  const self = resolveServiceRef(inventory, 'launchpad')
  assert.equal(self.service.serviceId, 'launchpad')
  assert.throws(() => resolveServiceRef(inventory, 'nope'), (error) => error.code === 'NOT_FOUND')
})

test('可执行 spec 不进入 JSON 输出（non-enumerable）', async () => {
  const inventory = await load()
  const alpha = inventory.services.find((service) => service.serviceId === 'alpha')
  assert.ok(alpha._actionSpec)
  assert.equal(Object.keys(alpha).includes('_actionSpec'), false)
  const roundTrip = JSON.parse(JSON.stringify(inventory))
  assert.equal(roundTrip.services[0]._actionSpec, undefined)
})
