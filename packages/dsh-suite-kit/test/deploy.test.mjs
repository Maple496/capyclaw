import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commands, loadConfig, getRuntimeId } from '../bin/dsh-deploy.mjs'
import { readFileSync } from 'node:fs'
import { removeRuntime, stopRuntime } from '../src/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLES = path.resolve(HERE, '..', 'examples')
const REPO = path.resolve(HERE, '..', '..', '..')
const PKG = path.resolve(REPO, 'packages', 'dsh-runtime-control')
const CATALOG_PKG = path.join(REPO, 'packages', 'dsh-catalog')
const INSTALLER_PKG = path.join(REPO, 'packages', 'dsh-installer')

test('loadConfig 解析 .works 示例并把相对 source 解析为绝对路径', () => {
  const config = loadConfig(path.join(EXAMPLES, 'deployment-ppt-basic.works'))
  assert.equal(config.name, 'PPT工作台部署配置')
  assert.equal(config.version, '1.0.0')
  assert.equal(config.deployment.type, 'domain')
  assert.ok(path.isAbsolute(config.deployment.source), config.deployment.source)
  assert.ok(fs.existsSync(path.join(config.deployment.source, 'dsh-domain.json')))
})

test('loadConfig 解析 JSON 示例', () => {
  const config = loadConfig(path.join(EXAMPLES, 'deployment-ppt-basic.json'))
  assert.equal(config.name, 'ppt-basic')
  assert.equal(config.deployment.type, 'domain')
  assert.ok(fs.existsSync(config.deployment.source))
})

test('loadConfig 缺必需字段时报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-bad-'))
  try {
    const file = path.join(dir, 'bad.json')
    fs.writeFileSync(file, JSON.stringify({ name: 'x' }))
    assert.throws(() => loadConfig(file), /缺少必需字段/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('getRuntimeId 对中文名生成合法且确定性的 runtime ID', () => {
  const config = { name: 'PPT工作台部署配置', version: '1.0.0' }
  const id = getRuntimeId(config)
  assert.match(id, /^[a-z0-9][a-z0-9._-]{0,63}$/)
  assert.equal(id, getRuntimeId(config))
})

test('validate 通过仓库内 .works 与 JSON 示例', async () => {
  await commands.validate(path.join(EXAMPLES, 'deployment-ppt-basic.works'))
  await commands.validate(path.join(EXAMPLES, 'deployment-ppt-basic.json'))
})

/** deploy E2E 用的最小 domain（与 runtime-control e2e 同款组件，已被证明可启动）。 */
function deployDomain(root) {
  const domain = {
    name: 'deploy-e2e',
    version: '1.0.0',
    title: 'Deploy E2E',
    baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    components: [PKG, CATALOG_PKG, INSTALLER_PKG],
    profile: { name: 'deploy-e2e', port: 3080 },
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
        files: [
          { id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] },
          { id: 'control', kind: 'content', path: 'content/control', patterns: ['**'] },
        ],
        network: { bind: ['127.0.0.1'] },
        processes: { killTree: true },
      },
      ports: { harness: 0, dsh: 0, content: 0 },
      model: {
        id: 'llm-deepseek',
        plugin: '@deepseek-ai/dsh-llm-deepseek-api-key',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseUrlEnv: 'DEEPSEEK_BASE_URL',
        baseURL: 'https://api.deepseek.com/anthropic',
      },
    },
  }
  const file = path.join(root, 'deploy-e2e-domain.json')
  fs.writeFileSync(file, JSON.stringify(domain, null, 2) + '\n')
  return file
}

test('E2E deploy：.works 配置 → start（创建+启动+健康检查）→ status → stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-e2e-'))
  const storeRoot = path.join(root, 'store')
  const domainFile = deployDomain(root)

  // 用 .works 配置走全链路（CODE 段与示例同构）
  const worksFile = path.join(root, 'deploy-e2e.works')
  fs.writeFileSync(worksFile, `%%%WORKS-META%%%
{
  "name": "deploy-e2e",
  "brief": "deploy e2e smoke",
  "tags": "e2e,deploy",
  "view": { "kind": "deployment" },
  "schema_version": "1.0.0"
}

%%%WORKS-CODE%%%
{
  "deployment": { "type": "domain", "source": ${JSON.stringify(domainFile)}, "storeRoot": ${JSON.stringify(storeRoot)}, "autoStart": true },
  "runtime": { "driver": "node", "workId": "main" },
  "launcher": {
    "mode": "background",
    "healthCheck": { "enabled": true, "timeout": 10, "retries": 3 },
    "beforeStart": ["echo before-start"],
    "afterStart": ["echo after-start"]
  }
}
`)

  const runtimeId = getRuntimeId(loadConfig(worksFile))
  try {
    await commands.start(worksFile)

    const state = JSON.parse(readFileSync(path.join(storeRoot, 'deployments', 'deploy-e2e.json'), 'utf-8'))
    assert.equal(state.status, 'running')
    assert.equal(state.runtimeId, runtimeId)

    await commands.status(worksFile)
    await commands.stop(worksFile)

    const stopped = JSON.parse(readFileSync(path.join(storeRoot, 'deployments', 'deploy-e2e.json'), 'utf-8'))
    assert.equal(stopped.status, 'stopped')
  } finally {
    await stopRuntime({ storeRoot, runtimeId }).catch(() => {})
    removeRuntime({ storeRoot, runtimeId })
    fs.rmSync(root, { recursive: true, force: true })
  }
}, { timeout: 120000 })
