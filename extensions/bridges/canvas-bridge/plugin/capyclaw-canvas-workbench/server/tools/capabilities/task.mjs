/** 任务与检查点能力：长任务的存档/恢复。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText } from '../../bridge-client.mjs'
import { readMirror, writeMirror } from '../domains/mirror.mjs'

export const taskCapability = defineCapability({
  id: 'task',
  title: '任务检查点',
  description: '批次状态 + 命名检查点：大改前存档、失败后恢复（checkpoint 载荷是完整 doc）。',
  tags: ['task'],
  requires: ['doc', 'task', 'editor'],
  features: ['task.checkpoint'],
  tools: [
    defineTool({
      name: 'canvas_task',
      description: '任务状态与检查点列表：seq/applied_seq/编辑器连接 + 已有检查点名。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'read',
      since: '1.0.0',
      handler: async (_args, ctx) => {
        const [status, checkpoints] = await Promise.all([ctx.task.status(), ctx.task.list()])
        const names = (checkpoints && checkpoints.checkpoints) || []
        return { text: JSON.stringify({ ...status, checkpoints: names }, null, 2) }
      },
    }),
    defineTool({
      name: 'canvas_checkpoint',
      description: '检查点操作：save（当前文档存为命名检查点）/ restore（恢复到检查点）/ read（读检查点内容）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'restore', 'read'], description: '操作' },
          name: { type: 'string', description: '检查点名（save 默认 auto）' },
          title: { type: 'string' },
        },
        required: ['action', 'name'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const name = String(args.name || '').trim()
        if (!name) throw new Error('name 不能为空')
        if (args.action === 'save') {
          const doc = await readMirror(ctx)
          const payload = await ctx.task.checkpoint(name, { words: ctx.doc.wordCountOf(doc) })
          return { text: `已存检查点 ${name}（${payload && payload.seq != null ? 'seq ' + payload.seq : 'ok'}）` }
        }
        if (args.action === 'read') {
          const payload = await ctx.task.read(name)
          return { text: JSON.stringify(payload, null, 2).slice(0, 8000) }
        }
        if (args.action === 'restore') {
          const payload = await ctx.task.read(name)
          const doc = payload && (payload.doc || payload.checkpoint && payload.checkpoint.doc)
          if (!doc || typeof doc !== 'object') throw new Error(`检查点 ${name} 里没有文档载荷`)
          const r = await writeMirror(ctx, doc, `恢复检查点 ${name}`)
          return okText(r, `已恢复 ${name}`)
        }
        throw new Error(`未知 action：${args.action}`)
      },
    }),
  ],
})
