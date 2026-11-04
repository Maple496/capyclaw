import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRuntime, removeRuntime, startRuntime, stopRuntime,
} from '../../dsh-suite-kit/src/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const REPO = path.resolve(PKG, '..', '..')
const PUBLIC = {
  serviceHost: path.join(REPO, 'packages', 'dsh-service-host'),
  toolHost: path.join(REPO, 'packages', 'dsh-tool-host'),
  state: path.join(REPO, 'packages', 'dsh-state-service'),
  assets: path.join(REPO, 'packages', 'dsh-asset-service'),
  editorHost: path.join(REPO, 'packages', 'dsh-editor-host'),
}

function publicDomain(root) {
  const domain = {
    name: 'public-plugins-e2e',
    version: '1.0.0',
    title: 'Public Plugins E2E',
    baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    components: [
      PUBLIC.serviceHost,
      PUBLIC.toolHost,
      PUBLIC.state,
      PUBLIC.assets,
      PUBLIC.editorHost,
      path.join(PKG, 'test', 'probe-suite'),
    ],
    profile: { name: 'public-plugins-e2e', port: 3080 },
    runtime: {
      driver: 'node',
      workId: 'main',
      requires: {
        services: ['serviceHost', 'toolHost', 'state', 'assets', 'editorHost'],
        capabilities: ['host.http@^1.0.0', 'tools.registry@^1.0.0', 'state.persistence@^1.0.0', 'assets.store@^1.0.0', 'editor.host@^1.0.0'],
      },
      bindings: [
        { row: 'public-plugins-probe', config: { port: '${ports.content}', hostDir: '${paths.contentState}' } },
      ],
      model: {
        id: 'llm-deepseek',
        plugin: '@deepseek-ai/dsh-llm-deepseek-api-key',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseUrlEnv: 'DEEPSEEK_BASE_URL',
        baseURL: 'https://api.deepseek.com/anthropic',
      },
      scope: {
        sessions: { path: '.dsh/sessions', isolated: true },
        files: [
          { id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] },
          { id: 'probe', kind: 'content', path: 'content/probe', patterns: ['**'] },
        ],
        workspace: { workId: 'main', files: ['**'], allowNew: true },
        network: { bind: ['127.0.0.1'] },
        processes: { killTree: true },
      },
      ports: {
        harness: { preferred: 0, range: 100 },
        dsh: { preferred: 0, range: 100 },
        content: { preferred: 0, range: 100 },
      },
    },
  }
  const file = path.join(root, 'public-plugins.json')
  fs.writeFileSync(file, JSON.stringify(domain, null, 2) + '\n')
  return file
}

async function waitFetch(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`fetch timeout: ${url}`)
}

test('E2E：公共插件作为 DSH 插件加载，ctx.* 注入到功能插件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-plugins-e2e-'))
  const storeRoot = path.join(root, 'store')
  const domainFile = publicDomain(root)
  const runtime = await createRuntime({
    name: 'public-plugins-e2e',
    domainInput: domainFile,
    storeRoot,
    harnessPort: 0,
    dshPort: 0,
    contentPort: 0,
  })
  try {
    const started = await startRuntime({ storeRoot, runtimeId: runtime.runtimeId, waitMs: 30000 })
    assert.equal(started.ready, true, 'runtime should be ready')
    const base = `http://127.0.0.1:${runtime.ports.content}`

    const health = await waitFetch(`${base}/healthz`).then((res) => res.json())
    assert.equal(health.ok, true)
    assert.deepEqual(health.services, {
      serviceHost: true,
      toolHost: true,
      state: true,
      assets: true,
      editorHost: true,
    })
    assert.equal(health.tools, 1)

    const tools = await fetch(`${base}/probe/tools`).then((res) => res.json())
    assert.deepEqual(tools.tools, ['probe_echo'])

    const state1 = await fetch(`${base}/probe/state`).then((res) => res.json())
    const state2 = await fetch(`${base}/probe/state`).then((res) => res.json())
    assert.equal(state1.count, 1)
    assert.equal(state2.count, 2)

    const asset = await fetch(`${base}/probe/asset`).then((res) => res.json())
    assert.equal(asset.ok, true)
    assert.equal(asset.text, 'probe-asset')
    assert.match(asset.id, /^[a-f0-9]{64}$/)
  } finally {
    await stopRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    removeRuntime({ storeRoot, runtimeId: runtime.runtimeId })
    fs.rmSync(root, { recursive: true, force: true })
  }
})
