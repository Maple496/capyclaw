/**
 * 通用 DSH domain bundle 构建器。
 *
 * 组件来源唯一：dsh-domain.json -> dsh-suite.json。
 * 不再硬编码任何具体插件路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveDomain, stageDomain } from '../../packages/dsh-suite-kit/src/index.mjs'
import { resolveHarnessDir } from 'dsh-harness-paths'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..', '..')
export const DEFAULT_DOMAIN = path.join(REPO_ROOT, 'bridges', 'ppt-bridge', 'domains', 'ppt', 'dsh-domain.json')

// dsh 宿主目录定位的唯一实现在 dsh-harness-paths（此前三处副本靠注释同步，已实际漂移）。
function resolveHarness() {
  return resolveHarnessDir({ repoRoot: REPO_ROOT })
}
export const DEFAULT_HARNESS = resolveHarness()
export const DEFAULT_WINDOWS_NODE = path.join(REPO_ROOT, 'bundles', 'dsh-ppt-windows-bundle', 'node')

export function copyDir(src, dest, filter = () => true) {
  fs.cpSync(src, dest, { recursive: true, filter })
}

export function copyHarnessShell(harnessSource, dest, reuseNodeModules = true) {
  const files = ['auth-proxy.mjs', 'package.json', 'package-lock.json', 'process-manager.mjs', 'single-instance.mjs']
  fs.mkdirSync(dest, { recursive: true })
  for (const file of files) {
    const source = path.join(harnessSource, file)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dest, file))
  }
  const modules = path.join(harnessSource, 'node_modules')
  if (reuseNodeModules && fs.existsSync(modules)) {
    copyDir(modules, path.join(dest, 'node_modules'), (source) => {
      const base = path.basename(source)
      return base !== '.cache' && base !== '.bin'
    })
  } else {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const result = spawnSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: dest,
      stdio: 'inherit',
    })
    if (result.status !== 0) throw new Error('npm install 失败，无法准备 harness node_modules')
  }
}

function setupSource(profile) {
  return `#!/usr/bin/env node
/**
 * 首次运行初始化：创建 bundle 自己的 runtime（独立端口/DSH_HOME/namespace）。
 * 所有持久化内容都在 <bundle>/.dsh-store 下，不写用户主目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime, runtimePublicInfo } from './domain/kit/src/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const storeRoot = path.resolve(process.env.DSH_STORE_ROOT || path.join(HERE, '.dsh-store'))
const infoFile = path.join(HERE, '.runtime.json')

try {
  let info = null
  if (fs.existsSync(infoFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(infoFile, 'utf8'))
      if (saved.storeRoot === storeRoot && saved.runtimeId && fs.existsSync(path.join(saved.root || '', 'runtime.json'))) {
        info = saved
      }
    } catch { /* 重新创建 */ }
  }
  if (!info) {
    const runtime = await createRuntime({
      name: 'local',
      domainInput: path.join(HERE, 'domain', 'domain.json'),
      storeRoot,
      harnessPort: process.env.DSH_HARNESS_PORT != null ? Number(process.env.DSH_HARNESS_PORT) : undefined,
      contentPort: process.env.DSH_CONTENT_PORT != null ? Number(process.env.DSH_CONTENT_PORT) : undefined,
      runPnpm: false,
      harnessDir: path.join(HERE, 'deepseek-harness'),
      profile: process.env.DSH_PROFILE || undefined,
    })
    info = { ...runtimePublicInfo(runtime), root: runtime.paths.root }
    fs.writeFileSync(infoFile, JSON.stringify(info, null, 2) + '\\n')
  }
  fs.writeFileSync(path.join(HERE, '.runtime.env'), [
    'set DSH_PROXY_PORT=' + info.ports.harness,
    'set DSH_CONTENT_PORT=' + info.ports.content,
    '',
  ].join('\\r\\n'))
  fs.writeFileSync(path.join(HERE, '.runtime.env.sh'), [
    'export DSH_PROXY_PORT=' + info.ports.harness,
    'export DSH_CONTENT_PORT=' + info.ports.content,
    '',
  ].join('\\n'))
  console.log('[setup] runtime :', info.runtimeId)
  console.log('[setup] harness :', info.harnessUrl)
  console.log('[setup] content :', info.contentUrl)
  console.log('[setup] store   :', info.storeRoot)
} catch (error) {
  console.error('[setup] 初始化失败:', error && error.message || error)
  process.exit(1)
}
`
}

function launchSource() {
  return `#!/usr/bin/env node
/** 读取 setup.mjs 生成的 .runtime.json，前台启动该 runtime。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from './domain/kit/src/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const info = JSON.parse(fs.readFileSync(path.join(HERE, '.runtime.json'), 'utf8'))
const result = await startRuntime({
  storeRoot: info.storeRoot,
  runtimeId: info.runtimeId,
  harnessDir: path.join(HERE, 'deepseek-harness'),
  detached: false,
  waitMs: 30000,
})
if (result.alreadyRunning) {
  console.log('[launch] runtime 已在运行')
  process.exit(0)
}
if (result.child) {
  if (result.child.exitCode != null) process.exit(result.child.exitCode)
  const code = await new Promise((resolve) => result.child.once('exit', (value) => resolve(value ?? 0)))
  process.exit(code)
}
`
}

function startBat(profile) {
  return `@echo off
setlocal
chcp 65001 >nul
title DSH Bundle

cd /d "%~dp0"

if exist "%~dp0node\\node.exe" set "PATH=%~dp0node;%PATH%"

node setup.mjs
if errorlevel 1 (
  echo [ERROR] setup failed.
  pause
  exit /b 1
)

if exist "%~dp0.runtime.env" call "%~dp0.runtime.env"

if exist "%~dp0.runtime.env" call "%~dp0.runtime.env"

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 10; Start-Process 'http://localhost:%DSH_PROXY_PORT%/'; Start-Sleep 2; Start-Process 'http://127.0.0.1:%DSH_CONTENT_PORT%/'"

node launch.mjs
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" (
  echo [ERROR] service exited with code %EXITCODE%.
) else (
  echo Service stopped.
)
pause
`
}

function startSh(profile) {
  return `#!/bin/bash
set -e
cd "$(dirname "$0")"
node setup.mjs
if [ -f .runtime.env.sh ]; then source .runtime.env.sh; fi
node launch.mjs
`
}

function startSilent() {
  return `Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd /c start.bat", 0, False
`
}

function readmeSource({ title, domain, profile }) {
  return `# ${title || domain.name}

DSH 领域包：\`${domain.name}\`（runtime: \`${profile}\`）。

## 启动

- Windows：双击 \`start.bat\`
- macOS / Linux：\`bash start.sh\`

首次启动会运行 \`setup.mjs\`，在 \`<bundle>/.dsh-store\` 下创建一个独立 runtime：
独立 harness/content 端口、独立 DSH_HOME 和 workspace、独立内容 namespace。
所有落盘内容都在这个目录下，不会写入用户主目录。

## 手动初始化

\`\`\`bash
node setup.mjs
node launch.mjs
\`\`\`

\`setup.mjs\` 会把端口和 URL 写到 \`.runtime.json\`。
`
}

function writeText(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, mode ? { mode } : undefined)
}

/**
 * 构建 bundle。
 * @param {{
 *   domainInput?: string, outDir: string, target?: 'portable'|'windows',
 *   title?: string, harnessSource?: string, nodeDir?: string,
 *   skipRuntime?: boolean, reuseNodeModules?: boolean, clean?: boolean
 * }} options
 */
export async function buildBundle(options) {
  if (!options?.outDir) throw new Error('buildBundle: outDir 必填')
  const target = options.target || 'portable'
  if (!['portable', 'windows'].includes(target)) throw new Error(`未知 target: ${target}`)
  const domainInput = path.resolve(options.domainInput || DEFAULT_DOMAIN)
  const outDir = path.resolve(options.outDir)
  const resolved = resolveDomain(domainInput)
  const domain = resolved.manifest
  const profile = domain.profile?.name || `domain-${domain.name}`
  const nodeDir = target === 'windows'
    ? path.resolve(options.nodeDir || DEFAULT_WINDOWS_NODE)
    : null
  if (nodeDir && options.clean !== false && (nodeDir === outDir || nodeDir.startsWith(outDir + path.sep))) {
    throw new Error('node 运行时目录不能位于输出目录内（会被清理）')
  }

  if (options.clean !== false) fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const domainDir = path.join(outDir, 'domain')
  stageDomain({ domainInput, outDir: domainDir })

  if (!options.skipRuntime) {
    const harnessOut = path.join(outDir, 'deepseek-harness')
    copyHarnessShell(options.harnessSource || DEFAULT_HARNESS, harnessOut, options.reuseNodeModules !== false)
    if (target === 'windows') {
      if (!fs.existsSync(path.join(nodeDir, 'node.exe'))) {
        throw new Error(`找不到 Windows node 运行时: ${nodeDir}（用 --node-dir 指定）`)
      }
      copyDir(nodeDir, path.join(outDir, 'node'))
    }
  }

  writeText(path.join(outDir, 'setup.mjs'), setupSource(profile))
  writeText(path.join(outDir, 'launch.mjs'), launchSource(), 0o755)
  writeText(path.join(outDir, 'start.bat'), startBat(profile))
  writeText(path.join(outDir, 'start.sh'), startSh(profile), 0o755)
  if (target === 'windows') writeText(path.join(outDir, 'start-silent.vbs'), startSilent())
  writeText(path.join(outDir, 'README.md'), readmeSource({ title: options.title, domain, profile }))

  const manifest = {
    name: domain.name,
    title: options.title || domain.title || domain.name,
    version: domain.version,
    target,
    profile,
    baseBundles: domain.baseBundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    runtime: {
      driver: domain.runtime?.driver || 'node',
      workId: domain.runtime?.workId || 'main',
      requires: domain.runtime?.requires || {},
      scope: domain.runtime?.scope || {},
    },
    suites: resolved.suites.map((suite) => suite.manifest.name),
    packages: resolved.composed.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.entry.version,
      role: pkg.entry.role,
    })),
    createdAt: new Date().toISOString(),
  }
  writeText(path.join(outDir, 'bundle.manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  return { outDir, manifest, domainDir }
}
