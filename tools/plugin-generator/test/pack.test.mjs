import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packPlugin, stagePlugin, validateManifests } from '../lib/pack.mjs'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-'))
  const plugin = path.join(dir, 'plugin')
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(plugin, 'server'), { recursive: true })
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'dsh-pack-fixture',
    version: '1.2.3',
    main: './lib/host.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['lib/', 'server/', 'cordis.patch.yml', '!server/secret.txt'],
  }, null, 2))
  fs.writeFileSync(path.join(plugin, 'lib', 'host.mjs'), 'export function apply() {}\n')
  fs.writeFileSync(path.join(plugin, 'server', 'secret.txt'), 'do not pack')
  fs.writeFileSync(path.join(plugin, 'server', 'ok.txt'), 'ok')
  fs.writeFileSync(path.join(plugin, 'cordis.patch.yml'), '- insert: []\n')
  fs.writeFileSync(path.join(plugin, 'README.md'), '# fixture\n')
  return { dir, plugin }
}

test('stagePlugin 始终包含 package.json 并应用排除项', () => {
  const { dir, plugin } = fixture()
  try {
    const staged = path.join(dir, 'staged')
    const result = stagePlugin({ srcDir: plugin, destDir: staged })
    assert.ok(result.files.includes('package.json'))
    assert.ok(result.files.includes('lib/host.mjs'))
    assert.ok(result.files.includes('server/ok.txt'))
    assert.ok(!result.files.includes('server/secret.txt'))
    assert.ok(fs.existsSync(path.join(staged, 'package.json')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('packPlugin 生成可解析 ZIP 且包含 package.json', () => {
  const { dir, plugin } = fixture()
  try {
    const result = packPlugin({ srcDir: plugin, outDir: path.join(dir, 'dist') })
    assert.match(result.outFile, /dsh-pack-fixture-v1\.2\.3\.zip$/)
    assert.ok(result.entries.includes('package.json'))
    assert.ok(result.entries.includes('lib/host.mjs'))
    assert.ok(!result.entries.includes('server/secret.txt'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** 带 suite manifest 的插件 fixture。 */
function suiteFixture(suiteManifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-suite-'))
  const plugin = path.join(dir, 'suite')
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'dsh-fixture-suite',
    version: '1.0.0',
    main: './lib/index.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' }, suite: './dsh-suite.json' },
    files: ['lib/', 'dsh-suite.json', 'cordis.patch.yml'],
  }, null, 2))
  fs.writeFileSync(path.join(plugin, 'lib', 'index.mjs'), 'export const name = 1\n')
  fs.writeFileSync(path.join(plugin, 'cordis.patch.yml'), '- insert: []\n')
  fs.writeFileSync(path.join(plugin, 'dsh-suite.json'), JSON.stringify(suiteManifest, null, 2))
  return { dir, plugin }
}

const VALID_SUITE = {
  name: 'dsh-fixture-suite',
  version: '1.0.0',
  title: 'fixture 套件',
  packages: {
    'dsh-fixture-plugin': {
      role: 'runtime',
      version: '^1.0.0',
      path: '../dsh-fixture-plugin',
      provides: { tools: ['fixture_echo'], services: ['fixture-service'], ports: [39311] },
    },
  },
  rows: [
    { id: 'fixture-host', name: 'dsh-fixture-plugin', config: { port: '${ports.content}' } },
  ],
}

test('合法 suite manifest 打包成功且 warnings 透出', () => {
  const { dir, plugin } = suiteFixture(VALID_SUITE)
  try {
    const result = packPlugin({ srcDir: plugin, outDir: path.join(dir, 'dist') })
    assert.ok(result.entries.includes('dsh-suite.json'))
    assert.deepEqual(result.warnings, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('坏 suite manifest（非法 role + 重复端口 + 坏 row id）打包被拦', () => {
  const bad = {
    ...VALID_SUITE,
    packages: {
      'dsh-fixture-plugin': {
        role: 'not-a-role',
        version: '^1.0.0',
        path: '../dsh-fixture-plugin',
        provides: { ports: [39311, 39311] },
      },
    },
    rows: [{ id: 'Bad_Row_Id', name: 'dsh-fixture-plugin' }],
  }
  const { dir, plugin } = suiteFixture(bad)
  try {
    assert.throws(
      () => packPlugin({ srcDir: plugin, outDir: path.join(dir, 'dist') }),
      (error) => /manifest 语义校验/.test(error.message)
        && /role 非法/.test(error.message)
        && /ports 重复/.test(error.message)
        && /row\.id 非法/.test(error.message),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('validateManifests 校验 staged 目录里的 dsh-domain.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-domain-'))
  try {
    fs.writeFileSync(path.join(dir, 'dsh-domain.json'), JSON.stringify({
      name: 'Bad_Domain', version: 'nope', components: [],
    }))
    const pkg = {}
    const { errors, warnings } = validateManifests(dir, pkg)
    assert.ok(errors.some((message) => /name 必须是 kebab-case/.test(message)), errors.join())
    assert.ok(errors.some((message) => /version 必须是 semver/.test(message)), errors.join())
    assert.ok(errors.some((message) => /components 必须是非空数组/.test(message)), errors.join())
    assert.deepEqual(warnings, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rows 引用 packages 外的包（如官方 mcp-client）时透出 warning 且不拦打包', () => {
  const manifest = {
    ...VALID_SUITE,
    rows: [
      ...VALID_SUITE.rows,
      { id: 'mcp-client', name: '@deepseek-ai/dsh-mcp-client', config: { url: 'http://127.0.0.1:39311/mcp' } },
    ],
  }
  const { dir, plugin } = suiteFixture(manifest)
  try {
    const result = packPlugin({ srcDir: plugin, outDir: path.join(dir, 'dist') })
    assert.ok(result.warnings.some((message) => /引用外部包/.test(message)), result.warnings.join())
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
