import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { analyze, resolveManifestRef } from '../lib/analyze.mjs'
import { scan } from '../lib/scan.mjs'
import { HERE } from './helpers.mjs'

const STACK_FIXTURE = path.join(HERE, 'fixtures', 'stack')

async function loadStackInventory() {
  const result = await scan({
    roots: [STACK_FIXTURE],
    dshHome: path.join(STACK_FIXTURE, 'home'),
    includeProfiles: false,
    cwd: STACK_FIXTURE,
  })
  return analyze(result)
}

test('扫描识别 dsh-stack.json 并检查 profile/manifest 漂移', async () => {
  const inventory = await loadStackInventory()
  assert.equal(inventory.summary.stacks, 1)
  assert.equal(inventory.stacks.length, 1)
  const stack = inventory.stacks[0]
  assert.equal(stack.stack.name, 'fixture-stack')
  assert.equal(stack.stack.profile, 'web')
  assert.deepEqual(stack.stack.bundles, ['@deepseek-ai/dsh-base', 'demo-plugin'])
  assert.deepEqual(stack.stack.services.map((service) => service.id), ['demo'])
  assert.ok(stack.issues.some((issue) => issue.code === 'stack-profile-drift'))
  assert.ok(stack.issues.some((issue) => issue.code === 'stack-manifest-drift'))
})

test('stack 可被清单引用解析', async () => {
  const inventory = await loadStackInventory()
  const stack = resolveManifestRef(inventory, 'dsh-stack.json')
  assert.equal(stack.type, 'stack')
  assert.equal(stack.stack.name, 'fixture-stack')
})
