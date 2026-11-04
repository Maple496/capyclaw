"""
沙箱资源限制模块 - cgroup v2 集成
通过 systemd-run 实现安全的资源限制
"""
import asyncio
import subprocess
import uuid
from typing import Optional, Dict, Any
import structlog


logger = structlog.get_logger()


class ResourceLimits:
    """资源限制配置"""
    
    def __init__(
        self,
        memory_max: str = "512M",  # 内存限制
        cpu_quota: float = 1.0,  # CPU 配额（1.0 = 100%）
        pids_max: int = 100,  # 最大进程数
    ):
        self.memory_max = memory_max
        self.cpu_quota = cpu_quota
        self.pids_max = pids_max


class CgroupSandbox:
    """基于 cgroup v2 的沙箱执行器"""
    
    def __init__(self, resource_limits: Optional[ResourceLimits] = None):
        self.resource_limits = resource_limits or ResourceLimits()
        self._check_systemd_support()
    
    def _check_systemd_support(self):
        """检查 systemd-run 是否可用"""
        try:
            result = subprocess.run(
                ["systemd-run", "--version"],
                capture_output=True,
                timeout=5
            )
            if result.returncode != 0:
                logger.warning("systemd_run_not_available")
                self.systemd_available = False
            else:
                self.systemd_available = True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            logger.warning("systemd_run_not_found")
            self.systemd_available = False
    
    async def run_with_limits(
        self,
        command: list,
        timeout: float,
        cwd: str,
        env: Optional[Dict[str, str]] = None
    ) -> tuple:
        """
        在资源限制下执行命令
        
        返回: (stdout, stderr, returncode)
        """
        if not self.systemd_available:
            # 降级：使用普通子进程（无资源限制）
            logger.info("cgroup_fallback_no_systemd")
            return await self._run_without_cgroup(command, timeout, cwd, env)
        
        # 生成唯一的 scope 名称
        scope_name = f"agentbox-{uuid.uuid4().hex[:8]}"
        
        # 尝试用户级 systemd，失败则降级
        # 注意：--user 需要会话总线，在服务环境可能不可用
        systemd_cmd = [
            "systemd-run",
            "--scope",  # scope 模式（临时）
            f"--unit={scope_name}",
            f"-p", f"MemoryMax={self.resource_limits.memory_max}",
            f"-p", f"CPUQuota={int(self.resource_limits.cpu_quota * 100)}%",
            f"-p", f"TasksMax={self.resource_limits.pids_max}",
            "--quiet",  # 减少输出噪音
        ] + command
        
        logger.info(
            "cgroup_sandbox_start",
            scope=scope_name,
            memory_max=self.resource_limits.memory_max,
            cpu_quota=self.resource_limits.cpu_quota,
            pids_max=self.resource_limits.pids_max
        )
        
        try:
            proc = await asyncio.create_subprocess_exec(
                *systemd_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env
            )
            
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=timeout
            )
            
            logger.info(
                "cgroup_sandbox_complete",
                scope=scope_name,
                returncode=proc.returncode
            )
            
            return stdout, stderr, proc.returncode
            
        except asyncio.TimeoutError:
            logger.warning(
                "cgroup_sandbox_timeout",
                scope=scope_name,
                timeout=timeout
            )
            # 尝试 kill 进程
            try:
                proc.kill()
                await proc.wait()
            except:
                pass
            raise
        
        except Exception as e:
            error_msg = str(e).lower()
            logger.warning(
                "cgroup_sandbox_error",
                scope=scope_name,
                error=str(e),
                error_type=type(e).__name__
            )
            # 如果 systemd-run 失败（如无会话总线），降级到无 cgroup 模式
            if any(x in error_msg for x in ["dbus", "session", "failed to connect"]):
                logger.info("cgroup_fallback_no_session_bus")
                return await self._run_without_cgroup(command, timeout, cwd, env)
            raise
    
    async def _run_without_cgroup(
        self,
        command: list,
        timeout: float,
        cwd: str,
        env: Optional[Dict[str, str]] = None
    ) -> tuple:
        """降级：无 cgroup 限制的执行"""
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env
        )
        
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout
        )
        
        return stdout, stderr, proc.returncode


# 全局单例（复用配置）
_default_sandbox: Optional[CgroupSandbox] = None


def get_sandbox(
    memory_max: str = "512M",
    cpu_quota: float = 1.0,
    pids_max: int = 100
) -> CgroupSandbox:
    """获取默认沙箱实例"""
    global _default_sandbox
    if _default_sandbox is None:
        limits = ResourceLimits(
            memory_max=memory_max,
            cpu_quota=cpu_quota,
            pids_max=pids_max
        )
        _default_sandbox = CgroupSandbox(limits)
    return _default_sandbox


async def run_sandboxed(
    command: list,
    timeout: float = 10.0,
    cwd: str = "/tmp",
    memory_max: str = "512M",
    cpu_quota: float = 1.0
) -> Dict[str, Any]:
    """
    便捷函数：在沙箱中执行命令
    
    返回:
        {
            "stdout": str,
            "stderr": str,
            "exit_code": int,
            "timed_out": bool,
            "resource_limited": bool
        }
    """
    sandbox = get_sandbox(memory_max=memory_max, cpu_quota=cpu_quota)
    
    try:
        stdout, stderr, returncode = await sandbox.run_with_limits(
            command=command,
            timeout=timeout,
            cwd=cwd,
            env=None
        )
        
        return {
            "stdout": stdout.decode("utf-8", "replace"),
            "stderr": stderr.decode("utf-8", "replace"),
            "exit_code": returncode,
            "timed_out": False,
            # 真实语义：仅进程被 SIGKILL（cgroup OOM / TasksMax 最常见形态）才视为资源受限
            "resource_limited": returncode in (-9, 137),
            "cgroup_used": sandbox.systemd_available
        }
    
    except asyncio.TimeoutError:
        return {
            "stdout": "",
            "stderr": f"执行超时（>{timeout}s）",
            "exit_code": -1,
            "timed_out": True,
            "resource_limited": False,
            "cgroup_used": sandbox.systemd_available
        }
    
    except Exception as e:
        return {
            "stdout": "",
            "stderr": f"执行失败: {str(e)}",
            "exit_code": -1,
            "timed_out": False,
            "resource_limited": False,
            "cgroup_used": False
        }
