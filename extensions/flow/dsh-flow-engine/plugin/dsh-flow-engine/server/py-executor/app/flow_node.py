"""FlowNode —— 子工作流组合节点 [dsh 适配 2026-11-01]

组合原语：把"另一个工作流"当作本图的一个节点（工作流即组件）。

声明形（与 llm 节点同风格，平铺键）：
    - id: outline_stage
      type: flow
      workflow_id: deck-curator        # 组件仓引用（Node 侧 dsh-workflow 组件）
      input_template: "为主题「{{input}}」生成大纲"   # 可选，缺省透传 current_value
      output: outline_stage            # 可选，output_var（引擎通用语义）
      timeout: 300                     # 可选，秒（≤600）

    - id: inline_stage
      type: flow
      workflow: |                      # 或内联 DSL（同 AgentNode 的 DAG-as-tool 语义）
        version: "2.0" …

执行语义：
- workflow_id 形：HTTP 回调宿主组件面（context["subflow_url"]，Node 侧
  /api/flow/subflow）解析组件仓并递归执行——组件真源在 Node 侧组件仓，
  执行器不读它的磁盘。
- workflow 内联形：本进程引擎套引擎（与 AgentNode._run_tool 同语义）。
- 失败形态：配置错误（缺 workflow_id/workflow）= 装载期报错；运行期失败
  （组件缺失/子 run 失败）= 返回 {"ok": false, "error": …} JSON 文本——
  可被 branch 节点按 .ok 分流（与 react 节点失败形态一致），不终止 run。
- 深度护栏：subflow_depth 逐层 +1，≥ _FLOW_DEPTH_CAP 判失败（防环）。
"""
import json
from typing import Any, Dict

try:
    import aiohttp
except ImportError:  # pragma: no cover — 依赖由 requirements.txt 保证
    aiohttp = None


class FlowNode:
    """不继承 WorkflowNode 以避免循环 import；duck-type 同基类接口
    （id/type/description/execute）。create_node 惰性导入本模块。"""

    _FLOW_DEPTH_CAP = 4

    def __init__(self, node_config: Dict[str, Any]):
        self.id = node_config.get("id")
        self.type = "flow"
        self.description = node_config.get("description", "")
        self.workflow_id = str(node_config.get("workflow_id") or "").strip()
        inline = node_config.get("workflow")
        self.inline_dsl = inline if isinstance(inline, str) and inline.strip() else ""
        self.input_template = str(node_config.get("input_template") or "").strip()
        self.output_var = str(node_config.get("output") or "").strip()
        self.timeout = min(600, max(1, int(node_config.get("timeout") or 300)))
        if not self.workflow_id and not self.inline_dsl:
            raise ValueError("flow 节点需要 workflow_id（组件引用）或 workflow（内联 DSL）")

    async def execute(self, context: Dict[str, Any]) -> Any:
        # 惰性导入（本模块由 nodes.create_node 惰性加载，避免循环 import）
        from .nodes import render_template, _llm_session

        sub_input = context.get("current_value")
        if self.input_template:
            sub_input = render_template(self.input_template, context, json_escape=False)

        depth = int(context.get("subflow_depth") or 0)
        if depth >= self._FLOW_DEPTH_CAP:
            return json.dumps(
                {"ok": False, "error": f"子工作流嵌套深度超限（>{self._FLOW_DEPTH_CAP}）"},
                ensure_ascii=False)

        # 内联 DSL：本进程引擎套引擎（不经宿主）
        if self.inline_dsl and not self.workflow_id:
            from .engine import WorkflowEngine
            engine = WorkflowEngine(self.inline_dsl)
            out = await engine.execute(
                input_data=str(sub_input or ""),
                user_id=context.get("user_id"),
                requester_id=context.get("requester_id"),
                llm_router_url=context.get("llm_router_url") or "http://127.0.0.1:8300",
                platform_api_url=context.get("platform_api_url") or "",
                platform_api_token=context.get("platform_api_token") or "",
            )
            return str(out)

        # 组件引用：回调宿主组件面递归执行
        base = str(context.get("subflow_url") or "").rstrip("/")
        if not base:
            raise Exception(
                f"flow 节点 '{self.id}' 需要 subflow_url（dsh 宿主未注入）——"
                "组件引用只能经 dsh 宿主执行")
        payload = {
            "workflow_id": self.workflow_id,
            "input": str(sub_input if sub_input is not None else ""),
            "depth": depth + 1,
            "user_id": context.get("user_id"),
            "requester_id": context.get("requester_id"),
        }
        async with _llm_session().post(
                f"{base}/api/flow/subflow", json=payload,
                timeout=aiohttp.ClientTimeout(total=self.timeout)) as response:
            try:
                body = await response.json()
            except Exception:
                body = {"ok": False, "error": f"宿主响应非 JSON（HTTP {response.status}）"}
        if response.status == 404:
            return json.dumps(
                {"ok": False, "error": f"组件不存在: {self.workflow_id}"},
                ensure_ascii=False)
        if response.status != 200 or not body.get("ok"):
            return json.dumps(
                {"ok": False,
                 "error": f"子工作流 {self.workflow_id} 执行失败: {body.get('error') or response.status}"},
                ensure_ascii=False)
        return str(body.get("output") if body.get("output") is not None else "")
