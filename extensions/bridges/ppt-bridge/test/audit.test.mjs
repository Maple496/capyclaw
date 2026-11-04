import test from 'node:test'
import assert from 'node:assert/strict'
import { auditDeck } from '../src/mcp/audit.mjs'
import { buildDeck } from '../src/core/deck-layout.js'

const text = (id, content, left, top, width, height, color = '#333333') => ({
  type: 'text', id, left, top, width, height, content, defaultColor: color,
})

const shape = (id, left, top, width, height, fill) => ({
  type: 'shape', id, left, top, width, height,
  path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z', viewBox: [200, 200], fill,
})

const shapeText = (id, left, top, width, height, fill, html) => ({
  ...shape(id, left, top, width, height, fill),
  text: { content: html, defaultColor: '#333333' },
})

const codesOf = (result) => new Set(result.issues.map((issue) => issue.code))

test('audit：干净 deck 通过', () => {
  const result = auditDeck({
    slides: [{
      background: { type: 'solid', color: '#ffffff' },
      elements: [text('t1', '<p style="font-size: 32px;">标题</p>', 60, 60, 400, 60)],
    }],
  })
  assert.equal(result.pass, true)
  assert.equal(result.score, 100)
  assert.deepEqual(result.issues, [])
})

test('audit：内置 clean 版式通过', () => {
  const deck = buildDeck({
    title: '测试',
    preset: 'clean',
    slides: [
      { layout: 'cover', title: '测试标题', subtitle: '副标题' },
      { layout: 'section', title: '第一章', index: 1, subtitle: '引导' },
      { layout: 'bullets', title: '要点', bullets: [{ text: '要点一', detail: '细节一' }, { text: '要点二' }] },
      { layout: 'two', title: '对比', left: { heading: '左', bullets: ['a'] }, right: { heading: '右', bullets: ['b'] } },
      { layout: 'end', title: '谢谢' },
    ],
  })
  const result = auditDeck(deck)
  assert.equal(result.pass, true, JSON.stringify(result.blocking))
  assert.equal(result.summary.errors, 0)
})

test('audit：越界/溢出/重叠/对比度/配色/重复图片/密度全部命中', () => {
  const longA = '这是一段很长很长的正文'.repeat(20)
  const longB = '另一段很长很长的正文'.repeat(20)
  const result = auditDeck({
    slides: [{
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        text('t1', longA, -20, 10, 200, 40, '#eeeeee'),
        text('t2', longB, -20, 10, 200, 40, '#eeeeee'),
        shape('s1', 0, 0, 100, 100, '#ff0000'),
        shape('s2', 100, 0, 100, 100, '#00ff00'),
        shape('s3', 200, 0, 100, 100, '#0000ff'),
        shape('s4', 200, 100, 100, 100, '#ff00ff'),
        { type: 'image', id: 'i1', left: 300, top: 0, width: 100, height: 100, src: 'data:image/png;base64,AAA' },
        { type: 'image', id: 'i2', left: 400, top: 0, width: 100, height: 100, src: 'data:image/png;base64,AAA' },
      ],
    }],
  })
  const codes = codesOf(result)
  for (const code of ['bounds', 'text-overflow', 'text-overlap', 'contrast', 'palette-drift', 'duplicate-image', 'density']) {
    assert.ok(codes.has(code), `缺少 ${code}: ${[...codes].join(',')}`)
  }
  assert.equal(result.pass, false)
  assert.ok(result.blocking.length > 0)
})

test('audit：shape 文字参与对比度与溢出检查', () => {
  const result = auditDeck({
    slides: [{
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        shapeText('s1', 100, 100, 200, 30, 'rgb(197, 189, 205)',
          '<p style="font-size: 20px; color: #ffffff;">这是一段很长的白色文字</p>'),
      ],
    }],
  })
  const codes = codesOf(result)
  assert.ok(codes.has('contrast'), [...codes].join(','))
  assert.ok(codes.has('text-overflow'), [...codes].join(','))
})

test('audit：shape 文字与同文案 text 叠加判重复', () => {
  const result = auditDeck({
    slides: [{
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        shapeText('s1', 100, 100, 300, 40, 'rgb(197, 189, 205)',
          '<p style="font-size: 20px; color: #333;">预测下一个 token</p>'),
        text('t1', '<p style="font-size: 20px; color: #333;">预测下一个 token</p>', 110, 108, 300, 40),
      ],
    }],
  })
  assert.ok(codesOf(result).has('duplicate-text'), [...codesOf(result)].join(','))
})

test('audit：白字压在深色矩形 shape 上不误报对比度', () => {
  const result = auditDeck({
    slides: [{
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        shape('s1', 100, 100, 400, 100, 'rgb(96, 84, 111)'),
        text('t1', '<p style="font-size: 20px; color: #ffffff;">白字在深紫上</p>', 120, 130, 300, 40, '#ffffff'),
      ],
    }],
  })
  assert.ok(!codesOf(result).has('contrast'), result.issues.map((i) => i.message).join('\n'))
})

test('audit：文字与自身高亮同色判 text-invisible', () => {
  const result = auditDeck({
    slides: [{
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        text('t1', '<p><span style="background-color: #2F2838;">大语言模型入门</span></p>', 100, 100, 500, 80, '#2F2838'),
      ],
    }],
  })
  assert.ok(codesOf(result).has('text-invisible'), [...codesOf(result)].join(','))
})

test('audit：上层形状遮挡文字判 text-occluded', () => {
  const result = auditDeck({
    slides: [{
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        text('t1', '<p style="font-size: 20px;">会被盖住的文字</p>', 100, 100, 300, 40),
        shape('s1', 80, 80, 340, 80, '#000000'),
      ],
    }],
  })
  assert.ok(codesOf(result).has('text-occluded'), [...codesOf(result)].join(','))
})

test('audit：三页以上复用同一版式判 repeated-layout', () => {
  const page = (n) => ({
    background: { type: 'solid', color: '#ffffff' },
    elements: [
      shape('s1', 20, 100, 400, 300, '#60546f'),
      shape('s2', 450, 100, 400, 300, '#c5bdcd'),
      text('t1', `<p style="font-size: 20px;">第${n}页标题</p>`, 20, 20, 400, 50),
      text('t2', '<p style="font-size: 16px;">说明一说明一说明一说明一说明一说明一</p>', 20, 330, 400, 30),
      text('t3', '<p style="font-size: 16px;">说明二说明二说明二说明二说明二说明二</p>', 400, 330, 400, 30),
      text('t4', '<p style="font-size: 16px;">说明三说明三说明三说明三说明三说明三</p>', 400, 380, 400, 30),
    ],
  })
  const result = auditDeck({ slides: [page(1), page(2), page(3)] })
  assert.ok(codesOf(result).has('repeated-layout'), [...codesOf(result)].join(','))
})

test('audit：装饰形状出血不再报 bounds', () => {
  const result = auditDeck({
    slides: [{
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        shape('s1', -30, 225, 194, 194, '#60546f'),
        text('t1', '<p style="font-size: 20px;">正常文字</p>', 100, 100, 300, 40),
      ],
    }],
  })
  assert.ok(!codesOf(result).has('bounds'), [...codesOf(result)].join(','))
})
