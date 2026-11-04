# Documentation

项目文档的统一入口。

## 目录结构

### architecture/
架构设计和决策文档
- **contracts.md** - 模块间契约定义

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

### history/
历史报告和归档文档（按日期组织）
- **2024-11/** - 2024年11月的交付报告、实现总结等

## 快速开始

- 新手入门：[../QUICKSTART.md](../QUICKSTART.md)
- 插件开发：[guides/plugin-development.md](guides/plugin-development.md)
- 架构概览：[architecture/contracts.md](architecture/contracts.md)

## 文档维护原则

1. **唯一权威来源** - 每个主题只有一份权威文档
2. **历史文档归档** - 过时的报告移至 history/ 并标注日期
3. **分层清晰** - architecture（为什么）、guides（怎么做）、reference（是什么）
4. **保持更新** - 文档与代码同步更新
