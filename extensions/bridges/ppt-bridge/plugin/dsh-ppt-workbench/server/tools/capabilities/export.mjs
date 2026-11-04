/** PPTX 导出：把当前 deck 渲染成本机 .pptx 文件。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineCapability, defineTool } from '../kernel/define.mjs'
import { renderDeckToPptx, safeFileName } from '../domains/pptx-export.mjs'

function outputPath({ filePath, fileName, title }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const base = safeFileName(fileName || title || 'presentation')
  const defaultName = `${base}${stamp ? '-' + stamp : ''}.pptx`
  if (!filePath) return path.join(os.tmpdir(), 'ppt-exports', defaultName)

  const resolved = path.resolve(String(filePath))
  if (/\.pptx$/i.test(resolved)) return resolved
  return path.join(resolved, defaultName)
}

export const exportCapability = defineCapability({
  id: 'export',
  title: '导出 PPTX',
  tags: ['write', 'file'],
  requires: ['deck', 'status'],
  features: ['deck.export'],
  tools: [
    defineTool({
      name: 'ppt_export_pptx',
      description: '把当前 deck 导出为本机 .pptx 文件（pptxgenjs）。支持文字/形状/图片/线条/表格/图表/背景/备注；自定义 SVG 路径用矩形近似，LaTeX/音视频跳过。返回文件绝对路径与降级项。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '输出 .pptx 路径，或已存在的目录；缺省写到系统临时目录 ppt-exports/' },
          file_name: { type: 'string', maxLength: 160, description: '文件名（可省略 .pptx）；path 为目录/缺省时使用' },
          slide_indices: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
            maxItems: 200,
            description: '只导出指定页（0 基）；缺省导出全部',
          },
          include_notes: { type: 'boolean', description: '是否写入演讲者备注（默认 true）' },
          overwrite: { type: 'boolean', description: '目标已存在时是否覆盖；保存回原文件必须显式 true' },
          backup: { type: 'boolean', description: '覆盖前是否备份为 <name>.bak-<时间>.pptx（默认 true）' },
        },
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.4.0',
      handler: async ({ path: filePath, file_name, slide_indices, include_notes, overwrite, backup }, ctx) => {
        const doc = await ctx.deck.read()
        const deck = doc && doc.deck
        if (!deck || !Array.isArray(deck.slides) || !deck.slides.length) {
          throw new Error('当前 deck 没有幻灯片，无法导出 PPTX')
        }

        let exportDeck = deck
        if (Array.isArray(slide_indices) && slide_indices.length) {
          const indices = [...new Set(slide_indices.map((value) => Number(value)))]
          const bad = indices.find((index) => !Number.isInteger(index) || index < 0 || index >= deck.slides.length)
          if (bad !== undefined) throw new Error(`页号越界：${bad}（共 ${deck.slides.length} 页）`)
          exportDeck = { ...deck, slides: indices.map((index) => deck.slides[index]) }
        }

        const target = outputPath({ filePath, fileName: file_name, title: deck.title })
        if (fs.existsSync(target) && overwrite !== true) {
          throw new Error('目标文件已存在：保存回原文件请显式传 overwrite:true；否则请换 path 或 file_name 另存')
        }
        const { buffer, stats } = await renderDeckToPptx(exportDeck, {
          assetBase: ctx.status.baseUrl,
          includeNotes: include_notes !== false,
        })
        fs.mkdirSync(path.dirname(target), { recursive: true })
        let backupPath = ''
        if (fs.existsSync(target) && backup !== false) {
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
          backupPath = target.replace(/\.pptx$/i, `.bak-${stamp}.pptx`)
          fs.copyFileSync(target, backupPath)
        }
        fs.writeFileSync(target, buffer)

        return {
          text: JSON.stringify({
            ok: true,
            path: target,
            backup: backupPath,
            bytes: buffer.length,
            title: deck.title || '',
            slides: exportDeck.slides.length,
            stats,
            note: '导出完成。若 stats.skipped/approximated 非 0，说明有元素被跳过或近似，详见 stats.warnings。',
          }, null, 2),
        }
      },
    }),
  ],
})
