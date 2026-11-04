/** PPTX 导入：把本机文件交给编辑器内置的 PPTist 导入器，返回导入摘要。 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { defineCapability, defineTool } from '../kernel/define.mjs'

const MAX_BYTES = 128 * 1024 * 1024
const DEFAULT_WAIT_MS = 180_000
const MAX_WAIT_MS = 300_000
const RESULT_URL = '/api/desktop/works/ppt-bridge/import-result'
const PPTX_EXT = /\.pptx$/i

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readBytes({ filePath, data }) {
  if (filePath && data) throw new Error('path 与 data 只能二选一')
  if (!filePath && !data) throw new Error('请提供 path（本机 .pptx 路径）或 data（base64）')

  if (filePath) {
    const abs = path.resolve(String(filePath))
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new Error(`找不到文件：${abs}`)
    }
    if (!stat.isFile()) throw new Error(`不是文件：${abs}`)
    if (!PPTX_EXT.test(abs)) throw new Error('只支持 .pptx（OOXML）文件；.ppt 请先用 PowerPoint 另存为 .pptx')
    if (stat.size > MAX_BYTES) throw new Error(`文件过大：${Math.round(stat.size / 1024 / 1024)}MB（上限 ${MAX_BYTES / 1024 / 1024}MB）`)
    return { bytes: fs.readFileSync(abs), name: path.basename(abs), path: abs }
  }

  const bytes = Buffer.from(String(data), 'base64')
  if (!bytes.length) throw new Error('data 不是有效的 base64 内容')
  if (bytes.length > MAX_BYTES) throw new Error(`文件过大：${Math.round(bytes.length / 1024 / 1024)}MB（上限 ${MAX_BYTES / 1024 / 1024}MB）`)
  return { bytes, name: 'import.pptx', path: '' }
}

function assertPptx(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('不是有效的 PPTX 文件（缺少 ZIP/OOXML 头）')
  }
}

function compactDeck(deck) {
  const slides = Array.isArray(deck?.slides) ? deck.slides : []
  return {
    title: deck?.title || '',
    slides: slides.length,
    elements: slides.reduce((sum, slide) => sum + (Array.isArray(slide.elements) ? slide.elements.length : 0), 0),
    perSlide: slides.map((slide, index) => ({
      index,
      elements: Array.isArray(slide.elements) ? slide.elements.length : 0,
      types: Array.from(new Set((slide.elements || []).map((el) => el.type).filter(Boolean))),
    })),
  }
}

async function waitForMirror(ctx, summary, timeoutMs = 8000) {
  const wantSlides = Number(summary?.import?.final ?? summary?.slideCount ?? 0)
  const wantTitle = String(summary?.title || '')
  const deadline = Date.now() + timeoutMs
  let doc = await ctx.deck.read()
  while (Date.now() < deadline) {
    const deck = doc?.deck || {}
    const slides = Array.isArray(deck.slides) ? deck.slides.length : 0
    const titleOk = !wantTitle || String(deck.title || '') === wantTitle
    if ((!wantSlides || slides === wantSlides) && titleOk) return { doc, synced: true }
    await sleep(150)
    doc = await ctx.deck.read()
  }
  return { doc, synced: false }
}

export const importCapability = defineCapability({
  id: 'import',
  title: '导入 PPTX',
  tags: ['write', 'file'],
  requires: ['deck', 'editor', 'importer'],
  features: ['deck.import'],
  tools: [
    defineTool({
      name: 'ppt_import_pptx',
      description: '打开本机 .pptx：上传给右侧 PPTist 编辑器，用其原生导入器转换成可编辑 deck。导入后返回标题/页数/每页元素摘要；动画、母版、SmartArt、复杂图表等可能丢失。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机 .pptx 文件路径（绝对路径，或相对 MCP 进程 cwd）' },
          data: { type: 'string', description: '可选：PPTX 的 base64 内容（无法访问 path 时使用）' },
          name: { type: 'string', maxLength: 200, description: '显示文件名；缺省取 path 的 basename' },
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description: 'replace（默认）用导入内容替换当前 deck；append 追加到现有页之后',
          },
          wait_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: MAX_WAIT_MS,
            description: '等待编辑器完成导入的毫秒数（默认 180000）',
          },
        },
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.4.0',
      handler: async ({ path: filePath, data, name, mode, wait_ms }, ctx) => {
        const input = readBytes({ filePath, data })
        assertPptx(input.bytes)
        const displayName = String(name || input.name || 'import.pptx')
        const importMode = mode === 'append' ? 'append' : 'replace'
        const waitMs = Math.max(1000, Math.min(Number(wait_ms) || DEFAULT_WAIT_MS, MAX_WAIT_MS))

        /* 导入必须在编辑器页面里执行（复用 PPTist 的 DOM/字体/图片上下文）。 */
        await ctx.editor.require(4000)

        const uploaded = await ctx.importer.upload(input.bytes, displayName, input.path || '')
        if (!uploaded || !uploaded.url) throw new Error('上传 PPTX 失败：桥没有返回临时文件地址')

        const req = `imp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
        const pushed = await ctx.deck.write([
          /* 先压服务端历史快照：导入是编辑器级操作，不走 op 内核；
           * 没有这一步 ppt_history undo 回不到导入前。 */
          { op: 'snapshot' },
          {
            op: 'import-pptx',
            req,
            id: uploaded.id,
            url: uploaded.url,
            name: displayName,
            mode: importMode,
            resultUrl: RESULT_URL,
          },
        ])
        if (!pushed.ok) throw new Error('导入指令投递失败：' + (pushed.error || '编辑器未接受指令'))

        const deadline = Date.now() + waitMs
        let result = null
        while (Date.now() < deadline) {
          try {
            const current = await ctx.importer.result(req)
            if (current && current.done) { result = current; break }
          } catch { /* relay 瞬断：继续轮询直到超时 */ }
          await sleep(200)
        }
        if (!result) {
          throw new Error(
            `等待编辑器导入超时（${Math.round(waitMs / 1000)}s）：请确认右侧编辑器页面已打开并刷新到最新版本`,
          )
        }
        if (!result.ok) throw new Error('PPTX 导入失败：' + (result.error || '编辑器未返回错误详情'))

        const { doc, synced } = await waitForMirror(ctx, result.summary)
        const deck = compactDeck(doc?.deck)
        const summary = result.summary && typeof result.summary === 'object' ? result.summary : {}
        const warnings = []
        if (!synced) warnings.push('deck 镜像尚未追上导入结果；稍后调用 ppt_get_deck 复查')
        if (summary.mounted === false) warnings.push('编辑器返回 mounted=false，导入结果可能不完整')
        const expectedFinal = Number(summary.import?.final ?? summary.slideCount ?? 0)
        if (expectedFinal && deck.perSlide.length !== expectedFinal) {
          warnings.push('导入摘要与 deck 页数不一致；请用 ppt_get_deck 复查')
        }

        return {
          text: JSON.stringify({
            ok: true,
            source: { name: displayName, path: input.path || '', bytes: input.bytes.length, mode: importMode },
            title: deck.title || summary.title || '',
            slideCount: deck.slides,
            elementCount: deck.elements,
            deck: { title: deck.title, slides: deck.slides, elements: deck.elements, perSlide: deck.perSlide },
            imported: summary,
            warnings,
            note: 'PPTX 已转换为 PPTist 编辑模型；动画/母版/SmartArt/复杂图表等可能丢失。建议随后调用 ppt_get_deck 或 ppt_audit 检查。',
          }, null, 2),
        }
      },
    }),
  ],
})
