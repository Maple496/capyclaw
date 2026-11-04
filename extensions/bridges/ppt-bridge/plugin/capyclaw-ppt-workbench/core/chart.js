/**
 * 图表元素纯函数：数据归一化 + 元素构建（零 DOM，node:test 直测）。
 *
 * PPTist chart 元素结构（编辑器原生渲染，echarts 已内置于 bundle）：
 *   { type:'chart', chartType:'bar'|'column'|'line'|'area'|'pie'|'ring'|'radar'|'scatter',
 *     data:{ labels, legends, series }, options?{ lineSmooth, stack }, themeColors?, textColor? }
 *
 * normalizeChartData 支持多种「丢数据」格式，统一归一为 PPTist 原生结构：
 *   1. { labels, legends, series }            原生格式直通
 *   2. { labels, values }                     单系列
 *   3. { headers, rows }                      表格数据：首列=类目，其余列=系列
 *   4. { items: [[name, value]...] | [{name,value}...] }  饼图/环形图
 *   5. { series: [{name, values}...] }        series 对象式（labels 可省，自动生成）
 */

export const CHART_TYPES = ['bar', 'column', 'line', 'area', 'pie', 'ring', 'radar', 'scatter']

/** 单系列图：饼/环只取第一个系列，多余系列报错。 */
export const SINGLE_SERIES_TYPES = ['pie', 'ring']

/** 图表缺省调色板（与编辑器模板主题色 #5b9bd5 同族）。 */
export const DEFAULT_CHART_COLORS = [
  '#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4',
  '#70ad47', '#264478', '#9e480e', '#636363', '#997300',
]

const isNum = (v) => typeof v === 'number' && isFinite(v)
const isNumArr = (a) => Array.isArray(a) && a.length > 0 && a.every(isNum)

function fail(msg) {
  throw new Error('图表数据格式错误：' + msg)
}

/** 归一化 series：数字数组或 {name, values} 对象数组 → [number[]] + legends。 */
function normalizeSeriesInput(series) {
  if (!Array.isArray(series) || series.length === 0) fail('series 不能为空')
  const legends = []
  const out = []
  for (const s of series) {
    if (isNumArr(s)) {
      out.push(s.slice())
      legends.push(`系列${out.length}`)
      continue
    }
    if (s && isNumArr(s.values)) {
      out.push(s.values.slice())
      legends.push(String(s.name != null && s.name !== '' ? s.name : `系列${out.length + 1}`))
      continue
    }
    fail('series 每项必须是数字数组或 {name, values}')
  }
  return { legends, series: out }
}

/** 生成类目名：类别1..n。 */
const autoLabels = (n) => Array.from({ length: n }, (_, i) => `类别${i + 1}`)

/**
 * 归一化图表数据 → { labels, legends, series }。
 * @param {object} raw 上述 5 种格式之一
 * @param {string} chartType 用于 pie/ring 的单系列裁剪
 */
export function normalizeChartData(raw, chartType = 'bar') {
  if (!raw || typeof raw !== 'object') fail('data 必须是对象')

  let labels = []
  let legends = []
  let series = []

  if (Array.isArray(raw.series)) {
    // 格式 1 / 5：series 数组（数字数组或 {name, values}）
    const norm = normalizeSeriesInput(raw.series)
    legends = raw.legends && Array.isArray(raw.legends) && raw.legends.length
      ? norm.series.map((_, i) => String(raw.legends[i] != null ? raw.legends[i] : norm.legends[i]))
      : norm.legends
    series = norm.series
    labels = Array.isArray(raw.labels) && raw.labels.length
      ? raw.labels.map(String)
      : autoLabels(series[0].length)
  }
  else if (Array.isArray(raw.values)) {
    // 格式 2：{ labels?, values } 单系列
    if (!isNumArr(raw.values)) fail('values 必须是非空数字数组')
    series = [raw.values.slice()]
    legends = [String(raw.name || '值')]
    labels = Array.isArray(raw.labels) && raw.labels.length
      ? raw.labels.map(String)
      : autoLabels(series[0].length)
  }
  else if (Array.isArray(raw.rows) || Array.isArray(raw.headers)) {
    // 格式 3：{ headers?, rows } 表格数据：首列=类目
    if (!Array.isArray(raw.rows) || raw.rows.length === 0) fail('rows 不能为空')
    const width = raw.rows[0].length
    if (width < 2) fail('rows 每行至少 2 列（首列类目 + 至少 1 列数值）')
    const heads = Array.isArray(raw.headers) && raw.headers.length
      ? raw.headers.map(String)
      : null
    labels = []
    const cols = Array.from({ length: width - 1 }, () => [])
    for (const row of raw.rows) {
      if (!Array.isArray(row) || row.length !== width) fail(`rows 每行长度必须一致（${width}）`)
      labels.push(String(row[0]))
      for (let c = 1; c < width; c++) {
        const v = Number(row[c])
        if (!isFinite(v)) fail(`第 ${labels.length} 行第 ${c + 1} 列不是数字：${JSON.stringify(row[c])}`)
        cols[c - 1].push(v)
      }
    }
    legends = cols.map((_, i) => (heads && heads[i + 1]) || `系列${i + 1}`)
    series = cols
  }
  else if (Array.isArray(raw.items)) {
    // 格式 4：{ items: [[name, value]] | [{name, value}] } 饼图式
    labels = []
    const values = []
    for (const it of raw.items) {
      const [name, value] = Array.isArray(it) ? it : [it && it.name, it && it.value]
      if (name == null || !isFinite(Number(value))) fail('items 每项必须是 [name, value] 或 {name, value}')
      labels.push(String(name))
      values.push(Number(value))
    }
    series = [values]
    legends = [String(raw.name || '值')]
  }
  else {
    fail('无法识别的 data 格式（支持 labels+series / labels+values / headers+rows / items）')
  }

  if (labels.length === 0) fail('labels 不能为空')
  for (const s of series) {
    if (s.length !== labels.length) {
      fail(`系列长度(${s.length})与类目数(${labels.length})不一致`)
    }
  }

  if (SINGLE_SERIES_TYPES.includes(chartType) && series.length > 1) {
    fail(`${chartType} 图只支持 1 个系列（收到 ${series.length} 个），请改用 bar/line 等`)
  }

  return { labels, legends, series }
}

/** 图表 options 白名单：只透传编辑器认识的字段。 */
const CHART_OPTION_KEYS = ['lineSmooth', 'stack', 'horizontalBars']

export function normalizeChartOptions(options) {
  if (options == null) return undefined
  if (typeof options !== 'object') fail('options 必须是对象')
  const out = {}
  for (const k of CHART_OPTION_KEYS) {
    if (options[k] != null) out[k] = Boolean(options[k])
  }
  return Object.keys(out).length ? out : undefined
}

/** 画布 1000 × 562.5；图表缺省居中偏上。 */
function geometry(e) {
  const width = Number(e.width != null ? e.width : 560)
  const height = Number(e.height != null ? e.height : 360)
  return {
    width,
    height,
    left: Number(e.left != null ? e.left : Math.round((1000 - width) / 2)),
    top: Number(e.top != null ? e.top : 110),
    rotate: Number(e.rotate || 0),
  }
}

/**
 * 构建图表元素。
 * @param {object} e {chartType, data, options?, colors?|themeColors?, left/top/width/height?, textColor?}
 * @param {string[]} [deckThemeColors] 幻灯片主题色（可选兜底）
 */
export function makeChartElement(e, deckThemeColors) {
  if (!e || typeof e !== 'object') fail('图表元素必须是对象')
  const chartType = String(e.chartType || (e.type && e.type !== 'chart' ? e.type : 'bar'))
  if (!CHART_TYPES.includes(chartType)) {
    fail(`不支持的 chartType: ${chartType}（支持 ${CHART_TYPES.join(' / ')}）`)
  }
  const data = normalizeChartData(e.data, chartType)
  const colors = Array.isArray(e.colors) && e.colors.length
    ? e.colors.map(String)
    : (Array.isArray(e.themeColors) && e.themeColors.length
        ? e.themeColors.map(String)
        : (Array.isArray(deckThemeColors) && deckThemeColors.length ? deckThemeColors : DEFAULT_CHART_COLORS))
  const g = geometry(e)
  const el = {
    type: 'chart',
    id: e.id || `chart_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    ...g,
    chartType,
    data,
    themeColors: colors,
    textColor: String(e.textColor || '#333333'),
  }
  const options = normalizeChartOptions(e.options)
  if (options) el.options = options
  return el
}
