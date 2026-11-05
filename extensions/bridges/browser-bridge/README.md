# @capyclaw/browser-bridge（私有工作区）

浏览器操控工作台套件的中台：Playwright 引擎、ref 快照交互、MCP 工具服务、
插件包构建与 skill 源。与 `ppt-bridge` / `canvas-bridge` 同构，构建产物在 `plugin/`。

## 结构

```
browser-bridge/
├── src/
│   ├── mcp/
│   │   ├── engine.mjs              # Playwright 控制器（懒启动/探测链/ref 注册表/动作互斥/安全门控）
│   │   ├── contract.mjs            # 契约版本 1.0.0 / 包版本
│   │   ├── tools.mjs               # 工具 facade
│   │   ├── tools/kernel/           # define/registry/ports/output（I/O 端口注入）
│   │   ├── tools/capabilities/     # 8 个能力模块 → 15 个 browser_* 工具
│   │   └── shared/                 # 公共插件快照（构建期 sync-shared 生成）
│   └── skills/                     # 3 个技能源：browser / browser-api / browser-ops
├── scripts/
│   ├── build-plugin.mjs            # 构建 5 个包（workbench + 3 skill + suite）
│   └── lint-skills.mjs             # 技能 lint（frontmatter/工具名/技能名/契约对账）
├── test/                           # 22 项单测（engine 纯函数/契约/relay mock/host）
├── contract/                       # 生成的 browser-contract.json
└── plugin/                         # 构建产物（可发布包）
    ├── capyclaw-browser-workbench/     # 运行时（relay + 工作台 UI + demo）
    ├── capyclaw-browser-skill-browser/
    ├── capyclaw-browser-skill-api/
    ├── capyclaw-browser-skill-ops/
    └── capyclaw-browser-suite/         # 套件（dsh-suite.json / services.json / 生成 patch）
```

## 命令

```bash
npm run build:plugin      # 构建 5 个包
npm run check:plugin      # 构建产物漂移检查
npm run lint:skills       # 技能 lint
npm test                  # 22 项单测
npm run start:workbench   # 直接拉起 relay（http://127.0.0.1:39315/）
```

## 设计口径

- **snapshot + ref**：动作只引用快照里 `ref=eN` 的元素，不猜 CSS 选择器；
  ref 过期报 `STALE_SNAPSHOT`（可恢复错误，提示重新快照）。
- **服务解耦**：relay 以独立进程运行（broker 按 `services.json` 拉起），
  浏览器生命周期与 dsh 进程隔离；`lib/host.mjs` 仅作兼容入口。
- **安全默认**：仅 http(s)、拒绝带凭据 URL、`browser_evaluate` 默认关闭、
  页面内容视为不可信数据（写进 MCP instructions 与技能）。
- **诚实边界**：不做反爬/风控绕过；快照只覆盖主框架；无浏览器时结构化报错。

## 端口

- workbench：**39315**（固定端口，套件 `services.json` 消费）
- MCP：`http://127.0.0.1:39315/mcp`，dsh 侧工具名 `mcp__browser__browser_*`

## 测试接入

- 单测：`extensions/bridges/browser-bridge/test/*.test.mjs`（e2e L3 内也会跑）
- e2e：L1（套件 validate/compose/registry）、L3（relay + MCP + 真浏览器离线冒烟 +
  host 模板 + 15 skill 包）、L4（broker 消费 services.json）、L5（发布闸/zip/抽检）
