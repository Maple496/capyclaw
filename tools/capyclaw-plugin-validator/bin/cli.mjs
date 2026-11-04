#!/usr/bin/env node
/**
 * DSH 插件验证 CLI
 * 用法: validate-plugin <plugin-path>
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { validatePlugin } from '../lib/index.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const pluginPath = process.argv[2]

if (!pluginPath) {
  console.error('用法: validate-plugin <plugin-path>')
  console.error('示例: validate-plugin extensions/official/port-sidebar')
  process.exit(1)
}

const absolutePath = resolve(process.cwd(), pluginPath)

console.log('🔍 验证插件:', absolutePath)
console.log('━'.repeat(60))

try {
  const result = await validatePlugin(absolutePath)
  
  if (result.valid) {
    console.log('\n✅ 验证通过！所有检查项合规。\n')
    if (result.warnings.length > 0) {
      console.log('⚠️  警告:')
      result.warnings.forEach(w => console.log('   -', w))
    }
    process.exit(0)
  } else {
    console.log('\n❌ 验证失败！发现以下问题:\n')
    result.errors.forEach((err, i) => {
      console.log(`${i + 1}. [${err.rule}] ${err.message}`)
      if (err.hint) console.log(`   提示: ${err.hint}`)
    })
    console.log()
    process.exit(1)
  }
} catch (error) {
  console.error('\n💥 验证过程出错:', error.message)
  process.exit(1)
}
