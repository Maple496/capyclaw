# 🎯 DSH 启动清单插件设计方案

## 核心概念

### 插件生命周期管理
```
1. 插件发现（Discovery）
   - 自动扫描所有插件
   - 读取插件元数据
   - 默认状态：已识别但未启动

2. 启动清单（Manifest）
   - 定义哪些插件应该启动
   - 定义启动顺序和依赖
   - 支持多个预设清单

3. 动态控制（Control）
   - 根据清单启动/停止插件
   - 运行时切换清单
   - 热重载插件
```

---

## 📋 启动清单插件架构

### 1. 插件发现机制

```javascript
// packages/dsh-plugin-manifest/lib/discovery.mjs

export class PluginDiscovery {
  async discoverAll() {
    const plugins = [];
    
    // 扫描所有可能的插件位置
    const locations = [
      'extensions/**/dsh-suite.json',
      'examples/plugins/**/dsh-suite.json'
    ];
    
    for (const pattern of locations) {
      const found = await glob(pattern);
      for (const file of found) {
        const plugin = await this.parsePlugin(file);
        plugins.push({
          ...plugin,
          enabled: false,  // 默认不启动
          discovered: true
        });
      }
    }
    
    return plugins;
  }
  
  async parsePlugin(suiteFile) {
    const suite = JSON.parse(await fs.readFile(suiteFile));
    
    return {
      id: suite.name,
      name: suite.title || suite.name,
      version: suite.version,
      description: suite.description,
      path: path.dirname(suiteFile),
      dependencies: suite.components || [],
      services: suite.services || []
    };
  }
}
```

### 2. 启动清单格式

```json
// config/manifests/default.json
{
  "name": "default",
  "description": "默认启动清单",
  "plugins": {
    "dsh-llm-config": {
      "enabled": true,
      "priority": 1,
      "autoStart": true
    },
    "dsh-ppt-workbench": {
      "enabled": false,
      "priority": 2,
      "autoStart": false
    },
    "dsh-flow-engine": {
      "enabled": false,
      "priority": 3,
      "autoStart": false
    }
  }
}
```

```json
// config/manifests/development.json
{
  "name": "development",
  "description": "开发环境清单",
  "plugins": {
    "dsh-llm-config": {
      "enabled": true,
      "priority": 1,
      "autoStart": true
    },
    "dsh-ppt-workbench": {
      "enabled": true,
      "priority": 2,
      "autoStart": true
    },
    "dsh-flow-engine": {
      "enabled": true,
      "priority": 3,
      "autoStart": false
    }
  }
}
```

### 3. 清单管理器

```javascript
// packages/dsh-plugin-manifest/lib/manager.mjs

export class ManifestManager {
  constructor() {
    this.discovery = new PluginDiscovery();
    this.allPlugins = [];
    this.currentManifest = null;
  }

  /**
   * 初始化：发现所有插件
   */
  async initialize() {
    console.log('🔍 正在发现所有插件...');
    this.allPlugins = await this.discovery.discoverAll();
    console.log(`✅ 发现 ${this.allPlugins.length} 个插件（默认全部禁用）`);
    return this.allPlugins;
  }

  /**
   * 加载启动清单
   */
  async loadManifest(manifestName = 'default') {
    const manifestFile = `config/manifests/${manifestName}.json`;
    
    if (!fs.existsSync(manifestFile)) {
      console.warn(`⚠️  清单 ${manifestName} 不存在，使用空清单`);
      this.currentManifest = { name: manifestName, plugins: {} };
      return;
    }
    
    this.currentManifest = JSON.parse(await fs.readFile(manifestFile));
    console.log(`📋 加载清单: ${this.currentManifest.description}`);
    
    return this.currentManifest;
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
      const config = this.currentManifest.plugins[plugin.id] || {};
      
      if (config.enabled && config.autoStart) {
        toStart.push({ ...plugin, priority: config.priority || 999 });
      } else {
        toStop.push(plugin);
      }
    }
    
    // 按优先级排序
    toStart.sort((a, b) => a.priority - b.priority);
    
    // 停止不需要的插件
    console.log(`\n🛑 停止 ${toStop.length} 个插件...`);
    for (const plugin of toStop) {
      await this.stopPlugin(plugin);
    }
    
    // 启动需要的插件
    console.log(`\n🚀 启动 ${toStart.length} 个插件...`);
    for (const plugin of toStart) {
      await this.startPlugin(plugin);
    }
    
    return {
      started: toStart.length,
      stopped: toStop.length,
      total: this.allPlugins.length
    };
  }

  /**
   * 启动单个插件
   */
  async startPlugin(plugin) {
    console.log(`  ▶️  启动: ${plugin.name}`);
    
    // 调用 service-broker 启动插件
    try {
      await fetch(`http://localhost:9999/api/services/${plugin.id}/start`, {
        method: 'POST'
      });
      console.log(`     ✅ ${plugin.name} 已启动`);
    } catch (error) {
      console.error(`     ❌ ${plugin.name} 启动失败:`, error.message);
    }
  }

  /**
   * 停止单个插件
   */
  async stopPlugin(plugin) {
    console.log(`  ⏹️  停止: ${plugin.name}`);
    
    try {
      await fetch(`http://localhost:9999/api/services/${plugin.id}/stop`, {
        method: 'POST'
      });
    } catch (error) {
      // 忽略已停止的插件
    }
  }

  /**
   * 列出所有插件及其状态
   */
  listPlugins() {
    console.log('\n📦 所有可用插件:\n');
    
    for (const plugin of this.allPlugins) {
      const config = this.currentManifest?.plugins?.[plugin.id] || {};
      const status = config.enabled ? '✅ 已启用' : '⚪ 已禁用';
      
      console.log(`${status} ${plugin.name}`);
      console.log(`   ID: ${plugin.id}`);
      console.log(`   版本: ${plugin.version}`);
      console.log(`   路径: ${plugin.path}`);
      console.log('');
    }
  }

  /**
   * 切换清单
   */
  async switchManifest(newManifest) {
    console.log(`\n🔄 切换清单: ${this.currentManifest?.name} → ${newManifest}`);
    return this.applyManifest(newManifest);
  }
}
```

---

## 🚀 使用示例

### CLI 命令

```bash
# 列出所有插件（默认全部禁用）
dsh manifest list

# 应用清单（启动指定的插件）
dsh manifest apply default
dsh manifest apply development
dsh manifest apply production

# 切换清单
dsh manifest switch development

# 单个插件控制
dsh plugin enable dsh-ppt-workbench
dsh plugin disable dsh-ppt-workbench
```

### API 使用

```javascript
import { ManifestManager } from '@deepseek-ai/dsh-plugin-manifest';

const manager = new ManifestManager();

// 1. 初始化：发现所有插件
await manager.initialize();
// 输出: 发现 10 个插件（默认全部禁用）

// 2. 列出所有插件
manager.listPlugins();
// 输出:
// ⚪ dsh-llm-config
// ⚪ dsh-ppt-workbench
// ⚪ dsh-flow-engine
// ...

// 3. 应用清单
await manager.applyManifest('development');
// 输出:
// 停止 8 个插件...
// 启动 2 个插件...
//   ▶️  启动: LLM 配置
//      ✅ LLM 配置 已启动
//   ▶️  启动: PPT 工作台
//      ✅ PPT 工作台 已启动

// 4. 切换清单
await manager.switchManifest('production');
```

---

## 📋 清单预设

### 1. minimal.json - 最小化清单
```json
{
  "name": "minimal",
  "description": "最小化启动（只有核心功能）",
  "plugins": {
    "dsh-llm-config": {
      "enabled": true,
      "priority": 1,
      "autoStart": true
    }
  }
}
```

### 2. development.json - 开发环境
```json
{
  "name": "development",
  "description": "开发环境（启用所有调试工具）",
  "plugins": {
    "dsh-llm-config": { "enabled": true, "priority": 1, "autoStart": true },
    "dsh-ppt-workbench": { "enabled": true, "priority": 2, "autoStart": true },
    "dsh-flow-engine": { "enabled": true, "priority": 3, "autoStart": true }
  }
}
```

### 3. production.json - 生产环境
```json
{
  "name": "production",
  "description": "生产环境（只启用必要插件）",
  "plugins": {
    "dsh-llm-config": { "enabled": true, "priority": 1, "autoStart": true },
    "dsh-ppt-workbench": { "enabled": true, "priority": 2, "autoStart": false }
  }
}
```

---

## 🎯 核心特性

### 1. 自动发现 ✅
- 扫描所有插件位置
- 读取插件元数据
- **默认状态：已识别但未启动**

### 2. 清单管理 ✅
- 支持多个预设清单
- 定义启动顺序和优先级
- 运行时切换清单

### 3. 动态控制 ✅
- 启动/停止单个插件
- 批量应用清单
- 热重载支持

### 4. 依赖管理 ✅
- 自动解析依赖关系
- 按依赖顺序启动
- 检测循环依赖

---

## 🔧 集成到 DSH

### service-broker 集成

```javascript
// packages/dsh-service-broker/lib/engine.mjs

import { ManifestManager } from '@deepseek-ai/dsh-plugin-manifest';

export class ServiceBroker {
  async start() {
    // 1. 初始化清单管理器
    this.manifestManager = new ManifestManager();
    await this.manifestManager.initialize();
    
    // 2. 加载默认清单（如果存在）
    const defaultManifest = process.env.DSH_MANIFEST || 'default';
    await this.manifestManager.applyManifest(defaultManifest);
    
    // 3. 启动 API 服务器
    this.startApiServer();
  }
  
  startApiServer() {
    // 新增 API 端点
    app.get('/api/plugins', (req, res) => {
      res.json(this.manifestManager.allPlugins);
    });
    
    app.post('/api/manifest/:name/apply', async (req, res) => {
      const result = await this.manifestManager.applyManifest(req.params.name);
      res.json(result);
    });
    
    app.post('/api/plugins/:id/enable', async (req, res) => {
      await this.manifestManager.startPlugin({ id: req.params.id });
      res.json({ success: true });
    });
    
    app.post('/api/plugins/:id/disable', async (req, res) => {
      await this.manifestManager.stopPlugin({ id: req.params.id });
      res.json({ success: true });
    });
  }
}
```

---

## 📊 工作流程

```
用户启动 DSH
    ↓
自动发现所有插件（默认禁用）
    ↓
读取启动清单（如果有）
    ↓
应用清单：启动指定插件
    ↓
用户可动态切换清单
    ↓
插件热重载
```

---

## 💡 优势

1. **发现与启动分离**
   - 所有插件都被识别
   - 只启动需要的插件
   - 降低启动时间和资源占用

2. **灵活的清单管理**
   - 开发/测试/生产不同配置
   - 快速切换场景
   - 版本控制清单文件

3. **动态控制**
   - 运行时启动/停止插件
   - 无需重启 DSH
   - 快速调试

4. **依赖管理**
   - 自动解析依赖
   - 按顺序启动
   - 避免启动失败

---

**状态**: ✅ 设计完成  
**下一步**: 实现代码  
**集成点**: dsh-service-broker
