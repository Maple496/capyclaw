# 统一组件组合系统使用示例

本示例演示如何使用 `dsh-assembly-kit` 从组件库搜索、选择、构建一个新插件。

## 场景：构建一个包含特定公共服务的 suite

### 步骤 1：扫描组件库

```bash
cd packages/dsh-assembly-kit
node bin/dsh-assembly.mjs scan --cache --workspace ../..
```

**输出**：
```
扫描工作区: <repo>
✓ 扫描完成: 22 个组件
  保存到: <repo>\component-library.json

统计:
  总计: 22
    plugin: 14
    skill: 8
  工具: 2
  服务: 14
  能力: 16
```

### 步骤 2：查看统计和搜索组件

```bash
# 查看统计
node bin/dsh-assembly.mjs stats --workspace ../..

# 搜索服务相关组件
node bin/dsh-assembly.mjs search "service" --workspace ../..

# 搜索特定能力
node bin/dsh-assembly.mjs search --kind plugin --provides services:* --workspace ../..
```

### 步骤 3：创建产品清单

```bash
# 创建一个 bundle 类型的产品（组合多个插件包）
node bin/dsh-assembly.mjs init my-services-suite --target bundle --workspace ../..
```

**生成的 `dsh-product.json`**：
```json
{
  "$schema": "../packages/dsh-assembly-kit/product.schema.json",
  "name": "my-services-suite",
  "version": "0.1.0",
  "title": "my-services-suite",
  "description": "my-services-suite 产品",
  "target": "bundle",
  "select": {
    "capabilities": [],
    "packages": []
  }
}
```

### 步骤 4：编辑清单，添加需要的组件

编辑 `dsh-product.json`，添加组件：

```json
{
  "$schema": "../packages/dsh-assembly-kit/product.schema.json",
  "name": "my-services-suite",
  "version": "0.1.0",
  "title": "我的服务套件",
  "description": "包含基础服务的组合套件",
  "target": "bundle",
  "select": {
    "packages": [
      "dsh-service-host",
      "dsh-tool-host",
      "dsh-asset-service"
    ]
  }
}
```

或使用 CLI 添加：

```bash
node bin/dsh-assembly.mjs add dsh-service-host dsh-tool-host dsh-asset-service --manifest dsh-product.json
```

### 步骤 5：查看依赖解析计划

```bash
node bin/dsh-assembly.mjs plan dsh-product.json --workspace ../..
```

**输出示例**：
```
解析计划:

  产品: my-services-suite v0.1.0
  目标: bundle
  选中: 3 个组件
  展开: 3 个组件（含依赖）

组件列表:
  plugin       dsh-asset-service
  plugin       dsh-service-host
  plugin       dsh-tool-host
```

### 步骤 6：构建产物

```bash
node bin/dsh-assembly.mjs build dsh-product.json --out ./dist --workspace ../..
```

**生成的文件**：
- `dist/dsh-suite.json` - Suite 清单
- `dist/cordis.patch.yml` - Cordis 配置补丁

**dist/dsh-suite.json 示例**：
```json
{
  "name": "my-services-suite-suite",
  "version": "0.1.0",
  "title": "我的服务套件",
  "description": "包含基础服务的组合套件",
  "packages": {
    "dsh-service-host": {
      "role": "runtime",
      "version": "0.1.0",
      "path": "../../packages/dsh-service-host",
      "provides": {
        "services": ["serviceHost"],
        "capabilities": { "host.http": "1.0.0" }
      }
    },
    "dsh-tool-host": {
      "role": "runtime",
      "version": "0.1.0",
      "path": "../../packages/dsh-tool-host",
      "provides": {
        "services": ["toolHost"],
        "capabilities": { "tools.registry": "1.0.0" }
      }
    },
    "dsh-asset-service": {
      "role": "runtime",
      "version": "0.1.0",
      "path": "../../packages/dsh-asset-service",
      "provides": {
        "services": ["assets"],
        "capabilities": { "assets.store": "1.0.0" }
      }
    }
  },
  "rows": [
    { "id": "dsh-service-host-host", "name": "dsh-service-host" },
    { "id": "dsh-tool-host-host", "name": "dsh-tool-host" },
    { "id": "dsh-asset-service-host", "name": "dsh-asset-service" }
  ],
  "checks": []
}
```

### 步骤 7：验证产物

```bash
node bin/dsh-assembly.mjs verify ./dist --target bundle --workspace ../..
```

**输出**：
```
验证: ./dist
目标: bundle

✓ 验证通过
  suite: my-services-suite-suite v0.1.0
  packages: 3 个
  rows: 3 个
```

## 场景 2：构建能力注册表（registry target）

如果要生成进程内的能力加载器（适用于有 capability 组件的场景）：

```bash
# 创建 registry 类型产品
node bin/dsh-assembly.mjs init my-capabilities --target registry --workspace ../..

# 假设有 capability 组件，添加它们
# node bin/dsh-assembly.mjs add deck text image --manifest dsh-product.json

# 构建（生成 capabilities.loader.mjs）
# node bin/dsh-assembly.mjs build dsh-product.json --out ./dist --workspace ../..

# 验证
# node bin/dsh-assembly.mjs verify ./dist --target registry --workspace ../..
```

**注意**：当前工作区扫描到的主要是 plugin 和 skill 组件。要使用 registry target，需要先为插件（如 PPT workbench）生成 `capabilities.json` 元数据。

## 下一步

- 查看 [packages/dsh-assembly-kit/README.md](../README.md) 了解完整 API
- 查看 [IMPLEMENTATION_SUMMARY.md](../IMPLEMENTATION_SUMMARY.md) 了解实施细节
- 为现有插件添加 capability 元数据，扩展组件库

## 常见问题

**Q: 组件库索引需要手动更新吗？**  
A: 添加新组件或修改后，运行 `dsh-assembly scan --cache` 重新扫描即可。

**Q: 如何查看某个组件的详细信息？**  
A: 查看生成的 `component-library.json` 文件，或使用 `search` 命令过滤。

**Q: 冲突如何处理？**  
A: `plan` 命令会列出所有冲突（工具名、端口等），需要手动调整组件选择或配置。

**Q: 生成的产物如何使用？**  
A: 
- bundle target：使用 `dsh-suite install` 安装到 profile
- registry target：在插件代码中 import 生成的 loader
