/**
 * 确定性 deck 审计：不依赖浏览器/LLM，检查越界、文字溢出、文字重叠、
 * 对比度、文字遮挡、重复文字、重复版式、配色漂移、重复图片与页面密度。
 *
 * 设计原则：
 * - 文字载体统一走 textHolder()：text 元素与「shape + text」都算文字；
 * - 对比度按文字实际所处的底色计算（自身高亮 → 元素 fill → 下方形状 → 页面背景）；
 * - 宁可少报装饰形状的出血，也不让真正的文字硬伤被 warning 淹没。
 */
import { parseColor, luminance, contrastRatio } from './color.js'
import { textHolder, htmlOf } from './text.js'

const DEFAULT_FONT = 20
const CANVAS_W = 1000
const CANVAS_H = 562.5

/** 审计阈值调优钩子：进化搜索（bench/evolution）与生产覆盖共用。
 * 通过 globalThis.PPT_AUDIT_TUNING 注入（保持 core 零依赖，可在浏览器端运行）；
 * 非法/缺失时回退默认值。默认值即 2026-11-01 进化固化的基线。 */
function auditTuning() {
  const raw = globalThis.PPT_AUDIT_TUNING
  return raw && typeof raw === 'object' ? raw : {}
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function isNeutral(rgb) {
  const diff = Number(auditTuning().neutralDiff) || 20
  return Math.max(...rgb) - Math.min(...rgb) < diff || luminance(rgb) > 245 || luminance(rgb) < 10
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** #rgb/#rrggbb/#rrggbbaa/rgb()/rgba() → {rgb, alpha}；未知返回 null。 */
function parseRgba(value) {
  const s = String(value || '').trim()
  if (!s || /^(none|transparent)$/i.test(s)) return { rgb: null, alpha: 0 }

  let m = /^#([0-9a-f]{8})$/i.exec(s)
  if (m) {
    const h = m[1]
    return {
      rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
      alpha: parseInt(h.slice(6, 8), 16) / 255,
    }
  }
  m = /^#([0-9a-f]{4})$/i.exec(s)
  if (m) {
    const h = m[1].split('').map((c) => c + c).join('')
    return {
      rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
      alpha: parseInt(h.slice(6, 8), 16) / 255,
    }
  }
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
  if (m) {
    return {
      rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
      alpha: m[4] != null ? clamp(Number(m[4]), 0, 1) : 1,
    }
  }
  const rgb = parseColor(s)
  return rgb ? { rgb, alpha: 1 } : null
}

const blendOver = (fg, bg, alpha) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)))

const boxOf = (element) => {
  const left = Number(element?.left ?? 0)
  const top = Number(element?.top ?? 0)
  const width = Number(element?.width ?? 0)
  const height = Number(element?.height ?? 0)
  return { left, top, width, height }
}

const areaOf = (box) => Math.max(0, box.width) * Math.max(0, box.height)

function overlapArea(a, b) {
  const x = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
  const y = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))
  return x * y
}

/** 取 CSS 声明值；负向后顾避免把 background-color 当成 color。 */
function cssValue(html, prop) {
  const source = String(html || '')
  const re = new RegExp(`(?<![-\\w])${prop}\\s*:\\s*([^;"'}]+)`, 'i')
  const match = re.exec(source)
  return match ? match[1].trim() : null
}

function fontSizeOf(element) {
  const html = htmlOf(element)
  let size = 0
  for (const match of String(html || '').matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/gi)) {
    size = Math.max(size, Number(match[1]))
  }
  if (!size) {
    size = Number(
      element?.fontSize
      ?? element?.style?.fontSize
      ?? element?.text?.fontSize
      ?? DEFAULT_FONT,
    )
  }
  return size || DEFAULT_FONT
}

function textStyleOf(element) {
  const html = htmlOf(element)
  const holder = textHolder(element)
  const colorRaw = cssValue(html, 'color')
    || element?.color
    || element?.defaultColor
    || holder?.defaultColor
    || null
  const highlightRaw = cssValue(html, 'background-color') || null
  const align = (cssValue(html, 'text-align') || element?.align || 'left').toLowerCase()
  return { colorRaw, highlightRaw, align }
}

/** 估算文字实际占据的矩形，避免用过宽的空文本框去匹配背景色块。 */
function glyphBoxOf(item) {
  const { box, text, fontSize, align } = item
  if (!text) return box
  let fullWidth = 0
  for (const char of text) {
    fullWidth += /[\u3400-\u9fff\uff00-\uffef]/.test(char) ? fontSize : fontSize * 0.55
  }
  const lineWidth = Math.min(box.width, Math.max(fontSize, fullWidth))
  const lines = Math.max(1, Math.ceil(fullWidth / Math.max(1, box.width)))
  const height = Math.min(box.height, lines * fontSize * 1.35)
  let left = box.left
  if (align === 'center') left += (box.width - lineWidth) / 2
  else if (align === 'right') left += box.width - lineWidth
  const top = box.top + Math.max(0, (box.height - height) / 2)
  return { left, top, width: lineWidth, height }
}

function slideBackground(slide) {
  const bg = slide?.background
  if (!bg) return [255, 255, 255]
  if (bg.type && bg.type !== 'solid') return null
  const parsed = parseRgba(bg.color)
  if (!parsed || !parsed.rgb) return [255, 255, 255]
  return parsed.alpha >= 0.999 ? parsed.rgb : blendOver(parsed.rgb, [255, 255, 255], parsed.alpha)
}

/** 只有矩形形状的 bbox 才近似等于实际覆盖区域；其他形状用采样判断。 */
function isRectShape(element) {
  return element?.type === 'shape'
    && /^M\s*0\s+0\s+L\s*200\s+0\s+L\s*200\s+200\s+L\s*0\s+200\s*Z/i.test(String(element.path || '').trim())
}

function polygonPoints(element) {
  const nums = String(element?.path || '').match(/-?\d+(?:\.\d+)?/g)
  if (!nums || nums.length < 6) return null
  const points = []
  for (let i = 0; i + 1 < nums.length; i += 2) points.push([Number(nums[i]), Number(nums[i + 1])])
  return points
}

function pointInPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 形状对文字矩形的覆盖比例：矩形走面积，多边形先 bbox 快筛再 4×4 采样。 */
function shapeCoverage(glyph, element) {
  if (!element || !glyph.width || !glyph.height) return 0
  const ebox = boxOf(element)
  if (element.type === 'image') return overlapArea(glyph, ebox) / Math.max(1, areaOf(glyph))
  if (element.type !== 'shape') return 0
  /* bbox 快筛：无交集直接返回 0，跳过多边形解析和采样 */
  if (!overlapArea(glyph, ebox)) return 0
  if (isRectShape(element) || !element.path) {
    return overlapArea(glyph, ebox) / Math.max(1, areaOf(glyph))
  }
  const points = polygonPoints(element)
  if (!points) return 0
  const viewBox = Array.isArray(element.viewBox) ? element.viewBox : [200, 200]
  let inside = 0
  let total = 0
  for (let gx = 1; gx <= 4; gx++) {
    for (let gy = 1; gy <= 4; gy++) {
      const x = glyph.left + (glyph.width * gx) / 5
      const y = glyph.top + (glyph.height * gy) / 5
      if (x < ebox.left || x > ebox.left + ebox.width || y < ebox.top || y > ebox.top + ebox.height) continue
      total++
      const px = ((x - ebox.left) / Math.max(1, ebox.width)) * viewBox[0]
      const py = ((y - ebox.top) / Math.max(1, ebox.height)) * viewBox[1]
      if (pointInPolygon(px, py, points)) inside++
    }
  }
  return total ? inside / total : 0
}

/** 文字实际所处的底色：自身高亮 → 自身 fill → 下方形状（按 alpha 混合）→ 页面背景。 */
function effectiveBackground(item, slide, elements) {
  let base = slideBackground(slide)
  if (!base) return null

  const layers = []
  for (let i = 0; i < item.index; i++) {
    const lower = elements[i]
    if (lower.type !== 'shape' && lower.type !== 'text' && lower.type !== 'image') continue
    const coverage = shapeCoverage(item.glyph, lower)
    if (coverage < 0.5) continue

    if (lower.type === 'image') {
      layers.push({ unknown: true })
      continue
    }
    if (lower.type !== 'shape' && lower.type !== 'text') continue

    const fill = parseRgba(lower.fill)
    if (fill && fill.rgb && fill.alpha > 0) {
      if (fill.alpha >= 0.999) layers.length = 0
      layers.push(fill)
    } else if (lower.type === 'shape' && lower.fill && !/^(none|transparent)$/i.test(String(lower.fill))) {
      layers.push({ unknown: true })
    }
  }

  for (const layer of layers) {
    if (layer.unknown) return null
    base = blendOver(layer.rgb, base, layer.alpha)
  }

  const ownFill = parseRgba(item.element?.fill)
  if (ownFill && ownFill.rgb && ownFill.alpha > 0) {
    base = blendOver(ownFill.rgb, base, ownFill.alpha)
  }

  if (item.highlightRaw) {
    const highlight = parseRgba(item.highlightRaw)
    if (highlight && highlight.rgb && highlight.alpha > 0) {
      base = blendOver(highlight.rgb, base, highlight.alpha)
    }
  }
  return base
}

/** 版式指纹：忽略文字内容，只看非文字元素的结构与几何。 */
function layoutFingerprint(slide) {
  const parts = (slide?.elements || [])
    .filter((element) => element.type !== 'text')
    .map((element) => {
      const box = boxOf(element)
      return [
        element.type,
        element.path || element.src || '',
        Math.round(box.left), Math.round(box.top),
        Math.round(box.width), Math.round(box.height),
        String(element.fill || ''),
      ].join(':')
    })
    .sort()
  return parts.join('|')
}

/** 只有大块装饰版面重复才算设计问题；clean 的小线条/圆点属于统一版式。 */
function hasHeavyDecoration(slide) {
  return (slide?.elements || []).some((element) => {
    if (element.type !== 'shape') return false
    return areaOf(boxOf(element)) > CANVAS_W * CANVAS_H * 0.18
  })
}

/**
 * @param {object} deck
 * @param {{maxCharsPerSlide?: number, paletteMax?: number, repeatedLayoutMin?: number}} [options]
 * @returns {{score:number, pass:boolean, issues:Array, blocking:Array, summary:object}}
 */
export function auditDeck(deck, options = {}) {
  const maxCharsPerSlide = options.maxCharsPerSlide ?? 320
  const paletteMax = options.paletteMax ?? 3
  const repeatedLayoutMin = options.repeatedLayoutMin ?? 3
  const issues = []
  const palette = new Set()
  /* 主题声明的色板是设计意图的一部分：预先登记，不计入“配色漂移”。
   * （进化轮发现：buildDeck 生成稿的 bg/accent/accent2 会触发假 palette-drift。） */
  const themeColors = new Set(
    (Array.isArray(deck?.theme?.themeColors) ? deck.theme.themeColors : [])
      .map((color) => String(color || '').toLowerCase()),
  )
  const images = new Map()
  const slides = Array.isArray(deck?.slides) ? deck.slides : []

  const push = (severity, page, code, message, element = '') => {
    issues.push({ severity, page, element, code, message })
  }

  slides.forEach((slide, pageIndex) => {
    const page = pageIndex + 1
    const elements = Array.isArray(slide?.elements) ? slide.elements : []
    if (!elements.length) push('warning', page, 'empty-slide', '页面没有元素')

    const bg = parseColor(slide?.background?.color)
    if (bg && !isNeutral(bg)) palette.add(String(slide.background.color).toLowerCase())

    let textChars = 0
    const textItems = []

    elements.forEach((element, index) => {
      const holder = textHolder(element)
      if (element.type === 'shape') {
        const fill = parseColor(element.fill)
        if (fill && !isNeutral(fill)) palette.add(String(element.fill).toLowerCase())
      }
      if (element.type === 'image' && element.src) {
        const key = String(element.src).slice(0, 96)
        images.set(key, (images.get(key) || 0) + 1)
      }
      if (!holder) return

      const box = boxOf(element)
      const text = stripHtml(htmlOf(element))
      const fontSize = fontSizeOf(element)
      const style = textStyleOf(element)
      const highlightRgba = parseRgba(style.highlightRaw)
      const item = {
        element, index, holder, text, box, fontSize,
        color: parseColor(style.colorRaw),
        highlight: highlightRgba && highlightRgba.alpha > 0 ? parseColor(style.highlightRaw) : null,
        highlightRaw: style.highlightRaw,
        align: style.align,
        kind: element.type === 'shape' ? 'shape' : 'text',
      }
      item.glyph = glyphBoxOf(item)
      textItems.push(item)
      textChars += text.length

      if (box.left < -1 || box.top < -1 || box.left + box.width > CANVAS_W + 1 || box.top + box.height > CANVAS_H + 1) {
        push('error', page, 'bounds',
          `文字越界：(${Math.round(box.left)},${Math.round(box.top)}) ${Math.round(box.width)}×${Math.round(box.height)}`,
          element.id)
      }

      const cjk = /[\u3400-\u9fff]/.test(text)
      const charsPerLine = Math.max(1, Math.floor(box.width / (fontSize * (cjk ? 1 : 0.55))))
      const lines = Math.max(1, Math.ceil(text.length / charsPerLine))
      const needed = lines * fontSize * 1.35
      const tuning = auditTuning()
      const overflowWarnK = Number(tuning.overflowWarnK) || 1.2
      const overflowErrK = Number(tuning.overflowErrK) || 1.5
      if (needed > box.height * overflowWarnK + 4) {
        push(needed > box.height * overflowErrK + 8 ? 'error' : 'warning', page, 'text-overflow',
          `文字可能溢出：约 ${lines} 行，需要 ${Math.round(needed)}px，框高 ${Math.round(box.height)}px`, element.id)
      }

      if (item.color) {
        const effective = effectiveBackground(item, slide, elements)
        if (effective) {
          const ratio = contrastRatio(item.color, effective)
          const large = fontSize >= 24
          const minimum = large ? 3 : 4.5
          if (item.highlight && ratio < 1.15) {
            push('error', page, 'text-invisible',
              `文字与自身高亮背景几乎同色（${ratio.toFixed(2)}:1），文字不可见`, element.id)
          } else if (ratio < minimum) {
            push('error', page, 'contrast', `文字对比度 ${ratio.toFixed(2)}:1，低于 ${minimum}:1`, element.id)
          }
        }
      }

      if (item.color && !isNeutral(item.color)) {
        palette.add(`#${item.color.map((v) => v.toString(16).padStart(2, '0')).join('')}`)
      }
    })

    /* 文字重叠 / 同文案重复绘制 */
    for (let i = 0; i < textItems.length; i++) {
      for (let j = i + 1; j < textItems.length; j++) {
        const a = textItems[i]
        const b = textItems[j]
        if (!a.text || !b.text) continue
        const overlap = overlapArea(a.glyph, b.glyph)
        const minArea = Math.min(areaOf(a.glyph), areaOf(b.glyph))
        if (minArea <= 0) continue
        const ratio = overlap / minArea
        const tuning = auditTuning()
        const overlapMin = Number(tuning.overlapMin) || 0.15
        const overlapErr = Number(tuning.overlapErr) || 0.3
        if (ratio <= overlapMin) continue

        if (a.text === b.text && a.text.length >= 2) {
          push('error', page, 'duplicate-text',
            `同一段文字重复绘制：${a.element.id} 与 ${b.element.id}（“${a.text.slice(0, 24)}”）`,
            `${a.element.id},${b.element.id}`)
        } else if (ratio > overlapErr) {
          push('error', page, 'text-overlap',
            `文本元素重叠：${a.element.id} 与 ${b.element.id}（重叠 ${Math.round(ratio * 100)}%）`,
            `${a.element.id},${b.element.id}`)
        }
      }
    }

    /* 文字被上层不透明元素遮挡 */
    for (const item of textItems) {
      for (let i = item.index + 1; i < elements.length; i++) {
        const upper = elements[i]
        if (upper.type !== 'shape' && upper.type !== 'image') continue
        const coverage = shapeCoverage(item.glyph, upper)
        if (coverage <= 0.55) continue
        if (upper.type === 'image') {
          push('error', page, 'text-occluded', `文字 ${item.element.id} 被上层图片遮挡`, item.element.id)
          break
        }
        const fill = parseRgba(upper.fill)
        if (fill && fill.rgb && fill.alpha >= 0.85) {
          push('error', page, 'text-occluded', `文字 ${item.element.id} 被上层形状 ${upper.id} 遮挡`, item.element.id)
          break
        }
      }
    }

    if (textChars > maxCharsPerSlide) {
      push(textChars > maxCharsPerSlide * 1.5 ? 'error' : 'warning', page, 'density',
        `页面文字偏多：${textChars} 字（建议 ≤ ${maxCharsPerSlide}）`)
    }
  })

  /* 重复版式：同一套非文字结构出现在 3 页以上，且这些页都有正文。 */
  const layoutGroups = new Map()
  slides.forEach((slide, pageIndex) => {
    const fingerprint = layoutFingerprint(slide)
    if (!fingerprint || !hasHeavyDecoration(slide)) return
    const bodyTexts = (slide.elements || [])
      .filter((element) => textHolder(element))
      .map((element) => stripHtml(htmlOf(element)))
      .filter(Boolean)
    if (bodyTexts.length < 4 || bodyTexts.join('').length < 50) return
    if (!layoutGroups.has(fingerprint)) layoutGroups.set(fingerprint, [])
    layoutGroups.get(fingerprint).push(pageIndex + 1)
  })
  for (const pages of layoutGroups.values()) {
    if (pages.length >= repeatedLayoutMin) {
      push('error', pages[0], 'repeated-layout',
        `重复版式：${pages.length} 页共用同一套结构（${pages.map((p) => `p${p}`).join('、')}）`)
    }
  }

  for (const [src, count] of images) {
    if (count > 1) push('warning', 0, 'duplicate-image', `同一张图片重复使用 ${count} 次：${src.slice(0, 48)}…`)
  }
  const offPalette = [...palette].filter((color) => !themeColors.has(color))
  if (offPalette.length > paletteMax) {
    push('warning', 0, 'palette-drift', `非中性色过多：${offPalette.length} 种（建议 ≤ ${paletteMax}）`)
  }

  const errors = issues.filter((item) => item.severity === 'error').length
  const warnings = issues.filter((item) => item.severity === 'warning').length
  const score = clamp(100 - errors * 6 - warnings * 2, 0, 100)
  const blocking = issues
    .filter((item) => item.severity === 'error')
    .map(({ page, code, element, message }) => ({ page, code, element, message }))

  return {
    score,
    pass: errors === 0,
    issues,
    blocking,
    summary: {
      slides: slides.length,
      elements: slides.reduce((sum, slide) => sum + (slide.elements?.length || 0), 0),
      textHolders: slides.reduce((sum, s) => sum + (s.elements || []).filter((e) => textHolder(e)).length, 0),
      errors,
      warnings,
      paletteColors: palette.size,
      imageReuse: [...images.values()].filter((count) => count > 1).length,
    },
  }
}

export function formatAudit(result) {
  const lines = [
    `score ${result.score}/100 · pass=${result.pass ? 'true' : 'false'} · ${result.summary.errors} errors · ${result.summary.warnings} warnings`,
  ]
  for (const issue of result.issues) {
    lines.push(`[${issue.severity}] p${issue.page || '-'} ${issue.code}: ${issue.message}${issue.element ? ` (${issue.element})` : ''}`)
  }
  return lines.join('\n')
}
