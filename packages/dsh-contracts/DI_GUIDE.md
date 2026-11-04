# 依赖注入使用指南

## 概述

DSH Contracts 提供了一个轻量级的依赖注入（DI）容器，用于管理服务的创建和依赖关系。

---

## 基本用法

### 1. 注册服务

```javascript
import { container } from 'dsh-contracts/di'
import { PluginLoaderImpl } from './plugin-loader.mjs'

// 注册瞬态服务（每次解析创建新实例）
container.register('IPluginLoader', () => new PluginLoaderImpl())

// 注册单例服务（只创建一次）
container.registerSingleton('IServiceBroker', () => new ServiceBrokerImpl())

// 直接注册实例
container.registerInstance('config', { port: 3000 })
```

### 2. 解析服务

```javascript
import { container } from 'dsh-contracts/di'

// 解析服务
const loader = container.resolve('IPluginLoader')
const broker = container.resolve('IServiceBroker')
```

### 3. 服务间依赖

```javascript
// 服务A依赖服务B
container.registerSingleton('IStateService', (c) => {
  const backend = c.resolve('IStateBackend')
  return new StateServiceImpl(backend)
})

container.registerSingleton('IStateBackend', () => {
  return new FileStateBackend('./state.json')
})
```

---

## 高级用法

### 批量注册

```javascript
import { registerServices, registerSingletons } from 'dsh-contracts/di'

// 批量注册瞬态服务
registerServices({
  'IPluginLoader': () => new PluginLoaderImpl(),
  'IPluginValidator': () => new PluginValidatorImpl(),
})

// 批量注册单例服务
registerSingletons({
  'IServiceBroker': (c) => new ServiceBrokerImpl(c.resolve('config')),
  'IStateService': (c) => new StateServiceImpl(c.resolve('IStateBackend')),
})
```

### 子容器

```javascript
import { container } from 'dsh-contracts/di'

// 创建子容器（继承父容器的注册）
const childContainer = container.createChild()

// 子容器可以覆盖父容器的注册
childContainer.registerSingleton('IPluginLoader', () => new MockPluginLoader())
```

### 快捷注入

```javascript
import { inject } from 'dsh-contracts/di'

// 快速解析服务
const loader = inject('IPluginLoader')
```

---

## 完整示例

```javascript
// 1. 定义接口（dsh-contracts）
export class IPluginLoader {
  async load(path) {
    throw new Error('Must implement')
  }
}

// 2. 实现接口（dsh-plugin-kit）
import { IPluginLoader } from 'dsh-contracts/plugin'

export class PluginLoaderImpl extends IPluginLoader {
  async load(path) {
    // 实际实现
    return { id: 'plugin', manifest: {} }
  }
}

// 3. 注册服务（应用启动时）
import { registerSingletons } from 'dsh-contracts/di'
import { PluginLoaderImpl } from 'dsh-plugin-kit'

registerSingletons({
  'IPluginLoader': () => new PluginLoaderImpl(),
})

// 4. 使用服务（扩展中）
import { inject } from 'dsh-contracts/di'

export class MyExtension {
  constructor() {
    this.loader = inject('IPluginLoader')
  }
  
  async loadPlugin(path) {
    return await this.loader.load(path)
  }
}
```

---

## 最佳实践

### 1. 使用接口名作为服务标识

```javascript
// ✅ 推荐：使用接口名
container.registerSingleton('IPluginLoader', () => new PluginLoaderImpl())

// ❌ 不推荐：使用实现类名
container.registerSingleton('PluginLoaderImpl', () => new PluginLoaderImpl())
```

### 2. 优先使用单例

```javascript
// ✅ 推荐：大多数服务应该是单例
container.registerSingleton('IServiceBroker', () => new ServiceBrokerImpl())

// ⚠️ 谨慎使用：只在确实需要多实例时使用
container.register('IPluginInstance', () => new PluginInstance())
```

### 3. 在应用启动时注册

```javascript
// bootstrap.mjs
import { registerSingletons } from 'dsh-contracts/di'

export async function bootstrap() {
  // 注册所有服务
  registerSingletons({
    'IPluginLoader': () => new PluginLoaderImpl(),
    'IServiceBroker': () => new ServiceBrokerImpl(),
    'IStateService': (c) => new StateServiceImpl(c.resolve('IStateBackend')),
  })
  
  // 启动应用
  const app = inject('IApp')
  await app.start()
}
```

### 4. 在扩展中使用注入

```javascript
// my-extension/plugin.mjs
import { inject } from 'dsh-contracts/di'

export class MyExtension {
  constructor() {
    // 通过 DI 获取依赖
    this.loader = inject('IPluginLoader')
    this.broker = inject('IServiceBroker')
  }
}
```

---

## 测试支持

```javascript
// test/my-extension.test.mjs
import { container } from 'dsh-contracts/di'
import { MyExtension } from '../my-extension/plugin.mjs'

// 测试中使用 mock
container.clear()
container.registerInstance('IPluginLoader', {
  async load() { return { id: 'mock' } }
})

const ext = new MyExtension()
// 测试 ext...
```

---

## 迁移指南

### 从直接依赖迁移到 DI

**Before:**
```javascript
import { PluginLoaderImpl } from '../../../../packages/dsh-plugin-kit/src/index.mjs'

export class MyExtension {
  constructor() {
    this.loader = new PluginLoaderImpl()  // 硬编码依赖
  }
}
```

**After:**
```javascript
import { inject } from 'dsh-contracts/di'

export class MyExtension {
  constructor() {
    this.loader = inject('IPluginLoader')  // 通过 DI 注入
  }
}
```

---

## API 参考

### DIContainer

- `register(name, factory)` - 注册瞬态服务
- `registerSingleton(name, factory)` - 注册单例服务
- `registerInstance(name, instance)` - 注册实例
- `resolve(name)` - 解析服务
- `has(name)` - 检查服务是否存在
- `clear()` - 清除所有注册
- `createChild()` - 创建子容器

### 辅助函数

- `inject(serviceName)` - 快速解析服务
- `registerServices(services)` - 批量注册瞬态服务
- `registerSingletons(services)` - 批量注册单例服务
