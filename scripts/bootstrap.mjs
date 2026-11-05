#!/usr/bin/env node
/**
 * 开发环境一键重建：clone 后只需 `npm run bootstrap`（或 node scripts/bootstrap.mjs）。
 *
 *   1. node 版本闸（engines >=20；.nvmrc 记录推荐版本）
 *   2. npm install（workspace 链接 + package-lock 精确还原）
 *   3. playwright chromium（L6 真浏览器层的隐性依赖，浏览器二进制不进 node_modules）
 *   4. 快速冒烟 L1（秒级，证明工作区可用；--full 跑六层）
 *
 * 幂等：重复执行无副作用。细节见 docs/DEVENV.md。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const FULL = args.includes('--full')
const SKIP_SMOKE = args.includes('--skip-smoke')
const MIN_NODE = 20

const say = (s) => console.log(`\n== ${s}`)
const ok = (s) => console.log(`✓ ${s}`)
const bad = (s) => { console.error(`✗ ${s}`); process.exit(1) }

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    cwd: ROOT, encoding: 'utf8', stdio: 'inherit',
    shell: process.platform === 'win32', ...opts,
  })
}

/* 1. node 版本闸 */
say(`node 版本（要求 >=${MIN_NODE}）`)
const [major] = process.versions.node.split('.').map(Number)
if (major < MIN_NODE) {
  bad(`当前 node ${process.versions.node} < ${MIN_NODE}。用 nvm：nvm install && nvm use（.nvmrc=${fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim()}）`)
}
ok(`node ${process.versions.node}`)

/* 2. 依赖还原 */
say('npm install（workspace 链接，按 package-lock 精确还原）')
if (run('npm', ['install', '--no-audit', '--no-fund']).status !== 0) bad('npm install 失败')
ok('依赖就绪')

/* 3. playwright 浏览器（L6 隐性依赖） */
say('playwright chromium（L6 真浏览器层）')
const pw = run('npx', ['playwright', 'install', 'chromium'])
if (pw.status !== 0) {
  if (process.platform !== 'win32') {
    console.log('! Linux 缺系统库时执行：sudo npx playwright install-deps chromium')
  }
  bad('playwright install chromium 失败')
}
ok('chromium 就绪')

/* 4. 冒烟 */
if (!SKIP_SMOKE) {
  say(FULL ? '全量六层 e2e' : '快速冒烟 L1（--full 可跑六层）')
  const layer = FULL ? [] : ['--layer', 'l1']
  if (run('node', ['scripts/e2e-all.mjs', ...layer]).status !== 0) bad('冒烟失败')
  ok('工作区可用')
}

console.log(`\n环境就绪。常用命令：
  npm run build          构建全部插件包产物
  npm run test:e2e       六层验证（65+ 项）
  npm run verify:install 沙箱验证 npm 渠道安装形态（删除→重装→实测）
  npm run release        发布流水线（zip + index + registry，不发布）`)
