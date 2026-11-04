import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectContractSnapshots } from '../server/contract-snapshots.mjs'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const ownSnapshot = JSON.parse(readFileSync(new URL('../contract/ppt-contract.json', import.meta.url), 'utf8'))
const SCOPE = '@capyclaw'

test('自身契约快照存在且合法', () => {
  assert.ok(ownSnapshot.contractVersion, 'contract/ppt-contract.json 缺 contractVersion')
  assert.ok(Array.isArray(ownSnapshot.tools), 'contract/ppt-contract.json 缺 tools 清单')
})

test('兄弟 skill 包契约快照 major 对齐（dev 树，dsh-ppt-skill-*）', () => {
  const report = inspectContractSnapshots(packageDir, ownSnapshot.contractVersion)
  assert.ok(report.checked >= 1, `dev 树应至少检查到 1 个 skill 包，实际 ${report.checked}`)
  assert.deepEqual(report.mismatched, [])
  assert.equal(report.ok, true)
})

test('npm 扁平安装布局（父目录即 @capyclaw，ppt-skill-* 直接兄弟）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ppt-contract-flat-'))
  const scopeDir = join(root, SCOPE)
  const workbenchDir = join(scopeDir, 'ppt-workbench')
  const snapDir = join(scopeDir, 'ppt-skill-ppt', 'contract')
  try {
    mkdirSync(workbenchDir, { recursive: true })
    mkdirSync(snapDir, { recursive: true })
    writeFileSync(join(snapDir, 'ppt-contract.json'), JSON.stringify({ contractVersion: ownSnapshot.contractVersion }))
    /* 同 major 应通过且 checked=1 */
    const ok = inspectContractSnapshots(workbenchDir, ownSnapshot.contractVersion)
    assert.equal(ok.checked, 1, `npm 布局应检查到 1 个 skill 包，实际 ${ok.checked}`)
    assert.equal(ok.ok, true)
    /* major 不一致应报 mismatch */
    const bad = inspectContractSnapshots(workbenchDir, '99.0.0')
    assert.equal(bad.ok, false)
    assert.equal(bad.mismatched.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('嵌套作用域布局（node_modules/@capyclaw/ppt-skill-*）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ppt-contract-nested-'))
  const workbenchDir = join(root, '@capyclaw', 'ppt-workbench')
  const snapDir = join(root, '@capyclaw', 'ppt-skill-api', 'contract')
  try {
    mkdirSync(workbenchDir, { recursive: true })
    mkdirSync(snapDir, { recursive: true })
    writeFileSync(join(snapDir, 'ppt-contract.json'), JSON.stringify({ contractVersion: ownSnapshot.contractVersion }))
    const report = inspectContractSnapshots(workbenchDir, ownSnapshot.contractVersion)
    assert.equal(report.checked, 1)
    assert.equal(report.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
