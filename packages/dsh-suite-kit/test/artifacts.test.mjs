import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packPackage, resolvePackageSpec, listArtifacts } from '../src/index.mjs'

function tempPackage(version = '1.0.0') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifact-pkg-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'demo-plugin',
    version,
    dsh: { apiVersion: '1.0.0' },
    dependencies: { 'dsh-plugin-kit': '^0.2.0' },
  }, null, 2))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'index.mjs'), `export const version = '${version}'\n`)
  return dir
}

test('artifact-store: pack / resolve exact / latest / list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifacts-'))
  const v1 = tempPackage('1.0.0')
  const v2 = tempPackage('1.1.0')
  const one = packPackage(v1, { root })
  const two = packPackage(v2, { root })
  assert.equal(one.name, 'demo-plugin')
  assert.equal(one.apiVersion, '1.0.0')
  assert.ok(fs.existsSync(path.join(one.dir, 'src', 'index.mjs')))
  assert.equal(resolvePackageSpec('demo-plugin@1.0.0', { root }).version, '1.0.0')
  assert.equal(resolvePackageSpec('demo-plugin@1.1.0', { root }).version, '1.1.0')
  assert.equal(resolvePackageSpec('demo-plugin', { root }).version, '1.1.0')
  assert.throws(() => resolvePackageSpec('demo-plugin@9.9.9', { root }), /版本不存在/)
  assert.equal(listArtifacts({ root }).length, 2)
  assert.throws(() => packPackage(v1, { root }), /已存在/)
})

test('artifact-store: tree hash changes with content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifacts-hash-'))
  const dir = tempPackage('1.0.0')
  const first = packPackage(dir, { root })
  fs.writeFileSync(path.join(dir, 'src', 'index.mjs'), 'export const version = "changed"\n')
  const second = packPackage(dir, { root, force: true })
  assert.notEqual(first.sha256, second.sha256)
})
