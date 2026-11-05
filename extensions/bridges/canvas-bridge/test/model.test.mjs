/** 块级写作模型与文档投影：纯函数直测。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PAPER, blocksToElements, documentOf, tableElement, imageElement,
  replaceInDoc, EMPTY_DOC, isEmptyDoc,
} from '../src/core/blocks.js'
import {
  textOf, wordCountOf, outlineOf, elementStats, summarize, findInDoc,
} from '../src/core/doc.js'
import { auditDoc } from '../src/core/audit.js'
import { docToHtml } from '../src/core/html.js'

test('PAPER 覆盖常用纸张', () => {
  assert.equal(PAPER.A4.width, 794)
  assert.ok(PAPER.Letter)
  assert.ok(PAPER.Legal)
})

test('heading 块 → 内核原生 title 元素（目录语义）', () => {
  const els = blocksToElements([{ type: 'heading', level: 1, text: '标题' }])
  assert.equal(els.length, 1)
  assert.equal(els[0].type, 'title')
  assert.equal(els[0].level, 'first')
  assert.equal(els[0].valueList[0].value, '标题')
  /* 字号/加粗交给内核按 level 默认（26/24/22/20/18/16），桥层不再自设 */
  assert.equal(els[0].valueList[0].size, undefined)

  const l6 = blocksToElements([{ type: 'heading', level: 9, text: '深级' }])
  assert.equal(l6[0].level, 'sixth')
})

test('文本块以 \\n 开头自成一行（内核行模型）', () => {
  const els = blocksToElements([
    { type: 'paragraph', text: '第一行' },
    { type: 'bullet', text: '要点' },
  ])
  assert.equal(els.length, 2)
  assert.equal(els[0].value, '\n第一行')
  assert.equal(els[1].value, '\n• 要点')
})

test('documentOf 三段都是数组', () => {
  const doc = documentOf([{ type: 'paragraph', text: 'hi' }])
  assert.ok(Array.isArray(doc.header))
  assert.ok(Array.isArray(doc.main))
  assert.ok(Array.isArray(doc.footer))
  assert.equal(doc.main.length, 1)
  assert.equal(doc.main[0].value, '\nhi')
})

test('块级 style 映射到行内样式（title 落到 valueList 内）', () => {
  const els = blocksToElements([
    { type: 'paragraph', text: 'x', style: { bold: true, color: '#f00' } },
    { type: 'heading', level: 2, text: 'T', style: { color: '#0f0' } },
  ])
  assert.ok(els[0].bold)
  assert.equal(els[0].color, '#f00')
  assert.equal(els[1].valueList[0].color, '#0f0')
})

test('tableElement：列数自适应、表头底色、单元格元素流', () => {
  const el = tableElement(['A', 'B'], [['1', '2']], { header_background: '#eee' })
  assert.equal(el.type, 'table')
  assert.equal(el.colgroup.length, 2)
  assert.equal(el.trList.length, 2)
  assert.equal(el.trList[0].tdList[0].value[0].value, 'A')
  assert.equal(el.trList[0].tdList[0].backgroundColor, '#eee')
  assert.equal(el.trList[1].tdList[1].value[0].value, '2')
})

test('imageElement 校验与题注', () => {
  const el = imageElement('data:image/png;base64,xx', 100, 50, '图')
  assert.equal(el.type, 'image')
  assert.equal(el.width, 100)
  assert.equal(el.imgCaption, '图')
})

test('replaceInDoc：多处替换计数、表格内替换、all=false 只改第一处', () => {
  const doc = {
    main: [
      { value: 'foo bar foo' }, { value: '\n' },
      tableElement(['foo'], [['foo']]),
      { value: '\n' },
    ],
  }
  const all = replaceInDoc(doc, 'foo', 'X', true)
  assert.equal(all.count, 4)
  /* 文本投影含表格单元格：正文 'X bar X' + 表头 'X' + 单元格 'X' */
  assert.equal(textOf(all.doc), 'X bar XXX')
  const one = replaceInDoc(doc, 'foo', 'X', false)
  assert.equal(one.count, 1)
})

test('textOf / wordCountOf：拼接三段并统计中英字数', () => {
  const doc = { header: [{ value: '页眉' }], main: [{ value: '你好 world' }, { value: '\n' }], footer: [] }
  assert.equal(textOf(doc), '页眉\n你好 world')
  assert.equal(wordCountOf(doc), 5) // 页眉2 + 你好2 + world1
})

test('outlineOf：title 用 level，伪标题退回字号启发式，分页符翻页', () => {
  const doc = { main: [
    { type: 'title', level: 'first', value: '', valueList: [{ value: '真一级' }] },
    { value: '\n正文', size: 16 },
    { type: 'pageBreak', value: '' },
    { type: 'title', level: 'second', value: '', valueList: [{ value: '真二级' }] },
    { value: '\n旧伪标题', size: 28, bold: true },
  ] }
  const outline = outlineOf(doc)
  assert.equal(outline.length, 3)
  assert.equal(outline[0].level, 1)
  assert.equal(outline[0].text, '真一级')
  assert.equal(outline[1].level, 2)
  assert.equal(outline[1].page, 2)
  assert.equal(outline[2].level, 1)
  assert.equal(outline[2].text, '旧伪标题')
})

test('elementStats / summarize / findInDoc（含 title 检索）', () => {
  const doc = documentOf([
    { type: 'heading', level: 1, text: 'T 标题' },
    { type: 'paragraph', text: '内容 needle 内容' },
  ])
  doc.main.push(tableElement(['a'], [['b']]))
  const stats = elementStats(doc)
  assert.equal(stats.table, 1)
  assert.equal(stats.title, 1)
  assert.ok(stats.text >= 1)
  assert.ok(summarize(doc).includes('大纲'))
  assert.ok(summarize(doc).includes('标题 1'))
  assert.equal(findInDoc(doc, 'needle').length, 1)
  const titleHit = findInDoc(doc, 'T 标题')
  assert.equal(titleHit.length, 1)
  assert.equal(titleHit[0].sub, 0)
  assert.equal(findInDoc(doc, '不存在').length, 0)
})

test('auditDoc：空文档 blocking，结构完整通过，表格越界 warn', () => {
  assert.equal(auditDoc(EMPTY_DOC()).ok, false)
  const good = documentOf([
    { type: 'heading', level: 1, text: '标题' },
    { type: 'paragraph', text: '正文' },
  ])
  const report = auditDoc(good)
  assert.equal(report.ok, true)
  const ragged = documentOf([])
  ragged.main.push({ type: 'table', value: ' ', colgroup: [{ width: 100 }], trList: [
    { tdList: [{ colspan: 1, rowspan: 1, value: [] }] },
    { tdList: [{ colspan: 1, rowspan: 1, value: [] }, { colspan: 1, rowspan: 1, value: [] }] },
  ] })
  const raggedReport = auditDoc(ragged)
  assert.ok(raggedReport.findings.some((f) => f.rule === 'ragged-table'))
})

test('isEmptyDoc 三形兼容', () => {
  assert.ok(isEmptyDoc(null))
  assert.ok(isEmptyDoc(EMPTY_DOC()))
  assert.ok(!isEmptyDoc({ main: [{ value: 'x' }] }))
  assert.ok(isEmptyDoc({ header: { elementList: [] }, main: [], footer: [] }))
})

test('docToHtml：标题/表格/图片/高亮投影', () => {
  const doc = documentOf([{ type: 'heading', level: 1, text: '标题 & <安全>' }])
  doc.main.push(tableElement(['列A'], [['值1']]))
  doc.main.push(imageElement('data:image/png;base64,x', 10, 10))
  const html = docToHtml(doc, '测试')
  assert.ok(html.includes('<h1>'))
  assert.ok(html.includes('<table>'))
  assert.ok(html.includes('<img src="data:image/png;base64,x"'))
  assert.ok(html.includes('&lt;安全&gt;'))
  assert.ok(!html.includes('<安全>'))
})
