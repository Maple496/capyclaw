# 性能测试套件

全部为**实测**，没有预置数字。每个脚本都真实调用被测代码，失败会让进程非 0 退出。

## 运行

```bash
cd <repo-root>

# 全部（约 90 秒；建议带 --expose-gc 以启用精确内存判据）
node --expose-gc tests/performance/run-all.mjs

# 跳过需要起进程的 broker 压测
node --expose-gc tests/performance/run-all.mjs --skip-broker
```

产物：`tests/performance/reports/perf-<timestamp>.json`

## 套件

| 文件 | 测什么 | 需要 --expose-gc |
|---|---|---|
| `real-benchmark.mjs` | DIContainer vs Cordis：访问/工厂/事件/插件生命周期/堆 | 建议 |
| `hot-path.mjs` | 循环内读 `ctx.x` vs 局部变量缓存 | 建议 |
| `memory-stability.mjs` | 插件销毁、监听器注销、热循环后堆是否回收 | **必须**（否则只做趋势观察） |
| `broker-stress.mjs` | 真实 broker + 真实子服务：启动/并发/doctor/重启/清理 | 否 |
| `run-all.mjs` | 运行器，汇总并落盘 JSON | 建议 |

## 本机实测基线（2026-11-04，Node v25.2.1 / win32 x64）

> 绝对值受机器与负载影响，**跨机请只看趋势与倍率**。

### DIContainer vs Cordis（`real-benchmark.mjs`）

| 指标 | 实测 |
|---|---|
| DIContainer.resolve()（已注册实例） | 100.9M ~ 102.5M ops/s（≈ 9.9 ns/次） |
| Cordis `ctx.svc` 属性读取 | 141K ~ 146K ops/s（≈ 6.9 µs/次） |
| 倍率 | **DIContainer 快约 693 ~ 768 倍** |
| Cordis `emit`（50 listeners） | 22.9K ~ 24.4K ops/s |
| Cordis 10 插件加载+卸载 | 321 ~ 344 cycles/s（约 2.9 ~ 3.1 ms/轮） |
| 堆增量：DIContainer ×200 | −0.26 ~ −0.30 MB（GC 后为负，即被回收） |
| 堆增量：Cordis Context ×200 | +7.37 ~ +7.38 MB |

**结论**：不要为「访问速度」选 Cordis。慢的原因是 `ctx` 是 Proxy，读属性走反射与依赖追踪。
选 Cordis 的理由是结构性能力（事件、Fiber 生命周期、`ctx.inject`、HMR、`isolate`）。

### 热路径写法（`hot-path.mjs`）

| 写法 | 实测 |
|---|---|
| 单次 `ctx.db` 读取 | 6.9 ~ 7.9 µs |
| 循环内反复读 `ctx.db`（1000 次/轮） | 153 ~ 190 轮/s（约 5.6 ms/轮） |
| 顶部取局部变量后循环 | 131K ~ 138K 轮/s（约 7.3 µs/轮） |
| 提升 | **741 ~ 769 倍** |
| 3 服务场景（900 次调用/轮） | 提升 **257 ~ 276 倍** |

**规则**：`apply(ctx, config)` 开头把需要的服务取到局部变量，循环内只出现局部变量。

### 内存稳定性（`memory-stability.mjs`）

| 场景 | 实测 | 判定 |
|---|---|---|
| 插件创建/销毁 40 轮 | 前半 11.8 KB/轮 → 后半 1.6 KB/轮，总 +0.31 MB | 收敛，无泄漏特征 |
| 监听器 12 轮 × 200 个 | 前半 6.9 KB/轮 → 后半 0.3 KB/轮，总 +0.04 MB；每轮 emit 恰好触发 200 个 | 无泄漏（含行为断言） |
| 服务访问 5 轮 × 200k 次 | 总 −0.09 MB（GC 后回落） | 无泄漏 |

判据：后半段 <16KB/轮，或后半段斜率 < 前半段的 70%（显著收敛）。
**不设绝对内存阈值**——机器差异太大。

### Service Broker（`broker-stress.mjs`）

真实启动 `packages/dsh-service-broker/server.mjs`，通过 `/control/*` 驱动真实子进程服务。

| 项目 | 优化前 | 优化后 |
|---|---|---|
| broker 启动到可用 | 157 ~ 164 ms | 106 ~ 164 ms |
| 单服务 start→健康 | 2.77 ~ 2.80 s | 2.57 ~ 2.80 s |
| **8 服务并发启动** | **22.1 s** | **8.7 ~ 11.3 s（2.0 ~ 2.5x）** |
| 并发后平均每服务 | 2.77 s | 1.09 ~ 1.41 s |
| doctor 吞吐 | 952 ~ 1001 QPS | 952 ~ 1168 QPS |
| doctor P50 / P95 | 0.85 / 1.65 ms | 0.81 / 1.17 ms |
| 重启可靠性 | 5/5 | 5/5（平均 1.73 ~ 1.92 s） |
| 清理后残留 | — | 0 |

并发提升来自修复：`lib/recovery.mjs` 新增异步 `markerAsync`，`lib/engine.mjs` 用它查子进程身份，
并把 broker 自身 marker 缓存（`_brokerMarker`）。原因见下。

## 已发现并修复的真实性能问题

**问题**：`marker()` 在 Windows 上通过 `spawnSync` 调 PowerShell 取进程创建时间，单次约 **900ms**，
且**同步阻塞事件循环**。每次服务启动会调用 2 次（broker 自身 + 子进程），并发启动因此完全串行。

**修复**：
1. `engine.mjs`：broker 自身 marker 只算一次并缓存（进程生命周期内不变）。
2. `recovery.mjs`：新增 `markerAsync()`（异步 spawn，输出格式与 `marker()` 完全一致），
   `engine.mjs` 用它查子进程身份，使多个服务的身份查询可以并行。

**效果**：8 服务并发 22.1s → 8.7 ~ 11.3s（实测 2.0 ~ 2.5x）；
broker 自带测试由基线的 29 通过/1 失败 变为 **30/30（连续 3 次稳定通过）**。
注：原先失败的那条用例是「守护发现根进程退出时保留收据并标记 error，拒绝重启」，
它断言错误文案，属时序敏感用例；改动后稳定通过，但未针对该用例做定向修复。

**已知剩余成本**：单服务仍约 2.6 ~ 2.8s，其中约 1.8s 是两次 PowerShell 身份查询（安全校验，不可省）。
更快的替代方案实测为 `wmic process get CreationDate`（198ms，比 PowerShell 快约 4.7 倍），
但其时间格式与现有收据不兼容，切换会导致升级前启动的服务无法被识别归属，故**未采用**。

## 与其他测试的关系

| 命令 | 覆盖 |
|---|---|
| `npm run test-stack-kit` | stack 编译（实测 9/9） |
| `npm --prefix packages/dsh-service-broker test` | broker 单元/E2E/稳定性（实测 30/30，连续 3 次） |
| `node --expose-gc tests/performance/run-all.mjs` | 性能与内存（本套件 4/4） |

本套件测**性能与稳定性**，不替代功能正确性测试。

## 注意

- 需要真实子进程的 `broker-stress.mjs` 会在 `127.0.0.1` 上开端口；
  端口段按进程 ID 派生，结束时按端口兜底回收，正常退出不留孤儿。
- 若上次运行被强杀，可能残留监听进程；重跑前可用
  `netstat -ano | findstr :<port>` 定位并清理。
