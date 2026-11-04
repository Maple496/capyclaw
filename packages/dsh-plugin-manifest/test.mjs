#!/usr/bin/env node
/**
 * DSH 启动清单 CLI 测试
 */

import { ManifestManager } from './lib/manager.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

async function test() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  DSH 启动清单管理器 - 测试                               ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log(`📁 工作目录: ${rootDir}\n`);

  const manager = new ManifestManager({ rootDir });

  // 初始化：发现所有插件
  console.log('1️⃣  发现插件...\n');
  await manager.initialize();

  // 列出所有插件
  console.log('\n2️⃣  列出插件...\n');
  manager.listPlugins();

  // 创建默认清单
  console.log('\n3️⃣  创建默认清单...\n');
  await manager.createDefaultManifests();

  // 应用清单
  console.log('\n4️⃣  应用清单...\n');
  await manager.applyManifest('minimal');

  console.log('\n✅ 测试完成！\n');
}

test().catch(console.error);
