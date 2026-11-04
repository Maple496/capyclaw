"""config_env —— 环境变量类型化读取（契约见 ../contract.md）。

组件纪律（common/plugin.spec.md §2）：本组件是 `reads_env: true` 的唯一
允许者；不读文件、不缓存、不做业务判断。
"""
from __future__ import annotations

import os

__version__ = "1.0.0"

_TRUTHY = ("1", "true", "yes", "on")


def env_str(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return int(default)
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"环境变量 {name}={raw!r} 不是整数") from exc


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return float(default)
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"环境变量 {name}={raw!r} 不是数字") from exc


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return bool(default)
    return raw.strip().lower() in _TRUTHY
