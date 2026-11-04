/**
 * Canvas 工具组（MCP）：面向「长文档写作」而非通用命令转发。
 *
 * 设计取舍：
 *   - 生成 = canvas_write_document（一次成稿，块→元素流，不逐条 exec）
 *   - 续写/插入 = canvas_append_blocks
 *   - 精修 = canvas_style（作用于当前光标选区）/ canvas_replace_text
 *   - 读 = 三层（summary / text / doc），默认不拉整份富文本
 *   - 视觉校验 = canvas_screenshot（编辑器渲染，非 DOM 截图）
 *
 * 每个写工具都会等 applied_seq 追上再返回——Agent 不需要自己轮询。
 */
import {
  push, status, docView, textView, summary, shot, post, waitApplied, waitShot,
} from './bridge-client.mjs'
import {
  blocksToElements, documentOf, tableElement, imageElement, replaceInDoc, PAPER,
} from './canvas-model.mjs'

const ok = (text) => ({ content: [{ type: 'text', text: String(text) }] })
const fail = (text) => ({ content: [{ type: 'text', text: String(text) }], isError: true })

async function run(cmds, title) {
  const doc = await push(cmds, title)
  const st = await waitApplied(doc.seq, 120000)
  return { seq: doc.seq, applied: st.applied_seq, error: st.error || '', word_count: st.word_count }
}

const txt = (o) => JSON.stringify(o, null, 2)

export const TOOLS = [
  {
    name: 'canvas_status',
    description: '查看 Canvas 编辑器状态：seq / 已应用序号 / 字数 / 是否有文档 / 当前租约。（轻量，先调它判断编辑器在不在线）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'canvas_read',
    description: '读取当前文档。mode=summary（默认，摘要+正文预览）| text（纯文本全文）| doc（完整富文本结构，含表格/图片元素）。读全文优先用 text，需要结构才用 doc。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['summary', 'text', 'doc'], description: '读取层级' },
      },
    },
  },
  {
    name: 'canvas_write_document',
    description: '一次成稿：用块数组替换整篇文档（推荐用于「写一份 XX」）。块类型：heading(level 1-4) / paragraph / bullet / number / quote / code / divider。写作规范：先列大纲再展开；标题层级从 1 开始；段落之间自然分段，不要把整篇塞进一个段落。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '本次操作标题（写进桥文档 title，便于追踪）' },
        blocks: {
          type: 'array',
          description: '文档块数组',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['heading', 'paragraph', 'bullet', 'number', 'quote', 'code', 'divider'],
              },
              text: { type: 'string' },
              level: { type: 'number', description: 'heading 层级 1-4' },
              index: { type: 'number', description: 'number 列表序号' },
              style: {
                type: 'object',
                description: '可选行内样式',
                properties: {
                  bold: { type: 'boolean' },
                  italic: { type: 'boolean' },
                  underline: { type: 'boolean' },
                  color: { type: 'string' },
                  size: { type: 'number' },
                  font: { type: 'string' },
                  highlight: { type: 'string' },
                },
              },
            },
            required: ['type'],
          },
        },
      },
      required: ['blocks'],
    },
  },
  {
    name: 'canvas_append_blocks',
    description: '在文档末尾追加块（用于续写、补章节）。块类型与 canvas_write_document 相同。不会动已有内容。',
    inputSchema: {
      type: 'object',
      properties: {
        blocks: { type: 'array', items: { type: 'object' } },
        title: { type: 'string' },
      },
      required: ['blocks'],
    },
  },
  {
    name: 'canvas_insert_table',
    description: '插入表格。headers 为表头行（可选），rows 为数据行。列宽按列数自动均分；表头默认浅灰底。适合对比/清单/参数表。',
    inputSchema: {
      type: 'object',
      properties: {
        headers: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        header_background: { type: 'string', description: '表头底色，如 #eef1f5' },
      },
      required: ['rows'],
    },
  },
  {
    name: 'canvas_insert_image',
    description: '插入图片。src 必须是 dataURL（data:image/...;base64,...）；外链 URL 在编辑器内可能因跨域无法绘制，优先用 dataURL。width/height 为显示尺寸（像素）。',
    inputSchema: {
      type: 'object',
      properties: {
        src: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        caption: { type: 'string' },
      },
      required: ['src'],
    },
  },
  {
    name: 'canvas_style',
    description: '给「当前光标选区」套样式（不传的项不动）。只支持开启加粗等开关；颜色用 #rrggbb；字号像素；字体名直接写（如 "SimSun"）。若没有选区则不生效——批量改样式请用 canvas_write_document 重建。',
    inputSchema: {
      type: 'object',
      properties: {
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        strikeout: { type: 'boolean' },
        color: { type: 'string' },
        size: { type: 'number' },
        font: { type: 'string' },
        highlight: { type: 'string' },
      },
    },
  },
  {
    name: 'canvas_replace_text',
    description: '全文查找替换（保留样式与结构）。返回替换次数。all=false 只换第一处。',
    inputSchema: {
      type: 'object',
      properties: {
        find: { type: 'string' },
        replace: { type: 'string' },
        all: { type: 'boolean', description: '默认 true' },
      },
      required: ['find', 'replace'],
    },
  },
  {
    name: 'canvas_page_setup',
    description: '页面设置：纸张（A4/A3/A5/B4/B5/Letter/Legal 或自定义 width/height）、方向（vertical/horizontal）、页边距 [上,右,下,左] 像素、页面模式（paging 分页 / continuity 连续）。',
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'string', enum: Object.keys(PAPER) },
        width: { type: 'number' },
        height: { type: 'number' },
        direction: { type: 'string', enum: ['vertical', 'horizontal'] },
        margins: { type: 'array', items: { type: 'number' } },
        mode: { type: 'string', enum: ['paging', 'continuity'] },
      },
    },
  },
  {
    name: 'canvas_screenshot',
    description: '让编辑器渲染当前文档并回传截图（约 1-2 秒）。用于视觉自检：排版是否溢出、表格是否错位。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'canvas_history',
    description: '撤销 / 重做。action=undo|redo。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['undo', 'redo'] } },
      required: ['action'],
    },
  },
  {
    name: 'canvas_clear',
    description: '清空文档（替换为空文档）。谨慎使用——不可通过本工具恢复，需靠编辑器撤销。',
    inputSchema: { type: 'object', properties: {} },
  },
]

export const TOOL_IMPL = {
  async canvas_status() {
    return ok(txt(await status()))
  },

  async canvas_read(args = {}) {
    const mode = args.mode || 'summary'
    if (mode === 'text') {
      const v = await textView()
      return ok(v.text ? `${v.text}\n\n[字数 ${v.word_count} / state_seq ${v.state_seq}]` : '（空文档）')
    }
    if (mode === 'doc') {
      const v = await docView()
      return ok(txt({ state_seq: v.state_seq, word_count: v.word_count, doc: v.doc }))
    }
    return ok(txt(await summary()))
  },

  async canvas_write_document(args = {}) {
    const els = blocksToElements(args.blocks || [])
    if (!els.length) return fail('blocks 为空：至少给一个块')
    const r = await run([{ cmd: 'setValue', args: [documentOf(args.blocks || [])] }],
      args.title || '写入文档')
    return ok(`已写入 ${els.length} 个元素（seq ${r.seq}，应用 ${r.applied}，字数 ${r.word_count}）${r.error ? '\n错误: ' + r.error : ''}`)
  },

  async canvas_append_blocks(args = {}) {
    const els = blocksToElements(args.blocks || [])
    if (!els.length) return fail('blocks 为空')
    const r = await run([{ cmd: 'appendElementList', args: [els] }], args.title || '追加内容')
    return ok(`已追加 ${els.length} 个元素（seq ${r.seq}，应用 ${r.applied}，字数 ${r.word_count}）${r.error ? '\n错误: ' + r.error : ''}`)
  },

  async canvas_insert_table(args = {}) {
    const el = tableElement(args.headers, args.rows || [], {
      header_background: args.header_background,
    })
    const r = await run([{ cmd: 'appendElementList', args: [[el]] }], '插入表格')
    return ok(`已插入表格（seq ${r.seq}，应用 ${r.applied}）${r.error ? '\n错误: ' + r.error : ''}`)
  },

  async canvas_insert_image(args = {}) {
    if (!args.src) return fail('缺 src')
    const el = imageElement(args.src, args.width, args.height, args.caption)
    const r = await run([{ cmd: 'appendElementList', args: [[el]] }], '插入图片')
    return ok(`已插入图片（seq ${r.seq}，应用 ${r.applied}）${r.error ? '\n错误: ' + r.error : ''}`)
  },

  async canvas_style(args = {}) {
    const cmds = []
    for (const k of ['bold', 'italic', 'underline', 'strikeout']) {
      if (args[k] === true) cmds.push({ cmd: k, args: [] })
    }
    if (args.color) cmds.push({ cmd: 'color', args: [args.color] })
    if (args.size) cmds.push({ cmd: 'size', args: [Number(args.size)] })
    if (args.font) cmds.push({ cmd: 'font', args: [args.font] })
    if (args.highlight) cmds.push({ cmd: 'highlight', args: [args.highlight] })
    if (!cmds.length) return fail('没有可应用的样式项（只支持开启开关 + color/size/font/highlight）')
    const r = await run(cmds, '样式')
    return ok(`已应用 ${cmds.length} 项样式（seq ${r.seq}）${r.error ? '\n错误: ' + r.error : ''}`)
  },

  async canvas_replace_text(args = {}) {
    if (!args.find) return fail('find 不能为空')
    const view = await docView()
    const { doc, count } = replaceInDoc(view.doc, args.find, args.replace ?? '', args.all !== false)
    if (!count) return ok(`未找到「${args.find}」`)
    const r = await run([{ cmd: 'setValue', args: [doc] }], `替换 ${count} 处`)
    return ok(`已替换 ${count} 处（seq ${r.seq}）${r.error ? '\n错误: ' + r.error : ''}`)
  },

  async canvas_page_setup(args = {}) {
    const cmds = []
    const size = args.size && PAPER[args.size]
    const w = Number(args.width) || (size && size.width)
    const h = Number(args.height) || (size && size.height)
    if (w && h) cmds.push({ cmd: 'paperSize', args: [w, h] })
    if (args.direction) cmds.push({ cmd: 'paperDirection', args: [args.direction] })
    if (Array.isArray(args.margins) && args.margins.length === 4) {
      cmds.push({ cmd: 'setPaperMargin', args: [args.margins.map(Number)] })
    }
    if (args.mode) cmds.push({ cmd: 'pageMode', args: [args.mode] })
    if (!cmds.length) return fail('没有可应用的页面设置')
    const r = await run(cmds, '页面设置')
    return ok(`已应用页面设置（seq ${r.seq}）${r.error ? '\n错误: ' + r.error : ''}`)
  },

  async canvas_screenshot() {
    const r = await post('/shot-request', {})
    const req = r.shot_req
    const s = await waitShot(req, 20000)
    if (!s.data) return fail(`截图超时（req ${req}）：确认编辑器窗口已打开且持有租约`)
    const m = /^data:([^;]+);base64,(.*)$/s.exec(s.data)
    const content = [{ type: 'text', text: `截图 req=${req}，${Math.round(s.data.length / 1024)}KB` }]
    if (m) content.push({ type: 'image', data: m[2], mimeType: m[1] })
    return { content }
  },

  async canvas_history(args = {}) {
    const action = args.action === 'redo' ? 'redo' : 'undo'
    const r = await run([{ cmd: action, args: [] }], action)
    return ok(`已${action === 'redo' ? '重做' : '撤销'}（seq ${r.seq}）${r.error ? '\n错误: ' + r.error : ''}`)
  },

  async canvas_clear() {
    const r = await run([{ cmd: 'setValue', args: [{ header: [], main: [], footer: [] }] }], '清空文档')
    return ok(`已清空（seq ${r.seq}）${r.error ? '\n错误: ' + r.error : ''}`)
  },
}

/** server instructions：agent 的「怎么用这套工具」说明书（≤32KB）。 */
export function serverInstructions(editorHint) {
  return [
    '# Canvas 文档编辑器 - Agent 指南',
    '',
    '## 角色',
    '你是中文长文档写作与排版专家。产物是一份「画布文档」：富文本元素流，',
    '支持标题层级、表格、图片、分页与打印。',
    '',
    '## 工作循环',
    '```',
    'canvas_status()                  # 编辑器在不在线（has_doc / word_count）',
    'canvas_read(mode="summary")      # 先看现状',
    'canvas_write_document(blocks)    # 一次成稿（首选）',
    'canvas_screenshot()              # 视觉自检',
    'canvas_replace_text / style      # 精修',
    '```',
    '',
    '## 生成规范',
    '1. 一次成稿优于多次追加：write_document 一次提交，减少往返。',
    '2. 块类型：heading(1-4) / paragraph / bullet / number / quote / code / divider。',
    '3. 结构：标题 → 导语 → 分节（每节小标题 + 若干段落）→ 结论。',
    '4. 表格用于对比/参数/清单；不要用表格排版整篇文字。',
    '5. 不要写 Markdown 记号（#、**、-）到 text 里——层级与加粗由 type/level/style 表达。',
    '6. 中文排版：段首不空格；中英文之间不加多余空格；数字用半角。',
    '',
    '## 修改规范',
    '- 局部改文字：canvas_replace_text（保留样式）。',
    '- 改结构：重新 canvas_write_document。',
    '- 改样式：canvas_style 只作用于当前光标选区，没有选区不会生效。',
    '- 撤销：canvas_history(action="undo")。',
    '',
    '## 视觉自检',
    '生成后调用 canvas_screenshot；若表格列过挤/图片过大，调小 width 或改回段落。',
    '',
    editorHint ? `编辑器地址：${editorHint}` : '',
  ].filter(Boolean).join('\n')
}
