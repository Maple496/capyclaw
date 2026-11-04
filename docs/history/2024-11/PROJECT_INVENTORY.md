# DeepSeek Harness 项目清单

迁移完成时间：2026-10-29

## 📦 迁移汇总

所有 DeepSeek Harness 相关项目已从 workplace 各处集中到此目录。

### 原始位置 → 新位置

```
workplace/applications/deepseek-harness/     → core-harness/deepseek-harness/
workplace/canvas-bridge/                     → bridges/canvas-bridge/
workplace/ppt-bridge/                        → bridges/ppt-bridge/
workplace/applications/ppt文档/              → plugins/ppt文档/
workplace/dsh-ppt-bundle/                    → bundles/dsh-ppt-bundle/
workplace/dsh-ppt-windows-bundle/            → bundles/dsh-ppt-windows-bundle/
workplace/DSH-PPT-工作台/                    → bundles/DSH-PPT-工作台/
workplace/DSH-PPT-*.zip                      → archives/
workplace/node*.zip                          → archives/
workplace/pack-*.mjs                         → scripts/
workplace/DEPLOYMENT_PLAN.md                 → scripts/
```

## 🗂️ 项目分类详解

### 1. Core Harness（核心框架）
**目录**: `core-harness/`

- **deepseek-harness**: 主框架代码
  - 提供 AI 对话能力
  - 插件系统支持
  - 认证代理服务

### 2. Bridges（桥接服务）
**目录**: `bridges/`

这些独立服务连接 DeepSeek Harness 与其他系统：

- **canvas-bridge**: Canvas 画布桥接
  - 连接 Harness 与图形编辑器
  - 实时渲染 AI 生成的图形内容
  
- **ppt-bridge**: PowerPoint 桥接
  - 连接 Harness 与 PPT 编辑器
  - 实时生成和编辑 PPT 幻灯片
  - 提供 MCP 工具集

### 3. Plugins（插件）
**目录**: `plugins/`

- **ppt文档**: PPT 工作台插件文档
  - 使用说明
  - API 文档
  - 示例代码

### 3.1 公共运行时插件（插件标准化的核心）
**目录**: `packages/dsh-*`

功能插件不再各自实现宿主、工具面、状态、资产和编辑器。以下都是标准 DSH 插件，通过 `ctx.*` 注入：

- **dsh-service-host**：`ctx.serviceHost`
  - HTTP 路由、/healthz、/metrics、静态资源、单实例锁、端口复用、discovery、优雅关闭
  - 支持 standalone 与 embedded（`ctx.webServer`）两种模式
- **dsh-tool-host**：`ctx.toolHost`
  - `defineTool` / `defineCapability`、能力注册表、参数校验、契约报告、MCP 协议壳、instructions 模板
- **dsh-state-service**：`ctx.state`
  - 原子状态、journal（2MB 轮转）、命名 checkpoint、崩溃恢复
- **dsh-asset-service**：`ctx.assets`
  - sha256 对象仓库、`/assets/<id>`、base64 上传、content-type
- **dsh-editor-host**：`ctx.editorHost`
  - 编辑器静态托管、租约仲裁、心跳、连接状态
- **dsh-mcp-gateway**：`ctx.mcpGateway`
  - 聚合多个插件的 MCP 工具面，向外部客户端暴露单一 `/mcp`

**插件形态**：每个包都有 `lib/host.mjs`、`dsh-suite.json`、`cordis.patch.yml`，可单独 `dsh-suite install`，也可作为 domain 的 component。

### 3.2 底层协议库（保留为库，不做插件）
**目录**: `packages/dsh-plugin-kit/`

- HTTP/MCP 传输、单实例锁、参数校验、技能 provider、journal 存储、编辑器传输与租约
- `bin/sync.mjs` 仍可把 kit 快照到插件 `server/infra/`，用于旧插件独立分发
- 新插件默认由 `server/shared/` 消费公共插件源码；kit 只作为公共插件的底层实现

### 3.2.1 文档工作台框架（纯库）
**目录**: `packages/dsh-document-workbench/`

- 从 PPTist 桥中抽出的通用文档协议层：`session`（seq/命令队列/ack/watch/checkpoint/recover/owner lease）、`ops`（op registry/snapshot）、`bridge`（标准 HTTP 端点族）、`client`（浏览器租约/心跳/轮询/镜像/截图）、`screenshot`（contact sheet）、`testing`（内存 backend/fake adapter）
- 纯库，不提供 `ctx.*`；HTTP/工具/状态/资产/编辑器托管仍由 `dsh-*` 公共插件提供
- 第一个消费者：`bridges/ppt-bridge/plugin/dsh-ppt-workbench`；新编辑器插件只需提供 `documentKey`、领域文档、op 实现和浏览器 adapter

### 3.3 组合标准件（构建期工具）
**目录**: `packages/dsh-suite-kit/`

- 通用 DSH 组合层：suite / domain manifest、compose、install、stage、launch、doctor
- Runtime 隔离层：`dsh-runtime` 为每个 DSH 进程分配 harness/content 端口、独立 profile/DSH_HOME/workspace/锁；启动声明校验工具/能力/服务，`scope.sessions` 声明会话记录目录，`scope.files` 声明修改文件根目录，`scope.workspace` 声明 work 文件范围
- 共享对象仓库：`dsh-plugin-kit` 的 `BlobStore` 只存 sha256 对象；`WorkspaceManager` 中间层维护 work manifest、归属、版本 CAS、catalog 和生命周期
- 所有落盘内容统一在 `DSH_STORE_ROOT` 下，默认 `~/.dsh-store`
- Workspace 插件：`packages/dsh-workspace-service/` 向同进程插件提供 `ctx.workspace`，与具体能力解耦
- 控制面插件：`packages/dsh-runtime-control/` 提供 `ctx.runtimeControl`，管理 worker runtime

### 3.4 统一组件组合系统（新增 2024-12-31）
**目录**: `packages/dsh-assembly-kit/`

**核心功能**：
- **组件库扫描**：扫描工作区所有 `dsh-suite.json` 和 `package.json.dsh.capabilities`，生成统一的组件库索引（验证：扫描到 22 个组件，包含 14 个 plugin、8 个 skill）
- **智能搜索**：按 id、title、tags、provides（tools/services/capabilities）搜索组件
- **依赖解析**：自动展开 `dependsOn` 传递闭包，验证 `requires` 能否满足
- **冲突检测**：工具名、端口、服务命名空间、能力版本冲突检测
- **双目标支持**：
  - **registry target**：生成 `capabilities.manifest.json` + `capabilities.loader.mjs`（进程内能力组合）
  - **bundle target**：生成 `dsh-suite.json` + `cordis.patch.yml`（包级组合）

**CLI 命令**：
- `dsh-assembly scan` - 扫描工作区生成索引
- `dsh-assembly search <query>` - 搜索组件
- `dsh-assembly init <name> --target <registry|bundle>` - 创建产品清单
- `dsh-assembly add <id...>` - 添加组件到清单
- `dsh-assembly plan <manifest>` - 解析依赖显示计划
- `dsh-assembly build <manifest>` - 构建产物
- `dsh-assembly verify <dir> --target <type>` - 验证产物

**工作流**：搜索组件 → 选择 → 生成清单 → 构建产物 → 验证

**详细文档**：
- `packages/dsh-assembly-kit/README.md` - API 文档和使用指南
- `packages/dsh-assembly-kit/IMPLEMENTATION_SUMMARY.md` - 实施总结
- 目录/安装插件：`packages/dsh-catalog/`、`packages/dsh-installer/` 分别提供 `ctx.catalog`、`ctx.installer`
- 共享基础库：`packages/dsh-runtime-kit/` 提供 BlobStore/WorkspaceManager/fs-lock
- 当前实例：`bridges/ppt-bridge/plugin/dsh-ppt-suite/dsh-suite.json`
- 领域包实例：`bridges/ppt-bridge/domains/ppt/dsh-domain.json`
- bundle 构建：`scripts/build-bundle.mjs` 基于 `resolveDomain` / `stageDomain` 生成可运行目录
- 后续 canvas / office / 其他组合可直接复用

### 3.4 Plugin Development（插件开发标准）
**目录**: `plugin-development/`

- 唯一入口：`plugin-development/README.md`
- 脚手架：`create-plugin.mjs`（生成 plugin + suite + domain）
- 最小参考：`examples/dsh-hello-service/`
- 服务接入决策树：`docs/SERVICE_INTEGRATION.md`
- 旧 `shared/` 已废弃，仅保留兼容导出

### 4. Bundles（发布包）
**目录**: `bundles/`

#### dsh-ppt-bundle（基础版）
- **平台**: Windows / macOS / Linux
- **特点**: 
  - 需要预装 Node.js 18+
  - 体积小（~517MB）
  - 需要手动 npm install
- **适合**: 开发者、技术用户

#### dsh-ppt-windows-bundle（Windows 完全版）
- **平台**: Windows 专用
- **特点**:
  - 内置 Node.js v22.23.4
  - 开箱即用，零配置
  - 体积较大（~616MB）
  - 提供静默启动（.vbs）
- **适合**: 普通用户、快速部署

#### DSH-PPT-工作台
- **平台**: 待确认
- **特点**: 工作台集成版本

### 5. Archives（归档）
**目录**: `archives/`

- `DSH-PPT-Complete-v2.zip` (118MB)
- `DSH-PPT-Windows-Complete.zip` (191MB)
- `DSH-PPT-Windows-完全版.zip` (119MB)
- `node-portable.zip` (28MB)
- `node22.zip` (34MB)

### 6. Scripts（构建脚本）
**目录**: `scripts/`

- **pack-for-deployment.mjs**: 基础版打包
  - 生成跨平台版本
  - 不包含 Node.js 运行时
  
- **pack-windows-complete.mjs**: Windows 完全版打包
  - 包含 Node.js 运行时
  - 包含所有依赖
  - 生成 .vbs 静默启动脚本
  
- **DEPLOYMENT_PLAN.md**: 部署计划和流程

## 🏗️ 架构说明

### 系统组成
```
┌─────────────────────────────────────────┐
│      DeepSeek Harness (Core)            │
│   - AI 对话引擎                          │
│   - 插件管理器                           │
│   - 认证代理                             │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴───────┐
       │               │
┌──────▼──────┐  ┌────▼──────┐
│Canvas Bridge│  │PPT Bridge │
│画布桥接服务  │  │PPT桥接服务│
└──────┬──────┘  └────┬──────┘
       │               │
┌──────▼──────┐  ┌────▼──────┐
│Canvas Editor│  │PPT Editor │
│图形编辑器    │  │PPT编辑器  │
└─────────────┘  └───────────┘
```

### 通信方式
- Core ↔ Bridge: HTTP/WebSocket
- Bridge ↔ Editor: WebSocket 实时通信
- 所有服务独立启动，松耦合设计

## 🚀 使用建议

### 开发环境
```bash
# 使用核心 Harness
cd core-harness/deepseek-harness/
npm install
node auth-proxy.mjs

# 开发桥接服务
cd bridges/canvas-bridge/
npm install
npm start
```

### 生产部署
```bash
# 使用完整打包版本
cd bundles/dsh-ppt-windows-bundle/
start.bat
```

### 构建新版本
```bash
# 通用 bundle 构建（默认域：bridges/ppt-bridge/domains/ppt）
node scripts/build-bundle.mjs --out builds/ppt-portable --target portable

# Windows 完全版（内置 node，默认复用现有 node 运行时）
node scripts/build-bundle.mjs --out builds/ppt-windows --target windows

# 兼容入口：两个旧脚本现在只是上述 builder 的薄包装
node scripts/pack-for-deployment.mjs
node scripts/pack-windows-complete.mjs
```

## 📝 开发规范

1. **核心功能开发**: 在 `core-harness/` 中进行
2. **桥接服务开发**: 在 `bridges/` 中创建独立项目
3. **插件开发**: 在 `plugin-development/` 中用 `create-plugin.mjs` 创建，不再手工复制模板
4. **发布版本**: 使用 `scripts/build-bundle.mjs`（新标准）或两个兼容包装脚本
5. **提交前验证**: `node scripts/verify-standard.mjs`
6. **文档更新**: 以 `plugin-development/README.md` 为唯一入口，及时更新本文件

## ⚠️ 注意事项

- ✅ 原始文件已迁移或复制到此目录
- ⚠️ workplace 根目录下的 `dsh-ppt-bundle` 和 `dsh-ppt-windows-bundle` 是复制版本（原始版本无法移动，可能正在使用中）
- 📌 后续开发请统一在此目录进行
- 🔄 定期将开发成果打包到 `bundles/`

---

**整理人员**: ZCode AI Assistant  
**整理时间**: 2026-10-29  
**项目总数**: 3 个核心项目 + 2 个桥接服务 + 3 个发布包 + 6 个公共运行时插件
