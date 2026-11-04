# 验收与收口报告（2026-11-04）

> 对象：两项优化宣称——①「MCP 优化到 MCP 2.0，性能提升」②「利用 DSH 自带插件
> 管理基础设施，性能提升」。
> 方法：不看报告下结论，独立核查代码接线 + 独立复跑基准/测试 + 基线对照。

---

## 一、验收结论

### 宣称 ① MCP → MCP 2.0 性能提升：❌ 不通过

| 检查项 | 结果 |
|---|---|
| 优化器接入主链路 | **否**。`packages/dsh-tool-host/src/optimizers/`（21 文件）在全仓范围内零外部引用；主入口 `src/index.mjs`、`lib/host.mjs` 均不 import。纯孤岛代码，且随包发布 |
| 基准打真实服务 | **否**。`real-world-benchmark.mjs` 对端为 Mock Client（setTimeout 模拟 100ms 延迟 + 随机失败）。复跑可得到 80.5%/90.1%/88.2% 的"提升"，但只证明并发>串行、缓存>无缓存、重试>不重试——与 MCP 协议、与真实系统均无关 |
| 协议层存在"MCP 2.0" | **否**。真实工具面是 `createMcpHandler` → plugin-kit mcp-http（JSON-RPC Streamable HTTP），无任何协议版本变更 |
| 附带报告可信度 | `真实性能提升验证报告.md` 声称"真实运行测试、可信度 5/5、立即部署"；`E2E测试报告.md` 自身 10 项测试 1 项失败，结论却写"可立即投入生产使用"。**均不可信** |

### 宣称 ② 利用 DSH 插件管理基础设施：⚠️ 部分通过，口径需修正

真实落地的部分（逐项独立验证）：

| 工作 | 验证结果 | 收益口径 |
|---|---|---|
| 启动清单复用 DSH 原生 discovery/manifest/engine | ✅ `tools/launch.mjs` 实测 147 行；launchpad 测试 58/58 | **可维护性**（500+ 行→147 行），非性能 |
| 服务解耦 + service-broker 编排 | ✅ verify-chain 8/10→10/10（CLOSURE 报告） | 架构正确性 |
| HOTPATH A2：状态写 fsync 节流 | ✅ 在 `dsh-state-service` 真实落地；复测 1.79→1.04ms（**-42%**） | 性能 ✅ |
| HOTPATH A6：校验器预编译 | ✅ 在 plugin-kit 真实落地；复测 0.0072ms（**3.7×**） | 性能 ✅ |
| HOTPATH A1：消除 ppt-shim 深拷贝 | ❌ 验收时**未落地**（报告声称已做，代码与 git 历史均无 `cloneJson`）→ 本次收口补做，见下 | 性能 ✅（现已落地） |
| `registerWithDsh` 原生工具注册 | ⚠️ 已实现+单测，生产入口零调用 | 不宣称收益 |

---

## 二、本次收口动作

1. **A1 补做落地**：`cloneJson`（递归纯 JSON 拷贝）接入 ppt-shim，替换全部
   5 处 `JSON.parse(JSON.stringify(...))`；三份副本
   （capyclaw-ppt-workbench / dsh-ppt-workbench / src/mcp）字节一致（md5 相同）。
   在位实测（77KB deck，300 轮）：
   - snapshot 0.368→0.119ms（**3.1×**）
   - load 0.433→0.091ms（**4.8×**）
   - duplicateSlide 0.009→0.004ms（2.3×）
2. **删除 MCP 2.0 孤岛**：`packages/dsh-tool-host/src/optimizers/` 整目录删除
   （21 文件，含两份夸大报告）。删除前后 tool-host 测试均 6/6，无外部引用破坏。
3. **文档修正**：HOTPATH 报告追加「验收修正（2026-11-04）」节，如实记录
   A1 此前未落地、现已补做 + 复测数据；明确性能/可维护性两类收益的口径边界。

## 三、回归验证（全部独立复跑）

| 套件 | 结果 |
|---|---|
| dsh-plugin-kit | 30/30 ✅ |
| dsh-state-service | 5/5 ✅ |
| dsh-tool-host（删孤岛后） | 6/6 ✅ |
| dsh-suite-kit | 69/69 ✅ |
| dsh-mcp-gateway | 3/3 ✅ |
| capyclaw-launchpad | 58/58 ✅ |
| ppt-bridge | 149/157（**与改动前基线完全一致**）|

**存量问题（与本次改动无关）**：ppt-bridge 7 个失败由工作区未完成的
dsh→capyclaw 改名引起（版本对齐 / 契约快照 / suite patch / relay 身份标记 /
MCP initialize / 构建产物对账 / skill 快照）。已用 HEAD 版 ppt-shim 做基线对照
确认：失败集合在改动前后逐一相同。**该改名收尾是下一个待办。**

## 四、遗留与建议

1. **dsh→capyclaw 改名收尾**（7 个存量测试失败的根因，优先级最高）。
2. `registerWithDsh` 若要兑现"省去 loopback /mcp 端口"的收益，需在
   ppt-workbench 真实接线并补对比数据；在此之前它是可选能力。
3. HOTPATH 未实施项维持原报告的诚实边界：A3（调用方 batch，~9× 潜力）、
   A5（mtime 缓存）、A4（命名管道，-18%）按触发条件再做。

## 五、复现

```bash
# A1 在位基准（本报告数字来源）
node bench-shim.mjs   # 临时脚本：A1 收口时创建于 %TEMP%/a1-clone/

# 热路径全套
node research/hotpath-bench.mjs

# 回归
cd extensions/bridges/ppt-bridge && npm test   # 149/157（与基线一致）
cd packages/dsh-plugin-kit && npm test          # 30/30
cd packages/dsh-tool-host && npm test           # 6/6
```
