# DSH Contracts - 核心接口契约层

定义 DSH 项目中模块间的抽象接口，遵循依赖倒置原则（DIP）。

---

## 设计原则

1. **依赖倒置**：高层模块和低层模块都依赖这些抽象
2. **接口隔离**：每个接口只定义必要的方法
3. **单一职责**：每个接口只负责一个领域
4. **开闭原则**：对扩展开放，对修改封闭

---

## 接口分类

### plugin/ - 插件相关接口
- `IPluginLoader` - 插件加载器接口
- `IPluginValidator` - 插件验证器接口
- `IPluginManifest` - 插件清单接口

### service/ - 服务相关接口
- `IServiceBroker` - 服务代理接口
- `IServiceHost` - 服务宿主接口
- `IServiceRegistry` - 服务注册接口

### runtime/ - 运行时相关接口
- `IRuntimeControl` - 运行时控制接口
- `IRuntimeConfig` - 运行时配置接口
- `ILifecycle` - 生命周期接口

### workspace/ - 工作区相关接口
- `IWorkspaceManager` - 工作区管理器接口
- `IWorkspaceClient` - 工作区客户端接口

### state/ - 状态管理接口
- `IStateBackend` - 状态后端接口
- `IStateService` - 状态服务接口

### asset/ - 资产管理接口
- `IAssetStore` - 资产存储接口
- `IAssetService` - 资产服务接口

### editor/ - 编辑器接口
- `IEditorHost` - 编辑器宿主接口
- `IEditorTransport` - 编辑器传输接口
- `ILeaseManager` - 租约管理接口

### orchestration/ - Suite/Stack 编排接口
- `ISuiteLoader` - Suite 加载器接口
- `IStackCompiler` - Stack 编译器接口
- `IDomainManager` - Domain 管理器接口

### schemas/ - 数据契约
- 导出所有 schema.json 文件的引用

---

## 使用方式

```javascript
// 定义实现
import { IPluginLoader } from 'dsh-contracts/plugin'

export class PluginLoaderImpl extends IPluginLoader {
  async load(path) { /* ... */ }
  validate(manifest) { /* ... */ }
}

// 使用接口
import { IPluginLoader } from 'dsh-contracts/plugin'

export class MyExtension {
  constructor(loader) {  // 类型: IPluginLoader
    this.loader = loader
  }
}
```

---

## 接口文档

每个接口都有完整的 JSDoc 注释，包括：
- 方法签名
- 参数说明
- 返回值说明
- 使用示例

详见各接口定义文件。

---

## 版本管理

接口变更遵循语义化版本：
- **MAJOR**: 破坏性变更（删除方法、改变签名）
- **MINOR**: 向后兼容的新增（新方法、可选参数）
- **PATCH**: 文档修正
