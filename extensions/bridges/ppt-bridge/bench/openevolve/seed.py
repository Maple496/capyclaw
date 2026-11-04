"""OpenEvolve seed：PPT workbench 运行时调优参数。

只允许修改 EVOLVE-BLOCK 内的 TUNING 字典；评估器会把它交给真实 relay 基准。
目标：降低 watch 更新延迟与空闲唤醒，同时保持 push/status 延迟和稳定性。
"""

# EVOLVE-BLOCK-START
TUNING = {
    "watch_poll_ms": 75,
    "watch_timeout_sec": 20,
    "status_poll_ms": 100,
    "push_base_deadline_ms": 12000,
    "push_per_op_ms": 50,
    "http_keep_alive_timeout_ms": 5000,
    "http_request_timeout_ms": 30000,
    "body_limit_mb": 10,
}
# EVOLVE-BLOCK-END


def get_tuning():
    """评估器入口：返回当前候选配置。"""
    return dict(TUNING)
