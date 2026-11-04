#!/usr/bin/env node
/**
 * PPT 工作台插件 - 独立启动脚本
 * 可以不依赖 DeepSeek Harness 独立运行
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 加载插件
const pluginPath = path.join(HERE, 'lib', 'host.mjs')
const pluginUrl = pathToFileURL(pluginPath).href
const plugin = await import(pluginUrl)

console.log('🚀 正在启动 PPT 工作台插件...\n')

// 创建模拟的 ctx 对象
const mockCtx = {
  on: () => {},
  emit: () => {},
}

// 启动插件
const config = {
  port: 39311,
}

try {
  const disposer = await plugin.apply(mockCtx, config)
  
  console.log('\n✅ 插件启动成功！\n')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('📊 PPT 工作台')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🌐 UI 界面: http://127.0.0.1:39311')
  console.log('🔌 WebSocket: ws://127.0.0.1:39311/ws')
  console.log('🛠️  MCP 工具: http://127.0.0.1:39311/mcp')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  console.log('💡 测试命令:')
  console.log('  在浏览器打开: http://127.0.0.1:39311')
  console.log('  测试 MCP: curl http://127.0.0.1:39311/api/status')
  console.log('\n按 Ctrl+C 停止服务\n')
  
  // 处理退出信号
  process.on('SIGINT', async () => {
    console.log('\n\n正在停止服务...')
    if (disposer) {
      await disposer()
    }
    process.exit(0)
  })
  
} catch (error) {
  console.error('❌ 启动失败:', error)
  process.exit(1)
}
