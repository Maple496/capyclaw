import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { marker, absent, recoverServices, writeReceipt, queryWindowsIdentity } from '../lib/recovery.mjs'
import { allocatePort } from '../lib/engine.mjs'
import { stopRuntime } from '../../dsh-suite-kit/src/runtime.mjs'
import { processIdentity } from '../../dsh-suite-kit/src/process-identity.mjs'

const server = fileURLToPath(new URL('../server.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('./fixture/mini-service.mjs', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(fn) { for (let i = 0; i < 200; i++) { const result = await fn(); if (result) return result; await sleep(100) } throw new Error('timeout') }
function kill(pid) { if (!pid || absent(pid)) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); else process.kill(pid, 'SIGKILL') }

test('Windows identity query retries unavailable results but never invents a marker', () => {
  let calls = 0
  const valid = value => /^\d+$/.test(value)
  const query = responses => queryWindowsIdentity('query', valid, () => {
    calls++
    const response = responses.shift()
    if (response instanceof Error) throw response
    return response
  })
  assert.equal(query([new Error('spawn'), { status: 0, stdout: '' }, { status: 0, stdout: '123\r\n' }]), '123')
  assert.equal(calls, 3)
  calls = 0
  assert.equal(query([{ status: 1, stdout: '123' }, { status: 0, stdout: 'garbage' }, { status: null }]), null)
  assert.equal(calls, 3)
  calls = 0
  assert.equal(query([{ status: 0, stdout: '456' }, { status: 0, stdout: '123' }]), '456')
  assert.equal(calls, 1)
})

test('Windows identity formats stay stable for this process', { skip: process.platform !== 'win32' }, () => {
  const brokerMarker = marker(process.pid)
  const suiteIdentity = processIdentity(process.pid)
  assert.match(brokerMarker || '', /^win:\d+$/)
  assert.match(suiteIdentity?.marker || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/)
  assert.equal(marker(process.pid), brokerMarker)
  assert.deepEqual(processIdentity(process.pid), suiteIdentity)
})

test('crashed broker receipts recover owned child without touching unrelated process', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-'))
  const discovery = path.join(dir, 'services.json'), manifest = path.join(dir, 'manifest.json')
  const port = await allocatePort()
  fs.writeFileSync(manifest, JSON.stringify({ services: [{ id: 'mini', cmd: [process.execPath, fixture, '--port', '${PORT}'], ports: { main: 'auto' }, url: 'http://127.0.0.1:${PORT}' }] }))
  const broker = spawn(process.execPath, [server, '--port', String(port), '--discovery', discovery, '--manifest', manifest], { stdio: 'ignore' })
  let servicePid
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  try {
    const identity = await waitFor(() => marker(broker.pid))
    const row = await waitFor(() => { try { return JSON.parse(fs.readFileSync(discovery)).services.mini } catch { return null } })
    servicePid = row.pid
    assert.equal(row.ownership, 'owned')
    const proof = { pid: broker.pid, marker: 'captured', recoveryMarker: identity }
    assert.deepEqual((await recoverServices(discovery, proof)).unresolved, ['broker:not-confirmed-absent'])
    kill(broker.pid)
    await waitFor(() => absent(broker.pid))
    writeReceipt(discovery, 'foreign', { id: 'foreign', brokerPid: broker.pid, brokerMarker: identity, state: 'spawned', pid: foreign.pid, identity: 'incorrect' })
    const result = await recoverServices(discovery, proof)
    assert.ok(result.stopped.includes('mini'))
    assert.ok(!result.unresolved.includes('service:mini:descendants-unverified'))
    assert.ok(!fs.existsSync(`${discovery}.ownership/mini.json`), '已确认端口释放后收据应清除')
    assert.ok(result.unresolved.some(x => x.includes('foreign')))
    assert.equal(absent(servicePid), true)
    assert.equal(absent(foreign.pid), false)
    writeReceipt(discovery, 'foreign', { id: 'foreign', brokerPid: broker.pid, brokerMarker: identity, state: 'pending' })
    assert.ok((await recoverServices(discovery, proof)).unresolved.length)
    assert.equal(absent(foreign.pid), false)
  } finally { kill(broker.pid); kill(servicePid); kill(foreign.pid); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('suite stop recovers service after broker crash', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suite-recovery-'))
  const dir = path.join(root, 'runtimes', 'safe')
  fs.mkdirSync(dir, { recursive: true })
  const discovery = path.join(dir, 'services.json'), manifest = path.join(dir, 'manifest.json')
  const port = await allocatePort()
  fs.writeFileSync(manifest, JSON.stringify({ services: [{ id: 'mini', cmd: [process.execPath, fixture, '--port', '${PORT}'], ports: { main: 'auto' } }] }))
  const broker = spawn(process.execPath, [server, '--port', String(port), '--discovery', discovery, '--manifest', manifest], { stdio: 'ignore' })
  let servicePid
  try {
    const recovery = await waitFor(() => marker(broker.pid))
    const identity = await waitFor(() => processIdentity(broker.pid))
    const row = await waitFor(() => { try { return JSON.parse(fs.readFileSync(discovery)).services.mini } catch { return null } })
    servicePid = row.pid
    const runtime = { runtimeId: 'safe', storeRoot: root, paths: { root: dir, runtimeFile: path.join(dir, 'runtime.json') }, services: { manifest, discovery, ids: ['mini'] }, ports: { broker: port }, pids: { broker: broker.pid }, identities: { broker: { ...identity, recoveryMarker: recovery } }, startedAt: new Date().toISOString(), status: 'running' }
    fs.writeFileSync(runtime.paths.runtimeFile, JSON.stringify(runtime))
    kill(broker.pid)
    await waitFor(() => absent(broker.pid))
    // The receipt's root is killed and its declared port is verified free, so
    // the runtime may finish stopping instead of staying stuck forever.
    await stopRuntime({ storeRoot: root, runtimeId: 'safe' })
    assert.equal(JSON.parse(fs.readFileSync(runtime.paths.runtimeFile)).status, 'stopped')
    assert.equal(absent(servicePid), true)
  } finally { kill(broker.pid); kill(servicePid); fs.rmSync(root, { recursive: true, force: true }) }
})
