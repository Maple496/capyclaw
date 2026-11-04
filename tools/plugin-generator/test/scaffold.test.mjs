import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..')
const CREATE = path.join(ROOT, 'create-plugin.mjs')
const SUITE_CLI = path.join(REPO, 'packages', 'dsh-suite-kit', 'bin', 'dsh-suite.mjs')
const DOMAIN_CLI = path.join(REPO, 'packages', 'dsh-suite-kit', 'bin', 'dsh-domain.mjs')

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

test('脚手架生成 service + suite + domain，并通过生成插件测试', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scaffold-'))
  const out = path.join(tmp, 'plugins')
  try {
    execFileSync(process.execPath, [
      CREATE,
      '--name', 'dsh-demo-service',
      '--type', 'service',
      '--title', 'Demo Service',
      '--port', '39601',
      '--out', out,
      '--domain', 'demo',
      '--yes',
    ], { cwd: ROOT, stdio: 'pipe' })

    const root = path.join(out, 'dsh-demo-service')
    const pluginDir = path.join(root, 'plugin', 'dsh-demo-service')
    const suiteDir = path.join(root, 'plugin', 'dsh-demo-service-suite')
    const domainDir = path.join(root, 'domains', 'demo')

    assert.ok(fs.existsSync(path.join(pluginDir, 'package.json')))
    assert.ok(fs.existsSync(path.join(pluginDir, 'server', 'shared', 'service-host.mjs')))
    assert.ok(fs.existsSync(path.join(pluginDir, 'server', 'shared', 'tool-host.mjs')))
    assert.ok(!fs.existsSync(path.join(pluginDir, 'server', 'infra')), '新插件不应再生成 server/infra 快照')
    assert.ok(fs.existsSync(path.join(suiteDir, 'dsh-suite.json')))
    assert.ok(fs.existsSync(path.join(domainDir, 'dsh-domain.json')))

    for (const file of walk(pluginDir).filter((name) => name.endsWith('.mjs'))) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    }

    execFileSync(process.execPath, ['--test', 'test/plugin.test.mjs'], {
      cwd: pluginDir,
      stdio: 'pipe',
      timeout: 120000,
    })

    execFileSync(process.execPath, [SUITE_CLI, 'validate', suiteDir], { stdio: 'pipe' })
    execFileSync(process.execPath, [DOMAIN_CLI, 'validate', domainDir], { stdio: 'pipe' })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('plugin-only 生成最小插件且不创建 suite/domain', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scaffold-'))
  try {
    execFileSync(process.execPath, [
      CREATE,
      '--name', 'dsh-mini',
      '--type', 'minimal',
      '--out', tmp,
      '--yes',
    ], { cwd: ROOT, stdio: 'pipe' })
    const pluginDir = path.join(tmp, 'dsh-mini')
    assert.ok(fs.existsSync(path.join(pluginDir, 'lib', 'host.mjs')))
    assert.ok(fs.existsSync(path.join(pluginDir, 'package.json')))
    assert.ok(!fs.existsSync(path.join(pluginDir, 'server')))
    assert.ok(!fs.existsSync(path.join(pluginDir, 'dsh-suite.json')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
