/**
 * dsh-flow-engine 业务实现：执行器代理（validate/run/fixtures）。
 *
 * Python worker 的生命周期由 relay.mjs 装配；本文件只做 HTTP 编排与
 * DSL 载入（fixture 读取），不含执行语义——执行语义唯一真源仍是
 * server/py-executor/app（上游 port-8301 快照）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkflowStore } from './workflows.mjs'
import { runAgent } from './agentloop.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(HERE, 'py-executor', 'fixtures')

let worker = null   // { url, stop, logs } — relay.mjs 注入
let llmShim = null  // { mode, stats } — relay.mjs 注入
let selfBase = ''   // 本服务对外基址（执行器 LLM 回流地址）
let store = null    // 工作流组件仓 — relay.mjs 注入

export function bindRuntime({ pyWorker, shim, baseUrl, workflowStore }) {
  worker = pyWorker
  llmShim = shim
  if (baseUrl) selfBase = baseUrl
  if (workflowStore) store = workflowStore
}

export function getStore() {
  if (!store) throw new Error('组件仓未就绪（服务仍在启动）')
  return store
}

function assertWorker() {
  if (!worker) throw new Error('执行器未就绪（服务仍在启动或启动失败）')
  return worker
}

/** 把 DSL 入参归一为文本：对象 → JSON 文本；字符串原样（JSON/YAML 皆可） */
function dslText(workflow) {
  if (typeof workflow === 'string') return workflow
  if (workflow && typeof workflow === 'object') {
    return typeof workflow.dsl === 'string'
      ? workflow.dsl
      : JSON.stringify(workflow.dsl ?? workflow)
  }
  throw new Error('workflow 必须是 DSL 文本（JSON/YAML）或 {dsl} 对象')
}

async function postExecutor(ExecPath, payload, timeoutMs = 600000) {
  const w = assertWorker()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${w.url}${ExecPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 2000) } }
    return { status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}

export async function flowValidate(args) {
  const { status, data } = await postExecutor('/v1/validate',
    { workflow_dsl: dslText(args.workflow) }, 30000)
  return { status, ...data }
}

export async function flowRun(args) {
  const input = String(args.input ?? '')
  if (!input.trim()) throw new Error('input 不能为空')
  const base = args.selfBase || selfBase
  if (!base) throw new Error('服务尚未完成绑定（selfBase 未就绪）')
  const payload = {
    workflow_dsl: dslText(args.workflow),
    input,
    user_id: Number(args.user_id ?? 0),
    requester_id: args.requester_id != null ? Number(args.requester_id) : null,
    llm_router_url: base,              // LLM 调用回流 Node 侧 shim
    platform_api_url: args.platform_api_url || '',
    platform_api_token: args.platform_api_token || '',
    stream: false,
    subflow_url: base,                 // flow 组合节点回调本服务组件面
    subflow_depth: Number(args.subflow_depth ?? 0),
  }
  const { status, data } = await postExecutor('/v1/execute', payload)
  if (status === 400) return { ok: false, stage: 'validate', error: data.detail ?? data }
  if (status !== 200) return { ok: false, stage: 'execute', error: data.detail ?? data }
  return {
    ok: true,
    output: data.output,
    replies: data.replies,
    ...(data.engine ? { engine: data.engine, steps: data.steps, trace: data.trace } : {}),
  }
}

export function flowFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) return { fixtures: [], note: 'fixtures 目录不存在' }
  const fixtures = []
  for (const f of fs.readdirSync(FIXTURES_DIR).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8'))
      const dsl = j.dsl
      const nodes = Array.isArray(dsl?.nodes)
        ? dsl.nodes
        : [...String(j.dsl_raw ?? '').matchAll(/type:\s*(\w+)/g)].map((m) => ({ type: m[1] }))
      fixtures.push({
        fixture: f.replace(/\.json$/, ''),
        work_id: j.work_id,
        name: j.meta?.name ?? j.name,
        version: j.version,
        dsl_kind: j.dsl_kind,
        node_types: nodes.map((n) => n.type),
        has_decorator: Boolean(j.meta?.decorator),
        description: String(j.meta?.description ?? '').slice(0, 120),
      })
    } catch { fixtures.push({ fixture: f, error: 'fixture 解析失败' }) }
  }
  return { fixtures, llm_mode: llmShim?.mode ?? 'unknown' }
}

/** 健康面附加段（relay 的 health() 会并入 /healthz） */
export function runtimeHealth() {
  let components = null
  try { if (store) components = store.listMeta().length } catch { /* 仓未就绪 */ }
  return {
    executor: worker ? { url: worker.url, up: true } : { up: false },
    llm: { mode: llmShim?.mode ?? 'unknown', ...(llmShim?.stats ?? {}) },
    components,
  }
}

export function pyWorkerLogs() {
  return worker?.logs?.join('\n') ?? '(worker 未启动)'
}

// ===== 工作流组件面（组件仓 + flow 组合节点回调） =====

const FLOW_DEPTH_CAP = 4

/** 组件清单 */
export function workflows() {
  const s = getStore()
  const items = s.listMeta().map((m) => ({
    ...m,
    works_ref: m.id ? `WORKS-local-flow-${m.id}` : undefined,
  }))
  return { count: items.length, workflows: items, store_dir: s.dir }
}

/** 按组件 id 调用（组合产物 = 可调用技能） */
export async function invokeWorkflow(args) {
  const s = getStore()
  const comp = s.read(String(args.workflow_id || ''))
  if (!comp) throw new Error(`组件不存在: ${args.workflow_id}`)
  const r = await flowRun({ ...args, workflow: comp.dsl })
  return { ...r, workflow_id: comp.id, workflow_name: comp.name }
}

/** 保存组件（先过执行器结构校验，再入仓） */
export async function saveWorkflow(args) {
  const s = getStore()
  const v = await flowValidate({ workflow: args.dsl })
  if (v.ok === false && (v.errors?.length)) {
    return { ok: false, stage: 'validate', validate: v }
  }
  const meta = s.save({
    id: args.id, name: args.name, tags: args.tags,
    description: args.description, contract: args.contract,
    dsl: args.dsl,
    source: { kind: 'authored', note: args.note },
  })
  return { ok: true, validate: v, component: meta }
}

export function removeWorkflow({ id } = {}) {
  return { ok: getStore().remove(String(id || '')) }
}

// ===== 作品导入（平台作品 → dsh 工作流组件） =====

/** slug 化：非 [a-z0-9-] 折叠为 '-'；全非 ASCII（如纯中文）返回 null 由调用方兜底 */
function slugify(text) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return /^[a-z]/.test(s) && s.length >= 2 ? s.slice(0, 48) : null
}

function hashId(text) {
  let h = 0
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return `imported-${h.toString(36).padStart(6, '0')}`
}

/** 拆 .works 文件节（%%%WORKS-META%%% / %%%WORKS-CODE%%% / …） */
function parseWorksSections(text) {
  const sections = {}
  const re = /%%%WORKS-([A-Z-]+)%%%\r?\n?/g
  const marks = []
  for (const m of text.matchAll(re)) marks.push({ name: m[1], start: m.index + m[0].length })
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length
      ? text.indexOf('%%%WORKS-', marks[i].start)
      : text.length
    sections[marks[i].name] = text.slice(marks[i].start, end).trim()
  }
  return sections
}

/**
 * 归一任意"作品工件"为 {dsl, name, description, decorator, warnings[]}。
 * 接受四形：
 *  1. DSL 文本（v3 JSON / YAML pipeline）
 *  2. 作品 agent_proxy_json（含 workflow_dsl / workflow_code / decorator）
 *  3. .works 文件（%%%WORKS-META%%% / %%%WORKS-CODE%%% 节）
 *  4. v3 文档对象（{nodes,edges,...}）
 */
export function normalizeWorkArtifact(input) {
  const warnings = []
  let name = ''
  let description = ''
  let decorator = ''
  let dsl = ''

  const fromProxy = (obj) => {
    name = String(obj.name || name)
    description = String(obj.description || description)
    if (obj.decorator) {
      decorator = String(obj.decorator)
      warnings.push(`装饰器外壳 ${decorator} 未导入（平台回复卡语义，dsh 侧不适用）`)
    }
    const inner = obj.workflow_dsl ?? obj.workflow_code
    if (typeof inner !== 'string' || !inner.trim()) {
      throw new Error('工件缺 workflow_dsl/workflow_code（不是可导入的工作流作品）')
    }
    return inner
  }

  if (typeof input === 'string') {
    const text = input.trim()
    if (text.includes('%%%WORKS-')) {
      const sections = parseWorksSections(text)
      let meta = {}
      let code = {}
      try { meta = JSON.parse(sections.META || '{}') } catch { /* META 非法按空处理 */ }
      try { code = JSON.parse(sections.CODE || '{}') } catch { /* CODE 可能是代码文本 */ }
      name = String(meta.name || name)
      description = String(meta.brief || description)
      if (typeof code === 'object' && code && (code.workflow_dsl || code.workflow_code)) {
        dsl = fromProxy(code)
      } else if (typeof code === 'object' && code && Array.isArray(code.nodes)) {
        dsl = JSON.stringify(code)
      } else {
        throw new Error('.works CODE 节未找到工作流（workflow_dsl/nodes）')
      }
    } else {
      try {
        const obj = JSON.parse(text)
        if (obj && typeof obj === 'object') {
          if (obj.workflow_dsl || obj.workflow_code) dsl = fromProxy(obj)
          else if (Array.isArray(obj.nodes)) dsl = text
          else throw new Error('JSON 对象既非 agent_proxy 形也非 v3 文档形')
        } else dsl = text
      } catch (e) {
        if (e instanceof SyntaxError) dsl = text // 非 JSON → YAML pipeline DSL 原文
        else throw e
      }
    }
  } else if (input && typeof input === 'object') {
    if (input.workflow_dsl || input.workflow_code) dsl = fromProxy(input)
    else if (Array.isArray(input.nodes)) dsl = JSON.stringify(input)
    else if (typeof input.work === 'string' || typeof input.work === 'object') {
      return normalizeWorkArtifact(input.work)
    } else throw new Error('无法识别的工件对象形')
  } else {
    throw new Error('work 必须是 DSL/agent_proxy/.works 文本或对应对象')
  }

  if (!dsl || !dsl.trim()) throw new Error('归一后 DSL 为空')
  return { dsl, name, description, decorator, warnings }
}

/** 方言识别：统一引擎按方言路由执行（声明式 → 线性行走内核；画布形 →
 *  超步内核 canvas_kernel）。导入时只做标注，不再拒绝。 */
function detectDialect(dsl) {
  const isCanvas = /["']type["']\s*:\s*["']pyfunc["']/.test(dsl)
    || /(^|\s)type:\s*pyfunc\s*$/.test(dsl)
    || /__canvas_(in|out)/.test(dsl)
    || /["']when["']\s*:/.test(dsl)
    || /(^|\s)when:\s/.test(dsl)
  return {
    kind: isCanvas ? 'canvas' : 'declarative',
    note: isCanvas
      ? '画布形 DSL（pyfunc/when/伪端点语义）→ 统一引擎画布超步内核执行'
      : '声明式词汇 → 统一引擎线性行走内核执行（平台 8301 同语义）',
  }
}

/** 导入一个工作流作品 → 校验 → 入仓（作品存量变组件） */
export async function importWork(args = {}) {
  const s = getStore()
  // 可预见的输入错误（非工作流工件/缺 DSL）返回结构化报告，不抛异常
  let norm
  try {
    norm = normalizeWorkArtifact(args.work)
  } catch (e) {
    return { ok: false, stage: 'parse', error: String(e.message || e) }
  }
  const warnings = [...norm.warnings]
  const dialect = detectDialect(norm.dsl)
  warnings.push(dialect.note)
  const v = await flowValidate({ workflow: norm.dsl })
  if (v.ok === false && (v.errors?.length)) {
    return { ok: false, stage: 'validate', validate: v, warnings }
  }
  const id = args.id || slugify(norm.name) || hashId(norm.dsl)
  if (s.read(id)) warnings.push(`组件 ${id} 已存在，版本将 +1 覆盖`)
  const meta = s.save({
    id,
    name: args.name || norm.name || id,
    tags: args.tags || ['imported', dialect.kind],
    description: args.description || norm.description,
    dsl: norm.dsl,
    source: {
      kind: 'imported',
      note: [args.note, dialect.kind, norm.decorator ? `装饰器: ${norm.decorator}` : '']
        .filter(Boolean).join('；'),
    },
  })
  if (meta.requires.platform_api) {
    warnings.push('组件含 http 节点（requires.platform_api）：dsh 侧执行需提供 platform_api_url/token，否则走 fail 分支')
  }
  return { ok: true, id, component: meta, validate: v, warnings }
}

/** flow 组合节点回调面：组件仓解析 + 递归执行（深度护栏） */
export async function subflowExec(body = {}) {
  const depth = Number(body.depth ?? 0)
  if (depth > FLOW_DEPTH_CAP) {
    return { status: 400, data: { ok: false, error: `子工作流嵌套深度超限（>${FLOW_DEPTH_CAP}）` } }
  }
  const s = getStore()
  const comp = s.read(String(body.workflow_id || ''))
  if (!comp) return { status: 404, data: { ok: false, error: `组件不存在: ${body.workflow_id}` } }
  const r = await flowRun({
    workflow: comp.dsl,
    input: String(body.input ?? ''),
    user_id: body.user_id,
    requester_id: body.requester_id,
    subflow_depth: depth,
  })
  return { status: 200, data: { ok: r.ok, output: r.output ?? null, error: r.error } }
}

// ===== agent 节点接管面（executor: dsh） =====

/** agent 节点回调编排：循环在 agentloop.mjs，工具分派在此。
 *  - LLM：经本服务 llmshim（与执行器同一条 LLM 面）
 *  - workflow 工具体：flowRun 递归执行（内联子 DAG）
 *  - sandbox 工具体：回调执行器 /v1/tools/sandbox（隔离能力留在执行器进程）
 *  - http 工具体：Node 直接 POST {name, arguments}（对齐上游契约） */
export async function agentExec(body = {}) {
  const w = assertWorker()
  const base = selfBase
  if (!base) throw new Error('服务尚未完成绑定（selfBase 未就绪）')
  const toolBodies = body.tool_bodies && typeof body.tool_bodies === 'object'
    ? body.tool_bodies : {}

  return runAgent({
    system_prompt: body.system_prompt,
    input: body.input,
    tools: body.tools,
    max_iterations: body.max_iterations,
    memory_strategy: body.memory_strategy,
    memory_window: body.memory_window,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    model: body.model,
  }, {
    callLlm: async (llmBody) => {
      const res = await fetch(`${base}/v1/llm/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(llmBody),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`)
      try { return JSON.parse(text) } catch { throw new Error(`LLM 响应非 JSON: ${text.slice(0, 120)}`) }
    },
    execTool: async (name, args) => {
      const tb = toolBodies[name]
      if (!tb || typeof tb !== 'object') {
        return JSON.stringify({ error: `未知工具 ${name}` })
      }
      if (typeof tb.workflow === 'string' && tb.workflow.trim()) {
        // 对齐上游 DAG-as-tool：arguments JSON 串作子工作流 input
        const r = await flowRun({
          workflow: tb.workflow,
          input: JSON.stringify(args ?? {}),
          user_id: body.user_id,
          requester_id: body.requester_id,
        })
        return r.ok ? String(r.output ?? '') : JSON.stringify({ error: r.error })
      }
      if (tb.sandbox && typeof tb.sandbox === 'object') {
        const res = await fetch(`${w.url}/v1/tools/sandbox`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandbox: tb.sandbox, arguments: args ?? {} }),
        })
        const j = await res.json().catch(() => ({ ok: false, error: '沙箱端点响应非 JSON' }))
        return j.ok ? String(j.result ?? '') : JSON.stringify({ error: j.error })
      }
      const url = String(tb.http?.url || '').trim()
      if (!url) return JSON.stringify({ error: `工具 ${name} 无执行体` })
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, arguments: args }),
      })
      const text = await res.text()
      if (!res.ok) {
        return JSON.stringify({ error: `HTTP ${res.status}`, detail: text.slice(0, 300) })
      }
      return text
    },
  })
}

// ===== 节点词汇目录（agent 拼装工作流的知识面） =====

const NODE_CATALOG = [
  { type: 'input', purpose: '入口：接收本轮输入', args: {}, note: '全图恰好一个；产物注入 current_value' },
  { type: 'output', purpose: '出口：终态产物', args: {}, note: '至少一个；返回 current_value' },
  { type: 'llm', purpose: '单次 LLM 调用', args: { model: '编号(数字)', system_prompt: '系统提示', temperature: '0-1', max_tokens: '默认2000' }, note: '吃 current_value，产出覆盖之' },
  { type: 'react', purpose: '生成→校验→反思→重试（结构化产出）', args: { schema: 'text|string_array|deck_outline|game_spec|intent|board_spec|board_update', builder: 'none|deck|game', max_iterations: '1-5', output: 'output_var', data_output: '归一产物变量名', reflect: '反思开关', system_prompt: '…' }, note: '产出 {"ok":true|false,...} JSON 文本，配 branch 分流；deck_outline 同时落 slides 变量' },
  { type: 'branch', purpose: '读一个 JSON 变量的布尔路径 → ok/fail', args: { source: '变量名(节点id)', path: '点路径，缺省 ok', checks: '可选精确匹配' }, note: '返回值供条件边匹配，不改写 current_value' },
  { type: 'template', purpose: '模板渲染 {{var}} / {{var.field}}', args: { template: '模板文本', escape: 'raw|json(缺省)', output: 'output_var' }, note: '产物进变量表供下游 {{}} 引用' },
  { type: 'http', purpose: 'HTTP 调用（平台回环 API 等）', args: { method: 'GET|POST', url: '支持 {{platform_api_url}}', headers: '{}', body: '{}（支持 {{}}）' }, note: '依赖 platform_api_url/token（requires.platform_api）' },
  { type: 'flow', purpose: '[dsh] 子工作流组合：工作流即节点', args: { workflow_id: '组件仓 id', workflow: '或内联 DSL', input_template: '渲染子输入，缺省透传', output: 'output_var', timeout: '秒' }, note: '组件引用经宿主递归执行；失败返回 {"ok":false} 可被 branch 分流；深度护栏 4' },
  { type: 'agent', purpose: 'ReAct 工具循环', args: { model: '编号', system_prompt: '…', max_iterations: '≤32', tools: '[{name,description,parameters,http|workflow|sandbox}]' }, note: '工具体三形：http 端点 / 内联子 DAG / 沙箱执行' },
  { type: 'function', purpose: '受限函数节点（语言检测等安全子集）', args: { code: '受限代码' }, note: '产物只进变量表不改写 current_value' },
  { type: 'switch', purpose: '条件边标签路由', args: {}, note: '产物为标签，出边 condition 匹配' },
  { type: 'json', purpose: 'JSON 提取/变换', args: {}, note: '' },
  { type: 'regex', purpose: '正则提取/替换', args: {}, note: '' },
  { type: 'assert', purpose: '断言校验（失败即 fail 文本）', args: {}, note: '' },
  { type: 'emit', purpose: '中间回复（流式通道）', args: { template: '模板' }, note: '副作用型，不改 current_value' },
  { type: 'ticket', purpose: '工单号分配', args: {}, note: '全局持久序列' },
  { type: 'slot', purpose: '装饰器外壳槽位（decorator_dsl 场景）', args: {}, note: 'dsh 直连场景少用' },
  { type: 'deck', purpose: '大纲→幻灯片数据', args: { style: '风格', max_slides: '页数上限' }, note: '一般由 react(deck_outline) 内部调用' },
]

export function nodeCatalog() {
  return {
    node_types: NODE_CATALOG,
    composition: {
      patterns: [
        '链式：input → a → b → output（缺省 output_var=last 逐跳传递）',
        '校验分流：react → branch(source=<react节点id>, path=ok) →（condition ok|fail 分流）',
        '并行/失败降级：多 worker 异键 output → 汇聚节点 {{key1}} {{key2}}',
        '组件复用：flow(workflow_id=X) → branch(X, path=ok) → 降级模板',
      ],
      edge_condition: "出边 condition 与 branch/switch/function 产物做 ==/!= 比较，如 condition: 'ok'",
      variables: 'output/output_var/data_output 进变量表；模板 {{节点id}}/{{变量名.点路径}} 取值',
    },
  }
}
