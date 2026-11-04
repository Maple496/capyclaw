/**
 * llmshim —— 8300 统一路由契约的本地承接面。
 *
 * 上游执行器所有 LLM 调用都 POST {llm_router_url}/v1/llm/complete
 * （请求 {model:int, messages, temperature, max_tokens, stream:false, tools?}
 *  → 响应 {choices:[{message}]}，8300 形 = OpenAI 形子集）。
 *
 * 三种模式（DSH_FLOW_LLM_MODE，缺省 mock）：
 * - mock     ：确定性应答（烟雾测试/离线演示）。按提示词特征返回合法
 *              string_array / deck_outline JSON；带 tools 时先回一轮 tool_calls。
 * - openai   ：转发 OpenAI 兼容端点（DSH_FLOW_LLM_BASE_URL + API_KEY），
 *              model 编号经 DSH_FLOW_MODEL_MAP（形如 "1=deepseek-chat,2=..."）映射。
 * - dsh      ：注入式接管——host.mjs（harness 内）用 ctx.llm 组装 completeFn
 *              注入。react/agent 的生成由此经 dsh 的 llm 层（适配器/重试/计量）。
 *              限制：content-block 文本桥接；带 tools 的请求点名拒绝（工具面
 *              桥接属 agent-loop 接管范畴，另行推进）。
 *
 * 后续 react/agent 接管（dsh agentLoop）就在这一层挂钩：把 /v1/llm/complete
 * 换成 Node 侧 harness 调用，执行器零改动。
 */
import http from 'node:http'
import https from 'node:https'

const MOCK_ARRAY = JSON.stringify(['角度一：核心机制', '角度二：版本环境', '角度三：玩家生态', '角度四：赛事观察'])
const MOCK_OUTLINE = JSON.stringify({
  title: '演示标题',
  subtitle: '一句话核心主张',
  slides: [
    { title: '背景与问题', bullets: ['要点一', '要点二', '要点三'] },
    { title: '方案概览', bullets: ['要点一', '要点二'] },
    { title: '结论与展望', bullets: ['要点一'] },
  ],
})

function mockComplete(body) {
  const text = JSON.stringify(body.messages || [])
  let message
  // agent 节点（function calling）：首轮给一次工具调用，收到工具结果后收束
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const last = (body.messages || []).at(-1)
    if (last && (last.role === 'tool' || last.role === 'function')) {
      message = { role: 'assistant', content: 'mock: 已根据工具结果完成回答。' }
    } else {
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_mock_1', type: 'function',
          function: { name: body.tools[0].function?.name || body.tools[0].name || 'tool', arguments: '{}' },
        }],
      }
    }
  } else if (text.includes('JSON 数组')) {
    message = { role: 'assistant', content: MOCK_ARRAY }
  } else if (text.includes('slides') || text.includes('大纲') || text.includes('演示')) {
    message = { role: 'assistant', content: MOCK_OUTLINE }
  } else {
    message = { role: 'assistant', content: 'mock: 收到。' }
  }
  // 8300 契约响应形 = OpenAI 形子集：{choices:[{message}]}
  return { choices: [{ message }] }
}

function parseModelMap(raw) {
  const map = {}
  for (const pair of String(raw || '').split(',')) {
    const [k, v] = pair.split('=')
    if (k && v) map[k.trim()] = v.trim()
  }
  return map
}

function forwardOpenAi(body, cfg) {
  const map = parseModelMap(cfg.modelMap)
  const modelId = String(body.model)
  const payload = { ...body, model: map[modelId] || cfg.defaultModel || modelId, stream: false }
  delete payload.tools_cache
  const data = JSON.stringify(payload)
  const url = new URL(cfg.baseUrl)
  const mod = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname.replace(/\/$/, '') + '/chat/completions',
      method: 'POST',
      timeout: 180000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          reject(new Error(`上游 LLM HTTP ${res.statusCode}: ${text.slice(0, 300)}`))
          return
        }
        try { resolve(JSON.parse(text)) } catch (e) { reject(new Error(`上游响应非 JSON: ${e.message}`)) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('上游 LLM 超时 180s')) })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

/** 返回 fastify 风格 (req,res,u) 路由钩子；命中返回 true。 */
export function createLlmShim(cfg = {}) {
  const mode = cfg.mode || process.env.DSH_FLOW_LLM_MODE || 'mock'
  const stats = { requests: 0, errors: 0 }
  return {
    mode,
    stats,
    handler(req, res, u) {
      if (u.pathname !== '/v1/llm/complete') return false
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: 'POST only' }))
        return true
      }
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', async () => {
        stats.requests += 1
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (e) {
          stats.errors += 1
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ detail: `bad_json: ${e.message}` }))
          return
        }
        try {
          let result
          if (mode === 'openai') {
            result = await forwardOpenAi(body, cfg)
          } else if (mode === 'dsh') {
            if (typeof cfg.completeFn !== 'function') {
              throw new Error('dsh 模式需要注入 completeFn（host.mjs 未在 harness ctx 下装配）')
            }
            if (Array.isArray(body.tools) && body.tools.length > 0) {
              throw new Error('dsh 模式暂不支持工具面桥接（agent 节点请用 openai/mock 模式）')
            }
            result = await cfg.completeFn(body)
          } else {
            result = mockComplete(body)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          stats.errors += 1
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ detail: String(e.message || e) }))
        }
      })
      return true
    },
  }
}
