# @capyclaw/publisher — npm 发布器

把 capyclaw 插件工程的 npm 发布流水线搬进 dsh：插件工程仓库只负责**生产**（构建 → `dist/` 打包件），
发布动作由本插件在 dsh 内以 MCP 工具执行。发布逻辑逐条移植自仓库原 `scripts/publish-to-npm.mjs`
（闸门、依赖顺序、同版本漂移、发布后 shasum 复核），行为保持对齐。

## 工具

| 工具 | kind | 说明 |
|---|---|---|
| `publisher_whoami` | read | npm 凭据预检（宿主 `npm whoami` / `NODE_AUTH_TOKEN`） |
| `publisher_preview` | read | 全量 dry-run：发现集 → 发布闸/pack 闸 → 已发布与漂移 → 顺序闸，逐包结果 + 汇总 |
| `publisher_execute` | control | 真发布（不可撤销）。**必须显式 `confirm: true`**；支持 `only` / `tag` / `skipTests` |
| `publisher_capabilities` | read | 契约探针（contractVersion 1.x） |

## 使用

1. 安装：`dsh plugin add @capyclaw/publisher`（本包需在 npm 上；首次引导见仓库 docs/PUBLISHING.md）
2. 在 dsh 里对 AI 说「预演发布」→ `publisher_whoami` + `publisher_preview({ root })`
3. 核对批次后「执行发布」→ `publisher_execute({ root, confirm: true })`

## 配置

| 项 | 工具参数 / 环境变量 | 默认 |
|---|---|---|
| 工作区路径 | `root` 参数 / `DSH_PUBLISHER_ROOT` | 无（必填其一） |
| 支撑库清单 | `DSH_PUBLISHER_LIBS`（JSON 数组，相对 root） | 内置 4 项（plugin-kit / document-workbench / host-shell / skills-service） |
| 服务端口 | cordis config `port` / `DSH_PUBLISHER_PORT` | 39700 |

发布凭据沿用宿主环境（dsh 运行用户的 npm 登录态），本插件不经手 token。

## 行为要点（与原流水线对齐）

- 发现集 = 支撑库（显式清单）+ `discoverPlugins()`（过发布闸的插件），先库后插件。
- 同版本漂移闸：本地 `npm pack` sha1 ≠ registry `dist.shasum` 时拒绝（npm 禁止同版本重发）。
- 顺序闸：待发包的 `@capyclaw/*` 依赖闭包必须 registry 可解析或同批发布，否则拦截。
- 发布后复核：registry 收到的 tarball 与本地 pack 逐字节比对。
- 额外 pack 闸：`npm pack --dry-run` 断言 package.json / main / patch 文件必在包内。
