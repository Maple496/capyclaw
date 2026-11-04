# dsh-flow-engine —— 固定工作流执行引擎（组件化）

把平台（ddr0）主站的工作流执行器（port-8301 语义）做成 dsh 常驻插件：
**执行器 = 运行时，工作流 = 插件内一等组件**，可被调用、可互相组合、
可由 agent 拼装入仓，用于完成确定流程的程序化任务。

## 架构

```text
dsh-flow-engine (Node, Cordis 插件)
├── lib/host.mjs                 生命周期（复用锁/健康/停止）
├── server/relay.mjs             组合根：装配 + 路由
│   ├── pyworker.mjs             Python 执行器 worker（上游 8301/app 快照）
│   │   └── py-executor/         执行器源码 + 适配补丁（见其 ADAPTATIONS.md）
│   ├── llmshim.mjs              LLM 路由承接面（8300 契约兼容）
│   │   ├── mode=mock            确定性应答（测试/离线）
│   │   ├── mode=openai          转发 OpenAI 兼容端点 + model 编号映射
│   │   └── mode=dsh             接管：ctx.llm 流式桥（host.mjs 注入 completeFn；
│   │                            文本面已通，工具面桥接属 agent-loop 接管范畴）
│   ├── workflows.mjs            工作流组件仓（一组件一文件，依赖自动推导）
│   ├── agentloop.mjs            agent 节点接管循环（executor: dsh，策略在宿主）
│   └── impl.mjs / tools.mjs     业务实现 + MCP 工具面
```

数据面：执行器只绑回环临时端口；LLM 调用经 shim 回流 Node；flow 组合节点
按 workflow_id 回调 `/api/flow/subflow` 递归执行（深度护栏 4）。

## 组件模型（对齐 dsh 作品体系）

组件文件 `<hostDir>/workflows/<id>.workflow.json`：

```json
{
  "id": "deck-curator", "name": "…", "version": 1,
  "tags": ["ppt"], "description": "…",
  "contract": { "input": "string", "output": "string" },
  "requires": { "llm": true, "platform_api": false, "subflows": [] },
  "dsl": "<v3 JSON 或 YAML pipeline 文本>",
  "source": { "kind": "fixture|authored", "work_id": 3709 }
}
```

- `requires` 保存时自动推导（扫节点类型 / `{{platform_api_url}}` / flow 引用）
- 首启从 `py-executor/fixtures/` 播种平台在役工作流（13 个，幂等）
- 组件来源三通道：fixtures 播种 / agent 拼装（save_workflow）/ **作品导入**（import_work）

### dsh 作品体系登记（dsh-works 可见）

组件 save/remove 联动登记进 dsh 作品注册表（`DSH_STORE_ROOT/registry.json`
+ `works/WORKS-local-flow-<id>/`，ref 形对 `dsh-works parseWorkRef` 原生兼容）：

- `dsh-works list / search / show` 原生可见（`type: workflow`，能力索引
  `flow.workflow`）；作品目录含 meta.json / content.json / `<ref>.works`
- `.works` 双段文件自带完整 DSL（执行体随作品走），可流转到任何装有
  dsh-flow-engine 的实例经 `import_work` 再物化
- 启动时对账幂等（仓内组件全部登记，重复启动不产生重复条目）
- DSL 文本可能含字面 `%%%WORKS-XXX%%%` 标记（如打包模板）——双段解析
  只认行首标记，不得简单 split 反解
- **双向闭环**：启动时反向对账——作品注册表里 `kind: flow-workflow` 的
  作品（含 `dsh-works install` 装入的外来作品，ref 形不限）→ 缺失的自动
  物化为组件立即可执行；已存在的不动（执行真源在组件仓，刷新走显式
  `import_work`）。全链：`平台作品 → .works → dsh-works install → 启动即用`

### 作品导入（作品 → 组件）

`flow_engine_import_work` 接受四形工件，归一后校验入仓：

| 工件形 | 说明 |
|---|---|
| agent_proxy_json | 平台 `work_versions.agent_proxy_json`（含 workflow_dsl/decorator/description） |
| `.works` 文件 | `%%%WORKS-META%%%`/`%%%WORKS-CODE%%%` 节内含 agent_proxy 或 v3 文档 |
| DSL 文本 | v3 JSON 或 YAML pipeline 原文 |
| v3 文档对象 | `{nodes,edges,...}` |

导入语义：装饰器外壳不导入（平台回复卡语义，warning 点名）；`requires.platform_api`
组件在 dsh 侧执行需提供 `platform_api_url/token`，否则走 fail 分支；坏工件返回
结构化报告（`{ok:false, stage:'parse'}`），不抛异常。

## MCP 工具面（flow_engine_*）

| 工具 | 用途 |
|---|---|
| `flow_engine_run` | 执行一段 DSL（workflow 文本 + input） |
| `flow_engine_validate` | 结构校验（不执行不触 LLM） |
| `flow_engine_workflows` | 组件仓清单（id/契约/依赖/版本） |
| `flow_engine_invoke` | 按组件 id 调用（组合产物 = 可调用技能） |
| `flow_engine_save_workflow` | DSL → 校验 → 入仓 + 作品登记（agent 拼装新流程的出口） |
| `flow_engine_remove_workflow` | 移除组件（联动注销作品登记） |
| `flow_engine_import_work` | 作品导入：agent_proxy_json / .works / DSL → 校验 → 入仓 |
| `flow_engine_node_catalog` | 节点词汇目录（18 类型 + 组合模式，拼装前先读） |
| `flow_engine_fixtures` | 平台快照样本清单 |

## 统一引擎：双方言一个入口 [dsh 扩展]

`/v1/execute` 与 `/v1/validate` 按方言自动路由，一套引擎吃全部形态：

| 方言 | 识别特征 | 内核 | 语义 |
|---|---|---|---|
| 声明式（YAML 2.0 / v3 信封） | input/llm/agent/react/branch… 词汇 | 原 WorkflowEngine（线性行走） | 平台 8301 同语义，逐字不变 |
| 画布形（v3） | pyfunc / when 守卫 / `__canvas_in/out` | **canvas_kernel（新增超步内核）** | 对齐 dsl-semantics.md §15 |

画布内核已对齐：伪端点转译/虚拟边界节点、并行分支 + join（超步屏障）、
when 守卫（白名单 eval、快照语义、全不命中响亮报错）、并行写闸（编译期）、
reducer（append/overwrite）、pyfunc 三签名 + state 快照 + ctx{args,llm,node,fan}
（dict+属性双访问）、print 按节点捕获（≤200 行）、catch 错误出口键、
步数 50 / 墙钟 300s、节点级 trace。待对齐：ctx.llm images、usage 聚合。
画布响应带 `engine: "canvas-superstep"` + `trace`（flowRun 透传）。

## agent 节点接管（executor: dsh）[dsh 扩展]

平台 agent 节点缺省在执行器进程内跑 ReAct 循环；声明 `executor: dsh` 后
整个循环回调宿主 `/api/flow/agent`，由 dsh/Node 侧持有循环策略与记忆管理：

```yaml
- id: bilingual_agent
  type: agent
  executor: dsh          # ← 接管开关；缺省 = 上游进程内循环
  tools:
    - name: translate
      workflow: |…       # 内联子 DAG → 宿主递归执行（flowRun）
    - name: run_python
      sandbox: {runtime: python, timeout: 10, network: false}
                         # → 回调执行器 /v1/tools/sandbox（隔离留在执行器）
    - name: call_api
      http: {url: …}     # → Node 直接 POST
```

- 语义对齐上游：sliding_window/summarization 记忆、超限回退 last_content、
  工具结果截断 8000 字；错误语义同为 raise（不静默）
- 与 `llmshim mode=dsh` 组合 = react/agent 的 LLM 面也走 dsh ctx.llm

## 组合原语：flow 节点 [dsh 扩展]

```json
{"id": "stage", "type": "flow", "workflow_id": "platform-w3746",
 "input_template": "主题：{{input}}", "output": "stage_out"}
```

- 组件引用：经宿主递归执行，子 run 产物回流本图；失败返回
  `{"ok":false,...}` 可被 branch 分流（不终止 run）
- 内联 DSL：`workflow:` 字段，本进程引擎套引擎（同平台 DAG-as-tool 语义）
- 嵌套护栏：深度 4；自引用被吸收为 fail 产物而非挂死

## 配置

| 环境变量/配置 | 缺省 | 说明 |
|---|---|---|
| `port` | 39600 | Node 服务端口 |
| `DSH_FLOW_LLM_MODE` | mock | `mock` / `openai` |
| `DSH_FLOW_LLM_BASE_URL` / `_API_KEY` | — | openai 模式的上游端点 |
| `DSH_FLOW_MODEL_MAP` | — | 形如 `1=deepseek-chat,2=deepseek-reasoner` |
| `DSH_FLOW_ENGINE_HOME` | `~/.dsh-store/flow-engine` | 组件仓/锁/状态目录 |
| `DSH_FLOW_PYTHON` | PATH 探测 | 指定 Python 解释器（≥3.10） |

## 开发

```bash
npm test        # 8 组测试（mock LLM，离线跑）：契约 / 端到端 / 组件化 / 作品导入 / 画布内核 / agent 接管 / 作品对齐 / 反向闭环
```

### 真实 LLM 验收（opt-in，花费真实 token）

```bash
DSH_FLOW_LLM_API_KEY=sk-... DSH_FLOW_LLM_BASE_URL=https://api.deepseek.com \
  node scripts/verify-llm.mjs
# 跑 W3746（llm 直答）+ W3761（react 链，验证反思审查门真模型通过）
```

## 安装到 DSH

```bash
dsh plugin --profile web add <本插件目录>
```
