/**
 * 插件验证器测试
 */

import { validatePlugin } from '../lib/index.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = join(__dirname, '../../..')

console.log('🧪 测试插件验证器\n')

// 测试 1: 验证标准插件
console.log('测试 1: 验证 port-sidebar...')
const portSidebarPath = join(rootDir, 'extensions/official/dsh-port-sidebar')
const result1 = await validatePlugin(portSidebarPath)
console.log(result1.valid ? '✅ 通过' : '❌ 失败')
if (!result1.valid) {
  console.log('错误:', result1.errors.map(e => `[${e.rule}] ${e.message}`).join('\n'))
}
if (result1.warnings.length > 0) {
  console.log('警告:', result1.warnings.join('\n'))
}

console.log('\n✅ 测试完成')
process.exit(result1.valid ? 0 : 1)
