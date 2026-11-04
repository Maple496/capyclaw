"""端到端：以 MCP 客户端身份驱动 canvas 工具（等价于 DSH mcp-client 的调用序列）。"""
import base64
import json
import time

import requests

MCP = "http://127.0.0.1:39312/mcp"
_id = iter(range(1, 100))


def rpc(method, params=None):
    r = requests.post(MCP, json={
        "jsonrpc": "2.0", "id": next(_id), "method": method, "params": params or {},
    }, timeout=180)
    j = r.json()
    if "error" in j:
        raise RuntimeError(j["error"])
    return j["result"]


def call(name, args=None):
    res = rpc("tools/call", {"name": name, "arguments": args or {}})
    text = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
    if res.get("isError"):
        raise RuntimeError(f"{name} 失败: {text}")
    return res, text


init = rpc("initialize", {})
print("initialize:", init.get("serverInfo"), "protocol", init.get("protocolVersion"))
tools = rpc("tools/list")["tools"]
print("tools:", len(tools), [t["name"] for t in tools])

print("\n--- canvas_status ---")
_, t = call("canvas_status")
print(t)


print("\n--- canvas_write_document（生成一份真实文档）---")
blocks = [
    {"type": "heading", "level": 1, "text": "Canvas 中间件端到端验收报告"},
    {"type": "paragraph", "text": "本文档由 MCP 工具 canvas_write_document 生成，用于验证 DeepSeek Harness 能否通过 canvas-bridge 操作 Canvas 编辑器。"},
    {"type": "heading", "level": 2, "text": "一、验证链路"},
    {"type": "number", "index": 1, "text": "MCP 客户端调用 canvas_write_document"},
    {"type": "number", "index": 2, "text": "桌面网关把命令写入 canvas-bridge 指令队列"},
    {"type": "number", "index": 3, "text": "Canvas 窗口长轮询取到指令，调用 CanvasApp.load 落档"},
    {"type": "number", "index": 4, "text": "编辑器回执 ack 并镜像 doc/text"},
    {"type": "heading", "level": 2, "text": "二、预期结果"},
    {"type": "bullet", "text": "标题层级正确：一级 28px、二级 22px"},
    {"type": "bullet", "text": "正文可读、分节清晰"},
    {"type": "bullet", "text": "表格与截图工具可继续追加内容"},
    {"type": "quote", "text": "如果这段文字出现在编辑器画布上，说明链路打通。"},
    {"type": "paragraph", "text": "下一步：插入表格并截图确认排版。"},
]
_, t = call("canvas_write_document", {"title": "E2E 验收", "blocks": blocks})
print(t)

print("\n--- canvas_read(text) ---")
_, t = call("canvas_read", {"mode": "text"})
print(t[:500])

print("\n--- canvas_insert_table ---")
_, t = call("canvas_insert_table", {
    "headers": ["环节", "组件", "状态"],
    "rows": [
        ["指令下行", "MCP → 网关 → 编辑器", "通过"],
        ["回执上行", "编辑器 → 网关 → MCP", "通过"],
        ["文档镜像", "doc + text + word_count", "通过"],
    ],
})
print(t)

print("\n--- canvas_screenshot ---")
res, t = call("canvas_screenshot")
print(t)
img = next((c for c in res["content"] if c.get("type") == "image"), None)
if not img:
    print("!! 未返回图片块")
else:
    raw = base64.b64decode(img["data"])
    path = "canvas-e2e-shot.jpg"
    with open(path, "wb") as f:
        f.write(raw)
    print("已保存截图:", path, len(raw), "bytes", img.get("mimeType"))

print("\n--- canvas_read(summary) ---")
_, t = call("canvas_read", {"mode": "summary"})
print(t)
