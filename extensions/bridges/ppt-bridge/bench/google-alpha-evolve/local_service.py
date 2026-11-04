"""官方 AlphaEvolve 客户端的本地离线服务端（Discovery Engine 兼容 shim）。

用途：在无 GCP 凭据的机器上跑通 Google 官方 `alpha_evolve` 的 controller/worker
闭环。生成端不是 Gemini，而是本文件内置的候选队列（用于回归官方客户端集成）。
真实托管服务请使用 `backend=google-cloud`，见 README。
"""

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SEED_CODE = '''"""PPT workbench tuning candidate."""
# EVOLVE-BLOCK-START
TUNING = {
    "watch_poll_ms": 75,
    "watch_timeout_sec": 20,
    "status_poll_ms": 100,
    "push_base_deadline_ms": 12000,
    "push_per_op_ms": 50,
    "http_keep_alive_timeout_ms": 5000,
    "http_request_timeout_ms": 30000,
    "body_limit_mb": 10,
}
# EVOLVE-BLOCK-END


def get_tuning():
    return dict(TUNING)
'''

CANDIDATES = [
    {"watch_poll_ms": 50, "watch_timeout_sec": 20, "status_poll_ms": 100,
     "push_base_deadline_ms": 12000, "push_per_op_ms": 50,
     "http_keep_alive_timeout_ms": 5000, "http_request_timeout_ms": 30000, "body_limit_mb": 8},
    {"watch_poll_ms": 100, "watch_timeout_sec": 20, "status_poll_ms": 100,
     "push_base_deadline_ms": 12000, "push_per_op_ms": 50,
     "http_keep_alive_timeout_ms": 5000, "http_request_timeout_ms": 30000, "body_limit_mb": 10},
    {"watch_poll_ms": 60, "watch_timeout_sec": 18, "status_poll_ms": 90,
     "push_base_deadline_ms": 11000, "push_per_op_ms": 45,
     "http_keep_alive_timeout_ms": 6000, "http_request_timeout_ms": 28000, "body_limit_mb": 8},
    {"watch_poll_ms": 75, "watch_timeout_sec": 20, "status_poll_ms": 100,
     "push_base_deadline_ms": 12000, "push_per_op_ms": 50,
     "http_keep_alive_timeout_ms": 5000, "http_request_timeout_ms": 30000, "body_limit_mb": 10},
]


def render_program(tuning):
    body = ",\n".join(f'    "{key}": {value}' for key, value in tuning.items())
    code = f'TUNING = {{\n{body},\n}}'
    return re.sub(r"TUNING = \{[^}]*\}", code, SEED_CODE, count=1)


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.queue = []
        self.programs = []
        self.best = None
        self.next_id = 0
        self.enqueued = False

    def enqueue_candidates(self):
        if self.enqueued or self.queue:
            return
        self.enqueued = True
        for tuning in CANDIDATES:
            self.next_id += 1
            self.queue.append({
                "name": f"experiments/local/alphaEvolvePrograms/p{self.next_id}",
                "lockToken": f"lock-{self.next_id}",
                "content": {"files": [{"path": "program.py", "content": render_program(tuning)}]},
                "evaluation": {"scores": {"scores": [{"metric": "combined_score", "score": -1e12}]}},
            })

    def acquire(self, count):
        with self.lock:
            self.enqueue_candidates()
            out = self.queue[: max(1, count)]
            del self.queue[: len(out)]
            self.programs.extend(out)
            return out

    def submit(self, submissions):
        with self.lock:
            for item in submissions or []:
                name = item.get("program")
                evaluation = item.get("evaluation", {})
                program = next((p for p in self.programs if p["name"] == name), None)
                if not program:
                    continue
                program["evaluation"] = evaluation
                scores = evaluation.get("scores", {}).get("scores", [])
                value = next((float(s["score"]) for s in scores if s.get("metric") == "combined_score"), 0.0)
                if self.best is None or value > self.best[0]:
                    self.best = (value, program)
            return {"ok": True}

    def register(self, program):
        with self.lock:
            self.programs.append(program)


STATE = State()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, payload, code=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("content-length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_POST(self):
        path = self.path
        body = self._body()
        if path.endswith(":streamAssist"):
            return self._send([{"sessionInfo": {"session": "sessions/local"}}])
        if path.endswith("alphaEvolveExperiments"):
            return self._send({"name": "experiments/local"})
        if path.endswith("alphaEvolvePrograms"):
            program = body if body.get("content") else {}
            if program:
                program.setdefault("name", "experiments/local/alphaEvolvePrograms/initial")
                STATE.register(program)
            return self._send(program or {"name": "experiments/local/alphaEvolvePrograms/initial"})
        if path.endswith(":start") or path.endswith(":resume"):
            return self._send({"name": "experiments/local", "state": "RUNNING"})
        if path.endswith(":acquirePrograms"):
            return self._send({"programs": STATE.acquire(int(body.get("desired_programs_count") or 1))})
        if path.endswith(":submitProgramsEvaluations"):
            return self._send(STATE.submit(body.get("evaluation_submissions") or []))
        return self._send({})

    def do_GET(self):
        if "alphaEvolvePrograms" in self.path:
            with STATE.lock:
                return self._send({"alphaEvolvePrograms": list(STATE.programs)})
        if "alphaEvolveExperiments" in self.path:
            return self._send({"alphaEvolveExperiments": [{"name": "experiments/local"}]})
        return self._send({"name": "experiments/local", "state": "RUNNING"})


def start_server(host="127.0.0.1", port=0):
    server = ThreadingHTTPServer((host, port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_address[1]
