"""用 Google 官方 alpha_evolve 客户端跑本地离线闭环。

本机没有 GCP 凭据，因此把官方 client 的 base_url 指向 `local_service.py` 的
Discovery Engine 兼容 shim；controller / worker / experiment 代码均来自
Google-Cloud-AI/alphaevolve-on-googlecloud（Apache-2.0）。
"""

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

from alpha_evolve.client import AlphaEvolveClient  # noqa: E402
from alpha_evolve.controller import run_controller_loop  # noqa: E402
from alpha_evolve.experiment import AlphaEvolveExperiment  # noqa: E402
from local_service import STATE, start_server  # noqa: E402

MARKER = "__AE_RESULT__"


def evaluate_program(program):
    code = program["content"]["files"][0]["content"]
    namespace = {}
    exec(code, namespace)  # noqa: S102 - local experiment sandbox
    tuning = namespace["get_tuning"]()
    completed = subprocess.run(
        ["node", str(ROOT / "bench" / "openevolve" / "evaluate.mjs"), json.dumps(tuning)],
        cwd=str(ROOT), capture_output=True, text=True, timeout=120,
    )
    line = ""
    for candidate in (completed.stdout or "").splitlines():
        if candidate.startswith(MARKER):
            line = candidate[len(MARKER):]
    if not line:
        return {"scores": {"scores": [{"metric": "combined_score", "score": 0.0}]},
                "insights": (completed.stderr or completed.stdout or "no result")[-800:]}
    payload = json.loads(line)
    if not payload.get("ok"):
        return {"scores": {"scores": [{"metric": "combined_score", "score": 0.0}]},
                "insights": str(payload.get("error", "evaluation failed"))[:800]}
    obj = payload.get("objectives", {})
    latency = float(obj.get("watchLatencyMs", 999))
    wakeups = float(obj.get("watchWakeupsPerSec", 999))
    push = float(obj.get("pushP95Ms", 999))
    status = float(obj.get("p95StatusMs", 999))
    failures = float(obj.get("stabilityFailures", 9))
    score = 0.0 if failures > 0 else 100.0 - (
        2.0 * latency / 100.0 + 1.5 * wakeups / 20.0 + 0.3 * push / 50.0 + 0.3 * status / 5.0
    )
    return {
        "scores": {"scores": [
            {"metric": "combined_score", "score": round(score, 4)},
            {"metric": "watch_latency_ms", "score": latency},
            {"metric": "watch_wakeups_per_sec", "score": wakeups},
            {"metric": "push_p95_ms", "score": push},
            {"metric": "status_p95_ms", "score": status},
            {"metric": "stability_failures", "score": failures},
        ]},
        "insights": json.dumps({"genome": payload.get("genome", {}), "objectives": obj}),
    }


def main():
    logging.basicConfig(level=logging.INFO)
    server, port = start_server()
    try:
        client = AlphaEvolveClient(
            project_id="local-project", location="global", collection="default_collection",
            engine="local-engine", assistant="default_assistant",
            base_url="http://127.0.0.1",
        )
        # __init__ 会把非 https 的 base_url 补成 https://；这里改回本地 http。
        client.base_url = f"http://127.0.0.1:{port}"
        # 本地 shim 不需要 GCP bearer token。
        client._get_headers = lambda: {"Content-Type": "application/json"}

        experiment = AlphaEvolveExperiment(client, evaluate_program, 4, parallel_evaluation=False)
        experiment.create_experiment({
            "title": "PPT workbench tuning",
            "problem_description": "Evolve watch/push runtime tuning for lower latency and CPU.",
            "program_language": "python",
            "run_settings": {"max_programs": 4, "concurrency": 1},
            "generation_settings": {"models": [{"name": "local", "weight": 1.0}]},
        })
        experiment.create_initial_program({
            "content": {"files": [{"path": "program.py", "content": (HERE.parent / "openevolve" / "seed.py").read_text(encoding="utf-8")}]},
            "evaluation": {"scores": {"scores": [{"metric": "combined_score", "score": -1e12}]}},
        })
        experiment.start_experiment()
        asyncio.run(run_controller_loop(experiment, num_samplers=1, num_evaluators=1, idle_timeout_s=8))

        best = STATE.best
        result = {
            "engine": "Google-Cloud-AI/alphaevolve-on-googlecloud official client (local Discovery Engine shim)",
            "backend": "local-shim (no GCP credentials)",
            "evaluated": experiment.stats.get("num_programs_evaluated", 0),
            "generated": experiment.stats.get("num_programs_generated", 0),
            "best": None if not best else {
                "score": best[0],
                "program": best[1],
            },
        }
        out = ROOT / "bench" / "results" / "google-alpha-evolve-local.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"evaluated": result["evaluated"], "bestScore": result["best"]["score"] if result["best"] else None}, ensure_ascii=False))
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
