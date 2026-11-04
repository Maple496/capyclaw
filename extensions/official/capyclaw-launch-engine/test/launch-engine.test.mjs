import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeRegistry, createRegistry, createHttpRegistry, lookupCapability, resolveClosure, RegistryError,
} from '../lib/registry.mjs'
import { planActivation, planDeactivation, filterPending, verificationTargets } from '../lib/planner.mjs'
import { waitForEntries } from '../lib/verify.mjs'
import { executePlan } from '../lib/executor.mjs'
import { apply as applyHost } from '../lib/index.mjs'

/** 示例注册表：skills（被依赖）→ ppt（依赖 skills，含共享 bundle/entry 与服务）。 */
const sampleRaw = () => ({
  version: 1,
  capabilities: {
    skills: {
      bundles: [{ name: 'dsh-skills-bundle' }],
      entries: [{ entryId: 'include:skills-provider' }],
    },
    ppt: {
      title: 'PPT 工作台',
      requires: ['skills'],
      bundles: [{ name: '@capyclaw/ppt-bridge' }, { name: 'dsh-skills-bundle' }],
      entries: [{ entryId: 'include:ppt-workbench' }, { entryId: 'include:skills-provider' }],
      services: [{ id: 'ppt-workbench', cmd: ['node', 'server.mjs'], ports: { main: 39311 } }],
    },
  },
})

// ---------- registry ----------

test('registry：归一化默认值（title 回退、enabled 缺省 true、requires 去重）', () => {
  const reg = normalizeRegistry(sampleRaw())
  assert.equal(reg.version, 1)
  const skills = reg.capabilities.skills
  assert.equal(skills.title, 'skills')
  assert.deepEqual(skills.bundles, [{ name: 'dsh-skills-bundle', enabled: true }])
  assert.deepEqual(skills.entries, [{ entryId: 'include:skills-provider', enabled: true }])
  assert.deepEqual(skills.services, [])
  assert.deepEqual(reg.capabilities.ppt.requires, ['skills'])
})

test('registry：非法输入逐项报错（非对象 / 版本 / 重复名 / 自依赖 / 空 id）', () => {
  assert.throws(() => normalizeRegistry([]), RegistryError)
  assert.throws(() => normalizeRegistry({ version: 2, capabilities: {} }), /不支持的注册表版本/)
  assert.throws(() => normalizeRegistry({ capabilities: { a: {}, ' a ': {} } }), /重复定义/)
  assert.throws(() => normalizeRegistry({ capabilities: { a: { requires: ['a'] } } }), /不能依赖自己/)
  assert.throws(() => normalizeRegistry({ capabilities: { a: { bundles: [{ name: ' ' }] } } }), /非空字符串/)
  assert.throws(() => normalizeRegistry({ capabilities: { a: { services: [{ cmd: ['x'] }] } } }), /services.id/)
})

test('registry：inline 源允许空表；local 源可读文件且 describe 重读', async () => {
  const empty = createRegistry({ kind: 'inline' })
  assert.deepEqual((await empty.describe()).capabilities, {})

  const dir = await mkdtemp(path.join(os.tmpdir(), 'le-reg-'))
  const file = path.join(dir, 'capabilities.json')
  await writeFile(file, JSON.stringify({ capabilities: { demo: { bundles: [{ name: 'x' }] } } }))
  const local = createRegistry({ kind: 'local', file })
  assert.equal((await local.describe()).capabilities.demo.bundles[0].name, 'x')

  await writeFile(file, JSON.stringify({ capabilities: { demo2: {} } }))
  assert.ok((await local.describe()).capabilities.demo2, 'local 源每次 describe 重读文件')
})

test('registry：profile 源读 <DSH_HOME>/profiles/<DSH_PROFILE>/launch-engine.registry.json', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'le-home-'))
  const profileDir = path.join(home, 'profiles', 'domain-demo')
  await mkdir(profileDir, { recursive: true })
  const file = path.join(profileDir, 'launch-engine.registry.json')
  await writeFile(file, JSON.stringify({ version: 1, capabilities: { demo: { bundles: [{ name: 'x' }] } } }))

  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'domain-demo'
  try {
    const profile = createRegistry({ kind: 'profile' })
    assert.equal(profile.id, 'profile')
    assert.equal(profile.file, file)
    assert.equal((await profile.describe()).capabilities.demo.bundles[0].name, 'x')

    await writeFile(file, JSON.stringify({ capabilities: { demo2: {} } }))
    assert.ok((await profile.describe()).capabilities.demo2, 'profile 源每次 describe 重读文件')

    /* 显式 file 覆盖推导路径 */
    const override = createRegistry({ kind: 'profile', file })
    assert.equal(override.file, file)
  } finally {
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE
  }
})

test('registry：profile 源缺文件 / 缺环境都诚实报错', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'le-home-missing-'))
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'ghost'
  try {
    const missing = createRegistry({ kind: 'profile' })
    await assert.rejects(() => missing.describe(), (error) => {
      assert.equal(error.code, 'REGISTRY_NOT_FOUND')
      assert.match(error.message, /suite-kit/)
      return true
    })
  } finally {
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE
  }

  const noEnv = createRegistry({ kind: 'profile' })
  await assert.rejects(() => noEnv.describe(), (error) => error.code === 'INVALID_REGISTRY')
})

test('registry：local 文件缺失 / http 源 / 未知类型都诚实报错', async () => {
  const missing = createRegistry({ kind: 'local', file: path.join(os.tmpdir(), 'no-such-registry.json') })
  await assert.rejects(() => missing.describe(), (error) => error.code === 'REGISTRY_NOT_FOUND')

  const http = createHttpRegistry({ url: 'https://example.com/capabilities.json' })
  await assert.rejects(() => http.describe(), (error) => error.code === 'NOT_IMPLEMENTED')

  assert.throws(() => createRegistry({ kind: 'ftp' }), /未知的注册表源类型/)
})

test('closure：依赖在前、共享依赖去重、环与未知依赖报错', () => {
  const reg = normalizeRegistry(sampleRaw())
  assert.deepEqual(resolveClosure(reg, 'ppt'), ['skills', 'ppt'])
  assert.deepEqual(resolveClosure(reg, 'skills'), ['skills'])
  assert.throws(() => lookupCapability(reg, 'nope'), (error) => {
    assert.equal(error.code, 'UNKNOWN_CAPABILITY')
    assert.deepEqual(error.detail.available, ['skills', 'ppt'])
    return true
  })

  const cyclic = normalizeRegistry({ capabilities: { a: { requires: ['b'] }, b: { requires: ['a'] } } })
  assert.throws(() => resolveClosure(cyclic, 'a'), (error) => error.code === 'CAPABILITY_CYCLE')

  const dangling = normalizeRegistry({ capabilities: { a: { requires: ['ghost'] } } })
  assert.throws(() => resolveClosure(dangling, 'a'), /未注册的 capability: ghost/)
})

// ---------- planner ----------

test('planner：激活波按依赖排序，共享 bundle/entry/service 归首个（更深依赖）波', () => {
  const plan = planActivation(normalizeRegistry(sampleRaw()), 'ppt')
  assert.equal(plan.intent, 'activate')
  assert.equal(plan.expect, 'active')
  assert.deepEqual(plan.waves.map((w) => w.capability), ['skills', 'ppt'])
  assert.deepEqual(plan.waves[0].bundles, [{ name: 'dsh-skills-bundle', enabled: true }])
  assert.deepEqual(plan.waves[1].bundles, [{ name: '@capyclaw/ppt-bridge', enabled: true }], '共享 bundle 不重复')
  assert.deepEqual(plan.waves[0].entries, [{ entryId: 'include:skills-provider', enabled: true }])
  assert.deepEqual(plan.waves[1].entries, [{ entryId: 'include:ppt-workbench', enabled: true }])
  assert.deepEqual(plan.waves[1].services.map((s) => s.id), ['ppt-workbench'])
})

test('planner：声明 enabled:false 的开关在激活计划里保持关闭', () => {
  const reg = normalizeRegistry({ capabilities: { solo: { bundles: [{ name: 'x', enabled: false }] } } })
  assert.deepEqual(planActivation(reg, 'solo').waves[0].bundles, [{ name: 'x', enabled: false }])
})

test('planner：停用计划波序倒转且全部关闭', () => {
  const plan = planDeactivation(normalizeRegistry(sampleRaw()), 'ppt')
  assert.equal(plan.intent, 'deactivate')
  assert.equal(plan.expect, 'inactive')
  assert.deepEqual(plan.waves.map((w) => w.capability), ['ppt', 'skills'])
  for (const wave of plan.waves) {
    for (const bundle of wave.bundles) assert.equal(bundle.enabled, false)
    for (const entry of wave.entries) assert.equal(entry.enabled, false)
  }
})

test('planner：filterPending 裁掉已满足开关，找不到的保留（交给 manager 诚实报错）', () => {
  const plan = planActivation(normalizeRegistry(sampleRaw()), 'ppt')
  const pending = filterPending(plan, {
    bundles: [{ name: 'dsh-skills-bundle', enabled: true }],
    plugins: [{ entryId: 'include:skills-provider', enabled: true }],
  })
  assert.deepEqual(pending.waves[0].bundles, [], '已启用的 bundle 不重复下发')
  assert.deepEqual(pending.waves[0].entries, [])
  assert.deepEqual(pending.waves[1].bundles, [{ name: '@capyclaw/ppt-bridge', enabled: true }])
  assert.deepEqual(verificationTargets(plan), ['include:skills-provider', 'include:ppt-workbench'], '验证目标含被裁剪项')
})

// ---------- verify ----------

const managerOf = (plugins) => ({
  async listPlugins() { return plugins },
  async listBundles() { return [] },
})

test('verify：active 口径只认 enabled && fiberPhase=active', async () => {
  const ok = await waitForEntries({
    manager: managerOf([{ entryId: 'include:x', enabled: true, fiberPhase: 'active' }]),
    entryIds: ['include:x'], timeoutMs: 50, pollMs: 5,
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.entries[0].state, 'active')

  const notYet = await waitForEntries({
    manager: managerOf([{ entryId: 'include:x', enabled: true, fiberPhase: 'starting' }]),
    entryIds: ['include:x'], timeoutMs: 30, pollMs: 5,
  })
  assert.equal(notYet.ok, false)
  assert.equal(notYet.timedOut, true)
  assert.equal(notYet.entries[0].state, 'pending')
})

test('verify：inactive 口径接受 entry 消失或 enabled=false', async () => {
  const gone = await waitForEntries({
    manager: managerOf([]), entryIds: ['include:x'], expect: 'inactive', timeoutMs: 30, pollMs: 5,
  })
  assert.equal(gone.ok, true)
  const off = await waitForEntries({
    manager: managerOf([{ entryId: 'include:x', enabled: false, fiberPhase: 'disposed' }]),
    entryIds: ['include:x'], expect: 'inactive', timeoutMs: 30, pollMs: 5,
  })
  assert.equal(off.ok, true)
  const stillOn = await waitForEntries({
    manager: managerOf([{ entryId: 'include:x', enabled: true, fiberPhase: 'active' }]),
    entryIds: ['include:x'], expect: 'inactive', timeoutMs: 30, pollMs: 5,
  })
  assert.equal(stillOn.ok, false)
})

// ---------- executor ----------

/** 模拟世界：pluginManager 状态机 + pluginSync 转发 + broker。 */
function makeWorld({ application = 'applied', brokerEnabled = true } = {}) {
  const world = {
    applied: [], started: [], stopped: [],
    bundles: [{ name: 'dsh-skills-bundle', enabled: true, installed: true }],
    plugins: [{ entryId: 'include:skills-provider', enabled: true, fiberPhase: 'active' }],
  }
  world.manager = {
    async listBundles() { return world.bundles },
    async listPlugins() { return world.plugins },
  }
  world.pluginSync = {
    async apply({ changes }) {
      world.applied.push(...changes)
      let applied = 0
      let pending = 0
      for (const change of changes) {
        if (application !== 'applied') { pending += 1; continue }
        if (change.op === 'bundle') {
          const bundle = world.bundles.find((b) => b.name === change.name) || { name: change.name, installed: true }
          bundle.enabled = change.enabled
          if (!world.bundles.includes(bundle)) world.bundles.push(bundle)
        } else {
          const entry = world.plugins.find((p) => p.entryId === change.entryId) || { entryId: change.entryId }
          entry.enabled = change.enabled
          entry.fiberPhase = change.enabled ? 'active' : 'disposed'
          if (!world.plugins.includes(entry)) world.plugins.push(entry)
        }
        applied += 1
      }
      return { ok: application === 'applied', applied, pending, failed: 0, results: [] }
    },
  }
  world.broker = {
    async start(spec) { world.started.push(spec); return { ok: true, id: spec.id } },
    async stop(id) { world.stopped.push(id); return { ok: true, id } },
  }
  world.getBroker = () => (brokerEnabled ? world.broker : null)
  return world
}

test('executor：逐波转发 + 裁剪 + 验证，全绿报 active', async () => {
  const world = makeWorld()
  const plan = planActivation(normalizeRegistry(sampleRaw()), 'ppt')
  const result = await executePlan(
    { plan, pluginSync: world.pluginSync, getBroker: world.getBroker, manager: world.manager },
    { verifyTimeoutMs: 200, pollMs: 5 },
  )
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'active')
  // 已启用的 dsh-skills-bundle 被裁掉，只下发差异部分；bundle 在 entry 前
  assert.deepEqual(world.applied, [
    { op: 'bundle', name: '@capyclaw/ppt-bridge', enabled: true },
    { op: 'entry', entryId: 'include:ppt-workbench', enabled: true },
  ])
  assert.deepEqual(world.started.map((s) => s.id), ['ppt-workbench'])
  assert.equal(result.waves.length, 2)
  assert.equal(result.waves[0].changes.skipped, true, '首波已满足 → 无变更')
  assert.equal(result.waves[1].verification.ok, true)
})

test('executor：没有 broker 时服务步骤诚实失败（degraded，不冒充成功）', async () => {
  const world = makeWorld({ brokerEnabled: false })
  const plan = planActivation(normalizeRegistry(sampleRaw()), 'ppt')
  const result = await executePlan(
    { plan, pluginSync: world.pluginSync, getBroker: world.getBroker, manager: world.manager },
    { verifyTimeoutMs: 200, pollMs: 5 },
  )
  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'degraded')
  assert.equal(result.waves[1].services[0].ok, false)
  assert.match(result.waves[1].services[0].error, /serviceBroker/)
})

test('executor：restart-required 不算成功，outcome 如实上报', async () => {
  const world = makeWorld({ application: 'restart-required' })
  const plan = planActivation(normalizeRegistry(sampleRaw()), 'ppt')
  const result = await executePlan(
    { plan, pluginSync: world.pluginSync, getBroker: world.getBroker, manager: world.manager },
    { verifyTimeoutMs: 50, pollMs: 5 },
  )
  assert.equal(result.outcome, 'restart-required')
  assert.equal(result.ok, false)
})

test('executor：停用走 entry→bundle 且波序倒转，验证 inactive', async () => {
  const world = makeWorld()
  const plan = planDeactivation(normalizeRegistry(sampleRaw()), 'ppt')
  const result = await executePlan(
    { plan, pluginSync: world.pluginSync, getBroker: world.getBroker, manager: world.manager },
    { verifyTimeoutMs: 200, pollMs: 5 },
  )
  assert.equal(result.outcome, 'inactive')
  assert.equal(result.ok, true)
  assert.deepEqual(world.applied, [
    // 停用波序倒转（ppt 在前），共享开关归首个遍历到的波；波内 entry → bundle
    { op: 'entry', entryId: 'include:ppt-workbench', enabled: false },
    { op: 'entry', entryId: 'include:skills-provider', enabled: false },
    { op: 'bundle', name: '@capyclaw/ppt-bridge', enabled: false },
    { op: 'bundle', name: 'dsh-skills-bundle', enabled: false },
  ])
  assert.deepEqual(world.stopped, ['ppt-workbench'], '停用时服务走 broker.stop 而不是 start')
  assert.deepEqual(world.started, [])
})

// ---------- host（apply + 服务面 + HTTP 路由） ----------

function makeCtx(world, config) {
  const ctx = {
    pluginManager: world.manager,
    pluginSync: world.pluginSync,
    serviceBroker: world.broker,
    provided: {}, routes: [],
    provide(name, service) { ctx.provided[name] = service; return () => delete ctx.provided[name] },
    webServer: { register(route) { ctx.routes.push(route.path); return () => {} } },
    logger: { info() {}, warn() {} },
  }
  ctx.dispose = applyHost(ctx, { capabilities: sampleRaw().capabilities, ...config })
  return ctx
}

test('host：provide launchEngine + 挂 5 条路由，disposer 可执行', () => {
  const world = makeWorld()
  const ctx = makeCtx(world, {})
  assert.ok(ctx.provided.launchEngine)
  assert.equal(ctx.provided.launchEngine.registryId, 'inline')
  assert.deepEqual(ctx.routes.sort(), [
    '/__launch_engine__/activate',
    '/__launch_engine__/capabilities',
    '/__launch_engine__/deactivate',
    '/__launch_engine__/resolve',
    '/__launch_engine__/status',
  ])
  assert.equal(typeof ctx.dispose, 'function')
  ctx.dispose()
})

test('host：enableHttp=false 时不挂路由，服务面仍在', () => {
  const world = makeWorld()
  const ctx = makeCtx(world, { enableHttp: false })
  assert.deepEqual(ctx.routes, [])
  assert.ok(ctx.provided.launchEngine)
})

test('host：resolve/activate/status 全链路（inline 注册表 → 计划 → 执行）', async () => {
  const world = makeWorld()
  const ctx = makeCtx(world, {})
  const engine = ctx.provided.launchEngine

  const plan = await engine.resolve('ppt')
  assert.deepEqual(plan.waves.map((w) => w.capability), ['skills', 'ppt'])

  const capabilities = await engine.capabilities()
  assert.equal(capabilities.length, 2)
  assert.equal(capabilities.find((c) => c.name === 'ppt').bundles, 2)

  const result = await engine.activate('ppt', { timeoutMs: 200, pollMs: 5 })
  assert.equal(result.outcome, 'active')

  const status = await engine.status()
  const ppt = status.find((c) => c.name === 'ppt')
  assert.equal(ppt.satisfied, true)
  assert.equal(ppt.entries.find((e) => e.entryId === 'include:ppt-workbench').active, true)

  await assert.rejects(() => engine.resolve('nope'), (error) => error.code === 'UNKNOWN_CAPABILITY')
})

// ---------- suite 清单自检（防止 schema 漂移） ----------

test('suite：随包 dsh-suite.json 通过 suite-kit 校验', async () => {
  const suiteKit = await import(new URL('../../../../packages/dsh-suite-kit/src/index.mjs', import.meta.url).href)
  const suiteDir = fileURLToPath(new URL('../plugin/capyclaw-launch-engine-suite', import.meta.url))
  const { manifest } = suiteKit.loadSuiteManifest(suiteDir)
  assert.equal(manifest.name, 'capyclaw-launch-engine-suite')
  suiteKit.assertValidSuiteManifest(manifest, 'capyclaw-launch-engine-suite')
  assert.ok(manifest.packages['@capyclaw/launch-engine'])
  assert.ok(manifest.packages['@capyclaw/plugin-sync'])
  assert.deepEqual(manifest.rows.map((r) => r.id), ['plugin-sync-host', 'launch-engine-host'])
})
