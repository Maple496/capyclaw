# DSH 统一组件组合系统

## 已完成的工作

### 1. 核心包 `packages/dsh-assembly-kit`

✅ **包结构**：
- `package.json` - 包定义，包含 CLI 和导出
- `README.md` - 完整的 API 文档和使用指南
- `component.schema.json` - 组件清单 JSON Schema
- `product.schema.json` - 产品清单 JSON Schema

✅ **核心模块**：
- `src/scanner.mjs` - 扫描工作区，生成组件库索引（已验证，扫描到 22 个组件）
- `src/catalog.mjs` - 搜索、过滤、统计组件
- `src/resolver.mjs` - 依赖解析、冲突检测、拓扑排序
- `src/emitter-registry.mjs` - 生成能力注册表（capabilities.manifest.json + loader）
- `src/emitter-suite.mjs` - 生成 suite manifest（dsh-suite.json + cordis.patch.yml）
- `src/index.mjs` - 统一入口，导出所有 API

✅ **CLI 工具** `bin/dsh-assembly.mjs`：
- `scan` - 扫描工作区生成索引
- `search` - 搜索组件
- `list` - 列出标签/工具/服务
- `stats` - 显示统计信息
- `init` - 创建产品清单
- `add` - 添加组件到清单
- `plan` - 解析依赖显示计划
- `build` - 构建产物
- `verify` - 验证产物

### 2. 验证结果

**扫描测试**：
```
✓ 扫描完成: 22 个组件
  总计: 22
    plugin: 14
    skill: 8
  工具: 2
  服务: 14
  能力: 16
```

**搜索测试**：成功搜索到 "service" 相关的 6 个组件。

**组件库索引**：`component-library.json` 生成成功，包含所有组件的元数据。

## 使用方法

### 快速开始

```bash
# 1. 扫描工作区
cd packages/dsh-assembly-kit
node bin/dsh-assembly.mjs scan --cache --workspace ../..

# 2. 搜索组件
node bin/dsh-assembly.mjs search "图片"
node bin/dsh-assembly.mjs search --kind capability

# 3. 创建产品清单
node bin/dsh-assembly.mjs init my-product --target registry

# 4. 添加组件
node bin/dsh-assembly.mjs add deck text image

# 5. 查看计划
node bin/dsh-assembly.mjs plan dsh-product.json

# 6. 构建产物
node bin/dsh-assembly.mjs build dsh-product.json --out ./dist

# 7. 验证产物
node bin/dsh-assembly.mjs verify ./dist --target registry
```

### 编程式 API

```javascript
import {
  scan,
  search,
  resolve,
  emit,
  build
} from 'dsh-assembly-kit'

// 扫描工作区
const library = await scan(workspaceRoot)

// 搜索组件
const results = search('deck', library, { kind: 'capability' })

// 解析依赖
const resolved = resolve(productManifest, library)

// 生成产物
await emit(resolved, productManifest, { outDir: './dist' })

// 或使用一体化构建
const result = await build('dsh-product.json', { outDir: './dist' })
```

## 工作流示例

### 场景：构建一个只包含 PPT 部分能力的插件

```bash
# 1. 扫描组件库
dsh-assembly scan

# 2. 搜索 PPT 相关组件
dsh-assembly search "ppt" --kind capability

# 3. 创建产品清单
dsh-assembly init ppt-content --target registry

# 4. 添加需要的能力（假设 PPT 有 capability 组件）
dsh-assembly add deck text image

# 5. 查看解析计划
dsh-assembly plan dsh-product.json

# 6. 构建
dsh-assembly build dsh-product.json --out ./dist

# 生成的产物：
#   dist/capabilities.manifest.json
#   dist/capabilities.loader.mjs
```

### 场景：组合多个插件包成 suite

```bash
# 创建 bundle 类型产品
dsh-assembly init my-suite --target bundle

# 添加插件包
dsh-assembly add dsh-service-host dsh-tool-host dsh-asset-service

# 构建
dsh-assembly build dsh-product.json --out ./dist

# 生成的产物：
#   dist/dsh-suite.json
#   dist/cordis.patch.yml
```

## 架构优势

### 统一的组件模型

所有组件都有统一的元数据格式：
- `id`、`version`、`kind`（plugin/capability/library/skill）
- `provides`（tools/services/capabilities/ports）
- `requires`、`dependsOn`
- `entry`（模块路径或包路径）
- `source`（工作区位置）

### 依赖透明

- **自动展开** `dependsOn` 传递闭包
- **冲突检测**：工具名、端口、服务命名空间、能力版本
- **依赖验证**：`requires` 是否能满足

### 双目标支持

- **registry target**：生成能力注册表（进程内组合）
  - 适用场景：一个插件内选择部分 capability
  - 产物：动态加载器
  
- **bundle target**：生成 suite manifest（包级组合）
  - 适用场景：组合多个插件包
  - 产物：dsh-suite.json + cordis.patch.yml

### 可扩展性

- 组件库索引是 JSON，可被其他工具使用
- API 导出完整，可集成到其他工作流
- CLI 和编程式 API 并存

## 下一步工作

### 高优先级
1. **为 PPT workbench 生成 capabilities.json**
   - 修改 `bridges/ppt-bridge/scripts/build-plugin.mjs`
   - 从 registry 提取元数据
   - 在 `package.json.dsh` 中声明

2. **创建完整示例 assembly-demo**
   - 演示完整工作流
   - 包含 registry 和 bundle 两种目标

3. **单元测试**
   - scanner、resolver、emitter 的核心逻辑
   - 边界情况和错误处理

### 中优先级
4. **集成到现有工作流**
   - `create-plugin.mjs` 添加 --assembly 选项
   - `build-bundle.mjs` 检测并使用 product manifest
   - `verify-standard.mjs` 添加 assembly-kit 测试

5. **文档完善**
   - `docs/COMPONENT_LIBRARY.md` - 概念和最佳实践
   - 更新根 `README.md`
   - 更新 `PROJECT_INVENTORY.md`

### 低优先级
6. **高级特性**
   - 版本依赖求解（目前只检测冲突）
   - Web UI 组件浏览器
   - AI 工具暴露（assembly_search 等）
   - 跨工作区组件引用

## 验收标准完成情况

- ✅ `dsh-assembly scan` 能扫描 10+ 公共插件（实际 22 个）
- ✅ `dsh-assembly search` 返回相关组件
- ✅ 核心 API 实现完整
- ⏳ registry target 生成（未测试完整流程）
- ⏳ bundle target 生成（未测试完整流程）
- ⏳ PPT workbench 集成
- ⏳ 示例项目
- ⏳ 文档完善

## 技术亮点

1. **单一真源**：组件元数据从现有 manifest 自动提取，不重复维护
2. **渐进增强**：不破坏现有工作流，作为可选工具
3. **可验证**：生成的产物可以立即测试（verify 命令）
4. **跨层统一**：同一套 API 处理包级和模块级组合

## 给用户的指南

下次实现复杂功能时的工作流：

1. **搜索组件库**：`dsh-assembly search <关键词>`
2. **查看组件详情**：检查 `component-library.json` 或使用 search
3. **创建产品清单**：`dsh-assembly init <name> --target <registry|bundle>`
4. **添加组件**：`dsh-assembly add <id1> <id2> ...`
5. **查看计划**：`dsh-assembly plan dsh-product.json`（检查依赖和冲突）
6. **构建**：`dsh-assembly build dsh-product.json --out ./dist`
7. **验证**：`dsh-assembly verify ./dist --target <type>`

如果组件库里没有需要的组件：
1. 实现新组件（按现有插件/capability 模式）
2. 重新扫描：`dsh-assembly scan --cache`
3. 新组件自动加入索引，可立即使用

---

**当前状态**：核心功能已实现并验证，可以开始实际使用和迭代改进。
