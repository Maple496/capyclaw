/** 单测：规格规范化 / 占位符展开 / discovery 读写。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  normalizeSpec, specHash, expandVars, expandSpec, pidAlive,
} from '../lib/engine.mjs'
import { loadDiscovery, saveDiscovery } from '../lib/discovery.mjs'

test('normalizeSpec：缺省值与校验', () => {
  const spec = normalizeSpec({ id: 'demo', cmd: ['node', 'x.mjs'] })
  assert.equal(spec.keepAlive, true)
  assert.equal(spec.healthPath, '/healthz')
  assert.deepEqual(spec.requires, [])
  assert.throws(() => normalizeSpec({ cmd: ['node'] }), /id/)
  assert.throws(() => normalizeSpec({ id: 'demo', cmd: 'node x' }), /cmd/)
  assert.throws(() => normalizeSpec({ id: 'demo', cmd: ['node'], requires: 'x' }), /requires/)
})

test('specHash：同规格稳定、异规格不同', () => {
  const a = normalizeSpec({ id: 'demo', cmd: ['node', 'x.mjs'], ports: { main: 1 } })
  const b = normalizeSpec({ id: 'demo', cmd: ['node', 'x.mjs'], ports: { main: 1 } })
  const c = normalizeSpec({ id: 'demo', cmd: ['node', 'y.mjs'], ports: { main: 1 } })
  assert.equal(specHash(a), specHash(b))
  assert.notEqual(specHash(a), specHash(c))
})

test('expandVars：命中替换、缺失降级为空串', () => {
  const ctx = { PORT: '39311', HOME_X: '/x' }
  assert.equal(expandVars('http://127.0.0.1:${PORT}/', ctx), 'http://127.0.0.1:39311/')
  assert.equal(expandVars('${MISSING_VAR}/x', ctx), '/x')
  assert.equal(expandVars('${HOME_X}/${PORT}', ctx), '/x/39311')
})

test('expandSpec：cmd/env/url/cwd 全展开', () => {
  const out = expandSpec({
    id: 'demo',
    cmd: ['node', 's.mjs', '--port', '${PORT}'],
    env: { A: '${PORT}' },
    url: 'http://127.0.0.1:${PORT}/',
    cwd: '${CWD_X}',
  }, { PORT: '1234', CWD_X: '/c' })
  assert.deepEqual(out.cmd, ['node', 's.mjs', '--port', '1234'])
  assert.deepEqual(out.env, { A: '1234' })
  assert.equal(out.url, 'http://127.0.0.1:1234/')
  assert.equal(out.cwd, '/c')
})

test('pidAlive：非法/不存活 pid 返回 false', () => {
  assert.equal(pidAlive(null), false)
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive(-1), false)
})

test('discovery：写读回环 + 损坏降级为 null', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-broker-test-'))
  const file = path.join(dir, 'services.json')
  await saveDiscovery(file, { version: 1, services: { a: { id: 'a', state: 'running' } } })
  const reg = await loadDiscovery(file)
  assert.equal(reg.services.a.id, 'a')
  await saveDiscovery(path.join(dir, 'broken.json'), { version: 1 })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path.join(dir, 'broken2.json'), '{oops', 'utf8')
  assert.equal(await loadDiscovery(path.join(dir, 'broken2.json')), null)
})

/** 服务 spec 统一校验（service.schema.json 的代码面，两个 runtime 工件共用）。 */
import { validateServiceManifest, validateServiceSpec } from '../lib/spec.mjs'
import { loadManifest } from '../lib/manifest.mjs'

test('spec 校验：合法 spec（含 suite 物化提示字段）通过，重复 id 报错', () => {
  const errors = validateServiceManifest([
    { id: 'ppt-workbench', cmd: ['node', 'server/relay.mjs', '--port', '${PORT}'], ports: { main: 39311 }, keepAlive: true, portFrom: 'content', dirFrom: 'contentState' },
    { id: 'dsh-skills', cmd: ['node', 'server.mjs'], ports: { main: 'auto' }, env: { A: 'b' }, requires: [] },
  ])
  assert.deepEqual(errors, [])
  assert.deepEqual(validateServiceManifest([
    { id: 'a', cmd: ['node', 'x.mjs'] },
    { id: 'a', cmd: ['node', 'y.mjs'] },
  ]).filter((e) => e.includes('重复')), ['manifest: 重复的服务 id a'])
})

test('spec 校验：结构错误逐项列出（id/cmd/ports/env/keepAlive/portFrom）', () => {
  const errors = validateServiceSpec({ id: 'bad id!', cmd: [], ports: { main: 0 }, env: { A: 1 }, keepAlive: 'yes', portFrom: 'nope' })
  assert.ok(errors.some((e) => e.includes('id')))
  assert.ok(errors.some((e) => e.includes('cmd')))
  assert.ok(errors.some((e) => e.includes('ports.main')))
  assert.ok(errors.some((e) => e.includes('env')))
  assert.ok(errors.some((e) => e.includes('keepAlive')))
  assert.ok(errors.some((e) => e.includes('portFrom')))
  assert.deepEqual(validateServiceSpec('x'), ['service 必须是对象'])
})

test('loadManifest：非法 spec 在装载期诚实拒绝', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-broker-spec-'))
  const file = path.join(dir, 'bad-services.json')
  writeFileSync(file, JSON.stringify({ services: [{ id: 'x', cmd: [] }] }), 'utf8')
  assert.throws(() => loadManifest(file), /服务 spec 非法/)
})
