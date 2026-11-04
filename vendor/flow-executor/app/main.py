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
    """执行工作流（decorator_dsl = 外壳组合；stream = NDJSON 流式回复）"""
    import time
    start_time = time.time()
    
    try:
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
