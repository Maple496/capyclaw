# 架构：dsh 插件工程

本仓库是**插件工程**，职责收敛为一条流水线：
**构建 dsh 插件 → 生成打包产物（dist/ zip + index + registry）**。
npm 发布不在仓内：由 dsh 内的 `@capyclaw/publisher` 插件（源在本仓
`extensions/official/capyclaw-publisher/`）执行。
它不包含 dsh 本体，不修改 dsh 源码，不做运行时编排与部署，也不承担测试职责。

---

## 一、与 dsh 的边界

```
        ┌──────────────────────────────────────────────┐
        │  本仓库（插件工程）                            │
        │                                              │
        │  packages/  构建库与基建插件                   │
        │  tools/     插件工具链                        │
        │  extensions/ 插件本体（含 publisher 发布器）   │
        │  scripts/   流水线脚本                        │
        └───────────────┬──────────────────────────────┘
                        │ 产出：zip 产物 / registry 清单
                        ▼
        ┌──────────────────────────────────────────────┐
        │  dsh 运行时（npm 依赖 @deepseek-ai/dsh）       │
        │  Cordis 插件树 + profile + 服务               │
        │  （@capyclaw/publisher 在这里发布 npm 包）     │
        └──────────────────────────────────────────────┘
```

**扩展方式只有三种官方途径**，都不碰 dsh 源码：

| 途径 | 文件 | 作用 |
|---|---|---|
| bundle | `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` | 把一个插件行插入 Cordis 配置树 |
| suite | `dsh-suite.json` + `dsh.suite` | 把多个插件与 patch 行打成一个可校验组件 |
| domain | `dsh-domain.json` | 选择若干 suite 组合成领域描述（仅校验/解析） |

---

## 二、目录职责

| 目录 | 职责 |
|---|---|
| `packages/` | 构建库（plugin-kit、suite-kit）+ 基建级插件产品 + shared 源供给 |
| `tools/` | plugin-generator（脚手架）、plugin-validator（校验）、plugin-release（打包/发布闸） |
| `extensions/` | 插件本体：official（7 个官方插件）、bridges（ppt-bridge 构建工场 + 10 个生成包） |
| `scripts/` | validate-all、check-suite-drift（三 suite）、check-package-exports、bump、release、gen-registry |
| `docs/` | 工程文档（guides / reference） |

## 三、依赖方向

```
extensions/  ──────────────► packages/
（插件本体）                  （基础设施）

tools/       ──────────────► packages/
（工具链）      └──────────► extensions/（发现插件、打包、校验）

scripts/     ──────────────► packages/ + tools/
```

**约束**：

1. `packages/` 不得依赖 `extensions/`。
2. `@capyclaw/suite-kit` 与 `@capyclaw/plugin-kit` 保持同级落位（相对路径互相引用）。
3. `tools/capyclaw-plugin-release` 以相对路径直连 `packages/capyclaw-suite-kit/src/{manifest,domain}.mjs`。
4. 三个 bridge 的 `scripts/build-plugin.mjs` 都只声明差异配置，并调用
   `scripts/lib/bridge-build.mjs` 的 `runBridgeBuild`；bridge 不能脱离仓库独立构建。

## 四、统一构建链路

三个 bridge（PPT / Canvas / Browser）共用唯一流水线 `scripts/lib/bridge-build.mjs` 的
`runBridgeBuild()`；各自的 `scripts/build-plugin.mjs` 只声明技能包、MCP 源拷贝、基建供应子集、
编辑器选项与 sanity 清单。根 `npm run build` / `npm run check` 并行调度三桥，单桥仍可独立运行。

```
npm run build
  → scripts/build-all.mjs（并行调度）
      ├─ ppt-bridge/scripts/build-plugin.mjs ─┐
      ├─ canvas-bridge/scripts/build-plugin.mjs ├─ runBridgeBuild(config)
      └─ browser-bridge/scripts/build-plugin.mjs ┘
          1. checkSuiteDrift（suite 元数据一致性闸）
          2. syncSharedDir：packages/{service-host,tool-host,state-service,
             asset-service,editor-host}/src + plugin-kit 片段 → server/shared/
          3. 生成工具契约快照与 capabilities.json
          4. 按 INFRA_KIT_FILES 声明，从 plugin-kit 选择性拼接运行时基础设施
             （HTTP、调优、锁、存储、workspace/runtime 等）
          5. 按配置可选打包编辑器 / 拷贝运行时资产
          6. 生成单 skill 包、composition.lock.json、suite patch
          7. skill lint 与包完整性 sanity
  → 各 bridge 的 plugin/ 可安装包产物（保持提交进仓）
```

基建来源分两类并在构建期注入：公共插件快照由 `scripts/sync-shared.mjs` 的 `PUBLIC_SHARED`
清单管理；plugin-kit 文件由 `scripts/lib/bridge-build.mjs` 的 `INFRA_KIT_FILES` 供应表管理，
每个 bridge 通过 `kitInfra` 选择所需子集。新增 bridge 只需提供配置，不复制流水线实现。

## 五、打包与发布

| 环节 | 命令 | 产物 |
|---|---|---|
| 版本 | `node scripts/bump.mjs <pkg> <level> [--write]` / `--sync-refs` | 本地版本一处提升（package.json / SKILL_PACKAGES 表 / PACKAGE_VERSION / suite version） |
| 打包 | `release-all` / `release-index` / `release-source` | `dist/plugins/*.zip`、`dist/index.json`、`release/*.zip` |
| 闸 | `validate-all`（结构）、`check-registry`（清单一致）、`verify-source`（zip 源标准） | — |
| 发布 | dsh 内 `@capyclaw/publisher` 插件（`publisher_preview` → `publisher_execute`） | npm |

发布集合 = `discoverPlugins()` 过闸结果 = `capyclaw-registry.json`（`gen-registry` 生成），
外加支撑库清单（`scripts/lib/publish-set.mjs`，plugin-kit / document-workbench /
host-shell / skills-service）——支撑库在 registry 外，由 publisher 插件显式清单发布。

## 六、插件间通信的通道

插件之间不通过进程内对象互联，而是：

| 通道 | 机制 |
|---|---|
| 代码复用 | `import '@capyclaw/plugin-kit'` |
| ctx 服务注入 | `export const inject = ['x']` + `ctx.x`（skills、workspace、serviceHost 等） |
| 依赖声明 | suite 组合（`dsh-suite.json` → composition.lock.json） |

## 七、性能约定（历史实测）

| 约定 | 依据 |
|---|---|
| 热路径不反复读 `ctx.x`，在 `apply()` 顶部取局部变量 | 单次 `ctx.x` 约 6.9~8.7 µs（历史基准） |
| 服务启动的身份校验保持异步 | 同步 `spawnSync` 会阻塞事件循环（Windows 单次约 900 ms） |
