/**
 * 把 ppt-bridge/dsh/ 同步到 dsh 运行时（可重复执行）。
 * 用法：node scripts/install-dsh.mjs
 * 环境变量（缺省为本机路径）：
 *   DSH_ROOT  dsh 安装根（缺省本仓 apps/harness/deepseek-harness）
 *   DSH_HOME  专属实例 home（.dsh-keynote）
 *
 * 同步内容：
 *   workspace-keynote/AGENTS.md                  → DSH_ROOT/workspace-keynote
 *   AGENTS.md                                    → 首用工作区 keynote-docs/...
 *   .dsh/skills/（可选，存在时）                   → 上述两个工作区
 *   profile-patch.yml                            → DSH_ROOT/workspace-keynote 与
 *                                                 DSH_HOME/profiles/keynote（若存在）
 *
 * 工具用法以 workbench 的 MCP instructions 为准；不再附带 raw-curl 的
 * keynote-bridge skill（与 AGENTS.md 的「只走 mcp__ppt__*」冲突）。
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = join(ROOT, 'dsh')
const DSH_ROOT = process.env.DSH_ROOT || resolve(ROOT, '..', '..', '..', 'apps', 'harness', 'deepseek-harness')
const DSH_HOME = process.env.DSH_HOME || join(DSH_ROOT, '.dsh-keynote')
const WORKSPACE = join(DSH_ROOT, 'workspace-keynote')
const FIRST_WS = join(DSH_ROOT, 'keynote-docs', 'deepseek-harness', 'default-workspace')

function copyTree(from, to) {
  if (!existsSync(from)) return 0
  mkdirSync(to, { recursive: true })
  let n = 0
  for (const name of readdirSync(from)) {
    const a = join(from, name), b = join(to, name)
    if (statSync(a).isDirectory()) n += copyTree(a, b)
    else { copyFileSync(a, b); n++ }
  }
  return n
}

if (!existsSync(DSH_ROOT)) throw new Error('DSH_ROOT 不存在: ' + DSH_ROOT)

let n = 0
/* 1. 专属 workspace（auth-proxy 的 DSH_WORKSPACE 指向这里） */
n += copyTree(join(SRC, 'skills'), join(WORKSPACE, '.dsh', 'skills'))
if (existsSync(join(SRC, 'AGENTS.md'))) {
  copyFileSync(join(SRC, 'AGENTS.md'), join(WORKSPACE, 'AGENTS.md')); n++
}
/* 2. 首用工作区（dsh 实际 session cwd） */
n += copyTree(join(SRC, 'skills'), join(FIRST_WS, '.dsh', 'skills'))
if (existsSync(join(SRC, 'AGENTS.md'))) {
  copyFileSync(join(SRC, 'AGENTS.md'), join(FIRST_WS, 'AGENTS.md')); n++
}
/* 3. profile 补丁（auth-proxy 创建 profile 时拷贝） */
if (existsSync(join(SRC, 'profile-patch.yml'))) {
  copyFileSync(join(SRC, 'profile-patch.yml'), join(WORKSPACE, 'profile-patch.yml')); n++
  const prof = join(DSH_HOME, 'profiles', 'keynote', 'cordis.patch.yml')
  if (existsSync(dirname(prof))) { copyFileSync(join(SRC, 'profile-patch.yml'), prof); n++ }
}
console.log(`✓ dsh 同步 ${n} 个文件 → ${DSH_ROOT}`)
