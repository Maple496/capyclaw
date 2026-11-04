import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildBundle } from '../../../scripts/lib/bundle-builder.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')

function domainFixture(root) {
  const domain = {
    name: 'ws-probe-bundle',
    version: '1.0.0',
    title: 'Workspace Probe Bundle',
    baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    components: [PKG, path.join(PKG, 'test', 'probe-suite')],
    profile: { name: 'ws-probe-bundle', port: 3080 },
    runtime: {
      driver: 'node',
      workId: 'main',
      requires: { services: ['workspace', 'workspace-probe'], capabilities: ['workspace.runtime@^1.0.0'] },
      bindings: [{ row: 'workspace-probe', config: { port: '${ports.content}', workId: '${workId}' } }],
      scope: {
        sessions: { path: '.dsh/sessions', isolated: true },
        files: [
          { id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] },
          { id: 'probe', kind: 'content', path: 'content/probe', patterns: ['probe/**'] },
        ],
        workspace: { workId: 'main', files: ['probe/**'], allowNew: false },
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
  const file = path.join(root, 'domain.json')
  fs.writeFileSync(file, JSON.stringify(domain, null, 2) + '\n')
  return file
}

test('E2E bundle：workspace-service + probe 打包并由 setup 创建 runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bundle-e2e-'))
  const out = path.join(root, 'bundle')
  const storeRoot = path.join(root, 'store')
  try {
    const result = await buildBundle({
      domainInput: domainFixture(root),
      outDir: out,
      target: 'portable',
      skipRuntime: true,
    })
    assert.equal(result.manifest.name, 'ws-probe-bundle')
    assert.ok(fs.existsSync(path.join(out, 'domain', 'dsh-plugin-kit', 'src', 'workspace', 'manager.mjs')))
    assert.ok(fs.existsSync(path.join(out, 'launch.mjs')))
    assert.ok(fs.existsSync(path.join(out, 'setup.mjs')))

    execFileSync(process.execPath, [path.join(out, 'setup.mjs')], {
      env: { ...process.env, DSH_STORE_ROOT: storeRoot },
      stdio: 'pipe',
      timeout: 120000,
    })
    const info = JSON.parse(fs.readFileSync(path.join(out, '.runtime.json'), 'utf8'))
    assert.ok(info.runtimeId.startsWith('rt-'))
    assert.ok(info.ports.harness > 0)
    const runtime = JSON.parse(fs.readFileSync(path.join(info.paths.root, 'runtime.json'), 'utf8'))
    assert.deepEqual(runtime.requires.services, ['workspace', 'workspace-probe'])
    assert.equal(runtime.storage.sessions.isolated, true)
    const profile = path.join(runtime.paths.dshHome, 'profiles', runtime.profile)
    const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
    assert.ok(pkg.dsh.profile.bundles.includes('dsh-workspace-service-suite'))
    assert.ok(pkg.dsh.profile.bundles.includes('dsh-workspace-probe-suite'))
    assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'dsh-workspace-service')))
    assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'dsh-workspace-probe')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
