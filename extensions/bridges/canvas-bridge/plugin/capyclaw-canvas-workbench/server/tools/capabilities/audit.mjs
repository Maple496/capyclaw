/** 审计能力：交付前只读检查（镜像层纯函数，不改稿）。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { auditDoc } from '../../../core/audit.js'
import { readMirror } from '../domains/mirror.mjs'

export const auditCapability = defineCapability({
  id: 'audit',
  title: '文档审计',
  description: '只读审计：空文档/缺标题/超长段落/表格结构/图片引用。产出 blocking / warn 两级发现。',
  tags: ['quality'],
  requires: ['doc'],
  features: ['doc.audit'],
  tools: [
    defineTool({
      name: 'canvas_audit',
      description: '审计当前文档：返回 blocking（必须处理）与 warn（提示）发现列表。只读，不改稿。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'read',
      since: '1.0.0',
      handler: async (_args, ctx) => {
        const doc = await readMirror(ctx)
        const report = auditDoc(doc)
        const lines = [
          `审计结果：${report.ok ? '通过' : '存在 blocking'}（字数 ${report.words}，标题 ${report.counts.heading}）`,
        ]
        for (const f of report.findings) {
          lines.push(`- [${f.level}] ${f.rule}：${f.message}${f.hint ? `（${f.hint}）` : ''}`)
        }
        if (!report.findings.length) lines.push('- 没有发现')
        return { text: lines.join('\n') }
      },
    }),
  ],
})
