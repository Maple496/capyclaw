/** 视图能力：截图（编辑器 canvas 出图）与页面级视图命令。 */
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { okText, sleep } from '../../bridge-client.mjs'
import { getTuning } from '../../tuning.mjs'

const VIEW_CMDS = new Set(['pageMode', 'pageScale', 'pageScaleAdd', 'pageScaleMinus', 'pageScaleRecovery', 'mode', 'toggleRuler', 'toggleTrace', 'print', 'locationCatalog'])

export const viewCapability = defineCapability({
  id: 'view',
  title: '视图与截图',
  description: 'canvas_screenshot 由编辑器 canvas 元素直接出图（非 DOM 截图）；视图命令只改编辑器显示，不改文档。',
  tags: ['view'],
  requires: ['editor'],
  features: ['view.screenshot', 'view.control'],
  tools: [
    defineTool({
      name: 'canvas_screenshot',
      description: '编辑器渲染截图（所有页拼图，JPEG）：排版自检用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'read',
      since: '1.0.0',
      handler: async (_args, ctx) => {
        await ctx.editor.require()
        await ctx.editor.requestShot()
        const pollMs = getTuning().statusPollMs || 50
        const deadline = Date.now() + 30000
        let shot = null
        while (Date.now() < deadline) {
          shot = await ctx.editor.getShot()
          if (shot && shot.data) break
          await sleep(pollMs)
        }
        if (!shot || !shot.data) throw new Error('截图超时：编辑器页面未回传画面')
        const base64 = String(shot.data).split(',')[1] || ''
        return {
          content: [
            { type: 'text', text: `截图 ${Math.floor(base64.length * 0.75 / 1024)} KB` },
            { type: 'image', data: base64, mimeType: 'image/jpeg' },
          ],
        }
      },
    }),
    defineTool({
      name: 'canvas_view',
      description: '页面级视图命令：pageMode(paging/continuous)/pageScale(0.5-3)/缩放/编辑模式/标尺/修订/打印/定位目录。不改文档内容。',
      inputSchema: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            enum: ['pageMode', 'pageScale', 'pageScaleAdd', 'pageScaleMinus', 'pageScaleRecovery', 'mode', 'toggleRuler', 'toggleTrace', 'print', 'locationCatalog'],
            description: '视图命令',
          },
          value: { type: 'string', description: '命令参数（pageMode: paging|continuous；pageScale: 数字；mode: edit|clean）' },
          title: { type: 'string' },
        },
        required: ['cmd'],
        additionalProperties: false,
      },
      kind: 'control',
      since: '1.0.0',
      handler: async (args, ctx) => {
        if (!VIEW_CMDS.has(args.cmd)) throw new Error(`未知视图命令：${args.cmd}`)
        const cmds = args.value !== undefined
          ? [{ cmd: args.cmd, args: [isNaN(Number(args.value)) ? args.value : Number(args.value)] }]
          : [{ cmd: args.cmd, args: [] }]
        await ctx.editor.require()
        const r = await ctx.doc.write(cmds, args.title || `视图 ${args.cmd}`)
        return okText(r, `已执行 ${args.cmd}`)
      },
    }),
  ],
})
