/**
 * 发布引擎纯逻辑单测（无网络、无 npm 调用）。
 * publisher_execute 发布本包自身时会跑这份测试（dogfood）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  publishGateErrors, libraryGateErrors, packGateErrors, orderGate, resolveRoot,
  scanDirForSecrets, DEFAULT_SUPPORT_LIBS, FAILURE_STATUSES,
} from '../server/impl.mjs'

const basePkg = {
  name: '@capyclaw/x',
  version: '0.1.0',
  private: false,
  publishConfig: { access: 'public' },
  engines: { dsh: '^0.2.0-rc.2' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-test-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('publishGateErrors：合格的插件包零错误', () => withTempDir((dir) => {
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert: []\n')
  assert.deepEqual(publishGateErrors(basePkg, dir), [])
}))

test('publishGateErrors：private/缺 access/缺 engines.dsh/patch 缺文件逐一报错', () => withTempDir((dir) => {
  const errors = publishGateErrors(
    { ...basePkg, private: true, publishConfig: undefined, engines: {}, dsh: { bundle: { patch: './nope.yml' } } },
    dir,
  )
  assert.ok(errors.some((e) => e.includes('private')))
  assert.ok(errors.some((e) => e.includes('publishConfig.access')))
  assert.ok(errors.some((e) => e.includes('engines.dsh')))
  assert.ok(errors.some((e) => e.includes('不存在')))
}))

test('publishGateErrors：link:/file: 依赖被拦', () => withTempDir((dir) => {
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '')
  const errors = publishGateErrors(
    { ...basePkg, dependencies: { '@capyclaw/plugin-kit': 'link:../../packages/capyclaw-plugin-kit' } },
    dir,
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0], /link:/)
}))

test('libraryGateErrors：缺 license/version 与 link: 依赖', () => {
  const errors = libraryGateErrors({ name: '@capyclaw/lib', version: '', optionalDependencies: { foo: 'file:./x' } })
  assert.ok(errors.some((e) => e.includes('license')))
  assert.ok(errors.some((e) => e.includes('version')))
  assert.ok(errors.some((e) => e.includes('file:')))
})

test('packGateErrors：必需文件不在 npm pack 清单里时报错', () => withTempDir((dir) => {
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '')
  const npm = {
    rawNpmRun: () => ({
      status: 0,
      stdout: JSON.stringify([{ files: [{ path: 'package.json' }, { path: 'server/relay.mjs' }] }]),
    }),
  }
  const errors = packGateErrors({ ...basePkg, main: './lib/host.mjs' }, dir, npm)
  /* 假 npm 的第二次 pack 调用产不出真 tarball，解包失败按「无法扫描」降级报告 */
  assert.deepEqual(errors, [
    '分发必需文件未进包: lib/host.mjs',
    '分发必需文件未进包: cordis.patch.yml',
    'tarball 解包失败（无法做密钥扫描）',
  ])
}))

test('scanDirForSecrets：凭据/本机路径形态逐一识别，干净目录零命中', () => withTempDir((dir) => {
  fs.writeFileSync(path.join(dir, 'clean.mjs'), 'export const x = 1\n')
  assert.deepEqual(scanDirForSecrets(dir), [])

  fs.writeFileSync(path.join(dir, 'leak.txt'), [
    'key = sk-abcdefghijklmnopqrstuvwx',
    'token = npm_abcdefghijklmnopqrst',
    '//registry.npmjs.org/:_authToken=zzz',
    'path = C:\\Users\\bob\\secret',
    'home = /home/alice/x',
  ].join('\n'))
  const hits = scanDirForSecrets(dir)
  assert.equal(hits.length, 5)
  assert.ok(hits.every((h) => h.startsWith('leak.txt: ')), hits.join('|'))
}))

test('orderGate：依赖不可解析且不在批次 → 拦截；同批 → 警告放行', () => {
  const pkg = { name: '@capyclaw/a', dependencies: { '@capyclaw/dep': '^1.0.0' } }
  const npmView = () => ({ status: 1 }) /* registry 不可解析 */
  const blocked = orderGate(pkg, new Map(), new Set(), { npmView })
  assert.equal(blocked.errors.length, 1)
  assert.match(blocked.errors[0], /404\/ETARGET/)
  const sameBatch = orderGate(pkg, new Map(), new Set(['@capyclaw/dep']), { npmView })
  assert.deepEqual(sameBatch.errors, [])
  assert.equal(sameBatch.warnings.length, 1)
})

test('orderGate：闭包沿本地包继续展开（传递依赖也要可解析）', () => {
  const localMap = new Map([
    ['@capyclaw/dep', { pkg: { name: '@capyclaw/dep', dependencies: { '@capyclaw/deep': '^0.1.0' } } }],
  ])
  const npmView = (spec) => ({ status: spec.startsWith('@capyclaw/dep@') ? 0 : 1 })
  const { errors } = orderGate(
    { name: '@capyclaw/a', dependencies: { '@capyclaw/dep': '^1.0.0' } }, localMap, new Set(), { npmView },
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0], /@capyclaw\/deep/)
})

test('resolveRoot：缺 root 与非工作区路径给出明确错误', () => {
  const prev = process.env.DSH_PUBLISHER_ROOT
  delete process.env.DSH_PUBLISHER_ROOT
  assert.match(resolveRoot(undefined).error, /DSH_PUBLISHER_ROOT/)
  assert.match(resolveRoot(os.tmpdir()).error, /不是插件工程工作区/)
  process.env.DSH_PUBLISHER_ROOT = prev
})

test('默认支撑库与失败状态集完整', () => {
  assert.equal(DEFAULT_SUPPORT_LIBS.length, 4)
  assert.ok(FAILURE_STATUSES.includes('version-drift'))
  assert.ok(FAILURE_STATUSES.includes('order-blocked'))
  assert.ok(!FAILURE_STATUSES.includes('skipped-exists'))
})
