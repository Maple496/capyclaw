/**
 * dsh-flow-engine 宿主插件（Cordis 入口）。
 *
 * 服务宿主、工具面、状态、资产、编辑器全部来自公共插件；
 * 本文件只负责生命周期装配。运行在 harness ctx 内时（ctx.llm 在场）
 * 可用 llmMode:'dsh' 把执行器的全部 LLM 调用接管到 dsh 的 llm 层。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startService } from '../server/relay.mjs'

export const name = 'dsh-flow-engine-host'

/** ctx.llm（流式 content-block）→ 8300 complete 契约的文本桥。
 *  限制：只聚合 text delta；tool 调用面由 shim 侧点名拒绝。 */
function buildCompleteFnFromLlm(ctx, config = {}) {
  const provider = config.llmProvider
  const model = config.llmModel
  return async function complete(body) {
    const messages = (body.messages || []).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }))
    let text = ''
    for await (const chunk of ctx.llm.stream({
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      messages,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.delta === 'string') {
        text += chunk.delta
      }
    }
    return { choices: [{ message: { role: 'assistant', content: text } }] }
  }
}

export async function apply(ctx, config = {}) {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const llmMode = config.llmMode || process.env.DSH_FLOW_LLM_MODE || 'mock'
  let completeFn
  if (llmMode === 'dsh') {
    if (!ctx.llm || typeof ctx.llm.stream !== 'function') {
      throw new Error("[dsh-flow-engine] llmMode='dsh' 需要 harness ctx.llm（请随域挂 @deepseek-ai/dsh-llm + 适配器）")
    }
    completeFn = buildCompleteFnFromLlm(ctx, config)
    console.log('[dsh-flow-engine] LLM 层接管：ctx.llm（react/agent 生成经 dsh llm 面执行）')
  }
  const service = await startService({
    packageDir,
    port: Number(config.port) || 39600,
    hostDir: config.hostDir || process.env.DSH_FLOW_ENGINE_HOME,
    strictPort: config.strictPort,
    lockFile: config.lockFile,
    llmMode,
    llmBaseUrl: config.llmBaseUrl,
    llmApiKey: config.llmApiKey,
    llmModelMap: config.llmModelMap,
    llmDefaultModel: config.llmDefaultModel,
    completeFn,
  })
  console.log(`[dsh-flow-engine] ${service.reused ? '复用' : '启动'}服务: ${service.url}（executor: ${service.executorUrl}）`)
  return async () => {
    await service.stop()
    console.log('[dsh-flow-engine] 服务已停止')
  }
}
