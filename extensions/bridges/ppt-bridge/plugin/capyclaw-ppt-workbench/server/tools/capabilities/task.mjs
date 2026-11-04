/** 任务恢复能力：status / list / checkpoint / restore。 */
import { okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const taskCapability = defineCapability({
  id: 'task',
  title: '任务恢复',
  tags: ['state'],
  requires: ['deck', 'task'],
  features: ['deck.task'],
  tools: [
    defineTool({
      name: 'ppt_task',
      description: '任务恢复：status 查当前进度/待处理批次/最近 checkpoint；list 列 checkpoint；checkpoint 保存命名快照；restore 恢复快照。长任务每阶段保存一次。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'list', 'checkpoint', 'restore'] },
          name: { type: 'string', maxLength: 64, description: 'checkpoint 名称（字母/数字/._-）' },
          meta: { type: 'object', description: 'checkpoint 附带的 goal/plan/next 等元数据' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      kind: 'read',
      since: '2.2.0',
      handler: async ({ action, name, meta }, ctx) => {
        if (action === 'status') {
          const status = await ctx.task.status()
          return { text: JSON.stringify(status, null, 2) }
        }
        if (action === 'list') {
          const data = await ctx.task.list()
          return { text: JSON.stringify(data, null, 2) }
        }
        if (action === 'checkpoint') {
          if (!name) throw new Error('checkpoint 需要 name')
          const saved = await ctx.task.checkpoint(name, meta || {})
          return { text: `已保存 checkpoint ${saved.name}（seq ${saved.seq}，${saved.slides} 页）` }
        }
        if (action === 'restore') {
          if (!name) throw new Error('restore 需要 name')
          const saved = await ctx.task.read(name)
          if (!saved || !saved.deck) throw new Error('checkpoint 不存在或内容损坏: ' + name)
          const result = await ctx.deck.write([{ op: 'load', deck: saved.deck }])
          return okText(result, `已恢复 checkpoint ${name}（${saved.slides} 页）`)
        }
        throw new Error('未知 action: ' + action)
      },
    }),
  ],
})
