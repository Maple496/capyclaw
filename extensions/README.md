# DSH Extensions

项目的核心扩展模块，按功能领域组织。

## 目录结构

### official/
官方稳定插件，已验证并可发布：
- **dsh-launchpad** - 管理界面和控制入口
- **dsh-llm-tempkey** - LLM 临时密钥管理
- **dsh-port-sidebar** - 端口侧边栏

### bridges/
桥接层，连接不同应用和服务：
- **ppt-bridge/** - PowerPoint 桥接
  - `plugin/` - PPT 核心插件
  - `domains/` - PPT 领域定义
  - `plugins/` - PPT 相关扩展插件
    - `dsh-ppt-editor/` - AI 驱动的 PPT 编辑器
    - `dsh-ppt-sidebar/` - PPT 工作台侧边栏版本

### flow/
工作流引擎领域：
- **dsh-flow-engine/** - 工作流 DSL 执行引擎
  - `plugin/` - 工作流引擎插件
  - `domains/` - 工作流领域定义

### llm-config/
LLM 配置管理领域：
- **dsh-llm-config/** - LLM 配置管理器
  - `plugin/` - LLM 配置插件
  - `domains/` - LLM 配置领域定义

## 开发规范

每个领域项目可以包含：
- `plugin/` - 一个或多个插件
- `domains/` - 领域定义（dsh-domain.json）
- `suites/` - 套件定义（dsh-suite.json）
- `README.md` - 领域文档

## 添加新扩展

1. 在对应类别下创建目录
2. 遵循现有项目结构
3. 添加到组件注册表（待建立）
4. 通过验证测试
