import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  applyStack,
  compileStack,
  loadStack,
  planStack,
  summarizePlan,
  validateStack,
} from '../src/index.mjs'

const posix = (value) => String(value).split(path.sep).join('/')

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function makeFixture(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-stack-'))
  await mkdir(path.join(dir, 'plugin'), { recursive: true })
  await writeJson(path.join(dir, 'plugin', 'package.json'), {
    name: 'demo-plugin',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeFile(path.join(dir, 'plugin', 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo\n')
  await writeFile(path.join(dir, 'plugin', 'server.mjs'), 'console.log("demo")\n')
  await mkdir(path.join(dir, 'kit'), { recursive: true })
  await writeJson(path.join(dir, 'kit', 'package.json'), { name: 'dsh-plugin-kit', version: '0.2.0' })

  const stack = {
    name: 'test',
    home: './home',
    profile: 'web',
    workspace: './ws',
    stateDir: './state',
    ports: { broker: 14001, proxy: 14002, upstream: 14003 },
    plugins: {
      bundles: [
        '@deepseek-ai/dsh-base',
        { name: 'demo-plugin', path: './plugin' },
      ],
      install: false,
    },
    services: [
      {
        id: 'demo',
        path: './plugin/server.mjs',
        args: ['--roots', '${STACK_DIR}', '--dsh-home', '${home}'],
        ports: { main: 14004 },
        env: { DEMO: '1' },
      },
      {
        id: 'direct',
        cmd: ['node', '${STACK_DIR}/plugin/server.mjs', '--port', '${PORT}'],
        ports: { main: 'auto' },
      },
    ],
    ...overrides,
  }
  await writeJson(path.join(dir, 'stack.json'), stack)
  return { dir, stackFile: path.join(dir, 'stack.json') }
}

test('validateStack/compileStack：bundles、link 依赖、服务 spec、占位符', async () => {
  const { dir, stackFile } = await makeFixture()
  try {
    const stack = loadStack(stackFile)
    const validation = validateStack(stack)
    assert.equal(validation.ok, true)

    const compiled = compileStack(stack)
    assert.equal(compiled.valid, true)
    assert.equal(compiled.paths.home, path.join(dir, 'home'))
    assert.equal(compiled.paths.manifest, path.join(dir, 'state', 'stack-services.json'))
    assert.deepEqual(compiled.profile.bundles, ['@deepseek-ai/dsh-base', 'demo-plugin'])
    assert.deepEqual(compiled.profile.packageJson.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'demo-plugin'])
    assert.equal(compiled.profile.packageJson.dependencies['demo-plugin'], `link:${posix(path.join(dir, 'plugin'))}`)

    const demo = compiled.services.find((service) => service.id === 'demo')
    assert.deepEqual(demo.cmd, [
      'node',
      path.join(dir, 'plugin', 'server.mjs'),
      '--roots', dir,
      '--dsh-home', path.join(dir, 'home'),
      '--port', '${PORT}',
    ])
    assert.equal(demo.env.DEMO, '1')
    assert.equal(demo.ports.main, 14004)
    assert.equal(demo.url, 'http://127.0.0.1:${PORT}')
    assert.equal(demo.healthPath, '/healthz')
    assert.equal(demo.keepAlive, true)

    const direct = compiled.services.find((service) => service.id === 'direct')
    assert.deepEqual(direct.cmd, ['node', path.join(dir, 'plugin', 'server.mjs'), '--port', '${PORT}'])
    assert.equal(direct.ports.main, 'auto')
    assert.equal(compiled.config.ports.broker, 14001)
    assert.equal(compiled.profile.installNeeded, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('planStack/applyStack：写 profile 与 broker 清单，二次 plan 无变化', async () => {
  const { dir, stackFile } = await makeFixture()
  try {
    const stack = loadStack(stackFile)
    const before = planStack(stack)
    assert.equal(before.valid, true)
    assert.equal(before.changes.profileBundles.changed, true)
    assert.ok(before.changes.dependencies.added.includes('demo-plugin'))
    assert.deepEqual(before.changes.services.map((item) => [item.id, item.change]), [['demo', 'added'], ['direct', 'added']])
    assert.equal(before.profile.installNeeded, false)

    const applied = applyStack(stack, { install: false })
    assert.equal(applied.applied, true)
    assert.equal(applied.profileWritten, true)
    assert.equal(applied.manifestWritten, true)
    assert.equal(applied.profilePackageFile, path.join(dir, 'home', 'profiles', 'web', 'package.json'))
    assert.equal(applied.manifestFile, path.join(dir, 'state', 'stack-services.json'))

    const profile = JSON.parse(await readFile(applied.profilePackageFile, 'utf8'))
    assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'demo-plugin'])
    assert.equal(profile.dependencies['demo-plugin'], `link:${posix(path.join(dir, 'plugin'))}`)

    const manifest = JSON.parse(await readFile(applied.manifestFile, 'utf8'))
    assert.equal(manifest._generatedBy, 'dsh-stack-kit')
    assert.equal(manifest.services.length, 2)
    assert.equal(manifest.services[0].id, 'demo')

    const after = planStack(loadStack(stackFile))
    assert.equal(after.changes.profileBundles.changed, false)
    assert.deepEqual(after.changes.dependencies.added, [])
    assert.deepEqual(after.changes.services, [])
    assert.equal(after.changes.manifest.changed, false)
    assert.equal(after.profile.installNeeded, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plugins.dependencies/overrides 编译为 link 与 pnpm.overrides', async () => {
  const { dir, stackFile } = await makeFixture({
    plugins: {
      bundles: ['@deepseek-ai/dsh-base'],
      install: false,
      dependencies: { 'dsh-plugin-kit': './kit' },
      overrides: { 'dsh-plugin-kit': './kit' },
    },
  })
  try {
    const compiled = compileStack(loadStack(stackFile))
    assert.equal(compiled.valid, true)
    assert.equal(compiled.profile.packageJson.dependencies['dsh-plugin-kit'], `link:${posix(path.join(dir, 'kit'))}`)
    assert.equal(compiled.profile.packageJson.pnpm.overrides['dsh-plugin-kit'], `link:${posix(path.join(dir, 'kit'))}`)
    assert.deepEqual(compiled.profile.bundles, ['@deepseek-ai/dsh-base'])
    assert.equal(compiled.profile.installNeeded, false) // install:false
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('installNeeded 只在依赖变化/缺 link 时为 true', async () => {
  const { dir, stackFile } = await makeFixture({
    plugins: {
      bundles: ['@deepseek-ai/dsh-base'],
      install: true,
    },
    services: [],
  })
  try {
    const compiled = compileStack(loadStack(stackFile))
    assert.equal(compiled.valid, true)
    assert.equal(compiled.profile.dependencyChanged, false)
    assert.equal(compiled.profile.installNeeded, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('applyStack install:true 会为 link 依赖创建 node_modules 链接', async () => {
  const { dir, stackFile } = await makeFixture({
    plugins: {
      bundles: [
        '@deepseek-ai/dsh-base',
        { name: 'demo-plugin', path: './plugin' },
      ],
      install: true,
    },
    services: [],
  })
  try {
    const stack = loadStack(stackFile)
    const plan = planStack(stack)
    assert.equal(plan.profile.installNeeded, true)
    const result = applyStack(stack, { install: true })
    assert.equal(result.applied, true)
    assert.equal(result.installSkipped, false)
    assert.ok(existsSync(path.join(dir, 'home', 'profiles', 'web', 'node_modules', 'demo-plugin', 'package.json')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('校验：重复 id、缺失插件路径、非法端口', async () => {
  {
    const { dir, stackFile } = await makeFixture({
      services: [
        { id: 'x', cmd: ['node', 'a.mjs'] },
        { id: 'x', cmd: ['node', 'b.mjs'] },
      ],
    })
    try {
      const result = validateStack(loadStack(stackFile))
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((error) => error.includes('id 重复')))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  {
    const { dir, stackFile } = await makeFixture({
      plugins: { bundles: [{ name: 'missing', path: './nope' }], install: false },
    })
    try {
      const result = validateStack(loadStack(stackFile))
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((error) => error.includes('没有 package.json')))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  {
    const { dir, stackFile } = await makeFixture({
      ports: { broker: 70000, proxy: 14002, upstream: 14003 },
    })
    try {
      const result = validateStack(loadStack(stackFile))
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((error) => error.includes('ports.broker')))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('summarizePlan 输出 CLI 可用摘要', async () => {
  const { dir, stackFile } = await makeFixture()
  try {
    const summary = summarizePlan(planStack(loadStack(stackFile)))
    assert.equal(summary.valid, true)
    assert.deepEqual(summary.bundles, ['@deepseek-ai/dsh-base', 'demo-plugin'])
    assert.deepEqual(summary.services, ['demo', 'direct'])
    assert.equal(summary.installNeeded, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('domain 型 stack：kind/domain 编译、默认 runtimeId/storeRoot、plan 与 apply 边界', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-stack-domain-'))
  try {
    await mkdir(path.join(dir, 'domain'), { recursive: true })
    await writeJson(path.join(dir, 'domain', 'dsh-domain.json'), {
      name: 'demo-domain',
      version: '1.0.0',
      components: ['./suite'],
    })
    const stackFile = path.join(dir, 'stack.json')
    await writeJson(stackFile, {
      kind: 'domain',
      name: 'domain-stack',
      stateDir: './state',
      ports: {
        proxy: 'auto',
        upstream: 'auto',
        content: 'auto',
        broker: 'auto',
        services: { probe: 'auto' },
      },
      domain: {
        source: './domain',
        name: 'Demo Domain',
        profile: 'demo-profile',
        env: { DOMAIN_FLAG: '1' },
      },
    })

    const stack = loadStack(stackFile)
    const validation = validateStack(stack)
    assert.equal(validation.ok, true)

    const compiled = compileStack(stack)
    assert.equal(compiled.valid, true)
    assert.equal(compiled.kind, 'domain')
    assert.equal(compiled.paths.runtimeId, 'rt-stack-domain-stack')
    assert.equal(compiled.paths.storeRoot, path.join(dir, 'state', 'store'))
    assert.equal(compiled.domain.source, path.join(dir, 'domain'))
    assert.equal(compiled.domain.profile, 'demo-profile')
    assert.equal(compiled.domain.name, 'Demo Domain')
    assert.equal(compiled.domain.env.DOMAIN_FLAG, '1')
    assert.equal(compiled.profile, null)
    assert.deepEqual(compiled.services, [])

    const plan = planStack(stack)
    assert.equal(plan.valid, true)
    assert.equal(plan.changes.domain.exists, false)
    assert.equal(plan.changes.domain.changed, true)
    const summary = summarizePlan(plan)
    assert.equal(summary.kind, 'domain')
    assert.equal(summary.domain.runtimeId, 'rt-stack-domain-stack')

    // kind 缺省 + 有 domain 段 → 推断 domain
    const inferredFile = path.join(dir, 'stack-inferred.json')
    await writeJson(inferredFile, {
      name: 'domain-inferred',
      stateDir: './state',
      domain: { source: './domain' },
    })
    const inferred = loadStack(inferredFile)
    assert.equal(inferred.kind, 'domain')
    assert.equal(validateStack(inferred).ok, true)
    assert.equal(compileStack(inferred).kind, 'domain')

    assert.throws(() => applyStack(stack), /dshd/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('domain 型 stack：缺 domain.source 报错，且不要求 home/profile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-stack-domain-bad-'))
  try {
    const stackFile = path.join(dir, 'stack.json')
    await writeJson(stackFile, { kind: 'domain', name: 'bad' })
    const result = validateStack(loadStack(stackFile))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('domain 型 stack 必须有 domain 对象')))
    assert.ok(!result.errors.some((error) => error.includes('home 必填')))
    assert.ok(!result.errors.some((error) => error.includes('profile 必填')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
