import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectContractSnapshots } from '../plugin/capyclaw-ppt-workbench/server/contract-snapshots.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ppt-contract-'))
  const workbench = join(root, 'capyclaw-ppt-workbench')
  mkdirSync(workbench, { recursive: true })
  const addSkill = (name, version) => {
    mkdirSync(join(root, name), { recursive: true })
    if (version === null) return
    mkdirSync(join(root, name, 'contract'), { recursive: true })
    writeFileSync(
      join(root, name, 'contract', 'ppt-contract.json'),
      JSON.stringify({ contractVersion: version }),
    )
  }
  return { root, workbench, addSkill }
}

test('contract snapshots：同 major 通过，异 major / 缺快照被标记', () => {
  const { root, workbench, addSkill } = fixture()
  try {
    addSkill('dsh-ppt-skill-ppt', '2.2.0')
    addSkill('dsh-ppt-skill-narrative', '2.9.1')
    addSkill('dsh-ppt-skill-stale', '3.0.0')
    addSkill('dsh-ppt-skill-missing', null)

    const report = inspectContractSnapshots(workbench, '2.2.0')
    assert.equal(report.checked, 4)
    assert.equal(report.ok, false)
    assert.deepEqual(
      report.mismatched.map((item) => item.package).sort(),
      ['dsh-ppt-skill-missing', 'dsh-ppt-skill-stale'],
    )
    assert.equal(report.mismatched.find((item) => item.package === 'dsh-ppt-skill-missing').actual, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('contract snapshots：没有 skill 包时 checked=0 且通过', () => {
  const { root, workbench } = fixture()
  try {
    const report = inspectContractSnapshots(workbench, '2.2.0')
    assert.equal(report.checked, 0)
    assert.equal(report.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
