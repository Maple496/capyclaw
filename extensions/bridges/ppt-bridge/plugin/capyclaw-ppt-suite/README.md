# @capyclaw/ppt-suite（PPT 工作台套件）

一键安装的入口包。内部包含 PPT 运行时、技能、文档工作台框架和 4 个公共基建插件，套件负责锁定兼容版本。

```text
dsh-ppt-suite
├─ @capyclaw/service-host    公共基建：HTTP 宿主/健康/指标/锁/复用
├─ @capyclaw/tool-host       公共基建：能力 DSL/注册表/契约/MCP
├─ @capyclaw/asset-service   公共基建：sha256 对象资产/`/assets`
├─ @capyclaw/editor-host     公共基建：编辑器托管/租约/心跳
├─ @capyclaw/document-workbench 文档框架库：会话/命令/桥路由/编辑器客户端（非 row）
├─ @capyclaw/ppt-workbench   运行时：relay + editor + 18 个 ppt_* MCP 工具
├─ @capyclaw/ppt-skill-ppt          路由
├─ @capyclaw/ppt-skill-narrative    叙事
├─ @capyclaw/ppt-skill-design       审美
├─ @capyclaw/ppt-skill-api          工具手册
├─ @capyclaw/ppt-skill-authoring    成稿
├─ @capyclaw/ppt-skill-editing      纯执行
├─ @capyclaw/ppt-skill-visual-check 审计
└─ @capyclaw/ppt-skill-research     研究
```

安装后这 4 个公共插件会作为独立 row 出现在 profile 中；`@capyclaw/ppt-suite` 通过
`components` 引用它们自己的 suite manifest，不再复制 packages/rows。`capyclaw-ppt-workbench` 优先通过
`ctx.serviceHost` / `ctx.toolHost` / `ctx.assets` / `ctx.editorHost`
使用它们，独立运行时再回退到 `server/shared` 快照。

PPT 的 journal/checkpoint 由 `server/store/*` + `@capyclaw/document-workbench` 直接落盘，
不依赖 `ctx.state`，因此套件不安装 `@capyclaw/state-service`。

组合层是标准件 `packages/capyclaw-suite-kit` 的第一个实例：

- `dsh-suite.json` 是唯一真源（packages / rows / checks / 端口 / 能力）；
- `cordis.patch.yml` 由 manifest 生成，不手写；
- 安装、组合、doctor 都用同一套 CLI，后续别的组合可以复用。

## 安装

```bash
# 本地开发（推荐；在 bridges/ppt-bridge 下执行）：
cd bridges/ppt-bridge
node scripts/install-plugin-suite.mjs --profile web
# 会建 suite/公共插件/workbench/skills 的 junction 并清旧 patch 块

# 发布/打包后也可走 dsh 插件安装
dsh plugin --profile <profile> install /path/to/dsh-ppt-suite
```

安装后：

- MCP 工具组 `mcp__ppt__*` 出现；
- 本机 39311 端口起 relay；
- 浏览器打开 `http://127.0.0.1:39311/` 即为实时编辑器；
- 会话 skill 目录出现 8 个 PPT skill。

## 标准件命令

```bash
# 在 workspace 根目录
node packages/capyclaw-suite-kit/bin/dsh-suite.mjs validate bridges/ppt-bridge/plugin/dsh-ppt-suite
node packages/capyclaw-suite-kit/bin/dsh-suite.mjs compose bridges/ppt-bridge/plugin/dsh-ppt-suite --out /tmp/ppt-suite
node packages/capyclaw-suite-kit/bin/dsh-suite.mjs doctor --profile web \
  --dsh-bin core-harness/deepseek-harness/node_modules/.bin/dsh.cmd
```

`doctor` 会检查 `ppt-health` 和 `ppt-contract`（`contractVersion` major=2），并检查组合后 row id 是否重复。

## 不要重复装

套件已经包含 workbench 和 8 个 skill 包的 patch 行。再单独安装 `capyclaw-ppt-workbench` 或任一 `capyclaw-ppt-skill-*` 会产生重复的 `ppt-workbench-host` / `ppt-skill-*` 行。二选一：

- 普通用户：只装 `@capyclaw/ppt-suite`；
- 开发者：单独装 `capyclaw-ppt-workbench` / 某个 `capyclaw-ppt-skill-*`，方便分别调试。

## 版本策略

PPT 包组版本同步从 `2.2.0` 起步；4 个公共基建插件独立版本（当前 `^0.1.0`），由套件锁定兼容范围：

- Workbench 工具契约不兼容变化 → contract major +1，workbench 与 8 个 skill 包 major 同步；
- 单个 skill 只改文案/流程 → 该 `capyclaw-ppt-skill-*` 单独升 minor/patch；
- 公共插件升级 → 同步更新 `server/shared/` 快照并重新验证 PPT；
- 本地开发用 `scripts/install-plugin-suite.mjs` 建 suite/公共插件/workbench/8 个 skill 包的 junction；发布到 npm 时依赖按各自版本正常安装。

## 验证

```bash
# 在 ppt-bridge 根目录
node scripts/build-plugin.mjs
node --test test/plugin.test.mjs test/skills.test.mjs test/packages.test.mjs
```
