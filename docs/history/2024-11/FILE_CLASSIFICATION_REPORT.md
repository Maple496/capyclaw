# 项目文件归属分类报告

生成时间：2024-11-03
项目根目录：<repo>

---

## 一、核心源码（应保留并规范）

### 1.1 主程序 - core-harness/
**状态**: ✅ 核心源码
**大小**: 516MB
**归属**: `apps/harness/`
```
core-harness/deepseek-harness/
├── auth-proxy.mjs          # 认证代理
├── process-manager.mjs     # 进程管理
├── single-instance.mjs     # 单实例控制
├── start-safe.mjs          # 启动入口
├── package.json
└── README.md
```
**问题**:
- 包含运行时用户数据 `workspace/`, `workspace-keynote/`, `workspace-qa/`（应分离）
- 包含测试文档 `keynote-docs/`（应移至 docs/ 或 examples/）

### 1.2 基础包 - packages/
**状态**: ✅ 核心源码
**大小**: 1.6MB
**归属**: `packages/` （保持）
```
packages/
├── dsh-plugin-kit/          # 插件 SDK
├── dsh-runtime-kit/         # 运行时内核
├── dsh-suite-kit/           # Suite 编排
├── dsh-stack-kit/           # Stack 编译
├── dsh-service-broker/      # 服务管理
├── dsh-assembly-kit/        # 组件组装
├── dsh-runtime-control/     # 运行时控制
├── dsh-service-host/        # 服务宿主
├── dsh-tool-host/           # 工具宿主
├── dsh-editor-host/         # 编辑器宿主
├── dsh-workspace-service/   # 工作区服务
├── dsh-state-service/       # 状态服务
├── dsh-asset-service/       # 资产服务
├── dsh-mcp-gateway/         # MCP 网关
├── dsh-document-workbench/  # 文档工作台
├── dsh-catalog/             # 组件目录
└── dsh-installer/           # 安装器
```
**评价**: 职责清晰，结构良好

### 1.3 官方扩展 - extensions/
**状态**: ✅ 核心源码（部分需整理）
**大小**: 64MB
**归属**: `extensions/`
```
extensions/
├── official/
│   ├── dsh-launchpad/       # ✅ 管理界面（稳定）
│   ├── dsh-llm-tempkey/     # ✅ LLM 临时密钥（稳定）
│   └── dsh-port-sidebar/    # ✅ 端口侧边栏（稳定）
├── bridges/
│   ├── ppt-bridge/          # ✅ PPT 桥接（活跃开发中）
│   └── canvas-bridge/       # ⚠️ 状态不明（只有 node_modules）
├── suites/                  # 🔴 空目录
└── experimental/            # 🔴 空目录
```
**问题**:
- `ppt-bridge/` 是完整的领域项目，包含 plugin/suite/domain，应保持完整
- `canvas-bridge/` 只有依赖，没有源码（可能未完成或已废弃）
- `suites/` 和 `experimental/` 空目录误导性强

### 1.4 开发工具 - tools/
**状态**: ✅ 核心源码
**大小**: 1.9MB
**归属**: `tools/`
```
tools/
├── dsh-launcher/            # ✅ 启动器（核心）
├── plugin-generator/        # ✅ 插件生成器
├── plugin-validator/        # ✅ 插件验证器
├── plugin-release/          # ✅ 插件发布工具
└── product-packager/        # ✅ 产品打包器
```
**评价**: 工具链完整，职责明确

### 1.5 产品定义 - products/
**状态**: ✅ 核心源码
**大小**: 4.0KB
**归属**: `products/`
```
products/
└── dsh-desktop/
    └── product.json         # 产品清单
```
**问题**: 依赖 `bundles/dsh-ppt-windows-bundle/node`（被 gitignore 的历史 bundle）

### 1.6 启动清单 - launchpads/
**状态**: ✅ 核心源码（示例配置）
**大小**: 5.0KB
**归属**: `launchpads/` 或 `examples/launchpads/`
```
launchpads/
├── example.stack
└── （其他 .stack 文件）
```

### 1.7 自动化脚本 - scripts/
**状态**: ✅ 核心源码
**大小**: 93KB
**归属**: `scripts/`
```
scripts/
├── lib/                     # 共享库（⚠️ 被产品打包器引用）
├── test/
├── validate-all-plugins.mjs
├── test-all-plugins.mjs
├── sync-shared.mjs
└── 其他工具脚本
```
**问题**: `lib/` 中的代码被正式工具引用，应提升为 package

---

## 二、构建产物（应删除或迁移到 out/）

### 2.1 插件源发布 - dist/
**状态**: 🔴 构建产物
**大小**: 636KB
**归属**: 删除或移至 `out/plugin-sources/`
```
dist/
├── index.json               # 插件索引
└── plugins/
    ├── dsh-launchpad-1.1.0.zip
    ├── dsh-llm-tempkey-1.0.0.zip
    └── dsh-port-sidebar-1.0.1.zip
```
**处理**: `.gitignore` 已忽略，可删除重建

### 2.2 完整源发布 - release/
**状态**: 🔴 构建产物
**大小**: 1.3MB
**归属**: 删除或移至 `out/releases/`
```
release/
├── dsh-plugin-source-20261103-050503.zip  # 带时间戳的归档
└── plugin-source/                          # 与 dist/ 重复
    ├── index.json
    └── plugins/*.zip
```
**处理**: 与 `dist/` 内容重复，应统一输出位置

### 2.3 产品构建 - dist-products/
**状态**: 🔴 构建产物 + ⚠️ 用户数据
**大小**: 2.8GB (!) 
**归属**: 删除或移至 `out/products/`，`data/` 目录需保护
```
dist-products/
├── dsh-desktop/                           # 正式产品构建
│   ├── app/                               # 应用代码
│   ├── node/                              # Node 运行时
│   ├── launcher/                          # 启动器
│   └── data/                              # ⚠️ 用户数据，不可删除！
├── verify-agent-20261103-unique-01/       # 🔴 验证构建 1
├── verify-isolated-20261103-unique/       # 🔴 验证构建 2
└── verify-real-20261103-unique2/          # 🔴 验证构建 3
```
**严重问题**: 
- 占用 2.8GB，包含多个验证构建
- `dsh-desktop/data/` 可能包含用户数据，删除前需备份
- 验证构建应放到临时目录或独立的 `out/verification/`

### 2.4 历史 Bundle - bundles/
**状态**: 🔴 历史构建产物（被产品依赖！）
**大小**: 99MB
**归属**: 应移除依赖后删除
```
bundles/
└── dsh-ppt-windows-bundle/
    └── node/                              # Node.js 运行时 (99MB)
```
**严重问题**: 
- 被 `products/dsh-desktop/product.json` 依赖
- 应改为声明式运行时清单，从官方渠道下载
- `.gitignore` 已忽略，但实际存在且被依赖

### 2.5 plugin-development/dist/
**状态**: 🔴 构建产物
**大小**: 包含在 44MB 中
**归属**: 删除
```
plugin-development/dist/
├── dsh-port-sidebar-v1.0.0.zip
└── dsh-port-sidebar-v1.0.1.zip
```
**处理**: 旧版本插件包，应删除

---

## 三、开发工作区（应分离或标准化）

### 3.1 plugin-development/
**状态**: ⚠️ 混合用途目录
**大小**: 44MB
**归属**: 拆分为多个目标
```
plugin-development/
├── lib/                     # 🔴 问题：被 tools/plugin-release 引用
├── templates/               # ✅ 模板：移至 tools/plugin-generator/
├── examples/                # ✅ 示例：移至根 examples/
├── docs/                    # ⚠️ 文档：与 docs/ 重复
├── my-plugins/              # 🔴 用户插件工作区
│   ├── dsh-flow-engine/     # ⚠️ 状态不明
│   ├── dsh-llm-config/      # ⚠️ 状态不明
│   ├── dsh-ppt-editor/      # ⚠️ 状态不明
│   └── dsh-ppt-sidebar/     # ⚠️ 状态不明
├── dist/                    # 🔴 构建产物（见上）
└── PLUGIN_*.md              # ⚠️ 文档：与 docs/ 重复
```
**严重问题**:
1. **`lib/` 反向耦合**: `tools/plugin-release` 引用 `plugin-development/lib/pack.mjs` 和 `zip.mjs`
2. **`my-plugins/` 归属不清**: 是正式源码？实验项目？用户草稿？
3. **文档重复**: 5 个 MD 文档与 `docs/` 中的插件开发指南重复
4. **多个入口混乱**: 根 `package.json` 指向 `tools/`，这里又提供另一套

**建议处理**:
- `lib/` → 提取为 `packages/plugin-packaging/`
- `templates/` → 移至 `tools/plugin-generator/templates/`
- `examples/` → 移至根 `examples/plugins/`
- `docs/` → 合并到 `docs/plugins/`，删除重复
- `my-plugins/` → **需要用户决策**（见下方）

### 3.2 my-plugins/ 决策
**四个插件的归属需要明确**:

| 插件 | 可能状态 | 建议处理 |
|------|---------|---------|
| `dsh-flow-engine` | 包含 plugin/suite/domain | 评估后决定：移至 `extensions/` 或删除 |
| `dsh-llm-config` | 包含 plugin/suite/domain | 评估后决定：移至 `extensions/` 或删除 |
| `dsh-ppt-editor` | PPT 相关 | 考虑合并到 `extensions/bridges/ppt-bridge/` |
| `dsh-ppt-sidebar` | PPT 相关 | 考虑合并到 `extensions/bridges/ppt-bridge/` |

**需要检查**:
1. 这些插件是否已经发布？
2. 是否在 `extensions/official/` 中有对应？
3. 是否只是历史实验？

---

## 四、历史材料（应归档或删除）

### 4.1 archives/
**状态**: ✅ 已归档（但包含可执行代码）
**大小**: 1.5MB
**归属**: 保持 `archives/`，但需标注
```
archives/
├── code-audit/              # 代码审计记录（2026-11-01）
│   ├── inventory.json       # 组件清单
│   ├── dup-report.json      # 重复代码报告
│   └── removed/             # 已删除的代码快照
├── desktop-integration/     # 桌面集成历史方案
│   ├── canvas-bridge-deliver/
│   └── workspace-services.json
├── experiments/             # 实验项目
│   ├── dsh-multi-agent/     # 多代理实验（完整 package.json）
│   └── ppt-bridge-openevolve/
└── frontend-orphan/         # 废弃的前端代码
```
**评价**: 已集中归档，但：
- 包含完整可执行源码（.mjs, package.json）
- 搜索时会误命中
- 建议：添加 `ARCHIVED_*.md` 标记，说明归档原因和日期

### 4.2 evolution/
**状态**: ⚠️ 实验框架（活跃使用中）
**大小**: 627KB
**归属**: 重命名为 `research/` 或 `experiments/`
```
evolution/
├── cases/                   # 测试用例
├── evaluators/              # 评估器（可执行代码）
├── results/                 # 测试结果
├── analyze-relay.mjs
├── chain-bench.mjs
└── genomes.mjs
```
**评价**: 
- 不是"已废弃"的历史材料
- 是活跃的测试/基准框架
- 应重命名为 `research/` 或 `tests/benchmark/`

### 4.3 vendor/
**状态**: ⚠️ 第三方代码（来源不明）
**大小**: 511KB
**归属**: 保持 `vendor/`，但需补充元数据
```
vendor/
└── flow-executor/           # Flow 执行器
    ├── app/
    ├── artifacts/
    ├── fixtures/
    └── _vendor/
```
**问题**:
- 无 README 说明来源、版本、许可证
- 无更新策略
- 建议：添加 `vendor/flow-executor/VENDOR.md` 说明来源和维护方式

---

## 五、文档（需要整理）

### 5.1 根目录文档
**状态**: ✅ 保留
```
根目录/
├── README.md                # ✅ 项目主 README
├── QUICKSTART.md            # ✅ 快速开始
├── CHAIN_CONTRACTS.md       # ✅ 契约文档
└── .gitignore               # ✅ 忽略规则
```

### 5.2 docs/
**状态**: ⚠️ 需要整理
**大小**: 328KB
```
docs/
├── PLUGIN_*.md              # 插件开发指南（4 个文件）
├── SERVICE_STANDARD.md      # 服务标准
├── PUBLIC_PLUGINS.md        # 公共插件
├── PYTHON_DEPLOYMENT_ADAPTER.py  # 🔴 可执行代码！
└── reports/                 # 🔴 大量历史报告（27 个文件）
```
**严重问题**:
1. **代码混入文档**: `PYTHON_DEPLOYMENT_ADAPTER.py` 应移至 `tools/` 或 `examples/`
2. **历史报告泛滥**: 27 个报告文件，包括：
   - 交付报告（DELIVERY*.md）
   - 重构报告（REFACTORING_REPORT.md）
   - 实现报告（*_IMPLEMENTATION_REPORT.md）
   - 演进报告（EVOLUTION_REPORT_*.md）
3. **文档重复**: 与 `plugin-development/` 中的文档重复

**建议处理**:
```
docs/
├── architecture/            # 架构文档
│   ├── contracts.md
│   └── service-standard.md
├── guides/                  # 用户指南
│   ├── quickstart.md
│   ├── plugin-development.md
│   └── product-packaging.md
├── reference/               # 参考文档
│   └── api/
├── history/                 # 历史报告（标注日期）
│   └── 2024-11/
│       ├── delivery-report.md
│       └── evolution-report.md
└── examples/
    └── python-deployment-adapter.py
```

---

## 六、运行时状态（不应在源码仓库）

### 6.1 .dshd/
**状态**: ⚠️ 运行时状态
**大小**: 包含在总计中
**归属**: 用户本地，`.gitignore` 已忽略
```
.dshd/
└── launchpads/
    └── example/             # 运行时示例
```
**处理**: 已被 `.gitignore`，无需操作

### 6.2 tools/dsh-launcher/.dshd/
**状态**: ⚠️ 运行时状态
**归属**: 应删除或移至全局位置
**处理**: 工具不应在自身目录保存状态

### 6.3 core-harness/deepseek-harness/workspace*/
**状态**: ⚠️ 用户数据
**大小**: 包含在 516MB 中
**归属**: 应移至项目外
```
core-harness/deepseek-harness/
├── workspace/               # 🔴 用户工作区
├── workspace-keynote/       # 🔴 用户工作区
└── workspace-qa/            # 🔴 用户工作区
```
**严重问题**: 
- 包含用户笔记、报告、插件项目
- 不应在源码仓库中
- 应移至 `~/Documents/DSH/` 或其他用户目录

### 6.4 component-library.json
**状态**: ⚠️ 生成文件
**大小**: 31KB
**归属**: `.gitignore` 已忽略
**处理**: 可删除重建

---

## 七、归属分类总结

### 按处理优先级分类

#### P0 - 立即删除（构建产物，可重建）
```
总大小：~3.0GB

🔴 必删：
- dist-products/verify-agent-*         (验证构建 × 3)
- dist-products/verify-isolated-*      
- dist-products/verify-real-*          
- dist/                                 (插件源)
- release/                              (完整源)
- plugin-development/dist/              (旧插件包)
- component-library.json                (生成文件)
```

#### P1 - 需要决策（混合归属）
```
⚠️ 需要用户决策：

1. plugin-development/my-plugins/
   - dsh-flow-engine      → 是否保留？移至 extensions/?
   - dsh-llm-config       → 是否保留？移至 extensions/?
   - dsh-ppt-editor       → 合并到 ppt-bridge?
   - dsh-ppt-sidebar      → 合并到 ppt-bridge?

2. bundles/dsh-ppt-windows-bundle/
   - 被产品依赖，需先解除依赖关系
   - 建议：声明式运行时清单 → 官方下载

3. core-harness/deepseek-harness/workspace*/
   - 用户工作区，迁移到项目外

4. dist-products/dsh-desktop/data/
   - ⚠️ 可能包含用户数据，删除前需检查
```

#### P2 - 需要重组（目录结构）
```
🔄 需要重构：

1. plugin-development/
   - lib/        → packages/plugin-packaging/
   - templates/  → tools/plugin-generator/templates/
   - examples/   → examples/plugins/
   - docs/       → docs/plugins/（合并去重）

2. docs/reports/
   - 27 个历史报告 → docs/history/YYYY-MM/

3. docs/PYTHON_DEPLOYMENT_ADAPTER.py
   - 可执行代码 → tools/ 或 examples/

4. evolution/
   - 重命名为 research/ 或 tests/benchmark/

5. extensions/
   - 删除空目录 suites/, experimental/
   - canvas-bridge/ 评估状态
```

#### P3 - 需要补充元数据
```
📝 需要文档：

1. vendor/flow-executor/
   - 添加 VENDOR.md（来源、版本、许可证）

2. archives/
   - 添加 ARCHIVED.md（归档原因、日期）

3. 所有 packages/
   - 补充 exports 字段
   - 声明依赖关系
```

---

## 八、建议的目标结构

```
project/
├── README.md
├── QUICKSTART.md
├── .gitignore
│
├── apps/
│   └── harness/                    # 从 core-harness 移入（不含 workspace）
│
├── packages/                       # ✅ 保持现状
│   ├── plugin-packaging/           # 🆕 从 plugin-development/lib 提取
│   └── ...其他 16 个包
│
├── extensions/                     # ✅ 保持，清理空目录
│   ├── registry.json               # 🆕 统一注册表
│   ├── official/                   # ✅ 3 个稳定插件
│   ├── bridges/
│   │   ├── ppt/                    # 🔄 重命名 ppt-bridge → ppt
│   │   └── canvas/                 # ⚠️ 评估后保留或删除
│   └── （删除 suites/, experimental/ 空目录）
│
├── products/                       # ✅ 保持
│   └── dsh-desktop/
│       ├── product.json
│       └── runtime-manifest.json   # 🆕 显式声明 Node 来源
│
├── tools/                          # ✅ 保持
│   ├── dsh-launcher/
│   ├── plugin-dev/                 # 🆕 合并 generator + 脚手架
│   ├── plugin-validator/
│   ├── plugin-release/
│   └── product-packager/
│
├── examples/                       # 🆕 集中示例
│   ├── plugins/                    # 从 plugin-development/examples
│   ├── launchpads/                 # 从根 launchpads/
│   └── scripts/
│       └── python-deployment-adapter.py
│
├── tests/                          # 🆕 跨包测试
│   └── integration/
│
├── research/                       # 🔄 从 evolution/ 重命名
│   ├── benchmark/
│   └── experiments/
│
├── docs/
│   ├── architecture/
│   │   ├── contracts.md            # 从根 CHAIN_CONTRACTS.md
│   │   └── service-standard.md
│   ├── guides/
│   │   ├── quickstart.md           # 从根 QUICKSTART.md
│   │   ├── plugin-development.md   # 合并多份指南
│   │   └── product-packaging.md
│   ├── reference/
│   └── history/                    # 🔄 从 docs/reports/ 移入
│       └── 2024-11/
│
├── archives/                       # ✅ 保持
│   └── ARCHIVED.md                 # 🆕 说明归档策略
│
├── vendor/                         # ✅ 保持
│   └── flow-executor/
│       └── VENDOR.md               # 🆕 说明来源
│
├── scripts/                        # ✅ 保持（仅编排）
│   └── （lib/ 中可复用代码应提升为 package）
│
└── out/                            # 🆕 统一构建输出（gitignore）
    ├── plugins/                    # 替代 dist/
    ├── releases/                   # 替代 release/
    ├── products/                   # 替代 dist-products/
    └── verification/               # 验证构建专用
```

---

## 九、执行计划

### 阶段 1：清理构建产物（安全，可立即执行）
```bash
# 1. 备份可能包含用户数据的目录
mkdir -p ../backup
cp -r dist-products/dsh-desktop/data ../backup/dsh-desktop-data-backup

# 2. 删除验证构建
rm -rf dist-products/verify-*

# 3. 删除可重建的构建产物
rm -rf dist/
rm -rf release/
rm -rf plugin-development/dist/
rm component-library.json

# 4. 清理运行时状态
rm -rf tools/dsh-launcher/.dshd/

# 节省空间：~1.5GB
```

### 阶段 2：解决 my-plugins 归属（需要检查）
```bash
# 检查各插件状态
cd plugin-development/my-plugins/

# 对每个插件执行：
for plugin in dsh-*/; do
  echo "=== $plugin ==="
  cat "$plugin/package.json" | grep -E '"name"|"version"|"description"'
  echo ""
done

# 根据检查结果决定：
# - 保留 → 移至 extensions/
# - 废弃 → 移至 archives/my-plugins-snapshot/
# - 合并 → 合并到对应领域项目
```

### 阶段 3：重构 plugin-development（破坏性）
```bash
# 1. 提取共享库为独立包
mkdir -p packages/plugin-packaging
mv plugin-development/lib/* packages/plugin-packaging/src/
# 创建 packages/plugin-packaging/package.json

# 2. 移动模板
mv plugin-development/templates tools/plugin-generator/

# 3. 移动示例
mkdir -p examples/plugins
mv plugin-development/examples/* examples/plugins/

# 4. 合并文档
mv plugin-development/*.md docs/guides/
# 手动去重合并

# 5. 删除空壳
rm -rf plugin-development/
```

### 阶段 4：解决 bundles 依赖（需要修改产品清单）
```bash
# 1. 创建运行时清单
cat > products/dsh-desktop/runtime-manifest.json <<EOF
{
  "nodejs": {
    "version": "18.20.0",
    "platform": "win32",
    "arch": "x64",
    "source": "https://nodejs.org/dist/v18.20.0/node-v18.20.0-win-x64.zip",
    "sha256": "..."
  }
}
EOF

# 2. 修改 product.json 引用
# 从：nodeSource: "bundles/dsh-ppt-windows-bundle/node"
# 改为：runtimeManifest: "./runtime-manifest.json"

# 3. 删除 bundles
rm -rf bundles/

# 节省空间：99MB
```

### 阶段 5：迁移用户工作区（需要用户确认）
```bash
# 1. 检查工作区内容
find core-harness/deepseek-harness/workspace* -type f

# 2. 迁移（示例）
mkdir -p ~/Documents/DSH-Workspaces/
mv core-harness/deepseek-harness/workspace* ~/Documents/DSH-Workspaces/

# 3. 更新 harness 配置以指向新位置
```

### 阶段 6：整理文档
```bash
# 1. 创建新结构
mkdir -p docs/{architecture,guides,reference,history/2024-11}

# 2. 移动历史报告
mv docs/reports/* docs/history/2024-11/

# 3. 移动可执行代码
mv docs/PYTHON_DEPLOYMENT_ADAPTER.py examples/scripts/

# 4. 移动根文档
mv CHAIN_CONTRACTS.md docs/architecture/contracts.md
mv QUICKSTART.md docs/guides/quickstart.md
```

### 阶段 7：重命名和清理
```bash
# 1. 重命名 evolution
mv evolution research

# 2. 删除空目录
rmdir extensions/suites extensions/experimental

# 3. 添加元数据文件
# - archives/ARCHIVED.md
# - vendor/flow-executor/VENDOR.md
# - extensions/registry.json
```

---

## 十、风险评估

### 高风险操作（需要格外小心）
1. **删除 dist-products/dsh-desktop/data/** 
   - 可能包含用户数据
   - 必须先检查并备份

2. **移动 plugin-development/lib/**
   - 被 tools/plugin-release 引用
   - 需要同步修改引用路径

3. **删除 bundles/**
   - 被 products/dsh-desktop/product.json 依赖
   - 必须先解除依赖

4. **移动 core-harness/workspace*/**
   - 可能包含重要用户数据
   - 需要用户确认

### 中风险操作（可能影响构建）
1. **移动 plugin-development/templates/**
   - 可能被脚本硬编码路径引用

2. **删除 dist/, release/**
   - 如果 CI/CD 依赖这些目录
   - 需要更新部署脚本

### 低风险操作（安全）
1. **删除验证构建** verify-*
2. **删除 component-library.json**
3. **整理文档目录**
4. **重命名 evolution/ → research/**

---

## 十一、预期收益

### 磁盘空间节省
```
当前总占用：~3.8GB

删除构建产物：
- dist-products/verify-* (3 × ~700MB)  ≈ 2.1GB
- dist/                                ≈ 1MB
- release/                             ≈ 1MB
- plugin-development/dist/             ≈ 50MB
- bundles/                             ≈ 99MB
----------------------------------------------
预计节省：~2.25GB (减少 59%)

剩余核心源码：~1.55GB
```

### 结构清晰度提升
- ✅ 消除源码/产物混淆
- ✅ 统一构建输出位置
- ✅ 明确组件归属
- ✅ 减少文档重复
- ✅ 分离用户数据

### 独立演化就绪度
- ✅ 明确包边界
- ✅ 减少反向依赖
- ✅ 统一工具链入口
- ✅ 为契约层铺路

---

## 十二、下一步行动建议

**推荐执行顺序**：

1. **先执行阶段 1**（清理构建产物）—— 安全，立即见效
2. **然后执行阶段 2**（检查 my-plugins）—— 需要决策但不破坏现状
3. **再执行阶段 6**（整理文档）—— 低风险，提升可维护性
4. **最后执行阶段 3-5**（重构目录）—— 破坏性操作，需要充分测试

**需要你现在决策的问题**：

1. **plugin-development/my-plugins/ 中的 4 个插件**：
   - 是否还在使用？
   - 是否应该成为正式扩展？
   - 还是历史实验可以归档？

2. **core-harness/workspace*** 用户工作区**：
   - 里面有重要数据吗？
   - 迁移到哪个位置？

3. **构建产物的 data/ 目录**：
   - 是否需要保留？
   - 是测试数据还是实际用户数据？

要我帮你执行哪个阶段？还是先检查某些具体内容？
