import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildActivationRegistry, composeSuites, loadSuiteManifest, resolveDomain,
  writeActivationRegistry,
} from '../src/index.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function writeSuite(dir, manifest, services) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'dsh-suite.json'), JSON.stringify(manifest, null, 2))
  if (services) fs.writeFileSync(path.join(dir, 'services.json'), JSON.stringify({ services }, null, 2))
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-activation-'))
  /* 基建：有 row 的 provider 套件 */
  const host = path.join(root, 'host-suite')
  writeSuite(host, {
    name: 'host-suite', version: '1.0.0',
    packages: { 'demo-host': { role: 'runtime', version: '^1.0.0', path: './demo-host', provides: { capabilities: { 'demo.host': '1.0.0' } } } },
    rows: [{ id: 'demo-host-row', name: 'demo-host' }],
  })
  /* 功能套件：workbench 无 row（纯服务进程）+ skill 有 row + 外部包行 */
  const feature = path.join(root, 'feature-suite')
  writeSuite(feature, {
    name: 'feature-suite', version: '2.0.0', title: '演示功能',
    packages: {
      'demo-workbench': {
        role: 'runtime', version: '^2.0.0', path: './demo-workbench',
        requires: { capabilities: { 'demo.host': '^1.0.0' } },
        provides: { capabilities: { 'demo.runtime': '2.0.0' } },
      },
      'demo-skill': {
        role: 'skills', version: '^2.0.0', path: './demo-skill',
        requires: { capabilities: { 'demo.runtime': '^2.0.0' } },
      },
      'demo-kit': { role: 'support', version: '^0.1.0', path: './demo-kit' },
    },
    rows: [
      { id: 'mcp-demo', name: '@deepseek-ai/dsh-mcp-client', config: { url: 'http://127.0.0.1:39000/mcp' } },
      { id: 'demo-skill-row', name: 'demo-skill' },
    ],
  }, [
    {
      id: 'demo-workbench',
      cmd: ['node', '${PACKAGE_DIR}/node_modules/demo-workbench/server.mjs', '--port', '${PORT}'],
      ports: { main: 39000 }, url: 'http://127.0.0.1:${PORT}', keepAlive: true, portFrom: 'content', dirFrom: 'contentState',
    },
    {
      id: 'orphan-service',
      cmd: ['node', '${PACKAGE_DIR}/scripts/standalone.mjs'],
      ports: { main: 39001 }, url: 'http://127.0.0.1:${PORT}',
    },
  ])
  /* 包目录占位（路径存在性不影响组合校验，但保持真实） */
  for (const name of ['demo-host', 'demo-workbench', 'demo-skill', 'demo-kit']) {
    fs.mkdirSync(path.join(feature, name), { recursive: true })
  }
  fs.mkdirSync(path.join(host, 'demo-host'), { recursive: true })
  return { root, host, feature }
}

function composed() {
  const { host, feature } = fixture()
  const suites = [loadSuiteManifest(host), loadSuiteManifest(feature)]
  const composedResult = composeSuites(suites)
  assert.equal(composedResult.ok, true, composedResult.errors.join('\n'))
  return { suites, composed: composedResult }
}

test('activation-registry: 包/套件/聚合三层 capability 与归属规则', () => {
  const { suites, composed: result } = composed()
  const { registry, warnings } = buildActivationRegistry({ suites, composed: result })
  const caps = registry.capabilities

  /* 基建包：有 row */
  assert.deepEqual(caps['demo-host'].entries, [{ entryId: 'include:demo-host-row', enabled: true }])
  assert.equal(caps['demo-host'].requires.length, 0)

  /* workbench：无 row 但被 skill required + 拥有服务进程 → 必须成 capability */
  assert.ok(caps['demo-workbench'], '被 required 的无 row 包必须成为 capability')
  assert.deepEqual(caps['demo-workbench'].entries, [])
  assert.deepEqual(caps['demo-workbench'].requires, ['demo-host'])
  assert.equal(caps['demo-workbench'].services.length, 1)
  assert.equal(caps['demo-workbench'].services[0].id, 'demo-workbench')
  /* ${PACKAGE_DIR} 展开为包目录绝对路径；portFrom/dirFrom 剥除 */
  assert.ok(caps['demo-workbench'].services[0].cmd[1].includes('demo-workbench/server.mjs'))
  assert.ok(path.isAbsolute(caps['demo-workbench'].services[0].cmd[1]))
  assert.equal(caps['demo-workbench'].services[0].portFrom, undefined)
  assert.equal(caps['demo-workbench'].services[0].dirFrom, undefined)

  /* skill：requires 指向 workbench（provider 包名解析） */
  assert.deepEqual(caps['demo-skill'].requires, ['demo-workbench'])
  assert.deepEqual(caps['demo-skill'].entries, [{ entryId: 'include:demo-skill-row', enabled: true }])

  /* 纯 support 包不成 capability */
  assert.equal(caps['demo-kit'], undefined)

  /* 套件聚合：bundle 开关 + 外部行 + 无主服务 */
  assert.deepEqual(caps['feature-suite'].bundles, [{ name: 'feature-suite', enabled: true }])
  assert.deepEqual(caps['feature-suite'].entries, [{ entryId: 'include:mcp-demo', enabled: true }])
  assert.equal(caps['feature-suite'].services.length, 1)
  assert.equal(caps['feature-suite'].services[0].id, 'orphan-service')
  assert.ok(caps['feature-suite'].requires.includes('demo-workbench'))
  assert.ok(caps['feature-suite'].requires.includes('demo-skill'))

  /* 外部行有告警，不静默 */
  assert.ok(warnings.some((w) => w.includes('mcp-demo')))

  /* 版本字段 */
  assert.equal(registry.version, 1)
})

test('activation-registry: 写入 profile 并可被 launch-engine 归一化读取', async () => {
  const { suites, composed: result } = composed()
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  const written = writeActivationRegistry(profileDir, { suites, composed: result })
  assert.equal(written.file, path.join(profileDir, 'launch-engine.registry.json'))
  assert.ok(fs.existsSync(written.file))
  assert.ok(written.capabilities.includes('demo-workbench'))

  /* 用 launch-engine 的 normalizeRegistry 校验生成的注册表合法（同构消费） */
  const { normalizeRegistry } = await import(
    pathToFileURL(path.join(REPO, 'extensions/official/capyclaw-launch-engine/lib/registry.mjs')).href
  )
  const normalized = normalizeRegistry(JSON.parse(fs.readFileSync(written.file, 'utf8')))
  assert.equal(normalized.version, 1)
  assert.ok(normalized.capabilities['demo-workbench'])
  assert.equal(normalized.capabilities['feature-suite'].title, '演示功能')
})

test('activation-registry: 真实 ppt 域生成的注册表依赖图完整', () => {
  const domainDir = path.join(REPO, 'extensions/bridges/ppt-bridge/domains/ppt')
  if (!fs.existsSync(domainDir)) return
  const resolved = resolveDomain(domainDir)
  const { registry } = buildActivationRegistry({
    suites: resolved.suites,
    composed: resolved.composed,
    requiredCapabilities: resolved.manifest.runtime?.requires?.capabilities || [],
  })
  const caps = registry.capabilities
  const names = Object.keys(caps)
  /* workbench（服务进程形态）+ 8 skill + 基建 + 套件聚合都在；
   * 包名正处于 dsh-* → @capyclaw/* 改名期，按后缀匹配保持健壮 */
  const workbench = names.find((n) => n.endsWith('/ppt-workbench') || n === 'dsh-ppt-workbench')
  assert.ok(workbench, `缺少 workbench capability（现有: ${names.join(', ')}）`)
  for (const skill of ['api', 'authoring', 'design', 'editing', 'narrative', 'ppt', 'research', 'visual-check']) {
    const name = names.find((n) => n.endsWith(`ppt-skill-${skill}`))
    assert.ok(name, `缺少 skill capability: *ppt-skill-${skill}`)
    assert.ok(caps[name].requires.includes(workbench), `${name} 应依赖 workbench`)
  }
  assert.ok(names.includes('capyclaw-ppt-suite'))
  assert.ok(caps['capyclaw-ppt-suite'].bundles.length === 1)
  /* 依赖闭包可解析（launch-engine 语义：无断链） */
  for (const cap of Object.values(caps)) {
    for (const dep of cap.requires) assert.ok(caps[dep], `断链: ${cap.name} → ${dep}`)
  }
})
