# py-executor 适配记录（相对平台上游 port-8301/app@2026-10-31）

## 统一引擎扩展（2026-11-01）

- **新增 `app/canvas_kernel.py`（dsh 新模块，上游零改动）**：Flow 画布形
  DSL（pyfunc/when/伪端点语义）的超步执行内核，对齐
  `flow-standalone/docs/dsl-semantics.md` §15 引擎对齐清单。
  `main.py` 按方言路由：画布形 → canvas_kernel（响应带
  `engine: "canvas-superstep"` + 节点级 trace）；声明式词汇 → 原
  WorkflowEngine（线性行走语义逐字不变，13 个在役工作流为回归硬闸）。
- 待对齐项（§15 清单余量）：ctx.llm 的 images 归一（当前点名不支持）、
  token usage 聚合、遗留类型（v2 词汇）读取。

---

真源：`<internal-server>:/home/<user>/workplace/applications/port-8301/app/`。
本目录 = 上游快照 + 最小适配补丁，全部改动以 `[dsh 适配]` 注释标记，
便于将来 re-sync 上游时对账。

| # | 文件 | 改动 | 原因 |
|---|---|---|---|
| 1 | `app/nodes.py` | `import fcntl` → `_file_lock` 上下文（POSIX fcntl / Windows msvcrt 双实现） | fcntl 是 POSIX 专有；仅 next_ticket 工单号锁使用 |
| 2 | `app/agent_cache.py` | `import redis.asyncio` 顶装改懒加载（`_load_redis()`） | dsh 插件缺省 `CACHE_ENABLED=false`，不应强依赖 redis 包 |
| 3 | `app/agent_cache.py` | `Optional[aioredis.Redis]` 注解 → `None` | 懒加载后类型运行期不可用 |
| 4 | `app/nodes.py` | AgentNode 增 `executor` 配置项 + `_execute_via_host` 回调路径 | executor=dsh 时整个 ReAct 循环回调宿主（/api/flow/agent），循环策略与工具分派在 dsh/Node 侧；缺省空 = 上游进程内循环不变 |
| 5 | `app/main.py` | 增 `POST /v1/tools/sandbox` 端点（裸 AgentNode._run_sandbox 承接） | 接管路径下 sandbox 工具体回调执行器——沙箱隔离能力留在执行器进程 |
| 6 | `app/engine.py` `app/main.py` | execute 增 subflow_url/subflow_depth 透传；ExecuteRequest 增可选字段 | flow 组合节点（子工作流）与 agent 接管的宿主回调面 |

未改动但平台相关的运行语义（dsh 侧以配置承接，不改代码）：

- LLM 调用：`context["llm_router_url"]` 指向 Node 侧 LLM shim（`/v1/llm/complete`
  契约与 8300 一致），shim 再转发 OpenAI 兼容端点或返回 mock。
- `http` 节点 / `{{platform_api_url}}`/`{{platform_api_token}}`：由 run 请求
  携带，指向 ddr0 平台回环 API 或留空（发布类工作流在 dsh 侧无平台时自然
  走 fail 分支）。
- `redis://localhost:6380/0`（缓存）：`CACHE_ENABLED=false` 时不连接。
- cgroup 沙箱（agent 节点 sandbox 工具）：Linux 专属能力，Windows 开发机
  不触发即不受影响；生产部署（Linux）行为与上游一致。接管路径下沙箱仍
  在执行器进程执行（/v1/tools/sandbox）。
