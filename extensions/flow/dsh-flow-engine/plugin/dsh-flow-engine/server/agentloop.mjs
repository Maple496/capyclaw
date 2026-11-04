/**
 * agentloop —— agent 节点接管路径的 ReAct 循环（executor: dsh）。
 *
 * 循环策略由 dsh/Node 侧持有（对应上游 AgentNode.execute 的进程内循环）：
 * LLM → tool_calls? → 分派工具体 → 追加历史 → 循环，直至终答或迭代上限。
 *
 * LLM 调用经 llmshim（openai 模式原生支持 tools；dsh 模式工具面桥接
 * 待 agentLoop 深度接入）。工具分派由宿主注入：
 * - workflow（内联子 DAG）→ flowRun 递归执行
 * - sandbox              → 回调执行器 /v1/tools/sandbox（隔离能力留在执行器）
 * - http                 → Node 直接 POST
 *
 * 语义对齐上游：sliding_window 记忆（[system]+尾 N）；summarization 上游
 * 本就是无 LLM 简化版，同形承接；超限回退 last_content（或上限文案）。
 */
export async function runAgent(spec = {}, { callLlm, execTool } = {}) {
  if (typeof callLlm !== 'function') throw new Error('runAgent 需要 callLlm')
  if (typeof execTool !== 'function') throw new Error('runAgent 需要 execTool')

  const messages = []
  if (spec.system_prompt) messages.push({ role: 'system', content: spec.system_prompt })
  messages.push({ role: 'user', content: String(spec.input ?? '') })

  const maxIterations = Math.max(1, Math.min(32, Number(spec.max_iterations) || 8))
  const window = Math.max(2, Number(spec.memory_window) || 10)
  const trace = []
  let lastContent = ''

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Phase 3 对齐：memory 策略在每轮调用前应用
    let scoped = messages
    if (messages.length > window + 1) {
      const recent = messages.slice(-window)
      if (spec.memory_strategy === 'summarization') {
        // 上游简化版：system + 中间段仅保留 user/assistant 文本尾 2 条 + 最近 N
        const middle = messages.slice(1, -window)
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
          .slice(-2)
        scoped = [messages[0], ...middle, ...recent]
      } else {
        scoped = [messages[0], ...recent] // sliding_window（缺省）
      }
    }

    const resp = await callLlm({
      model: spec.model,
      messages: scoped,
      temperature: spec.temperature,
      max_tokens: spec.max_tokens,
      ...(Array.isArray(spec.tools) && spec.tools.length ? { tools: spec.tools } : {}),
      stream: false,
    })
    const message = resp?.choices?.[0]?.message ?? {}
    const calls = message.tool_calls || []

    if (!calls.length) {
      return {
        ok: true,
        output: message.content || lastContent,
        iterations: iteration,
        trace,
      }
    }

    lastContent = message.content || lastContent
    messages.push({ role: 'assistant', content: message.content || '', tool_calls: calls })

    // Phase 2 对齐：工具串行执行（parallel 语义留待 dsh agentLoop 深度接入）
    for (const call of calls) {
      const name = call.function?.name || ''
      let args = {}
      try { args = JSON.parse(call.function?.arguments || '{}') } catch { /* 宽松对齐上游 */ }
      let result
      try {
        result = await execTool(name, args)
      } catch (e) {
        result = JSON.stringify({ error: String(e.message || e) })
      }
      trace.push({ iteration, tool: name, result: String(result).slice(0, 200) })
      messages.push({
        role: 'tool',
        tool_call_id: call.id || name || 'unknown',
        content: String(result).slice(0, 8000),
      })
    }
  }

  return {
    ok: true,
    output: lastContent || '（达到工具循环上限，未能给出最终回答）',
    iterations: maxIterations,
    trace,
  }
}
