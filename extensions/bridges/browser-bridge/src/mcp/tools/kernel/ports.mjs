/**
 * 内核端口：能力模块唯一允许接触的 I/O 面。
 *
 * engine —— 浏览器引擎控制器（lib 侧 src/mcp/engine.mjs；relay 启动后
 *           setEngine 绑定实例，能力经 ctx.engine.* 调用；模块级 registry
 *           在未绑定时调用会得到结构化 ENGINE_UNBOUND 错误）。
 * server —— relay 侧注入的工作台地址（capabilities 报告用）。
 */
const ENGINE_METHODS = [
  'navigate', 'snapshot', 'click', 'fill', 'press', 'select', 'scroll',
  'wait', 'history', 'tabsAction', 'screenshot', 'screenshotBuffer',
  'evaluate', 'close', 'status', 'actionLog',
]

let currentEngine = null
let serverUrl = ''

/** relay 绑定引擎实例（工具面在 relay 进程内运行）。 */
export function setEngine(engine) {
  currentEngine = engine || null
}

/** relay 绑定工作台地址（capabilities 报告展示用）。 */
export function setServerUrl(url) {
  serverUrl = String(url || '')
}

export function getEngine() {
  return currentEngine
}

export function createKernelPorts({ serverBaseUrl = '' } = {}) {
  const base = serverBaseUrl || serverUrl
  const engine = {}
  for (const method of ENGINE_METHODS) {
    engine[method] = (...args) => {
      if (!currentEngine || typeof currentEngine[method] !== 'function') {
        throw Object.assign(new Error('引擎未绑定（relay 未完成装配）'), {
          code: 'ENGINE_UNBOUND',
          hint: '该调用应经 relay 的 /mcp 进入；独立 import 工具面时没有引擎实例。',
        })
      }
      return currentEngine[method](...args)
    }
  }
  return {
    engine,
    server: {
      url: () => base,
    },
  }
}

export const KERNEL_PORT_NAMES = Object.freeze(['engine', 'server'])
