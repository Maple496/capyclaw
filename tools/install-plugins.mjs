#!/usr/bin/env node
/**
 * 插件安装器（适配 dsh 原生机制）
 *
 * 用法:
 *   node tools/install-plugins.mjs --registry <url-or-file> --target <profile-dir>
 *
 * 做什么:
 *   1. 读 capyclaw-registry.json（本地文件或 HTTP）
 *   2. 下载/复制插件到目标目录
 *   3. 修改 profile 的 package.json（加 dependencies + bundles）
 *   4. 运行 pnpm install（让 dsh 原生机制接管）
 *
 * 为什么这样设计:
 *   - 开发阶段: registry 指向本地 dist/，直接 link
 *   - 生产阶段: registry 指向 npm，改用版本号（"^1.0.0"）
 *   - dsh 更新后: 只要 package.json 格式不变，就能继续用
 */
import { readFileSync, existsSync, mkdirSync, cpSync, writeFileSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { homedir } from 'os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function run(cmd, args, { cwd = process.cwd() } = {}) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败（${result.status}）`)
}

async function fetchRegistry(source) {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    console.log(`⏳ 下载 registry: ${source}`)
    const res = await fetch(source)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
  const path = resolve(source)
  if (!existsSync(path)) die(`registry 不存在: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function ensureProfileStructure(profileDir) {
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true })
  }
  const pkgPath = join(profileDir, 'package.json')
  if (!existsSync(pkgPath)) {
    const profile = {
      name: `dsh-profile-${dirname(profileDir).split(/[/\\]/).pop()}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }
    writeFileSync(pkgPath, JSON.stringify(profile, null, 2))
  }
  return pkgPath
}

/**
 * 核心：适配 dsh 原生 package.json 机制
 *
 * 开发阶段: dependencies[name] = "link:/path/to/dist"
 * 生产阶段: dependencies[name] = "^1.0.0"（npm registry）
 */
function updateProfilePackage(pkgPath, plugins, mode = 'development') {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.dependencies = pkg.dependencies || {}
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []

  const existing = new Set(pkg.dsh.profile.bundles)

  for (const plugin of plugins) {
    const { name, version, path: distPath } = plugin

    // 开发模式: link 本地路径
    if (mode === 'development') {
      if (!distPath) die(`开发模式下插件 ${name} 缺少 path`)
      const abs = resolve(REPO, distPath)
      if (!existsSync(join(abs, 'package.json'))) {
        die(`插件路径无效: ${abs}`)
      }
      pkg.dependencies[name] = `link:${abs}`
    }
    // 生产模式: 用 npm 版本号
    else if (mode === 'production') {
      if (!version) die(`生产模式下插件 ${name} 缺少 version`)
      pkg.dependencies[name] = `^${version}`
    }

    // 加入 bundles（dsh 的激活列表）
    if (!existing.has(name)) {
      pkg.dsh.profile.bundles.push(name)
      existing.add(name)
    }
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`✓ 已更新 ${pkgPath}`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('--help')) {
    console.log(`用法:
  开发模式（link 本地 dist）:
    node tools/install-plugins.mjs --registry ./capyclaw-registry.json --target ~/.dsh/profiles/web --mode development

  生产模式（用 npm 版本）:
    node tools/install-plugins.mjs --registry https://your-cdn.com/registry.json --target ~/.dsh/profiles/web --mode production

选项:
  --registry <url-or-file>  registry 位置（本地文件或 HTTP）
  --target <profile-dir>    目标 profile 目录（默认 ~/.dsh/profiles/web）
  --mode <dev|prod>         development（link 本地）或 production（npm 版本），默认 development
  --install                 自动运行 pnpm install
`)
    process.exit(0)
  }

  const registryIdx = args.indexOf('--registry')
  const targetIdx = args.indexOf('--target')
  const modeIdx = args.indexOf('--mode')
  const autoInstall = args.includes('--install')

  const registrySource = registryIdx > -1 ? args[registryIdx + 1] : join(REPO, 'capyclaw-registry.json')
  const targetDir = targetIdx > -1 ? args[targetIdx + 1] : join(homedir(), '.dsh/profiles/web')
  const mode = modeIdx > -1 ? args[modeIdx + 1] : 'development'

  if (!['development', 'production'].includes(mode)) {
    die(`--mode 只能是 development 或 production，收到: ${mode}`)
  }

  console.log(`registry: ${registrySource}`)
  console.log(`target:   ${targetDir}`)
  console.log(`mode:     ${mode}\n`)

  // 1. 读 registry
  const registry = await fetchRegistry(registrySource)
  const plugins = registry.plugins || []
  console.log(`发现 ${plugins.length} 个插件\n`)

  // 2. 确保 profile 结构存在
  const pkgPath = ensureProfileStructure(targetDir)

  // 3. 更新 package.json（适配 dsh 原生机制）
  updateProfilePackage(pkgPath, plugins, mode)

  // 4. 运行 pnpm install（让 dsh 的包管理接管）
  if (autoInstall) {
    console.log('\n⏳ 运行 pnpm install...')
    try {
      run('pnpm', ['install'], { cwd: targetDir })
      console.log('✓ 依赖安装完成')
    } catch (error) {
      console.error(`✗ pnpm install 失败: ${error.message}`)
      console.error('  你需要手动运行: cd ${targetDir} && pnpm install')
    }
  } else {
    console.log(`\n下一步: cd ${targetDir} && pnpm install`)
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`✓ 插件已注册到 ${targetDir}`)
  console.log(`  模式: ${mode}`)
  console.log(`  启动: dsh --profile ${dirname(targetDir).split(/[/\\]/).pop()}`)
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
