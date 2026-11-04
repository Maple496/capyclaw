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

test('heading 块 → 大字号加粗元素 + 换行', () => {
  const els = blocksToElements([{ type: 'heading', level: 1, text: '标题' }])
  assert.equal(els.length, 2)
  assert.equal(els[0].size, 28)
  assert.ok(els[0].bold)
  assert.equal(els[1].value, '\n')
})

test('documentOf 三段都是数组', () => {
  const doc = documentOf([{ type: 'paragraph', text: 'hi' }])
  assert.ok(Array.isArray(doc.header))
  assert.ok(Array.isArray(doc.main))
  assert.ok(Array.isArray(doc.footer))
  assert.equal(doc.main.length, 2)
})

test('块级 style 映射到行内样式', () => {
  const els = blocksToElements([{ type: 'paragraph', text: 'x', style: { bold: true, color: '#f00' } }])
  assert.ok(els[0].bold)
  assert.equal(els[0].color, '#f00')
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
  assert.equal(textOf(all.doc), 'X bar X')
  const one = replaceInDoc(doc, 'foo', 'X', false)
  assert.equal(one.count, 1)
})

test('textOf / wordCountOf：拼接三段并统计中英字数', () => {
  const doc = { header: [{ value: '页眉' }], main: [{ value: '你好 world' }, { value: '\n' }], footer: [] }
  assert.equal(textOf(doc), '页眉\n你好 world')
  assert.equal(wordCountOf(doc), 5) // 页眉2 + 你好2 + world1
})

test('outlineOf：按字号/加粗识别层级，分页符翻页', () => {
  const doc = { main: [
    { value: '一级', size: 28, bold: true }, { value: '\n' },
    { value: '正文', size: 16 }, { value: '\n' },
    { type: 'pageBreak', value: '' },
    { value: '二级', size: 22, bold: true }, { value: '\n' },
  ] }
  const outline = outlineOf(doc)
  assert.equal(outline.length, 2)
  assert.equal(outline[0].level, 1)
  assert.equal(outline[1].level, 2)
  assert.equal(outline[1].page, 2)
})

test('elementStats / summarize / findInDoc', () => {
  const doc = documentOf([
    { type: 'heading', level: 1, text: 'T' },
    { type: 'paragraph', text: '内容 needle 内容' },
  ])
  doc.main.push(tableElement(['a'], [['b']]))
  const stats = elementStats(doc)
  assert.equal(stats.table, 1)
  assert.ok(stats.text >= 2)
  assert.ok(summarize(doc).includes('大纲'))
  assert.equal(findInDoc(doc, 'needle').length, 1)
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
