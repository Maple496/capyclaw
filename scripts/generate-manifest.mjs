#!/usr/bin/env node
/**
 * DSH 插件清单生成器
 * 
 * 功能：扫描所有插件，生成 services.json 清单
 * 利用：DSH 自带的 manifest.mjs 和 engine.mjs
 */

import { glob } from 'glob';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const profile = process.argv[2] || 'minimal';
const rootDir = process.cwd();

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  DSH 插件清单生成器                                      ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// 1. 扫描所有插件
console.log('🔍 扫描插件...\n');

const patterns = [
  'extensions/**/dsh-suite.json',
  'examples/plugins/**/dsh-suite.json'
];

const suiteFiles = [];
for (const pattern of patterns) {
  const files = await glob(pattern, { cwd: rootDir, absolute: true });
  suiteFiles.push(...files);
}

console.log(`   发现 ${suiteFiles.length} 个插件\n`);

// 2. 解析插件并提取服务
const allPlugins = [];
const allServices = [];

for (const file of suiteFiles) {
  try {
    const content = await readFile(file, 'utf-8');
    const suite = JSON.parse(content);
    const suiteDir = path.dirname(file);
    
    const plugin = {
      id: suite.name,
      name: suite.title || suite.name,
      version: suite.version,
      path: suiteDir,
      file: file
    };
    
    allPlugins.push(plugin);
    console.log(`   ✓ ${plugin.name} (${plugin.id})`);
    
    // 提取服务定义（从 rows）
    if (suite.rows) {
      for (const row of suite.rows) {
        // 跳过 MCP 客户端（不是服务）
        if (row.name === '@deepseek-ai/dsh-mcp-client') continue;
        
        allServices.push({
          ...row,
          _plugin: suite.name,
          _pluginName: plugin.name,
          _suiteDir: suiteDir
        });
      }
    }
  } catch (error) {
    console.warn(`   ⚠️  跳过: ${file} (${error.message})`);
  }
}

console.log(`\n📊 统计:`);
console.log(`   插件数: ${allPlugins.length}`);
console.log(`   服务数: ${allServices.length}\n`);

// 3. 根据 profile 筛选服务
console.log(`📋 配置文件: ${profile}\n`);

const profiles = {
  empty: [],
  minimal: ['llm-config'],
  development: allServices.map(s => s.id),
  production: ['llm-config', 'ppt']
};

const enabledIds = new Set(profiles[profile] || profiles.minimal);
const selectedServices = enabledIds.size === 0 ? [] :
  allServices.filter(s => 
    Array.from(enabledIds).some(keyword => 
      s.id.includes(keyword) || 
      s._plugin.includes(keyword) ||
      s.name?.includes(keyword)
    )
  );

console.log(`   启用服务: ${selectedServices.length}/${allServices.length}\n`);

for (const service of selectedServices) {
  console.log(`   ✅ ${service.id} (${service._pluginName})`);
}

if (selectedServices.length === 0) {
  console.log(`   (空清单 - 所有服务禁用)`);
}

// 4. 生成 DSH 原生格式的 services.json
const manifest = {
  services: selectedServices.map(service => {
    const config = service.config || {};
    
    // 构建 DSH 服务定义
    const spec = {
      id: service.id,
      port: config.port
    };
    
    // 添加可选字段
    if (service.name && service.name !== '@deepseek-ai/dsh-mcp-client') {
      spec.name = service.name;
    }
    
    if (config.cwd) {
      spec.cwd = config.cwd.replace(/\$\{PACKAGE_DIR\}/g, service._suiteDir);
    }
    
    if (config.url) {
      spec.url = config.url;
    } else if (config.port) {
      spec.url = `http://localhost:${config.port}`;
    }
    
    if (service.cmd) {
      spec.cmd = service.cmd;
    }
    
    if (config.env) {
      spec.env = config.env;
    }
    
    if (config.logFile) {
      spec.logFile = config.logFile;
    }
    
    // 默认 keepAlive
    spec.keepAlive = config.keepAlive !== false;
    
    return spec;
  })
};

// 5. 保存清单
const outputDir = path.join(rootDir, 'config/manifests');
await mkdir(outputDir, { recursive: true });

const outputFile = path.join(outputDir, `services.${profile}.json`);
await writeFile(outputFile, JSON.stringify(manifest, null, 2), 'utf-8');

console.log(`\n✅ 已生成清单: config/manifests/services.${profile}.json`);

// 6. 使用说明
console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║  使用方法                                                ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');
console.log('  使用 DSH 原生能力启动服务:');
console.log('');
console.log(`  DSH_MANIFEST=config/manifests/services.${profile}.json npm start`);
console.log('');
console.log('  或者:');
console.log('');
console.log('  cd packages/dsh-service-broker');
console.log(`  node server.mjs --manifest=../../config/manifests/services.${profile}.json`);
console.log('');
