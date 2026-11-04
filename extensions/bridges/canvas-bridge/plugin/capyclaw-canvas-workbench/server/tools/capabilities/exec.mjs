/** 命令透传能力：白名单内的 CanvasApp.exec 原样执行（完整命令面的逃生舱）。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText } from '../../bridge-client.mjs'
import { validateCommands, commandCatalog, COMMAND_NAMES } from '../../../core/commands.js'

export const execCapability = defineCapability({
  id: 'exec',
  title: '命令透传',
  description: `把 {cmd,args} 透传给 CanvasApp.exec（白名单 ${COMMAND_NAMES.size} 条：文档/表格/文字样式/搜索/页面/控件/区域/历史/图片/视图）。工具面没覆盖的组合操作走这里。`,
  tags: ['power'],
  requires: ['editor'],
  features: ['exec.passthrough'],
  tools: [
    defineTool({
      name: 'canvas_exec',
      description: `执行编辑器原生命令（白名单 ${COMMAND_NAMES.size} 条，分组见 canvas_capabilities）。cmds 是 {cmd,args} 数组；顺序执行、整批一条 undo 记录。示例：[{cmd:"insertTitle",args:[1]},{cmd:"bold",args:[true]}]。`,
      inputSchema: {
        type: 'object',
        properties: {
          cmds: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cmd: { type: 'string', description: '命令名（如 insertTable / bold / setRange / paperSize）' },
                args: { type: 'array', description: '命令参数数组' },
              },
              required: ['cmd'],
            },
            description: '命令数组',
          },
          title: { type: 'string' },
        },
        required: ['cmds'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const check = validateCommands(args.cmds)
        if (!check.ok) throw new Error(check.error)
        await ctx.editor.require()
        const r = await ctx.doc.write(check.cmds, args.title || '透传命令')
        return okText(r, `已执行 ${check.cmds.length} 条命令`)
      },
    }),
    defineTool({
      name: 'canvas_commands',
      description: '列出全部可用命令（分组 + 说明）：写 canvas_exec 前先看这里。',
      inputSchema: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '只看某组：doc/table/text/search/page/control/area/history/image/view' },
        },
        additionalProperties: false,
      },
      kind: 'read',
      since: '1.0.0',
      handler: async (args, ctx) => {
        const groups = commandCatalog().filter((g) => !args.group || g.id === args.group)
        if (args.group && !groups.length) throw new Error(`未知分组：${args.group}`)
        const lines = []
        for (const g of groups) {
          lines.push(`## ${g.id} —— ${g.title}${g.viewOnly ? '（视图，不改文档）' : ''}${g.bridge ? '（桥层合成）' : ''}`)
          for (const c of g.commands) lines.push(`- ${c.name}：${c.desc}`)
        }
        return { text: lines.join('\n') }
      },
    }),
  ],
})
