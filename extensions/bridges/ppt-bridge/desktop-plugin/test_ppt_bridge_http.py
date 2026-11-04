"""PPT 桥 HTTP 契约测试（自桌面主仓 test_main.PptBridgeApiTest 迁入，
2026-10-27 主站接口化批——桥测试随桥实现走，主仓只测框架与主站面）。

运行环境：桌面主仓（插件已投递到 backend/bridges.d/ppt_bridge.py 并被
网关装载）。在主仓 backend/ 目录下以 unittest 运行需要主仓测试夹具；
此处保留契约的可执行参照（7 用例 = pptbridge 契约的 HTTP 面），接入
方式：把本类并回主仓 test_main.py 临时验证，或用 curl 按 405/400 断言
逐条手验。契约真源 = 本仓 contract/ops.json。
"""
import json
import unittest
import urllib.error
import urllib.request


class PptBridgeApiContract(unittest.TestCase):
    """PPT 桥端点契约（GET 零位空态 → POST 入队（seq 自增、回执清零）→
    ack 落档 → 过期 ack 原样返回；包络畸形 400；已知路径错误方法 405）。"""

    base = "http://127.0.0.1:3311"   # 本机网关（cd frontend && npm run dev 拉起）

    def _req(self, method, path, payload=None):
        data = payload if payload is None else (
            payload if isinstance(payload, bytes) else json.dumps(payload).encode())
        req = urllib.request.Request(self.base + path, data=data, method=method)
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status, json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8") or "{}"
            try:
                return e.code, json.loads(body)
            except Exception:
                return e.code, {}

    def test_empty_state_then_push_ack_roundtrip(self):
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge",
                                {"title": "示例", "cmds": [{"op": "load", "deck": {"slides": []}}]})
        self.assertEqual(status, 200)
        self.assertEqual((doc["seq"], doc["title"], len(doc["cmds"])), (1, "示例", 1))
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge/ack",
                                {"seq": 1, "applied": 1, "error": ""})
        self.assertEqual((status, doc["applied_seq"], doc["applied"]), (200, 1, 1))
        # 过期 ack（seq 不匹配）原样返回现文档，不落脏
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge/ack",
                                {"seq": 99, "applied": 5, "error": ""})
        self.assertEqual((status, doc["applied_seq"], doc["applied"]), (200, 1, 1))

    def test_push_resets_ack_fields(self):
        self._req("POST", "/api/desktop/works/ppt-bridge",
                  {"cmds": [{"op": "title", "title": "a"}]})
        self._req("POST", "/api/desktop/works/ppt-bridge/ack", {"seq": 1, "applied": 1})
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge",
                                {"cmds": [{"op": "title", "title": "b"}]})
        self.assertEqual((doc["seq"], doc["applied_seq"], doc["applied"], doc["error"]),
                         (2, 0, 0, ""))

    def test_bad_envelopes_rejected(self):
        for payload in (
            {},                                   # 缺 cmds
            {"cmds": []},                         # 空队
            {"cmds": ["load"]},                   # 条目非对象
            {"cmds": [{"op": "load"}], "title": "x" * 121},   # title 超长
            {"cmds": [{"op": "load", "pad": "y" * (8 * 1024 * 1024)}]},  # 总量超限
        ):
            status, _ = self._req("POST", "/api/desktop/works/ppt-bridge", payload)
            self.assertEqual(status, 400)
        for ack in ({"seq": -1, "applied": 0}, {"applied": 0}, {"seq": True, "applied": 0}):
            status, _ = self._req("POST", "/api/desktop/works/ppt-bridge/ack", ack)
            self.assertEqual(status, 400, ack)

    def test_state_mirror(self):
        status, _ = self._req("POST", "/api/desktop/works/ppt-bridge/state",
                              {"deck": {"title": "T", "slides": [{"id": "s1"}]}})
        self.assertEqual(status, 200)
        status, doc = self._req("GET", "/api/desktop/works/ppt-bridge")
        self.assertEqual(doc["deck"]["title"], "T")
        # 非 JSON 对象的 deck = 400；state 的 GET = 405（读侧只有主地址）
        status, _ = self._req("POST", "/api/desktop/works/ppt-bridge/state", {"deck": []})
        self.assertEqual(status, 400)
        status, _ = self._req("GET", "/api/desktop/works/ppt-bridge/state")
        self.assertEqual(status, 405)

    def test_shot_request_and_result(self):
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge/shot-request")
        self.assertEqual((status, doc["shot_req"]), (200, 1))
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge/shot-result",
                                {"req": 1, "data": "data:image/jpeg;base64,AAA"})
        self.assertEqual((status, doc["shot"]["req"]), (200, 1))
        # 过期 req 原样返回现文档；非 data:image 前缀 400
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge/shot-result",
                                {"req": 99, "data": "data:image/jpeg;base64,BBB"})
        self.assertEqual((status, doc["shot"]["req"]), (200, 1))
        status, _ = self._req("POST", "/api/desktop/works/ppt-bridge/shot-result",
                              {"req": 1, "data": "not-an-image"})
        self.assertEqual(status, 400)

    def test_editor_owner_lease(self):
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge/claim", {"id": "win-a"})
        self.assertEqual((status, doc["ok"], doc["owner"]), (200, True, "win-a"))
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge/claim", {"id": "win-b"})
        self.assertEqual((doc["ok"], doc["owner"]), (False, "win-a"))
        status, _ = self._req("POST", "/api/desktop/works/ppt-bridge/release", {"id": "win-a"})
        self.assertEqual(status, 200)
        status, doc = self._req("POST", "/api/desktop/works/ppt-bridge/claim", {"id": "win-b"})
        self.assertEqual((doc["ok"], doc["owner"]), (True, "win-b"))
        status, _ = self._req("POST", "/api/desktop/works/ppt-bridge/claim", {"id": ""})
        self.assertEqual(status, 400)

    def test_other_methods_405(self):
        req = urllib.request.Request(self.base + "/api/desktop/works/ppt-bridge",
                                     method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                status = r.status
        except urllib.error.HTTPError as e:
            status = e.code
        self.assertEqual(status, 405)


if __name__ == "__main__":
    unittest.main()
