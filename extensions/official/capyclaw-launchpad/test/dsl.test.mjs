import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parseDsl, replacePluginsBlock, validateDsl } from '../lib/dsl.mjs'

function devDsl() {
  return [
    '# dev launchpad',
    'stack "dev" {',
    '  kind "profile"',
    '  home "../.dshd/home"',
    '  profile "web"',
    '  workspace "../apps/harness/deepseek-harness/workspace"',
    '  stateDir "../.dshd/dev-state"',
    '  ports { broker 13593 proxy 13594 upstream 13595 }',
    '  plugins {',
    '    bundle "@deepseek-ai/dsh-base"',
    '    bundle "@deepseek-ai/dsh-web-app"',
    '    plugin "dsh-launchpad" { path "../extensions/official/dsh-launchpad" }',
    '    dependency "@capyclaw/plugin-kit" { path "../packages/@capyclaw/plugin-kit" }',
    '    install true',
    '  }',
    '  service "launchpad" {',
    '    path "../extensions/official/dsh-launchpad/server.mjs"',
    '    args ["--roots", "${STACK_DIR}/..", "--dsh-home", "${home}", "--broker-url", "http://127.0.0.1:${ports.broker}"]',
    '    port 13596',
    '    health "/healthz"',
    '    keepAlive true',
    '  }',
    '}',
    '',
  ].join('\n')
}

test('parseDsl/validateDsl：块、数组、注释、布尔值、路径与占位符', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dsl-'))
  try {
    const file = path.join(dir, 'launchpads', 'dev.stack')
    const result = validateDsl(devDsl(), file)
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.kind, 'profile')
    const stack = result.stack
    assert.equal(stack.name, 'dev')
    assert.equal(stack.home, path.join(dir, '.dshd', 'home'))
    assert.equal(stack.profile, 'web')
    assert.equal(stack.stateDir, path.join(dir, '.dshd', 'dev-state'))
    assert.deepEqual(stack.ports, { broker: 13593, proxy: 13594, upstream: 13595 })
    assert.equal(stack.plugins.install, true)
    assert.deepEqual(stack.plugins.bundles[0], '@deepseek-ai/dsh-base')
    assert.deepEqual(stack.plugins.bundles[1], '@deepseek-ai/dsh-web-app')
    assert.deepEqual(stack.plugins.bundles[2], {
      name: 'dsh-launchpad',
      path: path.join(dir, 'extensions', 'official', 'dsh-launchpad'),
    })
    assert.deepEqual(stack.plugins.dependencies, {
      '@capyclaw/plugin-kit': path.join(dir, 'packages', '@capyclaw/plugin-kit'),
    })
    assert.equal(stack.services.length, 1)
    const service = stack.services[0]
    assert.equal(service.id, 'launchpad')
    assert.equal(service.path, path.join(dir, 'extensions', 'official', 'dsh-launchpad', 'server.mjs'))
    assert.equal(service.ports.main, 13596)
    assert.equal(service.healthPath, '/healthz')
    assert.equal(service.keepAlive, true)
    assert.equal(service.args[1], path.join(dir, 'launchpads', '..'))
    assert.equal(service.args[3], '${home}')
    assert.equal(service.args[5], 'http://127.0.0.1:${ports.broker}')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseDsl 支持等号、单引号、嵌套 env 和多服务', async () => {
  const text = [
    "stack 'multi' {",
    '  kind = "profile"',
    '  home = "./home"',
    '  profile = "web"',
    '  stateDir "./state"',
    '  ports {',
    '    broker "auto"',
    '    proxy "auto"',
    '    upstream "auto"',
    '  }',
    '  plugins {',
    '    bundle "@deepseek-ai/dsh-base"',
    '    install false',
    '  }',
    '  service "a" {',
    '    cmd ["node", "a.mjs"]',
    '    ports { main "auto", extra 41001 }',
    '    env {',
    '      MODE "dev"',
    '      RETRIES "3"',
    '    }',
    '    requires ["b"]',
    '  }',
    '  service "b" {',
    '    cmd ["node", "b.mjs"]',
    '  }',
    '}',
  ].join('\n')
  const result = validateDsl(text, path.join(os.tmpdir(), 'multi.stack'))
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.stack.services.length, 2)
  assert.deepEqual(result.stack.services[0].cmd, ['node', 'a.mjs'])
  assert.deepEqual(result.stack.services[0].ports, { main: 'auto', extra: 41001 })
  assert.deepEqual(result.stack.services[0].env, { MODE: 'dev', RETRIES: '3' })
  assert.deepEqual(result.stack.services[0].requires, ['b'])
  assert.equal(result.stack.plugins.install, false)
})

test('validateDsl 对语法/重复 id/非法端口/未知 kind 给出错误', () => {
  {
    const result = validateDsl('stack "x" {\n  kind "profile"\n  home "./h"\n', 'x.stack')
    assert.equal(result.ok, false)
    assert.match(result.errors[0].message, /缺少|}"?/i)
  }
  {
    const result = validateDsl([
      'stack "x" {', '  kind "profile"', '  home "./h"',
      '  service "a" { cmd ["node","a.mjs"] }',
      '  service "a" { cmd ["node","b.mjs"] }',
      '}',
    ].join('\n'), 'x.stack')
    assert.equal(result.ok, false)
    assert.match(result.errors[0].message, /重复|id/)
  }
  {
    const result = validateDsl([
      'stack "x" {', '  kind "profile"', '  home "./h"',
      '  ports { broker 70000 }',
      '}',
    ].join('\n'), 'x.stack')
    assert.equal(result.ok, false)
    assert.match(result.errors[0].message, /70000|端口/)
  }
  {
    const result = validateDsl('stack "x" {\n  kind "domain"\n  home "./h"\n}', 'x.stack')
    assert.equal(result.ok, false)
    assert.match(result.errors[0].message, /domain 型需要 domain/)
  }
  {
    const result = validateDsl('stack "x" {\n  kind "bogus"\n}', 'x.stack')
    assert.equal(result.ok, false)
    assert.match(result.errors[0].message, /不支持的 kind/)
  }
})

test('parseDsl 顶层只能一个 stack 块', () => {
  assert.throws(() => parseDsl('stack "a" {}\nstack "b" {}', 'x.stack'), /只能有一个/)
})

test('domain 型 DSL：kind/domain 块、端口、env 与 source 路径', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dsl-domain-'))
  try {
    const domainDir = path.join(dir, 'domain')
    await mkdir(domainDir, { recursive: true })
    await writeFile(path.join(domainDir, 'dsh-domain.json'), JSON.stringify({ name: 'probe', version: '1.0.0', components: ['./suite'] }))
    const file = path.join(dir, 'launchpads', 'ppt.stack')
    const text = [
      'stack "ppt" {',
      '  kind "domain"',
      '  stateDir "../state"',
      '  ports { broker "auto" proxy 39100 upstream "auto" content 39311 }',
      '  domain {',
      '    source "../domain"',
      '    runtimeId "rt-ppt"',
      '    profile "domain-ppt"',
      '    recreate false',
      '    env { PPT_FLAG "1" }',
      '  }',
      '  env { TOP_FLAG "1" }',
      '}',
      '',
    ].join('\n')
    const result = validateDsl(text, file)
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.kind, 'domain')
    assert.equal(result.stack.kind, 'domain')
    assert.equal(result.stack.name, 'ppt')
    assert.equal(result.stack.domain.source, domainDir)
    assert.equal(result.stack.domain.runtimeId, 'rt-ppt')
    assert.equal(result.stack.profile, 'domain-ppt')
    assert.equal(result.stack.domain.recreate, false)
    assert.equal(result.stack.domain.env.PPT_FLAG, '1')
    assert.equal(result.stack.env.TOP_FLAG, '1')
    assert.deepEqual(result.stack.ports, { broker: 'auto', proxy: 39100, upstream: 'auto', content: 39311 })

    const missing = validateDsl('stack "bad" {\n  kind "domain"\n  domain { source "../nope" }\n}\n', file)
    assert.equal(missing.ok, false)
    assert.match(missing.errors[0].message, /domain\.source 不存在/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('replacePluginsBlock 只重写 plugins 块，保留块外注释与其它段', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dsl-replace-'))
  try {
    const file = path.join(dir, 'launchpads', 'dev.stack')
    const text = `# 顶部注释\n${devDsl()}# 尾部注释\n`
    const updated = replacePluginsBlock(text, {
      bundles: ['@deepseek-ai/dsh-base', { name: 'dsh-launchpad', path: path.join(dir, 'plugin') }],
      dependencies: { '@capyclaw/plugin-kit': path.join(dir, 'kit') },
      install: false,
    })
    assert.match(updated, /# 顶部注释/)
    assert.match(updated, /# 尾部注释/)
    assert.match(updated, /bundle "@deepseek-ai\/dsh-base"/)
    assert.match(updated, /plugin "dsh-launchpad"/)
    assert.match(updated, /dependency "@capyclaw\/plugin-kit"/)
    assert.match(updated, /install false/)
    assert.match(updated, /service "launchpad"/)
    const result = validateDsl(updated, file)
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.stack.plugins.install, false)
    assert.deepEqual(result.stack.plugins.bundles.map((bundle) => typeof bundle === 'string' ? bundle : bundle.name),
      ['@deepseek-ai/dsh-base', 'dsh-launchpad'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
