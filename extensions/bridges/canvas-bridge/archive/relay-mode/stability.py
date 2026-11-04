"""Canvas 桥稳定性测试套件：压力测试 + 并发 + 边界条件。"""
import base64
import json
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

MCP = "http://127.0.0.1:39312/mcp"
BRIDGE = "http://127.0.0.1:3311/api/desktop/works/canvas-bridge"
_id_gen = iter(range(1, 10000))


def rpc(method, params=None):
    r = requests.post(MCP, json={
        "jsonrpc": "2.0", "id": next(_id_gen), "method": method, "params": params or {},
    }, timeout=180)
    j = r.json()
    if "error" in j:
        raise RuntimeError(j["error"])
    return j["result"]


def call(name, args=None):
    res = rpc("tools/call", {"name": name, "arguments": args or {}})
    if res.get("isError"):
        text = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        raise RuntimeError(f"{name} failed: {text}")
    return res


def direct_bridge(method, path, body=None):
    """直接调桥端点（测试网关层）"""
    url = BRIDGE + path
    if method == "GET":
        r = requests.get(url, timeout=30)
    else:
        r = requests.post(url, json=body, timeout=30)
    return r.status_code, r.json()


print("=== 1. 基础读写循环（100 次）===")
for i in range(100):
    blocks = [
        {"type": "heading", "level": 1, "text": f"测试 #{i}"},
        {"type": "paragraph", "text": f"这是第 {i} 次迭代。"},
    ]
    call("canvas_write_document", {"blocks": blocks})
    res = call("canvas_read", {"mode": "text"})
    text = res["content"][0]["text"]
    assert f"测试 #{i}" in text, f"round {i}: text mismatch"
    if i % 20 == 0:
        print(f"  {i}/100 ✓")
print("✓ 100 次读写循环通过")

print("\n=== 2. 大文档（5000 字 / 100 块）===")
big_blocks = [{"type": "heading", "level": 1, "text": "大文档压力测试"}]
for j in range(20):
    big_blocks.append({"type": "heading", "level": 2, "text": f"第 {j} 节"})
    for k in range(4):
        big_blocks.append({"type": "paragraph", "text": "段落内容" * 50})
call("canvas_write_document", {"blocks": big_blocks})
res = call("canvas_read", {"mode": "summary"})
summ = json.loads(res["content"][0]["text"])
assert summ["word_count"] > 4000, f"word_count={summ['word_count']} too low"
print(f"✓ 大文档写入成功：{summ['word_count']} 字 / {len(big_blocks)} 块")

print("\n=== 3. 并发写入（10 线程 × 5 次）===")
errors = []


def concurrent_write(tid):
    try:
        for i in range(5):
            blocks = [
                {"type": "heading", "level": 1, "text": f"线程 {tid} 迭代 {i}"},
                {"type": "paragraph", "text": f"并发测试 {tid}-{i}"},
            ]
            call("canvas_write_document", {"blocks": blocks})
            time.sleep(random.uniform(0.05, 0.15))
    except Exception as e:
        errors.append((tid, str(e)))


with ThreadPoolExecutor(max_workers=10) as exe:
    list(exe.map(concurrent_write, range(10)))
if errors:
    print(f"✗ {len(errors)} 个线程失败：{errors[:3]}")
else:
    print("✓ 10 线程 × 5 次并发写入全通过")

print("\n=== 4. 快速连续操作（无等待 applied）===")
st, doc = direct_bridge("POST", "", {"cmds": [{"cmd": "setValue", "args": [
    {"header": [], "main": [{"value": "快速 A"}], "footer": []}
]}], "title": "A"})
st, doc = direct_bridge("POST", "", {"cmds": [{"cmd": "appendElementList", "args": [
    [{"value": "快速 B"}]
]}], "title": "B"})
st, doc = direct_bridge("POST", "", {"cmds": [{"cmd": "appendElementList", "args": [
    [{"value": "快速 C"}]
]}], "title": "C"})
time.sleep(3)
st, view = direct_bridge("GET", "/text", None)
text = view.get("text", "")
if "快速 A" in text and "快速 B" in text and "快速 C" in text:
    print(f"✓ 连续指令全部应用（seq={doc['seq']}）")
else:
    print(f"✗ 部分指令未应用：{text[:100]}")

print("\n=== 5. 边界条件 ===")
# 空文档
call("canvas_clear")
res = call("canvas_read", {"mode": "text"})
assert "空文档" in res["content"][0]["text"], "clear 后应为空"
print("✓ 清空 → 读空文档")

# 单字文档
call("canvas_write_document", {"blocks": [{"type": "paragraph", "text": "一"}]})
res = call("canvas_read", {"mode": "text"})
assert "一" in res["content"][0]["text"], "单字丢失"
print("✓ 单字文档")

# 特殊字符
special = "emoji🎉、引号\u300c\u300d、零宽\u200b、换行\n测试"
call("canvas_write_document", {"blocks": [{"type": "paragraph", "text": special}]})
res = call("canvas_read", {"mode": "text"})
text = res["content"][0]["text"]
if "🎉" in text and "\u300c" in text:
    print("✓ 特殊字符保留")
else:
    print(f"✗ 特殊字符丢失：{repr(text[:100])}")

# 超长单段（1MB 文本）
long_text = "x" * (1024 * 1024)
try:
    call("canvas_write_document", {"blocks": [{"type": "paragraph", "text": long_text}]})
    print("✓ 超长单段（1MB）写入成功")
except Exception as e:
    print(f"⚠ 超长单段失败（预期内）：{str(e)[:80]}")

print("\n=== 6. 截图稳定性（10 次）===")
call("canvas_write_document", {"blocks": [
    {"type": "heading", "level": 1, "text": "截图测试"},
    {"type": "paragraph", "text": "内容变化"},
]})
sizes = []
for i in range(10):
    call("canvas_append_blocks", {"blocks": [{"type": "paragraph", "text": f"段 {i}"}]})
    res = call("canvas_screenshot")
    img = next((c for c in res["content"] if c.get("type") == "image"), None)
    if not img:
        print(f"✗ 第 {i} 次截图无图片块")
        break
    raw = base64.b64decode(img["data"])
    sizes.append(len(raw))
    time.sleep(0.3)
if len(sizes) == 10:
    print(f"✓ 10 次截图全成功，尺寸范围 {min(sizes) // 1024}–{max(sizes) // 1024} KB")
else:
    print(f"✗ 截图中断：{len(sizes)}/10")

print("\n=== 7. 租约竞争 ===")
st, r = direct_bridge("POST", "/claim", {"id": "test-a"})
assert r["ok"] is True, "第一次 claim 应成功"
st, r = direct_bridge("POST", "/claim", {"id": "test-b"})
assert r["ok"] is False and r["owner"] == "test-a", "租约内第二个应被拒"
st, r = direct_bridge("POST", "/release", {"id": "test-a"})
st, r = direct_bridge("POST", "/claim", {"id": "test-b"})
assert r["ok"] is True, "release 后应可接管"
print("✓ 租约互斥逻辑正确")

print("\n=== 8. 错误恢复 ===")
# 畸形指令
st, r = direct_bridge("POST", "", {"cmds": [{"cmd": "nonexistent", "args": []}], "title": "bad"})
assert st == 200, "畸形指令应返回 200（入队成功）"
time.sleep(2)
st, status = direct_bridge("GET", "/status", None)
if status.get("error"):
    print(f"✓ 编辑器回执错误：{status['error'][:60]}")
else:
    print("⚠ 畸形指令未产生错误回执")

# 后续正常指令应不受影响
call("canvas_write_document", {"blocks": [{"type": "paragraph", "text": "恢复测试"}]})
res = call("canvas_read", {"mode": "text"})
if "恢复测试" in res["content"][0]["text"]:
    print("✓ 错误后恢复正常")
else:
    print("✗ 错误后未恢复")

print("\n=== 9. 长时间空闲后操作 ===")
print("  等待 20 秒...")
time.sleep(20)
call("canvas_write_document", {"blocks": [{"type": "paragraph", "text": "空闲后写入"}]})
res = call("canvas_read", {"mode": "text"})
if "空闲后写入" in res["content"][0]["text"]:
    print("✓ 空闲 20s 后操作正常")
else:
    print("✗ 空闲后操作失败")

print("\n=== 总结 ===")
print("稳定性测试完成。若全部 ✓ 则可进入独立插件改造。")
