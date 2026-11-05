/** 契约探测能力：版本、工具清单、能力清单与引擎状态。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { runTool } from '../kernel/output.mjs'

export const contractCapability = defineCapability({
  id: 'contract',
  title: '契约探测',
  tags: ['meta'],
  requires: ['engine', 'server'],
  features: ['browser.contract'],
  tools: [
    defineTool({
      name: 'browser_capabilities',
      description: '返回工作台契约版本、工具清单、能力清单与引擎状态。skill 加载后先调用一次；工具缺失或 major 版本不一致时停止并提示升级。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'read',
      since: '1.0.0',
      handler: async (_args, ctx) => runTool(() => {
        let runtime = { engineRunning: false, tabs: 0, headless: null, evaluateEnabled: false }
        try {
          const status = ctx.engine.status()
          runtime = {
            engineRunning: !!status.running,
            tabs: status.tabs.length,
            headless: !!status.headless,
            evaluateEnabled: !!status.evaluateEnabled,
          }
        } catch { /* 引擎未绑定时仍返回静态契约 */ }
        let workbenchUrl = ''
        try { workbenchUrl = ctx.server.url() } catch { /* 保持空 */ }
        return JSON.stringify(ctx.contract.report(workbenchUrl, runtime), null, 2)
      }),
    }),
  ],
})
