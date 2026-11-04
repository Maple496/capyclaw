# 架构：dsh 插件工程

本仓库是**插件工程**：产出的东西是 dsh 插件包，以及把插件组合成可运行环境的清单。
它不包含 dsh 本体，也不修改 dsh 源码。

---

## 一、与 dsh 的边界

```
        ┌──────────────────────────────────────────────┐
        │  本仓库（插件工程）                            │
        │                                              │
        │  packages/  插件基础设施与基建级插件            │
        │  tools/     插件工具链                        │
        │  extensions/ 插件本体                         │
        │  launchpads/ 插件组合清单（*.stack）           │
        │                                              │
        └───────────────┬──────────────────────────────┘
                        │ 产出：bundle patch / suite / domain
                        ▼
        ┌──────────────────────────────────────────────┐
        │  dsh 运行时（npm 依赖 @deepseek-ai/dsh）       │
        │  Cordis 插件树 + profile + 服务               │
        └──────────────────────────────────────────────┘
```

**扩展方式只有三种官方途径**，都不碰 dsh 源码：

| 途径 | 文件 | 作用 |
|---|---|---|
| bundle | `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` | 把一个插件行插入 Cordis 配置树 |
| suite | `dsh-suite.json` + `dsh.suite` | 把多个插件与 patch 行打成一个可校验组件 |
| domain | `dsh-domain.json` | 选择若干 suite，生成独立 profile |

实测口径：仓库内全部 `cordis.patch.yml` 的操作类型统计为 **40 个 `insert`，0 个 `update`/`remove`**
（`grep -rh "^\s*-\s*\(insert\|update\|remove\)" --include=cordis.patch.yml packages extensions`）。

---

## 二、目录职责

| 目录 | 职责 | 是否加载进 dsh |
|---|---|---|
| `packages/` | 插件基础设施（纯库）+ 基建级插件 | 纯库不加载；基建级插件加载 |
| `tools/` | 生成/校验/发布/启动工具 | 否（工具，不是插件） |
| `extensions/` | 插件本体（official / bridges / flow / llm-config） | 是 |
| `scripts/` | 插件生命周期自动化 | 否 |
| `launchpads/` | 插件组合的运行清单（DSL → stack.json） | 否（输入给 `dshd`） |
| `docs/` | 插件工程文档 | 否 |
| `examples/` | 示例插件 | 否 |
| `tests/` | 性能与稳定性套件 | 否 |
| `research/` | 插件模块实验与基准 | 否 |
| `vendor/` | 插件依赖的第三方领域执行器 | 否（由插件拉起） |

---

## 三、依赖方向

```
extensions/  ──────────────► packages/
（插件本体）                  （基础设施）

tools/       ──────────────► packages/
（工具链）      └──────────► extensions/（读取插件、跑测试、打包）

scripts/     ──────────────► packages/ + tools/
```

**约束**：

1. `packages/` 不得依赖 `extensions/`。
2. `packages/` 内四个包必须保持同级落位（它们用相对路径互相找）：
   `dsh-plugin-kit`、`dsh-suite-kit`、`dsh-runtime-kit`、`dsh-service-broker`。
   证据：`packages/dsh-suite-kit/src/domain.mjs` 按 `../../dsh-plugin-kit` 定位；
   `packages/dsh-runtime-kit/src/index.mjs` 用 `../../dsh-plugin-kit/src/...`。
3. `tools/` 内部允许反向深层引用（如 `tools/dsh-launcher` 直接 import
   `packages/dsh-service-broker/lib/recovery.mjs`）——这是工具链特权，插件代码不要模仿。

---

## 四、插件间通信的三种通道

按实测依赖形态，插件之间**不通过进程内对象互联**，而是：

| 通道 | 机制 | 谁在用（实测） |
|---|---|---|
| **代码复用** | `import 'dsh-plugin-kit'` | 13 个包依赖它（最强的一条） |
| **ctx 服务注入** | `export const inject = ['x']` + `ctx.x` | `skills`（8 个 skill 插件）、`workspace`（5 个）、`serviceHost`（4 个）、`assets`（2 个） |
| **进程/文件** | broker 的 HTTP `/control/*` + `~/.dsh/services.json` discovery | `dsh-runtime-control`、`capyclaw-launchpad` |

> 现状说明：14 个 ctx 服务被 `provide`，其中 10 个（`catalog`、`installer`、`editorHost`、
> `mcpGateway`、`runtimeControl`、`state`、`toolHost`、`serviceBroker`、`llmTempkey`、`scrapling`）
> 在仓库内**没有 ctx 消费方**——它们目前的预期消费方是外部 UI（经 HTTP），不是其他插件。
> 复核脚本：`node scripts/analyze-plugin-layers.mjs`。

---

## 五、性能约定（有实测支撑）

| 约定 | 依据 |
|---|---|
| 热路径不反复读 `ctx.x`，在 `apply()` 顶部取局部变量 | 单次 `ctx.x` 约 6.9~8.7 µs；局部变量方案快 741~775 倍（`tests/performance/hot-path.mjs`） |
| 服务启动的身份校验不要改成同步阻塞 | `marker()` 在 Windows 用 `spawnSync` 调 PowerShell，单次约 900 ms 且阻塞事件循环；异步版让 8 服务并发从 22.1 s 降到 8.7~11.3 s |
| 内存判据只看趋势，不设绝对阈值 | `tests/performance/memory-stability.mjs` 用分段斜率收敛判定 |

---

## 六、已移出的部分

插件工程只保留「造插件」与「把插件组合起来」所需的代码。其余在相邻目录：

| 内容 | 现在位置 |
|---|---|
| dsh 宿主（auth-proxy、单实例锁、前台守卫、workspace 数据）与本地安装的 `@deepseek-ai/dsh` | `../dsh-runtime/apps/harness/deepseek-harness/` |
| 全栈启动脚本、便携 Windows bundle 打包 | `../dsh-runtime/deploy/` |
| 桌面产品定义与打包器 | `../dsh-runtime/product/` |
| 历史归档、一次性验收脚本、阶段性报告 | `../dsh-archive/` |

**harnessDir 解析顺序**（三处实现保持一致：`tools/dsh-launcher/lib/config.mjs`、
`packages/dsh-suite-kit/src/runtime.mjs`、`scripts/lib/bundle-builder.mjs`）：

1. stack / 配置文件里的 `harnessDir`
2. 环境变量 `DSH_HARNESS_DIR`
3. 兄弟目录 `../dsh-runtime/apps/harness/deepseek-harness`
4. 历史布局（`apps/harness/...`、`../deepseekharness_out_of_scope/...`）

都找不到时，启动前报「harnessDir（dsh 宿主目录；本仓库不再内置…）」，不会悄悄指向空目录。

---

## 七、插件参数如何注入

profile 型 stack 支持 `plugins.configs`，由启动器把参数写进 profile 的 `cordis.patch.yml`：

```
stack.plugins.configs[{name,row,config}]
  → dsh-stack-kit/src/plugin-config.mjs
      读 bundle 的 dsh.bundle.patch → 找到目标 insert 行 → 深合并默认 config
  → dsh-stack-kit/src/patch-block.mjs
      写入 cordis.patch.yml 的受管区块（区块外用户内容保留）
  → dsh 加载 profile patch 覆盖 bundle 行
  → 插件 apply(ctx, config) 拿到合并后的完整配置
```

为什么必须由启动器合并：dsh 的 patch 覆盖是 `target[key] = value`，`config` 整键替换，
不深合并就会丢掉插件自己的默认值（见 `dsh-app-boot` 的 `applyEntryPatches`）。

插件侧统一用 `resolveConfig`（`dsh-plugin-kit/config`）解析：
`ctx config → 环境变量 → 代码默认值`，并记录每个值的来源，便于 doctor/日志说明。

---

## 八、运行期插件集合管理

`dshd` 只能整体起停；**运行中**的插件集合由进程内插件 `@capyclaw/plugin-sync` 管。

```
清单（local JSON / 未来 HTTP）
   ↓ describe()
plugin-sync ── listBundles()/listPlugins() ──→ 期望 × 实际 差异
   ↓ apply(changes)
dsh 原生 pluginManager
   ├─ setBundleEnabled(name, enabled)     → dsh.profile.bundles（保留 dependencies）
   └─ setPluginEnabled(entryId, enabled)  → profile cordis.patch.yml 的 disabled
        ↓ dsh-hmr 热重组
   application: applied | restart-required | overridden | failed
```

约定（实测）：

- **唯一可靠的"插件激活"证据**是 `pluginInventory/list` 的 `enabled && fiberPhase === 'active'`；
  `GET /` 200 与 `dshd doctor` 都不能证明。
- entry 被禁用时**不会**触发插件的 `dispose`，所以 `apply()` 必须可重复执行，
  不要在里面注册不可重复的资源（例如固定路径的具名路由）。
- `setPluginEnabled` 收的是 **entryId**（`include:<rowId>`），`setBundleEnabled` 收的是**包名**。
- `overridden` / `restart-required` 不等于成功，必须如实上报。

E2E 覆盖：`tests/e2e/external-dsh.test.mjs`（注入 → 激活 → 包级/行级开关 → 管理器驱动）。

---

## 九、发布链路

```
package.json（name/version/engines.dsh/bundle.patch/publishConfig）
  → tools/plugin-validator（结构校验）
  → tools/plugin-release.publishGateErrors（private / publishConfig / engines / patch / link 依赖）
  → scripts/verify-publishable（npm pack → 扫密钥与绝对路径 → 装进干净目录）
  → scripts/publish-to-npm（默认 dry-run）
  → scripts/gen-registry（从 package.json 重新生成 capyclaw-registry.json）
```

---

## 十、文档导航

- [README](README.md) — 定位与命令
- [docs/architecture/contracts.md](docs/architecture/contracts.md) — 全链契约总册
- [docs/guides/](docs/guides/) — 插件开发/打包/服务集成
- [docs/reference/](docs/reference/) — 插件结构、源码标准、服务标准
- [tests/performance/README.md](tests/performance/README.md) — 性能套件与实测基线
