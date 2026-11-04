"""
Agent 结果缓存层 - 基于 Redis

2026-10-16 P3-2 优化：智能缓存 Agent 执行结果，减少重复 LLM 调用。

缓存策略：
- 键 = hash(system_prompt + tools_schema + user_message + model_id)
- TTL = 1 小时（可配置）
- 仅缓存成功的结果（非错误/超时）
- 支持缓存预热和失效
"""
import hashlib
import json
import logging
from typing import Any, Dict, Optional

# [dsh 适配 2026-11-01] 原版模块顶 import redis.asyncio——dsh 插件缺省
# CACHE_ENABLED=false（与平台生产一致），无 Redis 也应可 import。
# 改为方法内懒加载：仅 connect() 实际启用时才需 redis 包。
aioredis = None


def _load_redis():
    global aioredis
    if aioredis is None:
        import redis.asyncio as _aioredis
        aioredis = _aioredis
    return aioredis

logger = logging.getLogger(__name__)


class AgentCache:
    """Agent 结果缓存（异步 Redis）"""
    
    def __init__(self, redis_url: str = "redis://localhost:6380/0", 
                 ttl_seconds: int = 3600,
                 enabled: bool = True):
        """
        Args:
            redis_url: Redis 连接 URL
            ttl_seconds: 缓存过期时间（秒），默认 1 小时
            enabled: 是否启用缓存
        """
        self.redis_url = redis_url
        self.ttl_seconds = ttl_seconds
        self.enabled = enabled
        self._client = None  # [dsh 适配] 懒加载后类型在 connect() 才可用
        
        # 统计指标
        self._stats = {
            "hits": 0,
            "misses": 0,
            "errors": 0,
            "sets": 0
        }
    
    async def connect(self):
        """建立 Redis 连接"""
        if not self.enabled:
            logger.info("Agent 缓存已禁用")
            return
        
        try:
            self._client = await _load_redis().from_url(
                self.redis_url,
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=2
            )
            # 测试连接
            await self._client.ping()
            logger.info(f"Agent 缓存已连接: {self.redis_url}, TTL={self.ttl_seconds}s")
        except Exception as e:
            logger.warning(f"Agent 缓存连接失败（将降级为无缓存）: {e}")
            self._client = None
            self.enabled = False
    
    async def close(self):
        """关闭连接"""
        if self._client:
            await self._client.close()
    
    def _compute_cache_key(self, config: Dict[str, Any], 
                          user_message: str,
                          model_id: int) -> str:
        """计算缓存键（基于请求内容哈希）
        
        Args:
            config: Agent 配置（system_prompt + tools）
            user_message: 用户消息
            model_id: LLM 模型 ID
        
        Returns:
            缓存键字符串
        """
        # 提取关键字段
        system_prompt = config.get("system_prompt", "")
        tools = config.get("tools", [])
        
        # 工具模式：只取名称和参数 schema
        tools_schema = [
            {
                "name": t.get("name"),
                "parameters": t.get("parameters")
            }
            for t in tools
        ]
        
        # 构造缓存输入
        cache_input = {
            "system": system_prompt,
            "tools": tools_schema,
            "message": user_message,
            "model": model_id
        }
        
        # 计算 SHA256 哈希
        json_str = json.dumps(cache_input, sort_keys=True, ensure_ascii=False)
        hash_digest = hashlib.sha256(json_str.encode("utf-8")).hexdigest()
        
        return f"agent:cache:{hash_digest[:16]}"
    
    async def get(self, config: Dict[str, Any], 
                  user_message: str,
                  model_id: int) -> Optional[str]:
        """获取缓存结果
        
        Args:
            config: Agent 配置
            user_message: 用户消息
            model_id: LLM 模型 ID
        
        Returns:
            缓存的结果（JSON 字符串），未命中返回 None
        """
        if not self.enabled or not self._client:
            return None
        
        try:
            key = self._compute_cache_key(config, user_message, model_id)
            value = await self._client.get(key)
            
            if value:
                self._stats["hits"] += 1
                logger.debug(f"缓存命中: {key[:32]}...")
                return value
            else:
                self._stats["misses"] += 1
                return None
        
        except Exception as e:
            self._stats["errors"] += 1
            logger.warning(f"缓存读取失败: {e}")
            return None
    
    async def set(self, config: Dict[str, Any],
                  user_message: str,
                  model_id: int,
                  result: str):
        """设置缓存
        
        Args:
            config: Agent 配置
            user_message: 用户消息
            model_id: LLM 模型 ID
            result: 执行结果（JSON 字符串）
        """
        if not self.enabled or not self._client:
            return
        
        try:
            # 只缓存非错误结果
            try:
                result_obj = json.loads(result)
                # 只检查字典类型的错误字段
                if isinstance(result_obj, dict):
                    if "error" in result_obj or "timeout" in result_obj:
                        logger.debug("跳过缓存错误结果")
                        return
            except (json.JSONDecodeError, TypeError):
                pass  # 非 JSON 结果也缓存
            
            key = self._compute_cache_key(config, user_message, model_id)
            await self._client.setex(key, self.ttl_seconds, result)
            self._stats["sets"] += 1
            logger.debug(f"缓存设置: {key[:32]}... (TTL={self.ttl_seconds}s)")
        
        except Exception as e:
            self._stats["errors"] += 1
            logger.warning(f"缓存写入失败: {e}")
    
    async def invalidate(self, config: Dict[str, Any],
                        user_message: str,
                        model_id: int):
        """使缓存失效
        
        Args:
            config: Agent 配置
            user_message: 用户消息
            model_id: LLM 模型 ID
        """
        if not self.enabled or not self._client:
            return
        
        try:
            key = self._compute_cache_key(config, user_message, model_id)
            await self._client.delete(key)
            logger.debug(f"缓存失效: {key[:32]}...")
        except Exception as e:
            logger.warning(f"缓存失效失败: {e}")
    
    def get_stats(self) -> Dict[str, Any]:
        """获取缓存统计信息"""
        total_requests = self._stats["hits"] + self._stats["misses"]
        hit_rate = (self._stats["hits"] / total_requests * 100 
                   if total_requests > 0 else 0)
        
        return {
            **self._stats,
            "total_requests": total_requests,
            "hit_rate_pct": round(hit_rate, 2),
            "enabled": self.enabled
        }
    
    def reset_stats(self):
        """重置统计信息"""
        self._stats = {
            "hits": 0,
            "misses": 0,
            "errors": 0,
            "sets": 0
        }


# 全局单例（由 main.py 初始化）
_GLOBAL_CACHE: Optional[AgentCache] = None


def get_cache() -> Optional[AgentCache]:
    """获取全局缓存实例"""
    return _GLOBAL_CACHE


def init_cache(redis_url: str = "redis://localhost:6380/0",
               ttl_seconds: int = 3600,
               enabled: bool = True) -> AgentCache:
    """初始化全局缓存实例"""
    global _GLOBAL_CACHE
    _GLOBAL_CACHE = AgentCache(redis_url, ttl_seconds, enabled)
    return _GLOBAL_CACHE
