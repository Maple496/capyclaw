/**
 * standalone/tools.mjs
 *
 * MCP 工具层：复用 lib/canvas-model.mjs，bridge-client 换成 headless-canvas。
 */
import * as headless from './headless-canvas.mjs'
import * as storage from './storage.mjs'
import {
  blocksToElements, documentOf, tableElement, imageElement, replaceInDoc, PAPER,
} from '../lib/canvas-model.mjs'

/** 等待初始化完成 */
async function ensureReady() {
  await headless.start()
}

/** 执行指令并返回结果摘要 */
async function run(cmds, title) {
  await ensureReady()
  const { seq, applied } = await headless.exec(cmds, title)
  const wc = await headless.getWordCount()
  return { seq, applied, word_count: wc }
}

/** MCP 工具实现（与 server/tools.mjs 接口一致） */
export const TOOL_IMPL = {
  async canvas_status() {
    await ensureReady()
    const st = await headless.status()
    return {
      content: [{ type: 'text', text: JSON.stringify(st, null, 2) }],
    }
  },

  async canvas_read(args) {
    await ensureReady()
    const mode = args.mode || 'text'
    if (mode === 'text') {
      const text = await headless.getText()
      const wc = await headless.getWordCount()
      return {
        content: [{ type: 'text', text: `${text}\n\n[字数 ${wc}]` }],
      }
    } else if (mode === 'summary') {
      const st = await headless.status()
      const text = await headless.getText()
      const preview = text.slice(0, 200)
      return {
        content: [{ type: 'text', text: JSON.stringify({
          seq: st.seq,
          word_count: st.word_count,
          text_preview: preview,
          truncated: text.length > 200,
        }, null, 2) }],
      }
    } else {
      const doc = await headless.getDoc()
      return {
        content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }],
      }
    }
  },

  async canvas_write_document(args) {
    const r = await run([{ cmd: 'setValue', args: [documentOf(args.blocks || [])] }],
      args.title || '写入文档')
    return {
      content: [{ type: 'text', text: `已写入（seq ${r.seq}，${r.word_count} 字）` }],
    }
  },

  async canvas_append_blocks(args) {
    const els = blocksToElements(args.blocks || [])
    const r = await run([{ cmd: 'appendElementList', args: [els] }], '追加内容')
    return {
      content: [{ type: 'text', text: `已追加 ${els.length} 个元素（seq ${r.seq}，${r.word_count} 字）` }],
    }
  },

  async canvas_insert_table(args) {
    const el = tableElement(args.headers || [], args.rows || [], args)
    const r = await run([{ cmd: 'appendElementList', args: [[el]] }], '插入表格')
    return {
      content: [{ type: 'text', text: `已插入表格（seq ${r.seq}）` }],
    }
  },

  async canvas_insert_image(args) {
    const el = imageElement(args.src, args.width, args.height)
    const r = await run([{ cmd: 'appendElementList', args: [[el]] }], '插入图片')
    return {
      content: [{ type: 'text', text: `已插入图片（seq ${r.seq}）` }],
    }
  },

  async canvas_replace_text(args) {
    const r = await run([{ cmd: 'replaceText', args: [args.find, args.replace] }], '替换文本')
    return {
      content: [{ type: 'text', text: `已替换（seq ${r.seq}）` }],
    }
  },

  async canvas_page_setup(args) {
    const r = await run([{ cmd: 'pageSetup', args: [args] }], '页面设置')
    return {
      content: [{ type: 'text', text: `已应用页面设置（seq ${r.seq}）` }],
    }
  },

  async canvas_history(args) {
    const cmd = args.action === 'undo' ? 'undo' : 'redo'
    const r = await run([{ cmd, args: [] }], args.action === 'undo' ? '撤销' : '重做')
    return {
      content: [{ type: 'text', text: `已${args.action === 'undo' ? '撤销' : '重做'}（seq ${r.seq}）` }],
    }
  },

  async canvas_screenshot() {
    await ensureReady()
    const dataUrl = await headless.screenshot()
    const base64 = dataUrl.split(',')[1]
    return {
      content: [
        { type: 'text', text: `截图 ${Math.floor(base64.length * 0.75 / 1024)} KB` },
        { type: 'image', data: base64, mimeType: 'image/jpeg' },
      ],
    }
  },

  async canvas_clear() {
    const r = await run([{ cmd: 'setValue', args: [{ header: [], main: [], footer: [] }] }], '清空文档')
    return {
      content: [{ type: 'text', text: `已清空（seq ${r.seq}）` }],
    }
  },

  async canvas_style(args) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'canvas_style 依赖光标选区，headless 模式不支持' }],
    }
  },

  async canvas_save(args) {
    await ensureReady()
    const doc = await headless.getDoc()
    const file = args.file || 'untitled'
    const path = await storage.save(file, doc, { workspace: args.workspace })
    return {
      content: [{ type: 'text', text: `已保存到：${path}` }],
    }
  },

  async canvas_open(args) {
    const file = args.file
    if (!file) {
      return {
        isError: true,
        content: [{ type: 'text', text: '需要 file 参数' }],
      }
    }
    const loaded = await storage.load(file, args.workspace)
    if (!loaded) {
      return {
        isError: true,
        content: [{ type: 'text', text: `文件不存在：${file}` }],
      }
    }
    await ensureReady()
    await headless.exec([{ cmd: 'setValue', args: [loaded.doc] }], '打开文档')
    const wc = await headless.getWordCount()
    return {
      content: [{ type: 'text', text: `已打开：${file}（${wc} 字）` }],
    }
  },

  async canvas_export(args) {
    await ensureReady()
    const format = args.format || 'html'
    const file = args.file || 'export'
    
    if (format === 'html') {
      const text = await headless.getText()
      const html = await storage.exportHtml(await headless.getDoc(), text)
      const path = `${file}.html`
      await storage.save(path, { html }, { workspace: args.workspace })
      return {
        content: [{ type: 'text', text: `已导出 HTML：${path}` }],
      }
    } else if (format === 'pdf') {
      // PDF 需要 Playwright page.pdf()，在 headless-canvas 里实现
      const pdfBuf = await headless.exportPdf()
      const { writeFile } = await import('node:fs/promises')
      const path = `${file}.pdf`
      await writeFile(path, pdfBuf)
      return {
        content: [{ type: 'text', text: `已导出 PDF：${path}` }],
      }
    } else {
      return {
        isError: true,
        content: [{ type: 'text', text: `不支持的格式：${format}` }],
      }
    }
  },

  async canvas_list(args) {
    const files = await storage.list(args.workspace)
    return {
      content: [{ type: 'text', text: `文档列表（${files.length} 个）：\n${files.join('\n')}` }],
    }
  },
}

/** MCP 工具声明（与 server/tools.mjs 一致） */
export const TOOLS = [
  {
    name: 'canvas_status',
    description: '查看编辑器状态',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'canvas_read',
    description: '读取文档内容',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['text', 'summary', 'doc'], description: '读取模式' },
      },
    },
  },
  {
    name: 'canvas_write_document',
    description: '整篇写入文档',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        blocks: { type: 'array', items: { type: 'object' } },
      },
      required: ['blocks'],
    },
  },
  {
    name: 'canvas_append_blocks',
    description: '追加内容',
    inputSchema: {
      type: 'object',
      properties: {
        blocks: { type: 'array', items: { type: 'object' } },
      },
      required: ['blocks'],
    },
  },
  {
    name: 'canvas_insert_table',
    description: '插入表格',
    inputSchema: {
      type: 'object',
      properties: {
        headers: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array' } },
      },
      required: ['headers', 'rows'],
    },
  },
  {
    name: 'canvas_insert_image',
    description: '插入图片',
    inputSchema: {
      type: 'object',
      properties: {
        src: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['src'],
    },
  },
  {
    name: 'canvas_replace_text',
    description: '全文替换',
    inputSchema: {
      type: 'object',
      properties: {
        find: { type: 'string' },
        replace: { type: 'string' },
      },
      required: ['find', 'replace'],
    },
  },
  {
    name: 'canvas_page_setup',
    description: '页面设置',
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'string' },
        direction: { type: 'string' },
        mode: { type: 'string' },
        margins: { type: 'array', items: { type: 'number' } },
      },
    },
  },
  {
    name: 'canvas_screenshot',
    description: '截图',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'canvas_history',
    description: '撤销/重做',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['undo', 'redo'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'canvas_clear',
    description: '清空文档',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'canvas_style',
    description: '设置样式（headless 模式不支持）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'canvas_save',
    description: '保存文档到本地文件',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件名（不含扩展名）' },
        workspace: { type: 'string', description: '工作目录（可选）' },
      },
      required: ['file'],
    },
  },
  {
    name: 'canvas_open',
    description: '打开本地文档',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件名' },
        workspace: { type: 'string', description: '工作目录（可选）' },
      },
      required: ['file'],
    },
  },
  {
    name: 'canvas_export',
    description: '导出文档（html/pdf）',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '输出文件名' },
        format: { type: 'string', enum: ['html', 'pdf'], description: '导出格式' },
        workspace: { type: 'string', description: '工作目录（可选）' },
      },
      required: ['file', 'format'],
    },
  },
  {
    name: 'canvas_list',
    description: '列出所有文档',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: '工作目录（可选）' },
      },
    },
  },
]
