#!/usr/bin/env node
/**
 * 批量修复插件配置
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

console.log('🔧 批量修复插件配置\n')

// MIT License 内容
const MIT_LICENSE = `MIT License

Copyright (c) 2026 CapyClaw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

function findCapyClawPlugins(dir) {
  const plugins = []
  
  if (!existsSync(dir)) return plugins
  
  const entries = readdirSync(dir, { withFileTypes: true })
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fullPath = join(dir, entry.name)
      
      if (entry.name.startsWith('capyclaw-')) {
        plugins.push(fullPath)
      } else if (!entry.name.startsWith('.')) {
        plugins.push(...findCapyClawPlugins(fullPath))
      }
    }
  }
  
  return plugins
}

const plugins = findCapyClawPlugins(join(rootDir, 'extensions'))

console.log(`找到 ${plugins.length} 个 CapyClaw 插件\n`)

for (const pluginPath of plugins) {
  const pluginName = pluginPath.split(/[\\/]/).pop()
  console.log(`📦 处理: ${pluginName}`)
  
  // 1. 修复 package.json
  const pkgPath = join(pluginPath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      
      // 移除 private 标记
      if (pkg.private) {
        delete pkg.private
        console.log('  ✅ 移除 private 标记')
      }
      
      // 确保有 license 字段
      if (!pkg.license) {
        pkg.license = 'MIT'
        console.log('  ✅ 添加 license: MIT')
      }
      
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    } catch (error) {
      console.log(`  ❌ 修复 package.json 失败: ${error.message}`)
    }
  }
  
  // 2. 创建 LICENSE 文件
  const licensePath = join(pluginPath, 'LICENSE')
  if (!existsSync(licensePath)) {
    try {
      writeFileSync(licensePath, MIT_LICENSE)
      console.log('  ✅ 创建 LICENSE 文件')
    } catch (error) {
      console.log(`  ❌ 创建 LICENSE 失败: ${error.message}`)
    }
  }
  
  console.log()
}

console.log('✅ 批量修复完成！')
