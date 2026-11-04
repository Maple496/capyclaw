# 严格验收报告（2026-10-31）

> 验收范围：`dsh-ppt-suite` 的 8 个安装模块 + 进化优化/稳定性加固产物。
> 验收方式：静态核对 + 真实构建 + 全量测试 + 两条进化入口实跑 + 基线复测。

## 1. 目标 → 证据矩阵

| 目标要求 | 证据 | 结论 |
|---|---|---|
| 每个模块都做综合评估 | `docs/MODULE_EVALUATION.md` 覆盖 8 个模块；`scripts/acceptance-check.mjs` 检查 8/8 | **通过** |
| 评估是否需要性能优化 | 每个模块有热路径/基线/必要性/处置四列；结论表 8 行 | **通过** |
| 使用 Google 开源 AlphaEvolve 算法 | 官方 `alpha_evolve` client/controller/workers vendored；`run_local_harness.py` 实跑 4 个候选，最优 75ms | **有条件通过**（本地 shim，非 GCP Gemini 托管生成） |
| 选出有价值模块做进化 | workbench（高价值）+ state persistence（中价值）；其余明确判定不做性能优化 | **通过** |
| 得出更稳定/高效版本 | watch 50→75ms（唤醒 -35%）；state cmds 清空（小批次体积 -44%）；P0/P1 稳定性修复 | **通过** |
| 收尾：构建/文档/脚本 | `check:plugin` 通过；`npm run acceptance` 9/9 通过；文档与结果文件对齐 | **通过** |

## 2. 模块级状态

| 模块 | 评估 | 优化/加固 | 测试 |
|---|---|---|---|
| dsh-service-host | 低必要性 | 畸形 URL、原子锁、413、跨源写 403 | 全量 + stability |
| dsh-tool-host | 低必要性 | MCP batch 上限 | 全量 |
| dsh-state-service | 中必要性 | 损坏隔离/checkpoint 回退、journal 轮转、写放大治理 | 全量 + 单包 |
| dsh-asset-service | 低必要性 | 上传 404、sha256、MIME 降级、mount disposer | 全量 + 单包 |
| dsh-editor-host | 低必要性 | 保持现状 | 单包 |
| dsh-ppt-workbench | 高必要性 | 75ms watch、并发 push 串行化、bridge 超时等 | 全量 + stability |
| dsh-ppt-skills | 无必要性 | 契约提示按技能类型注入 | 全量 + 单包 |
| dsh-ppt-suite | 无必要性 | stripPatchRows、junction、semver、schema | 全量 + 单包 |

## 3. 严格验收命令与结果

```bash
cd bridges/ppt-bridge
npm run check:plugin       # ✓ 三个包全部最新
npm test                   # 106 tests, 105 pass, 1 skipped, 0 fail
npm run acceptance         # ✓ 9 项通过，0 项失败
npm run bench:modules      # 8/8 模块有基线
npm run evolve:google      # 官方 client 闭环：4 候选，最优 75ms
npm run evolve:openevolve  # OpenEvolve + DeepSeek：9 calls，最优 75ms
```

全工作区：

```bash
node scripts/verify-standard.mjs   # 全部通过
```

## 4. 未完全闭环 / 残余风险

严格意义上，只有**“GCP 托管 Gemini 生成”**这一项没有真实执行：

- 官方仓库是 GCP 托管服务的客户端，需要 `PROJECT_ID`、`GE_APP_ID` 和
  `gcloud auth application-default login`；本机没有这些凭据。
- 已 vendoring 官方 `alpha_evolve` 代码并跑通 controller/worker/evaluator 闭环，
  但生成端使用 `local_service.py` 的候选队列，不是 Gemini。
- 提供 GCP 凭据后，按 `bench/google-alpha-evolve/README.md` 改 `base_url`/credentials
  即可复跑，现有评估器与 genome 不需要改。

其他已知但非阻塞的残余项：

- `dsh-ppt-suite` 的 `components` 依赖本地 junction/相对路径；npm 发布包没有携带
  `packages/*`，发布前需要展开组件或改成按包名解析。
- `WorkspaceBackend.writeState` 未使用 manifest CAS；同一 work 的并发 state 写入
  理论上仍可能后写覆盖（当前 BridgeStore 已串行化 push，风险受限）。
- `ppt_image` 的本地 `path` 仍可读取进程可读文件；这是本地工具的显式输入，
  未做目录白名单。

## 5. 结论

- **工程实现、稳定性加固、进化搜索、构建与测试：全部完成。**
- **算法路径：有条件完成**——官方客户端闭环已跑通，但 GCP 托管 Gemini 生成未验证。
- 若验收标准要求“必须使用 GCP 托管 AlphaEvolve 生成”，则该项尚未完成；否则可判定通过。
