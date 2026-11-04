# OpenEvolve 实验（AlphaEvolve 开源实现）

本目录用 **OpenEvolve**（`algorithmicsuperintelligence/openevolve`，AlphaEvolve 的开源实现）
对 PPT workbench 的运行时调优参数做一次真实的 LLM 进化搜索。评估器调用本仓
`bench/evolution/evaluators.mjs`，真实启动 relay 并跑 status/push/watch 基准。

## 为什么不是 Google 官方客户端

Google Cloud 官方仓库 `Google-Cloud-AI/alphaevolve-on-googlecloud` 已开源（2026-07），
但它是 **GCP 托管 AlphaEvolve 服务的客户端**，运行需要：

- GCP 项目 + AlphaEvolve/Gemini Enterprise 已开通
- `PROJECT_ID` / `GE_APP_ID`
- `gcloud auth application-default login`

本机没有上述凭据，因此使用 OpenEvolve（同算法家族的开源实现）跑本地进化搜索；
结果与自研 NSGA-II 交叉验证。若后续提供 GCP 凭据，可按官方仓库直接替换本目录的
`openevolve-run` 为官方 `alpha_evolve` controller。

## 安装

```bash
cd bridges/ppt-bridge
uv venv .tools/openevolve-venv
uv pip install --python .tools/openevolve-venv/Scripts/python.exe openevolve
```

## 运行

OpenEvolve 支持任意 OpenAI 兼容端点；这里用 DeepSeek：

```bash
# 配置读取 llm.api_key: ${DEEPSEEK_API_KEY}
.tools/openevolve-venv/Scripts/openevolve-run.exe \
  bench/openevolve/seed.py bench/openevolve/evaluator.py \
  --config bench/openevolve/config.yaml \
  --iterations 12 \
  --output bench/openevolve/runs/openevolve-final
```

实际运行结果：9 次 LLM 调用（11,269 tokens），9 轮候选评估，最优解仍是 seed 的
75ms 配置，`combined_score=98.1993`；说明 75ms 是当前评分函数下的稳定最优，
LLM 提出的 50ms/60ms 变体在“唤醒次数 vs 更新延迟”权衡中得分更低。

结果摘要见 `bench/results/openevolve-final.json`。

## 文件

- `seed.py`：候选参数（只允许改 EVOLVE-BLOCK 内的 TUNING）
- `evaluator.py`：加载候选、调用 Node 真实基准、折算 combined_score
- `evaluate.mjs`：Node 侧 relay 基准入口
- `config.yaml`：OpenEvolve + DeepSeek 配置
