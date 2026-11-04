/**
 * 接缝测试（seam tests）：安装 → 部署 → 运行 三个环节的咬合面。
 *
 * 原则：环节之间只通过「工件 + 契约」衔接（.works 文件、domain manifest、
 * patch 行声明），不通过跨模块函数调用——每个环节可以独立实现/替换，
 * 只要守住契约就必然咬合。
 *
 * 接缝 S4：安装产物（.works）→ 部署配置（loadConfig + 部署语义校验）
 * 接缝 S5：部署配置（domain）→ 运行时行覆盖（bindings/removeRows 引用的行必须被声明）
 *
 * 生产→安装的接缝（S1-S3）由 plugin-development/test/chain.test.mjs 守卫。
 * 登录/平台接缝（S6/S7）由 dsh-llm-tempkey 的测试守卫（会话快照 / api·config 契约）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../bin/dsh-deploy.mjs'
import { auditRowCoverage, collectPatchRowIds } from '../lib/row-audit.mjs'
import { validateWorksDeployment } from '../lib/works-parser.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const PKG = path.resolve(REPO, 'packages', 'dsh-runtime-control')
const CATALOG_PKG = path.join(REPO, 'packages', 'dsh-catalog')
const INSTALLER_PKG = path.join(REPO, 'packages', 'dsh-installer')
const PPT_DOMAIN = path.join(REPO, 'extensions', 'bridges', 'ppt-bridge', 'domains', 'ppt', 'dsh-domain.json')

/** 可启动的 worker domain（三件套，与 runtime-control e2e 同款）。 */
function trioDomain(root, name = 'seam-worker') {
  const domain = {
    name,
    version: '1.0.0',
    title: 'Seam Worker',
    baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    components: [PKG, CATALOG_PKG, INSTALLER_PKG],
    profile: { name, port: 3080 },
    runtime: {
      driver: 'node',
      workId: 'main',
      requires: {
        services: ['runtimeControl', 'catalog', 'installer'],
        capabilities: ['runtime.control@^1.0.0', 'catalog.works@^1.0.0', 'installer.domain@^1.0.0'],
      },
      bindings: [{ row: 'runtime-control', config: { port: '${ports.content}' } }],
      scope: {
        sessions: { path: '.dsh/sessions', isolated: true },
        files: [{ id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] }],
        network: { bind: ['127.0.0.1'] },
        processes: { killTree: true },
      },
      ports: { harness: 0, dsh: 0, content: 0 },
      model: { id: 'llm-deepseek', plugin: '@deepseek-ai/dsh-llm-deepseek-api-key', apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrlEnv: 'DEEPSEEK_BASE_URL', baseURL: 'https://api.deepseek.com/anthropic' },
    },
  }
  const file = path.join(root, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(domain, null, 2) + '\n')
  return file
}

function worksFile(root, source) {
  const file = path.join(root, 'seam.works')
  fs.writeFileSync(file, `%%%WORKS-META%%%
{
  "name": "seam-deploy",
  "brief": "接缝测试：安装产物形态",
  "view": { "kind": "deployment" },
  "schema_version": "1.0.0"
}

%%%WORKS-CODE%%%
{
  "deployment": { "type": "domain", "source": ${JSON.stringify(source)}, "autoStart": true },
  "runtime": { "driver": "node", "workId": "main" }
}
`)
  return file
}

test('S4 接缝：安装产物 .works → 部署配置（loadConfig 通过，source 可解析且存在）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-s4-'))
  try {
    const domainPath = trioDomain(root)
    const works = worksFile(root, domainPath)
    const config = loadConfig(works)
    assert.equal(config.name, 'seam-deploy')
    assert.equal(config.deployment.type, 'domain')
    assert.ok(path.isAbsolute(config.deployment.source))
    assert.ok(fs.existsSync(config.deployment.source), '部署侧读到的 source 必须真实存在')
    assert.equal(validateWorksDeployment(config).valid, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('S4 负路径：.works 缺 deployment.source → 部署语义校验拦截', () => {
  const bad = { deployment: { type: 'domain' } }
  const result = validateWorksDeployment(bad)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => /deployment\.source 必填/.test(e)))
})

test('S5 接缝：真实 PPT domain 行覆盖审计通过（ppt-workbench-host 缺失事故的永久守卫）', () => {
  const audit = auditRowCoverage(PPT_DOMAIN)
  assert.equal(audit.ok, true, `缺失行: ${JSON.stringify(audit.missing)}`)
  assert.ok(audit.declaredCount > 0)
  assert.ok(audit.suites.includes('capyclaw-ppt-suite'))
})

test('S5 接缝：三件套 worker domain 行覆盖审计通过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-s5-'))
  try {
    const audit = auditRowCoverage(trioDomain(root))
    assert.equal(audit.ok, true, `缺失行: ${JSON.stringify(audit.missing)}`)
    assert.ok(audit.suites.includes('dsh-runtime-control-suite'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('S5 负路径：binding 引用未声明行 → 审计点名缺失', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-s5-bad-'))
  try {
    const file = trioDomain(root, 'seam-broken')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.runtime.bindings.push({ row: 'ghost-row', config: { port: '${ports.content}' } })
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
    const audit = auditRowCoverage(file)
    assert.equal(audit.ok, false)
    assert.deepEqual(audit.missing, [{ id: 'ghost-row', referencedBy: 'runtime.bindings' }])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('S5 负路径：removeRows 引用未声明行 → 审计点名缺失', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-s5-rm-'))
  try {
    const file = trioDomain(root, 'seam-rm')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.removeRows = ['phantom-row']
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
    const audit = auditRowCoverage(file)
    assert.equal(audit.ok, false)
    assert.deepEqual(audit.missing, [{ id: 'phantom-row', referencedBy: 'removeRows' }])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('collectPatchRowIds：容忍引号/缩进/注释散文', () => {
  const ids = collectPatchRowIds([
    '# 注释里提到 - id: not-a-row 不会算（不是条目行）',
    '- insert:',
    '    - id: plain-row',
    '    - id: "quoted-row"',
    "    - id: 'single-row'",
    '  - id: indented-row',
  ].join('\n'))
  assert.deepEqual(ids, ['plain-row', 'quoted-row', 'single-row', 'indented-row'])
})
