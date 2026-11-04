/** 图表/表格/形状/线条/备注 能力测试：数据归一化 + 元素构建 + op 行为。 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyOp } from '../src/core/ops.js'
import { makeElement } from '../src/core/text.js'
import { normalizeChartData, makeChartElement, CHART_TYPES } from '../src/core/chart.js'
import { makeTableElement, buildTableData, tint, normalizeColWidths } from '../src/core/table.js'
import { SHAPE_KEYS, getShape } from '../src/core/shape-library.js'

function fakeP(slides) {
  const state = { slides: JSON.parse(JSON.stringify(slides)), theme: {}, calls: [] }
  return {
    state,
    isMounted: () => true,
    getSlides: () => state.slides,
    updateSlide: (i, s) => { state.slides[i] = s; state.calls.push('update:' + i); return true },
    addSlide: (s) => { state.slides.push(s) },
    removeSlide: (i) => { state.slides.splice(i, 1); return true },
    moveSlide: () => true,
    duplicateSlide: () => true,
    selectSlide: () => true,
    load: async (deck) => { state.slides = JSON.parse(JSON.stringify(deck.slides)) },
    setTitle: (t) => { state.title = t },
    getTheme: () => state.theme,
    setTheme: (t) => { state.theme = t },
    undo: async () => {},
    redo: async () => {},
    present: () => {},
    exitPresent: () => {},
  }
}

const slide = (id, ...els) => ({ id, background: { type: 'solid', color: '#fff' }, elements: els })

/* ---------- normalizeChartData ---------- */

test('chart 数据：labels+series 原生格式', () => {
  const d = normalizeChartData({ labels: ['Q1', 'Q2'], legends: ['A', 'B'], series: [[1, 2], [3, 4]] })
  assert.deepEqual(d, { labels: ['Q1', 'Q2'], legends: ['A', 'B'], series: [[1, 2], [3, 4]] })
})

test('chart 数据：series 对象式 + 自动 labels', () => {
  const d = normalizeChartData({ series: [{ name: '华东', values: [10, 20, 30] }] })
  assert.deepEqual(d.labels, ['类别1', '类别2', '类别3'])
  assert.deepEqual(d.legends, ['华东'])
  assert.deepEqual(d.series, [[10, 20, 30]])
})

test('chart 数据：headers+rows 表格式', () => {
  const d = normalizeChartData({
    headers: ['区域', '目标', '完成'],
    rows: [['华东', 70, 74], ['华南', 66, 61]],
  })
  assert.deepEqual(d.labels, ['华东', '华南'])
  assert.deepEqual(d.legends, ['目标', '完成'])
  assert.deepEqual(d.series, [[70, 66], [74, 61]])
})

test('chart 数据：values 单系列 / items 饼图式', () => {
  const a = normalizeChartData({ labels: ['x', 'y'], values: [1, 2] })
  assert.deepEqual(a.series, [[1, 2]])
  const b = normalizeChartData({ items: [['A', 10], ['B', 20]] })
  assert.deepEqual(b.labels, ['A', 'B'])
  assert.deepEqual(b.legends, ['值'])
})

test('chart 数据：非法输入报错清晰', () => {
  assert.throws(() => normalizeChartData({ labels: ['a', 'b', 'c'], series: [[1, 2]] }), /长度.*不一致/)
  assert.throws(() => normalizeChartData({ series: [[1, 2], [3, 4]] }, 'pie'), /pie 图只支持 1 个系列/)
  assert.throws(() => normalizeChartData({ rows: [['a'], ['b']] }), /至少 2 列/)
  assert.throws(() => normalizeChartData({ rows: [['a', 'x']] }), /不是数字/)
  assert.throws(() => normalizeChartData('nope'), /必须是对象/)
})

/* ---------- makeChartElement ---------- */

test('chart 元素：默认几何居中 + 校验 chartType', () => {
  const el = makeChartElement({ chartType: 'bar', data: { values: [1, 2, 3] } })
  assert.equal(el.type, 'chart')
  assert.equal(el.width, 560)
  assert.equal(el.left, 220)
  assert.ok(el.themeColors.length >= 6)
  assert.throws(() => makeChartElement({ chartType: 'wordcloud', data: { values: [1] } }), /不支持的 chartType/)
  assert.deepEqual(CHART_TYPES, ['bar', 'column', 'line', 'area', 'pie', 'ring', 'radar', 'scatter'])
})

test('chart 元素：主题色兜底与显式配色', () => {
  const a = makeChartElement({ chartType: 'line', data: { values: [1] } }, ['#111111'])
  assert.deepEqual(a.themeColors, ['#111111'])
  const b = makeChartElement({ chartType: 'line', data: { values: [1] }, colors: ['#222222'] }, ['#111111'])
  assert.deepEqual(b.themeColors, ['#222222'])
  const c = makeChartElement({ chartType: 'line', data: { values: [1] }, options: { lineSmooth: true, bogus: 1 } })
  assert.deepEqual(c.options, { lineSmooth: true })
})

/* ---------- makeElement（line 通道） ---------- */

test('line 元素：画布坐标转相对坐标，width 是线宽', () => {
  const el = makeElement({ type: 'line', x1: 300, y1: 400, x2: 100, y2: 300, width: 3, end_point: 'arrow' })
  assert.equal(el.type, 'line')
  assert.equal(el.left, 100)
  assert.equal(el.top, 300)
  assert.deepEqual(el.start, [200, 100])
  assert.deepEqual(el.end, [0, 0])
  assert.equal(el.width, 3) // 线宽，不是包围盒
  assert.deepEqual(el.points, ['', 'arrow'])
  assert.ok(!('height' in el))
})

/* ---------- makeTableElement ---------- */

test('table 元素：表头样式 + 主题色淡底', () => {
  const el = makeTableElement({ rows: [['区域', '值'], ['A', 1]], header: true, themeColor: '#5b9bd5' })
  assert.equal(el.type, 'table')
  assert.equal(el.theme.rowHeader, true)
  assert.equal(el.data[0][0].style.bold, true)
  assert.match(el.data[0][0].style.backcolor, /^#/)
  assert.notEqual(el.data[0][0].style.backcolor, '#5b9bd5')
  assert.equal(el.data[1][0].style, undefined)
  assert.equal(el.height, 72) // 2 行 × 36
})

test('table 元素：colWidths 像素自动归一 / 对象单元格', () => {
  const el = makeTableElement({ rows: [['a', 'b', 'c']], colWidths: [200, 100, 100] })
  const sum = el.colWidths.reduce((x, y) => x + y, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9)
  assert.ok(el.colWidths[0] > el.colWidths[1])
  const el2 = makeTableElement({ rows: [[{ text: '加粗', bold: true, color: '#ff0000' }, 2]] })
  assert.equal(el2.data[0][0].style.bold, true)
  assert.equal(el2.data[0][0].style.color, '#ff0000')
  assert.equal(el2.data[0][1].text, '2')
  assert.throws(() => makeTableElement({ rows: [['a'], ['b', 'c']] }), /列数.*不一致/)
  assert.throws(() => makeTableElement({ rows: [] }), /rows 不能为空/)
})

test('table 工具函数：tint / normalizeColWidths', () => {
  assert.equal(tint('#ff0000', 1), '#ffffff')
  assert.match(tint('#ff0000', 0.8), /^#ff/)
  assert.doesNotThrow(() => tint('not-a-color', 0.8)) // 解析失败回落，不抛
  assert.deepEqual(normalizeColWidths([0.5, 0.5], 2), [0.5, 0.5])
  assert.throws(() => normalizeColWidths([1, 1, 1], 2), /长度.*不一致/)
})

/* ---------- op 行为 ---------- */

test('add-chart / update-chart op', async () => {
  const P = fakeP([slide('s0')])
  await applyOp(P, { op: 'add-chart', slide: 0, element: { chartType: 'bar', data: { values: [1, 2] } } })
  const chart = P.state.slides[0].elements[0]
  assert.equal(chart.type, 'chart')
  assert.equal(chart.chartType, 'bar')

  await applyOp(P, { op: 'update-chart', slide: 0, elementId: chart.id, props: { chartType: 'line', data: { values: [5, 6] } } })
  const updated = P.state.slides[0].elements[0]
  assert.equal(updated.chartType, 'line')
  assert.deepEqual(updated.data.series, [[5, 6]])

  await assert.rejects(
    applyOp(P, { op: 'update-chart', slide: 0, elementId: 'nope', props: {} }),
    /update-chart 未命中/,
  )
})

test('add-table / update-table / set-table-cells op', async () => {
  const P = fakeP([slide('s0')])
  await applyOp(P, { op: 'add-table', slide: 0, element: { rows: [['名', '值'], ['A', 1]], header: true } })
  const table = P.state.slides[0].elements[0]
  assert.equal(table.type, 'table')
  assert.equal(table.data.length, 2)

  await applyOp(P, {
    op: 'set-table-cells', slide: 0, elementId: table.id,
    cells: [{ row: 1, col: 0, text: '华东', bold: true, backcolor: '#fff1ec' }],
  })
  const cell = P.state.slides[0].elements[0].data[1][0]
  assert.equal(cell.text, '华东')
  assert.equal(cell.style.bold, true)

  await applyOp(P, { op: 'update-table', slide: 0, elementId: table.id, props: { themeColor: '#ed7d31', rowHeader: false } })
  const t2 = P.state.slides[0].elements[0]
  assert.equal(t2.theme.color, '#ed7d31')
  assert.equal(t2.theme.rowHeader, false)

  await assert.rejects(
    applyOp(P, { op: 'set-table-cells', slide: 0, elementId: table.id, cells: [{ row: 9, col: 0 }] }),
    /行越界/,
  )
})

test('set-notes op', async () => {
  const P = fakeP([slide('s0'), slide('s1')])
  await applyOp(P, { op: 'set-notes', slide: 1, notes: '这一页讲重点' })
  assert.equal(P.state.slides[1].notes, '这一页讲重点')
  await applyOp(P, { op: 'set-notes', slide: 1, notes: '' })
  assert.equal(P.state.slides[1].notes, '')
})

/* ---------- 形状库 ---------- */

test('shape-library：全部形状 path 合法且非空', () => {
  assert.ok(SHAPE_KEYS.length >= 20)
  for (const key of SHAPE_KEYS) {
    const s = getShape(key)
    assert.ok(s.path.startsWith('M '), `${key} path 应以 M 开头`)
    assert.deepEqual(s.viewBox, [200, 200])
  }
  assert.throws(() => getShape('nope'), /未知形状/)
})
