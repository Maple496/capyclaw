#!/usr/bin/env node
/**
 * 一次性修复脚本:把全部 package.json 的 repository/homepage/bugs
 * 统一指向 github.com/Maple496/capyclaw(monorepo 根)。
 *
 * 用法:node scripts/fix-repo-fields.mjs [--check]
 *   --check 只报告,不写文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const REPO_URL = 'git+https://github.com/Maple496/capyclaw.git'
const REPO_HTTPS = 'https://github.com/Maple496/capyclaw'
const CHECK = process.argv.includes('--check')

const dirs = execSync(
  'find . -name package.json -not -path "*/node_modules/*" -not -path "*/test/*" -not -path "*/fixtures/*" -not -path "*/examples/*" -not -path "*/dist/*"',
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
  .map((f) => path.dirname(f))

let fixedWrong = 0, added = 0, alreadyOk = 0

for (const dir of dirs) {
  const file = path.join(ROOT, dir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    console.log(`SKIP(parse) ${dir}`)
    continue
  }
  if (!pkg.name) continue

  const relDir = dir.replace(/^\.\/?/, '').replace(/\\/g, '/')
  const repoField = {
    type: 'git',
    url: REPO_URL,
    ...(dir === '.' ? {} : { directory: relDir }),
  }
  const homepage = dir === '.' ? REPO_HTTPS : `${REPO_HTTPS}/tree/main/${relDir}#readme`
  const bugs = { url: `${REPO_HTTPS}/issues` }

  const curUrl = pkg.repository ? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url) : null
  if (curUrl === REPO_URL) {
    alreadyOk++
    continue
  }
  const action = curUrl ? 'FIX(wrong-url)' : 'ADD(missing)'
  if (curUrl) fixedWrong++
  else added++

  if (!CHECK) {
    pkg.repository = repoField
    pkg.bugs = bugs
    if (!pkg.homepage) pkg.homepage = homepage
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  }
  console.log(`${action} ${pkg.name} (${relDir || 'root'})`)
}

console.log(`\n合计: 修正错误URL=${fixedWrong} 新增=${added} 已正确=${alreadyOk} ${CHECK ? '(check模式,未写入)' : ''}`)
