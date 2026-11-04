# DSH Extensions

发布插件的所在目录，按来源组织。

## 目录结构

### official/
官方插件（均为 npm 发布产品）：
- **capyclaw-launchpad** - 管理界面和控制入口
- **capyclaw-launch-engine** - 按需激活引擎（+ plugin/capyclaw-launch-engine-suite）
- **capyclaw-plugin-sync** - 插件开关转发
- **capyclaw-llm-tempkey** - LLM 临时密钥管理
- **capyclaw-port-sidebar** - 端口侧边栏
- **capyclaw-scrapling** - 网页抓取
- **capyclaw-ddr0-client** - DDR0 客户端

### bridges/
桥接层：
- **ppt-bridge/** - PPT 工作台构建工场
  - `src/ assets/ contract/` - 构建输入
  - `plugin/` - 10 个生成包（workbench + suite + 8 个 skill），由 `npm run build:plugin` 生成
  - `capyclaw-skills-service/` - @capyclaw/skills-service（ppt-suite 依赖）
- **canvas-bridge/** - Canvas 插件（开发中，未发布）

## 开发规范

- 每个插件目录：`lib/`（入口）、`cordis.patch.yml`（bundle patch）、`README.md`
- suite 组合再加 `dsh-suite.json`；声明 `dsh.bundle.patch` + `publishConfig.access` 才进发布集
- 新插件用 `npm run create-plugin -- --name my-plugin` 脚手架生成，再过 `npm run validate-plugin`
