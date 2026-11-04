# dsh-assembly-kit

DSH 统一组合系统：组件库扫描、搜索、依赖解析、产物生成。

## 概述

`dsh-assembly-kit` 统一了两层组合机制：

- **运行时内组合**：`defineCapability` 模块 → 能力注册表
- **包级组合**：插件包 → suite manifest

通过统一的**组件清单**和**产品清单**，实现"搜索组件 → 选择 → 生成插件"的工作流。

## 核心概念

### 组件（Component）

可复用的最小功能单元，有三种形态：

| Kind | 说明 | 例子 |
|---|---|---|
| `plugin` | DSH 插件包（独立进程/行） | `dsh-service-host`、`dsh-ppt-workbench` |
| `capability` | 进程内能力模块（工具+逻辑） | PPT 的 16 个 capability |
| `library` | 纯库（无运行时行） | `dsh-plugin-kit`、`dsh-document-workbench` |
| `skill` | 技能包 | `dsh-ppt-skill-ppt` |

每个组件有元数据：`id`、`version`、`provides`（tools/services/capabilities）、`requires`、`dependsOn`。

### 组件库（Component Library）

扫描工作区生成的 `component-library.json` 索引，包含所有可用组件。

### 产品清单（Product Manifest）

`dsh-product.json` 描述要构建的产品：

```json
{
  "name": "ppt-content",
  "version": "1.0.0",
  "target": "registry",
  "select": {
    "capabilities": ["deck", "text", "image"]
  }
}
```

### 目标产物（Target）

- **`registry`**：生成 `capabilities.manifest.json` + `capabilities.loader.mjs`（进程内能力注册表）
- **`bundle`**：生成 `dsh-suite.json` + `cordis.patch.yml`（suite 包）

## 快速开始

```bash
# 扫描工作区，生成组件库索引
dsh-assembly scan

# 搜索组件
dsh-assembly search "图片处理"
dsh-assembly search --provides tools:ppt_image

# 创建产品清单
dsh-assembly init my-product --target registry

# 添加组件
dsh-assembly add deck text image --manifest dsh-product.json

# 解析依赖，显示计划
dsh-assembly plan dsh-product.json

# 构建产物
dsh-assembly build dsh-product.json --out ./dist

# 验证产物
dsh-assembly verify ./dist
```

## API

### 扫描

```js
import { scan } from 'dsh-assembly-kit'

const library = await scan(workspaceRoot, {
  include: ['packages/*', 'bridges/*/plugin/*'],
  exclude: ['node_modules', 'dist'],
  cache: true
})
```

### 搜索

```js
import { search } from 'dsh-assembly-kit'

const results = search('deck', library, {
  fields: ['id', 'title', 'description', 'tags', 'keywords'],
  kind: ['capability'],
  fuzzy: true
})
```

### 解析

```js
import { resolve } from 'dsh-assembly-kit'

const resolved = resolve(productManifest, library, {
  strict: true  // 缺失依赖报错而非警告
})

console.log(resolved.components)  // 选中的组件列表（已解析 dependsOn）
console.log(resolved.conflicts)   // 冲突列表
console.log(resolved.warnings)    // 警告列表
```

### 生成

```js
import { emit } from 'dsh-assembly-kit'

await emit(resolved, {
  target: 'registry',  // 或 'bundle'
  outDir: './dist'
})

// registry target 生成：
//   dist/capabilities.manifest.json
//   dist/capabilities.loader.mjs

// bundle target 生成：
//   dist/dsh-suite.json
//   dist/cordis.patch.yml
```

## 组件元数据格式

### Plugin 组件

从 `dsh-suite.json` 自动提取：

```json
{
  "id": "service-host",
  "name": "dsh-service-host",
  "version": "0.1.0",
  "kind": "plugin",
  "provides": {
    "services": ["serviceHost"],
    "capabilities": { "host.http": "1.0.0" }
  },
  "source": {
    "package": "packages/dsh-service-host"
  }
}
```

### Capability 组件

从 `package.json.dsh.capabilities` 引用的 `capabilities.json` 提取：

```json
{
  "id": "deck",
  "version": "2.2.0",
  "kind": "capability",
  "title": "读取演示文稿",
  "entry": {
    "module": "./capabilities/deck.mjs",
    "export": "deckCapability"
  },
  "provides": {
    "tools": ["ppt_get_deck"],
    "features": ["deck.read"]
  },
  "requires": ["deck"],
  "source": {
    "package": "bridges/ppt-bridge/plugin/dsh-ppt-workbench",
    "file": "server/tools/capabilities/deck.mjs"
  }
}
```

## 工作流集成

### 为现有插件生成组件元数据

在插件的构建脚本中：

```js
import { extractCapabilities } from 'dsh-assembly-kit'

// 从运行时注册表提取元数据
const metadata = await extractCapabilities({
  module: './server/tools.mjs',
  export: 'registry',
  baseDir: packageDir
})

fs.writeFileSync('capabilities.json', JSON.stringify(metadata, null, 2))
```

在 `package.json` 中声明：

```json
{
  "dsh": {
    "capabilities": {
      "source": "server/tools/capabilities",
      "manifest": "capabilities.json"
    }
  }
}
```

### 使用生成的能力加载器

在插件的 `server/tools/index.mjs` 中：

```js
// 替换静态 import
import { CAPABILITIES } from './capabilities.loader.mjs'  // 生成的
import { createRegistry } from './kernel/registry.mjs'

export { CAPABILITIES, createRegistry }
export const registry = createRegistry(CAPABILITIES)
```

## 设计原则

1. **单一真源**：组件元数据从代码/manifest 自动提取，不手工维护重复信息
2. **渐进增强**：现有工作流不变，assembly 作为可选工具
3. **依赖透明**：所有依赖关系显式声明，冲突早发现
4. **产物可验证**：生成的 loader/suite 可以立即测试和启动

## 边界

- 不做版本求解（只检测冲突，不自动选最优版本）
- 不做包管理（依赖 npm/pnpm）
- 不做发布/注册表（local-first）
- 组件库索引是工作区级的，不跨工作区

## 后续扩展

- Web UI 组件浏览器
- AI 工具暴露（`assembly_search`、`assembly_plan`、`assembly_build`）
- 跨工作区组件引用（全局库 + 项目库）
- 组件版本依赖求解
