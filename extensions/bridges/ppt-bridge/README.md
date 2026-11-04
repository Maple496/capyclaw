# ppt-bridge（Keynote 中间件）

桌面「Keynote 一体工作台」的源码工程：左侧 DeepSeek 编辑 agent + 右侧
PPTist 编辑器，通过本机网关的 PPT 桥联动。2026-10-22 结构批：业务逻辑
从 700+ 行的 `.works` 字符串与散落的脚本收编为模块化源码 + 构建产物。
2026-10-26 拆仓批：从桌前面前端独立成仓（平级目录），可独立维护/运行。

## 快速开始（独立运行）

```bash
npm install                 # 唯一 devDependency：esbuild
npm test                    # 全量单测（含契约对账、skills、三包结构；桌面仓不可见时跳过跨仓检查）
npm run build               # 构建 keystudio.works / pptbridge.works（输出目录见下方解析链）
```

## 目录

```
contract/ops.json      # 桥 op 契约：op 表、包络、上限（工具清单在生成的 ppt-contract.json）
docs/                  # ARCHITECTURE.md（分层/能力矩阵）、EXTENDING.md（扩展步骤）
src/core/              # 纯 deck 域（零 DOM / 零 PptApp 依赖，node:test 直测）
  color.js             #   颜色名/解析/亮度/对比色（唯一实现）
  text.js              #   文本/样式：setPlainText（保字号）、patchElement、对比度
  deck-layout.js       #   排版引擎（7 版式 × 4 预设，ppt_deck 用）
  audit.js             #   deck 审计（越界/溢出/重叠/对比度/配色/重复图/密度）
  quick.js             #   本地快捷指令（颜色名/改字/加页）
  ops.js               #   兼容 facade：applyOp / OP_NAMES
  ops/                 #   op 按域拆分：deck/text/element/slide/recolor/…
src/apps/keystudio/    # 桌面应用壳：UI、长轮询泵、截图回传、dsh 内嵌
src/apps/pptbridge/    # 兼容入口（旧「导演台」，打开即拉起一体工作台）
src/editor/            # 独立编辑器逻辑（插件用）
  main.js              #   启动/UI 接线
  session.js           #   租约/心跳/长轮询/镜像/应用/截图
  runtime.js           #   PPTist 装载与导出资产还原
  transport.js         #   同源 API 封装
  screenshot.js        #   renderSlides / 图片加载 / contact sheet
  ui.js                #   状态点与提示
src/mcp/               # MCP 工具服务（agent 侧干净接口）
  index.mjs            #   JSON-RPC stdio 协议入口（桌面部署用）
  tools.mjs            #   兼容入口：re-export tools/ registry + 旧 helper
  tools/
    kernel/            #     define/registry/ports：能力声明与端口注入
    domains/           #     工具侧纯辅助：颜色/图片/文本样式/换色规划
    capabilities/      #     24 个能力模块（一个关注点一个文件）
  bridge-client.mjs    #   桥 HTTP 客户端（独立连接、push/ack、deck 摘要）
  contract.mjs         #   契约版本 + capabilityReport 格式
  validate.mjs         #   inputSchema 参数校验
  audit.mjs            #   兼容 shim → core/audit.js
  deck-layout.mjs      #   兼容 shim → core/deck-layout.js
src/skills/            # 8 个 PPT 技能源（构建期分别拷入 8 个 capyclaw-ppt-skill-* 包）
plugin/
  README.md            # 三包地图、契约、构建与测试
  capyclaw-ppt-workbench/   # 运行时包：relay + editor + 27 个 MCP 工具
    core/              #   构建期复制自 src/core（路径镜像）
    server/
      relay.mjs        #     组合根
      router.mjs       #     有序路由
      routes/          #     assets/mcp/editor/bridge/health
      store/           #     sanitize/doc/lease/checkpoints/journal/backend/facade
      mcp/             #     handler/dispatch/instructions
      runtime/         #     recovery/watch/metrics
  capyclaw-ppt-skill-*/     # 8 个单 skill provider 包（路由/叙事/审美/工具/成稿/执行/审计/研究）
  dsh-ppt-suite/       # 组合包：dsh-suite.json + 生成的 cordis.patch.yml
domains/ppt/           # 领域包：只选择 PPT 组件，生成独立 profile
packages/capyclaw-suite-kit/ # 通用组合标准件（suite + domain + stage/launch）
scripts/
  build-works.mjs      # src/apps → *.works 产物（esbuild IIFE；输出目录自动探测，可覆盖）
  install-dsh.mjs      # dsh/ → 运行时（workspace-keynote、首用工作区、profile）
  build-plugin.mjs     # src/core + src/mcp → workbench、src/skills → 8 个单 skill 包、生成契约
  run-tests.mjs        # 跨平台运行 test/*.test.mjs
dsh/                   # dsh 侧资产（AGENTS.md / 技能 / profile 补丁）——收编入仓
test/                  # 契约/架构/文本/op/快捷/插件 relay+MCP/skills/三包结构
archive/               # 历史评估报告（INFRASTRUCTURE_IMPROVEMENTS / PRODUCTION_RISKS）
```

## 构建与验证

```bash
npm run build             # 生成 keystudio.works / pptbridge.works
npm run check             # 校验产物是否最新（CI 用）
npm test                  # 全量单测
npm run test:e2e          # 对运行中的 39311 跑真实 MCP 工具链（自动备份/恢复 deck）
npm run test:stress       # 并发读/写/非法参数/大参数/截图/UI 命令压测（参数见脚本）
npm run install:dsh       # 同步 dsh 侧资产到运行时
npm run build:plugin      # 组装三个插件包（workbench/skills/suite，npm run check:plugin 校验）
npm run lint:skills       # skill frontmatter / 工具名 / 路由对账
npm run suite:validate    # 用 @capyclaw/suite-kit 校验 dsh-suite.json
npm run suite:doctor      # 检查运行中的 suite（health + contract + row 去重）
npm run domain:validate   # 校验领域包 domains/ppt
npm run domain:stage      # 只打包 PPT 领域需要的组件 → dist/domain-ppt
npm run domain:install    # 生成独立 profile domain-ppt（只加载 PPT 能力）
node scripts/install-plugin-suite.mjs --profile web   # 本地切换到 suite（建 junction + 清旧 patch 块）
```

**输出目录解析链**（build-works，优先级从高到低）：
`--out <dir>` > `WORKS_OUT_DIR` 环境变量 > 本仓 `dist/apps`。
需要向桌面仓投递时显式设置 `DESKTOP_ROOT`（opt-in，不再自动探测平级目录）。
资产路径（build-plugin 的 PPTist bundle）：
`PPT_ASSET` 环境变量 > 本仓 `assets/ppt-full-app.js`。

闸门等价校验内建在 `build-works.mjs`（IIFE 可执行、无 import/export、
无裸 fetch / window 赋值 / 外部主机字面量），与桌面仓 check-engines 闸同源。

## 边界与约定

- `.works` 的 CODE 段经 `new Function` 执行，**不能 import/export**：
  `build-works.mjs` 用 esbuild 打包成单 IIFE，并做闸门等价校验
  （无裸 fetch / 无 window 赋值 / 无外部主机字面量）。
- **op 按域实现**：`src/core/ops/<domain>.js` 一处注册；`src/core/ops.js` 只是 facade。
  新增 op 必须同步：1) `contract/ops.json`；2) `src/core/ops/<domain>.js`；
  3) `src/core/ops/index.js` 的 `OP_MODULES`。`test/contract.test.mjs` 会双向对账。
- **MCP 能力一个模块一个关注点**：`src/mcp/tools/capabilities/*.mjs`；
  新增能力只在 `capabilities/index.mjs` 加一行，registry 自动派生工具面/契约/instructions。
  能力之间禁止互相 import，只能依赖 `kernel` 端口、`domains` 辅助和 `core` 域。
  详见 `docs/ARCHITECTURE.md` / `docs/EXTENDING.md`。
- 后端只保包络：桌面仓（`../桌前面前端`）的 `backend/bridges/ppt_bridge.py`
  （业务）+ `backend/sanitize.py`（白名单）+ `backend/data_local.py`（kv）；
  后端不解读 op。
- 默认走内置 clean 简洁版式（`ppt_deck`），不依赖外部样式。

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

op 全表见 `contract/ops.json`；MCP 工具 27 个（工具/能力清单见生成的
`contract/ppt-contract.json`）：
`ppt_capabilities / ppt_get_deck / ppt_audit / ppt_task / ppt_import_pptx /
ppt_export_pptx / ppt_text / ppt_style / ppt_recolor / ppt_element / ppt_image /
ppt_slide / ppt_history / ppt_present / ppt_apply / ppt_fill / ppt_deck /
ppt_page / ppt_images / ppt_screenshot`。

## 图片对象与导出

`ppt_image` 现在不再把 base64 塞进 deck：

1. 下载/读取图片并校验是 `image/*`；
2. 写入共享对象仓库 `objects/<sha256>`；
3. deck 里的 image 元素只保存 `/assets/<sha256>` 引用；
4. 编辑器和预览通过 relay 的 `/assets/<sha256>` 读取；
5. 导出 PPTX 前，编辑器把引用临时编码为 `data:image/...;base64`，再交给 PPTist 导出，导出后恢复引用。

这样编辑态 deck 不会被大图 base64 污染，导出文件仍然完整包含图片。

## 领域包（Domain Pack）

`domains/ppt/dsh-domain.json` 是“启动单位”而不是插件包：

```json
{
  "components": ["../../plugin/dsh-ppt-suite"],
  "baseBundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
  "profile": { "name": "domain-ppt", "port": 3080 }
}
```

`dsh-domain install` 只生成 `domain-ppt` profile，加载 base + web-app + 选中的 suite；
未选中的插件、skill、MCP 不会注册。`dsh-domain stage` 只复制选中组件，形成可带走的领域包。

推荐的运行方式是通过统一中间层创建 runtime：

```bash
node ../../packages/capyclaw-suite-kit/bin/dsh-runtime.mjs create \
  --name ppt-a --domain domains/ppt
node ../../packages/capyclaw-suite-kit/bin/dsh-runtime.mjs start <runtimeId>
```

`dsh-domain.json` 的 `runtime.requires` 声明需要 `ppt_*` 工具、`ppt.runtime` 等能力，
`runtime.scope.workspace` 声明 PPT work 只管理 `state.json`、`journal.jsonl`、
`checkpoints/**`。端口、profile、DSH_HOME、锁和对象 namespace 都由中间层分配。

## 两种部署形态

| | 桌面一体工作台（本目录主体） | dsh 套件（`plugin/dsh-ppt-suite/`） |
|---|---|---|
| 桥服务端 | 桌面网关 `backend/`（Python，kv 存储） | 包内 Node relay（`server/`，JSON 落盘） |
| MCP | stdio（`src/mcp/index.mjs`，profile 补丁指向本仓路径） | streamable-http（relay `/mcp`，patch 静态 URL） |
| 编辑器 | 桌面 `.works` 窗口（`build-works.mjs` 产物） | relay 托管的浏览器页（`build-plugin.mjs` 产物） |
| instructions | `dsh/AGENTS.md`（工具用法以 MCP instructions 为准） | 8 个独立的 `capyclaw-ppt-skill-*` 包 |
| 依赖 | 整套桌面系统 | 只要 dsh，装完即用 |

工具定义与 op 实现**两个形态共用同一真源**：`src/mcp/tools/*`（能力 → registry）
与 `src/core/*`（op 域/文本/审计/版式）由 `build-plugin.mjs` 以目录镜像拷入包内
（`test/plugin.test.mjs` 对账），core 同时经 esbuild 进编辑器产物。改桥契约/op
时两条链都要重跑构建。

## 运行时依赖（外部，不在本仓库）

- PPTist bundle `ppt-full-app.js`：桌面仓 `backend/system_works/assets/` 为
  运行真源（需打补丁，`patch:asset` 自动寻位）；也可放本仓 `assets/` 独立持有
- `applications/deepseek-harness/`（平级目录）：dsh 安装 + auth-proxy，
  `install:dsh` 同步资产（`DSH_ROOT` 可覆盖）
- 桥路由与业务层：桌面仓 `backend/main.py` + `backend/bridges/ppt_bridge.py`

## 稳定性与进化优化（2026-10-31）

- `docs/MODULE_EVALUATION.md`：dsh-ppt-suite 8 个模块逐个评估“是否有必要性能优化”，附真实基线。
- `docs/EVOLUTION_RESULTS.md`：Google 官方 AlphaEvolve 客户端 / OpenEvolve / NSGA-II 三条路径的设置、Pareto 前沿、75ms watch 膝点解与稳定性加固清单。
- `docs/ACCEPTANCE_REPORT.md`：严格验收报告（目标→证据矩阵、残余风险、结论）。
- 运行时调优参数集中在 `src/mcp/tuning.mjs`（构建复制到 `server/tuning.mjs`），可用 `PPT_TUNING_JSON` 覆盖。
- 复现：
  ```bash
  npm run bench:modules   # 全模块基线
  npm run evolve          # 进化搜索 → bench/results/
  npm test                # 含 test/stability.test.mjs 的 106 项回归
  ```

## 架构文档

- `docs/ARCHITECTURE.md`：分层、依赖规则、24 个能力矩阵、op 域、relay/store/editor 职责。
- `docs/EXTENDING.md`：新增 capability / op / recipe / relay 路由的步骤与测试清单。

## 已知约束

- **同一时间只应打开一个工作台窗口**：桥用 owner 租约（心跳 3s / 租约 10s）
  保证只有 owner 应用指令、回执、写镜像；第二个窗口会显示「待命」，等
  前一个关闭或租约过期后接管（会从镜像恢复当前 deck）。
  浏览器后台标签页会节流定时器，长时间后台后租约可能失效、所有权转移，
  原窗口会自动暂停同步。
- 版式引擎与审计改动后先跑 `node --test test/*.test.mjs`，并用 `ppt_deck` 生成一份
  clean 测试稿做冒烟（页型/文字/对比度正常，`ppt_audit` 通过）。
