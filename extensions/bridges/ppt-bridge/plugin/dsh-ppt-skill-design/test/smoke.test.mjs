import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, name, inject } from '../lib/index.mjs'

test('skill provider 注册', () => {
  assert.equal(name, 'ppt-skill-design')
  assert.deepEqual(inject, ['skills'])
  const registered = []
  apply({ skills: { registerProvider: (make) => registered.push(make) } }, {})
  assert.equal(registered.length, 1)
  assert.equal(typeof registered[0], 'function')
})
