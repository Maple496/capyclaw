"""OpenEvolve evaluator：把候选 TUNING 交给真实 relay 基准并折算成单一分数。"""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("NODE_BIN", "node")
EVALUATOR = ROOT / "bench" / "openevolve" / "evaluate.mjs"
MARKER = "__AE_RESULT__"


def _load_tuning(program_path: str) -> dict:
    spec = importlib.util.spec_from_file_location("ae_candidate", program_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tuning = module.get_tuning()
    if not isinstance(tuning, dict):
        raise ValueError("get_tuning() 必须返回 dict")
    return tuning


def evaluate(program_path: str):
    try:
        tuning = _load_tuning(program_path)
        completed = subprocess.run(
            [NODE, str(EVALUATOR), json.dumps(tuning)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=120,
        )
        line = ""
        for candidate in (completed.stdout or "").splitlines():
            if candidate.startswith(MARKER):
                line = candidate[len(MARKER):]
        if not line:
            return {
                "combined_score": 0.0,
                "error": (completed.stderr or completed.stdout or "no result")[-1200:],
            }
        payload = json.loads(line)
        if not payload.get("ok"):
            return {"combined_score": 0.0, "error": str(payload.get("error", "evaluation failed"))[:1200]}
        objectives = payload.get("objectives", {})
        latency = float(objectives.get("watchLatencyMs", 999))
        wakeups = float(objectives.get("watchWakeupsPerSec", 999))
        push = float(objectives.get("pushP95Ms", 999))
        status = float(objectives.get("p95StatusMs", 999))
        failures = float(objectives.get("stabilityFailures", 9))
        if failures > 0:
            score = 0.0
        else:
            score = 100.0 - (
                2.0 * latency / 100.0
                + 1.5 * wakeups / 20.0
                + 0.3 * push / 50.0
                + 0.3 * status / 5.0
            )
        return {
            "combined_score": round(score, 4),
            "watch_latency_ms": latency,
            "watch_wakeups_per_sec": wakeups,
            "push_p95_ms": push,
            "status_p95_ms": status,
            "stability_failures": failures,
            "genome": payload.get("genome", {}),
        }
    except Exception as error:  # noqa: BLE001 - evaluator must never crash the run
        return {"combined_score": 0.0, "error": f"{type(error).__name__}: {error}"[:1200]}


if __name__ == "__main__":
    print(json.dumps(evaluate(sys.argv[1]), ensure_ascii=False, indent=2))
