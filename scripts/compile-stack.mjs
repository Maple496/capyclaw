#!/usr/bin/env node
/**
 * compile-stack — 把作者视图的 launchpads/*.stack DSL 编译成 dshd 需要的 dsh-stack.json。
 *
 * DSL 是作者层（launchpad 管理）；dshd 的统一清单契约是 JSON。
 * 直接 `dshd --stack xx.stack` 会报 JSON 解析错误——先跑本脚本。
 *
 * 用法:
 *   node scripts/compile-stack.mjs launchpads/dev.stack            # 输出 launchpads/dev.dsh-stack.json
 *   node scripts/compile-stack.mjs a.stack b.stack                 # 批量
 *   node scripts/compile-stack.mjs launchpads/dev.stack out.json   # 指定输出
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDsl } from '../extensions/official/capyclaw-launchpad/lib/dsl.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const [, , ...argv] = process.argv

if (!argv.length) {
  console.error('用法: node scripts/compile-stack.mjs <in.stack>... [out.json]')
  process.exit(1)
}

// 末位参数若带 .json 后缀视为显式输出（单输入时有效）
const explicitOut = argv.length >= 2 && argv.at(-1).endsWith('.json') ? argv.pop() : null
const inputs = argv

let failed = 0
for (const input of inputs) {
  const file = join(REPO, input)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    console.error(`✗ 读取失败: ${input}: ${error.message}`)
    failed += 1
    continue
  }
  const result = validateDsl(text, file)
  if (!result.ok) {
    console.error(`✗ DSL 解析失败: ${input}`)
    for (const error of result.errors) console.error(`  - ${error.message}`)
    failed += 1
    continue
  }
  for (const warning of result.warnings) console.warn(`  ! ${input}: ${warning}`)
  const output = explicitOut && inputs.length === 1 ? explicitOut : input.replace(/\.stack$/, '.dsh-stack.json')
  writeFileSync(join(REPO, output), `${JSON.stringify(result.stack, null, 2)}\n`, 'utf8')
  console.log(`✓ ${input} → ${output}（kind=${result.kind}）`)
}
process.exit(failed ? 1 : 0)
