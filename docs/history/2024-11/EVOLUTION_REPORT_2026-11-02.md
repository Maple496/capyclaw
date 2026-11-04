# 进化优化报告（2026-11-02）

> 目标：用进化算法求「最优代码结构与配置参数」，为链路做性能优化。
> 方法：复用仓库既有 NSGA-II 框架（`evolution/`，引擎 `bridges/ppt-bridge/bench/evolution/core.mjs`），
> 基因 = 参与运行时决策的可调参数，founder = 旧生产默认值；评估器 = 真实策略仿真/真实基准；
> 结果确定性可复现（seed=2026）。安全不变式不进搜索空间。

---

## 一、起点：llm-tempkey 评估器从未能运行

审计发现 `evolution/evaluators/llm-tempkey.mjs`（旧版）三处坏点：

1. `import './vclock.mjs'` —— 该模块不存在；
2. `const { host } = await import(.../host.mjs)` —— host.mjs 只导出 `apply/name/CREDENTIAL_REF`；
3. `return objectives` —— `objectives` 从未定义（只有 `results`）。

**修复方式不是打补丁，而是结构性重写**：把轮换决策从宿主里抽成纯函数，评估器直接驱动真实策略。

## 二、结构优化 1：轮换策略纯函数化

新增 `extensions/official/dsh-llm-tempkey/lib/rotation-policy.mjs`：

| 函数 | 职责 |
|---|---|
| `decide(state, now, cfg)` | 周期检查动作：issue（无 Key/过期/进入轮换窗口）/ reuse |
| `shouldForceRefreshOn401(lastIssueAt, now, propagationMs)` | 401 宽限判定：宽限内诚实回 401，超限强制换新 |
| `effectiveMarginSeconds(ttl, margin)` | margin clamp（≤ TTL/2） |

`host.mjs` 改用该模块（行为逐条等价，12/12 测试兜底）；评估器共用同一套决策——**仿真即真实行为**。

## 三、评估器重写：虚拟时钟事件驱动

- 事件驱动（tick 与请求到达取最近者），24h 虚拟时长，毫秒级完成（供 GA 全速搜索）。
- 真实性修正（迭代中发现并修复）：
  1. **tick 抖动 ±10%**（否则 tick 与 TTL 整除时永无 gap，适应度失效）；
  2. **403 恢复相位偏移**（恢复时刻落在 tick 刻度之间）；
  3. **401 探针加密到每 5s**（否则 55s 等违规值落入探针空档）；
  4. 返回契约对齐引擎：`{ ok, objectives, meta }`（首轮进化因返回扁平对象导致“目标全空、平衡解退化为 founder”，已修）。
- 目标（全部最小化）：stabilityFailures（权重 10）、policyViolations（10）、issuedKeys（1.2）、heldSeconds（0.8）、checkCalls（0.4）。

## 四、进化结果（NSGA-II，population 14 × 8 代，evaluated=120，seed 2026）

| 参数/指标 | founder（旧默认） | 进化平衡解 | 变化 |
|---|---|---|---|
| `ttlSeconds` | 300 | **2820** | — |
| `refreshMarginSeconds` | 60 | **555** | — |
| `tickMs` | 30000 | **90000** | — |
| `propagationMs` | 60000 | **60000**（精确命中传播窗口） | 不变 |
| 24h 签发次数 | 340 | **38** | **-88.8%** |
| 24h 检查次数 | 2879 | **960** | **-66.7%** |
| 稳定性违例 | 0 | **0** | 持平 |
| 401 策略违例 | 0 | **0** | 持平 |

**解读**：长 TTL + 大 tick 把「签发/检查」这两类真实成本压到原来的 1/9~1/3；`margin≈6×tick` 提供时钟抖动安全垫；`prop=60s` 被 401 探针精确锁定到真实传播窗口边界。积分占用（`heldSeconds`）≈ 守恒（签发×TTL 近似定值），不构成额外代价。

**固化**：`lib/tuning.mjs` DEFAULTS 与 `cordis.patch.yml` 行 config 同步更新（行 config 优先级最高，只改 tuning 不生效——这是本次固化的关键点）。12/12 测试回归。

## 五、结构优化 2：行审计 patch 缓存（基准 A/B 决策）

链路热点基准（`evolution/chain-bench.mjs`，20 轮，ms/op）：

| 操作 | 优化前 | 优化后 |
|---|---|---|
| pack.stagePlugin（fixture） | 4.20 | 4.20（IO 本质，不动） |
| row-audit 冷启动（清缓存） | 3.70 | 3.41（不劣化） |
| **row-audit 重复调用（热路径）** | **3.70** | **2.75（-26%）** |
| domain.resolve（PPT） | 2.52 | 2.38 |
| manifest.loadSuite（PPT） | 1.84 | 1.59 |
| zip 读写 / sha256 / extract | ≤0.54 | ≤0.54（非热点） |

**结构变体**：`lib/row-audit.mjs` 对 patch 行 id 集合加进程内缓存，键 = `path + mtimeMs + size`（文件变更即失效），上限 512 条，提供 `clearPatchCache()`。收益场景：控制面反复 create / deploy validate / 安装链路。
**未做**：manifest 解析对象的进程内缓存——调用方存在对象引用的潜在变异面，风险 > 收益，明确放弃（保留在报告里）。

## 六、回归矩阵（全部全新跑）

```
plugin-kit 24/24 · suite-kit 64/64 · plugin-development 9/9 · tempkey 12/12
runtime-control 2/2 · workspace-service 7/7 · assembly-kit 12/12 · release 37/37
verify-chain 10/10
```

## 七、风险与边界

1. **单笔预扣增大**：TTL 2820s 使单次预扣 = 2820×费率；余额不足的账号签发可能失败（tuning 注释已标注，可用 `DSH_TUNING_JSON` 覆盖回短 TTL）。
2. **tick 90s**：登录态失效后的最长发现延迟 90s（403 场景恢复 ≤1 tick，评估器已设为稳定性约束）。
3. 评估器假设请求到达均值 11s、真实传播窗口 60s；工作负载明显不同时应重跑进化（流程已固化）。
4. 进化产物可复现：`node evolution/run.mjs --component llm-tempkey --population 14 --generations 8 --seed 2026`。

## 八、复现方式

```bash
node evolution/run.mjs --component llm-tempkey --population 14 --generations 8 --seed 2026
node evolution/chain-bench.mjs --rounds 20 --json evolution/results/chain-bench.json
```
