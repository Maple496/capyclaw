/**
 * DSH 启动清单管理器
 * 
 * 功能：
 * - 管理插件启动清单
 * - 根据清单启动/停止插件
 * - 运行时切换清单
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PluginDiscovery } from './discovery.mjs';

export class ManifestManager {
  constructor(options = {}) {
    this.rootDir = options.rootDir || process.cwd();
    this.manifestDir = options.manifestDir || path.join(this.rootDir, 'config/manifests');
    this.brokerUrl = options.brokerUrl || 'http://localhost:9999';
    
    this.discovery = new PluginDiscovery({ rootDir: this.rootDir });
    this.allPlugins = [];
    this.currentManifest = null;
  }

  /**
   * 初始化：发现所有插件
   */
  async initialize() {
    this.allPlugins = await this.discovery.discoverAll();
    return this.allPlugins;
  }

  /**
   * 加载启动清单
   */
  async loadManifest(manifestName = 'default') {
    const manifestFile = path.join(this.manifestDir, `${manifestName}.json`);
    
    if (!existsSync(manifestFile)) {
      console.warn(`⚠️  清单 ${manifestName} 不存在，使用空清单`);
      this.currentManifest = {
        name: manifestName,
        description: '空清单（所有插件禁用）',
        plugins: {}
      };
      return this.currentManifest;
    }
    
    const content = await readFile(manifestFile, 'utf-8');
    this.currentManifest = JSON.parse(content);
    
    console.log(`📋 加载清单: ${this.currentManifest.description || manifestName}`);
    
    return this.currentManifest;
  }

  /**
   * 保存清单
   */
  async saveManifest(manifestName, manifest) {
    await mkdir(this.manifestDir, { recursive: true });
    
    const manifestFile = path.join(this.manifestDir, `${manifestName}.json`);
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2), 'utf-8');
    
    console.log(`💾 保存清单: ${manifestName}`);
  }

  /**
   * 应用清单：根据清单启动/停止插件
   */
  async applyManifest(manifestName) {
    await this.loadManifest(manifestName);
    
    const toStart = [];
    const toStop = [];
    
    // 分析需要启动和停止的插件
    for (const plugin of this.allPlugins) {
      const config = this.currentManifest.plugins[plugin.id];
      
      if (config?.enabled && config?.autoStart) {
        toStart.push({
          ...plugin,
          priority: config.priority || 999,
          config: config
        });
      } else {
        toStop.push(plugin);
      }
    }
    
    // 按优先级排序
    toStart.sort((a, b) => a.priority - b.priority);
    
    console.log(`\n📊 清单应用计划:`);
    console.log(`   启动: ${toStart.length} 个插件`);
    console.log(`   停止: ${toStop.length} 个插件`);
    console.log(`   总计: ${this.allPlugins.length} 个插件\n`);
    
    // 停止不需要的插件
    if (toStop.length > 0) {
      console.log(`🛑 停止插件...\n`);
      for (const plugin of toStop) {
        await this.stopPlugin(plugin);
      }
    }
    
    // 启动需要的插件
    if (toStart.length > 0) {
      console.log(`\n🚀 启动插件...\n`);
      for (const plugin of toStart) {
        await this.startPlugin(plugin);
      }
    }
    
    console.log(`\n✅ 清单应用完成\n`);
    
    return {
      manifest: manifestName,
      started: toStart.length,
      stopped: toStop.length,
      total: this.allPlugins.length,
      plugins: {
        started: toStart.map(p => p.id),
        stopped: toStop.map(p => p.id)
      }
    };
  }

  /**
   * 启动单个插件
   */
  async startPlugin(plugin) {
    console.log(`  ▶️  启动: ${plugin.name}`);
    console.log(`     ID: ${plugin.id}`);
    
    // 这里应该调用 service-broker 的 API
    // 目前先打印日志
    console.log(`     ✅ ${plugin.name} 已标记为启动`);
    
    // TODO: 实际调用
    // await fetch(`${this.brokerUrl}/api/services/${plugin.id}/start`, {
    //   method: 'POST'
    // });
  }

  /**
   * 停止单个插件
   */
  async stopPlugin(plugin) {
    console.log(`  ⏹️  ${plugin.name} (保持停止)`);
    
    // TODO: 实际调用
    // await fetch(`${this.brokerUrl}/api/services/${plugin.id}/stop`, {
    //   method: 'POST'
    // });
  }

  /**
   * 列出所有插件及其状态
   */
  listPlugins() {
    console.log('\n📦 所有可用插件:\n');
    
    if (this.allPlugins.length === 0) {
      console.log('  (未发现任何插件)\n');
      return;
    }
    
    for (const plugin of this.allPlugins) {
      const config = this.currentManifest?.plugins?.[plugin.id];
      const enabled = config?.enabled || false;
      const autoStart = config?.autoStart || false;
      
      let status = '⚪ 已禁用';
      if (enabled && autoStart) {
        status = '✅ 已启用（自动启动）';
      } else if (enabled) {
        status = '🟡 已启用（手动启动）';
      }
      
      console.log(`${status}`);
      console.log(`  名称: ${plugin.name}`);
      console.log(`  ID: ${plugin.id}`);
      console.log(`  版本: ${plugin.version}`);
      console.log(`  描述: ${plugin.description || '(无)'}`);
      if (plugin.ports.length > 0) {
        console.log(`  端口: ${plugin.ports.join(', ')}`);
      }
      console.log('');
    }
  }

  /**
   * 切换清单
   */
  async switchManifest(newManifest) {
    const oldManifest = this.currentManifest?.name || '(无)';
    console.log(`\n🔄 切换清单: ${oldManifest} → ${newManifest}\n`);
    return this.applyManifest(newManifest);
  }

  /**
   * 创建默认清单
   */
  async createDefaultManifests() {
    await mkdir(this.manifestDir, { recursive: true });
    
    // 1. 空清单（所有插件禁用）
    const empty = {
      name: 'empty',
      description: '空清单 - 所有插件禁用',
      plugins: {}
    };
    await this.saveManifest('empty', empty);
    
    // 2. 最小清单（只启动核心插件）
    const minimal = {
      name: 'minimal',
      description: '最小清单 - 只启动核心插件',
      plugins: {}
    };
    
    // 找到核心插件（如 llm-config）
    const corePlugin = this.allPlugins.find(p => p.id.includes('llm-config'));
    if (corePlugin) {
      minimal.plugins[corePlugin.id] = {
        enabled: true,
        priority: 1,
        autoStart: true
      };
    }
    await this.saveManifest('minimal', minimal);
    
    // 3. 开发清单（启动所有插件）
    const development = {
      name: 'development',
      description: '开发清单 - 启动所有插件',
      plugins: {}
    };
    
    this.allPlugins.forEach((plugin, index) => {
      development.plugins[plugin.id] = {
        enabled: true,
        priority: index + 1,
        autoStart: true
      };
    });
    await this.saveManifest('development', development);
    
    console.log('✅ 已创建默认清单: empty, minimal, development\n');
  }
}
