# MCP 2.0 真伪验证报告

> 验证对象：`MCP2.0新特性优化方案.md` 及其产出的"真实性能提升验证报告"
> 验证方式：代码审查 + 对真实 MCP 服务（ppt-workbench @127.0.0.1:39311）实测
> 验证时间：2026-11-04 10:30

---

## 一、结论：**"MCP 2.0 提升 79.7%" 是假的**

三条独立证据，任何一条都足以证伪。

### 证据 1：测试数据来自 `setTimeout` 模拟，不是真实 MCP

`packages/dsh-tool-host/src/optimizers/real-world-benchmark.mjs` 原文：

```javascript
// ============================================
// Mock Client（模拟真实延迟）
// ============================================
class RealWorldMCPClient {
  async request(method, params) {
    await new Promise(r => setTimeout(r, actualLatency));   // ← 就是 setTimeout！
```

所谓"真实网络延迟 80-120ms 浮动"是 `Math.random()` 生成的数字，
"5% 真实失败率"也是 `Math.random() < 0.05` 模拟的。
**文件名里带 `real-world`，实际零网络、零 MCP、零服务端。**

那份报告里"串行 20 个 2216ms"的算法是：20 × 100ms 的 setTimeout ≈ 2000ms。
"批量 449ms"的算法是：只 setTimeout 了一次 100ms。
两者相减得到"79.7% 提升"——这是**数学必然，不是工程成果**。

### 证据 2：MCP 协议根本没有 `batch` 方法

方案的核心 API 是 `client.request('batch', {...})`。
对真实服务实测：

```
POST /mcp  {"method":"batch"}
→ {"code":-32601,"message":"Method not found: batch"}
```

**-32601 = JSON-RPC Method not found。** 服务端明确不支持。
MCP 规范（2024-11-05 / 2025-03-26 / 2025-06-18）均无批量工具调用能力；
JSON-RPC 的批量语义在 MCP 里并未启用。

所以即使代码接进真实路径，`flush()` 也会每次都抛错并回退到逐个调用——
**比不优化还慢**（多一次失败往返）。

### 证据 3：优化器从未接入任何真实代码路径

```
$ grep -n "optimizer|BatchTool|Concurrency|Retry" packages/dsh-tool-host/src/index.mjs
(空)
```

`dsh-tool-host` 的主入口没有 import 任何一个 optimizer；
全仓库也搜不到 `from 'dsh-tool-host'` 的真实调用方。
这 7 个优化器文件是**孤立文件**，运行时不生效。

### 附带发现：同批次的另一份文档结论也错了

`MCP协议使用情况分析.md` 结论是"deepseekharness_dev 项目未使用 MCP，无需修改"。
**这与事实相反**——本项目 PPT 桥正是通过
`@deepseek-ai/dsh-mcp-client` → `http://127.0.0.1:39311/mcp` 连的 MCP 服务，
27 个工具全靠 MCP 工作。

---

## 二、真实性能测量（对 39311 实测）

```
initialize                     6.8 ms   HTTP 200
tools/list                     1.2 ms   HTTP 200, 27 tools
tools/call (ppt_capabilities)  ~1.0 ms
tools/call (ppt_get_deck)      ~0.8 ms
tools/call (ppt_get_deck detailed) ~1.4 ms
tools/call (ppt_audit)         ~1.2 ms
```

| 对比项 | 原报告声称 | 实测 |
|--------|-----------|------|
| 单次往返 | 110ms | **~1ms**（本机回环） |
| 串行 10 次 | ~1100ms | **9.7ms** |
| 并发 10 次 | — | **9.1ms**（仅快 6%，非 79.7%） |
| batch | 可用 | **不存在（-32601）** |

**MCP 协议层从来不是瓶颈。** 优化 1ms 的往返没有意义。

---

## 三、真实瓶颈在哪？（这才是值得优化的地方）

用真实调用测出来的唯一大头是 **payload 体积**：

```
ppt_capabilities  响应 8263 字符  ≈ 2000+ tokens  ← 每次调用都进模型上下文
ppt_get_deck      1254 字符
ppt_audit         356 字符
```

`ppt_capabilities` 是 MCP instructions 要求"首次操作前调用"的工具，
内容是**静态契约**（27 个工具清单 + features + capabilities），
却因为 `JSON.stringify(..., null, 2)` 带 2 空格缩进而膨胀了 41.6%。

**缩进对模型毫无价值**（模型解析 JSON 不需要美化），纯粹浪费 token 和传输。

---

## 四、已落地的真实优化（可验证）

### 改动：6 处 MCP 工具输出改为紧凑 JSON

| 文件 | 工具 | 改动 |
|------|------|------|
| `server/tools/capabilities/contract.mjs` | ppt_capabilities | `JSON.stringify(x, null, 2)` → `JSON.stringify(x)` |
| `server/tools/capabilities/audit.mjs` | ppt_audit | 同上 |
| `server/tools/capabilities/task.mjs` | ppt_task status/list | 同上（2 处） |
| `server/tools/capabilities/imagesearch.mjs` | ppt_images | 同上 |
| `server/tools/capabilities/export.mjs` | ppt_export_pptx | 同上 |
| `server/tools/capabilities/import.mjs` | ppt_import_pptx | 同上 |

**未改动**（有意保留缩进）：
- `infra/util/fs-lock.mjs` — 持久化文件格式，缩进利于 diff
- `relay.mjs` / `service-host.mjs` — 给人看的 HTTP 调试端点

### 实测效果

```
ppt_capabilities:  8263 → 4827 字符   (-41.6%)
                   省 ~859 tokens/次
ppt_audit:         356 → 276 B
JSON 有效性:        ✅ 可解析
关键字段:           ✅ contractVersion=2.4.0, toolCount=27 完整
全部工具耗时:       ✅ 1~2ms，无回归
DSH 端到端:         ✅ 模型正常调用，266 tok/s，缓存命中 93%
```

### 端到端验证

在真实 DSH 会话里让模型调用 `ppt_capabilities`：

```
模型回答：当前 deck：3 页（标题《美国》：封面、国情概览、数据速览）
1 轮 2 步 · 266 tok/s · 缓存命中 93%
用量 32.6K tok（优化前同场景 36.6K）
```

---

## 五、给后续的建议

1. **不要再引入"MCP 2.0"这个说法** —— MCP 没有 2.0 这个版本，也没有 batch 能力。
   要查协议能力，看服务端 `tools/list` 和规范，不要看生成的方案文档。

2. **真实优化优先级**（按收益从大到小）：
   - ① 减少进上下文的 payload（本次已做，-41.6%）
   - ② 减少不必要的工具调用（如 skills 已加载时不必反复查 capabilities）
   - ③ 重型工具（导出/截图）加超时与进度反馈
   - ④ 并发调用独立工具——仅在工具本身慢（>100ms）时才有意义，
        本机 MCP 往返 1ms，收益可忽略

3. **`packages/dsh-tool-host/src/optimizers/` 里的文件**：
   - `concurrency-optimizer.mjs` / `retry-optimizer.mjs` / `cache-optimizer.mjs`
     作为**通用工具类**是可用的（实现没问题），但不要挂着"MCP 2.0"的名义，
     且目前**未接入**，接入前请用真实服务做前后对比。

4. **那些报告文档建议标注作废**：
   - `packages/dsh-tool-host/src/optimizers/真实性能提升验证报告.md`
   - `packages/dsh-tool-host/src/optimizers/E2E测试报告.md`
   - `MCP2.0新特性优化方案.md`
   - `MCP协议使用情况分析.md`

---

## 附：可复现的验证脚本

| 脚本 | 用途 |
|------|------|
| `real-mcp-bench.mjs` | 真实 MCP 往返/batch 探测/串并发对比 |
| `real-tool-profile.mjs` | 真实工具耗时与响应体积分布 |

运行：`node real-mcp-bench.mjs`（需 ppt-workbench 在 39311 运行）
