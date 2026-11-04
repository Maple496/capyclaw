# PPT 编辑链路多轮进化报告

> 日期：2026-11-01
> 目标：编辑 PPT 更快速、更高效、效果更好、稳定性更佳
> 范围：`bridges/ppt-bridge`（pptist 专用插件）编辑闭环 = MCP op → ppt-shim 引擎 → relay/store → 编辑器 watch
> 方法：三轮 NSGA-II（宽域 → 窄域 → 审计）+ 3 次重复确认扫描；**发现并修复 3 个生成器/审计器真 bug**

---

## 1. 结论速览

| 维度 | 结果 |
|---|---|
| **更快** | 编辑器更新延迟膝点维持 75ms（32ms 实测）；机制分析证明延迟 ∝ watchPollMs，GA 对更高 poll 的偏好被证实为测量伪影并排除 |
| **更高效** | 空闲唤醒 13 次/s 维持；审计单稿 0.41ms（4 预设 12 页稿）非瓶颈；deadline 类参数确认不构成延迟，保持原值 |
| **效果更好** | **修复 3 个真 bug**：warm 预设对比度 3.86:1 → ≥4.52:1（此前 compose 产出被自家审计打 11 个 block）；bullets 满长度溢出；主题色板假警告。生成稿现在 4 预设全部 0 error 0 warning |
| **稳定性** | 全部 ~250 次评估 stabilityFailures=0（含 6 并发混合编辑、journal 重载恢复、对抗稿审计不崩）；**ppt-bridge 141/141 测试通过** |

---

## 2. 三轮进化设置

引擎复用 `bench/evolution/core.mjs`（确定性 NSGA-II）。新增基因定义 `genomes-editing.mjs`、评估器 `evaluators-editing.mjs` / `evaluators-audit.mjs`、多轮 CLI `cli-editing.mjs`。

| 轮次 | 模块 | 种群×代 | 种子 | 评估次数 |
|---|---|---|---|---|
| R1 宽域 | editing（7 基因：watchPollMs/statusPollMs/pushBase/pushPerOp/watchTimeout/keepAlive/journalMax） | 12×6 | 2026 | 84 |
| R2 窄域 | 同上（以 R1 膝点为 founder，±2 步） | 10×5 | 777 | 60 |
| R3 审计 | audit（5 基因：warnK/errK/overlapMin/overlapErr/neutralDiff） | 10×5 | 2026 | 51 |
| 确认扫描 | founder vs 膝点 × 3 次重复 | — | — | 6 |

编辑评估器（每次评估真实执行）：
- 真实启动 relay，40 批混合 op 走 HTTP push（set-text/fill-slot/add-element/set-notes/set-background/duplicate-slide/move-slide，参数按 ops 真实 schema），测 push p95；
- op 引擎直测 60 批（store+applyOp，纯服务端编辑引擎吞吐），混合 op 预热至计时稳定；
- watch 更新延迟（5 次中位数，自适应挂载等待）；
- 6 并发混合编辑批次必须全部 200 且最终一致；
- journal 落盘体积 + 重载恢复。

审计评估器（非循环真相）：
- **干净语料**：buildDeck 4 预设生成稿（生成器接受的输入，审计必须放行）+ 长标题换行变体；
- **损坏注入**：小框压到 10px / 大框砍到 35%（溢出）、近乎重合与 40% 部分文本重叠、同文案重绘、#777-on-#999 低对比 —— 必须检出且严重度正确；
- **对抗稿**：零高度框、超长单行、60 元素页 —— 不得崩溃。

---

## 3. 测量伪影的发现与修复（方法论核心价值）

第一轮结果交叉验证时发现两处读数违反物理/机制，溯源修复后重跑：

1. **watch 挂载竞态**：`watchSession` 是纯轮询（tick 锚定挂载时刻，代码见
   `dsh-document-workbench/src/session/watch.mjs`）。固定 `sleep(200)` 在 poll>200 时
   push 落在挂载前 → 读到立即返回的假快值（第一轮 poll=225 出现 19ms 不可能值）。
   修复：等待时长 = max(350, pollMs+150)。修复后 poll=75 → 32.2ms（与官方受控扫描 35.6 吻合）。
2. **op 引擎 JIT 顺序效应**：只预热 load 时，混合 op 路径的前期评估 8-9ms/批 vs 后期
   3.9-4.2ms —— 被引擎误读为基因信号。修复：混合 op 预热至连续 3 批波动 <15%。
3. **--scan 旗标**：无值参数未被 arg() 识别导致误触发整轮重跑。已修。

**方法论结论**：GA 会忠实优化评估器给它的一切——包括伪影。多轮 + 机制交叉验证 + 确认扫描是必须的闭环。

---

## 4. 编辑链路判定（R1/R2 + 确认扫描）

确认扫描（3 次重复中位数）：

| 指标 | founder（75ms 等当前固化） | 两轮膝点（poll 175） | 判定 |
|---|---|---|---|
| watch 更新延迟 | 32.1ms | 21.2ms | 膝点读数来自刻度对齐伪影（tick 锚定挂载 + 自适应等待≈1.86×poll 仍相关），机制上延迟 ∝ poll，**不采纳** |
| 空闲唤醒 | 13/s | 6/s | 与延迟是同一枚硬币的两面（∝1/poll） |
| push p95 | 10.47ms | 11.6ms | 噪声级差异 |
| op 引擎 | 9.51ms/批 | 9.04ms/批 | 噪声级差异（预热修复后基因无影响） |
| 稳定性 | 0 | 0 | 全部评估 0 失败 |

**固化判定：编辑链路参数维持现值**（watchPollMs=75、statusPollMs=100、pushBase 12s、pushPerOp 50、keepAlive 5s、journal 2MB）。理由：
- 延迟 ∝ poll 是机制级事实（代码+官方受控扫描+本轮修复后读数三方一致），“编辑更快速”要求更小的 poll 而非更大；75 是上一轮以延迟/唤醒 2.0/1.5 权重选出的膝点，本轮未发现推翻它的可信证据；
- deadline 类参数（pushBase/pushPerOp/statusPoll）只影响超时预算，不构成延迟；GA 的漂移是噪声，且下调会侵蚀大批量编辑的健壮性余量；
- 真正的“编辑更快”杠杆不在这些参数，而在第 5 节的正确性修复（省掉整轮审计 block-返工循环）与未来可能的 op 引擎算法优化（当前 4-9ms/批已远低于轮询粒度，非瓶颈）。

---

## 5. 审计轮：3 个真 bug 修复 + 阈值确认

### 5.1 修复一：warm 预设对比度不达标（正确性）
`PRESETS.warm` 的 `muted:#8a7a70` / `accent:#c8583a` 对 bg/card 只有 **3.86-4.00:1**（WCAG AA 要求 4.5:1）。
后果：`compose`/`ppt_deck` 用 warm 预设生成的**每一页文字都被自家 `ppt_audit` 打 11 个 contrast block**
——用户拿到的一定是“审计不合格”的 deck，触发返工循环。
修复：对比度求解选定 `muted:#67594f`（6.31/5.60）+ `accent:#a6431f`（5.71/5.07），保留暖色气质。
验证：4 预设生成稿 0 error。

### 5.2 修复二：bullets 满长度溢出（正确性）
单行框 34px @22px 字号最多容纳 ~36 个 CJK 字符，但生成器允许 40 字 → 满长度纯中文要点折行溢出。
修复：单行字数上限 40 → 36（与框容量一致）。

### 5.3 修复三：主题色板假警告（误报）
business/tech 的设计主题色（bg/accent/accent2）被计入“配色漂移”→ 每稿 1 条假 warning。
修复：`auditDeck` 预登记 `deck.theme.themeColors`（设计意图声明），只对漂移出主题的配色计数。

### 5.4 阈值确认（搜索后维持 founder）
GA 膝点漂移到 warnK 1.0 / errK 1.3 / overlapErr 0.35，经边界分析**全部否决**：
- `warnK 1.0`：对生成器接受的换行标题（22 字 @50px，needed/H=1.13）产生假警告——实测复现
  （`文字可能溢出：约 2 行，需要 135px，框高 120px`）；
- `overlapErr 0.35`：0.32 重叠率从 error 变为静默（漏检回归）；
- `errK 1.3`：对语料无判别力（注入用例在任何 errK ≤ 2.1 下 severity 相同）。
结论：**warnK 1.2 / errK 1.5 / overlap 0.15-0.3 / neutralDiff 20 确认为最优**，搜索域内无更优解。

### 5.5 审计基础设施
`audit.js` 新增 `globalThis.PPT_AUDIT_TUNING` 钩子（5 阈值可注入，默认值不变，core 保持零依赖可在浏览器运行），
后续重新进化或线上调优无需改代码。

---

## 6. 验证

- ppt-bridge 全量单测：**141 pass / 0 fail**（1 skipped 为既有用例）
- 稳定性：编辑评估器全部评估（R1 84 + R2 60 + 修复前两轮 ~290 + 扫描）stabilityFailures = 0
- 干净语料：4 预设 + 长标题变体全部 0 error 0 warning
- 损坏注入：6 类全部检出、严重度正确
- 对抗稿：全部 finite score、无崩溃

## 7. 复现

```bash
cd bridges/ppt-bridge
node bench/evolution/cli-editing.mjs --module editing --round 1        # 宽域
node bench/evolution/cli-editing.mjs --module editing --round 2        # 窄域（自动以 R1 膝点为 founder）
node bench/evolution/cli-editing.mjs --module audit   --round 3        # 审计阈值
node bench/evolution/cli-editing.mjs --module editing --scan           # founder vs 膝点确认扫描（3 次重复）
npm test
```

生产覆盖（不改源码）：`PPT_TUNING_JSON='{"watchPollMs":75,...}'`（relay/store 调优层沿用既有机制）；
审计阈值可经 `globalThis.PPT_AUDIT_TUNING` 注入。

## 8. 产出物

| 路径 | 内容 |
|---|---|
| `bridges/ppt-bridge/bench/evolution/genomes-editing.mjs` | 编辑链路 7 基因 + 审计 5 基因定义 |
| `bridges/ppt-bridge/bench/evolution/evaluators-editing.mjs` | 编辑闭环真实评估器（混合 op + relay + 并发 + 恢复） |
| `bridges/ppt-bridge/bench/evolution/evaluators-audit.mjs` | 审计一致性评估器（生成稿 + 损坏注入 + 对抗稿） |
| `bridges/ppt-bridge/bench/evolution/cli-editing.mjs` | 多轮进化 CLI（含窄域派生与确认扫描） |
| `bridges/ppt-bridge/bench/results/evolution-{editing-r1,editing-r2,audit-r3,editing-scan}.json` | 三轮结果与扫描数据 |
| `evolution/results/applied-changes.json` | 全部固化变更（含本轮回滚信息） |
| 本文件 | 多轮进化报告 |

## 9. 边界与后续

- 浏览器侧编辑器节奏（stateDebounceMs/heartbeatMs/claimRetryMs 等）需要浏览器在环测量，本轮未覆盖——如需可挂 browser-use 驱动真实编辑页做第四轮；
- op 引擎当前 4-9ms/批（60 批 × 10 op），远低于交互粒度，非瓶颈；若未来 op 数量级增长，可考虑增量应用而非全量克隆；
- 审计的对比度下限（4.5/3.0）为 WCAG 政策值，不进搜索域。
