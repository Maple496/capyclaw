# DSH Bridges 目录说明

Bridges（桥接器）用于连接外部工具和 DSH 生态。

## 与标准插件的区别

Bridges 可以选择以下架构之一：

1. **标准 DSH 插件** - 遵循完整的插件规范
2. **独立服务** - 作为独立进程运行（如 MCP 服务器）
3. **混合模式** - 既有独立服务，又提供 DSH 插件接口

## 当前 Bridges

### ppt-bridge
- 类型：混合模式
- 包含：独立 PPT 编辑器 + DSH 插件套件（workbench + 8 skill + suite + 领域包）
- 符合规范：部分（插件部分符合，编辑器独立）

### canvas-bridge
- 类型：混合模式
- 包含：Canvas 文档工作台——relay 独立端口服务 + DSH 插件套件
  （capyclaw-canvas-workbench + 4 个 dsh-canvas-skill-* + capyclaw-canvas-suite + 领域包），
  另保留 standalone（headless Playwright）调试形态
- 架构：编辑器权威桥（document-workbench 标准协议）；22 个 `canvas_*` MCP 工具
- 复用：dsh-plugin-kit / dsh-document-workbench / dsh-suite-kit / 5 个公共服务插件（与 ppt-bridge 零重复）

## 验证规则

Bridges 目录下的包**不强制**要求通过插件验证。
如果 bridge 提供 DSH 插件接口，该部分应符合规范。
