# @capyclaw/ppt-bridge（Keynote/PPTist 工作台中间件）

PPT 工作台的构建工场：桥契约、studio 核心逻辑、MCP 工具服务的**单一真源**在
`src/`，经 `scripts/build-plugin.mjs` 组装出 10 个可发布 npm 包（`plugin/`）。
本包是 private 的 workspace 成员，不发布；发布产物全部走 `plugin/` 下的子包。

## 快速开始

```bash
npm run build:plugin        # 组装 10 个插件包（27 个 MCP 工具）
npm run check:plugin        # 校验产物是否最新（漂移检查）
npm run lint:skills         # skill frontmatter / 工具名 / 路由对账
npm run suite:validate      # 用 @capyclaw/suite-kit 校验套件 manifest
npm run suite:compose       # 组合预览 → dist/suite
npm run start:workbench     # 起开发 relay :39311（编辑器 http://127.0.0.1:39311/）
npm run start:standalone    # 旧 stdio MCP 入口（src/mcp/index.mjs，桌面遗留形态）
```

根仓库一键流水线：`npm run build` / `npm run check` / `npm run release`
（同时覆盖 ppt-bridge 与 canvas-bridge，见仓库根 README）。

## 目录

```
contract/              # op 契约（ops.json）+ 生成的工具契约快照（ppt-contract.json）
assets/                # PPTist bundle（ppt-full-app.js；PPT_ASSET 环境变量可覆盖）
src/core/              # 纯 deck 域：颜色/文本/版式/审计/快捷指令/ops（零 DOM 依赖）
src/editor/            # 编辑器逻辑：装载/会话/传输/截图（esbuild 进编辑器产物）
src/mcp/               # MCP 工具服务：kernel + capabilities（能力 → registry 自动派生）
  index.mjs            #   stdio JSON-RPC 入口（start:standalone，桌面遗留）
src/skills/            # 8 个 PPT 技能源（构建期分别拷入 8 个 skill 包）
src/apps/              # 旧桌面 .works 壳源码（历史遗留，不再构建）
scripts/
  build-plugin.mjs     # src/* → plugin/ 10 包；契约快照；composition.lock
  lint-skills.mjs      # skill 对账
capyclaw-skills-service/  # 独立 HTTP 技能服务（@capyclaw/skills-service，随套件发布）
plugin/
  capyclaw-ppt-workbench/   # 运行时包：relay + editor + 27 个 ppt_* MCP 工具
  capyclaw-ppt-skill-*/     # 8 个单 skill provider 包（路由/叙事/审美/工具/成稿/执行/审计/研究）
  capyclaw-ppt-suite/       # 组合包：dsh-suite.json + services.json + 生成的 cordis.patch.yml
```

## 启动形态（三种，同一真源）

| 形态 | 入口 | 说明 |
|---|---|---|
| 开发调试 | `npm run start:workbench` → `plugin/capyclaw-ppt-workbench/server/relay.mjs --port 39311` | relay 独立进程：编辑器 + `/mcp` + `/healthz` |
| dsh 生产 | 套件 `services.json` → dsh-service-broker 拉起（`portFrom: content`，安装态 `node_modules/@capyclaw/ppt-workbench` 路径） | broker 是唯一合法拉起者（见 `docs/reference/service-standard.md`） |
| 进程内兼容 | workbench 包 `lib/host.mjs`（被 insert 时以同样装配拉起 relay） | 兼容入口；桌面遗留 stdio 形态是 `npm run start:standalone` |

## 边界与约定

- **op 按域实现**：`src/core/ops/<domain>.js` 一处注册；新增 op 必须同步
  `contract/ops.json` 与 `src/core/ops/index.js` 的 `OP_MODULES`。
- **MCP 能力一个模块一个关注点**：`src/mcp/tools/capabilities/*.mjs`；新增能力只在
  `capabilities/index.mjs` 加一行，registry 自动派生工具面/契约/instructions。
  能力之间禁止互相 import，只能依赖 `kernel` 端口、`domains` 辅助和 `core` 域。
- `@capyclaw/ppt-workbench` 的 version 必须与 `src/mcp/contract.mjs` 的
  `PACKAGE_VERSION` 一致（构建脚本强校验）。
- 8 个 skill 包的 version/files/publishConfig 由 `build-plugin.mjs` 生成，不要手改。
- 图片等二进制资源只进对象仓库（`objects/<sha256>`），deck 里只保存
  `/assets/<sha256>` 引用；导出 PPTX 时临时编码回 base64。

## 桥契约（v1 摘要）

```
GET   /api/desktop/works/ppt-bridge             → {seq,cmds,applied_seq,error,deck?,shot_req,shot}
POST  /api/desktop/works/ppt-bridge             {title?,cmds:[op…]} → seq
POST  /api/desktop/works/ppt-bridge/ack         {seq,applied,error}
POST  /api/desktop/works/ppt-bridge/state       {deck}
POST  /api/desktop/works/ppt-bridge/shot-request → {shot_req}
POST  /api/desktop/works/ppt-bridge/shot-result {req,data}
GET   /api/desktop/works/ppt-bridge/watch?seq=&shot=  （长轮询，变化即返）
```

op 全表见 `contract/ops.json`；MCP 工具清单见生成的 `contract/ppt-contract.json`。

## 运行时依赖（外部，不在本仓库）

- dsh 运行时（`@deepseek-ai/dsh`）与 `@deepseek-ai/dsh-mcp-client` row
- PPTist bundle 运行真源在桌面仓；本仓 `assets/ppt-full-app.js` 独立持有同源副本
