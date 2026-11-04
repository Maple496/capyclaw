# 进化优化结果（AlphaEvolve / OpenEvolve + NSGA-II）

> 产出日期：2026-10-31
> 引擎：`bench/evolution/core.mjs`（确定性 NSGA-II）+ `bench/openevolve/`（OpenEvolve 真实 LLM 进化）
> 运行命令：`npm run evolve`、`npm run evolve:openevolve`

## 1. 算法来源与实现边界

Google DeepMind 的 **AlphaEvolve**（2025）公开的核心循环是：

1. 维护一个程序/配置种群（program database）；
2. 用 LLM 变异 + 交叉产生候选；
3. 在真实评估器上打分；
4. 用多目标非支配排序 + 拥挤距离选择下一代；
5. 迭代收敛到 Pareto 前沿。

Google Cloud 官方仓库 **`Google-Cloud-AI/alphaevolve-on-googlecloud`**（2026-07 开源）是
AlphaEvolve 的客户端库 + 示例，但**生成端是 GCP 托管服务**，运行需要 GCP 项目、
AlphaEvolve/Gemini Enterprise 开通、`PROJECT_ID` / `GE_APP_ID` 和
`gcloud auth application-default login`。本机没有这些凭据。

因此本项目实际使用三条可复现路径：

1. **Google 官方 `alpha_evolve` client/controller/worker**（vendored 在本目录，
   Apache-2.0）：通过 `bench/google-alpha-evolve/local_service.py` 的 Discovery Engine
   兼容 shim 跑通官方 controller/worker 闭环；本机无 GCP 凭据，生成端是本地候选队列
   而非 Gemini，用于验证官方客户端集成；
2. **OpenEvolve**（`algorithmicsuperintelligence/openevolve`，AlphaEvolve 的开源实现，
   7.6k stars）：用 DeepSeek（OpenAI 兼容端点）真实做 LLM 变异与候选生成，
   `bench/openevolve/` 下保留 seed/evaluator/config 与运行产物；
3. **NSGA-II + typed genome**（`bench/evolution/core.mjs`）：不依赖 LLM 的确定性
   多目标搜索，用来交叉验证前两条路径的结论、并覆盖无法用 LLM 打分的 state 参数。

评估器始终真实启动 relay、真实读写 store、真实跑 HTTP/MCP 请求，不使用模型估算。
若后续提供 GCP 凭据，可直接把官方客户端的 base_url/credentials 指向 GCP，
本目录的 evaluator 与 genome 可以直接复用。

## 2. 搜索设置

| 项 | relay/workbench | state/persistence |
|---|---|---|
| 种群 | 10 | 10 |
| 代数 | 4 | 4 |
| 种子 | 2026 | 2026 |
| 评估次数 | 50 | 6（枚举基因，重复基因组会缓存） |
| 目标 | 更新延迟、空闲唤醒、status/push p95、稳定性 | 批处理耗时、state 体积、journal 体积、恢复正确性 |
| 约束 | 稳定性失败必须为 0 | 恢复失败必须为 0 |

评估器会先预热 30 个批次/15 次请求，排除 JIT 与模块加载噪声；watch 延迟取 5 次中位数。`p95` 单次抖动较大，因此在最终权重中被压低（0.3），避免把噪声当成优化收益。

## 3. relay/workbench 结果

控制变量 scan（同机、5 次中位数）：

| watchPollMs | 更新延迟 | 每秒唤醒 | 结论 |
|---:|---:|---:|---|
| 50 | 30.9ms | 20 | 原默认 |
| **75** | **35.6ms** | **13** | **选中：+4.7ms 延迟，-35% 唤醒** |
| 100 | 58.6ms | 10 | 延迟代价过大 |
| 150 | 110.5ms | 7 | 不采用 |
| 200 | 163.0ms | 5 | 不采用 |

进化搜索的 Pareto 前沿包含 50/75/100/125/150/200/225/250ms 等解；按“延迟权重 2.0、唤醒权重 1.5、稳定性权重 10”的平衡解为 **75ms**（`bench/results/evolution-relay.json` 的 `balanced`）。

已固化到 `src/mcp/tuning.mjs`：

```js
watchPollMs: 75,
watchTimeoutSec: 20,
statusPollMs: 100,
pushBaseDeadlineMs: 12000,
pushPerOpMs: 50,        // 100 条批次额外 5s 预算，减少误超时
httpRequestTimeoutMs: 30000,
httpKeepAliveTimeoutMs: 5000,
bodyLimitBytes: 10MB,   // 不采用搜索建议的 16MB：内存风险 > 性能收益
```

### 3.1 OpenEvolve 真实 LLM 进化（交叉验证）

- 引擎：OpenEvolve，LLM 为 `deepseek-chat`（OpenAI 兼容）
- 运行：12 轮上限，实际 9 次 LLM 调用（11,269 tokens），9 个候选程序真实评估
- 结果：最优仍是 seed 的 75ms 配置，`combined_score=98.1993`
- LLM 提议的 50ms/60ms 变体得分 97.68–98.15，均低于 75ms
- 证据：`bench/results/openevolve-final.json`（历史运行目录已归档到 `archives/experiments/ppt-bridge-openevolve/runs/`；后续运行仍输出到 `bench/openevolve/runs/`，已 gitignore）

### 3.2 Google 官方客户端闭环（本地 shim）

- 引擎：`Google-Cloud-AI/alphaevolve-on-googlecloud` 的官方
  `AlphaEvolveClient` + `run_controller_loop` + Sampling/Evaluation workers
- 运行：4 个候选真实评估（官方 controller/worker 闭环）
- 结果：最优是 **75ms** 配置，`combined_score` 约 98.17–98.21（多次运行）
- 说明：本机无 GCP 凭据，`local_service.py` 替代 Discovery Engine 托管端；
  接上 GCP 后只需改 `base_url`/credentials，评估器不变
- 证据：`bench/results/google-alpha-evolve-local.json`

三条路径（官方 client、OpenEvolve、NSGA-II）全部收敛到 75ms。

## 4. state/persistence 结果

| journalMaxBytes | ms/batch | stateBytes | journalBytes | 恢复失败 |
|---:|---:|---:|---:|---:|
| 256KB | 4.51 | 615 | 15051 | 0 |
| 512KB | 4.46 | 615 | 15047 | 0 |
| 1MB | 4.51 | 615 | 15050 | 0 |
| 2MB（默认） | 5.99* | 615 | 15046 | 0 |
| 4MB | 4.31 | 613 | 15051 | 0 |
| 8MB | 4.22 | 615 | 15052 | 0 |

\* 首个评估含冷启动；同一配置复测在 4.2–4.6ms 区间。

结论：journal 轮转阈值在 256KB–8MB 之间对吞吐/恢复没有显著影响，**保留 2MB**（更小的磁盘占用、更可控的单文件大小），不为一个噪声级差异改默认值。

真正有效的持久化优化不是调参，而是消除写放大：

- `applyServer` 成功后清空整批 `cmds`：小批次 state 615B vs 1094B（-44%），最坏 8MB 批次每次省 8MB 写入；
- `taskStatus` 只列一次 checkpoint，避免两次全量 `JSON.parse`；
- journal 轮转后 `journalTail` 跨 `.1` 读取，轮转不再丢最近历史；
- state 损坏时隔离原文件并从最新 checkpoint 恢复，不再静默清空。

## 5. 稳定性加固清单（与进化并行落地）

| 级别 | 修复 | 位置 | 回归测试 |
|---|---|---|---|
| P0 | 畸形请求行不再打崩宿主进程 | `packages/dsh-service-host/src/index.mjs` | `stability.test.mjs` 畸形请求 |
| P0 | 并发 push 串行化 + `applyServer` seq 守卫 | `server/routes/bridge.mjs`, `server/store/index.mjs` | 并发 8 批 push |
| P1 | 单实例锁原子创建 + token 释放 | `dsh-service-host`, `dsh-plugin-kit/util/fs-lock` | 同 hostDir 并发启动 |
| P1 | BODY_TOO_LARGE 返回 413 而非连接重置 | `dsh-plugin-kit/service/http.mjs` | 11MB body |
| P1 | 跨源写请求 403（仅放行 loopback 页面） | `dsh-service-host/src/index.mjs` | 跨源 POST 用例 |
| P1 | `/assets` basePath 修复，`ppt_image` 不再 404 | `server/relay.mjs`, `dsh-asset-service` | basePath 上传/读取 |
| P1 | state 损坏隔离 + checkpoint 回退 | `dsh-state-service`, `server/store` | 坏 JSON 恢复 |
| P1 | BlobStore sha256 复核 | `dsh-plugin-kit/store/blob-store.mjs` | 现有 store 测试 |
| P1 | 文件锁 token/空锁/活进程不抢占 | `dsh-plugin-kit/util/fs-lock.mjs` | workspace 测试 |
| P1 | bridge-client 超时 + 响应 16MB 上限 | `src/mcp/bridge-client.mjs` | 工具超时路径 |
| P2 | watch abort 后 Promise settle | `server/runtime/watch.mjs` | abort 用例 |
| P2 | checkpoint 标记 pending，避免误判完整快照 | `server/store/checkpoints.mjs` | store 测试 |
| P2 | `ppt_slide` 缺 index/越界显式报错 | `src/mcp/tools/capabilities/slide.mjs` | 参数校验 |
| P2 | `ppt_image` 远程流式限 6MB、未知格式拒绝 | `src/mcp/tools/capabilities/image.mjs` | 图片校验 |
| P2 | `ppt_shim.load` 恢复 theme/viewport | `src/mcp/ppt-shim.mjs` | theme 断言 |
| P1 | `stripPatchRows` 只删指定 entry | `dsh-suite-kit/src/profile.mjs` | suite 迁移用例 |
| P1 | junction 下 components 按真实目录解析 | `dsh-suite-kit/src/manifest.mjs` | junction 用例 |
| P2 | 非法 semver / 缺失包路径 / 重复端口校验 | `dsh-suite-kit` | manifest 用例 |
| P2 | `pptmaster-*` 不再注入工具契约提示 | `dsh-plugin-skills` + kit provider | skills 用例 |

## 6. 稳定性前后对比（审计复现 → 回归测试）

| 场景 | 加固前（审计复现） | 加固后（本仓回归） |
|---|---|---|
| 畸形请求行 `GET http://[` | 宿主进程 unhandledRejection 退出 | `/healthz` 仍 200；`stability.test.mjs` |
| 同 hostDir 并发启动 | 两个实例同时运行，共享 state | 只允许一个；另一个明确报错 |
| 8 个并发 push | deck 混合、applied_seq 错标 | 全部 200，12 页一致，seq=8 |
| `ppt_image`（workspace 资产） | `POST …/assets` 404 | basePath 上传 200，根/前缀都可读 |
| state.json 截断 | 静默当空库并覆盖 | 隔离 + 从最新 checkpoint 恢复 |
| 客户端断开 watch | Promise 永不 settle | 立即 resolve(null) |
| 超大 body | 连接重置 | 413 + JSON 错误 |
| 工具能力配置错误 | 僵尸端口 + 残留锁 | 启动失败自动 close/清锁/清 discovery |

## 7. 验证

```bash
cd bridges/ppt-bridge
npm run build:plugin
npm test                 # 106 tests, 105 pass, 1 skipped（editor 资产缺失时跳过）
npm run bench:modules    # 全模块基线
npm run evolve           # 确定性 NSGA-II 搜索，输出 bench/results/evolution-*.json
npm run evolve:openevolve # OpenEvolve + DeepSeek 真实 LLM 进化（需先按 bench/openevolve/README.md 安装）
npm run acceptance        # 严格验收：模块覆盖/构建快照/进化产物/口径
```

全工作区标准验证：

```bash
node scripts/verify-standard.mjs
```

结果：workspace links、8 个公共插件、suite/domain 元数据、PPT suite/domain 全部通过。

## 8. 产物

- `bench/evolution/core.mjs`：NSGA-II 进化引擎
- `bench/evolution/genomes.mjs`：模块基因组与权重
- `bench/evolution/evaluators.mjs`：真实 relay/store 评估器
- `bench/evolution/cli.mjs`：CLI
- `bench/openevolve/`：OpenEvolve seed / evaluator / config / 运行产物
- `bench/google-alpha-evolve/`：官方 `alpha_evolve` 客户端 + 本地 Discovery Engine shim
- `bench/results/google-alpha-evolve-local.json`：官方客户端闭环结果
- `bench/results/openevolve-final.json`：OpenEvolve 最优解摘要
- `bench/module-baseline.mjs`：8 模块基线
- `bench/results/module-baseline.json`
- `bench/results/evolution-relay.json`
- `bench/results/evolution-store.json`
- `bench/results/evolution-run.log`
