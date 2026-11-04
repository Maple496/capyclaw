# DSH 插件开发指南

欢迎！本指南帮助你快速创建符合规范的 DSH 插件。

## ⚡ 服务解耦标准（2026-11-01 起强制，先读这个）

**服务于服务彼此独立，各自只守自己的端口；跨端口调动或拉起其他服务，
一律交给中间件（`dsh-service-broker`）。**

- 需要 HTTP 服务的"服务插件"（原 Tier 1/2 思路）**一律不 insert 进 dsh
  进程**：写成独立端口服务（standalone 入口 `server.mjs` + `/healthz`
  带 pid），在 services.json 清单登记，由中间件以独立进程拉起。
- dsh 进程内只允许两个角色：中间件插件（broker）与纯 UI 注入插件
  （如 `dsh-port-sidebar`——只注入、不拉服务）。
- 服务发现只读 discovery（`~/.dsh/services.json`），不许写死别人端口。
- 完整规范：**[docs/SERVICE_STANDARD.md](docs/SERVICE_STANDARD.md)**；
  中间件用法：**[packages/dsh-service-broker/README.md](packages/dsh-service-broker/README.md)**。

## 🚀 快速开始

### 1. 创建新插件

```bash
# 在项目根目录
cd deepseekharness_dev

# 创建一个简单的 UI 插件（Tier 0 - 纯客户端）
npm run create-plugin my-plugin

# 创建一个服务插件（Tier 1 - 需要后端服务）
npm run create-plugin my-service -- --tier 1 --category service

# 创建一个插件套件
npm run create-plugin my-suite -- --tier suite
```

### 2. 验证插件

```bash
# 验证单个插件
npm run validate-plugin extensions/official/dsh-my-plugin

# 验证所有插件
npm run validate-all
```

### 3. 开发插件

```bash
cd extensions/official/dsh-my-plugin
npm install
npm test
```

---

## 📂 目录结构

```
deepseekharness_dev/
├── extensions/                    # 所有插件的根目录
│   ├── official/                  # 官方维护插件
│   ├── suites/                    # 插件套件
│   ├── bridges/                   # 外部工具桥接（可选验证）
│   └── experimental/              # 实验性插件
│
├── packages/                      # 基础设施（不要修改）
│   ├── dsh-plugin-kit/            # 插件开发 SDK
│   ├── dsh-service-host/          # 服务托管
│   └── ...
│
├── tools/                         # 开发工具
│   ├── plugin-validator/          # 插件验证器
│   └── plugin-generator/          # 插件生成器
│
└── scripts/                       # 自动化脚本
    └── validate-all-plugins.mjs   # 批量验证
```

---

## 🏗️ 插件层级（Tier）

根据插件复杂度选择合适的层级：

### Tier 0: 纯客户端插件（最简单）
- **适用**: UI 组件、侧边栏、简单交互
- **依赖**: 仅 `dsh-plugin-kit`
- **示例**: `dsh-port-sidebar`

```json
{
  "dependencies": {
    "dsh-plugin-kit": "^0.2.0"
  }
}
```

### Tier 1: 标准服务插件
- **适用**: 需要后端能力的插件
- **依赖**: `dsh-plugin-kit` + `dsh-service-host`
- **示例**: 数据处理、API 调用

```json
{
  "dependencies": {
    "dsh-plugin-kit": "^0.2.0",
    "dsh-service-host": "^0.1.0"
  }
}
```

### Tier 2: 完整业务插件
- **适用**: 复杂业务逻辑、资产管理、工具集成
- **依赖**: 全套基础设施
- **示例**: 文档编辑器、协作工具

```json
{
  "dependencies": {
    "dsh-plugin-kit": "^0.2.0",
    "dsh-service-host": "^0.1.0",
    "dsh-tool-host": "^0.1.0",
    "dsh-asset-service": "^0.1.0"
  }
}
```

### Suite: 插件套件
- **适用**: 打包多个相关插件
- **依赖**: `dsh-suite-kit` + 子插件
- **示例**: `dsh-ppt-suite`

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

## 📋 插件结构（必需）

每个插件必须包含以下文件：

```
dsh-my-plugin/
├── package.json          # 必需：包元数据
├── lib/                  # 必需：主代码
│   └── index.mjs         # 入口文件
├── test/                 # 必需：测试
│   └── plugin.test.mjs
├── README.md             # 必需：文档
├── cordis.patch.yml      # 可选：Cordis 配置
└── client/               # 可选：客户端代码
    └── client.js
```

---

## 📝 package.json 必需字段

```json
{
  "name": "dsh-my-plugin",           // 必需：dsh- 前缀
  "version": "1.0.0",                // 必需：语义化版本
  "description": "...",              // 必需：清晰描述
  "type": "module",                  // 必需：ESM
  "main": "./lib/index.mjs",         // 必需：入口
  "exports": {
    ".": "./lib/index.mjs",
    "./package.json": "./package.json"
  },
  "dependencies": {
    "dsh-plugin-kit": "^0.2.0"       // 必需：至少依赖 plugin-kit
  },
  "dsh": {                           // 必需：DSH 配置
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "category": "ui",                // 必需：ui|service|bridge|tool|suite
    "platform": "web"                // 必需：web|desktop|both
  },
  "meta": {                          // 必需：用户可见元数据
    "title": "My Plugin",
    "description": "..."
  },
  "scripts": {
    "test": "node test/plugin.test.mjs"  // 必需：测试脚本
  }
}
```

---

## ✅ 验证规则（强制执行）

插件必须通过以下检查才能使用：

### 1. 文件结构
- ✅ 存在 `package.json`, `lib/`, `test/`, `README.md`
- ✅ `lib/` 目录不为空
- ✅ `test/` 目录包含 `*.test.mjs` 文件

### 2. 命名规范
- ✅ 包名以 `dsh-` 开头（或 `@org/dsh-`）
- ✅ 版本号符合语义化版本规范

### 3. 依赖管理
- ✅ 必须依赖 `dsh-plugin-kit`（suite 除外）
- ✅ 基础设施包版本在锁定范围内

### 4. 元数据完整性
- ✅ `dsh.category` 必须是有效值
- ✅ `dsh.platform` 必须是有效值
- ✅ `meta.title` 必须提供

---

## 🔧 开发工作流

### 标准流程

```bash
# 1. 创建插件
npm run create-plugin my-plugin -- --tier 1

# 2. 进入目录
cd extensions/official/dsh-my-plugin

# 3. 安装依赖
npm install

# 4. 开发功能
# 编辑 lib/index.mjs

# 5. 编写测试
# 编辑 test/plugin.test.mjs

# 6. 运行测试
npm test

# 7. 验证规范
cd ../../..
npm run validate-plugin extensions/official/dsh-my-plugin

# 8. 集成到 profile
# 修改 ~/.dsh/profiles/<profile>/package.json
```

### 在 DSH profile 中使用

```json
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-my-plugin": "link:/path/to/extensions/official/dsh-my-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-my-plugin"
      ]
    }
  }
}
```

---

## 🚨 常见错误

### 错误 1: 缺少 dsh-plugin-kit 依赖
```
❌ [PLUGIN_KIT_REQUIRED] 必须依赖 dsh-plugin-kit
```
**解决**: 在 `package.json` 的 `dependencies` 中添加：
```json
"dsh-plugin-kit": "^0.2.0"
```

### 错误 2: 缺少 dsh 配置
```
❌ [PACKAGE_FIELDS] package.json 缺少必需字段: dsh
```
**解决**: 添加 `dsh` 字段：
```json
"dsh": {
  "category": "ui",
  "platform": "web",
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```

### 错误 3: 缺少测试
```
❌ [REQUIRED_FILES] 缺少 test/ 目录
```
**解决**: 创建 `test/plugin.test.mjs`：
```javascript
console.log('✅ 测试通过')
```

---

## 📚 参考资源

- [插件结构规范](./PLUGIN_STRUCTURE.md) - 详细的架构说明
- [验证器源码](./tools/plugin-validator/) - 了解验证规则
- [生成器源码](./tools/plugin-generator/) - 了解脚手架模板
- [示例插件](./extensions/official/dsh-port-sidebar/) - 参考实现

---

## 🆘 需要帮助？

1. 运行 `npm run validate-plugin <path>` 查看具体错误
2. 参考 `dsh-port-sidebar` 的实现
3. 阅读验证器的错误提示和 hint

---

## 🎯 最佳实践

1. **使用生成器创建插件** - 自动生成符合规范的骨架
2. **开发时持续验证** - 早发现早修复
3. **编写测试** - 确保插件质量
4. **遵循语义化版本** - 清晰的版本管理
5. **文档完整** - README 说明使用方法

---

**提示**: 所有插件在 CI/CD 中会自动验证，不符合规范的插件无法合并！
