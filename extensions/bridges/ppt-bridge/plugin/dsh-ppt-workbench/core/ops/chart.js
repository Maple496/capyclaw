/** 图表 op：加图表 / 更新图表数据与样式。数据归一化在 core/chart.js。 */
import { makeChartElement, normalizeChartData, normalizeChartOptions, CHART_TYPES } from '../chart.js'

function clone(P, i) {
  const slide = P.getSlides()[i]
  if (!slide) {
    const total = P.getSlides().length
    throw new Error(`页号越界：第 ${i} 页不存在（共 ${total} 页）`)
  }
  return JSON.parse(JSON.stringify(slide))
}

/** 取幻灯片主题色（可选，图表缺省调色兜底）。 */
function deckThemeColors(P) {
  try {
    const th = typeof P.getTheme === 'function' ? P.getTheme() : null
    return th && Array.isArray(th.themeColors) ? th.themeColors : undefined
  } catch {
    return undefined
  }
}

export const chartOps = {
  'add-chart': {
    async run(P, c) {
      const i = Number(c.slide != null ? c.slide : 0)
      const s = clone(P, i)
      const el = makeChartElement(c.element || {}, deckThemeColors(P))
      s.elements.push(el)
      P.updateSlide(i, s)
      return el.id
    },
  },

  'update-chart': {
    run(P, c) {
      const i = Number(c.slide != null ? c.slide : 0)
      const s = clone(P, i)
      const el = s.elements.find(e => e.id === c.elementId)
      if (!el) throw new Error('update-chart 未命中: ' + c.elementId)
      if (el.type !== 'chart') throw new Error(`元素 ${c.elementId} 不是图表（type=${el.type}）`)
      const p = c.props || {}
      if (p.chartType != null) {
        const ct = String(p.chartType)
        if (!CHART_TYPES.includes(ct)) {
          throw new Error(`不支持的 chartType: ${ct}（支持 ${CHART_TYPES.join(' / ')}）`)
        }
        el.chartType = ct
      }
      if (p.data != null) el.data = normalizeChartData(p.data, el.chartType)
      if (p.options !== undefined) {
        const options = normalizeChartOptions(p.options)
        if (options) el.options = options
        else delete el.options
      }
      if (Array.isArray(p.colors) && p.colors.length) el.themeColors = p.colors.map(String)
      if (p.textColor != null) el.textColor = String(p.textColor)
      for (const k of ['left', 'top', 'width', 'height', 'rotate']) {
        if (p[k] != null && isFinite(Number(p[k]))) el[k] = Number(p[k])
      }
      P.updateSlide(i, s)
    },
  },
}
