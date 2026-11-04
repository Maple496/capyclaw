# 基础设施 + pptist 插件 全面进化调优报告

> 日期：2026-11-01
> 范围：`packages/` 全部基础设施组件 + `bridges/ppt-bridge`（pptist 专用插件）
> 方法：NSGA-II 多目标进化（复用 ppt-bridge 已验证的 `bench/evolution/core.mjs` 引擎）
>       + 3 次重复确认扫描（中位数决策，排除单次测量噪声）
> 结果：**6 项参数固化变更 + 1 项正确性修复**，全部 8 个基础设施包 76/76 测试通过

---

## 1. 总体结论

| 组件 | 评估次数 | 结论 |
|---|---|---|
| dsh-plugin-kit | 83 | **改 2 项**：锁轮询 25→10ms（竞争延迟 -36%）、journal 2MB→512KB（尾读 -56%、磁盘 -70%） |
| dsh-suite-kit | 79 | **改 1 项**：就绪轮询 500→300ms（启动检测 -16%） |
| dsh-service-host | 77 | **改 1 项**：复用探测 400→200ms（端口被占时启动阻塞 -47%） |
| dsh-state-service | 25 | **改 1 项**：journal 2MB→512KB（尾读 -57%、追加 +8%） |
| dsh-mcp-gateway | 16 | **改 1 项（正确性修复）**：上游超时 15s→30s，覆盖 ppt 截图链 ~21s |
| dsh-asset-service / dsh-editor-host / dsh-tool-host / dsh-runtime-kit | — | 评估后确认无有效基因（策略值/纯结构/纯 re-export），不进搜索 |
| **ppt-bridge（pptist）** | 60（relay 50 + store 6 + 缓存） | **重验证通过：现有固化调优（watchPollMs=75 膝点）仍在 Pareto 前沿，无需改动** |

稳定性约束贯穿全程：每个评估器内嵌对抗性稳定性场景（跨进程锁互斥、journal 轮转恢复、
崩溃重载、黑洞上游中止、空锁误抢），任何违例即 `ok=false`（权重 10×，Pareto 支配下直接淘汰）。
**所有入选解 stabilityFailures = 0。**

---

## 2. 已固化变更（旧 → 新）

完整机器可读版：[evolution/results/applied-changes.json](./evolution/results/applied-changes.json)

| # | 位置 | 参数 | 旧 | 新 | 实测效果（3 次重复中位数） |
|---|---|---|---|---|---|
| 1 | `dsh-plugin-kit/src/tuning.mjs` | `fileLockPollMs` | 25 | **10** | 24 路锁竞争 2202→1400ms；GA 前沿显示 poll≥90 恶化 2-3 倍 |
| 2 | `dsh-plugin-kit/src/tuning.mjs` | `journalMaxBytes` | 2MB | **512KB** | 尾读 p95 4.3→1.9ms，磁盘 1.75MB→690KB，追加吞吐持平+ |
| 3 | `dsh-plugin-kit/src/workspace/manager.mjs` | WorkspaceManager journal 默认 | 2MB | **512KB** | 同构机制统一默认 |
| 4 | `dsh-suite-kit/src/tuning.mjs` | `readyPollMs` | 500 | **300** | 真实 startRuntime 就绪检测 1948→1644ms |
| 5 | `dsh-service-host/src/tuning.mjs` | `reuseProbeTimeoutMs` | 400 | **200** | 黑洞端口启动阻塞 425→227ms；健康复用 RTT 1-3ms 仍有 60× 余量 |
| 6 | `dsh-state-service/src/index.mjs` | FileStateBackend journal 默认 | 2MB | **512KB** | 尾读 4.34→1.85ms，追加 5413→5857 ops/s，磁盘 -33% |
| 7 | `dsh-mcp-gateway/src/index.mjs` | `DEFAULT_UPSTREAM_TIMEOUT_MS` | 15s | **30s** | **正确性修复**：ppt 截图链 ~21s 经网关会被 15s 误杀（工具仍在跑，客户端先收到错误） |

回滚方式：每项都是单常量变更，旧值记录在 `applied-changes.json`。

### 评估后**不改**的参数（及理由）

- **plugin-kit**：`fsLockSyncTimeoutMs/staleMs`（搜索域内 0 失败，保守值即最优带）、
  `leaseWaitPollMs`、`catalogThrottleMs`、`tokenVerifyCacheMs`（基准无区分度，GA 漂移属噪声）、
  `keepAliveTimeoutMs`（**安全不变式**：必须 < `headersTimeoutMs`(10s)；15000 在基准内无收益却破坏不变式）。
- **suite-kit**：`portScanRange=200`、`probeHttpTimeoutMs=1000`、`canConnectTimeoutMs=500`、
  `stopPollMs=100`（GA 把 probeHttp 漂移到 4600 是噪声追逐——健康路径上超时上限无代价差；
  stop 检测由 taskkill 自身 ~100ms 主导，步长不可见）。
- **service-host**：`portScanLimit=50`、`lockFreshGraceMs=2000`、`closeGraceMs=50`（确认扫描无稳定信号）。
- **state-service**：`journalTailLimit=8`（尾读耗时由整文件读取主导）。

---

## 3. 各组件细节

### 3.1 dsh-plugin-kit（7 基因，pop 12 × 6 代）

基因：fs-lock 同步超时/过期阈值/轮询步长、journal 轮转阈值/尾读行数、catalog 节流、keep-alive 超时。

评估器压力场景（全部真实执行）：
- 24 路进程内异步锁竞争 + **4 子进程 × 20 op 跨进程互斥**（计数器必须精确 =80，
  同时验证 `DSH_TUNING_JSON` env 注入链路）；
- 400×4KB journal 真实追加 + 轮转正确性 + 200 次尾读 p95；
- 120 次 putJson 的 catalog 写次数与滞后版本数（节流过小→写放大，过大→索引滞后）；
- 租约 wait() 检测延迟（claim 延迟 120ms 注入）；
- keep-alive 空闲 1.4s 后的重连计数。

确认扫描（6 组 × 3 次重复）：poll=5/10 中位 1280/1400ms vs poll=25 的 2202ms；
journal 512KB 尾读 1.85ms vs 2MB 的 4.34ms。最终取 poll=10（比 5ms 多 ~9% 延迟，
但轮询 IO 减半——每次轮询含 statSync+readFileSync）。

### 3.2 dsh-suite-kit（5 基因，pop 12 × 6 代）

评估器**真实调用 `startRuntime`**：stub auth-proxy 800ms/1100ms 延迟监听、
/healthz 延迟 350ms 响应（对 probeHttpTimeoutMs < 400 的基因组构成真实稳定性压力）、
真实 `stopRuntime`（taskkill + pidAlive 轮询）。
`allocateRuntimePorts` 在 40 个注册表保留 + 8 个真实绑定端口下执行。

结论：就绪轮询 500→300ms 是唯一有信号的基因；scanRange 缩小会在高占用下真实失败
（40 个保留端口需 range≥50），放大无代价——保持 200。

### 3.3 dsh-service-host（4 基因，pop 12 × 6 代）

评估器真实 `createServiceApp().listen()`：6 个真实占位端口顺延启动、
黑洞实例（accept 不响应）复用探测、同 id 实例复用、空锁宽限内拒绝/超宽限接管、
关闭延迟、keep-alive 吞吐（6.6K-17K rps，非瓶颈，与 ppt-bridge MODULE_EVALUATION 结论一致）。

结论：复用探测 400→200ms。`reuseProbeTimeoutMs` 是"端口被非本服务进程占用"时
每次启动的固定税；200ms 对健康实例仍有 60× 余量。

### 3.4 dsh-state-service（2 基因，pop 10 × 4 代）

真实 FileStateBackend：400×3.6KB 追加+轮转、150 次原子写、checkpoint、崩溃重载。
256KB 在所有目标上严格占优且 0 失败；保守取 512KB（2 倍历史容量余量）。

### 3.5 dsh-mcp-gateway（1 基因，pop 10 × 4 代）

真实 3 上游：快工具 p95（1-3ms，透传开销极小）、5s 慢工具（超时下限压力：
timeout<5s 的基因组稳定性失败——3000ms 即失败 ✓ 引擎正确淘汰）、
callTool 永挂的上游（中止延迟 ≈ timeout，实测 15000→15015ms 精确）。

**进化发现的真实问题**：超时 15s < ppt 截图链最坏 ~21s
（`SHOT_WAIT_DEADLINES_MS=[12000,6000]` + settle 3000ms）。经网关聚合的
`ppt_screenshot` 调用会被网关在 15s 误杀而工具仍在服务端执行。升到 30s 覆盖 + 43% 余量；
代价仅是"上游真挂死"时的中止从 15s 变 30s（客户端自身超时仍然生效）。

### 3.6 无有效基因的组件（评估后记录，不进搜索）

- **dsh-asset-service**：`maxUploadBytes`/MIME 改写是安全策略值，非性能参数；
- **dsh-editor-host**：静态托管 + 租约透传（lease 参数属 plugin-kit）；
- **dsh-tool-host**：结构默认值（kind/since/schema），无数值热点；
- **dsh-runtime-kit**：3 个文件均为 `export * from dsh-plugin-kit`，实际参数即 plugin-kit，由其测试覆盖。

---

## 4. ppt-bridge（pptist）重验证

ppt-bridge 在 2026-10-31 已用同一方法学做过完整进化（NSGA-II + OpenEvolve +
AlphaEvolve 客户端三条路径，结论固化在 `server/tuning.mjs`）。本轮用其自带管线
（`bench/evolution/cli.mjs`，pop 10 × 4 代，seed 2026）重验证：

- **relay**：founder（watchPollMs=75 膝点）**仍在 Pareto 前沿**（lat 36.3ms / 13 唤醒每秒 / 0 稳定性失败）。
  本轮"平衡解"指向 poll=225，但其延迟读数（19.8ms）与上次受控扫描（200ms→163ms）矛盾，
  属长轮询挂载竞态产生的测量伪影（延迟读数低于轮询间隔的物理合理区间），
  **不采纳**——维持 75ms。
- **store**：journalMaxBytes 256K-8192K 全部等价（msPerBatch 4.26-4.59ms，
  founder 的 15.59 为首次评估 JIT 残留），recovery 全 0 失败——维持 2048KB。

**结论：ppt-bridge 现有固化调优在今日环境下依然有效，无参数变更。**

---

## 5. 验证

- 固化后全量单测：**8 包 76/76 通过**
  （plugin-kit 17、suite-kit 32、service-host 6、state-service 5、asset-service 4、
  editor-host 3、mcp-gateway 3、tool-host 6）。
- 基线（进化前）同为 76/76 —— 无行为回归，只有性能特征变化。
- 已知噪声：GA 运行期间 3/77 次 service-host 评估因瞬态 EADDRINUSE 失败（被引擎标记后不参与前沿），不影响结论。

---

## 6. 复现

```bash
# 冒烟（founder 各跑一次评估器）
node evolution/smoke.mjs plugin-kit suite-kit service-host state-service mcp-gateway

# 进化搜索（全部组件，~15 分钟）
node evolution/run.mjs --component all

# 确认扫描（3 次重复中位数）
node evolution/scan.mjs --component plugin-kit --cases evolution/cases/plugin-kit.json --reps 3
node evolution/scan.mjs --component suite-kit  --cases evolution/cases/suite-kit.json  --reps 3
node evolution/scan.mjs --component service-host --cases evolution/cases/service-host.json --reps 3
node evolution/scan.mjs --component state-service --cases evolution/cases/state-service.json --reps 3
node evolution/scan.mjs --component mcp-gateway --cases evolution/cases/mcp-gateway.json --reps 3

# ppt-bridge 重验证（其自带管线）
cd bridges/ppt-bridge && node bench/evolution/cli.mjs --module all --generations 4 --population 10 --seed 2026

# 全量测试
for p in dsh-plugin-kit dsh-suite-kit dsh-service-host dsh-state-service dsh-asset-service dsh-editor-host dsh-mcp-gateway dsh-tool-host; do (cd packages/$p && npm test); done
```

生产环境临时覆盖（不动源码）：

```bash
DSH_TUNING_JSON='{"dsh-plugin-kit":{"fileLockPollMs":10,"journalMaxBytes":524288},"dsh-suite-kit":{"readyPollMs":300},"dsh-service-host":{"reuseProbeTimeoutMs":200}}' node <plugin>
```

---

## 7. 产出物

| 路径 | 内容 |
|---|---|
| `evolution/` | 引擎接入 + 5 组件基因定义 + 5 个真实评估器 + 扫描/冒烟/运行 CLI |
| `evolution/results/<component>.json` | 各组件 Pareto 前沿 + 平衡解 + 代际历史 |
| `evolution/results/applied-changes.json` | 全部固化变更（含旧值，可回滚） |
| `packages/*/src/tuning.mjs`（3 个新文件） | plugin-kit / suite-kit / service-host 调优层（默认值即进化结果，支持 `DSH_TUNING_JSON` 覆盖） |
| `bridges/ppt-bridge/bench/results/evolution-*.json` | ppt-bridge 重验证结果（其自带管线产出） |
| 本文件 | 汇总报告 |
