/**
 * 工具输出格式：引擎的结构化错误（code/hint）转成模型可读文本，
 * 不让 MCP 协议壳把提示信息吞掉。
 */
export function ok(text) {
  return { content: [{ type: 'text', text }], isError: false }
}

export function fail(error) {
  const code = error?.code ? `[${error.code}] ` : ''
  const hint = error?.hint ? `\n提示：${error.hint}` : ''
  return { content: [{ type: 'text', text: `${code}${error?.message || String(error)}${hint}` }], isError: true }
}

/** 包一层：handler 里只写业务，错误统一转 fail。 */
export async function runTool(fn) {
  try {
    return ok(await fn())
  } catch (error) {
    return fail(error)
  }
}
