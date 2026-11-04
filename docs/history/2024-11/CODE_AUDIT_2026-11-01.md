# 组件重复/无用代码审计报告（证据链版）

> 日期：2026-11-01
> 范围：packages/ 全部 15 包 + bridges/ppt-bridge + core-harness + plugin-development + scripts（2,421 个源文件）
> 方法：md5 全量精确重复检测 → 引用图（零引用死文件 + 包依赖矩阵）→ 5 项重点深挖 → 分类处置 → 全量测试回归
> 工具脚本：`code-audit/inventory.mjs`（清单+重复组）、`code-audit/refgraph.mjs`（引用图），可复跑

---

## 1. 审计方法（为什么这个结论可信）

1. **精确重复**：对 2,421 个源文件逐个计算 md5，聚出 140 个 >80B 的完全相同组，再逐组判定成因；
2. **死码检测**：对每个源码文件检查其 basename / 相对路径是否出现在**其它任何**源文件中，
   在收窄到源码目录（排除运行时数据、进化产物、CLI 入口）后，**零引用候选 = 0**；
3. **引用图**：跨包 import 边全量提取（bare specifier + 相对路径穿越），得到包依赖矩阵；
4. **重点深挖**：对 5 个结构性疑点逐一追到最终消费方（见 §3）；
5. **处置后回归**：9 包 83 测试 + ppt-bridge 141 测试 + `verify-standard` 12 项全部通过。

---

## 2. 140 组精确重复的成因分类（全部有主）

| 类别 | 组数 | 代表 | 判定 |
|---|---|---|---|
| **构建期快照**（src ↔ plugin，同仓内单向生成，有 sync/check 机制） | ~60 | `src/core/audit.js ↔ plugin/dsh-ppt-workbench/core/audit.js`、`src/mcp/shared/kit/** ↔ plugin/.../server/shared/kit/**`、`lib/provider.mjs ×10`（8 skill 包各自随包分发） | **合法**：这是仓库声明的分发架构（“生成插件为可独立分发，构建期把公共源码快照进 server/shared”）。本轮已把全部快照刷新到进化后版本并通过 `--check` |
| **测试快照夹具**（core-harness tool-schemas.expected.json ×N） | ~30 | 同一 schema 被 17 个 session 快照引用 | **合法**：快照测试的数据文件，非代码 |
| **进化运行产物**（openevolve checkpoints/runs，跨 checkpoint 保留同一 program） | ~40 | `runs/*/checkpoints/*/programs/*.json` | **合法**：进化运行的历史留档，删除会破坏可复现性 |
| **域构建分发单元**（runtime-kit 整包拷贝进 bundle） | 1 | `dsh-suite-kit/domain.mjs:281 copyPackage(dsh-runtime-kit)` | **合法**：见 §3.1 |
| **废弃层残留**（plugin-development/shared ↔ core-harness workspace/plugins/shared，4 文件相同） | 4 | http-server / config / websocket / single-instance | **已清理**：见 §4 |
| **真实漂移**（进化改了真源、快照未同步） | — | kit fs-lock/lease/http/manager（进化前） | **已修复**：见 §4.1 |

**没有任何一组精确重复是“无主的意外拷贝”。**

---

## 3. 五个结构性疑点的深挖结论（充分论证）

### 3.1 dsh-runtime-kit（3 个 1 行 re-export 文件）——为什么不是无用壳

**证据**：
- `dsh-suite-kit/src/domain.mjs:281`：`copyPackage(runtimeKitRoot, outDir/'dsh-runtime-kit')` —— **域构建时整包拷贝**进 bundle；
- `scripts/artifact-store.mjs:28`：列为制品包；
- 代码消费方：`dsh-catalog/lib/host.mjs`、`dsh-suite-kit/{runtime,workspace}.mjs`（相对路径 import）。

**论证**：它是**分发门面**——bundle 内的稳定路径。因为内容是 `export * from plugin-kit`（1:1），
**结构上不可能漂移**（零维护成本）。删除它需要改 domain 构建逻辑 + bundle 布局 + 5 处 import，
收益为零、风险为正。**保留**。

### 3.2 两套 lease——数据模型 vs 运行时仲裁，不是重复

| | plugin-kit `editor/lease.mjs` | document-workbench `session/lease.mjs` |
|---|---|---|
| 职责 | 编辑器**运行时**抢占仲裁（claim/standby/心跳循环 startAutoAttach） | deck **文档数据**里的 owner 字段（`doc.owner = {id, ts}`），随 doc 持久化 |
| 生命周期 | 进程内存 | 随 journal/checkpoint 落盘、随恢复重放 |
| TTL 语义 | 15s（本次进化确认维持） | 10s（OWNER_TTL，文档侧续约窗口） |

两者操作的存储、失败模式、消费方（serviceHost vs 文档 store）完全不同。**保留，边界已论证。**

### 3.3 两套 journal/state——有意的平行实现（附合并代价论证）

| | plugin-kit `store/journal-store.mjs` | state-service `FileStateBackend` |
|---|---|---|
| 消费方 | workspace-service infra（vendored）→ `ctx.workspace`；plugin-kit 出口 | state-service → `ctx.state`；ppt-workbench `server/store/backends/file-backend.mjs`（BridgeStore 持久层） |
| 语义 | 轻量：原子 state + journal 轮转 + checkpoint | 加固版：**坏 state 隔离（quarantine）** + `replayPending` 崩溃重放 + 恢复语义 |
| 本轮进化 | journalMaxBytes 512KB + 走 tuning | journalMaxBytes 512KB（独立固化） |

**论证**：合并 = 让两个消费方家族（workspace 中间层 / 插件状态标准件）接受同一套 API 与故障语义。
FileStateBackend 的 quarantine/replay 是 state-service 的核心卖点，JournalStore 没有且不需要；
强行统一要么给 workspace 链路引入无用复杂度，要么砍掉恢复语义。**判定：有意平行，保留；
两套实现的差异已在本报告存档，未来若新增第三处需求应先合并再分发。**

### 3.4 service-host 内嵌实例锁 vs kit 的 single-instance —— **后者是死码，已删除**

**证据链**：`acquireLock`（kit 版）的全部引用 = plugin-kit 自己的 index 出口 + workspace-service infra 快照出口，
**全仓零运行时调用**。标准实例生命周期（锁/复用探测/残留接管）由 service-host 内置实现承担
（`createServiceApp.listen` → acquireLock/probeExisting，含本次进化调优的 200ms 探测）。
第二套无人调用的实例锁是纯漂移温床。**处置：删除**（原文件存档 `code-audit/removed/`），
同步清单、快照、文档三处一并清理。

### 3.5 plugin-development/shared（README 自述“已废弃”）—— **已删除**

**证据**：源码引用图零命中（唯一“引用”是 bundles/ 里的历史构建产物和 core-harness 的同名拷贝——
后者属于 harness 自己的运行环境，独立维护）。4 个文件（http-server/config/websocket/single-instance/logger/
editor-attach/index/README）全部是 kit + service-host 出现前的旧代实现。**处置：整目录删除**，
内容存档 `code-audit/removed/plugin-development-shared/`。

---

## 4. 本轮执行的清理（全部有回归验证）

### 4.1 快照欠同步修复（进化调优的收尾，防止三套副本行为分叉）
进化把 kit 的 fs-lock/lease/http/manager/journal-store 改了参数并新增 `tuning.mjs`，但快照还在跑旧值：
- `scripts/sync-shared.mjs`：SHARED_KIT_FILES 增加 `tuning.mjs`、移除 `service/single-instance.mjs`；
  新增 `PUBLIC_PKG_ROOT_FILES`（service-host 自带的 `tuning.mjs` → shared 根，与 kit 的 `kit/tuning.mjs` 各归其位）；
- 全部目标重同步并通过 `--check`：ppt-bridge `src/mcp/shared`（更新 8 文件）、hello-service（13）、flow-engine（4）、
  workspace-service `server/infra`（16 文件，bin/sync.mjs 全量快照含 tuning）；
- `bridges/ppt-bridge/scripts/build-plugin.mjs`：新增 `copyFlattened`（拍平到 infra 根的 http.mjs 的
  `'../tuning.mjs'` 必须改写为 `'./tuning.mjs'`，否则会撞上 relay 自己的 `server/tuning.mjs` 造成静默错配——
  这是本轮发现的最隐蔽的一处**布局陷阱**）；`npm run build:plugin` 重跑 + `--check` 全部最新。

### 4.2 死码删除
| 删除项 | 证据 | 存档 |
|---|---|---|
| `dsh-plugin-kit/src/service/single-instance.mjs` + index 出口 + 同步清单 + 快照 + 文档行 | 全仓零运行时调用 | `code-audit/removed/plugin-kit-service/` |
| `plugin-development/shared/`（8 文件） | 零源码引用 + 自述废弃 | `code-audit/removed/plugin-development-shared/` |
| 根目录 `.tmp-ae/ .tmp-compose/ .tmp-pptdeck.json` | 早期会话临时残留 | `code-audit/removed/root-tmp/` |

### 4.3 回归验证（清理不是靠信心）
- 9 个包 npm test：**83/83 通过**（含 workspace-service 7 个 e2e——它跑的就是刷新后的 infra 快照）；
- ppt-bridge npm test：**141 pass / 0 fail**；
- `sync-shared --check`（3 目标）+ `build-plugin --check`：**全部最新**；
- `verify-standard`：**12 项全 ✓**（bundle tests、suite 元数据 drift、5 个公共插件 suite、hello suite/domain、ppt suite/domain）。

---

## 5. 明确“不合并”清单（避免未来重复劳动时误判）

1. **src ↔ plugin 快照**（ppt-bridge、公共插件）：分发架构本体，有 sync+check 闭环；
2. **runtime-kit**：分发门面（§3.1）；
3. **两套 lease / 两套 journal**：职责边界论证见 §3.2/3.3；
4. **core-harness**：独立 git 仓库（harness 本体），其 workspace/plugins/shared 属于 harness 运行环境，不在本仓处置范围；
5. **openevolve checkpoints / core-harness 测试快照 / .dsh-keynote 会话数据**：运行产物与数据，非代码。

## 6. 复现

```bash
node code-audit/inventory.mjs      # 清单 + 140 组精确重复
node code-audit/refgraph.mjs       # 引用图 + 包依赖矩阵 + runtime-kit 专项
node scripts/sync-shared.mjs --out bridges/ppt-bridge/src/mcp/shared --check
node packages/dsh-plugin-kit/bin/sync.mjs --out packages/dsh-workspace-service/server/infra --force
cd bridges/ppt-bridge && npm run build:plugin -- --check && npm test
node scripts/verify-standard.mjs
```
