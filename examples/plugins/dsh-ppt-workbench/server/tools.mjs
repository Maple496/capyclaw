/** MCP 工具定义与实现（供 index.mjs 与契约测试共用）。 */
import {
  getDeckOnly, getShot, getStatus, post, push, okText, requireEditor, sleep, clamp, summarize,
} from './bridge-client.mjs'
import { buildDeck, escapeHtml } from './deck-layout.mjs'
import fs from 'node:fs'
import path from 'node:path'

const COLORS = {
  蓝: '#5b9bd5', 蓝色: '#5b9bd5', 天蓝: '#87ceeb', 淡蓝: '#add8e6', 浅蓝: '#b3e5fc', 深蓝: '#1e3a8a',
  白: '#ffffff', 白色: '#ffffff', 黑: '#000000', 黑色: '#000000',
  灰: '#cccccc', 灰色: '#cccccc', 深灰: '#333333', 浅灰: '#f2f2f2',
  黄: '#ffe066', 淡黄: '#fffacd', 浅黄: '#fffacd', 米色: '#f5f5dc',
  红: '#d14424', 红色: '#d14424', 绿: '#2e7d32', 绿色: '#2e7d32',
  紫: '#7e57c2', 紫色: '#7e57c2', 橙: '#f0a030', 橙色: '#f0a030',
  粉: '#ffc0cb', 粉色: '#ffc0cb', 青: '#20b2aa', 青色: '#20b2aa',
  棕: '#8d6e63', 棕色: '#8d6e63',
}
function resolveColor(v) {
  const s = String(v || '').trim()
  if (COLORS[s]) return COLORS[s]
  /* 最长匹配 + 同长度取更早出现：「天蓝色」应命中「天蓝」而不是「蓝色」 */
  let best = null
  for (const k of Object.keys(COLORS)) {
    const idx = s.indexOf(k)
    if (idx < 0) continue
    if (!best || k.length > best.k.length || (k.length === best.k.length && idx < best.idx)) {
      best = { k, idx }
    }
  }
  return best ? COLORS[best.k] : s
}

export const TEMPLATES = [
  { id: 'template_1', name: '山河映红', use: '正式汇报 / 品牌发布（红金，气势）' },
  { id: 'template_2', name: '都市蓝调', use: '商务汇报 / 数据复盘（蓝灰，理性）' },
  { id: 'template_3', name: '智感几何', use: '科技 / 产品发布（几何，现代）' },
  { id: 'template_4', name: '柔光莫兰迪', use: '品牌 / 生活方式（低饱和，柔和）' },
  { id: 'template_5', name: '简约绿意', use: '环保 / 健康 / 增长（绿色，清新）' },
  { id: 'template_6', name: '暖色复古', use: '文化 / 故事 / 回顾（暖棕，叙事）' },
  { id: 'template_7', name: '深邃沉稳', use: '战略 / 年度总结（深色，稳重）' },
  { id: 'template_8', name: '浅蓝小清新', use: '培训 / 校园 / 轻松主题（浅蓝，轻快）' },
]
export const resolveTemplate = (v) => {
  const s = String(v || '').trim()
  const hit = TEMPLATES.find(t => t.id === s || t.name === s || t.name.includes(s) || s.includes(t.name))
  return hit ? hit.id : ''
}

/* ---- 图片附件（2026-10-22）：聊天附件 → data URL ---------------- */

function imageMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/png'
}

function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf.length > 24) {
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
  }
  if (buf.slice(0, 3).toString('ascii') === 'GIF' && buf.length > 10) {
    return [buf.readUInt16LE(6), buf.readUInt16LE(8)]
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1]
      i += 2
      if (m === 0xd8 || m === 0xd9 || m === 0x01) continue
      const len = buf.readUInt16BE(i)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) {
        return [buf.readUInt16BE(i + 5), buf.readUInt16BE(i + 3)]
      }
      i += len
    }
  }
  return null
}

function resolveAttachmentFile(id) {
  const hex = String(id || '').replace(/^sha256:/i, '')
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('attachment_id 必须是 sha256:<64位hex>')
  const roots = []
  if (process.env.DSH_HOME) roots.push(path.join(process.env.DSH_HOME, 'attachments', 'v1', 'objects'))
  if (process.env.DSH_ATTACHMENTS_DIR) roots.push(process.env.DSH_ATTACHMENTS_DIR)
  if (process.env.USERPROFILE) roots.push(path.join(process.env.USERPROFILE, '.dsh', 'attachments', 'v1', 'objects'))
  for (const root of roots) {
    const p = path.join(root, hex.slice(0, 2), hex)
    if (fs.existsSync(p)) return p
  }
  throw new Error('找不到聊天附件：' + id + '（请在聊天里重新粘贴图片）')
}


export const TOOLS = [
  {
    name: 'ppt_get_deck',
    description: '读当前演示文稿：标题、每页背景/元素。需要精确定位（页号/元素 id）时调用；改背景/加页/改首个文本不要先读。',
    inputSchema: {
      type: 'object',
      properties: { detailed: { type: 'boolean', description: '元素几何/颜色等细节（缺省只给摘要）' } },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_text',
    description: '改文字：某页或某几页（缺省全部页）的首个文本，或指定 element_id 的文本；可同时改字号/颜色/加粗/对齐。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        slide: { type: 'integer', description: '0 起页号' },
        slides: { type: 'array', items: { type: 'integer' }, description: '0 起页号数组（缺省=全部）' },
        element_id: { type: 'string', description: '元素 id（缺省=首个文本）' },
        font_size: { type: 'integer' },
        color: { type: 'string', description: 'CSS 颜色或中文色名' },
        bold: { type: 'boolean' },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_style',
    description: '整体样式：背景色（可指定页），文字颜色，字体名，主题色数组。浅底会自动配深字、深底配白字。',
    inputSchema: {
      type: 'object',
      properties: {
        background: { type: 'string', description: '背景色（CSS 或中文色名）' },
        slides: { type: 'array', items: { type: 'integer' }, description: '只改这些页的背景；缺省全部' },
        contrast: { type: 'boolean', description: '自动对比度，缺省 true' },
        text_color: { type: 'string', description: '全局正文颜色' },
        font_name: { type: 'string' },
        theme_colors: { type: 'array', items: { type: 'string' }, description: '主题色数组' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_element',
    description: '元素级编辑：add 加文本/形状/图片，update 改位置/尺寸/旋转/填充/文字样式，remove 删除。插入图片优先用 ppt_image。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove'] },
        slide: { type: 'integer', description: '0 起页号' },
        element_id: { type: 'string' },
        element: {
          type: 'object',
          description: "add 用：{type:'text'|'shape'|'image', text?/content?, src?(image), fill?, left?, top?, width?, height?, fontSize?, color?}",
        },
        props: {
          type: 'object',
          description: 'update 用：{left?,top?,width?,height?,rotate?,opacity?,fill?,src?,text?,fontSize?,color?,bold?,align?}',
        },
      },
      required: ['action', 'slide'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_image',
    description: '插入图片（一次完成，插入后读回 deck 自校验）：attachment_id 取聊天图片附件的 sha256 id；也支持 path/src。自动压缩并等比放到指定页（缺省封面）。不要用 shell 找图，不要截图验证。',
    inputSchema: {
      type: 'object',
      properties: {
        slide: { type: 'integer', description: '0 起页号，缺省 0（封面）' },
        attachment_id: { type: 'string', description: '聊天图片附件的 attachmentId（sha256:…）' },
        path: { type: 'string', description: '本机图片路径（兼容旧用法）' },
        src: { type: 'string', description: 'http(s) 或 data URL' },
        left: { type: 'number' },
        top: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_slide',
    description: '页管理：add（标题+要点）/remove/move/duplicate/select。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'move', 'duplicate', 'select'] },
        index: { type: 'integer', description: '目标页号（0 起）；add 时为插入位置，缺省末尾' },
        to: { type: 'integer', description: 'move 的目标位置' },
        title: { type: 'string', description: 'add 的标题' },
        bullets: { type: 'array', items: { type: 'string' } },
        background: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_history',
    description: '撤销/重做。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['undo', 'redo'] } },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_present',
    description: '放映控制：start（可指定起始页）/ exit。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'exit'] },
        slide: { type: 'integer', description: 'start 的起始页（0 起）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_apply',
    description: '通用逃生口：一次提交任意底层指令数组（load / update-slide / add-element / set-background / theme / …），复杂组合动作用。',
    inputSchema: {
      type: 'object',
      properties: {
        ops: { type: 'array', items: { type: 'object' }, description: '底层 op 数组' },
        title: { type: 'string', description: 'deck 标题（可选）' },
      },
      required: ['ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_templates',
    description: '列出官方模板（风格唯一来源）：id / 名称 / 适用场景。做新 PPT 必须先选一个模板。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ppt_template',
    description: '套用官方模板（template_1..8 或名称）：加载模板的 slides + theme 作为风格底。之后用 ppt_get_deck / ppt_fill 填内容。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '模板 id 或名称（如 template_2 / 都市蓝调）' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_fill',
    description: '填充模板文本槽位：把某页的第 slot 个文本（0 起）改成 text，可带字号/颜色/加粗/对齐。保留模板版式。',
    inputSchema: {
      type: 'object',
      properties: {
        slide: { type: 'integer', description: '0 起页号' },
        slot: { type: 'integer', description: '该页第几个文本元素（0 起）' },
        text: { type: 'string' },
        font_size: { type: 'integer' },
        color: { type: 'string' },
        bold: { type: 'boolean' },
        align: { type: 'string' },
      },
      required: ['slide', 'slot', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_template_deck',
    description: '用官方模板一次成稿：选模板 + 封面/目录/章节要点/结尾，自动挑选模板版式页并填充文本（风格唯一来源=官方模板）。',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: '模板 id 或名称（先调 ppt_templates）' },
        title: { type: 'string', description: 'deck 标题' },
        cover: {
          type: 'object',
          properties: { title: { type: 'string' }, subtitle: { type: 'string' }, presenter: { type: 'string' } },
        },
        toc: { type: 'boolean', description: '是否生成目录页，缺省 true' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
            },
            required: ['title'],
          },
          description: '章节列表；每节生成一张过渡页 + 一张内容页（bullets 可为字符串或 {text,detail}）',
        },
        end: { type: 'object', properties: { title: { type: 'string' }, subtitle: { type: 'string' } } },
        cover_variant: { type: 'integer', description: '封面版式序号（0 起，缺省 0）' },
      },
      required: ['template', 'sections'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_deck',
    description: '从大纲一次成稿：按版式（cover/section/bullets/two/stat/quote/end）+ 设计预设（clean/business/warm/tech）生成整套专业排版 deck，替换当前内容。做新 PPT 首选。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        preset: { type: 'string', enum: ['clean', 'business', 'warm', 'tech'] },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              layout: { type: 'string', enum: ['cover', 'section', 'bullets', 'two', 'stat', 'quote', 'end'] },
              title: { type: 'string' },
              subtitle: { type: 'string' },
              kicker: { type: 'string' },
              index: { type: 'integer' },
              bullets: { type: 'array' },
              left: { type: 'object' }, right: { type: 'object' },
              stats: { type: 'array' },
              quote: { type: 'string' }, author: { type: 'string' },
              note: { type: 'string' }, foot: { type: 'string' },
            },
            required: ['layout'],
          },
        },
      },
      required: ['slides'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_recolor',
    description: '一键整体换色（一次调用完成）：背景 + 全部文字对比色 + 装饰形状（线条/圆点/色条）统一色。改整体背景/配色时优先用它，禁止逐页 ppt_element 改色。',
    inputSchema: {
      type: 'object',
      properties: {
        background: { type: 'string', description: '新背景色（CSS 颜色或中文色名）' },
        text: { type: 'string', description: '文字颜色；缺省按背景自动对比（浅底深字/深底白字）' },
        shapes: { type: 'string', description: '装饰形状填充色；缺省跟随文字色（传 null 表示不改装饰）' },
        slides: { type: 'array', items: { type: 'integer' }, description: '只改这些页；缺省全部' },
      },
      required: ['background'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_screenshot',
    description: '取右侧编辑器实时画面（全部页拼图）。确认视觉效果时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function simpleSlide(title, bullets, background) {
  const W = 1000, pad = 60, ts = Date.now()
  const els = [{
    type: 'text', id: `mcp_t_${ts}`,
    left: pad, top: 50, width: W - pad * 2, height: 70,
    content: `<p style="font-size: 34px;"><strong>${escapeHtml(title)}</strong></p>`,
    defaultColor: '#333333', defaultFontName: '', fixedRatio: false, rotate: 0,
  }]
  ;(bullets || []).slice(0, 8).forEach((b, i) => {
    els.push({
      type: 'text', id: `mcp_b_${ts}_${i}`,
      left: pad, top: 150 + i * 46, width: W - pad * 2, height: 42,
      content: `<p style="font-size: 20px; color: #555555;">• ${escapeHtml(String(b))}</p>`,
      defaultColor: '#333333', defaultFontName: '', fixedRatio: false, rotate: 0,
    })
  })
  return { id: `mcp_slide_${ts}`, background: { type: 'solid', color: background || '#ffffff' }, elements: els }
}

/** 旧编辑器兼容：把一次整体换色展开为 set-background + set-element 队列。
 *  纯函数，便于单测；每批 ≤90 条由调用方分组推送（包络上限 100）。 */
export function expandRecolorOps(deck, { bg, fg, sf, targets }) {
  const ops = []
  const list = (deck && deck.slides) || []
  list.forEach((s, i) => {
    if (targets && targets.indexOf(i) < 0) return
    ops.push({ op: 'set-background', color: bg, indices: [i], contrast: true })
    ;(s.elements || []).forEach(el => {
      if (el.type === 'text') return
      const props = {}
      if (sf && el.fill != null) props.fill = sf
      if (el.text && typeof el.text.content === 'string') props.color = fg
      if (Object.keys(props).length) {
        ops.push({ op: 'set-element', slide: i, elementId: el.id, props })
      }
    })
  })
  return ops
}

export const TOOL_IMPL = {
  async ppt_get_deck({ detailed }) {
    const doc = await getDeckOnly()
    return { text: summarize(doc.deck, !!detailed) }
  },
  async ppt_text({ text, slide, slides, element_id, font_size, color, bold, align }) {
    const base = { text: String(text ?? '') }
    if (element_id) base.elementId = String(element_id)
    if (font_size != null) base.fontSize = clamp(Number(font_size) | 0, 8, 200)
    if (color) base.color = resolveColor(color)
    if (bold != null) base.bold = !!bold
    if (align) base.align = align
    const targets = Array.isArray(slides) && slides.length
      ? slides.map(n => clamp(Number(n) | 0, 0, 999))
      : (slide !== undefined && slide !== null)
        ? [clamp(Number(slide) | 0, 0, 999)]
        : null
    if (targets) {
      const r = await push(targets.map(i => Object.assign({ op: 'set-text', id: i }, base)))
      return okText(r, `已改 ${targets.length} 页文本`)
    }
    const doc = await getDeckOnly()
    const n = doc.deck && Array.isArray(doc.deck.slides) ? doc.deck.slides.length : 0
    if (!n) throw new Error('桥上没有 deck')
    const r = await push(Array.from({ length: n }, (_, i) => Object.assign({ op: 'set-text', id: i }, base)))
    return okText(r, `已改全部 ${n} 页文本`)
  },
  async ppt_style({ background, slides, contrast, text_color, font_name, theme_colors }) {
    const ops = []
    if (background) {
      const cmd = { op: 'set-background', color: resolveColor(background), contrast: contrast !== false }
      if (Array.isArray(slides) && slides.length) cmd.indices = slides.map(n => clamp(Number(n) | 0, 0, 999))
      ops.push(cmd)
    }
    const theme = {}
    if (text_color) theme.fontColor = resolveColor(text_color)
    if (font_name) theme.fontName = String(font_name)
    if (Array.isArray(theme_colors) && theme_colors.length) theme.themeColors = theme_colors.map(resolveColor)
    if (Object.keys(theme).length) ops.push({ op: 'theme', theme })
    const r = await push(ops)
    return okText(r, '样式已更新')
  },
  async ppt_element({ action, slide, element_id, element, props }) {
    const i = clamp(Number(slide) | 0, 0, 999)
    if (action === 'add') {
      const el = element || {}
      const isImage = el.type === 'image'
      let beforeIds = new Set()
      if (isImage) {
        const before = await getDeckOnly()
        const s0 = (before.deck && before.deck.slides || [])[i] || {}
        beforeIds = new Set((s0.elements || []).filter(e => e.type === 'image').map(e => e.id))
      }
      const r = await push([{ op: 'add-element', slide: i, element: el }])
      if (!r.ok) return okText(r, `第 ${i} 页加元素失败`)
      if (isImage) {
        const after = await getDeckOnly()
        const s1 = (after.deck && after.deck.slides || [])[i] || {}
        const img = (s1.elements || []).find(e => e.type === 'image' && !beforeIds.has(e.id))
        if (!img) throw new Error('图片未真正插入：deck 中没有出现新的 image 元素。请按 F5 刷新桌面加载新编辑器后重试（不要重复插入）。')
        return { text: `已在第 ${i} 页插入并校验图片 id=${img.id}（${Math.round(img.width)}×${Math.round(img.height)}）` }
      }
      return okText(r, `已在第 ${i} 页加元素`)
    }
    if (!element_id) throw new Error('update/remove 需要 element_id')
    if (action === 'remove') {
      const r = await push([{ op: 'remove-element', slide: i, elementId: String(element_id) }])
      return okText(r, `已删除元素 ${element_id}`)
    }
    if (action === 'update') {
      const cleaned = {}
      const p = props || {}
      ;['left', 'top', 'width', 'height', 'rotate', 'opacity', 'fill', 'src', 'text', 'html', 'fontSize', 'color', 'bold', 'align', 'defaultColor'].forEach(k => {
        if (p[k] != null) cleaned[k] = p[k]
      })
      if (cleaned.color) cleaned.color = resolveColor(cleaned.color)
      const r = await push([{ op: 'set-element', slide: i, elementId: String(element_id), props: cleaned }])
      return okText(r, `已更新元素 ${element_id}`)
    }
    throw new Error('未知 action: ' + action)
  },
  async ppt_image({ slide, attachment_id, attachmentId, path: filePath, src, left, top, width, height }) {
    const i = clamp(Number(slide == null ? 0 : slide) | 0, 0, 999)
    const aid = attachment_id || attachmentId
    let buf = null
    let dataUrl = ''
    let natW = 0, natH = 0
    if (aid) {
      const p = resolveAttachmentFile(aid)
      buf = fs.readFileSync(p)
    } else if (filePath) {
      if (!fs.existsSync(String(filePath))) throw new Error('图片文件不存在：' + filePath)
      buf = fs.readFileSync(String(filePath))
    } else if (src) {
      const s = String(src)
      if (/^(https?:|data:)/i.test(s)) {
        dataUrl = s
      } else if (fs.existsSync(s)) {
        buf = fs.readFileSync(s)
      } else {
        throw new Error('src 既不是 http(s)/data URL，也不是存在的文件：' + s.slice(0, 120))
      }
    } else {
      throw new Error('ppt_image 需要 attachment_id / path / src 之一')
    }
    if (buf) {
      if (buf.length > 6 * 1024 * 1024) throw new Error('图片过大（>6MB），请先压缩后再插入')
      const mime = imageMime(buf)
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      const sz = imageSize(buf)
      if (sz) { natW = sz[0]; natH = sz[1] }
    }
    const SW = 1000, SH = 562.5
    let w = width != null ? Number(width) : null
    let h = height != null ? Number(height) : null
    if ((w == null || h == null) && natW && natH) {
      if (w == null && h == null) {
        const scale = Math.min(SW / natW, SH / natH)
        w = natW * scale; h = natH * scale
      } else if (w == null) {
        w = h * natW / natH
      } else {
        h = w * natH / natW
      }
    }
    if (w == null) w = SW
    if (h == null) h = SH
    const l = left != null ? Number(left) : Math.round((SW - w) / 2)
    const t = top != null ? Number(top) : Math.round((SH - h) / 2)
    const element = {
      type: 'image', src: dataUrl,
      left: l, top: t, width: Math.round(w), height: Math.round(h),
    }
    const beforeDoc = await getDeckOnly()
    const beforeSlide = ((beforeDoc.deck && beforeDoc.deck.slides) || [])[i] || {}
    const beforeIds = new Set((beforeSlide.elements || []).filter(e => e.type === 'image').map(e => e.id))
    const r = await push([{ op: 'add-element', slide: i, element }])
    if (!r.ok) return okText(r, '图片插入失败')
    const afterDoc = await getDeckOnly()
    const afterSlide = ((afterDoc.deck && afterDoc.deck.slides) || [])[i] || {}
    const newImg = (afterSlide.elements || []).find(e => e.type === 'image' && !beforeIds.has(e.id))
    if (!newImg) {
      throw new Error('图片未真正插入：deck 中目标页没有新增 image 元素。最常见原因是编辑器还是旧 bundle（不支持 image），请按 F5 刷新桌面后重试；不要重复插入。')
    }
    const imgSrc = String(newImg.src || '')
    if (!/^data:image\//i.test(imgSrc) && !/^https?:/i.test(imgSrc)) {
      throw new Error('图片元素已创建但 src 无效（不是 data:image/http URL），请重试或刷新编辑器。')
    }
    const nat = natW && natH ? `${natW}×${natH}` : '外部图'
    const kb = Math.round(imgSrc.length * 0.75 / 1024)
    return { text: `已插入并校验：第 ${i} 页新增图片 id=${newImg.id}（${nat} → ${Math.round(newImg.width)}×${Math.round(newImg.height)}，${kb}KB）` }
  },
  async ppt_slide({ action, index, to, title, bullets, background }) {
    if (action === 'add') {
      let at = index != null ? clamp(Number(index) | 0, 0, 999) : null
      if (at == null) {
        const doc = await getDeckOnly()
        at = (doc.deck && Array.isArray(doc.deck.slides)) ? doc.deck.slides.length : 0
      }
      const r = await push([{ op: 'add-slide', slide: simpleSlide(title || '新一页', bullets, background), index: at }])
      return okText(r, `已加一页「${title || '新一页'}」`)
    }
    if (action === 'remove') {
      const r = await push([{ op: 'remove-slide', id: clamp(Number(index) | 0, 0, 999) }])
      return okText(r, `已删除第 ${index} 页`)
    }
    if (action === 'move') {
      const r = await push([{ op: 'move-slide', from: clamp(Number(index) | 0, 0, 999), to: clamp(Number(to) | 0, 0, 999) }])
      return okText(r, `已移动第 ${index} 页到 ${to}`)
    }
    if (action === 'duplicate') {
      const r = await push([{ op: 'duplicate-slide', id: clamp(Number(index) | 0, 0, 999) }])
      return okText(r, `已复制第 ${index} 页`)
    }
    if (action === 'select') {
      const r = await push([{ op: 'select', id: clamp(Number(index) | 0, 0, 999) }])
      return okText(r, `已选中第 ${index} 页`)
    }
    throw new Error('未知 action: ' + action)
  },
  async ppt_history({ action }) {
    const r = await push([{ op: String(action) }])
    return okText(r, action === 'undo' ? '已撤销' : '已重做')
  },
  async ppt_present({ action, slide }) {
    const r = action === 'exit'
      ? await push([{ op: 'exit-present' }])
      : await push([{ op: 'present', index: slide != null ? clamp(Number(slide) | 0, 0, 999) : undefined }])
    return okText(r, action === 'exit' ? '已退出放映' : '已开始放映')
  },
  async ppt_apply({ ops, title }) {
    if (!Array.isArray(ops) || !ops.length) throw new Error('ops 不能为空')
    const r = await push(ops, title)
    return okText(r, `已应用 ${ops.length} 条指令`)
  },
  async ppt_templates() {
    return { text: TEMPLATES.map(t => `${t.id} · ${t.name} —— ${t.use}`).join('\n') }
  },
  async ppt_template({ id }) {
    const tid = resolveTemplate(id)
    if (!tid) throw new Error('未知模板：' + id + '（先调 ppt_templates）')
    const r = await push([{ op: 'template', id: tid }])
    if (!r.ok) return okText(r, '模板应用失败')
    const doc = await getDeckOnly()
    const n = doc.deck && Array.isArray(doc.deck.slides) ? doc.deck.slides.length : 0
    return okText(r, `已套用模板 ${tid}（${n} 页），可开始填充内容`)
  },
  async ppt_fill({ slide, slot, text, font_size, color, bold, align }) {
    const cmd = { op: 'fill-slot', slide: clamp(Number(slide) | 0, 0, 999), slot: clamp(Number(slot) | 0, 0, 99), text: String(text ?? '') }
    if (font_size != null) cmd.fontSize = clamp(Number(font_size) | 0, 8, 200)
    if (color) cmd.color = resolveColor(color)
    if (bold != null) cmd.bold = !!bold
    if (align) cmd.align = align
    const r = await push([cmd])
    return okText(r, `已填第 ${slide} 页槽位 ${slot}`)
  },
  async ppt_template_deck({ template, title, cover, toc, sections, end, cover_variant }) {
    const tid = resolveTemplate(template)
    if (!tid) throw new Error('未知模板：' + template + '（先调 ppt_templates）')
    const r = await push([{
      op: 'template-deck', template: tid, title: title || '演示文稿',
      cover: cover || {}, toc: toc !== false, sections: sections || [],
      end: end || {}, coverVariant: cover_variant || 0,
    }])
    if (!r.ok) return okText(r, '模板成稿失败')
    return okText(r, `已用模板 ${tid} 生成 ${(sections || []).length} 章（封面+目录+章节+结尾）`)
  },
  async ppt_deck({ title, preset, slides }) {
    const deck = buildDeck({ title, preset, slides })
    const r = await push([{ op: 'load', deck: deck }])
    return okText(r, `已生成 ${deck.slides.length} 页「${deck.title}」（预设 ${preset || 'clean'}）`)
  },
  async ppt_recolor({ background, text, shapes, slides }) {
    const bg = resolveColor(background)
    const textColor = text ? resolveColor(text) : ''
    const shapeColor = shapes === undefined ? undefined : (shapes === null ? null : resolveColor(shapes))
    const targets = Array.isArray(slides) && slides.length
      ? slides.map(n => clamp(Number(n) | 0, 0, 999))
      : null

    // 1) 新编辑器：单条 recolor 指令（背景+文字+装饰一次完成）
    const cmd = { op: 'recolor', background: bg }
    if (textColor) cmd.text = textColor
    if (shapeColor !== undefined) cmd.shapes = shapeColor
    if (targets) cmd.indices = targets
    const r = await push([cmd])
    if (r.ok) return okText(r, '整体配色已更新')
    if (!/未知指令/.test(String(r.error || ''))) return okText(r, '整体配色失败')

    // 2) 旧编辑器兼容：展开为 set-background + set-element 批量队列
    //    仍然只消耗 1 次工具调用（LLM 只等一轮），页面无需刷新。
    const lumOf = (hex) => {
      const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''))
      if (!m) return 1
      const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    }
    const fg = textColor || (lumOf(bg) > 0.62 ? '#1f2d3d' : '#ffffff')
    const sf = shapeColor === undefined ? fg : shapeColor
    const doc = await getDeckOnly()
    const ops = expandRecolorOps(doc.deck, { bg, fg, sf, targets })
    let applied = 0
    for (let i = 0; i < ops.length; i += 90) {
      const rr = await push(ops.slice(i, i + 90))
      if (!rr.ok) return okText(rr, '整体配色失败（兼容模式）')
      applied += rr.applied
    }
    return { text: `整体配色已更新（兼容模式，${applied} 条）` }
  },
  async ppt_screenshot() {
    await requireEditor()
    const reqDoc = await post('/shot-request', {})
    const req = reqDoc.shot_req
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const st = await getStatus()
      if (st.shot && st.shot.req === req) {
        const shot = await getShot()
        if (!shot.data) break
        const dataUrl = shot.data
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        return {
          content: [
            { type: 'text', text: '以下是右侧编辑器的实时画面（全部页拼图）：' },
            { type: 'image', data: base64, mimeType: 'image/jpeg' },
          ],
        }
      }
      await sleep(150)
    }
    throw new Error('截图超时（工作台是否打开？）')
  },
}
