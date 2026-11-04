"""
工作流引擎 - 解析和执行工作流

2026-10-15 压测优化批：
  - DSL 解析缓存（LRU，键 = DSL 文本）：同配置代理的 DSL 每请求恒定，
    yaml 解析 + 节点构造占单请求 CPU 的大头。节点对象无状态（执行态全在
    context），跨请求/并发共享安全。
  - 热路径预计算：input 节点与邻接表解析期一次算好（此前每次执行线性扫
    nodes/edges——剖析实锤为进程内吞吐第二大头）。
  - 日志绑定一次：structlog 懒代理每次 info() 都走 __getattr__→bind 机器
    （剖析占 execute 60%），模块级 .bind() 物化后按级别过滤近零开销。
"""
import yaml
from typing import Dict, Any, List, Tuple
import structlog

from .nodes import create_node, WorkflowNode

# 具体绑定日志器（避开懒代理逐调用 bind 机器；级别过滤见 main.py 配置）
logger = structlog.get_logger().bind()

# DSL → (workflow, nodes, edges, input_node, adjacency) 解析缓存
_DSL_CACHE_MAX = 256
_DSL_CACHE: "Dict[str, Tuple[dict, Dict[str, WorkflowNode], List[dict], WorkflowNode, Dict[str, List[Tuple[dict, WorkflowNode]]]]]" = {}


def _parse_dsl(workflow_dsl: str):
    """解析 DSL（带缓存）：yaml → 节点表 + 边表 + 入口节点 + 邻接表。"""
    hit = _DSL_CACHE.get(workflow_dsl)
    if hit is not None:
        return hit
    workflow = yaml.safe_load(workflow_dsl) or {}
    nodes: Dict[str, WorkflowNode] = {}
    input_node: "WorkflowNode | None" = None
    for node_config in workflow.get("nodes", []):
        node = create_node(node_config)
        nodes[node.id] = node
        if input_node is None and node.type == "input":
            input_node = node
    edges = workflow.get("edges", [])
    adjacency: Dict[str, List[Tuple[dict, WorkflowNode]]] = {}
    for edge in edges:
        adjacency.setdefault(edge.get("from"), []).append(
            (edge, nodes.get(edge.get("to"))))
    parsed = (workflow, nodes, edges, input_node, adjacency)
    if len(_DSL_CACHE) >= _DSL_CACHE_MAX:
        _DSL_CACHE.pop(next(iter(_DSL_CACHE)))  # FIFO 淘汰
    _DSL_CACHE[workflow_dsl] = parsed
    return parsed


class WorkflowEngine:
    """工作流执行引擎

    decorator_dsl 给出时 = 外壳装饰器组合执行：外壳图（须恰好一个 slot
    节点）作外层行走，slot 处以引擎套引擎执行业务工作流（共享 context，
    工单号/输入等变量互通）；业务工作流接口 = 完整标准形（input→…→output）。
    组合态（slot 引用 + 内层引擎）挂在引擎实例上——解析出的节点对象跨请求
    共享，不得写入节点。"""

    def __init__(self, workflow_dsl: str, decorator_dsl: "str | None" = None):
        """初始化工作流引擎（解析走缓存；节点无状态可跨请求共享）"""
        if decorator_dsl:
            (self.workflow, self.nodes, self.edges,
             self._input_node, self._adjacency) = _parse_dsl(decorator_dsl)
            slots = [n for n in self.nodes.values() if n.type == "slot"]
            if len(slots) != 1:
                raise ValueError(
                    "外壳装饰器工作流必须恰好一个 slot 节点"
                    f"（当前 {len(slots)} 个）")
            self._slot = slots[0]
            self._inner = WorkflowEngine(workflow_dsl)
        else:
            (self.workflow, self.nodes, self.edges,
             self._input_node, self._adjacency) = _parse_dsl(workflow_dsl)
            self._slot = None
            self._inner = None
        # 最近一次执行的中间回复（emit 产物；无 emit = 空表）
        self.last_replies: "list[str]" = []

        logger.info(
            "workflow_parsed",
            version=self.workflow.get("version"),
            nodes=len(self.nodes),
            edges=len(self.edges),
            decorator=bool(decorator_dsl)
        )

    async def execute(
        self,
        input_data: str = None,
        user_id: int = None,
        requester_id: int = None,
        llm_router_url: str = "http://127.0.0.1:8300",
        platform_api_url: str = "",
        platform_api_token: str = "",
        *,
        context: Dict[str, Any] = None,
        on_reply=None,
        subflow_url: str = "",      # [dsh 适配 2026-11-01] flow 节点回调基址
        subflow_depth: int = 0,     # [dsh 适配 2026-11-01] 子工作流嵌套深度
    ) -> str:
        """执行工作流

        context 给出时 = 被外壳槽位调起的内层执行：沿用同一 context
        （变量/回复列表/即时回调互通），标量参数不重建；on_reply = emit
        节点产物的即时回调（流式回复通道，异步 callable[str]）。"""

        # 初始化上下文（内层执行沿用外层 context）
        if context is None:
            context = {
                "input": input_data,
                "current_value": input_data,
                "user_id": user_id,
                "requester_id": requester_id,
                "llm_router_url": llm_router_url,
                "platform_api_url": platform_api_url,
                "platform_api_token": platform_api_token,
                "variables": {},
            }
        # [dsh 适配 2026-11-01] flow 组合节点执行面（内层执行沿用外层值）
        context.setdefault("subflow_url", subflow_url)
        context.setdefault("subflow_depth", subflow_depth)
        context.setdefault("_replies", [])
        if on_reply is not None:
            context["_on_reply"] = on_reply
        reply_cb = context.get("_on_reply")

        logger.info(
            "workflow_execution_start",
            user_id=context.get("user_id"),
            input_length=len(str(context.get("input") or ""))
        )

        # 入口节点（解析期已定位）
        input_node = self._input_node
        if not input_node:
            raise ValueError("工作流缺少 input 节点")

        # 执行工作流（从 input 开始）
        current_node = input_node
        visited = set()

        while current_node:
            if current_node.id in visited:
                logger.warning("detect_loop", node_id=current_node.id)
                break

            visited.add(current_node.id)

            logger.info("execute_node", node_id=current_node.id, type=current_node.type)

            # 执行当前节点（slot = 装饰器槽位：引擎套引擎跑业务工作流）
            if current_node is self._slot:
                result = await self._inner.execute(
                    context=context)
            else:
                result = await current_node.execute(context)

            # 保存节点结果到变量；带 output 变量名的节点（ticket/slot）
            # 同时落具名变量（emit 模板 {{ticket}}/{{result}} 的查表面）
            context["variables"][current_node.id] = result
            output_var = getattr(current_node, "output_var", None)
            if output_var:
                context["variables"][output_var] = result

            # function / branch / emit 节点：结果只进变量表，不改写
            # current_value（function/branch 留给条件判断；emit 是副作用型
            # 回复节点）——branch 不能吃掉成功产物，否则下游拿不到数据。
            if current_node.type not in ("function", "branch", "switch", "emit"):
                context["current_value"] = result

            # emit 节点：产物即时回调（流式通道；回调异常不拦执行）
            if current_node.type == "emit" and reply_cb is not None:
                try:
                    await reply_cb(str(result))
                except Exception:  # noqa: BLE001 — 回调失败不拖垮工作流
                    logger.warning("reply_callback_failed", node_id=current_node.id)

            # 如果是输出节点，返回结果
            if current_node.type == "output":
                logger.info(
                    "workflow_execution_complete",
                    output_length=len(str(result))
                )
                self.last_replies = list(context.get("_replies") or [])
                return str(result)

            # 查找下一个节点（对于 function 节点，使用其结果判断条件）
            next_node = self._find_next_node(
                current_node.id,
                context,
                decision_value=result if current_node.type in (
                    "function", "branch", "switch") else None
            )
            current_node = next_node

        # 如果没有输出节点，返回最后的值
        self.last_replies = list(context.get("_replies") or [])
        return str(context["current_value"])

    def _find_next_node(
        self,
        current_node_id: str,
        context: Dict[str, Any],
        decision_value: Any = None
    ) -> "WorkflowNode | None":
        """查找下一个要执行的节点（邻接表 O(出度)，解析期预计算）

        decision_value: 用于条件判断的值（function 节点的返回值）
        """
        candidates = self._adjacency.get(current_node_id)
        if not candidates:
            return None
        # 无条件边优先；有条件边按 decision_value 评估
        fallback = None
        for edge, target in candidates:
            if target is None:
                continue
            condition = (edge.get("condition") or "").strip()
            if not condition:
                if fallback is None:
                    fallback = target
                continue
            if decision_value is not None and self._eval_condition(
                    condition, decision_value):
                return target
        return fallback

    @staticmethod
    def _eval_condition(condition: str, decision_value: Any) -> bool:
        """条件边评估（语义与原实现一致）：
        - ``x == 'literal'`` / ``x != 'literal'``：取右值字面量比较
        - 裸条件：decision_value 直接全串匹配
        """
        current_value = str(decision_value)
        if "==" in condition:
            parts = condition.split("==")
            if len(parts) == 2:
                expected = parts[1].strip().strip("'\"")
                return current_value == expected
            return False
        if "!=" in condition:
            parts = condition.split("!=")
            if len(parts) == 2:
                expected = parts[1].strip().strip("'\"")
                return current_value != expected
            return False
        return current_value == condition
