import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { name, apply } from '../lib/index.mjs'

test('suite 组合包可独立加载', () => {
  assert.equal(name, 'ppt-suite')
  assert.doesNotThrow(() => apply())
  assert.ok(existsSync(new URL('../dsh-suite.json', import.meta.url)), 'dsh-suite.json 必须随包分发')
  assert.ok(existsSync(new URL('../services.json', import.meta.url)), 'services.json 必须随包分发')
  assert.ok(existsSync(new URL('../composition.lock.json', import.meta.url)), 'composition.lock.json 必须随包分发')
})
