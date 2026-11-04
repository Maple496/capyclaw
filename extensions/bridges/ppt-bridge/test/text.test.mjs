import test from 'node:test'
import assert from 'node:assert/strict'
import { setPlainText, fontSizeOf, patchElement, contrast, makeElement } from '../src/core/text.js'

test('setPlainText 保留 span 内联字号（54px 标题）', () => {
  const src = '<p style=""><strong><span style="font-size: 54px;"><span style="background-color: rgba(0, 0, 0, 0);">封面标题</span></span></strong></p>'
  const out = setPlainText(src, '认识深圳')
  assert.match(out, /font-size: 54px/)
  assert.match(out, /background-color: rgba\(0, 0, 0, 0\)/)
  assert.match(out, /认识深圳/)
  assert.ok(!out.includes('封面标题'))
})

test('setPlainText 多文本节点只保留第一个（其余清空）', () => {
  const out = setPlainText('<p><span style="font-size:20px">A</span><span style="font-size:12px">B</span></p>', 'X')
  assert.match(out, />X</)
  assert.ok(!out.includes('A') && !out.includes('B'))
})

test('setPlainText 空内容回退为 <p>', () => {
  assert.equal(setPlainText('', '你好'), '<p>你好</p>')
})

test('fontSizeOf 解析第一个字号', () => {
  assert.equal(fontSizeOf('<p><span style="font-size: 54px;">x</span></p>'), 54)
  assert.equal(fontSizeOf('<p style="font-size: 16px;">x</p>'), 16)
  assert.equal(fontSizeOf('<p>x</p>'), 0)
})

test('patchElement：只改文字时保留原字号；带 fontSize 时按指定字号重建', () => {
  const el = { type: 'text', content: '<p><span style="font-size: 40px;">旧</span></p>' }
  patchElement(el, { text: '新' })
  assert.match(el.content, /font-size: 40px/)
  assert.match(el.content, /新/)
  patchElement(el, { text: '更大', fontSize: 64 })
  assert.match(el.content, /font-size: 64px/)
})

test('contrast：浅底深字 / 深底白字，并改写显式 color', () => {
  const light = { elements: [{ type: 'text', content: '<p style="color: #fff;">a</p>' }] }
  contrast(light, '#ffffff')
  assert.equal(light.elements[0].defaultColor, '#1f2d3d')
  assert.match(light.elements[0].content, /#1f2d3d/)
  const dark = { elements: [{ type: 'text', content: '<p>b</p>' }] }
  contrast(dark, '#0f2740')
  assert.equal(dark.elements[0].defaultColor, '#ffffff')
})

test('makeElement：文本/形状默认字段完整', () => {
  const t = makeElement({ text: 'hi' })
  assert.equal(t.type, 'text')
  assert.match(t.content, /hi/)
  const s = makeElement({ type: 'shape', fill: '#f00' })
  assert.equal(s.type, 'shape')
  assert.equal(s.fill, '#f00')
  assert.equal(s.viewBox.length, 2)
})

test('makeElement：image 保留 src，不再静默降级为 text', () => {
  const el = makeElement({ type: 'image', src: 'data:image/png;base64,AAA', left: 0, top: 0, width: 100, height: 50 })
  assert.equal(el.type, 'image')
  assert.equal(el.src, 'data:image/png;base64,AAA')
  assert.equal(el.width, 100)
})

test('makeElement：本机路径 / 未知类型明确报错（不静默成功）', () => {
  assert.throws(() => makeElement({ type: 'image', src: 'C:/tmp/a.png' }), /ppt_image/)
  assert.throws(() => makeElement({ type: 'video' }), /不支持/)
})

test('patchElement：只改 color 保留字号', () => {
  const el = { type: 'text', content: '<p><span style="font-size: 54px; color: #fff;">标题</span></p>', defaultColor: '#fff' }
  patchElement(el, { color: '#1f2d3d' })
  assert.match(el.content, /font-size: 54px/)
  assert.match(el.content, /color: #1f2d3d/)
})
