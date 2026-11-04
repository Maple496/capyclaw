/**
 * pyworker —— 内嵌 Python 工作流执行器（上游 port-8301/app 快照）生命周期管理。
 *
 * 职责：venv 引导（缺则建）→ 临时端口起 uvicorn → /healthz 探活 → 健康与
 * 日志面暴露 → 随宿主停止。执行器只绑回环，Node 侧经 HTTP 反代对外。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXEC_DIR = path.join(HERE, 'py-executor')
const VENV_DIR = path.join(EXEC_DIR, '.venv')

function venvPython() {
  return process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python')
}

function findSystemPython() {
  const candidates = [process.env.DSH_FLOW_PYTHON, 'python3', 'python'].filter(Boolean)
  for (const cmd of candidates) {
    try {
      const r = spawnSyncSafe(cmd, ['--version'])
      if (r.status === 0) return cmd
    } catch { /* try next */ }
  }
  throw new Error('[dsh-flow-engine] 未找到 Python（≥3.10）。可用 DSH_FLOW_PYTHON 指定。')
}

function spawnSyncSafe(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function httpGetOk(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

async function waitForHealth(url, { deadlineMs, label }) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (await httpGetOk(url)) return
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`[dsh-flow-engine] ${label}超时（${deadlineMs}ms）: ${url}`)
}

async function ensureVenv(log) {
  const py = venvPython()
  if (fs.existsSync(py)) return py
  const sys = findSystemPython()
  log(`创建 venv（首次运行，需数秒）: ${VENV_DIR}`)
  const mk = spawnSyncSafe(sys, ['-I', '-m', 'venv', VENV_DIR])
  if (mk.status !== 0) throw new Error(`venv 创建失败: ${mk.stderr}`)
  const pip = spawnSyncSafe(py, ['-m', 'pip', 'install', '--disable-pip-version-check',
    '-r', path.join(EXEC_DIR, 'requirements.txt')])
  if (pip.status !== 0) {
    throw new Error(`依赖安装失败（需网络）: ${String(pip.stderr).slice(-800)}`)
  }
  log('venv 就绪')
  return py
}

/** 启动内嵌执行器。返回 { port, url, healthUrl, stop, logs } */
export async function startPyWorker({ log = () => {}, env = {} } = {}) {
  const python = await ensureVenv(log)
  const port = await freePort()
  const ring = []
  const pushLog = (line) => {
    ring.push(line)
    if (ring.length > 200) ring.shift()
  }

  const child = spawn(python, [
    '-m', 'uvicorn', 'app.main:app',
    '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning',
  ], {
    cwd: EXEC_DIR,
    env: {
      ...process.env,
      CACHE_ENABLED: 'false',       // 与平台生产一致；缓存需自起 redis 再开
      LOG_LEVEL: 'WARNING',
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const tag = (stream) => (buf) => String(buf).split(/\r?\n/).filter(Boolean)
    .forEach((line) => pushLog(`[py:${stream}] ${line}`))
  child.stdout.on('data', tag('out'))
  child.stderr.on('data', tag('err'))
  child.on('exit', (code, sig) => pushLog(`[py] 退出 code=${code} sig=${sig}`))

  const healthUrl = `http://127.0.0.1:${port}/healthz`
  try {
    await waitForHealth(healthUrl, { deadlineMs: 30000, label: '执行器启动探活' })
  } catch (err) {
    child.kill()
    throw new Error(`${err.message}\n${ring.slice(-30).join('\n')}`)
  }

  log(`执行器就绪: ${healthUrl}`)
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    healthUrl,
    logs: ring,
    stopped: false,
    async stop() {
      if (this.stopped) return
      this.stopped = true
      await new Promise((resolve) => {
        child.once('exit', resolve)
        try { child.kill() } catch { /* already gone */ }
        setTimeout(resolve, 3000).unref?.()
      })
    },
  }
}
