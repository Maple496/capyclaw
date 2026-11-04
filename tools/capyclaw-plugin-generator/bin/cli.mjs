#!/usr/bin/env node
/**
 * DSH 插件生成器 CLI
 * 用法: create-plugin <plugin-name> [options]
 */

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { generatePlugin } from '../lib/index.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const args = process.argv.slice(2)
const pluginName = args[0]

if (!pluginName || pluginName.startsWith('-')) {
  console.log('用法: create-plugin <plugin-name> [options]')
  console.log('')
  console.log('示例:')
  console.log('  create-plugin my-plugin --tier 0          # 纯客户端插件')
  console.log('  create-plugin my-service --tier 1         # 标准服务插件')
  console.log('  create-plugin my-suite --tier suite       # 插件套件')
  console.log('')
  console.log('选项:')
  console.log('  --tier <0|1|2|suite>   插件层级 (默认: 0)')
  console.log('  --category <ui|service|bridge|tool|suite>   插件分类 (默认: ui)')
  console.log('  --platform <web|desktop|both>   支持平台 (默认: web)')
  console.log('  --output <path>   输出目录 (默认: extensions/official/)')
  process.exit(1)
}

// 解析选项
const options = {
  tier: 0,
  category: 'ui',
  platform: 'web',
  output: null
}

for (let i = 1; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--tier' && args[i + 1]) {
    options.tier = args[i + 1] === 'suite' ? 'suite' : parseInt(args[i + 1], 10)
    i++
  } else if (arg === '--category' && args[i + 1]) {
    options.category = args[i + 1]
    i++
  } else if (arg === '--platform' && args[i + 1]) {
    options.platform = args[i + 1]
    i++
  } else if (arg === '--output' && args[i + 1]) {
    options.output = args[i + 1]
    i++
  }
}

console.log('🚀 创建 DSH 插件:', pluginName)
console.log('━'.repeat(60))
console.log('配置:')
console.log('  层级:', options.tier)
console.log('  分类:', options.category)
console.log('  平台:', options.platform)
console.log('')

try {
  const result = await generatePlugin(pluginName, options)
  console.log('\n✅ 插件创建成功!')
  console.log('\n插件位置:', result.path)
  console.log('\n下一步:')
  console.log(`  cd ${result.path}`)
  console.log('  npm install')
  console.log(`  npm run validate-plugin -- ${result.path}`)
  console.log('')
} catch (error) {
  console.error('\n❌ 创建失败:', error.message)
  process.exit(1)
}
