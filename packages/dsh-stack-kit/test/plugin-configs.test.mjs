import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

import { applyStack, planStack } from '../src/index.mjs'
import { deepMerge, buildConfigPatches } from '../src/plugin-config.mjs'
import { renderManagedBlock, readManagedBlock, parseManagedBlock, writeManagedBlock } from '../src/patch-block.mjs'

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 造一个带默认 config 的插件包 + 一份 stack。 */
async function fixture({ patchBody, configs, port = 39700 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-cfg-'))
  const pluginDir = path.join(dir, 'plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeJson(path.join(pluginDir, 'package.json'), {
    name: '@demo/plugin',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeFile(
    path.join(pluginDir, 'cordis.patch.yml'),
    patchBody ?? [
      '- insert:',
      '    - id: demo-host',
      '      name: "@demo/plugin"',
      '      config:',
      '        port: 39000',
      '        host: 127.0.0.1',
      '        nested:',
      '          a: 1',
      '          b: 2',
      '',
    ].join('\n'),
  )
  const stackFile = path.join(dir, 'dsh-stack.json')
  await writeJson(stackFile, {
    name: 'cfg',
    home: path.join(dir, 'home'),
    profile: 'web',
    stateDir: path.join(dir, 'state'),
    plugins: {
      install: false,
      bundles: [{ name: '@demo/plugin', path: pluginDir }],
      configs,
    },
    services: [],
  })
  return { dir, pluginDir, stackFile, profilePatch: path.join(dir, 'home', 'profiles', 'web', 'cordis.patch.yml') }
}

test('deepMerge：对象递归、数组与标量整体替换', () => {
  assert.deepEqual(
    deepMerge({ a: 1, nested: { x: 1, y: 2 }, list: [1, 2] }, { nested: { y: 9 }, list: [3] }),
    { a: 1, nested: { x: 1, y: 9 }, list: [3] },
  )
  assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 })
})

test('受管区块：渲染 → 解析 往返一致', () => {
  const rows = [{ id: 'demo-host', name: '@demo/plugin', config: { port: 39700 } }]
  const block = renderManagedBlock(rows)
  assert.match(block, /# >>> dshd:managed/)
  assert.match(block, /# <<< dshd:managed/)
  assert.deepEqual(parseManagedBlock(readManagedBlock(block)), rows)
})

test('受管区块：保留用户自己写的行', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-patch-'))
  const file = path.join(dir, 'cordis.patch.yml')
  await writeFile(file, '# 用户手写\n- id: user-row\n  config:\n    keep: true\n')
  const r1 = writeManagedBlock(file, [{ id: 'demo-host', name: '@demo/plugin', config: { port: 1 } }])
  assert.equal(r1.changed, true)
  const text1 = await readFile(file, 'utf8')
  assert.match(text1, /用户手写/)
  assert.match(text1, /demo-host/)

  // 二次写不同内容：用户的段落必须还在，受管区块被替换而不是叠加
  writeManagedBlock(file, [{ id: 'demo-host', name: '@demo/plugin', config: { port: 2 } }])
  const text2 = await readFile(file, 'utf8')
  assert.match(text2, /用户手写/)
  assert.equal((text2.match(/# >>> dshd:managed/g) || []).length, 1)
  assert.match(text2, /port: 2/)
  assert.doesNotMatch(text2, /port: 1/)

  // 幂等：同样的内容再写一次，不产生变化
  const r3 = writeManagedBlock(file, [{ id: 'demo-host', name: '@demo/plugin', config: { port: 2 } }])
  assert.equal(r3.changed, false)
})

test('buildConfigPatches：深合并插件默认 config', async () => {
  const f = await fixture({ configs: [] })
  const { rows, details } = buildConfigPatches({
    configs: [{ name: '@demo/plugin', config: { port: 39700, nested: { b: 9 } } }],
    resolveBundle: () => ({ dir: f.pluginDir, kind: 'link' }),
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'demo-host')
  assert.deepEqual(rows[0].config, { port: 39700, host: '127.0.0.1', nested: { a: 1, b: 9 } })
  assert.equal(details[0].row, 'demo-host')
})

test('buildConfigPatches：row 不存在时明确报错，不静默', async () => {
  const f = await fixture({ configs: [] })
  assert.throws(
    () => buildConfigPatches({
      configs: [{ name: '@demo/plugin', row: 'nope', config: { port: 1 } }],
      resolveBundle: () => ({ dir: f.pluginDir, kind: 'link' }),
    }),
    /找不到 row "nope"/,
  )
})

test('buildConfigPatches：多行 patch 未指定 row 时报错并列出可选行', async () => {
  const f = await fixture({
    patchBody: '- insert:\n    - id: a\n      name: A\n    - id: b\n      name: B\n',
    configs: [],
  })
  assert.throws(
    () => buildConfigPatches({
      configs: [{ name: '@demo/plugin', config: { port: 1 } }],
      resolveBundle: () => ({ dir: f.pluginDir, kind: 'link' }),
    }),
    /有多个可配置行（a, b）/,
  )
})

test('applyStack：写入受管区块，且 plan 能看见配置行', async () => {
  const f = await fixture({ configs: [{ name: '@demo/plugin', config: { port: 39700 } }] })
  const { loadStack } = await import('../src/index.mjs')
  const stack = loadStack(f.stackFile)

  const plan = planStack(stack)
  assert.equal(plan.valid, true)
  assert.equal(plan.changes.pluginConfigs.rows.length, 1)
  assert.deepEqual(plan.changes.pluginConfigs.rows[0].config, { port: 39700, host: '127.0.0.1', nested: { a: 1, b: 2 } })

  applyStack(stack, { install: false })
  const text = await readFile(f.profilePatch, 'utf8')
  const rows = parseManagedBlock(readManagedBlock(text))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'demo-host')
  assert.equal(rows[0].config.port, 39700)
  // 默认值没有丢
  assert.equal(rows[0].config.host, '127.0.0.1')
  assert.deepEqual(rows[0].config.nested, { a: 1, b: 2 })
})

test('applyStack：${ports.broker} 在 config 里被展开', async () => {
  const f = await fixture({ configs: [{ name: '@demo/plugin', config: { url: 'http://127.0.0.1:${ports.broker}/' } }] })
  const { loadStack } = await import('../src/index.mjs')
  const stack = loadStack(f.stackFile)
  stack.ports = { ...(stack.ports || {}), broker: 41234 }
  applyStack(stack, { install: false })
  const text = await readFile(f.profilePatch, 'utf8')
  const rows = parseManagedBlock(readManagedBlock(text))
  assert.match(rows[0].config.url, /41234/)
  assert.doesNotMatch(rows[0].config.url, /\$\{ports\./)
})
