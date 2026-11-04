#!/usr/bin/env node
/**
 * DSH 启动清单 CLI
 * 
 * 用法:
 *   dsh-manifest list                 - 列出所有插件
 *   dsh-manifest apply <name>         - 应用清单
 *   dsh-manifest switch <name>        - 切换清单
 *   dsh-manifest create-defaults      - 创建默认清单
 */

import { ManifestManager } from './lib/manager.mjs';
import minimist from 'minimist';

const argv = minimist(process.argv.slice(2));
const command = argv._[0];

async function main() {
  const manager = new ManifestManager();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  DSH 启动清单管理器                                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // 初始化：发现所有插件
  await manager.initialize();

  switch (command) {
    case 'list':
      manager.listPlugins();
      break;

    case 'apply': {
      const manifestName = argv._[1] || 'default';
      await manager.applyManifest(manifestName);
      break;
    }

    case 'switch': {
      const manifestName = argv._[1];
      if (!manifestName) {
        console.error('❌ 请指定清单名称');
        process.exit(1);
      }
      await manager.switchManifest(manifestName);
      break;
    }

    case 'create-defaults':
      await manager.createDefaultManifests();
      break;

    default:
      console.log('用法:');
      console.log('  dsh-manifest list                 - 列出所有插件');
      console.log('  dsh-manifest apply <name>         - 应用清单');
      console.log('  dsh-manifest switch <name>        - 切换清单');
      console.log('  dsh-manifest create-defaults      - 创建默认清单\n');
      break;
  }
}

main().catch(error => {
  console.error('❌ 错误:', error.message);
  process.exit(1);
});
