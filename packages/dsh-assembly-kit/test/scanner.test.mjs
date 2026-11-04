import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scan } from '../src/scanner.mjs'

test('scan：从工作区发现 suite 与 capability 组件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-scan-'))
  try {
    const suiteDir = path.join(root, 'suites', 'demo-suite')
    fs.mkdirSync(suiteDir, { recursive: true })
    fs.writeFileSync(path.join(suiteDir, 'dsh-suite.json'), JSON.stringify({
      name: 'demo-suite',
      version: '1.0.0',
      title: 'Demo Suite',
      description: '扫描 fixture',
      packages: {
        'demo-plugin': {
          role: 'runtime',
          version: '^1.0.0',
          path: '../plugin/demo-plugin',
          provides: { tools: ['demo_echo'], services: ['demo-service'] },
        },
      },
      rows: [{ id: 'demo-host', name: 'demo-plugin' }],
    }, null, 2))

    const capDir = path.join(root, 'caps', 'demo-cap')
    fs.mkdirSync(capDir, { recursive: true })
    fs.writeFileSync(path.join(capDir, 'package.json'), JSON.stringify({
      name: 'demo-cap',
      version: '1.0.0',
      dsh: { capabilities: { source: 'caps', manifest: 'capabilities.json' } },
    }, null, 2))
    fs.writeFileSync(path.join(capDir, 'capabilities.json'), JSON.stringify({
      capabilities: [{
        id: 'demo-capability',
        title: 'Demo Capability',
        description: '能力 fixture',
        version: '1.0.0',
        provides: { capabilities: { 'demo.runtime': '1.0.0' } },
      }],
    }, null, 2))

    const library = await scan(root)
    assert.ok(Array.isArray(library.components))
    const ids = library.components.map((c) => c.id)
    assert.ok(ids.includes('demo-plugin'), `应发现 suite 的 demo-plugin 组件，实际: ${ids.join(',')}`)
    assert.ok(ids.includes('demo-capability'), `应发现 demo-capability 组件，实际: ${ids.join(',')}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('scan：空工作区返回空组件库', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembly-empty-'))
  try {
    const library = await scan(root)
    assert.deepEqual(library.components, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
