import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseWorksContent, parseWorksFile, validateWorksDeployment, validateWorksFormat, worksToDeploymentConfig,
} from '../lib/works-parser.mjs'

const VALID = `%%%WORKS-META%%%
{ "name": "x", "brief": "b", "view": { "kind": "deployment" }, "schema_version": "1.0.0" }

%%%WORKS-CODE%%%
{ "deployment": { "type": "domain", "source": "./dom" } }
`

test('parseWorksContent 解析双段格式（CODE 为 JSON）', () => {
  const { meta, code } = parseWorksContent(VALID)
  assert.equal(meta.name, 'x')
  assert.equal(code.deployment.type, 'domain')
})

test('parseWorksContent CODE 段非 JSON 时保留字符串', () => {
  const { code } = parseWorksContent('%%%WORKS-META%%%\n{"name":"x","brief":"b","view":{"kind":"note"}}\n\n%%%WORKS-CODE%%%\nplain text')
  assert.equal(code, 'plain text')
})

test('parseWorksContent 缺标记时明确报错', () => {
  assert.throws(() => parseWorksContent('{"name":"x"}'), /缺少 %%%WORKS-META%%% 标记/)
  assert.throws(() => parseWorksContent('%%%WORKS-META%%%\n{}'), /缺少 %%%WORKS-CODE%%% 标记/)
})

test('validateWorksFormat：META 必填 + schema_version 格式', () => {
  const { valid, errors } = validateWorksFormat({ name: 'x' }, {})
  assert.equal(valid, false)
  assert.ok(errors.some((e) => /META 缺少必需字段: brief/.test(e)))
  assert.ok(errors.some((e) => /META 缺少必需字段: view/.test(e)))

  const badVersion = validateWorksFormat({ name: 'x', brief: 'b', view: { kind: 'note' }, schema_version: '1.0' }, {})
  assert.ok(badVersion.errors.some((e) => /schema_version 格式错误/.test(e)))
})

test('部署类作品：validateWorksFormat 补齐 CODE 段语义校验', () => {
  // 缺 deployment → 拦
  const missing = validateWorksFormat({ name: 'x', brief: 'b', view: { kind: 'deployment' } }, {})
  assert.equal(missing.valid, false)
  assert.ok(missing.errors.some((e) => /CODE\.deployment 缺失/.test(e)), missing.errors.join())

  // 缺 deployment.source → 拦
  const noSource = validateWorksFormat(
    { name: 'x', brief: 'b', view: { kind: 'deployment' } },
    { deployment: { type: 'domain' } },
  )
  assert.equal(noSource.valid, false)
  assert.ok(noSource.errors.some((e) => /deployment\.source 必填/.test(e)))

  // runtime/launcher 非对象 → 拦
  const badRuntime = validateWorksFormat(
    { name: 'x', brief: 'b', view: { kind: 'deployment' } },
    { deployment: { type: 'domain', source: './dom' }, runtime: 'node' },
  )
  assert.ok(badRuntime.errors.some((e) => /CODE\.runtime 必须是对象/.test(e)))

  // 非法 type → 拦
  const badType = validateWorksFormat(
    { name: 'x', brief: 'b', view: { kind: 'deployment' } },
    { deployment: { type: 'k8s', source: './dom' } },
  )
  assert.ok(badType.errors.some((e) => /暂只支持 domain/.test(e)))

  // 合法 → 通过
  const ok = validateWorksFormat(
    { name: 'x', brief: 'b', view: { kind: 'deployment' }, schema_version: '1.0.0' },
    { deployment: { type: 'domain', source: './dom' }, runtime: {}, launcher: {} },
  )
  assert.equal(ok.valid, true, ok.errors.join())
})

test('非部署类作品不受 CODE 语义校验影响', () => {
  const ok = validateWorksFormat({ name: 'x', brief: 'b', view: { kind: 'workflow' } }, 'plain code')
  assert.equal(ok.valid, true)
})

test('validateWorksDeployment 独立导出（控制面复用）', () => {
  assert.equal(validateWorksDeployment('not object').valid, false)
  assert.equal(validateWorksDeployment({ deployment: { source: './d' } }).valid, true)
})

test('parseWorksFile + worksToDeploymentConfig 端到端（相对 source 解析）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'works-parser-'))
  try {
    const file = path.join(dir, 'a.works')
    fs.writeFileSync(file, VALID)
    const { meta } = parseWorksFile(file)
    assert.equal(meta.name, 'x')
    const config = worksToDeploymentConfig(file)
    assert.equal(config.version, '1.0.0')
    assert.equal(config.deployment.type, 'domain')
    assert.throws(() => worksToDeploymentConfig(path.join(dir, 'missing.works')), /文件不存在/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
