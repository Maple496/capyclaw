/**
 * PPT 套件的标准件对账：manifest、组合、生成 patch、子包路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  composeSuites, loadSuiteManifest, renderCordisPatch, validateSuiteManifest,
} from 'dsh-suite-kit'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SUITE = join(ROOT, 'plugin', 'capyclaw-ppt-suite')
const loaded = loadSuiteManifest(SUITE)

test('dsh-suite.json 通过标准件校验', () => {
  const result = validateSuiteManifest(loaded.manifest)
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('组合结果与 cordis.patch.yml 一致', () => {
  const composed = composeSuites([loaded])
  assert.equal(composed.ok, true, composed.errors.join('\n'))
  const expected = renderCordisPatch(composed.rows)
  const actual = readFileSync(join(SUITE, 'cordis.patch.yml'), 'utf8')
  assert.equal(actual, expected)
})

test('子包路径存在且 row 覆盖公共插件 / workbench / skills / mcp', () => {
  for (const [name, entry] of Object.entries(loaded.manifest.packages)) {
    if (!entry.path) continue
    assert.ok(existsSync(join(SUITE, entry.path, 'package.json')), `${name} 路径不存在`)
  }
  const ids = loaded.manifest.rows.map((row) => row.id)
  assert.deepEqual(ids.sort(), [
    'asset-service',
    'editor-host',
    'mcp-ppt',
    'ppt-skill-api',
    'ppt-skill-authoring',
    'ppt-skill-design',
    'ppt-skill-editing',
    'ppt-skill-narrative',
    'ppt-skill-ppt',
    'ppt-skill-research',
    'ppt-skill-visual-check',
    'service-host',
    'tool-host',
  ])
})

test('能力声明覆盖工具、端口、技能', () => {
  const workbench = loaded.manifest.packages['dsh-ppt-workbench']
  assert.deepEqual(workbench.provides.ports, [39311])
  assert.ok(workbench.provides.tools.includes('ppt_*'))
  const skillNames = ['ppt', 'pptmaster-narrative', 'pptmaster-design', 'pptist-api', 'pptist-authoring', 'pptist-editing', 'pptist-visual-check', 'pptist-research']
  const provided = []
  for (const [name, entry] of Object.entries(loaded.manifest.packages)) {
    if (entry.role !== 'skills') continue
    assert.equal(entry.provides.skills.length, 1, `${name} 应只提供一个 skill`)
    provided.push(...entry.provides.skills)
  }
  assert.deepEqual(provided.sort(), skillNames.sort())
})
