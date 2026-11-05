/**
 * e2e 公共 harness：检查记录、进程拉起/回收、HTTP/MCP 探测、端口分配。
 *
 * 各层（l1-static / l3-services / l4-broker / l5-release）导入本模块；
 * 输出风格与仓库一致（✓/✗/·/!），每层结束打印 `L<N> <name>: x/y 通过`。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 20000-40000 随机端口（避开 393xx 服务固定端口段）。 */
export function randomPort() {
  return 20000 + Math.floor(Math.random() * 18000)
}

/** 端口是否空闲（可 bind 即空闲）。 */
export function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** 同步命令（继承 stdio 或捕获）。返回 { status, stdout, stderr }。 */
export function run(cmd, args, { cwd = ROOT, capture = true } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** 检查记录器：check(label, cond, detail)。 */
export class Recorder {
  constructor(name) {
    this.name = name
    this.results = []
  }

  check(label, cond, detail = '') {
    this.results.push({ label, ok: !!cond, detail: String(detail || '') })
    console.log(`${cond ? '✓' : '✗'} ${label}${!cond && detail ? ' — ' + String(detail).split('\n')[0].slice(0, 160) : ''}`)
    return !!cond
  }

  section(title) {
    console.log(`\n—— ${title} ——`)
  }

  skip(label, reason) {
    this.results.push({ label, ok: null, detail: reason })
    console.log(`· ${label}（跳过：${reason}）`)
  }

  summary() {
    const pass = this.results.filter((r) => r.ok === true).length
    const fail = this.results.filter((r) => r.ok === false).length
    const skip = this.results.filter((r) => r.ok === null).length
    console.log(`\n${this.name}: ${pass} 通过${fail ? `，${fail} 失败` : ''}${skip ? `，${skip} 跳过` : ''}`)
    return { name: this.name, pass, fail, skip }
  }
}

/** 轮询直到 fn() 返回真值（超时抛错）。 */
export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`等待超时（${timeoutMs}ms）: ${label}${last instanceof Error ? '，最后错误: ' + last.message : ''}`)
}

/** GET JSON（失败抛错）。 */
export async function getJson(url, timeoutMs = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`)
  return r.json()
}

/** 拉起一个长驻服务进程；stop() 杀进程树并等端口释放。
 *  绝对路径 exe（如 process.execPath，常带空格）不走 shell，避免被拆词。 */
export async function startService(cmd, args, { cwd = ROOT, readyFn, timeoutMs = 30000, env = {}, logFile } = {}) {
  const logFd = logFile ? fs.openSync(logFile, 'w') : 'ignore'
  const useShell = process.platform === 'win32' && !/[\\/]/.test(cmd)
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', logFile === undefined ? 'inherit' : logFd, logFile === undefined ? 'inherit' : logFd],
    shell: useShell,
    detached: false,
  })
  const stop = async () => {
    if (child.exitCode !== null) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 5000)
      child.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  try {
    if (readyFn) await waitFor(readyFn, { timeoutMs, label: `${cmd} ${args.join(' ')}` })
  } catch (error) {
    await stop()
    const tail = logFile ? (fs.readFileSync(logFile, 'utf8').split('\n').slice(-8).join('\n')) : ''
    throw new Error(`${error.message}\n--- 服务日志尾部 ---\n${tail}`)
  }
  return { proc: child, stop }
}

/** MCP /mcp 调用器（无状态纯 JSON POST，见 plugin-kit createMcpHandler）。 */
export function mcpCaller(port, base = '') {
  const url = `http://127.0.0.1:${port}${base}/mcp`
  return async function rpc(method, params = {}) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
      signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) throw new Error(`POST /mcp ${method} → ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return r.json()
  }
}

/** 解析 MCP tools/call 的文本内容（content[0].text）。 */
export function mcpText(result) {
  if (result?.error) throw new Error('MCP error: ' + JSON.stringify(result.error).slice(0, 200))
  const content = result?.result?.content
  if (!Array.isArray(content) || !content.length) throw new Error('MCP result 无 content')
  return content[0].text
}

/** Windows junction（目录链接，无需管理员）。 */
export function makeJunction(linkPath, targetPath) {
  const link = path.resolve(linkPath)
  const target = path.resolve(targetPath)
  if (fs.existsSync(link)) return
  fs.mkdirSync(path.dirname(link), { recursive: true })
  const r = run('cmd', ['/c', 'mklink', '/J', link, target])
  if (r.status !== 0) throw new Error(`mklink /J 失败: ${link} → ${target}\n${r.stderr}${r.stdout}`)
}

/** 只删 junction 链接本身（不递归进目标，防止误删真实目录内容）。 */
export function removeJunction(linkPath) {
  const link = path.resolve(linkPath)
  try {
    if (fs.existsSync(link)) fs.rmdirSync(link)
  } catch { /* 尽力而为 */ }
}

/** 临时目录（带前缀），返回绝对路径；用完 rmSync 即可。 */
export function tempDir(prefix) {
  const dir = path.join(process.env.TEMP || path.join(ROOT, '.temp-e2e'), `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
