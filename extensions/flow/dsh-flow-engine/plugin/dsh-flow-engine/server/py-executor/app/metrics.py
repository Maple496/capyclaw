"""
Prometheus 监控指标 - 工作流执行器
"""
from prometheus_client import Counter, Histogram, Gauge, Info
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST


# ============ 工作流执行指标 ============

# 工作流执行总数
workflow_executions_total = Counter(
    'workflow_executions_total',
    'Total workflow executions',
    ['status']  # status: success/error
)

# 工作流执行延迟
workflow_execution_duration_seconds = Histogram(
    'workflow_execution_duration_seconds',
    'Workflow execution duration in seconds',
    buckets=(0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 120.0)
)

# ============ Agent 节点指标 ============

# Agent 迭代次数分布
agent_iterations = Histogram(
    'agent_iterations',
    'Agent iteration count',
    ['agent_id'],
    buckets=(1, 2, 3, 5, 8, 10, 15, 20, 32)
)

# Agent 达到上限次数
agent_max_iterations_reached_total = Counter(
    'agent_max_iterations_reached_total',
    'Times agent reached max iterations',
    ['agent_id']
)

# Agent 工具调用次数
agent_tool_calls_total = Counter(
    'agent_tool_calls_total',
    'Total agent tool calls',
    ['agent_id', 'tool_name', 'status']  # status: success/error
)

# ============ 沙箱执行指标 ============

# 沙箱执行次数
sandbox_executions_total = Counter(
    'sandbox_executions_total',
    'Total sandbox executions',
    ['runtime', 'status']  # runtime: python/node, status: success/error/timeout
)

# 沙箱执行时长
sandbox_execution_duration_seconds = Histogram(
    'sandbox_execution_duration_seconds',
    'Sandbox execution duration in seconds',
    ['runtime'],
    buckets=(0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0)
)

# 沙箱 OOM 次数
sandbox_oom_total = Counter(
    'sandbox_oom_total',
    'Sandbox out of memory events',
    ['runtime']
)

# cgroup 启用状态
sandbox_cgroup_enabled = Gauge(
    'sandbox_cgroup_enabled',
    'Whether cgroup is enabled for sandbox',
    ['runtime']
)

# ============ DAG 执行指标 ============

# DAG 节点执行次数
dag_node_executions_total = Counter(
    'dag_node_executions_total',
    'Total DAG node executions',
    ['node_type', 'status']  # node_type: function/agent/llm/switch
)

# DAG 并行执行节点数
dag_parallel_nodes = Gauge(
    'dag_parallel_nodes',
    'Number of parallel nodes in current DAG'
)

# ============ 服务信息 ============

service_info = Info(
    'workflow_executor_service',
    'Workflow executor service information'
)


# ============ 辅助函数 ============

def record_workflow_execution(status: str, duration: float):
    """记录工作流执行"""
    workflow_executions_total.labels(status=status).inc()
    workflow_execution_duration_seconds.observe(duration)


def record_agent_execution(agent_id: str, iterations: int, reached_max: bool):
    """记录 Agent 执行"""
    agent_iterations.labels(agent_id=agent_id).observe(iterations)
    if reached_max:
        agent_max_iterations_reached_total.labels(agent_id=agent_id).inc()


def record_agent_tool_call(agent_id: str, tool_name: str, status: str):
    """记录 Agent 工具调用"""
    agent_tool_calls_total.labels(
        agent_id=agent_id,
        tool_name=tool_name,
        status=status
    ).inc()


def record_sandbox_execution(runtime: str, status: str, duration: float, 
                             cgroup_enabled: bool = False):
    """记录沙箱执行"""
    sandbox_executions_total.labels(
        runtime=runtime,
        status=status
    ).inc()
    
    sandbox_execution_duration_seconds.labels(runtime=runtime).observe(duration)
    
    if cgroup_enabled:
        sandbox_cgroup_enabled.labels(runtime=runtime).set(1)
    else:
        sandbox_cgroup_enabled.labels(runtime=runtime).set(0)
    
    if status == 'oom':
        sandbox_oom_total.labels(runtime=runtime).inc()


def record_dag_node_execution(node_type: str, status: str):
    """记录 DAG 节点执行"""
    dag_node_executions_total.labels(
        node_type=node_type,
        status=status
    ).inc()


def set_dag_parallel_nodes(count: int):
    """设置 DAG 并行节点数"""
    dag_parallel_nodes.set(count)


def init_service_info(version: str = "2.0.0"):
    """初始化服务信息"""
    service_info.info({
        'version': version,
        'service': 'workflow-executor'
    })


def get_metrics() -> bytes:
    """获取所有指标（Prometheus 格式）"""
    return generate_latest()


def get_content_type() -> str:
    """获取内容类型"""
    return CONTENT_TYPE_LATEST
