"""canvas_kernel —— 统一引擎的画布内核 [dsh 统一引擎 2026-11-01]

执行 Flow 画布形 DSL（pyfunc 语义）：并行超步调度、when 守卫、state 总线、
ctx.fan 动态扇出。对齐目标 = flow-editor/flow-standalone/docs/dsl-semantics.md
（v3 · 引擎对齐契约）§15 硬契约清单；声明式词汇（8301）仍走原 engine.py——
统一入口按方言路由，两内核并存逐步收敛。

本模块为 dsh 新增（非上游改动）；真源语义 = 上画布规范文档，实现自由面
（内部调度模型）按规范允许自定。

已对齐（本切片）：
  净形载荷 + 保存形容忍（x/y/tag/color/groups 忽略）；伪端点转译
  （__canvas_in/out → 虚拟 __canvas_entry/__canvas_exit）；隐式出口（末端
  节点承接）；并行分支真并发 + join；when 守卫（白名单 eval/快照语义/
  多命中并行/全不命中显式报错）；并行写闸（编译期）；reducer
  （append 累加 / overwrite 末写）；pyfunc 三签名分派；state 只读快照
  （就地写不落通道）；返回 dict = 多字段产出包；None = 不写通道；ctx =
  {args, llm, node, fan}；print 按节点捕获（≤200 行）；catch 错误出口键；
  步数 50；墙钟 300s；节点级 trace。

待对齐（后续切片，按 §15 清单推进）：
  ctx.llm 的 images 归一（当前传 images 点名不支持）；token usage 聚合；
  保存通道独立 validate 端点形态；遗留类型（v2 词汇）读取。
"""
import asyncio
import io
import json
import re
import threading
import time
from contextlib import redirect_stdout
from typing import Any, Dict, List, Optional, Tuple

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

# ---- 限额（§12） ----
LIMIT_NODES = 300
LIMIT_EDGES = 800
LIMIT_STATE_KEYS = 50
LIMIT_NODE_ID = 40
LIMIT_CODE = 20000
LIMIT_WHEN = 200
LIMIT_QUESTION = 2000
LIMIT_STDOUT_LINES = 200
STEP_LIMIT = 50          # 节点执行次数
WALL_CLOCK_S = 300.0     # 单 run 墙钟

_WHEN_BUILTINS = {"len": len, "abs": abs, "min": min, "max": max,
                  "str": str, "int": int, "float": float, "bool": bool,
                  "True": True, "False": False}


class CanvasError(Exception):
    """画布内核错误：defect = 机器码（对齐 §13 风格），message 点名可操作信息。"""

    def __init__(self, defect: str, message: str):
        super().__init__(message)
        self.defect = defect
        self.message = message


# ---- 载荷装载与方言识别 ----

_DOC_CACHE: "Dict[str, Any]" = {}
_DOC_CACHE_MAX = 256


def load_canvas_doc(text: str) -> Any:
    """yaml/json 装载（带缓存）；非映射返回 None 交回声明式路径。"""
    hit = _DOC_CACHE.get(text)
    if hit is not None:
        return hit
    try:
        doc = yaml.safe_load(text)
    except Exception:
        doc = None
    if len(_DOC_CACHE) >= _DOC_CACHE_MAX:
        _DOC_CACHE.pop(next(iter(_DOC_CACHE)))
    _DOC_CACHE[text] = doc
    return doc


def is_canvas_doc(doc: Any) -> bool:
    """方言识别：pyfunc 节点 / when 守卫边 / 画布伪端点，任一在场即画布形。"""
    if not isinstance(doc, dict):
        return False
    nodes = doc.get("nodes") or []
    edges = doc.get("edges") or []
    if any(isinstance(n, dict) and n.get("type") == "pyfunc" for n in nodes):
        return True
    for e in edges:
        if not isinstance(e, dict):
            continue
        if e.get("from") in ("__canvas_in", "__canvas_out") \
                or e.get("to") in ("__canvas_in", "__canvas_out"):
            return True
        if isinstance(e.get("when"), str) and e.get("when").strip():
            return True
    return False


# ---- 编译期（转译 + 校验 + 写闸） ----

class _Compiled:
    __slots__ = ("doc", "nodes", "edges", "entry", "exit_id", "answer_template",
                 "reducers", "entry_edge_sources", "state_decls")

    def __init__(self):
        self.doc: dict = {}
        self.nodes: Dict[str, dict] = {}
        self.edges: List[dict] = []
        self.entry: Optional[str] = None
        self.exit_id: Optional[str] = None
        self.answer_template: str = ""
        self.reducers: Dict[str, str] = {}
        self.state_decls: List[str] = []


def compile_canvas(doc: Any, question: str = "") -> _Compiled:
    """转译 + 校验（§10/§13）。错误以 CanvasError(defect, message) 抛出。"""
    c = _Compiled()
    if not isinstance(doc, dict):
        raise CanvasError("bad_shape", "工作流载荷必须是对象")
    if doc.get("v") not in (3, None) and not doc.get("nodes"):
        raise CanvasError("bad_shape", f"不支持的 DSL 版本 v={doc.get('v')!r}（画布形 v3）")

    raw_nodes = doc.get("nodes")
    raw_edges = doc.get("edges")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise CanvasError("empty_nodes", "工作流没有节点")
    if len(raw_nodes) > LIMIT_NODES:
        raise CanvasError("too_many_nodes", f"节点数 {len(raw_nodes)} 超限额 {LIMIT_NODES}")
    if not isinstance(raw_edges, list):
        raise CanvasError("bad_shape", "edges 必须是数组")
    if len(raw_edges) > LIMIT_EDGES:
        raise CanvasError("too_many_edges", f"边数 {len(raw_edges)} 超限额 {LIMIT_EDGES}")

    state_decls = doc.get("state")
    if state_decls is None:
        state_decls = []
    if not isinstance(state_decls, list):
        raise CanvasError("bad_state", "state 必须是数组")
    if len(state_decls) > LIMIT_STATE_KEYS:
        raise CanvasError("too_many_state_keys",
                          f"state 声明 {len(state_decls)} 项超限额 {LIMIT_STATE_KEYS}")
    for item in state_decls:
        if not isinstance(item, dict) or not str(item.get("key") or "").strip():
            raise CanvasError("bad_state", f"state 声明项非法: {item!r}")
        key = str(item["key"]).strip()
        if key in ("question", "history") or key.startswith("_"):
            raise CanvasError("reserved_state_key", f"state 键 {key!r} 是保留键，不得声明")
        reducer = item.get("reducer") or "overwrite"
        if reducer not in ("overwrite", "append"):
            raise CanvasError("bad_reducer", f"state 键 {key!r} reducer 非法: {reducer!r}")
        if key in c.reducers:
            raise CanvasError("dup_state_key", f"state 键 {key!r} 重复声明")
        c.reducers[key] = reducer
        c.state_decls.append(key)

    # 保存形容忍：剥 x/y/tag/color/groups（呈现字段不参与执行）
    for n in raw_nodes:
        if not isinstance(n, dict):
            raise CanvasError("bad_node", f"节点项非法: {n!r}")
        nid = str(n.get("id") or "")
        if not nid:
            raise CanvasError("bad_node", "节点缺 id")
        if len(nid) > LIMIT_NODE_ID:
            raise CanvasError("bad_node", f"节点 id 超 {LIMIT_NODE_ID} 字: {nid!r}")
        if nid in ("__canvas_in", "__canvas_out"):
            raise CanvasError("bad_node", f"{nid} 是世界伪端点，不得作为真实节点 id")
        if nid in c.nodes:
            raise CanvasError("dup_node_id", f"节点 id 重复: {nid!r}")
        ntype = str(n.get("type") or "").strip()
        if ntype == "pyfunc":
            code = n.get("code")
            if not isinstance(code, str) or not code.strip():
                raise CanvasError("missing_code", f"pyfunc 节点 {nid!r} 缺 code")
            if len(code) > LIMIT_CODE:
                raise CanvasError("code_too_long",
                                  f"pyfunc 节点 {nid!r} code 超 {LIMIT_CODE} 字")
            import ast
            try:
                tree = ast.parse(code, f"<pyfunc {nid}>", "exec")
            except SyntaxError as e:
                raise CanvasError("bad_code",
                                  f"pyfunc 节点 {nid!r} 代码语法错误（第 {e.lineno} 行）: {e.msg}")
            fns = [x.name for x in ast.walk(tree) if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef))]
            if "fn" not in fns:
                raise CanvasError("missing_fn", f"pyfunc 节点 {nid!r} 顶层须定义 fn")
            out_key = n.get("output")
            if out_key is not None:
                out_key = str(out_key).strip()
                if not out_key:
                    raise CanvasError("bad_output_key", f"pyfunc 节点 {nid!r} output 为空串")
                if out_key in ("question", "history") or out_key.startswith("_"):
                    raise CanvasError("bad_output_key",
                                      f"pyfunc 节点 {nid!r} output {out_key!r} 是保留键")
            catch_key = n.get("catch")
            if catch_key is not None:
                catch_key = str(catch_key).strip()
                if not catch_key or catch_key == (out_key or "last") or catch_key.startswith("_"):
                    raise CanvasError("bad_output_key",
                                      f"pyfunc 节点 {nid!r} catch {catch_key!r} 非法"
                                      "（不得为空/与 output 同键/_ 前缀）")
            args_decl = n.get("args")
            if args_decl is not None and not isinstance(args_decl, dict):
                raise CanvasError("bad_node", f"pyfunc 节点 {nid!r} args 必须是对象")
        elif ntype in ("input", "output"):
            pass  # 真实 input/output 节点：转译层识别（§10）
        else:
            raise CanvasError("bad_node_type",
                              f"节点 {nid!r} 类型 {ntype!r} 不在画布内核词汇"
                              "（pyfunc/input/output）；声明式节点请走声明式方言")
        clean = {k: n[k] for k in ("id", "type", "code", "output", "catch", "args")
                 if k in n}
        c.nodes[nid] = clean

    # 边校验
    seen_pairs: Dict[Tuple[str, str], Optional[str]] = {}
    for e in raw_edges:
        if not isinstance(e, dict):
            raise CanvasError("bad_edge", f"边项非法: {e!r}")
        src, dst = e.get("from"), e.get("to")
        src_ok = src in c.nodes or src == "__canvas_in"
        dst_ok = dst in c.nodes or dst == "__canvas_out"
        if not src_ok or not dst_ok:
            missing = src if not src_ok else dst
            raise CanvasError("edge_endpoint_missing", f"边 {src!r}→{dst!r} 端点未声明: {missing!r}")
        if src == dst:
            raise CanvasError("self_edge", f"自环边被禁: {src!r}")
        if src == "__canvas_out" or dst == "__canvas_in":
            raise CanvasError("edge_direction_reversed",
                              f"边界边方向反了: {src!r}→{dst!r}（__canvas_in 只作起点，__canvas_out 只作终点）")
        when = e.get("when")
        if when is not None:
            when = str(when).strip()
            if when:
                if len(when) > LIMIT_WHEN or "__" in when or "\n" in when:
                    raise CanvasError("bad_when",
                                      f"when 表达式非法（≤{LIMIT_WHEN} 字/单行/无 __）: {when!r}")
                try:
                    compile(when, "<when>", "eval")
                except SyntaxError as err:
                    raise CanvasError("bad_when", f"when 表达式编译失败 {when!r}: {err.msg}")
                if src in ("__canvas_in",) or dst in ("__canvas_out",):
                    raise CanvasError("bad_when", "when 守卫只允许真实节点↔真实节点的边")
        else:
            when = ""
        key = (src, dst)
        if key in seen_pairs:
            if (seen_pairs[key] or "") != when:
                raise CanvasError("dup_when_edge",
                                  f"重复边 {src!r}→{dst!r} 携带不同 when，拒绝（防去重静默丢守卫）")
            continue  # 同 when 重复边去重（保序）
        seen_pairs[key] = when or None
        c.edges.append({"from": src, "to": dst, "when": when})

    # 转译 §10：虚拟入口/出口
    has_real_input = any(n.get("type") == "input" for n in c.nodes.values())
    has_in_boundary = any(e["from"] == "__canvas_in" for e in c.edges)
    has_out_boundary = any(e["to"] == "__canvas_out" for e in c.edges)
    if has_real_input and has_in_boundary:
        raise CanvasError("bad_edge", "真实 input 节点与 __canvas_in 边界边并存，无法转译")
    if has_in_boundary:
        c.nodes["__canvas_entry"] = {"id": "__canvas_entry", "type": "input",
                                     "output": "last"}
        for e in c.edges:
            if e["from"] == "__canvas_in":
                e["from"] = "__canvas_entry"
    elif not has_real_input:
        raise CanvasError("input_missing", "图里没有真实 input 节点也没有 __canvas_in 边界入")

    if has_out_boundary:
        sources = []
        for e in c.edges:
            if e["to"] == "__canvas_out":
                if e["from"] not in c.nodes:
                    raise CanvasError("edge_endpoint_missing",
                                      f"边界出边来源未声明: {e['from']!r}")
                sources.append(e["from"])
        if not sources:
            raise CanvasError("output_missing", "__canvas_out 边界出存在但无有效来源")
        exit_id = "__canvas_exit"
        c.nodes[exit_id] = {"id": exit_id, "type": "output"}
        for e in c.edges:
            if e["to"] == "__canvas_out":
                e["to"] = exit_id
        # answer = 各来源节点输出键的 {{键}} 空格拼接（§10.3）
        keys = []
        for s in sources:
            out_key = c.nodes[s].get("output") or ("last" if c.nodes[s].get("type") != "input" else "last")
            keys.append(out_key)
        c.answer_template = " ".join("{{%s}}" % k for k in keys) if keys else "{{last}}"
        c.exit_id = exit_id
    else:
        # 隐式出口：无出边的末端节点承接；纯环图 → output_missing
        has_out = {e["from"] for e in c.edges}
        terminals = [nid for nid in c.nodes
                     if nid not in has_out and nid != "__canvas_entry"]
        if not terminals:
            raise CanvasError("output_missing", "纯环图无末端节点，无法承接最终输出")
        keys = []
        for t in terminals:
            node = c.nodes[t]
            if node.get("type") == "output":
                # 末端 output 节点自身无产出——answer 引其入边来源节点的输出键
                for e in c.edges:
                    if e["to"] == t and e["from"] in c.nodes:
                        k = c.nodes[e["from"]].get("output") or "last"
                        if k not in keys:
                            keys.append(k)
            else:
                k = node.get("output") or "last"
                if k not in keys:
                    keys.append(k)
        c.answer_template = " ".join("{{%s}}" % k for k in keys) if keys else "{{last}}"
        c.exit_id = None  # 隐式：静止即收口

    # 输出键全量登记（漏登记 = 下游读不到，最难的静默失效）
    for nid, n in c.nodes.items():
        if n.get("type") == "pyfunc":
            key = n.get("output") or "last"
            if key not in c.reducers:
                c.reducers[key] = "overwrite"

    # 并行写闸（编译期）：同一节点多条出边 = 并行分支组；组内两分支写同一键
    # 且该键未声明 append = 编译错误
    out_by_src: Dict[str, List[dict]] = {}
    for e in c.edges:
        out_by_src.setdefault(e["from"], []).append(e)
    for src, edges in out_by_src.items():
        if len(edges) < 2:
            continue
        keys = [(c.nodes[e["to"]].get("output") or "last")
                for e in edges if e["to"] in c.nodes
                and c.nodes[e["to"]].get("type") == "pyfunc"]
        dup = {k for k in keys if keys.count(k) > 1 and c.reducers.get(k) != "append"}
        if dup:
            raise CanvasError(
                "parallel_write_gate",
                f"并行分支 {src!r} 的多个分支同时写状态键 {sorted(dup)}——"
                "请在 state 声明 reducer:'append'，或让分支各写异键")
    return c


# ---- 运行期 ----

class _FanQueue:
    """ctx.fan：run 级动态扇出队列（put 覆盖式，take 原子领取，空返回 None）。"""

    def __init__(self):
        self._items: List[Any] = []
        self._lock = threading.Lock()

    def put(self, items: Any) -> int:
        if not isinstance(items, list):
            raise TypeError("fan.put 需要列表")
        with self._lock:
            self._items = list(items)
            return len(self._items)

    def take(self) -> Any:
        with self._lock:
            if not self._items:
                return None
            return self._items.pop(0)


class _StdoutRouter(io.TextIOBase):
    """print 观测路由：主线程直通捕获缓冲；to_thread 工作线程经 thread-local
    归属各自节点——并行分支不串节点、不串 run（§5 print = 唯一观测通道）。"""

    def __init__(self):
        self._local = threading.local()
        self._main_buf: Optional[io.StringIO] = None
        self._orig = None

    def install(self):
        import sys
        self._orig = sys.stdout
        sys.stdout = self
        return self

    def uninstall(self):
        import sys
        if self._orig is not None:
            sys.stdout = self._orig

    def bind_main(self, buf: io.StringIO):
        self._main_buf = buf

    def bind_thread(self, buf: Optional[io.StringIO]):
        self._local.buf = buf

    def write(self, s: str) -> int:
        buf = getattr(self._local, "buf", None)
        target = buf if buf is not None else self._main_buf
        if target is not None:
            target.write(s)
        try:
            if self._orig is not None:
                self._orig.write(s)
        except Exception:
            pass
        return len(s)

    def flush(self):
        try:
            if self._orig is not None:
                self._orig.flush()
        except Exception:
            pass


def _eval_when(expr: str, state: dict, node_id: str) -> bool:
    """when 守卫求值：白名单 eval + 快照 state；失败显式报错，不当 False 吞。
    注意：globals 缺 __builtins__ 键时 Python 会自动注入完整内建——必须显式
    钉死白名单，否则白名单形同虚设。"""
    env = {"__builtins__": dict(_WHEN_BUILTINS)}
    try:
        return bool(eval(expr, env, dict(state)))  # noqa: S307 — 白名单 + 信任边界同规范
    except CanvasError:
        raise
    except Exception as e:
        raise CanvasError("when_eval_failed",
                          f"节点 {node_id!r} 出边 when 守卫求值失败（{expr!r}）: "
                          f"{type(e).__name__}: {e}")


def _make_llm(context: dict):
    """ctx.llm：绑定服务端 LLM 通道（shim）。images 暂点名不支持（待对齐项）。"""
    import aiohttp

    async def llm(prompt, *, system=None, temperature=None, max_tokens=None,
                  images=None) -> str:
        if images:
            raise CanvasError("llm_images_unsupported",
                              "ctx.llm(images=…) 画布内核暂未支持（对齐进行中）——"
                              "请先用文本 prompt")
        url = context.get("llm_router_url") or "http://127.0.0.1:8300"
        messages = []
        if system:
            messages.append({"role": "system", "content": str(system)})
        messages.append({"role": "user",
                         "content": prompt if isinstance(prompt, str) else json.dumps(prompt, ensure_ascii=False)})
        payload = {"model": 1, "messages": messages, "stream": False}
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{url}/v1/llm/complete", json=payload,
                                    timeout=aiohttp.ClientTimeout(total=600)) as r:
                text = await r.text()
                if r.status != 200:
                    raise CanvasError("llm_call_failed",
                                      f"ctx.llm 调用失败 HTTP {r.status}: {text[:200]}")
                data = json.loads(text)
        return data["choices"][0]["message"]["content"]

    return llm


def _sig_kind(fn) -> str:
    """三签名分派（§5）：state / args / ctx。"""
    import inspect
    sig = inspect.signature(fn)
    params = [p for p in sig.parameters.values()
              if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    if len(params) == 1:
        return "state"
    if len(params) == 2 and params[1].name == "args":
        return "args"
    if len(params) == 2:
        return "ctx"
    raise CanvasError("bad_code",
                      "fn 形参不是 1–2 个（签名分派：fn(state) / fn(state, args) / "
                      f"async fn(state, ctx)），收到 {len(params)} 个")


def _resolve_args(node: dict) -> dict:
    """参数表实值形：剥 {type,value} 外壳（file 型补全属待对齐项）。"""
    out = {}
    for name, spec in (node.get("args") or {}).items():
        if isinstance(spec, dict) and "value" in spec:
            out[name] = spec.get("value")
        else:
            out[name] = spec
    return out


class _Ctx(dict):
    """_PyfuncCtx：dict + 属性双访问（§6）——ctx.llm 与 ctx["llm"] 等价。"""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)

    def __setattr__(self, name, value):
        self[name] = value


async def _exec_pyfunc(nid: str, node: dict, state: dict, context: dict,
                       fan: _FanQueue, router: _StdoutRouter,
                       llm) -> Tuple[Any, Optional[str], List[str], Optional[str]]:
    """执行一个 pyfunc：返回 (产出, output键, stdout行, caught错误文本)。"""
    import inspect
    code = node["code"]
    out_key = node.get("output") or "last"
    catch_key = node.get("catch")
    ns: dict = {}
    exec(compile(code, f"<pyfunc {nid}>", "exec"), ns)  # noqa: S102 — 信任边界同规范
    fn = ns.get("fn")
    if fn is None or not callable(fn):
        raise CanvasError("missing_fn", f"pyfunc 节点 {nid!r} 装载后未找到可调用 fn")
    kind = _sig_kind(fn)

    view = dict(state)  # 只读快照（视图副本：就地写不落通道）
    buf = io.StringIO()
    is_main_thread = threading.current_thread() is threading.main_thread()
    if is_main_thread:
        router.bind_main(buf)
    else:
        router.bind_thread(buf)

    captured_error: Optional[str] = None
    try:
        if kind == "state":
            result = fn(view)
        elif kind == "args":
            result = fn(view, _resolve_args(node))
        else:
            ctx = _Ctx({"args": _resolve_args(node), "llm": llm,
                        "node": nid, "fan": fan})
            result = fn(view, ctx)
        if inspect.iscoroutine(result):
            result = await result
    except Exception as e:  # noqa: BLE001
        if catch_key:
            captured_error = f"{type(e).__name__}: {e}"
            result = None
        else:
            lineno = None
            tb = e.__traceback__
            while tb:
                if str(tb.tb_frame.f_code.co_filename).startswith("<pyfunc"):
                    lineno = tb.tb_lineno
                tb = tb.tb_next
            raise CanvasError(
                "node_exec_failed",
                f"pyfunc 节点 {nid!r} 执行失败（fn 第 {lineno or '?'} 行）: "
                f"{type(e).__name__}: {e}")
    finally:
        if is_main_thread:
            router.bind_main(None)
        else:
            router.bind_thread(None)

    lines = buf.getvalue().splitlines()
    if len(lines) > LIMIT_STDOUT_LINES:
        lines = lines[:LIMIT_STDOUT_LINES] + [f"…（stdout 超限，截断至 {LIMIT_STDOUT_LINES} 行）"]
    return result, (catch_key if captured_error else out_key), lines, captured_error


async def run_canvas(doc_text: str, *, input_data: str,
                     context: Optional[dict] = None) -> dict:
    """画布超步执行入口。返回 {answer, trace, steps}；错误 CanvasError。"""
    t0 = time.time()
    context = context or {}
    doc = load_canvas_doc(doc_text)
    if not isinstance(doc, dict):
        raise CanvasError("bad_json", "工作流载荷无法解析为对象")
    c = compile_canvas(doc)
    question = str(input_data or "").strip()[:LIMIT_QUESTION]

    state: Dict[str, Any] = {"question": question, "history": ""}
    fan = _FanQueue()
    llm = _make_llm(context)
    router = _StdoutRouter().install()
    trace: List[dict] = []
    steps = 0
    last_run: Dict[str, int] = {}       # node_id -> 最近执行的波号（回路可重跑）
    wave_no = 0
    pending_in: Dict[str, List[dict]] = {}
    for e in c.edges:
        pending_in.setdefault(e["to"], []).append(e)

    entry = next((nid for nid, n in c.nodes.items() if n.get("type") == "input"), None)
    if entry is None:
        raise CanvasError("input_missing", "转译后缺少入口节点")
    answer = None
    final_error: Optional[CanvasError] = None

    def _ready_set() -> List[str]:
        """就绪集（LangGraph 式激活，§8 语义）：≥1 条入边的新鲜命中 offer
        （波号新于本节点上次执行）即就绪——超步屏障保证并行兄弟先于共同
        下游汇合（join），死支路天然不阻塞；无入边者仅入口节点（只跑一次）。"""
        ready = []
        for nid in c.nodes:
            edges = pending_in.get(nid)
            if edges is None:
                if nid == entry and nid not in last_run:
                    ready.append(nid)
                continue
            if any(e.get("_offer") and e["_offer"][1]
                   and e["_offer"][0] > last_run.get(nid, 0) for e in edges):
                ready.append(nid)
        return ready

    try:
        async def _wave_loop():
            nonlocal answer, steps, final_error, wave_no
            while True:
                if WALL_CLOCK_S and time.time() - t0 > WALL_CLOCK_S:
                    raise CanvasError("wall_clock", f"工作流超过墙钟上限 {WALL_CLOCK_S:.0f}s")
                ready = _ready_set()
                wave_no += 1
                if not ready:
                    # 静止期：判终态（激活语义下无传播必要）
                    pass
                if not ready:
                    if c.exit_id is not None and c.exit_id in last_run:
                        return
                    if c.exit_id is None:
                        # 隐式出口：静止即收口（末端节点承接；纯环图已在编译期拒绝）
                        return
                    raise CanvasError("no_terminal",
                                      "工作流执行结束但没有走到 output 终态"
                                      "（无就绪节点且出口未达成）")
                # 快照语义：同一超步的并行兄弟产出对彼此不可见（§8）
                snapshot = dict(state)
                steps += len(ready)
                if steps > STEP_LIMIT:
                    raise CanvasError("step_limit", f"工作流超过最大步数 {STEP_LIMIT}")

                async def _run_one(nid: str):
                    node = c.nodes[nid]
                    ntype = node.get("type")
                    rec = {"node": nid, "type": ntype, "status": "running",
                           "started": round(time.time(), 3)}
                    trace.append(rec)
                    ts = time.time()
                    try:
                        if ntype == "input":
                            result, out_key, lines, err = question, (node.get("output") or "last"), [], None
                        elif ntype == "output":
                            result, out_key, lines, err = None, "_final", [], None
                        else:
                            result, out_key, lines, err = await _exec_pyfunc(
                                nid, node, snapshot, context, fan, router, llm)
                        rec.update(status="ok", dur_ms=round((time.time() - ts) * 1000),
                                   stdout=lines, output=_preview(result),
                                   **({"error": err, "caught": True} if err else {}))
                        return nid, result, out_key, err
                    except CanvasError as e:
                        rec.update(status="error", dur_ms=round((time.time() - ts) * 1000),
                                   error=f"[{e.defect}] {e.message}")
                        raise

                results = await asyncio.gather(*[_run_one(n) for n in ready])

                # 并行写合并（reducer 语义：append 累加成 list / overwrite 末写）
                for nid, result, out_key, err in results:
                    last_run[nid] = wave_no
                    node = c.nodes[nid]
                    if node.get("type") == "output":
                        answer = _render_template(c.answer_template, state)
                        continue
                    if out_key == "_final":
                        continue
                    if err is not None and node.get("catch"):
                        state[node["catch"]] = err
                        continue
                    if result is None:
                        continue  # None = 不写通道
                    if c.reducers.get(out_key) == "append":
                        cur = state.get(out_key)
                        acc = cur if isinstance(cur, list) else ([] if cur is None else [cur])
                        acc.append(result)
                        state[out_key] = acc
                    else:
                        state[out_key] = result

                # 出边重新 offer（代际推进——回路靠它转起来）：守卫 = 波前快照
                # + 源节点自身产出（自己的输出对自己守卫可见；兄弟产出不可见）
                for nid, result, out_key, err in results:
                    node = c.nodes[nid]
                    if node.get("type") == "output":
                        continue
                    eval_state = dict(snapshot)
                    if err is not None and node.get("catch"):
                        eval_state[node["catch"]] = err
                    elif result is not None and out_key != "_final":
                        if c.reducers.get(out_key) == "append":
                            cur = eval_state.get(out_key)
                            acc = cur if isinstance(cur, list) else ([] if cur is None else [cur])
                            acc.append(result)
                            eval_state[out_key] = acc
                        else:
                            eval_state[out_key] = result
                    gen = last_run[nid]
                    for e in c.edges:
                        if e["from"] != nid:
                            continue
                        if e["when"]:
                            try:
                                hit = _eval_when(e["when"], eval_state, nid)
                            except CanvasError as ex:
                                final_error = final_error or ex
                                hit = False
                        else:
                            hit = True
                        e["_offer"] = (gen, hit)
                # 条件扇出全不命中 = 节点级显式报错（§8）：源最新一轮完成且其
                # 出边最新 offer 全部未命中（代际对齐——只对本轮响，不溯往轮）
                for src in {e["from"] for e in c.edges if e["when"]}:
                    if src not in last_run:
                        continue
                    src_edges = [e for e in c.edges if e["from"] == src]
                    if all(e.get("_offer") for e in src_edges) \
                            and all(not e["_offer"][1] for e in src_edges) \
                            and all(e["_offer"][0] == last_run[src]
                                    for e in src_edges):
                        raise CanvasError(
                            "when_all_missed",
                            f"节点 {src!r} 出边 when 守卫全部未命中"
                            "（广播无应答必须响亮）")
                if final_error is not None:
                    raise final_error

        await _wave_loop()
        if answer is None:  # 隐式出口：静止渲染
            answer = _render_template(c.answer_template, state)
    finally:
        router.uninstall()
        for e in c.edges:
            e.pop("_offer", None)

    return {"answer": answer if answer is not None else "", "trace": trace, "steps": steps}


def _preview(v: Any, limit: int = 500) -> str:
    text = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"


def _render_template(template: str, state: dict) -> str:
    """出口 answer 渲染：{{键}} → state 取值（缺键空串）。"""
    def _sub(m: "re.Match") -> str:
        key = m.group(1)
        v = state.get(key)
        if v is None:
            return ""
        return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    return re.sub(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", _sub, template)
