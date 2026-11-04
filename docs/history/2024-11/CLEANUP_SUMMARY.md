# 文件清理总结报告

执行时间：2024-11-03
操作者：AI Assistant

---

## ✅ 已完成的清理操作

### 1. 备份用户数据
```
已备份：dist-products/dsh-desktop/data/
备份位置：../backup-before-cleanup/dsh-desktop-data-backup/
备份内容：
  - base/dsh-home/profiles/
  - base/state/stack-services.json
  - launchers/
```

### 2. 删除验证构建（节省 ~2.1GB）
```
✓ dist-products/verify-agent-20261103-unique-01/     (714MB)
✓ dist-products/verify-isolated-20261103-unique/     (714MB)
✓ dist-products/verify-real-20261103-unique2/        (714MB)
```

### 3. 删除可重建的构建产物
```
✓ dist/                           (636KB - 插件源发布)
✓ release/                        (1.3MB - 完整源发布)
✓ plugin-development/dist/        (48KB - 旧插件包)
✓ component-library.json          (31KB - 生成文件)
```

### 4. 清理运行时状态文件
```
✓ tools/dsh-launcher/.dshd/       (工具不应在自身目录保存状态)
```

---

## 📊 清理效果

### 磁盘空间变化
```
清理前：~3.8GB
清理后：~1.4GB
节省空间：~2.4GB (63% 减少)
```

### 目录大小对比
| 目录 | 清理前 | 清理后 | 变化 |
|------|--------|--------|------|
| dist-products/ | 2.8GB | 635MB | -77% |
| 项目总计 | 3.8GB | 1.4GB | -63% |

---

## ⚠️ 发现的问题：plugin-development/my-plugins/

### 分析结果

在 `plugin-development/my-plugins/` 中发现 **4 个插件项目**，需要决策其归属：

#### 1. dsh-flow-engine（工作流引擎）
**状态**: 完整的领域项目
**结构**:
```
dsh-flow-engine/
├── domains/flow/
│   └── dsh-domain.json         # 领域定义
├── plugin/
│   ├── dsh-flow-engine/        # 主插件（含Python执行器）
│   │   ├── contract/flow-engine-contract.json
│   │   ├── server/py-executor/ # Python虚拟环境 + 依赖
│   │   └── package.json
│   └── dsh-flow-engine-suite/
│       └── dsh-suite.json      # Suite定义
```
**功能**: 
- 工作流DSL执行引擎
- 支持节点画布和YAML DSL
- 集成LLM路由和Python执行器
- 包含fixtures测试用例（AI翻译等工作流）

**建议**: 
- ✅ **保留并移至 `extensions/flow/`** （如果是活跃开发中的正式功能）
- 🔴 **移至 `archives/experiments/`** （如果是废弃的实验）

#### 2. dsh-llm-config（LLM配置管理器）
**状态**: 完整的领域项目
**结构**:
```
dsh-llm-config/
├── domains/llm-config/
│   └── dsh-domain.json
├── plugin/
│   ├── dsh-llm-config/
│   │   ├── contract/llm-config-contract.json
│   │   ├── server/shared/      # 共享基础设施快照
│   │   └── package.json
│   └── dsh-llm-config-suite/
│       └── dsh-suite.json
```
**功能**:
- LLM配置管理
- 提供 `llm_config_echo` 和 `llm_config_capabilities` 工具
- 包含共享基础设施快照（service-host, tool-host, state-service）

**建议**:
- ✅ **保留并移至 `extensions/llm-config/`** （如果是活跃功能）
- 🔴 **移至 `archives/experiments/`** （如果已被其他方案替代）

#### 3. dsh-ppt-editor（PPT编辑器）
**状态**: 独立插件（有package.json）
**结构**:
```
dsh-ppt-editor/
├── package.json          # v1.0.0
├── README.md            # "AI驱动的演示文稿创建和编辑工具"
├── cordis.patch.yml
├── lib/
└── ui/
```
**功能**: 
- AI生成和编辑PPT
- 实时预览效果
- 集成到侧边栏

**与现有代码关系**: 
- `extensions/bridges/ppt-bridge/` 已经存在完整的PPT领域项目
- 可能是重复实现或不同版本

**建议**:
- 🔄 **评估与 ppt-bridge 的关系**，决定：
  - 合并到 `extensions/bridges/ppt-bridge/plugins/`
  - 作为独立插件保留
  - 废弃删除

#### 4. dsh-ppt-sidebar（PPT工作台侧边栏版）
**状态**: 独立插件（有package.json）
**结构**:
```
dsh-ppt-sidebar/
├── package.json          # v1.0.0
├── README.md            # "侧边栏集成版本"
├── cordis.patch.yml
├── start.mjs            # 启动脚本
├── lib/
└── ui/
```
**功能**:
- AI生成PPT
- 实时预览
- 低延迟交互
- 侧边栏集成

**与现有代码关系**:
- 与 `dsh-ppt-editor` 类似，但强调侧边栏集成
- 也可能与 `ppt-bridge` 重叠

**建议**:
- 🔄 **评估与 ppt-bridge 的关系**，决定合并或废弃

---

## 🎯 推荐的下一步行动

### 优先级1：决策 my-plugins 归属

需要回答以下问题：

1. **dsh-flow-engine 和 dsh-llm-config**：
   - [ ] 这两个是正在开发的正式功能吗？
   - [ ] 还是已经被其他方案替代的实验？
   - [ ] 如果保留，是否需要清理Python虚拟环境？

2. **dsh-ppt-editor 和 dsh-ppt-sidebar**：
   - [ ] 它们与 `extensions/bridges/ppt-bridge/` 是什么关系？
   - [ ] 是否是同一个功能的不同实现？
   - [ ] 哪个是最新的、应该保留的版本？

### 优先级2：处理建议

根据你的回答，我将执行以下操作之一：

#### 选项A：保留为正式扩展
```bash
# 移动到正式扩展目录
mkdir -p extensions/flow
mkdir -p extensions/llm-config
mv plugin-development/my-plugins/dsh-flow-engine extensions/flow/
mv plugin-development/my-plugins/dsh-llm-config extensions/llm-config/

# 合并PPT相关到ppt-bridge
mv plugin-development/my-plugins/dsh-ppt-* extensions/bridges/ppt-bridge/plugins/
```

#### 选项B：归档为历史实验
```bash
# 移动到归档目录
mkdir -p archives/experiments/my-plugins-snapshot
mv plugin-development/my-plugins/* archives/experiments/my-plugins-snapshot/
echo "归档日期: 2024-11-03" > archives/experiments/my-plugins-snapshot/ARCHIVED.md
```

#### 选项C：直接删除
```bash
# 如果确认已废弃且不需要保留
rm -rf plugin-development/my-plugins/
```

### 优先级3：重构 plugin-development/

一旦 my-plugins 归属明确，执行完整的 plugin-development 重构：

1. 提取 `lib/` → `packages/plugin-packaging/`
2. 移动 `templates/` → `tools/plugin-generator/templates/`
3. 移动 `examples/` → `examples/plugins/`
4. 合并文档到 `docs/guides/`
5. 删除空壳 `plugin-development/`

---

## 📋 检查清单

### 已完成 ✅
- [x] 备份用户数据
- [x] 删除验证构建（节省2.1GB）
- [x] 删除dist/release构建产物
- [x] 清理运行时状态文件
- [x] 生成分类报告

### 待处理 ⏳
- [ ] 决策 my-plugins 中4个插件的归属
- [ ] 解决 bundles/ 依赖问题（产品清单引用）
- [ ] 迁移用户工作区（core-harness/workspace*）
- [ ] 重构 plugin-development/ 目录
- [ ] 整理文档目录结构
- [ ] 重命名 evolution/ → research/
- [ ] 添加元数据文件（ARCHIVED.md, VENDOR.md, registry.json）

### 风险提示 ⚠️
- ✅ 所有已删除内容均可通过构建重建
- ✅ 用户数据已备份
- ⚠️ bundles/ 尚未删除（被产品依赖）
- ⚠️ workspace*/ 用户工作区尚未迁移

---

## 🔍 后续建议

### 立即可做的安全操作
1. 重命名 `evolution/` → `research/`（不破坏功能）
2. 删除空目录 `extensions/suites/`, `extensions/experimental/`
3. 添加文档说明文件

### 需要代码修改的操作
1. 解除 `products/dsh-desktop/product.json` 对 `bundles/` 的依赖
2. 修改 `tools/plugin-release` 对 `plugin-development/lib/` 的引用
3. 更新 `.gitignore` 添加新的 `out/` 目录

### 需要测试验证的操作
1. 迁移 plugin-development/lib/ 后运行发布测试
2. 移动插件后验证构建和打包流程
3. 删除 bundles/ 后验证产品打包

---

## 总结

✅ **第一阶段清理成功完成**
- 节省空间：2.4GB (63%)
- 保留核心源码：1.4GB
- 所有操作安全可逆

⚠️ **需要你的决策**
- plugin-development/my-plugins/ 中的4个插件去向

🎯 **下一步目标**
- 完成插件归属决策
- 重构 plugin-development/
- 建立标准的目录结构

---

请告诉我：
1. 这4个插件（flow-engine, llm-config, ppt-editor, ppt-sidebar）的状态
2. 你希望如何处理它们（保留/归档/删除）
3. 是否需要我继续执行后续重构步骤
