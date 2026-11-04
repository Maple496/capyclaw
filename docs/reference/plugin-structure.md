# DSH 插件体系架构规范

## 📁 目录结构（强制）

```
deepseekharness_dev/
├── extensions/                          # 🆕 统一插件根目录
│   ├── official/                        # 官方维护插件
│   │   ├── port-sidebar/                # 端口侧边栏
│   │   ├── document-viewer/             # 文档查看器
│   │   └── ...
│   ├── suites/                          # 插件套件（组合包）
│   │   ├── ppt-suite/                   # PPT 工作台套件
│   │   └── office-suite/                # 未来的 Office 套件
│   ├── bridges/                         # 外部工具桥接
│   │   ├── canvas-bridge/               # Canvas MCP 桥
│   │   └── ppt-bridge/                  # PPT 编辑器桥
│   └── experimental/                    # 实验性插件
│       └── ...
│
├── packages/                            # 基础设施（不变）
│   ├── dsh-plugin-kit/                  # 插件开发 SDK
│   ├── dsh-suite-kit/                   # 套件打包工具
│   ├── dsh-service-host/                # 服务托管
│   └── ...
│
├── tools/                               # 开发工具链
│   ├── plugin-validator/                # 插件验证工具
│   ├── plugin-generator/                # 插件脚手架生成器
│   ├── plugin-release/                  # 发布、源索引与校验
│   └── dsh-launcher/                    # dsh 全栈启动器（--stack）
│
└── vendor/                              # 外来引入代码（flow-executor）

## 废弃目录
- ❌ `plugins/` → 迁移到 `extensions/`
- ❌ `bridges/` → 迁移到 `extensions/bridges/`
- ❌ `plugins/ppt文档/` → 迁移到 `research/vendor-libraries/`
```

---

## 🔒 插件规范（强制验证）

### 1. 目录结构（必需）
```
my-plugin/
├── package.json              # 必需：包含 dsh 字段
├── lib/                      # 必需：主入口（host 端）
│   └── index.mjs
├── client/                   # 可选：客户端代码
│   └── client.js
├── test/                     # 必需：至少一个测试
│   └── *.test.mjs
├── README.md                 # 必需：使用说明
└── cordis.patch.yml          # 可选：Cordis 配置
```

### 2. package.json 必需字段
```json
{
  "name": "dsh-*",                       // 强制：必须 dsh- 前缀
  "version": "x.y.z",                    // 强制：语义化版本
  "description": "...",                  // 强制：清晰描述
  "type": "module",                      // 强制：ESM
  "main": "./lib/index.mjs",             // 强制：主入口
  "exports": { ... },                    // 强制：明确导出
  "dependencies": {
    "dsh-plugin-kit": "^x.y.z"           // 强制：必须依赖 plugin-kit
  },
  "dsh": {                               // 强制：DSH 元数据
    "bundle": { ... },
    "category": "ui|service|bridge|tool", // 强制：插件分类
    "platform": "web|desktop|both"       // 强制：支持平台
  },
  "meta": {                              // 强制：用户可见元数据
    "title": "...",
    "description": "..."
  },
  "scripts": {
    "test": "..."                        // 强制：测试脚本
  }
}
```

### 3. 基础设施依赖（分层，强制检查）

**最小层（Tier 0）：纯客户端插件**
```json
{
  "dependencies": {
    "dsh-plugin-kit": "^0.2.0"  // 仅此，提供注册辅助和类型
  }
}
```

**标准层（Tier 1）：需要服务端能力**
```json
{
  "dependencies": {
    "dsh-plugin-kit": "^0.2.0",
    "dsh-service-host": "^0.1.0"  // 服务托管
  }
}
```

**完整层（Tier 2）：复杂业务插件**
```json
{
  "dependencies": {
    "dsh-plugin-kit": "^0.2.0",
    "dsh-service-host": "^0.1.0",
    "dsh-tool-host": "^0.1.0",      // 工具集成
    "dsh-asset-service": "^0.1.0"   // 资产管理
  }
}
```

**套件层（Suite）：插件组合**
```json
{
  "dependencies": {
    "dsh-suite-kit": "^0.1.0",
    "my-plugin-a": "^1.0.0",
    "my-plugin-b": "^1.0.0"
  },
  "dsh": {
    "suite": "./dsh-suite.json"
  }
}
```

---

## ⚙️ 验证规则（程序强制）

### 自动验证检查项

1. **目录结构验证**
   - ✅ 必需文件存在：package.json, lib/, README.md, test/
   - ✅ 命名规范：`dsh-*` 或 `@org/dsh-*`

2. **package.json 验证**
   - ✅ 必需字段完整：name, version, main, dsh, meta
   - ✅ 依赖检查：必须包含 `dsh-plugin-kit`
   - ✅ 版本一致性：基础设施包版本必须在锁定范围内

3. **代码质量验证**
   - ✅ ESM 模块格式
   - ✅ 至少一个测试文件存在
   - ✅ 测试可执行（npm test 不报错）

4. **运行时验证**
   - ✅ 插件可正常加载（import 不报错）
   - ✅ 导出符合约定（提供 apply 或 name 字段）

### 验证时机
- 开发时：`npm run validate` 手动验证
- 提交前：Git pre-commit hook 自动验证
- CI/CD：所有插件自动验证
- 安装时：`dsh plugin install` 验证后才安装

---

## 🛠️ 开发工具

### 1. 创建新插件
```bash
npm run create-plugin official/my-plugin --tier 1
# 生成标准骨架，自动配置依赖
```

### 2. 验证插件
```bash
npm run validate-plugin extensions/official/my-plugin
# 输出：✅ 所有检查通过 或 ❌ 违规项清单
```

### 3. 测试插件
```bash
npm run test-plugin extensions/official/my-plugin
# 运行测试 + 集成验证
```

### 4. 发布插件（套件）
```bash
npm run publish-suite extensions/suites/my-suite
# 自动锁定依赖版本、生成 composition.lock.json
```

---

## 📦 迁移计划

### Phase 1: 目录重组（本次）
- 创建 `extensions/`, `tools/`, `research/`
- 迁移现有插件到新结构
- 清理 `plugins/ppt文档/`

### Phase 2: 强制验证（本次）
- 实现 `plugin-validator` 工具
- 所有插件必须通过验证才能使用

### Phase 3: 脚手架与自动化
- 实现 `plugin-generator`
- 集成到开发流程

### Phase 4: 文档与培训
- 完整的插件开发指南
- 示例插件库
