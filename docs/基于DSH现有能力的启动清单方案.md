# 🎯 基于 DSH 现有能力的启动清单方案

**发现**: DSH 已经有完整的服务管理能力，无需重复造轮子！

---

## 📋 DSH 现有能力分析

### ✅ 1. 服务发现与注册 (discovery.mjs)

```javascript
// ~/.dsh/services.json
{
  "version": 1,
  "services": {
    "dsh": { id, state, url, pid, ports, ... },
    "ppt-workbench": { ... }
  }
}
```

**已有能力**:
- ✅ 服务状态持久化
- ✅ 原子写入（防并发）
- ✅ 运行时发现

### ✅ 2. 清单加载 (manifest.mjs)

```javascript
// services.json
[
  {
    "id": "dsh",
    "cmd": ["node", "start.mjs"],
    "cwd": "${PACKAGE_DIR}",
    "url": "http://localhost:13594",
    ...
  }
]
```

**已有能力**:
- ✅ 加载服务清单
- ✅ 变量展开 `${PACKAGE_DIR}`
- ✅ 支持相对路径

### ✅ 3. 服务编排引擎 (engine.mjs)

```javascript
// 核心功能
- 启动服务（独立进程）
- 健康检查（/healthz）
- 复用优先（已有实例不重启）
- keepAlive 守护（自动重启）
```

**已有能力**:
- ✅ 服务生命周期管理
- ✅ 健康探测
- ✅ 自动恢复

---

## 💡 新方案：利用 DSH 现有能力

### 核心思路

不需要重新实现插件发现和管理，只需：
1. ✅ 扫描所有插件的 `dsh-suite.json`
2. ✅ 生成不同的 `services.json` 清单
3. ✅ 使用 DSH 自带的 `loadManifest()` 加载
4. ✅ 使用 DSH 自带的 engine 启动

---

## 🔧 简化后的实现

### 1. 清单生成器

```javascript
// packages/dsh-plugin-manifest/lib/generator.mjs

import { glob } from 'glob';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 扫描所有插件并生成 services.json 清单
 */
export async function generateManifest(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const output = options.output || 'services.json';
  const profile = options.profile || 'minimal'; // minimal, development, production
  
  // 1. 扫描所有 dsh-suite.json
  const suiteFiles = await glob('extensions/**/dsh-suite.json', { 
    cwd: rootDir,
    absolute: true 
  });
  
  console.log(`🔍 发现 ${suiteFiles.length} 个插件`);
  
  // 2. 解析每个插件
  const allServices = [];
  const pluginInfo = [];
  
  for (const file of suiteFiles) {
    const suite = JSON.parse(await readFile(file, 'utf-8'));
    const suiteDir = path.dirname(file);
    
    pluginInfo.push({
      id: suite.name,
      name: suite.title || suite.name,
      version: suite.version,
      path: suiteDir
    });
    
    // 提取服务定义
    if (suite.rows) {
      for (const row of suite.rows) {
        if (row.name && row.name !== '@deepseek-ai/dsh-mcp-client') {
          allServices.push({
            ...row,
            _plugin: suite.name,
            _suiteDir: suiteDir
          });
        }
      }
    }
  }
  
  // 3. 根据 profile 筛选服务
  const selectedServices = filterByProfile(allServices, profile);
  
  console.log(`📋 配置文件: ${profile}`);
  console.log(`   总插件: ${pluginInfo.length}`);
  console.log(`   总服务: ${allServices.length}`);
  console.log(`   启用: ${selectedServices.length}`);
  
  // 4. 生成 services.json（DSH 原生格式）
  const manifest = selectedServices.map(service => ({
    id: service.id,
    cmd: service.cmd || ['node', 'start.mjs'],
    cwd: service.config?.cwd || '${PACKAGE_DIR}',
    url: service.config?.url || `http://localhost:${service.config?.port}`,
    port: service.config?.port,
    env: service.config?.env || {},
    logFile: service.config?.logFile,
    keepAlive: service.config?.keepAlive !== false
  }));
  
  // 5. 保存清单
  await writeFile(
    path.join(rootDir, output),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
  
  console.log(`✅ 生成清单: ${output}`);
  
  return {
    plugins: pluginInfo,
    services: selectedServices.length,
    manifest: output
  };
}

function filterByProfile(services, profile) {
  // 预设配置
  const profiles = {
    empty: [],  // 空清单
    minimal: ['llm-config'],  // 只要核心
    development: services.map(s => s.id),  // 全部
    production: ['llm-config', 'ppt-workbench']  // 生产常用
  };
  
  const enabled = new Set(profiles[profile] || []);
  
  if (enabled.size === 0) return [];
  
  // 简单匹配（包含任一关键词即启用）
  return services.filter(s => 
    Array.from(enabled).some(keyword => 
      s.id.includes(keyword) || s._plugin.includes(keyword)
    )
  );
}
```

### 2. CLI 工具

```javascript
// packages/dsh-plugin-manifest/cli.mjs

import { generateManifest } from './lib/generator.mjs';

const profile = process.argv[2] || 'minimal';

await generateManifest({
  profile,
  output: `services.${profile}.json`
});

console.log(`
✅ 已生成清单: services.${profile}.json

使用方法:
  cd packages/dsh-service-broker
  node server.mjs --manifest=../../services.${profile}.json
`);
```

### 3. 使用 DSH 原生加载

```javascript
// packages/dsh-service-broker/server.mjs (无需修改)

import { loadManifest } from './lib/manifest.mjs';
import { createEngine } from './lib/engine.mjs';

// DSH 自己会加载清单
const manifest = process.env.DSH_MANIFEST || 'services.json';
const services = loadManifest(manifest);

// DSH 自己会启动服务
const engine = createEngine({ services });
await engine.start();
```

---

## 🎯 工作流程（基于 DSH 原生能力）

```
1. 扫描插件
   dsh-manifest scan
   → 发现所有 dsh-suite.json

2. 生成清单
   dsh-manifest generate minimal
   → 生成 services.minimal.json (DSH 原生格式)

3. 启动服务（使用 DSH 自带能力）
   DSH_MANIFEST=services.minimal.json npm start
   → DSH 自己加载清单
   → DSH 自己启动服务
   → DSH 自己管理生命周期
```

---

## 📊 对比：重复造轮子 vs 利用现有能力

| 功能 | 自己实现 | 利用 DSH |
|------|---------|---------|
| **服务发现** | ❌ 重复实现 | ✅ discovery.mjs |
| **清单加载** | ❌ 重复实现 | ✅ manifest.mjs |
| **服务启动** | ❌ 重复实现 | ✅ engine.mjs |
| **健康检查** | ❌ 重复实现 | ✅ engine.mjs |
| **自动重启** | ❌ 重复实现 | ✅ engine.mjs |
| **状态持久化** | ❌ 重复实现 | ✅ discovery.mjs |
| **我们只需做** | ✅ 扫描插件 | ✅ 生成清单 |

---

## 💡 简化后的价值

### 之前的方案（重复造轮子）
- ❌ 重新实现服务发现
- ❌ 重新实现服务启动
- ❌ 重新实现生命周期管理
- ❌ 代码量大（~500行）

### 新方案（利用 DSH）
- ✅ 只做插件扫描（~100行）
- ✅ 只生成清单（~50行）
- ✅ 其他全用 DSH 现有能力
- ✅ 代码量小，维护简单

---

## 🚀 实现建议

### 极简版本

```javascript
// 只需要一个脚本
// scripts/generate-manifest.mjs

import { glob } from 'glob';
import { readFile, writeFile } from 'node:fs/promises';

const profile = process.argv[2] || 'minimal';
const suites = await glob('extensions/**/dsh-suite.json');

const services = [];
for (const file of suites) {
  const suite = JSON.parse(await readFile(file, 'utf-8'));
  
  // 根据 profile 决定是否包含
  if (shouldInclude(suite.name, profile)) {
    services.push(...extractServices(suite, file));
  }
}

await writeFile(
  `services.${profile}.json`,
  JSON.stringify(services, null, 2)
);

function shouldInclude(name, profile) {
  const profiles = {
    minimal: ['llm-config'],
    development: null,  // 包含所有
    production: ['llm-config', 'ppt']
  };
  
  const list = profiles[profile];
  return !list || list.some(k => name.includes(k));
}
```

**使用**:
```bash
# 生成清单
node scripts/generate-manifest.mjs minimal

# 启动（使用 DSH 原生）
DSH_MANIFEST=services.minimal.json npm start
```

---

## ✅ 结论

**不需要重复造轮子！**

DSH 已经有完整的服务管理能力：
- ✅ discovery.mjs - 服务发现
- ✅ manifest.mjs - 清单加载
- ✅ engine.mjs - 服务编排

**我们只需要**:
1. 扫描插件（读取 dsh-suite.json）
2. 生成清单（services.json）
3. 让 DSH 自己加载和管理

**代码量**: 从 500 行 → 150 行  
**维护成本**: 大幅降低  
**与 DSH 集成**: 完美契合
