# 多 Agent 插件：研究、实现与真实消费端验收报告（2026-11-02）

## 一、结论先行

1. **方向有价值，但必须"按需启用"，不能默认运作。** 真实模型实测（deepseek-flash）：
   - 20 页、单次调用装得下的同构改版：**单 agent 全面更优**（11.7s/4.3k tokens vs 17.3s/21.5k）。
   - 60 页 + 每页备注：多 agent 中位时延 **47.3s vs 90.4s（约 2× 快）**，但 token **80.3k vs 23.3k（3.4× 贵）**，风格一致性更差（要点长度 CV 0.18 vs 0.09）。两者最终交付均为 100%。
   - 结论：**多 agent 只在"时延敏感 + 工作项独立 + 单项耗时长/工具往返重/单次输出超预算"时值得**；其余场景单 agent 更便宜、更稳、风格更一致。
2. **插件已实现"能力 + 决策顾问 + 门禁"**：`multiagent_assess` 先判断值不值得；`run` 在建议为 single 时**默认拒绝执行**，需显式 `force`。
3. **真实消费端验收通过**：桌面网关（3311）→ 源校验 → 安装 → profile bundles 注册 → 服务启动 → 日志 `[multi-agent] ready`。
4. 消费端验收抓出并修复了 **4 个真实缺陷**（ZIP CRC、engines.dsh、Cordis inject、工具 output schema）——证明"从消费端验收"不可替代。

## 二、开源社区取证

| 项目 | 结论 |
|---|---|
| **DeepSeek `dsh-superagent-prototype`** | 研究原型：一个 GitHub 仓库一个 agent 实例、按工作项隔离会话；**不是通用多 agent 编排框架**，官方明示 research code、部分设计未实现 |
| **DeepSeek `deepseek-harness`** | 本插件的基础设施（"Everything is a Plugin"），自带 `ctx.subagents`（in-process/fork/ACP/Codex/Claude Code/dsh-sdk provider）与 `ctx.jobs` |
| **Kimi / MoonshotAI** | 开源物以模型（K2/K3 等）与 `kimi-code`（单 coding agent CLI）为主，**没有多 agent 编排框架** |
| **Anthropic 多 agent 研究系统** | orchestrator-worker：内部研究基准 +90.2%，并行化时延最多 -90%；但 **token 约 15×**，明确不适合紧耦合/共享上下文任务 |
| **LangGraph / AutoGen / CrewAI** | 可借鉴 supervisor / group-chat / hierarchical 模式；均为 Python 运行时，与本仓 Node harness 不直接兼容，仅取设计 |

**判断**：不复刻框架，**薄编排层复用 harness 原生 subagent** 是正确路线；多 agent 的价值边界由实测数据决定，而非概念。

## 三、实现（低耦合）

```
packages/dsh-multi-agent/
├── lib/plan.mjs       DAG 分层 / 循环检测 / 资源冲突检测
├── lib/scheduler.mjs  层内并发 / 层间顺序 / 失败隔离 / 重试 / 取消
├── lib/prompt.mjs     子任务提示词 + 结果 JSON 协议 + 验证提示词
├── lib/delegate.mjs   ctx.subagents.start(provider, …) 适配（可注入）
├── lib/advice.mjs     决策顾问（纯函数：single / multi + 理由 + 成本估计）
└── lib/host.mjs       ctx.multiAgent 服务 + multiagent_run / multiagent_assess 工具
```

- 只依赖 harness 公开 seam：`ctx.subagents`、`ctx.tools`（`inject = ['tools','subagents']`）；
- 不 import 任何领域包；PPT/文档/代码场景只通过 `items[].payload/resources` 传数据；
- **默认不自动运作**：`requireRecommendation=true`，顾问建议 single 时拒绝执行（除非 `force`）。

## 四、策略进化（仿真，确定性）

4 策略 × 3 负载（无冲突 / 重叠写入 / 全局变更），GA（population 20 × 10 代，seed 2026）收敛：

| 策略 | 无冲突负载 | 重叠写入 | 全局变更 |
|---|---|---|---|
| independent（直写） | 最快 | **正确率 70%（覆盖 12 页）** | 覆盖 |
| cow-merge（版本校验） | 快 | 重试预算内仍 73% | 可行但回滚成本高 |
| locked（逐页锁） | 快 | 100% 但 4019ms | 100% 但 17864ms |
| **adaptive（定版）** | **最快** | **100% / 1096ms** | **100% / 2894ms** |

**定版**：`adaptive` + `concurrency 8` + `verify` + 失败重试。adaptive = 同一资源的工作项按计划顺序串行化，其余并行——零覆盖且串行代价最小。

## 五、真实模型 ON/OFF 对比（消费端同款插件代码）

### 场景 A：20 页同构改版（单次可装下）

| 指标 | ON（多 agent） | OFF（单 agent） |
|---|---|---|
| 时延 | 17.3s | **11.7s** |
| token | 21.5k | **4.3k** |
| 交付 | 100% | 100% |
| 质量（标题/要点/配色/字体） | 100% | 100% |

### 场景 B：60 页 + 每页备注（4 轮中位数）

| 指标 | ON（adaptive c8，代码校验+修复） | OFF（单 agent） |
|---|---|---|
| 时延（中位 / 区间） | **47.3s**（42.7–204s） | 90.4s（59.7–295s） |
| token | 80.3k | **23.3k** |
| 调用次数 | ~70 | **1–2** |
| 交付状态 | 100% completed | 100% completed |
| 返工/验证拒绝 | 0–3 次 | 0–1 次 |
| 风格一致性（要点长度 CV） | 0.18 | **0.09** |

**读法**：多 agent 的时延优势不稳定（API 队列波动大），成本与风格一致性劣势稳定；因此**只在时延是硬约束时启用**。

## 六、决策顾问（默认不启用）

`multiagent_assess` / `ctx.multiAgent.assess` 输入工作项（可带 `estimate.outputTokens/toolCalls/toolLatencyMs`）：

| 条件 | 建议 |
|---|---|
| 工作项 < 4 | single（协调成本 > 收益） |
| 估计总输出 ≤ 单次预算（默认 24000 tokens）且非时延敏感、无重工具往返 | single |
| 估计输出 > 预算 / `wallClockCritical` / 单项 ≥3 次工具调用或 ≥3s | multi |
| 资源重叠且 policy ≠ adaptive | single（并行会覆盖） |

`run` 默认按建议门禁；`force: true` 可覆盖。顾问是纯函数，不触发任何子 agent。

## 七、消费端验收（真实桌面网关 3311）

| 步骤 | 结果 |
|---|---|
| 发布到源（index.json + zip + sha256） | ✅ |
| `GET /api/desktop/plugins/source/verify` | ✅ ok:true |
| `POST /api/desktop/plugins/install {name,version}` | ✅ ok:true，`restart_required:true` |
| profile 注册证据 | `dependencies["dsh-multi-agent"]` + `bundles` 含 `dsh-multi-agent` |
| `POST /api/desktop/works/service/start {id:"deepseekharness"}` | ✅ running |
| 运行日志 | ✅ `[multi-agent] ready provider=spawn concurrency=8 tool=multiagent_run` |

### 消费端抓出的真实缺陷（均已修复 + 回归）

1. **ZIP CRC-32 表错误**（合并单一真源时 `c >>> 1` 写成 `c >>> 8`）——Python 解压报 Bad CRC；已修复并加标准 CRC 回归测试。
2. **package.json 缺 `engines.dsh`**——消费端源校验拒绝；已补 `^0.2.0-rc.2`。
3. **Cordis 未声明 `inject`**——运行时访问 `ctx.tools` 抛错；已加 `inject=['tools','subagents']`。
4. **工具 output schema 的 `required` 位置错误**——harness 要求对象级 `required:['text']`；已修正。

## 八、最终建议

- **默认单 agent**；把多 agent 当作"时延/规模超预算时的加速器"，由 `multiagent_assess` 决策、`multiagent_run` 显式执行。
- 样式类确定性规则（配色/字体/编号）**由代码强制**，不要交给 agent（否则一致性下降且浪费 token）。
- 真正适合多 agent 的场景：逐项独立且耗时长（研究检索、逐页图表生成、逐文件分析），或单次上下文/输出超预算。
- 复现：
```bash
node packages/dsh-multi-agent/bench/evolve.mjs                 # 策略 GA
DEEPSEEK_API_KEY=... node packages/dsh-multi-agent/bench/acceptance.mjs --large
```


## 九、速查卡（一页结论）

| 维度 | 20 页同构改版（单次可装下） | 60 页 + 备注（超出单次舒适区） |
|---|---|---|
| 时延 | 多 17.3s / **单 11.7s（单快 32%）** | **多 47.3s / 单 90.4s（多快 48%）** |
| token | 多 21.5k / **单 4.3k（单省 5.0×）** | 多 80.3k / **单 23.3k（单省 3.45×）** |
| 调用次数 | 多 40 / **单 1** | 多 72 / **单 1** |
| 交付/质量 | 均为 100% | 均为 100% |
| 风格一致性（CV） | 多 0.15 / **单 0.04** | 多 0.18 / **单 0.10** |
| 结论 | **单 agent** | 时延敏感才用多 agent；否则单 agent |

**并行覆盖安全**（重叠写入负载）：直写 70% 正确率（丢 12 页）→ 不可用；cow-merge 73%；
locked 100% 但 4.0s；**adaptive 100% 且 1.1s（定版）**。

**默认决策**：`multiagent_assess` 建议 single 时插件拒绝执行（需 `force`）。
阈值：工作项 <4、估计输出 ≤24k tokens、非时延敏感、无重工具往返 → 单 agent。


## 十、最终决策（2026-11-02）：已从生产剔除并归档

**结论：多 agent 在当前 DSH 的 PPT 使用场景下是负收益，不应作为产品能力保留。**

决策依据（全部实测）：
1. 20 页同构改版：单 agent 快 32%、省 5× token、风格一致性高 3.75×；
2. 60 页 + 备注：多 agent 仅时延中位快 48%，但 token 贵 3.45×、风格一致性差 1.8×，
   且时延区间 42.7–204s（波动大，不可作为 SLA）；
3. 覆盖风险：直写策略在重叠负载下正确率仅 70%（丢 12 页），必须靠 adaptive/锁兜底；
4. Anthropic 自身结论一致：多 agent 适合 breadth-first 研究型任务，不适合同构批量改写。

已执行：
- 桌面端**卸载**（catalog installed=false，profile bundles/dependencies 已移除，dump-config 0 匹配）；
- 分发源**下架**（index.json 移除条目 + 删除所有 zip）；
- 代码**归档**至 `archives/experiments/dsh-multi-agent/`（保留实现、测试、benchmark 与数据，
  不在 workspace 内，不影响构建与测试）；
- 保留的基础设施收益：ZIP CRC-32 修复与回归测试、engines.dsh 规范、Cordis inject 经验、
  工具 output schema 规范——这些与多 agent 无关，继续留在主干。

恢复方式（仅当出现真正适合的场景：逐项独立、单项耗时长/工具往返重、单次输出超预算）：
把归档目录移回 `packages/`，重新发布并安装即可；决策顾问与门禁逻辑仍在归档代码中。
