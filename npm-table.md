
### 构建库(packages/ · registry 外单独发布)

| 包 | 版本 | 说明 |
|---|---|---|
| [`@capyclaw/document-workbench`](https://www.npmjs.com/package/@capyclaw/document-workbench) | 0.2.0 | 通用文档工作台框架：版本化文档会话、命令注册、桥路由、浏览器编辑器客户端与截图协 |
| [`@capyclaw/plugin-kit`](https://www.npmjs.com/package/@capyclaw/plugin-kit) | 0.2.2 | DSH 插件基础设施标准件：HTTP/MCP、单实例锁、参数校验、技能 prov |
| [`@capyclaw/skills-service`](https://www.npmjs.com/package/@capyclaw/skills-service) | 0.1.4 | DSH 独立技能服务：聚合 @capyclaw/ppt-skill-* 的 SK |

### 基建插件(packages/)

| 包 | 版本 | 说明 |
|---|---|---|
| [`@capyclaw/asset-service`](https://www.npmjs.com/package/@capyclaw/asset-service) | 0.1.2 | DSH 公共资产插件：sha256 对象仓库、/assets 路由、base64 |
| [`@capyclaw/editor-host`](https://www.npmjs.com/package/@capyclaw/editor-host) | 0.1.2 | DSH 公共编辑器宿主插件：静态托管、租约仲裁、心跳与连接状态，向插件提供 ct |
| [`@capyclaw/service-broker`](https://www.npmjs.com/package/@capyclaw/service-broker) | 0.2.2 | DSH 服务中间件（唯一进程内插件）：按清单/结构化命令把各服务作为独立进程拉起 |
| [`@capyclaw/service-host`](https://www.npmjs.com/package/@capyclaw/service-host) | 0.1.2 | DSH 公共服务宿主插件：统一 HTTP 路由、健康检查、指标、单实例锁、端口复 |
| [`@capyclaw/tool-host`](https://www.npmjs.com/package/@capyclaw/tool-host) | 0.1.2 | DSH 公共工具面插件：能力 DSL、工具注册表、参数校验、契约报告、MCP 协 |

### 工具链(tools/)

| 包 | 版本 | 说明 |
|---|---|---|
| [`@capyclaw/plugin-generator`](https://www.npmjs.com/package/@capyclaw/plugin-generator) | 1.0.0 | DSH 插件脚手架生成器：快速创建符合规范的插件骨架 |
| [`@capyclaw/plugin-validator`](https://www.npmjs.com/package/@capyclaw/plugin-validator) | 1.0.0 | DSH 插件强制验证工具：检查目录结构、依赖规范、代码质量 |

### 官方扩展(extensions/official/)

| 包 | 版本 | 说明 |
|---|---|---|
| [`@capyclaw/ddr0-client`](https://www.npmjs.com/package/@capyclaw/ddr0-client) | 1.0.2 | ddr0.com 客户端 - 在 DSH 中直接登录和浏览 ddr0 内容 by |
| [`@capyclaw/launch-engine`](https://www.npmjs.com/package/@capyclaw/launch-engine) | 0.1.1 | 按需激活引擎（组合根）：按 capability 注册表把「要求」解析成有序激活 |
| [`@capyclaw/launchpad`](https://www.npmjs.com/package/@capyclaw/launchpad) | 1.1.2 | 启动清单管理器 / 启动器：DSL 描述启动模式，管理界面点击启动、编辑、校验， |
| [`@capyclaw/llm-tempkey`](https://www.npmjs.com/package/@capyclaw/llm-tempkey) | 1.0.2 | DDH 千帆临时 Key 分发客户端：校验主站登录态 → 签发临时 LLM Ke |
| [`@capyclaw/plugin-sync`](https://www.npmjs.com/package/@capyclaw/plugin-sync) | 0.1.1 | 把运行中的 dsh 插件集合与外部清单对齐：报告差异、按清单启用/停用 bund |
| [`@capyclaw/port-sidebar`](https://www.npmjs.com/package/@capyclaw/port-sidebar) | 1.0.3 | 在 DSH 右侧边栏稳定展示一个本机端口页面：每个会话的侧边栏都确保存在指向该端 |
| [`@capyclaw/scrapling`](https://www.npmjs.com/package/@capyclaw/scrapling) | 1.1.5 | Scrapling 网页抓取集成：HTTP 抓取 + 纯 Node CSS 选择 |

### PPT 桥(extensions/bridges/ppt-bridge/)

| 包 | 版本 | 说明 |
|---|---|---|
| [`@capyclaw/ppt-skill-api`](https://www.npmjs.com/package/@capyclaw/ppt-skill-api) | 2.2.3 | PPT skill：PPTist 工具契约、参数、状态、撤销 |
| [`@capyclaw/ppt-skill-authoring`](https://www.npmjs.com/package/@capyclaw/ppt-skill-authoring) | 2.2.3 | PPT skill：deck_brief → clean 简洁版式成稿 |
| [`@capyclaw/ppt-skill-design`](https://www.npmjs.com/package/@capyclaw/ppt-skill-design) | 2.2.3 | PPT skill：design token、版式、反 AI slop |
| [`@capyclaw/ppt-skill-editing`](https://www.npmjs.com/package/@capyclaw/ppt-skill-editing) | 2.2.3 | PPT skill：指哪打哪的修改执行器：每步落盘、不审美、不审计、不回头验证 |
| [`@capyclaw/ppt-skill-narrative`](https://www.npmjs.com/package/@capyclaw/ppt-skill-narrative) | 2.2.4 | PPT skill：SCQA、金字塔、一页一观点、deck_brief |
| [`@capyclaw/ppt-skill-ppt`](https://www.npmjs.com/package/@capyclaw/ppt-skill-ppt) | 2.2.3 | PPT skill：PPT 总入口：按意图路由到执行、成稿、审美、审计、研究技能 |
| [`@capyclaw/ppt-skill-research`](https://www.npmjs.com/package/@capyclaw/ppt-skill-research) | 2.2.4 | PPT skill：外部资料、数据、配图研究，产出分析卡 |
| [`@capyclaw/ppt-skill-visual-check`](https://www.npmjs.com/package/@capyclaw/ppt-skill-visual-check) | 2.2.3 | PPT skill：只读审计与按需截图，报告 pass/blocking |
| [`@capyclaw/ppt-suite`](https://www.npmjs.com/package/@capyclaw/ppt-suite) | 2.4.8 | PPT 工作台套件：workbench + 8 个独立 skill 包 + 4  |
| [`@capyclaw/ppt-workbench`](https://www.npmjs.com/package/@capyclaw/ppt-workbench) | 2.4.5 | PPT 工作台运行时：27 个 ppt_* MCP 工具（导入/导出 PPTX  |

### Canvas 桥(extensions/bridges/canvas-bridge/)

| 包 | 版本 | 说明 |
|---|---|---|
| [`@capyclaw/canvas-skill-api`](https://www.npmjs.com/package/@capyclaw/canvas-skill-api) | 0.2.0 | Canvas skill：canvas_* 工具契约、参数、命令白名单、撤销与页 |
| [`@capyclaw/canvas-skill-authoring`](https://www.npmjs.com/package/@capyclaw/canvas-skill-authoring) | 0.2.0 | Canvas skill：结构设计 → 块级写作 → 一次成稿 → 精修 |
| [`@capyclaw/canvas-skill-canvas`](https://www.npmjs.com/package/@capyclaw/canvas-skill-canvas) | 0.2.0 | Canvas skill：Canvas 总入口：按意图路由到成稿、执行、API  |
| [`@capyclaw/canvas-skill-editing`](https://www.npmjs.com/package/@capyclaw/canvas-skill-editing) | 0.2.0 | Canvas skill：指哪打哪的修改执行器：每步落盘、不审美、不审计、不回头 |
| [`@capyclaw/canvas-suite`](https://www.npmjs.com/package/@capyclaw/canvas-suite) | 0.2.0 | Canvas 文档工作台套件：workbench + 4 个独立 skill 包 |
| [`@capyclaw/canvas-workbench`](https://www.npmjs.com/package/@capyclaw/canvas-workbench) | 0.2.0 | Canvas 文档工作台运行时：22 个 canvas_* MCP 工具（块级写 |

### Browser 桥(extensions/bridges/browser-bridge/)

| 包 | 版本 | 说明 |
|---|---|---|
| [`@capyclaw/browser-skill-api`](https://www.npmjs.com/package/@capyclaw/browser-skill-api) | 0.1.0 | Browser skill：browser_* 工具契约、ref 快照语义、登录 |
| [`@capyclaw/browser-skill-browser`](https://www.npmjs.com/package/@capyclaw/browser-skill-browser) | 0.1.0 | Browser skill：浏览器操控总入口：按意图路由到实操、API 手册技能 |
| [`@capyclaw/browser-skill-ops`](https://www.npmjs.com/package/@capyclaw/browser-skill-ops) | 0.1.0 | Browser skill：快照→ref→动作→验证的互联网任务工作流 |
| [`@capyclaw/browser-suite`](https://www.npmjs.com/package/@capyclaw/browser-suite) | 0.1.0 | 浏览器操控工作台套件：workbench + 3 个独立 skill 包 + 公 |
| [`@capyclaw/browser-workbench`](https://www.npmjs.com/package/@capyclaw/browser-workbench) | 0.1.0 | 浏览器操控工作台运行时：15 个 browser_* MCP 工具（导航/ref |
