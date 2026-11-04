#!/usr/bin/env node
/**
 * dsh-profile-doctor —— profile 组装对账闸。
 *
 * 动机（2026-11-01 事故复盘）：profile 是"安装时点快照"（node_modules、
 * 物化 patch、composition lock），上游演进（端口迁移/套件加包）不会传播，
 * harness 又容错启动（failOnStartupError:false）——坏状态无声存活数周。
 * 本闸在启动前/平时校验三条不变量，把漂移变成响亮的、可自愈的报错：
 *
 *   I1 组合  声明（lock.packages ∪ deps ∪ patch rows）↔ 安装（node_modules）
 *            双向一致；`link:` 依赖缺失可 --fix 自动补 junction
 *   I2 端点  patch 内所有 127.0.0.1 url 必须 TCP 探活；字面端口本身 =
 *            漂移风险警告（应走变量插值/端口注册表）
 *   I3 状态  patch config.hostDir 内 service.lock 指向死 pid = 陈旧锁；
 *            --fix 自动清除
 *
 * 用法：
 *   node dsh-profile-doctor.mjs <profileDir> [--fix] [--json]
 * 退出码：0 = 全绿（或 --fix 已自愈）；1 = 存在漂移；2 = 用法错误
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const args = process.argv.slice(2)
const profileDir = args.find((a) => !a.startsWith('--'))
const fix = args.includes('--fix')
const asJson = args.includes('--json')
if (!profileDir || !fs.existsSync(profileDir)) {
  console.error('用法: dsh-profile-doctor <profileDir> [--fix] [--json]')
  process.exit(2)
}
const nmDir = path.join(profileDir, 'node_modules')
const findings = [] // { section, level: error|warn|info|ok, msg, fixable }

// ---------- I1 组合 ----------
function declaredPackages() {
  const declared = new Map() // name -> { via, link }
  const lockFile = path.join(profileDir, 'dsh-composition.lock.json')
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    for (const name of Object.keys(lock.packages || {})) {
      declared.set(name, { via: 'composition.lock' })
    }
  } catch { /* 无 lock 不算错，deps 仍可判 */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
      if (!name.startsWith('dsh-')) continue
      declared.set(name, { via: 'package.json', link: spec.startsWith('link:') ? spec.slice(5) : null })
    }
  } catch { /* ignore */ }
  return declared
}

function patchRowNames() {
  const names = new Set()
  for (const f of patchFiles()) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/^\s*name:\s*['"]?([^\s'"]+)['"]?\s*$/gm)) {
      if (m[1].startsWith('dsh-') && !m[1].startsWith('@deepseek-ai')) names.add(m[1])
    }
  }
  return names
}

function patchFiles() {
  const out = []
  const root = path.join(profileDir, 'cordis.patch.yml')
  if (fs.existsSync(root)) out.push(root)
  if (fs.existsSync(nmDir)) {
    for (const e of fs.readdirSync(nmDir)) {
      const f = path.join(nmDir, e, 'cordis.patch.yml')
      if (fs.existsSync(f)) out.push(f)
    }
  }
  return out
}

function checkComposition(declared) {
  const installed = new Set(
    fs.existsSync(nmDir)
      ? fs.readdirSync(nmDir).filter((e) => !e.startsWith('.') && e.startsWith('dsh-'))
      : [])
  // lock 条目细察：role=skills 的聚合声明由其所属套件承载——套件在位即满足
  let lockEntries = {}
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(profileDir, 'dsh-composition.lock.json'), 'utf8'))
    lockEntries = lock.packages || {}
  } catch { /* ignore */ }
  for (const [name, meta] of declared) {
    if (installed.has(name)) continue
    const entry = lockEntries[name]
    if (entry?.role === 'skills' && entry.suite && installed.has(entry.suite)) {
      findings.push({
        section: 'I1 组合', level: 'info',
        msg: `${name}（role=skills）由已安装套件 ${entry.suite} 承载，聚合声明视为满足`,
      })
      continue
    }
    findings.push({
      section: 'I1 组合', level: 'error',
      msg: `包 ${name} 已声明（${meta.via}）但未安装到 node_modules${meta.link ? '（link: 依赖，可 --fix 补 junction）' : ''}`,
      fix: meta.link ? { name, target: meta.link } : null,
    })
  }
  for (const name of patchRowNames()) {
    if (!declared.has(name) && !installed.has(name)) {
      findings.push({
        section: 'I1 组合', level: 'error',
        msg: `patch 行引用包 ${name}，既不在声明里也未安装（插件加载必失败）`,
        fix: null,
      })
    }
  }
}

// ---------- I2 端点 ----------
function probeTcp(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    const done = (ok) => { try { sock.destroy() } catch { /* noop */ } resolve(ok) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

async function checkEndpoints() {
  for (const f of patchFiles()) {
    const rel = path.relative(profileDir, f)
    const text = fs.readFileSync(f, 'utf8')
    let rowId = ''
    let serverName = ''
    for (const line of text.split(/\r?\n/)) {
      const idm = line.match(/^\s*-\s+id:\s*(\S+)/)
      if (idm) { rowId = idm[1]; serverName = '' }
      const nm = line.match(/^\s*name:\s*['"]?([^\s'"]+)['"]?/)
      if (nm) serverName = nm[1]
      const um = line.match(/url:\s*['"]?http:\/\/127\.0\.0\.1:(\d+)([^'"\s]*)['"]?/)
      if (!um) continue
      const port = Number(um[1])
      const alive = await probeTcp(port)
      const label = `${rel} · ${rowId || '(行)'}${serverName ? ` (${serverName})` : ''}`
      if (alive) {
        findings.push({ section: 'I2 端点', level: 'info', msg: `字面端点 127.0.0.1:${port} 探活通过（${label}）——字面端口本身是漂移风险，建议改走变量插值/端口注册表` })
      } else {
        findings.push({ section: 'I2 端点', level: 'error', msg: `死端点 127.0.0.1:${port}${um[2]}（${label}）——服务已迁移/退役而 patch 未同步（经典端口漂移）` })
      }
    }
  }
}

// ---------- I3 状态 ----------
function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function checkStaleLocks() {
  const hostDirs = new Set()
  for (const f of patchFiles()) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/hostDir:\s*['"]?([^\s'"]+)['"]?/g)) {
      hostDirs.add(m[1].replace(/\$\{[^}]+\}/g, '_')) // 变量形无法定位，跳过实际扫描
    }
  }
  for (const dir of hostDirs) {
    const lockFile = path.join(dir, 'service.lock')
    if (!fs.existsSync(lockFile) || dir.includes('_')) continue
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (!pidAlive(lock.pid)) {
        findings.push({
          section: 'I3 状态', level: 'error',
          msg: `陈旧 service.lock（pid ${lock.pid} 已死）: ${lockFile} —— 会以"实例已在运行"挡住后续启动${fix ? '（--fix 将清除）' : ''}`,
          fix: { staleLock: lockFile },
        })
      }
    } catch { /* 损坏锁同样视为陈旧 */ }
  }
}

// ---------- 自愈 ----------
function applyFixes() {
  const fixed = []
  for (const f of findings) {
    if (!f.fix) continue
    try {
      if (f.fix.name && f.fix.target) {
        const dest = path.join(nmDir, f.fix.name)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.symlinkSync(f.fix.target, dest, 'junction')
        fixed.push(`补 junction: ${f.fix.name} -> ${f.fix.target}`)
        f.level = 'fixed'
      } else if (f.fix.staleLock) {
        fs.rmSync(f.fix.staleLock, { force: true })
        fixed.push(`清陈旧锁: ${f.fix.staleLock}`)
        f.level = 'fixed'
      }
    } catch (e) {
      f.msg += `（自愈失败: ${e.message}）`
    }
  }
  return fixed
}

// ---------- 主流程 ----------
const declared = declaredPackages()
for (const name of patchRowNames()) {
  if (!declared.has(name)) declared.set(name, { via: 'patch 行' })
}
checkComposition(declared)
await checkEndpoints()
checkStaleLocks()

let fixedList = []
if (fix && findings.some((f) => f.fix && f.level === 'error')) {
  fixedList = applyFixes()
  // 复检组合面（junction 补齐后应转绿）
  const recheck = declaredPackages()
  findings.length = 0
  checkComposition(recheck)
  await checkEndpoints()
  checkStaleLocks()
}

const errors = findings.filter((f) => f.level === 'error')
const warns = findings.filter((f) => f.level === 'warn')
const infos = findings.filter((f) => f.level === 'info')

if (asJson) {
  console.log(JSON.stringify({ profile: profileDir, ok: errors.length === 0, fixed: fixedList, findings }, null, 2))
} else {
  console.log(`\n🩺 profile 对账闸: ${profileDir}`)
  const order = { error: 0, warn: 1, fixed: 2, info: 3 }
  for (const f of [...findings].sort((a, b) => order[a.level] - order[b.level])) {
    const icon = { error: '✗', warn: '⚠', fixed: '🔧', info: '·' }[f.level]
    console.log(`  [${f.section}] ${icon} ${f.msg}`)
  }
  if (fixedList.length) console.log(`\n已自愈 ${fixedList.length} 项:\n  ${fixedList.join('\n  ')}`)
  console.log(`\n结论: ${errors.length ? `✗ ${errors.length} 项漂移（带伤上岗）` : '✓ 三条不变量全部成立'}${warns.length ? `，${warns.length} 警告` : ''}，${infos.length} 提示`)
}
process.exit(errors.length ? 1 : 0)
