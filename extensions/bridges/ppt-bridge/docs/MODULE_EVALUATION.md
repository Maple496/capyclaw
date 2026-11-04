# dsh-ppt-suite 模块综合评估（2026-10-31）

> 目标：逐个模块回答“是否有必要做性能优化”，只把有真实收益空间且可安全验证的模块送进进化搜索。
>
> 基线数据：`bench/results/module-baseline.json`（Windows 10 / Node v25.2.1 / 本机 loopback）。
> 复现：`npm run bench:modules`。

## 评估方法

每个模块按四个维度打分：

| 维度 | 含义 |
|---|---|
| 热路径 | 是否每个对话回合/每次工具调用都会执行 |
| 基线余量 | 实测吞吐/延迟是否已明显高于实际负载 |
| 可调空间 | 是否存在延迟 ↔ CPU/带宽、安全 ↔ 性能的真实权衡 |
| 稳定性风险 | 是否已有并发/崩溃/损坏恢复缺陷（优先于性能） |

处置分三类：

- **进化优化**：有真实权衡且能基准测量；
- **仅稳定性加固**：性能已足够，但存在正确性/并发缺陷；
- **保持现状**：无运行时成本或收益不可测。

> 下表为最近一次本机 loopback 基线（`bench/results/module-baseline.json`）。单次测量有 ±20% 波动，结论按量级判断，不依赖单个绝对值。

## 结论总表

| 模块 | 热路径 | 关键基线 | 性能优化必要性 | 处置 |
|---|---|---|---|---|
| dsh-service-host | 是（每个 HTTP 请求） | 2324 req/s，p95 0.80ms，100 并发 36ms | **低**（性能余量大） | 稳定性加固：畸形 URL、原子锁、413 语义 |
| dsh-tool-host | 是（每次 MCP 调用） | 参数校验 8.09M ops/s，19 工具，注册 0.1ms | **低** | 稳定性加固：batch 上限 |
| dsh-state-service | 是（每次 push 落盘） | 写 92 ops/s，读 38,795 ops/s | **中**（写是 durability 成本，不宜牺牲） | 稳定性加固：损坏隔离/checkpoint 回退、journal 轮转 |
| dsh-asset-service | 是（图片插入） | 写 217 MB/s，读 862 MB/s | **低** | 稳定性加固：上传 404、sha256 复核、MIME 降级 |
| dsh-editor-host | 是（编辑器静态资源） | 1818 req/s，p95 0.99ms | **低** | 保持现状 |
| dsh-ppt-workbench | 是（状态/push/watch/MCP） | status p95 0.29ms，push p95 5.98ms，watch 31.1ms/13 wakeups/s | **高**（watch 轮询有真实权衡） | **进化优化 + 稳定性加固** |
| dsh-ppt-skills | 否（按需加载） | list 7.53M ops/s，get 7.4k ops/s | **无** | 仅修契约注入边界 |
| dsh-ppt-suite | 否（安装/组合期） | load 709 ops/s，validate 3.55k ops/s，compose 6.05k ops/s | **无** | 仅修组合/迁移正确性 |

## 分模块说明

### 1. dsh-service-host

- 基线：300 请求 p95 0.80ms，100 并发总耗时 36ms；单进程 HTTP 宿主不是瓶颈。
- 审计发现的真正问题在稳定性而非性能：畸形请求行可打崩进程、单实例锁 TOCTOU、BODY_TOO_LARGE 返回连接重置、loopback 跨源写请求无防护。
- 结论：**不做性能优化**；已修复崩溃/锁/413/跨源写，见 `test/stability.test.mjs`。

### 2. dsh-tool-host

- 基线：16 个工具，注册 0.1ms；参数校验约 809 万次/秒，远端 MCP 往返远大于本地校验成本。
- 结论：**不做性能优化**；补 MCP batch 上限，避免单请求无限串行执行。

### 3. dsh-state-service

- 基线：同步写 92 ops/s（每次原子写 + fsync），读 38,795 ops/s。
- 写吞吐受耐久性约束：降低 fsync/原子替换会换来性能但失去崩溃安全，不划算。
- 真正可优化的是“无谓写放大”：`applyServer` 后保留整批 cmds（最大 8MB）、`taskStatus` 两次全量解析 checkpoint。已改为执行后清空 cmds、checkpoint 只列一次。
- 实测 state 体积：清空 cmds 后 615B vs 保留 1094B（小批次，-44%）；最坏 8MB 批次直接省掉 8MB/次。
- 结论：**不调参；做写放大治理与损坏恢复**。

### 4. dsh-asset-service

- 基线：256KB 资产写 217 MB/s、读 862 MB/s，远高于图片上传实际需求（单图 ≤6MB）。
- 新增 sha256 复核会让读路径多一次哈希（实测约 -5% 读吞吐），但能阻止截断/篡改对象被静默使用；这是稳定性优先的合理代价。
- 结论：**不做性能优化**；修 `/assets` basePath 导致的 `ppt_image` 404、上传 MIME 降级、mount disposer 泄漏。

### 5. dsh-editor-host

- 基线：`app.js`（44KB）p95 0.99ms，1818 req/s；静态托管远未成为瓶颈。
- 结论：**保持现状**。

### 6. dsh-ppt-workbench（唯一高价值优化对象）

- 基线：`/status` p95 0.29ms；单批 push p95 5.98ms；watch 更新延迟 31.1ms，空闲唤醒 13 次/秒。
- 真实权衡：`watchPollMs` 越小，编辑器看到变化越快，但服务端空闲唤醒越多。
- 控制变量实测（同一台机器、5 次中位数）：

| watchPollMs | 更新延迟 | 每秒唤醒 | 相对 50ms |
|---:|---:|---:|---:|
| 50 | 30.9ms | 20 | 基准 |
| **75** | **35.6ms** | **13** | **延迟 +4.7ms，唤醒 -35%** |
| 100 | 58.6ms | 10 | 延迟 +27.7ms，唤醒 -50% |

- 结论：75ms 是膝点解，已固化为默认值（`src/mcp/tuning.mjs`）。50→75 用 4.7ms 的感知延迟换 35% 的空闲轮询开销；100ms 以上延迟代价过大。
- 交叉验证：Google 官方 `alpha_evolve` 客户端（本地 Discovery Engine shim）跑 4 个候选，最优 75ms；OpenEvolve + DeepSeek 跑 9 个候选，最优也是 75ms；50/60ms 变体得分更低。
- 同时修复：并发 push 串行化、applyServer seq 守卫、state 损坏 checkpoint 回退、watcher abort settle、bridge-client 超时/响应上限、relay 启动失败清理。

#### workbench 内部子模块

| 子模块 | 评估 | 处置 |
|---|---|---|
| `server/relay.mjs` + routes | 每请求热路径；HTTP 宿主本身有 2k+ rps 余量 | 只做启动失败清理、并发 push 串行化 |
| `server/store/*` | 每批 push 同步落盘；写放大是主要成本 | 执行后清空 cmds、checkpoint 单次列举、损坏恢复 |
| `server/tools/*` | op 执行是 CPU 微秒级；MCP 往返占主导 | 不调参；补参数边界与图片大小上限 |
| `editor/*`（浏览器端） | 静态资源 + 长轮询；轮询参数是唯一真实权衡 | watchPollMs 进化到 75ms |
| `server/shared/*` 快照 | 与 `packages/dsh-*` 同源；快照漂移会制造“两个实现” | 构建期强制同步，`check:plugin` 对账 |

### 7. dsh-ppt-skills

- 基线：8 个技能，list 753 万次/秒，按需 get 7.4k 次/秒；没有运行时热路径。
- 结论：**无性能优化必要**；只修 `pptmaster-*` 被注入 `ppt_capabilities` 契约提示的边界问题。

### 8. dsh-ppt-suite

- 基线：8 个包/8 行，load 709 ops/s，validate 3.55k ops/s，compose 6.05k ops/s；只在安装/校验时运行。
- 结论：**无性能优化必要**；修 `stripPatchRows` 误删同块行、junction 下 components 路径、缺失包路径/非法 semver、schema capabilities 漂移。
