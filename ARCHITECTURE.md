# 架构：dsh 插件工程

本仓库是**插件工程**，职责收敛为一条流水线：
**构建 dsh 插件 → 生成打包产物 → 人工决定发布到 npm**。
它不包含 dsh 本体，不修改 dsh 源码，不做运行时编排与部署，也不承担测试职责。

---

## 一、与 dsh 的边界

```
        ┌──────────────────────────────────────────────┐
        │  本仓库（插件工程）                            │
        │                                              │
        │  packages/  构建库与基建插件                   │
        │  tools/     插件工具链                        │
        │  extensions/ 插件本体                         │
        │  scripts/   流水线脚本                        │
        └───────────────┬──────────────────────────────┘
                        │ 产出：npm 包 / zip 产物 / registry
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
| domain | `dsh-domain.json` | 选择若干 suite 组合成领域描述（仅校验/解析） |

---

## 二、目录职责

| 目录 | 职责 |
|---|---|
| `packages/` | 构建库（plugin-kit、suite-kit）+ 基建级插件产品 + shared 源供给 |
| `tools/` | plugin-generator（脚手架）、plugin-validator（校验）、plugin-release（打包/发布闸） |
| `extensions/` | 插件本体：official（7 个官方插件）、bridges（ppt-bridge 构建工场 + 10 个生成包） |
| `scripts/` | validate-all、check-suite-drift、sync-shared、gen-registry、publish-to-npm、verify-publishable |
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
4. `ppt-bridge/scripts/build-plugin.mjs` 以 `../../../../scripts/` 引用仓库级构建脚本
   （check-suite-drift、lib/shared-sync），ppt-bridge 不能脱离仓库独立构建。

## 四、构建链路（以 PPT 插件为例）

```
npm run build:plugin
  → extensions/bridges/ppt-bridge/scripts/build-plugin.mjs
      1. checkSuiteDrift（suite 元数据一致性闸）
      2. syncSharedDir：把 packages/{service-host,tool-host,state-service,
         asset-service,editor-host}/src 与 plugin-kit 片段快照进插件 server/shared/
      3. 生成契约快照 contract/ppt-contract.json、capabilities.json
      4. esbuild 打包编辑器；拷贝 PPTist 资产
      5. 生成 8 个 skill 包（package.json/cordis.patch.yml/lib/skills 全部脚本生成）
      6. 生成 composition.lock.json（suite 解析结果 + sha256，由 @capyclaw/suite-kit 支撑）
  → 产物提交进仓：extensions/bridges/ppt-bridge/plugin/**（10 个包）
```

## 五、打包与发布

| 环节 | 命令 | 产物 |
|---|---|---|
| 打包 | `release-all` / `release-index` / `release-source` | `dist/plugins/*.zip`、`dist/index.json`、`release/*.zip` |
| 闸 | `validate-all`（结构）、`verify-publishable`（npm pack 可安装性）、`check-registry`（清单一致） | — |
| 发布 | `publish:npm`（dry-run）→ `publish:execute`（人工决定） | npm |

发布集合 = `discoverPlugins()` 过闸结果 = `capyclaw-registry.json`（`gen-registry` 生成）。
例外（registry 外需手动发布）：`@capyclaw/plugin-kit`、`@capyclaw/document-workbench`、`@capyclaw/skills-service`。

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
