"""
工作流执行器 - 节点执行逻辑

2026-10-15 压测优化批：LLM 节点共享 aiohttp.ClientSession（此前每次调用
新建会话——TCP 握手 + 连接池重建是并发天花板主因之一）；连接池上限对齐
压测档位（max 500 并发）。

2026-10-15 外壳装饰器批：新增 ticket / emit / slot 三种节点（外壳工作流
专用——受理卡/终态卡固定回复模板；节点对象仍无状态，跨请求共享，装饰器
组合态由引擎持有，见 engine.WorkflowEngine）。工单号 = 服务本地持久序列
（state/tickets.json，flock 跨 worker 互斥，重启续号）。

2026-10-16 AgentNode 性能优化批：Phase 1（schema/查表/workflow 引擎缓存）、
Phase 2（工具并行执行）、Phase 3（Memory 管理：滑动窗口 + 总结策略）、
Phase 4（P3-2：Agent 结果缓存，基于 Redis）。
"""
import asyncio
import aiohttp
import fcntl
import html
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from .board_templates import build_board_game_code
from .game_templates import build_game_code

# 共享 HTTP 会话（惰性建；进程生命周期复用，连接池承载全部 LLM 调用）
_SHARED_SESSION: "Optional[aiohttp.ClientSession]" = None

# 工单序列状态文件（服务目录内自洽；多 worker 经 flock 互斥。
# 2026-10-26 修正：parents[2] 会落到 applications/ 区根，收回 parents[1]）
_TICKET_STATE = Path(__file__).resolve().parents[1] / "state" / "tickets.json"

# 模板占位符 {{var}} / {{var.field}}（查表序：context["variables"] → 顶层；
# 点路径对 dict 与 JSON 字符串逐段解析）
_TMPL_VAR_RE = re.compile(
    r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}")
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

# 反思审查固定系统提示：只做「是否满足用户原始请求」的判断，不重写结果。
_REFLECTION_PROMPT = (
    "你是结果审查员。判断【候选结果】是否真正满足【用户原始请求】。\n"
    "只输出 JSON：{\"ok\": true, \"reason\": \"一句话原因\"} 或 "
    "{\"ok\": false, \"reason\": \"一句话原因\"}。\n"
    "审查标准：\n"
    "1. 主题、对象、场景是否一致；\n"
    "2. 用户明确提出的数量、页数、游戏类型、语言等要求是否满足；\n"
    "3. 是否答非所问、偷换主题、遗漏核心要求；\n"
    "4. 不审查格式细节（格式已由程序校验）；用户没有明确要求的，不臆造标准；\n"
    "5. 候选结果在席位能力边界内正确回应即可通过。"
)


def next_ticket(prefix: str = "TASK-", digits: int = 6) -> str:
    """分配下一号工单（全局持久序列；flock 跨进程互斥，崩溃不跳号不重号）。"""
    _TICKET_STATE.parent.mkdir(parents=True, exist_ok=True)
    with open(_TICKET_STATE, "a+", encoding="utf-8") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            fh.seek(0)
            raw = fh.read().strip()
            try:
                seq = int((json.loads(raw) or {}).get("seq", 0))
            except (ValueError, TypeError):
                seq = 0
            seq += 1
            fh.seek(0)
            fh.truncate()
            fh.write(json.dumps({"seq": seq}))
            fh.flush()
            os.fsync(fh.fileno())
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)
    return f"{prefix}{seq:0{max(1, digits)}d}"


def _lookup_path(context: Dict[str, Any], name: str) -> Any:
    """模板变量查表：先整名命中，再按点路径逐段下行。

    段落值可以是 dict（直接取键）、list（数字下标）或 JSON 字符串（先
    json.loads 再下行）——http 节点返回 JSON 文本时模板可直接写
    ``{{publish.ref}}``。任一段落缺失返回 None。"""
    variables = context.get("variables") or {}
    if name in variables:
        return variables.get(name)
    if name in context:
        return context.get(name)
    parts = name.split(".")
    value: Any = variables.get(parts[0])
    if value is None:
        value = context.get(parts[0])
    for part in parts[1:]:
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                return None
        if isinstance(value, dict):
            value = value.get(part)
        elif isinstance(value, list) and part.isdigit():
            idx = int(part)
            value = value[idx] if 0 <= idx < len(value) else None
        else:
            return None
        if value is None:
            return None
    return value


def render_template(template: str, context: Dict[str, Any],
                    json_escape: bool = True) -> str:
    """模板渲染：{{var}} / {{var.field}} 查表逐个替换。

    json_escape=True（缺省）时替换值经 JSON 字符串转义——模板产物是卡片
    JSON 场景的正确姿势（用户输入含引号/换行不破 JSON）；escape: raw 关闭
    转义（纯文本外壳用）。未命中变量替换为空串（缺字段不出脏占位符）。"""
    def _lookup(match: "re.Match") -> str:
        value = _lookup_path(context, match.group(1))
        text = "" if value is None else (
            value if isinstance(value, str)
            else json.dumps(value, ensure_ascii=False))
        return json.dumps(text, ensure_ascii=False)[1:-1] if json_escape else text
    return _TMPL_VAR_RE.sub(_lookup, template)


def _extract_json_value(raw: Any) -> Any:
    """从 LLM 输出中提取首个 JSON 值（容忍 ``` 围栏与前后解释文字）。

    dict/list/标量原样返回——HTTP 节点返回的是已解析对象，不能再 str()
    成 Python repr（单引号）去 parse。"""
    if raw is None or isinstance(raw, (dict, list, int, float, bool)):
        return raw
    text = str(raw).strip()
    if not text:
        raise ValueError("JSON 抽取：内容为空")
    fence = re.search(r"```(?:json|javascript|js)?\s*(.*?)```", text,
                      re.S | re.I)
    if fence:
        text = fence.group(1).strip()
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        raise ValueError("JSON 抽取：未找到对象或数组")
    try:
        value, _end = json.JSONDecoder().raw_decode(text[min(starts):])
    except ValueError as exc:
        raise ValueError(f"JSON 抽取失败：{exc}") from exc
    return value


def _strip_code_fences(text: Any) -> str:
    """剥掉整段代码围栏（```lang ... ```），保留围栏内原文。"""
    raw = str(text or "").strip()
    m = re.fullmatch(r"```[A-Za-z0-9_+-]*\s*\n(.*?)\n?```", raw, re.S)
    return (m.group(1).strip() if m else raw)


def _llm_session() -> aiohttp.ClientSession:
    """LLM 调用共享会话（首次调用创建；FastAPI 单事件循环内安全）。"""
    global _SHARED_SESSION
    if _SHARED_SESSION is None or _SHARED_SESSION.closed:
        _SHARED_SESSION = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=60),
            connector=aiohttp.TCPConnector(
                limit=600, limit_per_host=600,
                keepalive_timeout=30.0))
    return _SHARED_SESSION


class WorkflowNode:
    """工作流节点基类"""
    
    def __init__(self, node_config: Dict[str, Any]):
        self.id = node_config.get("id")
        self.type = node_config.get("type")
        self.description = node_config.get("description", "")
    
    async def execute(self, context: Dict[str, Any]) -> Any:
        """执行节点（子类实现）"""
        raise NotImplementedError


class InputNode(WorkflowNode):
    """输入节点"""
    
    async def execute(self, context: Dict[str, Any]) -> Any:
        return context.get("input")


class OutputNode(WorkflowNode):
    """输出节点"""
    
    async def execute(self, context: Dict[str, Any]) -> Any:
        # 返回上一个节点的输出
        return context.get("current_value")


class FunctionNode(WorkflowNode):
    """函数节点（安全子集执行，2026-10-15 修正批）

    此前实现：code 字段被完全忽略，按节点 id 硬编码语言检测（id 含
    detect/language），其余形态静默直通输入——工作流作者写的函数体从未
    运行，错误路由静默发生（deck_forge 演示事故锚）。现行语义：

    1. id/code 提示语言检测（detect/language）→ 中文/英文检测（兼容
       translate_forge 真实 DSL）；
    2. ``return "<literal>"`` 单字面量返回形（常见静态路由值）→ 安全
       提取字面量（正则，无 eval，无任意代码执行面）；
    3. 其余形态 → 响亮报错（拒绝静默错误行为；作者按报错改写）。
    """

    _LITERAL_RETURN_RE = None  # 惰性编译（import 期正则开销规避）

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.code = node_config.get("code", "")

    async def execute(self, context: Dict[str, Any]) -> Any:
        input_value = context.get("current_value")

        # 1) 语言检测（id 或 code 提示；兼容存量 translate DSL）
        hint = f"{self.id} {self.code}".lower()
        if "detect" in hint or "language" in hint or "语言" in hint:
            if any('\u4e00' <= char <= '\u9fa5' for char in str(input_value)):
                return "chinese"
            return "english"

        # 2) 单字面量 return 形（静态路由值）
        import re
        if self._LITERAL_RETURN_RE is None:
            FunctionNode._LITERAL_RETURN_RE = re.compile(
                r'^\s*(?:function\s+\w+\s*\([^)]*\)\s*{)?\s*'
                r'return\s+(["\'])(.*?)\1\s*;?\s*}?\s*$', re.S)
        m = self._LITERAL_RETURN_RE.match(self.code or "")
        if m:
            return m.group(2)

        # 3) 未知形态：响亮失败（工作流作者可见，不再静默直通）
        if (self.code or "").strip():
            raise ValueError(
                f"function 节点 {self.id} 的 code 形态不受支持（支持：语言"
                "检测，或 return \"字面量\" 静态路由形）；不支持任意代码执行")
        return input_value


class LLMNode(WorkflowNode):
    """LLM 节点"""
    
    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.model = node_config.get("model", 1)  # 模型编号
        self.system_prompt = node_config.get("system_prompt", "")
        self.temperature = node_config.get("temperature", 0.7)
        self.max_tokens = node_config.get("max_tokens", 2000)
    
    async def execute(self, context: Dict[str, Any]) -> Any:
        """调用 LLM 路由服务"""
        llm_router_url = context.get("llm_router_url", "http://127.0.0.1:8300")
        user_id = context.get("user_id")
        requester_id = context.get("requester_id")
        input_value = context.get("current_value")
        
        # 构造请求
        url = f"{llm_router_url}/v1/llm/complete"
        headers = {
            "Content-Type": "application/json",
            "X-Agent-User-ID": str(user_id),
        }
        if requester_id:
            headers["X-Requester-ID"] = str(requester_id)
        
        messages = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        messages.append({"role": "user", "content": str(input_value)})
        
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": False
        }
        
        # 调用 LLM 路由（共享连接池会话）
        async with _llm_session().post(url, headers=headers, json=payload) as response:
            if response.status != 200:
                text = await response.text()
                raise Exception(f"LLM 调用失败: {response.status} - {text}")

            data = await response.json()
            return data["choices"][0]["message"]["content"]


class AgentNode(WorkflowNode):
    """agent 节点（harness 本体，2026-10-15 接入批 + 2026-10-16 性能优化批）：
    意图判断 → 自主调工具 → 观察 → 再判断，循环至最终回答。

    声明形（DSL 平铺键，与 llm 节点同风格）：
        - id: agent
          type: agent
          model: 1
          system_prompt: "…"
          max_iterations: 8            # 硬上限（缺省 8，≤32）
          memory_strategy: "sliding_window"  # 可选：sliding_window | summarization
          memory_window: 10            # 可选：保留最近 N 条消息
          parallel_tools: true         # 可选：工具并行执行（默认 false）
          tools:
            - name: word_count         # 工具名（LLM 按名调用）
              description: "统计字数"
              parameters: {…}          # 可选 JSON Schema（缺省宽松 object）
              parallel: true           # 可选：此工具可并行（默认 false）
              http:                    # 工具体 A：HTTP 端点
                url: http://…/tool     # POST {name, arguments} → JSON 结果
            - name: translate
              description: "翻译流水线"
              workflow: |              # 工具体 B：内联子 DAG（DAG-as-tool）
                version: "2.0" …
            - name: run_python
              description: "沙箱执行 Python"
              sandbox:                   # 工具体 C：独立沙箱执行代码
                runtime: python          # python | node
                timeout: 10              # 秒（≤30）
                network: false           # 网络隔离（unshare -n）

    组合性：agent 节点可出现在任何 DAG 里，也可作为别的 agent 的 workflow
    工具（递归编排）；引擎级递归深度护栏见 _AGENT_DEPTH。
    
    性能优化（2026-10-16）：
    - Phase 1：工具 schema 缓存、工具查表缓存、workflow 引擎预编译
    - Phase 2：工具并行执行（可配置）
    - Phase 3：Memory 管理（滑动窗口 + 总结策略）
    """

    MAX_ITERATIONS_CAP = 32
    _AGENT_DEPTH = {"n": 0}   # 进程级递归深度（agent→workflow→agent…）
    _AGENT_DEPTH_CAP = 4
    
    # 预编码常见错误（优化：避免重复 JSON 编码）
    _ERROR_DEPTH_LIMIT = json.dumps({"error": "agent 嵌套深度超限"}, 
                                    ensure_ascii=False)
    _ERROR_NO_EXECUTOR = json.dumps({"error": "工具无执行体"}, 
                                    ensure_ascii=False)
    _ERROR_UNKNOWN_TOOL = json.dumps({"error": "未知工具"}, 
                                     ensure_ascii=False)

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        
        self.model = node_config.get("model", 1)
        self.system_prompt = node_config.get("system_prompt", "")
        self.temperature = node_config.get("temperature", 0.7)
        self.max_tokens = node_config.get("max_tokens", 2000)
        self.max_iterations = min(
            int(node_config.get("max_iterations", 8) or 8),
            self.MAX_ITERATIONS_CAP)
        self.tools = [t for t in (node_config.get("tools") or [])
                      if isinstance(t, dict) and t.get("name")]
        
        # Phase 3: Memory 管理配置
        self.memory_strategy = node_config.get("memory_strategy", "sliding_window")
        self.memory_window = int(node_config.get("memory_window", 10) or 10)
        
        # Phase 2: 并发配置
        self.parallel_tools = bool(node_config.get("parallel_tools", False))
        
        # Phase 1 优化：缓存工具 schema（避免每次重建）
        self._tool_schemas_cache = self._build_tool_schemas()
        
        # Phase 1 优化：缓存工具查表（避免每次迭代重建字典）
        self._tools_by_name = {t["name"]: t for t in self.tools}
        
        # Phase 1 优化：缓存基础 headers 和 payload
        self._base_headers = {"Content-Type": "application/json"}
        self._base_payload = {
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": False
        }
        
        # Phase 1 优化：预编译 workflow 工具（避免运行时解析 DSL）
        self._workflow_engines = {}
        from .engine import WorkflowEngine
        for tool in self.tools:
            if "workflow" in tool:
                self._workflow_engines[tool["name"]] = WorkflowEngine(
                    tool["workflow"])

    def _build_tool_schemas(self) -> list:
        """构造工具 schema（仅在初始化时调用一次）"""
        return [{
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("parameters") or {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": True},
            }} for t in self.tools]


    async def _call_llm(self, context, messages, tools):
        """调用 LLM（优化：复用基础 payload 和 headers）"""
        llm_router_url = context.get("llm_router_url",
                                     "http://127.0.0.1:8300")
        # 优化：复用基础 headers，只添加动态部分
        headers = self._base_headers.copy()
        headers["X-Agent-User-ID"] = str(context.get("user_id"))
        if requester_id := context.get("requester_id"):
            headers["X-Requester-ID"] = str(requester_id)
        
        # 优化：复用基础 payload
        payload = self._base_payload.copy()
        payload["messages"] = messages
        payload["tools"] = tools
        
        async with _llm_session().post(
                f"{llm_router_url}/v1/llm/complete",
                headers=headers, json=payload) as response:
            if response.status != 200:
                raise Exception(f"agent LLM 调用失败: {response.status} - "
                                f"{(await response.text())[:200]}")
            return (await response.json())["choices"][0]["message"]

    async def _run_tool(self, tool: Dict[str, Any], arguments: Any,
                        context: Dict[str, Any]) -> str:
        """执行单个工具（优化：复用预编译的 workflow 引擎）"""
        if "workflow" in tool:
            if self._AGENT_DEPTH["n"] >= self._AGENT_DEPTH_CAP:
                return self._ERROR_DEPTH_LIMIT  # 优化：预编码错误
            
            # 优化：使用预编译的引擎
            engine = self._workflow_engines.get(tool["name"])
            if not engine:
                return self._ERROR_NO_EXECUTOR
            
            self._AGENT_DEPTH["n"] += 1
            try:
                out = await engine.execute(
                    input_data=json.dumps(arguments, ensure_ascii=False),
                    user_id=context.get("user_id"),
                    requester_id=context.get("requester_id"),
                    llm_router_url=context.get("llm_router_url"))
            finally:
                self._AGENT_DEPTH["n"] -= 1
            return out
        
        if "sandbox" in tool:
            return await self._run_sandbox(tool["sandbox"], arguments)
        
        http = tool.get("http") or {}
        url = (http.get("url") or "").strip()
        if not url:
            return json.dumps({"error": f"工具 {tool['name']} 无执行体"},
                              ensure_ascii=False)
        async with _llm_session().post(
                url, json={"name": tool["name"], "arguments": arguments}) as r:
            body = await r.text()
            if r.status != 200:
                return json.dumps(
                    {"error": f"HTTP {r.status}", "detail": body[:300]},
                    ensure_ascii=False)
            return body

    async def _run_sandbox(self, cfg: Dict[str, Any],
                            arguments: Any) -> str:
        """独立沙箱执行代码（2026-10-15）：子进程 + 硬超时 + 临时工作目录
        + 输出截断 + 可选网络命名空间隔离（unshare -n，宿主 root 可用）。
        
        2026-10-16 P2 优化：接入 cgroup v2 资源限制（可选，通过 systemd-run）。
        2026-10-16 P3-1 优化：Python 代码预编译（字节码缓存，减少启动时间）。
        
        诚实边界：进程级隔离（无 seccomp/cgroups 内存硬顶）——面向管理员
        配置的内部 agent 是合比例的护栏，不是强安全边界。"""
        import asyncio
        import tempfile
        import marshal
        import base64
        from .cgroup_sandbox import run_sandboxed
        
        runtime = (cfg.get("runtime") or "python").lower()
        timeout = min(float(cfg.get("timeout", 10) or 10), 30.0)
        code = arguments.get("code") if isinstance(arguments, dict) else None
        if not isinstance(code, str) or not code.strip():
            return json.dumps({"error": "沙箱工具参数需 {code: …}"},
                              ensure_ascii=False)
        runtimes = {
            "python": (["python3", "-I"], ".py"),   # -I 隔离用户环境
            "node": (["node"], ".js"),
        }
        if runtime not in runtimes:
            return json.dumps({"error": f"未知 runtime {runtime}"},
                              ensure_ascii=False)
        argv, ext = runtimes[runtime]
        if cfg.get("network") is False:
            argv = ["unshare", "-n"] + argv   # 独立网络命名空间
        
        # 资源限制配置（可选）
        memory_max = cfg.get("memory_max", "512M")
        cpu_quota = float(cfg.get("cpu_quota", 1.0))
        use_cgroup = cfg.get("use_cgroup", True)  # 默认启用 cgroup
        
        with tempfile.TemporaryDirectory(prefix="agentbox-") as workdir:
            path = os.path.join(workdir, f"main{ext}")
            
            # P3-1 优化：Python 代码预编译为字节码
            if runtime == "python" and cfg.get("precompile", True):
                try:
                    # 编译为字节码对象
                    code_obj = compile(code, "<sandbox>", "exec")
                    # 序列化为 marshal 格式并 base64 编码
                    marshaled = marshal.dumps(code_obj)
                    encoded = base64.b64encode(marshaled).decode("ascii")
                    
                    # 写入加载器脚本（反序列化并执行）
                    loader = f"""import marshal, base64
exec(marshal.loads(base64.b64decode({encoded!r})))"""
                    with open(path, "w", encoding="utf-8") as f:
                        f.write(loader)
                except SyntaxError as e:
                    return json.dumps({"error": f"代码语法错误: {e}"},
                                      ensure_ascii=False)
            else:
                # 非 Python 或禁用预编译：直接写入
                with open(path, "w", encoding="utf-8") as f:
                    f.write(code)
            
            command = argv + [path]
            
            if use_cgroup:
                # 使用 cgroup v2 限制
                result = await run_sandboxed(
                    command=command,
                    timeout=timeout,
                    cwd=workdir,
                    memory_max=memory_max,
                    cpu_quota=cpu_quota
                )
                
                if result["timed_out"]:
                    return json.dumps(
                        {"error": f"沙箱执行超时（>{timeout}s）已终止"},
                        ensure_ascii=False)
                
                return json.dumps({
                    "exit_code": result["exit_code"],
                    "stdout": result["stdout"][:4000],
                    "stderr": result["stderr"][:2000],
                    "resource_limited": result["resource_limited"],
                    "cgroup_used": result.get("cgroup_used", False)
                }, ensure_ascii=False)
            
            else:
                # 降级：使用原始方式（无 cgroup）
                try:
                    proc = await asyncio.create_subprocess_exec(
                        *command,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        cwd=workdir)
                    out, err = await asyncio.wait_for(
                        proc.communicate(), timeout=timeout)
                except asyncio.TimeoutError:
                    return json.dumps(
                        {"error": f"沙箱执行超时（>{timeout}s）已终止"},
                        ensure_ascii=False)
                except FileNotFoundError as e:
                    return json.dumps(
                        {"error": f"沙箱运行时不可用：{e}（unshare 隔离在非"
                                  "root 宿主可能不可用，可设 network: true 回退）"},
                        ensure_ascii=False)
                return json.dumps({
                    "exit_code": proc.returncode,
                    "stdout": out.decode("utf-8", "replace")[:4000],
                    "stderr": err.decode("utf-8", "replace")[:2000],
                }, ensure_ascii=False)


    async def _apply_memory_strategy(self, messages: list) -> list:
        """Phase 3: 应用 Memory 管理策略"""
        if len(messages) <= self.memory_window + 1:  # +1 for system prompt
            return messages
        
        if self.memory_strategy == "sliding_window":
            # 保留 system prompt + 最近 N 条
            return [messages[0]] + messages[-(self.memory_window):]
        
        elif self.memory_strategy == "summarization":
            # 保留 system + 总结中间部分 + 最近 N 条
            # 需要调用 LLM 总结，这里先用简化版（只保留用户消息和最终回答）
            system_msg = messages[0] if messages[0]["role"] == "system" else None
            recent = messages[-(self.memory_window):]
            
            # 简化：只保留用户消息和助手的最终回答（跳过中间工具调用）
            middle_summary = []
            for msg in messages[1:-(self.memory_window)]:
                if msg["role"] in ("user", "assistant") and msg.get("content"):
                    middle_summary.append(msg)
            
            result = ([system_msg] if system_msg else []) + middle_summary[-2:] + recent
            return result
        
        return messages

    async def _run_tools_parallel(self, calls: list, context: Dict[str, Any]) -> list:
        """Phase 2: 并行执行工具"""
        tasks = []
        call_info = []
        
        for call in calls:
            fn = call.get("function") or {}
            name = fn.get("name") or ""
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            
            tool = self._tools_by_name.get(name)
            call_info.append((call, name, tool))
            
            if tool:
                # 检查工具是否支持并行
                can_parallel = tool.get("parallel", False) or self.parallel_tools
                if can_parallel and "sandbox" not in tool and "workflow" not in tool:
                    # HTTP 工具可以并行
                    tasks.append(self._run_tool(tool, args, context))
                else:
                    # 有状态的工具（workflow/sandbox）或明确禁止并行的，标记为 None
                    tasks.append(None)
            else:
                tasks.append(None)
        
        # 并行执行所有可并行的工具
        parallel_indices = [i for i, t in enumerate(tasks) if t is not None]
        if parallel_indices:
            parallel_tasks = [tasks[i] for i in parallel_indices]
            parallel_results = await asyncio.gather(*parallel_tasks, return_exceptions=True)
            
            # 填充结果
            for idx, result in zip(parallel_indices, parallel_results):
                if isinstance(result, Exception):
                    tasks[idx] = json.dumps({"error": str(result)}, ensure_ascii=False)
                else:
                    tasks[idx] = result
        
        # 串行执行不能并行的工具
        for i, (call, name, tool) in enumerate(call_info):
            if tasks[i] is None:
                fn = call.get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                
                if tool:
                    tasks[i] = await self._run_tool(tool, args, context)
                else:
                    tasks[i] = json.dumps({"error": f"未知工具 {name}"}, 
                                         ensure_ascii=False)
        
        return tasks

    async def execute(self, context: Dict[str, Any]) -> Any:
        """执行 agent 节点（包含全部四阶段优化）"""
        user_message = str(context.get("current_value"))
        
        # Phase 4（P3-2）：检查 Agent 结果缓存
        from .agent_cache import get_cache
        cache = get_cache()
        if cache:
            cached_result = await cache.get(
                config={"system_prompt": self.system_prompt, "tools": self.tools},
                user_message=user_message,
                model_id=self.model
            )
            if cached_result:
                return cached_result
        
        messages = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        messages.append({"role": "user", "content": user_message})
        
        # Phase 1 优化：使用缓存的 schema 和查表
        tools = self._tool_schemas_cache
        
        last_content = ""
        for iteration in range(self.max_iterations):
            # Phase 3: 应用 Memory 策略
            messages = await self._apply_memory_strategy(messages)
            
            message = await self._call_llm(context, messages, tools)
            calls = message.get("tool_calls") or []
            
            if not calls:
                final_result = message.get("content") or last_content
                
                # Phase 4（P3-2）：成功结果写入缓存
                if cache and final_result:
                    await cache.set(
                        config={"system_prompt": self.system_prompt, "tools": self.tools},
                        user_message=user_message,
                        model_id=self.model,
                        result=final_result
                    )
                
                return final_result
            
            last_content = message.get("content") or last_content
            messages.append({"role": "assistant",
                             "content": message.get("content") or "",
                             "tool_calls": calls})
            
            # Phase 2: 并行执行工具（如果配置允许）
            if self.parallel_tools or any(
                self._tools_by_name.get(
                    (c.get("function") or {}).get("name", ""), {}
                ).get("parallel", False) for c in calls
            ):
                results = await self._run_tools_parallel(calls, context)
            else:
                # 串行执行（原逻辑）
                results = []
                for call in calls:
                    fn = call.get("function") or {}
                    name = fn.get("name") or ""
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except ValueError:
                        args = {}
                    
                    tool = self._tools_by_name.get(name)  # Phase 1: 使用缓存查表
                    result = (await self._run_tool(tool, args, context)
                              if tool else self._ERROR_UNKNOWN_TOOL)
                    results.append(result)
            
            # 添加工具结果到消息历史
            for call, result in zip(calls, results):
                tool_call_id = call.get("id")
                if not tool_call_id:
                    # 兜底：使用 function name
                    tool_call_id = (call.get("function") or {}).get("name", "unknown")
                
                messages.append({"role": "tool",
                                 "tool_call_id": tool_call_id,
                                 "content": result[:8000]})
        
        final_result = (last_content or
                       "（达到工具循环上限，未能给出最终回答）")
        
        # Phase 4（P3-2）：成功结果写入缓存
        if cache and final_result and "达到工具循环上限" not in final_result:
            await cache.set(
                config={"system_prompt": self.system_prompt, "tools": self.tools},
                user_message=user_message,
                model_id=self.model,
                result=final_result
            )
        
        return final_result


class TicketNode(WorkflowNode):
    """工单节点（外壳装饰器专用）：分配全局持久序号 TASK-%06d 形工单号。

    配置：prefix（缺省 TASK-）/ digits（缺省 6）/ output（结果写入的
    变量名，缺省 ticket）。节点无状态——序列真源在 state/tickets.json。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.prefix = str(node_config.get("prefix") or "TASK-")
        try:
            self.digits = int(node_config.get("digits") or 6)
        except (TypeError, ValueError):
            raise ValueError(f"ticket 节点 {self.id} 的 digits 须为整数")
        self.output_var = str(node_config.get("output") or "ticket").strip() \
            or "ticket"

    async def execute(self, context: Dict[str, Any]) -> Any:
        return next_ticket(self.prefix, self.digits)


class EmitNode(WorkflowNode):
    """回复节点（外壳装饰器专用）：渲染模板并作为一条中间回复发出。

    配置：template（{{var}} 模板，必备）/ escape（json 缺省 | raw）。
    产物进入 context["_replies"]；流式请求（stream: true）下经
    context["_on_reply"] 即时回吐。副作用型节点——不更新 current_value
    （引擎侧与 function 节点同待遇）。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.template = str(node_config.get("template") or "")
        if not self.template.strip():
            raise ValueError(f"emit 节点 {self.id} 缺少 template")
        self.json_escape = str(node_config.get("escape") or "json") != "raw"

    async def execute(self, context: Dict[str, Any]) -> Any:
        content = render_template(self.template, context, self.json_escape)
        (context.setdefault("_replies", [])).append(content)
        return content


class SlotNode(WorkflowNode):
    """槽位节点（外壳装饰器专用）：业务工作流注入位。

    装饰器组合期由引擎绑定业务引擎（engine.WorkflowEngine 持组合态——
    节点对象跨请求共享，不得在节点上存每请求状态）；执行 = 引擎套引擎
    （业务工作流以共享 context 跑完整 input→…→output 行走，最终输出 =
    槽位结果，写入 output 变量名，缺省 result）。裸用（非装饰器组合）=
    400。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.output_var = str(node_config.get("output") or "result").strip() \
            or "result"

    async def execute(self, context: Dict[str, Any]) -> Any:
        raise ValueError(
            f"slot 节点 {self.id} 只在外壳装饰器（decorator_dsl）里有效")


class DeckNode(WorkflowNode):
    """大纲 JSON → PPTist 幻灯片数据 JSON（确定性排版，零模型）。

    输入（current_value）：``{"title","subtitle","slides":[{"title",
    "bullets":[...]}]}``（容忍 ``` 围栏与前后说明；解析失败时把原文
    收成单页兜底）。输出 = WORKS-3686 只读放映套件消费的 PPTist 数据
    （1000×562.5，封面 + 内容页 + 封底）。

    style：plain（缺省，蓝白）| swiss（白底黑字 + 瑞士红，网格/字阶排布）。
    Swiss 形用于组合管线的「白板 + 画风」成片。"""

    _PRIMARY = "rgb(37, 99, 235)"
    _TEXT = "#1f2937"
    _MUTED = "#64748b"

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.output_var = str(node_config.get("output") or "slides").strip() \
            or "slides"
        self.style = str(node_config.get("style") or "plain").strip().lower()
        # strict（缺省 true）：大纲不是合法 JSON / 没有 slides 时响亮失败，
        # 不把模型原文静默收成单页发布（防低质或误导作品）。
        self.strict = bool(node_config.get("strict", True))
        self.max_slides = int(node_config.get("max_slides") or 12)
        self.max_bullets = int(node_config.get("max_bullets") or 5)
        self.honor_input_pages = bool(
            node_config.get("honor_input_pages", True))

    def _palette(self) -> dict:
        if self.style == "swiss":
            return {"primary": "#e2231a", "text": "#111111",
                    "muted": "#555555", "bg": "#ffffff"}
        return {"primary": self._PRIMARY, "text": self._TEXT,
                "muted": self._MUTED, "bg": "#ffffff"}

    @staticmethod
    def _esc(text: Any) -> str:
        return html.escape(str(text or ""), quote=False)

    @classmethod
    def _text(cls, eid: str, left: int, top: int, width: int, height: int,
              content: str, color: str, size: int, bold: bool = False) -> dict:
        style = f"font-size: {size}px; color: {color};"
        if bold:
            style += " font-weight: 600;"
        return {
            "type": "text", "id": eid, "left": left, "top": top,
            "width": width, "height": height,
            "content": f'<p style="{style}">{content}</p>',
            "defaultColor": color, "defaultFontName": "",
            "fixedRatio": False, "rotate": 0,
        }

    @classmethod
    def _bar(cls, eid: str, left: int, top: int, width: int, height: int,
             color: str) -> dict:
        return {
            "type": "shape", "id": eid, "left": left, "top": top,
            "width": width, "height": height, "viewBox": [200, 200],
            "path": "M 0 0 L 200 0 L 200 200 L 0 200 Z", "fill": color,
            "fixedRatio": False, "rotate": 0,
        }

    async def execute(self, context: Dict[str, Any]) -> Any:
        raw = context.get("current_value")
        if isinstance(raw, dict):
            data = raw
        else:
            try:
                data = _extract_json_value(raw)
            except ValueError:
                data = {}
        if not isinstance(data, dict):
            data = {}
        title = str(data.get("title") or "AI 演示文稿").strip()[:120]
        subtitle = str(data.get("subtitle") or "").strip()[:240]
        items = data.get("slides") if isinstance(data.get("slides"), list) else []
        items = [x for x in items if isinstance(x, dict)][:self.max_slides]
        if not items:
            if self.strict:
                raise ValueError(
                    f"deck 节点 {self.id}：大纲缺少有效 slides（LLM 输出不是"
                    "合法 JSON 或结构不符）——已阻断发布，请重试")
            fallback = _strip_code_fences(raw)[:800].strip()
            items = [{"title": title,
                      "bullets": [fallback or subtitle or "（内容待补充）"]}]

        # 总页数程序化：用户消息里的「N 页」= 封面 + 内容页 + 封底。
        target_total = 0
        if self.honor_input_pages:
            m = re.search(r"(\d{1,2})\s*(?:页|pages?|slides?)",
                          str(context.get("input") or ""), re.I)
            if m:
                target_total = max(1, min(20, int(m.group(1))))
        add_closing = True
        if target_total == 1:
            items = []
            add_closing = False
        elif target_total >= 2:
            items = items[:max(0, target_total - 2)]

        pal = self._palette()
        swiss = self.style == "swiss"
        slides: list[dict] = []

        if swiss:
            cover = [
                self._bar("s1_side", 0, 0, 26, 562.5, pal["primary"]),
                self._text("s1_kicker", 80, 62, 760, 40,
                           self._esc("瑞士风 · 组合演示"), pal["primary"], 14),
                self._text("s1_title", 80, 128, 840, 130,
                           self._esc(title), pal["text"], 46, True),
                self._bar("s1_sq", 860, 440, 60, 60, pal["primary"]),
            ]
            if subtitle:
                cover.append(self._text("s1_sub", 80, 278, 760, 90,
                                        self._esc(subtitle), pal["muted"], 20))
        else:
            cover = [
                self._bar("s1_band", 0, 0, 1000, 190, pal["primary"]),
                self._text("s1_title", 70, 62, 860, 100,
                           self._esc(title), "#ffffff", 44, True),
            ]
            if subtitle:
                cover.append(self._text("s1_sub", 70, 238, 860, 80,
                                        self._esc(subtitle), pal["muted"], 20))
        slides.append({
            "id": "slide_1", "turningMode": "fade",
            "background": {"type": "solid", "color": pal["bg"]},
            "elements": cover,
        })

        for i, item in enumerate(items, 2):
            stitle = str(item.get("title") or f"第 {i - 1} 页").strip()[:120]
            bullets = item.get("bullets") or item.get("points") or []
            if isinstance(bullets, str):
                bullets = [bullets]
            seen = set()
            clean = []
            for b in bullets:
                text = str(b).strip()[:300]
                if text and text not in seen:
                    seen.add(text)
                    clean.append(text)
            bullets = clean[:self.max_bullets] or ["（待补充）"]
            body = "".join(
                '<p style="font-size: 20px; line-height: 1.7; '
                'margin: 0 0 12px 0;">'
                f'<span style="color: {pal["primary"]};">■</span> '
                f'{self._esc(b)}</p>'
                for b in bullets) or (
                '<p style="font-size: 20px; color: '
                f'{pal["muted"]};">（要点待补充）</p>')
            if swiss:
                elements = [
                    self._bar(f"s{i}_rule", 60, 72, 880, 5, pal["primary"]),
                    self._text(f"s{i}_num", 900, 36, 60, 36,
                               f"{i - 1:02d}", pal["primary"], 16, True),
                    self._text(f"s{i}_title", 60, 98, 840, 72,
                               self._esc(stitle), pal["text"], 32, True),
                    {"type": "text", "id": f"s{i}_body", "left": 60,
                     "top": 184, "width": 880, "height": 330,
                     "content": body, "defaultColor": pal["text"],
                     "defaultFontName": "", "fixedRatio": False, "rotate": 0},
                ]
            else:
                elements = [
                    self._bar(f"s{i}_bar", 60, 52, 8, 56, pal["primary"]),
                    self._text(f"s{i}_title", 88, 44, 850, 70,
                               self._esc(stitle), pal["text"], 30, True),
                    {"type": "text", "id": f"s{i}_body", "left": 88,
                     "top": 140, "width": 850, "height": 360,
                     "content": body, "defaultColor": pal["text"],
                     "defaultFontName": "", "fixedRatio": False, "rotate": 0},
                ]
            slides.append({
                "id": f"slide_{i}", "turningMode": "slideX",
                "background": {"type": "solid", "color": pal["bg"]},
                "elements": elements,
            })

        if add_closing:
            n = len(slides) + 1
            if swiss:
                closing = [
                    self._bar(f"s{n}_side", 0, 0, 26, 562.5, pal["primary"]),
                    self._text(f"s{n}_title", 80, 205, 760, 90,
                               self._esc("谢谢"), pal["text"], 46, True),
                    self._bar(f"s{n}_line", 80, 330, 220, 8, pal["primary"]),
                ]
            else:
                closing = [
                    self._text(f"s{n}_title", 160, 210, 680, 90,
                               self._esc("谢谢"), "#ffffff", 44, True),
                    self._bar(f"s{n}_line", 390, 330, 220, 8, "#ffffff"),
                ]
            slides.append({
                "id": f"slide_{n}", "turningMode": "fade",
                "background": {"type": "solid",
                               "color": pal["bg"] if swiss else pal["primary"]},
                "elements": closing,
            })
        return json.dumps({
            "title": title, "width": 1000, "height": 562.5,
            "theme": {
                "themeColors": [pal["primary"], pal["text"], pal["muted"]],
                "fontColor": pal["text"], "fontName": "",
                "backgroundColor": pal["bg"],
            },
            "slides": slides,
        }, ensure_ascii=False)


class HttpNode(WorkflowNode):
    """HTTP 请求节点（确定性回调；默认只允许回环地址）。

    配置：url（模板，必备）/ method（缺省 POST）/ headers（模板字典）/
    body（JSON 值，字符串逐项模板渲染）/ output / allow_external（缺省
    false）/ timeout（秒，缺省 60）。返回 JSON 响应（dict/list）或文本。
    HTTP ≥400 响亮失败（ValueError），不静默吞错。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.url = str(node_config.get("url") or "").strip()
        if not self.url:
            raise ValueError(f"http 节点 {self.id} 缺少 url")
        self.method = str(node_config.get("method") or "POST").upper()
        self.headers = node_config.get("headers") or {}
        self.body = node_config.get("body")
        self.output_var = str(node_config.get("output") or "http").strip() \
            or "http"
        self.allow_external = bool(node_config.get("allow_external", False))
        self.soft = bool(node_config.get("soft", False))
        self.timeout = float(node_config.get("timeout") or 60)

    def _resolve(self, value: Any, context: Dict[str, Any]) -> Any:
        if isinstance(value, dict):
            return {k: self._resolve(v, context) for k, v in value.items()}
        if isinstance(value, list):
            return [self._resolve(v, context) for v in value]
        if isinstance(value, str):
            return render_template(value, context, json_escape=False)
        return value

    async def execute(self, context: Dict[str, Any]) -> Any:
        url = self._resolve(self.url, context).strip()
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError(f"http 节点 {self.id} 的 URL 非法：{url!r}")
        host = parsed.hostname.lower()
        loopback = host in ("127.0.0.1", "localhost", "::1")
        if host == "169.254.169.254":
            raise ValueError(f"http 节点 {self.id} 不允许访问云元数据地址")
        if not self.allow_external and not loopback:
            raise ValueError(
                f"http 节点 {self.id} 默认只允许回环地址（当前 {host}）；"
                "跨主机请显式 allow_external: true")

        headers = {str(k): str(self._resolve(v, context))
                   for k, v in (self.headers or {}).items()}
        body = self._resolve(self.body, context)
        # 凭证外发闸：平台席位 token 只许发往回环；跨主机即使显式
        # allow_external 也不得出现在 headers/body 里。
        platform_token = str(context.get("platform_api_token") or "")
        if platform_token and not loopback:
            wire = json.dumps({"headers": headers, "body": body},
                              ensure_ascii=False, default=str)
            if platform_token in wire:
                raise ValueError(
                    f"http 节点 {self.id}：非回环请求不得携带平台凭证")
        kwargs: dict = {"headers": headers,
                        "timeout": aiohttp.ClientTimeout(total=self.timeout)}
        if body is not None:
            kwargs["json"] = body
        async with _llm_session().request(self.method, url, **kwargs) as resp:
            text = await resp.text()
            if resp.status >= 400:
                detail = (f"HTTP {resp.status} - {text[:400]}")
                if self.soft:
                    return {"ok": False, "error": detail}
                raise ValueError(
                    f"http 节点 {self.id} 请求失败：{detail}")
        try:
            return json.loads(text)
        except ValueError:
            return text


class TemplateNode(WorkflowNode):
    """模板节点：渲染 {{var}} / {{var.field}} 为字符串。

    配置：template（必备）/ escape（json 缺省 | raw）/ strip_fences（布尔，
    缺省 false——LLM 代码输出整段带围栏时剥离）/ output。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.template = str(node_config.get("template") or "")
        if not self.template.strip():
            raise ValueError(f"template 节点 {self.id} 缺少 template")
        self.json_escape = str(node_config.get("escape") or "json") != "raw"
        self.strip_fences = bool(node_config.get("strip_fences", False))
        self.output_var = str(node_config.get("output") or "text").strip() \
            or "text"

    async def execute(self, context: Dict[str, Any]) -> Any:
        out = render_template(self.template, context, self.json_escape)
        if self.strip_fences:
            out = _strip_code_fences(out)
        return out


class AssertNode(WorkflowNode):
    """发布前确定性断言：不通过即 ValueError，阻断后续发布。

    配置：``require`` / ``forbid`` = 正则字符串数组；``count`` =
    ``[{"pattern": 正则, "eq": 次数}]``；``min_len`` / ``max_len``。
    本节点只读 current_value，不调用模型。典型用法 = 小游戏代码闸：
    恰好一次 Work.register、禁止 fetch/WebSocket/eval/外部 URL。
    """

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.require = [re.compile(p) for p in
                        (node_config.get("require") or [])]
        self.forbid = [re.compile(p) for p in
                       (node_config.get("forbid") or [])]
        self.counts = []
        for item in (node_config.get("count") or []):
            if not isinstance(item, dict) or not item.get("pattern"):
                raise ValueError(f"assert 节点 {self.id} 的 count 项非法")
            self.counts.append((re.compile(str(item["pattern"])),
                                int(item.get("eq", 1))))
        self.min_len = int(node_config.get("min_len") or 0)
        self.max_len = int(node_config.get("max_len") or 0)

    async def execute(self, context: Dict[str, Any]) -> Any:
        text = str(context.get("current_value") or "")
        if self.min_len and len(text) < self.min_len:
            raise ValueError(
                f"assert 节点 {self.id}：内容过短（{len(text)} < "
                f"{self.min_len}）——已阻断发布")
        if self.max_len and len(text) > self.max_len:
            raise ValueError(
                f"assert 节点 {self.id}：内容过长（{len(text)} > "
                f"{self.max_len}）——已阻断发布")
        for pattern in self.require:
            if not pattern.search(text):
                raise ValueError(
                    f"assert 节点 {self.id}：缺少必需模式 {pattern.pattern!r}"
                    "——已阻断发布")
        for pattern in self.forbid:
            if pattern.search(text):
                raise ValueError(
                    f"assert 节点 {self.id}：命中禁止模式 "
                    f"{pattern.pattern!r}——已阻断发布")
        for pattern, expected in self.counts:
            actual = len(pattern.findall(text))
            if actual != expected:
                raise ValueError(
                    f"assert 节点 {self.id}：模式 {pattern.pattern!r} 出现 "
                    f"{actual} 次（要求 {expected}）——已阻断发布")
        return text


class PermanentValidationError(Exception):
    """确定性校验失败：不重试，直接输出失败契约给 DAG。"""


class ReactNode(WorkflowNode):
    """节点内校验循环（ReAct 形）：生成 → 校验 → 失败带反馈重试。

    首次通过直接输出；失败把「上一轮输出 + 校验原因」回灌给模型重试；
    达到 max_iterations 后输出 ``{"ok":false,"error":...}`` 给 DAG，由
    branch 节点分流到失败回执，绝不把未通过校验的结果送进发布节点。

    schema：text / string_array / deck_outline / game_spec。
    builder：none / deck / game（deck 生成幻灯片数据，game 生成可运行代码）。
    """

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.schema = str(node_config.get("schema") or "text").lower()
        self.builder = str(node_config.get("builder") or "none").lower()
        self.max_iterations = max(
            1, min(5, int(node_config.get("max_iterations") or 3)))
        self.output_var = str(node_config.get("output") or "react").strip() \
            or "react"
        self.data_output = str(node_config.get("data_output") or "").strip()
        self.style = str(node_config.get("style") or "plain").lower()
        self.max_slides = int(node_config.get("max_slides") or 12)
        self.max_bullets = int(node_config.get("max_bullets") or 5)
        self.min_items = int(node_config.get("min_items") or 2)
        self.max_items = int(node_config.get("max_items") or 8)
        self.item_max_len = int(node_config.get("item_max_len") or 16)
        self.forbid = [re.compile(p) for p in (node_config.get("forbid") or [])]
        self.fallback_text = str(node_config.get("fallback_text") or
                                 "当前入口无法完成该请求，请重试或换一种描述。")
        self.reflect = bool(node_config.get("reflect", True))
        self.reflect_note = str(node_config.get("reflect_note") or "")
        self.skip_intent_guard = bool(
            node_config.get("skip_intent_guard", False))
        self.llm = LLMNode({
            "id": f"{self.id}_llm",
            "type": "llm",
            "model": node_config.get("model", 1),
            "temperature": node_config.get("temperature", 0.4),
            "max_tokens": node_config.get("max_tokens", 4096),
            "system_prompt": node_config.get("system_prompt", ""),
        })
        self.reflection_llm = LLMNode({
            "id": f"{self.id}_judge",
            "type": "llm",
            "model": node_config.get("model", 1),
            "temperature": 0.0,
            "max_tokens": 300,
            "system_prompt": _REFLECTION_PROMPT,
        })

    @staticmethod
    def _item_text(item: Any) -> str:
        if isinstance(item, dict):
            for key in ("title", "name", "text", "value", "angle"):
                if item.get(key) is not None:
                    return str(item[key]).strip()
            return ""
        return str(item).strip()

    def _norm_array(self, data: Any) -> list:
        if isinstance(data, dict):
            arrays = [v for v in data.values() if isinstance(v, list)]
            if len(arrays) == 1:
                data = arrays[0]
        if not isinstance(data, list):
            raise ValueError("期望 JSON 数组")
        values, seen = [], set()
        for item in data:
            text = self._item_text(item)[:self.item_max_len]
            if not text:
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            values.append(text)
        if len(values) < self.min_items:
            raise ValueError(
                f"数组元素不足（{len(values)} < {self.min_items}）")
        return values[:self.max_items]

    def _norm_outline(self, data: Any) -> dict:
        if not isinstance(data, dict):
            raise ValueError("大纲必须是 JSON 对象")
        title = str(data.get("title") or "").strip()[:120]
        if not title:
            raise ValueError("缺少 title")
        slides = data.get("slides")
        if not isinstance(slides, list) or not slides:
            raise ValueError("slides 必须是非空数组")
        out = []
        for i, item in enumerate(slides[:self.max_slides], 1):
            if not isinstance(item, dict):
                raise ValueError(f"第 {i} 页不是对象")
            stitle = str(item.get("title") or "").strip()[:120]
            if not stitle:
                raise ValueError(f"第 {i} 页缺少 title")
            bullets = item.get("bullets")
            if isinstance(bullets, str):
                bullets = [bullets]
            if not isinstance(bullets, list):
                raise ValueError(f"第 {i} 页 bullets 必须是数组")
            seen, clean = set(), []
            for b in bullets:
                text = str(b).strip()[:300]
                if text and text not in seen:
                    seen.add(text)
                    clean.append(text)
            if not clean:
                raise ValueError(f"第 {i} 页 bullets 为空")
            out.append({"title": stitle, "bullets": clean[:self.max_bullets]})
        return {
            "title": title,
            "subtitle": str(data.get("subtitle") or "").strip()[:240],
            "slides": out,
        }

    def _norm_game_spec(self, data: Any) -> dict:
        from .game_templates import normalize_spec

        if not isinstance(data, dict):
            raise ValueError("游戏 spec 必须是 JSON 对象")
        genre = str(data.get("genre") or "").strip().lower()
        if genre not in ("catch", "snake", "breakout", "gomoku"):
            raise ValueError("genre 必须是 catch / snake / breakout / gomoku")
        if not str(data.get("title") or "").strip():
            raise ValueError("缺少 title")
        for key in ("bg", "fg", "accent"):
            if not _HEX_COLOR.fullmatch(str(data.get(key) or "")):
                raise ValueError(f"{key} 必须是 #rrggbb")
        return normalize_spec(data)

    @staticmethod
    def _validate_game_code(code: str) -> None:
        # 迭代元数据注释不参与代码安全闸。
        clean = re.sub(r"(?m)^// __BOARD_SPEC__.*\n?", "", code)
        if not (200 <= len(clean) <= 200_000):
            raise ValueError(f"代码长度异常（{len(clean)}）")
        if len(re.findall(r"Work\.register\s*\(", clean)) != 1:
            raise ValueError("必须恰好一次 Work.register")
        for pattern in (r"\bfetch\s*\(", r"\bXMLHttpRequest\b",
                        r"\bWebSocket\b", r"\beval\s*\(",
                        r"\bnew\s+Function\b", r"\bimport\s*\(",
                        r"https?://"):
            if re.search(pattern, clean):
                raise ValueError(f"代码命中禁止模式：{pattern}")

    @staticmethod
    def _game_intent(text: str) -> "tuple[str, str]":
        """游戏需求预检：返回 (genre_hint, permanent_error)。

        先挡掉“改已有作品 / 不支持的类型 / 非游戏请求”，避免模型把
        围棋、塔防、跳跳龙都做成接物游戏，也避免把修改请求当成新建。"""
        text = str(text or "").strip()
        if not text:
            return "", "消息为空，请描述想做的游戏类型与玩法"
        if re.search(r"(WORKS[-\s]?\d+|\b\d{3,7}\b)", text, re.I) and re.search(
                r"(加入|修改|改成|增加|删掉|调整|迭代|更新|加个|加一个|换成)",
                text):
            return "", ("当前只支持新建小游戏；修改已有作品暂不支持。"
                        "请把要改的规则/玩法描述成一条新的游戏需求。")
        known = (("五子棋", "gomoku"), ("贪吃蛇", "snake"),
                 ("打砖块", "breakout"), ("砖块", "breakout"),
                 ("接住", "catch"), ("接星星", "catch"), ("接物", "catch"))
        hint = ""
        for keyword, genre in known:
            if keyword in text:
                hint = genre
                break
        unsupported = ("围棋", "象棋", "井字棋", "塔防", "跳跳龙", "飞机",
                       "坦克", "赛车", "跑酷", "消除", "消消乐",
                       "俄罗斯方块", "我的世界", "斗地主", "麻将", "扑克",
                       "拼图")
        for keyword in unsupported:
            if keyword in text:
                return "", (f"当前只支持 catch（接物/躲避）/ snake（贪吃蛇）"
                            f"/ breakout（打砖块）/ gomoku（五子棋）；"
                            f"暂不支持「{keyword}」。")
        if not any(k in text for k in ("游戏", "玩", "接", "打", "棋", "蛇",
                                       "砖", "星星", "躲避", "闯关", "对战")):
            return "", ("这条消息不像小游戏需求。请描述想做的游戏类型与玩法，"
                        "例如「做一个五子棋」「做一个贪吃蛇」。")
        return hint, ""

    @staticmethod
    def _explicit_unsupported(text: str) -> str:
        """明确不支持的棋类硬兜底（不参与新建/迭代判断，只防误生成）。"""
        for keyword in ("国际象棋", "中国象棋", "象棋", "围棋", "军棋",
                        "斗兽棋", "飞行棋", "将棋"):
            if keyword in str(text or ""):
                return keyword
        return ""

    @staticmethod
    def _board_intent(text: str) -> "tuple[str, str, str]":
        """棋类需求预检：返回 (genre_hint, mode_hint, permanent_error)。

        只接受五子棋/井字棋/四子棋/黑白棋；围棋、象棋、跳棋等明确拒绝；
        贪吃蛇/打砖块等非棋类也拒绝；改已有棋局暂不支持。"""
        text = str(text or "").strip()
        if not text:
            return "", "", "消息为空，请说明想下的棋类"
        if re.search(r"(WORKS[-\s]?\d+|\b\d{3,7}\b)", text, re.I) and re.search(
                r"(加入|修改|改成|增加|删掉|调整|迭代|更新|加个|加一个|换成)",
                text):
            return "", "", ("当前只支持新建棋局；修改已有棋局暂不支持。"
                            "请把要改的规则描述成一条新的棋类需求。")
        known = (("五子棋", "gomoku"), ("六子棋", "connect6"),
                 ("六连棋", "connect6"), ("井字棋", "tictactoe"),
                 ("井字", "tictactoe"), ("四子棋", "connect4"),
                 ("四连棋", "connect4"), ("黑白棋", "reversi"),
                 ("奥赛罗", "reversi"), ("翻转棋", "reversi"),
                 ("点格棋", "dotsandboxes"), ("点格", "dotsandboxes"),
                 ("六角棋", "hex"), ("hex", "hex"),
                 ("跳棋", "checkers"), ("国际跳棋", "checkers"),
                 ("西洋跳棋", "checkers"))
        hint = ""
        for keyword, genre in known:
            if keyword in text.lower():
                hint = genre
                break
        unsupported = ("围棋", "国际象棋", "中国象棋", "象棋",
                       "军棋", "斗兽棋", "飞行棋", "将棋")
        for keyword in unsupported:
            if keyword in text:
                return "", "", (f"本席位只支持棋类：五子棋 / 井字棋 / "
                                f"四子棋 / 黑白棋；暂不支持「{keyword}」。")
        non_board = ("贪吃蛇", "打砖块", "接星星", "接住", "跑酷", "塔防",
                     "飞机", "坦克", "消除", "俄罗斯方块", "我的世界",
                     "沙盒", "射击", "接物")
        for keyword in non_board:
            if keyword in text:
                return "", "", (f"本席位只做棋类（五子棋/井字棋/四子棋/"
                                f"黑白棋）；「{keyword}」不是棋类。")
        if not hint and "棋" not in text:
            return "", "", ("请说明想下的棋类：五子棋 / 井字棋 / 四子棋 / "
                            "黑白棋。")
        mode_hint = ""
        if any(k in text for k in ("人机", "AI", "电脑", "单机")):
            mode_hint = "ai"
        elif any(k in text for k in ("双人", "同屏", "两人")):
            mode_hint = "pvp"
        return hint, mode_hint, ""

    def _norm_board_spec(self, data: Any) -> dict:
        from .board_templates import normalize_spec as normalize_board_spec

        if not isinstance(data, dict):
            raise ValueError("棋类 spec 必须是 JSON 对象")
        genre = str(data.get("genre") or "").strip().lower()
        if genre not in ("gomoku", "tictactoe", "connect4", "reversi",
                         "connect6", "dotsandboxes", "hex", "checkers"):
            raise ValueError(
                "genre 必须是 gomoku / tictactoe / connect4 / reversi / "
                "connect6 / dotsandboxes / hex / checkers")
        if not str(data.get("title") or "").strip():
            raise ValueError("缺少 title")
        for key in ("bg", "fg", "accent"):
            if not _HEX_COLOR.fullmatch(str(data.get(key) or "")):
                raise ValueError(f"{key} 必须是 #rrggbb")
        return normalize_board_spec(data)

    def _norm_intent(self, data: Any) -> dict:
        if not isinstance(data, dict):
            raise ValueError("意图必须是 JSON 对象")
        action = str(data.get("action") or "").strip().lower()
        if action not in ("create", "iterate", "chat", "unsupported"):
            raise ValueError("action 必须是 create / iterate / chat / unsupported")
        target = str(data.get("target_ref") or "").strip().upper()
        if target:
            m = re.search(r"(?:WORKS[-\s]?)?(\d{1,9})", target)
            target = f"WORKS-{int(m.group(1))}" if m else ""
        if action == "iterate" and not target:
            raise ValueError("迭代请求必须带作品编号（如 WORKS-3831 / 3831）")
        genre = str(data.get("genre") or "").strip().lower()
        if genre and genre not in ("gomoku", "tictactoe", "connect4",
                                   "reversi", "connect6", "dotsandboxes",
                                   "hex", "checkers"):
            raise ValueError(f"genre 不在支持列表：{genre}")
        if action == "create" and not genre:
            raise ValueError("新建请求必须识别棋种（gomoku/.../checkers）")
        mode = "ai" if str(data.get("mode") or "").lower() == "ai" else "pvp"
        return {
            "action": action,
            "target_ref": target,
            "genre": genre,
            "mode": mode,
            "requirements": str(data.get("requirements") or "").strip()[:300],
            "reason": str(data.get("reason") or "").strip()[:200],
        }

    async def _reflect(self, context: Dict[str, Any],
                       candidate: str) -> None:
        """反思审查：候选结果是否真正满足用户原始请求。

        通过 = 返回 None；不通过 = ValueError（由外层捕获并带原因重试）。
        审查调用低温、短输出，只做判断，不重写结果。"""
        if not self.reflect:
            return
        user_request = str(
            context.get("input") or context.get("current_value") or "")
        prompt = ("【用户原始请求】\n" + user_request +
                  "\n\n【候选结果】\n" + candidate)
        if self.reflect_note:
            prompt += "\n\n【席位边界】\n" + self.reflect_note
        judge_ctx = dict(context)
        judge_ctx["current_value"] = prompt
        raw = await self.reflection_llm.execute(judge_ctx)
        try:
            data = _extract_json_value(raw)
        except ValueError as exc:
            raise ValueError(f"反思审查输出无法解析：{exc}") from exc
        if not isinstance(data, dict) or "ok" not in data:
            raise ValueError("反思审查输出缺少 ok")
        if not bool(data.get("ok")):
            reason = str(data.get("reason") or "结果与用户请求不一致")[:160]
            raise ValueError(f"反思未通过：{reason}")

    async def execute(self, context: Dict[str, Any]) -> Any:
        base = str(context.get("current_value") or "")
        hint, mode_hint = "", ""
        if self.schema == "intent":
            bad = self._explicit_unsupported(base)
            if bad:
                data = {
                    "action": "unsupported", "target_ref": "",
                    "genre": "", "mode": "pvp", "requirements": "",
                    "reason": (f"暂不支持「{bad}」；当前支持五子棋/井字棋/"
                               "四子棋/黑白棋/六子棋/点格棋/六角棋/跳棋。"),
                }
                return json.dumps({"ok": True, "data": data},
                                  ensure_ascii=False)
        if self.schema == "game_spec":
            hint, err = self._game_intent(base)
            if err:
                return json.dumps({"ok": False, "error": err},
                                  ensure_ascii=False)
        elif self.schema == "board_spec":
            if not self.skip_intent_guard:
                hint, mode_hint, err = self._board_intent(base)
                if err:
                    return json.dumps({"ok": False, "error": err},
                                      ensure_ascii=False)
            else:
                intent = (context.get("variables") or {}).get("intent")
                try:
                    idata = (_extract_json_value(intent)
                             if isinstance(intent, str) else intent)
                except ValueError:
                    idata = {}
                data = (idata.get("data")
                        if isinstance(idata, dict) else {}) or {}
                hint = str(data.get("genre") or "")
                mode_hint = str(data.get("mode") or "")
        last_raw, last_error = "", ""
        for attempt in range(1, self.max_iterations + 1):
            prompt = base if attempt == 1 else (
                base + "\n\n【上一轮输出】\n" + last_raw +
                "\n\n【校验/反思未通过】\n" + last_error +
                "\n\n请修正后重新输出；只输出要求的内容，不要解释。")
            attempt_ctx = dict(context)
            attempt_ctx["current_value"] = prompt
            raw = await self.llm.execute(attempt_ctx)
            last_raw = str(raw or "")
            try:
                if self.schema == "text":
                    if not last_raw.strip():
                        raise ValueError("输出为空")
                    for pattern in self.forbid:
                        if pattern.search(last_raw):
                            raise ValueError(
                                f"命中禁止表述：{pattern.pattern}")
                    await self._reflect(context, last_raw)
                    if self.data_output:
                        context.setdefault("variables", {})[
                            self.data_output] = last_raw
                    return json.dumps({"ok": True, "data": last_raw},
                                      ensure_ascii=False)
                if self.schema == "string_array":
                    values = self._norm_array(_extract_json_value(last_raw))
                    await self._reflect(
                        context, json.dumps(values, ensure_ascii=False))
                    if self.data_output:
                        context.setdefault("variables", {})[
                            self.data_output] = json.dumps(
                                values, ensure_ascii=False)
                    return json.dumps({"ok": True, "data": values},
                                      ensure_ascii=False)
                if self.schema == "deck_outline":
                    outline = self._norm_outline(
                        _extract_json_value(last_raw))
                    await self._reflect(
                        context, json.dumps(outline, ensure_ascii=False))
                    deck_json = await DeckNode({
                        "id": f"{self.id}_deck", "type": "deck",
                        "style": self.style,
                        "max_slides": self.max_slides,
                        "max_bullets": self.max_bullets,
                        "honor_input_pages": True,
                    }).execute({
                        "current_value": json.dumps(outline,
                                                    ensure_ascii=False),
                        "input": context.get("input"),
                        "variables": context.get("variables"),
                    })
                    context.setdefault("variables", {})["slides"] = deck_json
                    return json.dumps({"ok": True, "data": outline,
                                       "deck": deck_json},
                                      ensure_ascii=False)
                if self.schema == "game_spec":
                    spec = self._norm_game_spec(
                        _extract_json_value(last_raw))
                    if hint and spec.get("genre") != hint:
                        raise ValueError(
                            f"用户要求的是 {hint}，但 spec.genre="
                            f"{spec.get('genre')}；请按用户需求选择 genre")
                    await self._reflect(
                        context, json.dumps(spec, ensure_ascii=False))
                    code = build_game_code(spec)
                    self._validate_game_code(code)
                    context.setdefault("variables", {})["game_code"] = code
                    return json.dumps({"ok": True, "data": spec,
                                       "code": code},
                                      ensure_ascii=False)
                if self.schema == "intent":
                    data = self._norm_intent(
                        _extract_json_value(last_raw))
                    await self._reflect(
                        context, json.dumps(data, ensure_ascii=False))
                    return json.dumps({"ok": True, "data": data},
                                      ensure_ascii=False)
                if self.schema == "board_update":
                    spec = self._norm_board_spec(
                        _extract_json_value(last_raw))
                    await self._reflect(
                        context, json.dumps(spec, ensure_ascii=False))
                    code = build_board_game_code(spec)
                    self._validate_game_code(code)
                    context.setdefault("variables", {})["game_code"] = code
                    return json.dumps({"ok": True, "data": spec,
                                       "code": code},
                                      ensure_ascii=False)
                if self.schema == "board_spec":
                    spec = self._norm_board_spec(
                        _extract_json_value(last_raw))
                    if hint and spec.get("genre") != hint:
                        raise ValueError(
                            f"用户要求的是 {hint}，但 spec.genre="
                            f"{spec.get('genre')}；请按用户需求选择棋种")
                    if mode_hint and spec.get("mode") != mode_hint:
                        raise ValueError(
                            f"用户要求 {mode_hint} 模式，但 spec.mode="
                            f"{spec.get('mode')}；请按用户需求选择模式")
                    await self._reflect(
                        context, json.dumps(spec, ensure_ascii=False))
                    code = build_board_game_code(spec)
                    self._validate_game_code(code)
                    context.setdefault("variables", {})["game_code"] = code
                    return json.dumps({"ok": True, "data": spec,
                                       "code": code},
                                      ensure_ascii=False)
                raise ValueError(f"未知 schema：{self.schema}")
            except Exception as exc:  # noqa: BLE001 — 校验失败进入下一轮
                last_error = str(exc)
                continue
        error = last_error or "校验未通过"
        if self.schema == "text":
            error = self.fallback_text + (
                f"（{last_error}）" if last_error else "")
        return json.dumps({"ok": False, "error": error},
                          ensure_ascii=False)


class BranchNode(WorkflowNode):
    """分支节点：读一个 JSON 变量的布尔路径，返回 ok / fail。

    引擎对 branch 与 function 同待遇：返回值用于条件边，但不覆盖
    current_value——成功产物仍原样留给下游节点。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.source = str(node_config.get("source") or "").strip()
        raw_path = node_config.get("path")
        self.path = ("ok" if raw_path is None
                     else str(raw_path).strip())
        self.checks = node_config.get("checks") or []

    async def execute(self, context: Dict[str, Any]) -> Any:
        raw = (context.get("variables") or {}).get(self.source)
        if raw is None:
            raw = context.get("current_value")
        try:
            data = _extract_json_value(raw) if isinstance(raw, str) else raw
        except ValueError:
            return "fail"
        if self.checks:
            for chk in self.checks:
                if not isinstance(chk, dict):
                    continue
                value = data
                path = str(chk.get("path") or "").strip()
                if path:
                    for part in path.split("."):
                        if isinstance(value, dict):
                            value = value.get(part)
                        else:
                            value = None
                        if value is None:
                            break
                if value == chk.get("equals"):
                    return "ok"
            return "fail"
        if not self.path:
            return "ok" if bool(data) else "fail"
        value = data
        for part in self.path.split("."):
            if isinstance(value, dict):
                value = value.get(part)
            else:
                value = None
            if value is None:
                return "fail"
        return "ok" if bool(value) else "fail"


class GameNode(WorkflowNode):
    """游戏 spec → 完整可运行 Work.register 代码（确定性生成）。

    spec = JSON 对象：genre（catch/snake/breakout）/ title / bg / fg /
    accent / speed / target / labels / instructions。模型只做策划决策；
    入口、循环、输入、计分、重开、清理全部由模板生成。spec 不是合法
    JSON 时响亮失败，不静默生成错类型游戏。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.output_var = str(node_config.get("output") or "game_code").strip() \
            or "game_code"

    async def execute(self, context: Dict[str, Any]) -> Any:
        try:
            spec = _extract_json_value(context.get("current_value"))
        except ValueError as exc:
            raise ValueError(
                f"game 节点 {self.id}：游戏 spec 不是合法 JSON"
                f"（{exc}）——已阻断发布") from exc
        if not isinstance(spec, dict):
            raise ValueError(
                f"game 节点 {self.id}：游戏 spec 必须是 JSON 对象")
        return build_game_code(spec)


class JsonNode(WorkflowNode):
    """JSON 归一化节点：从模型输出抽取 JSON，按类型/数量/长度收敛。

    配置：``kind`` = array（缺省）/ object / any；``path`` = 可选键路径；
    ``min_items`` / ``max_items`` / ``item_max_len`` / ``dedupe``。
    array 形态把元素转成字符串（对象元素取 title/name/text/value），
    去重后截断。输出恒为 JSON 文本。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.kind = str(node_config.get("kind") or "array").lower()
        self.path = str(node_config.get("path") or "").strip()
        self.min_items = int(node_config.get("min_items") or 1)
        self.max_items = int(node_config.get("max_items") or 12)
        self.item_max_len = int(node_config.get("item_max_len") or 60)
        self.dedupe = bool(node_config.get("dedupe", True))
        self.output_var = str(node_config.get("output") or "json").strip() \
            or "json"

    @staticmethod
    def _item_text(item: Any) -> str:
        if isinstance(item, dict):
            for key in ("title", "name", "text", "value", "angle"):
                if item.get(key) is not None:
                    return str(item[key]).strip()
            return ""
        return str(item).strip()

    async def execute(self, context: Dict[str, Any]) -> Any:
        data = _extract_json_value(context.get("current_value"))
        if self.path:
            for part in self.path.split("."):
                if isinstance(data, dict):
                    data = data.get(part)
                else:
                    data = None
                if data is None:
                    raise ValueError(
                        f"json 节点 {self.id}：路径 {self.path!r} 不存在")
        if self.kind == "array" and isinstance(data, dict):
            # 容忍 {"angles": [...]} / {"items": [...]} 单数组包裹。
            arrays = [v for v in data.values() if isinstance(v, list)]
            if len(arrays) == 1:
                data = arrays[0]
        if self.kind == "array":
            if not isinstance(data, list):
                raise ValueError(
                    f"json 节点 {self.id}：期望数组，实际 {type(data).__name__}")
            values, seen = [], set()
            for item in data:
                text = self._item_text(item)[:self.item_max_len]
                if not text:
                    continue
                key = text.lower()
                if self.dedupe and key in seen:
                    continue
                seen.add(key)
                values.append(text)
            if len(values) < self.min_items:
                raise ValueError(
                    f"json 节点 {self.id}：数组元素不足（{len(values)} < "
                    f"{self.min_items}）")
            data = values[:self.max_items]
        elif self.kind == "object":
            if not isinstance(data, dict):
                raise ValueError(
                    f"json 节点 {self.id}：期望对象，实际 {type(data).__name__}")
        if self.kind == "any" and isinstance(data, str):
            return data
        return json.dumps(data, ensure_ascii=False)


class RegexNode(WorkflowNode):
    """正则抽取节点：从 current_value 文本里取捕获组（迭代元数据用）。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        pattern = str(node_config.get("pattern") or "")
        if not pattern:
            raise ValueError(f"regex 节点 {self.id} 缺少 pattern")
        self.pattern = re.compile(pattern, re.M)
        self.group = int(node_config.get("group") or 1)
        self.required = bool(node_config.get("required", True))
        self.output_var = str(node_config.get("output") or "match").strip() \
            or "match"

    async def execute(self, context: Dict[str, Any]) -> Any:
        text = str(context.get("current_value") or "")
        m = self.pattern.search(text)
        if not m:
            if self.required:
                raise ValueError(
                    f"regex 节点 {self.id} 未匹配：{self.pattern.pattern!r}")
            return ""
        try:
            return m.group(self.group)
        except IndexError:
            return m.group(0)


class RAGNode(WorkflowNode):
    """RAG (Retrieval-Augmented Generation) 节点 —— 已失效，执行即显式报错

    原设计（2026-10-21）：经主仓 services.workflow_react_functions 检索
    知识库相似案例增强生成。2026-10-26 RAG/ReAct 实验批已整体迁出主仓
    （workplace/rag-lab，与主站运行时零耦合，ChromaDB 知识库待重建），
    本节点不再有可达实现；如需恢复请在 rag-lab 重建知识库后另行接线。
    """
    
    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.function = node_config.get("function", "search_cases")
        self.args = node_config.get("args", {})
    
    async def execute(self, context: Dict[str, Any]) -> Any:
        # 依赖已随 2026-10-26 实验批迁出主仓（见类 docstring）——显式失败，
        # 不再尝试跨仓 import，也不软兜底吞错。
        raise ValueError(
            f"rag 节点 {self.id} 不可用：RAG/ReAct 实验已于 2026-10-26 迁至 "
            "workplace/rag-lab（与主站运行时零耦合，向量库待重建）；"
            "如需恢复请在 rag-lab 重建知识库后另行接线")


class SwitchNode(WorkflowNode):
    """值分派节点：读 JSON 变量的字符串路径，返回值用于条件边。

    与 branch/function 同待遇：不覆盖 current_value，只作为决策值。
    ``default`` 在路径缺失时返回（缺省 fail）。"""

    def __init__(self, node_config: Dict[str, Any]):
        super().__init__(node_config)
        self.source = str(node_config.get("source") or "").strip()
        self.path = str(node_config.get("path") or "").strip()
        self.default = str(node_config.get("default") or "fail")

    async def execute(self, context: Dict[str, Any]) -> Any:
        raw = (context.get("variables") or {}).get(self.source)
        if raw is None:
            raw = context.get("current_value")
        try:
            data = _extract_json_value(raw) if isinstance(raw, str) else raw
        except ValueError:
            return self.default
        value = data
        if self.path:
            for part in self.path.split("."):
                if isinstance(value, dict):
                    value = value.get(part)
                else:
                    value = None
                if value is None:
                    return self.default
        return str(value) if value is not None else self.default


def create_node(node_config: Dict[str, Any]) -> WorkflowNode:
    """创建节点实例"""
    node_type = node_config.get("type")

    if node_type == "input":
        return InputNode(node_config)
    elif node_type == "output":
        return OutputNode(node_config)
    elif node_type == "function":
        return FunctionNode(node_config)
    elif node_type == "llm":
        return LLMNode(node_config)
    elif node_type == "agent":
        return AgentNode(node_config)
    elif node_type == "ticket":
        return TicketNode(node_config)
    elif node_type == "emit":
        return EmitNode(node_config)
    elif node_type == "slot":
        return SlotNode(node_config)
    elif node_type == "deck":
        return DeckNode(node_config)
    elif node_type == "http":
        return HttpNode(node_config)
    elif node_type == "template":
        return TemplateNode(node_config)
    elif node_type == "assert":
        return AssertNode(node_config)
    elif node_type == "json":
        return JsonNode(node_config)
    elif node_type == "game":
        return GameNode(node_config)
    elif node_type == "react":
        return ReactNode(node_config)
    elif node_type == "rag":
        return RAGNode(node_config)
    elif node_type == "branch":
        return BranchNode(node_config)
    elif node_type == "regex":
        return RegexNode(node_config)
    elif node_type == "switch":
        return SwitchNode(node_config)
    else:
        raise ValueError(f"未知节点类型: {node_type}")
