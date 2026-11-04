/**
 * DSH 插件发现器
 * 
 * 功能：
 * - 自动扫描所有插件
 * - 读取插件元数据
 * - 默认状态：已识别但未启动
 */

import { glob } from 'glob';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export class PluginDiscovery {
  constructor(options = {}) {
    this.rootDir = options.rootDir || process.cwd();
    this.patterns = options.patterns || [
      'extensions/**/dsh-suite.json',
      'examples/plugins/**/dsh-suite.json',
      'plugins/**/dsh-suite.json'
    ];
  }

  /**
   * 发现所有插件
   */
  async discoverAll() {
    console.log('🔍 正在扫描插件...\n');
    
    const plugins = [];
    const seen = new Set();

    for (const pattern of this.patterns) {
      const files = await glob(pattern, { 
        cwd: this.rootDir,
        absolute: true 
      });

      for (const file of files) {
        try {
          const plugin = await this.parsePlugin(file);
          
          // 避免重复
          if (seen.has(plugin.id)) continue;
          seen.add(plugin.id);

          plugins.push({
            ...plugin,
            enabled: false,      // 默认不启动
            discovered: true,
            discoveredAt: new Date().toISOString()
          });

          console.log(`  ✓ 发现: ${plugin.name} (${plugin.id})`);
        } catch (error) {
          console.warn(`  ⚠️  跳过无效插件: ${file}`);
        }
      }
    }

    console.log(`\n✅ 总共发现 ${plugins.length} 个插件（默认全部禁用）\n`);
    
    return plugins;
  }

  /**
   * 解析插件元数据
   */
  async parsePlugin(suiteFile) {
    const content = await readFile(suiteFile, 'utf-8');
    const suite = JSON.parse(content);

    return {
      id: suite.name,
      name: suite.title || suite.name,
      version: suite.version,
      description: suite.description,
      path: path.dirname(suiteFile),
      suiteFile: suiteFile,
      
      // 插件提供的服务
      services: this.extractServices(suite),
      
      // 依赖关系
      dependencies: this.extractDependencies(suite),
      
      // 端口信息
      ports: this.extractPorts(suite),
      
      // 健康检查
      healthChecks: suite.checks || []
    };
  }

  /**
   * 提取服务列表
   */
  extractServices(suite) {
    if (!suite.rows) return [];
    
    return suite.rows
      .filter(row => row.name && row.name !== '@deepseek-ai/dsh-mcp-client')
      .map(row => ({
        id: row.id,
        name: row.name,
        config: row.config || {}
      }));
  }

  /**
   * 提取依赖关系
   */
  extractDependencies(suite) {
    const deps = [];
    
    if (suite.packages) {
      for (const [name, config] of Object.entries(suite.packages)) {
        if (config.path) {
          deps.push(name);
        }
      }
    }
    
    return deps;
  }

  /**
   * 提取端口信息
   */
  extractPorts(suite) {
    const ports = [];
    
    if (suite.packages) {
      for (const config of Object.values(suite.packages)) {
        if (config.provides?.ports) {
          ports.push(...config.provides.ports);
        }
      }
    }
    
    if (suite.rows) {
      for (const row of suite.rows) {
        if (row.config?.port) {
          ports.push(row.config.port);
        }
      }
    }
    
    return [...new Set(ports)];
  }
}
