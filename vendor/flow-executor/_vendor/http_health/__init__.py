"""http_health —— 外接服务标准健康端点（契约见 ../contract.md）。

组件纪律（common/plugin.spec.md §2）：只用标准库 + 调用方已声明的框架；
不读环境变量；不 import 应用代码；不做业务判断。
"""
from __future__ import annotations

import time
from typing import Callable

__version__ = "1.0.0"


def health_payload(service: str, port: int | None = None, *,
                   extra: Callable[[], dict] | None = None) -> dict:
    """标准健康负载。`extra` 的返回值并入（业务自检位），键冲突以 extra 为准。"""
    body: dict = {"ok": True, "service": service}
    if port is not None:
        body["port"] = int(port)
    body["ts"] = int(time.time())
    if extra is not None:
        body.update(extra() or {})
    return body


def mount(app, *, service: str, port: int | None = None,
          paths: tuple[str, ...] = ("/healthz",),
          extra: Callable[[], dict] | None = None) -> list:
    """把标准健康端点挂到 app 上（同一 payload 可挂多个路径）。

    路由不进 OpenAPI（`include_in_schema=False`）：探活面不是对外契约面。
    """
    handlers = []
    for index, path in enumerate(paths):
        name = "healthz" if index == 0 else f"healthz_alias_{index}"

        def handler(_service=service, _port=port, _extra=extra):
            return health_payload(_service, _port, extra=_extra)

        handler.__name__ = name
        handler.__doc__ = "标准健康端点（http_health 组件）：免鉴权、只报存活。"
        app.get(path, name=name, include_in_schema=False)(handler)
        handlers.append(handler)
    return handlers
