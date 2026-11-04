"""
工作流执行器服务主应用

日志纪律（2026-10-15 压测批）：每请求 4 行 INFO 是 HTTP 吞吐的显著拖累
（uvicorn→journal 管道），默认按 LOG_LEVEL 环境变量过滤（缺省 WARNING，
生产观测需要时调 INFO）；错误/异常恒记。

外壳装饰器协议（2026-10-15）：请求携带 decorator_dsl 时 = 外壳组合执行
（外壳图 slot 槽位注入业务 workflow_dsl，引擎套引擎）；stream: true 时
响应为 NDJSON 流（application/x-ndjson，每行一个 JSON 事件）——
emit 节点产物即时回吐（受理卡不等业务跑完）：
  {"type": "reply", "content": "<中间回复>"}*
  {"type": "done", "output": "<最终输出>", "replies": [...]} | {"type": "error", ...}
非流式响应恒 JSON（success/output/replies——replies = emit 产物按序）。
"""
import asyncio
import json

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional
import logging
import structlog

from _vendor.config_env import env_bool, env_int, env_str
from _vendor.http_health import mount

from .engine import WorkflowEngine
from . import metrics
from .agent_cache import init_cache, get_cache
from . import canvas_kernel  # [dsh 统一引擎 2026-11-01] 画布形方言内核

# 配置日志（级别可经 LOG_LEVEL 环境变量调；缺省 WARNING 保吞吐）
structlog.configure(
    wrapper_class=structlog.make_filtering_bound_logger(
        getattr(logging, env_str("LOG_LEVEL", "WARNING").upper(),
                logging.WARNING)),
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer()
    ]
)

logger = structlog.get_logger()

# 创建 FastAPI 应用
app = FastAPI(
    title="工作流执行器服务",
    description="执行智能体工作流",
    version="1.1.0"
)

# 初始化 Prometheus 指标
metrics.init_service_info(version="2.0.0")


# === 应用生命周期事件 ===

@app.on_event("startup")
async def startup_event():
    """应用启动时初始化缓存"""
    cache = init_cache(
        redis_url=env_str("REDIS_URL", "redis://localhost:6380/0"),
        ttl_seconds=env_int("CACHE_TTL", 3600),
        enabled=env_bool("CACHE_ENABLED", True)
    )
    if cache.enabled:
        await cache.connect()
        logger.info("Agent 缓存已启动")


@app.on_event("shutdown")
async def shutdown_event():
    """应用关闭时清理缓存连接"""
    cache = get_cache()
    if cache:
        await cache.close()
        logger.info("Agent 缓存已关闭")


# === Pydantic 模型 ===

class ExecuteRequest(BaseModel):
    workflow_dsl: str  # 业务工作流 DSL（YAML 格式；装饰器组合下注入 slot 槽位）
    input: str  # 输入数据
    user_id: int  # 智能体账号 ID
    requester_id: Optional[int] = None  # 请求者 ID
    llm_router_url: Optional[str] = "http://127.0.0.1:8300"  # LLM 路由器 URL
    platform_api_url: Optional[str] = None  # 平台回环 API 基址（http 节点用）
    platform_api_token: Optional[str] = None  # 席位 api_token（平台回调凭证）
    decorator_dsl: Optional[str] = None  # 外壳装饰器工作流 DSL（受理/终态卡固定回复模板）
    stream: bool = False  # NDJSON 流式回吐 emit 中间回复（受理卡即时可达）
    # [dsh 适配 2026-11-01] flow 组合节点执行面（可选，向后兼容：
    # subflow_url = 宿主组件回调基址；subflow_depth = 递归深度护栏）
    subflow_url: Optional[str] = None
    subflow_depth: Optional[int] = None


# === API 端点 ===

@app.get("/")
async def root():
    """根端点"""
    return {
        "service": "工作流执行器服务",
        "version": "1.1.0",
        "status": "running"
    }


# 标准健康端点（_vendor/http_health 组件）
mount(app, service="workflow-executor", port=8301)


@app.get("/v1/health")
async def health_check():
    """健康检查"""
    from datetime import datetime

    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat() + "Z"
    }


class ValidateRequest(BaseModel):
    workflow_dsl: str  # 业务工作流 DSL（YAML/JSON 文本）


class SandboxExecRequest(BaseModel):
    """[dsh 适配 2026-11-01] agent 接管路径的沙箱回执载荷。"""
    sandbox: dict  # 工具体 sandbox 段（runtime/timeout/network/…）
    arguments: dict = {}  # 工具实参（需含 code）


@app.post("/v1/tools/sandbox")
async def tools_sandbox(request: SandboxExecRequest):
    """[dsh 适配 2026-11-01] agent 接管执行（executor=dsh）时，Node 侧
    循环对 sandbox 工具体回调此处——沙箱隔离能力留在执行器进程，
    循环策略在宿主。返回 {ok, result|error}，错误不抛（结构化回执）。"""
    from .nodes import AgentNode

    node = AgentNode({"id": "__sandbox_runner__", "type": "agent"})
    try:
        out = await node._run_sandbox(request.sandbox, request.arguments)
        return {"ok": True, "result": out}
    except Exception as e:  # noqa: BLE001 — 沙箱失败以结构化回执返回
        return {"ok": False, "error": str(e)}


@app.post("/v1/validate")
async def validate_workflow(request: ValidateRequest):
    """[dsh 适配 2026-11-01] 结构校验端点（补上游已知缺口，dsl-semantics.md §15）。

    方言路由：画布形走 canvas_kernel.compile_canvas（转译+编译期闸含并行
    写闸/when 形状），声明式走 _parse_dsl。只校验不执行不触 LLM。错误文案
    点名缺失；不抛 400——返回结构化报告。
    """
    from .engine import _parse_dsl

    errors = []
    version = None
    node_types: list = []
    nodes, edges = {}, []

    # 方言路由：画布形 → 画布编译校验
    probe = canvas_kernel.load_canvas_doc(request.workflow_dsl)
    if canvas_kernel.is_canvas_doc(probe):
        try:
            c = canvas_kernel.compile_canvas(probe)
            node_types = [n.get("type") for n in c.nodes.values()]
            edges = c.edges
            version = probe.get("version") if isinstance(probe, dict) else None
            return {
                "ok": True,
                "version": version,
                "node_count": len(node_types),
                "edge_count": len(edges),
                "node_types": sorted(set(node_types)),
                "engine": "canvas-superstep",
                "errors": [],
            }
        except canvas_kernel.CanvasError as e:
            return {
                "ok": False,
                "version": None,
                "node_count": 0,
                "edge_count": 0,
                "node_types": [],
                "engine": "canvas-superstep",
                "errors": [f"[{e.defect}] {e.message}"],
            }

    try:
        workflow, nodes, edges, input_node, adjacency = _parse_dsl(
            request.workflow_dsl)
        version = workflow.get("version")
        for node in nodes.values():
            node_types.append(node.type)
        if input_node is None:
            errors.append("input_missing: 工作流缺少 input 节点")
        if not any(n.type == "output" for n in nodes.values()):
            errors.append("output_missing: 工作流缺少 output 节点")
        dangling = [e.get("from") for e in edges
                    if e.get("from") not in nodes]
        dangling += [e.get("to") for e in edges if e.get("to") not in nodes]
        if dangling:
            errors.append(
                f"edge_endpoint_missing: 边引用了未声明节点 {sorted(set(dangling))}")
    except ValueError as e:
        errors.append(f"bad_node: {e}")
    except Exception as e:  # noqa: BLE001 — 校验器把一切解析失败点名为报告
        errors.append(f"bad_json: {type(e).__name__}: {e}")

    return {
        "ok": not errors,
        "version": version,
        "node_count": len(node_types),
        "edge_count": len(edges),
        "node_types": sorted(set(node_types)),
        "errors": errors,
    }


@app.get("/metrics")
async def prometheus_metrics():
    """Prometheus 指标端点"""
    from fastapi.responses import Response
    return Response(
        content=metrics.get_metrics(),
        media_type=metrics.get_content_type()
    )


@app.post("/v1/execute")
async def execute_workflow(request: ExecuteRequest):
    """执行工作流（decorator_dsl = 外壳组合；stream = NDJSON 流式回复）。

    [dsh 统一引擎 2026-11-01] 方言路由：画布形（pyfunc/when/伪端点）→
    canvas_kernel 超步内核；声明式词汇 → 原 WorkflowEngine（语义不变）。"""
    import time
    start_time = time.time()

    try:
        # ---- 方言路由：画布形走超步内核 ----
        probe = canvas_kernel.load_canvas_doc(request.workflow_dsl)
        if canvas_kernel.is_canvas_doc(probe):
            result = await canvas_kernel.run_canvas(
                request.workflow_dsl,
                input_data=request.input,
                context={
                    "llm_router_url": request.llm_router_url or "http://127.0.0.1:8300",
                    "user_id": request.user_id,
                    "requester_id": request.requester_id,
                })
            duration = time.time() - start_time
            metrics.record_workflow_execution('success', duration)
            return {
                "success": True,
                "output": result["answer"],
                "replies": [],
                "engine": "canvas-superstep",
                "trace": result["trace"],
                "steps": result["steps"],
            }

        logger.info(
            "workflow_request",
            user_id=request.user_id,
            requester_id=request.requester_id,
            input_length=len(request.input),
            dsl_length=len(request.workflow_dsl),
            decorator=bool(request.decorator_dsl),
            stream=request.stream
        )

        # 创建工作流引擎（外壳组合校验在此响亮：槽位数/缺 input 等）
        engine = WorkflowEngine(request.workflow_dsl,
                                decorator_dsl=request.decorator_dsl)

        if request.stream:
            return _stream_response(engine, request)

        # 执行工作流
        result = await engine.execute(
            input_data=request.input,
            user_id=request.user_id,
            requester_id=request.requester_id,
            llm_router_url=request.llm_router_url,
            platform_api_url=request.platform_api_url or "",
            platform_api_token=request.platform_api_token or "",
            subflow_url=request.subflow_url or "",        # [dsh 适配]
            subflow_depth=request.subflow_depth or 0,     # [dsh 适配]
        )
        
        # 记录成功指标
        duration = time.time() - start_time
        metrics.record_workflow_execution('success', duration)

        return {
            "success": True,
            "output": result,
            "replies": engine.last_replies
        }

    except ValueError as e:
        # 记录失败指标
        duration = time.time() - start_time
        metrics.record_workflow_execution('error', duration)
        
        logger.error("validation_error", error=str(e))
        raise HTTPException(status_code=400, detail=str(e))

    except Exception as e:
        # 记录失败指标
        duration = time.time() - start_time
        metrics.record_workflow_execution('error', duration)
        
        logger.error("execution_error", error=str(e))
        raise HTTPException(status_code=500, detail=f"执行失败: {str(e)}")


def _stream_response(engine: WorkflowEngine, request: ExecuteRequest):
    """NDJSON 流式执行：emit 中间回复即时回吐，终态 done/error 收尾。

    执行在后台任务里跑、产物经队列按序下发——受理卡（首个 emit）在业务
    工作流（LLM 调用）开始前就已上线；客户端断连时任务取消（触发即一次，
    不重试）。"""
    queue: "asyncio.Queue" = asyncio.Queue()

    async def _run():
        try:
            output = await engine.execute(
                input_data=request.input,
                user_id=request.user_id,
                requester_id=request.requester_id,
                llm_router_url=request.llm_router_url or "http://127.0.0.1:8300",
                platform_api_url=request.platform_api_url or "",
                platform_api_token=request.platform_api_token or "",
                on_reply=lambda content: queue.put(
                    {"type": "reply", "content": content}))
            await queue.put({"type": "done", "output": output,
                             "replies": engine.last_replies})
        except ValueError as e:
            logger.error("validation_error", error=str(e))
            await queue.put({"type": "error", "status": 400, "detail": str(e)})
        except Exception as e:  # noqa: BLE001 — 流式面错误以事件形态送达
            logger.error("execution_error", error=str(e))
            await queue.put({"type": "error", "status": 500,
                             "detail": str(e)})

    async def _gen():
        task = asyncio.create_task(_run())
        try:
            while True:
                item = await queue.get()
                yield json.dumps(item, ensure_ascii=False) + "\n"
                if item.get("type") != "reply":
                    break
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(_gen(), media_type="application/x-ndjson")


@app.get("/v1/admin/cache/stats")
async def get_cache_stats():
    """获取缓存统计信息"""
    cache = get_cache()
    if not cache:
        return {"enabled": False, "message": "缓存未初始化"}
    
    return cache.get_stats()


@app.post("/v1/admin/cache/reset-stats")
async def reset_cache_stats():
    """重置缓存统计信息"""
    cache = get_cache()
    if not cache:
        raise HTTPException(status_code=503, detail="缓存未初始化")
    
    cache.reset_stats()
    return {"success": True, "message": "缓存统计已重置"}


@app.post("/v1/admin/cache/invalidate")
async def invalidate_cache(request: Request):
    """使特定缓存失效
    
    请求体示例:
    {
        "config": {"system_prompt": "...", "tools": [...]},
        "user_message": "...",
        "model_id": 1
    }
    """
    cache = get_cache()
    if not cache:
        raise HTTPException(status_code=503, detail="缓存未初始化")
    
    body = await request.json()
    await cache.invalidate(
        config=body["config"],
        user_message=body["user_message"],
        model_id=body["model_id"]
    )
    return {"success": True, "message": "缓存已失效"}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """全局异常处理"""
    logger.error(
        "unhandled_exception",
        path=request.url.path,
        method=request.method,
        error=str(exc)
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "服务器内部错误"}
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8301)
