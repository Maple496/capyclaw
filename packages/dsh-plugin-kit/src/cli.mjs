/**
 * CLI 脚手架（纯函数，无副作用）。
 *
 * 全仓 8+ 个 bin 脚本各自手写参数解析/导入守卫/失败退出——这里收敛为一套：
 * 新的 bin 只需要写「命令表 + 用法文本 + 业务逻辑」，解析与守卫交给本模块。
 *
 *   import { parseArgs, isMain, fail } from '@capyclaw/plugin-kit'
 *
 *   const commands = { async do(arg, flags) { … } }
 *   if (isMain(import.meta.url)) { … dispatch & print usage … }
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 解析命令行：位置参数与 `--flag`/`--flag value` 混排。
 * @param {string[]} argv - 不含 node 与脚本路径的原始参数
 * @returns {{ positional: string[], flags: Record<string, string|boolean> }}
 *   `--flag value` → 字符串；`--flag`（后随缺失或另一个 -- 项）→ true；`--flag=x` → 字符串
 */
export function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 2) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
        continue
      }
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ }
      else flags[key] = true
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

/**
 * 导入守卫：仅当本模块被直接执行（而非被测试/其他模块 import）时为 true。
 * @param {string} importMetaUrl - 调用方的 import.meta.url
 */
export function isMain(importMetaUrl, argv = process.argv) {
  const entry = argv[1] ? pathToFileURL(resolve(argv[1])).href : ''
  return importMetaUrl === entry
}

/** 统一失败出口：打印 ✗ 后以非零码退出。 */
export function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}
