/** 排版引擎（7 版式 × 4 预设）：大纲 → 专业排版 slides（纯 deck 域）。 */
/* ===================== 设计系统与排版引擎（2026-10-21） =====================
 * 目标：一次 ppt_deck 调用产出「结构完整、版式统一、对比度正确」的 deck。
 * 约束内置：60px 网格边距、标题/正文/注释三级字号、要点数自适应、
 * 强调色只用于标题装饰与关键数字。 */
export const PRESETS = {
  clean:    { bg:'#ffffff', fg:'#1f2d3d', muted:'#5b6472', card:'#f3f4f6', accent:'#2563eb', accent2:'#c2410c' },
  business: { bg:'#0f2740', fg:'#ffffff', muted:'#b8c4d0', card:'#16324f', accent:'#e0a33a', accent2:'#5aa9e6' },
  /* warm：muted/accent 经对比度求解固化（2026-11-01 进化轮发现原值对 bg/card
   * 只有 3.86-4.00:1，低于 WCAG 4.5:1，导致 compose 产出被自家 ppt_audit 打 block）。 */
  warm:     { bg:'#fbf7f0', fg:'#3b2f2a', muted:'#67594f', card:'#f2e9dd', accent:'#a6431f', accent2:'#2e7d32' },
  tech:     { bg:'#0b1020', fg:'#e8efff', muted:'#93a4c4', card:'#141b31', accent:'#22d3ee', accent2:'#a78bfa' },
}
const GRID = { W: 1000, H: 562.5, pad: 60, titleTop: 46, bodyTop: 150 }
const tidy = (s, max) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
const textEl = (id, x, y, w, h, html, opts = {}) => ({
  type: 'text', id, left: x, top: y, width: w, height: h,
  content: `<p style="font-size: ${opts.size || 20}px;${opts.color ? ' color:' + opts.color + ';' : ''}${opts.align ? ' text-align:' + opts.align + ';' : ''}">${opts.bold ? '<strong>' + html + '</strong>' : html}</p>`,
  defaultColor: opts.color || '#333333', defaultFontName: '', fixedRatio: false, rotate: 0,
})
const shapeEl = (id, x, y, w, h, fill, rotate = 0) => ({
  type: 'shape', id, left: x, top: y, width: w, height: h,
  path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z', viewBox: [200, 200],
  fill, fixedRatio: false, rotate,
})
const bgOf = (P) => ({ type: 'solid', color: P.bg })

function layoutCover(P, s, i) {
  const W = GRID.W, pad = GRID.pad
  return {
    id: `lt_cover_${i}`, background: bgOf(P), elements: [
      shapeEl(`lt_cover_bar_${i}`, 0, 0, W, 14, P.accent),
      textEl(`lt_cover_kicker_${i}`, pad, 120, W - pad * 2, 30,
        escapeHtml(tidy(s.kicker || '', 40)), { size: 16, color: P.accent, bold: true }),
      textEl(`lt_cover_title_${i}`, pad, 160, W - pad * 2, 120,
        escapeHtml(tidy(s.title || '', 30)), { size: 50, color: P.fg, bold: true }),
      textEl(`lt_cover_sub_${i}`, pad, 300, W - pad * 2, 70,
        escapeHtml(tidy(s.subtitle || '', 60)), { size: 21, color: P.muted }),
      shapeEl(`lt_cover_line_${i}`, pad, 400, 120, 4, P.accent),
      textEl(`lt_cover_foot_${i}`, pad, 470, W - pad * 2, 30,
        escapeHtml(tidy(s.foot || '', 50)), { size: 13, color: P.muted }),
    ],
  }
}

function layoutSection(P, s, i) {
  const W = GRID.W, pad = GRID.pad
  const n = String(s.index != null ? s.index : '').padStart(2, '0')
  return {
    id: `lt_section_${i}`, background: bgOf(P), elements: [
      textEl(`lt_sec_num_${i}`, pad, 120, 160, 120, escapeHtml(n || '—'),
        { size: 72, color: P.accent, bold: true }),
      textEl(`lt_sec_title_${i}`, pad, 250, W - pad * 2, 90,
        escapeHtml(tidy(s.title || '', 30)), { size: 40, color: P.fg, bold: true }),
      shapeEl(`lt_sec_line_${i}`, pad, 350, 100, 4, P.accent),
      textEl(`lt_sec_sub_${i}`, pad, 380, W - pad * 2, 60,
        escapeHtml(tidy(s.subtitle || '', 70)), { size: 18, color: P.muted }),
    ],
  }
}

function layoutBullets(P, s, i) {
  const W = GRID.W, pad = GRID.pad
  const items = (s.bullets || []).slice(0, 6).map(b =>
    typeof b === 'string' ? { text: b } : b)
  const size = items.length <= 3 ? 22 : items.length === 4 ? 20 : 18
  const els = [
    textEl(`lt_b_title_${i}`, pad, GRID.titleTop, W - pad * 2, 70,
      escapeHtml(tidy(s.title || '', 28)), { size: 32, color: P.fg, bold: true }),
    shapeEl(`lt_b_line_${i}`, pad, 128, 90, 4, P.accent),
  ]
  items.forEach((b, k) => {
    const y = GRID.bodyTop + 8 + k * (b.detail ? 74 : 62)
    els.push(shapeEl(`lt_b_dot_${i}_${k}`, pad + 2, y + 9, 8, 8, P.accent))
    /* 单行框（34px）按 22px 字号最多容纳 ~36 个 CJK 字符：上限从 40 收紧到 36，
     * 否则满长度纯中文要点会折行溢出，被 ppt_audit 判 text-overflow（2026-11-01）。 */
    els.push(textEl(`lt_b_txt_${i}_${k}`, pad + 26, y, W - pad * 2 - 26, 34,
      escapeHtml(tidy(b.text || '', 36)), { size, color: P.fg }))
    if (b.detail) {
      els.push(textEl(`lt_b_det_${i}_${k}`, pad + 26, y + 32, W - pad * 2 - 26, 28,
        escapeHtml(tidy(b.detail, 60)), { size: 14, color: P.muted }))
    }
  })
  return { id: `lt_bullets_${i}`, background: bgOf(P), elements: els }
}

function layoutTwo(P, s, i) {
  const W = GRID.W, pad = GRID.pad
  const cw = (W - pad * 2 - 24) / 2
  const col = (side, data, x) => {
    const els = [
      shapeEl(`lt_two_card_${i}_${side}`, x, 150, cw, 330, P.card),
      textEl(`lt_two_h_${i}_${side}`, x + 24, 172, cw - 48, 40,
        escapeHtml(tidy((data && data.heading) || '', 20)), { size: 22, color: P.accent, bold: true }),
    ]
    ;((data && data.bullets) || []).slice(0, 4).forEach((b, k) => {
      els.push(textEl(`lt_two_b_${i}_${side}_${k}`, x + 24, 226 + k * 56, cw - 48, 48,
        escapeHtml(tidy(b, 30)), { size: 17, color: P.fg }))
    })
    return els
  }
  return {
    id: `lt_two_${i}`, background: bgOf(P), elements: [
      textEl(`lt_two_title_${i}`, pad, GRID.titleTop, W - pad * 2, 70,
        escapeHtml(tidy(s.title || '', 26)), { size: 30, color: P.fg, bold: true }),
      ...col('l', s.left, pad),
      ...col('r', s.right, pad + cw + 24),
    ],
  }
}

function layoutStat(P, s, i) {
  const W = GRID.W, pad = GRID.pad
  const stats = (s.stats || []).slice(0, 3)
  const n = Math.max(1, stats.length)
  const cw = (W - pad * 2 - (n - 1) * 24) / n
  const els = [
    textEl(`lt_st_title_${i}`, pad, GRID.titleTop, W - pad * 2, 70,
      escapeHtml(tidy(s.title || '', 26)), { size: 30, color: P.fg, bold: true }),
  ]
  stats.forEach((st, k) => {
    const x = pad + k * (cw + 24)
    els.push(shapeEl(`lt_st_card_${i}_${k}`, x, 150, cw, 260, P.card))
    els.push(textEl(`lt_st_val_${i}_${k}`, x, 190, cw, 110,
      escapeHtml(tidy(st.value || '', 10)), { size: 60, color: P.accent, bold: true, align: 'center' }))
    els.push(textEl(`lt_st_lab_${i}_${k}`, x, 310, cw, 60,
      escapeHtml(tidy(st.label || '', 20)), { size: 16, color: P.muted, align: 'center' }))
  })
  if (s.note) {
    els.push(textEl(`lt_st_note_${i}`, pad, 450, W - pad * 2, 40,
      escapeHtml(tidy(s.note, 80)), { size: 14, color: P.muted }))
  }
  return { id: `lt_stat_${i}`, background: bgOf(P), elements: els }
}

function layoutQuote(P, s, i) {
  const W = GRID.W, pad = GRID.pad
  return {
    id: `lt_quote_${i}`, background: bgOf(P), elements: [
      shapeEl(`lt_q_bar_${i}`, pad, 150, 6, 200, P.accent),
      textEl(`lt_q_txt_${i}`, pad + 30, 150, W - pad * 2 - 30, 200,
        escapeHtml(tidy(s.quote || '', 120)), { size: 28, color: P.fg }),
      textEl(`lt_q_author_${i}`, pad + 30, 380, W - pad * 2 - 30, 40,
        escapeHtml(tidy(s.author || '', 30)), { size: 16, color: P.muted }),
    ],
  }
}

function layoutEnd(P, s, i) {
  const W = GRID.W
  const pad = GRID.pad
  return {
    id: `lt_end_${i}`, background: bgOf(P), elements: [
      shapeEl(`lt_end_bar_${i}`, 0, GRID.H - 14, W, 14, P.accent),
      textEl(`lt_end_title_${i}`, pad, 200, W - pad * 2, 90,
        escapeHtml(tidy(s.title || '谢谢观看', 20)), { size: 44, color: P.fg, bold: true, align: 'center' }),
      textEl(`lt_end_sub_${i}`, pad, 300, W - pad * 2, 60,
        escapeHtml(tidy(s.subtitle || '', 60)), { size: 18, color: P.muted, align: 'center' }),
    ],
  }
}

export function buildDeck(input) {
  const presetName = PRESETS[input.preset] ? input.preset : 'clean'
  const P = PRESETS[presetName]
  const slides = (input.slides || []).slice(0, 30).map((s, i) => buildSlide(P, s, i))
  if (!slides.length) throw new Error('slides 不能为空')
  return {
    title: tidy(input.title || '未命名演示', 40),
    slides,
    theme: { themeColors: [P.accent, P.accent2, P.fg], fontColor: P.fg, backgroundColor: P.bg },
  }
}

/** 构建单页 slide（ppt_page 用），跳过 deck 级 theme/title 构建。 */
export function buildSlide(P, spec, index) {
  const presetName = typeof P === 'string' ? (PRESETS[P] ? P : 'clean') : null
  const preset = presetName ? PRESETS[presetName] : P
  switch (spec.layout) {
    case 'cover': return layoutCover(preset, spec, index)
    case 'section': return layoutSection(preset, spec, index)
    case 'two': return layoutTwo(preset, spec, index)
    case 'stat': return layoutStat(preset, spec, index)
    case 'quote': return layoutQuote(preset, spec, index)
    case 'end': return layoutEnd(preset, spec, index)
    default: return layoutBullets(preset, spec, index)
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
