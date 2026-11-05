# Documentation

项目文档的统一入口。

## 目录结构

### guides/
开发指南和教程
- **plugin-development.md** - 插件开发完整指南
- **plugin-packaging.md** - 插件打包与分发
- **plugin-ux-standard.md** - 插件用户体验标准
- **plugin-quick-reference.md** - 快速参考手册
- **service-integration.md** - 服务集成指南

### reference/
参考文档和规范
- **service-standard.md** - 服务标准
- **plugin-source-standard.md** - 插件源码标准
- **plugin-structure.md** - 插件结构规范
- **public-plugins.md** - 公共插件清单
- **unification-verification.md** - 统一重构验证报告（e2e 六层矩阵 + 复杂度度量）

### 顶层文档
- [../README.md](../README.md) - 流水线总览
- [../ARCHITECTURE.md](../ARCHITECTURE.md) - 架构与依赖方向
- [PUBLISHING.md](PUBLISHING.md) - 发布到 npm
- [PLUGIN_DISTRIBUTION.md](PLUGIN_DISTRIBUTION.md) - 插件分发机制

## 快速开始

- 插件开发：[guides/plugin-development.md](guides/plugin-development.md)
- 发布流程：[PUBLISHING.md](PUBLISHING.md)

## 文档维护原则

1. **唯一权威来源** - 每个主题只有一份权威文档
2. **分层清晰** - 顶层（为什么）、guides（怎么做）、reference（是什么）
3. **保持更新** - 文档与代码同步更新
