"""PPT Bridge 插件（自包含单文件，2026-10-27 主站接口化批外置）

真源 = ppt-bridge 仓 desktop-plugin/ppt_bridge.py；`npm run build` 投递到
桌面主仓 backend/bridges.d/ppt_bridge.py（投递层，gitignore），由主仓
Bridge Framework 扫描装载（bridges/__init__.py 的 register 契约）。

契约来源（不是猜的）：
  - 桥仓 HTTP 契约测试（test/plugin.test.mjs 同口径）
  - 编辑器消费方 ppt-bridge/src/editor/main.js（watch 读 doc.seq / doc.cmds /
    doc.shot_req / doc.deck；pushState 发 {deck, seq}）
  - 历史契约 = 主仓 git 历史里的 sanitize.py _ppt_bridge_* 纯函数（已随
    本文件内联，主仓不再持有桥私有校验）

关键约定（勿「优化」成信封结构）：
  1. 主文档全量返回：GET / POST / watch / ack / state / shot-* 都回完整 doc
     （编辑器直接 doc.cmds 遍历、doc.deck 加载，信封会直接崩）
  2. push = 整队替换 + seq 自增 + 回执字段清零
  3. ack 只对当前 seq 生效；过期 seq 原样返回现文档（不落脏）
  4. shot-result 只对当前 shot_req 生效；过期原样返回
  5. claim 是租约（默认 15s）：同租约期内第二个窗口拿不到所有权
  6. watch 支持 ?timeout=N（编辑器传 3 秒），超时返回当前文档
  7. 已知路径的错误方法回 405（不是 404，也不落代理）
"""
from __future__ import annotations
import json
import os
import re
import time

from bridges.framework import BaseBridge, BridgeConfig, registry
from bridges.monitoring import MonitoredBridgeMixin

# ============================================================================
# 入参白名单（自 sanitize.py _ppt_bridge_* 内联；畸形 = None → 400）
# ============================================================================

_MAX_CMDS = 100                  # 单队指令条数上限
_MAX_TOTAL = 8 * 1024 * 1024     # 单队总量上限（字节）


def _sanitize_push(body) -> dict | None:
    """入队白名单：cmds = 非空指令数组（每条必须 JSON 对象，总量设上限），
    title 可选短串。"""
    if not isinstance(body, dict):
        return None
    cmds = body.get("cmds")
    if not (isinstance(cmds, list) and 0 < len(cmds) <= _MAX_CMDS):
        return None
    total = 0
    for c in cmds:
        if not isinstance(c, dict):
            return None
        total += len(json.dumps(c, ensure_ascii=False))
        if total > _MAX_TOTAL:
            return None
    title = body.get("title")
    if title is not None and (not isinstance(title, str) or len(title) > 120):
        return None
    return {"cmds": cmds, "title": title or ""}


def _sanitize_ack(body) -> dict | None:
    """回执白名单：{seq, applied, error?}，前两者非负整数（bool 冒充整数
    拒绝），error 可选短串。"""
    if not isinstance(body, dict):
        return None
    out: dict = {}
    for field in ("seq", "applied"):
        v = body.get(field)
        if not (isinstance(v, int) and not isinstance(v, bool) and v >= 0):
            return None
        out[field] = v
    err = body.get("error")
    if err is not None and (not isinstance(err, str) or len(err) > 2000):
        return None
    out["error"] = err or ""
    return out


def _sanitize_state(body) -> dict | None:
    """状态镜像白名单（导演台 → agent 的可见面）：{deck} 必须是 JSON 对象、
    总量 ≤8MB（deck 全量，含 slides/elements）。"""
    if not isinstance(body, dict):
        return None
    deck = body.get("deck")
    if not isinstance(deck, dict) or len(json.dumps(deck, ensure_ascii=False)) > _MAX_TOTAL:
        return None
    seq = body.get("seq")
    if seq is not None and (not isinstance(seq, int) or isinstance(seq, bool) or seq < 0):
        return None
    return {"deck": deck, "seq": seq}


def _sanitize_shot_result(body) -> dict | None:
    """截图回传白名单：{req: 非负整数, data: data:image/jpeg;base64,… ≤4MB}。"""
    if not isinstance(body, dict):
        return None
    req = body.get("req")
    data = body.get("data")
    if not (isinstance(req, int) and not isinstance(req, bool) and req >= 0):
        return None
    if not isinstance(data, str) or len(data) > 4 * 1024 * 1024:
        return None
    if data and not data.startswith("data:image/"):
        return None
    return {"req": req, "data": data}


def _sanitize_claim(body) -> dict | None:
    """编辑器所有权声明：{id: 1-64 字符串}。"""
    if not isinstance(body, dict):
        return None
    oid = body.get("id")
    if not isinstance(oid, str) or not (1 <= len(oid) <= 64):
        return None
    return {"id": oid}


# ============================================================================
# 批量操作（自 ppt_batch_ops.py 内联——Agent 高层次操作，减少 token/指令数）
# ============================================================================

def get_deck_summary(deck: dict) -> dict:
    """deck 摘要（Agent 快速决策用，不含完整元素列表）。"""
    slides = deck.get('slides', [])
    summary = {
        'slide_count': len(slides),
        'backgrounds': [],
        'structure': [],
        'has_images': False,
        'total_elements': 0,
    }
    for slide in slides:
        bg = slide.get('background', {})
        if bg.get('type') == 'solid':
            summary['backgrounds'].append(bg.get('color', '#ffffff'))
        else:
            summary['backgrounds'].append(f"[{bg.get('type', 'unknown')}]")
        elements = slide.get('elements', [])
        summary['total_elements'] += len(elements)
        text_elements = [e for e in elements if e.get('type') == 'text']
        if len(text_elements) <= 2:
            summary['structure'].append('cover')
        elif len(text_elements) <= 4:
            summary['structure'].append('section')
        else:
            summary['structure'].append('content')
        if any(e.get('type') == 'image' for e in elements):
            summary['has_images'] = True
    return summary


def _contrast_color(bg_color: str) -> str:
    """根据背景色计算对比文字颜色（深色或浅色）。"""
    m = re.match(r'#([0-9a-fA-F]{6})', bg_color.strip())
    if m:
        h = m.group(1)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    else:
        r, g, b = 255, 255, 255
    luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    return '#1f2d3d' if luminance > 0.6 else '#ffffff'


def set_all_backgrounds(deck: dict, color: str, adjust_text: bool = True) -> list:
    """批量设置所有背景色（生成指令列表，可直接入队）。"""
    cmds = []
    for slide in deck.get('slides', []):
        slide_id = slide.get('id')
        if not slide_id:
            continue
        cmds.append({'op': 'set-background', 'id': slide_id, 'color': color})
        if adjust_text:
            text_color = _contrast_color(color)
            for elem in slide.get('elements', []):
                if elem.get('type') == 'text':
                    cmds.append({'op': 'set-element', 'id': elem.get('id'),
                                 'defaultColor': text_color})
    return cmds


def set_all_text_colors(deck: dict, color: str) -> list:
    """批量设置所有文字颜色。"""
    cmds = []
    for slide in deck.get('slides', []):
        for elem in slide.get('elements', []):
            if elem.get('type') == 'text':
                cmds.append({'op': 'set-element', 'id': elem.get('id'),
                             'defaultColor': color})
    return cmds


# ============================================================================
# 桥本体
# ============================================================================

# 桥文档零位空态（与 data_local.ppt_bridge_load 的默认形状一致）
_DEFAULT_DOC = {
    "seq": 0, "cmds": [], "title": "",
    "applied_seq": 0, "applied": 0, "error": "", "updated": 0,
    "shot_req": 0, "shot": {"req": 0, "data": ""},
    "state_seq": 0,
}

# 编辑器所有权租约（2026-10-22 多窗口裁定：心跳 5s，租约 15s）
OWNER_TTL = 15.0


def _trace(event: str, **kw) -> None:
    """PPT 桥时间线（PPT_BRIDGE_TRACE=1 时启用）：定位 push→state→ack 各段耗时。"""
    if os.environ.get("PPT_BRIDGE_TRACE", "0") != "1":
        return
    try:
        rec = {"t": time.time(), "event": event}
        rec.update(kw)
        with open("ppt_bridge_trace.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


class PPTBridge(MonitoredBridgeMixin, BaseBridge):
    """PPT 中间件（Agent ↔ PPTist 编辑器）"""

    enable_monitoring = True      # 指标采集（/api/bridges/* 监控面消费）
    enable_request_log = False    # 详细请求日志：排查时置 True

    # 主文档零位空态（BridgeStorage 用它深拷贝出默认值）
    default_doc = _DEFAULT_DOC

    @property
    def config(self) -> BridgeConfig:
        return BridgeConfig(
            name="ppt",
            display_name="PPT Bridge",
            enable_push=True,
            enable_watch=True,
            enable_ack=True,
            enable_state=True,
            max_commands=100,
            max_payload_bytes=8 * 1024 * 1024,
            watch_timeout=30.0,
            watch_categories=["cmd", "shot"],
        )

    # ---- 校验（本文件白名单，不另立口径）----

    def validate_push(self, body):
        return _sanitize_push(body) if isinstance(body, dict) else None

    def validate_ack(self, body):
        return _sanitize_ack(body) if isinstance(body, dict) else None

    def validate_state(self, body):
        return _sanitize_state(body) if isinstance(body, dict) else None

    @staticmethod
    def _validate_shot_result(body):
        return _sanitize_shot_result(body) if isinstance(body, dict) else None

    @staticmethod
    def _validate_claim(body):
        return _sanitize_claim(body) if isinstance(body, dict) else None

    # ---- 核心读写（全部返回完整文档）----

    def snapshot(self) -> dict:
        return self.storage.load()

    def push(self, body: dict) -> dict:
        v = self.validate_push(body)
        if v is None:
            raise ValueError("ppt-bridge 数据不合法")

        def updater(doc: dict) -> dict:
            doc.update({
                "seq": int(doc.get("seq") or 0) + 1,
                "cmds": v["cmds"],
                "title": v["title"],
                "applied_seq": 0, "applied": 0, "error": "",   # 回执清零
                "updated": time.time(),
            })
            return doc

        doc = self.storage.atomic_update(updater)
        self.notifier.notify(self.config.name, "cmd")
        _trace("push_out", seq=doc["seq"], cmds=len(doc["cmds"]))
        self.on_push(v, doc)
        return doc

    def ack(self, body: dict) -> dict:
        v = self.validate_ack(body)
        if v is None:
            raise ValueError("ppt-bridge 回执不合法")

        def updater(doc: dict) -> dict:
            # 过期 ack：原样返回，不落脏（编辑器重连后可能补发旧 seq）
            if int(doc.get("seq") or 0) != int(v["seq"]):
                return doc
            doc.update({"applied_seq": v["seq"], "applied": v["applied"],
                        "error": v["error"], "updated": time.time()})
            return doc

        doc = self.storage.atomic_update(updater)
        _trace("ack_in", seq=v["seq"], applied=v["applied"])
        self.on_ack(v, doc)
        return doc

    def state(self, body: dict) -> dict:
        v = self.validate_state(body)
        if v is None:
            raise ValueError("ppt-bridge 状态不合法")

        def updater(doc: dict) -> dict:
            doc["deck"] = v["deck"]
            if v["seq"] is not None:
                doc["state_seq"] = int(v["seq"])
            doc["updated"] = time.time()
            return doc

        doc = self.storage.atomic_update(updater)
        self.notifier.notify(self.config.name, "state")
        _trace("state_in", bytes=len(json.dumps(body, ensure_ascii=False)))
        self.on_state(v)
        return doc

    def watch(self, last_seq: int, last_shot: int, timeout: float | None = None) -> dict:
        """长轮询：seq 或 shot_req 变化即返；超时返回当前文档。

        返回完整文档（编辑器读 doc.seq / doc.cmds / doc.shot_req）。
        timeout 来自 ?timeout=N（秒），编辑器传 3；缺省用 config.watch_timeout。
        """
        budget = self.config.watch_timeout if timeout is None else timeout
        try:
            budget = max(0.1, min(float(budget), 60.0))
        except (TypeError, ValueError):
            budget = self.config.watch_timeout

        deadline = time.monotonic() + budget
        while True:
            doc = self.storage.load()
            if (int(doc.get("seq") or 0) != int(last_seq)
                    or int(doc.get("shot_req") or 0) != int(last_shot)):
                return doc
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return doc
            # 条件变量快路径（进程内 <1ms）；50ms 上限保证多进程部署时
            # push 落在别的进程也能在下一次复核里看见（DB 是唯一真源）。
            self.notifier.wait_for_change(
                self.config.name, self.config.watch_categories, min(remaining, 0.05))

    # ---- 截图 ----

    def shot_request(self) -> dict:
        def updater(doc: dict) -> dict:
            doc["shot_req"] = int(doc.get("shot_req") or 0) + 1
            doc["shot"] = {"req": 0, "data": ""}   # 清旧图，等新图
            doc["updated"] = time.time()
            return doc

        doc = self.storage.atomic_update(updater)
        self.notifier.notify(self.config.name, "shot")
        return doc

    def shot_result(self, body: dict) -> dict:
        v = self._validate_shot_result(body)
        if v is None:
            raise ValueError("截图回传不合法")

        def updater(doc: dict) -> dict:
            # 过期 req：原样返回（并发两轮截图时旧结果不能覆盖新请求）
            if int(doc.get("shot_req") or 0) != int(v["req"]):
                return doc
            doc["shot"] = {"req": v["req"], "data": v["data"]}
            doc["updated"] = time.time()
            return doc

        doc = self.storage.atomic_update(updater)
        self.notifier.notify(self.config.name, "shot")
        return doc

    # ---- 编辑器所有权（租约）----

    def claim(self, body: dict) -> dict:
        v = self._validate_claim(body)
        if v is None:
            raise ValueError("claim 不合法")
        now = time.time()
        outcome: dict = {}

        def updater(doc: dict) -> dict:
            cur = doc.get("owner") or {}
            free = (not cur.get("id")
                    or cur.get("id") == v["id"]
                    or now - float(cur.get("ts") or 0) > OWNER_TTL)
            if free:
                doc["owner"] = {"id": v["id"], "ts": now}
                doc["updated"] = now
                outcome.update({"ok": True, "owner": v["id"]})
            else:
                outcome.update({"ok": False, "owner": cur.get("id")})
            return doc

        self.storage.atomic_update(updater)
        self.notifier.notify(self.config.name, "claim")
        return outcome

    def release(self, body: dict) -> dict:
        v = self._validate_claim(body)
        if v is None:
            raise ValueError("release 不合法")

        def updater(doc: dict) -> dict:
            cur = doc.get("owner") or {}
            if cur.get("id") == v["id"]:
                doc.pop("owner", None)
                doc["updated"] = time.time()
            return doc

        self.storage.atomic_update(updater)
        return {"ok": True}

    # ---- 导出方法（供路由直接取字段，保持旧响应形状）----

    def status(self) -> dict:
        doc = self.storage.load()
        shot = doc.get("shot") or {}
        owner = doc.get("owner") or {}
        return {
            "seq": doc.get("seq", 0),
            "applied_seq": doc.get("applied_seq", 0),
            "applied": doc.get("applied", 0),
            "error": doc.get("error", ""),
            "shot_req": doc.get("shot_req", 0),
            "shot": {"req": shot.get("req", 0)},
            "state_seq": doc.get("state_seq", 0),
            "owner": ({"id": owner.get("id", ""),
                       "age": round(time.time() - float(owner.get("ts") or 0), 2)}
                      if owner.get("id") else None),
            "has_deck": bool((doc.get("deck") or {}).get("slides")),
            "updated": doc.get("updated", 0),
        }


def register(local_source):
    """注册 PPT Bridge：标准 4 端点由框架自动生成，此处补自定义/严格方法面。"""
    bridge = PPTBridge(local_source)
    registry.register(bridge)

    from router import router
    prefix = f"{bridge.config.route_prefix}/{bridge.config.name}-bridge"

    def _main():
        import main
        return main

    def _read_body(handler) -> dict:
        length = int(handler.headers.get("Content-Length") or 0)
        if length:
            try:
                return json.loads(handler.rfile.read(length).decode("utf-8"))
            except Exception:
                pass
        return {}

    def _405(handler, parsed):
        m = _main()
        return m._json_response(handler, 405, None, "method not allowed")

    def _post_intact(fn, label: str):
        """POST 端点公共壳：读体 → 业务 → 200 全文档；ValueError → 400。"""
        def handler(handler_obj, parsed):
            m = _main()
            try:
                return m._json_response(handler_obj, 200, fn(_read_body(handler_obj)))
            except ValueError as e:
                return m._json_response(handler_obj, 400, None, str(e))
        return handler

    # ---- 截图 ----
    @router.route(f"{prefix}/shot-request", ("POST",))
    def handle_shot_request(handler, parsed):
        m = _main()
        return m._json_response(handler, 200, bridge.shot_request())

    router.route(f"{prefix}/shot-result", ("POST",))(
        _post_intact(bridge.shot_result, "shot-result"))

    @router.route(f"{prefix}/shot", ("GET", "HEAD"))
    def handle_shot_get(handler, parsed):
        m = _main()
        doc = bridge.snapshot()
        shot = doc.get("shot") or {}
        return m._json_response(handler, 200,
                                {"req": shot.get("req", 0), "data": shot.get("data", "")})

    # ---- 所有权 ----
    @router.route(f"{prefix}/claim", ("POST",))
    def handle_claim(handler, parsed):
        m = _main()
        try:
            return m._json_response(handler, 200, bridge.claim(_read_body(handler)))
        except ValueError as e:
            return m._json_response(handler, 400, None, str(e))

    @router.route(f"{prefix}/release", ("POST",))
    def handle_release(handler, parsed):
        m = _main()
        try:
            return m._json_response(handler, 200, bridge.release(_read_body(handler)))
        except ValueError as e:
            return m._json_response(handler, 400, None, str(e))

    # ---- 轻量读取（MCP 侧轮询只取必要字段，省 token/带宽）----
    @router.route(f"{prefix}/status", ("GET", "HEAD"))
    def handle_status(handler, parsed):
        m = _main()
        return m._json_response(handler, 200, bridge.status())

    @router.route(f"{prefix}/deck", ("GET", "HEAD"))
    def handle_deck(handler, parsed):
        m = _main()
        doc = bridge.snapshot()
        return m._json_response(handler, 200, {
            "deck": doc.get("deck", {}),
            "state_seq": doc.get("state_seq", 0),
            "applied_seq": doc.get("applied_seq", 0),
        })

    # ---- 批量辅助 ----
    @router.route(f"{prefix}/summary", ("GET", "HEAD"))
    def handle_summary(handler, parsed):
        m = _main()
        doc = bridge.snapshot()
        return m._json_response(handler, 200, {
            "seq": doc.get("seq", 0),
            "summary": get_deck_summary(doc.get("deck", {})),
            "title": doc.get("title", ""),
        })

    @router.route(f"{prefix}/batch/set-backgrounds", ("POST",))
    def handle_batch_backgrounds(handler, parsed):
        m = _main()
        body = _read_body(handler)
        color = body.get("color", "#ffffff")
        doc = bridge.snapshot()
        cmds = set_all_backgrounds(doc.get("deck", {}), color, body.get("adjust_text", True))
        if not cmds:
            return m._json_response(handler, 200, {
                "success": True, "commands_count": 0,
                "seq": doc.get("seq", 0), "message": "没有需要修改的幻灯片"})
        out = bridge.push({"cmds": cmds, "title": f"批量设置背景色: {color}"})
        return m._json_response(handler, 200, {
            "success": True, "commands_count": len(cmds), "seq": out.get("seq", 0)})

    @router.route(f"{prefix}/batch/set-text-colors", ("POST",))
    def handle_batch_text_colors(handler, parsed):
        m = _main()
        body = _read_body(handler)
        color = body.get("color", "#333333")
        doc = bridge.snapshot()
        cmds = set_all_text_colors(doc.get("deck", {}), color)
        if not cmds:
            return m._json_response(handler, 200, {
                "success": True, "commands_count": 0,
                "seq": doc.get("seq", 0), "message": "没有需要修改的文本元素"})
        out = bridge.push({"cmds": cmds, "title": f"批量设置文字颜色: {color}"})
        return m._json_response(handler, 200, {
            "success": True, "commands_count": len(cmds), "seq": out.get("seq", 0)})

    # ---- 已知路径的错误方法：405（不落代理、不伪装 404）----
    router.route(prefix, ("PUT", "PATCH", "DELETE"))(_405)
    router.route(f"{prefix}/watch", ("POST", "PUT", "PATCH", "DELETE"))(_405)
    router.route(f"{prefix}/ack", ("GET", "HEAD", "PUT", "PATCH", "DELETE"))(_405)
    router.route(f"{prefix}/state", ("GET", "HEAD", "PUT", "PATCH", "DELETE"))(_405)
    router.route(f"{prefix}/shot-request", ("GET", "HEAD"))(_405)
    router.route(f"{prefix}/shot-result", ("GET", "HEAD"))(_405)
    router.route(f"{prefix}/claim", ("GET", "HEAD"))(_405)
    router.route(f"{prefix}/release", ("GET", "HEAD"))(_405)
