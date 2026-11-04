# Google 官方 AlphaEvolve 客户端（可选）

官方仓库：[`Google-Cloud-AI/alphaevolve-on-googlecloud`](https://github.com/Google-Cloud-AI/alphaevolve-on-googlecloud)
（Apache-2.0，2026-07 开源）。

它是 **GCP 托管 AlphaEvolve 服务的客户端库 + 示例**，不是本地可独立运行的算法实现。
运行前提：

1. GCP 项目已开通 AlphaEvolve / Gemini Enterprise；
2. 有 `PROJECT_ID` 与 `GE_APP_ID`；
3. 本机安装 `gcloud` 并执行 `gcloud auth application-default login`；
4. Python 3.9+、`uv`。

## 用官方客户端跑本仓实验

官方库的 evaluator 接收一个程序文件并返回 `scores`。本仓 `bench/openevolve/`
的 seed/evaluator 已经按这个接口拆好：

```bash
# 1) 安装官方客户端（从官方仓库 src/）
git clone https://github.com/Google-Cloud-AI/alphaevolve-on-googlecloud.git
cd alphaevolve-on-googlecloud
uv pip install -e ".[examples]"

# 2) 用官方 controller 指向本仓 evaluator
#    需要按官方 examples/*/run_evolution.py 填 PROJECT_ID / GE_APP_ID
python -c "from alpha_evolve.controller import run_controller_loop; print('ready')"
```

本机没有 GCP 凭据，所以当前结果使用两条本地路径：官方客户端 + 本地 Discovery Engine
shim（`run_local_harness.py`），以及同算法家族的开源实现 **OpenEvolve**
（见 `bench/openevolve/`）。两者共用同一套真实评估器；拿到凭据后只需替换 controller。

## 本机离线闭环（无 GCP 凭据）

本目录已 vendoring 官方 `alpha_evolve` 的 client/controller/experiment/workers
（Apache-2.0，文件头保留 Google 版权）。`run_local_harness.py` 把官方 client 指向
`local_service.py` 的 Discovery Engine 兼容 shim，从而在无 GCP 凭据时也能跑通
**官方 controller + worker + evaluator** 闭环：

```bash
.tools/openevolve-venv/Scripts/python.exe bench/google-alpha-evolve/run_local_harness.py
```

- `local_service.py`：模拟 session/experiment/acquirePrograms/submitProgramsEvaluations；
- 候选生成是本地候选队列（不是 Gemini），用于验证官方客户端集成与评估闭环；
- 真实 Gemini 生成仍需 `google-cloud` 模式（见上节）。

最近一次离线闭环结果见 `bench/results/google-alpha-evolve-local.json`。

## 为什么不在本仓直接引入官方 Python 包

官方 `alpha_evolve` 依赖 `google.auth` 与 Discovery Engine API，安装会引入 GCP 运行时；
本仓的 Node 测试/打包不应依赖云 SDK。因此官方客户端作为**可选实验路径**，不进入
`package.json` 的默认依赖。
