import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/host.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const PPT_DOMAIN = path.join(REPO, 'bridges', 'ppt-bridge', 'domains', 'ppt', 'dsh-domain.json')

test('installer：resolves a domain without starting processes', () => {
  let service
  const dispose = apply({ provide(name, value) { service = value; return () => {} } })
  assert.ok(service)
  const resolved = service.resolve(PPT_DOMAIN)
  assert.ok(resolved.components.includes('capyclaw-ppt-suite'))
  assert.ok(resolved.components.includes('dsh-workspace-service-suite'))
  assert.ok(resolved.rows.length > 0)
  dispose()
})
