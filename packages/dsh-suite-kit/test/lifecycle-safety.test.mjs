import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { stopRuntime, removeRuntime, startRuntime } from '../src/runtime.mjs'

test('runtime 不杀未验证 PID 或借用服务，失败保留记录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-safe-'))
  const dir = path.join(root, 'runtimes', 'safe')
  fs.mkdirSync(dir, { recursive: true })
  const discovery = path.join(dir, 'services.json')
  fs.writeFileSync(discovery, JSON.stringify({ services: {
    borrowed: { state: 'running', pid: process.pid, ownership: 'borrowed' },
    unknown: { state: 'running', pid: process.pid },
  } }))
  const runtime = { runtimeId: 'safe', storeRoot: root, paths: { runtimeFile: path.join(dir, 'runtime.json') }, services: { discovery }, pids: { proxy: process.pid }, status: 'running' }
  fs.writeFileSync(runtime.paths.runtimeFile, JSON.stringify(runtime))
  try {
    await assert.rejects(stopRuntime({ storeRoot: root, runtimeId: 'safe' }), /停止未完成/)
    const saved = JSON.parse(fs.readFileSync(runtime.paths.runtimeFile, 'utf8'))
    assert.equal(saved.status, 'stop-incomplete')
    assert.deepEqual(saved.stopResult.borrowed, ['borrowed'])
    assert.equal(saved.pids.proxy, process.pid)
    assert.throws(() => removeRuntime({ storeRoot: root, runtimeId: 'safe' }), /未解决/)
    process.kill(process.pid, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('proxy 启动中断时保留运行态和端口', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-proxy-intent-'))
  const dir = path.join(root, 'runtimes', 'safe')
  fs.mkdirSync(dir, { recursive: true })
  const runtime = { runtimeId: 'safe', storeRoot: root, paths: { root: dir, runtimeFile: path.join(dir, 'runtime.json') }, pids: {}, proxyStartupPending: true, status: 'starting' }
  fs.writeFileSync(runtime.paths.runtimeFile, JSON.stringify(runtime))
  try {
    await assert.rejects(stopRuntime({ storeRoot: root, runtimeId: 'safe' }), /proxy:startup-interrupted/)
    assert.throws(() => removeRuntime({ storeRoot: root, runtimeId: 'safe' }), /未解决/)
    await assert.rejects(startRuntime({ storeRoot: root, runtimeId: 'safe' }), /未清理/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('broker 启动中断且 discovery 缺失时保留记录和端口', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-interrupted-'))
  const dir = path.join(root, 'runtimes', 'safe')
  fs.mkdirSync(dir, { recursive: true })
  const runtime = { runtimeId: 'safe', storeRoot: root, paths: { root: dir, runtimeFile: path.join(dir, 'runtime.json') }, services: { manifest: 'manifest', discovery: path.join(dir, 'services.json') }, ports: { broker: 43210 }, pids: {}, brokerStartupPending: true, status: 'starting' }
  fs.writeFileSync(runtime.paths.runtimeFile, JSON.stringify(runtime))
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ ports: { '43210': 'safe' }, runtimes: {} }))
  try {
    await assert.rejects(stopRuntime({ storeRoot: root, runtimeId: 'safe' }), /停止未完成/)
    const saved = JSON.parse(fs.readFileSync(runtime.paths.runtimeFile, 'utf8'))
    assert.ok(saved.stopResult.unresolved.includes('broker:startup-interrupted'))
    assert.ok(saved.stopResult.unresolved.includes('discovery:missing'))
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'registry.json'))).ports['43210'], 'safe')
    await assert.rejects(startRuntime({ storeRoot: root, runtimeId: 'safe' }), /未清理/)
    assert.throws(() => removeRuntime({ storeRoot: root, runtimeId: 'safe' }), /未解决/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('空服务清单且 broker 已退出时可以恢复启动中断', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-recover-'))
  const dir = path.join(root, 'runtimes', 'safe')
  fs.mkdirSync(dir, { recursive: true })
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const discovery = path.join(dir, 'services.json')
  const manifest = path.join(dir, 'manifest.json')
  fs.writeFileSync(manifest, JSON.stringify({ services: [{ id: 'svc' }] }))
  const runtime = { runtimeId: 'safe', storeRoot: root, paths: { root: dir, runtimeFile: path.join(dir, 'runtime.json') }, services: { manifest, discovery, ids: ['svc'] }, pids: { broker: child.pid }, identities: { broker: { pid: child.pid, marker: 'recorded' } }, brokerStartupPending: true, status: 'starting' }
  fs.writeFileSync(runtime.paths.runtimeFile, JSON.stringify(runtime))
  fs.writeFileSync(discovery, JSON.stringify({ services: { svc: { state: 'running', pid: child.pid, ownership: 'owned' } } }))
  try {
    fs.writeFileSync(discovery, JSON.stringify({ services: {} }))
    await assert.rejects(stopRuntime({ storeRoot: root, runtimeId: 'safe' }), /startup-interrupted/)
    fs.writeFileSync(discovery, JSON.stringify({ services: { svc: { state: 'running', pid: process.pid, ownership: 'owned' } } }))
    await assert.rejects(stopRuntime({ storeRoot: root, runtimeId: 'safe' }), /startup-interrupted/)
    fs.writeFileSync(discovery, JSON.stringify({ services: { svc: { state: 'running', pid: child.pid, ownership: 'owned' } } }))
    await assert.rejects(stopRuntime({ storeRoot: root, runtimeId: 'safe' }), /startup-interrupted/)
    const saved = JSON.parse(fs.readFileSync(runtime.paths.runtimeFile, 'utf8'))
    saved.services.ids = []
    fs.writeFileSync(runtime.paths.runtimeFile, JSON.stringify(saved))
    fs.writeFileSync(manifest, JSON.stringify({ services: [] }))
    fs.writeFileSync(discovery, JSON.stringify({ services: {} }))
    const stopped = await stopRuntime({ storeRoot: root, runtimeId: 'safe' })
    assert.equal(stopped.brokerStartupPending, false)
    assert.equal(stopped.status, 'stopped')
    removeRuntime({ storeRoot: root, runtimeId: 'safe' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('PID 与身份记录不一致时绝不杀身份对应的进程', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-mismatch-'))
  const dir = path.join(root, 'runtimes', 'safe')
  fs.mkdirSync(dir, { recursive: true })
  const runtime = { runtimeId: 'safe', storeRoot: root, paths: { runtimeFile: path.join(dir, 'runtime.json') }, pids: { proxy: process.pid + 1000000 }, identities: { proxy: { pid: process.pid, marker: 'untrusted' } } }
  fs.writeFileSync(runtime.paths.runtimeFile, JSON.stringify(runtime))
  try {
    await assert.rejects(stopRuntime({ storeRoot: root, runtimeId: 'safe' }), /identity-mismatch/)
    process.kill(process.pid, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
